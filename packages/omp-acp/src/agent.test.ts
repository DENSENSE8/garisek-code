// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as NodeServices from "@effect/platform-node/NodeServices";

import * as AcpClient from "effect-acp/client";
import type * as AcpCompat from "effect-acp/compat";

const BIN = NodePath.join(import.meta.dirname, "../bin/garisek-omp-acp.ts");

// Stand-in OMP: v2 protocol, one full prompt turn, then handles abort.
const FAKE_OMP_SCRIPT = /* javascript */ `#!/usr/bin/env node
const SESSION_FILE = "/tmp/fake-omp-acp-session.jsonl";
const out = (r) => process.stdout.write(JSON.stringify(r) + "\\n");
if (process.argv[2] === "session" && process.argv[3] === "lease") {
  const ids = process.argv.slice(process.argv.indexOf("--") + 1);
  out({ held: ids.filter((id) => id.startsWith("live-")), unknown: [] });
  process.exit(0);
}
if (process.argv.includes("--session")) require("node:fs").appendFileSync(SESSION_FILE + ".spawns", process.argv.join(" ") + "\\n");
out({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });
let buf = "";
let promptCount = 0;
let resumeTurn = null;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const r = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (r.type === "negotiate_protocol") {
      out({ id: r.id, type: "response", command: "negotiate_protocol", success: true });
    } else if (r.type === "get_state") {
      out({ id: r.id, type: "response", command: "get_state", success: true, data: { sessionId: "fake-sid", sessionFile: SESSION_FILE } });
    } else if (r.type === "set_model") {
      out({ id: r.id, type: "response", command: "set_model", success: true, data: {} });
    } else if (r.type === "prompt") {
      promptCount++;
      out({ id: r.id, type: "response", command: "prompt", success: true });
      out({ type: "agent_start" });
      if (promptCount === 1) {
        out({ type: "extension_ui_request", id: "ui-notify", method: "notify", message: "rule-router: inert here" });
        out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello", contentIndex: 0 } });
        out({ type: "extension_ui_request", id: "ui-confirm", method: "confirm", title: "Run tests?", message: "npm test" });
        // Like real OMP, the turn waits for the confirm dialog's answer before it continues.
        resumeTurn = () => {
          out({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "thinking...", contentIndex: 1 } });
          out({ type: "tool_execution_start", toolCallId: "tc1", toolName: "read_file" });
          out({ type: "tool_execution_end", toolCallId: "tc1", toolName: "read_file", isError: false, result: { content: [{ type: "text", text: "file contents" }] } });
          out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " world", contentIndex: 0 } });
          out({ type: "prompt_result", id: r.id, agentInvoked: true, status: "completed", sessionSettled: true });
          out({ type: "session_settled" });
        };
      }
    } else if (r.type === "extension_ui_response") {
      require("node:fs").appendFileSync(SESSION_FILE + ".ui", JSON.stringify(r) + "\\n");
      if (r.id === "ui-confirm" && resumeTurn) { const resume = resumeTurn; resumeTurn = null; resume(); }
    } else if (r.type === "abort") {
      out({ type: "prompt_result", status: "aborted", sessionSettled: true });
      out({ type: "session_settled" });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`;

const writeFakeOmp = (): string => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fake-omp-acp-"));
  const file = NodePath.join(dir, "omp");
  NodeFS.writeFileSync(file, FAKE_OMP_SCRIPT);
  NodeFS.chmodSync(file, 0o755);
  return file;
};

