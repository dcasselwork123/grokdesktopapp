"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  normalizeRelMedia,
  extractMediaPaths,
  listSessionMedia,
  resolveSessionMediaFile,
  attachMediaToMessages,
  isMediaToolName,
} = require("./sessionMedia");

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
  return fs.mkdtempSync(path.join(os.tmpdir(), "gd-media-"));
}

test("normalizeRelMedia accepts session-relative images and videos", () => {
  assert.strictEqual(normalizeRelMedia("images/1.jpg"), "images/1.jpg");
  assert.strictEqual(normalizeRelMedia("videos\\2.mp4"), "videos/2.mp4");
  assert.strictEqual(normalizeRelMedia("../images/1.jpg"), null);
  assert.strictEqual(normalizeRelMedia("images/../../secret.jpg"), null);
  assert.strictEqual(normalizeRelMedia("C:\\Windows\\x.jpg"), null);
});

test("extractMediaPaths finds relative and absolute session media", () => {
  const fromText = extractMediaPaths("Saved as images/1.jpg in the session folder.");
  assert.deepStrictEqual(fromText, ["images/1.jpg"]);
  const fromAbs = extractMediaPaths(
    "C:\\Users\\me\\.grok\\sessions\\proj\\abc\\images\\2.png"
  );
  assert.deepStrictEqual(fromAbs, ["images/2.png"]);
  const fromObj = extractMediaPaths({
    rawOutput: { path: "/home/me/.grok/sessions/x/id/images/3.webp" },
  });
  assert.deepStrictEqual(fromObj, ["images/3.webp"]);
});

test("list and resolve stay inside the session folder", () => {
  const dir = tmpDir();
  try {
    fs.mkdirSync(path.join(dir, "images"));
    fs.writeFileSync(path.join(dir, "images", "1.jpg"), "x");
    fs.writeFileSync(path.join(dir, "images", "note.txt"), "nope");
    assert.deepStrictEqual(listSessionMedia(dir), ["images/1.jpg"]);
    const ok = resolveSessionMediaFile(dir, "images/1.jpg");
    assert.ok(ok && ok.endsWith(`${path.sep}1.jpg`));
    assert.strictEqual(resolveSessionMediaFile(dir, "images/../images/1.jpg"), null);
    assert.strictEqual(resolveSessionMediaFile(dir, "images/note.txt"), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("attachMediaToMessages uses tool output then leftover files", () => {
  const dir = tmpDir();
  try {
    fs.mkdirSync(path.join(dir, "images"));
    fs.writeFileSync(path.join(dir, "images", "1.jpg"), "a");
    fs.writeFileSync(path.join(dir, "images", "2.jpg"), "b");
    const messages = [
      { role: "user", text: "draw a cat" },
      {
        role: "assistant",
        text: "Here you go.",
        tools: [{ name: "image_gen", status: "completed", media: ["images/1.jpg"] }],
      },
      {
        role: "assistant",
        text: "And another.",
        tools: [{ name: "image_gen", status: "completed" }],
      },
    ];
    attachMediaToMessages(dir, messages);
    assert.deepStrictEqual(messages[1].media, ["images/1.jpg"]);
    assert.deepStrictEqual(messages[2].media, ["images/2.jpg"]);
    assert.ok(isMediaToolName("image_edit"));
    assert.ok(!isMediaToolName("read_file"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("attachMediaToMessages ignores images/ paths from non-media tools", () => {
  const dir = tmpDir();
  try {
    fs.mkdirSync(path.join(dir, "images"));
    fs.writeFileSync(path.join(dir, "images", "1.jpg"), "a");
    const messages = [
      { role: "user", text: "search the repo" },
      {
        role: "assistant",
        text: "found 18 matches",
        tools: [
          {
            name: "grep",
            status: "completed",
            output: "renderer/app.js:1511: ![alt](images/1.jpg)",
          },
        ],
      },
    ];
    attachMediaToMessages(dir, messages);
    assert.deepStrictEqual(messages[1].media || [], []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("attachMediaToMessages still takes a path mentioned in assistant text", () => {
  const dir = tmpDir();
  try {
    const messages = [
      { role: "user", text: "draw a cat" },
      {
        role: "assistant",
        text: "Saved as images/1.jpg",
        tools: [{ name: "image_gen", status: "completed", media: ["images/1.jpg"] }],
      },
    ];
    attachMediaToMessages(dir, messages);
    assert.deepStrictEqual(messages[1].media, ["images/1.jpg"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("attachMediaToMessages does not treat code talk as generated media", () => {
  const dir = tmpDir();
  try {
    const messages = [
      { role: "user", text: "why is /imagine doubled?" },
      {
        role: "assistant",
        text: "renderMarkdown turns images/1.jpg into a second img tag",
        tools: [{ name: "grep", status: "completed" }],
      },
    ];
    attachMediaToMessages(dir, messages);
    assert.deepStrictEqual(messages[1].media || [], []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

if (failed) {
  process.exitCode = 1;
  throw new Error(`${failed} test(s) failed`);
}

console.log("all tests passed");
