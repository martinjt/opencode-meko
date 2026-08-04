/**
 * config.mjs - Safe JSON file manipulation for installer-managed config.
 *
 * Provides generic JSON utilities plus client-specific path helpers used by
 * Claude Code, Claude Desktop, and Cursor install flows.
 *
 * Zero external dependencies - Node.js built-ins only.
 */

import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** @returns {string} Absolute path to ~/.claude/settings.json */
export function getClaudeCodeSettingsPath() {
  return join(homedir(), ".claude", "settings.json");
}

/**
 * Compatibility alias used by existing Claude Code paths.
 * @returns {string}
 */
export function getSettingsPath() {
  return getClaudeCodeSettingsPath();
}

/**
 * Return the canonical user-level Claude Desktop config path for this OS.
 * @returns {string}
 */
export function getClaudeDesktopConfigPath() {
  const home = homedir();
  switch (process.platform) {
    case "darwin":
      return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    case "win32":
      return join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json");
    default:
      return join(home, ".config", "Claude", "claude_desktop_config.json");
  }
}

/**
 * Return path to Cursor's MCP config file.
 * @param {"user"|"project"} scope
 * @param {string} projectRoot
 * @returns {string}
 */
export function getCursorMcpPath(scope, projectRoot) {
  if (scope === "project") {
    return join(projectRoot, ".cursor", "mcp.json");
  }
  return join(homedir(), ".cursor", "mcp.json");
}

/**
 * Return path to Cursor hooks config file.
 * @param {"user"|"project"} scope
 * @param {string} projectRoot
 * @returns {string}
 */
export function getCursorHooksPath(scope, projectRoot) {
  if (scope === "project") {
    return join(projectRoot, ".cursor", "hooks.json");
  }
  return join(homedir(), ".cursor", "hooks.json");
}

/**
 * Return path to Cursor skills directory.
 * @param {"user"|"project"} scope
 * @param {string} projectRoot
 * @returns {string}
 */
export function getCursorSkillsDir(scope, projectRoot) {
  if (scope === "project") {
    return join(projectRoot, ".cursor", "skills");
  }
  return join(homedir(), ".cursor", "skills");
}

/**
 * Return path for Claude compatibility settings file.
 * @param {"user"|"project"} scope
 * @param {string} projectRoot
 * @returns {string}
 */
export function getClaudeCompatSettingsPath(scope, projectRoot) {
  if (scope === "project") {
    return join(projectRoot, ".claude", "settings.json");
  }
  return getClaudeCodeSettingsPath();
}

/**
 * Return path to Codex's user-level config (TOML).
 * Honors $CODEX_HOME if set, else defaults to ~/.codex/config.toml.
 * Codex has no project-level config — caller should warn and degrade
 * if a project scope was requested.
 * @returns {string}
 */
export function getCodexConfigPath() {
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  return join(codexHome, "config.toml");
}

/**
 * Return path to Codex's user-level AGENTS.md.
 * @returns {string}
 */
export function getCodexAgentsMdPath() {
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  return join(codexHome, "AGENTS.md");
}

/**
 * Return path to Codex's user-level hooks config.
 * @returns {string}
 */
export function getCodexHooksPath() {
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  return join(codexHome, "hooks.json");
}

/**
 * Return path to the Meko env file the Codex hooks source on launch.
 * Lives next to hooks.json under $CODEX_HOME (default ~/.codex/) and is
 * written at mode 0600. Used because Codex's hooks.json schema has no
 * `env` block, and inlining the API key into each hook's `command`
 * field would expose it via `ps -ef` while the hook runs.
 *
 * The hook command becomes `. ~/.codex/meko-env.sh && bash /path/to/hook.sh`,
 * so the secret never appears in process arguments.
 *
 * @returns {string}
 */
export function getCodexMekoEnvFilePath() {
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  return join(codexHome, "meko-env.sh");
}

