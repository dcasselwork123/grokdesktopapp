"use strict";

const fs = require("fs");
const path = require("path");

const LARGE_FILE_BYTES = 20 * 1024 * 1024;
const PEEK_BYTES = 64 * 1024;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function looksLikeSessionDir(name, dirPath) {
  if (name && UUID_RE.test(name)) return true;
  if (!dirPath) return false;
  try {
    if (fs.existsSync(path.join(dirPath, "updates.jsonl"))) return true;
    if (fs.existsSync(path.join(dirPath, "chat_history.jsonl"))) return true;
  } catch {
    /* ignore */
  }
  return false;
}

function decodeCwdDirName(name) {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

function projectName(cwd) {
  if (!cwd) return "unknown";
  const normalized = String(cwd).replace(/[\\/]+$/, "");
  const base = path.basename(normalized);
  return base || normalized;
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function hasUnclosedString(text) {
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!inStr) {
      if (c === '"') inStr = true;
      continue;
    }
    if (esc) {
      esc = false;
      continue;
    }
    if (c === "\\") {
      esc = true;
      continue;
    }
    if (c === '"') inStr = false;
  }
  return inStr;
}

function unescapeJsonString(s) {
  try {
    return JSON.parse(`"${s}"`);
  } catch {
    return s.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"');
  }
}

function salvageExtractUpdate(text) {
  const kindM = text.match(/"sessionUpdate"\s*:\s*"([a-z_]+)"/);
  if (!kindM) return null;
  const kind = kindM[1];
  if (kind !== "user_message_chunk" && kind !== "agent_message_chunk") {
    return null;
  }
  const textM = text.match(/"text"\s*:\s*"((?:\\.|[^"\\])*)/);
  if (!textM) return null;
  return {
    method: "session/update",
    params: {
      update: {
        sessionUpdate: kind,
        content: { type: "text", text: unescapeJsonString(textM[1]) },
      },
    },
  };
}

/**
 * Complete a truncated last JSONL line when it is almost-JSON.
 * Middle-of-file garbage is not salvaged.
 */
function salvageAlmostJson(text) {
  if (!text || text[0] !== "{") return null;
  let s = text;
  if (hasUnclosedString(s)) s += '"';

  const stack = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (c === "\\") {
        esc = true;
        continue;
      }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === "{") stack.push("}");
    else if (c === "[") stack.push("]");
    else if (c === "}" || c === "]") stack.pop();
  }
  if (inStr) s += '"';
  while (stack.length) s += stack.pop();

  try {
    return JSON.parse(s);
  } catch {
    return salvageExtractUpdate(text);
  }
}

function parseJsonLine(line, { salvage = false } = {}) {
  const trimmed = String(line || "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return salvage ? salvageAlmostJson(trimmed) : null;
  }
}

function* readLinesSync(filePath) {
  const fd = fs.openSync(filePath, "r");
  const bufSize = 64 * 1024;
  const buf = Buffer.alloc(bufSize);
  let leftover = "";
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, bufSize, null)) > 0) {
      leftover += buf.toString("utf8", 0, n);
      let idx;
      while ((idx = leftover.indexOf("\n")) >= 0) {
        yield leftover.slice(0, idx);
        leftover = leftover.slice(idx + 1);
      }
    }
    if (leftover) yield leftover;
  } finally {
    fs.closeSync(fd);
  }
}

function forEachJsonlLine(text, onObj) {
  if (!text) return;
  const lines = String(text).split(/\r?\n/);
  while (lines.length && !String(lines[lines.length - 1]).trim()) lines.pop();
  for (let i = 0; i < lines.length; i++) {
    const obj = parseJsonLine(lines[i], { salvage: i === lines.length - 1 });
    if (obj) onObj(obj);
  }
}

function forEachJsonlFile(filePath, onObj, largeFileBytes = LARGE_FILE_BYTES) {
  const st = fs.statSync(filePath);
  if (st.size <= largeFileBytes) {
    forEachJsonlLine(fs.readFileSync(filePath, "utf8"), onObj);
    return;
  }
  let pending = null;
  for (const line of readLinesSync(filePath)) {
    if (!String(line).trim()) continue;
    if (pending !== null) {
      const obj = parseJsonLine(pending, { salvage: false });
      if (obj) onObj(obj);
    }
    pending = line;
  }
  if (pending !== null) {
    const obj = parseJsonLine(pending, { salvage: true });
    if (obj) onObj(obj);
  }
}

function unwrapUpdate(evt) {
  if (!evt || typeof evt !== "object") return null;
  if (evt.params && evt.params.update) return evt.params.update;
  if (evt.update) return evt.update;
  if (evt.sessionUpdate) return evt;
  return null;
}

