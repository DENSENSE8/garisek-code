#!/usr/bin/env node
// Probes every RPC command provider-pi sends against `omp --mode rpc` (throwaway session dir)
// and writes docs/garisek/receipts/omp-rpc-probe-<ISO>.json. `--no-model` skips model turns.
// Exit 0 when verdicts were recorded, 1 on harness failure.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeReadline from "node:readline";
import * as NodeCrypto from "node:crypto";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const REPO_ROOT = NodePath.resolve(__dirname, "../..");

const NO_MODEL = process.argv.includes("--no-model");

const COMMANDS = [
  // ── Lifecycle ──────────────────────────────────────────────────────────
  {
    id: "new_session",
    record: { type: "new_session" },
    needsModel: false,
    desc: "Create a new session",
    derivedFrom: "adapter.ts:2464",
  },
  {
    id: "get_state",
    record: { type: "get_state" },
    needsModel: false,
    desc: "Return session state (model, sessionFile, isStreaming, pendingMessageCount, …)",
    derivedFrom: "adapter.ts:1813,2470,3192,3330",
  },
  {
    id: "get_available_models",
    record: { type: "get_available_models" },
    needsModel: false,
    desc: "Return list of available models",
    derivedFrom: "adapter.ts:2472, status.ts:174",
  },
  {
    id: "get_commands",
    record: { type: "get_commands" },
    needsModel: false,
    desc: "Return slash commands and skills (pi TUI builtins omitted; T3 supplements /compact)",
    derivedFrom: "status.ts:176,212",
  },
  {
    id: "get_entries",
    record: { type: "get_entries" },
    needsModel: false,
    desc: "Return session tree entries (leafId, entries[])",
    derivedFrom: "adapter.ts:1648,2537,3163,3204,3319",
  },
  {
    id: "get_messages",
    record: { type: "get_messages" },
    needsModel: false,
    desc: "Return messages on the active branch",
    derivedFrom: "adapter.ts:3085",
  },
  {
    id: "get_session_stats",
    record: { type: "get_session_stats" },
    needsModel: false,
    desc: "Return token usage stats",
    derivedFrom: "adapter.ts:854",
  },
  // ── Model / session config ─────────────────────────────────────────────
  {
    id: "set_model",
    record: { type: "set_model", provider: "anthropic", modelId: "claude-haiku-5-5" },
    needsModel: false,
    desc: "Switch the active model (provider + modelId)",
    derivedFrom: "adapter.ts:2555,2583",
  },
  {
    id: "set_session_name",
    record: { type: "set_session_name", name: "omp-rpc-probe-test" },
    needsModel: false,
    desc: "Set the session display name",
    derivedFrom: "adapter.ts:2738",
  },
  {
    id: "set_thinking_level",
    record: { type: "set_thinking_level", level: "low" },
    needsModel: false,
    desc: "Set extended thinking level",
    derivedFrom: "adapter.ts:2572,2604",
  },
  // ── Context-dependent ──────────────────────────────────────────────────
  {
    id: "fork",
    record: { type: "fork", entryId: "__LEAF_ID__" },
    needsModel: false,
    desc: "Fork session at a given entry ID (entryId filled from prior get_entries leafId)",
    derivedFrom: "adapter.ts:3189,3323",
  },
  {
    id: "switch_session",
    record: { type: "switch_session", sessionPath: "/tmp/omp-rpc-probe-nonexistent.jsonl" },
    needsModel: false,
    desc: "Switch to an existing session by path",
    derivedFrom: "adapter.ts:2463",
  },
  // ── Send-only (fire-and-forget in production) ──────────────────────────
  {
    id: "extension_ui_response",
    record: { type: "extension_ui_response", id: "probe-no-pending-request", cancelled: true },
    sendOnly: true,
    needsModel: false,
    desc: "Respond to an extension UI request (send-only; no ack from server)",
    derivedFrom: "adapter.ts:1360,1486,3024",
  },
  // ── Basic model turns (without full settle wait) ───────────────────────
  {
    id: "prompt",
    record: { type: "prompt", message: "Reply with exactly the string: PROBE_OK" },
    needsModel: true,
    waitForSettle: true,
    desc: "Send a user prompt (triggers model generation) — waits for session_settled",
    derivedFrom: "adapter.ts:2831",
  },
  {
    id: "compact",
    record: { type: "compact" },
    needsModel: true,
    desc: "Summarize conversation and reduce context (triggers model)",
    derivedFrom: "adapter.ts:620-622, commands.ts:5-9",
  },
  {
    id: "clear_queue",
    record: { type: "clear_queue" },
    needsModel: true,
    desc: "Clear queued steering/follow-up prompts",
    derivedFrom: "adapter.ts:1427",
  },
  {
    id: "get_last_assistant_text",
    record: { type: "get_last_assistant_text" },
    needsModel: true,
    desc: "Return the last assistant text after a completed prompt turn",
    derivedFrom: "textGeneration.ts:108",
  },
];

