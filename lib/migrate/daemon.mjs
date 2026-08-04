/**
 * daemon.mjs — Detached-child spawn helper and run-id utilities.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * `YYYYMMDD-HHMMSS-<6-hex>`.
 */
export function generateRunId() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const stamp =
    d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "-" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds());
  const rand = crypto.randomBytes(3).toString("hex");
  return `${stamp}-${rand}`;
}

/**
 * Root directory for all migrate runs.
 *
 * @param {object} [opts]
 * @param {string} [opts.home]
 */
export function migrateRoot(opts = {}) {
  const home = opts.home ?? process.env.HOME;
  return path.join(home, ".meko", "migrate");
}

/**
 * Spawn a detached child running the installer binary with `--__migrate-child`.
 *
 * @param {object} opts
 * @param {string} opts.scriptPath   Absolute path to create-meko-setup.mjs.
 * @param {string} opts.runId
 * @param {string[]} opts.args       Pass-through CLI args (e.g., ["--scope","user"]).
 * @param {string} opts.logFilePath  File to redirect child stdout+stderr to.
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {string} [opts.cwd]
 * @returns {number}                 The detached child's PID.
 */
export function forkDetached(opts) {
  fs.mkdirSync(path.dirname(opts.logFilePath), { recursive: true });
  const logFd = fs.openSync(opts.logFilePath, "a");

  const child = spawn(
    process.execPath,
    [opts.scriptPath, "--__migrate-child", "--run-id", opts.runId, ...opts.args],
    {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: opts.env ?? process.env,
      cwd: opts.cwd ?? process.cwd(),
    },
  );
  child.unref();
  return child.pid;
}
