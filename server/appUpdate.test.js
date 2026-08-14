"use strict";

const assert = require("assert");
const {
  parseCommitLines,
  formatUpdateSummary,
} = require("./appUpdate");

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

test("parseCommitLines reads tab-separated git log", () => {
  const rows = parseCommitLines("abc1234\tFix the thing\ndef5678\tUpdate README\n");
  assert.deepStrictEqual(rows, [
    { sha: "abc1234", subject: "Fix the thing" },
    { sha: "def5678", subject: "Update README" },
  ]);
});

test("parseCommitLines accepts space-separated fallback", () => {
  const rows = parseCommitLines("abc1234 Fix the thing");
  assert.deepStrictEqual(rows, [{ sha: "abc1234", subject: "Fix the thing" }]);
});

test("formatUpdateSummary uses the subject for one commit", () => {
  assert.strictEqual(
    formatUpdateSummary([{ sha: "abc", subject: "Reconnect mobile chats" }]),
    "Reconnect mobile chats"
  );
});

test("formatUpdateSummary lists a few commits and a remainder", () => {
  const commits = [
    { sha: "1", subject: "One" },
    { sha: "2", subject: "Two" },
    { sha: "3", subject: "Three" },
    { sha: "4", subject: "Four" },
    { sha: "5", subject: "Five" },
    { sha: "6", subject: "Six" },
    { sha: "7", subject: "Seven" },
  ];
  const text = formatUpdateSummary(commits);
  assert.ok(text.startsWith("• One"));
  assert.ok(text.includes("• Five"));
  assert.ok(!text.includes("• Six"));
  assert.ok(text.includes("…and 2 more"));
});

if (failed) {
  throw new Error(`${failed} test(s) failed`);
}
console.log("all tests passed");
