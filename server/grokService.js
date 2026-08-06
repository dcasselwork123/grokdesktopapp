"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execFile } = require("child_process");
const { EventEmitter } = require("events");
const { randomUUID } = require("crypto");

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
    };
  }

  const account =
    entries.find((e) => e.refresh_token || e.key || e.auth_mode === "oidc") ||
    entries[0];

  const hasKey = typeof account.key === "string" && account.key.length > 0;
  const hasRefresh =
    typeof account.refresh_token === "string" && account.refresh_token.length > 0;
  const hasCredential = hasKey || hasRefresh;

  if (!hasCredential) {
    return {
      present: true,
      valid: false,
      reason: "no_credentials",
      path: authPath,
      email: account.email || null,
      userId: account.user_id || account.principal_id || null,
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
  };
}

/**
 * Spawn `grok login --oauth` so the real browser OAuth flow runs on this machine.
 * Same as the CLI; the desktop app only triggers it.
 */
function startGrokLogin({ oauth = true } = {}) {
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
    auth: {
      present: auth.present,
      valid: auth.valid,
      reason: auth.reason,
      email: auth.email,
      userId: auth.userId,
    },
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
 */
function listSessions({ limit = 100 } = {}) {
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
      const summaryPath = path.join(groupPath, sd.name, "summary.json");
      if (!fs.existsSync(summaryPath)) continue;
      const summary = safeReadJson(summaryPath);
      if (!summary) continue;

      const id = summary.info?.id || sd.name;
      const title =
        summary.manual_title ||
        summary.generated_title ||
        summary.session_summary ||
        "Untitled session";
      const updated =
        summary.last_active_at || summary.updated_at || summary.created_at || null;
      const created = summary.created_at || null;

      results.push({
        id,
        title,
        cwd: summary.info?.cwd || cwd,
        project: groupProjectName(summary.info?.cwd || cwd),
        createdAt: created,
        updatedAt: updated,
        model: summary.current_model_id || null,
        effort: summary.reasoning_effort || null,
        numMessages: summary.num_chat_messages ?? summary.num_messages ?? 0,
        path: path.join(groupPath, sd.name),
      });
    }
  }

  results.sort((a, b) => {
    const ta = a.updatedAt ? Date.parse(a.updatedAt) : 0;
    const tb = b.updatedAt ? Date.parse(b.updatedAt) : 0;
    return tb - ta;
  });

  return results.slice(0, limit);
}

/**
 * Reconstruct a readable chat transcript from updates.jsonl.
 */
