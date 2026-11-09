#!/usr/bin/env node
// AC1 receipt: drives garisek-omp-acp over ACP v2 JSON-RPC against real OMP and records the whole
// exchange. Checks: a new session reads a file whose token never appears in the prompt; a session
// another live omp holds is refused on load; a closed session resumes into the same file.
// Usage: omp-acp-receipt.mjs --out <dir> [--live-session <path>] [--closed-session <path>]
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

const args = {};
for (let index = 2; index < process.argv.length; index += 2) {
  args[process.argv[index].replace(/^--/, "")] = process.argv[index + 1] ?? "";
}
if (!args.out) {
  console.error(
    "usage: omp-acp-receipt.mjs --out <dir> [--live-session <path>] [--closed-session <path>]",
  );
  process.exit(2);
}
const repo = NodePath.resolve(import.meta.dirname, "../..");
const bin = NodePath.join(repo, "packages/omp-acp/bin/garisek-omp-acp.ts");
const model = args.model || "anthropic/claude-haiku-5-5";
const outDir = NodePath.resolve(args.out);
NodeFS.mkdirSync(outDir, { recursive: true });
const token = `ac1-${NodeCrypto.randomBytes(6).toString("hex")}`;
const lineCount = (file) =>
  NodeFS.existsSync(file)
    ? NodeFS.readFileSync(file, "utf8").split("\n").filter(Boolean).length
    : 0;

const exchange = [];
const child = NodeChildProcess.spawn(process.execPath, [bin], {
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});
const stderr = [];
child.stderr.on("data", (chunk) => stderr.push(chunk));
let nextId = 0;
const pending = new Map();
const updates = [];
const permissionRequests = [];
NodeReadline.createInterface({ input: child.stdout }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  exchange.push({ at: new Date().toISOString(), direction: "agent→client", message });
  if (message.method === undefined && message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  } else if (message.method === "session/update") {
    updates.push(message.params);
  } else if (message.method === "session/request_permission" && message.id !== undefined) {
    // Answer like an interactive client that approves; the exchange log keeps every prompt.
    permissionRequests.push(message.params.title);
    const reply = {
      jsonrpc: "2.0",
      id: message.id,
      result: { outcome: { outcome: "selected", optionId: "allow" } },
    };
    exchange.push({ at: new Date().toISOString(), direction: "client→agent", message: reply });
    child.stdin.write(`${JSON.stringify(reply)}\n`);
  }
});
const request = (method, params) =>
  new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    const message = { jsonrpc: "2.0", id, method, params };
    exchange.push({ at: new Date().toISOString(), direction: "client→agent", message });
    child.stdin.write(`${JSON.stringify(message)}\n`);
  });
const ok = async (method, params) => {
  const response = await request(method, params);
  if (response.error) throw new Error(`${method}: ${JSON.stringify(response.error)}`);
  return response.result;
};

async function turn(sessionId, text, timeoutMs = 180_000) {
  const from = updates.length;
  await ok("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const mine = updates.slice(from).filter((params) => params.sessionId === sessionId);
    const done = mine.find(
      (params) =>
        params.update.sessionUpdate === "state_update" &&
        params.update.state === "idle" &&
        params.update.stopReason,
    );
    if (done) {
      const reply = mine
        .filter((params) => params.update.sessionUpdate === "agent_message_chunk")
        .map((params) => params.update.content?.text ?? "")
        .join("");
      const tools = mine
        .filter(
          (params) => params.update.sessionUpdate === "tool_call_update" && params.update.name,
        )
        .map((params) => params.update.name);
      return { stopReason: done.update.stopReason, reply, tools };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`turn did not reach idle within ${timeoutMs / 1000}s`);
}

const checks = {};
const record = (name, pass, detail) => {
  checks[name] = { pass, ...detail };
  console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
};
try {
  await ok("initialize", {
    protocolVersion: 2,
    capabilities: {},
    info: { name: "garisek-ac1-receipt", version: "0" },
  });

  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "garisek-ac1-"));
  NodeFS.writeFileSync(NodePath.join(cwd, "probe.txt"), `${token}\n`);
  const created = await ok("session/new", { cwd, mcpServers: [] });
  await ok("session/set_config_option", {
    sessionId: created.sessionId,
    configId: "model",
    type: "id",
    value: model,
  });
  await ok("session/set_config_option", {
    sessionId: created.sessionId,
    configId: "thinking",
    type: "id",
    value: "off",
  });
  const fresh = await turn(
    created.sessionId,
    "Use the read tool on probe.txt in the current directory and reply with exactly its contents.",
  );
  record(
    "new-session-read",
    fresh.reply.includes(token) && fresh.tools.includes("read") && fresh.stopReason === "end_turn",
    {
      sessionFile: created.sessionId,
      linesAfter: lineCount(created.sessionId),
      tokenInFile: NodeFS.readFileSync(created.sessionId, "utf8").includes(token),
      ...fresh,
    },
  );

  if (args["live-session"]) {
    const before = lineCount(args["live-session"]);
    const response = await request("session/resume", {
      sessionId: args["live-session"],
      cwd,
      mcpServers: [],
      replayFrom: { type: "start" },
    });
    record(
      "live-session-refused",
      Boolean(response.error) &&
        JSON.stringify(response.error).includes("session_in_use") &&
        lineCount(args["live-session"]) >= before,
      {
        sessionFile: args["live-session"],
        error: response.error ?? null,
      },
    );
  }

  if (args["closed-session"]) {
    const file = args["closed-session"];
    const before = lineCount(file);
    const marker = `ac1-resume-${NodeCrypto.randomBytes(4).toString("hex")}`;
    await ok("session/resume", { sessionId: file, cwd, mcpServers: [] });
    await ok("session/set_config_option", {
      sessionId: file,
      configId: "model",
      type: "id",
      value: model,
    });
    const resumed = await turn(file, `Reply with exactly: ${marker}`);
    const after = lineCount(file);
    record(
      "closed-session-resumed",
      resumed.reply.includes(marker) &&
        after > before &&
        NodeFS.readFileSync(file, "utf8").includes(marker),
      {
        sessionFile: file,
        linesBefore: before,
        linesAfter: after,
        ...resumed,
      },
    );
  }
} catch (error) {
  record("run", false, { error: String(error?.message ?? error) });
} finally {
  child.stdin.end();
  await new Promise((resolve) => {
    child.on("close", resolve);
    setTimeout(() => {
      child.kill();
      resolve();
    }, 5000);
  });
}

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
NodeFS.writeFileSync(
  NodePath.join(outDir, `AC1-exchange-${stamp}.jsonl`),
  exchange.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
);
NodeFS.writeFileSync(NodePath.join(outDir, `AC1-stderr-${stamp}.txt`), Buffer.concat(stderr));
const summary = {
  takenAt: new Date().toISOString(),
  model,
  thinking: "off",
  token,
  bridge: bin,
  permissionRequests,
  checks,
};
NodeFS.writeFileSync(
  NodePath.join(outDir, `AC1-summary-${stamp}.json`),
  `${JSON.stringify(summary, null, 2)}\n`,
);
process.exit(Object.values(checks).every((check) => check.pass) ? 0 : 1);
