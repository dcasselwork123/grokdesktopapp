"use strict";

const assert = require("assert");
const {
  parseAcpLine,
  mapSessionUpdateToGrokEvent,
  makeQuestionResponse,
  makeQuestionCancelledResponse,
  pickPermissionOptionId,
  isAskUserQuestionMethod,
  buildAcpArgs,
} = require("./grokAcp");
const { answersMapFromPairs, shouldParkForAsk } = require("./sessionQuestions");

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

test("parseAcpLine splits responses, updates, and server requests", () => {
  assert.deepStrictEqual(parseAcpLine('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}').kind, "response");
  const upd = parseAcpLine(
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } },
    })
  );
  assert.strictEqual(upd.kind, "session-update");
  assert.strictEqual(upd.sessionId, "s1");
  const req = parseAcpLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 9,
      method: "x.ai/ask_user_question",
      params: { questions: [] },
    })
  );
  assert.strictEqual(req.kind, "server-request");
  assert.strictEqual(req.method, "x.ai/ask_user_question");
});

test("mapSessionUpdateToGrokEvent matches streaming-json shapes", () => {
  const text = mapSessionUpdateToGrokEvent(
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello" } },
    "s1"
  );
  assert.deepStrictEqual(text, { type: "text", data: "Hello", sessionId: "s1" });
  const thought = mapSessionUpdateToGrokEvent(
    { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } },
    "s1"
  );
  assert.strictEqual(thought.type, "thought");
  const tool = mapSessionUpdateToGrokEvent(
    {
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      title: "read_file",
      status: "pending",
      _meta: { "x.ai/tool": { name: "read_file" } },
    },
    "s1"
  );
  assert.strictEqual(tool.type, "tool_call");
  assert.strictEqual(tool.toolName, "read_file");
});

test("question response carries outcome accepted and answer map", () => {
  const msg = makeQuestionResponse(3, { "Minimal or bold?": "Bold & expressive" });
  assert.strictEqual(msg.id, 3);
  assert.strictEqual(msg.result.outcome, "accepted");
  assert.strictEqual(msg.result.answers["Minimal or bold?"], "Bold & expressive");
  assert.deepStrictEqual(msg.result.annotations, {});
  assert.strictEqual(makeQuestionCancelledResponse(4).result.outcome, "cancelled");
});

test("answersMapFromPairs keys by question text", () => {
  const map = answersMapFromPairs([
    { question: "Framework?", answer: "Other: SvelteKit" },
    { question: "Tone?", answer: "Minimal" },
  ]);
  assert.strictEqual(map["Framework?"], "Other: SvelteKit");
  assert.strictEqual(map["Tone?"], "Minimal");
});

test("shouldParkForAsk is true only for a live question", () => {
  const ask = { id: "call-1", questions: [{ question: "Tone?", options: [] }] };
  assert.strictEqual(shouldParkForAsk({ status: "pending" }, ask), true);
  assert.strictEqual(shouldParkForAsk({ status: "in_progress" }, ask), true);
  assert.strictEqual(shouldParkForAsk({ status: "completed" }, ask), false);
  assert.strictEqual(shouldParkForAsk({ status: "pending" }, { questions: [] }), false);
});

test("pickPermissionOptionId prefers allow-once in Full access", () => {
  const options = [
    { optionId: "allow-always", kind: "allow_always" },
    { optionId: "allow-once", kind: "allow_once" },
    { optionId: "reject-once", kind: "reject_once" },
  ];
  assert.strictEqual(pickPermissionOptionId(options, "bypassPermissions"), "allow-once");
  assert.strictEqual(pickPermissionOptionId(options, "dontAsk"), "reject-once");
});

test("isAskUserQuestionMethod accepts the xAI prefix", () => {
  assert.strictEqual(isAskUserQuestionMethod("x.ai/ask_user_question"), true);
  assert.strictEqual(isAskUserQuestionMethod("_x.ai/ask_user_question"), true);
  assert.strictEqual(isAskUserQuestionMethod("session/request_permission"), false);
});

test("buildAcpArgs keeps -p flags off stdio and always-approves Full access", () => {
  const args = buildAcpArgs({
    cwd: "E:\\Dev\\GrokDesktop",
    model: "grok-4.5",
    effort: "high",
    permissionMode: "bypassPermissions",
  });
  assert.ok(args.includes("agent"));
  assert.ok(args.includes("stdio"));
  assert.ok(args.includes("--always-approve"));
  assert.ok(!args.includes("-p"));
  assert.ok(!args.includes("--prompt-file"));
  const safer = buildAcpArgs({ permissionMode: "dontAsk" });
  assert.ok(!safer.includes("--always-approve"));
});

if (failed) {
  process.exitCode = 1;
  throw new Error(`${failed} test(s) failed`);
}

console.log("all tests passed");
