"use strict";

const assert = require("assert");
const { isSafeExternalUrl, isApiOrigin } = require("./externalUrl");

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

test('isSafeExternalUrl("https://x.ai") true', () => {
  assert.strictEqual(isSafeExternalUrl("https://x.ai"), true);
});

test('isSafeExternalUrl("http://example.com") true', () => {
  assert.strictEqual(isSafeExternalUrl("http://example.com"), true);
});

test('isSafeExternalUrl("file:///C:/") false', () => {
  assert.strictEqual(isSafeExternalUrl("file:///C:/"), false);
});

test('isSafeExternalUrl("myapp://x") false', () => {
  assert.strictEqual(isSafeExternalUrl("myapp://x"), false);
});

test('isSafeExternalUrl("javascript:alert(1)") false', () => {
  assert.strictEqual(isSafeExternalUrl("javascript:alert(1)"), false);
});

test("isSafeExternalUrl rejects data:, about:, empty, relative", () => {
  assert.strictEqual(isSafeExternalUrl("data:text/html,hi"), false);
  assert.strictEqual(isSafeExternalUrl("about:blank"), false);
  assert.strictEqual(isSafeExternalUrl(""), false);
  assert.strictEqual(isSafeExternalUrl("   "), false);
  assert.strictEqual(isSafeExternalUrl("/foo"), false);
  assert.strictEqual(isSafeExternalUrl("./rel"), false);
  assert.strictEqual(isSafeExternalUrl(null), false);
});

test('isApiOrigin("http://127.0.0.1:3847/foo", { port: 3847 }) true', () => {
  assert.strictEqual(isApiOrigin("http://127.0.0.1:3847/foo", { port: 3847 }), true);
});

test("isApiOrigin localhost same port true", () => {
  assert.strictEqual(
    isApiOrigin("http://localhost:3847/bar", { port: 3847 }),
    true
  );
});

test('isApiOrigin("http://evil.example/", { port: 3847 }) false', () => {
  assert.strictEqual(isApiOrigin("http://evil.example/", { port: 3847 }), false);
});

test("isApiOrigin wrong port / https / missing port false", () => {
  assert.strictEqual(isApiOrigin("http://127.0.0.1:9999/foo", { port: 3847 }), false);
  assert.strictEqual(isApiOrigin("https://127.0.0.1:3847/foo", { port: 3847 }), false);
  assert.strictEqual(isApiOrigin("http://127.0.0.1:3847/foo", {}), false);
});

if (failed) {
  throw new Error(`${failed} test(s) failed`);
}
console.log("all tests passed");
