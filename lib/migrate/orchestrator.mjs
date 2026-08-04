/**
 * orchestrator.mjs — Drives a migration run end-to-end.
 *
 * Reads state, acquires a lock, enumerates sources, walks the MCP tools,
 * flushes progress/state, and returns a summary. All I/O goes through
 * the lower-level modules (`state`, `progress`, `lockfile`, `mcp-client`).
 */

import path from "node:path";
import fs from "node:fs";
import * as state from "./state.mjs";
import * as progress from "./progress.mjs";
import * as lockfile from "./lockfile.mjs";
import { McpClient } from "./mcp-client.mjs";
import { createLogger, nullLogger } from "./logger.mjs";
import { seedFor } from "./id.mjs";
import { resolveDestinationDatapack } from "./datapack.mjs";
import * as claudeCodeAdapter from "./adapters/claude-code.mjs";
import * as cursorAdapter from "./adapters/cursor.mjs";
import * as memoryMdAdapter from "./adapters/memory-md.mjs";

/**
 * @param {object} opts
 * @param {string} opts.url
 * @param {string|null} opts.apiKey
 * @param {string} opts.runId
 * @param {"user"|"project"} opts.scope
 * @param {string} opts.projectCwd
 * @param {string} opts.runDir
 * @param {string} opts.statePath
 * @param {string} opts.lockPath
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.noExtract]
 * @param {boolean} [opts.force]              Bypass state-level skip-if-done.
 * @param {boolean} [opts.lockAlreadyHeld]    Caller (e.g. detached child) says the lock is already owned by this process; skip acquire.
 * @param {number}  [opts.concurrency]
 * @param {string}  [opts.home]
 * @param {string|null} [opts.datapack]       Raw `--datapack` value (UUID or
 *                                            name). Resolved against the
 *                                            server before any writes; the
 *                                            resolved id is then injected
 *                                            into every tool call so the
 *                                            destination is explicit on the
 *                                            wire rather than relying on the
 *                                            server's tenant-context fallback.
 * @returns {Promise<{ok: boolean, summary: object, counts: object}>}
 */
