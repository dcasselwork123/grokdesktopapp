"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  parseUpdatesJsonl,
  parseChatHistoryJsonl,
  loadTranscript,
  synthesizeSessionMeta,
  looksLikeSessionDir,
  writeDesktopTitle,
  isClearedSessionStub,
  clearSessionDir,
  takeClearedSessionStub,
} = require("./sessionTranscript");

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

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gd-transcript-"));
}

function wrapUpdate(kind, extra = {}, timestamp = 1000) {
  return JSON.stringify({
    timestamp,
    method: "session/update",
    params: {
      sessionId: "sess-1",
      update: { sessionUpdate: kind, ...extra },
    },
  });
}

test("chunked assistant concatenates agent_message_chunk text", () => {
  const text = [
    wrapUpdate("user_message_chunk", { content: { type: "text", text: "hi" } }, 1),
    wrapUpdate("agent_thought_chunk", { content: { type: "text", text: "thinking" } }, 2),
    wrapUpdate("agent_message_chunk", { content: { type: "text", text: "Hel" } }, 3),
    wrapUpdate("agent_message_chunk", { content: { type: "text", text: "lo!" } }, 4),
  ].join("\n");
  const msgs = parseUpdatesJsonl(text);
  assert.strictEqual(msgs.length, 2);
  assert.deepStrictEqual(
    msgs.map((m) => m.role),
    ["user", "assistant"]
  );
  assert.strictEqual(msgs[0].text, "hi");
  assert.strictEqual(msgs[1].text, "Hello!");
  assert.ok(!/thinking/.test(msgs[1].text));
});

test("tool_call chips are attached and updated", () => {
  const text = [
    wrapUpdate("user_message_chunk", { content: { type: "text", text: "whoami" } }, 1),
    wrapUpdate(
      "agent_message_chunk",
      { content: { type: "text", text: "Checking." } },
      2
    ),
    wrapUpdate(
      "tool_call",
      {
        toolCallId: "call-1",
        title: "run_terminal_command",
        _meta: { "x.ai/tool": { name: "run_terminal_command" } },
      },
      3
    ),
    wrapUpdate(
      "tool_call_update",
      { toolCallId: "call-1", title: "Execute `whoami`", status: "completed" },
      4
    ),
  ].join("\n");
  const msgs = parseUpdatesJsonl(text);
  assert.strictEqual(msgs.length, 2);
  assert.strictEqual(msgs[1].tools.length, 1);
  assert.strictEqual(msgs[1].tools[0].id, "call-1");
  assert.strictEqual(msgs[1].tools[0].name, "run_terminal_command");
  assert.strictEqual(msgs[1].tools[0].title, "Execute `whoami`");
  assert.strictEqual(msgs[1].tools[0].status, "completed");
});

test("truncated last line is salvaged and prior messages are flushed", () => {
  const text =
    wrapUpdate("user_message_chunk", { content: { type: "text", text: "hello" } }, 1) +
    "\n" +
    wrapUpdate("agent_message_chunk", { content: { type: "text", text: "ok" } }, 2) +
    "\n" +
    '{"timestamp":3,"method":"session/update","params":{"sessionId":"sess-1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":" more';
  const msgs = parseUpdatesJsonl(text);
  assert.strictEqual(msgs.length, 2);
  assert.strictEqual(msgs[0].text, "hello");
  assert.strictEqual(msgs[1].text, "ok more");
});

test("garbage last line does not drop accumulated messages", () => {
  const text = [
    wrapUpdate("user_message_chunk", { content: { type: "text", text: "keep me" } }, 1),
    wrapUpdate("agent_message_chunk", { content: { type: "text", text: "also keep" } }, 2),
    "{this is not json",
  ].join("\n");
  const msgs = parseUpdatesJsonl(text);
  assert.strictEqual(msgs.length, 2);
  assert.strictEqual(msgs[0].text, "keep me");
  assert.strictEqual(msgs[1].text, "also keep");
});

test("_x.ai/session/update turn_completed is ignored", () => {
  const text = [
    wrapUpdate("user_message_chunk", { content: { type: "text", text: "q" } }, 1),
    wrapUpdate("agent_message_chunk", { content: { type: "text", text: "a" } }, 2),
    JSON.stringify({
      timestamp: 3,
      method: "_x.ai/session/update",
      params: {
        sessionId: "sess-1",
        update: { sessionUpdate: "turn_completed", stop_reason: "end_turn" },
      },
    }),
    wrapUpdate("user_message_chunk", { content: { type: "text", text: "q2" } }, 4),
    wrapUpdate("agent_message_chunk", { content: { type: "text", text: "a2" } }, 5),
  ].join("\n");
  const msgs = parseUpdatesJsonl(text);
  assert.deepStrictEqual(
    msgs.map((m) => `${m.role}:${m.text}`),
    ["user:q", "assistant:a", "user:q2", "assistant:a2"]
  );
});

