/**
 * version-check.mjs — Optional npm-registry version probe.
 *
 * Never throws, never rejects, never blocks the install. Used by the installer
 * to surface an upgrade hint when a newer @yugabytedb/meko-mcp is available.
 *
 * Zero external dependencies (node:https + node:url only), matching the
 * Design Principles documented in installer/README.md.
 */

import https from "node:https";
import { URL } from "node:url";

const REGISTRY_URL =
  "https://registry.npmjs.org/@yugabytedb/meko-mcp/latest";

/**
 * Semver-ish comparator. Returns -1 if a<b, 0 if equal, 1 if a>b, or `null`
 * when the comparison cannot be ordered (e.g. a side contains non-numeric
 * pre-release tags).
 *
 * Deliberately minimal: splits on ".", maps to Number, and compares
 * lexicographically over the resulting tuple. Does NOT order pre-release
 * tags (`1.0.0-alpha.1`) — for the installer we only care about stable
 * releases like 1.0.8 vs 1.0.9. The `null` sentinel lets callers
 * distinguish "equal" (0) from "incomparable" and fall back to strict
 * string equality only when actually needed, so identical-but-formatted-
 * differently versions like `1.0` vs `1.0.0` are NOT flagged as outdated.
 */
export function compareSemver(a, b) {
  const partsA = String(a).split(".").map((x) => Number(x));
  const partsB = String(b).split(".").map((x) => Number(x));
  const hasNaN = partsA.some((n) => Number.isNaN(n)) || partsB.some((n) => Number.isNaN(n));
  if (hasNaN) {
    return a === b ? 0 : null;
  }
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const x = partsA[i] ?? 0;
    const y = partsB[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/**
 * Fetch the latest published version of @yugabytedb/meko-mcp from the npm
 * registry and compare against `currentVersion`.
 *
 * Never throws. On any network error, timeout, or parse failure, returns
 * `{ current, latest: null, isOutdated: false, error: <string> }`.
 *
 * @param {object} opts
 * @param {string} opts.currentVersion — the installed version to compare against.
 * @param {number} [opts.timeoutMs=2000] — hard cap on the registry request.
 * @param {boolean} [opts.background=false] — when true, unref the request's
 *   underlying socket so an in-flight probe does not keep the Node process
 *   alive after the main install completes. Callers who `await` the result
 *   (e.g. the `--check-updates` handler) should leave this false.
 * @returns {Promise<{current: string, latest: string|null, isOutdated: boolean, error?: string}>}
 */
export async function checkLatest({ currentVersion, timeoutMs = 2000, background = false, _requestImpl } = {}) {
  const requestImpl = _requestImpl ?? https.request;

  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve({ current: currentVersion, ...result });
    };

    let url;
    try {
      url = new URL(REGISTRY_URL);
    } catch (err) {
      return done({ latest: null, isOutdated: false, error: `bad-url: ${err.message}` });
    }

    let req;
    try {
      req = requestImpl(
        {
          method: "GET",
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname + url.search,
          headers: {
            Accept: "application/json",
            "User-Agent": `@yugabytedb/meko-mcp/${currentVersion}`,
          },
        },
        (res) => {
          if (res.statusCode && res.statusCode >= 400) {
            // Drain so the socket can be freed, then report error.
            res.resume();
            return done({
              latest: null,
              isOutdated: false,
              error: `http ${res.statusCode}`,
            });
          }
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            try {
              const parsed = JSON.parse(body);
              const latest = parsed?.version;
              if (typeof latest !== "string" || latest.length === 0) {
                return done({
                  latest: null,
                  isOutdated: false,
                  error: "registry response missing .version",
                });
              }
              let isOutdated;
              const cmp = compareSemver(currentVersion, latest);
              if (cmp === null) {
                // Incomparable (non-numeric tags). Fall back to strict
                // string inequality; only flag outdated if they actually
                // differ as strings.
                isOutdated = currentVersion !== latest;
              } else {
                isOutdated = cmp < 0;
              }
              done({ latest, isOutdated });
            } catch (err) {
              done({
                latest: null,
                isOutdated: false,
                error: `parse: ${err.message}`,
              });
            }
          });
          res.on("error", (err) => {
            done({ latest: null, isOutdated: false, error: err.message });
          });
        },
      );
    } catch (err) {
      return done({ latest: null, isOutdated: false, error: err.message });
    }

    const timer = setTimeout(() => {
      try {
        req.destroy(new Error("timeout"));
      } catch {
        /* ignore */
      }
      done({ latest: null, isOutdated: false, error: "timeout" });
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    // In background mode, unref the socket so Node can exit as soon as the
    // main work finishes even if the registry request is still in flight.
    // The socket appears on "socket" — not on the request object itself at
    // construction time — so we subscribe rather than reaching for req.socket.
    if (background) {
      req.on("socket", (socket) => {
        if (socket && typeof socket.unref === "function") socket.unref();
      });
    }

    req.on("error", (err) => {
      clearTimeout(timer);
      done({ latest: null, isOutdated: false, error: err.message });
    });

    try {
      req.end();
    } catch (err) {
      clearTimeout(timer);
      done({ latest: null, isOutdated: false, error: err.message });
    }
  });
}
