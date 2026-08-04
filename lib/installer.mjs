import { askYesNo } from "./prompt.mjs";
import {
  banner,
  dim,
  error,
  info,
  stepFail,
  stepOk,
  success,
  warn,
} from "./logger.mjs";
import { getClientAdapters } from "./clients/index.mjs";
import { redactKey } from "./clients/common.mjs";
import { runValidation } from "./validate.mjs";

const LOG = {
  dim,
  warn,
  info,
};

/**
 * Install and configure Meko MCP server for a selected client.
 * @param {object} options
 */
export async function install(options) {
  const {
    client = "claude-code",
    url,
    apiKey = null,
    scope = "user",
    name = "meko",
    skipSkills = false,
    skipValidation = false,
    skipCanary = false,
    installStatusline = false,
    dryRun = false,
    verbose = false,
    yes = false,
    projectRoot = process.cwd(),
    cursorHookMode = "native",
  } = options;

  const adapters = getClientAdapters();
  const adapter = adapters[client];
  if (!adapter) {
    throw new Error(`Unsupported client "${client}".`);
  }

  const settingsPath = adapter.settingsPath(scope, projectRoot);

  let totalSteps = 3; // register + env/hooks + validate
  if (!skipSkills) totalSteps += 1;
  if (installStatusline && typeof adapter.installStatusline === "function") totalSteps += 1;
  if (skipValidation) totalSteps -= 1;

  banner(`Meko Setup for ${adapter.displayName}`);
  if (dryRun) warn("Dry-run mode - no changes will be made.");
  if (verbose) {
    dim(`  client: ${client}`);
    dim(`  url:    ${url}`);
    dim(`  apiKey: ${redactKey(apiKey)}`);
    dim(`  scope:  ${scope}`);
    dim(`  name:   ${name}`);
    if (settingsPath) dim(`  config: ${settingsPath}`);
  }

  info("Checking prerequisites...");
  try {
    await adapter.detectPrerequisites({ verbose, log: LOG, scope, projectRoot });
  } catch (err) {
    error(err.message);
    throw err;
  }
  success(`${adapter.displayName} prerequisites detected.`);

  const existing = adapter.detectExisting(name, { scope, projectRoot });
  let skipMcpRegistration = false;
  if (existing.found) {
    let overwrite = true;
    if (typeof adapter.maybeConfirmOverwrite === "function") {
      overwrite = await adapter.maybeConfirmOverwrite({
        existingFound: existing.found,
        name,
        yes,
      });
    } else if (!yes) {
      overwrite = await askYesNo(
        `Meko MCP is already configured for ${adapter.displayName}. Overwrite?`,
        false,
      );
    }

    if (!overwrite) {
      warn("Skipping MCP registration (keeping existing config).");
      skipMcpRegistration = true;
    } else if (!dryRun) {
      try {
        adapter.removeRegistration(name, { scope, projectRoot });
        if (verbose) dim(`  Removed existing "${name}" MCP entry.`);
      } catch {
        // best effort
      }
    } else {
      info(`Existing "${name}" MCP configuration found - overwriting.`);
    }
  }

  let currentStep = 1;

  if (!skipMcpRegistration) {
    try {
      await adapter.registerServer({
        name,
        url,
        scope,
        apiKey,
        dryRun,
        verbose,
        log: LOG,
        projectRoot,
        yes,
      });
      stepOk(currentStep, totalSteps, dryRun ? "Registering MCP server (dry-run)." : "MCP server registered.");
    } catch (err) {
      stepFail(currentStep, totalSteps, "Failed to register MCP server.");
      error(err.stderr || err.message);
      throw new Error("MCP server registration failed.");
    }
  } else {
    stepOk(currentStep, totalSteps, "MCP server registration skipped (existing config kept).");
  }
  currentStep++;

  try {
    adapter.setHookEnvironment({
      url,
      apiKey,
      scope,
      dryRun,
      verbose,
      log: LOG,
      settingsPath,
      projectRoot,
      cursorHookMode,
    });
    stepOk(currentStep, totalSteps, dryRun ? "Configuring hook environment (dry-run)." : "Hook environment configured.");
  } catch (err) {
    stepFail(currentStep, totalSteps, "Failed to configure hook environment.");
    error(err.message);
    throw new Error("Hook environment configuration failed.");
  }
  currentStep++;

  if (!skipSkills) {
    try {
      const result = adapter.installSkills({
        name,
        scope,
        dryRun,
        verbose,
        log: LOG,
        projectRoot,
      });
      if (!dryRun && result?.marketplace === "manual") {
        warn("Skills installation requires manual action for this client.");
      }
      stepOk(currentStep, totalSteps, dryRun ? "Installing skills support (dry-run)." : "Skills support configured.");
    } catch (err) {
      stepFail(currentStep, totalSteps, "Failed to configure skills support.");
      warn(`Non-critical: ${err.message}`);
    }
    currentStep++;
  }

  if (installStatusline && typeof adapter.installStatusline === "function") {
    try {
      adapter.installStatusline({
        scope,
        dryRun,
        verbose,
        log: LOG,
        settingsPath,
        projectRoot,
      });
      stepOk(
        currentStep,
        totalSteps,
        dryRun ? "Wiring datapack statusline (dry-run)." : "Datapack statusline wired.",
      );
    } catch (err) {
      stepFail(currentStep, totalSteps, "Failed to wire datapack statusline.");
      warn(`Non-critical: ${err.message}`);
    }
    currentStep++;
  }

  if (!skipValidation) {
    if (dryRun) {
      dim("Would validate config, MCP connectivity, and tool availability.");
      stepOk(currentStep, totalSteps, "Validating setup (dry-run).");
    } else {
      try {
        const results = await runValidation(url, apiKey, name, {
          validateConfig: async ({ serverName }) =>
            adapter.validateConfig({ serverName, scope, projectRoot, url, apiKey }),
          skipCanary,
        });

        const checks = [
          { label: "Config", ...results.config },
          { label: "Connectivity", ...results.connectivity },
          { label: "Tools", ...results.tools },
        ];
        if (results.canary) {
          checks.push({ label: "Canary", ...results.canary });
        }
        for (const check of checks) {
          if (check.ok) success(`${check.label}: ${check.message}`);
          else warn(`${check.label}: ${check.message}`);
        }

        if (results.allPassed) {
          stepOk(currentStep, totalSteps, "All validation checks passed.");
        } else {
          stepFail(currentStep, totalSteps, "Some validation checks failed.");
          warn("Setup completed but some checks did not pass. See details above.");
        }
      } catch (err) {
        stepFail(currentStep, totalSteps, "Validation error.");
        warn(`Validation failed: ${err.message}`);
      }
    }
  }

  console.log("");
  success("Meko MCP Server setup complete.");
  info(`Restart ${adapter.displayName} to activate the updated configuration.`);
}

/**
 * Remove installer-managed Meko configuration for selected client.
 * @param {object} options
 */
export async function uninstall(options = {}) {
  const {
    client = "claude-code",
    name = "meko",
    scope = "user",
    verbose = false,
    projectRoot = process.cwd(),
    cursorHookMode = "native",
  } = options;

  const adapters = getClientAdapters();
  const adapter = adapters[client];
  if (!adapter) {
    throw new Error(`Unsupported client "${client}".`);
  }

  banner(`Meko Uninstall (${adapter.displayName})`);
  const settingsPath = adapter.settingsPath(scope, projectRoot);
  const results = adapter.uninstall({
    name,
    scope,
    projectRoot,
    settingsPath,
    cursorHookMode,
  });

  for (const result of results) {
    if (result.ok) success(result.message);
    else warn(result.message);
  }

  console.log("");
  success(`Meko has been uninstalled for ${adapter.displayName}.`);
  if (verbose && settingsPath) {
    dim(`Config path: ${settingsPath}`);
  }
}
