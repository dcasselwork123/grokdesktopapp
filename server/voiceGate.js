"use strict";

const crypto = require("crypto");

const PLAN_TOOLS = "read_file,list_dir,grep,web_search,todo_write";
const ARM_TTL_MS = 30 * 1000;

const PLANNING_WRAPPER =
  "[Voice planning mode — read-only]\n" +
  "You may inspect this project (read, list, search). You cannot edit files or run commands; those tools are disabled.\n" +
  "Keep spoken answers short. Address the user as sir when it fits naturally, not every sentence.\n" +
  "When you have a concrete plan, ask whether they would like you to build it.\n" +
  "Do not claim you already changed files.\n" +
  "\n" +
  "User:\n";

const BUILD_WRAPPER =
  "[Voice build mode — approved]\n" +
  "The user confirmed. Implement the plan you just discussed in this session.\n" +
  "Start your reply with:\n" +
  "SPEAK: <two to four sentences summarizing what you are about to do / just did>\n" +
  "Then write the usual detailed recap on screen. Do not put code in the SPEAK line.\n" +
  "\n" +
  "User confirmed. Build this now.\n";

const BUILD_EXACT = new Set([
  "go ahead",
  "go ahead and build",
  "go ahead and build this",
  "go ahead and build it",
  "go ahead and build this now",
  "go ahead and build it now",
  "build it",
  "build this",
  "build this now",
  "build it now",
  "make it so",
  "ship it",
  "do it",
  "execute",
  "lets build",
  "let us build",
  "yes build",
  "implement it",
  "implement this",
  "proceed",
]);

const CONFIRM_YES_EXACT = new Set([
  "yes",
  "y",
  "yeah",
  "yep",
  "confirm",
  "do it",
  "build",
  "ok",
  "okay",
  "yes please",
  "yes build",
]);

const CONFIRM_NO_EXACT = new Set([
  "no",
  "nope",
  "not yet",
  "wait",
  "cancel",
  "keep planning",
  "dont",
  "do not",
  "stop",
  "dont build",
  "do not build",
]);

const arms = new Map();

function normalizeIntent(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isBlockedBuildPhrase(n) {
  if (!n) return true;
  if (n.startsWith("what should i build")) return true;
  if (n.startsWith("go ahead and tell")) return true;
  if (n.startsWith("go ahead and explain")) return true;
  if (/\btell me more\b/.test(n)) return true;
  if (/\bdont build\b/.test(n) || /\bdo not build\b/.test(n)) return true;
  return false;
}

function isBuildIntent(text) {
  const n = normalizeIntent(text);
  if (!n || isBlockedBuildPhrase(n)) return false;
  return BUILD_EXACT.has(n);
}

function isConfirmYes(text) {
  const n = normalizeIntent(text);
  if (!n || isBlockedBuildPhrase(n)) return false;
  return CONFIRM_YES_EXACT.has(n) || BUILD_EXACT.has(n);
}

function isConfirmNo(text) {
  const n = normalizeIntent(text);
  if (!n) return false;
  return CONFIRM_NO_EXACT.has(n);
}

function looksLikeBuildAsk(text) {
  const n = normalizeIntent(text);
  if (!n) return false;
  return /\b(build|implement|shall i)\b/.test(n);
}

function createArmToken(sessionId, { now = Date.now(), ttlMs = ARM_TTL_MS } = {}) {
  const sid = String(sessionId || "").trim();
  if (!sid) {
    const err = new Error("sessionId is required");
    err.status = 400;
    err.code = "NO_SESSION";
    throw err;
  }
  const token = crypto.randomBytes(24).toString("hex");
  const expiresAt = now + ttlMs;
  arms.set(token, { sessionId: sid, expiresAt });
  return { token, expiresAt };
}

function consumeArmToken(token, sessionId, { now = Date.now() } = {}) {
  const t = String(token || "").trim();
  const sid = String(sessionId || "").trim();
  if (!t || !sid) return false;
  const rec = arms.get(t);
  if (!rec) return false;
  arms.delete(t);
  if (rec.sessionId !== sid) return false;
  if (now >= rec.expiresAt) return false;
  return true;
}

function clearArmTokens() {
  arms.clear();
}

function appendVoiceSpawnArgs(args, voiceTurn) {
  if (!Array.isArray(args)) {
    throw new Error("args must be an array");
  }
  if (voiceTurn == null || voiceTurn === "") return args;
  if (voiceTurn === "build") return args;
  if (voiceTurn === "plan") {
    args.push("--tools", PLAN_TOOLS, "--no-subagents", "--sandbox", "read-only");
    return args;
  }
  throw new Error(`Unknown voiceTurn: ${voiceTurn}`);
}

function wrapVoicePrompt(prompt, voiceTurn) {
  const text = String(prompt || "");
  if (voiceTurn === "plan") return PLANNING_WRAPPER + text;
  if (voiceTurn === "build") return BUILD_WRAPPER + (text ? `\nUser:\n${text}` : "");
  if (voiceTurn == null || voiceTurn === "") return text;
  throw new Error(`Unknown voiceTurn: ${voiceTurn}`);
}

function extractSpeakBlock(fullText) {
  const raw = String(fullText || "").replace(/\r\n/g, "\n");
  const lines = raw.split("\n");
  const start = lines.findIndex((line) => /^\s*SPEAK:\s*/i.test(line));
  if (start !== -1) {
    const first = lines[start].replace(/^\s*SPEAK:\s*/i, "");
    const parts = [];
    if (first.trim()) parts.push(first.trim());
    for (let i = start + 1; i < lines.length; i++) {
      if (!lines[i].trim()) break;
      if (/^\s*```/.test(lines[i])) break;
      parts.push(lines[i].trim());
    }
    const joined = parts.join(" ").trim();
    if (joined) return joined;
  }
  const stripped = raw
    .replace(/^\s*#{1,6}\s+.+$/gm, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return "";
  const sentences = stripped.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [stripped];
  return sentences
    .slice(0, 3)
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

module.exports = {
  PLAN_TOOLS,
  ARM_TTL_MS,
  PLANNING_WRAPPER,
  BUILD_WRAPPER,
  normalizeIntent,
  isBuildIntent,
  isConfirmYes,
  isConfirmNo,
  looksLikeBuildAsk,
  createArmToken,
  consumeArmToken,
  clearArmTokens,
  appendVoiceSpawnArgs,
  wrapVoicePrompt,
  extractSpeakBlock,
};
