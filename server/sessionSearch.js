"use strict";

const fs = require("fs");
const path = require("path");

const MAX_QUERY = 200;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_LINE = 256 * 1024;
const SNIPPET_RADIUS = 48;
const CHAT_MARKERS = [
  "user_message_chunk",
  "agent_message_chunk",
  '"type":"user"',
  '"type": "user"',
  '"type":"assistant"',
  '"type": "assistant"',
];

function normalizeSearchQuery(q) {
  return String(q || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_QUERY);
}

function includesInsensitive(hay, needle) {
  if (!hay || !needle) return false;
  return String(hay).toLowerCase().includes(String(needle).toLowerCase());
}

function projectName(cwd) {
  if (!cwd) return "unknown";
  const normalized = String(cwd).replace(/[\\/]+$/, "");
  const base = path.basename(normalized);
  return base || normalized;
}

function sessionMetaMatches(session, query) {
  const q = normalizeSearchQuery(query);
  if (!q || !session) return false;
  return (
    includesInsensitive(session.title, q) ||
    includesInsensitive(session.project, q) ||
    includesInsensitive(session.cwd, q)
  );
}

function snippetAround(text, query) {
  const raw = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) return "";
  const q = normalizeSearchQuery(query);
  if (!q) return raw.length > 90 ? `${raw.slice(0, 89)}…` : raw;
  const i = raw.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return raw.length > 90 ? `${raw.slice(0, 89)}…` : raw;
  const start = Math.max(0, i - SNIPPET_RADIUS);
  const end = Math.min(raw.length, i + q.length + SNIPPET_RADIUS);
  let s = raw.slice(start, end).trim();
  if (start > 0) s = `…${s}`;
  if (end < raw.length) s += "…";
  return s;
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

function extractUserFacingText(text) {
  const m = String(text).match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  if (m) return m[1].trim();
  return String(text).trim();
}

function extractSearchableChat(evt) {
  const update = unwrapUpdate(evt);
  if (update) {
    const kind = update.sessionUpdate;
    if (kind === "user_message_chunk") {
      return { role: "user", text: chunkText(update.content) };
    }
    if (kind === "agent_message_chunk") {
      return { role: "assistant", text: chunkText(update.content) };
    }
    return null;
  }
  if (evt && evt.type === "user") {
    const raw = chunkText(evt.content);
    if (!raw.trim()) return null;
    return { role: "user", text: extractUserFacingText(raw) };
  }
  if (evt && evt.type === "assistant") {
    const text = chunkText(evt.content);
    if (!text) return null;
    return { role: "assistant", text };
  }
  return null;
}

function lineLooksLikeChat(line) {
  if (!line) return false;
  const probe = line.length > 4096 ? line.slice(0, 4096) : line;
  for (const m of CHAT_MARKERS) {
    if (probe.includes(m)) return true;
  }
  return false;
}

function scanFileForChatHit(filePath, query) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return null;
  }

  const qLower = query.toLowerCase();
  const buf = Buffer.alloc(64 * 1024);
  let leftover = "";
  let skippingLine = false;
  let bytes = 0;
  let currentRole = null;
  let currentText = "";
  let messageIndex = 0;

  function consider() {
    if (currentText && currentText.toLowerCase().includes(qLower)) {
      return { snippet: snippetAround(currentText, query), messageIndex };
    }
    return null;
  }

  function handleLine(line) {
    if (!lineLooksLikeChat(line)) return null;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return null;
    }
    const extracted = extractSearchableChat(obj);
    if (!extracted || !extracted.text) return null;
    if (extracted.role !== currentRole) {
      const prev = consider();
      if (prev) return prev;
      if (currentRole) messageIndex += 1;
      currentRole = extracted.role;
      currentText = extracted.text;
    } else {
      currentText += extracted.text;
    }
    return consider();
  }

  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      bytes += n;
      if (bytes > MAX_FILE_BYTES) break;
      let chunk = buf.toString("utf8", 0, n);
      if (skippingLine) {
        const nl = chunk.indexOf("\n");
        if (nl < 0) continue;
        skippingLine = false;
        leftover = "";
        chunk = chunk.slice(nl + 1);
      }
      leftover += chunk;
      let idx;
      while ((idx = leftover.indexOf("\n")) >= 0) {
        const line = leftover.slice(0, idx);
        leftover = leftover.slice(idx + 1);
        const hit = handleLine(line);
        if (hit) return hit;
      }
      if (leftover.length > MAX_LINE) {
        skippingLine = true;
        leftover = "";
      }
    }
    if (!skippingLine && leftover) {
      const hit = handleLine(leftover);
      if (hit) return hit;
    }
    return consider();
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

