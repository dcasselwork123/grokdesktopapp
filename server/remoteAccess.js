"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile, execFileSync } = require("child_process");
const { randomBytes, X509Certificate } = require("crypto");

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

/** Absolute path for lastCwd, or null to clear. Directory need not exist. */
function normalizeStoredCwd(cwd) {
  if (cwd == null) return null;
  const s = String(cwd).trim();
  if (!s) return null;
  return path.resolve(s);
}

function getLastCwd() {
  const stored = loadConfig();
  if (typeof stored.lastCwd !== "string") return null;
  const s = stored.lastCwd.trim();
  return s || null;
}

function setLastCwd(cwd) {
  const stored = loadConfig();
  const next = normalizeStoredCwd(cwd);
  if (next == null) {
    delete stored.lastCwd;
  } else {
    stored.lastCwd = next;
  }
  saveConfig(stored);
  return next;
}

/** Compare resolved paths; win32 is case-insensitive. Does not read or write config. */
function folderInSeenList(cwd, list) {
  const resolved = normalizeStoredCwd(cwd);
  if (resolved == null || !Array.isArray(list)) return false;
  const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  for (const item of list) {
    const other = normalizeStoredCwd(item);
    if (other == null) continue;
    const otherKey = process.platform === "win32" ? other.toLowerCase() : other;
    if (key === otherKey) return true;
  }
  return false;
}

function getSeenFolders() {
  const stored = loadConfig();
  if (!Array.isArray(stored.seenFolders)) return [];
  const out = [];
  for (const item of stored.seenFolders) {
    const resolved = normalizeStoredCwd(item);
    if (resolved == null) continue;
    if (!folderInSeenList(resolved, out)) out.push(resolved);
  }
  return out;
}

function addSeenFolder(cwd) {
  const next = normalizeStoredCwd(cwd);
  const list = getSeenFolders();
  if (next == null) return list;
  if (!folderInSeenList(next, list)) list.push(next);
  const stored = loadConfig();
  stored.seenFolders = list;
  saveConfig(stored);
  return list;
}

function isSeenFolder(cwd) {
  return folderInSeenList(cwd, getSeenFolders());
}

const STORED_PERMISSION_MODES = ["bypassPermissions", "dontAsk", "default"];
const STORED_PERMISSION_DEFAULT = "bypassPermissions";

function getPermissionMode() {
  const stored = loadConfig();
  const mode = stored.permissionMode;
  if (STORED_PERMISSION_MODES.includes(mode)) return mode;
  return STORED_PERMISSION_DEFAULT;
}

