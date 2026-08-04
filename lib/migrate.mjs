/**
 * migrate.mjs — CLI-facing entry points for the `migrate` subcommand.
 *
 * Three externally-visible actions:
 *   - startMigration(...) — foreground wrapper that forks a detached child
 *   - readStatus(...)     — print latest run's progress
 *   - stopMigration(...)  — SIGTERM the running child, wait briefly, SIGKILL
 *
 * The detached child re-enters this module via `runChildMigration()`
 * (invoked from bin/create-meko-setup.mjs when --__migrate-child is set).
 */

import fs from "node:fs";
import path from "node:path";
import { runMigration } from "./migrate/orchestrator.mjs";
import { createLogger } from "./migrate/logger.mjs";
import { generateRunId, forkDetached, migrateRoot } from "./migrate/daemon.mjs";
import * as lockfile from "./migrate/lockfile.mjs";
import * as progress from "./migrate/progress.mjs";
import { datapackKeyFromUrl } from "./migrate/id.mjs";
import { resolveDestinationDatapack } from "./migrate/datapack.mjs";
import { McpClient } from "./migrate/mcp-client.mjs";
import { selfInvocation } from "./clients/common.mjs";
import { askYesNo } from "./prompt.mjs";

function home() {
  return process.env.HOME || "";
}

/**
 * Build on-disk paths for a migration run.
 *
 * The `statePath` is scoped by `datapackKey` so switching datapacks does not
 * make the migrator falsely skip every session based on checkpoints from a
 * different datapack. See issue #45 for the regression that motivated this.
 *
 * When `datapackKey` is omitted, `statePath` points at the legacy top-level
 * `state.json` — only used for read paths that don't know the datapack yet
 * (e.g. `readStatus` when run-id metadata doesn't record it). New writes
 * should always supply a key.
 *
 * @param {object} [opts]
 * @param {string} [opts.home]
 * @param {string} [opts.datapackKey]
 */
function paths(opts = {}) {
  const root = migrateRoot({ home: opts.home ?? home() });
  const stateDir = path.join(root, "state");
  const statePath = opts.datapackKey
    ? path.join(stateDir, `${opts.datapackKey}.json`)
    : path.join(root, "state.json");
  return {
    root,
    stateDir,
    legacyStatePath: path.join(root, "state.json"),
    statePath,
    lockPath: path.join(root, "lock"),
    runDir: (runId) => path.join(root, runId),
    logFile: (runId) => path.join(root, runId, "stdout.log"),
    progressFile: (runId) => path.join(root, runId, "progress.json"),
  };
}

/**
 * One-time migration of the legacy global `state.json` into the per-datapack
 * `state/<key>.json` layout. Called on the first run after upgrade.
 *
 * We keep the legacy file on disk (don't delete it) so a rollback to an
 * older installer keeps resume state visible there. Future runs ignore
 * `state.json` entirely once `state/` is populated.
 *
 * Safe to call on every run — a no-op if there's nothing to migrate.
 *
 * @param {object} opts
 * @param {ReturnType<typeof paths>} opts.P   Already-constructed paths bundle
 *                                            whose `statePath` is the per-key
 *                                            destination.
 * @param {string} opts.datapackKey
 * @param {boolean} [opts.interactive]        Whether to prompt; false on CI / --yes.
 * @param {(entry: object) => void} [opts.onWarning]  Hook for the orchestrator
 *                                            to log a structured `warnings++`
 *                                            entry. Not invoked on no-op.
 * @returns {Promise<{migrated: boolean, from?: string, to?: string, declined?: boolean}>}
 */
