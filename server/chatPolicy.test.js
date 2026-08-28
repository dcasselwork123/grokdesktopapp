"use strict";

const assert = require("assert");
const os = require("os");
const path = require("path");
const {
  assertRemoteCwd,
  assertModelEffort,
  listKnownProjectFolders,
  createChatRateLimiter,
} = require("./chatPolicy");

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

function throwsHttp(fn, status) {
  let err;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err, "expected throw");
  assert.strictEqual(err.status, status);
  assert.ok(err.message, "expected message");
  return err;
}

const GROK_MODELS = [{ id: "grok-4.6", efforts: [{ id: "high", value: "high" }] }];

test("assertRemoteCwd(os.tmpdir(), { knownFolders: [os.tmpdir()] }) succeeds", () => {
  const resolved = assertRemoteCwd(os.tmpdir(), { knownFolders: [os.tmpdir()] });
  assert.strictEqual(resolved, path.resolve(os.tmpdir()));
});

test('assertRemoteCwd("C:\\\\Windows", { knownFolders: [os.tmpdir()] }) throws 400', () => {
  const err = throwsHttp(
    () => assertRemoteCwd("C:\\Windows", { knownFolders: [os.tmpdir()] }),
    400
  );
  assert.ok(
    /does not exist|known project folder/i.test(err.message),
    err.message
  );
});

test("assertRemoteCwd a missing path throws 400", () => {
  const missing = path.join(os.tmpdir(), `gd-chat-policy-missing-${Date.now()}`);
  const err = throwsHttp(
    () => assertRemoteCwd(missing, { knownFolders: [missing] }),
    400
  );
  assert.strictEqual(err.message, "Working folder does not exist.");
});

test("lastCwd allows a folder that is not in knownFolders", () => {
  const resolved = assertRemoteCwd(os.tmpdir(), {
    knownFolders: [],
    lastCwd: os.tmpdir(),
  });
  assert.strictEqual(resolved, path.resolve(os.tmpdir()));
});

test("lastCwd still works when knownFolders is another existing dir", () => {
  const resolved = assertRemoteCwd(os.tmpdir(), {
    knownFolders: [path.resolve(os.tmpdir(), "not-this-folder")],
    lastCwd: os.tmpdir(),
  });
  assert.strictEqual(resolved, path.resolve(os.tmpdir()));
});

test("assertRemoteCwd rejects an existing folder outside the allow-list", () => {
  const forbidden = os.homedir();
  if (path.resolve(forbidden) === path.resolve(os.tmpdir())) return;
  const err = throwsHttp(
    () => assertRemoteCwd(forbidden, { knownFolders: [os.tmpdir()] }),
    400
  );
  assert.strictEqual(err.message, "Remote chat can only use a known project folder.");
});

test("assertRemoteCwd matches knownFolders case-insensitively on win32", () => {
  if (process.platform !== "win32") return;
  const tmp = path.resolve(os.tmpdir());
  const flipped = tmp.replace(/[A-Za-z]/g, (ch) =>
    ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()
  );
  const resolved = assertRemoteCwd(flipped, { knownFolders: [tmp] });
  assert.strictEqual(path.resolve(resolved).toLowerCase(), tmp.toLowerCase());
});

test('assertModelEffort("nope", "high", grok-4.6/high) throws', () => {
  throwsHttp(() => assertModelEffort("nope", "high", GROK_MODELS), 400);
});

test('assertModelEffort("grok-4.6", "insane", grok-4.6/high) throws', () => {
  throwsHttp(() => assertModelEffort("grok-4.6", "insane", GROK_MODELS), 400);
});

test("assertModelEffort(undefined, undefined, grok-4.6/high) defaults", () => {
  assert.deepStrictEqual(assertModelEffort(undefined, undefined, GROK_MODELS), {
    model: "grok-4.6",
    effort: "high",
  });
});

test("assertModelEffort prefers grok-4.6 when both 4.5 and 4.6 are listed", () => {
  const models = [
    { id: "grok-4.5", efforts: [{ id: "high", value: "high" }] },
    { id: "grok-4.6", efforts: [{ id: "high", value: "high" }] },
  ];
  assert.deepStrictEqual(assertModelEffort(undefined, undefined, models), {
    model: "grok-4.6",
    effort: "high",
  });
});

test("listKnownProjectFolders unique non-empty cwd values", () => {
  const folders = listKnownProjectFolders([
    { cwd: os.tmpdir() },
    { cwd: os.tmpdir() },
    { cwd: "" },
    { cwd: null },
    {},
    { cwd: path.join(os.tmpdir(), "other-project") },
  ]);
  assert.strictEqual(folders.length, 2);
  assert.strictEqual(folders[0], os.tmpdir());
  assert.strictEqual(folders[1], path.join(os.tmpdir(), "other-project"));
});

test("rate limiter: 30 checks ok, 31st throws 429", () => {
  const limiter = createChatRateLimiter({ windowMs: 60_000, max: 30 });
  for (let i = 0; i < 30; i += 1) {
    limiter.check("peer-1");
  }
  const err = throwsHttp(() => limiter.check("peer-1"), 429);
  assert.strictEqual(err.message, "Too many chat requests. Try again in a minute.");
});

test("rate limiter missing key counts under unknown", () => {
  const limiter = createChatRateLimiter({ windowMs: 60_000, max: 2 });
  limiter.check(undefined);
  limiter.check(null);
  throwsHttp(() => limiter.check(""), 429);
});

test("rate limiter buckets are per key", () => {
  const limiter = createChatRateLimiter({ windowMs: 60_000, max: 1 });
  limiter.check("a");
  limiter.check("b");
  throwsHttp(() => limiter.check("a"), 429);
});

if (failed) {
  throw new Error(`${failed} test(s) failed`);
}
console.log("all tests passed");
