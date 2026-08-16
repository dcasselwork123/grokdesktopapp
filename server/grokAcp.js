"use strict";

const { spawn } = require("child_process");
const { EventEmitter } = require("events");
const { answersMapFromPairs, formatUserAnswersPrompt } = require("./sessionQuestions");

const ASK_METHODS = new Set(["x.ai/ask_user_question", "_x.ai/ask_user_question"]);

function parseAcpLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed) return null;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return { kind: "non-json", line: trimmed };
  }
  if (!msg || typeof msg !== "object") return { kind: "non-json", line: trimmed };
  if (msg.id != null && msg.method == null) {
    return { kind: "response", id: msg.id, result: msg.result, error: msg.error };
  }
  if (msg.method === "session/update") {
    return {
      kind: "session-update",
      sessionId: msg.params && msg.params.sessionId,
      update: msg.params && msg.params.update,
      meta: msg.params && msg.params._meta,
    };
  }
  if (msg.method) {
    return { kind: "server-request", id: msg.id, method: msg.method, params: msg.params };
  }
  return { kind: "unknown", raw: msg };
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
  if (!update || typeof update !== "object") return "";
  const meta = update._meta && update._meta["x.ai/tool"];
  return (
    update.toolName ||
    update.name ||
    (meta && meta.name) ||
    update.title ||
    ""
  );
}

function mapSessionUpdateToGrokEvent(update, sessionId) {
  if (!update || typeof update !== "object") return null;
  const kind = update.sessionUpdate;
  if (kind === "agent_message_chunk") {
    const text = chunkText(update.content);
    if (!text) return null;
    return { type: "text", data: text, sessionId: sessionId || null };
  }
  if (kind === "agent_thought_chunk") {
    const text = chunkText(update.content);
    if (!text) return null;
    return { type: "thought", data: text, sessionId: sessionId || null };
  }
  if (kind === "tool_call" || kind === "tool_call_update") {
    return {
      type: kind,
      toolCallId: update.toolCallId || update.id || null,
      toolName: toolNameFromUpdate(update),
      title: update.title || "",
      status: update.status || (kind === "tool_call" ? "pending" : undefined),
      rawInput: update.rawInput || update.input || null,
      _meta: update._meta || null,
      sessionId: sessionId || null,
    };
  }
  return null;
}

function makeQuestionResponse(id, answers, annotations) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      outcome: "accepted",
      answers: answers && typeof answers === "object" ? answers : {},
      annotations: annotations && typeof annotations === "object" ? annotations : {},
    },
  };
}

function makeQuestionCancelledResponse(id) {
  return { jsonrpc: "2.0", id, result: { outcome: "cancelled" } };
}

function makePermissionResponse(id, optionId) {
  return {
    jsonrpc: "2.0",
    id,
    result: { outcome: { outcome: "selected", optionId } },
  };
}

function pickPermissionOptionId(options, permissionMode) {
  const list = Array.isArray(options) ? options : [];
  const kindOf = (o) => String((o && (o.kind || o.optionId)) || "").toLowerCase();
  if (permissionMode === "dontAsk") {
    const reject = list.find((o) => /reject|deny/.test(kindOf(o)));
    return (reject && reject.optionId) || (list[0] && list[0].optionId) || "reject-once";
  }
  const allowOnce = list.find((o) => kindOf(o) === "allow_once" || o.optionId === "allow-once");
  if (allowOnce) return allowOnce.optionId;
  const allow = list.find((o) => /allow/.test(kindOf(o)));
  return (allow && allow.optionId) || (list[0] && list[0].optionId) || "allow-once";
}

function isAskUserQuestionMethod(method) {
  return ASK_METHODS.has(String(method || "").trim());
}

function buildAcpArgs({ cwd, model, effort, permissionMode }) {
  const args = [];
  if (cwd) args.push("--cwd", cwd);
  if (model) args.push("-m", model);
  if (effort) args.push("--effort", effort);
  if (permissionMode) args.push("--permission-mode", permissionMode);
  args.push("--no-auto-update", "agent");
  if (permissionMode === "bypassPermissions") args.push("--always-approve");
  args.push("stdio");
  return args;
}

