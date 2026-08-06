"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("grokDesktop", {
  isElectron: true,
  getApiInfo: () => ipcRenderer.invoke("get-api-info"),
  /** Native OS folder picker. Returns absolute path or null if cancelled. */
  pickFolder: (defaultPath) => ipcRenderer.invoke("pick-folder", defaultPath),
});
