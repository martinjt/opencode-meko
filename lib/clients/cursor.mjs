import {
  existsSync,
  lstatSync,
  readlinkSync,
  mkdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  getClaudeCompatSettingsPath,
  getCursorHooksPath,
  getCursorMcpPath,
  getCursorSkillsDir,
  readJsonFile,
  writeJsonFile,
} from "../config.mjs";
import {
  MEKO_MCP_USER_AGENT,
  getInstallerVersion,
  installStableTree,
  isDanglingSymlink,
  isPackagedInstall,
  markerIsStale,
  readInstallerMarker,
  resolveHooksRoot,
  resolveSkillSource,
  removePath,
  symlinkOrCopy,
  writeInstallerMarker,
} from "./common.mjs";

const SKILLS = [{ name: "meko-mcp-tools" }];

const HOOKS = [
  { event: "sessionStart", script: "cursor-session-start.sh", timeout: 15000 },
  { event: "preCompact", script: "pre-compact.sh" },
  { event: "sessionEnd", script: "session-end.sh", timeout: 30000 },
];

/**
 * @returns {object}
 */
export function createCursorAdapter(customPaths = {}) {
  const resolveHooksRootPath = customPaths.resolveHooksRoot ?? resolveHooksRoot;
  const resolveSkillSourcePath = customPaths.resolveSkillSource ?? resolveSkillSource;
  const packagedInstallDetector = customPaths.isPackagedInstall ?? isPackagedInstall;
  const paths = {
    getMcpPath: customPaths.getMcpPath ?? getCursorMcpPath,
    getHooksPath: customPaths.getHooksPath ?? getCursorHooksPath,
    getSkillsDir: customPaths.getSkillsDir ?? getCursorSkillsDir,
    getClaudeCompatSettingsPath:
      customPaths.getClaudeCompatSettingsPath ?? getClaudeCompatSettingsPath,
  };

  return {
    id: "cursor",
    displayName: "Cursor",
    settingsPath() {
      return "";
    },
    async detectPrerequisites() {
      // No CLI dependency for Cursor config-mode installs.
    },
    /**
     * Is Cursor actually installed? Cursor creates `~/.cursor/` on first
     * launch for MCP / hooks / skills config, so its existence is a strong
     * signal the app has been run at least once on this machine. A user who
     * installed Cursor but never opened it produces a false negative —
     * acceptable; they'd pass --client explicitly.
     */
    isInstalled() {
      return existsSync(join(homedir(), ".cursor"));
    },
    detectExisting(name, { scope, projectRoot }) {
      const path = paths.getMcpPath(scope, projectRoot);
      const cfg = readJsonFile(path);
      const entry = cfg?.mcpServers?.[name];
      const found = Boolean(entry);
      return {
        found,
        status: found ? "Configured" : "",
        ...(typeof entry?.url === "string" ? { url: entry.url } : {}),
      };
    },
    removeRegistration(name, { scope, projectRoot }) {
      const mcpPath = paths.getMcpPath(scope, projectRoot);
      const cfg = readJsonFile(mcpPath);
      if (!cfg?.mcpServers?.[name]) return;
      delete cfg.mcpServers[name];
      writeJsonFile(mcpPath, cfg);
    },
    registerServer({ name, url, apiKey, dryRun, log, scope, projectRoot }) {
      const mcpPath = paths.getMcpPath(scope, projectRoot);
      if (dryRun) {
        log.dim(`  Would update ${mcpPath}:`);
        log.dim(`    mcpServers.${name}.url = ${url}`);
        log.dim(`    mcpServers.${name}.headers.User-Agent = ${MEKO_MCP_USER_AGENT}`);
        if (apiKey) {
          log.dim("    mcpServers.<name>.headers.Authorization = <set>");
        }
        return;
      }

      const cfg = readJsonFile(mcpPath);
      if (!cfg.mcpServers || typeof cfg.mcpServers !== "object") {
        cfg.mcpServers = {};
      }
      const server = { url, headers: { "User-Agent": MEKO_MCP_USER_AGENT } };
      if (apiKey) {
        server.headers.Authorization = `Bearer ${apiKey}`;
      }
      cfg.mcpServers[name] = server;
      writeJsonFile(mcpPath, cfg);
    },
    setHookEnvironment({ url, apiKey, dryRun, log, scope, projectRoot, cursorHookMode }) {
      const mode = cursorHookMode || "native";
      const installedHooksRoot = getCursorHooksInstallRoot(paths, scope, projectRoot);
      if (dryRun) {
        log.dim(`  Would copy Cursor hook scripts to ${installedHooksRoot}`);
        if (mode === "native") {
          log.dim(`  Would configure Cursor hooks at ${paths.getHooksPath(scope, projectRoot)}`);
        }
        if (mode === "claude-compat") {
          log.dim(`  Would configure Claude-compatible hooks at ${paths.getClaudeCompatSettingsPath(scope, projectRoot)}`);
        }
        return;
      }

      installStableTree(resolveHooksRootPath(), installedHooksRoot);

      if (mode === "native") {
        installNativeCursorHooks({
          scope,
          projectRoot,
          url,
          apiKey,
          paths,
          handlersRoot: installedHooksRoot,
        });
      }
      if (mode === "claude-compat") {
        installClaudeCompatHooks({
          scope,
          projectRoot,
          url,
          apiKey,
          paths,
          handlersRoot: installedHooksRoot,
        });
      }
    },
    installSkills({ dryRun, log, scope, projectRoot }) {
      const skillDir = paths.getSkillsDir(scope, projectRoot);
      const currentVersion = getInstallerVersion();
      if (dryRun) {
        log.dim(`  Would install skills into ${skillDir}`);
        log.dim(`  Would write .meko-installer marker (version=${currentVersion})`);
        return { marketplace: "skipped", skills: "dry-run" };
      }

      mkdirSync(skillDir, { recursive: true });
      for (const skill of SKILLS) {
        const source = resolveSkillSourcePath(skill.name);
        const destination = join(skillDir, skill.name);

        if (existsSync(destination)) {
          // Symlinks pointing at our own source directory are already live —
          // the source tree IS the latest content, so there's nothing to
          // refresh. Treat them the same as a fresh-current-version install.
          if (isOwnSymlink(destination, source)) continue;

          const marker = readInstallerMarker(destination);
          if (!marker) {
            // No marker AND not a symlink we own — user-managed dir or a
            // pre-marker install. Leave it alone to avoid clobbering local
            // edits; the user can delete it themselves for a fresh deploy.
            log.dim(
              `  Skipping ${destination}: no .meko-installer marker (user-managed).`,
            );
            continue;
          }
          if (markerIsStale(destination, currentVersion)) {
            const from = marker.version ?? "pre-1.0.9";
            log.dim(
              `  Upgrading cursor skill from ${from} -> ${currentVersion}`,
            );
            removePath(destination);
          } else {
            // Same version already deployed — nothing to do.
            continue;
          }
        } else if (isDanglingSymlink(destination)) {
          // Stale symlink left behind by an earlier install whose target
          // (e.g. a deleted worktree) no longer exists. existsSync is false
          // for these, so the branch above misses them. Clear it so the
          // fresh-install path below can replace it cleanly.
          log.dim?.(
            `  Replacing dangling symlink at ${destination} (target missing).`,
          );
          removePath(destination);
        }

        const strategy = symlinkOrCopy(source, destination, {
          preferCopy: packagedInstallDetector(),
        });
        // Only stamp a marker when we materialized a real copy. Writing into
        // a symlinked source dir would mutate the shipped asset tree, which
        // is confusing at best and a permission error at worst. Symlinks
        // re-resolve via isOwnSymlink on the next run.
        if (strategy === "copy") {
          writeInstallerMarker(destination);
        }
      }

      return { marketplace: "skipped", skills: "ok" };
    },
    uninstall({ name, scope, projectRoot, cursorHookMode }) {
      const results = [];
      try {
        this.removeRegistration(name, { scope, projectRoot });
        results.push({ key: "mcp", ok: true, message: `Cursor MCP server "${name}" removed.` });
      } catch (err) {
        results.push({ key: "mcp", ok: false, message: `Could not remove Cursor MCP server: ${err.message}` });
      }

      try {
        uninstallCursorHooks({
          scope,
          projectRoot,
          mode: cursorHookMode || "native",
          paths,
        });
        results.push({ key: "hooks", ok: true, message: "Cursor hook configuration cleaned up." });
      } catch (err) {
        results.push({ key: "hooks", ok: false, message: `Could not clean Cursor hooks: ${err.message}` });
      }

      try {
        uninstallCursorSkills({ scope, projectRoot, paths });
        results.push({ key: "skills", ok: true, message: "Cursor skills cleaned up." });
      } catch (err) {
        results.push({ key: "skills", ok: false, message: `Could not remove Cursor skills: ${err.message}` });
      }

      return results;
    },
    async validateConfig({ serverName, scope, projectRoot }) {
      const mcpPath = paths.getMcpPath(scope, projectRoot);
      const cfg = readJsonFile(mcpPath);
      const entry = cfg?.mcpServers?.[serverName];
      if (!entry) {
        return { ok: false, message: `Server "${serverName}" not found in ${mcpPath}.` };
      }
      const hasUserAgent = Object.keys(entry.headers ?? {}).some(
        (key) => key.toLowerCase() === "user-agent",
      );
      if (!hasUserAgent) {
        return {
          ok: false,
          message: `Server "${serverName}" in ${mcpPath} is missing the User-Agent header required by the Cloud WAF.`,
        };
      }
      return { ok: true, message: `Server "${serverName}" is registered in ${mcpPath}.` };
    },
  };
}

