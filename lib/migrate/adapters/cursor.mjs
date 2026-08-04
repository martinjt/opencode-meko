/**
 * adapters/cursor.mjs — Enumerate + parse Cursor agent transcripts.
 *
 * Cursor writes sessions under:
 *   ~/.cursor/projects/<projectName>/agent-transcripts/<sessionUuid>/...jsonl
 *
 * The transcript format differs from Claude Code's: each line is a
 * `{role, message: {content: [blocks]}}` object. Blocks may be
 * `{type:"text", text:"..."}` or `{type:"tool_use", name, input}` or
 * `{type:"tool_result", content:...}`.
 *
 * Schema drift is common with Cursor; unknown block types are dropped
 * with a warning and do not fail ingestion.
 */

import fs from "node:fs";
import path from "node:path";
import { agentIdForCursor } from "../id.mjs";

function homeDir() {
  return process.env.HOME || require("node:os").homedir();
}

export function projectsRoot(opts = {}) {
  return path.join(opts.home ?? homeDir(), ".cursor", "projects");
}

/**
 * @typedef {Object} CursorSessionRef
 * @property {string} sessionUuid
 * @property {string} path            Directory containing transcript shards.
 * @property {string} projectName
 * @property {string} agentId         `cursor:<projectName>`.
 * @property {number} mtimeMs
 * @property {boolean} likelyInProgress
 */

/**
 * @param {object} opts
 * @param {"user"|"project"} opts.scope
 * @param {string} [opts.projectCwd]
 * @param {string} [opts.home]
 * @returns {CursorSessionRef[]}
 */
export function listSessions(opts) {
  const root = projectsRoot(opts);
  if (!fs.existsSync(root)) return [];

  // Cursor's project folder name is NOT path-encoded the same way as
  // Claude Code. For `--scope project`, we can only match heuristically
  // on the basename of the cwd. That's acceptable for v1.
  const wantedName = opts.scope === "project"
    ? path.basename(opts.projectCwd || "")
    : null;

  const projects = fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const out = [];
  for (const projectName of projects) {
    if (wantedName && projectName !== wantedName) continue;
    const transcriptsDir = path.join(root, projectName, "agent-transcripts");
    let sessionDirs;
    try {
      sessionDirs = fs.readdirSync(transcriptsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sd of sessionDirs) {
      if (!sd.isDirectory()) continue;
      const sessionDir = path.join(transcriptsDir, sd.name);
      let stat;
      try {
        stat = fs.statSync(sessionDir);
      } catch {
        continue;
      }
      out.push({
        sessionUuid: sd.name,
        path: sessionDir,
        projectName,
        agentId: agentIdForCursor(projectName),
        mtimeMs: stat.mtimeMs,
        likelyInProgress: stat.mtimeMs > Date.now() - 60_000,
      });
    }
  }
  return out;
}

/**
 * Parse a session directory: pair user/assistant turns.
 *
 * @param {string} sessionPath
 * @returns {{
 *   sessionUuid: string,
 *   firstUserText: string,
 *   startedAt: string|null,
 *   exchanges: Array<{user_uuid: string, input: string, output: string, reasoning: string, timestamp: string}>,
 *   partial: boolean,
 * }}
 */
export function parseSession(sessionPath) {
  const entries = collectEntries(sessionPath);

  let firstUserText = "";
  let startedAt = null;
  for (const e of entries) {
    if (!startedAt && e.timestamp) startedAt = e.timestamp;
    if (!firstUserText && e.role === "user") {
      const txt = extractTextBlocks(e.content);
      if (txt) firstUserText = txt.slice(0, 240);
    }
  }

  // Pair user→assistant turns.
  const exchanges = [];
  let pendingUser = null;
  let turnIdx = 0;
  for (const e of entries) {
    if (e.role === "user") {
      if (pendingUser) {
        // User-after-user: flush with empty output.
        exchanges.push(makePair(pendingUser, null, turnIdx++));
      }
      pendingUser = e;
    } else if (e.role === "assistant") {
      if (!pendingUser) continue; // assistant with no preceding user — skip
      exchanges.push(makePair(pendingUser, e, turnIdx++));
      pendingUser = null;
    }
  }
  if (pendingUser) {
    exchanges.push(makePair(pendingUser, null, turnIdx++));
  }

  return {
    sessionUuid: path.basename(sessionPath),
    firstUserText,
    startedAt,
    exchanges: exchanges.filter((ex) => ex.input || ex.output),
    partial: false, // Cursor directories don't give us a partial-line signal
  };
}

function collectEntries(dir) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
  const entries = [];
  for (const f of files) {
    let raw;
    try {
      raw = fs.readFileSync(path.join(dir, f), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        const role = obj.role || obj.message?.role;
        if (role !== "user" && role !== "assistant") continue;
        entries.push({
          role,
          uuid: obj.uuid || obj.id || null,
          timestamp: obj.timestamp || obj.createdAt || null,
          content: obj.message?.content ?? obj.content ?? null,
        });
      } catch {
        continue;
      }
    }
  }
  return entries;
}

function makePair(userEntry, assistantEntry, idx) {
  const input = extractTextBlocks(userEntry.content);
  const output = assistantEntry ? extractTextBlocks(assistantEntry.content) : "";
  const reasoning = assistantEntry ? extractToolCallsText(assistantEntry.content) : "";
  return {
    user_uuid: userEntry.uuid || `cursor-${idx}`,
    input,
    output,
    reasoning,
    timestamp: assistantEntry?.timestamp || userEntry.timestamp || "",
  };
}

function extractTextBlocks(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const b of content) {
    if (!b) continue;
    if (typeof b === "string") { parts.push(b); continue; }
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

function extractToolCallsText(content) {
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const b of content) {
    if (!b) continue;
    if (b.type === "tool_use") {
      const input = b.input ? JSON.stringify(b.input).slice(0, 500) : "";
      parts.push(`TOOL CALL: ${b.name || "unknown"}(${input})`);
    } else if (b.type === "tool_result" && typeof b.content === "string") {
      parts.push(`TOOL RESULT:\n${b.content.slice(0, 3000)}`);
    }
  }
  return parts.join("\n---\n");
}
