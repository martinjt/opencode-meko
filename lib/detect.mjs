/**
 * detect.mjs - Detection helpers for Claude CLI and existing Meko config.
 *
 * Uses child_process.execSync so the installer can fail fast if
 * prerequisites are missing. Every function is safe to call on any
 * platform - failures are caught and returned as structured results.
 * Zero external dependencies - Node.js built-ins only.
 */

import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import { readJsonFile } from "./config.mjs";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Run a shell command and return its trimmed stdout.
 * Returns `null` if the command fails for any reason.
 *
 * @param {string} cmd
 * @returns {string | null}
 */
function run(cmd) {
  try {
    return execSync(cmd, {
      encoding: "utf8",
      // Suppress stderr so failed commands don't litter the terminal.
      stdio: ["pipe", "pipe", "pipe"],
      // Short timeout to avoid hanging on unexpected interactive prompts.
      timeout: 10_000,
    }).trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// detectClaude
// ---------------------------------------------------------------------------

/**
 * Check whether the Claude CLI is installed and reachable on the PATH.
 *
 * @returns {{ found: boolean, version: string, path: string }}
 *   `found`   - true when the `claude` binary exists and responds to --version.
 *   `version` - the version string reported by `claude --version`, or "".
 *   `path`    - the absolute path to the binary, or "".
 */
export function detectClaude() {
  const result = { found: false, version: "", path: "" };

  // Locate the binary.
  const binPath = run("which claude");
  if (!binPath) return result;

  result.path = binPath;

  // Retrieve version - `claude --version` typically outputs something like
  // "1.0.12 (Claude Code)" or just a semver string.
  const versionOutput = run("claude --version");
  if (!versionOutput) return result;

  result.version = versionOutput;
  result.found = true;

  return result;
}

// ---------------------------------------------------------------------------
// detectExistingMeko
// ---------------------------------------------------------------------------

/**
 * Canonical location of Claude Code's user-scope MCP registry. This is the
 * file `claude mcp add` writes to — we read it directly rather than shelling
 * out to `claude mcp list`, which takes 18–28s on real user machines and
 * was timing out against our 10s guard (issue #80).
 *
 * @returns {string}
 */
export function getClaudeCodeConfigPath() {
  return join(homedir(), ".claude.json");
}

/**
 * Check if a Meko MCP server is already registered in Claude Code.
 *
 * Reads `~/.claude.json` directly and inspects either `mcpServers[serverName]`
 * (user scope) or `projects[projectRoot].mcpServers[serverName]` (project
 * scope). This mirrors the approach the Claude Desktop adapter already uses
 * against its own config (installer/lib/clients/claude-desktop.mjs:detectExisting)
 * and replaces the previous `claude mcp list` shell-out, which silently
 * returned `found: false` whenever the CLI exceeded the 10s run() timeout.
 *
 * Scope handling: `claude mcp add --scope project` writes under
 * `projects[<absolute projectRoot>].mcpServers`, not the top-level
 * `mcpServers`. A project-scope re-install must detect the existing entry
 * in that nested location, otherwise the overwrite prompt is skipped and
 * `claude mcp add --scope project` rejects the duplicate with "already
 * exists". User-scope installs read the top-level `mcpServers` object
 * (which is where the CLI writes entries added with `--scope user`).
 *
 * @param {string} [serverName="meko"] - The MCP server name to look for.
 * @param {{ configPath?: string, scope?: "user"|"project", projectRoot?: string }} [options]
 *   `configPath` — test-only injection point for the config file path; defaults to `~/.claude.json`.
 *   `scope`      — "user" (default) or "project". Project scope looks under `projects[projectRoot].mcpServers`.
 *   `projectRoot` — absolute path used as the key into `projects[...]` when `scope === "project"`.
 *                   Ignored for user scope. Must be supplied by the caller for project scope.
 * @returns {{ found: boolean, status: string, url?: string }}
 *   `found`  - true if a matching MCP entry exists at the scope-appropriate location.
 *   `status` - "Configured" when found, "" otherwise. (Kept as a string for
 *              API compatibility with the prior implementation; callers use
 *              this only for logging, never parsing.)
 */
export function detectExistingMeko(serverName = "meko", options = {}) {
  const { scope = "user", projectRoot } = options;
  const configPath = options.configPath ?? getClaudeCodeConfigPath();
  const cfg = readJsonFile(configPath);

  const entry =
    scope === "project"
      ? cfg?.projects?.[projectRoot]?.mcpServers?.[serverName]
      : cfg?.mcpServers?.[serverName];

  if (!entry) {
    return { found: false, status: "" };
  }
  const url = typeof entry.url === "string" ? entry.url : undefined;
  return {
    found: true,
    status: "Configured",
    ...(url ? { url } : {}),
  };
}
