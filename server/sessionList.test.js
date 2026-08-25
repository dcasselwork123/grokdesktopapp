"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { listSessions, findSessionById, searchSessions } = require("./grokService");

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
  return fs.mkdtempSync(path.join(os.tmpdir(), "gd-session-list-"));
}

function writeSession(groupPath, id, { title, cwd, sessionKind } = {}) {
  const sessionPath = path.join(groupPath, id);
  fs.mkdirSync(sessionPath, { recursive: true });
  const summary = {
    info: { id, cwd: cwd || "C:\\PolybotV3" },
    generated_title: title || "Untitled",
    last_active_at: "2026-08-25T20:00:00Z",
  };
  if (sessionKind) summary.session_kind = sessionKind;
  fs.writeFileSync(path.join(sessionPath, "summary.json"), JSON.stringify(summary), "utf8");
  return sessionPath;
}

function withGrokHome(home, fn) {
  const prev = process.env.GROK_HOME;
  process.env.GROK_HOME = home;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = prev;
  }
}

test("listSessions omits CLI subagent children from the sidebar", () => {
  const home = tmpDir();
  const cwd = "C:\\PolybotV3";
  const groupPath = path.join(home, "sessions", encodeURIComponent(cwd));
  const parentId = "0d568364-3a76-4d5f-989b-f13e5cda871c";
  const childId = "01a03aa1-18d3-7f61-b315-f83d87e013aa";
  const siblingId = "01a02a59-2d27-7f43-bc12-c0cb3557f8fe";
  try {
    fs.mkdirSync(groupPath, { recursive: true });
    fs.writeFileSync(path.join(groupPath, ".cwd"), cwd, "utf8");
    writeSession(groupPath, parentId, { title: "Cut Alchemy usage", cwd });
    writeSession(groupPath, siblingId, { title: "RN1 golden run", cwd });
    writeSession(groupPath, childId, {
      title: "Polymarket API alternatives",
      cwd,
      sessionKind: "subagent",
    });
    fs.mkdirSync(path.join(groupPath, parentId, "subagents", childId), { recursive: true });

    withGrokHome(home, () => {
      const listed = listSessions({ limit: 100 });
      const ids = listed.map((s) => s.id);
      assert.ok(ids.includes(parentId));
      assert.ok(ids.includes(siblingId));
      assert.ok(!ids.includes(childId));
      assert.strictEqual(listed.length, 2);

      const all = listSessions({ limit: 100, includeSubagents: true });
      assert.ok(all.some((s) => s.id === childId));
      const child = all.find((s) => s.id === childId);
      assert.strictEqual(child.sessionKind, "subagent");

      const found = findSessionById(childId);
      assert.ok(found);
      assert.strictEqual(found.id, childId);
      assert.strictEqual(found.sessionKind, "subagent");
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("listSessions still shows adopted chats that lack session_kind", () => {
  const home = tmpDir();
  const cwd = "C:\\PolybotV3";
  const groupPath = path.join(home, "sessions", encodeURIComponent(cwd));
  const parentId = "de665e59-8a02-4a5c-b334-e3b5917ba3e2";
  const adoptedId = "01a02a59-2d27-7f43-bc12-c0cb3557f8fe";
  try {
    fs.mkdirSync(groupPath, { recursive: true });
    writeSession(groupPath, parentId, { title: "Main chat", cwd });
    writeSession(groupPath, adoptedId, { title: "RN1 golden run", cwd });
    fs.mkdirSync(path.join(groupPath, parentId, "subagents", adoptedId), { recursive: true });

    withGrokHome(home, () => {
      const ids = listSessions({ limit: 100 }).map((s) => s.id);
      assert.ok(ids.includes(parentId));
      assert.ok(ids.includes(adoptedId));
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("searchSessions does not return hidden subagent chats", () => {
  const home = tmpDir();
  const cwd = "C:\\PolybotV3";
  const groupPath = path.join(home, "sessions", encodeURIComponent(cwd));
  const parentId = "0d568364-3a76-4d5f-989b-f13e5cda871c";
  const childId = "01a03aa1-18d3-7f61-b315-f83d87e013aa";
  try {
    fs.mkdirSync(groupPath, { recursive: true });
    writeSession(groupPath, parentId, { title: "Cut Alchemy usage via Polymarket", cwd });
    writeSession(groupPath, childId, {
      title: "Polymarket API alternatives to Alchemy RPC",
      cwd,
      sessionKind: "subagent",
    });

    withGrokHome(home, () => {
      const hits = searchSessions("Alchemy");
      assert.ok(hits.some((h) => h.id === parentId));
      assert.ok(!hits.some((h) => h.id === childId));
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

if (failed) {
  process.exitCode = 1;
  throw new Error(`${failed} test(s) failed`);
}

console.log("all tests passed");
