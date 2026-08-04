/**
 * adapters/memory-md.mjs — Enumerate and parse CLAUDE.md + per-file memory/*.md.
 *
 * Two shapes:
 *   1. CLAUDE.md (user- or project-scope) — split on `^# ` level-1 headings;
 *      each section becomes one memory (metadata includes `heading`).
 *   2. ~/.claude/projects/<slug>/memory/*.md — each file is one memory; the
 *      body (minus YAML frontmatter) is the text, frontmatter becomes metadata.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  CLAUDE_CODE_USER_AGENT_ID,
  agentIdForClaude,
  memoryHash,
  slugifyCwd,
} from "../id.mjs";
import { cwdForSlugDir } from "./claude-code.mjs";

function homeDir() {
  return process.env.HOME || os.homedir();
}

/**
 * @typedef {Object} MemoryItem
 * @property {string} agentId
 * @property {string} text
 * @property {string} hash
 * @property {{source: string, scope: "user"|"project", sourcePath: string, heading?: string, name?: string, description?: string, type?: string}} metadata
 * @property {string} name      Display/dedup name.
 */

/**
 * Enumerate memory items per scope.
 *
 * Derives project cwd by peeking at an actual session file in each slug
 * directory (authoritative) rather than reverse-slugging, which is lossy
 * for paths containing `-` or `.`.
 *
 * @param {object} opts
 * @param {"user"|"project"} opts.scope
 * @param {string} [opts.projectCwd]
 * @param {string} [opts.home]
 * @returns {Promise<MemoryItem[]>}
 */
export async function enumerateMemoryItems(opts) {
  const home = opts.home ?? homeDir();
  const items = [];

  if (opts.scope === "user") {
    const userMd = path.join(home, ".claude", "CLAUDE.md");
    items.push(...readClaudeMd(userMd, CLAUDE_CODE_USER_AGENT_ID, "user"));

    const projectsRoot = path.join(home, ".claude", "projects");
    if (fs.existsSync(projectsRoot)) {
      for (const slug of fs.readdirSync(projectsRoot)) {
        const dir = path.join(projectsRoot, slug);
        let stat;
        try { stat = fs.statSync(dir); } catch { continue; }
        if (!stat.isDirectory()) continue;
        const cwd = await cwdForSlugDir(dir, slug);
        if (!cwd) continue;
        const agentId = agentIdForClaude(cwd);
        const projMd = path.join(cwd, ".claude", "CLAUDE.md");
        items.push(...readClaudeMd(projMd, agentId, "project", cwd));
        const memDir = path.join(dir, "memory");
        items.push(...readMemoryDir(memDir, agentId, "project", cwd));
      }
    }
  } else {
    const cwd = opts.projectCwd;
    if (!cwd) return [];
    const agentId = agentIdForClaude(cwd);
    const projMd = path.join(cwd, ".claude", "CLAUDE.md");
    items.push(...readClaudeMd(projMd, agentId, "project", cwd));
    const slug = slugifyCwd(cwd);
    const memDir = path.join(home, ".claude", "projects", slug, "memory");
    items.push(...readMemoryDir(memDir, agentId, "project", cwd));
  }

  return items;
}

/**
 * Parse a CLAUDE.md file into one item per top-level `# ` heading. If the
 * file has no top-level headings, the whole body is one item.
 *
 * @param {string} filePath
 * @param {string} agentId
 * @param {"user"|"project"} scope
 * @param {string|null} [cwd] - Absolute project path. Attached to metadata
 *   so downstream consumers can correlate even after the agent_id is
 *   sanitized down to a basename. Null for user-scope items (which use the
 *   `meko_agent` common bucket).
 * @returns {MemoryItem[]}
 */
export function readClaudeMd(filePath, agentId, scope, cwd = null) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  if (!raw.trim()) return [];

  const sections = splitTopLevelSections(raw);
  return sections.map((section) => {
    const heading = section.heading;
    const text = section.body.trim();
    const name = heading || path.basename(filePath);
    return {
      agentId,
      text,
      hash: memoryHash(text, name),
      name,
      metadata: {
        source: path.basename(filePath),
        scope,
        sourcePath: filePath,
        ...(cwd ? { cwd } : {}),
        ...(heading ? { heading } : {}),
      },
    };
  });
}

/**
 * Split on `^# ` (level-1) headings. Returns [{heading, body}...].
 * Content before the first heading becomes a section with empty heading
 * (dropped only if the body is also empty).
 *
 * @param {string} md
 * @returns {{heading: string, body: string}[]}
 */
export function splitTopLevelSections(md) {
  const lines = md.split("\n");
  const sections = [];
  let currentHeading = "";
  let currentLines = [];
  for (const line of lines) {
    const m = /^#\s+(.*)$/.exec(line);
    if (m) {
      if (currentHeading || currentLines.some((l) => l.trim())) {
        sections.push({ heading: currentHeading, body: currentLines.join("\n") });
      }
      currentHeading = m[1].trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  if (currentHeading || currentLines.some((l) => l.trim())) {
    sections.push({ heading: currentHeading, body: currentLines.join("\n") });
  }
  // If the file has zero headings, treat the whole thing as one anonymous section.
  if (sections.length === 0) return [];
  return sections.filter((s) => s.body.trim().length > 0);
}

/**
 * Read `~/.claude/projects/<slug>/memory/*.md`. One item per file.
 *
 * @param {string} memDir
 * @param {string} agentId
 * @param {"user"|"project"} scope
 * @param {string|null} [cwd] - Absolute project path; attached to metadata.
 * @returns {MemoryItem[]}
 */
export function readMemoryDir(memDir, agentId, scope, cwd = null) {
  let entries;
  try {
    entries = fs.readdirSync(memDir);
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    if (entry === "MEMORY.md") continue; // index-only
    const full = path.join(memDir, entry);
    let raw;
    try {
      raw = fs.readFileSync(full, "utf8");
    } catch {
      continue;
    }
    const { frontmatter, body } = parseFrontmatter(raw);
    const text = body.trim();
    if (!text) continue;
    const name = frontmatter.name || entry.replace(/\.md$/, "");
    out.push({
      agentId,
      text,
      hash: memoryHash(text, name),
      name,
      metadata: {
        source: `memory/${entry}`,
        scope,
        sourcePath: full,
        ...(cwd ? { cwd } : {}),
        ...(frontmatter.name ? { name: frontmatter.name } : {}),
        ...(frontmatter.description ? { description: frontmatter.description } : {}),
        ...(frontmatter.type ? { type: frontmatter.type } : {}),
      },
    });
  }
  return out;
}

/**
 * Minimal YAML frontmatter parser. Supports `key: value` on a single line
 * (bare or quoted). Returns `{frontmatter: {...}, body: string}`.
 *
 * @param {string} raw
 * @returns {{frontmatter: object, body: string}}
 */
export function parseFrontmatter(raw) {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(raw);
  if (!m) return { frontmatter: {}, body: raw };
  const fmText = m[1];
  const body = raw.slice(m[0].length);
  const frontmatter = {};
  for (const line of fmText.split("\n")) {
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let val = kv[2].trim();
    // strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    frontmatter[kv[1]] = val;
  }
  return { frontmatter, body };
}