export async function runMigration(opts) {
  fs.mkdirSync(opts.runDir, { recursive: true });

  const log = opts.dryRun
    ? nullLogger()
    : createLogger(path.join(opts.runDir, "log.ndjson"), { runId: opts.runId });

  const prog = progress.initial(opts.runId, opts.scope);
  const progressPath = path.join(opts.runDir, "progress.json");
  const writeProgress = () => {
    try { progress.write(progressPath, prog); } catch { /* best effort */ }
  };

  let st = state.load(opts.statePath);
  let opsSinceFlush = 0;
  const FLUSH_EVERY = 25;
  const flushState = () => {
    try { state.save(opts.statePath, st); } catch { /* best effort */ }
    opsSinceFlush = 0;
  };

  // Lock acquisition. On the production path the detached-child runner has
  // already marked the lock with its own PID, so we MUST NOT try to acquire
  // again — that would self-deadlock. Tests that call runMigration()
  // directly default to acquiring here.
  let lockAcquiredHere = false;
  if (!opts.dryRun && !opts.lockAlreadyHeld) {
    const acq = lockfile.acquire(opts.lockPath, { runId: opts.runId }, { force: opts.force });
    if (!acq.acquired) {
      log.error("lock_busy", { holder: acq.holder });
      return { ok: false, summary: { error: "lock_busy", holder: acq.holder }, counts: prog.counts };
    }
    lockAcquiredHere = true;
  }

  // Plan the work.
  const claudeSessions = await claudeCodeAdapter.listSessions({
    scope: opts.scope,
    projectCwd: opts.projectCwd,
    home: opts.home,
  });
  const cursorSessions = cursorAdapter.listSessions({
    scope: opts.scope,
    projectCwd: opts.projectCwd,
    home: opts.home,
  });
  const memoryItems = await memoryMdAdapter.enumerateMemoryItems({
    scope: opts.scope,
    projectCwd: opts.projectCwd,
    home: opts.home,
  });

  prog.counts.sessionsPlanned = claudeSessions.length + cursorSessions.length;
  writeProgress();

  log.info("plan", {
    scope: opts.scope,
    claudeSessions: claudeSessions.length,
    cursorSessions: cursorSessions.length,
    memoryItems: memoryItems.length,
    dryRun: !!opts.dryRun,
    noExtract: !!opts.noExtract,
  });

  if (opts.dryRun) {
    // Peek-parse every session so we can report planned turn counts and
    // the total expected MCP call volume — helps users estimate
    // LLM-extraction cost before firing a real run.
    let pairedTurns = 0;
    for (const ref of claudeSessions) {
      const parsed = await claudeCodeAdapter.parseSession(ref.path);
      pairedTurns += parsed.exchanges.length;
    }
    for (const ref of cursorSessions) {
      const parsed = cursorAdapter.parseSession(ref.path);
      pairedTurns += parsed.exchanges.length;
    }
    const plannedConversationCreates = claudeSessions.length + cursorSessions.length
      + (memoryItems.length > 0 ? countDistinctMemoryAgents(memoryItems) : 0);
    const plannedConversationAddMessage = pairedTurns;
    const plannedMemoryAddExtract = opts.noExtract ? 0 : pairedTurns;
    const plannedMemoryAddText = memoryItems.length;

    const summary = {
      scope: opts.scope,
      claudeSessions: claudeSessions.length,
      cursorSessions: cursorSessions.length,
      memoryItems: memoryItems.length,
      pairedTurns,
      plannedCalls: {
        conversation_create: plannedConversationCreates,
        conversation_add_message: plannedConversationAddMessage,
        memory_add_messages: plannedMemoryAddExtract,
        memory_add_text: plannedMemoryAddText,
        total:
          plannedConversationCreates +
          plannedConversationAddMessage +
          plannedMemoryAddExtract +
          plannedMemoryAddText,
      },
    };
    return { ok: true, summary, counts: prog.counts };
  }

  // Open MCP client.
  const client = new McpClient({
    url: opts.url,
    apiKey: opts.apiKey,
    concurrency: opts.concurrency ?? 4,
    log,
  });

  try {
    await client.connect();
    log.info("mcp_connected", { sessionId: client.sessionId });
  } catch (err) {
    log.error("mcp_connect_failed", { error: err.message, code: err.statusCode });
    releaseLock();
    prog.status = "failed";
    prog.finishedAt = new Date().toISOString();
    writeProgress();
    return { ok: false, summary: { error: "mcp_connect_failed", detail: err.message }, counts: prog.counts };
  }

  // Resolve --datapack against the live datapack_list so every subsequent
  // tools/call carries an explicit datapack_id. Without this we'd be silently
  // relying on the server's tenant-context default — fine when it's correct,
  // invisible when it isn't.
  let datapackId = null;
  try {
    const resolved = await resolveDestinationDatapack({
      client,
      requested: opts.datapack ?? null,
    });
    if (!resolved.ok) {
      log.error("resolve_datapack_failed", { message: resolved.message });
      releaseLock();
      prog.status = "failed";
      prog.finishedAt = new Date().toISOString();
      writeProgress();
      return {
        ok: false,
        summary: { error: "resolve_datapack_failed", detail: resolved.message },
        counts: prog.counts,
      };
    }
    datapackId = resolved.id ?? null;
    log.info("migration_target", {
      requested: opts.datapack ?? null,
      resolvedId: resolved.id ?? null,
      resolvedName: resolved.name ?? null,
      source: resolved.source,
    });
  } catch (err) {
    log.error("resolve_datapack_threw", { error: err.message });
    releaseLock();
    prog.status = "failed";
    prog.finishedAt = new Date().toISOString();
    writeProgress();
    return {
      ok: false,
      summary: { error: "resolve_datapack_threw", detail: err.message },
      counts: prog.counts,
    };
  }

  // Injects datapack_id into every tools/call args object when set. When
  // resolution fell into 'server-fallback' (no row matched), datapackId is
  // null and we omit the key entirely so the server's own fallback chain
  // still applies — the migration would otherwise fail before doing any work.
  const withDp = (args) => (datapackId ? { ...args, datapack_id: datapackId } : args);

  // -- Conversations --
  for (const ref of [...claudeSessions, ...cursorSessions]) {
    let existing = state.getSession(st, ref.agentId, ref.sessionUuid);
    if (existing?.status === "done" && !opts.force) {
      log.info("session_skip_done", { agentId: ref.agentId, sessionUuid: ref.sessionUuid });
      prog.counts.sessionsDone++;
      writeProgress();
      continue;
    }
    // --force re-ingests: wipe resume state so we don't skip messages.
    if (existing && opts.force) {
      state.markSession(st, ref.agentId, ref.sessionUuid, {
        status: "pending",
        messagesSent: 0,
        memoryPairsSent: 0,
        lastUuid: null,
        completedAt: null,
        lastError: null,
      });
      existing = state.getSession(st, ref.agentId, ref.sessionUuid);
    }

    prog.currentAgent = ref.agentId;
    prog.currentSession = ref.sessionUuid;
    writeProgress();

    const parsed = (ref.path && ref.path.endsWith(".jsonl"))
      ? await claudeCodeAdapter.parseSession(ref.path)
      : cursorAdapter.parseSession(ref.path);

    if (parsed.partial) {
      log.warn("session_partial", { path: ref.path });
    }

    // Ensure a conversation_id exists.
    let conversationId = existing?.conversationId || "";
    if (!conversationId) {
      const createRes = await safeCall(client, "conversation_create", withDp({
        scope: "write",
        agent_id: ref.agentId,
        session_id: ref.sessionUuid,
        title: (parsed.firstUserText || ref.sessionUuid).slice(0, 120),
        metadata: JSON.stringify({
          source: ref.path.endsWith(".jsonl") ? "claude-code" : "cursor",
          cwd: ref.cwd || null,
          gitBranch: ref.slug ? (parsed.gitBranch || null) : null,
          startedAt: parsed.startedAt || null,
        }),
      }), log);

      if (!createRes.ok) {
        log.error("conversation_create_failed", { agentId: ref.agentId, sessionUuid: ref.sessionUuid, error: createRes.error?.message });
        state.markSession(st, ref.agentId, ref.sessionUuid, {
          status: "failed",
          lastError: createRes.error?.message ?? "conversation_create failed",
        });
        prog.counts.warnings++;
        if (++opsSinceFlush >= FLUSH_EVERY) flushState();
        writeProgress();
        continue;
      }

      conversationId = extractId(createRes.text) || "";
      state.markSession(st, ref.agentId, ref.sessionUuid, {
        conversationId,
        status: "partial",
      });
      if (++opsSinceFlush >= FLUSH_EVERY) flushState();
    }

    // Replay turns.
    let messagesSent = existing?.messagesSent ?? 0;
    let memoryPairsSent = existing?.memoryPairsSent ?? 0;
    let lastUuid = existing?.lastUuid ?? null;

    // Resume from lastUuid if present.
    let skipping = !!lastUuid;
    for (const ex of parsed.exchanges) {
      if (skipping) {
        if (ex.user_uuid === lastUuid) skipping = false;
        continue;
      }
      const seed = seedFor(ref.agentId, ref.sessionUuid, ex.user_uuid);

      // (a) conversation_add_message — fire-and-forget; server batches.
      const addMsgPromise = client.callTool("conversation_add_message", withDp({
        scope: "write",
        conversation_id: conversationId,
        agent_id: ref.agentId,
        input: ex.input,
        output: ex.output,
        reasoning: ex.reasoning || undefined,
        seed,
        metadata: JSON.stringify({
          source: "migrate",
          sessionUuid: ref.sessionUuid,
          userUuid: ex.user_uuid,
          timestamp: ex.timestamp,
        }),
      }), { fireAndForget: true });

      // (b) memory_add(messages=...) — invokes Mem0 extractor server-side.
      let memPromise = Promise.resolve(null);
      if (!opts.noExtract && (ex.input || ex.output)) {
        memPromise = client.callTool("memory_add", withDp({
          scope: "write",
          agent_id: ref.agentId,
          conversation_id: conversationId,
          messages: [
            { role: "user", content: ex.input || "" },
            { role: "assistant", content: ex.output || "" },
          ],
          metadata: JSON.stringify({
            source: "migrate",
            sessionUuid: ref.sessionUuid,
            userUuid: ex.user_uuid,
            cwd: ref.cwd || null,
          }),
        }), { fireAndForget: true });
      }

      const [, memRes] = await Promise.all([addMsgPromise, memPromise]);
      messagesSent++;
      if (!opts.noExtract) {
        if (memRes && memRes.ok && !isErrorText(memRes.text)) {
          memoryPairsSent++;
          prog.counts.memoryPairsSent++;
        } else if (memRes) {
          prog.counts.memoryErrors++;
          log.warn("memory_add_failed", {
            agentId: ref.agentId,
            sessionUuid: ref.sessionUuid,
            userUuid: ex.user_uuid,
            detail: errorDetail(memRes),
          });
        }
      }
      lastUuid = ex.user_uuid;
      prog.counts.messagesSent++;

      state.markSession(st, ref.agentId, ref.sessionUuid, {
        conversationId,
        status: "partial",
        messagesSent,
        memoryPairsSent,
        lastUuid,
      });
      if (++opsSinceFlush >= FLUSH_EVERY) flushState();
      writeProgress();
    }

    state.markSession(st, ref.agentId, ref.sessionUuid, {
      conversationId,
      status: parsed.partial ? "partial" : "done",
      messagesSent,
      memoryPairsSent,
      lastUuid,
      completedAt: new Date().toISOString(),
      lastError: null,
    });
    flushState();
    if (!parsed.partial) prog.counts.sessionsDone++;
    writeProgress();
    log.info("session_done", {
      agentId: ref.agentId,
      sessionUuid: ref.sessionUuid,
      messagesSent,
      memoryPairsSent,
      partial: parsed.partial,
    });
  }

  // -- Memory MD files --
  const umbrellaPerAgent = new Map();
  for (const item of memoryItems) {
    if (state.isMemoryDone(st, item.agentId, item.hash) && !opts.force) continue;

    let convId = umbrellaPerAgent.get(item.agentId);
    if (!convId) {
      const existingUmbrella = state.ensureAgent(st, item.agentId).memoryConversationId;
      if (existingUmbrella) {
        convId = existingUmbrella;
      } else {
        const res = await safeCall(client, "conversation_create", withDp({
          scope: "write",
          agent_id: item.agentId,
          title: "memory-migration",
          metadata: JSON.stringify({ source: "migrate", purpose: "memory-umbrella" }),
        }), log);
        if (!res.ok) {
          log.error("memory_umbrella_failed", { agentId: item.agentId, error: res.error?.message });
          prog.counts.warnings++;
          continue;
        }
        convId = extractId(res.text) || "";
        state.ensureAgent(st, item.agentId).memoryConversationId = convId;
      }
      umbrellaPerAgent.set(item.agentId, convId);
    }

    const res = await client.callTool("memory_add", withDp({
      scope: "write",
      agent_id: item.agentId,
      conversation_id: convId,
      text: item.text,
      metadata: JSON.stringify(item.metadata),
    }), { fireAndForget: true });

    if (res.ok && !isErrorText(res.text)) {
      state.markMemory(st, item.agentId, item.hash, {
        memoryId: extractId(res.text) || "",
        name: item.name,
        addedAt: new Date().toISOString(),
      });
      prog.counts.memoriesFromMD++;
    } else {
      prog.counts.memoryErrors++;
      log.warn("memory_md_failed", {
        agentId: item.agentId,
        name: item.name,
        error: res.error?.message,
        detail: errorDetail(res),
      });
    }
    if (++opsSinceFlush >= FLUSH_EVERY) flushState();
    writeProgress();
  }

  flushState();
  prog.status = "done";
  prog.finishedAt = new Date().toISOString();
  prog.currentAgent = null;
  prog.currentSession = null;
  writeProgress();

  st.runs.push({
    runId: opts.runId,
    startedAt: prog.startedAt,
    finishedAt: prog.finishedAt,
    scope: opts.scope,
    status: "done",
    counts: prog.counts,
  });
  flushState();

  log.info("done", { summary: prog.counts });
  log.close();
  releaseLock();

  return { ok: true, summary: prog.counts, counts: prog.counts };

  function releaseLock() {
    if (lockAcquiredHere) {
      try { lockfile.release(opts.lockPath); } catch { /* ignore */ }
    }
  }
}

