"use strict";

const http = require("http");
const https = require("https");
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
  logoutGrok,
  getLoginStatus,
  bulkSessionAction,
  renameSession,
  getUsageSnapshot,
} = require("./grokService");
const { transcribeAudio, createLiveTranscriber, decodePcmPayload } = require("./speechToText");
const {
  buildRemoteInfo,
  normalizeRemoteAddress,
  isLoopbackAddress,
  isAllowedPeer,
  getListenPlan,
  resolveAccessSettings,
  setAllowLan,
  detectTailscaleIpSync,
  detectTailscaleStatusSync,
  ensureTailscaleHttpsCert,
  getLanIpv4,
  rotateToken,
  toPublicRemoteInfo,
  toLoopbackRemoteInfo,
  getLastCwd,
  setLastCwd,
  getSeenFolders,
  addSeenFolder,
  getPermissionMode,
  setPermissionMode,
} = require("./remoteAccess");
const { isSafeSessionId } = require("./sessionId");
const { getUpdateStatus, applyAppUpdate } = require("./appUpdate");
const { tokensEqual, cookieHeader, presentedToken } = require("./authToken");
const {
  assertRemoteCwd,
  assertModelEffort,
  listKnownProjectFolders,
  createChatRateLimiter,
} = require("./chatPolicy");

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

function sendJson(res, status, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
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

const PRIVILEGED_POST_PATHS = new Set([
  "/api/update",
  "/api/auth/login",
  "/api/auth/login/cancel",
  "/api/auth/logout",
  "/api/remote/settings",
  "/api/remote/rotate",
  "/api/sessions/bulk",
]);

const LOOPBACK_ONLY_BODY = {
  error: "This action must be done on the PC (loopback only).",
  code: "LOOPBACK_ONLY",
};

function isLoopbackRequest(req) {
  return isLoopbackAddress(normalizeRemoteAddress(req.socket?.remoteAddress));
}

function isPrivilegedPost(method, pathname) {
  return (
    String(method || "").toUpperCase() === "POST" &&
    PRIVILEGED_POST_PATHS.has(pathname)
  );
}

function isRejectedSessionId(id) {
  return !id || id === "bulk" || !isSafeSessionId(id);
}

function listenOn(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(server.address());
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeHttpServer(server) {
  return new Promise((resolve) => {
    if (!server) return resolve();
    if (!server.listening) {
      try {
        server.close();
      } catch {
        /* ignore */
      }
      return resolve();
    }
    server.close(() => resolve());
    try {
      if (typeof server.closeAllConnections === "function") {
        server.closeAllConnections();
      }
    } catch {
      /* ignore */
    }
  });
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
  code{color:#9966CB;word-break:break-all}
</style></head><body>
<div class="card">
  <h1>Open the full phone URL</h1>
  <p>This address is missing the access token, so CSS/API calls are blocked.</p>
  <p>On your PC, open <strong>Grok Desktop</strong> → tap <strong>📱</strong> → <strong>Copy phone URL</strong>, then paste that full link here (it includes <code>?token=…</code>).</p>
</div>
</body></html>`;
}

const SSE_RECENT_LIMIT = 80;
const SSE_KEEPALIVE_MS = 15000;
const RUN_DONE_GRACE_MS = 30000;

function formatSse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data === undefined ? null : data)}\n\n`;
}

function safeWrite(res, chunk) {
  try {
    if (!res || res.writableEnded || res.destroyed) return false;
    res.write(chunk);
    return true;
  } catch {
    return false;
  }
}

function writeSseHeaders(res, extraHeaders = {}) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    ...extraHeaders,
  });
}

function broadcast(record, event, data) {
  record.lastEventAt = Date.now();
  let storedEvent = event;
  let storedData = data;
  let chunk;
  try {
    chunk = formatSse(event, data);
  } catch {
    storedEvent = "error";
    storedData = { message: "Failed to serialize event" };
    try {
      chunk = formatSse(storedEvent, storedData);
    } catch {
      return;
    }
  }
  record.recent.push({ event: storedEvent, data: storedData });
  if (record.recent.length > SSE_RECENT_LIMIT) record.recent.shift();
  for (const client of [...record.clients]) {
    if (!safeWrite(client, chunk)) record.clients.delete(client);
  }
}

function attachSseClient(record, req, res) {
  record.clients.add(res);
  const detach = () => {
    record.clients.delete(res);
  };
  req.on("close", detach);
  req.on("error", detach);
  res.on("close", detach);
  res.on("error", detach);
}

function replayRecent(record, res) {
  for (const frame of record.recent) {
    let chunk;
    try {
      chunk = formatSse(frame.event, frame.data);
    } catch {
      continue;
    }
    if (!safeWrite(res, chunk)) return false;
  }
  return true;
}

function startRunKeepAlive(record) {
  if (record.keepAlive) return;
  record.keepAlive = setInterval(() => {
    for (const client of [...record.clients]) {
      if (!safeWrite(client, ":\n\n")) record.clients.delete(client);
    }
  }, SSE_KEEPALIVE_MS);
  if (typeof record.keepAlive.unref === "function") record.keepAlive.unref();
}

