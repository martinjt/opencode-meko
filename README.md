# Meko Setup Installer

> **Fork note:** this repo is seeded from the [`@yugabytedb/meko-mcp`](https://www.npmjs.com/package/@yugabytedb/meko-mcp) npm package (Apache-2.0). The upstream source repo (`yugabyte/meko-mcp-server`) isn't public, so this was bootstrapped from the published package contents rather than a `git fork`. Goal: add an `opencode` client adapter, alongside the existing Claude Code / Claude Desktop / Cursor / Codex ones, and upstream it if/when that becomes possible.

A zero-dependency Node.js CLI that configures [Meko MCP Server](https://mekodata.netlify.app/) for Claude Code, Claude Desktop, Cursor, and OpenAI Codex (CLI + Desktop App) in one command. It registers MCP server settings, configures hook/runtime environment where supported, installs skills support, and validates the setup.

Reduces manual setup to a single command.

## Prerequisites

- **Node.js 18 or newer** on your PATH. Get it from [nodejs.org](https://nodejs.org/) or via a version manager (`nvm`, `fnm`, `asdf`). `npx`, which comes bundled with Node, is how you invoke the installer.

## Quick Start

The installer is path-agnostic — the three forms below are equivalent. Pick the one that matches how you obtained the code:

| Source | Command |
|---|---|
| npm (no repo clone needed) | `npx @yugabytedb/meko-mcp [options]` |
| Repo clone, from repo root | `node installer/bin/create-meko-setup.mjs [options]` |
| Repo clone, from `installer/` | `node bin/create-meko-setup.mjs [options]` |

Claude Desktop has two install paths: a one-click `.mcpb` Desktop Extension downloaded from GitHub Releases, and the scripted installer here (run via `npx` or from a clone) — only the latter also installs the agent skill bundle. See [Claude Desktop install](#claude-desktop-install) below for the full comparison.

**Interactive (recommended for first-time users):**

```bash
npx @yugabytedb/meko-mcp
```

The installer walks you through connection type, URL, API key, and skills installation with guided prompts.

**Local one-liner (docker-compose stack already running):**

```bash
npx @yugabytedb/meko-mcp --local --yes
```

**Cursor project install (local):**

```bash
npx @yugabytedb/meko-mcp --client cursor --local --scope project --yes
```

**Claude Desktop install:**

Claude Desktop has two install paths — pick based on whether you want the agent skill (the behavioral guide that teaches the agent *when* to call Meko tools — how to capture turns via per-turn `conversation_add_message` posting so the server can extract memories, and when the narrow explicit `memory_add` cases apply):

| | Option A: `.mcpb` Desktop Extension | Option B: `create-meko-setup` installer |
|---|---|---|
| Installs MCP server | Yes | Yes |
| Installs the agent skill (behavioral guide) | **No** | **Yes** |
| Repo clone needed | No | No (works via `npx`); clones also work |
| Best for | Non-technical users; quickest path to a working MCP connection | Anyone who wants the skill that teaches the agent *when* to call Meko tools |
| Auto-capture of conversations/memories | No (see [issue #8](https://github.com/amiramm/meko-mcp-server/issues/8)) | Skill-driven — the agent posts each substantive turn via `conversation_add_message` and the server extracts memories from those posts. Still less reliable than Claude Code hooks because it's agent-driven, not lifecycle-driven. |

You can also combine both: install via `.mcpb` for the MCP wiring, then run Option B to add the skill bundle. If you re-run the Option B installer on top of an `.mcpb` install, it detects the existing entry and prompts before overwriting `mcpServers.meko`.

**Option A — Desktop Extension (`.mcpb`), one-click:**

1. Download `meko-<version>.mcpb` from the [GitHub Releases page](https://github.com/yugabyte/meko-mcp-server/releases) (e.g. `meko-1.1.0.mcpb`).
2. Open **Claude Desktop > Settings > Extensions > Install from file** and select the file (or drag the file onto that pane).
3. When prompted, paste your Meko MCP URL and API key.
4. Quit and relaunch Claude Desktop.
5. Verify in chat: *"Is Claude configured with an MCP Server for Meko?"*

Prerequisite: Node 18+ on `PATH` (the bundle launches `npx mcp-remote` under the hood). See [`mcpb/README.md`](../mcpb/README.md) for what's in the bundle.

**Option B — `create-meko-setup` installer:**

Run via `npx` (no clone needed) — pick the form that matches the table at the top of this section. From a repo clone:

```bash
node installer/bin/create-meko-setup.mjs --client claude-desktop --local --yes
```

Or via npm without a clone:

```bash
npx @yugabytedb/meko-mcp --client claude-desktop --local --yes
```

This does two things:

1. Merges `mcpServers.meko` into `claude_desktop_config.json` (backed up to `.bak`).
2. Builds two bundles — `meko-mcp-tools-desktop.skill` (memory doctrine) and `meko-select-datapack-desktop.skill` (datapack selection/pinning) — and prints their absolute paths. The location depends on how you invoked the installer — under the npm package's asset root for `npx`, or under `skills/` in your clone. **Import both**; the selector bundle is required for pinned-datapack capture routing.

Then, **once per machine**:

1. Open the path that the installer printed (look for the `Built Meko skill bundle: ...` log lines — there are two).
2. Drag **both** `meko-mcp-tools-desktop.skill` and `meko-select-datapack-desktop.skill` onto the Claude Desktop window — or import each via **Settings > Extensions > Install from file**.
3. Quit and relaunch Claude Desktop.
4. Verify both loaded: ask *"Which Meko skills do you have available?"* — the agent should mention `meko-mcp-tools-desktop` and `meko-select-datapack-desktop`.

Re-run the installer to refresh the bundles when skill content updates; you'll need to re-drag the rebuilt `.skill` files to pick up changes.

**Install on multiple clients at once:**

```bash
# Target two clients in one run:
npx @yugabytedb/meko-mcp --client claude-code,claude-desktop --local --yes

# Target every supported client (claude-code, claude-desktop, cursor):
npx @yugabytedb/meko-mcp --client all --local --yes
```

Each client is installed sequentially. A failure on one does not abort the others — the command exits with status 2 on partial success, 1 on total failure.

**CI / non-interactive (Cloud Meko):**

```bash
npx @yugabytedb/meko-mcp \
  --url https://mcp.mekodata.ai/mcp \
  --api-key "$MEKO_API_KEY" \
  --yes
```

## What It Does

The installer performs up to 5 steps (some are skippable via flags):

| Step | Action | Command / File Modified |
|------|--------|------------------------|
| 1 | Register MCP server | `claude mcp add meko <url> --transport http --scope user` (with `-H "Authorization: Bearer <key>"` for cloud) |
| 2 | Set hook environment vars | Writes `MEKO_MCP_URL` and `MEKO_API_KEY` into `~/.claude/settings.json` under the `env` key. Also prunes any stale Meko hook entries in `settings.json.hooks` that point at a prior install path (e.g. a previous `npx` cache or homebrew-global copy) so only the current install's hooks fire. |
| 3 | Register public plugin marketplace | `claude plugin marketplace add https://github.com/yugabyte/meko-skills.git --scope user` |
| 4 | Install skills plugin | `claude plugin install meko-agent-skills --scope user` |
| 5 | Validate setup | Config check via `claude mcp list`, MCP `initialize` handshake, `tools/list` verification, and a canary `datapack_list` call |

### Post-install validation (canary)

Step 5 includes a **canary call** that invokes the read-only `datapack_list` tool and asserts the response is a non-empty JSON array of datapack records. This proves the part of the stack that connectivity + `tools/list` don't cover: the API token authenticated as a real Meko identity, the tenant resolver found an account for it, and datapack routing wired up the user's actual workspace. A successful `tools/list` only proves the server speaks MCP — it says nothing about whether a Meko tool call would actually find the user's data.

The canary used to do a `memory_add` → `memory_get_by_id` → `memory_delete_by_id` round-trip, but mem0's LLM fact-extractor is non-deterministic for synthetic test text — for the same input it sometimes returned `results: []` (no facts extracted) while still adding graph relations, which the installer reported as "no memory id" and surfaced as a validation failure even when the server was healthy. `datapack_list` is a single SQL read with no LLM in the path and returns deterministically.

`--no-canary` skips the canary entirely. The `initialize` and `tools/list` checks still run. Use this when you've already proved the round-trip in a prior step (CI, pre-flight smoke).

**Files modified (depends on `--client`):**

- **Claude Code**
  - `~/.claude/settings.json` -- env vars (`MEKO_MCP_URL`, `MEKO_API_KEY`) that lifecycle hooks read at runtime.
  - Claude Code internal config (`~/.claude.json`) -- MCP registration and plugin state (managed by `claude` CLI).
- **Claude Desktop**
  - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
  - Linux: `~/.config/Claude/claude_desktop_config.json`
  - Windows: `%USERPROFILE%/AppData/Roaming/Claude/claude_desktop_config.json`
- **Cursor**
  - MCP config: `~/.cursor/mcp.json` or `.cursor/mcp.json`
  - Hooks config: `~/.cursor/hooks.json` or `.cursor/hooks.json` (native mode)
  - Stable hook scripts: `~/.cursor/meko-hooks/hooks-handlers` or `.cursor/meko-hooks/hooks-handlers`. The installer copies the shipped tree here so an npx cache cleanup cannot break configured hooks.
  - Skills path: `~/.cursor/skills` or `.cursor/skills`. Packaged installs copy skills instead of symlinking back into the ephemeral npm package cache.
- **OpenAI Codex (CLI + Desktop App)** — one install configures both surfaces (they share `~/.codex/`).
  - MCP config: `~/.codex/config.toml` (TOML; `[mcp_servers.<name>]` block).
  - Skills path: `~/.agents/skills/meko-mcp-tools/` (the shared agent-skills convention).
  - System prompt: `~/.codex/AGENTS.md` (a Meko-managed sentinel block is upserted; user content outside the fence is preserved).
  - **Cloud auth (MCP server)**: Codex's TOML stores `bearer_token_env_var = "MEKO_API_KEY"` rather than the key itself. You must export `MEKO_API_KEY` in your shell before launching Codex. The installer offers (interactively, never with `--yes`) to append the export line to your shell rc (`~/.zshrc` / `~/.bashrc` / `~/.config/fish/config.fish`). On macOS, when the desktop app is detected and an API key is supplied, the installer runs `launchctl setenv MEKO_API_KEY ...` so Codex.app launched from Finder/Dock can authenticate in the current login session.
  - **Cloud WAF User-Agent** (cloud installs only): Cloud Meko sits behind a WAF that returns an HTML `403 Forbidden` for any HTTP request with no `User-Agent`. Codex's native MCP client sends none by default, so its `initialize` handshake would 403 and the `meko` server would fail to start with `MCP client for 'meko' failed to start ... HTTP 403`. `codex mcp add` exposes no header flag, so the installer writes a per-server header into `~/.codex/config.toml`:
    ```toml
    [mcp_servers.meko]
    http_headers = { "User-Agent" = "codex-mcp/1.0 (+https://github.com/yugabyte/meko-mcp-server)" }
    ```
    This is **scoped to the Meko server block only** — it affects requests Codex makes to the Meko MCP server and nothing else (other MCP servers, other Codex traffic are untouched). The installer **merges** rather than clobbers: it reads whatever headers you already have — in either the inline `http_headers = { … }` form or the table form `[mcp_servers.meko.http_headers]` — keeps every one of them, and only *adds* a `User-Agent` if you don't already have one (a custom User-Agent is left exactly as you set it). If you had the table form, it's folded into the single inline line so there's never a conflicting duplicate definition. This holds **across a reinstall** too: re-registration deletes and rewrites the whole server block, so the installer snapshots your headers beforehand and merges them back. It **backs up `config.toml` to `config.toml.bak`** before writing. Local installs skip this (no WAF in front of `localhost`). Related: the capture-hook side of the same WAF issue is [#174](https://github.com/yugabyte/meko-mcp-server/issues/174).
  - **No project scope**: Codex has no per-project config. `--scope project --client codex` warns and degrades to user scope.
  - **Auto-capture hooks**: when Codex hooks are available, the installer copies the Meko hook scripts to `~/.codex/meko-hooks/hooks-handlers/`, writes Meko lifecycle hooks to `~/.codex/hooks.json` pointing at that copy, and prunes stale Meko hook entries from deleted install paths. The scripts live under `$CODEX_HOME` (not the shipped package) on purpose: under `npx @yugabytedb/meko-mcp` the package unpacks into an ephemeral `~/.npm/_npx/<hash>/` cache dir that npx later garbage-collects, so a `hooks.json` pinned there would become a dangling `bash '<missing>'` and Codex would report `SessionStart hook (failed) — hook exited with code 127`. Copying under `$CODEX_HOME` gives the hook a home-dir-stable target; re-running the installer refreshes the copy and auto-heals any stale npx-pinned entry. `memory_search` still handles recall; capture is driven by the hooks (and, where hooks are unavailable, by AGENTS.md-prompted per-turn `conversation_add_message` posting that the server extracts memories from). Explicit `memory_add` is reserved for the narrow cases — the user says "remember this", a fact lives only in the assistant's output or a tool result, or a negated/corrected fact needs overwriting.
  - **API key storage** (security note): Codex's hooks.json schema rejects a top-level `env` block and provides no per-command env field. The installer writes `MEKO_MCP_URL` and (when supplied) `MEKO_API_KEY` to `~/.codex/meko-env.sh` at mode 0600 (user read/write only); each hook's `command` field sources that file before invoking bash, e.g. `. '/Users/you/.codex/meko-env.sh' && bash '/Users/you/.codex/meko-hooks/hooks-handlers/session-start.sh'`. The key never appears in process arguments, so `ps -ef` from another user can't lift it while a hook is running. Trust boundary is the same as `~/.aws/credentials` or `~/.netrc` — file-system permissions on the user's home directory. If your threat model precludes even that, install for the local Meko URL (no API key prompt), or skip hook installation by deleting the Meko entries from `~/.codex/hooks.json` and removing `~/.codex/meko-env.sh` and `~/.codex/meko-hooks/` after install.
  - **Restart Codex.app** after install so it picks up the new MCP server registration.

## CLI Reference

```
Usage:
  create-meko-setup [options]
```

| Flag | Description | Default |
|------|-------------|---------|
| `--client <list>` | Target client(s): one or more of `claude-code`, `claude-desktop`, `cursor`, `codex`. Comma-separated, or `all`. `codex` covers both the OpenAI Codex CLI and the Codex Desktop App (they share `~/.codex/config.toml`). | `claude-code` |
| `--url <url>` | MCP server URL (from cloud.mekodata.ai > Datapacks > Connect) | Shared existing endpoint, otherwise production; conflicts prompt or require `--url` under `--yes` |
| `--api-key <key>` | API key for Cloud Meko authentication. If a Cloud `--url` is supplied without this flag, the installer falls back to `$MEKO_API_KEY`, then to an interactive prompt on a TTY. Only fails hard when running under `--yes` or with no TTY attached. | _(interactive prompt or `$MEKO_API_KEY` env)_ |
| `--local` | Use local Meko at `http://localhost:8000/mcp` (no API key needed) | `false` |
| `--scope <scope>` | Config scope: `user` or `project` (`claude-desktop` uses user scope config) | `user` |
| `--name <name>` | MCP server name in config | `meko` |
| `--cursor-hook-mode <mode>` | Cursor hook strategy: `native` or `claude-compat` | `native` |
| `--skip-skills` | Skip plugin marketplace and skills installation (steps 3-4) | `false` |
| `--skip-validation` | Skip post-install validation (step 5) | `false` |
| `--no-canary` | Skip the canary `datapack_list` call. Basic connectivity + tools/list still run. | `false` |
| `--dry-run` | Show what would be done without making changes | `false` |
| `--uninstall` | Remove Meko MCP server, skills, env vars, and marketplace entry | `false` |
| `--verbose` | Show detailed output (API keys are always redacted) | `false` |
| `--yes` | Accept all defaults, run non-interactively | `false` |
| `-h`, `--help` | Show help message | |
| `-v`, `--version` | Show version | |

Migrate subcommand flags (see [Migrate Existing Data](#migrate-existing-data) below for details):

| Flag | Description | Default |
|------|-------------|---------|
| `--migrate` | Start a detached migration of existing Claude Code + Cursor conversations and `CLAUDE.md` memories into Meko. | `false` |
| `--with-migrate` | With `--yes`, kick off `--migrate` at the end of a successful install without prompting. CI-friendly. | `false` |
| `--migrate-status` | Print the status of the latest (or `--run-id`-specified) migration run. | `false` |
| `--migrate-stop` | Stop the running migration (SIGTERM, then SIGKILL after 2s). | `false` |
| `--no-extract` | Skip `memory_add(messages=...)` (the Mem0 extractor call). Replay via `conversation_create` + `conversation_add_message` only; standalone `memory_add(text=...)` for CLAUDE.md / memory files still runs. | `false` |
| `--rate <n>` | Max concurrent MCP calls during migration. | `4` |
| `--force` | Ignore a live lockfile or re-ingest already-processed items. | `false` |
| `--run-id <id>` | Target a specific run-id for `--migrate-status`. | _(latest run)_ |

## Migrate Existing Data

After installing Meko, `--migrate` seeds your new datapack with the conversations and memories already on your machine so the first session isn't an empty slate.

### What the migrator reads

| Source | Location | Becomes |
|---|---|---|
| Claude Code transcripts | `~/.claude/projects/<slug>/<uuid>.jsonl` | One Meko conversation (one Langfuse trace) per session; one paired user↔assistant turn per message pair. |
| Cursor transcripts | `~/.cursor/projects/<name>/agent-transcripts/<uuid>/*.jsonl` | Same — one conversation per session, one paired turn per user↔assistant round. |
| User-scope CLAUDE.md | `~/.claude/CLAUDE.md` | One memory per top-level `# ` section (`agent_id = "meko_agent"` — the cross-project common bucket — with `metadata.scope = "user"`). |
| Project-scope CLAUDE.md | `<projectCwd>/.claude/CLAUDE.md` | One memory per top-level `# ` section (`agent_id = "claude_code:<repo-basename>"`, `metadata.scope = "project"`, `metadata.cwd = <project path>`). |
| Indexed project memories | `~/.claude/projects/<slug>/memory/*.md` | One memory per file (`agent_id = "claude_code:<repo-basename>"`); YAML frontmatter (`name`, `description`, `type`) is preserved in metadata. |

Project `cwd` is derived by reading the `cwd` field from a real session file in each slug directory — never by reverse-slugging the directory name, which loses `.` and `-` in component names.

### What the migrator writes (MCP calls)

Per migrated Claude Code / Cursor session:

1. **`conversation_create`** — once per session. Captures `cwd`, `gitBranch`, `startedAt`, and source agent (`claude-code` or `cursor`) in metadata. Returns the `conversation_id` used for subsequent calls.
2. **`conversation_add_message`** — once per paired user↔assistant turn. Carries `input`, `output`, and `reasoning` (thinking blocks + tool-use/tool-result summaries), plus a deterministic `seed` for server-side dedup. Fire-and-forget; Meko batches to Langfuse.
3. **`memory_add(messages=[{role,content},...])`** — once per paired turn. This invokes Meko's server-side Mem0 extractor (the same pipeline the demo chatbot uses at `chatbot.py:177-178`) so the migrator seeds structured memories, not just raw transcripts. Skipped entirely under `--no-extract`.

Per CLAUDE.md / memory directory discovered:

4. **`conversation_create`** — one umbrella "memory-migration" conversation per agent (reused for all MD items under that agent, to satisfy Meko's `memory_add` requirement that memories be associated with a conversation).
5. **`memory_add(text=...)`** — once per CLAUDE.md section or `memory/*.md` file. Uses the `text=` form (not `messages=`) because the file is already curated memory; no LLM extraction needed.

So a real run exercises **both** the Langfuse observability surface (1 + 2) and the Mem0 memory surface (3 + 5). `--dry-run` prints the exact breakdown before you commit:

```
Dry run:
  Claude Code sessions: 94
  Cursor sessions:      10
  Paired user↔asst turns: 887
  Memory items (MD):    14
  Planned MCP calls:
    conversation_create:      105   ← one per session + one umbrella per memory agent
    conversation_add_message: 887   ← one per paired turn (Langfuse)
    memory_add (messages=):   887   ← one per paired turn (Mem0 extractor)
    memory_add (text=):       14    ← one per CLAUDE.md section / memory file
    total:                    1893
```

### Why the migrator drives memory extraction

The Meko MCP server does **not** currently auto-extract memories on `conversation_add_message` (that call only writes to Langfuse). See [yugabyte/meko#120](https://github.com/yugabyte/meko/issues/120) — auto-extraction on the live write path was deferred because of LLM cost, but batch extraction for *previously-existing* conversations was explicitly endorsed. Until #120 lands, the migrator closes that gap itself by calling `memory_add(messages=...)` once per paired turn.

`--no-extract` skips step 3 above, turning migration into conversation-only replay. Use it when you're re-running for any reason other than seeding memories, when extraction cost is a concern, or if / when #120 lands (the migrator will be updated to default to `--no-extract` then).

### Scope

- `--scope user` (default) — every Claude Code and Cursor project on the machine, plus `~/.claude/CLAUDE.md`, plus every per-project `.claude/CLAUDE.md` and indexed `memory/*.md` directory.
- `--scope project` — only sessions whose `cwd` equals `process.cwd()`, plus that one project's `.claude/CLAUDE.md` and memory directory.

### Running

```bash
# Plan-only (no HTTP, no fork). Works without --url / --api-key — prints
# session counts, paired-turn counts, and per-tool planned-call totals so
# you can estimate LLM extraction cost before firing a real run.
create-meko-setup --migrate --dry-run --scope user

# Start a real migration; returns immediately with a run-id.
create-meko-setup --migrate --scope user --url https://... --api-key "$MEKO_API_KEY"

# Install + migrate in one command (CI-friendly).
create-meko-setup --url https://... --api-key "$MEKO_API_KEY" --yes --with-migrate

# Watch progress (or pass --run-id <id>).
create-meko-setup --migrate-status

# Stop a long-running migration (SIGTERM, then SIGKILL after 2s).
create-meko-setup --migrate-stop

# Conversation replay only; do not invoke the Mem0 extractor.
create-meko-setup --migrate --scope user --no-extract
```

### Reading `--migrate-status` output

```
run-id:       20260429-000912-74dbe6
status:       running         (pending → running → done | failed | stopped)
scope:        user
started:      2026-04-29T00:09:12.673Z
finished:     (in progress)
current:      agent / a2f6a1d6-...  (agent_id / source-session-uuid)
sessions:     76 / 111        (processed / discovered)
messages:     674
memory pairs: 674              (memory_add from Mem0 extractor)
memory (MD):  0                (memory_add from CLAUDE.md / memory files)
warnings:     0                (non-fatal; run continues)
memory errs:  0                (failed memory_add calls; re-run with --force to retry)
```

| Field | Meaning |
|---|---|
| `run-id` | Unique ID; also the directory name under `~/.meko/migrate/<run-id>/`. |
| `status` | Terminal states are `done`, `failed`, `stopped`. A `running` row that hasn't advanced in >30 s may indicate the daemon died — check `~/.meko/migrate/<run-id>/stdout.log`. |
| `scope` | Matches the `--scope` flag used at start (`user` or `project`). |
| `started` / `finished` | UTC timestamps. `finished` shows `(in progress)` until a terminal state is reached. |
| `current` | Which source item is being replayed — `<adapter>:<source-session>` (adapter = `claude-code` / `cursor` / `memory-md`). Becomes stale on `done`/`failed`/`stopped`. |
| `sessions` | Conversation sessions processed / discovered across all adapters. Climbs during the run. |
| `messages` | Total messages replayed so far via `conversation_add_message`. |
| `memory pairs` | `memory_add` calls made via the Mem0 extractor path (messages-style input). Usually close to `messages` when the extractor is enabled. |
| `memory (MD)` | `memory_add` calls from `CLAUDE.md` / memory-file sources (plain-text input). |
| `warnings` | Non-fatal issues (skipped item, partial parse). Run keeps going. |
| `memory errs` | `memory_add` calls that failed. Non-zero means the memory extractor couldn't reach the server or rejected the payload — check the per-run log. Re-run with `--force` to retry only the failed items. |

### Behavior around install

- **Interactive install** (no `--yes`): after a successful install, the installer dry-runs the enumerator, prints how much local data would be migrated, and asks `Y/n`. Declining prints a reminder to run `--migrate` later.
- **`--yes` without `--with-migrate`**: install succeeds silently and prints a one-line tip pointing at `create-meko-setup --migrate`. No migration is started.
- **`--yes --with-migrate`**: install succeeds, then the detached migration is started automatically. Progress via `--migrate-status`.

### Idempotency, resume, and state

- Per-run logs: `~/.meko/migrate/<run-id>/log.ndjson` (one JSON object per line). `tail -f | jq .` is a reasonable debug loop.
- Per-run progress snapshot: `~/.meko/migrate/<run-id>/progress.json` (what `--migrate-status` reads).
- Durable state: `~/.meko/migrate/state/<datapack-key>.json` tracks per-session checkpoints (`conversationId`, `messagesSent`, `lastUuid`, `status`) and per-memory content hashes, **scoped per destination datapack**. A re-run skips sessions marked `done` and memories whose body hash is unchanged. A partial session resumes from `lastUuid + 1`.
- **Per-datapack scoping**: the datapack key is the UUID segment of the MCP URL (`https://<uuid>.mcp.mekodev.com/mcp` → `<uuid>`), or a stable 16-char sha256 prefix for non-UUID URLs (e.g. `http://localhost:8000/mcp`). Switching datapacks produces completely independent state — migrating into a fresh datapack never falsely treats sessions as already-done just because an earlier run populated a different one. `--migrate-status` prints the `datapack:` key of the latest run so you can tell at a glance which state it belongs to.
- Back-compat for the legacy layout: migrations created before this change wrote to a single `~/.meko/migrate/state.json`. On the first run after upgrading, if `state/` is empty and `state.json` exists, the installer asks (or, under `--yes` / CI, silently accepts) "treat the legacy state as belonging to the current datapack" and copies `state.json` → `state/<current-key>.json`. The legacy file is kept on disk in case you roll back the installer.
- Server-side dedup: `conversation_add_message` gets a deterministic `seed = sha256(agentId + ":" + sessionUuid + ":" + messageUuid)` so partial-run overlap doesn't create duplicate messages.
- `--force` wipes the **current datapack's** resume state and re-issues every MCP call for it. Other datapacks' state files are untouched. If you only want to re-migrate into a new datapack, just point `--url` at the new one — no `--force` needed.

### What does NOT get migrated (v1)

- Slash-command skills, hooks, and `.claude/settings.json` — those remain in Claude Code's own config; Meko has no equivalent tool.
- Knowledge-base documents — KB ingestion is UI-only (Datapack → Actions → Add Knowledge); not exposed via MCP.
- Transcripts from other coding agents (Aider, Continue.dev, Windsurf, Codex). Claude Code + Cursor only.
- `user_id` is left null on every call (the server fills it from the API key). Multi-user routing is a follow-up.

## Client Compatibility Matrix

| Capability | Claude Code | Claude Desktop | Cursor | Codex (CLI + App) |
|---|---|---|---|---|
| One-command install | Yes | Yes | Yes | Yes |
| MCP server registration | via `claude mcp add` | via `claude_desktop_config.json` merge using `mcp-remote` stdio bridge | via `.cursor/mcp.json` merge | via `codex mcp add` (CLI) or direct TOML write (App-only) |
| Backup before config write | `.bak` on `~/.claude/settings.json` | `.bak` on `claude_desktop_config.json` | `.bak` on Cursor config | `.bak` on `~/.codex/config.toml` and `~/.codex/AGENTS.md` |
| Automatic conversation capture | Yes (hooks) | **No** — see [issue #8](https://github.com/amiramm/meko-mcp-server/issues/8) | Yes (native hooks; first SessionStart may pause briefly while creating the Meko conversation) | **No** — Codex has no user-installable hooks; AGENTS.md prompts proactive memory tool calls instead |
| Automatic memory persistence | Yes (hooks + skill) | Skill only (proactive `memory_add`) | Yes (hooks + skill) | Skill + AGENTS.md (proactive `memory_add`) |
| Skill install | Plugin marketplace (automatic) | `.skill` bundle auto-built, user drags into app | Copy into `.cursor/skills` | Copy into `~/.agents/skills/meko-mcp-tools/` |
| Uninstall | Full automatic | MCP entry removed; skill must be removed manually from app | MCP + hooks + skills cleaned up | MCP entry, skill dir, and AGENTS.md block all cleaned up |

Cursor previously had a hybrid hook mode that also wrote Claude-compatible hooks into `~/.claude/settings.json`. If you used that mode and now see duplicate `claude_code:*` Meko instructions in Cursor, remove the old Meko hook entries from `~/.claude/settings.json` unless you still use them for Claude Code.
| `agent_id` used by skill | `claude_code:<repo>` per project (via SessionStart hook); cross-project facts go to `meko_agent` | `claude_desktop` | `cursor:<repo>` per project (via Cursor hook); cross-project facts go to `meko_agent` | Whatever the agent derives by following the meko-mcp-tools skill (no hook injects an agent_id; the AGENTS.md block defers to the skill) |
| Transport | HTTP only | HTTP (or stdio via hand-edited config) | HTTP only | HTTP (Codex's `bearer_token_env_var` model) |
| Auth model | inline `Authorization: Bearer ...` header | inline header via `mcp-remote` | inline header | MCP server: env-var name reference (`MEKO_API_KEY` exported in shell or via `launchctl setenv`). Hooks: key written to `~/.codex/meko-env.sh` at mode 0600; each hook command sources the file before bash (no env block in Codex's hooks schema; see [Security](#security)). |
| Project scope | Yes (`--scope project`) | No | Yes (`--scope project`) | No (warns and degrades to user scope) |
| Deferred to a follow-up | — | `.mcpb` Desktop Extension packaging — see [issue #7](https://github.com/amiramm/meko-mcp-server/issues/7) | — | Native `codex:<repo>` agent_id classification in capture.js |

## Cloud vs Local

| | Cloud Meko | Local Meko |
|---|-----------|-----------|
| **URL** | `https://mcp.mekodata.ai/mcp` (or the endpoint shown by cloud.mekodata.ai) | `http://localhost:8000/mcp` |
| **Authentication** | Requires `--api-key` or `$MEKO_API_KEY` env var | None |
| **MCP registration** | Includes `-H "Authorization: Bearer <key>"` header | No auth header |
| **Hook env vars** | Both `MEKO_MCP_URL` and `MEKO_API_KEY` written to settings | Only `MEKO_MCP_URL` written |
| **Infrastructure** | Hosted, no local setup needed | Requires `docker compose up -d` running the Meko stack |
| **Use case** | Production, team collaboration | Development, testing |
| **Flag** | `--url <url> --api-key <key>` | `--local` |

The installer auto-detects cloud vs local based on the URL: any URL containing `localhost` or `127.0.0.1` is treated as local (no API key required). All other URLs are cloud and require authentication.

## Security

**Where credentials are stored** (per client; all files inherit standard user-only filesystem permissions):

- **Claude Code**
  - API key header — stored in `~/.claude.json` (MCP server config, managed by `claude mcp add`).
  - `MEKO_API_KEY` env var — written to `~/.claude/settings.json` under `env` so lifecycle hooks can authenticate with the MCP server.
- **Claude Desktop**
  - `MEKO_API_KEY` env var — written to `claude_desktop_config.json` under `mcpServers.<name>.env`. The header itself uses `${MEKO_API_KEY}` interpolation in `args`, so the key value lives only in the `env` block.
- **Cursor**
  - API key header — stored in `~/.cursor/mcp.json` (or `.cursor/mcp.json` for project scope) under `mcpServers.<name>.headers.Authorization`.
  - `MEKO_API_KEY` env var — written to `~/.cursor/hooks.json` (native hook mode) and/or `~/.claude/settings.json` (claude-compat hook mode) under `env` so lifecycle hooks can authenticate.
- **OpenAI Codex (CLI + Desktop App)**
  - MCP-server bearer reference — `~/.codex/config.toml` stores `bearer_token_env_var = "MEKO_API_KEY"`, **not** the key itself. The runtime env (shell rc or `launchctl setenv`) supplies the value.
  - Hook commands — Codex's `~/.codex/hooks.json` schema rejects a top-level `env` block and provides no per-command env field, so the installer writes `MEKO_API_KEY` to `~/.codex/meko-env.sh` at **mode 0600** (user read/write only). Each Meko hook's `command` field sources that file before invoking bash, so the key never appears in process arguments — `ps -ef` from another user can't lift it while the hook runs. Same trust boundary as `~/.aws/credentials` or `~/.netrc` (file-system permissions on the user's home directory). To opt out: install for the local Meko URL (no key prompt), or skip Codex hook installation by deleting the Meko entries from `~/.codex/hooks.json` and removing `~/.codex/meko-env.sh` and `~/.codex/meko-hooks/` after install. The hook scripts themselves are copied to `~/.codex/meko-hooks/hooks-handlers/` (a home-dir-stable location) rather than referenced from the shipped package, so `npx`'s cache garbage-collection can't leave the hook pointing at a deleted script (which would fail with `code 127`).

**How credentials are protected:**

- The `--verbose` flag never prints the actual API key. It always appears as `<set>` or `<not set>`.
- `--dry-run` mode redacts the key in displayed commands (shown as `<set>`).
- The API key is never logged to stdout or stderr during normal operation.
- Interactive mode uses silent input (sudo/ssh-style — no characters echoed) when prompting for the API key to prevent cleartext leaks during paste or with specific terminal configurations.
- The `MEKO_API_KEY` env var fallback means the key does not need to appear in shell history — set it in your shell profile or CI secrets.
- During Codex installs, the installer emits a `warn`-level log line confirming where the API key has been written.

**Backups:**

Before modifying any config file the installer touches, it creates a `.bak` copy alongside the original (e.g. `~/.claude/settings.json.bak`, `~/.codex/config.toml.bak`, `~/.codex/AGENTS.md.bak`). The merge is additive: existing keys are preserved unless explicitly overridden.

## Upgrading

There is no separate upgrade command — re-running the installer is the upgrade mechanism. The steps below cover the canonical paths and what to expect.

### Upgrading via `npx` (recommended)

```bash
npx @yugabytedb/meko-mcp@latest
```

The `@latest` tag is load-bearing. `npx` aggressively caches the installer tarball based on semver resolution, so plain `npx @yugabytedb/meko-mcp` can silently re-run a stale cached copy and appear to do nothing. `@latest` forces a registry lookup and pulls the newest published version. This applies to every `npx @yugabytedb/meko-mcp ...` example earlier in this README — append `@latest` whenever you intend to upgrade rather than re-run the same version.

### Upgrading a globally-installed copy

If you installed via `npm install -g @yugabytedb/meko-mcp`, the `npx` path above will not touch the global copy. Update the global package first, then re-run:

```bash
npm update -g @yugabytedb/meko-mcp
create-meko-setup
```

### What a re-run actually does

Re-running the installer is idempotent but not inert. A re-run:

- Overwrites the `env` block in `~/.claude/settings.json` (with a `.bak` backup — see the Security section above for backup semantics and locations).
- Prunes stale Meko hook entries in `settings.json.hooks` that reference a prior install path (e.g., a frozen `capture.js` from an old `npx` cache or homebrew-global copy). The current install's hook entries — whether they come from the plugin (`${CLAUDE_PLUGIN_ROOT}/...`) or an absolute path matching the current `hooks-handlers/` root — are preserved. Non-Meko hooks in the same arrays are untouched.
- Rewrites the Cursor skill directory and hooks config if `--client cursor` is targeted.
- Auto-updates the skills plugin if it's already installed (via `claude plugin update meko-agent-skills@meko-agent-skills`), otherwise installs it. See "Updating the skills plugin" below.
- Rebuilds the Claude Desktop `.skill` bundle if `--client claude-desktop` is targeted. You must re-drag the rebuilt bundle into Claude Desktop to pick up the new skill content.

### Updating the skills plugin (Claude Code)

The `meko-agent-skills` plugin is distributed via the Claude Code plugin marketplace and versions independently of the installer npm package. Re-running the installer now picks up the latest skill definitions automatically: it probes `claude plugin list` and, when the plugin is already present, calls

```bash
claude plugin update meko-agent-skills@meko-agent-skills --scope <scope>
```

using the qualified `plugin@marketplace` form required by Claude Code CLI 2.1.x. Older CLIs that don't know `plugin update` fall back to an uninstall-then-install dance to achieve the same refresh. You can still run the update manually if you want to bypass the installer:

```bash
claude plugin update meko-agent-skills@meko-agent-skills
```

#### Inside an active Claude Code session

If you're already in a session and want to pull the latest skill content without exiting:

```
/plugin marketplace update meko-agent-skills
/reload-plugins
```

The first command refetches the marketplace's source and rebuilds the plugin cache; the second activates the new content without restarting. Run `/doctor` afterward to confirm there are no plugin load errors.

#### Enabling auto-update so future skill changes land automatically

Auto-update is **per-marketplace and disabled by default for third-party marketplaces** (only Anthropic-official marketplaces auto-update out of the box). To opt in:

1. Open the in-session `/plugin` command, switch to the **Marketplaces** tab, select `meko-agent-skills`, and toggle **Enable auto-update**.
2. Or set it directly in your settings file (`~/.claude/settings.json` for user scope, or a project's `.claude/settings.json`):

   ```json
   {
     "extraKnownMarketplaces": {
       "meko-agent-skills": {
         "autoUpdate": true
       }
     }
   }
   ```

Once enabled, Claude Code refreshes the marketplace and pulls the latest plugin version on each session start. There's no global "auto-update everything" switch — opt in per marketplace.

### Checking your installed version

```bash
create-meko-setup --version
```

### Rollback

If an upgrade breaks something, restore the `.bak` backups the installer wrote before its changes:

```bash
cp ~/.claude/settings.json.bak ~/.claude/settings.json
```

See the Security section above for the full list of backup locations across Claude Code, Claude Desktop, and Cursor.

## Troubleshooting

### Claude Code CLI not found

```
Claude Code CLI not found.
Install it first: https://docs.anthropic.com/en/docs/claude-code/getting-started
```

The `claude` binary is not installed or not on your PATH. After installing, verify:

```bash
which claude
claude --version
```

### MCP server `meko` already exists in the user config

```
[1/4] Failed to register MCP server.
MCP server meko already exists in the user config
Install for claude-code failed: MCP server registration failed.
```

Claude Code's `claude mcp add` refuses to overwrite an existing registration, so a re-run — or a previous install that failed partway through — aborts at step 1. Remove the stale entry, then re-run the installer:

```bash
claude mcp list                     # confirm the "meko" entry and which scope it is on
claude mcp remove meko --scope user # or --scope local / --scope project, matching what `list` showed
claude mcp list                     # confirm it is gone
npx @yugabytedb/meko-mcp@latest     # re-run the installer
```

If `claude mcp remove` errors or you want to edit the file directly, the user-scope config lives at `~/.claude.json` — open it, find the `"mcpServers"` block, and delete the `"meko": { ... }` entry. Claude Desktop and Claude Code keep **separate** configs, so a clean Desktop install does not imply a clean Code install.

Logs worth collecting before filing a bug:

- **Installer log** — `ls -lt ~/.meko*/logs 2>/dev/null; ls -lt /tmp/meko-installer* 2>/dev/null` — share the newest file.
- **Claude Code MCP log** (macOS) — `ls -lt ~/Library/Caches/claude-cli-nodejs/*/mcp-logs-meko/ 2>/dev/null` — most recent `*.txt` shows the registration attempt and any stderr from the spawned process.
- **Current config snippet** — `grep -A 20 '"meko"' ~/.claude.json` — confirms what state Claude Code was in when the install was attempted.

### Connection refused

```
Connection refused. Is the MCP server running?
For local Meko, ensure `docker compose up -d` has started the stack.
```

For local setups, confirm the stack is running and the MCP endpoint is accessible. Note that the `Accept` header **must** advertise both `application/json` and `text/event-stream` per the MCP Streamable HTTP spec — sending only one yields HTTP 406:

```bash
curl -s http://localhost:8000/mcp -X POST \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}'
```

For cloud, swap the URL and add `-H "Authorization: Bearer $MEKO_API_KEY"`.

### HTTP 406 Not Acceptable

```
Server returned HTTP 406: ... "Client must accept both application/json and text/event-stream"
```

The MCP server is enforcing strict Streamable HTTP compliance: clients must advertise both content types in their `Accept` header. The installer does this automatically; if you see this error, you're likely on an older installer release. Upgrade with `npx @yugabytedb/meko-mcp@latest`.

### Authentication failure (401 / 403)

```
Server returned 401. Verify your API key is correct and has not expired.
```

- Confirm the API key at cloud.mekodata.ai > Datapacks > Connect.
- If using `$MEKO_API_KEY` env var, ensure it is exported in the current shell.
- Confirm the key environment matches the URL: PATs minted on `app.mekodev.com` only validate against `mcp.mekodev.com`; PATs minted on `cloud.mekodata.ai` only validate against `mcp.mekodata.ai`.
- The installer normalizes API keys (trims surrounding whitespace and a single matching pair of quotes) so a paste with a trailing newline or a literal `"…"` from a `.env` file is fine — but your raw shell variable might still be contaminated. Echo it (`echo "[$MEKO_API_KEY]"`) and check the brackets bracket the key tightly with no extra characters.
- Re-run the installer interactively to re-enter the key.

### Plugin marketplace already registered

This is non-fatal. The installer logs a warning and continues. If you need to force a re-registration, uninstall first (`--uninstall`) then install again.

### Skills plugin already installed

Same as above -- non-fatal. The existing plugin is kept. Use `--uninstall` followed by a fresh install if you need to update.

### Invalid JSON in settings.json

```
Invalid JSON in ~/.claude/settings.json: ...
Fix the file manually or delete it and re-run the installer.
```

The settings file has been corrupted or hand-edited incorrectly. Restore from the `.bak` backup:

```bash
cp ~/.claude/settings.json.bak ~/.claude/settings.json
```

### Missing core tools

```
Missing core tools: memory_search, memory_get_by_id, conversation_create. Found 0 tool(s) total.
```

The MCP server responded but does not expose the expected tools (`memory_search`, `memory_get_by_id`, `conversation_create`, `datapack_list`). This usually means a server version mismatch. Update the MCP server or check which datapack is connected. `memory_get_by_id` is used by the canary round-trip for direct-row verification (see [Post-install validation](#post-install-validation-canary-round-trip) above), so an older server that exposes `memory_search` but not `memory_get_by_id` will fail the canary check.

### DNS lookup failed

```
DNS lookup failed for host. Check the URL is correct.
```

Verify the MCP URL is spelled correctly and your network can resolve it.

### Request timed out

```
Request timed out after 10s. Is the server running and reachable?
```

The server did not respond within 10 seconds. Check network connectivity, firewall rules, or server health.

### Claude Desktop doesn't see the new MCP server

After the installer writes `claude_desktop_config.json`, **quit and relaunch** Claude Desktop — it only reads the config on startup. If Desktop shows *"Some MCP servers could not be loaded"* or the server still doesn't appear:

1. **Check the `meko` entry is the stdio shape.** Claude Desktop rejects the HTTP `{ "url": ... }` shape with a silent warning. The installer writes the stdio form that wraps the URL with the `mcp-remote` bridge:
   ```json
   "meko": {
     "command": "npx",
     "args": ["-y", "mcp-remote", "<url>", "--transport", "http-only", "--header", "User-Agent:meko-mcp-installer/1.0"]
   }
   ```
   If you see a `"url"` field at the top level instead, re-run the installer to rewrite it.
2. Validate the config is well-formed JSON: `python3 -m json.tool ~/Library/Application\ Support/Claude/claude_desktop_config.json`
3. Verify `npx` is on PATH (the bridge is launched via `npx -y mcp-remote`): `which npx`
4. Check the Desktop logs at `~/Library/Logs/Claude/mcp.log` (macOS) or `%APPDATA%\Claude\logs\` (Windows) for load errors.
5. Restore the `.bak` backup if needed: `cp ~/Library/Application\ Support/Claude/claude_desktop_config.json.bak ~/Library/Application\ Support/Claude/claude_desktop_config.json`

### Claude Desktop skill bundle didn't build

The installer runs `skills/scripts/package-desktop-skill.sh` via `bash`. If packaging fails:

- Run the script directly to see the error: `bash skills/scripts/package-desktop-skill.sh`
- Verify `zip` is on your PATH (`which zip`)
- The output file `skills/meko-mcp-tools-desktop.skill` is gitignored — safe to regenerate

### Claude Desktop capture doesn't happen automatically

Expected: Claude Desktop has no SessionStart / PreCompact / SessionEnd hook API, so there is no lifecycle-driven transcript capture. Instead, the skill tells the agent to post each substantive turn via `conversation_add_message` (creating a conversation first with `conversation_create`); the server then extracts durable memories from those posts. This per-turn posting replaces the old proactive-`memory_add` model and addresses the proactive-save unreliability tracked in [issue #8](https://github.com/amiramm/meko-mcp-server/issues/8), but it still relies on agent behavior rather than a hook.

## Uninstalling

Remove Meko configuration for the selected client:

```bash
node installer/bin/create-meko-setup.mjs --client cursor --scope project --uninstall
```

This reverses installer-managed changes for the selected client:

1. Removes MCP registration/config entries
2. Removes installer-managed hook/runtime config
3. Removes installer-managed skills wiring where applicable

Each step is safe if the component was already removed -- the uninstaller logs a warning and continues.

Use `--verbose` for detailed output during uninstall:

```bash
node installer/bin/create-meko-setup.mjs --uninstall --verbose
```

## Manual Test Plan

| # | Scenario | Steps | Expected Result |
|---|----------|-------|-----------------|
| M1 | Fresh local install | `node installer/bin/create-meko-setup.mjs --local --yes` with docker stack running | All 5 steps pass, validation shows 3 green checks |
| M2 | Fresh cloud install | Run interactively, provide Cloud Meko URL + API key | MCP registered with `Authorization: Bearer` header, env vars set, validation passes |
| M3 | Existing config | Run installer when `meko` MCP is already registered | Prompts to overwrite; answering No keeps existing config |
| M4 | No claude CLI | Run on a machine without `claude` in PATH | Exits with error message and install link |
| M5 | Server unreachable | Install with `--skip-validation`, then re-run without it | Install succeeds; validation warns about connectivity |
| M6 | Uninstall | Run `--uninstall` after a successful install | MCP removed, env vars removed, plugin removed, marketplace entry removed |
| M7 | Dry run | `--local --dry-run --verbose` | Shows all planned commands with redacted keys, no files changed on disk |
| M8 | Cloud hooks capture | After cloud install, start a new Claude Code session | SessionStart hook creates conversation via cloud MCP (check watermark in `~/.claude/meko-capture/`) |
| M9 | API key redaction | Run with `--verbose` using a cloud URL and API key | API key appears only as `<set>`, never as the actual value |
| M10 | Idempotent re-install | Run installer twice with `--local --yes` | Second run detects existing config, overwrites cleanly, all checks pass |
| M11 | Invoke from repo root | `cd <repo> && node installer/bin/create-meko-setup.mjs --client cursor --local --scope user --dry-run --yes` | Dry-run succeeds; no path-resolution errors |
| M12 | Invoke from `installer/` | `cd <repo>/installer && node bin/create-meko-setup.mjs --client cursor --local --scope user --dry-run --yes` | Dry-run succeeds (note: `--scope project` gives different `.cursor/...` paths because project scope uses cwd — pick a fixed cwd or `--scope user` to compare byte-for-byte) |
| M13 | Clone-free via npm pack | `cd installer && npm pack` → `npm install -g ./yugabytedb-meko-mcp-*.tgz` → from a directory with **no repo clone**, run `create-meko-setup --client cursor --local --scope project --dry-run` | Succeeds; asset paths resolve under the globally-installed `node_modules/@yugabytedb/meko-mcp/assets/...` |

## Development

### Prerequisites

- Node.js >= 18.0.0 (required for `util.parseArgs` and `node:test`)
- No `npm install` needed -- zero external dependencies

### Project Structure

```
installer/
  package.json               # @yugabytedb/meko-mcp
  bin/
    create-meko-setup.mjs    # CLI entry point (arg parsing, orchestration)
  lib/
    installer.mjs            # Shared multi-client orchestration
    clients/                 # Per-client adapters (claude-code/desktop/cursor), aliases, common helpers
    config.mjs               # Safe JSON read/merge/write + path helpers
    detect.mjs               # Claude CLI and existing config detection
    logger.mjs               # ANSI-colored console output (respects NO_COLOR)
    prompt.mjs               # Interactive readline prompts (choice, text, secret, yes/no)
    validate.mjs             # Post-install validation (config, connectivity, tools, canary)
    migrate.mjs              # Migrate subcommand orchestration + per-datapack state
    migrate/
      id.mjs                 # datapackKeyFromUrl + agent-id / seed helpers
      orchestrator.mjs, daemon.mjs, state.mjs, progress.mjs, lockfile.mjs, logger.mjs
      claude-parser.mjs, mcp-client.mjs, adapters/
  scripts/
    bundle-assets.mjs        # prepack: copy skill/hook assets into the npm tarball
    prepublish-smoke.sh      # Pre-publish smoke harness (run before `npm publish`)
  test/
    config.test.mjs          # Unit tests for JSON merge/read/write
    clients.test.mjs         # Unit tests for cursor/claude-code/desktop adapters
    validate.test.mjs        # Unit tests for validation logic (including the canary round-trip)
    migrate.test.mjs         # Unit tests for migrator + datapackKeyFromUrl helper
    migrate-integration.test.mjs   # Integration tests for migrator scoping + legacy state back-compat
    prepublish-smoke.test.mjs      # Piped-stdin smoke tests, gated by SMOKE_HARNESS=1
    installer.test.mjs       # Integration tests for full install flow
    fixtures/                # Mock settings files for tests
```

### Running Tests

```bash
cd installer

# All tests
node --test test/

# Unit tests only
npm run test:unit

# Integration tests (opt-in; can mutate local config)
npm run test:integration

# Cloud round-trip tests (opt-in; regression coverage for MEKO-20).
# Requires credentials in the shell:
export MEKO_TEST_CLOUD_URL=https://mcp.mekodata.ai/mcp
export MEKO_TEST_API_KEY=<your-cloud-api-key>
npm run test:integration:cloud

# Pre-publish smoke harness: npm pack → install tarball into a throwaway
# $HOME → exercise the installed CLI (`--version`, `--help`, `--dry-run`)
# via both the raw node entry and the `node_modules/.bin/meko-mcp` symlink
# that `npx` resolves through. Gated piped-stdin tests in
# `test/prepublish-smoke.test.mjs` (SMOKE_HARNESS=1) are run by the harness.
npm run smoke
```

The cloud round-trip tests point the installer at a throw-away `$HOME` via
`spawnSync`, so the developer's real `~/.claude/settings.json` is never
modified. They skip cleanly when either env var is unset.

The pre-publish smoke harness is the last gate before `npm publish`. See
[`RELEASING.md`](../RELEASING.md) at the repo root for the full release
procedure (version bump → smoke harness → manual TTY checklist → tag → CI
publish workflows). A CI workflow at `.github/workflows/prepublish-smoke.yml`
runs the harness on Ubuntu and macOS for every push to a `release/*`
branch.

### Design Principles

- **Zero external dependencies** -- Node.js built-ins only (`fs`, `path`, `readline`, `child_process`, `url`, `http`, `https`, `os`, `node:test`, `node:assert`), matching the pattern of `capture.js`.
- **Non-destructive** -- Creates `.bak` backups before modifying settings.
- **Additive merges** -- New env vars are added without overwriting existing unrelated keys.
- **Graceful failures** -- Non-critical errors (plugin already exists) warn and continue; only missing prerequisites cause hard failures.
- **API key safety** -- Never logged, always redacted in output.
- **NO_COLOR support** -- Respects the `NO_COLOR` env var to suppress ANSI color codes.
