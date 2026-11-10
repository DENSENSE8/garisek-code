import { contextBridge } from "electron";

// Loaded only into Garisek-partition guests on the configured origin (shell.ts).
contextBridge.exposeInMainWorld("garisekBridge", { version: 1 });