/**
 * Return the stable directory the Codex hook scripts are copied into at
 * install time.
 *
 * Why a dedicated copy instead of referencing the shipped asset root
 * directly: when the installer runs via `npx @yugabytedb/meko-mcp`, the
 * asset root resolves to an ephemeral npm cache dir
 * (`~/.npm/_npx/<hash>/node_modules/@yugabytedb/meko-mcp/assets/...`).
 * npx garbage-collects those hashed dirs, so a hooks.json that pins the
 * npx path becomes a dangling pointer on the next npx run — Codex then
 * spawns `bash '<missing script>'`, which exits 127 ("command not found")
 * and surfaces as a failed SessionStart hook + the misleading "could not
 * reach Meko" fallback. Copying the scripts under $CODEX_HOME gives the
 * hook a home-dir-stable target that outlives the npx cache.
 *
 * The `hooks-handlers` leaf is preserved so the command string still
 * matches `isMekoHookCommand`'s prune regex — that lets a reinstall
 * auto-heal any stale npx-pinned entry left by an older installer.
 *
 * @returns {string}
 */
export function getCodexHooksInstallRoot() {
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  return join(codexHome, "meko-hooks", "hooks-handlers");
}

/**
 * Return path to the shared agent-skills directory used by Codex
 * (and other agent runtimes that follow the convention).
 * @returns {string}
 */
export function getCodexSkillsRoot() {
  return join(homedir(), ".agents", "skills");
}

// ---------------------------------------------------------------------------
// Read / Write primitives
// ---------------------------------------------------------------------------

/**
 * Read and parse a JSON file.
 *
 * - Returns `{}` when the file does not exist.
 * - Returns `{}` when the file exists but is empty (0 bytes or whitespace).
 * - Throws a descriptive error when the file contains invalid JSON.
 *
 * @param {string} filePath - Absolute path to the JSON file.
 * @returns {Record<string, unknown>} Parsed contents, or empty object.
 */
export function readJsonFile(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      return {};
    }
    throw err;
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return {};
  }

  try {
    return JSON.parse(trimmed);
  } catch (parseErr) {
    throw new Error(
      `Invalid JSON in ${filePath}: ${parseErr.message}.\n` +
        "Fix the file manually or delete it and re-run the installer.",
    );
  }
}

/**
 * Write a JavaScript value as pretty-printed JSON to a file.
 *
 * Creates parent directories if they do not exist.
 * Output uses 2-space indentation and a trailing newline.
 *
 * @param {string} filePath - Absolute path to write.
 * @param {unknown} data - Value to serialize.
 */
export function writeJsonFile(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Deep merge helper
// ---------------------------------------------------------------------------

/**
 * Recursively merge `source` into `target`, returning a new object.
 *
 * Rules:
 *  - Plain objects are merged key-by-key (additive).
 *  - Everything else (arrays, scalars, null) in `source` overwrites `target`.
 *
 * @param {Record<string, unknown>} target
 * @param {Record<string, unknown>} source
 * @returns {Record<string, unknown>} Merged result (new object, inputs unchanged).
 */
function deepMerge(target, source) {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = result[key];

    if (isPlainObject(srcVal) && isPlainObject(tgtVal)) {
      result[key] = deepMerge(tgtVal, srcVal);
    } else {
      result[key] = srcVal;
    }
  }

  return result;
}

/**
 * @param {unknown} val
 * @returns {boolean} True when val is a non-null, non-array plain object.
 */
function isPlainObject(val) {
  return val !== null && typeof val === "object" && !Array.isArray(val);
}

// ---------------------------------------------------------------------------
// High-level operations
// ---------------------------------------------------------------------------

/**
 * Deep-merge a patch into an existing JSON file.
 *
 * - Reads current contents (or `{}` if missing).
 * - Creates a `.bak` backup of the original file before writing.
 * - Performs an additive deep merge: existing keys are preserved unless
 *   explicitly overridden in `patch`.
 *
 * @param {string} filePath - Absolute path to the JSON file.
 * @param {Record<string, unknown>} patch - Object to merge in.
 * @returns {Record<string, unknown>} The merged result that was written.
 */
