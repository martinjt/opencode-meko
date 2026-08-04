/**
 * state.mjs — Durable cross-run state for the migrator.
 *
 * File layout documented in the feature plan. Writes are atomic
 * (tmp + rename) and debounced by the caller via `flushNow()` / periodic.
 */

import fs from "node:fs";
import path from "node:path";

export const STATE_VERSION = 1;

/**
 * @typedef {Object} State
 * @property {number} version
 * @property {string} updatedAt
 * @property {Array<object>} runs
 * @property {Record<string, AgentState>} agents
 *
 * @typedef {Object} AgentState
 * @property {string|null} memoryConversationId
 * @property {Record<string, ConversationState>} conversations
 * @property {Record<string, MemoryState>} memories
 *
 * @typedef {Object} ConversationState
 * @property {string} conversationId
 * @property {"pending"|"partial"|"done"|"failed"} status
 * @property {number} messagesSent
 * @property {number} memoryPairsSent
 * @property {string|null} lastUuid
 * @property {string|null} completedAt
 * @property {string|null} lastError
 *
 * @typedef {Object} MemoryState
 * @property {string} memoryId
 * @property {string} name
 * @property {string} addedAt
 */

/**
 * Load state from disk. Returns an empty shell if the file is missing.
 *
 * @param {string} statePath
 * @returns {State}
 */
export function load(statePath) {
  try {
    const raw = fs.readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return {
        version: parsed.version ?? STATE_VERSION,
        updatedAt: parsed.updatedAt ?? new Date().toISOString(),
        runs: Array.isArray(parsed.runs) ? parsed.runs : [],
        agents: parsed.agents && typeof parsed.agents === "object" ? parsed.agents : {},
      };
    }
  } catch {
    /* fall through to empty */
  }
  return empty();
}

/**
 * @returns {State}
 */
export function empty() {
  return {
    version: STATE_VERSION,
    updatedAt: new Date().toISOString(),
    runs: [],
    agents: {},
  };
}

/**
 * Atomic write: writes to `${statePath}.tmp` then renames.
 *
 * @param {string} statePath
 * @param {State} state
 */
export function save(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  state.updatedAt = new Date().toISOString();
  const tmp = `${statePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, statePath);
}

/**
 * Ensure an agent bucket exists and return it (mutable reference).
 *
 * @param {State} state
 * @param {string} agentId
 * @returns {AgentState}
 */
export function ensureAgent(state, agentId) {
  if (!state.agents[agentId]) {
    state.agents[agentId] = {
      memoryConversationId: null,
      conversations: {},
      memories: {},
    };
  }
  return state.agents[agentId];
}

/**
 * Has this session already been fully ingested?
 *
 * @param {State} state
 * @param {string} agentId
 * @param {string} sessionUuid
 * @returns {boolean}
 */
export function isSessionDone(state, agentId, sessionUuid) {
  return state.agents[agentId]?.conversations?.[sessionUuid]?.status === "done";
}

/**
 * Return the stored conversation record for (agentId, sessionUuid), or null.
 * Callers use this to resume a `partial` ingestion.
 *
 * @param {State} state
 * @param {string} agentId
 * @param {string} sessionUuid
 * @returns {ConversationState | null}
 */
export function getSession(state, agentId, sessionUuid) {
  return state.agents[agentId]?.conversations?.[sessionUuid] ?? null;
}

/**
 * Upsert a session record. Returns the mutated record.
 *
 * @param {State} state
 * @param {string} agentId
 * @param {string} sessionUuid
 * @param {Partial<ConversationState>} patch
 * @returns {ConversationState}
 */
export function markSession(state, agentId, sessionUuid, patch) {
  const agent = ensureAgent(state, agentId);
  const prev = agent.conversations[sessionUuid] ?? {
    conversationId: "",
    status: "pending",
    messagesSent: 0,
    memoryPairsSent: 0,
    lastUuid: null,
    completedAt: null,
    lastError: null,
  };
  const next = { ...prev, ...patch };
  agent.conversations[sessionUuid] = next;
  return next;
}

/**
 * @param {State} state
 * @param {string} agentId
 * @param {string} hash
 * @returns {boolean}
 */
export function isMemoryDone(state, agentId, hash) {
  return Boolean(state.agents[agentId]?.memories?.[hash]);
}

/**
 * @param {State} state
 * @param {string} agentId
 * @param {string} hash
 * @param {MemoryState} record
 */
export function markMemory(state, agentId, hash, record) {
  const agent = ensureAgent(state, agentId);
  agent.memories[hash] = record;
}
