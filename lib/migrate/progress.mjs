/**
 * progress.mjs — Lightweight progress snapshots for `--migrate-status`.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * @typedef {Object} Progress
 * @property {string} runId
 * @property {string} scope
 * @property {string} startedAt
 * @property {string|null} finishedAt
 * @property {"running"|"done"|"failed"|"interrupted"} status
 * @property {string|null} currentAgent
 * @property {string|null} currentSession
 * @property {Counts} counts
 *
 * @typedef {Object} Counts
 * @property {number} sessionsPlanned
 * @property {number} sessionsDone
 * @property {number} messagesSent
 * @property {number} memoryPairsSent
 * @property {number} memoriesFromMD
 * @property {number} warnings
 * @property {number} memoryErrors
 */

/**
 * @returns {Progress}
 */
export function initial(runId, scope) {
  return {
    runId,
    scope,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: "running",
    currentAgent: null,
    currentSession: null,
    counts: {
      sessionsPlanned: 0,
      sessionsDone: 0,
      messagesSent: 0,
      memoryPairsSent: 0,
      memoriesFromMD: 0,
      warnings: 0,
      memoryErrors: 0,
    },
  };
}

/**
 * Atomic write.
 *
 * @param {string} progressPath
 * @param {Progress} progress
 */
export function write(progressPath, progress) {
  fs.mkdirSync(path.dirname(progressPath), { recursive: true });
  const tmp = `${progressPath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(progress, null, 2));
  fs.renameSync(tmp, progressPath);
}

/**
 * @param {string} progressPath
 * @returns {Progress | null}
 */
export function read(progressPath) {
  try {
    return JSON.parse(fs.readFileSync(progressPath, "utf8"));
  } catch {
    return null;
  }
}
