"use strict";

const fs = require("fs");
const path = require("path");

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  throw err;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

/** Resolve, strip trailing slashes, case-fold on win32. */
function normalizePathKey(p) {
  if (typeof p !== "string" || p.trim() === "") return "";
  let resolved = path.resolve(p);
  resolved = resolved.replace(/[\\/]+$/, "");
  if (process.platform === "win32") {
    resolved = resolved.toLowerCase();
  }
  return resolved;
}

function pathsEqual(a, b) {
  const left = normalizePathKey(a);
  const right = normalizePathKey(b);
  return left !== "" && left === right;
}

function isAllowedCwd(resolved, { knownFolders, lastCwd } = {}) {
  if (isNonEmptyString(lastCwd) && pathsEqual(resolved, lastCwd)) return true;
  if (!Array.isArray(knownFolders)) return false;
  return knownFolders.some((folder) => isNonEmptyString(folder) && pathsEqual(resolved, folder));
}

/**
 * Remote chat may only run in a known project folder (session cwd) or lastCwd.
 * Returns path.resolve(cwd). Throws { status, message } on failure.
 */
function assertRemoteCwd(cwd, { knownFolders, lastCwd } = {}) {
  if (!isNonEmptyString(cwd)) {
    fail(400, "Working folder is required.");
  }

  const resolved = path.resolve(cwd);

  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    fail(400, "Working folder does not exist.");
  }
  if (!stat.isDirectory()) {
    fail(400, "Working folder does not exist.");
  }

  if (!isAllowedCwd(resolved, { knownFolders, lastCwd })) {
    fail(400, "Remote chat can only use a known project folder.");
  }

  return resolved;
}

function findModel(models, modelId) {
  if (!Array.isArray(models)) return null;
  return models.find((m) => m && m.id === modelId) || null;
}

function findEffort(model, effortId) {
  const efforts = (model && model.efforts) || [];
  return efforts.find((e) => e && (e.id === effortId || e.value === effortId)) || null;
}

function defaultModel(models) {
  if (!Array.isArray(models) || models.length === 0) return null;
  return findModel(models, "grok-4.6") || models[0] || null;
}

function defaultEffort(model) {
  if (findEffort(model, "high")) return findEffort(model, "high");
  if (model && isNonEmptyString(model.defaultEffort)) {
    const fromDefault = findEffort(model, model.defaultEffort);
    if (fromDefault) return fromDefault;
  }
  const first = model && Array.isArray(model.efforts) ? model.efforts[0] : null;
  return first || null;
}

/**
 * Resolve model + effort against loadModels() catalog.
 * Returns { model, effort } ids. Throws { status, message } when unknown.
 */
function assertModelEffort(model, effort, models) {
  const modelId = isNonEmptyString(model) ? String(model).trim() : "";
  const chosenModel = modelId ? findModel(models, modelId) : defaultModel(models);
  if (!chosenModel || !chosenModel.id) {
    fail(400, modelId ? `Unknown model: ${modelId}` : "Unknown model.");
  }

  const effortId = isNonEmptyString(effort) ? String(effort).trim() : "";
  const chosenEffort = effortId ? findEffort(chosenModel, effortId) : defaultEffort(chosenModel);
  if (!chosenEffort || !isNonEmptyString(chosenEffort.id || chosenEffort.value)) {
    fail(400, effortId ? `Unknown effort: ${effortId}` : "Unknown effort for this model.");
  }

  return {
    model: chosenModel.id,
    effort: chosenEffort.id || chosenEffort.value,
  };
}

/** Unique non-empty session.cwd values (Windows-safe path compare). */
function listKnownProjectFolders(sessions) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(sessions)) return out;
  for (const session of sessions) {
    const cwd = session && session.cwd;
    if (!isNonEmptyString(cwd)) continue;
    const key = normalizePathKey(cwd);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(cwd);
  }
  return out;
}

function listKnownProjectFoldersFromDisk() {
  const { listSessions } = require("./grokService");
  return listKnownProjectFolders(listSessions());
}

function createChatRateLimiter({ windowMs = 60_000, max = 30 } = {}) {
  const hitsByKey = new Map();

  function check(key) {
    const bucket = key == null || key === "" ? "unknown" : String(key);
    const now = Date.now();
    const recent = (hitsByKey.get(bucket) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      fail(429, "Too many chat requests. Try again in a minute.");
    }
    recent.push(now);
    hitsByKey.set(bucket, recent);
  }

  return { check };
}

module.exports = {
  assertRemoteCwd,
  assertModelEffort,
  listKnownProjectFolders,
  listKnownProjectFoldersFromDisk,
  createChatRateLimiter,
};
