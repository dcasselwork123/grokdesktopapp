"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("grokDesktop", {
  isElectron: true,
  getApiInfo: () => ipcRenderer.invoke("get-api-info"),
  /** Native OS folder picker. Returns absolute path or null if cancelled. */
  pickFolder: (defaultPath) => ipcRenderer.invoke("pick-folder", defaultPath),
  /** Open a /btw side chat in a new desktop window. */
  openSidechat: (payload) => ipcRenderer.invoke("open-sidechat", payload),
  /** One-shot payload for a window opened with ?side=<nonce>. */
  getSidechatInit: (nonce) => ipcRenderer.invoke("get-sidechat-init", nonce),
});
