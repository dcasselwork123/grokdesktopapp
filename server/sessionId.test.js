"use strict";

const assert = require("assert");
const os = require("os");
const path = require("path");
const { isSafeSessionId, resolveUnderSessionsRoot } = require("./sessionId");

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

const UUID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

test("isSafeSessionId rejects Windows parent traversal", () => {
  assert.strictEqual(isSafeSessionId("..\\..\\.grok"), false);
});

test("isSafeSessionId rejects POSIX parent traversal", () => {
  assert.strictEqual(isSafeSessionId("../x"), false);
});

test("isSafeSessionId rejects a slash in the id", () => {
  assert.strictEqual(isSafeSessionId("foo/bar"), false);
});

test("isSafeSessionId rejects a backslash in the id", () => {
  assert.strictEqual(isSafeSessionId("foo\\bar"), false);
});

test("isSafeSessionId rejects ..", () => {
  assert.strictEqual(isSafeSessionId(".."), false);
});

test("isSafeSessionId rejects an empty string", () => {
  assert.strictEqual(isSafeSessionId(""), false);
});

test("isSafeSessionId rejects null", () => {
  assert.strictEqual(isSafeSessionId(null), false);
});

test("isSafeSessionId accepts a typical UUID", () => {
  assert.strictEqual(isSafeSessionId(UUID), true);
});

test("resolveUnderSessionsRoot rejects ..\\\\..\\\\.grok under a group", () => {
  const root = path.join(os.tmpdir(), "gd-sessions-root");
  assert.strictEqual(resolveUnderSessionsRoot(root, "group", "..\\..\\.grok"), null);
});

test("resolveUnderSessionsRoot keeps ok-id under root", () => {
  const root = path.join(os.tmpdir(), "gd-sessions-root");
  const resolved = resolveUnderSessionsRoot(root, "group", "ok-id");
  const resolvedRoot = path.resolve(root);
  assert.ok(resolved);
  assert.ok(resolved.startsWith(resolvedRoot + path.sep));
  assert.strictEqual(resolved, path.resolve(resolvedRoot, "group", "ok-id"));
});

test("joining an id with backslashes must not escape root", () => {
  const root = path.resolve(os.tmpdir(), "gd-sessions-root");
  assert.strictEqual(resolveUnderSessionsRoot(root, "group", "..\\..\\..\\outside"), null);
  assert.strictEqual(resolveUnderSessionsRoot(root, "group\\..\\..\\outside", "ok-id"), null);
  const naive = path.resolve(path.join(root, "group", "..\\..\\.grok"));
  const escaped = resolveUnderSessionsRoot(root, "group", "..\\..\\.grok");
  assert.strictEqual(escaped, null);
  if (process.platform === "win32") {
    assert.ok(!naive.startsWith(root + path.sep), "naive join would escape on Windows");
  }
});

if (failed) {
  throw new Error(`${failed} test(s) failed`);
}
console.log("all tests passed");
