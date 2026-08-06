"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile, execFileSync } = require("child_process");
const { randomBytes } = require("crypto");

const CONFIG_DIR = path.join(os.homedir(), ".grok-desktop");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    }
  } catch {
    /* ignore corrupt */
  }
  return {};
}

function saveConfig(cfg) {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
}

/**
 * Host/token defaults:
 * - Bind 0.0.0.0 so Tailscale (and LAN) can reach the app while it's open
 * - Stable random token stored in ~/.grok-desktop/config.json
 * Env vars always win when set.
 */
function resolveAccessSettings() {
  const stored = loadConfig();
  let token =
    process.env.GROK_DESKTOP_TOKEN ||
    stored.token ||
    null;

  if (!token) {
    token = randomBytes(18).toString("base64url");
    stored.token = token;
    saveConfig(stored);
  } else if (!stored.token && !process.env.GROK_DESKTOP_TOKEN) {
    stored.token = token;
    saveConfig(stored);
  } else if (process.env.GROK_DESKTOP_TOKEN && stored.token !== process.env.GROK_DESKTOP_TOKEN) {
    // Keep env token in file for the phone URL UI next time
    stored.token = process.env.GROK_DESKTOP_TOKEN;
    saveConfig(stored);
  }

  const host =
    process.env.GROK_DESKTOP_HOST ||
    stored.host ||
    "0.0.0.0";

  const port = Number(process.env.GROK_DESKTOP_PORT || stored.port || 3847);

  if (stored.host !== host || stored.port !== port) {
    stored.host = host;
    stored.port = port;
    if (!stored.token) stored.token = token;
    saveConfig(stored);
  }

  return { host, port, token, configPath: CONFIG_PATH };
}

function findTailscaleBinary() {
  const candidates = [
    process.env.TAILSCALE_BIN,
    path.join("C:", "Program Files", "Tailscale", "tailscale.exe"),
    path.join("C:", "Program Files (x86)", "Tailscale", "tailscale.exe"),
    "tailscale",
  ].filter(Boolean);

  for (const c of candidates) {
    if (c === "tailscale") return c;
    if (fs.existsSync(c)) return c;
  }
  return "tailscale";
}

function detectTailscaleIpSync() {
  const bin = findTailscaleBinary();
  try {
    const out = execFileSync(bin, ["ip", "-4"], {
      encoding: "utf8",
      timeout: 4000,
      windowsHide: true,
    });
    const ip = (out || "").trim().split(/\r?\n/).filter(Boolean)[0];
    if (ip && /^100\.\d+\.\d+\.\d+$/.test(ip)) return ip;
    // Some setups return other CGNAT ranges; accept any non-empty IPv4
    if (ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip;
  } catch {
    /* tailscale missing or stopped */
  }
  return null;
}

function detectTailscaleIpAsync() {
  return new Promise((resolve) => {
    const bin = findTailscaleBinary();
    execFile(
      bin,
      ["ip", "-4"],
      { encoding: "utf8", timeout: 4000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        const ip = (stdout || "").trim().split(/\r?\n/).filter(Boolean)[0];
        if (ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) resolve(ip);
        else resolve(null);
      }
    );
  });
}

function getLanIpv4() {
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const info of list || []) {
      if (info.family !== "IPv4" && info.family !== 4) continue;
      if (info.internal) continue;
      // Prefer Tailscale-looking addresses first
      if (info.address.startsWith("100.")) return info.address;
    }
  }
  for (const list of Object.values(ifaces)) {
    for (const info of list || []) {
      if (info.family !== "IPv4" && info.family !== 4) continue;
      if (info.internal) continue;
      return info.address;
    }
  }
  return null;
}

function buildRemoteInfo({ port, token, host }) {
  const tailscaleIp = detectTailscaleIpSync() || getLanIpv4();
  const phoneBase = tailscaleIp
    ? `http://${tailscaleIp}:${port}`
    : `http://<your-tailscale-ip>:${port}`;
  const phoneUrl = token
    ? `${phoneBase}/?token=${encodeURIComponent(token)}`
    : phoneBase;

  return {
    host,
    port,
    token,
    tailscaleIp,
    phoneUrl,
    localUrl: token
      ? `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`
      : `http://127.0.0.1:${port}`,
    bindNote:
      host === "0.0.0.0" || host === "::"
        ? "Listening on all interfaces — reachable over Tailscale while this app is open."
        : `Only listening on ${host} (not reachable from phone until host is 0.0.0.0).`,
    phoneApps: {
      required: "Nothing extra — use Safari (or Chrome) on your iPhone.",
      optional: "Add the page to your Home Screen for an app-like icon.",
      notNeeded: "No Termius/SSH app required for the chat UI.",
    },
  };
}

module.exports = {
  resolveAccessSettings,
  detectTailscaleIpSync,
  detectTailscaleIpAsync,
  getLanIpv4,
  buildRemoteInfo,
  loadConfig,
  saveConfig,
  CONFIG_PATH,
};
