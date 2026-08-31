"use strict";

const { getAccountAccessKey } = require("./grokService");

const STT_URL = "https://api.x.ai/v1/stt";
const STT_WS_URL = "wss://api.x.ai/v1/stt";
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
  ["audio/x-m4a", "m4a"],
  ["audio/aac", "aac"],
  ["video/mp4", "mp4"],
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

function buildSttWsUrl({ sampleRate = 16000, language = "en" } = {}) {
  const u = new URL(STT_WS_URL);
  u.searchParams.set("sample_rate", String(sampleRate));
  u.searchParams.set("encoding", "pcm");
  u.searchParams.set("interim_results", "true");
  // Dictation: hold through mid-sentence pauses; don't cut on a 10ms gap.
  u.searchParams.set("smart_turn", "0.7");
  u.searchParams.set("smart_turn_timeout", "3000");
  u.searchParams.set("endpointing", "400");
  u.searchParams.set("vad_threshold", "0.05");
  if (language) u.searchParams.set("language", String(language));
  return u.toString();
}

function getWebSocketImpl(override) {
  if (override) return override;
  if (typeof WebSocket === "function") return WebSocket;
  try {
    const undici = require("undici");
    if (undici && typeof undici.WebSocket === "function") return undici.WebSocket;
  } catch {
    /* optional */
  }
  return null;
}

