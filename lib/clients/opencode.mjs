/**
 * opencode.mjs — opencode adapter for the Meko MCP installer.
 *
 * MCP registration is direct JSON editing of opencode.json (Cursor's
 * pattern) — opencode.json's `mcp` key accepts a McpRemoteConfig shape
 * (type/url/enabled/headers) confirmed against the installed opencode SDK's
 * type definitions. No CLI dependency, unlike Claude Code/Codex.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  getOpencodeAgentsMdPath,
  getOpencodeConfigPath,
  readJsonFile,
  writeJsonFile,
} from "../config.mjs";
import { getInstallerVersion, MEKO_MCP_USER_AGENT } from "./common.mjs";
import { upsertAgentsMdBlock } from "./codex.mjs";

/**
 * @param {{ getConfigPath?: (scope: string, projectRoot: string) => string, getAgentsMdPath?: (scope: string, projectRoot: string) => string }} [customPaths]
 * @returns {object}
 */
export function createOpencodeAdapter(customPaths = {}) {
  const resolveConfigPath = customPaths.getConfigPath ?? getOpencodeConfigPath;
  const resolveAgentsMdPath = customPaths.getAgentsMdPath ?? getOpencodeAgentsMdPath;

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
  };
}
