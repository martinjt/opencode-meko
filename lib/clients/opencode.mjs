/**
 * opencode.mjs — opencode adapter for the Meko MCP installer.
 *
 * MCP registration is direct JSON editing of opencode.json (Cursor's
 * pattern) — opencode.json's `mcp` key accepts a McpRemoteConfig shape
 * (type/url/enabled/headers) confirmed against the installed opencode SDK's
 * type definitions. No CLI dependency, unlike Claude Code/Codex.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  getOpencodeAgentsMdPath,
  getOpencodeConfigPath,
  getOpencodePluginConfigPath,
  getOpencodePluginInstallPath,
  mergeAllowList,
  readJsonFile,
  removeFromAllowList,
  writeJsonFile,
} from "../config.mjs";
import {
  getInstallerVersion,
  installStableTree,
  MEKO_MCP_USER_AGENT,
  removePath,
  resolveOpencodePluginSource,
} from "./common.mjs";
import { removeAgentsMdBlock, upsertAgentsMdBlock } from "./codex.mjs";

/**
 * @param {{
 *   getConfigPath?: (scope: string, projectRoot: string) => string,
 *   getAgentsMdPath?: (scope: string, projectRoot: string) => string,
 *   getPluginInstallPath?: (scope: string, projectRoot: string) => string,
 *   getPluginConfigPath?: (scope: string, projectRoot: string) => string,
 *   resolveOpencodePluginSource?: () => string,
 * }} [customPaths]
 * @returns {object}
 */