function normalizePhrase(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function wordsOf(s) {
  return normalizePhrase(s).split(" ").filter(Boolean);
}

function containsWords(hay, needle) {
  const h = wordsOf(hay).join(" ").toLowerCase();
  const n = wordsOf(needle).join(" ").toLowerCase();
  if (!n) return true;
  if (!h) return false;
  return ` ${h} `.includes(` ${n} `);
}

/**
 * Join two phrases, collapsing a repeated tail/head instead of doubling.
 */
function mergeOverlap(prev, next) {
  const a = normalizePhrase(prev);
  const b = normalizePhrase(next);
  if (!b) return a;
  if (!a) return b;
  if (a === b) return b;
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  if (bl.startsWith(al) || bl.endsWith(al)) return b;
  if (al.startsWith(bl) || al.endsWith(bl)) return a;

  const aw = wordsOf(a);
  const bw = wordsOf(b);
  const max = Math.min(aw.length, bw.length);
  for (let n = max; n > 0; n--) {
    const tail = aw.slice(-n).join(" ").toLowerCase();
    const head = bw.slice(0, n).join(" ").toLowerCase();
    if (tail === head) return aw.concat(bw.slice(n)).join(" ");
  }
  return `${a} ${b}`;
}

/** Prefer the longer phrase when one already contains the other. Never shrink. */
function pickBetter(prev, next) {
  const a = normalizePhrase(prev);
  const b = normalizePhrase(next);
  if (!b) return a;
  if (!a) return b;
  if (a === b) return b;
  if (containsWords(b, a)) return b;
  if (containsWords(a, b)) return a;
  return mergeOverlap(a, b);
}

function emptyLiveState() {
  return { finals: [], committed: "", interim: "" };
}

function foldPhrases(parts) {
  let acc = "";
  for (const part of parts || []) {
    const p = normalizePhrase(part);
    if (!p) continue;
    acc = pickBetter(acc, p);
  }
  return acc;
}

/** After a pause the STT often restates prior sentences; don't append a copy. */
function commitSpeechFinal(finals, utterance) {
  const next = normalizePhrase(utterance);
  if (!next) return finals;
  const prior = foldPhrases(finals);
  if (!prior) return [next];
  if (containsWords(next, prior)) return [next];
  if (containsWords(prior, next)) return finals;
  return finals.concat(next);
}

function liveTranscriptText(state) {
  const src = state || emptyLiveState();
  const committed = normalizePhrase(src.committed);
  const interim = normalizePhrase(src.interim);
  let current = committed;
  if (interim) {
    if (!committed) current = interim;
    else if (
      containsWords(interim, committed) ||
      interim.toLowerCase().startsWith(committed.toLowerCase())
    ) {
      current = pickBetter(committed, interim);
    } else {
      current = mergeOverlap(committed, interim);
    }
  }
  return foldPhrases([...(src.finals || []), current]);
}

/**
 * Assemble Grok streaming events:
 * - interim (!is_final): replace the unstable hypothesis only
 * - chunk final (is_final && !speech_final): lock that slice
 * - utterance final (speech_final): commit the stitched utterance
 */
function applyLiveTranscript(state, event) {
  const prev = state || emptyLiveState();
  const next = normalizePhrase(event && event.text);
  const finals = Array.isArray(prev.finals) ? prev.finals.slice() : [];
  let committed = prev.committed || "";
  let interim = prev.interim || "";

  if (event && event.speech_final) {
    const current = pickBetter(committed, interim);
    const utterance = next ? pickBetter(current, next) : current;
    return { finals: commitSpeechFinal(finals, utterance), committed: "", interim: "" };
  }

  if (event && event.is_final) {
    return { finals, committed: pickBetter(committed, next), interim: "" };
  }

  return { finals, committed, interim: next };
}

/** @deprecated overlap-safe join; prefer applyLiveTranscript for live streams */
function mergeTranscript(prev, next) {
  return pickBetter(prev, next);
}

function decodePcmPayload(data) {
  const buf = Buffer.isBuffer(data) ? data : decodeAudioPayload(data);
  if (!buf.length || buf.length % 2 !== 0) {
    throw sttError(400, "Invalid PCM audio", "BAD_PCM");
  }
  if (buf.length > MAX_AUDIO_BYTES) {
    throw sttError(400, "Audio is too long", "AUDIO_TOO_LARGE");
  }
  return buf;
}

function createLiveTranscriber({
  language = "en",
  apiKey,
  WebSocketImpl,
  onPartial,
  onError,
  onDone,
} = {}) {
  const key = apiKey !== undefined ? apiKey : getSttApiKey();
  if (!key) {
    throw sttError(401, "Sign in required for voice input", "NO_KEY");
  }
  const WS = getWebSocketImpl(WebSocketImpl);
  if (!WS) {
    throw sttError(
      501,
      "Live transcription needs Electron or Node 22+.",
      "NO_WS"
    );
  }

  const headers = { Authorization: `Bearer ${key}` };
  if (!process.env.XAI_API_KEY) {
    headers["X-XAI-Token-Auth"] = "xai-grok-cli";
  }

  let live = emptyLiveState();
  let ready = false;
  let closed = false;
  let finishSent = false;
  const queue = [];
  const readyWaiters = [];
  const finishWaiters = [];

  function settleReady(err) {
    while (readyWaiters.length) {
      const { resolve, reject } = readyWaiters.shift();
      if (err) reject(err);
      else resolve();
    }
  }

  function currentText() {
    return liveTranscriptText(live);
  }

  function settleFinish() {
    const finalText = currentText();
    while (finishWaiters.length) {
      finishWaiters.shift()(finalText);
    }
    if (typeof onDone === "function") {
      try {
        onDone({ text: finalText });
      } catch {
        /* ignore */
      }
    }
  }

  function emitPartial() {
    if (typeof onPartial === "function") {
      try {
        onPartial({ text: currentText() });
      } catch {
        /* ignore */
      }
    }
  }

  function flushQueue() {
    while (queue.length && ready && !closed) {
      const chunk = queue.shift();
      try {
        ws.send(chunk);
      } catch {
        /* ignore */
      }
    }
  }

  const ws = new WS(buildSttWsUrl({ language }), { headers });

  function handlePayload(raw) {
    if (closed) return;
    let event = raw;
    if (typeof raw === "string" || Buffer.isBuffer(raw)) {
      try {
        event = JSON.parse(raw.toString());
      } catch {
        return;
      }
    }
    if (!event || typeof event !== "object") return;

    if (event.type === "transcript.created") {
      ready = true;
      flushQueue();
      settleReady(null);
      return;
    }
    if (event.type === "transcript.partial") {
      live = applyLiveTranscript(live, event);
      emitPartial();
      return;
    }
    if (event.type === "transcript.done") {
      const doneText = normalizePhrase(event.text);
      if (doneText) {
        live = {
          finals: [pickBetter(currentText(), doneText)].filter(Boolean),
          committed: "",
          interim: "",
        };
        emitPartial();
      }
      close();
      return;
    }
    if (event.type === "error") {
      const err = sttError(
        502,
        event.message || "Speech stream error",
        "STT_STREAM"
      );
      if (typeof onError === "function") {
        try {
          onError(err);
        } catch {
          /* ignore */
        }
      }
      if (!ready) settleReady(err);
    }
  }

  if (typeof ws.addEventListener === "function") {
    ws.addEventListener("message", (ev) => handlePayload(ev && ev.data));
    ws.addEventListener("error", () => {
      if (closed) return;
      const err = sttError(502, "Speech stream failed", "STT_STREAM");
      if (!ready) settleReady(err);
      else if (typeof onError === "function") {
        try {
          onError(err);
        } catch {
          /* ignore */
        }
      }
    });
    ws.addEventListener("close", () => {
      if (!closed) close();
    });
  } else {
    ws.onmessage = (ev) => handlePayload(ev && ev.data);
    ws.onerror = () => {
      const err = sttError(502, "Speech stream failed", "STT_STREAM");
      if (!ready) settleReady(err);
    };
    ws.onclose = () => {
      if (!closed) close();
    };
  }

  function sendPcm(data) {
    if (closed) return;
    const buf = decodePcmPayload(data);
    if (ready) {
      try {
        ws.send(buf);
      } catch {
        /* ignore */
      }
      return;
    }
    const queued = queue.reduce((n, c) => n + (c.length || 0), 0);
    if (queued + buf.length > MAX_AUDIO_BYTES) {
      throw sttError(400, "Audio is too long", "AUDIO_TOO_LARGE");
    }
    queue.push(buf);
  }

  function whenReady({ timeoutMs = 8000 } = {}) {
    if (ready) return Promise.resolve();
    if (closed) {
      return Promise.reject(sttError(502, "Speech stream closed", "STT_STREAM"));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(sttError(504, "Speech stream timed out", "STT_TIMEOUT"));
      }, timeoutMs);
      readyWaiters.push({
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  function finish({ timeoutMs = 8000 } = {}) {
    if (closed) return Promise.resolve(currentText());
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        close();
        resolve(currentText());
      }, timeoutMs);
      finishWaiters.push((finalText) => {
        clearTimeout(timer);
        resolve(finalText);
      });
      if (finishSent) return;
      finishSent = true;
      const sendDone = () => {
        try {
          ws.send(JSON.stringify({ type: "audio.done" }));
        } catch {
          /* ignore */
        }
      };
      if (ready) sendDone();
      else {
        whenReady({ timeoutMs: Math.min(timeoutMs, 4000) })
          .then(sendDone)
          .catch(() => {
            close();
            resolve(currentText());
          });
      }
    });
  }

  function close() {
    if (closed) return;
    closed = true;
    queue.length = 0;
    if (!ready) {
      settleReady(sttError(502, "Speech stream closed", "STT_STREAM"));
    }
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    settleFinish();
  }

  return {
    sendPcm,
    finish,
    close,
    whenReady,
    getText: () => currentText(),
    get ready() {
      return ready;
    },
    get closed() {
      return closed;
    },
  };
}

module.exports = {
  STT_URL,
  STT_WS_URL,
  MAX_AUDIO_BYTES,
  decodeAudioPayload,
  decodePcmPayload,
  normalizeAudioMime,
  looksLikeWav,
  validateAudioBuffer,
  getSttApiKey,
  transcribeAudio,
  mergeTranscript,
  mergeOverlap,
  pickBetter,
  applyLiveTranscript,
  liveTranscriptText,
  emptyLiveState,
  buildSttWsUrl,
  createLiveTranscriber,
};
