/**
 * codex.mjs - OpenAI Codex (CLI + Desktop App) adapter for the Meko MCP installer.
 *
 * The CLI and the Desktop App share the same on-disk state — `~/.codex/config.toml`,
 * `~/.codex/AGENTS.md`, `~/.agents/skills/` — so a single adapter handles both
 * surfaces. We prefer `codex mcp add` when the CLI is available (forward-compatible
 * with future schema fields) and fall back to direct TOML editing when only the
 * App is installed.
 */

import { execSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { askYesNo } from "../prompt.mjs";
import {
  getCodexAgentsMdPath,
  getCodexConfigPath,
  getCodexHooksInstallRoot,
  getCodexHooksPath,
  getCodexMekoEnvFilePath,
  getCodexSkillsRoot,
  readJsonFile,
  writeJsonFile,
} from "../config.mjs";
import {
  getInstallerVersion,
  installStableTree,
  isPackagedInstall,
  isDanglingSymlink,
  markerIsStale,
  readInstallerMarker,
  removePath,
  resolveHooksRoot,
  resolveSkillSource,
  shellQuote,
  symlinkOrCopy,
  writeInstallerMarker,
} from "./common.mjs";

const CODEX_INSTALL_URL = "https://github.com/openai/codex";
const CODEX_APP_INSTALL_URL = "https://openai.com/index/codex";

// Cloud Meko (mcp.mekodata.ai) sits behind a WAF that returns an HTML 403 for
// any request with no User-Agent. Codex's native MCP client (codex_rmcp_client)
// sends none by default, so its `initialize` handshake 403s and the server
// fails to start. `codex mcp add` exposes no header flag, so we set a per-server
// `http_headers` entry in config.toml. Scoped to [mcp_servers.<name>] only — it
// affects requests to the Meko MCP server and nothing else. Local installs skip
// this (no WAF in front of localhost). See GH #174 and the capture.js UA fix.
const CODEX_MCP_USER_AGENT =
  "codex-mcp/1.0 (+https://github.com/yugabyte/meko-mcp-server)";

// AGENTS.md sentinel markers. Idempotent upsert/strip relies on these being
// stable across versions — never rename without a migration story.
const AGENTS_MD_START = "<!-- meko:start -->";
const AGENTS_MD_END = "<!-- meko:end -->";

// Shell rc fence used by maybeOfferRcAppend. Mirrors well-known conventions
// (homebrew, asdf, etc.) so a user grepping their rc can see at a glance
// which tool added the block.
const RC_FENCE_START = "# >>> meko mcp >>>";
const RC_FENCE_END = "# <<< meko mcp <<<";

const SKILLS = [{ name: "meko-mcp-tools" }];
// Codex hook timeouts are in SECONDS (Duration::from_secs in
// codex-rs/hooks/src/engine/command_runner.rs), not milliseconds like Claude
// Code / Cursor. Codex hard-caps SessionEnd at three seconds, so its dedicated
// handler only spools input and launches the actual capture in the background.
const MEKO_HOOKS = [
  { event: "SessionStart", script: "session-start.sh", timeout: 15 },
  { event: "PreCompact", script: "pre-compact.sh" },
  { event: "SessionEnd", script: "codex-session-end.sh", timeout: 3 },
];
// Include the former synchronous Codex SessionEnd handler so reinstall prunes
// it instead of leaving both old and new handlers active.
const MEKO_HOOK_SCRIPTS = [
  ...MEKO_HOOKS.map((hook) => hook.script),
  "session-end.sh",
];

/**
 * @param {{
 *   getConfigPath?: () => string,
 *   getAgentsMdPath?: () => string,
 *   getHooksPath?: () => string,
 *   getSkillsRoot?: () => string,
 *   resolveHooksRoot?: () => string,
 *   getHooksInstallRoot?: () => string,
 *   runCommand?: (cmd: string) => string,
 *   probeCodex?: () => {found: boolean, version: string, path: string},
 *   probeCodexApp?: () => {found: boolean, path: string, platform: string, version: string} | null,
 *   detectShellRc?: () => string | null,
 *   promptUser?: (question: string, defaultYes?: boolean) => Promise<boolean>,
 * }} [options]
 * @returns {object}
 */
export function createCodexAdapter(options = {}) {
  const resolveConfigPath = options.getConfigPath ?? getCodexConfigPath;
  const resolveAgentsMdPath = options.getAgentsMdPath ?? getCodexAgentsMdPath;
  const resolveHooksPath = options.getHooksPath ?? getCodexHooksPath;
  const resolveMekoEnvFilePath =
    options.getMekoEnvFilePath ?? getCodexMekoEnvFilePath;
  const resolveHooksRootPath = options.resolveHooksRoot ?? resolveHooksRoot;
  const resolveHooksInstallRoot =
    options.getHooksInstallRoot ?? getCodexHooksInstallRoot;
  const resolveSkillsRoot = options.getSkillsRoot ?? getCodexSkillsRoot;
  const packagedInstallDetector = options.isPackagedInstall ?? isPackagedInstall;
  const runCommand = options.runCommand ?? defaultRunCommand;
  const probeCodex = options.probeCodex ?? defaultProbeCodex;
  const probeCodexApp = options.probeCodexApp ?? defaultProbeCodexApp;
  const detectShellRc = options.detectShellRc ?? defaultDetectShellRc;
  const promptUser = options.promptUser ?? askYesNo;

  /** @type {{cli: object|null, app: object|null}} */
  const surfaces = { cli: null, app: null };

  let scopeWarned = false;

  // A reinstall's remove→register sequence deletes the whole
  // [mcp_servers.<name>] block (via `codex mcp remove` or removeCodexConfigBlock),
  // including any http_headers in either inline or table form, before
  // registerServer rewrites it — which would silently drop a user's custom
  // headers. removeRegistration stashes the pre-existing headers (as a key→value
  // map, form-agnostic) here so the later ensureCodexHttpHeaderUserAgent step
  // can merge them back while guaranteeing a User-Agent. null = nothing to
  // preserve.
  let preservedHttpHeaders = null;

  /** Returns the resolved config.toml path; warns once on project scope. */
  function settingsPathFor(scope, log) {
    if (scope === "project" && !scopeWarned) {
      scopeWarned = true;
      log?.warn?.(
        "Codex has no project-scope config; installing into the user-level ~/.codex/config.toml.",
      );
    }
    return resolveConfigPath();
  }

  return {
    id: "codex",
    displayName: "OpenAI Codex (CLI + App)",
    settingsPath() {
      // The scope arg is intentionally ignored: Codex has no project scope.
      // The first call site with a logger (registerServer / installSkills)
      // emits the degrade warning.
      return resolveConfigPath();
    },
    async detectPrerequisites({ verbose, log } = { verbose: false, log: console }) {
      const cli = probeCodex();
      const app = probeCodexApp();
      surfaces.cli = cli?.found ? cli : null;
      surfaces.app = app?.found ? app : null;
      if (!surfaces.cli && !surfaces.app) {
        throw new Error(
          `OpenAI Codex not found. Install the CLI (${CODEX_INSTALL_URL}) ` +
            `or the desktop app (${CODEX_APP_INSTALL_URL}).`,
        );
      }
      if (verbose) {
        if (surfaces.cli) {
          log.dim?.(`  Codex CLI: ${surfaces.cli.path} (${surfaces.cli.version})`);
        }
        if (surfaces.app) {
          log.dim?.(
            `  Codex App: ${surfaces.app.path} (${surfaces.app.platform}${
              surfaces.app.version ? `, ${surfaces.app.version}` : ""
            })`,
          );
        }
      }
    },
    isInstalled() {
      // Cheap check used by the picker — full prereq probing happens in
      // detectPrerequisites. We re-probe here because the picker runs before
      // detectPrerequisites and we want it to reflect reality.
      const cli = probeCodex();
      const app = probeCodexApp();
      return Boolean((cli && cli.found) || (app && app.found));
    },
    detectExisting(name, { scope } = {}) {
      // Force a probe if we haven't yet — picker may not have called
      // detectPrerequisites.
      if (surfaces.cli === null && surfaces.app === null) {
        const cli = probeCodex();
        const app = probeCodexApp();
        surfaces.cli = cli?.found ? cli : null;
        surfaces.app = app?.found ? app : null;
      }

      let cliFound = false;
      if (surfaces.cli) {
        try {
          runCommand(`codex mcp get ${shellQuote(name)}`);
          cliFound = true;
        } catch {
          // fall through to TOML grep — `codex mcp get` exits non-zero when
          // the entry isn't present, but might also fail for unrelated
          // reasons (very old CLI, syntax error in config.toml). The TOML
          // grep is authoritative.
        }
      }
      const path = settingsPathFor(scope, null);
      const raw = safeReadFile(path);
      if (raw !== null) {
        const parsed = parseCodexConfigForServer(raw, name);
        if (parsed.found) {
          return {
            found: true,
            status: "Configured",
            ...(parsed.url ? { url: parsed.url } : {}),
          };
        }
      }
      return cliFound
        ? { found: true, status: "Configured" }
        : { found: false, status: "" };
    },
    removeRegistration(name, { scope, log } = {}) {
      const path = settingsPathFor(scope, log);
      // Capture any existing http_headers (inline OR table form) BEFORE we
      // delete the block, so a reinstall can restore the user's custom values
      // (see preservedHttpHeaders). Done on both the CLI and TOML paths since
      // `codex mcp remove` also drops the whole block and any subtable.
      preservedHttpHeaders = readCodexHttpHeaders(safeReadFile(path), name);
      if (surfaces.cli) {
        try {
          runCommand(`codex mcp remove ${shellQuote(name)}`);
          return;
        } catch {
          // CLI doesn't know `mcp remove`, or the entry wasn't present.
          // Fall through to direct TOML edit — idempotent on a missing
          // block.
        }
      }
      const raw = safeReadFile(path);
      if (raw === null) return;
      const next = removeCodexConfigBlock(raw, name);
      if (next !== raw) writeWithBackup(path, next);
    },
    async registerServer({ name, url, apiKey, dryRun, verbose, log, scope, yes }) {
      const path = settingsPathFor(scope, log);
      const useApiKey = apiKey ? "MEKO_API_KEY" : null;
      const cliCmd = buildCliRegisterCommand(name, url, useApiKey);

      const cloud = !isLocalUrl(url);

      if (dryRun) {
        if (surfaces.cli) {
          log.dim?.(`  Would run: ${cliCmd}`);
        } else {
          log.dim?.(`  Would upsert [mcp_servers.${name}] in ${path}`);
        }
        if (apiKey) {
          log.dim?.(
            "  Codex resolves the bearer token from $MEKO_API_KEY at runtime; the key is not written to config.toml.",
          );
        }
        if (cloud) {
          log.dim?.(
            `  Would ensure [mcp_servers.${name}] has an http_headers User-Agent (Cloud WAF needs one; backs up ${path} first, preserves any existing header).`,
          );
        }
        return;
      }

      let usedCliPath = false;
      if (surfaces.cli) {
        try {
          const output = runCommand(cliCmd);
          if (verbose && output) log.dim?.(`  ${output.trim()}`);
          usedCliPath = true;
        } catch (err) {
          const msg = (err && (err.stderr || err.message)) || "";
          const lower = msg.toLowerCase();
          // Old CLI (no `mcp add` subcommand) — fall through to TOML write.
          if (
            lower.includes("unknown command") ||
            lower.includes("unrecognized") ||
            lower.includes("invalid command")
          ) {
            log.warn?.(
              "  codex mcp add not supported by this CLI version — writing config.toml directly.",
            );
          } else {
            throw err;
          }
        }
      }

      if (!usedCliPath) {
        const raw = safeReadFile(path) ?? "";
        const next = upsertCodexConfigBlock(raw, name, {
          url,
          bearer_token_env_var: useApiKey,
        });
        writeWithBackup(path, next);
        if (verbose) log.dim?.(`  Wrote [mcp_servers.${name}] to ${path}`);
      }

      // Cloud Meko's WAF 403s Codex's native MCP client when it sends no
      // User-Agent on the initialize handshake. `codex mcp add` has no header
      // flag, so patch the written block with an http_headers User-Agent.
      // Reads the file first, preserves any existing http_headers, and backs
      // up config.toml before writing. Local installs have no WAF, so skip.
      if (cloud) {
        // Merge back any custom http_headers captured by removeRegistration
        // before the reinstall wiped the block, while guaranteeing a User-Agent.
        const preserved = preservedHttpHeaders;
        preservedHttpHeaders = null; // consume — don't leak into a later call
        const outcome = ensureCodexHttpHeaderUserAgent(path, name, {
          preserved,
        });
        if (outcome === "restored") {
          log.dim?.(
            `  Restored your existing http_headers on [mcp_servers.${name}] (with a User-Agent) after re-registration.`,
          );
        } else if (outcome === "merged") {
          log.dim?.(
            `  Added a User-Agent to your existing http_headers on [mcp_servers.${name}] so Codex's MCP client clears the Cloud WAF (backup written to ${path}.bak).`,
          );
        } else if (outcome === "added") {
          log.dim?.(
            `  Set http_headers User-Agent on [mcp_servers.${name}] so Codex's MCP client clears the Cloud WAF (backup written to ${path}.bak).`,
          );
        } else if (outcome === "present" && verbose) {
          log.dim?.(
            `  [mcp_servers.${name}] already has an http_headers User-Agent — left as-is.`,
          );
        } else if (outcome === "absent") {
          log.warn?.(
            `  Could not find [mcp_servers.${name}] in ${path} to set the Cloud WAF User-Agent header; if Codex reports an HTTP 403 on startup, add http_headers = { "User-Agent" = "${CODEX_MCP_USER_AGENT}" } manually.`,
          );
        }
      }

      // Cloud auth UX: env-var-only model. The key is never written to
      // config.toml; the user's runtime env supplies it. Print actionable
      // instructions and (when interactive) offer to wire things up.
      if (apiKey) {
        const platform = surfaces.app?.platform ?? process.platform;
        const hasApp = Boolean(surfaces.app);
        const shellRc = detectShellRc();
        printCloudAuthInstructions({ shellRc, hasApp, platform, log });
        if (!yes) {
          await maybeOfferRcAppend({
            apiKey,
            shellRc,
            promptUser,
            log,
          });
          if (hasApp && platform === "darwin") {
            await maybeOfferLaunchctlSetenv({
              apiKey,
              promptUser,
              runCommand,
              log,
            });
          }
        } else if (hasApp && platform === "darwin") {
          setLaunchctlMekoApiKey({
            apiKey,
            runCommand,
            log,
          });
        }
      }

      if (surfaces.app) {
        log.dim?.("  Restart Codex.app to attach the new MCP server.");
      }
    },
    async maybeConfirmOverwrite({ existingFound, name, yes }) {
      if (!existingFound) return true;
      if (yes) return true;
      return promptUser(`${name} MCP is already configured. Overwrite?`, false);
    },
    setHookEnvironment({ url, apiKey, log, dryRun, verbose }) {
      const hooksPath = resolveHooksPath();
      const assetHooksRoot = resolveHooksRootPath();
      const installedHooksRoot = resolveHooksInstallRoot();
      const envFilePath = resolveMekoEnvFilePath();
      if (dryRun) {
        log?.dim?.(`  Would copy Codex hook scripts to ${installedHooksRoot}`);
        log?.dim?.(`  Would write env file at ${envFilePath} (mode 0600)`);
        log?.dim?.(`  Would configure Codex hooks at ${hooksPath}`);
        if (apiKey) {
          log?.dim?.(
            `  MEKO_API_KEY will be stored in ${envFilePath} (mode 0600); hook commands source it (no API key in process args).`,
          );
        }
        return;
      }

      // Copy the hook scripts to a home-dir-stable location before wiring
      // hooks.json at that path. Referencing the shipped asset root directly
      // would pin an ephemeral npx cache dir that npx later GCs, leaving the
      // hook a dangling `bash '<missing>'` that exits 127. See
      // getCodexHooksInstallRoot for the full rationale.
      installStableTree(assetHooksRoot, installedHooksRoot);
      writeCodexMekoEnvFile(envFilePath, { url, apiKey });
      const changed = upsertCodexMekoHooks(hooksPath, installedHooksRoot, {
        envFilePath,
      });
      if (verbose || changed) {
        log?.dim?.(`  Updated Codex hooks at ${hooksPath}`);
      }
      if (apiKey) {
        log?.dim?.(
          `  MEKO_API_KEY stored in ${envFilePath} (mode 0600). Hook commands source the file at run time, so the key never appears in process arguments.`,
        );
      }
    },
    installSkills({ dryRun, log, scope, name }) {
      void scope; // Codex skills are user-scope only.
      const serverName = name ?? "meko";
      const skillsRoot = resolveSkillsRoot();
      const agentsMdPath = resolveAgentsMdPath();
      const currentVersion = getInstallerVersion();

      if (dryRun) {
        log.dim?.(`  Would install skills into ${skillsRoot}`);
        log.dim?.(`  Would upsert Meko block in ${agentsMdPath}`);
        return { marketplace: "skipped", skills: "dry-run" };
      }

      mkdirSync(skillsRoot, { recursive: true });
      for (const skill of SKILLS) {
        const source = resolveSkillSource(skill.name);
        const destination = join(skillsRoot, skill.name);

        if (existsSync(destination)) {
          // A symlink we own already points at the latest source — nothing
          // to refresh. Mirrors the cursor adapter's isOwnSymlink branch.
          if (isOwnSymlink(destination, source)) continue;

          const marker = readInstallerMarker(destination);
          if (!marker) {
            log.dim?.(
              `  Skipping ${destination}: no .meko-installer marker (user-managed).`,
            );
            continue;
          }
          if (markerIsStale(destination, currentVersion)) {
            const from = marker.version ?? "pre-1.0.9";
            log.dim?.(
              `  Upgrading codex skill from ${from} -> ${currentVersion}`,
            );
            removePath(destination);
          } else {
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
        if (strategy === "copy") writeInstallerMarker(destination);
      }

      upsertAgentsMdBlock(agentsMdPath, currentVersion, { name: serverName });

      if (surfaces.app) {
        log.dim?.("  Restart Codex.app to pick up the new skill / AGENTS.md.");
      }

      return { marketplace: "skipped", skills: "ok" };
    },
    uninstall({ name, scope, log = console }) {
      const results = [];
      try {
        this.removeRegistration(name, { scope, log });
        results.push({
          key: "mcp",
          ok: true,
          message: `Codex MCP server "${name}" removed.`,
        });
      } catch (err) {
        results.push({
          key: "mcp",
          ok: false,
          message: `Could not remove Codex MCP server: ${err.message}`,
        });
      }

      try {
        const skillsRoot = resolveSkillsRoot();
        for (const skill of SKILLS) {
          const dest = join(skillsRoot, skill.name);
          if (!existsSync(dest)) continue;
          // Remove the dest if it's either a marker-stamped copy (we own it)
          // or a symlink pointing at our shipped source (also us).
          const markerPath = join(dest, ".meko-installer");
          if (existsSync(markerPath)) {
            removePath(dest);
            continue;
          }
          const expectedSource = resolveSkillSource(skill.name);
          if (isOwnSymlink(dest, expectedSource)) removePath(dest);
        }
        results.push({
          key: "skills",
          ok: true,
          message: "Codex skills cleaned up.",
        });
      } catch (err) {
        results.push({
          key: "skills",
          ok: false,
          message: `Could not remove Codex skills: ${err.message}`,
        });
      }

      try {
        const hooksPath = resolveHooksPath();
        const envFilePath = resolveMekoEnvFilePath();
        const changed = removeCodexMekoHooks(hooksPath, {
          envFilePath,
          hooksInstallRoot: resolveHooksInstallRoot(),
        });
        if (changed) {
          results.push({
            key: "hooks",
            ok: true,
            message: "Codex Meko hooks cleaned up.",
          });
        }
      } catch (err) {
        results.push({
          key: "hooks",
          ok: false,
          message: `Could not clean Codex hooks: ${err.message}`,
        });
      }

      try {
        const agentsMdPath = resolveAgentsMdPath();
        const raw = safeReadFile(agentsMdPath);
        if (raw !== null) {
          const next = removeAgentsMdBlock(raw);
          if (next !== raw) writeWithBackup(agentsMdPath, next);
        }
        results.push({
          key: "agents-md",
          ok: true,
          message: "Meko block stripped from AGENTS.md.",
        });
      } catch (err) {
        results.push({
          key: "agents-md",
          ok: false,
          message: `Could not update AGENTS.md: ${err.message}`,
        });
      }

      if (surfaces.app) {
        log.dim?.("  Restart Codex.app to apply the removal.");
      }

      return results;
    },
    async validateConfig({ serverName, scope, url }) {
      const path = settingsPathFor(scope, null);
      if (surfaces.cli) {
        try {
          runCommand(`codex mcp get ${shellQuote(serverName)}`);
          return {
            ok: true,
            message: `Server "${serverName}" registered (codex mcp get succeeded).`,
          };
        } catch {
          // fall through to TOML inspection
        }
      }
      const raw = safeReadFile(path);
      if (raw === null) {
        return { ok: false, message: `Codex config not found at ${path}.` };
      }
      const parsed = parseCodexConfigForServer(raw, serverName);
      if (!parsed.found) {
        return {
          ok: false,
          message: `Server "${serverName}" not found in ${path}.`,
        };
      }
      if (url && parsed.url && parsed.url !== url) {
        return {
          ok: false,
          message: `Server "${serverName}" in ${path} points at ${parsed.url}, expected ${url}.`,
        };
      }
      return { ok: true, message: `Server "${serverName}" is registered in ${path}.` };
    },
  };
}

// Codex's hooks.json schema only deserializes `hooks` and `state` — sibling
// keys like `env` are silently dropped, and `HookHandlerConfig::Command` has
// no per-command `env` field. The runner spawns each command via
// `$SHELL -lc <command>` with the parent env inherited.
//
// We sidestep that by writing a 0600 env file (default ~/.codex/meko-env.sh)
// that the hook command sources before invoking the script:
//   `. /path/to/meko-env.sh && bash /path/to/hook.sh`
// The API key never appears in process arguments, so a `ps -ef` from another
// user (or a logging shim) can't lift it from the command line. Same trust
// boundary as `git credential-store`.
function upsertCodexMekoHooks(hooksPath, hooksRoot, { envFilePath } = {}) {
  const cfg = readJsonFile(hooksPath);
  const before = JSON.stringify(cfg);
  if (!cfg.hooks || typeof cfg.hooks !== "object") {
    cfg.hooks = {};
  }

  pruneCodexMekoHooksObject(cfg.hooks);
  for (const hook of MEKO_HOOKS) {
    const entry = {
      type: "command",
      command: buildCodexHookCommand(join(hooksRoot, hook.script), { envFilePath }),
    };
    if (hook.timeout) entry.timeout = hook.timeout;
    upsertCodexHookEntry(cfg.hooks, hook.event, entry);
  }

  const after = JSON.stringify(cfg);
  if (after !== before) {
    writeJsonFile(hooksPath, cfg);
    return true;
  }
  return false;
}

function buildCodexHookCommand(scriptPath, { envFilePath } = {}) {
  const parts = [];
  if (envFilePath) parts.push(`. ${shellQuote(envFilePath)}`);
  parts.push(`MEKO_HOOK_CLIENT=codex bash ${shellQuote(scriptPath)}`);
  return parts.join(" && ");
}

/**
 * Write the Meko env file the Codex hooks source. Mode 0600 (user
 * read/write only) so the API key isn't readable by other users.
 * Idempotent: re-running with the same values is a no-op write that
 * still asserts the mode.
 */
function writeCodexMekoEnvFile(path, { url, apiKey }) {
  mkdirSync(dirname(path), { recursive: true });
  const lines = [
    "# Auto-generated by @yugabytedb/meko-mcp installer.",
    "# Sourced by Codex hooks (see ~/.codex/hooks.json) before each hook runs.",
    "# Mode 0600 — do not commit, do not share, do not relax permissions.",
    `export MEKO_MCP_URL=${shellQuote(url || "")}`,
    `export MEKO_API_KEY=${shellQuote(apiKey || "")}`,
    "",
  ];
  writeFileSync(path, lines.join("\n"), { encoding: "utf8", mode: 0o600 });
  // writeFileSync's `mode` only applies on initial create; re-assert
  // explicitly so a permission relaxation between installs is corrected.
  chmodSync(path, 0o600);
}

function removeCodexMekoHooks(hooksPath, { envFilePath, hooksInstallRoot } = {}) {
  const cfg = readJsonFile(hooksPath);
  let changed = false;
  if (cfg.hooks && typeof cfg.hooks === "object") {
    const before = JSON.stringify(cfg);
    pruneCodexMekoHooksObject(cfg.hooks);
    if (Object.keys(cfg.hooks).length === 0) {
      delete cfg.hooks;
    }
    // Older installs (PR 127 first cut) wrote a top-level cfg.env block that
    // Codex silently ignored. Strip it during uninstall so we don't leave a
    // misleading env hanging around in user configs.
    if (cfg.env && typeof cfg.env === "object") {
      delete cfg.env.MEKO_MCP_URL;
      delete cfg.env.MEKO_API_KEY;
      if (Object.keys(cfg.env).length === 0) {
        delete cfg.env;
      }
    }
    if (JSON.stringify(cfg) !== before) {
      writeJsonFile(hooksPath, cfg);
      changed = true;
    }
  }

  // Remove the meko-env.sh file too — leaving a 0600 file with credentials
  // around after uninstall is a security gap.
  if (envFilePath) {
    try {
      rmSync(envFilePath, { force: true });
    } catch {
      // best-effort
    }
  }

  // Remove the copied hook scripts (getCodexHooksInstallRoot). We remove the
  // whole meko-hooks/ wrapper, not just the hooks-handlers leaf, so no empty
  // parent is left behind. best-effort — never let cleanup fail uninstall.
  if (hooksInstallRoot) {
    try {
      rmSync(dirname(hooksInstallRoot), { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
  return changed;
}

function upsertCodexHookEntry(hooksObj, event, entry) {
  if (!Array.isArray(hooksObj[event])) hooksObj[event] = [];
  let group = hooksObj[event].find((item) => Array.isArray(item?.hooks));
  if (!group) {
    group = { hooks: [] };
    hooksObj[event].push(group);
  }
  const exists = group.hooks.some((hook) => hook.command === entry.command);
  if (!exists) group.hooks.push(entry);
}

function pruneCodexMekoHooksObject(hooksObj) {
  for (const event of Object.keys(hooksObj)) {
    const groups = hooksObj[event];
    if (!Array.isArray(groups)) continue;
    hooksObj[event] = groups
      .map((group) => {
        if (!Array.isArray(group?.hooks)) return group;
        return {
          ...group,
          hooks: group.hooks.filter((hook) => !isMekoHookCommand(hook?.command)),
        };
      })
      .filter((group) => !Array.isArray(group?.hooks) || group.hooks.length > 0);
    if (hooksObj[event].length === 0) {
      delete hooksObj[event];
    }
  }
}

function isMekoHookCommand(command) {
  if (typeof command !== "string") return false;
  return MEKO_HOOK_SCRIPTS.some((script) => {
    const escaped = script.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(
      String.raw`(^|[/\\])hooks-handlers[/\\]${escaped}(?=$|['"\s])`,
    );
    return pattern.test(command);
  });
}

// ---------------------------------------------------------------------------
// Probes (default impls; tests inject stubs)
// ---------------------------------------------------------------------------

function defaultRunCommand(cmd) {
  return execSync(cmd, { encoding: "utf8", stdio: "pipe" }).toString();
}

function defaultProbeCodex() {
  const result = { found: false, version: "", path: "" };
  let path = "";
  try {
    path = execSync("which codex", { encoding: "utf8", stdio: "pipe" }).trim();
  } catch {
    return result;
  }
  if (!path) return result;
  result.path = path;
  try {
    result.version = execSync("codex --version", {
      encoding: "utf8",
      stdio: "pipe",
      timeout: 10_000,
    }).trim();
  } catch {
    return result;
  }
  result.found = true;
  return result;
}

function defaultProbeCodexApp() {
  const home = homedir();
  if (process.platform === "darwin") {
    for (const candidate of [
      "/Applications/Codex.app",
      join(home, "Applications", "Codex.app"),
    ]) {
      if (existsSync(candidate)) {
        return {
          found: true,
          path: candidate,
          platform: "darwin",
          version: readMacAppVersion(candidate) ?? "",
        };
      }
    }
    return null;
  }
  if (process.platform === "linux") {
    // Best-effort. Codex Linux distribution shape is fluid; check the most
    // common landing spots and return null otherwise.
    const linuxCandidates = [
      join(home, ".local", "share", "applications", "codex.desktop"),
      "/usr/share/applications/codex.desktop",
    ];
    for (const candidate of linuxCandidates) {
      if (existsSync(candidate)) {
        return { found: true, path: candidate, platform: "linux", version: "" };
      }
    }
    return null;
  }
  // Windows desktop app detection is out of scope for v1.
  return null;
}

function readMacAppVersion(appPath) {
  const plist = join(appPath, "Contents", "Info.plist");
  let raw;
  try {
    raw = readFileSync(plist, "utf8");
  } catch {
    return null;
  }
  const m = raw.match(
    /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/,
  );
  return m ? m[1] : null;
}

function defaultDetectShellRc() {
  const shell = process.env.SHELL || "";
  const home = homedir();
  if (shell.endsWith("/zsh")) return join(home, ".zshrc");
  if (shell.endsWith("/bash")) {
    // macOS: bash users typically edit ~/.bash_profile (login shell);
    // Linux: ~/.bashrc.
    return process.platform === "darwin"
      ? join(home, ".bash_profile")
      : join(home, ".bashrc");
  }
  if (shell.endsWith("/fish")) {
    return join(home, ".config", "fish", "config.fish");
  }
  return null;
}

// ---------------------------------------------------------------------------
// CLI command builders
// ---------------------------------------------------------------------------

function buildCliRegisterCommand(name, url, bearerEnv) {
  let cmd = `codex mcp add ${shellQuote(name)} --url ${shellQuote(url)}`;
  if (bearerEnv) {
    cmd += ` --bearer-token-env-var ${shellQuote(bearerEnv)}`;
  }
  return cmd;
}

/**
 * True for localhost / loopback MCP URLs (no cloud WAF in front). Parses the
 * URL and compares the HOSTNAME exactly — a substring test would wrongly
 * classify `https://localhost.example.com` (a real remote host) as local and
 * skip the WAF User-Agent header. Unparseable input is treated as non-local
 * (cloud), i.e. we err toward setting the header.
 */
function isLocalUrl(url) {
  let host;
  try {
    host = new URL(String(url ?? "")).hostname;
  } catch {
    return false;
  }
  // `new URL` strips the brackets from IPv6 literals, so `[::1]` → `::1`.
  host = host.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    host === "localhost" ||
    host === "::1" ||
    // Entire 127.0.0.0/8 block is loopback, not just 127.0.0.1.
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

const HTTP_HEADER_USER_AGENT_KEY = "User-Agent";

// Matches one `KEY = "VALUE"` (or single-quoted) pair. KEY may be
// double-quoted, single-quoted, or a bare TOML key (letters/digits/_/-).
// Used for both the inline `{ ... }` body and the table-form body.
const TOML_KV_PAIR =
  /(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** True if `map` has a `User-Agent` key, case-insensitively (HTTP names are). */
function hasUserAgentKey(map) {
  return Object.keys(map).some((k) => k.toLowerCase() === "user-agent");
}

/** Parse `KEY = "VALUE"` pairs from a chunk of TOML into an ordered object. */
function parseTomlKvPairs(text) {
  const out = {};
  TOML_KV_PAIR.lastIndex = 0;
  let m;
  while ((m = TOML_KV_PAIR.exec(text)) !== null) {
    const key = m[1] ?? m[2] ?? m[3];
    const value = m[4] ?? m[5] ?? "";
    if (key !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Locate a table-form `[mcp_servers.<name>.http_headers]` section, if present.
 * `parseCodexConfigForServer`'s block ends at the first subtable, so this form
 * lives OUTSIDE that block and needs its own lookup.
 *
 * @returns {{start: number, end: number, body: string}|null}
 */
function findHttpHeadersSubtable(raw, name) {
  const header = `[mcp_servers.${name}.http_headers]`;
  const idx = findHeader(raw, header);
  if (idx === -1) return null;
  const end = findNextHeader(raw, idx + header.length);
  return { start: idx, end, body: raw.slice(idx + header.length, end) };
}

/**
 * Read the effective `http_headers` for a server from EITHER form (inline
 * `http_headers = { ... }` inside the block, or a `[…​.http_headers]` subtable),
 * returning an ordered key→value map, or null when neither is present. Used to
 * snapshot a user's headers before a reinstall wipes them.
 *
 * @param {string|null} raw
 * @param {string} name
 * @returns {Record<string,string>|null}
 */
function readCodexHttpHeaders(raw, name) {
  if (raw === null || raw === undefined) return null;
  const existing = parseCodexConfigForServer(raw, name);
  if (!existing.found) return null;

  const block = raw.slice(existing.start, existing.end);
  const inline = block.match(/^[ \t]*http_headers[ \t]*=[ \t]*\{([^}]*)\}/m);
  if (inline) return parseTomlKvPairs(inline[1]);

  const subtable = findHttpHeadersSubtable(raw, name);
  if (subtable) return parseTomlKvPairs(subtable.body);

  return null;
}

/** Render a headers map as a single canonical inline `http_headers` line. */
function renderInlineHttpHeaders(map) {
  const parts = Object.entries(map).map(
    ([k, v]) => `"${escapeTomlString(k)}" = "${escapeTomlString(v)}"`,
  );
  return `http_headers = { ${parts.join(", ")} }`;
}

/**
 * Ensure the `[mcp_servers.<name>]` block carries an `http_headers` User-Agent
 * so Codex's native MCP client clears the Cloud WAF (see CODEX_MCP_USER_AGENT).
 *
 * This MERGES rather than all-or-nothing: it reads the effective headers from
 * whichever form is present — inline `http_headers = { ... }` or a table-form
 * `[mcp_servers.<name>.http_headers]` — plus any `preserved` map captured
 * before a reinstall wiped the block, then guarantees a `User-Agent` entry
 * exists while keeping every other header the user set. The result is written
 * as a single canonical inline line, and any table-form section is removed so
 * we never leave two conflicting `http_headers` definitions (invalid TOML).
 *
 * Contract — check, back up, then change:
 *   1. Read config.toml (returns "absent" if the file or server block is gone).
 *   2. Merge preserved + existing headers; if a User-Agent is already present
 *      AND no reshaping is needed (no table form to collapse), report "present"
 *      and write nothing.
 *   3. Otherwise write the merged inline header via writeWithBackup (`.bak`).
 *
 * @param {string} configPath
 * @param {string} name
 * @param {{userAgent?: string, preserved?: Record<string,string>|null}} [opts]
 * @returns {"added"|"restored"|"merged"|"present"|"absent"} what happened
 */
function ensureCodexHttpHeaderUserAgent(
  configPath,
  name,
  { userAgent, preserved = null } = {},
) {
  const ua = userAgent ?? CODEX_MCP_USER_AGENT;
  const raw = safeReadFile(configPath);
  if (raw === null) return "absent";
  const existing = parseCodexConfigForServer(raw, name);
  if (!existing.found) return "absent";

  const block = raw.slice(existing.start, existing.end);
  const inlineMatch = block.match(
    /^[ \t]*http_headers[ \t]*=[ \t]*\{([^}]*)\}[ \t]*$/m,
  );
  const subtable = findHttpHeadersSubtable(raw, name);

  // Merge order: existing on-disk headers first (inline or table), then any
  // reinstall-preserved map layered on top. Preserved wins on key collisions
  // because it reflects the user's most recent intent before the wipe.
  const onDisk = inlineMatch
    ? parseTomlKvPairs(inlineMatch[1])
    : subtable
      ? parseTomlKvPairs(subtable.body)
      : {};
  const merged = { ...onDisk, ...(preserved ?? {}) };

  const hadUserAgent = hasUserAgentKey(merged);
  const restoring = Boolean(preserved);

  // Nothing to do only when a User-Agent is already present AND the on-disk
  // form is a single inline line (nothing to collapse or restore).
  if (hadUserAgent && inlineMatch && !subtable && !restoring) return "present";

  if (!hadUserAgent) merged[HTTP_HEADER_USER_AGENT_KEY] = ua;

  const line = renderInlineHttpHeaders(merged);

  // Build the new server block: drop any existing inline line, then insert the
  // canonical inline line right under the table header.
  let newBlock = block;
  if (inlineMatch) {
    newBlock = newBlock.replace(
      /^[ \t]*http_headers[ \t]*=[ \t]*\{[^}]*\}[ \t]*\n?/m,
      "",
    );
  }
  const headerLine = `[mcp_servers.${name}]`;
  const headerIdx = newBlock.indexOf(headerLine);
  const insertAt = headerIdx + headerLine.length;
  newBlock =
    newBlock.slice(0, insertAt) + `\n${line}` + newBlock.slice(insertAt);

  // Reassemble the file, splicing the block back and excising any table-form
  // subtable (now folded into the inline line) to avoid a duplicate key.
  let next = raw.slice(0, existing.start) + newBlock + raw.slice(existing.end);
  if (subtable) {
    // Recompute the subtable bounds against the rewritten string — the block
    // edit shifted offsets. The subtable always sits after our block.
    const fresh = findHttpHeadersSubtable(next, name);
    if (fresh) {
      next = next.slice(0, fresh.start) + next.slice(fresh.end);
      next = next.replace(/\n{3,}/g, "\n\n");
    }
  }

  writeWithBackup(configPath, next);
  if (restoring) return "restored";
  if (subtable || (inlineMatch && !hadUserAgent)) return "merged";
  return "added";
}

// ---------------------------------------------------------------------------
// TOML helpers (App-only fallback path)
// ---------------------------------------------------------------------------

/**
 * Locate `[mcp_servers.<name>]` and return its raw block text.
 * Read-only — no parsing into a structured object.
 *
 * @param {string} raw
 * @param {string} name
 * @returns {{found: boolean, start?: number, end?: number, url?: string}}
 */
export function parseCodexConfigForServer(raw, name) {
  const header = `[mcp_servers.${name}]`;
  const headerIdx = findHeader(raw, header);
  if (headerIdx === -1) return { found: false };
  const blockEnd = findNextHeader(raw, headerIdx + header.length);
  const block = raw.slice(headerIdx, blockEnd);
  const urlMatch = block.match(/^\s*url\s*=\s*"([^"]*)"/m);
  return {
    found: true,
    start: headerIdx,
    end: blockEnd,
    url: urlMatch ? urlMatch[1] : undefined,
  };
}

/**
 * Insert or replace `[mcp_servers.<name>]` block. `fields` keys must be
 * string-valued (we don't need numbers / arrays / inline tables for the
 * MCP fields we write). Pass `null`/`undefined` to omit a field.
 *
 * Emission contract:
 *   - The rendered block always ends with a single "\n" so the last
 *     field line is terminated.
 *   - When something follows the block in the existing TOML (another
 *     table header at `existing.end`), we add one additional "\n" so
 *     there is exactly one blank line separating the two tables —
 *     matching canonical `taplo` / `dprint-toml` formatting.
 *   - When the block is the last thing in the file we emit just the
 *     terminator "\n" — no trailing blank line.
 *
 * Without these terminators the replacement path glued the next
 * top-level header onto the last field, e.g.
 *   bearer_token_env_var = "MEKO_API_KEY"[final]
 * which is invalid TOML.
 *
 * @param {string} raw
 * @param {string} name
 * @param {Record<string, string|null|undefined>} fields
 * @returns {string}
 */
export function upsertCodexConfigBlock(raw, name, fields) {
  const blockBody = renderBlock(name, fields);
  const existing = parseCodexConfigForServer(raw, name);

  if (!existing.found) {
    // Fresh insert appended to the end of file.
    if (raw.length === 0) return blockBody + "\n";
    const sep = raw.endsWith("\n") ? "\n" : "\n\n";
    return raw + sep + blockBody + "\n";
  }

  // In-place replacement. parseCodexConfigForServer's `end` is the index
  // of the next `[` (top-level table) or raw.length when our block is
  // last. Pick the trailing separator accordingly.
  const tail = raw.slice(existing.end);
  const trailing = tail.length === 0 ? "\n" : "\n\n";
  return raw.slice(0, existing.start) + blockBody + trailing + tail;
}

/**
 * Excise the `[mcp_servers.<name>]` block. Collapses extra blank lines
 * left behind by the cut so we don't accumulate `\n\n\n` runs across
 * round-trips.
 *
 * @param {string} raw
 * @param {string} name
 * @returns {string}
 */
export function removeCodexConfigBlock(raw, name) {
  const existing = parseCodexConfigForServer(raw, name);
  if (!existing.found) return raw;
  let next = raw.slice(0, existing.start) + raw.slice(existing.end);
  next = next.replace(/\n{3,}/g, "\n\n");
  return next;
}

/**
 * Render a `[mcp_servers.<name>]` block. The returned string is the
 * header line plus one line per non-null field, joined with "\n" and
 * with NO trailing newline. Callers (upsertCodexConfigBlock) append
 * their own terminator and any blank-line separation.
 */
function renderBlock(name, fields) {
  const lines = [`[mcp_servers.${name}]`];
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    lines.push(`${key} = "${escapeTomlString(value)}"`);
  }
  return lines.join("\n");
}

function escapeTomlString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Find the first occurrence of `header` at the start of a line, ignoring
 * comments and indented (subtable) headers like `[mcp_servers.meko.tools]`.
 *
 * @param {string} raw
 * @param {string} header
 * @returns {number} index of the `[`, or -1
 */
function findHeader(raw, header) {
  // Match `[mcp_servers.<name>]` exactly (no subkey appended). Anchored to
  // the start of a line and must be followed by a newline or end-of-string.
  const re = new RegExp(
    `^${escapeRegex(header)}\\s*$`,
    "m",
  );
  const m = re.exec(raw);
  return m ? m.index : -1;
}

/**
 * Starting from `from`, return the index of the next top-level `[...]`
 * header, or raw.length if none.
 */
function findNextHeader(raw, from) {
  const re = /^\[[^\]]+\]/m;
  re.lastIndex = from;
  const slice = raw.slice(from);
  const m = re.exec(slice);
  return m ? from + m.index : raw.length;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// AGENTS.md sentinel-block helpers
// ---------------------------------------------------------------------------

/**
 * Upsert the Meko-managed AGENTS.md block fenced by sentinel comments.
 * Idempotent: a second call with the same version + name produces a
 * byte-identical file. Preserves user content outside the fence
 * byte-for-byte.
 *
 * Block-ownership contract (what `upsertAgentsMdBlock` writes and what
 * `removeAgentsMdBlock` is allowed to remove):
 *
 *   - The block we own is exactly `block + "\n"` — the start fence
 *     line, the body, the end fence line, and a single trailing "\n".
 *   - On fresh insert into non-empty content, the block is appended
 *     immediately after the user's existing bytes. We do NOT add a
 *     separator "\n" — markdown rendering survives just fine with the
 *     fence sitting on the line right after the user's last line, and
 *     the user's last newline (if present) belongs to them, not us.
 *   - For visual separation, callers can include `\n\n` at the START
 *     of the rendered block (we don't, to keep the block self-contained
 *     and removable byte-faithfully).
 *
 * `removeAgentsMdBlock` strips exactly the bytes we own (`block` plus
 * the trailing `"\n"` we wrote) and nothing else.
 *
 * Round-trip: a non-empty input ending in "\n" survives upsert → remove
 * unchanged. An input that does NOT end in "\n" gets a "\n" appended on
 * upsert (markdown best practice), which the round-trip cannot undo —
 * this is an explicit and documented exception.
 *
 * @param {string} filePath
 * @param {string} version
 * @param {{name?: string}} [opts]
 */
export function upsertAgentsMdBlock(filePath, version, opts = {}) {
  const name = opts.name ?? "meko";
  const block = renderAgentsMdBlock(version, name);
  const raw = safeReadFile(filePath) ?? "";
  const startIdx = raw.indexOf(AGENTS_MD_START);
  const endIdx = raw.indexOf(AGENTS_MD_END);
  if (startIdx === -1) {
    // Fresh insert. Append `block + "\n"` immediately after the user's
    // bytes. If the user's content does not end in "\n", insert one
    // first so our fence appears on its own line — that prepended "\n"
    // is treated as user content (markdown convention) and is NOT
    // removed by removeAgentsMdBlock.
    const userTerminator = raw.length > 0 && !raw.endsWith("\n") ? "\n" : "";
    writeWithBackup(filePath, raw + userTerminator + block + "\n");
    return;
  }
  if (endIdx === -1 || endIdx < startIdx) {
    // Malformed (start fence without matching end fence). Append a fresh
    // block; the orphan start fence is left in place for the user to
    // notice / clean up.
    const userTerminator = raw.length > 0 && !raw.endsWith("\n") ? "\n" : "";
    writeWithBackup(filePath, raw + userTerminator + block + "\n");
    return;
  }
  // In-place replacement: just swap the body between start and end fences.
  const next =
    raw.slice(0, startIdx) +
    block +
    raw.slice(endIdx + AGENTS_MD_END.length);
  if (next === raw) return;
  writeWithBackup(filePath, next);
}

/**
 * Strip the Meko-managed block from AGENTS.md content. Returns the next
 * content string. Removes only:
 *
 *   - The bytes from AGENTS_MD_START through AGENTS_MD_END (inclusive).
 *   - A single trailing "\n" immediately after the end fence (the
 *     newline upsert wrote to terminate the block).
 *
 * Bytes BEFORE the start fence are preserved exactly, so a user's
 * trailing newline survives byte-for-byte.
 *
 * @param {string} raw
 * @returns {string}
 */
export function removeAgentsMdBlock(raw) {
  const startIdx = raw.indexOf(AGENTS_MD_START);
  const endIdx = raw.indexOf(AGENTS_MD_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return raw;
  let cutEnd = endIdx + AGENTS_MD_END.length;
  if (raw[cutEnd] === "\n") cutEnd += 1;
  return raw.slice(0, startIdx) + raw.slice(cutEnd);
}

function renderAgentsMdBlock(version, name) {
  const toolPrefix = `mcp__${name}__`;
  return [
    `${AGENTS_MD_START} v${version}`,
    "## Meko memory (auto-managed by meko installer)",
    "",
    `You have a persistent memory store via the \`${name}\` MCP server. At the start of every conversation, call \`${toolPrefix}memory_search\` for relevant context. When the user shares facts, preferences, or decisions worth remembering, call \`${toolPrefix}memory_add\`. Skill details: ~/.agents/skills/meko-mcp-tools/SKILL.md`,
    "",
    "Cloud auth requires `MEKO_API_KEY` exported in your shell (or, for the desktop app on macOS, set via `launchctl setenv`).",
    AGENTS_MD_END,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Cloud auth helpers
// ---------------------------------------------------------------------------

function printCloudAuthInstructions({ shellRc, hasApp, platform, log }) {
  // Never echo the key value here — these instructions are advisory and may
  // be captured in terminal scrollback, screenshares, CI logs, etc. The
  // interactive rc-append / launchctl helpers receive the key directly when
  // the user opts in.
  log.warn?.(
    "Codex resolves MEKO_API_KEY from your runtime env. The key was NOT written to ~/.codex/config.toml.",
  );
  const flavor = shellRc ? rcFlavor(shellRc) : null;
  if (shellRc) {
    log.dim?.(`  Add to ${shellRc}:`);
    if (flavor === "fish") {
      log.dim?.(`    set -gx MEKO_API_KEY '<your-meko-api-key>'`);
    } else {
      log.dim?.(`    export MEKO_API_KEY='<your-meko-api-key>'`);
    }
  } else {
    log.dim?.("  Add to your shell rc:");
    log.dim?.(`    bash/zsh:  export MEKO_API_KEY='<your-meko-api-key>'`);
    log.dim?.(`    fish:      set -gx MEKO_API_KEY '<your-meko-api-key>'`);
  }
  log.dim?.(`  Then open a new terminal (or run "exec $SHELL" / "exec fish").`);
  if (hasApp && platform === "darwin") {
    log.warn?.(
      "macOS Codex.app launched from Finder/Dock does NOT inherit shell rc — set it via launchctl too:",
    );
    log.dim?.(
      `    launchctl setenv MEKO_API_KEY '<your-meko-api-key>'  # current login session`,
    );
    log.dim?.(
      "    (For permanence across reboots, add a ~/Library/LaunchAgents/com.meko.env.plist.)",
    );
  }
}

/**
 * Pick the right env-export syntax for the rc file we're writing to.
 * fish uses `set -gx`; everything else (zsh, bash, sh, ksh) uses
 * POSIX `export`. The detection key is the path: detectShellRc maps
 * fish to a `.../fish/config.fish` path, which is the only shell whose
 * rc file fish actually reads. (User-supplied paths flow through this
 * same check, so a user passing `~/.config/fish/config.fish` from any
 * shell still gets fish syntax.)
 *
 * @param {string} shellRc
 * @returns {"fish"|"posix"}
 */
function rcFlavor(shellRc) {
  return shellRc.endsWith(".fish") ? "fish" : "posix";
}

function buildExportLine(flavor, apiKey) {
  if (flavor === "fish") {
    // fish quoting is single-quote-only; no $-interpolation inside, and no
    // way to escape a single quote inside a single-quoted string. Disallow
    // single quotes outright rather than emit something that won't parse.
    if (String(apiKey).includes("'")) {
      throw new Error(
        "MEKO_API_KEY contains a single quote; cannot safely write to a fish rc.",
      );
    }
    return `set -gx MEKO_API_KEY '${apiKey}'`;
  }
  return `export MEKO_API_KEY=${shellQuote(apiKey)}`;
}

/**
 * Interactive: append a sentinel-fenced env-export block to the user's
 * shell rc. Picks `set -gx` for fish, POSIX `export` otherwise. Skipped
 * silently when shellRc is null. Idempotent: re-running a second time
 * finds the existing block and is a no-op.
 *
 * @returns {Promise<{appended: boolean, flavor?: "fish"|"posix"}>}
 */
export async function maybeOfferRcAppend({ apiKey, shellRc, promptUser, log }) {
  if (!shellRc) return { appended: false };
  const existing = safeReadFile(shellRc) ?? "";
  if (existing.includes(RC_FENCE_START)) {
    log?.dim?.(`  ${shellRc} already contains a meko-mcp block; skipping.`);
    return { appended: false };
  }
  const flavor = rcFlavor(shellRc);
  const exportLine = buildExportLine(flavor, apiKey);
  const promptVerb = flavor === "fish" ? "set -gx" : "export";
  const accept = await promptUser(
    `Append "${promptVerb} MEKO_API_KEY ..." to ${shellRc}?`,
    false,
  );
  if (!accept) return { appended: false };
  const block = [
    "",
    RC_FENCE_START,
    exportLine,
    RC_FENCE_END,
    "",
  ].join("\n");
  mkdirSync(dirname(shellRc), { recursive: true });
  appendFileSync(shellRc, block, "utf8");
  log?.dim?.(`  Appended meko block to ${shellRc}.`);
  return { appended: true, flavor };
}

/**
 * Interactive: run `launchctl setenv MEKO_API_KEY <key>` so the macOS
 * Codex.app (launched from Finder/Dock) sees the env var for the current
 * login session.
 *
 * @returns {Promise<{set: boolean}>}
 */
export async function maybeOfferLaunchctlSetenv({
  apiKey,
  promptUser,
  runCommand,
  log,
}) {
  const accept = await promptUser(
    "Run `launchctl setenv MEKO_API_KEY ...` so Codex.app sees the key now?",
    false,
  );
  if (!accept) return { set: false };
  return setLaunchctlMekoApiKey({ apiKey, runCommand, log });
}

/**
 * Run `launchctl setenv MEKO_API_KEY <key>` so the macOS Codex.app launched
 * from Finder/Dock can authenticate during the current login session.
 *
 * The key is passed to launchctl but never logged.
 *
 * @returns {{set: boolean}}
 */
export function setLaunchctlMekoApiKey({ apiKey, runCommand, log }) {
  try {
    runCommand(`launchctl setenv MEKO_API_KEY ${shellQuote(apiKey)}`);
    log?.dim?.("  Set MEKO_API_KEY via launchctl (current login session).");
    return { set: true };
  } catch (err) {
    log?.warn?.("  launchctl setenv failed; run it manually if Codex.app needs cloud auth.");
    return { set: false };
  }
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

function safeReadFile(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * True when `destination` is a symlink that resolves to `expectedSource`.
 * Used to recognize in-place symlink installs on re-run / uninstall.
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

function writeWithBackup(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    try {
      copyFileSync(path, path + ".bak");
    } catch {
      // best-effort
    }
  }
  writeFileSync(path, content, "utf8");
}

// re-export for tests / outside use of the resolved-source helper
export const __TEST__ = {
  RC_FENCE_START,
  RC_FENCE_END,
  AGENTS_MD_START,
  AGENTS_MD_END,
  defaultDetectShellRc,
  buildCliRegisterCommand,
  ensureCodexHttpHeaderUserAgent,
  readCodexHttpHeaders,
  findHttpHeadersSubtable,
  parseTomlKvPairs,
  isLocalUrl,
  CODEX_MCP_USER_AGENT,
};