function chunkText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(chunkText).join("");
  if (typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (content.content) return chunkText(content.content);
  }
  return "";
}

function toolNameFromUpdate(update) {
  return (
    (update._meta && update._meta["x.ai/tool"] && update._meta["x.ai/tool"].name) ||
    update.title ||
    "tool"
  );
}

function createUpdatesAccumulator() {
  const messages = [];
  let currentUser = null;
  let currentAssistant = null;
  const tools = new Map();

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

  function ensureAssistant(ts) {
    if (!currentAssistant) currentAssistant = { text: "", tools: [], ts };
  }

  function apply(evt) {
    const update = unwrapUpdate(evt);
    if (!update) return;
    const kind = update.sessionUpdate;
    if (!kind || kind === "turn_completed") {
      if (kind === "turn_completed") {
        flushUser();
        flushAssistant();
      }
      return;
    }
    const ts = evt.timestamp != null ? evt.timestamp : null;

    if (kind === "user_message_chunk") {
      flushAssistant();
      const chunk = chunkText(update.content);
      if (!currentUser) currentUser = { text: "", ts };
      currentUser.text += chunk;
    } else if (kind === "agent_message_chunk") {
      flushUser();
      const chunk = chunkText(update.content);
      ensureAssistant(ts);
      currentAssistant.text += chunk;
    } else if (kind === "agent_thought_chunk") {
      flushUser();
      ensureAssistant(ts);
    } else if (kind === "tool_call") {
      flushUser();
      ensureAssistant(ts);
      const id = update.toolCallId;
      const name = toolNameFromUpdate(update);
      const entry = {
        id,
        title: update.title || name,
        status: update.status || "pending",
        name,
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

  function finish() {
    flushUser();
    flushAssistant();
    return messages;
  }

  return { apply, finish };
}

function parseUpdatesJsonl(text) {
  const acc = createUpdatesAccumulator();
  forEachJsonlLine(text, (evt) => acc.apply(evt));
  return acc.finish();
}

function extractContentText(content) {
  return chunkText(content).trim();
}

function extractUserFacingText(text) {
  const m = String(text).match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  if (m) return m[1].trim();
  return String(text).trim();
}

function isIgnorableUser(evt, text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return true;
  const hasQuery = /<user_query>/i.test(trimmed);
  if (evt && evt.synthetic_reason && !hasQuery) return true;
  if (/^<user_info>/i.test(trimmed) && !hasQuery) return true;
  if (/^<system-reminder>/i.test(trimmed) && !hasQuery) return true;
  return false;
}

function normalizeToolCall(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name =
    raw.name ||
    (raw.function && raw.function.name) ||
    raw.title ||
    "tool";
  return {
    id: raw.id || raw.tool_call_id || null,
    title: raw.title || name,
    status: raw.status || "pending",
    name,
  };
}

function createChatHistoryAccumulator() {
  const messages = [];
  let currentAssistant = null;
  const tools = new Map();

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

  function ensureAssistant(ts) {
    if (!currentAssistant) currentAssistant = { text: "", tools: [], ts };
  }

  function apply(evt) {
    if (!evt || typeof evt !== "object") return;
    const type = evt.type;
    if (!type || type === "system" || type === "reasoning") return;
    const ts = evt.timestamp != null ? evt.timestamp : null;

    if (type === "user") {
      const raw = extractContentText(evt.content);
      if (isIgnorableUser(evt, raw)) return;
      const text = extractUserFacingText(raw);
      if (!text) return;
      flushAssistant();
      messages.push({ role: "user", text, ts });
      return;
    }

    if (type === "assistant") {
      ensureAssistant(ts);
      const text = extractContentText(evt.content);
      if (text) {
        if (currentAssistant.text) currentAssistant.text += "\n";
        currentAssistant.text += text;
      }
      const calls = Array.isArray(evt.tool_calls) ? evt.tool_calls : [];
      for (const raw of calls) {
        const entry = normalizeToolCall(raw);
        if (!entry) continue;
        if (entry.id) tools.set(entry.id, entry);
        currentAssistant.tools.push(entry);
      }
      return;
    }

    if (type === "tool_result" || type === "tool") {
      const id = evt.tool_call_id || evt.toolCallId;
      const entry = id ? tools.get(id) : null;
      if (entry) {
        entry.status = evt.status || "completed";
        if (evt.title) entry.title = evt.title;
      }
    }
  }

  function finish() {
    flushAssistant();
    return messages;
  }

  return { apply, finish };
}

function parseChatHistoryJsonl(text) {
  const acc = createChatHistoryAccumulator();
  forEachJsonlLine(text, (evt) => acc.apply(evt));
  return acc.finish();
}

function hasChatText(messages) {
  return (messages || []).some(
    (m) =>
      (m.role === "user" || m.role === "assistant") &&
      ((m.text && String(m.text).trim()) || (m.tools && m.tools.length))
  );
}

function parseUpdatesFile(filePath, largeFileBytes) {
  const acc = createUpdatesAccumulator();
  forEachJsonlFile(filePath, (evt) => acc.apply(evt), largeFileBytes);
  return acc.finish();
}

function parseChatHistoryFile(filePath, largeFileBytes) {
  const acc = createChatHistoryAccumulator();
  forEachJsonlFile(filePath, (evt) => acc.apply(evt), largeFileBytes);
  return acc.finish();
}

function loadTranscript(sessionPath, { largeFileBytes = LARGE_FILE_BYTES } = {}) {
  if (!sessionPath) return { messages: [], source: null };
  const updatesPath = path.join(sessionPath, "updates.jsonl");
  const historyPath = path.join(sessionPath, "chat_history.jsonl");

  if (fs.existsSync(updatesPath)) {
    try {
      const messages = parseUpdatesFile(updatesPath, largeFileBytes);
      if (hasChatText(messages)) return { messages, source: "updates" };
    } catch {
      /* fall through to chat_history */
    }
  }

  if (fs.existsSync(historyPath)) {
    try {
      const messages = parseChatHistoryFile(historyPath, largeFileBytes);
      return { messages, source: "chat_history" };
    } catch {
      return { messages: [], source: null };
    }
  }

  return { messages: [], source: null };
}

function firstLineTitle(text) {
  const line = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!line) return null;
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

function peekFirstUserTitle(sessionPath) {
  const files = [
    ["updates.jsonl", parseUpdatesJsonl],
    ["chat_history.jsonl", parseChatHistoryJsonl],
  ];
  for (const [name, parse] of files) {
    const fp = path.join(sessionPath, name);
    if (!fs.existsSync(fp)) continue;
    let text = "";
    try {
      const st = fs.statSync(fp);
      const n = Math.min(st.size, PEEK_BYTES);
      const fd = fs.openSync(fp, "r");
      try {
        const buf = Buffer.alloc(n);
        fs.readSync(fd, buf, 0, n, 0);
        text = buf.toString("utf8");
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      continue;
    }
    const messages = parse(text);
    const user = messages.find((m) => m.role === "user" && m.text && m.text.trim());
    if (user) {
      const title = firstLineTitle(user.text);
      if (title) return title;
    }
  }
  return null;
}

function resolveGroupCwd(sessionPath, groupCwd) {
  if (groupCwd) return groupCwd;
  const parent = path.dirname(sessionPath);
  const cwdFile = path.join(parent, ".cwd");
  try {
    if (fs.existsSync(cwdFile)) {
      const raw = fs.readFileSync(cwdFile, "utf8").trim();
      if (raw) return raw;
    }
  } catch {
    /* ignore */
  }
  return decodeCwdDirName(path.basename(parent));
}

function isoFromStat(st, which) {
  try {
    const d = which === "birth" ? st.birthtime || st.ctime : st.mtime;
    if (d && typeof d.toISOString === "function") return d.toISOString();
  } catch {
    /* ignore */
  }
  return null;
}

function synthesizeSessionMeta(sessionPath, groupCwd) {
  const idFromDir = path.basename(sessionPath);
  const summary = safeReadJson(path.join(sessionPath, "summary.json"));
  let st = null;
  try {
    st = fs.statSync(sessionPath);
  } catch {
    st = null;
  }

  const cwd =
    (summary && summary.info && summary.info.cwd) ||
    resolveGroupCwd(sessionPath, groupCwd);
  const createdFromFs = st ? isoFromStat(st, "birth") : null;
  const updatedFromFs = st ? isoFromStat(st, "mtime") : null;

  let title =
    (summary &&
      (summary.manual_title ||
        summary.generated_title ||
        summary.session_summary)) ||
    null;
  if (!title || title === "Untitled session") {
    title = peekFirstUserTitle(sessionPath) || title || idFromDir;
  }

  return {
    id: (summary && summary.info && summary.info.id) || idFromDir,
    title,
    cwd,
    project: projectName(cwd),
    createdAt: (summary && summary.created_at) || createdFromFs,
    updatedAt:
      (summary &&
        (summary.last_active_at || summary.updated_at || summary.created_at)) ||
      updatedFromFs,
    model: (summary && summary.current_model_id) || null,
    effort: (summary && summary.reasoning_effort) || null,
    numMessages:
      (summary &&
        (summary.num_chat_messages ?? summary.num_messages)) ??
      0,
    path: sessionPath,
  };
}

module.exports = {
  parseUpdatesJsonl,
  parseChatHistoryJsonl,
  loadTranscript,
  synthesizeSessionMeta,
  looksLikeSessionDir,
  LARGE_FILE_BYTES,
};
