"use strict";

const ASK_NAME = "ask_user_question";
const ASK_NAME_ALIASES = new Set([
  ASK_NAME,
  "askuserquestion",
  "ask-user-question",
]);
const MAX_QUESTIONS = 12;
const MAX_OPTIONS = 12;
const MAX_TEXT = 4000;

function clipText(value, max = MAX_TEXT) {
  if (value == null) return "";
  const s = String(value).replace(/\s+/g, " ").trim();
  if (!s) return "";
  return s.length > max ? s.slice(0, max) : s;
}

function unwrapEvt(evt) {
  if (!evt || typeof evt !== "object") return null;
  if (evt.params && evt.params.update) return evt.params.update;
  if (evt.update && typeof evt.update === "object") return evt.update;
  return evt;
}

function toolNameOf(src) {
  if (!src || typeof src !== "object") return "";
  const meta = src._meta && src._meta["x.ai/tool"];
  return (
    src.toolName ||
    src.name ||
    src.kind ||
    (meta && meta.name) ||
    ""
  );
}

function isAskUserQuestionName(name) {
  const key = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (!key) return false;
  if (ASK_NAME_ALIASES.has(key) || ASK_NAME_ALIASES.has(key.replace(/_/g, ""))) {
    return true;
  }
  return key === ASK_NAME;
}

function parseMaybeJson(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!s || (s[0] !== "{" && s[0] !== "[")) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function looksLikeQuestion(q) {
  if (!q || typeof q !== "object" || Array.isArray(q)) return false;
  return !!(q.question || q.prompt || q.text || q.options || q.choices);
}

function normalizeOption(raw, index) {
  if (raw == null) return null;
  if (typeof raw === "string") {
    const label = clipText(raw, 200);
    if (!label) return null;
    return {
      label,
      description: "",
      preview: "",
      isOther: isOtherLabel(label),
    };
  }
  if (typeof raw !== "object") return null;
  const label = clipText(
    raw.label || raw.title || raw.value || raw.text || `Option ${index + 1}`,
    200
  );
  if (!label) return null;
  const previewRaw = raw.preview;
  const preview =
    previewRaw == null
      ? ""
      : typeof previewRaw === "string"
        ? clipText(previewRaw, 500)
        : clipText(JSON.stringify(previewRaw), 500);
  return {
    label,
    description: clipText(raw.description || raw.detail || raw.hint || "", 500),
    preview,
    isOther: !!(raw.isOther || raw.other || isOtherLabel(label)),
  };
}

function isOtherLabel(label) {
  return /^(other|other…|other\.\.\.)(\b|$)/i.test(String(label || "").trim());
}

function ensureOtherOption(options) {
  const list = Array.isArray(options) ? options.slice() : [];
  if (list.some((o) => o && o.isOther)) return list;
  list.push({
    label: "Other…",
    description: "Type your own answer",
    preview: "",
    isOther: true,
  });
  return list;
}

function normalizeQuestion(raw, index) {
  if (typeof raw === "string") {
    const question = clipText(raw, 800);
    if (!question) return null;
    return {
      question,
      options: ensureOtherOption([]),
      multiSelect: false,
    };
  }
  if (!looksLikeQuestion(raw)) return null;
  const question = clipText(
    raw.question || raw.prompt || raw.text || `Question ${index + 1}`,
    800
  );
  if (!question) return null;
  const rawOpts = raw.options || raw.choices || raw.answers || [];
  const options = [];
  if (Array.isArray(rawOpts)) {
    for (let i = 0; i < rawOpts.length && options.length < MAX_OPTIONS; i++) {
      const opt = normalizeOption(rawOpts[i], i);
      if (opt) options.push(opt);
    }
  }
  const multiSelect = !!(raw.multi_select || raw.multiSelect || raw.multiple);
  return {
    question,
    options: ensureOtherOption(options),
    multiSelect,
  };
}

function normalizeQuestions(rawList) {
  if (!Array.isArray(rawList)) return [];
  const out = [];
  for (let i = 0; i < rawList.length && out.length < MAX_QUESTIONS; i++) {
    const q = normalizeQuestion(rawList[i], i);
    if (q) out.push(q);
  }
  return out;
}

