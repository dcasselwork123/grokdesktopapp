"use strict";

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const FETCH_INTERVAL_MS = 30 * 60 * 1000;
const NETWORK_RETRY_MS = 5 * 60 * 1000;

let cache = {
  fetchedAt: 0,
  snapshot: null,
  fetchPromise: null,
};
let applying = false;
let applyPromise = null;
/** Full SHA of HEAD when this process first inspected the repo. */
let startedHead = null;

function repoRoot() {
  return process.env.GROK_DESKTOP_REPO || REPO_ROOT;
}

function looksLikeAppRepo(root) {
  try {
    return (
      fs.existsSync(path.join(root, "package.json")) &&
      fs.existsSync(path.join(root, "electron", "main.js"))
    );
  } catch {
    return false;
  }
}

function whichOnPath(cmd) {
  if (!cmd) return null;
  try {
    if (process.platform === "win32") {
      const out = require("child_process").execFileSync("where.exe", [cmd], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 4000,
      });
      const first = out
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)[0];
      if (first && fs.existsSync(first)) return first;
      return null;
    }
    const out = require("child_process").execFileSync("which", [cmd], {
      encoding: "utf8",
      timeout: 4000,
    });
    const first = out.trim().split(/\r?\n/)[0];
    if (first && fs.existsSync(first)) return first;
    return null;
  } catch {
    return null;
  }
}

function resolveGitBinary() {
  if (process.env.GIT_BIN && fs.existsSync(process.env.GIT_BIN)) {
    return process.env.GIT_BIN;
  }
  const named =
    whichOnPath(process.platform === "win32" ? "git.exe" : "git") ||
    whichOnPath("git");
  if (named) return named;
  if (process.platform === "win32") {
    const candidates = [
      path.join("C:", "Program Files", "Git", "cmd", "git.exe"),
      path.join("C:", "Program Files", "Git", "bin", "git.exe"),
      path.join("C:", "Program Files (x86)", "Git", "cmd", "git.exe"),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
  }
  return null;
}

function resolveNpmCommand() {
  if (process.env.NPM_BIN && fs.existsSync(process.env.NPM_BIN)) {
    return process.env.NPM_BIN;
  }
  if (process.platform === "win32") {
    return whichOnPath("npm.cmd") || "npm.cmd";
  }
  return whichOnPath("npm") || "npm";
}

function runFile(bin, args, { timeout = 60000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        cwd: cwd || repoRoot(),
        timeout,
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        env: process.env,
      },
      (err, stdout, stderr) => {
        if (err) {
          const wrapped = new Error(
            (stderr || stdout || err.message || String(err)).trim() ||
              "Command failed"
          );
          wrapped.code = err.code;
          wrapped.stdout = stdout || "";
          wrapped.stderr = stderr || "";
          reject(wrapped);
          return;
        }
        resolve({ stdout: stdout || "", stderr: stderr || "" });
      }
    );
  });
}

function parseCommitLines(stdout) {
  return String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      if (tab < 0) {
        const space = line.indexOf(" ");
        if (space < 0) return { sha: line, subject: "" };
        return {
          sha: line.slice(0, space).trim(),
          subject: line.slice(space + 1).trim(),
        };
      }
      return {
        sha: line.slice(0, tab).trim(),
        subject: line.slice(tab + 1).trim(),
      };
    })
    .filter((c) => c.sha);
}

function formatUpdateSummary(commits) {
  const list = Array.isArray(commits) ? commits.filter((c) => c && c.subject) : [];
  if (!list.length) return "";
  if (list.length === 1) return list[0].subject;
  const shown = list.slice(0, 5);
  const extra = list.length - shown.length;
  let text = shown.map((c) => `• ${c.subject}`).join("\n");
  if (extra > 0) text += `\n…and ${extra} more`;
  return text;
}

function emptySnapshot(extra = {}) {
  return {
    available: false,
    supported: false,
    applying: applying,
    current: null,
    latest: null,
    commits: [],
    summary: "",
    behind: 0,
    ahead: 0,
    branch: null,
    upstream: null,
    checkedAt: Date.now(),
    nextCheckAt: Date.now() + FETCH_INTERVAL_MS,
    ...extra,
  };
}

