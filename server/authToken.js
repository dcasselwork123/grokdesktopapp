"use strict";

const crypto = require("crypto");

const COOKIE_NAME = "grok_desktop_token";

function tokensEqual(presented, expected) {
  if (
    typeof presented !== "string" ||
    typeof expected !== "string" ||
    !presented ||
    !expected
  ) {
    return false;
  }
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function cookieHeader(token, { secure = false } = {}) {
  let header = `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`;
  if (secure) header += "; Secure";
  return header;
}

function parseCookies(req) {
  const header = (req && req.headers && req.headers.cookie) || "";
  const out = {};
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const k = trimmed.slice(0, eq).trim();
    const v = trimmed.slice(eq + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function nonEmptyString(value) {
  return typeof value === "string" && value ? value : null;
}

function presentedToken(req, url) {
  const query = nonEmptyString(url && url.searchParams && url.searchParams.get("token"));
  if (query) return query;

  const headers = (req && req.headers) || {};
  const header = nonEmptyString(headers["x-grok-token"]);
  if (header) return header;

  const auth = headers.authorization || "";
  const bearer = nonEmptyString(
    typeof auth === "string" ? auth.replace(/^Bearer\s+/i, "") : ""
  );
  if (bearer) return bearer;

  const cookies = parseCookies(req);
  return nonEmptyString(cookies[COOKIE_NAME]);
}

module.exports = {
  COOKIE_NAME,
  tokensEqual,
  cookieHeader,
  parseCookies,
  presentedToken,
};