function findQuestionsArray(value, depth = 0) {
  if (value == null || depth > 6) return null;
  if (typeof value === "string") {
    return findQuestionsArray(parseMaybeJson(value), depth + 1);
  }
  if (Array.isArray(value)) {
    if (value.length && value.every((item) => looksLikeQuestion(item) || typeof item === "string")) {
      return value;
    }
    for (const item of value) {
      const found = findQuestionsArray(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  if (Array.isArray(value.questions)) return value.questions;
  if (typeof value.questions === "string") {
    const parsed = parseMaybeJson(value.questions);
    if (Array.isArray(parsed)) return parsed;
  }
  for (const key of [
    "rawInput",
    "raw_input",
    "input",
    "arguments",
    "params",
    "content",
    "data",
  ]) {
    if (value[key] != null) {
      const found = findQuestionsArray(value[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function toolCallIdOf(evt, root) {
  return (
    (evt && (evt.toolCallId || evt.tool_call_id || evt.id)) ||
    (root && (root.toolCallId || root.tool_call_id || root.id)) ||
    null
  );
}

/**
 * Pull a normalized ask from a live grok event, an updates.jsonl
 * session/update, or a restored tool entry.
 * @returns {{ id: string|null, questions: object[], name: string } | null}
 */
function extractAskUserQuestions(evt) {
  if (!evt || typeof evt !== "object") return null;
  const root = unwrapEvt(evt) || evt;
  const name = toolNameOf(evt) || toolNameOf(root);
  const titled = String((evt && evt.title) || (root && root.title) || "");
  const named = isAskUserQuestionName(name) || isAskUserQuestionName(titled);

  let rawQuestions = null;
  if (Array.isArray(evt.questions) && evt.questions.length) {
    rawQuestions = evt.questions;
  } else if (Array.isArray(root.questions) && root.questions.length) {
    rawQuestions = root.questions;
  } else {
    rawQuestions = findQuestionsArray(evt) || findQuestionsArray(root);
  }

  const questions = normalizeQuestions(rawQuestions || []);
  if (!questions.length) {
    if (named) return { id: toolCallIdOf(evt, root), questions: [], name: ASK_NAME };
    return null;
  }
  if (!named && !questions.some((q) => q.options && q.options.length)) {
    return null;
  }
  return {
    id: toolCallIdOf(evt, root),
    questions,
    name: ASK_NAME,
  };
}

function formatUserAnswersPrompt(pairs, { override = false } = {}) {
  const list = Array.isArray(pairs) ? pairs : [];
  const lines = ["<user_answers>"];
  for (const pair of list) {
    const question = clipText(pair && pair.question, 800);
    const answer = clipText(pair && (pair.answer || pair.label), 800);
    if (!question && !answer) continue;
    lines.push(`Question: ${question || "Question"}`);
    lines.push(`Answer: ${answer || ""}`);
  }
  lines.push("</user_answers>");
  const block = lines.join("\n");
  if (override) {
    return `Use this choice instead of any earlier pick.\n\n${block}`;
  }
  return block;
}

function parseUserAnswersBlock(text) {
  const raw = String(text || "");
  if (!/<user_answers>/i.test(raw)) return null;
  const m = raw.match(/<user_answers>\s*([\s\S]*?)\s*<\/user_answers>/i);
  if (!m) return null;
  const body = m[1];
  const pairs = [];
  const re = /Question:\s*(.*?)\s*\r?\nAnswer:\s*(.*?)(?=\r?\nQuestion:|$)/gis;
  let match;
  while ((match = re.exec(body))) {
    const question = clipText(match[1], 800);
    const answer = clipText(match[2], 800);
    if (!question && !answer) continue;
    pairs.push({ question, answer });
  }
  return pairs.length ? pairs : null;
}

function isAnswersOnlyUserText(text) {
  const raw = String(text || "").trim();
  if (!raw || !/<user_answers>/i.test(raw)) return false;
  const stripped = raw
    .replace(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/gi, "$1")
    .replace(/<user_answers>[\s\S]*?<\/user_answers>/gi, "")
    .replace(/Use this choice instead of any earlier pick\.?/gi, "")
    .trim();
  return !stripped;
}

function answersMapFromPairs(pairs) {
  const map = {};
  for (const pair of Array.isArray(pairs) ? pairs : []) {
    const question = clipText(pair && pair.question, 800);
    const answer = clipText(pair && (pair.answer || pair.label), 800);
    if (!question) continue;
    map[question] = answer;
  }
  return map;
}

function askStatusKey(evt) {
  return String((evt && evt.status) || "")
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function isFinishedAskStatus(status) {
  const key = String(status || "")
    .toLowerCase()
    .replace(/\s+/g, "_");
  return [
    "completed",
    "complete",
    "success",
    "done",
    "ok",
    "failed",
    "error",
    "errored",
    "cancelled",
    "canceled",
  ].includes(key);
}

/** Park -p only when the ask is live (has questions and has not finished). */
function shouldParkForAsk(evt, ask) {
  if (!ask || !Array.isArray(ask.questions) || !ask.questions.length) return false;
  return !isFinishedAskStatus(askStatusKey(evt));
}

function applyAnswersToAsk(entry, pairs) {
  if (!entry || !pairs || !pairs.length) return entry;
  entry.answers = pairs.map((p) => ({
    question: clipText(p.question, 800),
    answer: clipText(p.answer || p.label, 800),
  }));
  return entry;
}

function rememberAskOnRun(record, evt) {
  const ask = extractAskUserQuestions(evt);
  if (!ask || !record) return ask;
  if (!Array.isArray(record.asks)) record.asks = [];
  const idx = record.asks.findIndex((a) => a.id && ask.id && a.id === ask.id);
  if (idx >= 0) {
    const prev = record.asks[idx];
    record.asks[idx] = {
      ...prev,
      ...ask,
      questions: ask.questions.length ? ask.questions : prev.questions || [],
    };
  } else {
    record.asks.push(ask);
  }
  return ask;
}

function pendingAsksOf(record) {
  if (!record || !Array.isArray(record.asks)) return [];
  return record.asks.filter((a) => a && a.questions && a.questions.length && !a.answers);
}

function markAskAnsweredOnRun(record, id, pairs) {
  if (!record || !Array.isArray(record.asks)) return;
  const ask = record.asks.find((a) => a && a.id === id);
  if (ask) applyAnswersToAsk(ask, pairs);
}

module.exports = {
  ASK_NAME,
  MAX_QUESTIONS,
  MAX_OPTIONS,
  isAskUserQuestionName,
  extractAskUserQuestions,
  normalizeQuestions,
  normalizeQuestion,
  ensureOtherOption,
  formatUserAnswersPrompt,
  parseUserAnswersBlock,
  isAnswersOnlyUserText,
  applyAnswersToAsk,
  answersMapFromPairs,
  shouldParkForAsk,
  isFinishedAskStatus,
  rememberAskOnRun,
  pendingAsksOf,
  markAskAnsweredOnRun,
};
