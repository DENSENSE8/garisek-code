import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

const BIN = NodePath.join(import.meta.dirname, "../bin/garisek-omp-rpc.ts");

// A stand-in omp that speaks the OMP dialect: v2 negotiation, rpc_chunk framing, session_settled.
const FAKE_OMP = `#!/usr/bin/env node
if (process.argv[2] === "session" && process.argv[3] === "lease") {
  const ids = process.argv.slice(process.argv.indexOf("--") + 1);
  console.log(JSON.stringify({ held: ids.filter((id) => id.startsWith("live-")), unknown: [] }));
  process.exit(0);
}
if (!process.argv.includes("rpc")) { console.log("omp/0.0.0-fake " + process.argv.slice(2).join(" ")); process.exit(0); }
const out = (r) => process.stdout.write(JSON.stringify(r) + "\\n");
if (process.argv.includes("--offline")) process.exit(3);
if (process.argv.includes("--exit-now")) { out({ type: "ready", supportedProtocolVersions: [1] }); process.exit(7); }
let v2 = false;
out({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1024, maxReassembledFrameBytes: 1 << 20 });
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const r = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (r.type === "negotiate_protocol") { v2 = true; out({ id: r.id, type: "response", command: r.type, success: true }); }
    else if (r.type === "switch_session") out({ id: r.id, type: "response", command: r.type, success: true, data: { cancelled: false } });
    else if (r.type === "get_available_commands") out({ id: r.id, type: "response", command: r.type, success: true, data: { commands: [{ name: "plan", source: "builtin" }] } });
    else if (r.type === "prompt") {
      out({ id: r.id, type: "response", command: "prompt", success: true });
      out({ type: "agent_start" });
      const big = Buffer.from(JSON.stringify({ type: "agent_end", messages: [{ text: "x".repeat(5000) }], v2 }));
      const n = Math.ceil(big.length / 900);
      for (let k = 0; k < n; k++) out({ type: "rpc_chunk", chunkId: "c1", index: k, count: n, byteLength: big.length, data: big.subarray(k * 900, (k + 1) * 900).toString("base64") });
      out({ type: "prompt_result", id: r.id, agentInvoked: true, status: "completed", sessionSettled: true });
      out({ type: "session_settled" });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`;

const fakeOmp = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fake-omp-"));
  const file = NodePath.join(dir, "omp");
  NodeFS.writeFileSync(file, FAKE_OMP);
  NodeFS.chmodSync(file, 0o755);
  return file;
};
// Like T3, keep stdin open until the session settles; closing early would race v2 negotiation.
const run = (args: string[], input: object[], keepStdinOpen = false) => {
  const { promise, resolve } = Promise.withResolvers<{ code: number | null; stdout: string }>();
  const child = NodeChildProcess.spawn(process.execPath, [BIN, ...args], {
    env: { ...process.env, GARISEK_OMP_BINARY: fakeOmp() },
  });
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => {
    stdout += d;
    if (stdout.includes('"agent_settled"')) child.stdin.end();
  });
  child.on("exit", (code) => resolve({ code, stdout }));
  for (const r of input) child.stdin.write(`${JSON.stringify(r)}\n`);
  if (input.length === 0 && !keepStdinOpen) child.stdin.end();
  return Effect.promise(() => promise);
};

it.live("translates a whole OMP RPC session into the Pi dialect", () =>
  Effect.gen(function* () {
    const { code, stdout } = yield* run(
      ["--mode", "rpc", "--session-dir", "/tmp/x", "--offline"],
      [
        { id: "1", type: "get_commands" },
        { id: "2", type: "prompt", message: "hi" },
      ],
    );
    expect(code).toBe(0);
    const frames = stdout
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(frames.map((f) => f.type)).toEqual([
      "ready",
      "response",
      "response",
      "agent_start",
      "agent_end",
      "prompt_result",
      "agent_settled",
    ]);
    expect(frames[1]).toMatchObject({
      id: "1",
      command: "get_commands",
      data: { commands: [{ name: "plan" }] },
    });
    expect(frames[4]).toMatchObject({ v2: true });
    expect(frames[6]).toEqual({ type: "agent_settled", aborted: false });
  }),
);

it.live("passes non-RPC invocations such as --version straight through", () =>
  Effect.gen(function* () {
    const { code, stdout } = yield* run(["--version"], []);
    expect(code).toBe(0);
    expect(stdout).toBe("omp/0.0.0-fake --version\n");
  }),
);

it.live("exits with omp's status when omp exits while the host keeps stdin open", () =>
  Effect.gen(function* () {
    const { code, stdout } = yield* run(["--mode", "rpc", "--exit-now"], [], true);
    expect(code).toBe(7);
    expect(stdout).toContain('"ready"');
  }),
);

const sessionFile = (id: string) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "omp-session-"));
  const file = NodePath.join(dir, `${id}.jsonl`);
  NodeFS.writeFileSync(
    file,
    `${JSON.stringify({ type: "title", v: 1 })}\n${JSON.stringify({ type: "session", version: 3, id })}\n`,
  );
  return file;
};

it.live("refuses to attach to a session another live omp is writing, and allows a closed one", () =>
  Effect.gen(function* () {
    const { stdout } = yield* run(
      ["--mode", "rpc"],
      [
        { id: "live", type: "switch_session", sessionPath: sessionFile("live-1") },
        { id: "closed", type: "switch_session", sessionPath: sessionFile("closed-1") },
        { id: "p", type: "prompt", message: "hi" },
      ],
    );
    const frames = stdout
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(frames.find((f) => f.id === "live")).toMatchObject({
      success: false,
      command: "switch_session",
      error: { code: "session_in_use" },
    });
    expect(JSON.stringify(frames.find((f) => f.id === "live")?.error)).toContain("live-1");
    expect(frames.find((f) => f.id === "closed")).toMatchObject({ success: true });
  }),
);