function stopRunKeepAlive(record) {
  if (!record.keepAlive) return;
  clearInterval(record.keepAlive);
  record.keepAlive = null;
}

function finalizeRun(activeRuns, record, donePayload) {
  if (!record.done) {
    record.done = donePayload;
    broadcast(record, "done", donePayload);
  }
  stopRunKeepAlive(record);
  const clients = [...record.clients];
  record.clients.clear();
  for (const client of clients) {
    try {
      if (!client.writableEnded && !client.destroyed) client.end();
    } catch {
      /* ignore */
    }
  }
  if (!record.graceTimer) {
    record.graceTimer = setTimeout(() => {
      activeRuns.delete(record.runId);
    }, RUN_DONE_GRACE_MS);
    if (typeof record.graceTimer.unref === "function") record.graceTimer.unref();
  }
}

function registerRun(activeRuns, { runId, sessionId, emitter, clientTurnId }) {
  const record = {
    runId,
    sessionId: sessionId || null,
    clientTurnId: clientTurnId || null,
    emitter,
    startedAt: Date.now(),
    lastEventAt: Date.now(),
    recent: [],
    clients: new Set(),
    done: null,
    keepAlive: null,
    graceTimer: null,
  };
  activeRuns.set(runId, record);
  startRunKeepAlive(record);
  emitter.on("status", (data) => broadcast(record, "status", data));
  emitter.on("event", (evt) => broadcast(record, "grok", evt));
  emitter.on("sessionId", (id) => {
    record.sessionId = id;
    broadcast(record, "session", { sessionId: id });
  });
  emitter.on("error", (err) =>
    broadcast(record, "error", { message: String(err.message || err) })
  );
  emitter.on("end", (info) => {
    finalizeRun(activeRuns, record, info);
  });
  return record;
}

function pickBestRun(matches) {
  let best = null;
  for (const record of matches) {
    if (!best) {
      best = record;
      continue;
    }
    if (!record.done && best.done) {
      best = record;
      continue;
    }
    if (!!record.done === !!best.done && record.startedAt > best.startedAt) {
      best = record;
    }
  }
  return best;
}

function findRunBySessionId(activeRuns, sessionId, { includeDone = false } = {}) {
  if (!sessionId) return null;
  const matches = [];
  for (const record of activeRuns.values()) {
    if (record.sessionId !== sessionId) continue;
    if (record.done && !includeDone) continue;
    matches.push(record);
  }
  return pickBestRun(matches);
}

function findRunByClientTurnId(activeRuns, clientTurnId, { includeDone = true } = {}) {
  if (!clientTurnId) return null;
  const matches = [];
  for (const record of activeRuns.values()) {
    if (record.clientTurnId !== clientTurnId) continue;
    if (record.done && !includeDone) continue;
    matches.push(record);
  }
  return pickBestRun(matches);
}

function findActiveRunBySessionId(activeRuns, sessionId) {
  return findRunBySessionId(activeRuns, sessionId, { includeDone: false });
}

function serializeRun(record) {
  if (!record) return null;
  return {
    runId: record.runId,
    sessionId: record.sessionId,
    startedAt: record.startedAt,
    done: !!record.done,
    clientTurnId: record.clientTurnId || null,
  };
}

function sendRunLookup(res, record, extraHeaders) {
  if (!record) {
    sendJson(res, 200, { run: null, runs: [] }, extraHeaders);
    return;
  }
  const run = serializeRun(record);
  sendJson(
    res,
    200,
    {
      run,
      runId: run.runId,
      sessionId: run.sessionId,
      startedAt: run.startedAt,
      done: run.done,
      runs: [run],
    },
    extraHeaders
  );
}

function resolveStaticFile(staticDir, pathname) {
  const root = path.resolve(staticDir);
  let rel = pathname === "/" ? "index.html" : String(pathname || "");
  rel = rel.replace(/^[/\\]+/, "");
  rel = path.normalize(rel);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const filePath = path.resolve(root, rel);
  if (filePath !== root && !filePath.startsWith(root + path.sep)) return null;
  return filePath;
}

