/**
 * mcp-client.mjs — Thin wrapper over mcp-transport.mjs for the migrator.
 *
 * Adds:
 *   - session management (initialize once, reuse sessionId)
 *   - a concurrency semaphore on outgoing tool calls
 *   - exponential-backoff retries on transient errors
 *   - a small helper that parses the JSON text returned by Meko tools
 */

import {
  jsonRpcRequest,
  classifyError,
  mcpInitialize,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from "../mcp-transport.mjs";

/**
 * @typedef {Object} CallOptions
 * @property {number} [timeoutMs]
 * @property {number} [maxRetries]  Default 3. 0 disables retry.
 * @property {boolean} [fireAndForget]  If true, failures log+return null.
 */

export class McpClient {
  /**
   * @param {object} opts
   * @param {string} opts.url
   * @param {string|null} opts.apiKey
   * @param {number} [opts.concurrency]  Default 4.
   * @param {number} [opts.timeoutMs]
   * @param {{info?: Function, warn?: Function, error?: Function}} [opts.log]
   */
  constructor(opts) {
    this.url = opts.url;
    this.apiKey = opts.apiKey ?? null;
    // Defense in depth: NaN or anything non-positive would leave the
    // semaphore permanently blocked (queued waiters never fire because
    // `inflight < NaN` is always false). Fall back to the default.
    const concurrency = Number(opts.concurrency);
    this.concurrency = Number.isFinite(concurrency) && concurrency >= 1
      ? Math.floor(concurrency)
      : 4;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.log = opts.log ?? {};
    this.sessionId = null;
    this._reqId = 100;
    this._inflight = 0;
    this._waiters = [];
  }

  async connect() {
    const res = await mcpInitialize(this.url, this.apiKey, {
      clientName: "meko-migrate",
      timeoutMs: this.timeoutMs,
    });
    if (!res.ok) {
      const err = new Error(res.message || "initialize failed");
      err.statusCode = res.statusCode;
      throw err;
    }
    this.sessionId = res.sessionId;
  }

  /**
   * Call a tool over the open session.
   *
   * @param {string} name
   * @param {object} args
   * @param {CallOptions} [opts]
   * @returns {Promise<{ok: boolean, result?: object, text?: string, error?: object, statusCode?: number}>}
   */
  async callTool(name, args, opts = {}) {
    await this._acquire();
    try {
      return await this._callWithRetry(name, args, opts);
    } finally {
      this._release();
    }
  }

  async _callWithRetry(name, args, opts) {
    const maxRetries = opts.maxRetries ?? 3;
    let lastErr = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const out = await this._callOnce(name, args, opts);
        // HTTP-level failures inside a structured response go through
        // _callOnce too; it throws on non-2xx. A tool-level error surfaces
        // as `{ok:false, error:{...}}` and we return it without retry.
        return out;
      } catch (err) {
        lastErr = err;
        const code = err.statusCode;
        if (code === 401 || code === 403) {
          // Auth is fatal; surface immediately.
          throw err;
        }
        if (attempt < maxRetries) {
          const delay = 1000 * 2 ** attempt;
          this.log.warn?.("mcp_retry", {
            tool: name,
            attempt: attempt + 1,
            delay_ms: delay,
            error: err.message,
          });
          await sleep(delay);
          continue;
        }
      }
    }
    if (opts.fireAndForget) {
      this.log.warn?.("mcp_fire_and_forget_failed", {
        tool: name,
        error: lastErr?.message,
      });
      return { ok: false, error: { message: lastErr?.message ?? "unknown" } };
    }
    throw lastErr;
  }

  async _callOnce(name, args, opts) {
    const payload = {
      jsonrpc: "2.0",
      id: this._reqId++,
      method: "tools/call",
      params: { name, arguments: args },
    };

    let res;
    try {
      res = await jsonRpcRequest(this.url, payload, this.apiKey, this.sessionId, {
        timeoutMs: opts.timeoutMs ?? this.timeoutMs,
      });
    } catch (err) {
      const e = new Error(classifyError(err, this.timeoutMs));
      e.cause = err;
      throw e;
    }

    if (res.statusCode === 401 || res.statusCode === 403) {
      const e = new Error(
        `Auth rejected by server (HTTP ${res.statusCode}). Check Authorization header / API key.`,
      );
      e.statusCode = res.statusCode;
      throw e;
    }

    if (res.statusCode < 200 || res.statusCode >= 300) {
      const e = new Error(
        `tools/call ${name} returned HTTP ${res.statusCode}: ${res.body.slice(0, 200)}`,
      );
      e.statusCode = res.statusCode;
      throw e;
    }

    let parsed;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      const e = new Error(
        `tools/call ${name} returned non-JSON: ${res.body.slice(0, 200)}`,
      );
      e.statusCode = res.statusCode;
      throw e;
    }

    if (parsed.error) {
      return {
        ok: false,
        error: parsed.error,
        statusCode: res.statusCode,
      };
    }

    const text = extractFirstText(parsed.result);
    return {
      ok: true,
      result: parsed.result,
      text,
      statusCode: res.statusCode,
    };
  }

  // --- Semaphore -----------------------------------------------------------

  _acquire() {
    if (this._inflight < this.concurrency) {
      this._inflight++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this._waiters.push(() => {
        this._inflight++;
        resolve();
      });
    });
  }

  _release() {
    this._inflight--;
    const next = this._waiters.shift();
    if (next) next();
  }
}

/**
 * Meko tool results come back as `{content: [{type:"text", text: "..."}], ...}`.
 * Pull the first text block out (or null).
 */
function extractFirstText(result) {
  const content = result?.content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (block && block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
