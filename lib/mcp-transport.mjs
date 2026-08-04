/**
 * mcp-transport.mjs — Shared Streamable-HTTP JSON-RPC client for Meko MCP.
 *
 * Used by validate.mjs (post-install validation) and migrate/mcp-client.mjs
 * (background migration). Tracks the `Mcp-Session-Id` response header across
 * requests within a session. Zero external dependencies.
 */

import http from "node:http";
import https from "node:https";

/** Default per-request timeout in milliseconds. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Send a JSON-RPC payload over HTTP(S).
 *
 * @param {string} url - Target URL.
 * @param {object} payload - JSON-RPC body.
 * @param {string|null} apiKey - Optional API key, sent as `Authorization: Bearer <key>`.
 * @param {string|null} sessionId - Optional `Mcp-Session-Id` to include.
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] - Override per-request timeout.
 * @returns {Promise<{statusCode: number, headers: object, body: string}>}
 */
export function jsonRpcRequest(url, payload, apiKey, sessionId, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === "https:" ? https : http;

    // MCP Streamable HTTP requires the client to advertise both content
    // types: a non-streaming JSON response uses application/json, a
    // streaming response (which is what FastMCP returns for `initialize`
    // and any other call when stateless_http isn't `json_response=True`)
    // uses text/event-stream. Sending only `application/json` produces a
    // 406 Not Acceptable from spec-compliant servers (see meko-mcp-server
    // PR #97 / MEKO-137 which turned this on for prod).
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      // Cloud Meko sits behind a WAF that 403s requests with no User-Agent
      // (Node's http/https send none by default). This transport powers install
      // validation and migration against cloud URLs, so it hits the same WAF as
      // the capture hooks — send an explicit UA so those calls aren't rejected.
      "User-Agent": "meko-installer/1.0 (+https://github.com/yugabyte/meko-mcp-server)",
    };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
    if (sessionId) {
      headers["Mcp-Session-Id"] = sessionId;
    }

    const body = JSON.stringify(payload);
    headers["Content-Length"] = Buffer.byteLength(body);

    const req = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          // If the server answered with text/event-stream (the MCP spec's
          // streaming response shape), extract the JSON-RPC payload from
          // the first SSE `data:` field. Callers downstream want a plain
          // JSON-RPC body — they don't care which framing the wire used.
          const contentType = String(res.headers["content-type"] ?? "").toLowerCase();
          const body = contentType.includes("text/event-stream")
            ? extractSseData(raw)
            : raw;
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body,
          });
        });
      },
    );

    req.on("timeout", () => {
      req.destroy();
      reject(new Error("TIMEOUT"));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/**
 * Extract the JSON-RPC payload from an SSE-framed response body.
 *
 * MCP servers running Streamable HTTP wrap each JSON-RPC response in an
 * SSE event of the form:
 *
 *   event: message
 *   data: {"jsonrpc":"2.0","id":1,"result":{...}}
 *
 * For a single non-streaming JSON-RPC response (initialize, tools/list,
 * tools/call) there's exactly one event in the body. SSE allows the
 * payload to span multiple `data:` lines; per the spec they are joined
 * with `\n`. We concatenate every `data:` line we see in the first event
 * and return that. Returns the raw body unchanged if no `data:` line is
 * found (defensive fallback so a misbehaving server still produces a
 * useful "non-JSON response" error downstream rather than an empty
 * string).
 *
 * @param {string} raw - Raw response body (already utf8-decoded).
 * @returns {string}
 */
function extractSseData(raw) {
  const dataLines = [];
  // Split on all three SSE-permitted line terminators per the WHATWG SSE
  // spec: LF, CRLF, and bare CR. Most servers (including FastMCP) emit
  // LF or CRLF, but the spec is explicit about CR-only being valid and
  // we shouldn't break on a producer that uses it.
  for (const rawLine of raw.split(/\r\n|\r|\n/)) {
    if (rawLine === "") {
      // Blank line terminates the event. We only need the first event for
      // a JSON-RPC response.
      if (dataLines.length > 0) break;
      continue;
    }
    // `data:` field — capture the value, stripping the optional single
    // leading space the spec allows after the colon. Anything else
    // (`event:`, `id:`, `retry:`, comments starting with `:`) we ignore.
    const match = /^data: ?(.*)$/.exec(rawLine);
    if (match) dataLines.push(match[1]);
  }
  return dataLines.length > 0 ? dataLines.join("\n") : raw;
}

/**
 * Produce a human-friendly message from a network error.
 *
 * @param {Error} err
 * @param {number} [timeoutMs] - Included in timeout message.
 * @returns {string}
 */
export function classifyError(err, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  if (err.message === "TIMEOUT") {
    return (
      "Request timed out after " +
      timeoutMs / 1000 +
      "s. Is the server running and reachable?"
    );
  }
  if (err.code === "ECONNREFUSED") {
    return (
      "Connection refused. Is the MCP server running? " +
      "For local Meko, ensure `docker compose up -d` has started the stack."
    );
  }
  if (err.code === "ENOTFOUND") {
    return "DNS lookup failed for host. Check the URL is correct.";
  }
  if (err.code === "ECONNRESET") {
    return "Connection was reset by the server.";
  }
  return err.message;
}

/**
 * Perform the MCP `initialize` + `notifications/initialized` handshake.
 * Returns the session id assigned by the server (or null if none).
 *
 * @param {string} url
 * @param {string|null} apiKey
 * @param {object} [opts]
 * @param {string} [opts.clientName]
 * @param {string} [opts.clientVersion]
 * @param {string} [opts.protocolVersion]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ok: boolean, sessionId: string|null, statusCode?: number, message?: string, raw?: object}>}
 */
export async function mcpInitialize(url, apiKey, opts = {}) {
  const initPayload = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: opts.protocolVersion ?? "2025-03-26",
      capabilities: {},
      clientInfo: {
        name: opts.clientName ?? "meko-installer",
        version: opts.clientVersion ?? "1.0.0",
      },
    },
  };

  let res;
  try {
    res = await jsonRpcRequest(url, initPayload, apiKey, null, opts);
  } catch (err) {
    return {
      ok: false,
      sessionId: null,
      message: classifyError(err, opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
    };
  }

  if (res.statusCode === 401 || res.statusCode === 403) {
    return {
      ok: false,
      sessionId: null,
      statusCode: res.statusCode,
      message:
        `Server returned ${res.statusCode}. ` +
        "Verify your API key is correct and has not expired.",
    };
  }

  if (res.statusCode < 200 || res.statusCode >= 300) {
    return {
      ok: false,
      sessionId: null,
      statusCode: res.statusCode,
      message: `Server returned HTTP ${res.statusCode}: ${res.body}`,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    return {
      ok: false,
      sessionId: null,
      statusCode: res.statusCode,
      message: `Server returned non-JSON response: ${res.body.slice(0, 200)}`,
    };
  }

  if (parsed.error) {
    return {
      ok: false,
      sessionId: null,
      statusCode: res.statusCode,
      message: `Server error: ${parsed.error.message ?? JSON.stringify(parsed.error)}`,
    };
  }

  const sessionId = res.headers["mcp-session-id"] ?? null;

  // Fire-and-forget initialized notification.
  try {
    await jsonRpcRequest(
      url,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      apiKey,
      sessionId,
      opts,
    );
  } catch {
    // Non-fatal: some transports accept this silently.
  }

  return { ok: true, sessionId, statusCode: res.statusCode, raw: parsed };
}
