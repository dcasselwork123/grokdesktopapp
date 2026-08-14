"use strict";

const assert = require("assert");
const { resolvePermissionMode } = require("./grokService");

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

test("remote always dontAsk", () => {
  assert.strictEqual(resolvePermissionMode({ remote: true }), "dontAsk");
});

test("remote ignores stored/body bypassPermissions", () => {
  assert.strictEqual(
    resolvePermissionMode({ remote: true, permissionMode: "bypassPermissions" }),
    "dontAsk"
  );
});

test("desktop default is bypassPermissions", () => {
  assert.strictEqual(resolvePermissionMode({ remote: false }), "bypassPermissions");
});

test("desktop honors dontAsk", () => {
  assert.strictEqual(
    resolvePermissionMode({ remote: false, permissionMode: "dontAsk" }),
    "dontAsk"
  );
});

if (failed) {
  throw new Error(`${failed} test(s) failed`);
}
console.log("all tests passed");
