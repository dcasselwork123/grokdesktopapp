"use strict";

const assert = require("assert");
const { isPrivilegedPost, isLoopbackRequest } = require("./httpApi");

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

test('isPrivilegedPost("POST", "/api/update") is true', () => {
  assert.strictEqual(isPrivilegedPost("POST", "/api/update"), true);
});

test('isPrivilegedPost("GET", "/api/update") is false', () => {
  assert.strictEqual(isPrivilegedPost("GET", "/api/update"), false);
});

test('isPrivilegedPost("POST", "/api/chat") is false', () => {
  assert.strictEqual(isPrivilegedPost("POST", "/api/chat"), false);
});

test('isPrivilegedPost("POST", "/api/auth/login") is true', () => {
  assert.strictEqual(isPrivilegedPost("POST", "/api/auth/login"), true);
});

test("other privileged POSTs are gated; GET login is not", () => {
  assert.strictEqual(isPrivilegedPost("POST", "/api/auth/login/cancel"), true);
  assert.strictEqual(isPrivilegedPost("POST", "/api/auth/logout"), true);
  assert.strictEqual(isPrivilegedPost("POST", "/api/remote/settings"), true);
  assert.strictEqual(isPrivilegedPost("GET", "/api/auth/login"), false);
  assert.strictEqual(isPrivilegedPost("GET", "/api/remote"), false);
});

test("isLoopbackRequest 127.0.0.1 is true", () => {
  assert.strictEqual(
    isLoopbackRequest({ socket: { remoteAddress: "127.0.0.1" } }),
    true
  );
});

test("isLoopbackRequest ::ffff:127.0.0.1 is true", () => {
  assert.strictEqual(
    isLoopbackRequest({ socket: { remoteAddress: "::ffff:127.0.0.1" } }),
    true
  );
});

test("isLoopbackRequest 192.168.1.10 is false", () => {
  assert.strictEqual(
    isLoopbackRequest({ socket: { remoteAddress: "192.168.1.10" } }),
    false
  );
});

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("all tests passed");
