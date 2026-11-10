import { contextBridge, ipcRenderer } from "electron";

import { SHELL_CHANNEL, type GarisekShell } from "./contract.ts";

contextBridge.exposeInMainWorld("garisekShell", {
  getOrigin: () => ipcRenderer.invoke(SHELL_CHANNEL.getOrigin),
  setOrigin: (origin) => ipcRenderer.invoke(SHELL_CHANNEL.setOrigin, origin),
  onOpen: (listener) => {
    const forward = (_event: Electron.IpcRendererEvent, path: unknown) => {
      if (typeof path === "string") listener(path);
    };
    ipcRenderer.on(SHELL_CHANNEL.open, forward);
    void ipcRenderer.invoke(SHELL_CHANNEL.ready).then((pending: unknown) => {
      if (typeof pending === "string") listener(pending);
    });
    return () => {
      ipcRenderer.removeListener(SHELL_CHANNEL.open, forward);
    };
  },
} satisfies GarisekShell);
