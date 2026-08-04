/**
 * meko-memory.mjs — opencode plugin for Meko MCP memory capture.
 *
 * Installed by lib/clients/opencode.mjs into a stable path and referenced
 * via opencode.json's `plugin` array. Unlike the Claude Code / Cursor /
 * Codex hooks (assets/hooks-handlers/*.sh), which shell out to
 * lib/capture.js and parse a Claude-Code-shaped JSONL transcript file,
 * opencode sessions have no transcript file — this plugin talks to
 * opencode's own session/message API (via the SDK client every plugin
 * receives) instead.
 *
 * The Meko transport functions below (mcpPost/mcpInitialize/mcpCall/
 * createConversation/addMessage/fetchRecentMemories) are a deliberate port
 * of the equivalent functions in assets/hooks-handlers/lib/capture.js, kept
 * separate rather than imported — see the design spec's rationale for not
 * refactoring a module shared by 3 working clients for this first pass.
 */

import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import https from "node:https";

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(PLUGIN_DIR, "meko-memory.config.json");

function loadMekoConfig() {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return {
      url: raw.url || process.env.MEKO_MCP_URL || "http://localhost:8000/mcp",
      apiKey: raw.apiKey || process.env.MEKO_API_KEY || "",
    };
  } catch {
    return {
      url: process.env.MEKO_MCP_URL || "http://localhost:8000/mcp",
      apiKey: process.env.MEKO_API_KEY || "",
    };
  }
}

// --- Meko MCP transport (ported from hooks-handlers/lib/capture.js) ---

