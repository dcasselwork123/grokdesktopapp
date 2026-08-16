"use strict";

const assert = require("assert");
const { findRunBySessionId, findRunByClientTurnId, serializeRun } = require("./httpApi");

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
    asks: partial.asks,
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

test("serializeRun includes pending ask_user_question cards", () => {
  const record = run({
    runId: "r-ask",
    sessionId: "s-ask",
    startedAt: 2,
    asks: [
      {
        id: "call-ask",
        questions: [{ question: "Tone?", options: [{ label: "Minimal" }], multiSelect: false }],
      },
      {
        id: "call-done",
        questions: [{ question: "Done?", options: [{ label: "Yes" }], multiSelect: false }],
        answers: [{ question: "Done?", answer: "Yes" }],
      },
    ],
  });
  const json = serializeRun(record);
  assert.strictEqual(json.pendingQuestions.length, 1);
  assert.strictEqual(json.pendingQuestions[0].id, "call-ask");
  assert.strictEqual(json.pendingQuestions[0].questions[0].question, "Tone?");
});

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("all tests passed");