async function migrateLegacyStateIfNeeded(opts) {
  const { P, datapackKey } = opts;
  // We've already crossed this bridge iff `state/` holds any `.json` file.
  // Plain emptiness isn't enough: a stray `.DS_Store` (macOS) or editor
  // swap file would make `readdirSync().length === 0` return false and
  // silently skip the one-time copy, stranding the user's pre-upgrade
  // resume state under `state.json`.
  let hasScopedState = false;
  try {
    hasScopedState = fs.readdirSync(P.stateDir, { withFileTypes: true })
      .some((entry) => entry.isFile() && entry.name.endsWith(".json"));
  } catch {
    // ENOENT (dir doesn't exist yet) → trivially no scoped state.
  }
  if (hasScopedState) return { migrated: false };
  if (!fs.existsSync(P.legacyStatePath)) return { migrated: false };

  // Legacy file exists and state/ is empty → one-time copy.
  if (opts.interactive) {
    const accept = await askYesNo(
      `Legacy global migrate state found. Treating it as belonging to the current datapack ${datapackKey}?`,
      true,
    );
    if (!accept) {
      // User declined: don't copy. Future runs will see state/ empty again
      // and re-offer — but since state/<key>.json will likely be created by
      // this very run, the prompt won't repeat.
      return { migrated: false, declined: true };
    }
  }

  fs.mkdirSync(P.stateDir, { recursive: true });
  fs.copyFileSync(P.legacyStatePath, P.statePath);
  if (typeof opts.onWarning === "function") {
    opts.onWarning({
      event: "legacy_state_migrated",
      from: P.legacyStatePath,
      to: P.statePath,
      datapackKey,
    });
  }
  return { migrated: true, from: P.legacyStatePath, to: P.statePath };
}

/**
 * Choose the on-disk state key for a real run.
 *
 * Default (no --datapack) keeps the URL-derived key — that's what existing
 * installs already wrote into. An explicit `--datapack` that resolved to a
 * *non-default* id is scoped by `dp-<resolved-id>` so two runs against the
 * same URL with different packs don't share resume state and silently skip
 * work.
 *
 * If the explicit value resolved to the same datapack the default flow
 * targets (i.e. the user typed the default's UUID or the literal
 * `meko_default_datapack`), collapse back onto the URL key so the explicit
 * and implicit forms share resume state and don't reprocess every session
 * from a fresh file. Without this collapse, a user who runs the default
 * migration and later re-runs with `--datapack <default-uuid>` would
 * silently re-extract every memory.
 *
 * Falls back to the URL key when the resolver couldn't pin an id
 * (server-fallback / no API-side default row).
 *
 * @param {object} opts
 * @param {string} opts.urlDatapackKey
 * @param {string|null} opts.requested   Raw --datapack value (or null).
 * @param {string|null} opts.resolvedId  Resolver output (or null).
 * @param {string|null} [opts.defaultId] meko_default_datapack id, when known.
 * @returns {string}
 */
export function stateKeyFor({ urlDatapackKey, requested, resolvedId, defaultId }) {
  if (!requested || !resolvedId) return urlDatapackKey;
  // Explicit request that resolves to the user's default datapack: stay on
  // the URL-keyed file the implicit-default flow uses.
  if (defaultId && resolvedId.toLowerCase() === defaultId.toLowerCase()) {
    return urlDatapackKey;
  }
  return `dp-${resolvedId.toLowerCase()}`;
}

function findLatestRunId(root) {
  try {
    const dirs = fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((n) => /^\d{8}-\d{6}-[0-9a-f]{6}$/.test(n))
      .sort();
    return dirs.at(-1) ?? null;
  } catch {
    return null;
  }
}

/**
 * Foreground wrapper: acquire lock, fork detached child, print run-id.
 *
 * @param {object} opts
 * @param {string} opts.url
 * @param {string|null} opts.apiKey
 * @param {"user"|"project"} opts.scope
 * @param {string} opts.projectRoot
 * @param {string} opts.scriptPath       Absolute path to create-meko-setup.mjs.
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.noExtract]
 * @param {boolean} [opts.force]
 * @param {number}  [opts.rate]
 * @param {boolean} [opts.nonInteractive]  Set by callers that lack a TTY
 *                                         (e.g. --yes, CI). Skips prompts.
 * @param {string|null} [opts.datapack]    Raw `--datapack` value (UUID or
 *                                         name). Resolved against the server
 *                                         before the lock is taken so a typo
 *                                         fails fast.
 * @returns {Promise<{ok: boolean, runId?: string, message: string}>}
 */
