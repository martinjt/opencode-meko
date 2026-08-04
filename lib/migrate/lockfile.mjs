/**
 * lockfile.mjs — PID-based lockfile for migration runs.
 *
 * Lock contents: {pid, runId, startedAt}. A lock is considered stale
 * if the PID it names no longer has a live process.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * @typedef {Object} LockInfo
 * @property {number} pid
 * @property {string} runId
 * @property {string} startedAt  ISO timestamp.
 */

/**
 * Acquire a lock at `lockPath`. Returns `{acquired: true}` on success,
 * or `{acquired: false, holder: LockInfo, stale: boolean}` if another
 * process already holds it.
 *
 * @param {string} lockPath
 * @param {{pid?: number, runId: string}} info
 * @param {{force?: boolean}} [opts]
 * @returns {{acquired: true} | {acquired: false, holder: LockInfo, stale: boolean}}
 */
export function acquire(lockPath, info, opts = {}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  const existing = read(lockPath);
  if (existing) {
    const stale = isStale(existing);
    if (!stale && !opts.force) {
      return { acquired: false, holder: existing, stale: false };
    }
    // Stale or force — clobber.
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
  }

  const payload = {
    pid: info.pid ?? process.pid,
    runId: info.runId,
    startedAt: new Date().toISOString(),
  };

  // O_WRONLY | O_CREAT | O_EXCL — fail if another process got here first.
  try {
    const fd = fs.openSync(lockPath, "wx");
    fs.writeSync(fd, JSON.stringify(payload));
    fs.closeSync(fd);
    return { acquired: true };
  } catch (err) {
    if (err.code === "EEXIST") {
      const holder = read(lockPath);
      return {
        acquired: false,
        holder: holder ?? { pid: -1, runId: "?", startedAt: "?" },
        stale: false,
      };
    }
    throw err;
  }
}

/**
 * Release a lock held by this process. Safe to call multiple times.
 *
 * @param {string} lockPath
 */
export function release(lockPath) {
  try {
    const holder = read(lockPath);
    if (holder && holder.pid !== process.pid) {
      // Not ours — don't clobber.
      return;
    }
    fs.unlinkSync(lockPath);
  } catch {
    /* best effort */
  }
}

/**
 * Read a lockfile, returning null if missing or unreadable.
 *
 * @param {string} lockPath
 * @returns {LockInfo | null}
 */
export function read(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Is the process named in `info` no longer alive?
 *
 * Uses `process.kill(pid, 0)` which throws ESRCH for dead PIDs and
 * succeeds (or throws EPERM) for live ones.
 *
 * @param {LockInfo} info
 * @returns {boolean}
 */
export function isStale(info) {
  if (!info || typeof info.pid !== "number" || info.pid <= 0) return true;
  try {
    process.kill(info.pid, 0);
    return false; // live
  } catch (err) {
    if (err.code === "EPERM") return false; // live, owned by another user
    return true; // ESRCH or similar
  }
}