const KNOWN_ADAPTER_EVENTS = new Set([
  "agent_settled",
  "agent_start",
  "auto_retry_end",
  "auto_retry_start",
  "compaction_end",
  "compaction_start",
  "extension_error",
  "extension_ui_request",
  "message_end",
  "message_start",
  "message_update",
  "response",
  "t3.extension_status_reset",
  "t3.flush_extension_errors",
  "t3.rollback_barrier",
  "t3.settle_probe",
  "t3.ui_request_expired",
  "tool_execution_end",
  "tool_execution_start",
  "tool_execution_update",
]);

function isoNow() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, -1);
}

function log(msg) {
  process.stderr.write(`[probe] ${msg}\n`);
}

function spawnOmp(cwd, sessionDir) {
  const args = ["--mode", "rpc", "--session-dir", sessionDir, "--no-session"];
  log(`spawning: omp ${args.join(" ")} (cwd=${cwd})`);
  return NodeChildProcess.spawn("omp", args, {
    cwd,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

// Wait for ready frame; collect all startup frames
function waitForReady(rl, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for OMP ready")), timeoutMs);
    const startupFrames = [];
    let resolved = false;
    const handler = (line) => {
      if (!line.trim()) return;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        return;
      }
      startupFrames.push({ direction: "recv", frame, ts: Date.now() });
      const t = frame.type;
      if (!resolved && (t === "ready" || t === "available_commands_update")) {
        resolved = true;
        setTimeout(() => {
          clearTimeout(timer);
          rl.off("line", handler);
          resolve(startupFrames);
        }, 400);
      }
    };
    rl.on("line", handler);
  });
}

