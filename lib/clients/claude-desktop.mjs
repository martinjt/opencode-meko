import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  getClaudeDesktopConfigPath,
  mergeSettings,
  readJsonFile,
  removeKeys,
} from "../config.mjs";
import {
  MEKO_MCP_USER_AGENT,
  getAssetRoot,
  getInstallerVersion,
  markerIsStale,
  readInstallerMarker,
  run,
  writeInstallerMarker,
} from "./common.mjs";

/**
 * Claude Desktop adapter.
 *
 * User-scope only. Writes to claude_desktop_config.json via mergeSettings so
 * existing mcpServers entries (and unrelated preferences) are preserved and a
 * .bak backup is left behind on every write.
 *
 * Claude Desktop does not load MCP servers via HTTP directly — its loader only
 * spawns stdio subprocesses. We wrap the HTTP URL with the `mcp-remote` stdio
 * bridge so Desktop treats it as a normal stdio server:
 *
 *   "meko": {
 *     "command": "npx",
 *     "args": ["-y", "mcp-remote", "<url>", "--transport", "http-only",
 *              "--header", "User-Agent:meko-mcp-installer/1.0 (...)",
 *              "--header", "Authorization:Bearer ${MEKO_API_KEY}"],
 *     "env": { "MEKO_API_KEY": "<key>" }
 *   }
 *
 * The header uses the `${ENV_VAR}` interpolation form (documented by
 * mcp-remote) with no space around the colon after the header name —
 * some clients mis-parse space-containing `--header` args.
 *
 * installSkills() runs scripts/package-desktop-skill.sh under the resolved
 * asset root to build the .skill bundle and prints import instructions.
 * Desktop has no programmatic skill install API — the user drags the .skill
 * into the app. The asset root is `installer/assets/` for packaged installs
 * (npx) and `<repo>/skills/` for source checkouts; both layouts share the
 * same shape so the script can be invoked the same way.
 */
