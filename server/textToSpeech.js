"use strict";

const { getAccountAccessKey } = require("./grokService");

const TTS_URL = "https://api.x.ai/v1/tts";
const MAX_TTS_CHARS = 2000;
const DEFAULT_VOICE = "rex";

function ttsError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function getTtsApiKey() {
  const env = process.env.XAI_API_KEY;
  if (typeof env === "string" && env.trim()) return env.trim();
  return getAccountAccessKey();
}

function redactSecrets(text, key) {
  let out = String(text || "");
  if (key) out = out.split(key).join("[redacted]");
  return out;
}

function normalizeVoice(voice) {
  const raw = String(voice || DEFAULT_VOICE).trim().toLowerCase();
  return raw || DEFAULT_VOICE;
}

async function synthesizeSpeech({ text, voice, fetchImpl } = {}) {
  const t = String(text || "").trim();
  if (!t) throw ttsError(400, "Text is required", "NO_TEXT");
  if (t.length > MAX_TTS_CHARS) throw ttsError(400, "Text is too long", "TEXT_TOO_LONG");

  const key = getTtsApiKey();
  if (!key) throw ttsError(401, "Not signed in", "NO_KEY");

  const voiceId = normalizeVoice(voice);
  const fetchFn = fetchImpl || fetch;
  let res;
  try {
    res = await fetchFn(TTS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: t,
        voice_id: voiceId,
        language: "en",
      }),
    });
  } catch (err) {
    throw ttsError(502, "Speech failed", "TTS_NETWORK");
  }

  if (!res.ok) {
    let detail = "";
    try {
      detail = typeof res.text === "function" ? await res.text() : "";
    } catch {
      detail = "";
    }
    const safe = redactSecrets(detail, key);
    const status = res.status === 401 || res.status === 403 ? 401 : 502;
    const msg =
      status === 401 ? "Not signed in" : "Speech failed";
    const err = ttsError(status, msg, status === 401 ? "NO_KEY" : "TTS_FAILED");
    err.detail = safe.slice(0, 200);
    throw err;
  }

  const buf =
    typeof res.arrayBuffer === "function"
      ? Buffer.from(await res.arrayBuffer())
      : Buffer.isBuffer(res.body)
        ? res.body
        : Buffer.from(res.body || []);
  const contentType =
    (res.headers && typeof res.headers.get === "function"
      ? res.headers.get("content-type")
      : "") || "audio/mpeg";
  return { audio: buf, contentType: contentType.split(";")[0].trim() || "audio/mpeg" };
}

module.exports = {
  TTS_URL,
  MAX_TTS_CHARS,
  DEFAULT_VOICE,
  getTtsApiKey,
  synthesizeSpeech,
  redactSecrets,
};
