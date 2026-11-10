// Mirrors GarisekShell in apps/desktop/src/garisek/contract.ts, exposed by the desktop preload.
export interface GarisekShell {
  getOrigin(): Promise<string>;
  setOrigin(origin: string | null): Promise<string>;
  onOpen(listener: (path: string) => void): () => void;
}

declare global {
  interface Window {
    garisekShell?: GarisekShell;
  }
}

export const garisekShell: GarisekShell | undefined =
  typeof window === "undefined" ? undefined : window.garisekShell;

let origin: string | null = null;
let loading = false;
const listeners = new Set<() => void>();

const publish = (next: string) => {
  origin = next;
  for (const listener of listeners) listener();
};

// The Garisek origin the desktop app is configured for, shared by the area and Settings.
export const garisekOrigin = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    if (!loading && garisekShell !== undefined) {
      loading = true;
      void garisekShell.getOrigin().then(publish);
    }
    return () => listeners.delete(listener);
  },
  get: (): string | null => origin,
  async set(next: string | null): Promise<string> {
    if (garisekShell === undefined) throw new Error("Garisek needs the desktop app");
    const saved = await garisekShell.setOrigin(next);
    publish(saved);
    return saved;
  },
};