function setPermissionMode(mode) {
  if (!STORED_PERMISSION_MODES.includes(mode)) return getPermissionMode();
  const stored = loadConfig();
  stored.permissionMode = mode;
  saveConfig(stored);
  return mode;
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

function normalizeTailscaleDnsName(name) {
  const raw = String(name || "")
    .trim()
    .replace(/\.$/, "")
    .toLowerCase();
  return raw || null;
}

function parseTailscaleStatus(json) {
  const src = json && typeof json === "object" ? json : {};
  const self = src.Self && typeof src.Self === "object" ? src.Self : {};
  const dnsName = normalizeTailscaleDnsName(self.DNSName);
  const certDomains = (Array.isArray(src.CertDomains) ? src.CertDomains : [])
    .map(normalizeTailscaleDnsName)
    .filter(Boolean);
  const ips = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : [];
  const ip =
    ips.find((value) => /^\d{1,3}(\.\d{1,3}){3}$/.test(String(value))) || null;
  const httpsEligible = Boolean(dnsName && certDomains.includes(dnsName));
  return { ip, dnsName, certDomains, httpsEligible };
}

function detectTailscaleStatusSync() {
  const bin = findTailscaleBinary();
  try {
    const out = execFileSync(bin, ["status", "--json"], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    return parseTailscaleStatus(JSON.parse(out));
  } catch {
    return {
      ip: detectTailscaleIpSync(),
      dnsName: null,
      certDomains: [],
      httpsEligible: false,
    };
  }
}

function getTailscaleCertDir() {
  return path.join(os.homedir(), ".grok-desktop", "certs");
}

function tailscaleCertPaths(dnsName) {
  const safe = String(dnsName || "").replace(/[^a-z0-9.-]/gi, "_");
  const dir = getTailscaleCertDir();
  return {
    dir,
    cert: path.join(dir, `${safe}.crt`),
    key: path.join(dir, `${safe}.key`),
  };
}

function certNeedsRefresh(certPem, { now = Date.now(), renewWithinMs = 14 * 86400000 } = {}) {
  try {
    const x509 = new X509Certificate(certPem);
    const exp = Date.parse(x509.validTo);
    return !Number.isFinite(exp) || exp - now < renewWithinMs;
  } catch {
    return true;
  }
}

function readTailscaleTlsMaterial(dnsName) {
  const name = normalizeTailscaleDnsName(dnsName);
  if (!name) return null;
  const paths = tailscaleCertPaths(name);
  if (!fs.existsSync(paths.cert) || !fs.existsSync(paths.key)) return null;
  let cert;
  let key;
  try {
    cert = fs.readFileSync(paths.cert);
    key = fs.readFileSync(paths.key);
  } catch {
    return null;
  }
  if (!cert.length || !key.length || certNeedsRefresh(cert)) return null;
  return { cert, key, dnsName: name };
}

function requestTailscaleCertificate(dnsName) {
  const name = normalizeTailscaleDnsName(dnsName);
  if (!name) return null;
  const paths = tailscaleCertPaths(name);
  try {
    fs.mkdirSync(paths.dir, { recursive: true });
  } catch {
    return null;
  }
  const bin = findTailscaleBinary();
  try {
    execFileSync(bin, ["cert", "--cert-file", paths.cert, "--key-file", paths.key, name], {
      encoding: "utf8",
      timeout: 25000,
      windowsHide: true,
    });
  } catch (err) {
    console.warn(
      "[remoteAccess] tailscale cert failed:",
      err && err.message ? err.message : err
    );
    return null;
  }
  return readTailscaleTlsMaterial(name);
}

function ensureTailscaleHttpsCert(dnsName) {
  const existing = readTailscaleTlsMaterial(dnsName);
  if (existing) return existing;
  return requestTailscaleCertificate(dnsName);
}

function phoneUrlFor(host, port, token, { https = false } = {}) {
  const scheme = https ? "https" : "http";
  const base = `${scheme}://${host}:${port}`;
  return token ? `${base}/?token=${encodeURIComponent(token)}` : base;
}

function bindNoteFor({ allowLan, tailscaleIp, usedLan, httpsPhone }) {
  if (httpsPhone) {
    return allowLan
      ? "HTTPS over Tailscale (free Let's Encrypt). Live mic works in Chrome/Safari. LAN HTTP is also on."
      : "HTTPS over Tailscale (free Let's Encrypt). Live mic works in Chrome/Safari while this app is open.";
  }
  if (tailscaleIp && allowLan) {
    return "Reachable over Tailscale. LAN access is also on — devices on this Wi-Fi, including cafe or public networks, can reach this app. Live mic needs HTTPS: enable HTTPS Certificates in the Tailscale admin DNS page (free), then relaunch.";
  }
  if (tailscaleIp) {
    return "Reachable over Tailscale while this app is open. Live mic on iPhone needs HTTPS: enable HTTPS Certificates in the Tailscale admin DNS page (free), then relaunch.";
  }
  if (allowLan) {
    return usedLan
      ? "Tailscale is not detected. Using your local network address. Devices on the same Wi-Fi can reach this app, including on cafe or public networks."
      : "LAN access is on, so cafe or public Wi-Fi can reach this app. Tailscale is not detected and no local address was found.";
  }
  return "Phone access needs Tailscale on this PC. The app is not reachable from other devices until Tailscale is up.";
}

function buildRemoteInfo({
  port,
  token,
  host,
  allowLan,
  tailscaleIp,
  lanIpv4,
  tailscaleDns,
  httpsPhone,
} = {}) {
  const allow = Boolean(allowLan);
  const tsIp = tailscaleIp === undefined ? detectTailscaleIpSync() : tailscaleIp;
  const dnsName = normalizeTailscaleDnsName(tailscaleDns);
  const useHttps = Boolean(httpsPhone && dnsName);

  let phoneHost = null;
  let usedLan = false;
  if (useHttps) {
    phoneHost = dnsName;
  } else if (tsIp) {
    phoneHost = tsIp;
  } else if (allow) {
    const lan = lanIpv4 !== undefined ? lanIpv4 : getLanIpv4();
    if (lan) {
      phoneHost = lan;
      usedLan = true;
    }
  }

  const phoneUrl = phoneHost
    ? phoneUrlFor(phoneHost, port, token, { https: useHttps })
    : null;

  return {
    host,
    port,
    token,
    tailscaleIp: tsIp || null,
    phoneUrl,
    canCopyPhoneUrl: Boolean(phoneUrl),
    allowLan: allow,
    bindNote: bindNoteFor({
      allowLan: allow,
      tailscaleIp: tsIp || null,
      usedLan,
      httpsPhone: useHttps,
    }),
    httpsPhone: useHttps,
    tailscaleDns: dnsName,
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

function valueContainsToken(value, token) {
  if (!token) return false;
  if (typeof value === "string") return value.includes(token);
  try {
    return JSON.stringify(value).includes(token);
  } catch {
    return true;
  }
}

/** Redacted remote info for non-loopback clients. Never includes token or tokenized URLs. */
function toPublicRemoteInfo(info) {
  const src = info && typeof info === "object" ? info : {};
  const token = src.token;
  const out = {
    host: src.host,
    port: src.port,
    tailscaleIp: src.tailscaleIp,
    allowLan: src.allowLan,
    bindNote: src.bindNote,
    httpsPhone: !!src.httpsPhone,
    tailscaleDns: src.tailscaleDns || null,
    hasToken: Boolean(token),
    canCopyPhoneUrl: false,
    phoneUrl: null,
  };

  for (const key of Object.keys(src)) {
    if (
      key === "token" ||
      key === "phoneUrl" ||
      key === "canCopyPhoneUrl" ||
      key === "hasToken" ||
      key === "host" ||
      key === "port" ||
      key === "tailscaleIp" ||
      key === "allowLan" ||
      key === "bindNote" ||
      key === "httpsPhone" ||
      key === "tailscaleDns"
    ) {
      continue;
    }
    const value = src[key];
    if (key === "localUrl" && typeof value === "string" && value.includes("?token=")) {
      continue;
    }
    if (valueContainsToken(value, token)) continue;
    out[key] = value;
  }

  return out;
}

/** Full Phase-1 remote object for the PC 📱 modal. */
function toLoopbackRemoteInfo(info) {
  const src = info && typeof info === "object" ? info : {};
  return {
    ...toPublicRemoteInfo(src),
    token: src.token,
    phoneUrl: src.phoneUrl == null ? null : src.phoneUrl,
    canCopyPhoneUrl: src.canCopyPhoneUrl,
    localUrl: src.localUrl,
  };
}

function rotateToken() {
  const stored = loadConfig();
  const token = randomBytes(18).toString("base64url");
  stored.token = token;
  saveConfig(stored);
  const settings = resolveAccessSettings();
  return toLoopbackRemoteInfo(
    buildRemoteInfo({
      host: settings.host,
      port: settings.port,
      token,
      allowLan: settings.allowLan,
    })
  );
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
  rotateToken,
  toPublicRemoteInfo,
  toLoopbackRemoteInfo,
  getLastCwd,
  setLastCwd,
  normalizeStoredCwd,
  folderInSeenList,
  getSeenFolders,
  addSeenFolder,
  isSeenFolder,
  getPermissionMode,
  setPermissionMode,
  normalizeTailscaleDnsName,
  parseTailscaleStatus,
  detectTailscaleStatusSync,
  certNeedsRefresh,
  ensureTailscaleHttpsCert,
  phoneUrlFor,
};
