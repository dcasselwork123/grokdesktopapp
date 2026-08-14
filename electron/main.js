"use strict";

const { app, BrowserWindow, shell, ipcMain, dialog } = require("electron");
const path = require("path");
const { randomUUID } = require("crypto");
const { createServer } = require("../server/httpApi");
const { resolveAccessSettings } = require("../server/remoteAccess");

let mainWindow = null;
let api = null;
let access = null;
let showedUncaughtDialog = false;
let crashReloadPending = false;
const extraWindows = new Set();
const sidechatPayloads = new Map();

function formatError(err) {
  return err && err.stack ? err.stack : String(err);
}

function logUnexpected(kind, err) {
  const message = formatError(err);
  console.error(`[Grok Desktop] ${kind}:`, message);
  if (showedUncaughtDialog) return;
  showedUncaughtDialog = true;
  const show = () => {
    try {
      dialog.showErrorBox(
        "Grok Desktop hit an unexpected error",
        message +
          "\n\nThe app will keep running if it can. If things look stuck, quit and relaunch."
      );
    } catch {
      /* dialog may fail if app not ready */
    }
  };
  if (app.isReady()) show();
  else app.whenReady().then(show).catch(() => {});
}

process.on("uncaughtException", (err) => {
  logUnexpected("uncaughtException", err);
});

process.on("unhandledRejection", (reason) => {
  logUnexpected("unhandledRejection", reason);
});

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  console.log("[Grok Desktop] Another instance is already running — quitting this one.");
  app.quit();
}

function restartDesktopApp() {
  console.log("[Grok Desktop] Restarting after app update…");
  try {
    app.relaunch();
  } catch (err) {
    console.error("[Grok Desktop] relaunch failed:", formatError(err));
    return;
  }
  app.exit(0);
}

async function startApi() {
  if (api) return api;
  access = resolveAccessSettings();
  const staticDir = path.join(__dirname, "..", "renderer");

  // Prefer configured port; if busy, try the next few so launch still works.
  const portsToTry = [access.port, access.port + 1, access.port + 2, 0];
  let lastErr = null;

  for (const port of portsToTry) {
    try {
      if (port === 0) {
        console.warn(
          "[Grok Desktop] Configured ports busy — asking OS for any free port."
        );
      }
      api = await createServer({
        port,
        host: access.host, // default 0.0.0.0 → Tailscale-reachable
        staticDir,
        token: access.token,
        onAppRestart: restartDesktopApp,
      });
      console.log(`[Grok Desktop] Local UI:  ${api.url}`);
      if (api.port !== access.port) {
        console.warn(
          `[Grok Desktop] Bound ${api.port} instead of configured ${access.port} (that port was in use). Phone URL / token still match this process.`
        );
      }
      if (api.remote?.phoneUrl) {
        console.log(`[Grok Desktop] Phone URL: ${api.remote.phoneUrl}`);
      }
      if (api.remote?.tailscaleIp) {
        console.log(`[Grok Desktop] Tailscale: ${api.remote.tailscaleIp}`);
      } else {
        console.log(
          "[Grok Desktop] Tailscale IP not detected — open Tailscale on this PC, then tap 📱 in the app."
        );
      }
      return api;
    } catch (err) {
      lastErr = err;
      if (err && err.code === "EADDRINUSE") {
        console.warn(
          `[Grok Desktop] port ${port} in use (first instance — leftover node or other process, not a second window). Trying next…`
        );
        continue;
      }
      throw err;
    }
  }

  throw lastErr || new Error("Could not bind HTTP server");
}

function focusMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
    try {
      mainWindow.webContents.focus();
    } catch {
      /* contents may not be ready */
    }
    return;
  }
  if (api?.url) createWindow(api.url);
}

function reloadWindowOnce(win, reason) {
  if (crashReloadPending) {
    console.warn(
      `[Grok Desktop] Renderer ${reason} again before reload finished — not looping.`
    );
    return;
  }
  if (!win || win.isDestroyed()) {
    console.warn(
      `[Grok Desktop] Window gone after ${reason}; recreating (HTTP server stays up).`
    );
    if (api?.url) createWindow(api.url);
    return;
  }
  crashReloadPending = true;
  console.log(
    `[Grok Desktop] Reloading window after ${reason}; HTTP server stays up so grok can finish.`
  );
  try {
    win.webContents.reload();
  } catch (err) {
    crashReloadPending = false;
    console.error("[Grok Desktop] Reload failed:", formatError(err));
    if (api?.url) createWindow(api.url);
  }
}

function attachWindowGuards(win) {
  win.webContents.on("render-process-gone", (_event, details) => {
    const reason = (details && details.reason) || "unknown";
    const exitCode = details && details.exitCode;
    console.error(
      `[Grok Desktop] Renderer gone: ${reason}` +
        (exitCode != null ? ` (exit ${exitCode})` : "")
    );
    if (reason === "clean-exit") return;
    reloadWindowOnce(win, reason);
  });

  win.on("unresponsive", () => {
    console.warn("[Grok Desktop] Window unresponsive.");
    reloadWindowOnce(win, "unresponsive");
  });

  win.on("responsive", () => {
    console.log("[Grok Desktop] Window responsive again.");
  });

  win.webContents.on("did-finish-load", () => {
    crashReloadPending = false;
    // Windows often shows the window without giving the renderer keyboard focus
    // until a native dialog (e.g. folder picker) runs. Force it after load.
    try {
      if (!win.isDestroyed()) {
        win.focus();
        win.webContents.focus();
      }
    } catch {
      /* ignore */
    }
  });

  win.on("focus", () => {
    try {
      if (!win.isDestroyed()) win.webContents.focus();
    } catch {
      /* ignore */
    }
  });
}