// NOTE: URL and API key are NOT embedded in the command string.
// They live in the settings file's `env` block (see ensureEnvBlock below) so
// that changing env values — e.g., switching between local and cloud — takes
// effect without rewriting every hook entry. Shadowing env assignments in the
// command prefix (`VAR=... bash "..."`) silently override an inherited env,
// which is exactly the leak we're avoiding (see MEKO-20).
function buildScriptCommand({ scriptPath }) {
  return `bash "${scriptPath}"`;
}

function ensureEnvBlock(cfg, url, apiKey) {
  if (!cfg.env || typeof cfg.env !== "object") cfg.env = {};
  cfg.env.MEKO_MCP_URL = url;
  if (apiKey) {
    cfg.env.MEKO_API_KEY = apiKey;
  } else {
    delete cfg.env.MEKO_API_KEY;
  }
}

function getCursorHooksInstallRoot(paths, scope, projectRoot) {
  return join(
    dirname(paths.getHooksPath(scope, projectRoot)),
    "meko-hooks",
    "hooks-handlers",
  );
}

function installNativeCursorHooks({
  scope,
  projectRoot,
  url,
  apiKey,
  paths,
  handlersRoot,
}) {
  const hooksPath = paths.getHooksPath(scope, projectRoot);
  const cfg = readJsonFile(hooksPath);
  if (!cfg.version) cfg.version = 1;
  if (!cfg.hooks || typeof cfg.hooks !== "object") {
    cfg.hooks = {};
  }

  pruneNativeCursorMekoHooks(cfg.hooks);
  for (const hook of HOOKS) {
    const scriptPath = join(handlersRoot, hook.script);
    const entry = { command: buildScriptCommand({ scriptPath }) };
    if (hook.timeout) entry.timeout = hook.timeout;
    if (hook.matcher) entry.matcher = hook.matcher;
    upsertHookEntry(cfg.hooks, hook.event, entry);
  }

  ensureEnvBlock(cfg, url, apiKey);
  writeJsonFile(hooksPath, cfg);
}

