"use strict";

const path = require("path");

const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isSafeSessionId(id) {
  if (typeof id !== "string") return false;
  if (id.length === 0 || id.length > 128) return false;
  if (id.includes("/") || id.includes("\\") || id.includes("\0")) return false;
  if (id === "." || id === "..") return false;
  if (id.includes("..")) return false;
  return SAFE_SESSION_ID.test(id);
}

function resolveUnderSessionsRoot(sessionsRoot, ...parts) {
  if (typeof sessionsRoot !== "string" || sessionsRoot.length === 0) return null;
  if (parts.length === 0) return null;

  for (const part of parts) {
    if (typeof part !== "string" || part.length === 0) return null;
    if (part.includes("\0")) return null;
    if (path.isAbsolute(part)) return null;
    const segments = part.split(/[\\/]/);
    if (segments.length !== 1) return null;
    const seg = segments[0];
    if (seg === "." || seg === "..") return null;
  }

  const root = path.resolve(sessionsRoot);
  const resolved = path.resolve(root, ...parts);
  if (resolved === root) return null;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (!resolved.startsWith(prefix)) return null;
  return resolved;
}

module.exports = { isSafeSessionId, resolveUnderSessionsRoot };
