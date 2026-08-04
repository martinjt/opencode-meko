/**
 * claude-parser.mjs — Pure-ESM, streaming Claude Code transcript parser.
 *
 * Ported from skills/hooks-handlers/lib/capture.js, but:
 *   - no CLI / side effects; only exports
 *   - streaming via readline so sessions larger than available RAM
 *     don't need to be loaded whole
 *   - filters isSidechain / isMeta / attachment-type entries up front
 *     (the hook-side version doesn't need to because it runs live)
 *
 * Kept deliberately independent of `skills/hooks-handlers/lib/capture.js`:
 * installer packages ship without that sibling directory, and mixing
 * CommonJS side-effect-heavy hook code into an ESM installer costs more
 * than the ~150 LOC of parser logic duplicated here.
 */

import fs from "node:fs";
import readline from "node:readline";

export const MAX_THINKING_LEN = Number(process.env.MEKO_MAX_THINKING_LEN ?? 2000);
export const MAX_TOOL_INPUT_LEN = Number(process.env.MEKO_MAX_TOOL_INPUT_LEN ?? 500);
export const MAX_TOOL_RESULT_LEN = Number(process.env.MEKO_MAX_TOOL_RESULT_LEN ?? 3000);

const SKIP_INPUT_PATTERN =
  /^<(system-reminder|command-|local-command|available-deferred)/;

export function truncate(str, max) {
  if (!str || str.length <= max) return str;
  return str.slice(0, max) + "... [truncated]";
}

export function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const b of content) {
    if (typeof b === "string") { parts.push(b); continue; }
    if (b && b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

export function extractThinking(content) {
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const b of content) {
    if (b && b.type === "thinking" && typeof b.thinking === "string") {
      parts.push(truncate(b.thinking, MAX_THINKING_LEN));
    }
  }
  return parts.join("\n");
}

export function extractToolCalls(content) {
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const b of content) {
    if (!b || b.type !== "tool_use") continue;
    const name = b.name || "unknown";
    let inputStr = "";
    if (b.input && typeof b.input === "object") {
      try {
        inputStr = truncate(JSON.stringify(b.input), MAX_TOOL_INPUT_LEN);
      } catch {
        inputStr = "(unserializable)";
      }
    }
    parts.push(`TOOL CALL: ${name}(${inputStr})`);
  }
  return parts.join("\n");
}

export function isToolResultMessage(msg) {
  if (msg?.toolUseResult != null) return true;
  const content = msg?.message?.content;
  if (Array.isArray(content)) {
    return content.some((b) => b && b.type === "tool_result");
  }
  return false;
}

export function extractToolResultContent(msg) {
  const parts = [];
  const content = msg?.message?.content;
  if (Array.isArray(content)) {
    for (const b of content) {
      if (!b || b.type !== "tool_result") continue;
      const inner = b.content;
      if (typeof inner === "string") {
        parts.push(truncate(inner, MAX_TOOL_RESULT_LEN));
      } else if (Array.isArray(inner)) {
        for (const ib of inner) {
          if (ib && ib.type === "text" && typeof ib.text === "string") {
            parts.push(truncate(ib.text, MAX_TOOL_RESULT_LEN));
          }
        }
      }
    }
  }
  if (!parts.length && typeof msg?.toolUseResult === "string") {
    parts.push(truncate(msg.toolUseResult, MAX_TOOL_RESULT_LEN));
  }
  if (parts.length === 0) return "";
  return "TOOL RESULT:\n" + parts.join("\n---\n");
}

/**
 * Should this JSON entry be dropped before we start pairing turns?
 * Mirrors the plan: skip sidechains, meta turns, and the non-message types.
 *
 * @param {any} obj
 * @returns {boolean}
 */
export function isSkippable(obj) {
  if (!obj || typeof obj !== "object") return true;
  if (obj.isSidechain === true) return true;
  if (obj.isMeta === true) return true;
  const t = obj.type;
  if (t === "attachment" || t === "file-history-snapshot" || t === "custom-title") {
    return true;
  }
  if (t !== "user" && t !== "assistant") return true;
  return false;
}

/**
 * Stream a JSONL session and emit paired user↔assistant exchanges.
 *
 * Uses `readline.createInterface` with a file read stream — the file
 * is never fully materialized in memory, even at 100+ MB.
 *
 * Truncated-trailing-line handling: readline drops a trailing partial
 * line silently when the input stream ends without a newline. That is
 * exactly the behaviour we want for "in-progress" session files: the
 * partial JSON gets dropped rather than failing the whole run.
 *
 * @param {string} sessionPath
 * @returns {Promise<{
 *   sessionUuid: string,
 *   firstUserText: string,
 *   cwd: string,
 *   gitBranch: string|null,
 *   startedAt: string|null,
 *   messageCount: number,
 *   exchanges: Array<{user_uuid: string, input: string, output: string, reasoning: string, timestamp: string}>,
 *   partial: boolean,
 * }>}
 */