// Cursor's claude-compat mode writes absolute-path Meko hook entries into
// the shared settings.json (on scope=user, the same file Claude Code owns)
// and de-dupes them via upsertClaudeCompatHook. The Claude Code adapter's
// pruneMekoHookEntries (issue #60) is narrowed to preserve any entry whose
// command references the current resolveHooksRoot() — so the entry this
// function writes survives a subsequent Claude Code install from the
// SAME install root.
//
// TRADE-OFF: if Cursor installed from a different root (e.g. repo clone)
// than a later Claude Code install (e.g. npx cache), Cursor's entries look
// byte-identical to the stale Claude Code entries issue #60 targets. They
// will be pruned; the user must re-run the Cursor installer to restore
// them. pruneMekoHookEntries emits a warning on any removal so the user
// has a chance to notice before hooks silently disappear.
function installClaudeCompatHooks({
  scope,
  projectRoot,
  url,
  apiKey,
  paths,
  handlersRoot,
}) {
  const settingsPath = paths.getClaudeCompatSettingsPath(scope, projectRoot);
  const cfg = readJsonFile(settingsPath);
  if (!cfg.hooks || typeof cfg.hooks !== "object") {
    cfg.hooks = {};
  }

  const compatMap = {
    SessionStart: { script: "session-start.sh", timeout: 15000 },
    PreCompact: { script: "pre-compact.sh" },
    SessionEnd: { script: "session-end.sh", timeout: 30000 },
  };

  for (const [event, data] of Object.entries(compatMap)) {
    const scriptPath = join(handlersRoot, data.script);
    const entry = {
      type: "command",
      command: buildScriptCommand({ scriptPath }),
    };
    if (data.timeout) entry.timeout = data.timeout;
    upsertClaudeCompatHook(cfg.hooks, event, entry);
  }

  // On scope=user this file is shared with Claude Code (getClaudeCompatSettingsPath
  // returns ~/.claude/settings.json), so writing the env block here also feeds the
  // Claude Code adapter. See MEKO-20 for the leak this closes.
  ensureEnvBlock(cfg, url, apiKey);
  writeJsonFile(settingsPath, cfg);
}

function upsertHookEntry(hooksObj, event, entry) {
  if (!Array.isArray(hooksObj[event])) hooksObj[event] = [];
  const exists = hooksObj[event].some((item) => item.command === entry.command);
  if (!exists) hooksObj[event].push(entry);
}

