import * as Electron from "electron";

import { GARISEK_PARTITION, SHELL_CHANNEL } from "./contract.ts";
import { makeOriginStore, parseOrigin, type OriginStore } from "./origin.ts";

export interface GarisekShellInput {
  readonly platform: NodeJS.Platform;
  readonly preloadPath: string;
  readonly revealMain: () => Promise<Electron.BrowserWindow>;
}

interface GarisekShellState {
  readonly origins: OriginStore;
  readonly preloadPath: string;
  renderer: Electron.WebContents | null;
  pendingPath: string | null;
}

let state: GarisekShellState | null = null;

export const isGarisekPartition = (partition: unknown): boolean => partition === GARISEK_PARTITION;

// From the main window's will-attach-webview: a Garisek guest attaches only on the configured
// origin, isolated and sandboxed, with the bridge preload chosen here rather than by the renderer.
export function prepareGarisekWebview(
  webPreferences: Electron.WebPreferences,
  params: Record<string, string>,
): boolean {
  if (state === null || parseOrigin(params.src ?? "") !== state.origins.current()) return false;
  webPreferences.preload = state.preloadPath;
  webPreferences.sandbox = true;
  webPreferences.contextIsolation = true;
  webPreferences.nodeIntegration = false;
  webPreferences.nodeIntegrationInSubFrames = false;
  return true;
}

// The T3 renderer: a top-level frame of a normal window outside the Garisek partition.
function fromMainRenderer(event: Electron.IpcMainInvokeEvent): boolean {
  const garisekSession = Electron.session.fromPartition(GARISEK_PARTITION);
  return (
    event.sender.getType() === "window" &&
    event.sender.session !== garisekSession &&
    event.senderFrame === event.sender.mainFrame
  );
}

function guardGuestNavigation(contents: Electron.WebContents, origins: OriginStore): void {
  const isGarisekUrl = (url: string) => parseOrigin(url) === origins.current();
  contents.on("will-navigate", (event, url) => {
    if (isGarisekUrl(url)) return;
    event.preventDefault();
    void Electron.shell.openExternal(url);
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (isGarisekUrl(url)) void contents.loadURL(url);
    else if (parseOrigin(url) !== null) void Electron.shell.openExternal(url);
    return { action: "deny" };
  });
}

export function installGarisekShell(input: GarisekShellInput): void {
  const origins = makeOriginStore({
    userDataPath: Electron.app.getPath("userData"),
    envOrigin: process.env.GARISEK_ORIGIN,
  });
  const shell: GarisekShellState = {
    origins,
    preloadPath: input.preloadPath,
    renderer: null,
    pendingPath: null,
  };
  state = shell;
  const subscribedRenderers = new WeakSet<Electron.WebContents>();

  Electron.app.on("web-contents-created", (_event, contents) => {
    if (contents.session === Electron.session.fromPartition(GARISEK_PARTITION)) {
      guardGuestNavigation(contents, origins);
    }
  });

  Electron.ipcMain.handle(SHELL_CHANNEL.getOrigin, (event) => {
    if (!fromMainRenderer(event)) throw new Error("garisek shell: untrusted sender");
    return origins.current();
  });
  Electron.ipcMain.handle(SHELL_CHANNEL.setOrigin, (event, origin: unknown) => {
    if (!fromMainRenderer(event)) throw new Error("garisek shell: untrusted sender");
    if (origin !== null && typeof origin !== "string") throw new Error("origin must be a string");
    return origins.set(origin);
  });
  Electron.ipcMain.handle(SHELL_CHANNEL.ready, (event) => {
    if (!fromMainRenderer(event)) throw new Error("garisek shell: untrusted sender");
    const contents = event.sender;
    shell.renderer = contents;
    if (!subscribedRenderers.has(contents)) {
      subscribedRenderers.add(contents);
      contents.on("did-start-navigation", (details) => {
        if (details.isMainFrame && !details.isSameDocument && shell.renderer === contents) {
          shell.renderer = null;
        }
      });
    }
    const path = shell.pendingPath;
    shell.pendingPath = null;
    return path;
  });
}
