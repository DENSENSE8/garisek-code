// Runs `omp` where T3's Pi driver expects `pi`: argv passes through unchanged; in `--mode rpc`
// the JSONL stream is translated by OmpDialect in both directions.
import * as NodeChildProcess from "node:child_process";
import { liveSessionOwner, SESSION_IN_USE } from "./lease.ts";
import {
  ChunkAssembler,
  NEGOTIATE_ID,
  OmpDialect,
  translateArgs,
  type RpcRecord,
} from "./dialect.ts";

const DEFAULT_REASSEMBLY_LIMIT = 64 * 1024 * 1024;
// OMP writes `ready` at startup; an OMP without it must not hang the host forever.
const HANDSHAKE_TIMEOUT_MS = 10_000;

export function runShim(argv: ReadonlyArray<string>, binary: string): void {
  const modeIndex = argv.indexOf("--mode");
  const rpc = (modeIndex >= 0 && argv[modeIndex + 1] === "rpc") || argv.includes("--mode=rpc");
  const child = NodeChildProcess.spawn(binary, translateArgs(argv), {
    stdio: rpc ? ["pipe", "pipe", "inherit"] : "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", (error) => {
    process.stderr.write(`garisek-omp-rpc: cannot start ${binary}: ${error.message}\n`);
    process.exit(127);
  });
  // `close` fires after omp's stdout is drained; leaving with it keeps the host from waiting
  // on a shim whose omp already exited (e.g. on a rejected flag).
  child.on("close", (code, signal) => {
    const exitCode = code ?? (signal ? 128 : 1);
    if (!rpc) process.exit(exitCode);
    process.stdout.write("", () => process.exit(exitCode));
  });
  if (!rpc) return;

  const dialect = new OmpDialect();
  let assembler = new ChunkAssembler(DEFAULT_REASSEMBLY_LIMIT);
  const childIn = child.stdin!;
  const childOut = child.stdout!;

  const toHost = (record: RpcRecord) => {
    if (!process.stdout.write(`${JSON.stringify(record)}\n`)) {
      childOut.pause();
      process.stdout.once("drain", () => childOut.resume());
    }
  };
  const toOmp = (record: RpcRecord) => childIn.write(`${JSON.stringify(record)}\n`);
  // Host frames wait for the handshake: a prompt sent before v2 is negotiated would stream on
  // v1, where OMP elides oversized events instead of chunking them.
  let held: string[] | null = [];
  let hostEnded = false;
  const openGate = () => {
    if (held === null) return;
    for (const line of held) childIn.write(`${line}\n`);
    held = null;
    if (hostEnded) childIn.end();
  };
  const handshakeTimeout = setTimeout(openGate, HANDSHAKE_TIMEOUT_MS);

  forEachLine(childOut, (line) => {
    let record: RpcRecord;
    try {
      record = JSON.parse(line) as RpcRecord;
    } catch {
      process.stderr.write(
        `garisek-omp-rpc: dropped non-JSON stdout line (${line.length} chars)\n`,
      );
      return;
    }
    let whole: RpcRecord | null;
    try {
      whole = assembler.push(record);
    } catch (error) {
      process.stderr.write(`garisek-omp-rpc: ${(error as Error).message}; stopping omp\n`);
      child.kill("SIGTERM");
      process.exitCode = 1;
      return;
    }
    if (whole === null) return;
    if (whole.type === "ready") {
      const limit = whole.maxReassembledFrameBytes;
      if (typeof limit === "number" && limit > 0) assembler = new ChunkAssembler(limit);
      const negotiate = dialect.negotiationRequest(whole);
      if (negotiate === null) openGate();
      else toOmp(negotiate);
    }
    if (whole.type === "response" && whole.id === NEGOTIATE_ID) {
      clearTimeout(handshakeTimeout);
      openGate();
    }
    for (const out of dialect.inbound(whole)) toHost(out);
  });

  const sendHostLine = (line: string) => {
    if (held !== null) held.push(line);
    else childIn.write(`${line}\n`);
  };
  forEachLine(process.stdin, (line) => {
    let record: RpcRecord;
    try {
      record = JSON.parse(line) as RpcRecord;
    } catch {
      sendHostLine(line);
      return;
    }
    if (record.type === "switch_session" && typeof record.sessionPath === "string") {
      const owner = liveSessionOwner(binary, record.sessionPath);
      if (owner !== null) {
        toHost({
          ...(typeof record.id === "string" ? { id: record.id } : {}),
          type: "response",
          command: "switch_session",
          success: false,
          error: {
            code: SESSION_IN_USE,
            message: `Session ${owner} is being written by another live omp process; it stays read-only until that process exits.`,
          },
        });
        return;
      }
    }
    sendHostLine(JSON.stringify(dialect.outbound(record)));
  });
  process.stdin.on("end", () => {
    hostEnded = true;
    if (held === null) childIn.end();
  });
  childIn.on("error", () => {});
}

// LF framing with trailing CR stripped; readline would also split on U+2028/U+2029.
function forEachLine(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) onLine(line);
      newline = buffer.indexOf("\n");
    }
  });
  stream.on("end", () => {
    if (buffer.length > 0) onLine(buffer.replace(/\r$/, ""));
    buffer = "";
  });
}
