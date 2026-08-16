"use strict";

const fs = require("fs");
const path = require("path");

const IMAGE_TOOL_NAMES = new Set(["image_gen", "image_edit"]);
const VIDEO_TOOL_NAMES = new Set(["image_to_video", "reference_to_video"]);
const MEDIA_TOOL_NAMES = new Set([...IMAGE_TOOL_NAMES, ...VIDEO_TOOL_NAMES]);

const REL_MEDIA_RE =
  /\b((?:images|videos)[/\\][A-Za-z0-9][A-Za-z0-9._-]*\.(?:jpe?g|png|webp|gif|mp4|webm))\b/gi;
const ABS_MEDIA_RE =
  /(?:[A-Za-z]:\\|\/)[^\s"'<>]*[/\\]((?:images|videos)[/\\][A-Za-z0-9][A-Za-z0-9._-]*\.(?:jpe?g|png|webp|gif|mp4|webm))/gi;
const SAFE_REL_RE =
  /^(images|videos)\/[A-Za-z0-9][A-Za-z0-9._-]*\.(jpe?g|png|webp|gif|mp4|webm)$/i;

function normalizeRelMedia(p) {
  if (!p || typeof p !== "string") return null;
  const rel = String(p)
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "");
  if (!SAFE_REL_RE.test(rel)) return null;
  return rel;
}

function addRel(out, seen, raw) {
  const rel = normalizeRelMedia(raw);
  if (!rel) return;
  const key = rel.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  out.push(rel);
}

function extractMediaPaths(value, depth = 0) {
  const out = [];
  const seen = new Set();
  walk(value, 0);
  return out;

  function walk(v, d) {
    if (v == null || d > 8) return;
    if (typeof v === "string") {
      REL_MEDIA_RE.lastIndex = 0;
      let m;
      while ((m = REL_MEDIA_RE.exec(v))) addRel(out, seen, m[1]);
      ABS_MEDIA_RE.lastIndex = 0;
      while ((m = ABS_MEDIA_RE.exec(v))) addRel(out, seen, m[1]);
      addRel(out, seen, v);
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) walk(item, d + 1);
      return;
    }
    if (typeof v !== "object") return;
    for (const key of ["path", "file", "filename", "filepath", "filePath", "output", "saved"]) {
      if (typeof v[key] === "string") addRel(out, seen, v[key]);
    }
    for (const item of Object.values(v)) walk(item, d + 1);
  }
}

function isMediaToolName(name) {
  const key = String(name || "")
    .trim()
    .toLowerCase();
  return MEDIA_TOOL_NAMES.has(key);
}

function listSessionMedia(sessionPath) {
  if (!sessionPath || !fs.existsSync(sessionPath)) return [];
  const out = [];
  for (const folder of ["images", "videos"]) {
    const dir = path.join(sessionPath, folder);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const files = [];
    for (const name of names) {
      const rel = normalizeRelMedia(`${folder}/${name}`);
      if (!rel) continue;
      try {
        const st = fs.statSync(path.join(dir, name));
        if (!st.isFile()) continue;
        files.push({ rel, mtime: st.mtimeMs });
      } catch {
        /* skip */
      }
    }
    files.sort((a, b) => a.mtime - b.mtime || a.rel.localeCompare(b.rel));
    for (const f of files) out.push(f.rel);
  }
  return out;
}

function resolveSessionMediaFile(sessionPath, relPath) {
  const rel = normalizeRelMedia(relPath);
  if (!rel || !sessionPath) return null;
  const root = path.resolve(sessionPath);
  const resolved = path.resolve(root, rel);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (!resolved.startsWith(prefix)) return null;
  try {
    const st = fs.statSync(resolved);
    if (!st.isFile()) return null;
  } catch {
    return null;
  }
  return resolved;
}

function mediaTypeForRel(rel) {
  const ext = path.extname(String(rel || "")).toLowerCase();
  const map = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
  };
  return map[ext] || "application/octet-stream";
}

function attachMediaToMessages(sessionPath, messages) {
  const list = Array.isArray(messages) ? messages : [];
  const listed = listSessionMedia(sessionPath);
  const used = new Set();

  for (const msg of list) {
    if (!msg || msg.role !== "assistant") continue;
    const found = [];
    const seen = new Set();
    const tools = Array.isArray(msg.tools) ? msg.tools : [];
    let mediaToolCount = 0;
    for (const tool of tools) {
      if (!isMediaToolName(tool && (tool.name || tool.title))) continue;
      mediaToolCount += 1;
      for (const p of extractMediaPaths(tool)) addRel(found, seen, p);
      if (Array.isArray(tool && tool.media)) {
        for (const p of tool.media) addRel(found, seen, p);
      }
    }
    if (mediaToolCount > 0) {
      for (const p of extractMediaPaths(msg.text)) addRel(found, seen, p);
    }
    if (mediaToolCount > 0 && found.length < mediaToolCount) {
      for (const rel of listed) {
        if (found.length >= mediaToolCount) break;
        if (used.has(rel.toLowerCase())) continue;
        addRel(found, seen, rel);
      }
    }
    msg.media = found;
    for (const rel of found) used.add(rel.toLowerCase());
  }

  return list;
}

module.exports = {
  IMAGE_TOOL_NAMES,
  VIDEO_TOOL_NAMES,
  MEDIA_TOOL_NAMES,
  normalizeRelMedia,
  extractMediaPaths,
  isMediaToolName,
  listSessionMedia,
  resolveSessionMediaFile,
  mediaTypeForRel,
  attachMediaToMessages,
};
