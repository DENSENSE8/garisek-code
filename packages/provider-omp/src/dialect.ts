// OMP is a Pi fork whose RPC differs where omp://rpc.md "Pi-family adapter must dialect around":
// no agent_settled (session_settled + prompt_result instead), no get_commands/clear_queue,
// renamed compaction events, and protocol-v2 rpc_chunk framing for oversized frames.
export type RpcRecord = Record<string, unknown>;

const COMMAND_RENAMES: Readonly<Record<string, string>> = {
  get_commands: "get_available_commands",
  // Pi's Stop sends clear_queue then abort. A plain OMP abort requeues stranded steers into a
  // fresh turn; abort_and_restore_queue withdraws them atomically, and the later abort is idle.
  clear_queue: "abort_and_restore_queue",
};

const EVENT_RENAMES: Readonly<Record<string, string>> = {
  manual_compaction_start: "compaction_start",
  manual_compaction_end: "compaction_end",
  auto_compaction_start: "compaction_start",
  auto_compaction_end: "compaction_end",
};

export const NEGOTIATE_ID = "garisek-omp-negotiate";

export class OmpDialect {
  readonly #renamedRequests = new Map<string, string>();
  #lastPromptStatus: string | undefined;
  #negotiated = false;

  outbound(record: RpcRecord): RpcRecord {
    const renamed = typeof record.type === "string" ? COMMAND_RENAMES[record.type] : undefined;
    if (renamed === undefined) return record;
    if (typeof record.id === "string") this.#renamedRequests.set(record.id, record.type as string);
    return { ...record, type: renamed };
  }

  /** Returns the frames to forward to the Pi-family host, possibly none. */
  inbound(record: RpcRecord): RpcRecord[] {
    const type = record.type;
    if (type === "ready") {
      return [record];
    }
    if (type === "response" && record.id === NEGOTIATE_ID) {
      this.#negotiated = record.success === true;
      return [];
    }
    if (type === "response" && typeof record.id === "string") {
      const original = this.#renamedRequests.get(record.id);
      if (original !== undefined) {
        this.#renamedRequests.delete(record.id);
        return [
          { ...record, command: original, data: translateResponseData(original, record.data) },
        ];
      }
      return [record];
    }
    if (type === "prompt_result") {
      if (typeof record.status === "string") this.#lastPromptStatus = record.status;
      return [record];
    }
    if (type === "session_settled") {
      const aborted = this.#lastPromptStatus === "aborted";
      this.#lastPromptStatus = undefined;
      return [{ type: "agent_settled", aborted }];
    }
    if (typeof type === "string") {
      const renamed = EVENT_RENAMES[type];
      if (renamed !== undefined) return [{ ...record, type: renamed, ompType: type }];
    }
    return [record];
  }

  get negotiated(): boolean {
    return this.#negotiated;
  }

  negotiationRequest(ready: RpcRecord): RpcRecord | null {
    const supported = ready.supportedProtocolVersions;
    return Array.isArray(supported) && supported.includes(2)
      ? { id: NEGOTIATE_ID, type: "negotiate_protocol", protocolVersion: 2 }
      : null;
  }
}

function translateResponseData(command: string, data: unknown): unknown {
  if (command !== "clear_queue") return data;
  const queue = (data ?? {}) as { steering?: unknown; followUp?: unknown };
  const texts = (list: unknown) =>
    Array.isArray(list)
      ? list.map((entry: { text?: unknown } | null) =>
          typeof entry?.text === "string" ? entry.text : "",
        )
      : [];
  return { steering: texts(queue.steering), followUp: texts(queue.followUp) };
}

export class ChunkError extends Error {}

/** Reassembles protocol-v2 rpc_chunk sequences; validates per omp://rpc.md. */
export class ChunkAssembler {
  readonly #maxBytes: number;
  #current: { chunkId: string; count: number; byteLength: number; parts: Buffer[] } | null = null;

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
  }

  /** Returns the reassembled record when a sequence completes, else null. Non-chunks pass through. */
  push(record: RpcRecord): RpcRecord | null {
    if (record.type !== "rpc_chunk") {
      if (this.#current !== null)
        throw new ChunkError("rpc_chunk sequence interrupted by another frame");
      return record;
    }
    const { chunkId, index, count, byteLength, data } = record;
    if (
      typeof chunkId !== "string" ||
      !Number.isInteger(index) ||
      !Number.isInteger(count) ||
      !Number.isInteger(byteLength) ||
      typeof data !== "string" ||
      (count as number) < 1
    ) {
      throw new ChunkError("malformed rpc_chunk frame");
    }
    if ((byteLength as number) > this.#maxBytes)
      throw new ChunkError("rpc_chunk exceeds reassembly limit");
    if (this.#current === null) {
      if (index !== 0) throw new ChunkError("rpc_chunk sequence must start at index 0");
      this.#current = {
        chunkId,
        count: count as number,
        byteLength: byteLength as number,
        parts: [],
      };
    } else if (
      this.#current.chunkId !== chunkId ||
      this.#current.count !== count ||
      this.#current.byteLength !== byteLength ||
      this.#current.parts.length !== index
    ) {
      throw new ChunkError("interleaved or out-of-order rpc_chunk");
    }
    this.#current.parts.push(Buffer.from(data, "base64"));
    if (this.#current.parts.length < this.#current.count) return null;
    const bytes = Buffer.concat(this.#current.parts);
    const expected = this.#current.byteLength;
    this.#current = null;
    if (bytes.length !== expected) throw new ChunkError("rpc_chunk byteLength mismatch");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new ChunkError("reassembled rpc_chunk is not an object");
    }
    return parsed as RpcRecord;
  }
}
