"use strict";

const { getAccountAccessKey } = require("./grokService");

const TTS_URL = "https://api.x.ai/v1/tts";
const MAX_TTS_CHARS = 2000;
const DEFAULT_VOICE = "rex";
const MIN_TTS_SPEED = 0.7;
const MAX_TTS_SPEED = 1.5;
const DEFAULT_TTS_SPEED = 1;

const TTS_VOICES = [
  { id: "rex", label: "Rex — confident, clear" },
  { id: "altair", label: "Altair — refined, Jarvis-like" },
  { id: "leo", label: "Leo — authoritative" },
  { id: "perseus", label: "Perseus — strong, formal" },
  { id: "lux", label: "Lux — calm, understated" },
  { id: "orion", label: "Orion — cinematic" },
  { id: "ara", label: "Ara — warm" },
  { id: "eve", label: "Eve — upbeat" },
  { id: "sal", label: "Sal — smooth" },
];

const TTS_VOICE_IDS = new Set(TTS_VOICES.map((v) => v.id));

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
  if (TTS_VOICE_IDS.has(raw)) return raw;
  return DEFAULT_VOICE;
}

function clampTtsSpeed(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_TTS_SPEED;
  const clamped = Math.min(MAX_TTS_SPEED, Math.max(MIN_TTS_SPEED, n));
  return Math.round(clamped * 20) / 20;
}

async function synthesizeSpeech({ text, voice, speed, fetchImpl } = {}) {
  const t = String(text || "").trim();
  if (!t) throw ttsError(400, "Text is required", "NO_TEXT");
  if (t.length > MAX_TTS_CHARS) throw ttsError(400, "Text is too long", "TEXT_TOO_LONG");

  const key = getTtsApiKey();
  if (!key) throw ttsError(401, "Not signed in", "NO_KEY");

  const voiceId = normalizeVoice(voice);
  const rate = clampTtsSpeed(speed);
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
        speed: rate,
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
  MIN_TTS_SPEED,
  MAX_TTS_SPEED,
  DEFAULT_TTS_SPEED,
  TTS_VOICES,
  getTtsApiKey,
  normalizeVoice,
  clampTtsSpeed,
  synthesizeSpeech,
  redactSecrets,
};