// Send a request (adds an id), wait for the correlated response only
function sendRequest(child, rl, record, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    const id = `probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const payload = JSON.stringify({ ...record, id }) + "\n";
    const unsolicitedEvents = [];
    const timer = setTimeout(() => {
      rl.off("line", handler);
      resolve({ timedOut: true, id, unsolicitedEvents });
    }, timeoutMs);
    const handler = (line) => {
      if (!line.trim()) return;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        return;
      }
      if (frame.type === "response" && frame.id === id) {
        clearTimeout(timer);
        rl.off("line", handler);
        resolve({ response: frame, id, unsolicitedEvents });
        return;
      }
      unsolicitedEvents.push(frame);
    };
    rl.on("line", handler);
    child.stdin.write(payload);
  });
}

// Sends a prompt and collects every frame until session_settled or the timeout.
// onFirstDelta, if set, runs once on the first streaming frame and is awaited.
function runTurnAndWaitSettle(child, rl, promptRecord, options = {}) {
  const { settleTimeoutMs = 120_000, onFirstDelta = null } = options;
  return new Promise((resolve) => {
    const id = `probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const payload = JSON.stringify({ ...promptRecord, id }) + "\n";

    const frames = [];
    let promptAck = null;
    let settleFrame = null;
    let deltaFired = false;
    let maxFrameBytes = 0;
    const assistantMsgEventTypes = new Set();

    const timer = setTimeout(() => {
      rl.off("line", handler);
      resolve({
        promptAck,
        frames,
        settleFrame: null,
        maxFrameBytes,
        timedOut: true,
        assistantMsgEventTypes: [...assistantMsgEventTypes],
      });
    }, settleTimeoutMs);

    const handler = async (line) => {
      if (!line.trim()) return;
      maxFrameBytes = Math.max(maxFrameBytes, line.length);
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        return;
      }

      // Track the prompt ACK (correlated by id)
      if (frame.type === "response" && frame.id === id) {
        promptAck = frame;
        frames.push({ _ackForPrompt: true, ...frame });
        return;
      }
      frames.push(frame);

      // Track assistantMessageEvent types inside message_update
      if (frame.type === "message_update" && frame.assistantMessageEvent?.type) {
        assistantMsgEventTypes.add(frame.assistantMessageEvent.type);
      }

      // Fire onFirstDelta on first streaming signal
      if (
        onFirstDelta &&
        !deltaFired &&
        (frame.type === "message_update" ||
          (frame.type === "message_start" && frame.message?.role === "assistant"))
      ) {
        deltaFired = true;
        try {
          await onFirstDelta(frame, child);
        } catch {}
      }

      // Terminal: session_settled signals full turn completion (sole terminal)
      if (frame.type === "session_settled") {
        settleFrame = frame;
        clearTimeout(timer);
        rl.off("line", handler);
        resolve({
          promptAck,
          frames,
          settleFrame,
          maxFrameBytes,
          assistantMsgEventTypes: [...assistantMsgEventTypes],
        });
      }
    };
    rl.on("line", handler);
    child.stdin.write(payload);
  });
}

// Send a fire-and-forget frame; collect any events that arrive in a brief window
function sendOnly(child, rl, record, windowMs = 1_000) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(record) + "\n";
    const unsolicitedEvents = [];
    const handler = (line) => {
      if (!line.trim()) return;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        return;
      }
      unsolicitedEvents.push(frame);
    };
    rl.on("line", handler);
    child.stdin.write(payload);
    setTimeout(() => {
      rl.off("line", handler);
      resolve({ sendOnly: true, unsolicitedEvents });
    }, windowMs);
  });
}

function summarizeError(err) {
  if (typeof err === "string") return err.slice(0, 200);
  if (typeof err === "object" && err !== null) return JSON.stringify(err).slice(0, 200);
  return String(err).slice(0, 200);
}

function countEventTypes(frames) {
  const counts = {};
  for (const f of frames) {
    const t = (f.type ?? f._ackForPrompt) ? (f._ackForPrompt ? "response[ack]" : f.type) : "?";
    counts[t] = (counts[t] || 0) + 1;
  }
  return counts;
}

function firstExamples(frames) {
  const seen = {};
  for (const f of frames) {
    const t = f.type ?? "?";
    if (!seen[t]) seen[t] = JSON.stringify(f).slice(0, 400);
  }
  return seen;
}

function orderSequence(frames) {
  return frames.map((f) => f.type ?? "?");
}

