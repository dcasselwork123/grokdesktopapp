"use strict";

const assert = require("assert");
const { findRunBySessionId, findRunByClientTurnId } = require("./httpApi");

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

function run(partial) {
  return {
    runId: partial.runId,
    sessionId: partial.sessionId || null,
    clientTurnId: partial.clientTurnId || null,
    startedAt: partial.startedAt || 0,
    done: partial.done || null,
  };
}

test("findRunBySessionId prefers the live run over a newer done one", () => {
  const runs = new Map([
    ["old-live", run({ runId: "old-live", sessionId: "s1", startedAt: 1 })],
    ["new-done", run({ runId: "new-done", sessionId: "s1", startedAt: 9, done: { ok: true } })],
  ]);
  const found = findRunBySessionId(runs, "s1", { includeDone: true });
  assert.strictEqual(found.runId, "old-live");
});

test("findRunBySessionId skips done unless includeDone", () => {
  const runs = new Map([
    ["done", run({ runId: "done", sessionId: "s1", startedAt: 5, done: { ok: true } })],
  ]);
  assert.strictEqual(findRunBySessionId(runs, "s1"), null);
  assert.strictEqual(findRunBySessionId(runs, "s1", { includeDone: true }).runId, "done");
});

test("findRunByClientTurnId finds a run after the phone drops the stream", () => {
  const runs = new Map([
    [
      "r1",
      run({
        runId: "r1",
        sessionId: "s-new",
        clientTurnId: "ct-phone",
        startedAt: 3,
      }),
    ],
  ]);
  const found = findRunByClientTurnId(runs, "ct-phone");
  assert.strictEqual(found.runId, "r1");
  assert.strictEqual(found.sessionId, "s-new");
});

test("findRunByClientTurnId can ignore finished turns", () => {
  const runs = new Map([
    [
      "r1",
      run({
        runId: "r1",
        clientTurnId: "ct-1",
        startedAt: 1,
        done: { ok: true },
      }),
    ],
  ]);
  assert.strictEqual(findRunByClientTurnId(runs, "ct-1", { includeDone: false }), null);
  assert.strictEqual(findRunByClientTurnId(runs, "ct-1", { includeDone: true }).runId, "r1");
});

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("all tests passed");
