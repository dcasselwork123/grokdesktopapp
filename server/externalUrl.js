"use strict";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

function parseAbsoluteUrl(href) {
  if (typeof href !== "string") return null;
  const trimmed = href.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed);
  } catch {
    return null;
  }
}

/** True only for absolute http: and https: URLs. */
function isSafeExternalUrl(href) {
  const parsed = parseAbsoluteUrl(href);
  if (!parsed) return false;
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

/** True if URL is http://127.0.0.1:<port>/... or http://localhost:<port>/... */
function isApiOrigin(href, { port, host = "127.0.0.1" } = {}) {
  if (port == null || port === "") return false;
  const parsed = parseAbsoluteUrl(href);
  if (!parsed) return false;
  if (parsed.protocol !== "http:") return false;

  const hostname = String(parsed.hostname || "").toLowerCase();
  const allowed = new Set(LOOPBACK_HOSTS);
  const extra = String(host || "").trim().toLowerCase();
  if (LOOPBACK_HOSTS.has(extra)) allowed.add(extra);
  if (!allowed.has(hostname)) return false;

  const actualPort = parsed.port || (parsed.protocol === "http:" ? "80" : "");
  return actualPort === String(port);
}

module.exports = { isSafeExternalUrl, isApiOrigin };