function sessionTranscriptIsSmall(sessionPath) {
  if (!sessionPath) return false;
  for (const name of ["updates.jsonl", "chat_history.jsonl"]) {
    try {
      const st = fs.statSync(path.join(sessionPath, name));
      if (st.isFile() && st.size > 512 * 1024) return false;
    } catch {
      /* missing */
    }
  }
  return true;
}

function findTranscriptHit(sessionPath, query) {
  const q = normalizeSearchQuery(query);
  if (!q || !sessionPath) return null;
  const files = [
    path.join(sessionPath, "updates.jsonl"),
    path.join(sessionPath, "chat_history.jsonl"),
  ];
  for (const fp of files) {
    const hit = scanFileForChatHit(fp, q);
    if (hit) return hit;
  }
  return null;
}

function publicSessionHit(session, extra = {}) {
  return {
    id: session.id,
    title: session.title || "",
    project: session.project || "",
    cwd: session.cwd || "",
    updatedAt: session.updatedAt || null,
    createdAt: session.createdAt || null,
    model: session.model || null,
    effort: session.effort || null,
    numMessages: session.numMessages || 0,
    match: extra.match || "meta",
    snippet: extra.snippet || null,
  };
}

function escapeLike(s) {
  return String(s).replace(/([#%_])/g, "#$1");
}

function querySessionIndex(dbPath, query, limit) {
  if (!dbPath) return null;
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    return null;
  }
  try {
    if (!fs.existsSync(dbPath)) return null;
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const like = `%${escapeLike(query.toLowerCase())}%`;
      const hits = db
        .prepare(
          `SELECT session_id, cwd, title, content
           FROM session_docs
           WHERE LOWER(title) LIKE ? ESCAPE '#'
              OR LOWER(content) LIKE ? ESCAPE '#'
              OR LOWER(cwd) LIKE ? ESCAPE '#'
           LIMIT ?`
        )
        .all(like, like, like, Math.max(1, Number(limit) || 50));
      const ids = db.prepare("SELECT session_id FROM session_docs").all().map((r) => r.session_id);
      return { hits, ids };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function sessionFromIndexRow(row) {
  return {
    id: row.session_id,
    title: row.title || "",
    cwd: row.cwd || "",
    project: projectName(row.cwd),
    updatedAt: null,
    createdAt: null,
    model: null,
    effort: null,
    numMessages: 0,
  };
}

function searchSessions(query, { sessions = [], limit = 50, dbPath, shouldAbort } = {}) {
  const q = normalizeSearchQuery(query);
  if (!q) return [];
  const cap = Math.max(1, Number(limit) || 50);
  const hits = [];
  const seen = new Set();
  const byId = new Map();

  for (const s of sessions) {
    if (s && s.id) byId.set(s.id, s);
  }

  for (const s of sessions) {
    if (shouldAbort && shouldAbort()) return hits;
    if (!s || !s.id || seen.has(s.id)) continue;
    if (!sessionMetaMatches(s, q)) continue;
    seen.add(s.id);
    hits.push(
      publicSessionHit(s, {
        match: "meta",
        snippet: snippetAround(s.title || s.project || "", q),
      })
    );
    if (hits.length >= cap) return hits;
  }

  const indexed = querySessionIndex(dbPath, q, cap);
  if (indexed) {
    for (const row of indexed.hits || []) {
      if (shouldAbort && shouldAbort()) return hits;
      if (!row || !row.session_id || seen.has(row.session_id)) continue;
      const s = byId.get(row.session_id) || sessionFromIndexRow(row);
      seen.add(s.id);
      hits.push(
        publicSessionHit(s, {
          match: "transcript",
          snippet: snippetAround(row.content || row.title || "", q),
        })
      );
      if (hits.length >= cap) return hits;
    }
    const indexedIds = new Set(indexed.ids || []);
    for (const s of sessions) {
      if (shouldAbort && shouldAbort()) return hits;
      if (!s || !s.id || seen.has(s.id)) continue;
      if (indexedIds.has(s.id)) continue;
      if (!sessionTranscriptIsSmall(s.path)) continue;
      const hit = findTranscriptHit(s.path, q);
      if (!hit) continue;
      seen.add(s.id);
      hits.push(
        publicSessionHit(s, {
          match: "transcript",
          snippet: hit.snippet,
        })
      );
      if (hits.length >= cap) break;
    }
    return hits;
  }

  for (const s of sessions) {
    if (shouldAbort && shouldAbort()) return hits;
    if (!s || !s.id || seen.has(s.id)) continue;
    const hit = findTranscriptHit(s.path, q);
    if (!hit) continue;
    seen.add(s.id);
    hits.push(
      publicSessionHit(s, {
        match: "transcript",
        snippet: hit.snippet,
      })
    );
    if (hits.length >= cap) break;
  }

  return hits;
}

module.exports = {
  normalizeSearchQuery,
  sessionMetaMatches,
  findTranscriptHit,
  searchSessions,
};
