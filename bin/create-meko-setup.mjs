#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { install, uninstall } from '../lib/installer.mjs';
import { askChoice, askMultiChoice, askText, askSecret, askYesNo, close as closePrompts } from '../lib/prompt.mjs';
import { banner, error, dim, info, warn } from '../lib/logger.mjs';
import {
  isPackagedInstall,
  MEKO_PRODUCTION_CONSOLE_URL,
  selfInvocation,
} from '../lib/clients/common.mjs';
import { getClientAdapters } from '../lib/clients/index.mjs';
import { resolveSuggestedMcpUrl } from '../lib/url-selection.mjs';
import { parseClientList } from '../lib/clients/aliases.mjs';
import { startMigration, runChildMigration, readStatus, stopMigration } from '../lib/migrate.mjs';
import { checkLatest } from '../lib/version-check.mjs';

// ---------------------------------------------------------------------------
// Flag definitions
// ---------------------------------------------------------------------------

const options = {
  url:                { type: 'string' },
  'api-key':          { type: 'string' },
  local:              { type: 'boolean', default: false },
  scope:              { type: 'string',  default: 'user' },
  name:               { type: 'string',  default: 'meko' },
  client:             { type: 'string',  default: 'claude-code' },
  'cursor-hook-mode': { type: 'string',  default: 'native' },
  'skip-skills':      { type: 'boolean', default: false },
  'skip-validation':  { type: 'boolean', default: false },
  statusline:         { type: 'boolean', default: false },
  'no-statusline':    { type: 'boolean', default: false },
  'no-canary':        { type: 'boolean', default: false },
  'dry-run':          { type: 'boolean', default: false },
  'check-updates':    { type: 'boolean', default: false },
  uninstall:          { type: 'boolean', default: false },
  verbose:            { type: 'boolean', default: false },
  yes:                { type: 'boolean', default: false },
  help:               { type: 'boolean', short: 'h', default: false },
  version:            { type: 'boolean', short: 'v', default: false },

  // --- Migrate subcommand ---
  migrate:            { type: 'boolean', default: false },
  'migrate-status':   { type: 'boolean', default: false },
  'migrate-stop':     { type: 'boolean', default: false },
  'with-migrate':     { type: 'boolean', default: false },
  force:              { type: 'boolean', default: false },
  rate:               { type: 'string' },
  'no-extract':       { type: 'boolean', default: false },
  'run-id':           { type: 'string' },
  datapack:           { type: 'string' },
  '__migrate-child':  { type: 'boolean', default: false },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

function readVersion() {
  const pkgPath = join(__dirname, '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  return pkg.version;
}

const ALL_CLIENTS = ['claude-code', 'claude-desktop', 'cursor', 'codex'];

function printHelp() {
  const text = `
Meko Setup for Claude Clients and Cursor

Install and configure Meko MCP Server in one command.

Usage:
  create-meko-setup [options]

Examples:
  # Interactive setup (recommended for first-time users):
  create-meko-setup

  # Cloud Meko for Claude Code (non-interactive):
  create-meko-setup --url https://mcp.mekodata.ai/mcp --api-key "$MEKO_API_KEY" --yes

  # Local Meko with Cursor config:
  create-meko-setup --client cursor --local --scope project --yes

  # Install on both Claude Code and Claude Desktop at once:
  create-meko-setup --client claude-code,claude-desktop --local --yes

  # Install on every supported client:
  create-meko-setup --client all --local --yes

  # Install for OpenAI Codex (CLI + Desktop App share the same config):
  create-meko-setup --client codex --yes

  # Local Meko (docker-compose stack, Claude Code):
  create-meko-setup --local --yes

Options:
  --client <list>       Target clients: one or more of claude-code, claude-desktop, cursor, codex.
                        "claude" is accepted as an alias for claude-code.
                        Comma-separated, or "all" to target every supported client (default: claude-code)
                        codex covers BOTH the OpenAI Codex CLI and the Codex Desktop App
                        (they share ~/.codex/config.toml).
  --url <url>           MCP server URL (from cloud.mekodata.ai > Datapacks > Connect)
  --api-key <key>       API key for Cloud Meko authentication
  --local               Use local Meko at http://localhost:8000/mcp
  --scope <scope>       Config scope: user or project (default: user)
                        codex always installs at user scope (no project-level
                        config); --scope=project degrades with a warning.
  --name <name>         MCP server name in config (default: meko)
  --cursor-hook-mode    Cursor hook mode: native or claude-compat (default: native)
  --skip-skills         Skip plugin and skills installation
  --statusline          Wire the Meko datapack-pin indicator into Claude Code's
                        statusline (composes with any existing statusLine).
                        Default: ON under --yes, prompted otherwise.
                        Claude Code only.
  --no-statusline       Skip statusline wiring even under --yes.
  --skip-validation     Skip post-install validation
  --no-canary           Skip the canary datapack_list call. The
                        connectivity + tools/list checks still run.
  --dry-run             Show what would be done without making changes
  --check-updates       Compare installed version against npm registry and exit
  --uninstall           Remove Meko MCP server, skills, and env vars
  --verbose             Show detailed output
  --yes                 Accept all defaults (non-interactive)
  -h, --help            Show this help message
  -v, --version         Show version

Migrate existing conversations and memories into Meko:
  --migrate             Start a detached migration of existing Claude Code
                        and Cursor conversations + CLAUDE.md memories.
                        Honors --scope (user or project) and --dry-run.
  --with-migrate        When combined with --yes, kick off --migrate at the
                        end of a successful install without prompting
                        (CI-friendly: --local --yes --with-migrate).
  --migrate-status      Print the status of the latest migration run.
  --migrate-stop        Stop the running migration (SIGTERM, then SIGKILL).
  --no-extract          Skip memory extraction; replay conversations only.
  --rate <n>            Max concurrent MCP calls during migration (default 4).
  --force               Ignore a live lockfile or re-ingest processed items.
  --run-id <id>         Target a specific run-id for --migrate-status.
  --datapack <name|id>  Migration destination datapack. Accepts a datapack
                        name or UUID. When omitted, the user's default
                        datapack is used (resolved at run time and printed
                        before the run starts).
`.trimStart();

  console.log(text);
}

function isCloudUrl(url) {
  return url && !url.includes('localhost') && !url.includes('127.0.0.1');
}

/**
 * Sanitize a raw API key from any source (CLI flag, env var, askSecret prompt).
 *
 * Strips surrounding whitespace and a single matching pair of surrounding
 * quotes. The contaminated value would otherwise be concatenated into
 * `Authorization: Bearer <key>` verbatim and 401 against any server. Common
 * sources of contamination: a trailing newline from
 * `export MEKO_API_KEY=$(cat token.txt)`, a literal `"..."` copied out of a
 * `.env` file, or a stray space at the end of a paste.
 *
 * Returns `null` for null/undefined/empty so the existing `!apiKey` checks
 * still funnel into the "no key supplied" path.
 */
function normalizeApiKey(value) {
  if (value === null || value === undefined) return null;
  let s = String(value).trim();
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    s = s.slice(1, -1).trim();
  }
  return s || null;
}

/**
 * Parse --client into a deduplicated list of client IDs.
 * Accepts a single value, a comma-separated list, or the keyword "all".
 * Aliases (see CLIENT_ALIASES in ../lib/clients.mjs) are resolved before the
 * validity check so the cloud UI snippet (`--client claude`) works verbatim.
 * Returns { clients, invalid } where invalid lists any unknown tokens.
 */
function parseClients(raw) {
  return parseClientList(raw, ALL_CLIENTS);
}

function isValidScope(scope) {
  return ['user', 'project'].includes(scope);
}

/**
 * Did the user pass --client on the CLI? parseArgs always materializes the
 * default ("claude-code"), so we can't tell from flags alone — have to sniff
 * argv. Used to decide whether to show the interactive client picker.
 */
function userPassedClientFlag() {
  return process.argv.some(
    (a) => a === '--client' || a.startsWith('--client='),
  );
}

/**
 * Which clients are actually installed on this machine? Uses each adapter's
 * isInstalled() probe (CLI binary for Claude Code, config dir for Claude
 * Desktop and Cursor). NOT detectPrerequisites — that checks deps like npx,
 * which are present on basically any Node.js machine and would default the
 * picker to "install everything". Returns a Set of client IDs.
 */
function detectInstalledClients() {
  const adapters = getClientAdapters();
  const detected = new Set();
  for (const [id, adapter] of Object.entries(adapters)) {
    if (typeof adapter.isInstalled === "function" && adapter.isInstalled()) {
      detected.add(id);
    }
  }
  return detected;
}

function isValidCursorHookMode(mode) {
  return ['native', 'claude-compat'].includes(mode);
}

/**
 * Parse --rate as a positive integer, or throw with a helpful message.
 * `undefined` passes through (= use the default).
 */
function parseRate(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {
    throw new Error(`Invalid --rate "${raw}": must be a positive integer.`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { values: flags } = parseArgs({ options, strict: true });
  const projectRoot = process.cwd();

  // --help
  if (flags.help) {
    printHelp();
    process.exit(0);
  }

  // --version
  if (flags.version) {
    console.log(readVersion());
    console.log('(run with --check-updates to compare against npm registry)');
    process.exit(0);
  }

  // --check-updates — synchronous probe of the npm registry. Never fails:
  // network errors produce "status: network error (<message>)" and exit 0.
  if (flags['check-updates']) {
    const current = readVersion();
    const result = await checkLatest({ currentVersion: current });
    console.log(`current: ${current}`);
    if (result.latest) {
      console.log(`latest:  ${result.latest}`);
      if (result.isOutdated) {
        console.log('status:  outdated — run `npx @yugabytedb/meko-mcp@latest` to upgrade');
      } else {
        console.log('status:  up to date');
      }
    } else {
      console.log('latest:  unknown');
      console.log(`status:  network error (${result.error ?? 'unknown'})`);
    }
    process.exit(0);
  }

  // Kick off a background version check on normal runs. We intentionally don't
  // await — if the registry is slow or unreachable we don't want to delay
  // (or fail) the install. `background: true` unrefs the underlying socket so
  // an in-flight probe never keeps Node alive after the install exits; the
  // result is still consulted (via Promise.race with an already-resolved
  // sentinel) in time for the post-install banner when it arrives early.
  const versionCheckPromise = checkLatest({ currentVersion: readVersion(), background: true });
  versionCheckPromise.catch(() => {
    /* checkLatest never rejects, but belt-and-suspenders. */
  });

  // --- Migrate subcommand dispatch ---

  // Detached child branch: re-entry inside the spawned process.
  if (flags['__migrate-child']) {
    if (!flags['run-id']) {
      error('--__migrate-child requires --run-id');
      process.exit(1);
    }
    if (!flags.url) {
      error('--__migrate-child requires --url');
      process.exit(1);
    }
    let childRate;
    try { childRate = parseRate(flags.rate); }
    catch (err) { error(err.message); process.exit(1); }
    const code = await runChildMigration({
      runId: flags['run-id'],
      scope: flags.scope,
      url: flags.url,
      apiKey: normalizeApiKey(process.env.MEKO_API_KEY),
      projectRoot,
      noExtract: flags['no-extract'],
      force: flags.force,
      rate: childRate,
      datapack: flags.datapack ?? null,
    });
    process.exit(code);
  }

  if (flags['migrate-status']) {
    const out = readStatus({ runId: flags['run-id'] });
    console.log(out.message);
    process.exit(out.ok ? 0 : 1);
  }

  if (flags['migrate-stop']) {
    const out = await stopMigration();
    console.log(out.message);
    process.exit(out.ok ? 0 : 1);
  }

  if (flags.migrate) {
    if (!isValidScope(flags.scope)) {
      error(`Unknown scope "${flags.scope}". Valid values: user, project.`);
      process.exit(1);
    }
    let url = flags.url ?? process.env.MEKO_MCP_URL ?? null;
    let apiKey = normalizeApiKey(flags['api-key'] ?? process.env.MEKO_API_KEY);
    if (flags.local) { url = 'http://localhost:8000/mcp'; apiKey = null; }

    let parentRate;
    try { parentRate = parseRate(flags.rate); }
    catch (err) { error(err.message); process.exit(1); }

    const out = await startMigration({
      url,
      apiKey,
      scope: flags.scope,
      projectRoot,
      scriptPath: __filename,
      dryRun: flags['dry-run'],
      noExtract: flags['no-extract'],
      force: flags.force,
      rate: parentRate,
      nonInteractive: flags.yes,
      datapack: flags.datapack ?? null,
    });
    console.log(out.message);
    process.exit(out.ok ? 0 : 1);
  }

  let { clients, invalid } = parseClients(flags.client);
  if (invalid.length > 0) {
    error(`Unknown client(s): ${invalid.join(', ')}. Valid values: ${ALL_CLIENTS.join(', ')}, all.`);
    process.exit(1);
  }
  if (clients.length === 0) {
    error(`--client must name at least one of: ${ALL_CLIENTS.join(', ')}, all.`);
    process.exit(1);
  }

  // Validate --scope BEFORE any branch that interpolates it into a shell
  // command. The --uninstall path now forwards --scope to
  // `claude plugin uninstall --scope <X>`, so an invalid value must be
  // caught here, not after it's already been handed to the shell.
  if (!isValidScope(flags.scope)) {
    error(`Unknown scope "${flags.scope}". Valid values: user, project.`);
    process.exit(1);
  }

  // --uninstall
  if (flags.uninstall) {
    for (const client of clients) {
      await uninstall({
        client,
        name: flags.name,
        scope: flags.scope,
        verbose: flags.verbose,
        projectRoot,
        cursorHookMode: flags['cursor-hook-mode'],
      });
    }
    process.exit(0);
  }
  if (!isValidCursorHookMode(flags['cursor-hook-mode'])) {
    error(`Unknown --cursor-hook-mode "${flags['cursor-hook-mode']}". Valid values: native, claude-compat.`);
    process.exit(1);
  }

  let url    = flags.url    ?? null;
  let apiKey = normalizeApiKey(flags['api-key']);
  let skipSkills = flags['skip-skills'];
  // Statusline: --no-statusline always wins. --statusline forces on. Otherwise
  // default to on under --yes (programmatic), and prompt with Y default
  // interactively. Resolved later after the interactive prompts since the
  // flag may flip in the interactive flow.
  let installStatusline = !flags['no-statusline'] && (flags.statusline || flags.yes);
  // Tracks whether the full interactive flow already prompted for the API
  // key. The Cloud-URL fallback below should only run for the
  // semi-interactive `--url ... --client ...` paste path — otherwise
  // submitting an empty value at the full-flow prompt would re-ask the
  // same question.
  let promptedForApiKey = false;

  // --local shortcut
  if (flags.local) {
    url    = 'http://localhost:8000/mcp';
    apiKey = null;
  }

  // Client picker — runs for any interactive invocation (including
  // semi-interactive `--url ...` without `--client`). Historically the
  // installer silently defaulted to --client=claude-code, so a user with
  // Cursor or Claude Desktop also installed would never know those
  // clients weren't configured. Skip when the user explicitly passed
  // --client, or --yes (non-interactive).
  if (!userPassedClientFlag() && !flags.yes) {
    const detected = detectInstalledClients();
    const pickerOptions = ALL_CLIENTS.map((id) => {
      const displayName = {
        'claude-code': 'Claude Code',
        'claude-desktop': 'Claude Desktop',
        cursor: 'Cursor',
        codex: 'OpenAI Codex (CLI + App)',
      }[id];
      return {
        label: id,
        description: detected.has(id) ? `${displayName} (detected)` : `${displayName} (not detected)`,
      };
    });
    if (detected.size === 1) {
      clients = [[...detected][0]];
      dim(`Only ${pickerOptions.find((o) => o.label === clients[0]).description.replace(' (detected)', '')} detected; installing for it.`);
    } else if (detected.size === 0) {
      // No client detected — fall through to the existing default.
      // Validation later in the install will raise a clearer error than a
      // blank picker would.
      dim('No supported clients auto-detected. Defaulting to Claude Code; pass --client to override.');
    } else {
      const picked = await askMultiChoice(
        'Install Meko for which client(s)?',
        pickerOptions,
        { defaults: [...detected] },
      );
      if (picked.length === 0) {
        error('No clients selected. Aborting.');
        process.exit(1);
      }
      clients = picked;
    }
  }

  let suggestedUrl = null;
  if (!url && !flags.local) {
    suggestedUrl = resolveSuggestedMcpUrl({
      adapters: getClientAdapters(),
      clients,
      name: flags.name,
      scope: flags.scope,
      projectRoot,
    });
    if (flags.yes) {
      if (suggestedUrl.source === 'conflict') {
        const conflicts = suggestedUrl.existingUrls.map((existingUrl) => `\n  - ${existingUrl}`).join('');
        error(
          `Selected clients have different existing Meko URLs:${conflicts}\n` +
          'Pass --url explicitly to choose which endpoint to install.',
        );
        process.exit(1);
      }
      url = suggestedUrl.url;
    }
  }

  // Interactive mode: URL not provided and not auto-accepting defaults
  if (!url && !flags.yes) {
    banner('Meko Setup');

    // Step 1 — connection type. Local Meko only makes sense for users who
    // have the server repo cloned locally (docker-compose stack on :8000);
    // npm/npx users have no way to run it, so hide the option for them.
    // When only Cloud is available, skip the prompt entirely — asking to
    // pick between one option is pointless UX.
    const connectionOptions = [
      { label: 'Cloud Meko', description: 'Hosted at mekodata.ai (requires an API key)' },
    ];
    if (!isPackagedInstall()) {
      connectionOptions.push({
        label: 'Local Meko',
        description: 'Local stack at localhost:8000',
      });
    }
    const connectionType =
      connectionOptions.length === 1
        ? connectionOptions[0].label
        : await askChoice('Connection type:', connectionOptions);

    if (connectionType === 'Cloud Meko') {
      // Step 2 — MCP URL
      if (suggestedUrl?.source === 'existing') {
        dim(`Using the existing Meko endpoint as the default: ${suggestedUrl.url}`);
      } else if (suggestedUrl?.source === 'conflict') {
        const conflicts = suggestedUrl.existingUrls.map((existingUrl) => `\n  - ${existingUrl}`).join('');
        warn(
          `Selected clients use different Meko endpoints:${conflicts}\n` +
          'Enter the endpoint to use for this install.',
        );
      }
      url = await askText(
        `MCP server URL (from ${MEKO_PRODUCTION_CONSOLE_URL} > Datapacks > Connect):`,
        suggestedUrl?.url ?? undefined,
      );

      // Step 3 — API key. Normalize: terminal paste can drag in trailing
      // whitespace/CR or accidental surrounding quotes, all of which would
      // sail straight into `Authorization: Bearer ...` and 401.
      apiKey = normalizeApiKey(await askSecret('API key:'));
      promptedForApiKey = true;
    } else {
      url    = 'http://localhost:8000/mcp';
      apiKey = null;
    }

    // Step 4 — skills
    const installSkills = await askYesNo(
      'Install Meko agent skills plugin? (behavioral guides for MCP tools)',
      true,
    );
    if (!installSkills) {
      skipSkills = true;
    }

    // Step 5 — statusline (Claude Code only). --no-statusline / --statusline
    // skip the prompt; otherwise ask with Y default. The prompt only matters
    // when at least one selected client is claude-code; for desktop / cursor /
    // codex the install() orchestrator simply skips the step (the adapters
    // don't expose installStatusline()).
    if (!flags['no-statusline'] && !flags.statusline && clients.includes('claude-code')) {
      installStatusline = await askYesNo(
        'Show the active Meko datapack in Claude Code\'s statusline? ' +
        '(composes with any existing statusLine — non-destructive)',
        true,
      );
    }
  }

  // Validation — URL must be set by now
  if (!url) {
    error('MCP server URL is required. Provide --url, --local, or run interactively.');
    process.exit(1);
  }

  // Validation — Cloud URL requires an API key.
  // Resolution order: --api-key (already in `apiKey`) → $MEKO_API_KEY →
  // interactive prompt (only on a TTY, not under --yes, and only if the
  // full interactive flow above didn't already ask). The prompt fallback
  // exists so a user who pastes the cloud one-liner from the UI (which
  // only shows --url and --client) isn't dead-ended on a hard error when
  // they forgot to supply the key. Skipping it after a full-flow prompt
  // avoids re-asking the same question when the user submitted empty.
  if (isCloudUrl(url) && !apiKey) {
    apiKey = normalizeApiKey(process.env.MEKO_API_KEY);
    if (apiKey) {
      dim('Using API key from MEKO_API_KEY environment variable.');
    } else if (!flags.yes && !promptedForApiKey && process.stdin.isTTY) {
      dim('No --api-key or MEKO_API_KEY env var found; prompting for API key.');
      apiKey = normalizeApiKey(await askSecret('API key:'));
    }
    if (!apiKey) {
      error(
        'API key is required for Cloud Meko. ' +
        'Provide --api-key, set MEKO_API_KEY env var, or run interactively.',
      );
      process.exit(1);
    }
  }

  // Install — loop through each selected client sequentially so failures
  // for one client don't abort the others.
  const errors = [];
  for (const client of clients) {
    try {
      await install({
        url,
        apiKey,
        scope:          flags.scope,
        name:           flags.name,
        skipSkills,
        skipValidation: flags['skip-validation'],
        skipCanary:     flags['no-canary'],
        // Statusline is Claude Code only. For other clients the orchestrator
        // skips the step regardless of the flag because the adapter doesn't
        // expose installStatusline(); explicit guard keeps step counts honest.
        installStatusline: client === 'claude-code' && installStatusline,
        dryRun:         flags['dry-run'],
        verbose:        flags.verbose,
        yes:            flags.yes,
        client,
        projectRoot,
        cursorHookMode: flags['cursor-hook-mode'],
      });
    } catch (err) {
      errors.push({ client, err });
      error(`Install for ${client} failed: ${err.message ?? err}`);
    }
  }

  if (errors.length === clients.length) {
    process.exit(1);
  } else if (errors.length > 0) {
    // Partial success — exit non-zero so CI notices, but keep the successful
    // installs in place.
    process.exit(2);
  }

  // Post-install migration handling:
  //   - --yes --with-migrate → kick off a detached migration, no prompt
  //   - --yes (no --with-migrate) → silent; print a one-liner tip
  //   - interactive (not --yes), TTY → dry-run enumerate, prompt Y/n
  //   - --dry-run install → skip entirely (we don't want side effects)
  if (!flags['dry-run']) {
    if (flags['with-migrate']) {
      await runUnattendedMigration({
        url,
        apiKey,
        scope: flags.scope,
        projectRoot,
        datapack: flags.datapack ?? null,
      });
    } else if (flags.yes) {
      console.log('');
      dim(`Tip: run \`${selfInvocation()} --migrate\` to import existing conversations and memories.`);
    } else if (process.stdin.isTTY) {
      await maybeOfferMigration({
        url,
        apiKey,
        scope: flags.scope,
        projectRoot,
        datapack: flags.datapack ?? null,
      });
    }
  }

  // Upgrade hint — only print if the background probe finished in time.
  // We race the check against a pre-resolved sentinel so an in-flight
  // probe (slow network) is silently dropped instead of delaying exit.
  try {
    const raced = await Promise.race([
      versionCheckPromise,
      Promise.resolve({ timedOut: true }),
    ]);
    if (raced && raced.isOutdated === true && raced.latest && raced.current) {
      info(
        `A newer version is available (${raced.latest}, you have ${raced.current}). ` +
        'Re-run with `npx @yugabytedb/meko-mcp@latest`.',
      );
    }
  } catch {
    /* never reached — checkLatest doesn't reject — but don't block exit. */
  }
}

/**
 * Unattended migration — used by --yes --with-migrate.
 * No prompts; errors are surfaced but do not fail the install.
 */
async function runUnattendedMigration({ url, apiKey, scope, projectRoot, datapack }) {
  try {
    const out = await startMigration({
      url,
      apiKey,
      scope,
      projectRoot,
      scriptPath: __filename,
      nonInteractive: true,
      datapack: datapack ?? null,
    });
    console.log('');
    console.log(out.message);
    if (!out.ok) {
      // Don't fail the install; the user can retry with --migrate.
      dim(`Migration did not start cleanly. Install succeeded; try \`${selfInvocation()} --migrate\` later.`);
    }
  } catch (err) {
    dim(`Migration could not be started: ${err.message ?? err}`);
  }
}

/**
 * Dry-run enumerate the user's local data; if anything is migratable, ask
 * whether to kick off the detached migration. Any error here is non-fatal —
 * install has already succeeded.
 */
async function maybeOfferMigration({ url, apiKey, scope, projectRoot, datapack }) {
  try {
    const dry = await startMigration({
      url,
      apiKey,
      scope,
      projectRoot,
      scriptPath: __filename,
      dryRun: true,
      datapack: datapack ?? null,
    });
    const s = dry?.message?.match(/Claude Code sessions: *(\d+)/);
    const c = dry?.message?.match(/Cursor sessions: *(\d+)/);
    const m = dry?.message?.match(/Memory items \(MD\): *(\d+)/);
    const counts = {
      claude: s ? Number(s[1]) : 0,
      cursor: c ? Number(c[1]) : 0,
      memory: m ? Number(m[1]) : 0,
    };
    const total = counts.claude + counts.cursor + counts.memory;
    if (total === 0) return;

    console.log('');
    dim(
      `Found existing data to migrate: ` +
      `${counts.claude} Claude Code sessions, ` +
      `${counts.cursor} Cursor sessions, ` +
      `${counts.memory} memory items.`,
    );
    const proceed = await askYesNo(
      'Migrate existing conversations and memories into Meko now? ' +
      '(runs in the background; check with --migrate-status)',
      true,
    );
    if (!proceed) {
      dim(`Skipped. Run \`${selfInvocation()} --migrate\` later when you're ready.`);
      return;
    }
    const out = await startMigration({
      url,
      apiKey,
      scope,
      projectRoot,
      scriptPath: __filename,
      datapack: datapack ?? null,
    });
    console.log(out.message);
  } catch (err) {
    // Don't fail the whole install if the migration prompt hiccups.
    dim(`Skipped migration offer: ${err.message ?? err}`);
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

try {
  await main();
} catch (err) {
  error(err.message ?? err);
  process.exit(1);
} finally {
  closePrompts();
}
