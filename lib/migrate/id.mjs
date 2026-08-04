/**
 * id.mjs — Agent-id derivation and seed computation for the migrator.
 */

import { createHash } from "node:crypto";
import path from "node:path";

/**
 * Slugify an absolute path the way Claude Code stores project sessions:
 * `/Users/foo/bar` → `-Users-foo-bar`.
 *
 * Matches the on-disk folder names under `~/.claude/projects/`.
 *
 * @param {string} cwd - Absolute path.
 * @returns {string}
 */
export function slugifyCwd(cwd) {
  if (!cwd) return "";
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * Reverse-derive an absolute path from a Claude-style slug. Used when
 * scanning `~/.claude/projects/` and matching a session's `cwd` field
 * against a slugged directory name.
 *
 * Note: the slugify is lossy (multiple different paths can collide);
 * prefer matching on the session's embedded `cwd` field when available.
 *
 * @param {string} slug
 * @returns {string}
 */
export function unslugifyCwd(slug) {
  return slug.replace(/-/g, "/");
}

/**
 * Server-side fallback for empty/missing agent_id. Anything written without
 * an explicit value lands here. Used as the cross-project common bucket for
 * genuinely cross-project facts (user identity, global preferences) that any
 * agent should see without knowing the writer's project.
 */
export const COMMON_BUCKET_AGENT_ID = "meko_agent";

const AGENT_ID_MAX_LEN = 64;
const KNOWN_LOOSE_CLIENTS = new Set(["claude-desktop", "claude_desktop"]);
const KNOWN_CODING_CLIENTS = new Set(["claude_code", "cursor"]);

/**
 * Sanitize a project segment: lowercase, collapse non-`[a-z0-9-]` to `-`,
 * strip leading/trailing `-`, cap at 64 chars. Returns "" if the input
 * yields nothing usable (caller falls back to the bare client name).
 *
 * @param {string} segment
 * @returns {string}
 */
function sanitizeProjectSegment(segment) {
  if (!segment) return "";
  const lower = String(segment).toLowerCase();
  const collapsed = lower.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return collapsed.slice(0, AGENT_ID_MAX_LEN);
}

/**
 * Derive an `agent_id` for a Meko write.
 *
 * Contract:
 *   - `envOverride` (typically `MEKO_AGENT_ID`) wins if non-empty.
 *   - Loose clients (Claude Desktop) → bare `claude_desktop`; no schema.
 *   - Coding clients (Claude Code, Cursor) → `<client>:<repo-basename>`.
 *     Outside a repo (basename is empty/`.`/`/`) → bare client name to
 *     keep coding-agent traffic out of the common bucket.
 *   - Anything else → `meko_agent` (the common cross-project bucket).
 *
 * @param {object} opts
 * @param {string} [opts.client]       e.g. "claude_code", "cursor", "claude-desktop"
 * @param {string} [opts.cwd]          Absolute working directory, for coding clients
 * @param {string} [opts.envOverride]  Raw value of `MEKO_AGENT_ID`, if set
 * @returns {string}
 */
export function deriveAgentId(opts = {}) {
  const override = (opts.envOverride ?? "").trim();
  if (override) return override;

  const client = (opts.client ?? "").trim();
  if (KNOWN_LOOSE_CLIENTS.has(client)) return "claude_desktop";
  if (!KNOWN_CODING_CLIENTS.has(client)) return COMMON_BUCKET_AGENT_ID;

  const rawBase = opts.cwd ? path.basename(opts.cwd) : "";
  if (!rawBase || rawBase === "." || rawBase === "/") return client;
  const project = sanitizeProjectSegment(rawBase);
  if (!project) return client;
  return `${client}:${project}`;
}

/**
 * Back-compat alias. New code should call `deriveAgentId(...)`.
 */
export const AGENT_ID = COMMON_BUCKET_AGENT_ID;

/**
 * @param {string} [cwd] Absolute project cwd. Required for project-scope
 *   writes; omit for user-scope writes (returns the common bucket).
 * @returns {string}
 */
export function agentIdForClaude(cwd) {
  if (!cwd) return COMMON_BUCKET_AGENT_ID;
  return deriveAgentId({
    client: "claude_code",
    cwd,
    envOverride: process.env.MEKO_AGENT_ID,
  });
}

/**
 * User-scope agent id for content like `~/.claude/CLAUDE.md` that is genuinely
 * cross-project. Goes into the `meko_agent` common bucket so any agent can
 * read it regardless of the writer's project.
 */
export const CLAUDE_CODE_USER_AGENT_ID = COMMON_BUCKET_AGENT_ID;

/**
 * @param {string} [cwd] Absolute project cwd (or basename — Cursor's projects
 *   live under a flat `~/.cursor/projects/<name>/`). Omit for user-scope.
 * @returns {string}
 */
export function agentIdForCursor(cwd) {
  if (!cwd) return COMMON_BUCKET_AGENT_ID;
  return deriveAgentId({
    client: "cursor",
    cwd,
    envOverride: process.env.MEKO_AGENT_ID,
  });
}

/**
 * Deterministic seed for `conversation_add_message` dedup.
 * sha256(agentId + ":" + sessionUuid + ":" + messageUuid), truncated.
 *
 * @param {string} agentId
 * @param {string} sessionUuid
 * @param {string} messageUuid
 * @returns {string} 32-char hex
 */
export function seedFor(agentId, sessionUuid, messageUuid) {
  return createHash("sha256")
    .update(`${agentId}:${sessionUuid}:${messageUuid}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Dedup hash for a memory-MD entry.
 *
 * @param {string} text
 * @param {string} [name]
 * @returns {string} 64-char hex
 */
export function memoryHash(text, name = "") {
  return createHash("sha256").update(`${name}\0${text}`).digest("hex");
}

/**
 * Derive a stable, filesystem-safe key for the destination datapack so the
 * migrator can scope its resume state per datapack.
 *
 * Strategy:
 *   - For the canonical cloud URL shape `https://<uuid>.mcp.mekodev.com/mcp`,
 *     the leading host label is a UUID — use it verbatim. This keeps the
 *     on-disk file name recognizable at a glance (it matches the datapack
 *     UUID you'd see in the cloud UI).
 *   - For anything else (localhost stacks, custom deployments), fall back
 *     to `sha256(normalizedUrl).slice(0, 16)` — still stable, still short,
 *     but unambiguously derived from the URL. We strip trailing slashes
 *     before hashing so `http://localhost:8000/mcp` and
 *     `http://localhost:8000/mcp/` resolve to the same key; otherwise a
 *     user copy-pasting the endpoint with or without a trailing slash
 *     would land on different state files and break resume.
 *
 * A bare `null`/empty string yields `"unknown"` so callers don't need a
 * null-check just to pick a path. Callers that truly want to error on a
 * missing URL should do so upstream.
 *
 * @param {string|null|undefined} url
 * @returns {string}
 */
export function datapackKeyFromUrl(url) {
  if (!url) return "unknown";
  const trimmed = String(url).trim();
  if (!trimmed) return "unknown";
  // UUID host label, e.g. https://352ded8e-...mcp.mekodev.com/mcp
  const m = trimmed.match(
    /^https?:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\./i,
  );
  if (m) return m[1].toLowerCase();
  // Normalize trailing slashes so `.../mcp` and `.../mcp/` (and `.../mcp//`)
  // all hash to the same key. We keep everything else as-is — paths are
  // case-sensitive on most targets, so we deliberately don't touch case.
  const normalized = trimmed.replace(/\/+$/, "");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}