export function mergeSettings(filePath, patch) {
  const existing = readJsonFile(filePath);

  // Back up the original file (only if it physically exists on disk).
  try {
    copyFileSync(filePath, filePath + ".bak");
  } catch (err) {
    // File does not exist yet - nothing to back up.
    if (err.code !== "ENOENT") {
      throw err;
    }
  }

  const merged = deepMerge(existing, patch);
  writeJsonFile(filePath, merged);
  return merged;
}

/**
 * Union a list of string entries into an array at a dot-separated key path.
 *
 * Use this when the patch is a list (e.g. `permissions.allow`) that must be
 * merged additively rather than overwritten — plain `mergeSettings` replaces
 * arrays wholesale, which would clobber user-added entries.
 *
 * - Creates intermediate objects if they don't exist.
 * - Preserves existing entries; deduplicates by exact string match.
 * - Creates a `.bak` backup before writing.
 *
 * @param {string} filePath - Absolute path to the JSON file.
 * @param {string} keyPath - Dot-separated path to the array (e.g. "permissions.allow").
 * @param {string[]} entries - Entries to union into the array.
 * @returns {Record<string, unknown>} The data after the union.
 */
export function mergeAllowList(filePath, keyPath, entries) {
  const data = readJsonFile(filePath);

  try {
    copyFileSync(filePath, filePath + ".bak");
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw err;
    }
  }

  const segments = keyPath.split(".");
  const leaf = segments.pop();
  let cursor = data;
  for (const seg of segments) {
    if (!isPlainObject(cursor[seg])) {
      cursor[seg] = {};
    }
    cursor = cursor[seg];
  }

  if (!Array.isArray(cursor[leaf])) {
    cursor[leaf] = [];
  }

  const existing = new Set(cursor[leaf]);
  for (const entry of entries) {
    if (!existing.has(entry)) {
      cursor[leaf].push(entry);
      existing.add(entry);
    }
  }

  writeJsonFile(filePath, data);
  return data;
}

/**
 * Remove specific entries from an array at a dot-separated key path.
 *
 * Inverse of `mergeAllowList` — used to clean up installer-managed entries
 * on uninstall without touching user-added ones.
 *
 * @param {string} filePath
 * @param {string} keyPath
 * @param {string[]} entries
 * @returns {Record<string, unknown>}
 */
export function removeFromAllowList(filePath, keyPath, entries) {
  const data = readJsonFile(filePath);

  try {
    copyFileSync(filePath, filePath + ".bak");
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw err;
    }
  }

  const segments = keyPath.split(".");
  const leaf = segments.pop();
  let cursor = data;
  for (const seg of segments) {
    if (!isPlainObject(cursor) || !isPlainObject(cursor[seg])) {
      return data;
    }
    cursor = cursor[seg];
  }

  if (!Array.isArray(cursor[leaf])) {
    return data;
  }

  const toRemove = new Set(entries);
  cursor[leaf] = cursor[leaf].filter((entry) => !toRemove.has(entry));

  writeJsonFile(filePath, data);
  return data;
}

/**
 * Remove specific nested keys from a JSON file.
 *
 * Keys are specified as dot-separated paths (e.g. `"env.MEKO_MCP_URL"`).
 * Missing intermediate segments are silently skipped.
 * Creates a `.bak` backup before writing.
 *
 * @param {string} filePath - Absolute path to the JSON file.
 * @param {string[]} keyPaths - Dot-separated key paths to remove.
 * @returns {Record<string, unknown>} The data after removals.
 */
export function removeKeys(filePath, keyPaths) {
  const data = readJsonFile(filePath);

  // Back up original.
  try {
    copyFileSync(filePath, filePath + ".bak");
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw err;
    }
  }

  for (const keyPath of keyPaths) {
    const segments = keyPath.split(".");
    const leaf = segments.pop();
    let cursor = data;

    // Walk to the parent of the target key.
    let reachable = true;
    for (const seg of segments) {
      if (isPlainObject(cursor) && Object.prototype.hasOwnProperty.call(cursor, seg)) {
        cursor = cursor[seg];
      } else {
        reachable = false;
        break;
      }
    }

    if (reachable && isPlainObject(cursor)) {
      delete cursor[leaf];
    }
  }

  writeJsonFile(filePath, data);
  return data;
}
