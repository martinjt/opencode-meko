/**
 * logger.mjs — NDJSON event logger for migration runs.
 *
 * One JSON object per line. No dependency on the node logger used by
 * the installer (this one writes to a file fd on disk, not stderr).
 */

import fs from "node:fs";

/**
 * @typedef {Object} Logger
 * @property {(event: string, fields?: object) => void} info
 * @property {(event: string, fields?: object) => void} warn
 * @property {(event: string, fields?: object) => void} error
 * @property {() => void} close
 */

/**
 * Create a logger that appends NDJSON to `logPath`. Also forwards to
 * `process.stderr` when `tee` is true (useful in foreground dry-runs).
 *
 * @param {string} logPath - Absolute file path.
 * @param {object} [opts]
 * @param {string} [opts.runId]
 * @param {boolean} [opts.tee]
 * @returns {Logger}
 */
export function createLogger(logPath, opts = {}) {
  const fd = fs.openSync(logPath, "a");
  const runId = opts.runId;
  const tee = !!opts.tee;

  function emit(level, event, fields) {
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        level,
        event,
        runId,
        ...(fields || {}),
      }) + "\n";
    try {
      fs.writeSync(fd, line);
    } catch {
      /* best effort */
    }
    if (tee) {
      process.stderr.write(line);
    }
  }

  return {
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
    close() {
      try {
        fs.closeSync(fd);
      } catch {
        /* best effort */
      }
    },
  };
}

/**
 * Create a no-op logger. Useful in tests or `--dry-run` before the
 * run directory exists.
 *
 * @returns {Logger}
 */
export function nullLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    close: () => {},
  };
}
