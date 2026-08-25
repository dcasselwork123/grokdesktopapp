"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execFile } = require("child_process");
const { EventEmitter } = require("events");
const { randomUUID } = require("crypto");
const {
  loadTranscript,
  synthesizeSessionMeta,
  looksLikeSessionDir,
  writeDesktopTitle,
  clearSessionDir,
  takeClearedSessionStub,
  isSubagentSessionPath,
  isSubagentSidebarSession,
} = require("./sessionTranscript");
const { attachMediaToMessages } = require("./sessionMedia");
const { isSafeSessionId, resolveUnderSessionsRoot } = require("./sessionId");
const { extractAskUserQuestions, shouldParkForAsk } = require("./sessionQuestions");
const { continueSessionWithAnswers } = require("./grokAcp");
const { searchSessions: searchSessionList } = require("./sessionSearch");

function getGrokHome() {
  return process.env.GROK_HOME || path.join(os.homedir(), ".grok");
}

function getAuthJsonPath() {
  return path.join(getGrokHome(), "auth.json");
}

/**
 * Look up a command on PATH (first match). Returns absolute path or null.
 */
function whichOnPath(cmd) {
  if (!cmd) return null;
  try {
    if (process.platform === "win32") {
      const out = require("child_process").execFileSync("where.exe", [cmd], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 4000,
      });
      const first = out
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)[0];
      if (first && fs.existsSync(first)) return first;
      return null;
    }
    const out = require("child_process").execFileSync("which", [cmd], {
      encoding: "utf8",
      timeout: 4000,
    });
    const first = out.trim().split(/\r?\n/)[0];
    if (first && fs.existsSync(first)) return first;
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve a real grok binary path, or null if not installed.
 * Does not fall back to a bare "grok" name that may not exist.
 */
