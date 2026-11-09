#!/usr/bin/env node
// Cached-paint bench for check PAINT1, run against a Garisek Electron window started with
// --remote-debugging-port. Each trial is timed inside the page: from the input event to the first
// frame after the target DOM exists (rAF, then a task). Trials taken while the window is hidden are
// invalid because hidden windows starve rAF. Echo trials also report the ack and model clocks.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { connectPage } from "./cdp.mjs";

const args = {};
for (let index = 2; index < process.argv.length; index += 2) {
  args[process.argv[index].replace(/^--/, "")] = process.argv[index + 1] ?? "";
}
if (!args.out || !args.host) {
  console.error(
    "usage: paint-bench.mjs --host <label> --out <dir> [--cdp http://127.0.0.1:9333] [--trials 20] [--surfaces shell,thread-list,second-open,echo] [--echo-thread <title substring>]",
  );
  process.exit(2);
}
const cdpBase = args.cdp || "http://127.0.0.1:9333";
const trials = Number(args.trials || 20);
const surfaces = (args.surfaces || "shell,thread-list,second-open,echo").split(",");
const outDir = NodePath.resolve(args.out);
const budgetMs = 50;
NodeFS.mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const page = await connectPage(cdpBase);
const js = (value) => JSON.stringify(value);

const NEXT_FRAME = `() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))`;
const WAIT_UNTIL = `(ready, timeoutMs) => new Promise((resolve, reject) => {
  const started = performance.now();
  const tick = () => {
    if (ready()) return resolve();
    if (performance.now() - started > timeoutMs) return reject(new Error("timeout"));
    requestAnimationFrame(tick);
  };
  tick();
})`;

async function timeClick(clickExpression, readyExpression) {
  return page.evaluate(`(async () => {
    const waitUntil = ${WAIT_UNTIL};
    const nextFrame = ${NEXT_FRAME};
    const visibleBefore = document.visibilityState === "visible";
    const t0 = performance.now();
    (${clickExpression})();
    await waitUntil(${readyExpression}, 10000);
    await nextFrame();
    return { ms: performance.now() - t0, visible: visibleBefore && document.visibilityState === "visible" };
  })()`);
}

const sidebarCards = `[...document.querySelectorAll('[data-testid="sidebar-row-card"]')]`;

const results = {};
const invalid = [];

