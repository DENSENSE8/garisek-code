// Single-writer rule (check O3): OMP leases each session it writes. Attaching another process to
// a leased session would make OMP fork it into a sibling file, so callers refuse instead.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

export const SESSION_IN_USE = "session_in_use";

function sessionIdOf(sessionRef: string): string | null {
  if (!NodeFS.existsSync(sessionRef)) return sessionRef.includes("/") ? null : sessionRef;
  try {
    const fd = NodeFS.openSync(sessionRef, "r");
    const buffer = Buffer.alloc(64 * 1024);
    const length = NodeFS.readSync(fd, buffer, 0, buffer.length, 0);
    NodeFS.closeSync(fd);
    for (const line of buffer.subarray(0, length).toString("utf8").split("\n")) {
      try {
        const entry: unknown = JSON.parse(line);
        if (
          typeof entry === "object" &&
          entry !== null &&
          "type" in entry &&
          entry.type === "session" &&
          "id" in entry &&
          typeof entry.id === "string"
        )
          return entry.id;
      } catch {
        // A partial line at the 64 KiB boundary is not the header.
      }
    }
  } catch {
    return null;
  }
  return null;
}

// Returns the session id when a live omp process holds its lease, else null. Accepts a session
// file path or a bare session id. A failed lease query reads as free: OMP's own lease still
// prevents two writers on one file, it just forks instead of refusing.
export function liveSessionOwner(binary: string, sessionRef: string): string | null {
  const id = sessionIdOf(sessionRef);
  if (id === null) return null;
  const result = NodeChildProcess.spawnSync(binary, ["session", "lease", "--json", "--", id], {
    encoding: "utf8",
    timeout: 10_000,
  });
  try {
    const lease: unknown = JSON.parse(result.stdout);
    const held =
      typeof lease === "object" && lease !== null && "held" in lease && Array.isArray(lease.held)
        ? lease.held
        : [];
    return held.includes(id) ? id : null;
  } catch {
    return null;
  }
}