export async function startMigration(opts) {
  // Real runs scope state by destination datapack so switching datapacks
  // doesn't falsely flag every session as already-done. Two layers:
  //   - URL-derived key: stable enough for the default flow (cloud URLs
  //     already encode the default datapack UUID in their hostname; see
  //     issue #45 for the regression that motivated URL scoping).
  //   - When --datapack is explicit and resolves to a real id, scope by
  //     that id instead. Same URL + different --datapack values land in
  //     different state files, so an alt-pack run after a default-pack
  //     run doesn't silently skip every session marked done by the first.
  // Until preflight runs we only have the URL-derived key; that's enough
  // for the dry-run branch and for sizing P.root / P.lockPath, which
  // don't move when the state key changes.
  const urlDatapackKey = datapackKeyFromUrl(opts.url);
  let P = paths({ datapackKey: urlDatapackKey });
  fs.mkdirSync(P.root, { recursive: true });

  // Dry-run is a local-only planning pass: no HTTP, no lock, no fork.
  // Don't gate it on URL/apiKey.
  if (opts.dryRun) {
    const runId = generateRunId();
    const runDir = P.runDir(runId);
    const summary = await runMigration({
      url: opts.url ?? "",
      apiKey: opts.apiKey ?? null,
      runId,
      scope: opts.scope,
      projectCwd: opts.projectRoot,
      runDir,
      statePath: P.statePath,
      lockPath: P.lockPath,
      dryRun: true,
      noExtract: opts.noExtract,
      concurrency: opts.rate,
    });
    const s = summary.summary;
    const planned = s.plannedCalls ?? {};
    // Dry-run never opens an MCP session, so we can't resolve names→UUIDs
    // here. Echo what the user asked for; the real run will resolve and
    // print the canonical destination before doing any work.
    const destLine = opts.datapack
      ? `  Destination datapack: ${opts.datapack} (will be resolved at run time)\n`
      : "  Destination datapack: server default (will be resolved at run time)\n";
    return {
      ok: summary.ok,
      runId,
      message:
        (opts.url ? "" : "(no --url provided — planning only)\n") +
        `Dry run:\n` +
        destLine +
        `  Claude Code sessions: ${s.claudeSessions}\n` +
        `  Cursor sessions:      ${s.cursorSessions}\n` +
        `  Paired user↔asst turns: ${s.pairedTurns}\n` +
        `  Memory items (MD):    ${s.memoryItems}\n` +
        `  Planned MCP calls:\n` +
        `    conversation_create:      ${planned.conversation_create ?? 0}\n` +
        `    conversation_add_message: ${planned.conversation_add_message ?? 0}\n` +
        `    memory_add (messages=):   ${planned.memory_add_messages ?? 0}\n` +
        `    memory_add (text=):       ${planned.memory_add_text ?? 0}\n` +
        `    total:                    ${planned.total ?? 0}`,
    };
  }

  // Real run — now URL/apiKey are required (dry-run branch already returned).
  if (!opts.url) {
    return { ok: false, message: "--url (or MEKO_MCP_URL) is required for --migrate." };
  }
  if (!opts.apiKey && !isLocalUrl(opts.url)) {
    return { ok: false, message: "--api-key (or MEKO_API_KEY) is required for cloud --migrate." };
  }

  // Pre-flight: resolve the destination datapack *before* taking the lock or
  // forking the child. A typo in --datapack should fail fast with a useful
  // error, not after the child has spun up. We open a short-lived MCP client
  // here purely for the datapack_list call; the child opens its own session.
  // The resolved id isn't persisted into passthrough — the child re-resolves,
  // which costs one extra cheap read but keeps the wire-level routing
  // logic in a single place.
  const preflight = await preflightDatapack({
    url: opts.url,
    apiKey: opts.apiKey,
    requested: opts.datapack ?? null,
  });
  if (!preflight.ok) {
    return { ok: false, message: preflight.message };
  }
  const datapackBanner = formatDatapackBanner(preflight, opts.datapack ?? null);

  // Now that we know the resolved destination, pick the state key. An
  // explicit --datapack that resolved to an id wins so two runs against
  // the same URL but different packs get separate resume state files.
  // Default flows (no --datapack) keep the URL-derived key for back-compat
  // with checkpoints written before this PR.
  const stateKey = stateKeyFor({
    urlDatapackKey,
    requested: opts.datapack ?? null,
    resolvedId: preflight.id ?? null,
    defaultId: preflight.defaultId ?? null,
  });
  P = paths({ datapackKey: stateKey });

  // Back-compat for the legacy global `state.json`. This prompt has to run
  // in the foreground wrapper because the detached child has no TTY. The
  // non-interactive branch accepts silently, matching the behavior of
  // `runChildMigration` (which is the path exercised by already-started
  // runs with pre-existing state/).
  try {
    await migrateLegacyStateIfNeeded({
      P,
      datapackKey: stateKey,
      interactive: !opts.nonInteractive && Boolean(process.stdin.isTTY),
    });
  } catch { /* best effort; child path will retry non-interactively */ }

  // Reserve the lock slot in the foreground so a concurrent --migrate fails
  // fast. We use a two-step dance: first, O_EXCL-create the lock with the
  // foreground PID (just to claim the slot), then — after spawning the
  // child — rewrite it in place with the child's PID. The orchestrator in
  // the child is told the lock is already held so it doesn't try to
  // re-acquire (which would self-deadlock, since it would see its own PID
  // as a live holder).
  const runId = generateRunId();
  const acq = lockfile.acquire(P.lockPath, { runId }, { force: opts.force });
  if (!acq.acquired) {
    return {
      ok: false,
      message:
        `Another migration is running (pid=${acq.holder?.pid}, run-id=${acq.holder?.runId}). ` +
        `Use --migrate-status, --migrate-stop, or --force to override.`,
    };
  }

  fs.mkdirSync(P.runDir(runId), { recursive: true });
  fs.writeFileSync(
    path.join(P.runDir(runId), "cmd.json"),
    JSON.stringify(
      {
        runId,
        scope: opts.scope,
        url: opts.url,
        // urlDatapackKey records the key derived from the URL alone (issue
        // #45 layout); stateKey is the actual on-disk file scope for this
        // run, which may differ when --datapack is explicit. The child
        // reads stateKey out of this file to land on the same path.
        urlDatapackKey,
        stateKey,
        datapackKey: stateKey,  // back-compat alias for older readers
        datapackRequested: opts.datapack ?? null,
        datapackResolvedId: preflight.id ?? null,
        datapackResolvedName: preflight.name ?? null,
        datapackSource: preflight.source,
        apiKeyPresent: !!opts.apiKey,
        projectRoot: opts.projectRoot,
        noExtract: !!opts.noExtract,
        force: !!opts.force,
        rate: opts.rate ?? null,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  const passthrough = ["--scope", opts.scope, "--url", opts.url];
  if (opts.noExtract) passthrough.push("--no-extract");
  if (opts.force) passthrough.push("--force");
  if (opts.rate) passthrough.push("--rate", String(opts.rate));
  if (opts.datapack) passthrough.push("--datapack", String(opts.datapack));

  const env = { ...process.env };
  if (opts.apiKey) env.MEKO_API_KEY = opts.apiKey;

  const pid = forkDetached({
    scriptPath: opts.scriptPath,
    runId,
    args: passthrough,
    logFilePath: P.logFile(runId),
    env,
    cwd: opts.projectRoot,
  });

  // Hand lock ownership to the child. The rewrite is the same file that
  // was O_EXCL-created above, so no race with a competing --migrate.
  try {
    fs.writeFileSync(
      P.lockPath,
      JSON.stringify({ pid, runId, startedAt: new Date().toISOString() }),
    );
  } catch { /* best effort */ }

  return {
    ok: true,
    runId,
    message:
      `${datapackBanner}\n` +
      `Migration started. run-id=${runId}, pid=${pid}\n` +
      `Logs:   ${P.logFile(runId)}\n` +
      `Status: ${selfInvocation()} --migrate-status`,
  };
}

/**
 * Open a short-lived MCP client and resolve --datapack before the lock is
 * taken. Surfacing this synchronously means a typo in --datapack fails with
 * a clear, actionable message before the user ever sees a `run-id`.
 *
 * @param {object} opts
 * @param {string} opts.url
 * @param {string|null} opts.apiKey
 * @param {string|null} opts.requested
 * @returns {Promise<{ok:boolean, id?:string|null, name?:string|null, source?:string, message?:string}>}
 */
async function preflightDatapack({ url, apiKey, requested }) {
  const client = new McpClient({ url, apiKey, concurrency: 1 });
  try {
    await client.connect();
  } catch (err) {
    return {
      ok: false,
      message:
        `Could not connect to MCP server to resolve --datapack: ${err.message}.`,
    };
  }
  const resolved = await resolveDestinationDatapack({ client, requested });
  if (!resolved.ok) {
    return { ok: false, message: resolved.message };
  }
  return {
    ok: true,
    id: resolved.id ?? null,
    name: resolved.name ?? null,
    source: resolved.source,
    defaultId: resolved.defaultId ?? null,
  };
}

/**
 * Format the one-line "Migrating to ..." banner printed before the child
 * forks. Distinguishes the four cases so a misconfigured tenant (no default
 * row) is visible rather than silent.
 */
function formatDatapackBanner(preflight, requested) {
  const id = preflight.id ?? null;
  const name = preflight.name ?? null;
  if (preflight.source === "default") {
    return `Migrating to default datapack: ${name} (${id})`;
  }
  if (preflight.source === "server-fallback") {
    return (
      `Migrating to default datapack (server-resolved at runtime — no ` +
      `'meko_default_datapack' row visible to this API key).`
    );
  }
  // flag-id or flag-name
  const label = name ?? requested ?? "(unknown)";
  return `Migrating to datapack: ${label} (${id ?? "unknown id"}) [explicit]`;
}

/**
 * Invoked by the detached child via bin/create-meko-setup.mjs.
 *
 * The foreground wrapper has already taken the lock and written the
 * child's PID into it; we MUST NOT re-acquire (that would self-deadlock
 * because lockfile.isStale(our-own-pid) returns false).
 *
 * @param {object} opts
 * @param {string} opts.runId
 * @param {"user"|"project"} opts.scope
 * @param {string} opts.url
 * @param {string|null} opts.apiKey
 * @param {string} opts.projectRoot
 * @param {boolean} [opts.noExtract]
 * @param {boolean} [opts.force]
 * @param {number} [opts.rate]
 * @param {string|null} [opts.datapack]   Forwarded `--datapack` value.
 * @returns {Promise<number>}  Exit code.
 */
export async function runChildMigration(opts) {
  // The foreground wrapper picked the state key — possibly differently from
  // the URL-only derivation when --datapack overrode the destination — and
  // recorded it in cmd.json. Read that back so child writes land in the
  // same state file the foreground would have used. The cmd.json runDir
  // doesn't depend on the state key so we can locate it from the URL key.
  const urlDatapackKey = datapackKeyFromUrl(opts.url);
  const cmdRunDir = paths({ datapackKey: urlDatapackKey }).runDir(opts.runId);
  let stateKey = urlDatapackKey;
  try {
    const cmd = JSON.parse(fs.readFileSync(path.join(cmdRunDir, "cmd.json"), "utf8"));
    if (cmd && typeof cmd.stateKey === "string" && cmd.stateKey) {
      stateKey = cmd.stateKey;
    }
  } catch { /* no cmd.json (test entry / older foreground) → URL key. */ }

  const P = paths({ datapackKey: stateKey });
  const runDir = P.runDir(opts.runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(P.stateDir, { recursive: true });

  const log = createLogger(path.join(runDir, "log.ndjson"), { runId: opts.runId });

  // Back-compat: if `state/` is empty but the legacy `state.json` exists,
  // copy it into `state/<datapackKey>.json` so this run resumes off the
  // same checkpoints. CI / --yes path accepts silently; the detached child
  // has no TTY anyway, so we always take the non-interactive branch here.
  // (Interactive prompting, when introduced, happens in startMigration().)
  try {
    // The NDJSON `legacy_state_migrated` entry emitted via onWarning is the
    // audit trail; we intentionally don't bump prog.counts.warnings here
    // because the orchestrator owns that counter.
    await migrateLegacyStateIfNeeded({
      P,
      datapackKey: stateKey,
      interactive: false,
      onWarning: (entry) => {
        log.warn("legacy_state_migrated", entry);
      },
    });
  } catch (err) {
    log.warn("legacy_state_migrate_failed", { error: err.message });
  }

  let shuttingDown = false;
  const onSignal = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.warn("interrupted", { signal: sig });
    try { lockfile.release(P.lockPath); } catch { /* ignore */ }
    log.close();
    process.exit(130);
  };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));

  try {
    const result = await runMigration({
      url: opts.url,
      apiKey: opts.apiKey,
      runId: opts.runId,
      scope: opts.scope,
      projectCwd: opts.projectRoot,
      runDir,
      statePath: P.statePath,
      lockPath: P.lockPath,
      noExtract: opts.noExtract,
      force: opts.force,
      lockAlreadyHeld: true,
      concurrency: opts.rate,
      datapack: opts.datapack ?? null,
    });
    log.info("child_done", result.summary);
    log.close();
    try { lockfile.release(P.lockPath); } catch { /* ignore */ }
    return result.ok ? 0 : 1;
  } catch (err) {
    log.error("child_crashed", { error: err.message, stack: err.stack });
    log.close();
    try { lockfile.release(P.lockPath); } catch { /* ignore */ }
    return 1;
  }
}

/**
 * Print and return the status of the latest (or requested) migration run.
 *
 * @param {object} opts
 * @param {string} [opts.runId]
 * @returns {{ok: boolean, runId: string|null, progress: object|null, message: string}}
 */
export function readStatus(opts = {}) {
  const P = paths();
  const runId = opts.runId ?? findLatestRunId(P.root);
  if (!runId) {
    return { ok: false, runId: null, progress: null, message: "No migration runs found." };
  }
  const prog = progress.read(P.progressFile(runId));
  if (!prog) {
    return { ok: false, runId, progress: null, message: `No progress file for run-id=${runId}.` };
  }

  // Fish the datapack key out of cmd.json if the run recorded one. Older runs
  // (from before per-datapack scoping) don't have this field, in which case
  // we print `(legacy)` to flag that its resume state is under the global
  // `state.json`, not `state/<key>.json`.
  let datapackKeyLabel = "(legacy)";
  // The destination datapack (where the migration writes) is independent of
  // the resume-state key (where checkpoints are stored on disk). Older runs
  // didn't record this; show "-" for them.
  let datapackTargetLabel = "-";
  try {
    const cmd = JSON.parse(
      fs.readFileSync(path.join(P.runDir(runId), "cmd.json"), "utf8"),
    );
    if (cmd && typeof cmd.datapackKey === "string" && cmd.datapackKey) {
      datapackKeyLabel = cmd.datapackKey;
    }
    if (cmd) {
      const id = cmd.datapackResolvedId ?? null;
      const name = cmd.datapackResolvedName ?? null;
      const requested = cmd.datapackRequested ?? null;
      const source = cmd.datapackSource ?? null;
      if (source === "server-fallback") {
        datapackTargetLabel = "(server default)";
      } else if (id || name) {
        const tag = source === "default" ? "default" : "explicit";
        datapackTargetLabel = `${name ?? "(unknown)"} (${id ?? "?"}) [${tag}]`;
      } else if (requested) {
        datapackTargetLabel = `${requested} (unresolved)`;
      }
    }
  } catch {
    /* cmd.json missing or unreadable — fall back to legacy label */
  }

  // Gray annotations next to each field. Keeps the output self-documenting
  // without forcing the reader to cross-reference README docs for common
  // fields. Respects NO_COLOR.
  const useColor = !process.env.NO_COLOR;
  const GRAY = useColor ? "\x1b[90m" : "";
  const RESET = useColor ? "\x1b[0m" : "";
  const note = (s) => (s ? `  ${GRAY}${s}${RESET}` : "");

  const lines = [
    `run-id:       ${prog.runId}`,
    `status:       ${prog.status}${note("(pending → running → done | failed | stopped)")}`,
    `scope:        ${prog.scope}`,
    `datapack:     ${datapackKeyLabel}${note("(resume state lives under state/<key>.json)")}`,
    `target pack:  ${datapackTargetLabel}${note("(ingestion destination resolved at run start)")}`,
    `started:      ${prog.startedAt}`,
    `finished:     ${prog.finishedAt ?? "(in progress)"}`,
    `current:      ${prog.currentAgent ?? "-"} / ${prog.currentSession ?? "-"}${note("(<adapter>:<source-session> / <message-id>)")}`,
    `sessions:     ${prog.counts.sessionsDone} / ${prog.counts.sessionsPlanned}${note("(processed / discovered)")}`,
    `messages:     ${prog.counts.messagesSent}`,
    `memory pairs: ${prog.counts.memoryPairsSent}${note("(memory_add from Mem0 extractor)")}`,
    `memory (MD):  ${prog.counts.memoriesFromMD}${note("(memory_add from CLAUDE.md / memory files)")}`,
    `warnings:     ${prog.counts.warnings}${note("(non-fatal; run continues)")}`,
    `memory errs:  ${prog.counts.memoryErrors}${note("(failed memory_add calls; re-run with --force to retry)")}`,
  ];
  return { ok: true, runId, progress: prog, message: lines.join("\n") };
}

/**
 * SIGTERM the holder, wait briefly, SIGKILL. Best-effort.
 *
 * @returns {{ok: boolean, message: string}}
 */
export async function stopMigration() {
  const P = paths();
  const holder = lockfile.read(P.lockPath);
  if (!holder) return { ok: false, message: "No migration lock found." };
  if (lockfile.isStale(holder)) {
    try { lockfile.release(P.lockPath); } catch { /* ignore */ }
    return { ok: true, message: `Stale lock removed (pid=${holder.pid}).` };
  }
  try {
    process.kill(holder.pid, "SIGTERM");
  } catch (err) {
    return { ok: false, message: `Failed to signal pid=${holder.pid}: ${err.message}` };
  }

  // Wait up to 2s.
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    if (lockfile.isStale(lockfile.read(P.lockPath) ?? holder)) {
      return { ok: true, message: `Stopped pid=${holder.pid} (run-id=${holder.runId}).` };
    }
  }

  try {
    process.kill(holder.pid, "SIGKILL");
  } catch { /* ignore */ }
  try { lockfile.release(P.lockPath); } catch { /* ignore */ }
  return {
    ok: true,
    message: `Force-killed pid=${holder.pid} (run-id=${holder.runId}).`,
  };
}

function isLocalUrl(url) {
  return /localhost|127\.0\.0\.1/.test(url ?? "");
}
