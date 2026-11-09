#!/usr/bin/env node
// Check W5: one thread continued across a server restart and two clients. Client A sends turn one,
// the server restarts, client B opens the same route and sends turn two, and client A must see it.
// Disk is the judge: exactly one OMP session file holds both turns, in order.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { chatDriver, connectPage } from "./cdp.mjs";

const args = {};
for (let index = 2; index < process.argv.length; index += 2) {
  args[process.argv[index].replace(/^--/, "")] = process.argv[index + 1] ?? "";
}
const unit = args.unit || "garisek-code";
if (
  ["a-cdp", "a-host", "b-cdp", "b-host", "project", "project-path", "out"].some(
    (key) => !args[key],
  ) ||
  args["confirm-restart"] !== unit
) {
  console.error(
    `usage: handoff.mjs --a-cdp <url> --a-host <label> --b-cdp <url> --b-host <label> --project <name> --project-path <cwd> --out <dir> --confirm-restart <unit> [--unit garisek-code] [--ref <branch>] [--model "Claude Haiku 5.5 , OMP anthropic"] [--health https://avion.tail2cddbd.ts.net:8450/] [--turn-timeout-s 600]\n--confirm-restart must name the systemd --user unit the run restarts mid-check.`,
  );
  process.exit(2);
}
const projectPath = NodePath.resolve(args["project-path"].replace(/^~/, NodeOS.homedir()));
const modelOption = args.model || "Claude Haiku 5.5 , OMP anthropic";
const unitState = () =>
  NodeChildProcess.spawnSync(
    "systemctl",
    ["--user", "show", "-p", "MainPID,ActiveEnterTimestamp,ActiveState", unit],
    { encoding: "utf8" },
  ).stdout.trim();
const healthUrl = args.health || "https://avion.tail2cddbd.ts.net:8450/";
const turnTimeoutMs = Number(args["turn-timeout-s"] || 600) * 1000;
const outDir = NodePath.resolve(args.out);
const marker = `w5-${new Date().toISOString().replace(/[-:.]/g, "")}-${NodeCrypto.randomBytes(3).toString("hex")}`;
NodeFS.mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (data) => NodeCrypto.createHash("sha256").update(data).digest("hex");
const js = (value) => JSON.stringify(value);

const clients = {};
for (const side of ["a", "b"]) {
  const page = await connectPage(args[`${side}-cdp`]);
  clients[side] = { host: args[`${side}-host`], page, ...chatDriver(page, { turnTimeoutMs }) };
}

const steps = [];
async function step(name, run) {
  const record = { name, startedAt: new Date().toISOString() };
  steps.push(record);
  try {
    Object.assign(record, await run());
    record.ok = true;
  } catch (error) {
    record.ok = false;
    record.error = String(error?.stack ?? error);
  }
  record.endedAt = new Date().toISOString();
  record.screenshots = {};
  for (const [side, client] of Object.entries(clients)) {
    const file = `${String(steps.length).padStart(2, "0")}-${name}-${side}.png`;
    const shot = await client.page
      .send("Page.captureScreenshot", { format: "png" })
      .catch(() => null);
    if (shot) {
      NodeFS.writeFileSync(NodePath.join(outDir, file), Buffer.from(shot.data, "base64"));
      record.screenshots[side] = file;
    }
  }
  console.log(
    `${record.ok ? "ok  " : "FAIL"} ${name}${record.error ? `: ${record.error.split("\n")[0]}` : ""}`,
  );
  if (!record.ok) throw new Error(`step ${name} failed`);
  return record;
}

async function waitForReply(client, prompt, predicate, what) {
  const deadline = Date.now() + turnTimeoutMs;
  while (Date.now() < deadline) {
    const replies = await client.repliesAfter(prompt).catch(() => null);
    if (replies?.some(predicate)) return replies.find(predicate);
    await sleep(1000);
  }
  throw new Error(`${client.host} never showed ${what}`);
}

const sessionDir = NodePath.join(
  NodeOS.homedir(),
  ".omp/agent/sessions",
  `-${NodePath.relative(NodeOS.homedir(), projectPath).split(NodePath.sep).join("-")}`,
);
const sessionFilesWithMarker = () =>
  NodeFS.existsSync(sessionDir)
    ? NodeFS.readdirSync(sessionDir)
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => NodePath.join(sessionDir, name))
        .filter((file) => NodeFS.readFileSync(file, "utf8").includes(marker))
    : [];