function createMekoTransport({ url, apiKey }) {
  let mcpSessionId = null;
  let mcpRequestId = 0;

  function mcpPost(jsonBody) {
    const body = JSON.stringify(jsonBody);
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const transport = parsed.protocol === "https:" ? https : http;
      const headers = {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Content-Length": Buffer.byteLength(body),
        "User-Agent": "meko-opencode-plugin/1.0 (+https://github.com/yugabyte/meko-mcp-server)",
      };
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      if (mcpSessionId) headers["Mcp-Session-Id"] = mcpSessionId;

      const req = transport.request(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname + parsed.search,
          method: "POST",
          headers,
          timeout: 10_000,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            if (res.statusCode >= 400) {
              reject(new Error(`MCP HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
              return;
            }
            if (!data.trim()) {
              resolve({ body: null, headers: res.headers });
              return;
            }
            try {
              resolve({ body: parseMcpResponseBody(data), headers: res.headers });
            } catch {
              reject(new Error(`Invalid MCP response: ${data.slice(0, 200)}`));
            }
          });
        },
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("MCP request timed out"));
      });
      req.write(body);
      req.end();
    });
  }

  function parseMcpResponseBody(data) {
    const trimmed = data.trim();
    if (!trimmed.startsWith("event:") && !trimmed.startsWith("data:")) {
      return JSON.parse(trimmed);
    }
    const payloads = [];
    let current = [];
    for (const line of data.split(/\r?\n/)) {
      if (line === "") {
        if (current.length) payloads.push(current.join("\n"));
        current = [];
        continue;
      }
      if (line.startsWith("data:")) {
        current.push(line.startsWith("data: ") ? line.slice(6) : line.slice(5));
      }
    }
    if (current.length) payloads.push(current.join("\n"));
    const payload = payloads.find((item) => item.trim()) || "";
    if (!payload) throw new Error("SSE response had no data payload");
    const parsed = JSON.parse(payload);
    if (parsed.error) throw new Error(JSON.stringify(parsed.error));
    return parsed;
  }

  async function mcpInitialize() {
    mcpRequestId++;
    const initResult = await mcpPost({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "meko-opencode-plugin", version: "1.0.0" },
      },
      id: mcpRequestId,
    });
    const sid = initResult.headers["mcp-session-id"] || initResult.headers["Mcp-Session-Id"];
    if (sid) mcpSessionId = sid;
    await mcpPost({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  }

  async function mcpCall(toolName, args) {
    mcpRequestId++;
    const result = await mcpPost({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: toolName, arguments: args },
      id: mcpRequestId,
    });
    return result.body;
  }

  function extractToolResult(response) {
    try {
      return JSON.parse(response.result.content[0].text);
    } catch {
      return null;
    }
  }

  async function fetchRecentMemories(agentId, { limit = 10, budget = 2000 } = {}) {
    const response = await mcpCall("memory_get_all", {
      agent_id: agentId,
      conversation_id: "00000000-0000-0000-0000-000000000000",
      limit,
    });
    const result = extractToolResult(response);
    if (!result) return [];
    const entries = Array.isArray(result) ? result : result.memories || result.results || [];
    const summaries = [];
    let used = 0;
    for (const entry of entries) {
      const text = entry.memory || entry.text || entry.content || "";
      if (!text) continue;
      const line = `- ${String(text).replace(/\s+/g, " ").trim()}`;
      if (used + line.length + 1 > budget) break;
      summaries.push(line);
      used += line.length + 1;
    }
    return summaries;
  }

  async function createConversation(sessionId, agentId, metadata) {
    const response = await mcpCall("conversation_create", {
      agent_id: agentId,
      title: "opencode session (auto-captured)",
      session_id: sessionId,
      ...(metadata ? { metadata: JSON.stringify(metadata) } : {}),
    });
    const result = extractToolResult(response);
    return result && result.id ? result.id : null;
  }

  async function addMessage(convId, agentId, exchange) {
    const response = await mcpCall("conversation_add_message", {
      conversation_id: convId,
      agent_id: agentId,
      input: exchange.input,
      output: exchange.output,
      reasoning: exchange.reasoning || "",
      seed: `${convId}:${exchange.userMessageId}`,
    });
    if (response && response.result && response.result.isError) {
      throw new Error(`conversation_add_message returned isError: ${JSON.stringify(response.result)}`);
    }
    const result = extractToolResult(response);
    if (result === null) throw new Error("conversation_add_message: no parseable result body");
    if (result.error) throw new Error(`conversation_add_message failed: ${JSON.stringify(result.error)}`);
    return result;
  }

  return { mcpInitialize, mcpCall, fetchRecentMemories, createConversation, addMessage };
}

// --- agent_id derivation ---
// Deliberately its own copy, not capture.js's deriveAgentId: that one only
// gives a repo-scoped id to claude_code/cursor and buckets everything else
// (including codex) under the shared "meko_agent" id. opencode gets its own
// proper repo-scoped bucket here.

function deriveAgentId(directory) {
  const rawBase = directory ? basename(directory) : "";
  if (!rawBase || rawBase === "." || rawBase === "/") return "opencode";
  const project = rawBase
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return project ? `opencode:${project}` : "opencode";
}

// --- exchange extraction from opencode's session message list ---

function textOf(parts) {
  return parts
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

function reasoningOf(parts) {
  return parts
    .filter((p) => p && p.type === "reasoning" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

/**
 * Pair up user/assistant messages into exchanges. opencode's message list is
 * chronological; an AssistantMessage's `parentID` names the UserMessage it
 * replies to. Only completed assistant turns (`finish` set) after `afterId`
 * are included — `afterId` is the last assistant messageID this plugin
 * already captured for the session, so a session.idle firing again on the
 * same settled state doesn't re-capture the same exchange.
 *
 * @param {Array<{info: object, parts: Array<object>}>} messages
 * @param {string|null} afterId
 * @returns {Array<{userMessageId: string, assistantMessageId: string, input: string, output: string, reasoning: string}>}
 */
function extractExchanges(messages, afterId) {
  const byId = new Map(messages.map((m) => [m.info.id, m]));
  const exchanges = [];
  let seenAfter = !afterId;
  for (const entry of messages) {
    const info = entry.info;
    if (info.id === afterId) {
      seenAfter = true;
      continue;
    }
    if (!seenAfter) continue;
    if (info.role !== "assistant" || !info.finish) continue;
    const parent = byId.get(info.parentID);
    if (!parent || parent.info.role !== "user") continue;
    exchanges.push({
      userMessageId: parent.info.id,
      assistantMessageId: info.id,
      input: textOf(parent.parts),
      output: textOf(entry.parts),
      reasoning: reasoningOf(entry.parts),
    });
  }
  return exchanges;
}

// --- plugin entry point ---

export const MekoMemoryPlugin = async ({ client, directory }) => {
  const { url, apiKey } = loadMekoConfig();
  const meko = createMekoTransport({ url, apiKey });
  const agentId = deriveAgentId(directory);

  // sessionID -> { ready: Promise<{convId, memories}>, lastCapturedMessageId, memoriesInjected }
  const sessions = new Map();

  function primeSession(sessionId) {
    if (sessions.has(sessionId)) return sessions.get(sessionId);
    const state = {
      lastCapturedMessageId: null,
      memoriesInjected: false,
      ready: (async () => {
        try {
          await meko.mcpInitialize();
          const [convId, memories] = await Promise.all([
            meko.createConversation(sessionId, agentId, { source: "opencode-plugin" }),
            meko.fetchRecentMemories(agentId),
          ]);
          return { convId, memories };
        } catch (err) {
          console.warn(`[meko] session priming failed: ${err.message}`);
          return { convId: null, memories: [] };
        }
      })(),
    };
    sessions.set(sessionId, state);
    return state;
  }

  async function captureNewMessages(sessionId) {
    const state = sessions.get(sessionId);
    if (!state) return;
    const { convId } = await state.ready;
    if (!convId) return;
    let list;
    try {
      const response = await client.session.messages({ path: { id: sessionId } });
      list = response?.data ?? response;
    } catch (err) {
      console.warn(`[meko] failed to list session messages: ${err.message}`);
      return;
    }
    if (!Array.isArray(list)) return;
    const exchanges = extractExchanges(list, state.lastCapturedMessageId);
    for (const exchange of exchanges) {
      if (!exchange.input && !exchange.output) continue;
      try {
        await meko.addMessage(convId, agentId, exchange);
      } catch (err) {
        console.warn(`[meko] failed to capture exchange: ${err.message}`);
      }
    }
    if (exchanges.length) {
      state.lastCapturedMessageId = exchanges[exchanges.length - 1].assistantMessageId;
    }
  }

  return {
    event: async ({ event }) => {
      if (event.type === "session.created") {
        primeSession(event.properties.info.id);
      }
      if (event.type === "session.idle") {
        await captureNewMessages(event.properties.sessionID);
      }
    },
    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return;
      const state = sessions.get(input.sessionID) ?? primeSession(input.sessionID);
      if (state.memoriesInjected) return;
      const { memories } = await state.ready;
      state.memoriesInjected = true;
      if (memories.length) {
        output.system.push(
          `Relevant memories from Meko (agent: ${agentId}):\n${memories.join("\n")}`,
        );
      }
    },
    "experimental.session.compacting": async (input) => {
      await captureNewMessages(input.sessionID);
    },
  };
};

export default MekoMemoryPlugin;

export const __TEST__ = { deriveAgentId, extractExchanges, textOf, reasoningOf };
