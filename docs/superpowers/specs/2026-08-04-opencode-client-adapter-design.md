# opencode client adapter — design

## Context

`@yugabytedb/meko-mcp` is an npm-published installer CLI (`create-meko-setup` /
`meko-mcp`) that wires up the Meko memory MCP server for AI coding clients. It
is not the MCP server itself — it registers the server in each client's
config, installs session-lifecycle hooks that capture conversation history
into Meko, drops in "skill" instructions that tell the agent how to use the
Meko tools, and validates the result. It already supports four clients
through a uniform adapter interface: `claude-code`, `claude-desktop`,
`cursor`, `codex`.

This repo is seeded from the published npm package (v2.1.0) because the
upstream source repo (`yugabyte/meko-mcp-server`) is not public — see the
README's fork note. The goal of this spec is a fifth adapter, `opencode`,
built to the same interface, so `create-meko-setup --client opencode` works
end-to-end against [opencode](https://opencode.ai). If/when upstream access
becomes available, this adapter should be portable back to the real repo with
minimal changes.

## Goals

- `opencode` becomes a valid `--client` value alongside the existing four.
- Full parity with the Codex adapter: MCP registration, memory-capture hooks,
  AGENTS.md skill block, `uninstall`, `validateConfig`, `detectExisting`.
- Both `user` scope (`~/.config/opencode/opencode.json`) and `project` scope
  (`<projectRoot>/opencode.json`) work, since opencode supports both (unlike
  Codex, which is user-scope only).
- Existing adapters (claude-code, claude-desktop, cursor, codex) are
  untouched and their tests keep passing.

## Non-goals (for this pass)

- Publishing to npm / upstreaming to yugabyte — out of reach until repo
  access exists. This spec produces a working adapter in *this* repo only.
- The `--migrate` subcommand (importing historical Claude/Cursor
  conversations) — opencode has no equivalent history to migrate from on day
  one; skip it.
- Statusline integration — Claude Code specific, adapters opt in via an
  optional `installStatusline` method; opencode gets none for now.

## Architecture

Add `lib/clients/opencode.mjs` implementing the same adapter contract every
other client satisfies (confirmed by reading `lib/installer.mjs`, the
orchestrator that drives all adapters identically):

```
id, displayName
settingsPath(scope, projectRoot)
detectPrerequisites({ verbose, log, scope, projectRoot })
isInstalled()
detectExisting(name, { scope, projectRoot })
maybeConfirmOverwrite({ existingFound, name, yes })      // optional
registerServer({ name, url, scope, apiKey, dryRun, verbose, log, projectRoot, yes })
removeRegistration(name, { scope, projectRoot })
setHookEnvironment({ url, apiKey, scope, dryRun, verbose, log, settingsPath, projectRoot })
installSkills({ name, scope, dryRun, verbose, log, projectRoot })  // -> { marketplace, skills }
uninstall({ name, scope, projectRoot, settingsPath })     // -> [{ key, ok, message }]
validateConfig({ serverName, scope, projectRoot, url, apiKey })    // -> { ok, message }
```

Wire it in three places, mirroring how `codex` was added:

- `lib/clients/index.mjs`: `opencode: createOpencodeAdapter()`
- `bin/create-meko-setup.mjs`: add `"opencode"` to `ALL_CLIENTS`, the
  `--client` help text, and the picker's `displayName` map
- `lib/config.mjs`: add opencode path helpers (see below)

No changes to `lib/installer.mjs` — the orchestrator is already fully
generic over the adapter interface.

## Components

### 1. Config paths (`lib/config.mjs`)

```js
export function getOpencodeConfigPath(scope, projectRoot) {
  if (scope === "project") return join(projectRoot, "opencode.json");
  return join(homedir(), ".config", "opencode", "opencode.json");
}
```

opencode also accepts `opencode.jsonc` (JSON-with-comments) at the project
level — confirmed from a real local config (`trip-manager/opencode.jsonc`).
The adapter reads whichever exists (`opencode.json` first, falling back to
`opencode.jsonc`), same tie-break as `.mjs` doesn't need to worry about
comment-stripping since `readJsonFile`/`writeJsonFile` in `config.mjs` are
plain `JSON.parse`/`stringify`. **Open question, verify during
implementation:** if a project only has a `.jsonc` file with real comments,
a naive JSON round-trip will drop them — decide then whether to detect this
case and warn/skip rather than silently strip comments.

### 2. MCP registration

opencode's `mcp` config key is JSON-editable, so this follows the **Cursor**
adapter's approach (direct read/merge/write with a `.bak` backup via
`config.mjs`'s `readJsonFile`/`writeJsonFile`), not Codex's shell-out
approach — no coupling to `opencode` CLI version/flag stability.

Confirmed from a real local `opencode.json`, `type: "local"` MCP entries
look like:

```json
"mcp": {
  "sequential-thinking": {
    "type": "local",
    "command": ["npx", "-y", "@modelcontextprotocol/server-sequential-thinking"],
    "enabled": true
  }
}
```

Meko is a remote HTTP server, so the entry needs `type: "remote"` +
`url` + headers. **Spike before writing this code:** confirm the exact
field name/shape for headers and auth on a remote entry against opencode's
published schema (`https://opencode.ai/config.json`) or `opencode mcp add
--help` (`--header KEY=VALUE`, repeatable) — don't assume it matches
Cursor's `headers: {...}` object shape without checking.

Expected shape (to confirm):

```json
"mcp": {
  "meko": {
    "type": "remote",
    "url": "https://mcp.mekodata.ai/mcp",
    "enabled": true,
    "headers": {
      "User-Agent": "meko-mcp-installer/1.0",
      "Authorization": "Bearer <api-key>"
    }
  }
}
```

`registerServer`/`removeRegistration`/`detectExisting`/`validateConfig` all
follow the Cursor adapter's implementations almost line-for-line, swapped to
this shape.

### 3. Memory-capture hooks — the new mechanism

This is the one piece with no direct opencode equivalent to copy.

**How the other adapters do it:** Claude Code / Cursor / Codex all invoke
shell scripts (`assets/hooks-handlers/*.sh`) on session lifecycle events.
Those scripts shell out to a shared Node script,
`assets/hooks-handlers/lib/capture.js`, which:
- parses a **Claude-Code-shaped JSONL transcript file** on disk
  (`extractExchanges`, `countLines`, line-numbered watermarks) — this half is
  tightly coupled to that transcript format and does not transfer to
  opencode, whose sessions live in a local SQLite DB
  (`~/.local/share/opencode/opencode.db`), not a transcript file.
- talks JSON-RPC to the Meko MCP server (`mcpPost`, `mcpInitialize`,
  `mcpCall`, `createConversation`, `addMessage`, `fetchRecentMemories`) —
  this half is transport-only and has no Claude-specific assumptions baked
  in. Reusable.

**opencode's hook surface** is a JS/TS plugin
(`@opencode-ai/plugin`'s `Plugin`/`Hooks` types), not a shell-invoked
`hooks.json`. Each plugin gets a `PluginInput` including an SDK `client`
(`ReturnType<typeof createOpencodeClient>`) that can query session/message
state directly — no file parsing needed. Relevant hooks confirmed from the
installed SDK's `.d.ts`:

- `event` — generic hook fed the SDK's `Event` union; used to detect session
  lifecycle transitions (session created / idle / etc.) — **spike needed**
  to enumerate the exact `Event` member names and pick which ones map to
  "session start" and "session end", since opencode sessions are long-lived
  and resumable, unlike a single Claude Code CLI invocation.
- `experimental.session.compacting` — a clean 1:1 match for the Codex/Claude
  `PreCompact` hook.
- `tool.execute.before` / `tool.execute.after` — not needed for capture, but
  available if a finer-grained capture trigger turns out to be better than
  the coarse `event` hook.

**Design:** ship a new asset,
`assets/opencode-plugin/meko-memory.mjs`, exporting an opencode `Plugin`
function that returns `Hooks`. It reimplements only what's needed:
- On session start (however that's resolved from `event`/SDK query):
  create/resume a Meko conversation, fetch recent memories, inject them as
  context (mirrors `capture.js`'s `handleSessionStart` at a much smaller
  scope).
- On `experimental.session.compacting`: flush an exchange to Meko before
  context is dropped (mirrors `pre-compact.sh`).
- Periodically / on message updates: append exchanges via `client.session
  .messages(...)` (or whatever the SDK's actual message-listing call turns
  out to be — confirm during implementation) instead of tailing a transcript
  file.

For the transport layer, **port a copy** of the six reusable functions
(`mcpPost`/`mcpInitialize`/`mcpCall`/`createConversation`/`addMessage`/
`fetchRecentMemories`) into the new plugin file rather than extracting a
shared module up front. Rationale: a shared-module refactor touches
`capture.js`, which three working adapters depend on — safer to ship the
opencode adapter as an independent, reviewable unit first, and dedupe later
once the opencode capture path is proven out. Track the dedup as a documented
fast-follow, not a blocker.

**Installation:** `setHookEnvironment` writes the plugin file to a stable
path (mirroring `installStableTree` used by Codex/Cursor to avoid pinning an
ephemeral `npx` cache path) and adds it to `opencode.json`'s `plugin` array
(`Config.plugin: Array<string | [string, PluginOptions]>`, confirmed from
the SDK types) — or drops it into opencode's plugin auto-discovery
directory, if one exists. **Spike needed:** confirm opencode's actual plugin
auto-discovery convention before deciding between "explicit array entry" vs
"drop-in directory".

Env vars (`MEKO_MCP_URL`, `MEKO_API_KEY`) are threaded into the plugin the
same way Cursor does it — an `env` block opencode exposes to plugins, or (if
opencode plugins can't read arbitrary env vars set outside their own
process) baked into the generated plugin file's config at write time. To
confirm during implementation.

### 4. Skill instructions (AGENTS.md)

opencode reads `AGENTS.md` (project root + a global one), the same
convention Codex uses. The Codex adapter's `upsertAgentsMdBlock` /
`removeAgentsMdBlock` (sentinel-fenced, idempotent, byte-precise on
removal — see `lib/clients/codex.mjs`) are already generic, not
Codex-specific. The opencode adapter imports and calls them directly against
opencode's AGENTS.md path(s) — effectively zero new code for this piece.
**Spike needed:** confirm opencode's exact global AGENTS.md path (expected
`~/.config/opencode/AGENTS.md`, by analogy with its config path) and that
project-root `AGENTS.md` is auto-loaded without extra config.

### 5. Uninstall / validateConfig

`uninstall` mirrors Cursor's shape: delete the `mcp.<name>` key, remove the
plugin file + its `plugin` array entry, strip the AGENTS.md block (reusing
Codex's `removeAgentsMdBlock`). Returns the same
`[{ key, ok, message }]` array shape the orchestrator expects.

`validateConfig` mirrors Cursor's: re-read the config, confirm the `mcp`
entry exists with the right URL and a User-Agent header.

## Spikes — resolved

Checked against the locally installed opencode v1.17.20 SDK type
definitions (`@opencode-ai/sdk/dist/gen/types.gen.d.ts`,
`@opencode-ai/plugin/dist/index.d.ts`) and `opencode.ai/docs/rules`:

1. **MCP remote schema — confirmed.** `McpRemoteConfig = { type: "remote",
   url: string, enabled?: boolean, headers?: {[k:string]:string}, oauth?,
   timeout? }`, under `Config.mcp: {[name]: McpLocalConfig |
   McpRemoteConfig}`. Matches the spec's original guess exactly.
2. **Plugin wiring — resolved by going explicit, not by relying on
   discovery.** `Config.plugin?: Array<string>` is a real, confirmed field.
   A live example on this machine (`~/.config/opencode/plugins/rtk.ts`,
   auto-loaded with no `plugin` array entry) confirms
   `~/.config/opencode/plugins/` IS an auto-discovery directory for user
   scope, but there's no confirmed equivalent for project scope — so the
   adapter uses the explicit `plugin` array entry for both scopes
   (deterministic, testable, consistent with how every other piece of
   config in this codebase is JSON-edited rather than convention-based).
3. **Hook surface — confirmed, richer than assumed.** Relevant `Hooks`
   members (`@opencode-ai/plugin`'s `Hooks` interface): `event` (fed the
   SDK's `Event` union — `EventSessionCreated` `{type:"session.created",
   properties:{info:Session}}`, `EventSessionIdle`
   `{type:"session.idle", properties:{sessionID}}`), and
   `"experimental.session.compacting"` (fires before compaction — a clean
   `PreCompact` analog) and `"experimental.chat.system.transform"`
   (`(input:{sessionID?,model}, output:{system:string[]})` — lets a plugin
   push extra context into the system prompt, used here for the
   memory-preload that Claude's `SessionStart` `additionalContext` does).
   opencode sessions are long-lived/resumable (no single hard "end" like a
   Claude Code CLI invocation), so instead of a `SessionEnd` equivalent,
   the plugin captures on `session.idle` (fires once each assistant turn
   completes) — a better fit for opencode's model, not a lesser one.
   Messages are fetched via the SDK client every plugin receives:
   `client.session.messages({ path: { id: sessionID } })` →
   `Array<{ info: Message, parts: Part[] }>` where `Message = UserMessage |
   AssistantMessage`, `AssistantMessage.parentID` linking back to the
   `UserMessage` it replies to — this is what makes transcript-file parsing
   unnecessary; exchanges are paired directly from this array.
4. **AGENTS.md — confirmed.** opencode auto-loads project-root `AGENTS.md`
   (searched upward through parent directories) and
   `~/.config/opencode/AGENTS.md` (global), no config needed. `instructions`
   in `opencode.json` is for *additional* files beyond these defaults, not
   required for the default ones. Codex's `upsertAgentsMdBlock` /
   `removeAgentsMdBlock` are reused as designed.
5. **Env vars — resolved by not depending on them.** Rather than assume
   opencode plugins inherit the installer process's env, the adapter writes
   a small `meko-memory.config.json` (mode 0600) next to the installed
   plugin file, and the plugin reads that at load time (falling back to
   `process.env.MEKO_MCP_URL`/`MEKO_API_KEY` if the file is missing, mostly
   for local dev/testing of the plugin file in isolation).

See `docs/superpowers/plans/2026-08-04-opencode-client-adapter.md` for the
resulting implementation plan.

## Testing

- Unit tests under `test/clients.test.mjs`-style dependency injection (fake
  paths, no real filesystem/network), covering: register/detect/remove/
  validate for both scopes, AGENTS.md upsert/remove round-trip, uninstall.
- No inherited test suite — the npm package excludes `test/` from its
  published files, so this repo currently has zero tests. Bootstrapping
  `test/clients.test.mjs`-equivalent coverage for the opencode adapter is
  part of this work, not a given.
- Manual smoke pass, in order:
  1. `node bin/create-meko-setup.mjs --client opencode --local --yes --dry-run`
  2. Real run against a local Meko stack (docker-compose, if available) or
     cloud Meko with a test API key.
  3. Launch opencode, confirm the `meko` MCP tools resolve.
  4. Confirm `AGENTS.md` carries the sentinel-fenced block.
  5. Have a real conversation, confirm it shows up in Meko (validates the
     capture plugin end-to-end, not just config wiring).

## Rollout

This stays in `martinjt/opencode-meko` for now. If/when access to the real
`yugabyte/meko-mcp-server` repo materializes, port `lib/clients/opencode.mjs`
and the new plugin asset across with minimal changes — the adapter contract
was followed exactly for this reason.
