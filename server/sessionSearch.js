"use strict";

const fs = require("fs");
const path = require("path");
const { loadTranscript } = require("./sessionTranscript");

const MAX_QUERY = 200;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const SNIPPET_RADIUS = 48;

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

function fileMightContain(filePath, query) {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size === 0) return false;
    const n = Math.min(st.size, MAX_FILE_BYTES);
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, 0);
      return includesInsensitive(buf.toString("utf8"), query);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function findTranscriptHit(sessionPath, query) {
  const q = normalizeSearchQuery(query);
  if (!q || !sessionPath) return null;
  const files = [
    path.join(sessionPath, "updates.jsonl"),
    path.join(sessionPath, "chat_history.jsonl"),
  ];
  if (!files.some((fp) => fileMightContain(fp, q))) return null;
  let messages;
  try {
    messages = loadTranscript(sessionPath, { largeFileBytes: MAX_FILE_BYTES }).messages || [];
  } catch {
    return null;
  }
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    const text = m.text || "";
    if (!includesInsensitive(text, q)) continue;
    return { snippet: snippetAround(text, q), messageIndex: i };
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

function searchSessions(query, { sessions = [], limit = 50 } = {}) {
  const q = normalizeSearchQuery(query);
  if (!q) return [];
  const cap = Math.max(1, Number(limit) || 50);
  const hits = [];
  const seen = new Set();

  for (const s of sessions) {
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

  for (const s of sessions) {
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