test("chat_history extracts user_query and skips synthetic / reasoning", () => {
  const text = [
    JSON.stringify({ type: "system", content: "You are Grok" }),
    JSON.stringify({
      type: "user",
      content: [{ type: "text", text: "<user_info>\nOS: windows\n</user_info>" }],
    }),
    JSON.stringify({
      type: "user",
      synthetic_reason: "system_reminder",
      content: [{ type: "text", text: "<system-reminder>skills</system-reminder>" }],
    }),
    JSON.stringify({
      type: "user",
      content: [{ type: "text", text: "<user_query> whoami </user_query>" }],
    }),
    JSON.stringify({ type: "reasoning", content: "secret thoughts" }),
    JSON.stringify({
      type: "assistant",
      content: "I'll check.",
      tool_calls: [{ id: "call-1", name: "run_terminal_command" }],
    }),
    JSON.stringify({
      type: "tool_result",
      tool_call_id: "call-1",
      content: "dc-lenovo\\games",
    }),
    JSON.stringify({ type: "assistant", content: "You are games." }),
  ].join("\n");
  const msgs = parseChatHistoryJsonl(text);
  assert.strictEqual(msgs.length, 2);
  assert.strictEqual(msgs[0].role, "user");
  assert.strictEqual(msgs[0].text, "whoami");
  assert.strictEqual(msgs[1].role, "assistant");
  assert.ok(msgs[1].text.includes("I'll check."));
  assert.ok(msgs[1].text.includes("You are games."));
  assert.strictEqual(msgs[1].tools.length, 1);
  assert.strictEqual(msgs[1].tools[0].status, "completed");
  assert.ok(!msgs.some((m) => /secret thoughts|You are Grok|skills/.test(m.text)));
});