async function git(args, opts) {
  const bin = resolveGitBinary();
  if (!bin) {
    const err = new Error("Git is not installed or not on PATH.");
    err.code = "NO_GIT";
    throw err;
  }
  return runFile(bin, args, opts);
}

async function detectUpstream() {
  try {
    const { stdout } = await git([
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    ]);
    const name = stdout.trim();
    if (name) return name;
  } catch {
    /* no upstream */
  }
  for (const fallback of ["origin/main", "origin/master"]) {
    try {
      await git(["rev-parse", "--verify", fallback]);
      return fallback;
    } catch {
      /* try next */
    }
  }
  return null;
}

async function readCommit(ref) {
  const { stdout } = await git(["log", "-1", "--format=%h\t%s", ref]);
  const [row] = parseCommitLines(stdout);
  return row || null;
}

async function inspectRepo({ fetchRemote }) {
  const root = repoRoot();
  if (!looksLikeAppRepo(root)) {
    const err = new Error("This folder does not look like a Grok Desktop checkout.");
    err.code = "NOT_REPO";
    throw err;
  }
  try {
    const { stdout } = await git(["rev-parse", "--is-inside-work-tree"]);
    if (String(stdout).trim() !== "true") {
      const err = new Error("Not a git checkout.");
      err.code = "NOT_REPO";
      throw err;
    }
  } catch (err) {
    if (err.code === "NO_GIT") throw err;
    const wrapped = new Error("Not a git checkout.");
    wrapped.code = "NOT_REPO";
    throw wrapped;
  }

  if (fetchRemote) {
    await git(["fetch", "--quiet", "origin"], { timeout: 45000 });
  }

  let branch = null;
  try {
    const { stdout } = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
    branch = stdout.trim() || null;
  } catch {
    branch = null;
  }

  const upstream = await detectUpstream();
  if (!upstream) {
    return emptySnapshot({
      supported: true,
      error: "No origin/main (or upstream) to check.",
      branch,
    });
  }

  const current = await readCommit("HEAD");
  const latest = await readCommit(upstream);
  if (!startedHead) {
    try {
      const { stdout } = await git(["rev-parse", "HEAD"]);
      startedHead = stdout.trim() || current?.sha || null;
    } catch {
      startedHead = current?.sha || null;
    }
  }
  const { stdout: behindOut } = await git([
    "rev-list",
    "--count",
    `HEAD..${upstream}`,
  ]);
  const { stdout: aheadOut } = await git([
    "rev-list",
    "--count",
    `${upstream}..HEAD`,
  ]);
  const behind = Number(behindOut.trim()) || 0;
  const ahead = Number(aheadOut.trim()) || 0;
  let behindSinceStart = behind;
  if (startedHead) {
    try {
      const { stdout } = await git([
        "rev-list",
        "--count",
        `${startedHead}..${upstream}`,
      ]);
      behindSinceStart = Number(stdout.trim()) || 0;
    } catch {
      behindSinceStart = behind;
    }
  }

  let commits = [];
  const logRange =
    behindSinceStart > behind && startedHead
      ? `${startedHead}..${upstream}`
      : `HEAD..${upstream}`;
  if (behindSinceStart > 0 || behind > 0) {
    const { stdout: logOut } = await git([
      "log",
      "--format=%h\t%s",
      logRange,
    ]);
    commits = parseCommitLines(logOut);
  }

  const diskBehind = behind > 0 && ahead === 0;
  const launchedBehind = behindSinceStart > 0 && ahead === 0;
  return {
    available: diskBehind || launchedBehind,
    supported: true,
    applying,
    current,
    latest,
    commits,
    summary: formatUpdateSummary(commits),
    behind: Math.max(behind, behindSinceStart),
    ahead,
    branch,
    upstream,
    checkedAt: Date.now(),
    nextCheckAt: Date.now() + FETCH_INTERVAL_MS,
    error: ahead > 0 && (behind > 0 || behindSinceStart > 0)
      ? "Local branch has diverged from GitHub — update skipped."
      : ahead > 0
        ? "This checkout has local commits that are not on GitHub."
        : null,
  };
}