function windowPrefs(overrides = {}) {
  return {
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#1a1a1a",
    title: "Grok Desktop",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    ...overrides,
  };
}

function buildUiUrl({ sideNonce } = {}) {
  const baseUrl = api?.url || "";
  const token = api?.token || access?.token;
  const trimmed = String(baseUrl || "").replace(/\/+$/, "");
  const u = new URL(`${trimmed}/`);
  if (token) u.searchParams.set("token", token);
  if (sideNonce) u.searchParams.set("side", sideNonce);
  return u.toString();
}

function attachCommonWindowHandlers(win) {
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: "deny" };
  });
  attachWindowGuards(win);
}

function createWindow(baseUrl) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    focusMainWindow();
    return mainWindow;
  }

  crashReloadPending = false;
  mainWindow = new BrowserWindow(windowPrefs());

  mainWindow.once("ready-to-show", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
      try {
        mainWindow.webContents.focus();
      } catch {
        /* ignore */
      }
    }
  });

  // Loopback does not need the token, but include it so copy/paste of the address bar works.
  const token = api?.token || access?.token;
  const url = token ? `${baseUrl}/?token=${encodeURIComponent(token)}` : baseUrl;
  mainWindow.loadURL(url);

  attachCommonWindowHandlers(mainWindow);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  return mainWindow;
}

function createSideWindow(payload = {}, fromWin = null) {
  if (!api?.url) return null;
  const nonce = randomUUID();
  sidechatPayloads.set(nonce, payload && typeof payload === "object" ? payload : {});
  setTimeout(() => sidechatPayloads.delete(nonce), 60_000);

  const win = new BrowserWindow(
    windowPrefs({
      width: 980,
      height: 720,
      minWidth: 640,
      minHeight: 480,
      title: "Side chat — Grok Desktop",
    })
  );
  extraWindows.add(win);

  if (fromWin && !fromWin.isDestroyed()) {
    try {
      const [x, y] = fromWin.getPosition();
      win.setPosition(x + 36, y + 36);
    } catch {
      /* ignore */
    }
  }

  win.once("ready-to-show", () => {
    if (!win.isDestroyed()) {
      win.show();
      win.focus();
    }
  });

  win.loadURL(buildUiUrl({ sideNonce: nonce }));
  attachCommonWindowHandlers(win);
  win.on("closed", () => {
    extraWindows.delete(win);
  });
  return win;
}

function showFatal(err) {
  const message = formatError(err);
  const addrInUse = err && err.code === "EADDRINUSE";
  console.error("Failed to start:", message);
  const tip = addrInUse
    ? "Another Grok Desktop window or leftover node process is using this port.\n" +
      "Close it (or free port 3847) and try again.\n" +
      "If Windows Firewall prompts, allow access on private/Tailscale networks."
    : "Tip: close other Grok Desktop windows, or free port 3847, then try again.\n" +
      "If Windows Firewall prompts, allow access on private/Tailscale networks.";
  try {
    dialog.showErrorBox("Grok Desktop failed to start", message + "\n\n" + tip);
  } catch {
    /* dialog may fail if app not ready */
  }
}

if (gotTheLock) {
  app.on("second-instance", () => {
    console.log("[Grok Desktop] Second launch requested — focusing existing window.");
    focusMainWindow();
  });

  app.whenReady().then(async () => {
    try {
      const { url } = await startApi();
      createWindow(url);
    } catch (err) {
      showFatal(err);
      app.quit();
    }

    app.on("activate", async () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        try {
          const { url } = await startApi();
          createWindow(url);
        } catch (err) {
          showFatal(err);
        }
      } else {
        focusMainWindow();
      }
    });
  });

  app.on("window-all-closed", () => {
    console.log("[Grok Desktop] All windows closed.");
    if (process.platform !== "darwin") {
      console.log("[Grok Desktop] Quitting (Windows/Linux).");
      app.quit();
    }
  });

  app.on("before-quit", () => {
    console.log("[Grok Desktop] before-quit");
  });

  app.on("will-quit", () => {
    console.log(
      "[Grok Desktop] will-quit — HTTP server and child processes will exit."
    );
  });
}

ipcMain.handle("get-api-info", () => ({
  url: api?.url || null,
  port: api?.port || access?.port,
  host: api?.host || access?.host,
  token: api?.token || access?.token,
  remote: api?.remote || null,
}));

ipcMain.handle("open-sidechat", (event, payload) => {
  const fromWin = BrowserWindow.fromWebContents(event.sender);
  const win = createSideWindow(payload || {}, fromWin);
  return { ok: !!win };
});

ipcMain.handle("get-sidechat-init", (_event, nonce) => {
  if (!nonce || typeof nonce !== "string") return null;
  const payload = sidechatPayloads.get(nonce) || null;
  if (payload) sidechatPayloads.delete(nonce);
  return payload;
});

ipcMain.handle("pick-folder", async (event, defaultPath) => {
  const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  const opts = {
    title: "Select working folder",
    properties: ["openDirectory", "createDirectory"],
  };
  if (defaultPath && typeof defaultPath === "string") {
    opts.defaultPath = defaultPath;
  }
  const result = await dialog.showOpenDialog(win || undefined, opts);
  if (win && !win.isDestroyed()) {
    win.focus();
    try {
      win.webContents.focus();
    } catch {
      /* ignore */
    }
  }
  if (result.canceled || !result.filePaths?.length) return null;
  return result.filePaths[0];
});