export function createClaudeDesktopAdapter(options = {}) {
  const configPathResolver = options.getConfigPath ?? getClaudeDesktopConfigPath;
  const assetRootResolver = options.getAssetRoot ?? getAssetRoot;
  const packageRunner = options.runPackageScript ?? defaultRunPackageScript;
  const npxProber = options.probeNpx ?? defaultProbeNpx;

  return {
    id: "claude-desktop",
    displayName: "Claude Desktop",
    settingsPath() {
      return configPathResolver();
    },
    async detectPrerequisites({ log, verbose } = {}) {
      const npx = npxProber();
      if (!npx.found) {
        throw new Error(
          "npx (from Node.js) is required so Claude Desktop can launch the " +
            "mcp-remote stdio bridge. Install Node.js 18+ (which includes npx) " +
            "and re-run the installer.",
        );
      }
      if (verbose && log?.dim) {
        log.dim(`  npx: ${npx.path}${npx.version ? ` (${npx.version})` : ""}`);
      }
    },
    /**
     * Is Claude Desktop actually installed? The app creates its config
     * directory on first launch, so the presence of that directory is a
     * strong signal the app has been run at least once on this machine.
     * (A user who installed the app but never opened it would produce a
     * false negative — acceptable; they'd pass --client explicitly.)
     */
    isInstalled() {
      return existsSync(dirname(configPathResolver()));
    },
    detectExisting(name) {
      const cfg = readJsonFile(configPathResolver());
      const entry = cfg?.mcpServers?.[name];
      if (!entry) {
        return { found: false, status: "" };
      }
      // If the existing entry's launcher path looks like a .mcpb extension
      // install, surface that in the status so the installer prompts more
      // loudly before overwriting — users who installed via Settings >
      // Extensions usually don't expect `create-meko-setup` to touch the
      // same config.
      const argsJoined = Array.isArray(entry.args) ? entry.args.join(" ") : "";
      const commandJoined = (entry.command || "") + " " + argsJoined;
      const fromMcpb =
        /\bClaude\b[^ ]*\bExtensions\b/i.test(commandJoined) ||
        /mcp-remote-launcher\.js/.test(commandJoined);
      const url = getMcpRemoteEntryUrl(entry);
      return {
        found: true,
        status: fromMcpb ? "Configured (via .mcpb extension)" : "Configured",
        ...(url ? { url } : {}),
      };
    },
    removeRegistration(name) {
      removeKeys(configPathResolver(), [`mcpServers.${name}`]);
    },
    registerServer({ name, url, apiKey, dryRun, log }) {
      const path = configPathResolver();
      const server = buildMcpRemoteEntry({ url, apiKey });

      if (dryRun) {
        log.dim(`  Would update ${path}:`);
        log.dim(`    mcpServers.${name}.command = ${server.command}`);
        log.dim(`    mcpServers.${name}.args = ${JSON.stringify(server.args)}`);
        if (apiKey) {
          log.dim(`    mcpServers.${name}.env.MEKO_API_KEY = <set>`);
        }
        return;
      }

      mergeSettings(path, { mcpServers: { [name]: server } });
    },
    setHookEnvironment({ dryRun, log }) {
      // Claude Desktop has no hook API, so the skill mandates per-turn
      // conversation_add_message posting (the server extracts memories from
      // those posts); proactive memory_add is no longer the model. Nothing to
      // write here.
      if (dryRun) {
        log.dim("  No hook environment required for Claude Desktop (skill-driven).");
      }
    },
    installSkills({ dryRun, log }) {
      const assetRoot = assetRootResolver();
      const script = join(assetRoot, "scripts", "package-desktop-skill.sh");
      const output = join(assetRoot, "meko-mcp-tools-desktop.skill");
      const selectOutput = join(assetRoot, "meko-select-datapack-desktop.skill");
      const outputs = [output, selectOutput];
      // The .skill output is a ZIP file, so we can't drop a marker inside it.
      // Stamp the marker in the parent dir instead — it signals which
      // installer version produced the bundle sitting alongside it, so a
      // re-run can tell whether the existing .skill is stale.
      const markerDir = dirname(output);
      const currentVersion = getInstallerVersion();

      if (dryRun) {
        log.dim(`  Would run: bash ${script}`);
        for (const skillOutput of outputs) {
          log.dim(`  Would produce: ${skillOutput}`);
        }
        log.dim(`  Would write .meko-installer marker (version=${currentVersion}) in ${markerDir}`);
        return { marketplace: "skipped", skills: "dry-run", output, outputs };
      }

      if (!existsSync(script)) {
        log.warn(
          `Skill packaging script not found at ${script}. ` +
            "Skipping .skill bundle build; install the skill manually via Claude Desktop settings.",
        );
        return { marketplace: "skipped", skills: "script-missing" };
      }

      // If a previous build's marker is stale, warn visibly — the user has to
      // re-drag the .skill into Claude Desktop's Extensions panel; we can't do
      // that step for them. Keep rebuilding either way.
      const existingMarker = readInstallerMarker(markerDir);
      if (outputs.some((skillOutput) => existsSync(skillOutput)) && existingMarker && markerIsStale(markerDir, currentVersion)) {
        log.warn(
          `Claude Desktop .skill bundle was produced by installer ${existingMarker.version}. ` +
            `Rebuilding — you will need to re-drag it into Claude Desktop > Settings > Extensions.`,
        );
      }

      try {
        packageRunner(script);
      } catch (err) {
        log.warn(`Skill packaging failed: ${err.message}`);
        return { marketplace: "skipped", skills: "error", error: err.message };
      }

      const missingOutputs = outputs.filter((skillOutput) => !existsSync(skillOutput));
      if (missingOutputs.length) {
        log.warn(`Expected skill bundle(s) were not produced: ${missingOutputs.join(", ")}`);
        return { marketplace: "skipped", skills: "error" };
      }

      // Stamp the marker after a successful build so the next run knows what
      // version the sibling .skill was produced by.
      try {
        writeInstallerMarker(markerDir);
      } catch (err) {
        // Marker is best-effort — a failure here doesn't invalidate the build.
        log.warn(`Could not write .skill installer marker: ${err.message}`);
      }

      for (const skillOutput of outputs) {
        log.info(`Built Meko skill bundle: ${skillOutput}`);
      }
      log.info(
        "Install both in Claude Desktop: Settings > Extensions > Import skill, " +
          "or drag each .skill file onto the Claude Desktop window.",
      );
      return { marketplace: "skipped", skills: "ok", output, outputs };
    },
    uninstall({ name }) {
      const results = [];
      try {
        this.removeRegistration(name);
        results.push({
          key: "mcp",
          ok: true,
          message: `Claude Desktop MCP server "${name}" removed from ${configPathResolver()}.`,
        });
      } catch (err) {
        results.push({
          key: "mcp",
          ok: false,
          message: `Could not remove Claude Desktop MCP server: ${err.message}`,
        });
      }
      results.push({
        key: "skills",
        ok: true,
        message:
          "Desktop skills are managed via the Desktop UI; " +
          "remove the Meko skill manually if it was imported.",
      });
      return results;
    },
    async validateConfig({ serverName }) {
      const path = configPathResolver();
      const cfg = readJsonFile(path);
      const entry = cfg?.mcpServers?.[serverName];
      if (!entry) {
        return { ok: false, message: `Server "${serverName}" not found in ${path}.` };
      }

      // Claude Desktop only accepts stdio entries. A top-level `url` field
      // (the HTTP shape) is silently rejected by Desktop's loader with a
      // "not valid MCP server configurations" warning. Reject it here so the
      // installer catches the regression before the user restarts the app.
      if (entry.url && !entry.command) {
        return {
          ok: false,
          message:
            `Server "${serverName}" in ${path} uses the unsupported HTTP shape ` +
            `({ "url": ... }). Claude Desktop requires a stdio command entry. ` +
            `Re-run the installer to rewrite it via mcp-remote.`,
        };
      }
      if (typeof entry.command !== "string" || !Array.isArray(entry.args)) {
        return {
          ok: false,
          message:
            `Server "${serverName}" in ${path} is missing required "command" and "args" fields.`,
        };
      }
      if (!entry.args.includes(`User-Agent:${MEKO_MCP_USER_AGENT}`)) {
        return {
          ok: false,
          message: `Server "${serverName}" in ${path} is missing the User-Agent header required by the Cloud WAF.`,
        };
      }

      return { ok: true, message: `Server "${serverName}" is registered in ${path}.` };
    },
  };
}

