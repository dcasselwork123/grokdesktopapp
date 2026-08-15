"use strict";

const { getAccountAccessKey } = require("./grokService");

const STT_URL = "https://api.x.ai/v1/stt";
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MIN_AUDIO_BYTES = 44;

const ALLOWED_MIME = new Map([
  ["audio/wav", "wav"],
  ["audio/wave", "wav"],
  ["audio/x-wav", "wav"],
  ["audio/mpeg", "mp3"],
  ["audio/mp3", "mp3"],
  ["audio/mp4", "mp4"],
  ["audio/m4a", "m4a"],
  ["audio/aac", "aac"],
  ["audio/ogg", "ogg"],
  ["audio/opus", "opus"],
  ["audio/flac", "flac"],
  ["audio/webm", "webm"],
]);

function sttError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function getSttApiKey() {
  const env = process.env.XAI_API_KEY;
  if (typeof env === "string" && env.trim()) return env.trim();
  return getAccountAccessKey();
}

function decodeAudioPayload(data) {
  if (Buffer.isBuffer(data)) return data;
  if (typeof data !== "string" || !data.trim()) {
    throw sttError(400, "Audio is required", "NO_AUDIO");
  }
  let raw = data.trim();
  const comma = raw.indexOf(",");
  if (/^data:/i.test(raw) && comma !== -1) {
    raw = raw.slice(comma + 1);
  }
  const buf = Buffer.from(raw, "base64");
  if (!buf.length) {
    throw sttError(400, "Invalid audio encoding", "BAD_AUDIO");
  }
  return buf;
}

function normalizeAudioMime(mimeType) {
  const raw = String(mimeType || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (!raw) return "audio/wav";
  if (ALLOWED_MIME.has(raw)) return raw;
  throw sttError(400, "Unsupported audio format", "BAD_MIME");
}

function extForMime(mime) {
  return ALLOWED_MIME.get(mime) || "wav";
}

function looksLikeWav(buf) {
  return (
    Buffer.isBuffer(buf) &&
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WAVE"
  );
}

function validateAudioBuffer(buf, mime) {
  if (!buf || !Buffer.isBuffer(buf) || buf.length < MIN_AUDIO_BYTES) {
    throw sttError(400, "Audio is too short", "SHORT_AUDIO");
  }
  if (buf.length > MAX_AUDIO_BYTES) {
    throw sttError(400, "Audio is too long", "AUDIO_TOO_LARGE");
  }
  if (
    mime === "audio/wav" ||
    mime === "audio/wave" ||
    mime === "audio/x-wav"
  ) {
    if (!looksLikeWav(buf)) {
      throw sttError(400, "Audio does not look like a WAV file", "BAD_WAV");
    }
  }
  return buf;
}

function parseSttErrorBody(text, status) {
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const msg =
    (parsed &&
      (parsed.error?.message ||
        (typeof parsed.error === "string" ? parsed.error : null) ||
        parsed.message)) ||
    `Speech-to-text failed (${status})`;
  return { parsed, message: String(msg) };
}

async function transcribeAudio({
  data,
  mimeType,
  language = "en",
  fetchImpl = fetch,
  apiKey,
} = {}) {
  const key = apiKey !== undefined ? apiKey : getSttApiKey();
  if (!key) {
    throw sttError(401, "Sign in required for voice input", "NO_KEY");
  }

  const mime = normalizeAudioMime(mimeType);
  const buf = validateAudioBuffer(decodeAudioPayload(data), mime);

  const form = new FormData();
  form.append("format", "true");
  if (language) form.append("language", String(language));
  form.append(
    "file",
    new Blob([buf], { type: mime }),
    `dictation.${extForMime(mime)}`
  );

  const headers = {
    Authorization: `Bearer ${key}`,
  };
  if (!process.env.XAI_API_KEY) {
    headers["X-XAI-Token-Auth"] = "xai-grok-cli";
  }

  let res;
  try {
    res = await fetchImpl(STT_URL, {
      method: "POST",
      headers,
      body: form,
    });
  } catch (err) {
    throw sttError(
      502,
      err && err.message ? String(err.message) : "Speech-to-text unreachable",
      "STT_NETWORK"
    );
  }

  const bodyText = await res.text();
  const { parsed, message } = parseSttErrorBody(bodyText, res.status);

  if (!res.ok) {
    if (res.status === 401) {
      throw sttError(
        401,
        "Voice sign-in expired. Send a chat or sign in again.",
        "STT_UNAUTHORIZED"
      );
    }
    if (res.status === 429) {
      throw sttError(
        429,
        "Voice is rate-limited. Try again in a moment.",
        "STT_RATE_LIMIT"
      );
    }
    const status = res.status >= 400 && res.status < 600 ? res.status : 502;
    throw sttError(status, message, "STT_FAILED");
  }

  const transcript =
    parsed && typeof parsed.text === "string" ? parsed.text.trim() : "";
  return {
    text: transcript,
    language:
      parsed && typeof parsed.language === "string" ? parsed.language : null,
    duration:
      parsed && Number.isFinite(Number(parsed.duration))
        ? Number(parsed.duration)
        : null,
  };
}

module.exports = {
  STT_URL,
  MAX_AUDIO_BYTES,
  decodeAudioPayload,
  normalizeAudioMime,
  looksLikeWav,
  validateAudioBuffer,
  getSttApiKey,
  transcribeAudio,
};
