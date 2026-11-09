#!/usr/bin/env node
// Governed-workflow harness for checks W1-W4: drives a running Garisek Electron window over CDP
// (start the app with --remote-debugging-port), and checks every step against disk.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { connectPage } from "./cdp.mjs";
const args = {};
for (let index = 2; index < process.argv.length; index += 2) {
  args[process.argv[index].replace(/^--/, "")] = process.argv[index + 1] ?? "";
}
const required = ["host", "project", "project-path", "verifier", "out"];
for (const key of required) {
  if (!args[key]) {
    console.error(
      `usage: e2e-harness.mjs --host <label> --project <name in the picker> --project-path <cwd the thread runs in> --verifier <shell command> --out <dir> [--ref <worktree branch>] [--cdp http://127.0.0.1:9333] [--model "Claude Haiku 5.5 , OMP anthropic"] [--fixture NAME] [--turn-timeout-s 600]`,
    );
    process.exit(2);
  }
}
const cdpBase = args.cdp || "http://127.0.0.1:9333";
const projectName = args.project;
const ref = args.ref || null;
const projectPath = NodePath.resolve(args["project-path"].replace(/^~/, NodeOS.homedir()));
const modelOption = args.model || "Claude Haiku 5.5 , OMP anthropic";
const fixture = args.fixture || "GARISEK-HARNESS-FIXTURE.txt";
const turnTimeoutMs = Number(args["turn-timeout-s"] || 600) * 1000;
const outDir = NodePath.resolve(args.out);
const marker = `${args.host}-${new Date().toISOString().replace(/[-:.]/g, "")}-${NodeCrypto.randomBytes(3).toString("hex")}`;
const fixturePath = NodePath.join(projectPath, fixture);
NodeFS.mkdirSync(outDir, { recursive: true });

const steps = [];
const startedAt = new Date().toISOString();
const sha256 = (data) => NodeCrypto.createHash("sha256").update(data).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const git = (...gitArgs) =>
  NodeChildProcess.spawnSync("git", gitArgs, { cwd: projectPath, encoding: "utf8" }).stdout.trim();

const page = await connectPage(cdpBase);
const js = (value) => JSON.stringify(value);
const pressKey = page.pressKey;

async function screenshot(name) {
  const { data } = await page.send("Page.captureScreenshot", { format: "png" });
  const file = NodePath.join(outDir, `${name}.png`);
  NodeFS.writeFileSync(file, Buffer.from(data, "base64"));
  return NodePath.basename(file);
}

async function step(name, run) {
  const record = { name, startedAt: new Date().toISOString() };
  steps.push(record);
  try {
    Object.assign(record, (await run()) ?? {});
    record.ok ??= true;
  } catch (error) {
    record.ok = false;
    record.error = String(error?.stack ?? error);
  }
  record.endedAt = new Date().toISOString();
  record.screenshot = await screenshot(`${String(steps.length).padStart(2, "0")}-${name}`).catch(
    () => null,
  );
  console.log(
    `${record.ok ? "ok  " : "FAIL"} ${name}${record.error ? `: ${record.error.split("\n")[0]}` : ""}`,
  );
  if (!record.ok) throw new Error(`step ${name} failed`);
  return record;
}

const clickByText = (selector, predicateSource) =>
  page.evaluate(`(() => {
    const match = [...document.querySelectorAll(${js(selector)})]
      .filter((element) => (${predicateSource})(element.innerText.replace(/\\s+/g, " ").trim(), element))
      .sort((a, b) => a.innerText.length - b.innerText.length)[0];
    if (!match) return false;
    match.scrollIntoView({ block: "center" });
    match.click();
    return true;
  })()`);

// The timeline is virtualized, so row counts are meaningless: read the assistant rows that follow
// the newest user row carrying this turn's prompt.
const repliesAfter = (prompt) =>
  page.evaluate(`(() => {
    const scroll = [...document.querySelectorAll("button")].find((b) => b.innerText.trim() === "Scroll to end");
    if (scroll) scroll.click();
    const norm = (s) => s.replace(/\\s+/g, " ").trim();
    const head = norm(${js(prompt)}).slice(0, 60);
    const rows = [...document.querySelectorAll("[data-timeline-row-id]")];
    let anchor = -1;
    rows.forEach((row, index) => {
      if (row.getAttribute("data-message-role") === "user" && norm(row.innerText).includes(head)) anchor = index;
    });
    if (anchor < 0) return null;
    return rows.slice(anchor + 1).filter((row) => row.getAttribute("data-message-role") === "assistant").map((row) => row.innerText.trim());
  })()`);

