import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

import * as AcpAgent from "effect-acp/agent";
import * as AcpError from "effect-acp/errors";
import type * as AcpSchema from "effect-acp/schema";

import {
  spawnOmpSession,
  nextOmpId,
  type OmpEvent,
  type OmpFrame,
  type OmpSession,
} from "./omp-process.ts";

// -32602 = Invalid params (closest JSON-RPC code for a bad session reference)
const badRequest = (msg: string) =>
  new AcpError.AcpRequestError({ code: -32602, errorMessage: msg });

const waitForPromptAck = Effect.fn("OmpAcp.waitForPromptAck")(function* (
  events: Queue.Queue<OmpEvent>,
  promptId: string,
) {
  const buffer: OmpEvent[] = [];
  for (;;) {
    const ev = yield* Queue.take(events);
    if (ev._tag === "exit") {
      for (const e of buffer) yield* Queue.offer(events, e);
      return yield* badRequest("OMP exited before prompt ack");
    }
    if (ev.frame.type === "response" && ev.frame.id === promptId) {
      for (const e of buffer) yield* Queue.offer(events, e);
      if (ev.frame.success !== true) {
        return yield* badRequest(
          typeof ev.frame.error === "string" ? ev.frame.error : "OMP rejected prompt",
        );
      }
      return;
    }
    buffer.push(ev);
  }
});

const handlePermissionRequest = Effect.fn("OmpAcp.handlePermissionRequest")(function* (
  agent: AcpAgent.AcpAgent["Service"],
  session: OmpSession,
  sessionId: string,
  frame: OmpFrame,
) {
  const nativeId = typeof frame.id === "string" ? frame.id : "";
  const method = typeof frame.method === "string" ? frame.method : "confirm";
  const title = typeof frame.title === "string" ? frame.title : method;
  const description = typeof frame.message === "string" ? frame.message : undefined;

  const options: AcpSchema.PermissionOption[] =
    method === "select" && Array.isArray(frame.options) && frame.options.length > 0
      ? frame.options.map((opt, i) => ({
          optionId: String(i),
          name: String(opt),
          kind: "allow_once" as const,
        }))
      : [
          { optionId: "allow", name: "Allow", kind: "allow_once" as const },
          { optionId: "deny", name: "Deny", kind: "reject_once" as const },
        ];

  const resp = yield* agent.client.requestPermission({
    sessionId,
    title,
    ...(description !== undefined ? { description } : {}),
    options,
  });

  const outcome = resp.outcome;
  if (method === "select") {
    const idx =
      outcome.outcome === "selected" && typeof outcome.optionId === "string"
        ? parseInt(outcome.optionId, 10)
        : 0;
    session.write({
      type: "extension_ui_response",
      id: nativeId,
      selectedIndex: isNaN(idx) ? 0 : idx,
    });
  } else {
    session.write({
      type: "extension_ui_response",
      id: nativeId,
      confirmed: outcome.outcome === "selected" && outcome.optionId === "allow",
    });
  }
});