function resolveGrokBinary() {
  if (process.env.GROK_BIN) {
    if (fs.existsSync(process.env.GROK_BIN)) return process.env.GROK_BIN;
  }
  const candidates = [
    path.join(getGrokHome(), "bin", process.platform === "win32" ? "grok.exe" : "grok"),
    path.join(os.homedir(), ".local", "bin", "grok"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // PATH lookup (Windows installers may only put grok on PATH)
  return (
    whichOnPath(process.platform === "win32" ? "grok.exe" : "grok") ||
    whichOnPath("grok") ||
    null
  );
}

/**
 * Binary path to spawn. Prefer a resolved install; fall back to "grok" so
 * existing spawn paths still attempt PATH resolution at process-exec time.
 */
function findGrokBinary() {
  return resolveGrokBinary() || "grok";
}

/** Mutable so Recheck after install can pick up a newly installed binary. */
let GROK_BIN = findGrokBinary();

function refreshGrokBinary() {
  GROK_BIN = findGrokBinary();
  return GROK_BIN;
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Read ~/.grok/auth.json without exposing tokens to callers.
 * Valid = at least one account entry with a usable credential
 * (access key and/or refresh_token). Expiry alone is OK when refresh_token exists.
 */
function getAuthStatus() {
  const authPath = getAuthJsonPath();
  if (!fs.existsSync(authPath)) {
    return {
      present: false,
      valid: false,
      reason: "missing",
      path: authPath,
      email: null,
      userId: null,
      firstName: null,
    };
  }

  let raw;
  try {
    raw = fs.readFileSync(authPath, "utf8");
  } catch {
    return {
      present: true,
      valid: false,
      reason: "unreadable",
      path: authPath,
      email: null,
      userId: null,
      firstName: null,
    };
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return {
      present: true,
      valid: false,
      reason: "invalid_json",
      path: authPath,
      email: null,
      userId: null,
      firstName: null,
    };
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return {
      present: true,
      valid: false,
      reason: "invalid_shape",
      path: authPath,
      email: null,
      userId: null,
      firstName: null,
    };
  }

  const entries = Object.values(data).filter((e) => e && typeof e === "object");
  if (!entries.length) {
    return {
      present: true,
      valid: false,
      reason: "empty",
      path: authPath,
      email: null,
      userId: null,
      firstName: null,
    };
  }

  const account =
    entries.find((e) => e.refresh_token || e.key || e.auth_mode === "oidc") ||
    entries[0];

  const hasKey = typeof account.key === "string" && account.key.length > 0;
  const hasRefresh =
    typeof account.refresh_token === "string" && account.refresh_token.length > 0;
  const hasCredential = hasKey || hasRefresh;

  const firstName =
    typeof account.first_name === "string" && account.first_name.trim()
      ? account.first_name.trim()
      : null;

  if (!hasCredential) {
    return {
      present: true,
      valid: false,
      reason: "no_credentials",
      path: authPath,
      email: account.email || null,
      userId: account.user_id || account.principal_id || null,
      firstName,
    };
  }

  // Access token may be short-lived; refresh_token means CLI can renew.
  let expired = false;
  if (account.expires_at && !hasRefresh) {
    const exp = Date.parse(account.expires_at);
    if (Number.isFinite(exp) && exp < Date.now()) expired = true;
  }

  return {
    present: true,
    valid: !expired,
    reason: expired ? "expired" : "ok",
    path: authPath,
    email: typeof account.email === "string" ? account.email : null,
    userId: account.user_id || account.principal_id || null,
    firstName,
  };
}

// ---------- grok login (OAuth) process ----------
let loginChild = null;
const loginState = {
  running: false,
  pid: null,
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  signal: null,
  error: null,
  log: "",
  method: null,
};

function appendLoginLog(chunk) {
  if (!chunk) return;
  const text = String(chunk);
  loginState.log = (loginState.log + text).slice(-8000);
}

function getLoginStatus() {
  return {
    running: loginState.running,
    pid: loginState.pid,
    startedAt: loginState.startedAt,
    finishedAt: loginState.finishedAt,
    exitCode: loginState.exitCode,
    signal: loginState.signal,
    error: loginState.error,
    // Last lines only — may contain a URL; never tokens from auth.json
    logTail: loginState.log ? loginState.log.slice(-1200) : "",
    method: loginState.method,
  };
}

/**
 * Spawn `grok login --oauth` so the real browser OAuth flow runs on this machine.
 * Same as the CLI; the desktop app only triggers it.
 */
function startGrokLogin({ oauth = true, method = null } = {}) {
  refreshGrokBinary();
  const bin = resolveGrokBinary();
  if (!bin) {
    const err = new Error(
      "Grok CLI is not installed. Install it first, then sign in."
    );
    err.code = "NOT_INSTALLED";
    throw err;
  }

  if (loginChild && loginState.running) {
    return {
      ok: true,
      alreadyRunning: true,
      ...getLoginStatus(),
    };
  }

  loginState.running = true;
  loginState.pid = null;
  loginState.startedAt = new Date().toISOString();
  loginState.finishedAt = null;
  loginState.exitCode = null;
  loginState.signal = null;
  loginState.error = null;
  loginState.log = "";
  loginState.method = method === "email" ? "email" : "x";

  const args = oauth ? ["login", "--oauth"] : ["login"];

  try {
    loginChild = spawn(bin, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
      // Detach false so we track exit; OAuth still opens the system browser.
    });
  } catch (err) {
    loginChild = null;
    loginState.running = false;
    loginState.finishedAt = new Date().toISOString();
    loginState.error = err.message || String(err);
    const e = new Error(loginState.error);
    e.code = "SPAWN_FAILED";
    throw e;
  }

  loginState.pid = loginChild.pid || null;

  loginChild.stdout?.on("data", (d) => appendLoginLog(d));
  loginChild.stderr?.on("data", (d) => appendLoginLog(d));

  loginChild.on("error", (err) => {
    loginState.error = err.message || String(err);
    loginState.running = false;
    loginState.finishedAt = new Date().toISOString();
    loginChild = null;
  });

  loginChild.on("close", (code, signal) => {
    loginState.exitCode = code;
    loginState.signal = signal || null;
    loginState.running = false;
    loginState.finishedAt = new Date().toISOString();
    loginChild = null;
  });

  return {
    ok: true,
    alreadyRunning: false,
    ...getLoginStatus(),
  };
}

function cancelGrokLogin() {
  if (!loginChild || !loginState.running) {
    return { ok: true, cancelled: false, ...getLoginStatus() };
  }
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(loginChild.pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } else {
      loginChild.kill("SIGTERM");
    }
  } catch (err) {
    try {
      loginChild.kill();
    } catch {
      /* ignore */
    }
    loginState.error = err.message || String(err);
  }
  return { ok: true, cancelled: true, ...getLoginStatus() };
}

function publicAuthFields(auth) {
  return {
    present: !!auth.present,
    valid: !!auth.valid,
    reason: auth.reason || null,
    email: auth.email || null,
    userId: auth.userId || null,
    firstName: auth.firstName || null,
  };
}

/**
 * Sign out via `grok logout` and drop the cached weekly usage snapshot.
 * Never returns tokens.
 */
function logoutGrok() {
  return new Promise((resolve, reject) => {
    cancelGrokLogin();
    refreshGrokBinary();
    const bin = resolveGrokBinary();
    if (!bin) {
      const err = new Error("Grok CLI is not installed.");
      err.code = "NOT_INSTALLED";
      reject(err);
      return;
    }
    execFile(
      bin,
      ["logout"],
      { timeout: 25000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err) => {
        weeklyCreditsCache = { at: 0, data: null };
        const auth = getAuthStatus();
        if (err && auth.valid) {
          const e = new Error(err.message || "Logout failed");
          e.code = "LOGOUT_FAILED";
          reject(e);
          return;
        }
        resolve({
          ok: !auth.valid,
          auth: publicAuthFields(auth),
        });
      }
    );
  });
}

/**
 * Startup readiness: CLI installed + auth present/valid.
 */
function getSetupStatus() {
  refreshGrokBinary();
  const resolved = resolveGrokBinary();
  const installed = !!resolved;
  const auth = getAuthStatus();
  const ready = installed && auth.valid;

  return {
    ready,
    installed,
    grokBin: resolved || null,
    grokHome: getGrokHome(),
    platform: process.platform,
    auth: publicAuthFields(auth),
    login: getLoginStatus(),
    install: {
      docsUrl: "https://x.ai/cli",
      windows: "irm https://x.ai/cli/install.ps1 | iex",
      unix: "curl -fsSL https://x.ai/cli/install.sh | bash",
    },
  };
}

function decodeCwdDirName(name) {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

function groupProjectName(cwd) {
  if (!cwd) return "unknown";
  const normalized = cwd.replace(/[\\/]+$/, "");
  const base = path.basename(normalized);
  return base || normalized;
}

/**
 * Scan ~/.grok/sessions for all sessions, grouped by project cwd.
 * Subagent children (Grok CLI spawn_subagent) stay on disk but are omitted
 * from the sidebar unless includeSubagents is true.
 */
function listSessions({
  limit = 100,
  includeOrphans = true,
  includeSubagents = false,
} = {}) {
  const sessionsRoot = path.join(getGrokHome(), "sessions");
  if (!fs.existsSync(sessionsRoot)) return [];

  const results = [];
  let groups;
  try {
    groups = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const group of groups) {
    if (!group.isDirectory()) continue;
    if (group.name === "session_search.sqlite") continue;

    const groupPath = path.join(sessionsRoot, group.name);
    const cwdFromDir = decodeCwdDirName(group.name);
    const cwdFile = path.join(groupPath, ".cwd");
    let cwd = cwdFromDir;
    if (fs.existsSync(cwdFile)) {
      try {
        cwd = fs.readFileSync(cwdFile, "utf8").trim() || cwdFromDir;
      } catch {
        /* keep decoded */
      }
    }

    let sessionDirs;
    try {
      sessionDirs = fs.readdirSync(groupPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const sd of sessionDirs) {
      if (!sd.isDirectory()) continue;
      const sessionPath = path.join(groupPath, sd.name);
      const summary = safeReadJson(path.join(sessionPath, "summary.json"));
      if (!summary && !includeOrphans) continue;
      if (!summary && !looksLikeSessionDir(sd.name, sessionPath)) continue;
      results.push(synthesizeSessionMeta(sessionPath, cwd));
    }
  }

  const visible = includeSubagents
    ? results
    : results.filter((s) => !isSubagentSidebarSession(s));

  visible.sort((a, b) => {
    const ta = a.updatedAt ? Date.parse(a.updatedAt) : 0;
    const tb = b.updatedAt ? Date.parse(b.updatedAt) : 0;
    return tb - ta;
  });

  return visible.slice(0, limit);
}

/** Title / folder / transcript search for the sidebar. Never returns disk paths. */
function searchSessions(query, { shouldAbort } = {}) {
  const q = String(query || "").trim();
  if (!q) return [];
  const sessions = listSessions({ limit: 250 });
  const listed = new Set(sessions.map((s) => s && s.id).filter(Boolean));
  const dbPath = path.join(getGrokHome(), "sessions", "session_search.sqlite");
  const hits = searchSessionList(q, { sessions, limit: 80, dbPath, shouldAbort });
  if (!hits.length) return hits;
  return hits.filter((hit) => {
    if (!hit || !hit.id) return false;
    if (listed.has(hit.id)) return true;
    const sessionPath = findSessionPath(hit.id);
    if (!sessionPath) return true;
    return !isSubagentSessionPath(sessionPath);
  });
}

/**
 * Reconstruct a readable chat transcript from the session folder.
 */
function loadSessionMessages(sessionId) {
  const sessionPath = findSessionPath(sessionId);
  if (!sessionPath) {
    return { session: null, messages: [] };
  }
  const session = synthesizeSessionMeta(sessionPath);
  const { messages } = loadTranscript(sessionPath);
  attachMediaToMessages(sessionPath, messages);
  return { session, messages };
}

function loadModels() {
  const cachePath = path.join(getGrokHome(), "models_cache.json");
  const cache = safeReadJson(cachePath);
  const models = [];
  if (cache?.models) {
    for (const [id, entry] of Object.entries(cache.models)) {
      const info = entry.info || entry;
      if (info.hidden) continue;
      models.push({
        id: info.id || id,
        name: info.name || id,
        description: info.description || "",
        efforts: (info.reasoning_efforts || []).map((e) => ({
          id: e.id || e.value,
          value: e.value || e.id,
          label: e.label || e.id,
          default: !!e.default,
        })),
        defaultEffort: info.reasoning_effort || "high",
        supportsEffort: !!info.supports_reasoning_effort,
      });
    }
  }
  if (models.length === 0) {
    models.push({
      id: "grok-4.5",
      name: "Grok 4.5",
      description: "Default model",
      efforts: [
        { id: "high", value: "high", label: "High", default: true },
        { id: "medium", value: "medium", label: "Medium", default: false },
        { id: "low", value: "low", label: "Low", default: false },
      ],
      defaultEffort: "high",
      supportsEffort: true,
    });
  }
  return models;
}

/**
 * Parse a data-URL or raw base64 payload without a heavy whole-string regex
 * (large screenshots are multi‑MB and a greedy regex can be slow).
 */
function parseImageData(data, mimeType = "image/png") {
  if (!data || typeof data !== "string") {
    throw new Error("Image data is required");
  }
  let raw = data.trim();
  let mime = mimeType || "image/png";
  if (raw.startsWith("data:")) {
    const comma = raw.indexOf(",");
    if (comma < 0) throw new Error("Invalid image data URL");
    const header = raw.slice(5, comma); // after "data:"
    const semi = header.indexOf(";");
    mime = (semi >= 0 ? header.slice(0, semi) : header) || mime;
    raw = raw.slice(comma + 1);
  }
  // Strip whitespace/newlines that some encoders insert
  if (raw.length < 500000 && /\s/.test(raw)) {
    raw = raw.replace(/\s+/g, "");
  } else if (raw.includes("\n") || raw.includes("\r") || raw.includes(" ")) {
    raw = raw.replace(/\s+/g, "");
  }
  const buf = Buffer.from(raw, "base64");
  if (!buf.length) throw new Error("Invalid image data");
  if (buf.length > 20 * 1024 * 1024) throw new Error("Image too large (max 20MB)");
  return { buf, mimeType: mime.startsWith("image/") ? mime : "image/png" };
}

const IMAGE_MAGIC_EXT = {
  jpeg: ".jpg",
  png: ".png",
  gif: ".gif",
  webp: ".webp",
};

const IMAGE_MAGIC_MIME = {
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

const IMAGE_MIME_KIND = {
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** Detect JPEG / PNG / GIF / WEBP from magic bytes (prefix only). */
function detectImageMagic(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 2) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpeg";
  if (
    buf.length >= 4 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return "png";
  }
  if (
    buf.length >= 4 &&
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38
  ) {
    return "gif";
  }
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return "webp";
  }
  return null;
}

function resolveImageKind(buf, mime) {
  const magic = detectImageMagic(buf);
  const declared = IMAGE_MIME_KIND[mime];
  if (declared) {
    if (magic !== declared) {
      throw new Error(
        `Image bytes do not match declared type ${mime} (expected ${declared.toUpperCase()} magic)`
      );
    }
    return declared;
  }
  if (!magic) {
    throw new Error("Unrecognized image format (expected JPEG, PNG, GIF, or WEBP)");
  }
  return magic;
}

/**
 * Save a base64 (or data-URL) image under ~/.grok-desktop/uploads.
 * Short UUID filenames avoid awkward names and are easy to pass to Grok.
 */
function saveImageUpload({ data, mimeType = "image/png", name = "image" } = {}) {
  const { buf, mimeType: mime } = parseImageData(data, mimeType);
  const kind = resolveImageKind(buf, mime);
  const ext = IMAGE_MAGIC_EXT[kind];
  const outMime = IMAGE_MIME_KIND[mime] ? mime : IMAGE_MAGIC_MIME[kind];

  const uploadsDir = path.join(os.homedir(), ".grok-desktop", "uploads");
  fs.mkdirSync(uploadsDir, { recursive: true });

  // Prefer short unique names (avoid "foo.png.png" from naive concat)
  const filePath = path.join(uploadsDir, `${randomUUID()}${ext}`);
  fs.writeFileSync(filePath, buf);
  return {
    path: filePath,
    mimeType: outMime,
    name: path.basename(filePath),
    bytes: buf.length,
  };
}

/**
 * Build a headless -p prompt that includes on-disk image paths.
 *
 * We intentionally avoid --prompt-json for images: large/complex JSON args have
 * been unreliable under Electron on Windows (spawn appears to start, then no
 * session events ever arrive). The CLI's read_file tool supports image vision
 * when given an absolute path — same path the TUI uses for dropped files.
 */
function buildImagePrompt(prompt, imagePaths = []) {
  const paths = [];
  for (const img of imagePaths) {
    const filePath = typeof img === "string" ? img : img.path;
    if (filePath && fs.existsSync(filePath)) paths.push(filePath);
  }
  const userText =
    (prompt || "").trim() ||
    (paths.length === 1
      ? "Please look at the attached image and respond."
      : "Please look at the attached images and respond.");
  if (!paths.length) return userText;

  const list = paths.map((p, i) => `${i + 1}. ${p}`).join("\n");
  return (
    `The user attached ${paths.length} image file(s) on disk. Call read_file on each path to view them.\n\n` +
    `Paths:\n${list}\n\n` +
    `--- user message (untrusted) ---\n` +
    `${userText}\n` +
    `--- end ---`
  );
}

function debugLog(line) {
  try {
    const dir = path.join(os.homedir(), ".grok-desktop");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, "debug.log"),
      `[${new Date().toISOString()}] ${line}\n`,
      "utf8"
    );
  } catch {
    /* ignore */
  }
}

function getDesktopTmpDir(...parts) {
  const dir = path.join(os.homedir(), ".grok-desktop", ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write the prompt to disk so Windows spawn doesn't choke on long -p args. */
function writeTempPromptFile(text) {
  const filePath = path.join(getDesktopTmpDir("prompts"), `${randomUUID()}.txt`);
  fs.writeFileSync(filePath, text == null ? "" : String(text), "utf8");
  return filePath;
}

function cleanupTempFile(filePath) {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* already gone */
  }
}

function createBufferedEmitter() {
  const emitter = new EventEmitter();
  const early = { event: [], sessionId: [], error: [], end: [], status: [], awaitingAnswers: [] };
  let piping = false;
  const emitBuffered = (name, payload) => {
    if (piping || emitter.listenerCount(name) > 0) {
      piping = true;
      for (const key of Object.keys(early)) {
        if (early[key].length && emitter.listenerCount(key) > 0) {
          for (const p of early[key].splice(0)) emitter.emit(key, p);
        }
      }
      emitter.emit(name, payload);
    } else {
      early[name] = early[name] || [];
      early[name].push(payload);
    }
  };
  emitter.on("newListener", (name) => {
    if (early[name] && early[name].length) {
      process.nextTick(() => {
        if (!early[name]) return;
        for (const p of early[name].splice(0)) emitter.emit(name, p);
      });
    }
  });
  return { emitter, emitBuffered };
}

/** Patterns that mean the agent tried to kill the Grok process itself (Windows/Unix). */
const SELF_KILL_RE =
  /taskkill\s+.*(?:\/im|\/IM)\s+grok(?:\.exe)?|Stop-Process\s+.*-Name\s+['"]?grok|killall\s+grok|pkill\s+.*grok|Get-Process\s+grok.*(?:Stop-Process|Kill)/i;

const NEW_SESSION_HINT =
  "This session may be stuck after a crash — start a New chat and continue there.";

/**
 * Locate a session directory under ~/.grok/sessions (any cwd group).
 */
function findSessionPath(sessionId) {
  if (!isSafeSessionId(sessionId)) return null;
  const sessionsRoot = path.join(getGrokHome(), "sessions");
  if (!fs.existsSync(sessionsRoot)) return null;
  try {
    const groups = fs.readdirSync(sessionsRoot, { withFileTypes: true });
    for (const group of groups) {
      if (!group.isDirectory()) continue;
      const candidate = resolveUnderSessionsRoot(sessionsRoot, group.name, sessionId);
      if (!candidate) continue;
      try {
        if (fs.statSync(candidate).isDirectory()) return candidate;
      } catch {
        /* missing */
      }
    }
    for (const group of groups) {
      if (!group.isDirectory()) continue;
      const groupPath = resolveUnderSessionsRoot(sessionsRoot, group.name);
      if (!groupPath) continue;
      let sessionDirs;
      try {
        sessionDirs = fs.readdirSync(groupPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const sd of sessionDirs) {
        if (!sd.isDirectory()) continue;
        const sessionDir = resolveUnderSessionsRoot(sessionsRoot, group.name, sd.name);
        if (!sessionDir) continue;
        const summary = safeReadJson(path.join(sessionDir, "summary.json"));
        if (summary?.info?.id === sessionId) {
          return sessionDir;
        }
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Drop stale *.lock files left when grok.exe was killed mid-write.
 * Safe: empty lock files are only useful while a live process holds them.
 */
function clearStaleSessionLocks(sessionId) {
  const sessionPath = findSessionPath(sessionId);
  if (!sessionPath) return { cleared: 0, path: null };
  let cleared = 0;
  try {
    for (const name of fs.readdirSync(sessionPath)) {
      if (!name.endsWith(".lock")) continue;
      try {
        fs.unlinkSync(path.join(sessionPath, name));
        cleared += 1;
      } catch {
        /* in use or gone */
      }
    }
  } catch {
    /* ignore */
  }
  if (cleared) debugLog(`cleared ${cleared} stale lock(s) for session=${sessionId}`);
  return { cleared, path: sessionPath };
}

/**
 * Scan recent session transcript for self-kill / incomplete-turn signals.
 */
function inspectSessionExitHints(sessionId) {
  const result = {
    selfKill: false,
    selfKillSnippet: null,
    sawTools: false,
    incompleteTools: false,
  };
  const sessionPath = findSessionPath(sessionId);
  if (!sessionPath) return result;

  const candidates = [
    path.join(sessionPath, "chat_history.jsonl"),
    path.join(sessionPath, "updates.jsonl"),
  ];

  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    let text = "";
    try {
      const st = fs.statSync(filePath);
      // Read tail only for large transcripts
      if (st.size > 120_000) {
        const fd = fs.openSync(filePath, "r");
        try {
          const buf = Buffer.alloc(Math.min(st.size, 100_000));
          fs.readSync(fd, buf, 0, buf.length, Math.max(0, st.size - buf.length));
          text = buf.toString("utf8");
        } finally {
          fs.closeSync(fd);
        }
      } else {
        text = fs.readFileSync(filePath, "utf8");
      }
    } catch {
      continue;
    }

    if (SELF_KILL_RE.test(text)) {
      result.selfKill = true;
      const m = text.match(SELF_KILL_RE);
      result.selfKillSnippet = m ? m[0].slice(0, 120) : null;
    }
    if (
      /"type"\s*:\s*"tool_call"|sessionUpdate"\s*:\s*"tool_call"|run_terminal_command|read_file/.test(
        text
      )
    ) {
      result.sawTools = true;
    }
    // Background bash left "running" without a final result is a common poison signal
    if (
      /<status>running<\/status>|"status"\s*:\s*"in_progress"|"status"\s*:\s*"Pending"/.test(
        text
      )
    ) {
      result.incompleteTools = true;
    }
  }

  return result;
}

/**
 * Build a user-facing error after a non-zero exit or hang.
 */
function buildExitErrorMessage({
  code,
  stderr,
  gotStdout,
  sawToolsLive,
  isResume,
  hadImages,
  killedByWatchdog,
  sessionId,
}) {
  const hints = sessionId ? inspectSessionExitHints(sessionId) : {};
  const sawTools = sawToolsLive || hints.sawTools;
  const stderrTrim = (stderr && stderr.slice(-1500).trim()) || "";

  if (hints.selfKill) {
    return (
      `Grok exited ${code != null ? code : "abnormally"} because a tool killed the Grok process ` +
      `(e.g. taskkill /IM grok.exe). That also kills this app’s agent.\n\n` +
      `${NEW_SESSION_HINT}`
    );
  }

  if (killedByWatchdog) {
    if (isResume) {
      return (
        `Grok produced no output while resuming this session (waited ~2 minutes). ` +
        `A fork was attempted if possible. ${NEW_SESSION_HINT}` +
        (hadImages
          ? " If you attached images, you can also retry without them to isolate the issue."
          : "")
      );
    }
    return (
      `Grok produced no output after start.` +
      (hadImages
        ? " Try a new session, or send without the image to check the connection."
        : ` ${NEW_SESSION_HINT}`)
    );
  }

  if (stderrTrim && !/^\s*$/.test(stderrTrim)) {
    // Prefer real CLI stderr; still append new-session hint for resume/tool crashes
    if ((isResume || sawTools) && code !== 0) {
      return `${stderrTrim}\n\n${NEW_SESSION_HINT}`;
    }
    return stderrTrim;
  }

  if (!gotStdout) {
    return (
      `Grok exited ${code} without producing output.` +
      (isResume
        ? ` ${NEW_SESSION_HINT}`
        : " Check that the Grok CLI is installed and logged in.")
    );
  }

  // Got stdout (tools/thoughts) then died with empty stderr
  if (sawTools) {
    return (
      `Grok exited ${code} mid-turn after running tools (no error details from the CLI). ` +
      `This often means the process was killed or the session was left incomplete.\n\n` +
      `${NEW_SESSION_HINT}`
    );
  }

  return (
    `Grok exited ${code}.` +
    (isResume || hints.incompleteTools ? ` ${NEW_SESSION_HINT}` : "")
  );
}

// Spike: default/dontAsk deny tools with no approve event (dontAsk: "User cancelled").
// Phone uses the same stored Access setting as the PC so remote coding still works.
// A phone JSON body cannot pick the mode — httpApi passes getPermissionMode() only.
const SAFER_PERMISSION_MODE = "dontAsk";
const DESKTOP_DEFAULT_PERMISSION_MODE = "bypassPermissions";
const ALLOWED_PERMISSION_MODES = ["bypassPermissions", "dontAsk", "default"];

function resolvePermissionMode({ permissionMode } = {}) {
  if (ALLOWED_PERMISSION_MODES.includes(permissionMode)) return permissionMode;
  return DESKTOP_DEFAULT_PERMISSION_MODE;
}

/**
 * Run a headless grok prompt and stream NDJSON events.
 * @returns {EventEmitter} emits: event, sessionId, error, end, status
 */
function runPrompt({
  prompt,
  sessionId = null,
  cwd = process.cwd(),
  model = "grok-4.5",
  effort = "high",
  newSession = false,
  images = [],
  forkFrom = null,
  permissionMode,
  remote = false,
}) {
  const { emitter, emitBuffered } = createBufferedEmitter();
  refreshGrokBinary();

  const imageList = Array.isArray(images) ? images.filter(Boolean) : [];
  let restoreTitle = null;
  let consumedClearStub = false;
  if (sessionId && !forkFrom) {
    const existingPath = findSessionPath(sessionId);
    const stub = existingPath ? takeClearedSessionStub(existingPath) : null;
    if (stub) {
      consumedClearStub = true;
      if (stub.title) restoreTitle = stub.title;
    }
  }
  const requestedResume = !!(sessionId && !newSession && !consumedClearStub);
  const effectivePrompt =
    imageList.length > 0 ? buildImagePrompt(prompt, imageList) : prompt || "";

  // Stale *.lock files from a previous hard kill wedge `--resume` (no stdout, then death).
  if (sessionId) {
    clearStaleSessionLocks(sessionId);
  }

  const resolvedPermissionMode = resolvePermissionMode({ remote, permissionMode });
  const promptFile = writeTempPromptFile(effectivePrompt);
  let debugFile = null;

  let child = null;
  let resolvedSessionId = sessionId || null;
  let buffer = "";
  let stderr = "";
  let killed = false;
  let killedByWatchdog = false;
  let gotStdout = false;
  let firstEventAt = null;
  let sawToolsLive = false;
  let sawEndEvent = false;
  let emittedError = false;
  let finished = false;
  let forkedOnce = false;
  let userCancelled = false;
  let parkedForAnswers = null;
  let parkKilled = false;
  let acpStarted = false;
  let currentIsResume = requestedResume;
  let watchdogWarn = null;
  let watchdogFail = null;
  let hangAfterEnd = null;

  const NO_STDOUT_WARN_MS = 20000;
  // Resume of a crashed session can sit on locks / replay for well over 45s.
  // Only kill (or fork) after a long silence with zero stdout.
  const NO_STDOUT_FAIL_MS = requestedResume ? 120000 : 90000;
  const HANG_AFTER_END_MS = 12000;

  function clearWatchdogs() {
    if (watchdogWarn) clearTimeout(watchdogWarn);
    if (watchdogFail) clearTimeout(watchdogFail);
    if (hangAfterEnd) clearTimeout(hangAfterEnd);
    watchdogWarn = null;
    watchdogFail = null;
    hangAfterEnd = null;
  }

  function killChildTree(proc) {
    if (!proc || !proc.pid) return;
    debugLog(`kill pid=${proc.pid}`);
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
      } else {
        proc.kill("SIGTERM");
      }
    } catch {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    }
  }

  function buildArgs({ resumeId, forkId, writeDebug }) {
    const args = [
      "--prompt-file",
      promptFile,
      "--verbatim",
      "-m",
      model,
      "--effort",
      effort,
      "--permission-mode",
      resolvedPermissionMode,
      "--output-format",
      "streaming-json",
      "--cwd",
      cwd,
    ];
    if (resumeId && forkId) {
      args.push("--resume", resumeId, "--fork-session", "--session-id", forkId);
    } else if (resumeId) {
      args.push("--resume", resumeId);
    } else if (forkId || (newSession && sessionId)) {
      args.push("--session-id", forkId || sessionId);
    }
    if (writeDebug) {
      debugFile = path.join(
        getDesktopTmpDir("runs"),
        `${Date.now()}-${String(resumeId || forkId || sessionId || "new").slice(0, 8)}.log`
      );
      args.push("--debug-file", debugFile);
    }
    return args;
  }

  function attachChild(proc, { isResume, isFork }) {
    child = proc;
    buffer = "";
    gotStdout = false;
    firstEventAt = null;
    sawToolsLive = false;
    sawEndEvent = false;
    currentIsResume = isResume;

    debugLog(`spawned pid=${proc.pid} resume=${isResume} fork=${isFork}`);
    emitBuffered("status", {
      message: isFork
        ? "Previous session was stuck — continuing in a forked copy…"
        : imageList.length
          ? "Grok process started — opening image…"
          : "Grok process started…",
      pid: proc.pid,
    });

    clearWatchdogs();
    watchdogWarn = setTimeout(() => {
      if (!gotStdout && !killed && !finished) {
        debugLog(`watchdog: no stdout after ${NO_STDOUT_WARN_MS}ms pid=${proc.pid}`);
        emitBuffered("status", {
          message: isResume
            ? "Still waiting for Grok to resume this session…"
            : "Still waiting for Grok output… (this is taking longer than usual)",
        });
      }
    }, NO_STDOUT_WARN_MS);

    watchdogFail = setTimeout(() => {
      if (gotStdout || killed || finished) return;
      debugLog(
        `watchdog fail: no stdout pid=${proc.pid} resume=${isResume} forkedOnce=${forkedOnce}`
      );

      // First resume hang: fork into a new session so the user can keep going.
      if (isResume && sessionId && !forkedOnce && !userCancelled) {
        forkedOnce = true;
        emitBuffered("status", {
          message:
            "This session isn’t resuming (often leftover locks after a crash). Forking a continuation…",
        });
        killed = true;
        killChildTree(proc);
        return;
      }

      killedByWatchdog = true;
      const msg = buildExitErrorMessage({
        code: null,
        stderr,
        gotStdout: false,
        sawToolsLive: false,
        isResume,
        hadImages: imageList.length > 0,
        killedByWatchdog: true,
        sessionId: resolvedSessionId || sessionId,
      });
      emittedError = true;
      emitBuffered("error", new Error(msg));
      try {
        emitter.kill();
      } catch {
        /* ignore */
      }
    }, isResume ? NO_STDOUT_FAIL_MS : NO_STDOUT_FAIL_MS);

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      if (!gotStdout) {
        gotStdout = true;
        firstEventAt = Date.now();
        debugLog(`first stdout bytes=${chunk.length} pid=${proc.pid}`);
        emitBuffered("status", { message: "Grok is running…" });
        if (watchdogFail) {
          clearTimeout(watchdogFail);
          watchdogFail = null;
        }
      }
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let evt;
        try {
          evt = JSON.parse(line);
        } catch {
          continue;
        }
        if (evt.sessionId) resolvedSessionId = evt.sessionId;
        if (evt.type === "end" && evt.sessionId) resolvedSessionId = evt.sessionId;
        if (evt.session_id) resolvedSessionId = evt.session_id;
        if (
          parkedForAnswers &&
          evt.type !== "tool_call" &&
          evt.type !== "tool_call_update"
        ) {
          continue;
        }
        if (evt.type === "available_commands") {
          emitBuffered("status", { message: "Grok is running…" });
        } else if (evt.type === "thought") {
          emitBuffered("status", { message: "Thinking…" });
        } else if (evt.type === "tool_call" || evt.type === "tool_call_update") {
          sawToolsLive = true;
          const blob = JSON.stringify(evt);
          if (SELF_KILL_RE.test(blob)) {
            debugLog(
              `detected self-kill pattern in live tool event session=${resolvedSessionId}`
            );
          }
          const ask = extractAskUserQuestions(evt);
          if (ask) {
            debugLog(
              `ask_user_question id=${ask.id || "?"} questions=${ask.questions.length} ` +
                `status=${evt.status || evt.title || ""} session=${resolvedSessionId || ""}`
            );
          }
          if (
            ask &&
            shouldParkForAsk(evt, ask) &&
            !parkedForAnswers &&
            !userCancelled &&
            !finished
          ) {
            parkedForAnswers = {
              ask,
              sessionId: resolvedSessionId || sessionId,
            };
            emitBuffered("status", { message: "Waiting for your choice…" });
            emitBuffered("event", evt);
            if (resolvedSessionId) emitBuffered("sessionId", resolvedSessionId);
            emitBuffered("awaitingAnswers", {
              sessionId: resolvedSessionId || sessionId,
              askId: ask.id,
              questions: ask.questions,
            });
            debugLog(
              `park -p for ask id=${ask.id || "?"} session=${resolvedSessionId || sessionId}`
            );
            parkKilled = true;
            killed = true;
            killChildTree(proc);
            continue;
          }
          emitBuffered("status", {
            message: ask
              ? "Waiting for your choice…"
              : evt.title || evt.toolName || "Using tools…",
          });
        } else if (parkedForAnswers && (evt.type === "text" || evt.type === "thought")) {
          continue;
        } else if (evt.type === "text") {
          emitBuffered("status", { message: "Writing…" });
        } else if (evt.type === "end") {
          sawEndEvent = true;
          emitBuffered("status", { message: "Finishing turn…" });
          // grok sometimes emits `end` then hangs (debug log: turn completed, process never exits).
          if (!hangAfterEnd) {
            hangAfterEnd = setTimeout(() => {
              if (finished || killed) return;
              debugLog(
                `hang-after-end: killing pid=${proc.pid} session=${resolvedSessionId}`
              );
              killed = true;
              killChildTree(proc);
            }, HANG_AFTER_END_MS);
          }
        } else if (evt.type === "error" && evt.message) {
          emitBuffered("status", { message: String(evt.message).slice(0, 160) });
        }
        emitBuffered("event", evt);
        if (resolvedSessionId) emitBuffered("sessionId", resolvedSessionId);
      }
    });

    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 80_000) stderr = stderr.slice(-40_000);
      const last = String(chunk).trim().split(/\r?\n/).filter(Boolean).pop();
      if (last && !gotStdout) {
        emitBuffered("status", {
          message: last.length > 160 ? `${last.slice(0, 160)}…` : last,
        });
      }
    });

    proc.on("error", (err) => {
      debugLog(`child error: ${err.message || err}`);
      emitBuffered("error", err);
    });

    proc.on("close", (code) => {
      if (child !== proc) return;
      clearWatchdogs();
      if (parkedForAnswers && parkKilled && !userCancelled && !acpStarted && !finished) {
        child = null;
        debugLog(
          `parked: -p exited code=${code} waiting for answers session=${resolvedSessionId}`
        );
        emitBuffered("status", { message: "Waiting for your choice…" });
        return;
      }
      debugLog(
        `close code=${code} gotStdout=${gotStdout} session=${resolvedSessionId} ` +
          `stderrLen=${stderr.length} firstEventMs=${firstEventAt || "-"} ` +
          `sawTools=${sawToolsLive} watchdog=${killedByWatchdog} killed=${killed} ` +
          `forkedOnce=${forkedOnce} sawEnd=${sawEndEvent}`
      );
      if (buffer.trim()) {
        try {
          const evt = JSON.parse(buffer.trim());
          if (evt.sessionId) resolvedSessionId = evt.sessionId;
          emitBuffered("event", evt);
        } catch {
          /* ignore trailing garbage */
        }
      }

      // Resume hung with no output: fork once instead of failing the turn.
      if (
        !gotStdout &&
        currentIsResume &&
        forkedOnce &&
        !finished &&
        sessionId &&
        !killedByWatchdog &&
        !userCancelled
      ) {
        const forkId = createSessionId();
        debugLog(`fork-retry from session=${sessionId} -> ${forkId}`);
        if (sessionId) clearStaleSessionLocks(sessionId);
        killed = false;
        startChild({
          resumeId: sessionId,
          forkId,
          isResume: false,
          isFork: true,
          writeDebug: true,
        });
        emitBuffered("sessionId", forkId);
        resolvedSessionId = forkId;
        return;
      }

      finishRun(code);
    });
  }

  function finishRun(code) {
    if (finished) return;
    finished = true;
    clearWatchdogs();
    cleanupTempFile(promptFile);

    const abnormal = code !== 0 && !killed && !sawEndEvent;
    if (abnormal && !emittedError) {
      const msg = buildExitErrorMessage({
        code,
        stderr,
        gotStdout,
        sawToolsLive,
        isResume: currentIsResume,
        hadImages: imageList.length > 0,
        killedByWatchdog: false,
        sessionId: resolvedSessionId || sessionId,
      });
      emitBuffered("error", new Error(msg));
    }

    // `end` already wrote the session; a later hang-kill should not look like failure.
    const ok = (code === 0 || sawEndEvent) && !killedByWatchdog;
    emitBuffered("end", {
      ok,
      code,
      sessionId: resolvedSessionId,
      stderr: stderr.slice(-4000),
      poisonedHint: (!ok && (abnormal || killedByWatchdog)) || false,
      forked: forkedOnce && resolvedSessionId && resolvedSessionId !== sessionId,
    });
  }

  function startChild({ resumeId, forkId, isResume, isFork, writeDebug }) {
    const args = buildArgs({ resumeId, forkId, writeDebug });
    debugLog(
      `spawn images=${imageList.length} newSession=${newSession} resume=${!!resumeId} ` +
        `fork=${!!forkId} effort=${effort} permissionMode=${resolvedPermissionMode} cwd=${cwd} promptChars=${effectivePrompt.length} ` +
        `imgPaths=${imageList.map((i) => (typeof i === "string" ? i : i.path)).join("|")}`
    );
    let proc;
    try {
      proc = spawn(GROK_BIN, args, {
        cwd,
        env: { ...process.env },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      debugLog(`spawn threw: ${err.message || err}`);
      if (!finished) {
        cleanupTempFile(promptFile);
        process.nextTick(() => {
          emitBuffered("error", err);
          emitBuffered("end", { ok: false, error: String(err) });
        });
        finished = true;
      }
      return;
    }
    attachChild(proc, { isResume, isFork });
  }

  const forkSource =
    forkFrom && typeof forkFrom === "string" ? forkFrom.trim() : "";
  if (forkSource) {
    clearStaleSessionLocks(forkSource);
    const forkId = sessionId || createSessionId();
    resolvedSessionId = forkId;
    startChild({
      resumeId: forkSource,
      forkId,
      isResume: false,
      isFork: true,
      writeDebug: false,
    });
    emitBuffered("sessionId", forkId);
  } else {
    startChild({
      resumeId: requestedResume ? sessionId : null,
      forkId: (newSession || consumedClearStub) && sessionId ? sessionId : null,
      isResume: requestedResume,
      isFork: false,
      writeDebug: requestedResume,
    });
    if (restoreTitle) restoreDesktopTitleSoon(sessionId, restoreTitle);
  }

  async function startAcpContinuation(pairs) {
    acpStarted = true;
    emitBuffered("status", { message: "Continuing with your choice…" });
    if (resolvedSessionId) clearStaleSessionLocks(resolvedSessionId);
    try {
      const result = await continueSessionWithAnswers({
        grokBin: GROK_BIN,
        sessionId: resolvedSessionId || sessionId,
        cwd,
        model,
        effort,
        permissionMode: resolvedPermissionMode,
        answers: pairs,
        log: debugLog,
        shouldCancel: () => userCancelled || finished,
        onStatus: (data) => emitBuffered("status", data),
        onEvent: (evt) => {
          if (evt && evt.sessionId) resolvedSessionId = evt.sessionId;
          emitBuffered("event", evt);
          if (resolvedSessionId) emitBuffered("sessionId", resolvedSessionId);
        },
      });
      if (finished || userCancelled) return;
      sawEndEvent = true;
      if (result && result.sessionId) resolvedSessionId = result.sessionId;
      finishRun(0);
    } catch (err) {
      if (finished) return;
      if (userCancelled) {
        finishRun(null);
        return;
      }
      debugLog(`acp continuation failed: ${err && err.message ? err.message : err}`);
      emitBuffered("error", err);
      finishRun(1);
    }
  }

  emitter.submitAnswers = (pairs) => {
    if (finished || userCancelled || acpStarted) return false;
    if (!parkedForAnswers) return false;
    const list = Array.isArray(pairs) ? pairs.filter((p) => p && (p.answer || p.label)) : [];
    if (!list.length) return false;
    void startAcpContinuation(list);
    return true;
  };

  emitter.kill = () => {
    userCancelled = true;
    killed = true;
    clearWatchdogs();
    killChildTree(child);
    if (parkedForAnswers && !acpStarted) {
      parkedForAnswers = null;
      if (!finished) finishRun(null);
      return;
    }
    if (!child && !acpStarted) {
      finishRun(null);
    }
  };

  return emitter;
}

function createSessionId() {
  return randomUUID();
}

const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
let weeklyCreditsCache = { at: 0, data: null };

function getAccountAccessKey() {
  const authPath = getAuthJsonPath();
  if (!fs.existsSync(authPath)) return null;
  const data = safeReadJson(authPath);
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const entries = Object.values(data).filter((e) => e && typeof e === "object");
  const account =
    entries.find((e) => e.refresh_token || e.key || e.auth_mode === "oidc") ||
    entries[0];
  if (!account || typeof account.key !== "string" || !account.key) return null;
  return account.key;
}

function productLabel(id) {
  const raw = String(id || "");
  if (raw === "GrokBuild") return "Grok Build";
  if (raw === "GrokChat") return "Grok Chat";
  if (raw === "GrokImagine") return "Imagine";
  if (raw === "GrokVoice") return "Voice";
  return raw.replace(/([a-z])([A-Z])/g, "$1 $2");
}

async function fetchWeeklyCredits({ force = false } = {}) {
  if (!force && weeklyCreditsCache.data && Date.now() - weeklyCreditsCache.at < 45000) {
    return weeklyCreditsCache.data;
  }
  const key = getAccountAccessKey();
  if (!key) return null;
  const ac = typeof AbortSignal !== "undefined" && AbortSignal.timeout
    ? AbortSignal.timeout(8000)
    : undefined;
  const res = await fetch(BILLING_URL, {
    headers: {
      Authorization: `Bearer ${key}`,
      "X-XAI-Token-Auth": "xai-grok-cli",
      Accept: "application/json",
    },
    signal: ac,
  });
  if (!res.ok) {
    const err = new Error(`billing ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  weeklyCreditsCache = { at: Date.now(), data: json };
  return json;
}

function readSessionContext(sessionId) {
  if (!sessionId) return null;
  const sessionPath = findSessionPath(sessionId);
  if (!sessionPath) return null;
  const signals = safeReadJson(path.join(sessionPath, "signals.json"));
  if (!signals) return null;
  const tokensUsed = Number(signals.contextTokensUsed) || 0;
  const tokensTotal = Number(signals.contextWindowTokens) || 0;
  let usedPercent = Number(signals.contextWindowUsage);
  if (!Number.isFinite(usedPercent)) {
    usedPercent = tokensTotal > 0 ? Math.round((tokensUsed / tokensTotal) * 100) : 0;
  }
  return {
    tokensUsed,
    tokensTotal,
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
  };
}

/**
 * Weekly credit usage + this session's context window.
 * Never includes tokens or account secrets.
 */
async function getUsageSnapshot({ sessionId = null } = {}) {
  let weekly = null;
  let weeklyError = null;
  try {
    const raw = await fetchWeeklyCredits();
    const cfg = raw && raw.config;
    if (cfg) {
      const used = Number(cfg.creditUsagePercent);
      const usedPercent = Number.isFinite(used) ? used : 0;
      weekly = {
        usedPercent,
        remainingPercent: Math.max(0, Math.round((100 - usedPercent) * 10) / 10),
        resetsAt: (cfg.currentPeriod && cfg.currentPeriod.end) || cfg.billingPeriodEnd || null,
        periodStart:
          (cfg.currentPeriod && cfg.currentPeriod.start) || cfg.billingPeriodStart || null,
        periodEnd: (cfg.currentPeriod && cfg.currentPeriod.end) || cfg.billingPeriodEnd || null,
        periodType: (cfg.currentPeriod && cfg.currentPeriod.type) || "USAGE_PERIOD_TYPE_WEEKLY",
        products: Array.isArray(cfg.productUsage)
          ? cfg.productUsage.map((p) => ({
              id: p.product || "unknown",
              label: productLabel(p.product),
              usedPercent: Number(p.usagePercent) || 0,
            }))
          : [],
      };
    }
  } catch {
    weeklyError = "unavailable";
  }

  return {
    weekly,
    weeklyError,
    session: readSessionContext(sessionId),
  };
}

function getStatus() {
  const setup = getSetupStatus();
  return {
    grokBin: setup.grokBin || GROK_BIN,
    grokHome: setup.grokHome,
    platform: process.platform,
    cwd: process.cwd(),
    ready: setup.ready,
    installed: setup.installed,
    authenticated: setup.auth.valid,
    authEmail: setup.auth.email || null,
    authFirstName: setup.auth.firstName || null,
  };
}

/**
 * Prefer shelling out to `grok sessions list` when available; fall back to FS scan.
 */
function listSessionsCli({ limit = 50 } = {}) {
  return new Promise((resolve) => {
    execFile(
      GROK_BIN,
      ["sessions", "list", "-n", String(limit)],
      { timeout: 15000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout) {
          resolve(listSessions({ limit }));
          return;
        }
        // FS scan is richer (cwd, project, model); always use it as source of truth
        resolve(listSessions({ limit }));
      }
    );
  });
}

function findSessionById(sessionId, { limit = 500 } = {}) {
  if (!sessionId) return null;
  const sessionPath = findSessionPath(sessionId);
  if (sessionPath) return synthesizeSessionMeta(sessionPath);
  return (
    listSessions({ limit, includeOrphans: true }).find((s) => s.id === sessionId) ||
    null
  );
}

function getDesktopHome() {
  return path.join(os.homedir(), ".grok-desktop");
}

function getArchiveRoot() {
  return path.join(getDesktopHome(), "archive");
}

function execFileAsync(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: 20000, windowsHide: true, maxBuffer: 2 * 1024 * 1024, ...opts },
      (err, stdout, stderr) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          reject(err);
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

/** Remove a session directory from ~/.grok/sessions. */
function removeSessionDir(session) {
  if (!session?.path || !fs.existsSync(session.path)) return;
  fs.rmSync(session.path, { recursive: true, force: true });
}

async function notifyCliSessionDeleted(sessionId) {
  try {
    await execFileAsync(GROK_BIN, ["sessions", "delete", sessionId], {
      timeout: 8000,
    });
  } catch {
    /* folder is already gone; CLI index update is best-effort */
  }
}

async function deleteSession(sessionId) {
  const session = findSessionById(sessionId);
  if (!session) {
    const err = new Error("Session not found");
    err.code = "NOT_FOUND";
    throw err;
  }

  try {
    removeSessionDir(session);
  } catch (fsErr) {
    try {
      await execFileAsync(GROK_BIN, ["sessions", "delete", sessionId]);
    } catch (cliError) {
      const err = new Error(
        cliError.stderr?.toString?.().trim() ||
          cliError.message ||
          fsErr.message ||
          "Failed to delete session"
      );
      err.code = "DELETE_FAILED";
      throw err;
    }
    if (session.path && fs.existsSync(session.path)) {
      fs.rmSync(session.path, { recursive: true, force: true });
    }
    return { id: sessionId, deleted: true };
  }

  await notifyCliSessionDeleted(sessionId);
  return { id: sessionId, deleted: true };
}

/**
 * Archive a session by moving it out of ~/.grok/sessions into
 * ~/.grok-desktop/archive/ so it no longer appears in the sidebar.
 */
async function archiveSession(sessionId) {
  const session = findSessionById(sessionId);
  if (!session) {
    const err = new Error("Session not found");
    err.code = "NOT_FOUND";
    throw err;
  }
  if (!session.path || !fs.existsSync(session.path)) {
    const err = new Error("Session folder missing on disk");
    err.code = "NOT_FOUND";
    throw err;
  }

  const parentName = path.basename(path.dirname(session.path));
  const destDir = path.join(getArchiveRoot(), parentName, path.basename(session.path));
  fs.mkdirSync(path.dirname(destDir), { recursive: true });
  if (fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true, force: true });
  }

  try {
    fs.renameSync(session.path, destDir);
  } catch {
    fs.cpSync(session.path, destDir, { recursive: true });
    fs.rmSync(session.path, { recursive: true, force: true });
  }

  try {
    fs.writeFileSync(
      path.join(destDir, ".desktop-archive.json"),
      JSON.stringify(
        {
          archivedAt: new Date().toISOString(),
          originalPath: session.path,
          id: sessionId,
          title: session.title || null,
          cwd: session.cwd || null,
          project: session.project || null,
        },
        null,
        2
      ),
      "utf8"
    );
  } catch {
    /* non-fatal metadata */
  }

  return { id: sessionId, archived: true, archivePath: destDir };
}

/**
 * Wipe this session's conversation and tool state without deleting the
 * sidebar entry. Next send must use newSession + the same id.
 */
function clearSession(sessionId) {
  const session = findSessionById(sessionId);
  if (!session) {
    const err = new Error("Session not found");
    err.code = "NOT_FOUND";
    throw err;
  }
  if (!session.path || !fs.existsSync(session.path)) {
    const err = new Error("Session folder missing on disk");
    err.code = "NOT_FOUND";
    throw err;
  }

  const updated = clearSessionDir(session.path, {
    id: sessionId,
    cwd: session.cwd,
    createdAt: session.createdAt,
    title: session.title,
  });
  return { id: sessionId, session: updated, messages: [] };
}

function restoreDesktopTitleSoon(sessionId, title) {
  const cleaned = String(title || "").trim();
  if (!sessionId || !cleaned) return;
  let attempts = 40;
  const tick = () => {
    const sessionPath = findSessionPath(sessionId);
    if (sessionPath && fs.existsSync(sessionPath)) {
      try {
        writeDesktopTitle(sessionPath, cleaned);
      } catch {
        /* grok may still be creating the folder */
      }
      return;
    }
    attempts -= 1;
    if (attempts > 0) setTimeout(tick, 150);
  };
  setTimeout(tick, 200);
}

/**
 * Set or clear a user-chosen sidebar title for a session.
 * Empty title removes the override so the generated title is used again.
 */
function renameSession(sessionId, title) {
  const session = findSessionById(sessionId);
  if (!session) {
    const err = new Error("Session not found");
    err.code = "NOT_FOUND";
    throw err;
  }
  if (!session.path || !fs.existsSync(session.path)) {
    const err = new Error("Session folder missing on disk");
    err.code = "NOT_FOUND";
    throw err;
  }

  writeDesktopTitle(session.path, title);
  const updated = synthesizeSessionMeta(session.path);
  return {
    id: sessionId,
    title: updated.title,
    session: updated,
  };
}

/**
 * Bulk delete or archive. Continues on per-id errors and reports results.
 * @param {"delete"|"archive"} action
 * @param {string[]} ids
 */
async function bulkSessionAction(action, ids) {
  if (action !== "delete" && action !== "archive") {
    const err = new Error('action must be "delete" or "archive"');
    err.code = "BAD_REQUEST";
    throw err;
  }
  const list = Array.isArray(ids) ? [...new Set(ids.filter(Boolean))] : [];
  if (!list.length) {
    const err = new Error("No session ids provided");
    err.code = "BAD_REQUEST";
    throw err;
  }

  const results = [];
  if (action === "delete") {
    // Resolve every session first so later lookups don't depend on leftover CLI state.
    const resolved = list.map((id) => ({ id, session: findSessionById(id) }));
    for (const { id, session } of resolved) {
      try {
        if (!session) {
          const err = new Error("Session not found");
          err.code = "NOT_FOUND";
          throw err;
        }
        removeSessionDir(session);
        results.push({ id, ok: true });
      } catch (err) {
        results.push({
          id,
          ok: false,
          error: err.message || String(err),
          code: err.code || null,
        });
      }
    }
    const deleted = results.filter((r) => r.ok).map((r) => r.id);
    for (const id of deleted) {
      await notifyCliSessionDeleted(id);
    }
  } else {
    for (const id of list) {
      try {
        await archiveSession(id);
        results.push({ id, ok: true });
      } catch (err) {
        results.push({
          id,
          ok: false,
          error: err.message || String(err),
          code: err.code || null,
        });
      }
    }
  }

  const ok = results.filter((r) => r.ok).length;
  const failed = results.length - ok;
  return { action, results, ok, failed };
}

module.exports = {
  getGrokHome,
  findGrokBinary,
  resolveGrokBinary,
  refreshGrokBinary,
  getAuthStatus,
  getSetupStatus,
  startGrokLogin,
  cancelGrokLogin,
  logoutGrok,
  getLoginStatus,
  listSessions,
  searchSessions,
  listSessionsCli,
  findSessionById,
  findSessionPath,
  clearStaleSessionLocks,
  inspectSessionExitHints,
  buildExitErrorMessage,
  deleteSession,
  archiveSession,
  clearSession,
  renameSession,
  bulkSessionAction,
  loadSessionMessages,
  loadModels,
  runPrompt,
  resolvePermissionMode,
  SAFER_PERMISSION_MODE,
  DESKTOP_DEFAULT_PERMISSION_MODE,
  buildImagePrompt,
  saveImageUpload,
  createSessionId,
  getStatus,
  getUsageSnapshot,
  getAccountAccessKey,
};