export function createOpencodeAdapter(customPaths = {}) {
  const resolveConfigPath = customPaths.getConfigPath ?? getOpencodeConfigPath;
  const resolveAgentsMdPath = customPaths.getAgentsMdPath ?? getOpencodeAgentsMdPath;
  const resolvePluginInstallPath =
    customPaths.getPluginInstallPath ?? getOpencodePluginInstallPath;
  const resolvePluginConfigPath =
    customPaths.getPluginConfigPath ?? getOpencodePluginConfigPath;
  const resolvePluginSource =
    customPaths.resolveOpencodePluginSource ?? resolveOpencodePluginSource;

  return {
    id: "opencode",
    displayName: "opencode",
    settingsPath(scope, projectRoot) {
      return resolveConfigPath(scope, projectRoot);
    },
    async detectPrerequisites() {
      // No CLI dependency — opencode.json is edited directly, same as Cursor.
    },
    /**
     * Is opencode actually installed? `~/.config/opencode` is created on
     * first run, same signal Cursor's adapter uses for `~/.cursor`.
     */
    isInstalled() {
      return existsSync(join(homedir(), ".config", "opencode"));
    },
    detectExisting(name, { scope, projectRoot } = {}) {
      const path = resolveConfigPath(scope, projectRoot);
      const cfg = readJsonFile(path);
      const entry = cfg?.mcp?.[name];
      const found = Boolean(entry);
      return {
        found,
        status: found ? "Configured" : "",
        ...(typeof entry?.url === "string" ? { url: entry.url } : {}),
      };
    },
    removeRegistration(name, { scope, projectRoot } = {}) {
      const path = resolveConfigPath(scope, projectRoot);
      const cfg = readJsonFile(path);
      if (!cfg?.mcp?.[name]) return;
      delete cfg.mcp[name];
      writeJsonFile(path, cfg);
    },
    registerServer({ name, url, apiKey, dryRun, log, scope, projectRoot }) {
      const path = resolveConfigPath(scope, projectRoot);
      if (dryRun) {
        log.dim(`  Would update ${path}:`);
        log.dim(`    mcp.${name}.type = "remote"`);
        log.dim(`    mcp.${name}.url = ${url}`);
        log.dim(`    mcp.${name}.headers["User-Agent"] = ${MEKO_MCP_USER_AGENT}`);
        if (apiKey) log.dim(`    mcp.${name}.headers.Authorization = <set>`);
        return;
      }

      const cfg = readJsonFile(path);
      if (!cfg.mcp || typeof cfg.mcp !== "object") cfg.mcp = {};
      const headers = { "User-Agent": MEKO_MCP_USER_AGENT };
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      cfg.mcp[name] = { type: "remote", url, enabled: true, headers };
      writeJsonFile(path, cfg);
    },
    async validateConfig({ serverName, scope, projectRoot, url, apiKey }) {
      const path = resolveConfigPath(scope, projectRoot);
      const cfg = readJsonFile(path);
      const entry = cfg?.mcp?.[serverName];
      if (!entry) {
        return { ok: false, message: `Server "${serverName}" not found in ${path}.` };
      }
      if (url && entry.url !== url) {
        return {
          ok: false,
          message: `Server "${serverName}" in ${path} points at ${entry.url}, expected ${url}.`,
        };
      }
      const hasUserAgent = Object.keys(entry.headers ?? {}).some(
        (key) => key.toLowerCase() === "user-agent",
      );
      if (!hasUserAgent) {
        return {
          ok: false,
          message: `Server "${serverName}" in ${path} is missing the User-Agent header.`,
        };
      }
      if (apiKey) {
        const authEntry = Object.entries(entry.headers ?? {}).find(
          ([key]) => key.toLowerCase() === "authorization",
        );
        if (!authEntry || authEntry[1] !== `Bearer ${apiKey}`) {
          return {
            ok: false,
            message: `Server "${serverName}" in ${path} does not contain the current Authorization header.`,
          };
        }
      }
      return { ok: true, message: `Server "${serverName}" is registered in ${path}.` };
    },
    installSkills({ name, dryRun, log, scope, projectRoot }) {
      const serverName = name ?? "meko";
      const agentsMdPath = resolveAgentsMdPath(scope, projectRoot);
      const currentVersion = getInstallerVersion();
      if (dryRun) {
        log.dim(`  Would upsert Meko block in ${agentsMdPath}`);
        return { marketplace: "skipped", skills: "dry-run" };
      }
      upsertAgentsMdBlock(agentsMdPath, currentVersion, { name: serverName });
      return { marketplace: "skipped", skills: "ok" };
    },
    setHookEnvironment({ url, apiKey, dryRun, verbose, log, scope, projectRoot }) {
      const installPath = resolvePluginInstallPath(scope, projectRoot);
      const pluginConfigPath = resolvePluginConfigPath(scope, projectRoot);
      const opencodeConfigPath = resolveConfigPath(scope, projectRoot);

      if (dryRun) {
        log.dim(`  Would copy Meko memory plugin to ${installPath}`);
        log.dim(`  Would write plugin config at ${pluginConfigPath} (mode 0600)`);
        log.dim(`  Would add "${installPath}" to ${opencodeConfigPath}'s plugin array`);
        return;
      }

      installStableTree(resolvePluginSource(), installPath);
      mkdirSync(dirname(pluginConfigPath), { recursive: true });
      writeFileSync(
        pluginConfigPath,
        JSON.stringify({ url, apiKey: apiKey || "" }, null, 2) + "\n",
        { encoding: "utf8", mode: 0o600 },
      );
      chmodSync(pluginConfigPath, 0o600);
      mergeAllowList(opencodeConfigPath, "plugin", [installPath]);
      if (verbose) log.dim(`  Wired Meko memory plugin at ${installPath}`);
    },
    uninstall({ name, scope, projectRoot } = {}) {
      const results = [];
      try {
        this.removeRegistration(name, { scope, projectRoot });
        results.push({ key: "mcp", ok: true, message: `opencode MCP server "${name}" removed.` });
      } catch (err) {
        results.push({ key: "mcp", ok: false, message: `Could not remove opencode MCP server: ${err.message}` });
      }

      try {
        const installPath = resolvePluginInstallPath(scope, projectRoot);
        const opencodeConfigPath = resolveConfigPath(scope, projectRoot);
        removeFromAllowList(opencodeConfigPath, "plugin", [installPath]);
        removePath(dirname(installPath));
        results.push({ key: "plugin", ok: true, message: "Meko memory plugin removed." });
      } catch (err) {
        results.push({ key: "plugin", ok: false, message: `Could not remove Meko memory plugin: ${err.message}` });
      }

      try {
        const agentsMdPath = resolveAgentsMdPath(scope, projectRoot);
        const raw = safeReadFile(agentsMdPath);
        if (raw !== null) {
          const next = removeAgentsMdBlock(raw);
          if (next !== raw) writeFileSync(agentsMdPath, next, "utf8");
        }
        results.push({ key: "agents-md", ok: true, message: "Meko block stripped from AGENTS.md." });
      } catch (err) {
        results.push({ key: "agents-md", ok: false, message: `Could not update AGENTS.md: ${err.message}` });
      }

      return results;
    },
  };
}

function safeReadFile(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}