test("loadTranscript prefers updates.jsonl when it has chat text", () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(
      path.join(dir, "updates.jsonl"),
      wrapUpdate("user_message_chunk", { content: { type: "text", text: "from updates" } }) +
        "\n" +
        wrapUpdate("agent_message_chunk", { content: { type: "text", text: "reply" } }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(dir, "chat_history.jsonl"),
      JSON.stringify({
        type: "user",
        content: [{ type: "text", text: "<user_query>from history</user_query>" }],
      }),
      "utf8"
    );
    const loaded = loadTranscript(dir);
    assert.strictEqual(loaded.source, "updates");
    assert.strictEqual(loaded.messages[0].text, "from updates");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadTranscript falls back to chat_history when updates has no chat text", () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(
      path.join(dir, "updates.jsonl"),
      JSON.stringify({
        timestamp: 1,
        method: "_x.ai/session/update",
        params: { update: { sessionUpdate: "turn_completed" } },
      }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(dir, "chat_history.jsonl"),
      JSON.stringify({
        type: "user",
        content: [{ type: "text", text: "<user_query>fallback prompt</user_query>" }],
      }) +
        "\n" +
        JSON.stringify({ type: "assistant", content: "fallback answer" }),
      "utf8"
    );
    const loaded = loadTranscript(dir);
    assert.strictEqual(loaded.source, "chat_history");
    assert.strictEqual(loaded.messages[0].text, "fallback prompt");
    assert.strictEqual(loaded.messages[1].text, "fallback answer");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadTranscript streams large files line-by-line", () => {
  const dir = tmpDir();
  try {
    const lines = [
      wrapUpdate("user_message_chunk", { content: { type: "text", text: "streamed" } }, 1),
      wrapUpdate("agent_message_chunk", { content: { type: "text", text: "yes" } }, 2),
    ].join("\n");
    fs.writeFileSync(path.join(dir, "updates.jsonl"), lines, "utf8");
    const loaded = loadTranscript(dir, { largeFileBytes: 10 });
    assert.strictEqual(loaded.source, "updates");
    assert.strictEqual(loaded.messages[0].text, "streamed");
    assert.strictEqual(loaded.messages[1].text, "yes");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("synthesizeSessionMeta prefers desktop title over generated_title", () => {
  const dir = tmpDir();
  const sessionPath = path.join(dir, "019fd8b3-d10d-7cf0-a682-eb84d939e480");
  try {
    fs.mkdirSync(sessionPath);
    fs.writeFileSync(
      path.join(sessionPath, "summary.json"),
      JSON.stringify({
        info: { id: "019fd8b3-d10d-7cf0-a682-eb84d939e480", cwd: "C:\\Dev\\GrokDesktop" },
        generated_title: "Identify Current User",
      }),
      "utf8"
    );
    writeDesktopTitle(sessionPath, "  My custom name  ");
    const meta = synthesizeSessionMeta(sessionPath, "C:\\Dev\\GrokDesktop");
    assert.strictEqual(meta.title, "My custom name");
    writeDesktopTitle(sessionPath, "   ");
    const cleared = synthesizeSessionMeta(sessionPath, "C:\\Dev\\GrokDesktop");
    assert.strictEqual(cleared.title, "Identify Current User");
    assert.strictEqual(fs.existsSync(path.join(sessionPath, ".desktop.json")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("synthesizeSessionMeta uses summary when present", () => {
  const dir = tmpDir();
  const sessionPath = path.join(dir, "019fd8b3-d10d-7cf0-a682-eb84d939e480");
  try {
    fs.mkdirSync(sessionPath);
    fs.writeFileSync(
      path.join(sessionPath, "summary.json"),
      JSON.stringify({
        info: { id: "019fd8b3-d10d-7cf0-a682-eb84d939e480", cwd: "C:\\Dev\\GrokDesktop" },
        generated_title: "Identify Current User",
        created_at: "2026-08-06T20:11:30Z",
        last_active_at: "2026-08-06T20:11:37Z",
        current_model_id: "grok-4.5",
        reasoning_effort: "high",
        num_chat_messages: 12,
      }),
      "utf8"
    );
    const meta = synthesizeSessionMeta(sessionPath, "C:\\Dev\\GrokDesktop");
    assert.strictEqual(meta.id, "019fd8b3-d10d-7cf0-a682-eb84d939e480");
    assert.strictEqual(meta.title, "Identify Current User");
    assert.strictEqual(meta.cwd, "C:\\Dev\\GrokDesktop");
    assert.strictEqual(meta.project, "GrokDesktop");
    assert.strictEqual(meta.model, "grok-4.5");
    assert.strictEqual(meta.effort, "high");
    assert.strictEqual(meta.numMessages, 12);
    assert.strictEqual(meta.path, sessionPath);
    assert.strictEqual(meta.updatedAt, "2026-08-06T20:11:37Z");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("synthesizeSessionMeta for summary-less dir uses first user line and mtime", () => {
  const dir = tmpDir();
  const sessionPath = path.join(dir, "019aaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  try {
    fs.mkdirSync(sessionPath);
    fs.writeFileSync(
      path.join(sessionPath, "updates.jsonl"),
      wrapUpdate(
        "user_message_chunk",
        { content: { type: "text", text: "fix the session restore bugs please" } },
        1
      ),
      "utf8"
    );
    const meta = synthesizeSessionMeta(sessionPath, "C:\\Dev\\brick breaker");
    assert.strictEqual(meta.id, "019aaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    assert.strictEqual(meta.title, "fix the session restore bugs please");
    assert.strictEqual(meta.cwd, "C:\\Dev\\brick breaker");
    assert.strictEqual(meta.project, "brick breaker");
    assert.ok(meta.updatedAt);
    assert.ok(Date.parse(meta.updatedAt) > 0);
    assert.ok(looksLikeSessionDir(path.basename(sessionPath), sessionPath));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("clearSessionDir wipes transcript files and marks a stub", () => {
  const dir = tmpDir();
  const sessionPath = path.join(dir, "019bbbbb-cccc-4ddd-8eee-ffffffffffff");
  try {
    fs.mkdirSync(sessionPath);
    fs.writeFileSync(path.join(sessionPath, "updates.jsonl"), "old\n", "utf8");
    fs.writeFileSync(path.join(sessionPath, "chat_history.jsonl"), "old\n", "utf8");
    fs.writeFileSync(path.join(sessionPath, "prompt_context.json"), "{}", "utf8");
    fs.mkdirSync(path.join(sessionPath, "terminal"));
    writeDesktopTitle(sessionPath, "My saved title");

    const meta = clearSessionDir(sessionPath, {
      id: "019bbbbb-cccc-4ddd-8eee-ffffffffffff",
      cwd: "E:\\Dev\\GrokDesktop",
      title: "My saved title",
    });

    assert.strictEqual(meta.id, "019bbbbb-cccc-4ddd-8eee-ffffffffffff");
    assert.strictEqual(meta.title, "My saved title");
    assert.strictEqual(meta.cwd, "E:\\Dev\\GrokDesktop");
    assert.strictEqual(meta.numMessages, 0);
    assert.ok(isClearedSessionStub(sessionPath));
    assert.ok(!fs.existsSync(path.join(sessionPath, "updates.jsonl")));
    assert.ok(!fs.existsSync(path.join(sessionPath, "chat_history.jsonl")));
    assert.ok(!fs.existsSync(path.join(sessionPath, "prompt_context.json")));
    assert.ok(!fs.existsSync(path.join(sessionPath, "terminal")));
    assert.ok(fs.existsSync(path.join(sessionPath, "summary.json")));

    const loaded = loadTranscript(sessionPath);
    assert.deepStrictEqual(loaded.messages, []);

    const stub = takeClearedSessionStub(sessionPath);
    assert.ok(stub);
    assert.strictEqual(stub.title, "My saved title");
    assert.ok(!fs.existsSync(sessionPath));
    assert.strictEqual(takeClearedSessionStub(sessionPath), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("takeClearedSessionStub leaves a live session alone", () => {
  const dir = tmpDir();
  const sessionPath = path.join(dir, "019ccccc-dddd-4eee-8fff-000000000000");
  try {
    fs.mkdirSync(sessionPath);
    fs.writeFileSync(path.join(sessionPath, "updates.jsonl"), "keep\n", "utf8");
    assert.strictEqual(takeClearedSessionStub(sessionPath), null);
    assert.ok(fs.existsSync(path.join(sessionPath, "updates.jsonl")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

if (failed) {
  process.exitCode = 1;
  throw new Error(`${failed} test(s) failed`);
}

console.log("all tests passed");
