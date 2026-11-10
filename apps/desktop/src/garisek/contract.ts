// The window.garisekBridge contract shared with Garisek-OS. Shapes are the JSON the
// Tauri commands returned (serde field names), so Garisek-OS callers only change how they call.
export const GARISEK_PARTITION = "persist:garisek";

export interface HostProcess {
  readonly pid: number;
  readonly cpu: number;
  readonly rss_mb: number;
  readonly comm: string;
}

export interface FailedUnit {
  readonly name: string;
  readonly description: string;
}

export interface FeedEvent {
  readonly id: string;
  readonly ts: string;
  readonly kind: string;
  readonly title: string;
  readonly body: string;
  readonly acknowledged: boolean;
}

export interface HostSnapshot {
  readonly os: string;
  readonly hostname: string;
  readonly mem_total_mb: number;
  readonly mem_available_mb: number;
  readonly swap_total_mb: number;
  readonly swap_used_mb: number;
  readonly processes: ReadonlyArray<HostProcess>;
  readonly failed_units: ReadonlyArray<FailedUnit>;
  readonly feed: ReadonlyArray<FeedEvent>;
  readonly tauri: boolean;
}

export interface TerminalTargets {
  readonly warp: boolean;
  readonly default: string | null;
}

export type AllowlistedAction = "alignment_scan" | "memory_reflect";

export interface RunResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly action: string;
}

export interface JournalQuery {
  readonly unit: string;
  readonly lines: number;
}

// The raw system-feed line object, as the Tauri watcher emitted it.
export type SystemFeedEvent = Readonly<Record<string, unknown>>;

export interface GarisekBridge {
  readonly version: 1;
  hostSnapshot(): Promise<HostSnapshot>;
  killUserPid(pid: number): Promise<boolean>;
  terminalTargets(): Promise<TerminalTargets>;
  openInTerminal(command: string): Promise<string>;
  openWarpLaunch(name: string, yaml: string): Promise<string>;
  runAllowlisted(action: AllowlistedAction): Promise<RunResult>;
  readJournal(query: JournalQuery): Promise<RunResult>;
  hideSpotlight(): Promise<void>;
  showMainWindow(): Promise<void>;
  openMainAt(path: string): Promise<boolean>;
  setProcessBadge(count: number): Promise<void>;
  onSystemFeed(listener: (event: SystemFeedEvent) => void): () => void;
}

// The T3 renderer's side: which origin the Garisek area shows, and requests to open a Garisek path.
export interface GarisekShell {
  getOrigin(): Promise<string>;
  setOrigin(origin: string | null): Promise<string>;
  onOpen(listener: (path: string) => void): () => void;
}

export const SHELL_CHANNEL = {
  getOrigin: "garisek-shell:get-origin",
  setOrigin: "garisek-shell:set-origin",
  ready: "garisek-shell:ready",
  open: "garisek-shell:open",
} as const;