async function main() {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "omp-rpc-probe-cwd-"));
  const sessionDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "omp-rpc-probe-sessions-"));
  log(`cwd=${cwd}  sessionDir=${sessionDir}`);

  const child = spawnOmp(cwd, sessionDir);
  const stderrLines = [];
  child.stderr.on("data", (chunk) => stderrLines.push(chunk.toString()));

  const rl = NodeReadline.createInterface({ input: child.stdout, crlfDelay: Infinity });

  const transcript = {
    probedAt: new Date().toISOString(),
    ompBinary: "omp",
    ompVersion: "omp/18.18.2",
    sessionDir,
    cwd,
    noModel: NO_MODEL,
    commandDerivation:
      "packages/provider-pi/src/server/{adapter,status,textGeneration,commands}.ts",
    startupFrames: [],
    commands: [],
    // Extended probes
    toolCallProbe: null,
    abortProbe: null,
    largeFileProbe: null,
    // Summary
    observedEventTypes: [],
    neverObservedAdapterEvents: [],
    ompOnlyFrames: [],
    stderrTail: "",
  };

  let harnessFailed = false;

  try {
    transcript.startupFrames = await waitForReady(rl);
    log(`Got ${transcript.startupFrames.length} startup frame(s)`);
  } catch (err) {
    log(`HARNESS ERROR: ${err.message}`);
    harnessFailed = true;
    child.stdin.end();
    writeReceipt(transcript);
    process.exit(1);
  }

  const seenEventTypes = new Set();
  for (const f of transcript.startupFrames) {
    if (f.frame?.type) seenEventTypes.add(f.frame.type);
  }

  let lastLeafId = null;

  // ── Phase 1: existing command catalog ──────────────────────────────────
  for (const cmd of COMMANDS) {
    if (cmd.needsModel && NO_MODEL) {
      transcript.commands.push({
        id: cmd.id,
        record: cmd.record,
        desc: cmd.desc,
        derivedFrom: cmd.derivedFrom,
        verdict: "skipped",
        reason: "--no-model flag set",
        response: null,
        unsolicitedEvents: [],
      });
      continue;
    }

    let record = cmd.record;
    if (cmd.id === "fork" && lastLeafId !== null) {
      record = { ...record, entryId: lastLeafId };
    }

    log(`→ ${cmd.id}`);
    let result;

    try {
      if (cmd.sendOnly) {
        result = await sendOnly(child, rl, record);
      } else if (cmd.waitForSettle) {
        result = await runTurnAndWaitSettle(child, rl, record);
        for (const f of result.frames) {
          if (f.type) seenEventTypes.add(f.type);
        }
        const verdict = result.promptAck?.success === true ? "supported" : "partial";
        transcript.commands.push({
          id: cmd.id,
          record,
          desc: cmd.desc,
          derivedFrom: cmd.derivedFrom,
          verdict,
          reason: verdict === "supported" ? null : "prompt ack not success=true",
          response: result.promptAck,
          unsolicitedEvents: result.frames,
          settleFrame: result.settleFrame,
          eventCounts: countEventTypes(result.frames),
          eventOrder: orderSequence(result.frames),
        });
        log(`  → ${verdict} (settle=${!!result.settleFrame}, events=${result.frames.length})`);
        continue;
      } else {
        result = await sendRequest(child, rl, record);
      }
    } catch (err) {
      transcript.commands.push({
        id: cmd.id,
        record,
        desc: cmd.desc,
        derivedFrom: cmd.derivedFrom,
        verdict: "harness_error",
        reason: String(err),
        response: null,
        unsolicitedEvents: [],
      });
      continue;
    }

    for (const ev of result.unsolicitedEvents ?? []) {
      if (ev.type) seenEventTypes.add(ev.type);
    }

    let verdict,
      reason = null;
    if (cmd.sendOnly) {
      verdict = "send_only";
      reason = `Fire-and-forget frame sent; ${result.unsolicitedEvents.length} unsolicited event(s) in 1 s window`;
    } else if (result.timedOut) {
      verdict = "timeout";
      reason = "No response within 15 000 ms";
    } else {
      const r = result.response;
      if (r.success === true) {
        verdict = "supported";
        if (cmd.id === "get_entries" && r.data?.leafId) lastLeafId = r.data.leafId;
      } else if (r.success === false) {
        const errorStr = summarizeError(r.error ?? r.message ?? "(no error detail)");
        const isUnknownCmd = /unknown command/i.test(errorStr) || /not supported/i.test(errorStr);
        verdict = isUnknownCmd ? "unsupported" : "partial";
        reason = errorStr;
      } else {
        verdict = "partial";
        reason = "Response missing success field";
      }
    }

    transcript.commands.push({
      id: cmd.id,
      record,
      desc: cmd.desc,
      derivedFrom: cmd.derivedFrom,
      verdict,
      reason,
      response: result.response ?? null,
      unsolicitedEvents: result.unsolicitedEvents ?? [],
    });
    log(`  → ${verdict}${reason ? ` (${reason.slice(0, 80)})` : ""}`);
  }

  // ── Phase 2: Extended probes (model only) ──────────────────────────────
  if (!NO_MODEL) {
    // ── 2a: Tool-call probe ─────────────────────────────────────────────
    log("── Phase 2a: tool-call probe");
    const probeToken = `PROBE_TOKEN_${NodeCrypto.randomBytes(8).toString("hex")}`;
    NodeFS.writeFileSync(NodePath.join(cwd, "probe-input.txt"), probeToken, "utf8");
    log(`  wrote probe-input.txt with token ${probeToken}`);

    // Start a fresh session for the tool call probe
    await sendRequest(child, rl, { type: "new_session" });

    const toolCallResult = await runTurnAndWaitSettle(child, rl, {
      type: "prompt",
      message:
        `Use your read_file (or Read) tool to read the file "probe-input.txt" in the current directory. ` +
        `Reply with ONLY the exact contents of the file, nothing else.`,
    });

    // Get the last assistant text to verify token
    const lastTextResult = await sendRequest(child, rl, { type: "get_last_assistant_text" });
    const lastText =
      typeof lastTextResult.response?.data?.text === "string"
        ? lastTextResult.response.data.text.trim()
        : "";
    const tokenFound = lastText.includes(probeToken);

    for (const f of toolCallResult.frames) {
      if (f.type) seenEventTypes.add(f.type);
    }

    transcript.toolCallProbe = {
      probeToken,
      tokenFound,
      lastAssistantText: lastText.slice(0, 500),
      promptAck: toolCallResult.promptAck,
      settleFrame: toolCallResult.settleFrame,
      eventCounts: countEventTypes(toolCallResult.frames),
      eventOrder: orderSequence(toolCallResult.frames),
      firstExamples: firstExamples(toolCallResult.frames),
      maxFrameBytes: toolCallResult.maxFrameBytes,
      assistantMsgEventTypes: toolCallResult.assistantMsgEventTypes ?? [],
    };

    log(`  token found in assistant text: ${tokenFound}`);
    log(`  events: ${JSON.stringify(transcript.toolCallProbe.eventCounts)}`);

    // ── 2b: Abort probe ─────────────────────────────────────────────────
    log("── Phase 2b: abort probe");
    await sendRequest(child, rl, { type: "new_session" });

    let abortSentAt = null;
    let abortResult_cmd = null;

    const abortTurnResult = await runTurnAndWaitSettle(
      child,
      rl,
      {
        type: "prompt",
        message:
          "Write a 300-word essay on the history of the printing press. Use detailed paragraphs.",
      },
      {
        settleTimeoutMs: 60_000,
        onFirstDelta: async (triggerFrame, ch) => {
          log(`  first delta seen: type=${triggerFrame.type}`);
          abortSentAt = triggerFrame.type;
          // Send abort immediately
          const abortRes = await sendRequest(ch, rl, { type: "abort" }, 5_000);
          abortResult_cmd = abortRes.response;
          log(`  abort sent; ack: success=${abortResult_cmd?.success}`);
        },
      },
    );

    for (const f of abortTurnResult.frames) {
      if (f.type) seenEventTypes.add(f.type);
    }

    transcript.abortProbe = {
      abortTriggeredBy: abortSentAt,
      abortAck: abortResult_cmd,
      settleFrame: abortTurnResult.settleFrame,
      eventCounts: countEventTypes(abortTurnResult.frames),
      eventOrder: orderSequence(abortTurnResult.frames),
      firstExamples: firstExamples(abortTurnResult.frames),
      maxFrameBytes: abortTurnResult.maxFrameBytes,
    };

    log(`  abort turn events: ${JSON.stringify(transcript.abortProbe.eventCounts)}`);

    // ── 2c: Large-file framing probe ────────────────────────────────────
    log("── Phase 2c: large-file framing probe");
    const LARGE_FILE_SIZE = 2 * 1024 * 1024; // 2 MB
    const largeToken = `LARGE_TOKEN_${NodeCrypto.randomBytes(8).toString("hex")}`;
    // File: token on first line, then filler to reach 2MB
    const filler = "x".repeat(79) + "\n"; // 80-byte lines
    const headerLine = largeToken + "\n";
    const headerBytes = Buffer.byteLength(headerLine, "utf8");
    const fillCount = Math.ceil((LARGE_FILE_SIZE - headerBytes) / filler.length);
    const largeContent = headerLine + filler.repeat(fillCount);
    NodeFS.writeFileSync(NodePath.join(cwd, "probe-large.txt"), largeContent, "utf8");
    log(`  wrote probe-large.txt (${largeContent.length} bytes)`);

    await sendRequest(child, rl, { type: "new_session" });

    const largeFileResult = await runTurnAndWaitSettle(child, rl, {
      type: "prompt",
      message:
        `Use your read_file (or Read) tool to read the file "probe-large.txt" in the current directory. ` +
        `Do NOT use a line-range selector — read the entire file. ` +
        `Then reply with ONLY the first token you see on the first line, nothing else.`,
    });

    const largeLastText = await sendRequest(child, rl, { type: "get_last_assistant_text" });
    const largeAssistantText =
      typeof largeLastText.response?.data?.text === "string"
        ? largeLastText.response.data.text.trim()
        : "";
    const largeTokenFound = largeAssistantText.includes(largeToken);

    for (const f of largeFileResult.frames) {
      if (f.type) seenEventTypes.add(f.type);
    }

    transcript.largeFileProbe = {
      fileSizeBytes: largeContent.length,
      largeToken,
      tokenFound: largeTokenFound,
      lastAssistantText: largeAssistantText.slice(0, 500),
      promptAck: largeFileResult.promptAck,
      settleFrame: largeFileResult.settleFrame,
      eventCounts: countEventTypes(largeFileResult.frames),
      eventOrder: orderSequence(largeFileResult.frames),
      firstExamples: firstExamples(largeFileResult.frames),
      maxFrameBytes: largeFileResult.maxFrameBytes,
      assistantMsgEventTypes: largeFileResult.assistantMsgEventTypes ?? [],
    };

    log(`  large token found: ${largeTokenFound}`);
    log(`  max frame bytes: ${largeFileResult.maxFrameBytes}`);
    log(`  events: ${JSON.stringify(transcript.largeFileProbe.eventCounts)}`);
  }

  // Brief drain for trailing events
  await new Promise((resolve) => setTimeout(resolve, 600));
  child.stdin.end();
  await new Promise((resolve) => child.on("exit", resolve));

  // Categorize event types
  const ompOnly = [];
  for (const t of seenEventTypes) {
    if (!KNOWN_ADAPTER_EVENTS.has(t)) ompOnly.push(t);
  }
  transcript.observedEventTypes = [...seenEventTypes].sort();
  transcript.neverObservedAdapterEvents = [...KNOWN_ADAPTER_EVENTS]
    .filter((t) => !seenEventTypes.has(t))
    .sort();
  transcript.ompOnlyFrames = ompOnly.sort();
  transcript.stderrTail = stderrLines.join("").slice(-2000);

  writeReceipt(transcript);
  printSummaryTable(transcript);
  process.exit(harnessFailed ? 1 : 0);
}