function createAcpClient({ grokBin, cwd, model, effort, permissionMode, log }) {
  const emitter = new EventEmitter();
  const pending = new Map();
  let nextId = 1;
  let buffer = "";
  let closed = false;
  let child = null;
  let sessionId = null;
  const writeQueue = [];
  let writing = false;

  const debug = (line) => {
    if (typeof log === "function") log(line);
  };

  const args = buildAcpArgs({ cwd, model, effort, permissionMode });
  try {
    child = spawn(grokBin, args, {
      cwd: cwd || process.cwd(),
      env: { ...process.env },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    closed = true;
    process.nextTick(() => emitter.emit("error", err));
    return wrap();
  }

  debug(`acp spawn pid=${child.pid} args=${args.join(" ")}`);

  function failPending(err) {
    for (const [, rec] of pending) {
      if (rec.timer) clearTimeout(rec.timer);
      rec.reject(err);
    }
    pending.clear();
  }

  function writeLine(obj) {
    if (closed || !child || !child.stdin || child.stdin.destroyed) return false;
    writeQueue.push(JSON.stringify(obj) + "\n");
    flushWrite();
    return true;
  }

  function flushWrite() {
    if (writing || !child || !child.stdin || child.stdin.writableEnded) return;
    writing = true;
    const pump = () => {
      while (writeQueue.length) {
        const chunk = writeQueue.shift();
        const ok = child.stdin.write(chunk);
        if (!ok) {
          child.stdin.once("drain", pump);
          return;
        }
      }
      writing = false;
    };
    pump();
  }

  function handleMessage(msg) {
    if (msg.kind === "response") {
      const rec = pending.get(msg.id);
      if (!rec) return;
      pending.delete(msg.id);
      if (rec.timer) clearTimeout(rec.timer);
      if (msg.error) rec.reject(Object.assign(new Error(msg.error.message || "ACP error"), msg.error));
      else rec.resolve(msg.result == null ? {} : msg.result);
      return;
    }
    if (msg.kind === "session-update") {
      if (msg.sessionId) sessionId = msg.sessionId;
      emitter.emit("update", msg);
      return;
    }
    if (msg.kind === "server-request") {
      emitter.emit("request", msg);
    }
  }

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      const msg = parseAcpLine(line);
      if (msg) handleMessage(msg);
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    const text = String(chunk);
    debug(`acp stderr ${text.slice(0, 400).replace(/\s+/g, " ")}`);
    emitter.emit("stderr", text);
  });

  child.on("error", (err) => {
    debug(`acp child error: ${err.message || err}`);
    emitter.emit("error", err);
  });

  child.on("close", (code) => {
    closed = true;
    debug(`acp close code=${code}`);
    failPending(new Error(`ACP process exited (${code})`));
    emitter.emit("close", code);
  });

  function request(method, params, { timeout = 30000 } = {}) {
    if (closed) return Promise.reject(new Error("ACP client is closed"));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const rec = { resolve, reject, timer: null };
      if (timeout > 0) {
        rec.timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out`));
        }, timeout);
      }
      pending.set(id, rec);
      if (!writeLine({ jsonrpc: "2.0", id, method, params })) {
        pending.delete(id);
        if (rec.timer) clearTimeout(rec.timer);
        reject(new Error("ACP stdin is closed"));
      }
    });
  }

  function respond(id, result) {
    return writeLine({ jsonrpc: "2.0", id, result });
  }

  function respondError(id, error) {
    return writeLine({ jsonrpc: "2.0", id, error });
  }

  function cancel() {
    if (sessionId && !closed) {
      writeLine({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
    }
    close();
  }

  function close() {
    if (closed && !child) return;
    closed = true;
    failPending(new Error("ACP client closed"));
    if (!child || !child.pid) return;
    try {
      if (process.platform === "win32") {
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
  }

  function wrap() {
    return {
      on: emitter.on.bind(emitter),
      request,
      respond,
      respondError,
      cancel,
      close,
      get sessionId() {
        return sessionId;
      },
      set sessionId(id) {
        sessionId = id;
      },
      get closed() {
        return closed;
      },
    };
  }

  return wrap();
}

function pickAuthMethod(init) {
  const methods = Array.isArray(init && init.authMethods) ? init.authMethods : [];
  const ids = new Set(methods.map((m) => m && m.id).filter(Boolean));
  if (process.env.XAI_API_KEY && ids.has("xai.api_key")) return "xai.api_key";
  if (ids.has("cached_token")) return "cached_token";
  return methods[0] && methods[0].id ? methods[0].id : null;
}

async function continueSessionWithAnswers({
  grokBin,
  sessionId,
  cwd,
  model,
  effort,
  permissionMode,
  answers,
  onEvent,
  onStatus,
  log,
  shouldCancel,
}) {
  if (!grokBin) throw new Error("Grok CLI is not available");
  if (!sessionId) throw new Error("Missing session id");
  const client = createAcpClient({ grokBin, cwd, model, effort, permissionMode, log });
  let replaying = false;
  const answersMap = answersMapFromPairs(answers);

  const cancelled = () => typeof shouldCancel === "function" && shouldCancel();

  const emitStatus = (message) => {
    if (typeof onStatus === "function") onStatus({ message });
  };

  client.on("update", (msg) => {
    if (replaying) return;
    const evt = mapSessionUpdateToGrokEvent(msg.update, msg.sessionId || sessionId);
    if (evt && typeof onEvent === "function") onEvent(evt);
  });

  client.on("request", (msg) => {
    if (cancelled()) {
      if (msg.id != null) client.respond(msg.id, { outcome: "cancelled" });
      return;
    }
    if (isAskUserQuestionMethod(msg.method)) {
      if (typeof log === "function") {
        log(`acp ask_user_question id=${msg.id} keys=${Object.keys(answersMap).length}`);
      }
      client.respond(msg.id, makeQuestionResponse(msg.id, answersMap).result);
      emitStatus("Sent your choice…");
      return;
    }
    if (msg.method === "session/request_permission") {
      const optionId = pickPermissionOptionId(
        msg.params && msg.params.options,
        permissionMode
      );
      client.respond(msg.id, makePermissionResponse(msg.id, optionId).result);
      return;
    }
    if (msg.id != null) {
      client.respondError(msg.id, { code: -32601, message: "Method not supported" });
    }
  });

  try {
    emitStatus("Reconnecting so Grok can wait for your choice…");
    const init = await client.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "grok-desktop", version: "0.1.0" },
      clientCapabilities: {},
    });
    const methodId = pickAuthMethod(init);
    if (!methodId) {
      throw new Error("Run Sign in with Grok first, or set XAI_API_KEY.");
    }
    await client.request("authenticate", { methodId, _meta: { headless: true } });

    const caps = (init && init.agentCapabilities) || {};
    const canResume = !!(caps.sessionCapabilities && caps.sessionCapabilities.resume);
    const canLoad = caps.loadSession === true;
    const sessionParams = { sessionId, cwd: cwd || process.cwd(), mcpServers: [] };

    replaying = true;
    if (canResume) {
      await client.request("session/resume", sessionParams, { timeout: 60000 });
    } else if (canLoad) {
      await client.request("session/load", sessionParams, { timeout: 120000 });
    } else {
      throw new Error("This Grok CLI cannot resume a session over ACP.");
    }
    replaying = false;
    client.sessionId = sessionId;

    if (cancelled()) throw new Error("Cancelled");

    emitStatus("Continuing with your choice…");
    const promptText = formatUserAnswersPrompt(answers);
    const result = await client.request(
      "session/prompt",
      {
        sessionId,
        prompt: [{ type: "text", text: promptText }],
      },
      { timeout: 0 }
    );

    if (typeof onEvent === "function") {
      onEvent({
        type: "end",
        sessionId,
        stopReason: (result && result.stopReason) || "end_turn",
      });
    }
    return { ok: true, sessionId, stopReason: result && result.stopReason };
  } finally {
    try {
      client.close();
    } catch {
      /* ignore */
    }
  }
}

module.exports = {
  parseAcpLine,
  mapSessionUpdateToGrokEvent,
  makeQuestionResponse,
  makeQuestionCancelledResponse,
  makePermissionResponse,
  pickPermissionOptionId,
  isAskUserQuestionMethod,
  buildAcpArgs,
  createAcpClient,
  continueSessionWithAnswers,
};