const streamOmpEvents = Effect.fn("OmpAcp.streamOmpEvents")(function* (
  agent: AcpAgent.AcpAgent["Service"],
  session: OmpSession,
  sessionId: string,
) {
  let lastPromptStatus: string | undefined;
  let msgSeq = 0;

  const notify = (update: AcpSchema.SessionUpdate) =>
    agent.client.sessionUpdate({ sessionId, update }).pipe(Effect.ignore);

  for (;;) {
    const ev = yield* Queue.take(session.events);
    if (ev._tag === "exit") {
      yield* notify({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
      return;
    }
    const frame = ev.frame;

    if (frame.type === "agent_start") {
      yield* notify({ sessionUpdate: "state_update", state: "running" });
      continue;
    }

    if (frame.type === "message_update") {
      const delta = frame.assistantMessageEvent;
      const deltaType =
        delta !== null && typeof delta === "object" && "type" in delta ? String(delta.type) : "";
      if (deltaType === "text_delta" || deltaType === "thinking_delta") {
        const text =
          delta !== null &&
          typeof delta === "object" &&
          "delta" in delta &&
          typeof delta.delta === "string"
            ? delta.delta
            : "";
        yield* notify({
          sessionUpdate:
            deltaType === "thinking_delta" ? "agent_thought_chunk" : "agent_message_chunk",
          messageId: `m${++msgSeq}`,
          content: { type: "text", text },
        });
      }
      continue;
    }

    if (frame.type === "tool_execution_start") {
      const tcId = typeof frame.toolCallId === "string" ? frame.toolCallId : nextOmpId();
      const name = typeof frame.toolName === "string" ? frame.toolName : undefined;
      yield* notify({
        sessionUpdate: "tool_call_update",
        toolCallId: `tc-${tcId}`,
        ...(name !== undefined ? { name, title: name } : {}),
        status: "in_progress",
      });
      continue;
    }

    if (frame.type === "tool_execution_end") {
      const tcId = typeof frame.toolCallId === "string" ? frame.toolCallId : "";
      yield* notify({
        sessionUpdate: "tool_call_update",
        toolCallId: `tc-${tcId}`,
        status: frame.isError === true ? "failed" : "completed",
      });
      continue;
    }

    if (frame.type === "extension_ui_request") {
      yield* handlePermissionRequest(agent, session, sessionId, frame).pipe(Effect.ignore);
      continue;
    }

    if (frame.type === "prompt_result") {
      if (typeof frame.status === "string") lastPromptStatus = frame.status;
      continue;
    }

    if (frame.type === "session_settled") {
      yield* notify({
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: lastPromptStatus === "aborted" ? "cancelled" : "end_turn",
      });
      return;
    }
  }
});

const replayHistory = Effect.fn("OmpAcp.replayHistory")(function* (
  agent: AcpAgent.AcpAgent["Service"],
  session: OmpSession,
  sessionId: string,
) {
  const reqId = nextOmpId();
  session.write({ id: reqId, type: "get_messages" });

  const buffer: OmpEvent[] = [];
  let resp: OmpFrame | undefined;
  for (;;) {
    const ev = yield* Queue.take(session.events);
    if (ev._tag === "exit") break;
    if (ev.frame.type === "response" && ev.frame.id === reqId) {
      resp = ev.frame;
      break;
    }
    buffer.push(ev);
  }
  for (const e of buffer) yield* Queue.offer(session.events, e);

  if (!resp) return;
  const data = resp.data;
  const messages: OmpFrame[] =
    data !== null && typeof data === "object" && "messages" in data && Array.isArray(data.messages)
      ? (data.messages as OmpFrame[])
      : [];

  let msgN = 0;
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const content = msg.content;
    const text =
      typeof msg.text === "string"
        ? msg.text
        : content !== null &&
            typeof content === "object" &&
            "text" in content &&
            typeof content.text === "string"
          ? content.text
          : undefined;
    if (!text) continue;
    yield* agent.client
      .sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: `replay-${++msgN}`,
          content: { type: "text", text },
        },
      })
      .pipe(Effect.ignore);
  }
  yield* agent.client
    .sessionUpdate({ sessionId, update: { sessionUpdate: "state_update", state: "idle" } })
    .pipe(Effect.ignore);
});

export const setup = Effect.fn("OmpAcp.setup")(function* (binary: string) {
  const agentScope = yield* Effect.scope;
  const agent = yield* AcpAgent.AcpAgent;
  const sessions = yield* Ref.make(new Map<string, OmpSession>());

  const addSession = (s: OmpSession) =>
    Ref.update(sessions, (m) => new Map([...m, [s.sessionFile, s]]));

  const spawn = (extraArgs: ReadonlyArray<string>, cwd: string) =>
    spawnOmpSession(binary, extraArgs, cwd).pipe(
      Scope.provide(agentScope),
      Effect.mapError(
        (e) =>
          new AcpError.AcpRequestError({
            code: -32603,
            errorMessage: `OMP spawn failed: ${e.message}`,
          }),
      ),
    );

  yield* agent.handleInitialize((_req) =>
    Effect.succeed({
      protocolVersion: 2 as const,
      info: { name: "garisek-omp-acp", version: "0.0.0" },
      capabilities: { session: { prompt: { image: {} } } },
    }),
  );

  yield* agent.handleCreateSession(
    Effect.fn("OmpAcp.createSession")(function* (req) {
      const session = yield* spawn([], req.cwd);
      yield* addSession(session);
      return { sessionId: session.sessionFile };
    }),
  );

  yield* agent.handleLoadSession(
    Effect.fn("OmpAcp.loadSession")(function* (req) {
      const session = yield* spawn(["--session", req.sessionId], ".");
      yield* addSession(session);
      yield* Effect.forkDetach(replayHistory(agent, session, session.sessionFile));
      return {};
    }),
  );

  yield* agent.handleResumeSession(
    Effect.fn("OmpAcp.resumeSession")(function* (req) {
      const session = yield* spawn(["--session", req.sessionId], ".");
      yield* addSession(session);
      return {};
    }),
  );

  yield* agent.handlePrompt(
    Effect.fn("OmpAcp.prompt")(function* (req) {
      const sessionMap = yield* Ref.get(sessions);
      const s = sessionMap.get(req.sessionId);
      if (s === undefined) return yield* badRequest(`Unknown session: ${req.sessionId}`);
      const text = req.prompt.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
      const promptId = nextOmpId();
      s.write({ id: promptId, type: "prompt", message: text });
      yield* waitForPromptAck(s.events, promptId);
      yield* Effect.forkDetach(streamOmpEvents(agent, s, req.sessionId));
      return {};
    }),
  );

  yield* agent.handleCancel(
    Effect.fn("OmpAcp.cancel")(function* (notification) {
      const sessionMap = yield* Ref.get(sessions);
      sessionMap.get(notification.sessionId)?.write({ type: "abort" });
    }),
  );

  return yield* Effect.never;
});
