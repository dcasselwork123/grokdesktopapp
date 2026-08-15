"use strict";

const assert = require("assert");
const {
  decodeAudioPayload,
  normalizeAudioMime,
  looksLikeWav,
  validateAudioBuffer,
  transcribeAudio,
} = require("./speechToText");

let failed = 0;

function test(name, fn) {
  const run = Promise.resolve().then(fn);
  return run.then(
    () => {
      console.log("ok -", name);
    },
    (err) => {
      failed += 1;
      console.error("not ok -", name);
      console.error(err);
    }
  );
}

function makeWav(seconds = 0.2, sampleRate = 16000) {
  const n = Math.floor(seconds * sampleRate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  return buf;
}

async function main() {
  await test("decodeAudioPayload accepts raw base64", () => {
    const wav = makeWav();
    const out = decodeAudioPayload(wav.toString("base64"));
    assert.ok(Buffer.isBuffer(out));
    assert.strictEqual(out.length, wav.length);
    assert.ok(looksLikeWav(out));
  });

  await test("decodeAudioPayload accepts data URLs", () => {
    const wav = makeWav();
    const out = decodeAudioPayload(
      `data:audio/wav;base64,${wav.toString("base64")}`
    );
    assert.ok(looksLikeWav(out));
  });

  await test("decodeAudioPayload rejects empty input", () => {
    assert.throws(() => decodeAudioPayload(""), (err) => err.code === "NO_AUDIO");
  });

  await test("normalizeAudioMime accepts wav aliases and strips codec", () => {
    assert.strictEqual(normalizeAudioMime("audio/wav;codecs=1"), "audio/wav");
    assert.strictEqual(normalizeAudioMime("AUDIO/X-WAV"), "audio/x-wav");
    assert.strictEqual(normalizeAudioMime(""), "audio/wav");
  });

  await test("normalizeAudioMime rejects unknown types", () => {
    assert.throws(
      () => normalizeAudioMime("video/mp4"),
      (err) => err.code === "BAD_MIME"
    );
  });

  await test("validateAudioBuffer rejects junk labeled as wav", () => {
    const junk = Buffer.alloc(80, 7);
    assert.throws(
      () => validateAudioBuffer(junk, "audio/wav"),
      (err) => err.code === "BAD_WAV"
    );
  });

  await test("validateAudioBuffer accepts a real WAV", () => {
    const wav = makeWav();
    const out = validateAudioBuffer(wav, "audio/wav");
    assert.strictEqual(out, wav);
  });

  await test("transcribeAudio posts multipart and returns text", async () => {
    const wav = makeWav();
    let sawAuth = false;
    let sawFile = false;
    const fetchImpl = async (_url, opts) => {
      sawAuth = !!(opts && opts.headers && opts.headers.Authorization);
      const body = opts && opts.body;
      sawFile = !!(body && typeof body.has === "function" && body.has("file"));
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            text: "  hello from grok  ",
            language: "en",
            duration: 0.4,
          });
        },
      };
    };
    const result = await transcribeAudio({
      data: wav.toString("base64"),
      mimeType: "audio/wav",
      apiKey: "test-key",
      fetchImpl,
    });
    assert.strictEqual(result.text, "hello from grok");
    assert.strictEqual(result.language, "en");
    assert.strictEqual(result.duration, 0.4);
    assert.ok(sawAuth);
    assert.ok(sawFile);
  });

  await test("transcribeAudio maps 401 to a sign-in message", async () => {
    const wav = makeWav();
    const fetchImpl = async () => ({
      ok: false,
      status: 401,
      async text() {
        return JSON.stringify({ error: { message: "unauthorized" } });
      },
    });
    await assert.rejects(
      () =>
        transcribeAudio({
          data: wav.toString("base64"),
          mimeType: "audio/wav",
          apiKey: "expired",
          fetchImpl,
        }),
      (err) => err.code === "STT_UNAUTHORIZED" && err.status === 401
    );
  });

  await test("transcribeAudio requires a key", async () => {
    const prev = process.env.XAI_API_KEY;
    delete process.env.XAI_API_KEY;
    try {
      await assert.rejects(
        () =>
          transcribeAudio({
            data: makeWav().toString("base64"),
            mimeType: "audio/wav",
            apiKey: "",
            fetchImpl: async () => {
              throw new Error("should not fetch");
            },
          }),
        (err) => err.code === "NO_KEY"
      );
    } finally {
      if (prev !== undefined) process.env.XAI_API_KEY = prev;
    }
  });

  if (failed) {
    console.error(`\n${failed} failed`);
    process.exit(1);
  }
  console.log("all tests passed");
}

main();
