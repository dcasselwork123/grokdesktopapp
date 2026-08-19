"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  normalizeSearchQuery,
  sessionMetaMatches,
  findTranscriptHit,
  searchSessions,
} = require("./sessionSearch");

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
  return fs.mkdtempSync(path.join(os.tmpdir(), "gd-search-"));
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

function writeSession(root, id, { title, cwd, userText, assistantText } = {}) {
  const sessionPath = path.join(root, id);
  fs.mkdirSync(sessionPath, { recursive: true });
  fs.writeFileSync(
    path.join(sessionPath, "summary.json"),
    JSON.stringify({
      info: { id, cwd: cwd || "C:\\Dev\\GrokDesktop" },
      generated_title: title || "Untitled",
      last_active_at: "2026-08-19T12:00:00Z",
    }) + "\n",
    "utf8"
  );
  const lines = [];
  if (userText) {
    lines.push(
      wrapUpdate("user_message_chunk", { content: { type: "text", text: userText } }, 1)
    );
  }
  if (assistantText) {
    lines.push(
      wrapUpdate("agent_message_chunk", { content: { type: "text", text: assistantText } }, 2)
    );
  }
  if (lines.length) {
    fs.writeFileSync(path.join(sessionPath, "updates.jsonl"), lines.join("\n") + "\n", "utf8");
  }
  return {
    id,
    title: title || "Untitled",
    cwd: cwd || "C:\\Dev\\GrokDesktop",
    project: path.basename(cwd || "C:\\Dev\\GrokDesktop"),
    updatedAt: "2026-08-19T12:00:00Z",
    path: sessionPath,
  };
}

test("normalizeSearchQuery trims and caps", () => {
  assert.strictEqual(normalizeSearchQuery("  hello   world  "), "hello world");
  assert.strictEqual(normalizeSearchQuery(""), "");
  assert.strictEqual(normalizeSearchQuery("x".repeat(250)).length, 200);
});

test("sessionMetaMatches title, project, and cwd", () => {
  const s = {
    id: "a",
    title: "Landing Page Three-Card Design",
    project: "GrokDesktop",
    cwd: "E:\\Dev\\GrokDesktop",
  };
  assert.strictEqual(sessionMetaMatches(s, "landing"), true);
  assert.strictEqual(sessionMetaMatches(s, "GROKDESKTOP"), true);
  assert.strictEqual(sessionMetaMatches(s, "E:\\Dev"), true);
  assert.strictEqual(sessionMetaMatches(s, "whales"), false);
  assert.strictEqual(sessionMetaMatches(s, "   "), false);
});

test("searchSessions matches title without leaking path", () => {
  const dir = tmpDir();
  try {
    const a = writeSession(dir, "sess-title", {
      title: "Mac Build Question",
      cwd: "C:\\Dev\\GrokDesktop",
      userText: "how do I ship this",
    });
    const b = writeSession(dir, "sess-other", {
      title: "Unrelated chat",
      cwd: "C:\\Dev\\Other",
      userText: "hello",
    });
    const hits = searchSessions("mac build", { sessions: [a, b] });
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].id, "sess-title");
    assert.strictEqual(hits[0].match, "meta");
    assert.ok(!("path" in hits[0]));
    assert.ok(!JSON.stringify(hits).includes(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("searchSessions finds transcript text and returns a snippet", () => {
  const dir = tmpDir();
  try {
    const a = writeSession(dir, "sess-body", {
      title: "Status inquiry",
      cwd: "C:\\Dev\\PolybotV3",
      userText: "what is the current software run status",
      assistantText: "The worker queue is idle.",
    });
    const b = writeSession(dir, "sess-miss", {
      title: "New Whales",
      cwd: "C:\\Dev\\GrokDesktop",
      userText: "draw a whale",
    });
    const hits = searchSessions("worker queue", { sessions: [a, b] });
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].id, "sess-body");
    assert.strictEqual(hits[0].match, "transcript");
    assert.ok(/worker queue/i.test(hits[0].snippet));
    assert.ok(!("path" in hits[0]));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("findTranscriptHit ignores tool JSON that is not chat text", () => {
  const dir = tmpDir();
  try {
    const sessionPath = path.join(dir, "sess-json");
    fs.mkdirSync(sessionPath);
    fs.writeFileSync(
      path.join(sessionPath, "updates.jsonl"),
      wrapUpdate("user_message_chunk", { content: { type: "text", text: "hello there" } }, 1) +
        "\n",
      "utf8"
    );
    const hit = findTranscriptHit(sessionPath, "hello");
    assert.ok(hit);
    assert.ok(/hello/i.test(hit.snippet));
    assert.strictEqual(findTranscriptHit(sessionPath, "sessionUpdate"), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("empty query returns no hits", () => {
  const hits = searchSessions("  ", {
    sessions: [{ id: "a", title: "Hi", project: "X", cwd: "C:\\X", path: "nope" }],
  });
  assert.deepStrictEqual(hits, []);
});

if (failed) {
  process.exitCode = 1;
  throw new Error(`${failed} test(s) failed`);
}

console.log("all tests passed");
