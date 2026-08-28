"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const prevHome = process.env.GROK_HOME;
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "gd-models-"));
process.env.GROK_HOME = tmpHome;

const { loadModels, DEFAULT_MODEL_ID } = require("./grokService");

let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log("ok -", name);
  } catch (err) {
    failed += 1;
    console.error("not ok -", name);
    console.error(err);
  }
}

function writeCache(models) {
  fs.writeFileSync(
    path.join(tmpHome, "models_cache.json"),
    JSON.stringify({ models }),
    "utf8"
  );
}

test("DEFAULT_MODEL_ID is grok-4.6", () => {
  assert.strictEqual(DEFAULT_MODEL_ID, "grok-4.6");
});

test("loadModels omits grok-4.5 even when the CLI cache lists it", () => {
  writeCache({
    "grok-4.5": {
      info: {
        id: "grok-4.5",
        name: "Grok 4.5",
        hidden: false,
        reasoning_effort: "high",
        supports_reasoning_effort: true,
        reasoning_efforts: [{ id: "high", value: "high", label: "High", default: true }],
      },
    },
    "grok-4.6": {
      info: {
        id: "grok-4.6",
        name: "Grok 4.6",
        hidden: false,
        reasoning_effort: "high",
        supports_reasoning_effort: true,
        reasoning_efforts: [{ id: "high", value: "high", label: "High", default: true }],
      },
    },
  });
  const models = loadModels();
  assert.deepStrictEqual(
    models.map((m) => m.id),
    ["grok-4.6"]
  );
});

test("loadModels falls back to grok-4.6 when the cache is empty", () => {
  writeCache({});
  const models = loadModels();
  assert.strictEqual(models.length, 1);
  assert.strictEqual(models[0].id, "grok-4.6");
});

try {
  fs.rmSync(tmpHome, { recursive: true, force: true });
} catch {
  /* ignore */
}
if (prevHome === undefined) delete process.env.GROK_HOME;
else process.env.GROK_HOME = prevHome;

if (failed) {
  throw new Error(`${failed} test(s) failed`);
}
console.log("all tests passed");