export async function parseSessionStream(sessionPath) {
  let stat;
  try { stat = fs.statSync(sessionPath); } catch { stat = null; }
  let partial = false;
  if (stat) {
    try {
      const fd = fs.openSync(sessionPath, "r");
      const buf = Buffer.alloc(1);
      if (stat.size > 0) fs.readSync(fd, buf, 0, 1, stat.size - 1);
      fs.closeSync(fd);
      const recent = stat.mtimeMs > Date.now() - 60_000;
      const endsNL = stat.size === 0 || buf[0] === 0x0a;
      partial = recent && !endsNL;
    } catch { /* ignore */ }
  }

  const rl = readline.createInterface({
    input: fs.createReadStream(sessionPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  // Metadata we collect in a single streaming pass.
  let firstUserText = "";
  let cwd = "";
  let gitBranch = null;
  let startedAt = null;
  let messageCount = 0;

  // Turn-assembly state.
  const exchanges = [];
  let current = null;

  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    messageCount++;
    if (!cwd && typeof obj.cwd === "string") cwd = obj.cwd;
    if (!gitBranch && typeof obj.gitBranch === "string") gitBranch = obj.gitBranch;
    if (!startedAt && typeof obj.timestamp === "string") startedAt = obj.timestamp;
    if (!firstUserText && obj.type === "user" && !isSkippable(obj) && !isToolResultMessage(obj)) {
      const txt = extractText(obj.message?.content);
      if (txt && !SKIP_INPUT_PATTERN.test(txt)) firstUserText = txt.slice(0, 240);
    }

    if (isSkippable(obj)) continue;

    if (obj.type === "user" && !isToolResultMessage(obj)) {
      if (current) {
        const built = buildExchange(current);
        if (built) exchanges.push(built);
      }
      current = { userMsg: obj, assistantEntries: [], toolResultEntries: [] };
    } else if (current) {
      if (obj.type === "assistant") {
        current.assistantEntries.push(obj);
      } else if (obj.type === "user" && isToolResultMessage(obj)) {
        current.toolResultEntries.push(obj);
      }
    }
  }
  if (current) {
    const built = buildExchange(current);
    if (built) exchanges.push(built);
  }

  return {
    sessionUuid: baseName(sessionPath),
    firstUserText,
    cwd,
    gitBranch,
    startedAt,
    messageCount,
    exchanges,
    partial,
  };
}

function baseName(p) {
  const i = p.lastIndexOf("/");
  const file = i >= 0 ? p.slice(i + 1) : p;
  return file.replace(/\.jsonl$/, "");
}

function buildExchange(ex) {
  const input = extractText(ex.userMsg.message?.content);
  if (!input || SKIP_INPUT_PATTERN.test(input)) return null;
  if (ex.assistantEntries.length === 0) return null;

  const outputParts = [];
  const reasoningParts = [];

  for (const a of ex.assistantEntries) {
    const content = a.message?.content;
    if (!Array.isArray(content)) continue;
    const t = extractText(content);
    if (t) outputParts.push(t);
    const thinking = extractThinking(content);
    if (thinking) reasoningParts.push("THINKING:\n" + thinking);
    const tc = extractToolCalls(content);
    if (tc) reasoningParts.push(tc);
  }
  for (const tr of ex.toolResultEntries) {
    const trText = extractToolResultContent(tr);
    if (trText) reasoningParts.push(trText);
  }

  return {
    user_uuid: ex.userMsg.uuid || "unknown",
    input,
    output: outputParts.join("\n\n"),
    reasoning: reasoningParts.join("\n---\n"),
    timestamp:
      ex.assistantEntries[ex.assistantEntries.length - 1].timestamp ||
      ex.userMsg.timestamp ||
      "",
  };
}

/**
 * Peek just enough of a JSONL session to harvest its metadata
 * (cwd, gitBranch, startedAt, sessionId). Cheap — stops at the first
 * parseable line.
 *
 * @param {string} sessionPath
 * @returns {Promise<{cwd: string, gitBranch: string|null, startedAt: string|null, sessionId: string|null}>}
 */
export async function peekSessionMetadata(sessionPath) {
  const rl = readline.createInterface({
    input: fs.createReadStream(sessionPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  try {
    for await (const raw of rl) {
      const line = raw.trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        return {
          cwd: typeof obj.cwd === "string" ? obj.cwd : "",
          gitBranch: typeof obj.gitBranch === "string" ? obj.gitBranch : null,
          startedAt: typeof obj.timestamp === "string" ? obj.timestamp : null,
          sessionId: typeof obj.sessionId === "string" ? obj.sessionId : null,
        };
      } catch {
        continue;
      }
    }
  } finally {
    rl.close();
  }
  return { cwd: "", gitBranch: null, startedAt: null, sessionId: null };
}