function pruneNativeCursorMekoHooks(hooksObj) {
  if (!hooksObj || typeof hooksObj !== "object") return;
  for (const event of Object.keys(hooksObj)) {
    if (!Array.isArray(hooksObj[event])) continue;
    hooksObj[event] = hooksObj[event].filter((item) => {
      if (!item?.command) return true;
      return !isMekoHookCommand(item.command);
    });
  }
}

function isMekoHookCommand(command) {
  if (typeof command !== "string") return false;
  if (!command.includes("hooks-handlers/")) return false;
  return [
    "session-start.sh",
    "cursor-session-start.sh",
    "before-submit-prompt.sh",
    "pre-compact.sh",
    "session-end.sh",
    "post-tool-context.sh",
  ].some((script) => command.includes(script));
}

function upsertClaudeCompatHook(hooksObj, event, entry) {
  if (!Array.isArray(hooksObj[event])) hooksObj[event] = [];
  let bucket = hooksObj[event].find((item) => Array.isArray(item.hooks));
  if (!bucket) {
    bucket = { hooks: [] };
    hooksObj[event].push(bucket);
  }
  const exists = bucket.hooks.some((hook) => hook.command === entry.command);
  if (!exists) bucket.hooks.push(entry);
}

function uninstallCursorHooks({ scope, projectRoot, mode, paths }) {
  const handlersRoot = getCursorHooksInstallRoot(paths, scope, projectRoot);

  if (mode === "native") {
    const hooksPath = paths.getHooksPath(scope, projectRoot);
    const cfg = readJsonFile(hooksPath);
    if (cfg?.hooks && typeof cfg.hooks === "object") {
      for (const event of Object.keys(cfg.hooks)) {
        if (!Array.isArray(cfg.hooks[event])) continue;
        cfg.hooks[event] = cfg.hooks[event].filter((item) => {
          if (!item?.command) return true;
          return !isMekoHookCommand(item.command);
        });
      }
      writeJsonFile(hooksPath, cfg);
    }
  }

  if (mode === "claude-compat") {
    // NOTE: we deliberately do NOT strip env.MEKO_MCP_URL / env.MEKO_API_KEY here.
    // On scope=user, this file is the same ~/.claude/settings.json the Claude Code
    // adapter owns; the Claude Code uninstall (claude-code.mjs removeKeys call) is
    // responsible for env cleanup. Stripping here would break a still-active
    // Claude Code install. See MEKO-20.
    const settingsPath = paths.getClaudeCompatSettingsPath(scope, projectRoot);
    const cfg = readJsonFile(settingsPath);
    if (cfg?.hooks && typeof cfg.hooks === "object") {
      for (const event of Object.keys(cfg.hooks)) {
        const arr = cfg.hooks[event];
        if (!Array.isArray(arr)) continue;
        cfg.hooks[event] = arr.map((group) => {
          if (!Array.isArray(group?.hooks)) return group;
          const filtered = group.hooks.filter((item) => {
            if (!item?.command) return true;
            return !isMekoHookCommand(item.command);
          });
          return { ...group, hooks: filtered };
        }).filter((group) => {
          if (!Array.isArray(group?.hooks)) return true;
          return group.hooks.length > 0;
        });
      }
      writeJsonFile(settingsPath, cfg);
    }
  }

  removePath(dirname(handlersRoot));
}

/**
 * True when `destination` is a symlink that resolves to `expectedSource`.
 * Used to recognize in-place symlink installs on re-run: the live source is
 * the latest content, so there's nothing to refresh.
 */
function isOwnSymlink(destination, expectedSource) {
  try {
    const stat = lstatSync(destination);
    if (!stat.isSymbolicLink()) return false;
    const linkTarget = readlinkSync(destination);
    const resolvedTarget = resolve(dirname(destination), linkTarget);
    return resolvedTarget === expectedSource;
  } catch {
    return false;
  }
}

function uninstallCursorSkills({ scope, projectRoot, paths }) {
  const skillsDir = paths.getSkillsDir(scope, projectRoot);

  for (const skill of SKILLS) {
    const dest = join(skillsDir, skill.name);
    if (!existsSync(dest)) continue;

    const managedCopyMarker = join(dest, ".meko-installer");
    if (existsSync(managedCopyMarker)) {
      removePath(dest);
      continue;
    }

    try {
      const stat = lstatSync(dest);
      if (!stat.isSymbolicLink()) continue;
      const linkTarget = readlinkSync(dest);
      const resolvedTarget = resolve(dirname(dest), linkTarget);
      const expectedTarget = resolveSkillSource(skill.name);
      if (resolvedTarget === expectedTarget) {
        removePath(dest);
      }
    } catch {
      // no-op
    }
  }
}
