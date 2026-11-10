// @effect-diagnostics nodeBuiltinImport:off - fork-owned Electron main module outside the Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

// Garisek production on gex45, reached over Tailscale from every machine. A dev server
// (avion :3060) is a Settings override for building Garisek.
const DEFAULT_GARISEK_ORIGIN = "https://gex45.tail2cddbd.ts.net";

export function parseOrigin(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

export interface OriginStore {
  readonly current: () => string;
  readonly set: (origin: string | null) => string;
}

// Precedence: GARISEK_ORIGIN, then the value saved from Settings, then gex45.
export function makeOriginStore(input: {
  readonly userDataPath: string;
  readonly envOrigin: string | undefined;
}): OriginStore {
  const file = NodePath.join(input.userDataPath, "garisek.json");
  const pinned = input.envOrigin === undefined ? null : parseOrigin(input.envOrigin);
  const readSaved = (): string | null => {
    try {
      const saved: unknown = JSON.parse(NodeFS.readFileSync(file, "utf8"));
      if (typeof saved !== "object" || saved === null || !("origin" in saved)) return null;
      return typeof saved.origin === "string" ? parseOrigin(saved.origin) : null;
    } catch {
      return null;
    }
  };
  let saved = readSaved();
  const current = () => pinned ?? saved ?? DEFAULT_GARISEK_ORIGIN;
  return {
    current,
    set: (origin) => {
      const next = origin === null ? null : parseOrigin(origin);
      if (origin !== null && next === null) throw new Error(`not an http(s) origin: ${origin}`);
      NodeFS.mkdirSync(input.userDataPath, { recursive: true });
      NodeFS.writeFileSync(file, `${JSON.stringify(next === null ? {} : { origin: next })}\n`);
      saved = next;
      return current();
    },
  };
}
