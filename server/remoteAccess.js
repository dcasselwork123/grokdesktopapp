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

function isAllInterfacesHost(host) {
  return host === "0.0.0.0" || host === "::";
}

function parseIpv4(addr) {
  if (typeof addr !== "string") return null;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (parts.some((n) => !Number.isInteger(n) || n > 255)) return null;
  return parts;
}

function ipv4ToInt(parts) {
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function inCidr(addr, network, prefixLen) {
  const parts = parseIpv4(addr);
  const net = parseIpv4(network);
  if (!parts || !net) return false;
  if (prefixLen < 0 || prefixLen > 32) return false;
  const mask = prefixLen === 0 ? 0 : (0xffffffff << (32 - prefixLen)) >>> 0;
  return (ipv4ToInt(parts) & mask) === (ipv4ToInt(net) & mask);
}

/** Strip ::ffff: IPv4-mapped prefix. Null/undefined → "". */
function normalizeRemoteAddress(addr) {
  if (addr == null) return "";
  const s = String(addr).trim();
  if (!s) return "";
  const mapped = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) return mapped[1];
  const shortMapped = s.match(/^:ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (shortMapped) return shortMapped[1];
  return s;
}

function isLoopbackAddress(addr) {
  const n = normalizeRemoteAddress(addr);
  if (!n) return false;
  const lower = n.toLowerCase();
  if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return true;
  return inCidr(n, "127.0.0.0", 8);
}

/** Tailscale CGNAT is 100.64.0.0/10 only — not every 100.* address. */
function isTailscaleCgNat(addr) {
  const n = normalizeRemoteAddress(addr);
  return inCidr(n, "100.64.0.0", 10);
}

function isPrivateLanAddress(addr) {
  const n = normalizeRemoteAddress(addr);
  if (!n) return false;
  if (isLoopbackAddress(n) || isTailscaleCgNat(n)) return false;
  return (
    inCidr(n, "10.0.0.0", 8) ||
    inCidr(n, "172.16.0.0", 12) ||
    inCidr(n, "192.168.0.0", 16) ||
    inCidr(n, "169.254.0.0", 16)
  );
}

function isAllowedPeer(addr, opts) {
  const allowLan = Boolean(opts && opts.allowLan);
  const n = normalizeRemoteAddress(addr);
  if (!n) return false;
  if (isLoopbackAddress(n)) return true;
  if (isTailscaleCgNat(n)) return true;
  if (isPrivateLanAddress(n)) return allowLan;
  return false;
}

/**
 * What to listen on. A leftover stored host of 0.0.0.0 is not allowLan.
 * allInterfaces only from allowLan or an explicit env host of 0.0.0.0 / ::.
 */
function getListenPlan({ allowLan, tailscaleIp, envHost } = {}) {
  const allInterfaces = Boolean(allowLan) || isAllInterfacesHost(envHost);
  let tailscale = null;
  if (!allInterfaces && parseIpv4(tailscaleIp)) {
    tailscale = tailscaleIp;
  }
  return {
    loopback: "127.0.0.1",
    tailscale,
    allInterfaces,
  };
}

function envWantsAllowLan() {
  const flag = process.env.GROK_DESKTOP_ALLOW_LAN;
  if (flag === "1" || /^true$/i.test(String(flag || ""))) return true;
  return isAllInterfacesHost(process.env.GROK_DESKTOP_HOST);
}

function storedAllowLan(stored) {
  return typeof stored.allowLan === "boolean" ? stored.allowLan : false;
}

function resolveAllowLan(stored) {
  if (envWantsAllowLan()) return true;
  return storedAllowLan(stored);
}

function resolveListenHost(stored, allowLan) {
  const envHost = process.env.GROK_DESKTOP_HOST;
  const plan = getListenPlan({ allowLan, envHost });
  if (plan.allInterfaces) {
    return envHost === "::" ? "::" : "0.0.0.0";
  }
  if (envHost && !isAllInterfacesHost(envHost)) return envHost;
  // Old default 0.0.0.0 / missing host without allowLan → loopback + Tailscale.
  if (!stored.host || isAllInterfacesHost(stored.host)) return "127.0.0.1";
  return stored.host;
}

function applyAccessConfigFixes(stored) {
  let dirty = false;
  if (typeof stored.allowLan !== "boolean") {
    stored.allowLan = false;
    dirty = true;
  }
  if (stored.allowLan) {
    if (!isAllInterfacesHost(stored.host)) {
      stored.host = "0.0.0.0";
      dirty = true;
    }
  } else if (!stored.host || isAllInterfacesHost(stored.host)) {
    stored.host = "127.0.0.1";
    dirty = true;
  }
  return dirty;
}

/** Persist allowLan / rewrite leftover 0.0.0.0. Does not run on import. */
function ensureAccessConfig() {
  const stored = loadConfig();
  let dirty = applyAccessConfigFixes(stored);
  if (!stored.token) {
    stored.token = randomBytes(18).toString("base64url");
    dirty = true;
  }
  const port = Number(process.env.GROK_DESKTOP_PORT || stored.port || 3847);
  if (stored.port !== port) {
    stored.port = port;
    dirty = true;
  }
  if (dirty) saveConfig(stored);
  return stored;
}

/**
 * Host/token defaults:
 * - Loopback (+ Tailscale via getListenPlan) unless allowLan / env asks for all interfaces
 * - Do not treat a leftover stored host of 0.0.0.0 as allowLan
 * - Stable random token stored in ~/.grok-desktop/config.json
 * Env vars always win when set.
 */
function resolveAccessSettings() {
  const stored = loadConfig();
  let token =
    process.env.GROK_DESKTOP_TOKEN ||
    stored.token ||
    null;
  let wrote = false;

  if (!token) {
    token = randomBytes(18).toString("base64url");
    stored.token = token;
    wrote = true;
  } else if (!stored.token && !process.env.GROK_DESKTOP_TOKEN) {
    stored.token = token;
    wrote = true;
  } else if (process.env.GROK_DESKTOP_TOKEN && stored.token !== process.env.GROK_DESKTOP_TOKEN) {
    // Keep env token in file for the phone URL UI next time
    stored.token = process.env.GROK_DESKTOP_TOKEN;
    wrote = true;
  }

  const allowLan = resolveAllowLan(stored);
  const host = resolveListenHost(stored, allowLan);
  const port = Number(process.env.GROK_DESKTOP_PORT || stored.port || 3847);

  if (stored.port !== port) {
    stored.port = port;
    wrote = true;
  }

  const envHost = process.env.GROK_DESKTOP_HOST;
  if (envHost && stored.host !== envHost) {
    stored.host = envHost;
    wrote = true;
  }

  // Migrate leftover all-interfaces default and persist allowLan.
  if (typeof stored.allowLan !== "boolean") {
    stored.allowLan = false;
    wrote = true;
  }
  if (!envHost && !allowLan && isAllInterfacesHost(stored.host)) {
    stored.host = "127.0.0.1";
    wrote = true;
  }

  if (wrote) {
    if (!envHost) {
      if (stored.allowLan) {
        stored.host = "0.0.0.0";
      } else if (!stored.host || isAllInterfacesHost(stored.host)) {
        stored.host = "127.0.0.1";
      }
    }
    if (!stored.token) stored.token = token;
    saveConfig(stored);
  }

  return { host, port, token, allowLan, configPath: CONFIG_PATH };
}

function setAllowLan(allowLan) {
  const stored = loadConfig();
  stored.allowLan = Boolean(allowLan);
  if (stored.allowLan) {
    stored.host = "0.0.0.0";
  } else if (!stored.host || isAllInterfacesHost(stored.host)) {
    stored.host = "127.0.0.1";
  }
  saveConfig(stored);
  return resolveAccessSettings();
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

function phoneUrlFor(ip, port, token) {
  const base = `http://${ip}:${port}`;
  return token ? `${base}/?token=${encodeURIComponent(token)}` : base;
}

function bindNoteFor({ allowLan, tailscaleIp, usedLan }) {
  if (tailscaleIp && allowLan) {
    return "Reachable over Tailscale. LAN access is also on — devices on this Wi-Fi, including cafe or public networks, can reach this app.";
  }
  if (tailscaleIp) {
    return "Reachable over Tailscale while this app is open.";
  }
  if (allowLan) {
    return usedLan
      ? "Tailscale is not detected. Using your local network address. Devices on the same Wi-Fi can reach this app, including on cafe or public networks."
      : "LAN access is on, so cafe or public Wi-Fi can reach this app. Tailscale is not detected and no local address was found.";
  }
  return "Phone access needs Tailscale on this PC. The app is not reachable from other devices until Tailscale is up.";
}

function buildRemoteInfo({ port, token, host, allowLan, tailscaleIp, lanIpv4 } = {}) {
  const allow = Boolean(allowLan);
  const tsIp = tailscaleIp === undefined ? detectTailscaleIpSync() : tailscaleIp;

  let phoneHost = null;
  let usedLan = false;
  if (tsIp) {
    phoneHost = tsIp;
  } else if (allow) {
    const lan = lanIpv4 !== undefined ? lanIpv4 : getLanIpv4();
    if (lan) {
      phoneHost = lan;
      usedLan = true;
    }
  }

  const phoneUrl = phoneHost ? phoneUrlFor(phoneHost, port, token) : null;

  return {
    host,
    port,
    token,
    tailscaleIp: tsIp || null,
    phoneUrl,
    canCopyPhoneUrl: Boolean(phoneUrl),
    allowLan: allow,
    bindNote: bindNoteFor({ allowLan: allow, tailscaleIp: tsIp || null, usedLan }),
    localUrl: token
      ? `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`
      : `http://127.0.0.1:${port}`,
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
  normalizeRemoteAddress,
  isLoopbackAddress,
  isTailscaleCgNat,
  isPrivateLanAddress,
  isAllowedPeer,
  getListenPlan,
  setAllowLan,
  ensureAccessConfig,
};
