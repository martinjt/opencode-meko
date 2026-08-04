import { chmodSync, copyFileSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { askYesNo } from "../prompt.mjs";
import {
  getClaudeCodeSettingsPath,
  mergeAllowList,
  mergeSettings,
  readJsonFile,
  removeFromAllowList,
  removeKeys,
  writeJsonFile,
} from "../config.mjs";
import { detectClaude, detectExistingMeko, getClaudeCodeConfigPath } from "../detect.mjs";
import {
  MEKO_MCP_USER_AGENT,
  redactKey,
  resolveHooksRoot,
  resolveStatuslineSource,
  run,
  shellQuote,
  writeInstallerMarker,
} from "./common.mjs";

const CLAUDE_INSTALL_URL =
  "https://docs.anthropic.com/en/docs/claude-code/getting-started";

// Filenames of the Meko-owned hook scripts. The meko-agent-skills plugin
// registers these at runtime via ${CLAUDE_PLUGIN_ROOT} (skills/hooks/hooks.json),
// so any entry still present in ~/.claude/settings.json that references one of
// these filenames is stale — either a pre-plugin absolute-path install that
// accumulated across install locations (issue #60), or a legacy env-prefixed
// command rewritten from MEKO-20. pruneMekoHookEntries uses this list to
// identify and remove those stale entries.
const MEKO_HOOK_SCRIPTS = ["session-start.sh", "pre-compact.sh", "session-end.sh"];

// Qualified `plugin@marketplace` form. CLI 2.1.x's `plugin update` and
// `plugin uninstall` require this exact shape — the bare name fails with
// `Plugin "meko-agent-skills" not found` even when the plugin is installed
// (issues #59 / #63). `plugin install` fuzzy-resolves the bare name but we
// keep the shape consistent so every call site agrees. The marketplace happens
// to share the plugin's name (see extraKnownMarketplaces in settings.json).
const MEKO_PLUGIN_REF = "meko-agent-skills@meko-agent-skills";
const MEKO_MARKETPLACE_NAME = "meko-agent-skills";

// Meko MCP tools to union into `permissions.allow` so Claude Code resolves
// them without the deferred-tools ToolSearch round-trip (issue #5). The set
// is intentionally tight — the memory/conversation tools the agent actually
// reaches for per the meko-mcp-tools skill — to avoid bloating every user's
// settings.
//
// `memory_add` stays on this list even though the skill no longer tells the
// agent to fire it proactively (server-side extraction now captures
// conversationally-stated facts automatically). It's kept because the skill
// still uses memory_add for the narrow explicit-save cases — "remember this",
// output-only/tool-derived facts, and overwriting corrections — and pre-
// allowing it keeps those calls prompt-free. `conversation_add_message` is the
// tool that now drives capture-plus-extraction, so it must resolve instantly.
//
// NOTE: `permissions.allow` is verified to cover user-prompt bypass. Whether
// it also bypasses the deferred-tools schema-fetch gate must be re-verified
// empirically before this flag is considered load-bearing for #5. Tracked
// as Phase 10.1 in skills/TEST_PLAN.md.
const MEKO_ALWAYS_AVAILABLE_TOOLS = [
  "mcp__meko__memory_add",
  "mcp__meko__memory_search",
  "mcp__meko__memory_get_all",
  "mcp__meko__memory_get_by_id",
  "mcp__meko__memory_update",
  "mcp__meko__memory_delete_by_id",
  "mcp__meko__conversation_create",
  "mcp__meko__conversation_add_message",
];

/**
 * @param {{
 *   getSettingsPath?: () => string,
 *   getConfigPath?: () => string,
 *   getMekoCaptureDir?: () => string,
 *   runCommand?: (cmd: string) => string,
 * }} [options]
 * @returns {object}
 */
export function createClaudeCodeAdapter(options = {}) {
  const resolveSettingsPath = options.getSettingsPath ?? getClaudeCodeSettingsPath;
  const resolveConfigPath = options.getConfigPath ?? getClaudeCodeConfigPath;
  const resolveMekoCaptureDir =
    options.getMekoCaptureDir ??
    (() => join(homedir(), ".claude", "meko-capture"));
  // DI hook: tests substitute a fake shell so installSkills() branching
  // (probe -> update vs install, fallback on old CLIs) is verifiable
  // without invoking a real `claude` binary.
  const runCommand = options.runCommand ?? run;

  return {
    id: "claude-code",
    displayName: "Claude Code",
    settingsPath(scope, projectRoot) { // eslint-disable-line no-unused-vars
      return resolveSettingsPath();
    },
    async detectPrerequisites({ verbose, log }) {
      const claude = detectClaude();
      if (!claude.found) {
        throw new Error(
          `Claude Code CLI not found.\nInstall it first: ${CLAUDE_INSTALL_URL}`,
        );
      }
      if (verbose) {
        log.dim(`  Claude CLI: ${claude.path} (${claude.version})`);
      }
    },
    /** Is Claude Code actually installed on this machine? */
    isInstalled() {
      return detectClaude().found;
    },
    detectExisting(name, { scope = "user", projectRoot } = {}) {
      return detectExistingMeko(name, { scope, projectRoot });
    },
    removeRegistration(name, { scope = "user" } = {}) {
      runCommand(`claude mcp remove --scope ${shellQuote(scope)} ${shellQuote(name)}`);
    },
    registerServer({ name, url, scope, apiKey, dryRun, verbose, log }) {
      const cmd = this.buildRegisterCommand({ name, url, scope, apiKey });
      if (dryRun) {
        log.dim(`  Would run: ${this.buildRegisterDisplayCommand({ name, url, scope, apiKey })}`);
        return;
      }
      const output = this.runRegisterCommand(cmd);
      if (verbose && output) {
        const safeOutput = apiKey ? output.replaceAll(apiKey, "<REDACTED>") : output;
        log.dim(`  ${safeOutput}`);
      }
    },
    buildRegisterCommand({ name, url, scope, apiKey }) {
      let cmd =
        `claude mcp add --transport http --scope ${shellQuote(scope)} ` +
        `${shellQuote(name)} ${shellQuote(url)} ` +
        `--header ${shellQuote(`User-Agent: ${MEKO_MCP_USER_AGENT}`)}`;
      if (apiKey) {
        cmd += ` --header ${shellQuote(`Authorization: Bearer ${apiKey}`)}`;
      }
      return cmd;
    },
    buildRegisterDisplayCommand({ name, url, scope, apiKey }) {
      return this.buildRegisterCommand({
        name,
        url,
        scope,
        apiKey: apiKey ? redactKey(apiKey) : null,
      });
    },
    runRegisterCommand(cmd) {
      return run(cmd);
    },
    async maybeConfirmOverwrite({ existingFound, name, yes }) {
      if (!existingFound) return true;
      if (yes) return true;
      return askYesNo(
        `${name} MCP is already configured. Overwrite?`,
        false,
      );
    },
    setHookEnvironment({ url, apiKey, dryRun, verbose, log, settingsPath }) {
      const envPatch = { env: { MEKO_MCP_URL: url } };
      if (apiKey) envPatch.env.MEKO_API_KEY = apiKey;

      if (dryRun) {
        log.dim(`  Would set in ${settingsPath}:`);
        log.dim(`    MEKO_MCP_URL = ${url}`);
        if (apiKey) {
          log.dim(`    MEKO_API_KEY = ${redactKey(apiKey)}`);
        }
        log.dim(
          `  Would union ${MEKO_ALWAYS_AVAILABLE_TOOLS.length} Meko tools into permissions.allow`,
        );
        return;
      }

      mergeSettings(settingsPath, envPatch);
      mergeAllowList(settingsPath, "permissions.allow", MEKO_ALWAYS_AVAILABLE_TOOLS);
      const pruned = pruneMekoHookEntries(settingsPath);
      if (pruned) {
        // The prune removed at least one stale Meko hook entry. On the common
        // path these were frozen capture.js copies from prior install roots
        // (issue #60). On the edge case where Cursor claude-compat installed
        // from a DIFFERENT root than this Claude Code install, those Cursor
        // entries are indistinguishable from stale Claude Code entries and
        // were also removed — warn the user so they can re-run the Cursor
        // installer if they notice Cursor hooks missing.
        log.warn(
          "Removed stale Meko hook entries from settings.json. If you use Cursor claude-compat from a different install path, re-run the Cursor installer to restore its hooks.",
        );
      }

      // Drop an installer-version marker in the meko-capture watermark dir so
      // future installer runs can tell which version last touched this
      // machine. This is purely for diagnostics / future upgrade logic —
      // capture.js itself ignores the marker.
      const mekoCaptureDir = resolveMekoCaptureDir();
      try {
        mkdirSync(mekoCaptureDir, { recursive: true });
        writeInstallerMarker(mekoCaptureDir);
      } catch (err) {
        if (verbose) {
          log.dim(`  Could not write meko-capture marker: ${err.message}`);
        }
      }

      if (verbose) {
        log.dim(`  Updated ${settingsPath}`);
        log.dim(`    MEKO_MCP_URL = ${url}`);
        if (apiKey) {
          log.dim(`    MEKO_API_KEY = ${redactKey(apiKey)}`);
        }
        log.dim(
          `    permissions.allow += ${MEKO_ALWAYS_AVAILABLE_TOOLS.length} Meko tools`,
        );
      }
    },
    /**
     * Wire the Meko datapack-pin statusline contribution into ~/.claude/settings.json.
     *
     * Composable: if the user already has a `statusLine.command`, that command
     * is preserved as the inner command and our wrapper appends `Meko: <name>`
     * after its output. Idempotent: if our wrapper is already wired, no-op.
     *
     * Restore-on-uninstall: the original command is preserved in
     * settings.json under `_meko.statusLine.previousCommand` so `uninstall()`
     * can restore it. Absent that key (fresh install), uninstall removes the
     * whole `statusLine` block.
     */
    installStatusline({ dryRun, verbose, log, settingsPath }) {
      const scriptSource = resolveStatuslineSource();
      const scriptDest = join(homedir(), ".claude", "meko-statusline.sh");

      const existing = readJsonFile(settingsPath) ?? {};
      const existingCmd =
        existing?.statusLine?.type === "command" && typeof existing?.statusLine?.command === "string"
          ? existing.statusLine.command.trim()
          : "";

      // Detect prior install of our wrapper. Re-wiring is a no-op for the
      // command (already points at the wrapper); we still re-copy the script
      // so a refreshed installer ships an updated copy.
      const alreadyWired = existingCmd.includes("meko-statusline.sh");
      const innerCmd =
        alreadyWired
          ? (existing?._meko?.statusLine?.previousCommand ?? "")
          : existingCmd;

      const wrapperCmd = innerCmd
        ? `${shellQuote(scriptDest)} --inner-cmd ${shellQuote(innerCmd)}`
        : shellQuote(scriptDest);

      if (dryRun) {
        log.dim(`  Would copy ${scriptSource} → ${scriptDest}`);
        log.dim(`  Would set ${settingsPath} statusLine.command = ${wrapperCmd}`);
        if (innerCmd) log.dim(`    (preserving prior inner command: ${innerCmd})`);
        return;
      }

      mkdirSync(join(homedir(), ".claude"), { recursive: true });
      copyFileSync(scriptSource, scriptDest);
      chmodSync(scriptDest, 0o755);

      const patch = {
        statusLine: { type: "command", command: wrapperCmd },
      };
      // Stash the inner command so uninstall can restore it. Only write this
      // namespace on the first install (when alreadyWired is false), so a
      // re-install never overwrites the genuine original with our wrapper.
      if (!alreadyWired) {
        patch._meko = { statusLine: { previousCommand: innerCmd || null } };
      }
      mergeSettings(settingsPath, patch);

      if (verbose) {
        log.dim(`  Statusline script: ${scriptDest}`);
        log.dim(`  Wrapper command: ${wrapperCmd}`);
        if (innerCmd) log.dim(`  Inner command preserved: ${innerCmd}`);
        if (alreadyWired) log.dim(`  (refreshed existing wrapper, no settings change beyond script copy)`);
      }
    },
    installSkills({ scope, dryRun, verbose, log }) {
      // NB: we deliberately do NOT pass --sparse. Claude CLI's sparse
      // path filter silently produces an empty clone for our layout,
      // leaving the marketplace.json missing. Full clone is small
      // (~few MB, mostly markdown) and is the only way that reliably
      // succeeds today.
      // Marketplace source is normally the public generated skills repo. Use
      // an explicit HTTPS URL: GitHub's owner/repo shorthand makes Claude Code
      // clone over SSH, which fails for users without GitHub SSH credentials.
      // A dev/e2e
      // override lets a test install the plugin from a LOCAL working-tree
      // checkout (a directory path) so unreleased skill changes can be
      // exercised end-to-end before they are published to `yugabyte/meko-skills`.
      // Only set MEKO_PLUGIN_MARKETPLACE_SOURCE in tests.
      const marketplaceSource =
        process.env.MEKO_PLUGIN_MARKETPLACE_SOURCE
        || "https://github.com/yugabyte/meko-skills.git";
      const marketplaceCmd =
        `claude plugin marketplace add ${shellQuote(marketplaceSource)} --scope ${shellQuote(scope)}`;
      // `claude plugin list` dropped --scope in CLI 2.1.x; it prints all
      // scopes. The match-by-token regex used below is scope-agnostic by
      // design — `plugin update` failing with "not found" on a
      // different-scope install is handled in the fallback chain.
      const listCmd = `claude plugin list`;
      // Qualified `plugin@marketplace` form — see MEKO_PLUGIN_REF comment
      // at the top of this file.
      const installCmd = `claude plugin install ${MEKO_PLUGIN_REF} --scope ${scope}`;
      const updateCmd = `claude plugin update ${MEKO_PLUGIN_REF} --scope ${scope}`;
      const uninstallCmd = `claude plugin uninstall ${MEKO_PLUGIN_REF} --scope ${scope}`;

      if (dryRun) {
        log.dim(`  Would run: ${marketplaceCmd}`);
        log.dim(`  Would run: ${listCmd}`);
        log.dim(`  Would run: ${updateCmd} (if already installed)`);
        log.dim(`  Would run: ${installCmd} (if not yet installed)`);
        return { marketplace: "dry-run", skills: "dry-run" };
      }

      let marketplaceStatus = "ok";
      try {
        const output = runCommand(marketplaceCmd);
        if (verbose && output) log.dim(`  ${output}`);
      } catch (err) {
        const msg = err.stderr || err.message || "";
        if (msg.includes("already") || msg.includes("exists")) {
          marketplaceStatus = "already";
        } else {
          marketplaceStatus = "error";
          log.warn("Marketplace install skipped (non-critical).");
          log.dim(msg.trim());
        }
      }

      // Probe for an existing install so we can call `plugin update` instead
      // of `plugin install` (the latter no-ops on newer Claude CLIs when the
      // plugin is already present — which means users running
      // `npx @yugabytedb/meko-mcp@latest` never pull updated skill content).
      let alreadyInstalled = false;
      try {
        const listOutput = runCommand(listCmd);
        if (verbose && listOutput) log.dim(`  ${listOutput}`);
        // Match only when "meko-agent-skills" appears as a standalone token.
        // Leading anchor (^|\s) prevents false positives on substrings like
        // `not-meko-agent-skills`. Trailing anchor accepts whitespace, EOL,
        // or `@` — CLI 2.1.x formats plugins as `name@marketplace`, so the
        // plugin appears as `meko-agent-skills@meko-agent-skills` in the
        // probe output. `\b` is too loose because `-` counts as a word
        // boundary, so `\bmeko-agent-skills\b` would match inside
        // `not-meko-agent-skills`.
        //
        // This is deliberately scope-agnostic — `plugin list` prints all
        // scopes. If the plugin exists at a scope other than the one we're
        // installing into, `plugin update --scope ${scope}` will fail with
        // "Plugin not found" and the `not found` branch in the update
        // catch-block below falls through to `plugin install`.
        alreadyInstalled = /(^|\s)meko-agent-skills(\s|@|$)/m.test(listOutput);
      } catch (err) {
        // If the probe fails we fall through to `plugin install`, which is
        // the original behavior — safer than assuming a state we can't see.
        const msg = err.stderr || err.message || "";
        if (verbose) log.dim(`  plugin list probe failed: ${msg.trim()}`);
      }

      let skillStatus = "ok";
      if (alreadyInstalled) {
        try {
          const output = runCommand(updateCmd);
          if (verbose && output) log.dim(`  ${output}`);
          log.dim("  Updated meko-agent-skills plugin");
        } catch (err) {
          const msg = err.stderr || err.message || "";
          // Older Claude CLIs don't know `plugin update`. The exact wording
          // varies (`unknown command`, `unrecognized option`, `invalid`,
          // `command not found`) so we match a family of signals and fall
          // back to uninstall + install, which achieves the same refresh.
          if (
            msg.includes("unknown command") ||
            msg.includes("unrecognized") ||
            msg.includes("invalid command") ||
            msg.includes("command not found") ||
            msg.includes("Unknown subcommand")
          ) {
            log.warn("  claude plugin update not supported — falling back to uninstall + install");
            try {
              const unOutput = runCommand(uninstallCmd);
              if (verbose && unOutput) log.dim(`  ${unOutput}`);
            } catch (unErr) {
              if (verbose) {
                const unMsg = unErr.stderr || unErr.message || "";
                log.dim(`  plugin uninstall (fallback) failed: ${unMsg.trim()}`);
              }
            }
            try {
              const inOutput = runCommand(installCmd);
              if (verbose && inOutput) log.dim(`  ${inOutput}`);
              log.dim("  Installed meko-agent-skills plugin");
            } catch (inErr) {
              const inMsg = inErr.stderr || inErr.message || "";
              skillStatus = "error";
              log.warn("Skills plugin install skipped (non-critical).");
              log.dim(inMsg.trim());
            }
          } else if (msg.includes("not found")) {
            // `plugin list` matched the plugin at some scope, but
            // `plugin update --scope ${scope}` can't see it — the install
            // lives at a different scope. Fall through to `plugin install`
            // at the requested scope, which is what the user actually
            // asked for. (Also covers rare probe false-positives where
            // the regex matched but the plugin isn't really installed
            // anywhere visible to update.)
            log.dim(`  plugin update reports not found at scope ${scope} — installing instead`);
            try {
              const inOutput = runCommand(installCmd);
              if (verbose && inOutput) log.dim(`  ${inOutput}`);
              log.dim("  Installed meko-agent-skills plugin");
            } catch (inErr) {
              const inMsg = inErr.stderr || inErr.message || "";
              if (inMsg.includes("already") || inMsg.includes("installed")) {
                skillStatus = "already";
              } else {
                skillStatus = "error";
                log.warn("Skills plugin install skipped (non-critical).");
                log.dim(inMsg.trim());
              }
            }
          } else {
            skillStatus = "error";
            log.warn("Skills plugin update skipped (non-critical).");
            log.dim(msg.trim());
          }
        }
      } else {
        try {
          const output = runCommand(installCmd);
          if (verbose && output) log.dim(`  ${output}`);
          log.dim("  Installed meko-agent-skills plugin");
        } catch (err) {
          const msg = err.stderr || err.message || "";
          if (msg.includes("already") || msg.includes("installed")) {
            skillStatus = "already";
          } else {
            skillStatus = "error";
            log.warn("Skills plugin install skipped (non-critical).");
            log.dim(msg.trim());
          }
        }
      }

      return { marketplace: marketplaceStatus, skills: skillStatus };
    },
    uninstall({ name, scope = "user", settingsPath }) {
      const results = [];
      try {
        // Route through runCommand (DI) so unit tests that stub the shell
        // don't accidentally invoke the real `claude mcp remove` against
        // the developer's or CI runner's own config.
        runCommand(`claude mcp remove ${name}`);
        results.push({ key: "mcp", ok: true, message: `MCP server "${name}" removed.` });
      } catch {
        results.push({ key: "mcp", ok: false, message: `MCP server "${name}" was not registered (nothing to remove).` });
      }

      try {
        removeKeys(settingsPath, ["env.MEKO_MCP_URL", "env.MEKO_API_KEY"]);
        removeFromAllowList(settingsPath, "permissions.allow", MEKO_ALWAYS_AVAILABLE_TOOLS);
        results.push({ key: "env", ok: true, message: "Environment variables and Meko allowlist removed from settings." });
      } catch (err) {
        results.push({ key: "env", ok: false, message: `Could not update settings: ${err.message}` });
      }

      try {
        pruneMekoHookEntries(settingsPath);
        results.push({ key: "hooks", ok: true, message: "Stale Meko hook entries pruned from settings." });
      } catch (err) {
        results.push({ key: "hooks", ok: false, message: `Could not prune Meko hook entries: ${err.message}` });
      }

      try {
        // Restore the user's prior statusLine.command (if any) and remove our
        // bookkeeping. If no prior command was preserved, remove the whole
        // statusLine block — installStatusline() only added it on first
        // install, so we own it cleanly.
        const cfg = readJsonFile(settingsPath) ?? {};
        const wrapperWired =
          cfg?.statusLine?.type === "command" &&
          typeof cfg?.statusLine?.command === "string" &&
          cfg.statusLine.command.includes("meko-statusline.sh");
        if (wrapperWired) {
          const prev = cfg?._meko?.statusLine?.previousCommand;
          if (typeof prev === "string" && prev.length > 0) {
            cfg.statusLine = { type: "command", command: prev };
            results.push({ key: "statusline", ok: true, message: "Restored prior statusLine.command." });
          } else {
            delete cfg.statusLine;
            results.push({ key: "statusline", ok: true, message: "Removed Meko statusLine wrapper." });
          }
          if (cfg?._meko?.statusLine) {
            delete cfg._meko.statusLine;
            if (cfg._meko && Object.keys(cfg._meko).length === 0) delete cfg._meko;
          }
          writeJsonFile(settingsPath, cfg);
          // Remove the copied script too — installStatusline() owns it, so
          // leaving it behind would be a stale orphan after uninstall.
          try {
            unlinkSync(join(homedir(), ".claude", "meko-statusline.sh"));
          } catch {
            // Best-effort: absent file (ENOENT) or unreadable dir is fine.
          }
        } else {
          results.push({ key: "statusline", ok: false, message: "Statusline wrapper was not installed (nothing to remove)." });
        }
      } catch (err) {
        results.push({ key: "statusline", ok: false, message: `Could not restore statusLine: ${err.message}` });
      }

      try {
        // Qualified plugin@marketplace form — CLI 2.1.x rejects the bare
        // name (issue #63). Before: `catch` swallowed every failure as
        // "not installed", so a CLI shape mismatch reported success while
        // the plugin stayed registered. Distinguish real "not installed"
        // from other errors by inspecting stderr (case-insensitive, since
        // wording varies across CLI versions).
        //
        // Scope must match the installSkills() call site — a project-scope
        // install is invisible to a user-scope uninstall on CLI 2.1.x, so
        // without --scope the plugin stays registered after `--uninstall`.
        runCommand(`claude plugin uninstall ${MEKO_PLUGIN_REF} --scope ${scope}`);
        results.push({ key: "skills", ok: true, message: "Skills plugin removed." });
      } catch (err) {
        const msg = err.stderr || err.message || "";
        const lower = msg.toLowerCase();
        if (lower.includes("not found") || lower.includes("not installed")) {
          results.push({ key: "skills", ok: false, message: "Skills plugin was not installed (nothing to remove)." });
        } else {
          results.push({ key: "skills", ok: false, message: `Skills plugin uninstall failed: ${msg.trim()}` });
        }
      }

      try {
        runCommand(`claude plugin marketplace remove ${MEKO_MARKETPLACE_NAME}`);
        results.push({ key: "marketplace", ok: true, message: "Plugin marketplace entry removed." });
      } catch (err) {
        // Mirror the skills-uninstall treatment: a legitimate "never
        // registered" state is different from a CLI shape mismatch or a
        // missing binary. Without this, a broken CLI contract looks
        // identical to success.
        const msg = err.stderr || err.message || "";
        const lower = msg.toLowerCase();
        if (lower.includes("not found") || lower.includes("not registered") || lower.includes("not installed")) {
          results.push({ key: "marketplace", ok: false, message: "Plugin marketplace entry was not registered (nothing to remove)." });
        } else {
          results.push({ key: "marketplace", ok: false, message: `Plugin marketplace remove failed: ${msg.trim()}` });
        }
      }

      return results;
    },
    async validateConfig({ serverName, scope = "user", projectRoot, url, apiKey }) {
      const configPath = resolveConfigPath();
      let cfg;
      try {
        cfg = readJsonFile(configPath);
      } catch (err) {
        return { ok: false, message: `Could not read ${configPath}: ${err.message}` };
      }
      const entry =
        scope === "project"
          ? cfg?.projects?.[projectRoot]?.mcpServers?.[serverName]
          : cfg?.mcpServers?.[serverName];

      if (!entry) {
        return { ok: false, message: `Server "${serverName}" not found in ${configPath}.` };
      }

      if (url && entry.url !== url) {
        return {
          ok: false,
          message: `Server "${serverName}" in ${configPath} still points at ${entry.url ?? "<missing url>"}.`,
        };
      }

      const authHeader = getHeader(entry.headers, "Authorization");
      const userAgent = getHeader(entry.headers, "User-Agent");
      if (!userAgent) {
        return {
          ok: false,
          message: `Server "${serverName}" in ${configPath} is missing the User-Agent header required by the Cloud WAF.`,
        };
      }
      if (apiKey) {
        const expected = `Bearer ${apiKey}`;
        if (authHeader !== expected) {
          return {
            ok: false,
            message: `Server "${serverName}" in ${configPath} does not contain the current Authorization header.`,
          };
        }
      } else if (authHeader) {
        return {
          ok: false,
          message: `Server "${serverName}" in ${configPath} still contains an Authorization header.`,
        };
      }

      return { ok: true, message: `Server "${serverName}" is registered in ${configPath}.` };
    },
  };
}

/**
 * Remove stale Meko hook entries from a Claude Code settings.json —
 * keeping any entry that points at the CURRENT install's hooks root.
 *
 * The meko-agent-skills plugin registers hooks at runtime via
 * ${CLAUDE_PLUGIN_ROOT} (skills/hooks/hooks.json), so a Meko entry in
 * settings.json.hooks.* pointing at SOME OTHER install path is a
 * pre-plugin absolute-path entry left over from a prior install location
 * (issue #60) or a legacy env-prefixed command (MEKO-20). Those fire
 * frozen copies of capture.js on every session event and throw against
 * the current contract.
 *
 * Cursor's claude-compat mode (cursor.mjs installClaudeCompatHooks)
 * shares this file on scope=user and writes entries in exactly the same
 * shape as stale Claude Code entries — both are absolute-path
 * `bash "<hooks-handlers-root>/<script>"` commands. There's no
 * schema-safe signal in the command string that distinguishes the two,
 * so prune uses the current install root as a best-effort exemption:
 *
 * GUARANTEE (narrow): a Cursor claude-compat entry SURVIVES when its
 * command references the SAME resolveHooksRoot() this Claude Code
 * install resolved to. Cursor installed from the same path (e.g. both
 * via homebrew, or both from the same repo clone) will keep its hooks.
 *
 * KNOWN TRADE-OFF (issue #60 comment thread): a Cursor claude-compat
 * entry written from a DIFFERENT install root (e.g. Cursor installed
 * from the repo clone, Claude Code installed from npx cache) WILL be
 * pruned — it's indistinguishable from the stale-Claude-Code entries
 * that issue #60 is about. Callers should warn the user, and users
 * recover by re-running the Cursor installer.
 *
 * Match rule for pruning: command is a string that contains BOTH
 * `hooks-handlers/` AND one of MEKO_HOOK_SCRIPTS, AND the command does
 * NOT contain the current install's hooks root path. The `hooks-handlers/`
 * fence keeps unrelated user scripts that happen to share a filename
 * (e.g. their own `session-start.sh`) from being pruned.
 *
 * Prunes empty group.hooks arrays, empty groups, empty event arrays, and
 * deletes cfg.hooks entirely when it ends up empty — so an untouched file
 * stays byte-identical. Only writes when something actually changed.
 *
 * @param {string} settingsPath
 * @returns {boolean} true iff the file was rewritten
 */
export function pruneMekoHookEntries(settingsPath) {
  const cfg = readJsonFile(settingsPath);
  if (!cfg?.hooks || typeof cfg.hooks !== "object") return false;

  const currentHooksRoot = resolveHooksRoot();

  const isStaleMekoHookCommand = (cmd) =>
    typeof cmd === "string"
    && cmd.includes("hooks-handlers/")
    && MEKO_HOOK_SCRIPTS.some((s) => cmd.includes(s))
    && !cmd.includes(currentHooksRoot);

  // Only cascade empty-array cleanup on events where we actually removed a
  // Meko entry — otherwise a user's pre-existing empty hook array unrelated
  // to Meko (e.g. { hooks: { Notification: [] } }) would get silently
  // collapsed and trigger a file rewrite, breaking the "untouched file
  // stays byte-identical" guarantee.
  let changed = false;
  for (const event of Object.keys(cfg.hooks)) {
    const eventArr = cfg.hooks[event];
    if (!Array.isArray(eventArr)) continue;

    let eventChanged = false;
    for (const group of eventArr) {
      if (!Array.isArray(group?.hooks)) continue;
      const before = group.hooks.length;
      group.hooks = group.hooks.filter((h) => !isStaleMekoHookCommand(h?.command));
      if (group.hooks.length !== before) eventChanged = true;
    }
    if (!eventChanged) continue;

    const prunedEventArr = eventArr.filter(
      (group) => Array.isArray(group?.hooks) && group.hooks.length > 0,
    );
    if (prunedEventArr.length !== eventArr.length) {
      cfg.hooks[event] = prunedEventArr;
    }

    if (cfg.hooks[event].length === 0) {
      delete cfg.hooks[event];
    }
    changed = true;
  }

  if (changed && Object.keys(cfg.hooks).length === 0) {
    delete cfg.hooks;
  }

  if (changed) writeJsonFile(settingsPath, cfg);
  return changed;
}

function getHeader(headers, name) {
  if (!headers || typeof headers !== "object") return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}
