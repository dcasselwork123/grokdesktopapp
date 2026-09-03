"use strict";

const assert = require("assert");
const {
  synthesizeSpeech,
  redactSecrets,
  MAX_TTS_CHARS,
  normalizeVoice,
  clampTtsSpeed,
} = require("./textToSpeech");

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

async function main() {
  await test("empty text throws 400", async () => {
    await assert.rejects(
      () => synthesizeSpeech({ text: "", fetchImpl: async () => {} }),
      (err) => err.status === 400 && err.code === "NO_TEXT"
    );
    await assert.rejects(
      () => synthesizeSpeech({ fetchImpl: async () => {} }),
      (err) => err.status === 400 && err.code === "NO_TEXT"
    );
  });

  await test("API 401 message does not include the key", async () => {
    const secret = "xai-test-secret-key-do-not-leak";
    process.env.XAI_API_KEY = secret;
    await assert.rejects(
      () =>
        synthesizeSpeech({
          text: "hello",
          fetchImpl: async () => ({
            ok: false,
            status: 401,
            async text() {
              return `invalid token ${secret}`;
            },
          }),
        }),
      (err) => {
        assert.strictEqual(err.status, 401);
        assert.ok(!String(err.message).includes(secret));
        assert.ok(!String(err.detail || "").includes(secret));
        return true;
      }
    );
    delete process.env.XAI_API_KEY;
  });

  await test("fake fetchImpl: Authorization present, body is not the key", async () => {
    const secret = "xai-test-secret-key-do-not-leak";
    process.env.XAI_API_KEY = secret;
    let sawAuth = false;
    const audio = Buffer.from("ID3fake-mp3");
    const result = await synthesizeSpeech({
      text: "Hello sir.",
      voice: "rex",
      fetchImpl: async (_url, opts) => {
        const auth = opts && opts.headers && opts.headers.Authorization;
        sawAuth = typeof auth === "string" && auth.startsWith("Bearer ");
        assert.ok(sawAuth);
        assert.ok(auth.includes(secret));
        const body = JSON.parse(opts.body);
        assert.strictEqual(body.voice_id, "rex");
        assert.strictEqual(body.text, "Hello sir.");
        assert.strictEqual(body.speed, 1);
        return {
          ok: true,
          status: 200,
          headers: { get: (n) => (n.toLowerCase() === "content-type" ? "audio/mpeg" : null) },
          async arrayBuffer() {
            return audio;
          },
        };
      },
    });
    assert.ok(sawAuth);
    assert.ok(Buffer.isBuffer(result.audio));
    assert.strictEqual(result.contentType, "audio/mpeg");
    const asJson = JSON.stringify({ audio: result.audio.toString("utf8"), contentType: result.contentType });
    assert.ok(!asJson.includes(secret));
    delete process.env.XAI_API_KEY;
  });

  await test("redactSecrets strips the key from error text", () => {
    const key = "xai-super-secret";
    assert.strictEqual(redactSecrets(`fail ${key} end`, key), "fail [redacted] end");
  });

  await test("normalizeVoice falls back to rex; altair is allowed", () => {
    assert.strictEqual(normalizeVoice("Altair"), "altair");
    assert.strictEqual(normalizeVoice("nope"), "rex");
    assert.strictEqual(normalizeVoice(""), "rex");
  });

  await test("clampTtsSpeed stays in 0.7–1.5", () => {
    assert.strictEqual(clampTtsSpeed(1), 1);
    assert.strictEqual(clampTtsSpeed(0.2), 0.7);
    assert.strictEqual(clampTtsSpeed(9), 1.5);
    assert.strictEqual(clampTtsSpeed("1.25"), 1.25);
  });

  await test("overlong text is 400", async () => {
    await assert.rejects(
      () => synthesizeSpeech({ text: "a".repeat(MAX_TTS_CHARS + 1), fetchImpl: async () => {} }),
      (err) => err.status === 400 && err.code === "TEXT_TOO_LONG"
    );
  });

  if (failed) {
    throw new Error(`${failed} test(s) failed`);
  }
  console.log("all tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