const isRunning = () =>
  page.evaluate(`(() => {
    if ([...document.querySelectorAll("button[aria-label]")].some((button) => /^(stop|interrupt)/i.test(button.getAttribute("aria-label")))) return true;
    return /Working for \\d/.test(document.querySelector("main")?.innerText ?? document.body.innerText);
  })()`);

async function sendTurn(text, expect) {
  const focused = await page.evaluate(`(() => {
    const editor = document.querySelector('[data-testid="composer-editor"]');
    if (!editor) return false;
    editor.focus();
    return true;
  })()`);
  if (!focused) throw new Error("composer editor not found");
  await page.send("Input.insertText", { text });
  await sleep(300);
  await pressKey("Enter");
  const sentAt = new Date().toISOString();
  const deadline = Date.now() + turnTimeoutMs;
  let lastText = null;
  let stableSince = 0;
  while (Date.now() < deadline) {
    await sleep(1000);
    const replies = await repliesAfter(text);
    const failed = await page.evaluate(
      `[...document.querySelectorAll("main *")].some((element) => element.childElementCount === 0 && /^Provider turn failed/.test(element.textContent ?? ""))`,
    );
    if (failed && !replies?.length) throw new Error("UI reports: Provider turn failed");
    if (!replies?.length || (await isRunning())) continue;
    const joined = replies.join("\n---\n");
    if (joined !== lastText) {
      lastText = joined;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= 6000) {
      const reply = replies.at(-1);
      if (expect && !expect(reply)) throw new Error(`unexpected reply: ${reply.slice(0, 400)}`);
      return { sentAt, settledAt: new Date().toISOString(), reply };
    }
  }
  throw new Error(`turn did not settle within ${turnTimeoutMs / 1000}s`);
}

const sessionDir = NodePath.join(
  NodeOS.homedir(),
  ".omp/agent/sessions",
  `-${NodePath.relative(NodeOS.homedir(), projectPath).split(NodePath.sep).join("-")}`,
);
const PROGRESS_ROOT = NodePath.join(NodeOS.homedir(), "agent-reviews", "progress");
// The smart-goal extension persists each session's contract as <progress dir>/smart-goal.json.
const findContract = () => {
  for (const name of NodeFS.readdirSync(PROGRESS_ROOT)) {
    const file = NodePath.join(PROGRESS_ROOT, name, "smart-goal.json");
    if (!NodeFS.existsSync(file)) continue;
    const text = NodeFS.readFileSync(file, "utf8");
    if (text.includes(marker)) return { file, state: JSON.parse(text) };
  }
  return null;
};
const findSessionFile = () => {
  if (!NodeFS.existsSync(sessionDir)) return null;
  return (
    NodeFS.readdirSync(sessionDir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => NodePath.join(sessionDir, name))
      .find((file) => NodeFS.readFileSync(file, "utf8").includes(marker)) ?? null
  );
};