it.live(
  "omp-acp: initialize → session/new → session/prompt (text, thought, tool_call) → cancel second prompt → stopReason cancelled",
  () =>
    Effect.gen(function* () {
      const fakeOmp = writeFakeOmp();
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner.spawn(
        ChildProcess.make(process.execPath, [BIN], {
          cwd: NodePath.join(import.meta.dirname, ".."),
          env: { ...process.env, GARISEK_OMP_BINARY: fakeOmp },
        }),
      );

      const updates = yield* Ref.make<AcpCompat.SessionUpdate[]>([]);
      const permissionTitles = yield* Ref.make<string[]>([]);
      NodeFS.rmSync("/tmp/fake-omp-acp-session.jsonl.ui", { force: true });

      yield* Effect.gen(function* () {
        const acp = yield* AcpClient.AcpClient;

        yield* acp.handleSessionUpdate((notification) =>
          Ref.update(updates, (arr) => [...arr, notification.update]),
        );
        yield* acp.handleRequestPermission((request) =>
          Ref.update(permissionTitles, (titles) => [...titles, String(request.title)]).pipe(
            Effect.as({ outcome: { outcome: "selected" as const, optionId: "allow" } }),
          ),
        );

        const initialized = yield* acp.agent.initialize({ protocolVersion: 2 });
        assert.ok(
          initialized.agentCapabilities !== null && initialized.agentCapabilities !== undefined,
        );

        const created = yield* acp.agent.createSession({ cwd: NodeOS.tmpdir(), mcpServers: [] });
        const sessionId = created.sessionId;

        // First prompt — blocks until state_update: idle
        const first = yield* acp.agent.prompt({
          sessionId,
          prompt: [{ type: "text" as const, text: "say hello" }],
        });
        assert.equal(first.stopReason, "end_turn");

        const collected = yield* Ref.get(updates);
        const kinds = new Set(collected.map((u) => u.sessionUpdate));
        assert.ok(kinds.has("agent_message_chunk"), "must have text chunks");
        assert.ok(kinds.has("agent_thought_chunk"), "must have thought chunks");
        assert.ok(kinds.has("tool_call_update"), "must have tool call updates");

        const textCombined = collected
          .filter(
            (u): u is Extract<AcpCompat.SessionUpdate, { sessionUpdate: "agent_message_chunk" }> =>
              u.sessionUpdate === "agent_message_chunk",
          )
          .map((c) => (c.content.type === "text" ? c.content.text : ""))
          .join("");
        assert.include(textCombined, "Hello");

        const toolStatuses = collected
          .filter(
            (u): u is Extract<AcpCompat.SessionUpdate, { sessionUpdate: "tool_call_update" }> =>
              u.sessionUpdate === "tool_call_update",
          )
          .map((u) => u.status);
        assert.include(toolStatuses, "in_progress");
        assert.include(toolStatuses, "completed");

        // notify is fire-and-forget; only the confirm dialog may reach the client, and its answer
        // must flow back to OMP.
        assert.deepEqual(yield* Ref.get(permissionTitles), ["Run tests?"]);
        const answers = NodeFS.readFileSync("/tmp/fake-omp-acp-session.jsonl.ui", "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        assert.deepEqual(answers, [
          { type: "extension_ui_response", id: "ui-confirm", confirmed: true },
        ]);

        // Second prompt — cancel midway, expect stopReason: cancelled
        const secondFiber = yield* acp.agent
          .prompt({ sessionId, prompt: [{ type: "text" as const, text: "again" }] })
          .pipe(Effect.forkChild);

        yield* acp.agent.cancel({ sessionId });

        const second = yield* Fiber.join(secondFiber);
        assert.equal(second.stopReason, "cancelled");

        // A session another live omp leases is refused, and no writer is spawned for it (O3).
        const liveFile = NodePath.join(
          NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "omp-acp-")),
          "live.jsonl",
        );
        NodeFS.writeFileSync(
          liveFile,
          `${JSON.stringify({ type: "session", version: 3, id: "live-1" })}\n`,
        );
        NodeFS.rmSync("/tmp/fake-omp-acp-session.jsonl.spawns", { force: true });
        const refused = yield* acp.agent
          .loadSession({ sessionId: liveFile, cwd: NodeOS.tmpdir(), mcpServers: [] })
          .pipe(Effect.flip);
        assert.include(JSON.stringify(refused), "session_in_use");
        assert.isFalse(NodeFS.existsSync("/tmp/fake-omp-acp-session.jsonl.spawns"));
      }).pipe(Effect.provide(AcpClient.layerChildProcess(handle)));
    }).pipe(Effect.provide(NodeServices.layer)),
);
