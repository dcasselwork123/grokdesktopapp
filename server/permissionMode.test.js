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

test("default is bypassPermissions (desktop and phone)", () => {
  assert.strictEqual(resolvePermissionMode({}), "bypassPermissions");
  assert.strictEqual(resolvePermissionMode({ remote: true }), "bypassPermissions");
});

test("honors stored Full access for remote coding", () => {
  assert.strictEqual(
    resolvePermissionMode({ remote: true, permissionMode: "bypassPermissions" }),
    "bypassPermissions"
  );
});

test("honors Safer when that is the stored mode", () => {
  assert.strictEqual(
    resolvePermissionMode({ remote: false, permissionMode: "dontAsk" }),
    "dontAsk"
  );
  assert.strictEqual(
    resolvePermissionMode({ remote: true, permissionMode: "dontAsk" }),
    "dontAsk"
  );
});

if (failed) {
  throw new Error(`${failed} test(s) failed`);
}
console.log("all tests passed");
