/**
 * adapters/claude-code.mjs — Enumerate + parse Claude Code sessions.
 *
 * Parser lives in ../claude-parser.mjs (vendored, streaming). We do NOT
 * import from `skills/hooks-handlers/lib/capture.js` — that file is
 * published in a different package, is CommonJS with side effects, and
 * using `import.meta.dirname` to reach it broke under `npm install`.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { agentIdForClaude, slugifyCwd } from "../id.mjs";
import { parseSessionStream, peekSessionMetadata } from "../claude-parser.mjs";

function homeDir() {
  return process.env.HOME || os.homedir();
}

/**
 * The projects root that Claude Code writes session files under.
 *
 * @param {object} [opts]
 * @param {string} [opts.home]
 * @returns {string}
 */
export function projectsRoot(opts = {}) {
  return path.join(opts.home ?? homeDir(), ".claude", "projects");
}

/**
 * User-scope CLAUDE.md location.
 *
 * @param {object} [opts]
 * @param {string} [opts.home]
 * @returns {string}
 */
export function userClaudeMdPath(opts = {}) {
  return path.join(opts.home ?? homeDir(), ".claude", "CLAUDE.md");
}

/**
 * @typedef {Object} SessionRef
 * @property {string} sessionUuid
 * @property {string} path
 * @property {string} slug
 * @property {string} cwd             Derived from the first session in the slug dir.
 * @property {string} agentId
 * @property {number} size
 * @property {number} mtimeMs
 * @property {boolean} likelyInProgress
 */

/**
 * Enumerate session files under `~/.claude/projects/`.
 *
 * For `scope === "project"`, filter by matching the session's embedded
 * `cwd` field against `projectCwd`. The slug→cwd mapping is lossy for
 * paths containing `.` or `-`, so we only use the slug as a candidate
 * shortlist; the authoritative match is on file content.
 *
 * @param {object} opts
 * @param {"user"|"project"} opts.scope
 * @param {string} [opts.projectCwd]
 * @param {string} [opts.home]
 * @returns {Promise<SessionRef[]>}
 */
export async function listSessions(opts) {
  const root = projectsRoot(opts);
  if (!fs.existsSync(root)) return [];

  const slugs = fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const wantedCwd = opts.scope === "project" ? opts.projectCwd : null;
  const wantedSlug = wantedCwd ? slugifyCwd(wantedCwd) : null;

  const out = [];
  for (const slug of slugs) {
    if (wantedSlug && slug !== wantedSlug) continue;
    const dir = path.join(root, slug);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    // Resolve the project cwd from the first readable session — authoritative.
    const slugCwd = await cwdForSlugDir(dir, slug);
    if (wantedCwd && slugCwd && slugCwd !== wantedCwd) continue;

    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
      const full = path.join(dir, e.name);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      const sessionUuid = e.name.replace(/\.jsonl$/, "");
      out.push({
        sessionUuid,
        path: full,
        slug,
        cwd: slugCwd,
        agentId: agentIdForClaude(slugCwd),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        likelyInProgress: stat.mtimeMs > Date.now() - 60_000,
      });
    }
  }
  return out;
}

/**
 * Resolve the absolute project cwd for a slug directory by peeking at
 * the first parseable line of any session file in it. Falls back to a
 * naive `-` → `/` replacement if no session file has a cwd.
 *
 * Cached per call (each session dir is read at most once).
 *
 * @param {string} dir
 * @param {string} slug
 * @returns {Promise<string>}
 */
export async function cwdForSlugDir(dir, slug) {
  let entries;
  try {
    entries = fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return fallbackCwd(slug);
  }
  for (const name of entries) {
    try {
      const meta = await peekSessionMetadata(path.join(dir, name));
      if (meta.cwd) return meta.cwd;
    } catch {
      continue;
    }
  }
  return fallbackCwd(slug);
}

function fallbackCwd(slug) {
  if (!slug || !slug.startsWith("-")) return slug;
  return slug.replace(/-/g, "/");
}

/**
 * Parse a session file via the streaming parser.
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
export function parseSession(sessionPath) {
  return parseSessionStream(sessionPath);
}
