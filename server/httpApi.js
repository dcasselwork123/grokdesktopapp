"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const {
  listSessions,
  loadSessionMessages,
  loadModels,
  runPrompt,
  saveImageUpload,
  createSessionId,
  getStatus,
  getSetupStatus,
  startGrokLogin,
  cancelGrokLogin,
  getLoginStatus,
  bulkSessionAction,
} = require("./grokService");
const { buildRemoteInfo } = require("./remoteAccess");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

const COOKIE_NAME = "grok_desktop_token";

function sendJson(res, status, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    ...extraHeaders,
  });
  res.end(data);
}

function readBody(req, { maxBytes = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
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

function cookieHeader(token) {
  // Not HttpOnly so the SPA can also read it if needed; Path=/ covers CSS/JS.
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; SameSite=Lax; Max-Age=31536000`;
}

function serveStatic(res, filePath, extraHeaders = {}) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain", ...extraHeaders });
    res.end("Not found");
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Cache-Control": "no-cache",
    ...extraHeaders,
  });
  fs.createReadStream(filePath).pipe(res);
}

function isLoopback(req) {
  const ra = req.socket?.remoteAddress || "";
  return (
    ra === "127.0.0.1" ||
    ra === "::1" ||
    ra === "::ffff:127.0.0.1" ||
    ra.endsWith("127.0.0.1")
  );
}

function wantsHtml(req, pathname) {
  const accept = req.headers.accept || "";
  if (pathname === "/" || pathname.endsWith(".html")) return true;
  return accept.includes("text/html");
}

function gatePageHtml() {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
<title>Grok Desktop — link needed</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#1a1a1a;color:#e8e8e8;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    padding:24px;line-height:1.5}
  .card{max-width:420px;background:#222;border:1px solid #333;border-radius:16px;padding:22px}
  h1{font-size:18px;margin:0 0 10px}
  p{margin:0 0 10px;color:#aaa;font-size:14px}
  code{color:#d97757;word-break:break-all}
</style></head><body>
<div class="card">
  <h1>Open the full phone URL</h1>
  <p>This address is missing the access token, so CSS/API calls are blocked.</p>
  <p>On your PC, open <strong>Grok Desktop</strong> → tap <strong>📱</strong> → <strong>Copy phone URL</strong>, then paste that full link here (it includes <code>?token=…</code>).</p>
</div>
</body></html>`;
}

function createServer({ port = 3847, host = "127.0.0.1", staticDir, token = null }) {
  const activeRuns = new Map();
  let boundPort = port;
  let boundHost = host;

  const server = http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Grok-Token",
        "Access-Control-Allow-Credentials": "true",
      });
      res.end();
      return;
    }

    const parsed = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = parsed.pathname || "/";
    const cookies = parseCookies(req);
    const queryToken = parsed.searchParams.get("token");
    const headerToken =
      req.headers["x-grok-token"] ||
      (req.headers.authorization || "").replace(/^Bearer\s+/i, "") ||
      "";
    const presented =
      queryToken || headerToken || cookies[COOKIE_NAME] || null;

    const extraHeaders = {};
    // If they brought a valid token in the URL/header, mint a cookie so /styles.css & /app.js work.
    if (token && presented === token && queryToken === token) {
      extraHeaders["Set-Cookie"] = cookieHeader(token);
    }

    const authorized =
      !token || isLoopback(req) || presented === token;

    if (!authorized) {
      if (wantsHtml(req, pathname) && req.method === "GET") {
        res.writeHead(401, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(gatePageHtml());
        return;
      }
      sendJson(res, 401, {
        error:
          "Unauthorized. Open the phone URL from the desktop app (📱) — it includes your token.",
      });
      return;
    }

    try {
      if (pathname === "/api/health" && req.method === "GET") {
        sendJson(
          res,
          200,
          {
            ok: true,
            ...getStatus(),
            remote: buildRemoteInfo({ port: boundPort, token, host: boundHost }),
          },
          extraHeaders
        );
        return;
      }

      // CLI install + auth readiness (used by the setup gate on first load)
      if (pathname === "/api/setup" && req.method === "GET") {
        sendJson(res, 200, getSetupStatus(), extraHeaders);
        return;
      }

      // Trigger `grok login --oauth` (browser OAuth on this machine)
      if (pathname === "/api/auth/login" && req.method === "POST") {
        let body = {};
        try {
          body = await readBody(req);
        } catch {
          body = {};
        }
        try {
          const result = startGrokLogin({
            oauth: body.oauth !== false,
          });
          sendJson(res, 200, result, extraHeaders);
        } catch (err) {
          const status =
            err.code === "NOT_INSTALLED"
              ? 400
              : err.code === "SPAWN_FAILED"
                ? 500
                : 500;
          sendJson(
            res,
            status,
            { error: err.message || String(err), code: err.code || null },
            extraHeaders
          );
        }
        return;
      }

      if (pathname === "/api/auth/login" && req.method === "GET") {
        sendJson(res, 200, getLoginStatus(), extraHeaders);
        return;
      }

      if (pathname === "/api/auth/login/cancel" && req.method === "POST") {
        sendJson(res, 200, cancelGrokLogin(), extraHeaders);
        return;
      }

      if (pathname === "/api/remote" && req.method === "GET") {
        sendJson(
          res,
          200,
          buildRemoteInfo({ port: boundPort, token, host: boundHost }),
          extraHeaders
        );
        return;
      }

      if (pathname === "/api/sessions" && req.method === "GET") {
        const limit = Number(parsed.searchParams.get("limit")) || 100;
        // Don't leak absolute filesystem paths to the client
        const sessions = listSessions({ limit }).map(({ path: _p, ...rest }) => rest);
        sendJson(res, 200, { sessions }, extraHeaders);
        return;
      }

      if (pathname === "/api/sessions/bulk" && req.method === "POST") {
        let body;
        try {
          body = await readBody(req);
        } catch (err) {
          sendJson(res, 400, { error: err.message || "Invalid JSON body" }, extraHeaders);
          return;
        }
        try {
          const result = await bulkSessionAction(body.action, body.ids);
          sendJson(res, 200, result, extraHeaders);
        } catch (err) {
          const status = err.code === "BAD_REQUEST" ? 400 : 500;
          sendJson(res, status, { error: err.message || String(err) }, extraHeaders);
        }
        return;
      }

      if (pathname === "/api/models" && req.method === "GET") {
        sendJson(res, 200, { models: loadModels() }, extraHeaders);
        return;
      }

      if (pathname.startsWith("/api/sessions/") && req.method === "GET") {
        const id = decodeURIComponent(pathname.slice("/api/sessions/".length));
        if (!id || id.includes("/") || id === "bulk") {
          sendJson(res, 400, { error: "Invalid session id" }, extraHeaders);
          return;
        }
        const data = loadSessionMessages(id);
        if (!data.session) {
          sendJson(res, 404, { error: "Session not found" }, extraHeaders);
          return;
        }
        const session = data.session
          ? (({ path: _p, ...rest }) => rest)(data.session)
          : null;
        sendJson(res, 200, { session, messages: data.messages }, extraHeaders);
        return;
      }

      if (pathname === "/api/chat" && req.method === "POST") {
        let body;
        try {
          // Images arrive as base64; allow larger payloads than plain chat.
          body = await readBody(req, { maxBytes: 32 * 1024 * 1024 });
        } catch (err) {
          sendJson(
            res,
            400,
            { error: err.message === "Body too large" ? "Upload too large" : "Invalid JSON body" },
            extraHeaders
          );
          return;
        }

        const prompt = (body.prompt || "").trim();
        const rawImages = Array.isArray(body.images) ? body.images : [];
        if (!prompt && rawImages.length === 0) {
          sendJson(res, 400, { error: "prompt or images required" }, extraHeaders);
          return;
        }
        if (rawImages.length > 8) {
          sendJson(res, 400, { error: "Too many images (max 8)" }, extraHeaders);
          return;
        }

        let savedImages = [];
        try {
          savedImages = rawImages.map((img, i) =>
            saveImageUpload({
              data: img.data || img.dataUrl || img.base64,
              mimeType: img.mimeType || img.type || "image/png",
              name: img.name || `image-${i + 1}`,
            })
          );
        } catch (err) {
          sendJson(res, 400, { error: err.message || "Invalid image" }, extraHeaders);
          return;
        }

        const sessionId = body.sessionId || null;
        const newSession = !!body.newSession || !sessionId;
        const model = body.model || "grok-4.5";
        const effort = body.effort || "high";
        const cwd = body.cwd || process.cwd();
        const forcedId = newSession ? body.sessionId || createSessionId() : sessionId;

        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
          "X-Accel-Buffering": "no",
          ...extraHeaders,
        });

        const writeEvent = (event, data) => {
          res.write(`event: ${event}\n`);
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        };

        writeEvent("start", {
          sessionId: forcedId,
          newSession,
          model,
          effort,
          cwd,
          images: savedImages.length,
        });

        const runId = createSessionId();
        writeEvent("run", { runId });
        if (savedImages.length) {
          writeEvent("status", {
            message: `Saved ${savedImages.length} image(s) — launching Grok…`,
          });
        }

        // Attach listeners immediately; runPrompt buffers early events.
        const run = runPrompt({
          prompt,
          sessionId: forcedId,
          cwd,
          model,
          effort,
          newSession,
          images: savedImages,
        });
        activeRuns.set(runId, run);

        run.on("status", (data) => writeEvent("status", data));
        run.on("event", (evt) => writeEvent("grok", evt));
        run.on("sessionId", (id) => writeEvent("session", { sessionId: id }));
        run.on("error", (err) =>
          writeEvent("error", { message: String(err.message || err) })
        );
        run.on("end", (info) => {
          writeEvent("done", info);
          activeRuns.delete(runId);
          res.end();
        });

        req.on("close", () => {
          if (activeRuns.has(runId)) {
            try {
              run.kill();
            } catch {
              /* ignore */
            }
            activeRuns.delete(runId);
          }
        });
        return;
      }

      if (pathname === "/api/chat/cancel" && req.method === "POST") {
        let body = {};
        try {
          body = await readBody(req);
        } catch {
          /* empty */
        }
        const run = activeRuns.get(body.runId);
        if (run) {
          run.kill();
          activeRuns.delete(body.runId);
          sendJson(res, 200, { ok: true }, extraHeaders);
        } else {
          sendJson(res, 404, { error: "Run not found" }, extraHeaders);
        }
        return;
      }

      // ---------- Static UI ----------
      if (req.method === "GET" && staticDir) {
        let rel = pathname === "/" ? "/index.html" : pathname;
        rel = path.normalize(rel).replace(/^(\.\.[/\\])+/, "");
        const filePath = path.join(staticDir, rel);
        if (!filePath.startsWith(path.resolve(staticDir))) {
          res.writeHead(403, extraHeaders);
          res.end("Forbidden");
          return;
        }
        serveStatic(res, filePath, extraHeaders);
        return;
      }

      sendJson(res, 404, { error: "Not found" }, extraHeaders);
    } catch (err) {
      console.error("[httpApi]", err);
      if (!res.headersSent) {
        sendJson(res, 500, { error: String(err.message || err) }, extraHeaders);
      }
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      boundPort = addr.port;
      boundHost = addr.address;
      const localHost =
        addr.address === "0.0.0.0" || addr.address === "::"
          ? "127.0.0.1"
          : addr.address;
      const remote = buildRemoteInfo({
        port: boundPort,
        token,
        host: boundHost,
      });
      resolve({
        server,
        port: boundPort,
        host: boundHost,
        token,
        url: `http://${localHost}:${boundPort}`,
        remote,
      });
    });
  });
}

module.exports = { createServer };
