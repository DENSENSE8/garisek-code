// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as NodeServices from "@effect/platform-node/NodeServices";

import * as AcpClient from "effect-acp/client";
import type * as AcpCompat from "effect-acp/compat";

const BIN = NodePath.join(import.meta.dirname, "../bin/garisek-omp-acp.ts");
const LIVE = process.env.GARISEK_LIVE_OMP === "1";
const ompBinary = process.env.GARISEK_OMP_BINARY ?? "omp";

it.live.skipIf(!LIVE)(
  "live OMP: set model, prompt to read probe.txt, assert tool_call + text token",
  () =>
    Effect.gen(function* () {
      const tmpDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "garisek-omp-live-"));
      NodeFS.writeFileSync(NodePath.join(tmpDir, "probe.txt"), "GARISEK_PROBE_TOKEN_12345");

      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner.spawn(
        ChildProcess.make(process.execPath, [BIN], {
          cwd: NodePath.join(import.meta.dirname, ".."),
          env: {
            ...process.env,
            GARISEK_OMP_BINARY: ompBinary,
          },
        }),
      );

      const updates = yield* Ref.make<AcpCompat.SessionUpdate[]>([]);

      yield* Effect.gen(function* () {
        const acp = yield* AcpClient.AcpClient;

        yield* acp.handleSessionUpdate((n) => Ref.update(updates, (arr) => [...arr, n.update]));

        yield* acp.agent.initialize({ protocolVersion: 2 });

        const created = yield* acp.agent.createSession({ cwd: tmpDir, mcpServers: [] });
        const sessionId = created.sessionId;

        // Select haiku model (OMP uses provider/model naming via set_model RPC)
        yield* acp.agent
          .setSessionModel({ sessionId, modelId: "anthropic/claude-haiku-5-5" })
          .pipe(Effect.ignore);

        const result = yield* acp.agent.prompt({
          sessionId,
          prompt: [
            {
              type: "text" as const,
              text: "Read the file probe.txt in the current directory and tell me exactly what token it contains.",
            },
          ],
        });

        const collected = yield* Ref.get(updates);

        const hasToolCall = collected.some((u) => u.sessionUpdate === "tool_call_update");
        assert.ok(hasToolCall, "should have at least one tool call");

        const textCombined = collected
          .filter(
            (u): u is Extract<AcpCompat.SessionUpdate, { sessionUpdate: "agent_message_chunk" }> =>
              u.sessionUpdate === "agent_message_chunk",
          )
          .map((c) => (c.content.type === "text" ? c.content.text : ""))
          .join("");
        assert.include(
          textCombined,
          "GARISEK_PROBE_TOKEN_12345",
          "response must contain the probe token",
        );
        assert.ok(result.stopReason === "end_turn" || result.stopReason === "max_turns");
      }).pipe(Effect.provide(AcpClient.layerChildProcess(handle)));
    }).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 120_000 },
);