function loadSessionMessages(sessionId) {
  const session = listSessions({ limit: 500 }).find((s) => s.id === sessionId);
  if (!session) {
    return { session: null, messages: [] };
  }

  const updatesPath = path.join(session.path, "updates.jsonl");
  const messages = [];
  let currentUser = null;
  let currentAssistant = null;
  const tools = new Map(); // toolCallId -> tool entry

  function flushUser() {
    if (currentUser && currentUser.text.trim()) {
      messages.push({
        role: "user",
        text: currentUser.text.trim(),
        ts: currentUser.ts,
      });
    }
    currentUser = null;
  }

  function flushAssistant() {
    if (!currentAssistant) return;
    const hasContent =
      (currentAssistant.text && currentAssistant.text.trim()) ||
      (currentAssistant.tools && currentAssistant.tools.length);
    if (hasContent) {
      messages.push({
        role: "assistant",
        text: (currentAssistant.text || "").trim(),
        tools: currentAssistant.tools || [],
        ts: currentAssistant.ts,
      });
    }
    currentAssistant = null;
  }

  if (!fs.existsSync(updatesPath)) {
    return { session, messages: [] };
  }

  let lines;
  try {
    lines = fs.readFileSync(updatesPath, "utf8").split(/\r?\n/).filter(Boolean);
  } catch {
    return { session, messages: [] };
  }

  for (const line of lines) {
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    const update = evt.params?.update || evt.update;
    if (!update) continue;
    const kind = update.sessionUpdate;
    const ts = evt.timestamp || null;

    if (kind === "user_message_chunk") {
      flushAssistant();
      const chunk = update.content?.text || "";
      if (!currentUser) currentUser = { text: "", ts };
      currentUser.text += chunk;
    } else if (kind === "agent_message_chunk") {
      flushUser();
      const chunk = update.content?.text || "";
      if (!currentAssistant) currentAssistant = { text: "", tools: [], ts };
      currentAssistant.text += chunk;
    } else if (kind === "agent_thought_chunk") {
      // Skip thoughts in history view for cleaner chat
      flushUser();
      if (!currentAssistant) currentAssistant = { text: "", tools: [], ts };
    } else if (kind === "tool_call") {
      flushUser();
      if (!currentAssistant) currentAssistant = { text: "", tools: [], ts };
      const id = update.toolCallId;
      const entry = {
        id,
        title: update.title || update._meta?.["x.ai/tool"]?.name || "tool",
        status: "pending",
        name: update._meta?.["x.ai/tool"]?.name || update.title || "tool",
      };
      tools.set(id, entry);
      currentAssistant.tools.push(entry);
    } else if (kind === "tool_call_update") {
      const id = update.toolCallId;
      const entry = tools.get(id);
      if (entry) {
        if (update.title) entry.title = update.title;
        if (update.status) entry.status = update.status;
      }
    }
  }

  flushUser();
  flushAssistant();

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

/**
 * Save a base64 (or data-URL) image under ~/.grok-desktop/uploads.
 * Short UUID filenames avoid awkward names and are easy to pass to Grok.
 */
function saveImageUpload({ data, mimeType = "image/png", name = "image" } = {}) {
  const { buf, mimeType: mime } = parseImageData(data, mimeType);

  const uploadsDir = path.join(os.homedir(), ".grok-desktop", "uploads");
  fs.mkdirSync(uploadsDir, { recursive: true });

  const extFromMime = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/bmp": ".bmp",
  };
  let ext = extFromMime[mime] || ".png";
  // Prefer short unique names (avoid "foo.png.png" from naive concat)
  const filePath = path.join(uploadsDir, `${randomUUID()}${ext}`);
  fs.writeFileSync(filePath, buf);
  return {
    path: filePath,
    mimeType: mime,
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
    `The user attached ${paths.length} image file(s). ` +
    `They are real image files on disk — use the read_file tool on each path ` +
    `so you can see them with vision, then answer the user.\n\n` +
    `Image path(s):\n${list}\n\n` +
    `User message:\n${userText}`
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

/** Patterns that mean the agent tried to kill the Grok process itself (Windows/Unix). */
const SELF_KILL_RE =
  /taskkill\s+.*(?:\/im|\/IM)\s+grok(?:\.exe)?|Stop-Process\s+.*-Name\s+['"]?grok|killall\s+grok|pkill\s+.*grok|Get-Process\s+grok.*(?:Stop-Process|Kill)/i;

const NEW_SESSION_HINT =
  "This session may be stuck after a crash — start a New chat and continue there.";

/**
 * Locate a session directory under ~/.grok/sessions (any cwd group).
 */
function findSessionPath(sessionId) {
  if (!sessionId) return null;
  const known = findSessionById(sessionId, { limit: 500 });
  if (known?.path && fs.existsSync(known.path)) return known.path;

  const sessionsRoot = path.join(getGrokHome(), "sessions");
  if (!fs.existsSync(sessionsRoot)) return null;
  try {
    for (const group of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!group.isDirectory()) continue;
      const candidate = path.join(sessionsRoot, group.name, sessionId);
      if (fs.existsSync(candidate)) return candidate;
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
        `Grok produced no output for 45s after start while resuming this session. ` +
        `${NEW_SESSION_HINT}` +
        (hadImages
          ? " If you attached images, you can also retry without them to isolate the issue."
          : "")
      );
    }
    return (
      `Grok produced no output for 45s after start.` +
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
}) {
  const emitter = new EventEmitter();
  // Buffer early events so HTTP layer can attach listeners first
  const early = { event: [], sessionId: [], error: [], end: [], status: [] };
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

  const imageList = Array.isArray(images) ? images.filter(Boolean) : [];
  const isResume = !!(sessionId && !newSession);
  const effectivePrompt =
    imageList.length > 0 ? buildImagePrompt(prompt, imageList) : prompt || "";

  // Stale locks from a previous hard kill can leave resume wedged
  if (isResume && sessionId) {
    clearStaleSessionLocks(sessionId);
  }

  const args = [
    "-p",
    effectivePrompt,
    "-m",
    model,
    "--effort",
    effort,
    "--permission-mode",
    "bypassPermissions",
    "--output-format",
    "streaming-json",
    "--cwd",
    cwd,
  ];

  if (sessionId && !newSession) {
    args.push("--resume", sessionId);
  } else if (newSession && sessionId) {
    args.push("--session-id", sessionId);
  }

  debugLog(
    `spawn images=${imageList.length} newSession=${newSession} resume=${isResume} ` +
      `effort=${effort} cwd=${cwd} promptChars=${effectivePrompt.length} ` +
      `imgPaths=${imageList.map((i) => (typeof i === "string" ? i : i.path)).join("|")}`
  );

  let child;
  try {
    child = spawn(GROK_BIN, args, {
      cwd,
      env: { ...process.env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    debugLog(`spawn threw: ${err.message || err}`);
    process.nextTick(() => {
      emitBuffered("error", err);
      emitBuffered("end", { ok: false, error: String(err) });
    });
    return emitter;
  }

  debugLog(`spawned pid=${child.pid}`);
  emitBuffered("status", {
    message: imageList.length
      ? "Grok process started — opening image…"
      : "Grok process started…",
    pid: child.pid,
  });

  let resolvedSessionId = sessionId || null;
  let buffer = "";
  let stderr = "";
  let killed = false;
  let killedByWatchdog = false;
  let gotStdout = false;
  let firstEventAt = null;
  let sawToolsLive = false;
  let emittedError = false;

  // Watchdog: if Grok produces no stdout, surface that instead of silent hang
  const watchdog = setTimeout(() => {
    if (!gotStdout && !killed) {
      debugLog(`watchdog: no stdout after 20s pid=${child.pid}`);
      emitBuffered("status", {
        message: isResume
          ? "Still waiting for Grok to resume this session…"
          : "Still waiting for Grok output… (this is taking longer than usual)",
      });
    }
  }, 20000);

  const watchdogFail = setTimeout(() => {
    if (!gotStdout && !killed) {
      debugLog(`watchdog fail: killing pid=${child.pid} resume=${isResume}`);
      killedByWatchdog = true;
      const msg = buildExitErrorMessage({
        code: null,
        stderr: "",
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
    }
  }, 45000);

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    if (!gotStdout) {
      gotStdout = true;
      firstEventAt = Date.now();
      debugLog(`first stdout bytes=${chunk.length} pid=${child.pid}`);
      emitBuffered("status", { message: "Grok is running…" });
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
      if (evt.type === "available_commands") {
        emitBuffered("status", { message: "Grok is running…" });
      } else if (evt.type === "thought") {
        emitBuffered("status", { message: "Thinking…" });
      } else if (evt.type === "tool_call" || evt.type === "tool_call_update") {
        sawToolsLive = true;
        // Live stream may include command text; flag self-kill ASAP for messaging
        const blob = JSON.stringify(evt);
        if (SELF_KILL_RE.test(blob)) {
          debugLog(
            `detected self-kill pattern in live tool event session=${resolvedSessionId}`
          );
        }
        emitBuffered("status", {
          message: evt.title || evt.toolName || "Using tools…",
        });
      } else if (evt.type === "text") {
        emitBuffered("status", { message: "Writing…" });
      }
      emitBuffered("event", evt);
      if (resolvedSessionId) emitBuffered("sessionId", resolvedSessionId);
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  child.on("error", (err) => {
    debugLog(`child error: ${err.message || err}`);
    emitBuffered("error", err);
  });

  child.on("close", (code) => {
    clearTimeout(watchdog);
    clearTimeout(watchdogFail);
    debugLog(
      `close code=${code} gotStdout=${gotStdout} session=${resolvedSessionId} ` +
        `stderrLen=${stderr.length} firstEventMs=${firstEventAt || "-"} ` +
        `sawTools=${sawToolsLive} watchdog=${killedByWatchdog} killed=${killed}`
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

    // User/app cancel: don't double-error (watchdog already emitted)
    const abnormal = code !== 0 && !killed;
    if (abnormal && !emittedError) {
      const msg = buildExitErrorMessage({
        code,
        stderr,
        gotStdout,
        sawToolsLive,
        isResume,
        hadImages: imageList.length > 0,
        killedByWatchdog: false,
        sessionId: resolvedSessionId || sessionId,
      });
      emitBuffered("error", new Error(msg));
    }

    emitBuffered("end", {
      ok: code === 0 && !killedByWatchdog,
      code,
      sessionId: resolvedSessionId,
      stderr: stderr.slice(-4000),
      poisonedHint: abnormal || killedByWatchdog,
    });
  });

  emitter.kill = () => {
    killed = true;
    clearTimeout(watchdog);
    clearTimeout(watchdogFail);
    if (!child || !child.pid) return;
    debugLog(`kill pid=${child.pid}`);
    try {
      if (process.platform === "win32") {
        // Kill the whole tree — child.kill() often leaves grok.exe running on Windows
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
      } else {
        child.kill("SIGTERM");
      }
    } catch {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
  };

  return emitter;
}

function createSessionId() {
  return randomUUID();
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
  return listSessions({ limit }).find((s) => s.id === sessionId) || null;
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

/**
 * Permanently remove a session (CLI delete + FS cleanup fallback).
 */
async function deleteSession(sessionId) {
  const session = findSessionById(sessionId);
  if (!session) {
    const err = new Error("Session not found");
    err.code = "NOT_FOUND";
    throw err;
  }

  let cliError = null;
  try {
    await execFileAsync(GROK_BIN, ["sessions", "delete", sessionId]);
  } catch (err) {
    cliError = err;
  }

  if (session.path && fs.existsSync(session.path)) {
    try {
      fs.rmSync(session.path, { recursive: true, force: true });
    } catch (fsErr) {
      if (cliError) {
        const err = new Error(
          cliError.stderr?.toString?.().trim() ||
            cliError.message ||
            fsErr.message ||
            "Failed to delete session"
        );
        err.code = "DELETE_FAILED";
        throw err;
      }
      throw fsErr;
    }
  }

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
  for (const id of list) {
    try {
      if (action === "delete") {
        await deleteSession(id);
      } else {
        await archiveSession(id);
      }
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
  getLoginStatus,
  listSessions,
  listSessionsCli,
  findSessionById,
  findSessionPath,
  clearStaleSessionLocks,
  inspectSessionExitHints,
  buildExitErrorMessage,
  deleteSession,
  archiveSession,
  bulkSessionAction,
  loadSessionMessages,
  loadModels,
  runPrompt,
  saveImageUpload,
  createSessionId,
  getStatus,
};