async function getUpdateStatus({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache.snapshot && now - cache.fetchedAt < FETCH_INTERVAL_MS) {
    return {
      ...cache.snapshot,
      applying,
      cached: true,
      nextCheckAt: cache.fetchedAt + FETCH_INTERVAL_MS,
    };
  }
  if (cache.fetchPromise) return cache.fetchPromise;

  cache.fetchPromise = (async () => {
    try {
      const snapshot = await inspectRepo({ fetchRemote: true });
      cache.snapshot = snapshot;
      cache.fetchedAt = Date.now();
      return { ...snapshot, applying, cached: false };
    } catch (err) {
      const snapshot = emptySnapshot({
        error: err.message || String(err),
        code: err.code || null,
      });
      if (err.code === "NO_GIT" || err.code === "NOT_REPO") {
        cache.snapshot = snapshot;
        cache.fetchedAt = Date.now();
      } else if (cache.snapshot) {
        cache.fetchedAt = Date.now() - FETCH_INTERVAL_MS + NETWORK_RETRY_MS;
        return {
          ...cache.snapshot,
          applying,
          cached: true,
          error: err.message || String(err),
        };
      } else {
        cache.snapshot = snapshot;
        cache.fetchedAt = Date.now() - FETCH_INTERVAL_MS + NETWORK_RETRY_MS;
      }
      return { ...snapshot, applying, cached: false };
    } finally {
      cache.fetchPromise = null;
    }
  })();

  return cache.fetchPromise;
}

function remoteBranchName(upstream) {
  const raw = String(upstream || "");
  if (raw.startsWith("origin/")) return raw.slice("origin/".length);
  const slash = raw.lastIndexOf("/");
  return slash >= 0 ? raw.slice(slash + 1) : raw || "main";
}

async function applyAppUpdate() {
  if (applying && applyPromise) return applyPromise;
  applying = true;

  applyPromise = (async () => {
    const before = await inspectRepo({ fetchRemote: true });
    if (!before.supported) {
      const err = new Error(before.error || "Updates are not available here.");
      err.code = "NOT_SUPPORTED";
      throw err;
    }
    if (before.ahead > 0) {
      const err = new Error(
        before.error || "Local commits would block a fast-forward update."
      );
      err.code = "DIVERGED";
      throw err;
    }
    if (!before.available) {
      cache.snapshot = before;
      cache.fetchedAt = Date.now();
      return {
        ok: true,
        pulled: false,
        installed: false,
        restarting: false,
        alreadyCurrent: true,
        ...before,
        applying: false,
      };
    }

    let oldHead = before.current?.sha || "HEAD";
    try {
      const { stdout } = await git(["rev-parse", "HEAD"]);
      if (stdout.trim()) oldHead = stdout.trim();
    } catch {
      /* keep short sha */
    }
    const branch = remoteBranchName(before.upstream);
    await git(["pull", "--ff-only", "origin", branch], { timeout: 120000 });

    let installed = false;
    let changedFiles = "";
    try {
      const { stdout } = await git(["diff", "--name-only", `${oldHead}..HEAD`]);
      changedFiles = stdout;
    } catch {
      changedFiles = "package.json\n";
    }
    const needsInstall = /(?:^|\/)package(?:-lock)?\.json$/m.test(changedFiles);
    if (needsInstall) {
      const npm = resolveNpmCommand();
      await runFile(npm, ["install"], { timeout: 300000 });
      installed = true;
    }

    const after = await inspectRepo({ fetchRemote: false });
    cache.snapshot = after;
    cache.fetchedAt = Date.now();
    return {
      ok: true,
      pulled: true,
      installed,
      restarting: true,
      alreadyCurrent: false,
      ...after,
      applying: false,
    };
  })()
    .finally(() => {
      applying = false;
      applyPromise = null;
    });

  return applyPromise;
}

function resetUpdateCache() {
  cache = { fetchedAt: 0, snapshot: null, fetchPromise: null };
  startedHead = null;
}

module.exports = {
  FETCH_INTERVAL_MS,
  parseCommitLines,
  formatUpdateSummary,
  getUpdateStatus,
  applyAppUpdate,
  resetUpdateCache,
  repoRoot,
};