const statusBefore = git("status", "--porcelain");
const result = {
  check: args.check ?? null,
  host: args.host,
  projectPath,
  marker,
  fixture,
  startedAt,
};
let failure = null;
try {
  if (NodeFS.existsSync(fixturePath)) throw new Error(`${fixturePath} already exists`);

  await step("open-project-thread", async () => {
    if (
      !(await clickByText(
        "button",
        `(text, element) => element.getAttribute("aria-label") === "New thread"`,
      ))
    )
      throw new Error("New thread button not found");
    await sleep(1200);
    await page.send("Input.insertText", { text: projectName });
    await sleep(1000);
    await pressKey("Enter");
    await sleep(1500);
    const heading = await page.evaluate(`document.querySelector("main")?.innerText ?? ""`);
    if (!heading.includes(projectName)) throw new Error(`project ${projectName} was not selected`);
    if (ref) {
      const current = git("rev-parse", "--abbrev-ref", "HEAD");
      if (current !== ref) throw new Error(`${projectPath} is on ${current}, not ${ref}`);
      if (
        !(await clickByText(
          '[role="combobox"]',
          `(text, element) => !element.getAttribute("aria-label") && text.length > 0 && text.length < 120 && element.closest("main") !== null && !/,/.test(text)`,
        ))
      )
        throw new Error("ref picker not found");
      await sleep(1000);
      await page.send("Input.insertText", { text: ref });
      await sleep(1000);
      await pressKey("Enter");
      await sleep(1500);
      const refShown = await page.evaluate(
        `[...document.querySelectorAll('[role="combobox"]')].some((element) => element.innerText.replace(/\\s+/g, "") === ${js(ref)})`,
      );
      if (!refShown) throw new Error(`worktree ref ${ref} was not selected`);
    }
    return { url: await page.evaluate("location.href"), project: projectName, ref: ref ?? null };
  });

  await step("select-model", async () => {
    if (
      !(await clickByText(
        "main form button[aria-label]",
        `(text, element) => /^[^,]+, [^,]+$/.test(element.getAttribute("aria-label") ?? "")`,
      ))
    )
      throw new Error("model picker button not found");
    await sleep(800);
    await page.evaluate(`(() => {
      const input = document.querySelector('input[placeholder="Search models..."]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${js(modelOption.split(",")[0].trim())});
      input.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await sleep(800);
    if (!(await clickByText('[role="option"]', `(text) => text.startsWith(${js(modelOption)})`)))
      throw new Error(`model option "${modelOption}" not found`);
    await sleep(500);
    await pressKey("Escape");
    const label = await page.evaluate(
      `[...document.querySelectorAll("button[aria-label]")].map((b) => b.getAttribute("aria-label")).find((l) => l.startsWith(${js(modelOption.split(",")[0].trim())}))`,
    );
    if (!label) throw new Error("model selection did not stick");
    return { model: label };
  });

  // Every stop is graded by smart-goal's verifier, so the contract names only the final state; an
  // intermediate-state check would make the verifier push the agent ahead of the script.
  const finalCheck = {
    id: "F1",
    claim: "the fixture round trip leaves the worktree as it was",
    how: `test ! -e ${fixture} && test -z "$(git status --porcelain)"`,
    passWhen: "exit 0",
  };
  const gateCheck = {
    id: "F2",
    claim: "the project gate passes",
    how: args.verifier,
    passWhen: "exit 0",
  };

  await step("smart-goal-set", async () => {
    const turn = await sendTurn(
      `Call the smart_goal tool with action "set", mission "Harness run ${marker}: write ${fixture}, read it back, then remove it", specific "${fixture} in the project root", checks ${JSON.stringify([finalCheck])}, scopeIn ["${fixture}"]. Do nothing else and do not create the file yet. Then reply with exactly: SET-${marker}`,
    );
    const contract = findContract();
    if (!contract)
      throw new Error(
        `no smart-goal.json under ${PROGRESS_ROOT} names ${marker}; reply was: ${turn.reply.slice(0, 300)}`,
      );
    const ids = contract.state.contract.checks.map((check) => check.id);
    if (ids.join() !== "F1") throw new Error(`contract checks are ${ids.join()}, expected F1`);
    return { ...turn, contractFile: contract.file, checks: ids, sessionFile: findSessionFile() };
  });

  await step("smart-goal-amend", async () => {
    const turn = await sendTurn(
      `Call the smart_goal tool with action "amend", reason "add the project gate", the same mission and specific, checks ${JSON.stringify([finalCheck, gateCheck])}. Do nothing else and do not create the file yet. Then reply with exactly: AMEND-${marker}`,
    );
    const contract = findContract();
    const ids = contract?.state.contract.checks.map((check) => check.id) ?? [];
    if (ids.join() !== "F1,F2")
      throw new Error(`contract checks are ${ids.join() || "missing"} after amend, expected F1,F2`);
    return { ...turn, contractFile: contract.file, checks: ids };
  });

  await step("edit-read-back-revert", async () => {
    let observed = null;
    const poller = { stop: false };
    const poll = (async () => {
      while (!poller.stop) {
        if (!observed && NodeFS.existsSync(fixturePath)) {
          const bytes = NodeFS.readFileSync(fixturePath);
          observed = {
            at: new Date().toISOString(),
            sha256: sha256(bytes),
            text: bytes.toString("utf8"),
          };
        }
        await sleep(100);
      }
    })();
    let turn;
    try {
      turn = await sendTurn(
        `Do this in order: 1) use the write tool to create ${fixture} in the project root containing exactly one line: ${marker} 2) use the read tool on that file 3) delete it with the bash tool (rm ${fixture}) and run git status --short. Reply with exactly the line the read tool returned, then REVERTED.`,
        (reply) => reply.includes(marker) && reply.includes("REVERTED"),
      );
    } finally {
      poller.stop = true;
      await poll;
    }
    if (!observed) throw new Error("the fixture never appeared on disk");
    if (observed.text.trim() !== marker) throw new Error(`fixture bytes differ: ${observed.text}`);
    const transcript = NodeFS.readFileSync(findSessionFile() ?? "/dev/null", "utf8");
    const readBack = transcript
      .split("\n")
      .some(
        (line) => line.includes('"toolResult"') && line.includes('"read"') && line.includes(marker),
      );
    if (!readBack)
      throw new Error("no read tool result containing the marker in the OMP session file");
    if (NodeFS.existsSync(fixturePath)) throw new Error("fixture still on disk");
    const statusAfter = git("status", "--porcelain");
    if (statusAfter !== statusBefore) throw new Error(`git status changed:\n${statusAfter}`);
    return {
      ...turn,
      fixtureObserved: observed,
      readBackInTranscript: true,
      gitStatusUnchanged: true,
    };
  });

  await step("project-verifier", async () => {
    const started = Date.now();
    const run = NodeChildProcess.spawnSync("bash", ["-lc", args.verifier], {
      cwd: projectPath,
      encoding: "utf8",
      maxBuffer: 1 << 28,
    });
    const log = NodePath.join(outDir, "verifier.log");
    NodeFS.writeFileSync(
      log,
      `$ ${args.verifier}\n${run.stdout}\n${run.stderr}\nexit ${run.status}\n`,
    );
    return {
      command: args.verifier,
      exitStatus: run.status,
      seconds: Math.round((Date.now() - started) / 1000),
      log: NodePath.basename(log),
      ok: true,
    };
  });

  await step("smart-goal-verdicts", async () => {
    const workDone = steps.find((record) => record.name === "edit-read-back-revert").sentAt;
    const deadline = Date.now() + 25 * 60_000;
    let contract = findContract();
    while (Date.now() < deadline && !contract.state.rounds.some((round) => round.at > workDone)) {
      await sleep(5000);
      contract = findContract();
    }
    const latest = contract.state.rounds.filter((round) => round.at > workDone).at(-1);
    if (!latest) throw new Error("no smart-goal verifier round recorded after the work turn");
    const statusFile = NodePath.join(outDir, "smart-goal.json");
    NodeFS.copyFileSync(contract.file, statusFile);
    return {
      contractStatus: contract.state.status,
      latest: {
        at: latest.at,
        model: latest.model,
        verdict: latest.verdict,
        checks: latest.checks,
      },
      rounds: contract.state.rounds.map((round) => ({
        n: round.n,
        at: round.at,
        model: round.model,
        verdict: round.verdict,
      })),
      copy: NodePath.basename(statusFile),
      ok: latest.verdict === "PASS" || latest.checks?.every((check) => check.pass) === true,
    };
  });
} catch (error) {
  failure = String(error?.message ?? error);
} finally {
  if (NodeFS.existsSync(fixturePath) && NodeFS.readFileSync(fixturePath, "utf8").includes(marker)) {
    NodeFS.rmSync(fixturePath);
    result.harnessRemovedFixture = true;
  }
}

const sessionFile = findSessionFile();
if (sessionFile) {
  const lines = NodeFS.readFileSync(sessionFile, "utf8").trim().split("\n");
  const tools = {};
  for (const line of lines) {
    for (const match of line.matchAll(/"type":"toolCall"[^}]*?"name":"([a-z_]+)"/g))
      tools[match[1]] = (tools[match[1]] ?? 0) + 1;
  }
  const copy = NodePath.join(outDir, NodePath.basename(sessionFile));
  NodeFS.copyFileSync(sessionFile, copy);
  result.session = {
    file: sessionFile,
    lines: lines.length,
    sha256: sha256(NodeFS.readFileSync(sessionFile)),
    toolCalls: tools,
    copy: NodePath.basename(copy),
  };
}
const identity = NodePath.join(outDir, "identity.json");
NodeChildProcess.spawnSync(
  process.execPath,
  [NodePath.join(import.meta.dirname, "identity.mjs"), "--out", identity],
  { stdio: "ignore" },
);
result.identity = NodeFS.existsSync(identity)
  ? JSON.parse(NodeFS.readFileSync(identity, "utf8")).digest
  : null;
result.endedAt = new Date().toISOString();
result.failure = failure;
result.steps = steps;
NodeFS.writeFileSync(NodePath.join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
page.close();
console.log(failure ? `FAILED: ${failure}` : "all steps completed", `→ ${outDir}/result.json`);
process.exit(failure ? 1 : 0);