/**
 * How many umbrella memory-migration conversations the real run would open.
 */
function countDistinctMemoryAgents(items) {
  const set = new Set();
  for (const item of items) set.add(item.agentId);
  return set.size;
}

/**
 * Call a tool with basic error-surfacing. Does not retry beyond the
 * client's own retry logic. Returns `{ok: boolean, text?: string, error?: any}`.
 */
async function safeCall(client, name, args, log) {
  try {
    return await client.callTool(name, args);
  } catch (err) {
    log.error("mcp_call_threw", { tool: name, error: err.message });
    return { ok: false, error: { message: err.message } };
  }
}

/**
 * Meko tools return JSON text in their content blocks. Parse that and
 * return an `id` field if present.
 */
function extractId(text) {
  if (!text) return null;
  try {
    const obj = JSON.parse(text);
    return obj.id || obj.conversation_id || obj.memory_id || null;
  } catch {
    return null;
  }
}

/**
 * The MCP transport returns `{ok:true}` whenever the HTTP call itself
 * succeeded, even if the tool's body encoded a failure. memory_add in
 * older server builds returned plain "Error adding memory: ..." strings
 * on exception; newer builds return JSON `{"error":"memory_add_failed",...}`.
 * Either way, the text content is the authoritative success signal.
 */
function isErrorText(text) {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.startsWith("Error adding memory")) return true;
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === "object" && obj.error) return true;
    } catch { /* not JSON; fall through */ }
  }
  return false;
}

function errorDetail(res) {
  if (!res) return null;
  if (res.error?.message) return res.error.message;
  if (!res.text) return null;
  try {
    const obj = JSON.parse(res.text);
    if (obj?.error) return obj.detail || obj.error;
  } catch { /* not JSON */ }
  return res.text.slice(0, 200);
}