function writeReceipt(transcript) {
  const receiptDir = NodePath.join(REPO_ROOT, "docs", "garisek", "receipts");
  NodeFS.mkdirSync(receiptDir, { recursive: true });
  const filename = `omp-rpc-probe-${isoNow().slice(0, 19)}.json`;
  const path = NodePath.join(receiptDir, filename);
  NodeFS.writeFileSync(path, JSON.stringify(transcript, null, 2));
  log(`Receipt written to ${path}`);
  process.stdout.write(`\nReceipt: ${path}\n`);
}

function padEnd(str, n) {
  return String(str).padEnd(n).slice(0, n);
}

function printSummaryTable(transcript) {
  const cols = [
    { label: "Command", w: 28 },
    { label: "Verdict", w: 14 },
    { label: "Detail", w: 60 },
  ];
  const sep = cols.map((c) => "-".repeat(c.w)).join("-+-");
  const header = cols.map((c) => padEnd(c.label, c.w)).join(" | ");

  process.stdout.write("\n## OMP RPC Command Verdicts\n\n");
  process.stdout.write(header + "\n");
  process.stdout.write(sep + "\n");
  for (const cmd of transcript.commands) {
    const row = [
      padEnd(cmd.id, cols[0].w),
      padEnd(cmd.verdict, cols[1].w),
      padEnd(cmd.reason ?? (cmd.verdict === "supported" ? "ok" : ""), cols[2].w),
    ].join(" | ");
    process.stdout.write(row + "\n");
  }

  if (transcript.toolCallProbe) {
    const p = transcript.toolCallProbe;
    process.stdout.write("\n## Tool-call probe\n\n");
    process.stdout.write(`  token found in assistant text: ${p.tokenFound}\n`);
    process.stdout.write(`  event counts: ${JSON.stringify(p.eventCounts)}\n`);
    process.stdout.write(`  event order: ${p.eventOrder.join(" → ")}\n`);
    process.stdout.write(`  max frame bytes: ${p.maxFrameBytes}\n`);
  }

  if (transcript.abortProbe) {
    const p = transcript.abortProbe;
    process.stdout.write("\n## Abort probe\n\n");
    process.stdout.write(`  aborted after: ${p.abortTriggeredBy ?? "(no delta)"}\n`);
    process.stdout.write(`  abort ack: ${JSON.stringify(p.abortAck)}\n`);
    process.stdout.write(
      `  terminal frame: ${JSON.stringify(p.settleFrame ?? p.eventOrder.at(-1))}\n`,
    );
    process.stdout.write(`  event order: ${p.eventOrder.join(" → ")}\n`);
  }

  if (transcript.largeFileProbe) {
    const p = transcript.largeFileProbe;
    process.stdout.write("\n## Large-file framing probe\n\n");
    process.stdout.write(`  file size: ${p.fileSizeBytes} bytes\n`);
    process.stdout.write(`  token found: ${p.tokenFound}\n`);
    process.stdout.write(`  max frame bytes: ${p.maxFrameBytes}\n`);
    process.stdout.write(`  event order: ${p.eventOrder.join(" → ")}\n`);
  }

  process.stdout.write("\n## OMP-only event frames observed\n\n");
  if (transcript.ompOnlyFrames.length) {
    for (const t of transcript.ompOnlyFrames) process.stdout.write(`  - ${t}\n`);
  } else {
    process.stdout.write("  (none beyond adapter events)\n");
  }

  process.stdout.write("\n## Adapter events never observed in this probe\n\n");
  if (transcript.neverObservedAdapterEvents.length) {
    for (const t of transcript.neverObservedAdapterEvents) process.stdout.write(`  - ${t}\n`);
  } else {
    process.stdout.write("  (all observed)\n");
  }

  process.stdout.write(`\nModel: ${transcript.ompVersion}  |  --no-model: ${transcript.noModel}\n`);
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err.stack ?? err}\n`);
  process.exit(1);
});