/**
 * Build a Claude Desktop mcpServers entry that wraps an HTTP MCP URL with the
 * mcp-remote stdio bridge.
 *
 * Exported for tests.
 *
 * @param {{url: string, apiKey: string|null}} params
 * @returns {{command: string, args: string[], env?: Record<string,string>}}
 */
export function buildMcpRemoteEntry({ url, apiKey }) {
  const args = [
    "-y",
    "mcp-remote",
    url,
    "--transport",
    "http-only",
    "--header",
    `User-Agent:${MEKO_MCP_USER_AGENT}`,
  ];
  const entry = { command: "npx", args };
  if (apiKey) {
    // `Authorization:Bearer ${MEKO_API_KEY}` with no space around the colon
    // after the header name — mcp-remote docs call out a spacing bug in some
    // clients' arg parsing. The space between `Bearer` and the token value
    // is part of the header value and is required by RFC 6750.
    args.push("--header", "Authorization:Bearer ${MEKO_API_KEY}");
    entry.env = { MEKO_API_KEY: apiKey };
  }
  return entry;
}

/** Read the remote URL from installer-managed or MCPB Claude Desktop entries. */
export function getMcpRemoteEntryUrl(entry) {
  if (typeof entry?.env?.MEKO_MCP_URL === "string") {
    return entry.env.MEKO_MCP_URL;
  }
  if (typeof entry?.url === "string") return entry.url;
  if (!Array.isArray(entry?.args)) return undefined;
  const remoteIndex = entry.args.indexOf("mcp-remote");
  const candidate = remoteIndex >= 0 ? entry.args[remoteIndex + 1] : undefined;
  return typeof candidate === "string" ? candidate : undefined;
}

function defaultRunPackageScript(scriptPath) {
  if (!statSync(scriptPath).isFile()) {
    throw new Error(`Not a file: ${scriptPath}`);
  }
  execFileSync("bash", [scriptPath], { stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Check whether `npx` is available on PATH.
 * @returns {{found: boolean, path: string, version: string}}
 */
function defaultProbeNpx() {
  const result = { found: false, path: "", version: "" };
  try {
    result.path = run("command -v npx");
  } catch {
    return result;
  }
  if (!result.path) return result;
  try {
    result.version = run("npx --version");
  } catch {
    // Path found but version probe failed — still usable.
  }
  result.found = true;
  return result;
}
