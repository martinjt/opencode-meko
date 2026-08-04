/**
 * exchange-helpers.mjs — pure functions used by meko-memory.mjs.
 *
 * Deliberately a separate module, NOT the plugin file itself. opencode's
 * plugin loader treats every top-level export of a file listed in
 * opencode.json's `plugin` array as a plugin candidate and requires each one
 * to be a function — confirmed empirically: a file exporting one async
 * plugin function plus one non-function named export (e.g. a `__TEST__`
 * object bundling helpers for unit tests) fails to load with "Plugin export
 * is not a function". Keeping these helpers in a module that opencode never
 * references directly avoids that trap while still letting tests import
 * them.
 */

import { basename } from "node:path";

// Deliberately its own copy, not capture.js's deriveAgentId: that one only
// gives a repo-scoped id to claude_code/cursor and buckets everything else
// (including codex) under the shared "meko_agent" id. opencode gets its own
// proper repo-scoped bucket here.
export function deriveAgentId(directory) {
  const rawBase = directory ? basename(directory) : "";
  if (!rawBase || rawBase === "." || rawBase === "/") return "opencode";
  const project = rawBase
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return project ? `opencode:${project}` : "opencode";
}

export function textOf(parts) {
  return parts
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

export function reasoningOf(parts) {
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
export function extractExchanges(messages, afterId) {
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