// opts.host is ignored: stored/passed 0.0.0.0 is a migration trap. getListenPlan decides.
async function createServer({
  port = 3847,
  staticDir,
  token = null,
  onAppRestart = null,
  allowLan: allowLanOpt,
} = {}) {
  const activeRuns = new Map();
  const liveSttSessions = new Map();
  const MAX_LIVE_STT = 3;
  const LIVE_STT_TTL_MS = 200_000;
  if (staticDir) staticDir = path.resolve(staticDir);

  let currentToken = token;
  const chatRateLimiter = createChatRateLimiter();

  function writeLiveStt(record, event, data) {
    if (!record) return;
    let chunk;
    try {
      chunk = formatSse(event, data);
    } catch {
      return;
    }
    for (const client of [...record.sseClients]) {
      if (!safeWrite(client, chunk)) record.sseClients.delete(client);
    }
  }

  function destroyLiveStt(id) {
    const record = liveSttSessions.get(id);
    if (!record) return;
    liveSttSessions.delete(id);
    if (record.timer) {
      clearTimeout(record.timer);
      record.timer = null;
    }
    if (record.keepAlive) {
      clearInterval(record.keepAlive);
      record.keepAlive = null;
    }
    try {
      if (record.transcriber) record.transcriber.close();
    } catch {
      /* ignore */
    }
    for (const client of [...record.sseClients]) {
      try {
        if (!client.writableEnded) client.end();
      } catch {
        /* ignore */
      }
    }
    record.sseClients.clear();
  }

  function destroyAllLiveStt() {
    for (const id of [...liveSttSessions.keys()]) destroyLiveStt(id);
  }

  let boundPort = port;
  let boundHost = "127.0.0.1";
  let currentAllowLan =
    typeof allowLanOpt === "boolean"
      ? allowLanOpt
      : !!resolveAccessSettings().allowLan;
  let currentTailscaleIp = detectTailscaleIpSync() || null;
  let loopbackServer = null;
  let allInterfacesServer = null;
  let lanServer = null;
  let lanListenIp = null;
  let tailscaleServer = null;
  let tailscaleListenIp = null;
  let tailscaleHttps = false;
  let tailscaleDnsName = null;
  let remote = null;
  const servers = [];
  let rebindLock = Promise.resolve();

  function refreshServers() {
    servers.length = 0;
    if (loopbackServer && loopbackServer.listening) servers.push(loopbackServer);
    if (allInterfacesServer && allInterfacesServer.listening) {
      servers.push(allInterfacesServer);
    }
    if (lanServer && lanServer.listening) servers.push(lanServer);
    if (tailscaleServer && tailscaleServer.listening) servers.push(tailscaleServer);
  }

  function currentRemoteInfo() {
    const plan = getListenPlan({
      allowLan: currentAllowLan,
      tailscaleIp: currentTailscaleIp,
      envHost: process.env.GROK_DESKTOP_HOST,
    });
    boundHost = plan.allInterfaces ? "0.0.0.0" : "127.0.0.1";
    return buildRemoteInfo({
      port: boundPort,
      token: currentToken,
      host: boundHost,
      allowLan: currentAllowLan,
      tailscaleIp: currentTailscaleIp,
      tailscaleDns: tailscaleDnsName,
      httpsPhone: tailscaleHttps,
      lanIpv4:
        currentAllowLan && typeof getLanIpv4 === "function" ? getLanIpv4() : null,
    });
  }

  function isHttpsRequest(req) {
    return !!(req && req.socket && req.socket.encrypted);
  }

  function attachConnectionFilter(srv) {
    srv.on("connection", (socket) => {
      const addr = socket.remoteAddress;
      if (!isAllowedPeer(addr, { allowLan: currentAllowLan })) {
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
      }
    });
  }

  function makeHttpServer() {
    const srv = http.createServer(handleRequest);
    attachConnectionFilter(srv);
    return srv;
  }

  function makeHttpsServer(tlsOpts) {
    const srv = https.createServer(tlsOpts, handleRequest);
    attachConnectionFilter(srv);
    return srv;
  }

  async function tryListenExtra(listenHost, kind, tlsOpts) {
    const srv = tlsOpts ? makeHttpsServer(tlsOpts) : makeHttpServer();
    try {
      await listenOn(srv, boundPort, listenHost);
      return srv;
    } catch (err) {
      try {
        srv.close();
      } catch {
        /* ignore */
      }
      const code = err && err.code;
      if (kind === "all" && code === "EADDRINUSE") {
        console.warn(
          `[httpApi] 0.0.0.0:${boundPort} already in use — loopback stays up (Windows often cannot bind both).`
        );
      } else if (
        (kind === "tailscale" || kind === "lan") &&
        (code === "EADDRNOTAVAIL" || code === "EADDRINUSE")
      ) {
        console.warn(
          `[httpApi] Tailscale ${listenHost}:${boundPort} unavailable (${code}) — loopback stays up.`
        );
      } else {
        console.warn(
          `[httpApi] could not bind ${listenHost}:${boundPort}${code ? ` (${code})` : ""}:`,
          err.message || err
        );
      }
      return null;
    }
  }

  async function rebindUnlocked(opts = {}) {
    if (typeof opts.allowLan === "boolean") {
      currentAllowLan = !!opts.allowLan;
    } else {
      currentAllowLan = !!resolveAccessSettings().allowLan;
    }

    if (Object.prototype.hasOwnProperty.call(opts, "tailscaleIp")) {
      currentTailscaleIp = opts.tailscaleIp || null;
    } else {
      currentTailscaleIp = detectTailscaleIpSync() || null;
    }

    const tsStatus = detectTailscaleStatusSync();
    if (!currentTailscaleIp && tsStatus.ip) currentTailscaleIp = tsStatus.ip;
    tailscaleDnsName = tsStatus.dnsName || null;
    const tlsMaterial =
      tsStatus.httpsEligible && tsStatus.dnsName
        ? ensureTailscaleHttpsCert(tsStatus.dnsName)
        : null;
    const wantHttps = Boolean(tlsMaterial);

    const plan = getListenPlan({
      allowLan: currentAllowLan,
      tailscaleIp: currentTailscaleIp,
      envHost: process.env.GROK_DESKTOP_HOST,
      preferTailscaleSocket: wantHttps,
      lanIpv4: currentAllowLan ? getLanIpv4() : null,
    });

    if (plan.allInterfaces) {
      if (tailscaleServer) {
        await closeHttpServer(tailscaleServer);
        tailscaleServer = null;
        tailscaleListenIp = null;
        tailscaleHttps = false;
      }
      if (lanServer) {
        await closeHttpServer(lanServer);
        lanServer = null;
        lanListenIp = null;
      }
      if (!allInterfacesServer) {
        allInterfacesServer = await tryListenExtra("0.0.0.0", "all");
      }
    } else {
      if (allInterfacesServer) {
        await closeHttpServer(allInterfacesServer);
        allInterfacesServer = null;
      }
      const wantTs = plan.tailscale || null;
      if (!wantTs) {
        if (tailscaleServer) {
          await closeHttpServer(tailscaleServer);
          tailscaleServer = null;
          tailscaleListenIp = null;
          tailscaleHttps = false;
        }
      } else if (
        !tailscaleServer ||
        tailscaleListenIp !== wantTs ||
        tailscaleHttps !== wantHttps
      ) {
        if (tailscaleServer) {
          await closeHttpServer(tailscaleServer);
          tailscaleServer = null;
          tailscaleListenIp = null;
          tailscaleHttps = false;
        }
        const tlsOpts = wantHttps
          ? { cert: tlsMaterial.cert, key: tlsMaterial.key }
          : null;
        tailscaleServer = await tryListenExtra(wantTs, "tailscale", tlsOpts);
        let usingHttps = !!(tailscaleServer && tlsOpts);
        if (!tailscaleServer && tlsOpts) {
          tailscaleServer = await tryListenExtra(wantTs, "tailscale", null);
          usingHttps = false;
        }
        tailscaleListenIp = tailscaleServer ? wantTs : null;
        tailscaleHttps = usingHttps;
        if (tailscaleHttps) {
          console.log(
            `[httpApi] Tailscale HTTPS on ${wantTs}:${boundPort} (${tsStatus.dnsName})`
          );
        }
      }

      const wantLan = plan.lan || null;
      if (!wantLan) {
        if (lanServer) {
          await closeHttpServer(lanServer);
          lanServer = null;
          lanListenIp = null;
        }
      } else if (!lanServer || lanListenIp !== wantLan) {
        if (lanServer) {
          await closeHttpServer(lanServer);
          lanServer = null;
          lanListenIp = null;
        }
        lanServer = await tryListenExtra(wantLan, "lan");
        lanListenIp = lanServer ? wantLan : null;
      }
    }

    refreshServers();
    remote = currentRemoteInfo();
    return remote;
  }

  function rebind(opts) {
    const run = rebindLock.then(() => rebindUnlocked(opts));
    rebindLock = run.catch(() => {});
    return run;
  }

  async function close() {
    destroyAllLiveStt();
    await rebindLock.catch(() => {});
    if (allInterfacesServer) {
      await closeHttpServer(allInterfacesServer);
      allInterfacesServer = null;
    }
    if (lanServer) {
      await closeHttpServer(lanServer);
      lanServer = null;
      lanListenIp = null;
    }
    if (tailscaleServer) {
      await closeHttpServer(tailscaleServer);
      tailscaleServer = null;
      tailscaleListenIp = null;
      tailscaleHttps = false;
    }
    if (loopbackServer) {
      await closeHttpServer(loopbackServer);
    }
    refreshServers();
  }

  async function handleRequest(req, res) {
    const parsed = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = parsed.pathname || "/";
    const presented = presentedToken(req, parsed);
    const queryToken = parsed.searchParams.get("token");

    const extraHeaders = {};
    // One-time Safari bootstrap: mint HttpOnly cookie when the query token matches.
    if (currentToken && tokensEqual(queryToken, currentToken)) {
      extraHeaders["Set-Cookie"] = cookieHeader(currentToken, {
        secure: isHttpsRequest(req),
      });
    }

    const authorized =
      !currentToken ||
      isLoopbackRequest(req) ||
      tokensEqual(presented, currentToken);

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

    if (isPrivilegedPost(req.method, pathname) && !isLoopbackRequest(req)) {
      sendJson(res, 403, LOOPBACK_ONLY_BODY, extraHeaders);
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
            remote: toPublicRemoteInfo(currentRemoteInfo()),
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
            method: body.method === "email" ? "email" : "x",
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

      if (pathname === "/api/auth/logout" && req.method === "POST") {
        try {
          const result = await logoutGrok();
          sendJson(res, 200, result, extraHeaders);
        } catch (err) {
          const status = err.code === "NOT_INSTALLED" ? 400 : 500;
          sendJson(
            res,
            status,
            { error: err.message || String(err), code: err.code || null },
            extraHeaders
          );
        }
        return;
      }

      if (pathname === "/api/update" && req.method === "GET") {
        const force = parsed.searchParams.get("refresh") === "1";
        const status = await getUpdateStatus({ force });
        sendJson(res, 200, status, extraHeaders);
        return;
      }

      if (pathname === "/api/update" && req.method === "POST") {
        try {
          const result = await applyAppUpdate();
          const restarting =
            !!result.pulled && typeof onAppRestart === "function";
          sendJson(
            res,
            200,
            { ...result, restarting },
            extraHeaders
          );
          if (restarting) {
            setTimeout(() => {
              try {
                onAppRestart();
              } catch (err) {
                console.error("[httpApi] onAppRestart failed:", err);
              }
            }, 700);
          }
        } catch (err) {
          sendJson(
            res,
            500,
            {
              error: err.message || String(err),
              code: err.code || null,
            },
            extraHeaders
          );
        }
        return;
      }

      if (pathname === "/api/remote" && req.method === "GET") {
        const info = await rebind();
        if (isLoopbackRequest(req)) {
          const payload = toLoopbackRemoteInfo(info);
          payload.seenFolders = getSeenFolders();
          payload.permissionMode = getPermissionMode();
          sendJson(res, 200, payload, extraHeaders);
        } else {
          sendJson(res, 200, toPublicRemoteInfo(info), extraHeaders);
        }
        return;
      }

      if (pathname === "/api/remote/settings" && req.method === "POST") {
        let body;
        try {
          body = await readBody(req);
        } catch (err) {
          sendJson(res, 400, { error: err.message || "Invalid JSON body" }, extraHeaders);
          return;
        }
        if (typeof body.allowLan === "boolean") {
          setAllowLan(body.allowLan);
        }
        if (typeof body.lastCwd === "string") {
          setLastCwd(body.lastCwd);
        }
        if (typeof body.seenFolder === "string") {
          addSeenFolder(body.seenFolder);
        }
        if (typeof body.permissionMode === "string") {
          setPermissionMode(body.permissionMode.trim());
        }
        const payload = toLoopbackRemoteInfo(await rebind());
        payload.seenFolders = getSeenFolders();
        payload.permissionMode = getPermissionMode();
        sendJson(res, 200, payload, extraHeaders);
        return;
      }

      if (pathname === "/api/remote/rotate" && req.method === "POST") {
        const rotated = rotateToken();
        currentToken = rotated.token;
        remote = currentRemoteInfo();
        extraHeaders["Set-Cookie"] = cookieHeader(currentToken, {
          secure: isHttpsRequest(req),
        });
        const payload = toLoopbackRemoteInfo(remote);
        payload.seenFolders = getSeenFolders();
        payload.permissionMode = getPermissionMode();
        sendJson(res, 200, payload, extraHeaders);
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

      if (pathname === "/api/usage" && req.method === "GET") {
        const sessionId = parsed.searchParams.get("sessionId") || null;
        if (sessionId && isRejectedSessionId(sessionId)) {
          sendJson(res, 400, { error: "Invalid session id" }, extraHeaders);
          return;
        }
        try {
          const usage = await getUsageSnapshot({ sessionId });
          sendJson(res, 200, usage, extraHeaders);
        } catch (err) {
          sendJson(
            res,
            500,
            { error: err.message || "Usage unavailable", weekly: null, session: null },
            extraHeaders
          );
        }
        return;
      }

      if (pathname.startsWith("/api/sessions/") && req.method === "GET") {
        const id = decodeURIComponent(pathname.slice("/api/sessions/".length));
        if (isRejectedSessionId(id)) {
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

      if (pathname.startsWith("/api/sessions/") && req.method === "PATCH") {
        const id = decodeURIComponent(pathname.slice("/api/sessions/".length));
        if (isRejectedSessionId(id)) {
          sendJson(res, 400, { error: "Invalid session id" }, extraHeaders);
          return;
        }
        let body;
        try {
          body = await readBody(req);
        } catch (err) {
          sendJson(res, 400, { error: err.message || "Invalid JSON body" }, extraHeaders);
          return;
        }
        if (body.title === undefined && body.name === undefined) {
          sendJson(res, 400, { error: "title is required" }, extraHeaders);
          return;
        }
        try {
          const result = renameSession(id, body.title ?? body.name);
          const session = result.session
            ? (({ path: _p, ...rest }) => rest)(result.session)
            : null;
          sendJson(res, 200, { id: result.id, title: result.title, session }, extraHeaders);
        } catch (err) {
          const status = err.code === "NOT_FOUND" ? 404 : 500;
          sendJson(res, status, { error: err.message || String(err) }, extraHeaders);
        }
        return;
      }

      if (pathname === "/api/stt/start" && req.method === "POST") {
        if (!isLoopbackRequest(req)) {
          try {
            chatRateLimiter.check(presented || req.socket.remoteAddress);
          } catch (err) {
            sendJson(
              res,
              err && err.status ? err.status : 429,
              { error: (err && err.message) || String(err) },
              extraHeaders
            );
            return;
          }
        }
        if (liveSttSessions.size >= MAX_LIVE_STT) {
          const oldest = [...liveSttSessions.values()].sort(
            (a, b) => a.createdAt - b.createdAt
          )[0];
          if (oldest) destroyLiveStt(oldest.id);
        }
        const id = createSessionId();
        const record = {
          id,
          transcriber: null,
          sseClients: new Set(),
          createdAt: Date.now(),
          bytes: 0,
          timer: null,
          keepAlive: null,
        };
        try {
          record.transcriber = createLiveTranscriber({
            language: "en",
            onPartial: ({ text }) => writeLiveStt(record, "partial", { text }),
            onError: (err) =>
              writeLiveStt(record, "fail", {
                error: (err && err.message) || "Speech stream failed",
              }),
            onDone: ({ text }) => {
              writeLiveStt(record, "done", { text: text || "" });
              for (const client of [...record.sseClients]) {
                try {
                  if (!client.writableEnded) client.end();
                } catch {
                  /* ignore */
                }
              }
              record.sseClients.clear();
            },
          });
        } catch (err) {
          sendJson(
            res,
            err && err.status ? err.status : 500,
            {
              error: (err && err.message) || "Could not start voice",
              code: (err && err.code) || null,
            },
            extraHeaders
          );
          return;
        }
        liveSttSessions.set(id, record);
        record.timer = setTimeout(() => destroyLiveStt(id), LIVE_STT_TTL_MS);
        try {
          await record.transcriber.whenReady({ timeoutMs: 8000 });
        } catch (err) {
          destroyLiveStt(id);
          sendJson(
            res,
            err && err.status ? err.status : 502,
            {
              error: (err && err.message) || "Could not start voice",
              code: (err && err.code) || null,
            },
            extraHeaders
          );
          return;
        }
        sendJson(res, 200, { sessionId: id }, extraHeaders);
        return;
      }

      if (pathname === "/api/stt/status" && req.method === "GET") {
        const id = parsed.searchParams.get("sessionId") || "";
        if (isRejectedSessionId(id) || !liveSttSessions.has(id)) {
          sendJson(res, 404, { error: "Voice session not found" }, extraHeaders);
          return;
        }
        const record = liveSttSessions.get(id);
        sendJson(
          res,
          200,
          {
            text: record.transcriber ? record.transcriber.getText() : "",
            closed: !!(record.transcriber && record.transcriber.closed),
          },
          extraHeaders
        );
        return;
      }

      if (pathname === "/api/stt/live" && req.method === "GET") {
        const id = parsed.searchParams.get("sessionId") || "";
        if (isRejectedSessionId(id) || !liveSttSessions.has(id)) {
          sendJson(res, 404, { error: "Voice session not found" }, extraHeaders);
          return;
        }
        const record = liveSttSessions.get(id);
        writeSseHeaders(res, extraHeaders);
        record.sseClients.add(res);
        const current = record.transcriber ? record.transcriber.getText() : "";
        safeWrite(res, formatSse("ready", { sessionId: id, text: current }));
        if (current) safeWrite(res, formatSse("partial", { text: current }));
        if (!record.keepAlive) {
          record.keepAlive = setInterval(() => {
            for (const client of [...record.sseClients]) {
              if (!safeWrite(client, ": ping\n\n")) record.sseClients.delete(client);
            }
          }, 15000);
        }
        const detach = () => record.sseClients.delete(res);
        req.on("close", detach);
        res.on("close", detach);
        return;
      }

      if (pathname === "/api/stt/audio" && req.method === "POST") {
        let body;
        try {
          body = await readBody(req, { maxBytes: 256 * 1024 });
        } catch (err) {
          sendJson(
            res,
            400,
            {
              error:
                err.message === "Body too large"
                  ? "Audio chunk too large"
                  : "Invalid JSON body",
            },
            extraHeaders
          );
          return;
        }
        const id = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
        if (isRejectedSessionId(id) || !liveSttSessions.has(id)) {
          sendJson(res, 404, { error: "Voice session not found" }, extraHeaders);
          return;
        }
        const record = liveSttSessions.get(id);
        let pcm;
        try {
          pcm = decodePcmPayload(body.pcm || body.audio || body.data);
        } catch (err) {
          sendJson(
            res,
            err && err.status ? err.status : 400,
            {
              error: (err && err.message) || "Invalid audio",
              code: (err && err.code) || null,
            },
            extraHeaders
          );
          return;
        }
        record.bytes += pcm.length;
        if (record.bytes > 8 * 1024 * 1024) {
          sendJson(res, 400, { error: "Audio is too long" }, extraHeaders);
          return;
        }
        try {
          record.transcriber.sendPcm(pcm);
          sendJson(res, 202, { ok: true }, extraHeaders);
        } catch (err) {
          sendJson(
            res,
            err && err.status ? err.status : 400,
            {
              error: (err && err.message) || "Could not send audio",
              code: (err && err.code) || null,
            },
            extraHeaders
          );
        }
        return;
      }

      if (pathname === "/api/stt/stop" && req.method === "POST") {
        let body = {};
        try {
          body = await readBody(req);
        } catch {
          body = {};
        }
        const id = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
        if (isRejectedSessionId(id) || !liveSttSessions.has(id)) {
          sendJson(res, 404, { error: "Voice session not found" }, extraHeaders);
          return;
        }
        const record = liveSttSessions.get(id);
        if (body.cancel) {
          const text = record.transcriber ? record.transcriber.getText() : "";
          destroyLiveStt(id);
          sendJson(res, 200, { text, cancelled: true }, extraHeaders);
          return;
        }
        let text = "";
        try {
          text = record.transcriber
            ? await record.transcriber.finish({ timeoutMs: 8000 })
            : "";
        } catch {
          text = record.transcriber ? record.transcriber.getText() : "";
        }
        destroyLiveStt(id);
        sendJson(res, 200, { text: text || "" }, extraHeaders);
        return;
      }

      if (pathname === "/api/stt" && req.method === "POST") {
        let body;
        try {
          body = await readBody(req, { maxBytes: 12 * 1024 * 1024 });
        } catch (err) {
          sendJson(
            res,
            400,
            {
              error:
                err.message === "Body too large"
                  ? "Audio too large"
                  : "Invalid JSON body",
            },
            extraHeaders
          );
          return;
        }

        if (!isLoopbackRequest(req)) {
          try {
            chatRateLimiter.check(presented || req.socket.remoteAddress);
          } catch (err) {
            sendJson(
              res,
              err && err.status ? err.status : 429,
              { error: (err && err.message) || String(err) },
              extraHeaders
            );
            return;
          }
        }

        try {
          const result = await transcribeAudio({
            data: body.audio || body.data || body.base64,
            mimeType: body.mimeType || body.type || "audio/wav",
            language: body.language || "en",
          });
          sendJson(res, 200, result, extraHeaders);
        } catch (err) {
          sendJson(
            res,
            err && err.status ? err.status : 500,
            {
              error: (err && err.message) || "Transcription failed",
              code: (err && err.code) || null,
            },
            extraHeaders
          );
        }
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

        const remoteChat = !isLoopbackRequest(req);
        if (remoteChat) {
          try {
            chatRateLimiter.check(presented || req.socket.remoteAddress);
          } catch (err) {
            sendJson(
              res,
              err && err.status ? err.status : 429,
              { error: (err && err.message) || String(err) },
              extraHeaders
            );
            return;
          }
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

        if (body.sessionId != null && body.sessionId !== "") {
          if (isRejectedSessionId(body.sessionId)) {
            sendJson(res, 400, { error: "Invalid session id" }, extraHeaders);
            return;
          }
        }
        if (typeof body.forkFrom === "string" && body.forkFrom.trim()) {
          if (isRejectedSessionId(body.forkFrom.trim())) {
            sendJson(res, 400, { error: "Invalid session id" }, extraHeaders);
            return;
          }
        }

        const sessionId = body.sessionId || null;
        const forkFrom =
          typeof body.forkFrom === "string" ? body.forkFrom.trim() : "";
        const newSession = !!body.newSession || !sessionId || !!forkFrom;
        let model = body.model || "grok-4.5";
        let effort = body.effort || "high";
        let cwd = body.cwd || process.cwd();
        if (remoteChat) {
          try {
            const resolved = assertModelEffort(body.model, body.effort, loadModels());
            model = resolved.model;
            effort = resolved.effort;
            cwd = assertRemoteCwd(body.cwd || getLastCwd(), {
              knownFolders: listKnownProjectFolders(listSessions({ limit: 500 })),
              lastCwd: getLastCwd(),
            });
          } catch (err) {
            sendJson(
              res,
              err && err.status ? err.status : 400,
              { error: (err && err.message) || String(err) },
              extraHeaders
            );
            return;
          }
        } else if (typeof body.cwd === "string" && body.cwd.trim()) {
          setLastCwd(body.cwd);
        }
        let permissionMode;
        if (remoteChat) {
          // Same Access setting as the PC. Ignore a phone-supplied override.
          permissionMode = getPermissionMode();
        } else {
          const bodyMode =
            typeof body.permissionMode === "string" ? body.permissionMode.trim() : "";
          if (
            bodyMode === "bypassPermissions" ||
            bodyMode === "dontAsk" ||
            bodyMode === "default"
          ) {
            setPermissionMode(bodyMode);
          }
          permissionMode = bodyMode || getPermissionMode();
        }
        const forcedId = newSession ? body.sessionId || createSessionId() : sessionId;
        const clientTurnId =
          typeof body.clientTurnId === "string" ? body.clientTurnId.trim().slice(0, 80) : "";

        writeSseHeaders(res, extraHeaders);

        const runId = createSessionId();
        // Attach listeners immediately; runPrompt buffers early events.
        const emitter = runPrompt({
          prompt,
          sessionId: forcedId,
          cwd,
          model,
          effort,
          newSession,
          images: savedImages,
          forkFrom: forkFrom || null,
          permissionMode,
          remote: remoteChat,
        });
        const record = registerRun(activeRuns, {
          runId,
          sessionId: forcedId,
          emitter,
          clientTurnId: clientTurnId || null,
        });
        // Disconnect only detaches this HTTP client — the grok child keeps running.
        attachSseClient(record, req, res);

        broadcast(record, "start", {
          sessionId: forcedId,
          newSession,
          model,
          effort,
          cwd,
          images: savedImages.length,
        });
        broadcast(record, "run", { runId });
        if (savedImages.length) {
          broadcast(record, "status", {
            message: `Saved ${savedImages.length} image(s) — launching Grok…`,
          });
        }
        return;
      }

      if (pathname.startsWith("/api/chat/runs/") && req.method === "GET") {
        const runId = decodeURIComponent(pathname.slice("/api/chat/runs/".length));
        if (!runId || runId.includes("/")) {
          sendJson(res, 404, { error: "Run not found" }, extraHeaders);
          return;
        }
        const record = activeRuns.get(runId);
        if (!record) {
          sendJson(res, 404, { error: "Run not found" }, extraHeaders);
          return;
        }

        writeSseHeaders(res, extraHeaders);
        const ok = replayRecent(record, res);
        if (!ok) return;
        if (record.done) {
          try {
            if (!res.writableEnded && !res.destroyed) res.end();
          } catch {
            /* ignore */
          }
          return;
        }
        attachSseClient(record, req, res);
        return;
      }

      if (pathname === "/api/runs" && req.method === "GET") {
        const sessionId = parsed.searchParams.get("sessionId") || "";
        if (sessionId && isRejectedSessionId(sessionId)) {
          sendJson(res, 400, { error: "Invalid session id" }, extraHeaders);
          return;
        }
        const clientTurnId = parsed.searchParams.get("clientTurnId") || "";
        const includeDone = parsed.searchParams.get("includeDone") === "1";
        if (clientTurnId) {
          sendRunLookup(
            res,
            findRunByClientTurnId(activeRuns, clientTurnId, { includeDone: true }),
            extraHeaders
          );
          return;
        }
        if (sessionId) {
          sendRunLookup(
            res,
            findRunBySessionId(activeRuns, sessionId, { includeDone }),
            extraHeaders
          );
          return;
        }
        const runs = [];
        for (const record of activeRuns.values()) {
          if (record.done) continue;
          runs.push(serializeRun(record));
        }
        sendJson(res, 200, { runs }, extraHeaders);
        return;
      }

      if (pathname === "/api/chat/cancel" && req.method === "POST") {
        let body = {};
        try {
          body = await readBody(req);
        } catch {
          /* empty */
        }
        const record =
          (body.runId && activeRuns.get(body.runId)) ||
          findActiveRunBySessionId(activeRuns, body.sessionId) ||
          findRunByClientTurnId(activeRuns, body.clientTurnId, { includeDone: false });
        if (record) {
          if (!record.done) {
            try {
              record.emitter.kill();
            } catch {
              /* ignore */
            }
          }
          sendJson(res, 200, { ok: true }, extraHeaders);
        } else {
          sendJson(res, 404, { error: "Run not found" }, extraHeaders);
        }
        return;
      }

      // ---------- Static UI ----------
      if (req.method === "GET" && staticDir) {
        const filePath = resolveStaticFile(staticDir, pathname);
        if (!filePath) {
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
  }

  loopbackServer = makeHttpServer();
  try {
    const addr = await listenOn(loopbackServer, port, "127.0.0.1");
    boundPort = addr && addr.port ? addr.port : port;
  } catch (err) {
    await closeHttpServer(loopbackServer);
    throw err;
  }

  await rebind({
    allowLan: currentAllowLan,
    tailscaleIp: currentTailscaleIp,
  });

  return {
    servers,
    get server() {
      return loopbackServer;
    },
    close,
    get port() {
      return boundPort;
    },
    get host() {
      return boundHost;
    },
    url: `http://127.0.0.1:${boundPort}`,
    get remote() {
      return remote;
    },
    get token() {
      return currentToken;
    },
    rebind,
  };
}

module.exports = {
  createServer,
  findRunBySessionId,
  findRunByClientTurnId,
  isLoopbackRequest,
  isPrivilegedPost,
};
