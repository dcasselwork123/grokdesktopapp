"use strict";

const assert = require("assert");
const {
  PLAN_TOOLS,
  ARM_TTL_MS,
  isBuildIntent,
  isConfirmYes,
  isConfirmNo,
  looksLikeBuildAsk,
  createArmToken,
  consumeArmToken,
  clearArmTokens,
  appendVoiceSpawnArgs,
  wrapVoicePrompt,
  extractSpeakBlock,
} = require("./voiceGate");

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

test("positive intents arm", () => {
  assert.strictEqual(isBuildIntent("go ahead"), true);
  assert.strictEqual(isBuildIntent("Go ahead and build this."), true);
  assert.strictEqual(isBuildIntent("  BUILD IT  "), true);
  assert.strictEqual(isBuildIntent("make it so"), true);
  assert.strictEqual(isBuildIntent("ship it"), true);
  assert.strictEqual(isBuildIntent("do it"), true);
  assert.strictEqual(isBuildIntent("execute"), true);
  assert.strictEqual(isBuildIntent("let's build"), true);
  assert.strictEqual(isBuildIntent("lets build"), true);
  assert.strictEqual(isBuildIntent("yes build"), true);
  assert.strictEqual(isBuildIntent("implement this"), true);
  assert.strictEqual(isBuildIntent("proceed"), true);
});

test("near-misses do not arm", () => {
  assert.strictEqual(isBuildIntent("go ahead and tell me more"), false);
  assert.strictEqual(isBuildIntent("go ahead and explain"), false);
  assert.strictEqual(isBuildIntent("what should I build"), false);
  assert.strictEqual(isBuildIntent("don't build this"), false);
  assert.strictEqual(isBuildIntent("not yet"), false);
  assert.strictEqual(isBuildIntent("yes"), false);
  assert.strictEqual(isBuildIntent("build"), false);
  assert.strictEqual(isBuildIntent("confirm"), false);
});

test("case / punctuation / extra spaces", () => {
  assert.strictEqual(isBuildIntent("GO AHEAD!!!"), true);
  assert.strictEqual(isBuildIntent("  Build   this now  "), true);
  assert.strictEqual(isBuildIntent("Make it so…"), true);
});

test("confirm yes/no only via dedicated helpers", () => {
  assert.strictEqual(isConfirmYes("yes"), true);
  assert.strictEqual(isConfirmYes("confirm"), true);
  assert.strictEqual(isConfirmYes("build"), true);
  assert.strictEqual(isConfirmYes("do it"), true);
  assert.strictEqual(isConfirmYes("go ahead and tell me more"), false);
  assert.strictEqual(isConfirmNo("no"), true);
  assert.strictEqual(isConfirmNo("not yet"), true);
  assert.strictEqual(isConfirmNo("keep planning"), true);
  assert.strictEqual(isConfirmNo("yes"), false);
});

test("looksLikeBuildAsk from Grok question text", () => {
  assert.strictEqual(looksLikeBuildAsk("Shall I build this now?"), true);
  assert.strictEqual(looksLikeBuildAsk("Would you like me to implement it?"), true);
  assert.strictEqual(looksLikeBuildAsk("What should we name the file?"), false);
});

test("appendVoiceSpawnArgs adds allowlist for plan only", () => {
  const plan = appendVoiceSpawnArgs(["--verbatim"], "plan");
  assert.deepStrictEqual(plan, [
    "--verbatim",
    "--tools",
    PLAN_TOOLS,
    "--no-subagents",
    "--sandbox",
    "read-only",
  ]);
  assert.deepStrictEqual(appendVoiceSpawnArgs(["--verbatim"], "build"), ["--verbatim"]);
  assert.deepStrictEqual(appendVoiceSpawnArgs(["--verbatim"], null), ["--verbatim"]);
  assert.throws(() => appendVoiceSpawnArgs([], "other"), /Unknown voiceTurn/);
});

test("wrapVoicePrompt prefixes plan/build; unknown throws", () => {
  const plan = wrapVoicePrompt("list files", "plan");
  assert.ok(plan.startsWith("[Voice planning mode — read-only]"));
  assert.ok(plan.includes("list files"));
  const build = wrapVoicePrompt("Build this now", "build");
  assert.ok(build.startsWith("[Voice build mode — approved]"));
  assert.ok(build.includes("SPEAK:"));
  assert.strictEqual(wrapVoicePrompt("hello", null), "hello");
  assert.throws(() => wrapVoicePrompt("x", "other"), /Unknown voiceTurn/);
});

test("arm consume: wrong session, expired, second consume fail", () => {
  clearArmTokens();
  const now = 1_000_000;
  const { token, expiresAt } = createArmToken("sess-a", { now, ttlMs: ARM_TTL_MS });
  assert.ok(token);
  assert.strictEqual(expiresAt, now + ARM_TTL_MS);
  assert.strictEqual(consumeArmToken(token, "sess-b", { now }), false);
  const again = createArmToken("sess-a", { now });
  assert.strictEqual(consumeArmToken(again.token, "sess-a", { now: now + ARM_TTL_MS + 1 }), false);
  const live = createArmToken("sess-a", { now });
  assert.strictEqual(consumeArmToken(live.token, "sess-a", { now }), true);
  assert.strictEqual(consumeArmToken(live.token, "sess-a", { now }), false);
});

test("extractSpeakBlock with and without SPEAK:", () => {
  assert.strictEqual(
    extractSpeakBlock("SPEAK: I will add the orb.\nThen the rest.\n\n# Details\ncode"),
    "I will add the orb. Then the rest."
  );
  const noMarker = extractSpeakBlock(
    "# Title\nFirst sentence. Second sentence. Third sentence. Fourth is ignored."
  );
  assert.ok(noMarker.startsWith("First sentence."));
  assert.ok(noMarker.includes("Third sentence."));
  assert.ok(!noMarker.includes("Fourth"));
});

if (failed) {
  throw new Error(`${failed} test(s) failed`);
}
console.log("all tests passed");
