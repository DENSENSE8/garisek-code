// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";

import * as AcpError from "effect-acp/errors";

import { ChunkAssembler, type RpcRecord } from "@t3tools/provider-omp/dialect";

const NEGOTIATE_ID = "garisek-omp-acp-v2";
const HANDSHAKE_TIMEOUT_MS = 15_000;

export type OmpFrame = Record<string, unknown>;

export type OmpEvent =
  | { readonly _tag: "frame"; readonly frame: OmpFrame }
  | { readonly _tag: "exit"; readonly code: number };

export interface OmpSession {
  readonly sessionFile: string;
  readonly write: (record: OmpFrame) => void;
  readonly events: Queue.Queue<OmpEvent>;
}

let _reqId = 0;
export const nextOmpId = (): string => `garisek-omp-${++_reqId}`;

const takeFrame = Effect.fn("OmpProcess.takeFrame")(function* (
  events: Queue.Queue<OmpEvent>,
  pred: (frame: OmpFrame) => boolean,
  buffer: OmpEvent[],
) {
  for (;;) {
    const ev = yield* Queue.take(events);
    if (ev._tag === "exit") {
      for (const e of buffer) yield* Queue.offer(events, e);
      return yield* new AcpError.AcpTransportError({
        operation: "read-input-stream",
        detail: `OMP exited unexpectedly (code ${ev.code})`,
        cause: undefined,
      });
    }
    if (pred(ev.frame)) {
      for (const e of buffer) yield* Queue.offer(events, e);
      return ev.frame;
    }
    buffer.push(ev);
  }
});

const isTransportError = Schema.is(AcpError.AcpTransportError);

export const spawnOmpSession = Effect.fn("OmpProcess.spawnOmpSession")(function* (
  binary: string,
  extraArgs: ReadonlyArray<string>,
  cwd: string,
) {
  const events = yield* Queue.unbounded<OmpEvent>();
  const ctx = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(ctx);

  const child = NodeChildProcess.spawn(binary, ["--mode", "rpc", ...extraArgs], {
    cwd,
    stdio: ["pipe", "pipe", "inherit"],
  });

  const scope = yield* Effect.scope;
  yield* Scope.addFinalizer(
    scope,
    Effect.sync(() => {
      if (!child.killed) child.kill("SIGTERM");
    }),
  );

  child.on("error", () => {
    runFork(Queue.offer(events, { _tag: "exit", code: 127 } as const));
  });
  child.on("close", (code) => {
    runFork(Queue.offer(events, { _tag: "exit", code: code ?? 1 } as const));
  });

  let assembler = new ChunkAssembler(64 * 1024 * 1024);
  const write = (record: OmpFrame): void => {
    child.stdin!.write(`${JSON.stringify(record)}\n`);
  };

  let lineBuf = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    lineBuf += chunk;
    let i: number;
    while ((i = lineBuf.indexOf("\n")) >= 0) {
      const line = lineBuf.slice(0, i);
      lineBuf = lineBuf.slice(i + 1);
      if (line.length === 0) continue;
      let record: OmpFrame;
      try {
        record = JSON.parse(line) as OmpFrame;
      } catch {
        continue;
      }
      let whole: OmpFrame | null;
      try {
        whole = assembler.push(record as RpcRecord) as OmpFrame | null;
      } catch {
        child.kill("SIGTERM");
        return;
      }
      if (whole === null) continue;
      if (whole.type === "ready") {
        const limit = whole.maxReassembledFrameBytes;
        if (typeof limit === "number" && limit > 0) assembler = new ChunkAssembler(limit);
      }
      runFork(Queue.offer(events, { _tag: "frame", frame: whole } as const));
    }
  });

  const buffer: OmpEvent[] = [];

  const ready = yield* takeFrame(events, (f) => f.type === "ready", buffer);
  if (
    Array.isArray(ready.supportedProtocolVersions) &&
    ready.supportedProtocolVersions.includes(2)
  ) {
    write({ id: NEGOTIATE_ID, type: "negotiate_protocol", protocolVersion: 2 });
    yield* takeFrame(events, (f) => f.type === "response" && f.id === NEGOTIATE_ID, buffer).pipe(
      Effect.timeout(HANDSHAKE_TIMEOUT_MS),
      Effect.mapError((e) =>
        isTransportError(e)
          ? e
          : new AcpError.AcpTransportError({ detail: "v2 negotiation timed out", cause: e }),
      ),
    );
  }

  const stateId = nextOmpId();
  write({ id: stateId, type: "get_state" });
  const stateResp = yield* takeFrame(
    events,
    (f) => f.type === "response" && f.id === stateId,
    buffer,
  );
  const data = stateResp.data;
  const sessionFile =
    data !== null &&
    typeof data === "object" &&
    "sessionFile" in data &&
    typeof data.sessionFile === "string"
      ? data.sessionFile
      : data !== null &&
          typeof data === "object" &&
          "sessionId" in data &&
          typeof data.sessionId === "string"
        ? data.sessionId
        : "omp-session-fallback";

  return { sessionFile, write, events } satisfies OmpSession;
});
