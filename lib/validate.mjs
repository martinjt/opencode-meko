/**
 * validate.mjs - Post-install validation for Meko MCP Server.
 *
 * Runs four checks in sequence:
 *   1. Config check   - Is the server registered in `claude mcp list`?
 *   2. Connectivity   - Can we complete an MCP `initialize` handshake?
 *   3. Tools          - Does `tools/list` return the expected core tools?
 *   4. Canary         - Does a deterministic read-only Meko tool call return
 *                       a sane response? Proves auth → tenant → datapack
 *                       routing end-to-end without depending on mem0's
 *                       LLM fact-extractor (which historically failed the
 *                       canary non-deterministically).
 *
 * HTTP transport lives in ./mcp-transport.mjs and is shared with the
 * migrate subcommand.
 */

import { execFile } from "node:child_process";
import {
  jsonRpcRequest,
  classifyError,
  mcpInitialize,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from "./mcp-transport.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Core tools that must appear in tools/list for validation to pass. */
const CORE_TOOLS = [
  "memory_search",
  "memory_get_by_id",
  "conversation_create",
  "datapack_list",
];

/** Nil UUID used as the conversation_id placeholder for the canary call. */
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** Tool the canary invokes. */
const CANARY_TOOL = "datapack_list";

// ---------------------------------------------------------------------------
// 1. Config validation
// ---------------------------------------------------------------------------

/**
 * Verify that a named MCP server appears in `claude mcp list` output.
 *
 * @param {string} serverName - The server name to look for (e.g. "meko").
 * @returns {Promise<{ok: boolean, message: string}>}
 */
export async function validateConfig(serverName) {
  try {
    const stdout = await execAsync("claude", ["mcp", "list"]);
    // `claude mcp list` outputs one server per line, name as the first token.
    const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    const found = lines.some((line) => {
      const name = line.split(":")[0].trim();
      return name === serverName;
    });

    if (found) {
      return { ok: true, message: `Server "${serverName}" is registered.` };
    }
    return {
      ok: false,
      message:
        `Server "${serverName}" not found in \`claude mcp list\` output. ` +
        "Run the installer again or add it manually.",
    };
  } catch (err) {
    return {
      ok: false,
      message: `Failed to run \`claude mcp list\`: ${err.message}`,
    };
  }
}

// ---------------------------------------------------------------------------
// 2. Connectivity validation
// ---------------------------------------------------------------------------

/**
 * Attempt an MCP `initialize` handshake against the server URL.
 *
 * @param {string} url - Full MCP endpoint URL (e.g. http://localhost:8000/mcp).
 * @param {string|null} apiKey - Optional API key (sent as `Authorization: Bearer <key>`).
 * @returns {Promise<{ok: boolean, message: string, sessionId?: string}>}
 */
export async function validateConnectivity(url, apiKey) {
  const result = await mcpInitialize(url, apiKey);
  if (!result.ok) {
    return { ok: false, message: result.message };
  }
  return {
    ok: true,
    message: `MCP server reachable at ${url}`,
    sessionId: result.sessionId,
  };
}

// ---------------------------------------------------------------------------
// 3. Tools validation
// ---------------------------------------------------------------------------

/**
 * Send `tools/list` and verify that core Meko tools are present.
 *
 * Performs its own initialize handshake first to establish a session,
 * then sends tools/list within that session.
 *
 * @param {string} url - Full MCP endpoint URL.
 * @param {string|null} apiKey - Optional API key.
 * @returns {Promise<{ok: boolean, tools: string[], message: string}>}
 */
export async function validateTools(url, apiKey) {
  // Establish a session first.
  const connResult = await validateConnectivity(url, apiKey);
  if (!connResult.ok) {
    return {
      ok: false,
      tools: [],
      message: `Cannot list tools: ${connResult.message}`,
    };
  }

  return sendToolsList(url, apiKey, connResult.sessionId);
}

// ---------------------------------------------------------------------------
// 4. Canary validation (deterministic, read-only)
// ---------------------------------------------------------------------------

/**
 * Call a deterministic, read-only Meko tool and verify the response shape.
 *
 * The canary's job is to prove the part of the stack that connectivity +
 * tools/list don't cover: auth was accepted as a real Meko identity, the
 * tenant resolver mapped it to an account, and the datapack routing wired
 * up the user's actual workspace. We invoke `datapack_list` for this — it
 * is a single read-only call, runs a short SQL query against the system
 * schema, and returns deterministically (every authenticated user has at
 * least one datapack: their default).
 *
 * Why not memory_add? The previous canary did a write/read/delete round-trip
 * via `memory_add`/`memory_get_by_id`/`memory_delete_by_id`. mem0's LLM
 * fact-extractor decides per-call whether the input contains facts worth
 * indexing; for the canary text it returned `results: []` *some of the time*
 * even though the graph extractor did add entities. The installer's id
 * extraction then reported "no memory id" and failed validation despite the
 * server being healthy. A non-LLM read-only tool removes that whole class
 * of false negative.
 *
 * Security note: `datapack_list` returns each datapack's
 * `datapack_ysql_connection_string`, which contains a database password.
 * This function MUST NOT echo the raw response into a user-facing message.
 * Failure messages reference the tool name, the JSON-RPC error code, or a
 * server-emitted `error` discriminator — never the body.
 *
 * @param {string} url - Full MCP endpoint URL.
 * @param {string|null} apiKey - Optional API key.
 * @param {object} [options]
 * @param {string} [options.sessionId] - Existing MCP session id. If omitted, a new
 *                                       initialize handshake is performed.
 * @param {number} [options.timeoutMs] - Override the canary call's transport timeout.
 *                                       Defaults to DEFAULT_REQUEST_TIMEOUT_MS.
 * @returns {Promise<{
 *   ok: boolean,
 *   message: string,
 *   datapack_count: number|null,
 *   step?: "initialize"|"datapack_list",
 * }>}
 */
export async function validateCanary(url, apiKey, options = {}) {
  const timeoutMs = options.timeoutMs;

  let sessionId = options.sessionId ?? null;
  if (!sessionId) {
    const init = await mcpInitialize(url, apiKey);
    if (!init.ok) {
      return {
        ok: false,
        datapack_count: null,
        step: "initialize",
        message: `Canary: could not initialize MCP session (${init.message}).`,
      };
    }
    sessionId = init.sessionId;
  }

  const callRes = await mcpCallTool(
    url,
    apiKey,
    sessionId,
    CANARY_TOOL,
    {
      scope: "read",
      conversation_id: NIL_UUID,
    },
    { timeoutMs },
  );

  if (!callRes.ok) {
    // mcpCallTool already produces a sanitized message (tool name + reason
    // or JSON-RPC error code); it never includes the raw text body when
    // the server emits a structured `{error: ...}` envelope. Pass it
    // through verbatim.
    return {
      ok: false,
      datapack_count: null,
      step: CANARY_TOOL,
      message: `Canary: ${callRes.message}`,
    };
  }

  const datapacks = parseDatapackList(callRes.text);
  if (!datapacks) {
    // The tool returned a 2xx but the body wasn't a recognizable list.
    // Don't dump it — list_datapacks responses include connection-string
    // secrets when they parse correctly, and we have no way to know whether
    // the unparseable body has the same.
    return {
      ok: false,
      datapack_count: null,
      step: CANARY_TOOL,
      message:
        `Canary: ${CANARY_TOOL} returned an unexpected response shape ` +
        `(expected a JSON array of datapack objects). Check the server logs.`,
    };
  }

  if (datapacks.length === 0) {
    return {
      ok: false,
      datapack_count: 0,
      step: CANARY_TOOL,
      message:
        `Canary: ${CANARY_TOOL} returned zero datapacks. Every authenticated ` +
        `Meko user should have at least their default datapack — this likely ` +
        `means the API token authenticated but resolved to the wrong tenant. ` +
        `Verify the API key matches the tenant the URL points at.`,
    };
  }

  return {
    ok: true,
    datapack_count: datapacks.length,
    message: `Canary OK — ${CANARY_TOOL} returned ${datapacks.length} datapack(s).`,
  };
}

// ---------------------------------------------------------------------------
// 5. Combined runner
// ---------------------------------------------------------------------------

/**
 * Run all validation checks in sequence and return a summary.
 *
 * When the connectivity check succeeds, the tools check reuses the same
 * MCP session rather than performing a redundant second initialize. The
 * canary reuses that same session too.
 *
 * The canary is skipped (not failed) when tools/list didn't pass — the
 * canary depends on `datapack_list` being present, and a tools failure
 * already surfaces that.
 *
 * @param {string} url - Full MCP endpoint URL.
 * @param {string|null} apiKey - Optional API key.
 * @param {string} serverName - Server name for config check (default "meko").
 * @param {object} [options]
 * @param {(params: {serverName: string}) => Promise<{ok: boolean, message: string}>} [options.validateConfig]
 * @param {boolean} [options.skipCanary] - Skip the canary entirely.
 * @returns {Promise<{config: object, connectivity: object, tools: object, canary: object|null, allPassed: boolean}>}
 */
export async function runValidation(url, apiKey, serverName = "meko", options = {}) {
  const configValidator = options.validateConfig ?? (async ({ serverName: value }) => validateConfig(value));
  const config = await configValidator({ serverName });
  const connectivity = await validateConnectivity(url, apiKey);

  let tools;
  if (connectivity.ok) {
    // Reuse the session from the connectivity check.
    tools = await sendToolsList(url, apiKey, connectivity.sessionId);
  } else {
    tools = { ok: false, tools: [], message: `Skipped: ${connectivity.message}` };
  }

  let canary = null;
  if (!options.skipCanary) {
    if (tools.ok && connectivity.ok) {
      canary = await validateCanary(url, apiKey, {
        sessionId: connectivity.sessionId,
      });
    } else {
      canary = {
        ok: false,
        datapack_count: null,
        message: `Skipped: tools/list did not pass (${tools.message}).`,
        skipped: true,
      };
    }
  }

  const allPassed =
    config.ok &&
    connectivity.ok &&
    tools.ok &&
    (!canary || canary.ok);

  return {
    config,
    connectivity,
    tools,
    canary,
    allPassed,
  };
}

// ---------------------------------------------------------------------------
// Internal: tools/list over an existing session
// ---------------------------------------------------------------------------

/**
 * Send a tools/list request using an existing (or null) session ID.
 *
 * @param {string} url
 * @param {string|null} apiKey
 * @param {string|null} sessionId
 * @returns {Promise<{ok: boolean, tools: string[], message: string}>}
 */
async function sendToolsList(url, apiKey, sessionId) {
  const payload = {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  };

  let res;
  try {
    res = await jsonRpcRequest(url, payload, apiKey, sessionId);
  } catch (err) {
    return {
      ok: false,
      tools: [],
      message: `tools/list request failed: ${classifyError(err)}`,
    };
  }

  if (res.statusCode < 200 || res.statusCode >= 300) {
    return {
      ok: false,
      tools: [],
      message: `tools/list returned HTTP ${res.statusCode}: ${String(res.body ?? "").slice(0, 300)}`,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    return {
      ok: false,
      tools: [],
      message: `tools/list returned non-JSON: ${String(res.body ?? "").slice(0, 200)}`,
    };
  }

  if (parsed.error) {
    return {
      ok: false,
      tools: [],
      message: `tools/list error: ${parsed.error.message ?? JSON.stringify(parsed.error)}`,
    };
  }

  const toolList = parsed.result?.tools ?? [];
  const toolNames = toolList.map((t) => t.name);
  const missing = CORE_TOOLS.filter((name) => !toolNames.includes(name));

  if (missing.length > 0) {
    return {
      ok: false,
      tools: toolNames,
      message:
        `Missing core tools: ${missing.join(", ")}. ` +
        `Found ${toolNames.length} tool(s) total.`,
    };
  }

  return {
    ok: true,
    tools: toolNames,
    message: `All ${CORE_TOOLS.length} core tools present (${toolNames.length} total).`,
  };
}

// ---------------------------------------------------------------------------
// Internal: tools/call for the canary
// ---------------------------------------------------------------------------

/**
 * Send a `tools/call` request and unwrap the MCP content envelope.
 *
 * Returns `{ok, text, message}` where `text` is the first text block (what
 * Meko tools return as a JSON-encoded string) and `message` is only
 * populated on the non-ok path. On the non-ok path the message is sanitized
 * — for tool-level errors emitted as `{"error": "...", "detail": "..."}`,
 * the discriminator and detail are surfaced; the raw body is never
 * echoed because it can contain secrets (e.g. `datapack_list` returns
 * connection strings).
 *
 * @param {string} url
 * @param {string|null} apiKey
 * @param {string|null} sessionId
 * @param {string} name - Tool name, e.g. "datapack_list".
 * @param {object} args - Tool arguments.
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, text: string|null, message?: string}>}
 */
async function mcpCallTool(url, apiKey, sessionId, name, args, opts = {}) {
  const payload = {
    jsonrpc: "2.0",
    id: Date.now() + Math.floor(Math.random() * 1000),
    method: "tools/call",
    params: { name, arguments: args },
  };

  const timeoutMs = opts.timeoutMs;
  let res;
  try {
    res = await jsonRpcRequest(url, payload, apiKey, sessionId, { timeoutMs });
  } catch (err) {
    return {
      ok: false,
      text: null,
      message: `${name} request failed: ${classifyError(err, timeoutMs)}`,
    };
  }

  if (res.statusCode < 200 || res.statusCode >= 300) {
    return {
      ok: false,
      text: null,
      message: `${name} returned HTTP ${res.statusCode}: ${String(res.body ?? "").slice(0, 300)}`,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    return {
      ok: false,
      text: null,
      message: `${name} returned non-JSON at the JSON-RPC envelope.`,
    };
  }

  if (parsed.error) {
    return {
      ok: false,
      text: null,
      message: `${name} error: ${parsed.error.message ?? JSON.stringify(parsed.error)}`,
    };
  }

  const text = extractFirstText(parsed.result);

  // Meko tools sometimes encode a tool-level failure inside the text body
  // (e.g. memory_add returning `{"error": "memory_add_failed", ...}`,
  // datapack_list returning `{"error": "list_failed", "detail": ...}`).
  // Surface the discriminator and detail — never the full body, since the
  // success body of datapack_list contains connection-string secrets and we
  // can't distinguish before parsing.
  if (text) {
    try {
      const body = JSON.parse(text);
      if (body && typeof body === "object" && !Array.isArray(body) && typeof body.error === "string") {
        const detail = typeof body.detail === "string" ? ` (${body.detail})` : "";
        return {
          ok: false,
          text,
          message: `${name} server error: ${body.error}${detail}`,
        };
      }
    } catch {
      // Non-JSON bodies are fine — many tools return plain text.
    }
  }

  return { ok: true, text };
}

/**
 * Meko tool results come back as `{content: [{type:"text", text: "..."}]}`.
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

/**
 * Parse a `datapack_list` response body and return the array of datapacks,
 * or `null` if the body is not a recognizable datapack list.
 *
 * Successful `datapack_list` returns a JSON array; each element has at
 * minimum a `datapack_id` and `datapack_name`. We accept any array whose
 * elements look like datapack records — we deliberately don't enumerate or
 * log the elements since they include credentials.
 *
 * @param {string|null} text
 * @returns {Array|null}
 */
function parseDatapackList(text) {
  if (!text) return null;
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(body)) return null;
  // Empty array is a meaningful answer (caller treats it as "wrong tenant").
  if (body.length === 0) return body;
  const allLookLikeDatapacks = body.every(
    (entry) => entry && typeof entry === "object" && typeof entry.datapack_id === "string",
  );
  return allLookLikeDatapacks ? body : null;
}

// ---------------------------------------------------------------------------
// Internal: child process helper
// ---------------------------------------------------------------------------

/**
 * Promisified child_process.execFile.
 *
 * @param {string} cmd - Executable name or path.
 * @param {string[]} args - Arguments.
 * @returns {Promise<string>} stdout
 */
function execAsync(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: DEFAULT_REQUEST_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr?.trim() || err.message;
        reject(new Error(msg));
        return;
      }
      resolve(stdout);
    });
  });
}