async function collect(surface, run) {
  const values = [];
  for (let trial = 0; trial < trials; trial++) {
    let sample;
    try {
      sample = await run(trial);
    } catch (error) {
      invalid.push({ surface, trial, reason: String(error?.message ?? error) });
      continue;
    }
    if (!sample.visible) {
      invalid.push({ surface, trial, reason: "window hidden during trial", ms: sample.ms });
      continue;
    }
    values.push(sample);
  }
  results[surface] = values;
  console.log(
    `${surface}: ${values.length} valid, p95 ${percentile(
      values.map((v) => v.ms),
      95,
    )?.toFixed(1)} ms`,
  );
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

if (surfaces.includes("shell")) {
  // Warm start: the app is already loaded once, so the reload is served from cache.
  await page.send("Page.enable");
  await page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      const observer = new MutationObserver(() => {
        if (document.querySelector('[data-testid="sidebar-row-card"]') && window.__garisekShellPaint === undefined) {
          window.__garisekShellPaint = -1;
          requestAnimationFrame(() => setTimeout(() => {
            window.__garisekShellPaint = performance.now();
            window.__garisekShellVisible = document.visibilityState === "visible";
          }, 0));
        }
      });
      observer.observe(document, { childList: true, subtree: true });
    })()`,
  });
  await collect("shell", async () => {
    await page.send("Page.reload", { ignoreCache: false });
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await sleep(100);
      const value = await page
        .evaluate(
          `window.__garisekShellPaint > 0 ? { ms: window.__garisekShellPaint, visible: window.__garisekShellVisible } : null`,
        )
        .catch(() => null);
      if (value) return value;
    }
    throw new Error("shell did not paint the thread list within 15 s");
  });
  await sleep(1500);
}

if (surfaces.includes("thread-list")) {
  const toggle = `document.querySelector('[data-testid="sidebar-settled-shelf-toggle"]')`;
  const expanded = `() => ${toggle}?.getAttribute("aria-expanded") === "true"`;
  if (await page.evaluate(`(${expanded})()`)) await page.evaluate(`${toggle}.click()`);
  await sleep(500);
  await page.evaluate(`${toggle}.click()`);
  await sleep(500);
  await page.evaluate(`${toggle}.click()`);
  await sleep(500);
  await collect("thread-list", async () => {
    const before = await page.evaluate(`${sidebarCards}.length`);
    const sample = await timeClick(
      `() => ${toggle}.click()`,
      `() => ${sidebarCards}.length > ${before}`,
    );
    await sleep(300);
    await page.evaluate(`${toggle}.click()`);
    await sleep(500);
    return sample;
  });
}

if (surfaces.includes("second-open")) {
  // Alternate between the first two pinned thread cards; each was opened once before timing.
  const cardAt = (index) => `${sidebarCards}[${index}]`;
  const open = async (index) => {
    const title = await page.evaluate(
      `${cardAt(index)}.innerText.split("\\n").find((line) => line.length > 3 && !/^\\d+[mhd]$|^now$/.test(line))`,
    );
    return timeClick(
      `() => ${cardAt(index)}.click()`,
      `() => (document.querySelector("header")?.innerText ?? document.body.innerText).includes(${js(title?.slice(0, 20) ?? "")}) && document.querySelector("[data-timeline-row-id]") !== null`,
    );
  };
  await open(0);
  await sleep(800);
  await open(1);
  await sleep(800);
  await collect("second-open", async (trial) => {
    const sample = await open(trial % 2);
    await sleep(400);
    return sample;
  });
}

if (surfaces.includes("echo")) {
  if (!args["echo-thread"]) throw new Error("--echo-thread is required for the echo surface");
  const card = `${sidebarCards}.find((element) => element.innerText.includes(${js(args["echo-thread"])}))`;
  await page.evaluate(`${card}.click()`);
  await sleep(2000);
  await collect("echo", async () => {
    const nonce = NodeCrypto.randomBytes(4).toString("hex");
    const prompt = `Reply with exactly: ok ${nonce}`;
    await page.evaluate(`(() => {
      window.__echo = { nonce: ${js(nonce)} };
      const nextFrame = ${NEXT_FRAME};
      const norm = (s) => s.replace(/\\s+/g, " ");
      const rowWith = (role) => [...document.querySelectorAll('[data-message-role="' + role + '"]')].find((row) => norm(row.innerText).includes(${js(nonce)}));
      document.addEventListener("keydown", (event) => { if (event.key === "Enter") window.__echo.key = event.timeStamp; }, { capture: true, once: true });
      const observer = new MutationObserver(() => {
        const state = window.__echo;
        const user = rowWith("user");
        if (user && state.echo === undefined) {
          state.echo = -1;
          nextFrame().then(() => { state.echo = performance.now(); state.visible = document.visibilityState === "visible"; });
        }
        if (state.ack === undefined && /Working/.test(document.querySelector('[data-testid="sidebar-row-card"]')?.innerText ?? "")) state.ack = performance.now();
        if (user && state.model === undefined) {
          const rows = [...document.querySelectorAll("[data-timeline-row-id]")];
          const after = rows.slice(rows.indexOf(user) + 1).find((row) => row.getAttribute("data-message-role") === "assistant" && row.innerText.trim().length > 0);
          if (after) state.model = performance.now();
        }
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      window.__echoObserver = observer;
      document.querySelector('[data-testid="composer-editor"]').focus();
    })()`);
    await page.send("Input.insertText", { text: prompt });
    await sleep(150);
    await page.pressKey("Enter");
    const deadline = Date.now() + 120000;
    let state;
    while (Date.now() < deadline) {
      await sleep(250);
      state = await page.evaluate(`window.__echo`);
      const running = await page.evaluate(
        `[...document.querySelectorAll("button[aria-label]")].some((b) => /^(stop|interrupt)/i.test(b.getAttribute("aria-label")))`,
      );
      if (state.echo > 0 && state.model !== undefined && !running) break;
    }
    await page.evaluate(`window.__echoObserver?.disconnect()`);
    if (!(state?.echo > 0) || state.key === undefined) throw new Error("no echo observed");
    await sleep(1500);
    return {
      ms: state.echo - state.key,
      visible: state.visible,
      ackMs: state.ack === undefined ? null : state.ack - state.key,
      modelMs: state.model === undefined ? null : state.model - state.key,
    };
  });
}

const summary = {};
for (const [surface, values] of Object.entries(results)) {
  const ms = values.map((value) => value.ms);
  summary[surface] = {
    valid: values.length,
    p50: percentile(ms, 50),
    p95: percentile(ms, 95),
    pass: values.length >= trials && percentile(ms, 95) < budgetMs,
  };
  if (surface === "echo") {
    const ack = values.map((value) => value.ackMs).filter((value) => value !== null);
    const model = values.map((value) => value.modelMs).filter((value) => value !== null);
    summary[surface].ack = { n: ack.length, p50: percentile(ack, 50), p95: percentile(ack, 95) };
    summary[surface].model = {
      n: model.length,
      p50: percentile(model, 50),
      p95: percentile(model, 95),
    };
  }
}
const identity = NodePath.join(outDir, "identity.json");
NodeChildProcess.spawnSync(
  process.execPath,
  [NodePath.join(import.meta.dirname, "identity.mjs"), "--out", identity],
  { stdio: "ignore" },
);
const report = {
  host: args.host,
  takenAt: new Date().toISOString(),
  budgetMs,
  trialsPerSurface: trials,
  method:
    "in-page performance.now(): input event to rAF+task after target DOM exists; p95 nearest rank",
  summary,
  values: results,
  invalid,
  identity: NodeFS.existsSync(identity)
    ? JSON.parse(NodeFS.readFileSync(identity, "utf8")).digest
    : null,
};
NodeFS.writeFileSync(NodePath.join(outDir, "result.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
page.close();