const turnOne = `W5 ${marker} turn one from ${clients.a.host}. Reply with exactly ONE-${marker} and nothing else. Do not use tools.`;
const turnTwo = `W5 ${marker} turn two from ${clients.b.host}. Reply with exactly TWO-${marker} followed by a space and the exact text of your previous reply in this conversation. Do not use tools.`;
const result = {
  check: "W5",
  marker,
  a: clients.a.host,
  b: clients.b.host,
  projectPath,
  restart: { unit, command: `systemctl --user restart ${unit}`, healthUrl },
  startedAt: new Date().toISOString(),
};
let failure = null;
try {
  await step("a-open-thread", async () => {
    await clients.a.openNewThread(args.project);
    if (args.ref) await clients.a.selectRef(args.ref);
    return { model: await clients.a.selectModel(modelOption) };
  });

  const one = await step("a-turn-one", async () => {
    const turn = await clients.a.sendTurn(turnOne, (reply) => reply.includes(`ONE-${marker}`));
    const route = await clients.a.page.evaluate("location.hash");
    if (!/^#\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(route))
      throw new Error(`thread route not settled: ${route}`);
    const files = sessionFilesWithMarker();
    if (files.length !== 1)
      throw new Error(`expected one session file with the marker, found ${files.length}`);
    return { ...turn, route, sessionFile: files[0] };
  });

  await step("server-restart", async () => {
    const restart = result.restart;
    restart.before = unitState();
    restart.requestedAt = new Date().toISOString();
    const run = NodeChildProcess.spawnSync("systemctl", ["--user", "restart", unit], {
      encoding: "utf8",
    });
    restart.exitStatus = run.status;
    restart.stderr = run.stderr.trim();
    if (run.status !== 0) throw new Error(`restart exited ${run.status}: ${restart.stderr}`);
    const deadline = Date.now() + 120_000;
    restart.health = 0;
    while (Date.now() < deadline) {
      restart.health = await fetch(healthUrl)
        .then((response) => response.status)
        .catch(() => 0);
      if (restart.health === 200) break;
      await sleep(1000);
    }
    restart.healthyAt = new Date().toISOString();
    restart.after = unitState();
    if (restart.health !== 200)
      throw new Error(`${healthUrl} not healthy after restart (last ${restart.health})`);
    if (restart.after === restart.before)
      throw new Error(`${unit} MainPID/start time did not change`);
    return { before: restart.before, after: restart.after, health: restart.health };
  });

  await step("b-open-same-thread", async () => {
    await clients.b.page.evaluate(`location.hash = ${js(one.route)}`);
    const reply = await waitForReply(
      clients.b,
      turnOne,
      (text) => text.includes(`ONE-${marker}`),
      "turn one",
    );
    return { route: await clients.b.page.evaluate("location.hash"), turnOneReply: reply };
  });

  const two = await step("b-turn-two", async () =>
    clients.b.sendTurn(
      turnTwo,
      (reply) => reply.includes(`TWO-${marker}`) && reply.includes(`ONE-${marker}`),
    ),
  );

  await step("a-sees-turn-two", async () => {
    const reply = await waitForReply(
      clients.a,
      turnTwo,
      (text) => text.includes(`TWO-${marker}`),
      "turn two",
    );
    return { reply, route: await clients.a.page.evaluate("location.hash") };
  });

  await step("one-session-on-disk", async () => {
    const files = sessionFilesWithMarker();
    if (files.length !== 1 || files[0] !== one.sessionFile)
      throw new Error(`turns landed in ${files.length} files: ${files.join(", ")}`);
    const lines = NodeFS.readFileSync(files[0], "utf8").trim().split("\n");
    const userTurns = lines
      .map((line, index) => ({ index, entry: JSON.parse(line) }))
      .filter(
        ({ entry }) =>
          entry.message?.role === "user" && JSON.stringify(entry.message.content).includes(marker),
      )
      .map(({ index, entry }) => ({
        line: index + 1,
        turn: JSON.stringify(entry.message.content).includes("turn one") ? 1 : 2,
      }));
    if (userTurns.length !== 2 || userTurns[0].turn !== 1 || userTurns[1].turn !== 2)
      throw new Error(`user turns on disk: ${js(userTurns)}`);
    const copy = NodePath.join(outDir, NodePath.basename(files[0]));
    NodeFS.copyFileSync(files[0], copy);
    return {
      file: files[0],
      lines: lines.length,
      sha256: sha256(NodeFS.readFileSync(files[0])),
      userTurns,
      replyTwo: two.reply,
    };
  });
} catch (error) {
  failure = String(error?.message ?? error);
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
result.steps = steps;
result.endedAt = new Date().toISOString();
result.failure = failure;
NodeFS.writeFileSync(NodePath.join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
for (const client of Object.values(clients)) client.page.close();
console.log(
  failure ? `FAILED: ${failure}` : `all steps completed → ${NodePath.join(outDir, "result.json")}`,
);
process.exit(failure ? 1 : 0);
