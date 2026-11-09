import { describe, expect, it } from "@effect/vitest";

import { ChunkAssembler, ChunkError, NEGOTIATE_ID, OmpDialect, translateArgs } from "./dialect.ts";

const chunks = (record: object, size: number, chunkId = "rpc-1") => {
  const bytes = Buffer.from(JSON.stringify(record), "utf8");
  const count = Math.ceil(bytes.length / size);
  return Array.from({ length: count }, (_, index) => ({
    type: "rpc_chunk",
    chunkId,
    index,
    count,
    byteLength: bytes.length,
    data: bytes.subarray(index * size, (index + 1) * size).toString("base64"),
  }));
};

describe("OmpDialect", () => {
  it("turns session_settled into Pi's agent_settled, carrying abort from prompt_result", () => {
    const dialect = new OmpDialect();
    expect(
      dialect.inbound({ type: "prompt_result", id: "p1", status: "aborted", sessionSettled: true }),
    ).toEqual([{ type: "prompt_result", id: "p1", status: "aborted", sessionSettled: true }]);
    expect(dialect.inbound({ type: "session_settled" })).toEqual([
      { type: "agent_settled", aborted: true },
    ]);
    dialect.inbound({ type: "prompt_result", id: "p2", status: "completed", sessionSettled: true });
    expect(dialect.inbound({ type: "session_settled" })).toEqual([
      { type: "agent_settled", aborted: false },
    ]);
  });

  it("serves get_commands through get_available_commands and answers under the Pi command name", () => {
    const dialect = new OmpDialect();
    expect(dialect.outbound({ id: "c1", type: "get_commands" })).toEqual({
      id: "c1",
      type: "get_available_commands",
    });
    const commands = [{ name: "skill:review", source: "skill", description: "Review" }];
    expect(
      dialect.inbound({
        id: "c1",
        type: "response",
        command: "get_available_commands",
        success: true,
        data: { commands },
      }),
    ).toEqual([
      { id: "c1", type: "response", command: "get_commands", success: true, data: { commands } },
    ]);
  });

  it("maps clear_queue to abort_and_restore_queue and returns Pi's string lists", () => {
    const dialect = new OmpDialect();
    expect(dialect.outbound({ id: "q1", type: "clear_queue" }).type).toBe(
      "abort_and_restore_queue",
    );
    expect(
      dialect.inbound({
        id: "q1",
        type: "response",
        command: "abort_and_restore_queue",
        success: true,
        data: { steering: [{ text: "steer" }], followUp: [{ text: "", images: [{}] }] },
      }),
    ).toEqual([
      {
        id: "q1",
        type: "response",
        command: "clear_queue",
        success: true,
        data: { steering: ["steer"], followUp: [""] },
      },
    ]);
  });

  it("passes failed renamed responses through so Pi's fallbacks run", () => {
    const dialect = new OmpDialect();
    dialect.outbound({ id: "q2", type: "clear_queue" });
    expect(
      dialect.inbound({
        id: "q2",
        type: "response",
        command: "abort_and_restore_queue",
        success: false,
        error: "x",
      }),
    ).toEqual([
      {
        id: "q2",
        type: "response",
        command: "clear_queue",
        success: false,
        error: "x",
        data: { steering: [], followUp: [] },
      },
    ]);
  });

  it("renames manual and automatic compaction events", () => {
    const dialect = new OmpDialect();
    expect(
      dialect.inbound({ type: "auto_compaction_end", aborted: false, willRetry: true }),
    ).toEqual([
      { type: "compaction_end", aborted: false, willRetry: true, ompType: "auto_compaction_end" },
    ]);
    expect(dialect.inbound({ type: "manual_compaction_start" })[0]?.type).toBe("compaction_start");
  });

  it("negotiates protocol v2 only when advertised and swallows its own response", () => {
    const dialect = new OmpDialect();
    expect(
      dialect.negotiationRequest({ type: "ready", supportedProtocolVersions: [1] }),
    ).toBeNull();
    expect(
      dialect.negotiationRequest({ type: "ready", supportedProtocolVersions: [1, 2] }),
    ).toEqual({
      id: NEGOTIATE_ID,
      type: "negotiate_protocol",
      protocolVersion: 2,
    });
    expect(dialect.inbound({ id: NEGOTIATE_ID, type: "response", success: true })).toEqual([]);
    expect(dialect.negotiated).toBe(true);
  });

  it("leaves Pi-identical frames untouched", () => {
    const dialect = new OmpDialect();
    for (const frame of [
      { type: "agent_start" },
      { type: "tool_execution_start", toolCallId: "t" },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "a" } },
      { id: "s", type: "response", command: "get_state", success: true, data: {} },
    ]) {
      expect(dialect.inbound(frame)).toEqual([frame]);
    }
  });
});

it("drops Pi's --offline, which OMP rejects, and keeps every other argument", () => {
  expect(translateArgs(["--mode", "rpc", "--no-session", "--offline", "--model", "x"])).toEqual([
    "--mode",
    "rpc",
    "--no-session",
    "--model",
    "x",
  ]);
});

describe("ChunkAssembler", () => {
  const big = { type: "agent_end", messages: [{ text: "é".repeat(5_000) }] };

  it("reassembles a chunked frame including multibyte characters split across chunks", () => {
    const assembler = new ChunkAssembler(1 << 20);
    const parts = chunks(big, 777);
    expect(parts.length).toBeGreaterThan(1);
    const results = parts.map((part) => assembler.push(part));
    expect(results.slice(0, -1).every((r) => r === null)).toBe(true);
    expect(results.at(-1)).toEqual(big);
    expect(assembler.push({ type: "agent_start" })).toEqual({ type: "agent_start" });
  });

  it("rejects interleaved, interrupted, truncated and oversized sequences", () => {
    const parts = chunks(big, 777);
    const interleaved = new ChunkAssembler(1 << 20);
    interleaved.push(parts[0]!);
    expect(() => interleaved.push(chunks(big, 777, "rpc-2")[1]!)).toThrow(ChunkError);

    const interrupted = new ChunkAssembler(1 << 20);
    interrupted.push(parts[0]!);
    expect(() => interrupted.push({ type: "agent_start" })).toThrow(ChunkError);

    const truncated = new ChunkAssembler(1 << 20);
    const lying = parts.map((p) => ({ ...p, byteLength: p.byteLength + 1 }));
    for (const p of lying.slice(0, -1)) truncated.push(p);
    expect(() => truncated.push(lying.at(-1)!)).toThrow(ChunkError);

    expect(() => new ChunkAssembler(10).push(parts[0]!)).toThrow(ChunkError);
    expect(() => new ChunkAssembler(1 << 20).push(parts[1]!)).toThrow(ChunkError);
  });
});
