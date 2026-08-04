# opencode Client Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fifth `opencode` client adapter to this installer, at parity with the existing `codex` adapter (MCP registration, memory-capture hooks, AGENTS.md skill block, uninstall, validateConfig), so `node bin/create-meko-setup.mjs --client opencode ...` works end-to-end against opencode.

**Architecture:** `lib/clients/opencode.mjs` implements the same adapter interface as `claude-code.mjs`/`cursor.mjs`/`codex.mjs`, registered in `lib/clients/index.mjs`. MCP registration is direct JSON editing of `opencode.json` (Cursor's pattern). Memory capture is a new opencode JS plugin (`assets/opencode-plugin/meko-memory.mjs`) that talks to opencode's own session/message API instead of parsing a Claude-Code-shaped transcript file — it ports (not imports) the Meko HTTP transport functions from `assets/hooks-handlers/lib/capture.js`. Skill instructions reuse Codex's `upsertAgentsMdBlock`/`removeAgentsMdBlock` verbatim against opencode's `AGENTS.md` convention.

**Tech Stack:** Node.js ≥18 (zero external dependencies, per this repo's existing constraint), `node:test` + `node:assert` for tests (matches `package.json`'s `"test": "node --test \"test/*.mjs\""`).

## Global Constraints

- No external npm dependencies — every existing file in this repo uses only Node built-ins (`node:fs`, `node:path`, `node:http`, etc.); the opencode adapter and plugin must do the same.
- Every adapter method that touches disk accepts `dryRun` and only logs (never writes) when true — this is how every existing adapter behaves and `lib/installer.mjs` assumes it.
- JSON writes go through `lib/config.mjs`'s `readJsonFile`/`writeJsonFile`/`mergeAllowList`/`removeFromAllowList` helpers (`.bak` backup, 2-space indent, trailing newline) — don't hand-roll file writes for `opencode.json`.
- `opencode.json` is assumed to be plain JSON (no comments) for this pass — a project using `.jsonc` with real comments is a known, documented limitation, not something this plan solves.
- Adapter constructors accept a `customPaths`/`options` object with injectable path-resolver overrides (mirrors `createCursorAdapter(customPaths = {})` / `createCodexAdapter(options = {})`) so tests never touch the real filesystem under `$HOME`.

---

## File Structure

- **Modify** `lib/config.mjs` — add opencode path helpers (`getOpencodeConfigPath`, `getOpencodeAgentsMdPath`, `getOpencodePluginInstallPath`, `getOpencodePluginConfigPath`).
- **Modify** `lib/clients/common.mjs` — add `resolveOpencodePluginSource()`.
- **Create** `assets/opencode-plugin/meko-memory.mjs` — the opencode plugin (ships as an asset, gets copied to a stable path at install time, same pattern as `assets/hooks-handlers/`).
- **Create** `lib/clients/opencode.mjs` — the adapter.
- **Modify** `lib/clients/index.mjs` — register it.
- **Modify** `bin/create-meko-setup.mjs` — add to `ALL_CLIENTS`, help text, and the picker's `displayName` map.
- **Modify** `package.json` — point `test:unit` at the test files this plan creates (the inherited script references files that don't exist in this repo).
- **Create** `test/opencode-config.test.mjs`, `test/opencode-client.test.mjs`, `test/opencode-plugin.test.mjs`.

---

### Task 1: opencode config path helpers

**Files:**
- Modify: `lib/config.mjs`
- Modify: `lib/clients/common.mjs`
- Test: `test/opencode-config.test.mjs`

**Interfaces:**
- Produces (used by Tasks 2, 4, 5): `getOpencodeConfigPath(scope, projectRoot)`, `getOpencodeAgentsMdPath(scope, projectRoot)`, `getOpencodePluginInstallPath(scope, projectRoot)`, `getOpencodePluginConfigPath(scope, projectRoot)` from `lib/config.mjs`; `resolveOpencodePluginSource()` from `lib/clients/common.mjs`.

- [ ] **Step 1: Write the failing test**

Create `test/opencode-config.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  getOpencodeConfigPath,
  getOpencodeAgentsMdPath,
  getOpencodePluginInstallPath,
  getOpencodePluginConfigPath,
} from "../lib/config.mjs";
import { resolveOpencodePluginSource } from "../lib/clients/common.mjs";

test("getOpencodeConfigPath: user scope", () => {
  assert.equal(
    getOpencodeConfigPath("user"),
    join(homedir(), ".config", "opencode", "opencode.json"),
  );
});

test("getOpencodeConfigPath: project scope", () => {
  assert.equal(
    getOpencodeConfigPath("project", "/tmp/proj"),
    join("/tmp/proj", "opencode.json"),
  );
});

test("getOpencodeAgentsMdPath: user vs project scope", () => {
  assert.equal(
    getOpencodeAgentsMdPath("user"),
    join(homedir(), ".config", "opencode", "AGENTS.md"),
  );
  assert.equal(
    getOpencodeAgentsMdPath("project", "/tmp/proj"),
    join("/tmp/proj", "AGENTS.md"),
  );
});

test("getOpencodePluginInstallPath: user vs project scope", () => {
  assert.equal(
    getOpencodePluginInstallPath("user"),
    join(homedir(), ".config", "opencode", "plugin", "meko-memory.mjs"),
  );
  assert.equal(
    getOpencodePluginInstallPath("project", "/tmp/proj"),
    join("/tmp/proj", ".opencode", "plugin", "meko-memory.mjs"),
  );
});

test("getOpencodePluginConfigPath: sits next to the install path", () => {
  assert.equal(
    getOpencodePluginConfigPath("user"),
    join(homedir(), ".config", "opencode", "plugin", "meko-memory.config.json"),
  );
});

test("resolveOpencodePluginSource: points at the shipped plugin asset", () => {
  const source = resolveOpencodePluginSource();
  assert.ok(source.endsWith(join("opencode-plugin", "meko-memory.mjs")));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/opencode-config.test.mjs`
Expected: FAIL — `getOpencodeConfigPath is not a function` (not exported yet).

- [ ] **Step 3: Add the path helpers to `lib/config.mjs`**

Add near the other client path helpers (after `getCodexSkillsRoot`, before the "Read / Write primitives" section):

```js
/**
 * Return path to opencode's config file.
 * @param {"user"|"project"} scope
 * @param {string} [projectRoot]
 * @returns {string}
 */
export function getOpencodeConfigPath(scope, projectRoot) {
  if (scope === "project") {
    return join(projectRoot, "opencode.json");
  }
  return join(homedir(), ".config", "opencode", "opencode.json");
}

/**
 * Return path to opencode's AGENTS.md. opencode auto-loads project-root
 * AGENTS.md (searching upward) and a global ~/.config/opencode/AGENTS.md —
 * see https://opencode.ai/docs/rules — no config wiring needed for either.
 * @param {"user"|"project"} scope
 * @param {string} [projectRoot]
 * @returns {string}
 */
export function getOpencodeAgentsMdPath(scope, projectRoot) {
  if (scope === "project") {
    return join(projectRoot, "AGENTS.md");
  }
  return join(homedir(), ".config", "opencode", "AGENTS.md");
}

/**
 * Stable path the Meko memory plugin is copied to at install time (not the
 * shipped asset path directly — see installStableTree's rationale in
 * common.mjs: an npx cache path is ephemeral and would leave opencode.json
 * pointing at a dangling file).
 * @param {"user"|"project"} scope
 * @param {string} [projectRoot]
 * @returns {string}
 */
export function getOpencodePluginInstallPath(scope, projectRoot) {
  if (scope === "project") {
    return join(projectRoot, ".opencode", "plugin", "meko-memory.mjs");
  }
  return join(homedir(), ".config", "opencode", "plugin", "meko-memory.mjs");
}

/**
 * Path to the small JSON file (mode 0600) carrying MEKO_MCP_URL/MEKO_API_KEY
 * to the plugin — sits next to the installed plugin file.
 * @param {"user"|"project"} scope
 * @param {string} [projectRoot]
 * @returns {string}
 */
export function getOpencodePluginConfigPath(scope, projectRoot) {
  return join(
    dirname(getOpencodePluginInstallPath(scope, projectRoot)),
    "meko-memory.config.json",
  );
}
```

- [ ] **Step 4: Add `resolveOpencodePluginSource` to `lib/clients/common.mjs`**

Add directly after `resolveStatuslineSource`:

```js
/**
 * @returns {string} absolute path to the opencode plugin source file.
 *   Lives under skills/opencode-plugin/ in source, mirrored under
 *   assets/opencode-plugin/ in the npm-packed install.
 */
export function resolveOpencodePluginSource() {
  return join(getAssetRoot(), "opencode-plugin", "meko-memory.mjs");
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/opencode-config.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add lib/config.mjs lib/clients/common.mjs test/opencode-config.test.mjs
git commit -m "Add opencode config path helpers"
```

---

### Task 2: MCP registration (register / detect / remove / validate)

**Files:**
- Create: `lib/clients/opencode.mjs`
- Modify: `lib/clients/index.mjs`
- Test: `test/opencode-client.test.mjs`

**Interfaces:**
- Consumes: `getOpencodeConfigPath`, `readJsonFile`, `writeJsonFile` from `lib/config.mjs` (Task 1 + pre-existing); `MEKO_MCP_USER_AGENT` from `lib/clients/common.mjs` (pre-existing).
- Produces: `createOpencodeAdapter(customPaths = {})` returning an object with `id: "opencode"`, `displayName: "opencode"`, `settingsPath`, `detectPrerequisites`, `isInstalled`, `detectExisting`, `removeRegistration`, `registerServer` — the rest of the adapter interface is added in Tasks 3 and 5. `customPaths.getConfigPath` overrides `getOpencodeConfigPath` for tests.

- [ ] **Step 1: Write the failing test**

Create `test/opencode-client.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createOpencodeAdapter } from "../lib/clients/opencode.mjs";

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "meko-opencode-test-"));
  const configPath = join(dir, "opencode.json");
  const adapter = createOpencodeAdapter({
    getConfigPath: () => configPath,
  });
  return { dir, configPath, adapter };
}

function silentLog() {
  return { dim() {}, warn() {}, info() {} };
}

test("registerServer writes a type:remote mcp entry with headers", () => {
  const { dir, configPath, adapter } = makeFixture();
  try {
    adapter.registerServer({
      name: "meko",
      url: "https://mcp.mekodata.ai/mcp",
      apiKey: "test-key",
      dryRun: false,
      log: silentLog(),
      scope: "user",
    });
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(cfg.mcp.meko.type, "remote");
    assert.equal(cfg.mcp.meko.url, "https://mcp.mekodata.ai/mcp");
    assert.equal(cfg.mcp.meko.enabled, true);
    assert.equal(cfg.mcp.meko.headers["User-Agent"], "meko-mcp-installer/1.0");
    assert.equal(cfg.mcp.meko.headers.Authorization, "Bearer test-key");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registerServer without an apiKey omits Authorization", () => {
  const { dir, configPath, adapter } = makeFixture();
  try {
    adapter.registerServer({
      name: "meko",
      url: "http://localhost:8000/mcp",
      apiKey: null,
      dryRun: false,
      log: silentLog(),
      scope: "user",
    });
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(cfg.mcp.meko.headers.Authorization, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registerServer dryRun makes no changes", () => {
  const { dir, configPath, adapter } = makeFixture();
  try {
    adapter.registerServer({
      name: "meko",
      url: "http://localhost:8000/mcp",
      apiKey: null,
      dryRun: true,
      log: silentLog(),
      scope: "user",
    });
    assert.equal(existsSync(configPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detectExisting finds a previously registered server", () => {
  const { dir, adapter } = makeFixture();
  try {
    adapter.registerServer({
      name: "meko",
      url: "http://localhost:8000/mcp",
      apiKey: null,
      dryRun: false,
      log: silentLog(),
      scope: "user",
    });
    const result = adapter.detectExisting("meko", { scope: "user" });
    assert.equal(result.found, true);
    assert.equal(result.url, "http://localhost:8000/mcp");
    assert.equal(adapter.detectExisting("nope", { scope: "user" }).found, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removeRegistration deletes the entry", () => {
  const { dir, configPath, adapter } = makeFixture();
  try {
    adapter.registerServer({
      name: "meko",
      url: "http://localhost:8000/mcp",
      apiKey: null,
      dryRun: false,
      log: silentLog(),
      scope: "user",
    });
    adapter.removeRegistration("meko", { scope: "user" });
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(cfg.mcp.meko, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validateConfig ok when url and User-Agent header match", async () => {
  const { dir, adapter } = makeFixture();
  try {
    adapter.registerServer({
      name: "meko",
      url: "http://localhost:8000/mcp",
      apiKey: "k",
      dryRun: false,
      log: silentLog(),
      scope: "user",
    });
    const result = await adapter.validateConfig({
      serverName: "meko",
      scope: "user",
      url: "http://localhost:8000/mcp",
      apiKey: "k",
    });
    assert.equal(result.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validateConfig fails when the url no longer matches", async () => {
  const { dir, adapter } = makeFixture();
  try {
    adapter.registerServer({
      name: "meko",
      url: "http://localhost:8000/mcp",
      apiKey: null,
      dryRun: false,
      log: silentLog(),
      scope: "user",
    });
    const result = await adapter.validateConfig({
      serverName: "meko",
      scope: "user",
      url: "https://mcp.mekodata.ai/mcp",
      apiKey: null,
    });
    assert.equal(result.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isInstalled reflects presence of ~/.config/opencode", () => {
  const { dir, adapter } = makeFixture();
  rmSync(dir, { recursive: true, force: true });
  // isInstalled checks the real homedir()/.config/opencode, not the fixture —
  // just assert it returns a boolean without throwing.
  assert.equal(typeof adapter.isInstalled(), "boolean");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/opencode-client.test.mjs`
Expected: FAIL — cannot find module `../lib/clients/opencode.mjs`.

- [ ] **Step 3: Create `lib/clients/opencode.mjs`**

```js
/**
 * opencode.mjs — opencode adapter for the Meko MCP installer.
 *
 * MCP registration is direct JSON editing of opencode.json (Cursor's
 * pattern) — opencode.json's `mcp` key accepts a McpRemoteConfig shape
 * (type/url/enabled/headers) confirmed against the installed opencode SDK's
 * type definitions. No CLI dependency, unlike Claude Code/Codex.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  getOpencodeConfigPath,
  readJsonFile,
  writeJsonFile,
} from "../config.mjs";
import { MEKO_MCP_USER_AGENT } from "./common.mjs";

/**
 * @param {{ getConfigPath?: (scope: string, projectRoot: string) => string }} [customPaths]
 * @returns {object}
 */
export function createOpencodeAdapter(customPaths = {}) {
  const resolveConfigPath = customPaths.getConfigPath ?? getOpencodeConfigPath;

  return {
    id: "opencode",
    displayName: "opencode",
    settingsPath(scope, projectRoot) {
      return resolveConfigPath(scope, projectRoot);
    },
    async detectPrerequisites() {
      // No CLI dependency — opencode.json is edited directly, same as Cursor.
    },
    /**
     * Is opencode actually installed? `~/.config/opencode` is created on
     * first run, same signal Cursor's adapter uses for `~/.cursor`.
     */
    isInstalled() {
      return existsSync(join(homedir(), ".config", "opencode"));
    },
    detectExisting(name, { scope, projectRoot } = {}) {
      const path = resolveConfigPath(scope, projectRoot);
      const cfg = readJsonFile(path);
      const entry = cfg?.mcp?.[name];
      const found = Boolean(entry);
      return {
        found,
        status: found ? "Configured" : "",
        ...(typeof entry?.url === "string" ? { url: entry.url } : {}),
      };
    },
    removeRegistration(name, { scope, projectRoot } = {}) {
      const path = resolveConfigPath(scope, projectRoot);
      const cfg = readJsonFile(path);
      if (!cfg?.mcp?.[name]) return;
      delete cfg.mcp[name];
      writeJsonFile(path, cfg);
    },
    registerServer({ name, url, apiKey, dryRun, log, scope, projectRoot }) {
      const path = resolveConfigPath(scope, projectRoot);
      if (dryRun) {
        log.dim(`  Would update ${path}:`);
        log.dim(`    mcp.${name}.type = "remote"`);
        log.dim(`    mcp.${name}.url = ${url}`);
        log.dim(`    mcp.${name}.headers["User-Agent"] = ${MEKO_MCP_USER_AGENT}`);
        if (apiKey) log.dim(`    mcp.${name}.headers.Authorization = <set>`);
        return;
      }

      const cfg = readJsonFile(path);
      if (!cfg.mcp || typeof cfg.mcp !== "object") cfg.mcp = {};
      const headers = { "User-Agent": MEKO_MCP_USER_AGENT };
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      cfg.mcp[name] = { type: "remote", url, enabled: true, headers };
      writeJsonFile(path, cfg);
    },
    async validateConfig({ serverName, scope, projectRoot, url, apiKey }) {
      const path = resolveConfigPath(scope, projectRoot);
      const cfg = readJsonFile(path);
      const entry = cfg?.mcp?.[serverName];
      if (!entry) {
        return { ok: false, message: `Server "${serverName}" not found in ${path}.` };
      }
      if (url && entry.url !== url) {
        return {
          ok: false,
          message: `Server "${serverName}" in ${path} points at ${entry.url}, expected ${url}.`,
        };
      }
      const hasUserAgent = Object.keys(entry.headers ?? {}).some(
        (key) => key.toLowerCase() === "user-agent",
      );
      if (!hasUserAgent) {
        return {
          ok: false,
          message: `Server "${serverName}" in ${path} is missing the User-Agent header.`,
        };
      }
      if (apiKey) {
        const authEntry = Object.entries(entry.headers ?? {}).find(
          ([key]) => key.toLowerCase() === "authorization",
        );
        if (!authEntry || authEntry[1] !== `Bearer ${apiKey}`) {
          return {
            ok: false,
            message: `Server "${serverName}" in ${path} does not contain the current Authorization header.`,
          };
        }
      }
      return { ok: true, message: `Server "${serverName}" is registered in ${path}.` };
    },
  };
}
```

- [ ] **Step 4: Register the adapter in `lib/clients/index.mjs`**

```js
import { createClaudeCodeAdapter } from "./claude-code.mjs";
import { createClaudeDesktopAdapter } from "./claude-desktop.mjs";
import { createCodexAdapter } from "./codex.mjs";
import { createCursorAdapter } from "./cursor.mjs";
import { createOpencodeAdapter } from "./opencode.mjs";

/**
 * @returns {Record<string, object>}
 */
export function getClientAdapters() {
  return {
    "claude-code": createClaudeCodeAdapter(),
    "claude-desktop": createClaudeDesktopAdapter(),
    cursor: createCursorAdapter(),
    codex: createCodexAdapter(),
    opencode: createOpencodeAdapter(),
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/opencode-client.test.mjs`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add lib/clients/opencode.mjs lib/clients/index.mjs test/opencode-client.test.mjs
git commit -m "Add opencode adapter: MCP registration"
```

---

### Task 3: AGENTS.md skill instructions

**Files:**
- Modify: `lib/clients/opencode.mjs`
- Modify: `test/opencode-client.test.mjs`

**Interfaces:**
- Consumes: `upsertAgentsMdBlock(filePath, version, {name})`, `removeAgentsMdBlock(raw)` — already exported from `lib/clients/codex.mjs` (pre-existing, generic, not Codex-specific — confirmed by reading the file). `getInstallerVersion()` from `lib/clients/common.mjs` (pre-existing). `getOpencodeAgentsMdPath` from Task 1.
- Produces: `installSkills({ name, dryRun, log, scope, projectRoot })` on the adapter, returning `{ marketplace: "skipped"|"dry-run", skills: "ok"|"dry-run" }` (matches the shape `lib/installer.mjs` expects).

- [ ] **Step 1: Write the failing test**

Append to `test/opencode-client.test.mjs`:

```js
import { readFileSync as readFileSyncForAgents } from "node:fs";

test("installSkills writes a sentinel-fenced Meko block to AGENTS.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "meko-opencode-test-"));
  const agentsMdPath = join(dir, "AGENTS.md");
  const adapter = createOpencodeAdapter({
    getConfigPath: () => join(dir, "opencode.json"),
    getAgentsMdPath: () => agentsMdPath,
  });
  try {
    const result = adapter.installSkills({
      name: "meko",
      dryRun: false,
      log: silentLog(),
      scope: "user",
    });
    assert.equal(result.skills, "ok");
    const content = readFileSyncForAgents(agentsMdPath, "utf8");
    assert.match(content, /meko:start/);
    assert.match(content, /mcp__meko__memory_search/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("installSkills is idempotent (second run produces the same content)", () => {
  const dir = mkdtempSync(join(tmpdir(), "meko-opencode-test-"));
  const agentsMdPath = join(dir, "AGENTS.md");
  const adapter = createOpencodeAdapter({
    getConfigPath: () => join(dir, "opencode.json"),
    getAgentsMdPath: () => agentsMdPath,
  });
  try {
    adapter.installSkills({ name: "meko", dryRun: false, log: silentLog(), scope: "user" });
    const first = readFileSyncForAgents(agentsMdPath, "utf8");
    adapter.installSkills({ name: "meko", dryRun: false, log: silentLog(), scope: "user" });
    const second = readFileSyncForAgents(agentsMdPath, "utf8");
    assert.equal(first, second);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("installSkills dryRun does not touch AGENTS.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "meko-opencode-test-"));
  const agentsMdPath = join(dir, "AGENTS.md");
  const adapter = createOpencodeAdapter({
    getConfigPath: () => join(dir, "opencode.json"),
    getAgentsMdPath: () => agentsMdPath,
  });
  try {
    const result = adapter.installSkills({ name: "meko", dryRun: true, log: silentLog(), scope: "user" });
    assert.equal(result.skills, "dry-run");
    assert.equal(existsSync(agentsMdPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/opencode-client.test.mjs`
Expected: FAIL — `adapter.installSkills is not a function`.

- [ ] **Step 3: Add `installSkills` to `lib/clients/opencode.mjs`**

Update the imports at the top of the file:

```js
import {
  getOpencodeAgentsMdPath,
  getOpencodeConfigPath,
  readJsonFile,
  writeJsonFile,
} from "../config.mjs";
import { getInstallerVersion, MEKO_MCP_USER_AGENT } from "./common.mjs";
import { upsertAgentsMdBlock } from "./codex.mjs";
```

Update the `createOpencodeAdapter` signature and add the resolver:

```js
export function createOpencodeAdapter(customPaths = {}) {
  const resolveConfigPath = customPaths.getConfigPath ?? getOpencodeConfigPath;
  const resolveAgentsMdPath = customPaths.getAgentsMdPath ?? getOpencodeAgentsMdPath;
```

Add this method inside the returned object, after `validateConfig`:

```js
    installSkills({ name, dryRun, log, scope, projectRoot }) {
      const serverName = name ?? "meko";
      const agentsMdPath = resolveAgentsMdPath(scope, projectRoot);
      const currentVersion = getInstallerVersion();
      if (dryRun) {
        log.dim(`  Would upsert Meko block in ${agentsMdPath}`);
        return { marketplace: "skipped", skills: "dry-run" };
      }
      upsertAgentsMdBlock(agentsMdPath, currentVersion, { name: serverName });
      return { marketplace: "skipped", skills: "ok" };
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/opencode-client.test.mjs`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/clients/opencode.mjs test/opencode-client.test.mjs
git commit -m "opencode adapter: install AGENTS.md skill block"
```

---

### Task 4: Memory-capture plugin asset

**Files:**
- Create: `assets/opencode-plugin/meko-memory.mjs`
- Test: `test/opencode-plugin.test.mjs`

**Interfaces:**
- Produces: `export const MekoMemoryPlugin` (default export too) — an opencode `Plugin` (`(input: PluginInput) => Promise<Hooks>`). For testability, also exports `export const __TEST__ = { deriveAgentId, extractExchanges, textOf, reasoningOf }` (mirrors the `__TEST__` export pattern already used in `lib/clients/codex.mjs`).
- Consumes nothing from earlier tasks — this file is a standalone asset, copied into place by Task 5's `setHookEnvironment`. It is **not** imported by `lib/clients/opencode.mjs` at install time (it runs inside the opencode process, not the installer process).

This task only unit-tests the three pure functions (`deriveAgentId`, `extractExchanges`, `textOf`/`reasoningOf`). The Meko HTTP transport (`mcpPost`/`mcpInitialize`/`mcpCall`/`createConversation`/`addMessage`/`fetchRecentMemories`) and the plugin's hook wiring are exercised by Task 7's manual smoke test, not automated tests — mocking `node:http` for a faithful port of already-working code isn't worth the churn here (the identical functions in `capture.js` are already running in production for 3 other clients).

- [ ] **Step 1: Write the failing test**

Create `test/opencode-plugin.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";

import { __TEST__ } from "../assets/opencode-plugin/meko-memory.mjs";

const { deriveAgentId, extractExchanges, textOf, reasoningOf } = __TEST__;

test("deriveAgentId: repo-scoped bucket from directory basename", () => {
  assert.equal(deriveAgentId("/home/martin/repos/martinjt/opencode-meko"), "opencode:opencode-meko");
});

test("deriveAgentId: sanitizes non [a-z0-9-] characters", () => {
  assert.equal(deriveAgentId("/home/martin/repos/My Cool Project!"), "opencode:my-cool-project");
});

test("deriveAgentId: falls back to bare 'opencode' with no directory", () => {
  assert.equal(deriveAgentId(""), "opencode");
  assert.equal(deriveAgentId("/"), "opencode");
});

test("textOf: joins text parts, ignores non-text parts", () => {
  const parts = [
    { type: "text", text: "hello" },
    { type: "tool", text: "ignored" },
    { type: "text", text: "world" },
  ];
  assert.equal(textOf(parts), "hello\nworld");
});

test("reasoningOf: joins reasoning parts only", () => {
  const parts = [
    { type: "reasoning", text: "thinking..." },
    { type: "text", text: "answer" },
  ];
  assert.equal(reasoningOf(parts), "thinking...");
});

test("extractExchanges: pairs assistant replies with their parent user message", () => {
  const messages = [
    {
      info: { id: "u1", role: "user", parentID: undefined },
      parts: [{ type: "text", text: "What is 2+2?" }],
    },
    {
      info: { id: "a1", role: "assistant", parentID: "u1", finish: "stop" },
      parts: [{ type: "text", text: "4" }],
    },
    {
      info: { id: "u2", role: "user", parentID: undefined },
      parts: [{ type: "text", text: "And 3+3?" }],
    },
    {
      info: { id: "a2", role: "assistant", parentID: "u2", finish: "stop" },
      parts: [{ type: "text", text: "6" }],
    },
  ];

  const all = extractExchanges(messages, null);
  assert.equal(all.length, 2);
  assert.deepEqual(
    all.map((e) => [e.input, e.output]),
    [["What is 2+2?", "4"], ["And 3+3?", "6"]],
  );

  const afterFirst = extractExchanges(messages, "a1");
  assert.equal(afterFirst.length, 1);
  assert.equal(afterFirst[0].input, "And 3+3?");
});

test("extractExchanges: skips an assistant message with no finish (still in progress)", () => {
  const messages = [
    { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "hi" }] },
    { info: { id: "a1", role: "assistant", parentID: "u1" }, parts: [{ type: "text", text: "" }] },
  ];
  assert.equal(extractExchanges(messages, null).length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/opencode-plugin.test.mjs`
Expected: FAIL — cannot find module `../assets/opencode-plugin/meko-memory.mjs`.

- [ ] **Step 3: Create `assets/opencode-plugin/meko-memory.mjs`**

```js
/**
 * meko-memory.mjs — opencode plugin for Meko MCP memory capture.
 *
 * Installed by lib/clients/opencode.mjs into a stable path and referenced
 * via opencode.json's `plugin` array. Unlike the Claude Code / Cursor /
 * Codex hooks (assets/hooks-handlers/*.sh), which shell out to
 * lib/capture.js and parse a Claude-Code-shaped JSONL transcript file,
 * opencode sessions have no transcript file — this plugin talks to
 * opencode's own session/message API (via the SDK client every plugin
 * receives) instead.
 *
 * The Meko transport functions below (mcpPost/mcpInitialize/mcpCall/
 * createConversation/addMessage/fetchRecentMemories) are a deliberate port
 * of the equivalent functions in assets/hooks-handlers/lib/capture.js, kept
 * separate rather than imported — see the design spec's rationale for not
 * refactoring a module shared by 3 working clients for this first pass.
 */

import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import https from "node:https";

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(PLUGIN_DIR, "meko-memory.config.json");

function loadMekoConfig() {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return {
      url: raw.url || process.env.MEKO_MCP_URL || "http://localhost:8000/mcp",
      apiKey: raw.apiKey || process.env.MEKO_API_KEY || "",
    };
  } catch {
    return {
      url: process.env.MEKO_MCP_URL || "http://localhost:8000/mcp",
      apiKey: process.env.MEKO_API_KEY || "",
    };
  }
}

// --- Meko MCP transport (ported from hooks-handlers/lib/capture.js) ---

function createMekoTransport({ url, apiKey }) {
  let mcpSessionId = null;
  let mcpRequestId = 0;

  function mcpPost(jsonBody) {
    const body = JSON.stringify(jsonBody);
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const transport = parsed.protocol === "https:" ? https : http;
      const headers = {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Content-Length": Buffer.byteLength(body),
        "User-Agent": "meko-opencode-plugin/1.0 (+https://github.com/yugabyte/meko-mcp-server)",
      };
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      if (mcpSessionId) headers["Mcp-Session-Id"] = mcpSessionId;

      const req = transport.request(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname + parsed.search,
          method: "POST",
          headers,
          timeout: 10_000,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            if (res.statusCode >= 400) {
              reject(new Error(`MCP HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
              return;
            }
            if (!data.trim()) {
              resolve({ body: null, headers: res.headers });
              return;
            }
            try {
              resolve({ body: parseMcpResponseBody(data), headers: res.headers });
            } catch {
              reject(new Error(`Invalid MCP response: ${data.slice(0, 200)}`));
            }
          });
        },
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("MCP request timed out"));
      });
      req.write(body);
      req.end();
    });
  }

  function parseMcpResponseBody(data) {
    const trimmed = data.trim();
    if (!trimmed.startsWith("event:") && !trimmed.startsWith("data:")) {
      return JSON.parse(trimmed);
    }
    const payloads = [];
    let current = [];
    for (const line of data.split(/\r?\n/)) {
      if (line === "") {
        if (current.length) payloads.push(current.join("\n"));
        current = [];
        continue;
      }
      if (line.startsWith("data:")) {
        current.push(line.startsWith("data: ") ? line.slice(6) : line.slice(5));
      }
    }
    if (current.length) payloads.push(current.join("\n"));
    const payload = payloads.find((item) => item.trim()) || "";
    if (!payload) throw new Error("SSE response had no data payload");
    const parsed = JSON.parse(payload);
    if (parsed.error) throw new Error(JSON.stringify(parsed.error));
    return parsed;
  }

  async function mcpInitialize() {
    mcpRequestId++;
    const initResult = await mcpPost({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "meko-opencode-plugin", version: "1.0.0" },
      },
      id: mcpRequestId,
    });
    const sid = initResult.headers["mcp-session-id"] || initResult.headers["Mcp-Session-Id"];
    if (sid) mcpSessionId = sid;
    await mcpPost({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  }

  async function mcpCall(toolName, args) {
    mcpRequestId++;
    const result = await mcpPost({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: toolName, arguments: args },
      id: mcpRequestId,
    });
    return result.body;
  }

  function extractToolResult(response) {
    try {
      return JSON.parse(response.result.content[0].text);
    } catch {
      return null;
    }
  }

  async function fetchRecentMemories(agentId, { limit = 10, budget = 2000 } = {}) {
    const response = await mcpCall("memory_get_all", {
      agent_id: agentId,
      conversation_id: "00000000-0000-0000-0000-000000000000",
      limit,
    });
    const result = extractToolResult(response);
    if (!result) return [];
    const entries = Array.isArray(result) ? result : result.memories || result.results || [];
    const summaries = [];
    let used = 0;
    for (const entry of entries) {
      const text = entry.memory || entry.text || entry.content || "";
      if (!text) continue;
      const line = `- ${String(text).replace(/\s+/g, " ").trim()}`;
      if (used + line.length + 1 > budget) break;
      summaries.push(line);
      used += line.length + 1;
    }
    return summaries;
  }

  async function createConversation(sessionId, agentId, metadata) {
    const response = await mcpCall("conversation_create", {
      agent_id: agentId,
      title: "opencode session (auto-captured)",
      session_id: sessionId,
      ...(metadata ? { metadata: JSON.stringify(metadata) } : {}),
    });
    const result = extractToolResult(response);
    return result && result.id ? result.id : null;
  }

  async function addMessage(convId, agentId, exchange) {
    const response = await mcpCall("conversation_add_message", {
      conversation_id: convId,
      agent_id: agentId,
      input: exchange.input,
      output: exchange.output,
      reasoning: exchange.reasoning || "",
      seed: `${convId}:${exchange.userMessageId}`,
    });
    if (response && response.result && response.result.isError) {
      throw new Error(`conversation_add_message returned isError: ${JSON.stringify(response.result)}`);
    }
    const result = extractToolResult(response);
    if (result === null) throw new Error("conversation_add_message: no parseable result body");
    if (result.error) throw new Error(`conversation_add_message failed: ${JSON.stringify(result.error)}`);
    return result;
  }

  return { mcpInitialize, mcpCall, fetchRecentMemories, createConversation, addMessage };
}

// --- agent_id derivation ---
// Deliberately its own copy, not capture.js's deriveAgentId: that one only
// gives a repo-scoped id to claude_code/cursor and buckets everything else
// (including codex) under the shared "meko_agent" id. opencode gets its own
// proper repo-scoped bucket here.

function deriveAgentId(directory) {
  const rawBase = directory ? basename(directory) : "";
  if (!rawBase || rawBase === "." || rawBase === "/") return "opencode";
  const project = rawBase
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return project ? `opencode:${project}` : "opencode";
}

// --- exchange extraction from opencode's session message list ---

function textOf(parts) {
  return parts
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

function reasoningOf(parts) {
  return parts
    .filter((p) => p && p.type === "reasoning" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

/**
 * Pair up user/assistant messages into exchanges. opencode's message list is
 * chronological; an AssistantMessage's `parentID` names the UserMessage it
 * replies to. Only completed assistant turns (`finish` set) after `afterId`
 * are included — `afterId` is the last assistant messageID this plugin
 * already captured for the session, so a session.idle firing again on the
 * same settled state doesn't re-capture the same exchange.
 *
 * @param {Array<{info: object, parts: Array<object>}>} messages
 * @param {string|null} afterId
 * @returns {Array<{userMessageId: string, assistantMessageId: string, input: string, output: string, reasoning: string}>}
 */
function extractExchanges(messages, afterId) {
  const byId = new Map(messages.map((m) => [m.info.id, m]));
  const exchanges = [];
  let seenAfter = !afterId;
  for (const entry of messages) {
    const info = entry.info;
    if (info.id === afterId) {
      seenAfter = true;
      continue;
    }
    if (!seenAfter) continue;
    if (info.role !== "assistant" || !info.finish) continue;
    const parent = byId.get(info.parentID);
    if (!parent || parent.info.role !== "user") continue;
    exchanges.push({
      userMessageId: parent.info.id,
      assistantMessageId: info.id,
      input: textOf(parent.parts),
      output: textOf(entry.parts),
      reasoning: reasoningOf(entry.parts),
    });
  }
  return exchanges;
}

// --- plugin entry point ---

export const MekoMemoryPlugin = async ({ client, directory }) => {
  const { url, apiKey } = loadMekoConfig();
  const meko = createMekoTransport({ url, apiKey });
  const agentId = deriveAgentId(directory);

  // sessionID -> { ready: Promise<{convId, memories}>, lastCapturedMessageId, memoriesInjected }
  const sessions = new Map();

  function primeSession(sessionId) {
    if (sessions.has(sessionId)) return sessions.get(sessionId);
    const state = {
      lastCapturedMessageId: null,
      memoriesInjected: false,
      ready: (async () => {
        try {
          await meko.mcpInitialize();
          const [convId, memories] = await Promise.all([
            meko.createConversation(sessionId, agentId, { source: "opencode-plugin" }),
            meko.fetchRecentMemories(agentId),
          ]);
          return { convId, memories };
        } catch (err) {
          console.warn(`[meko] session priming failed: ${err.message}`);
          return { convId: null, memories: [] };
        }
      })(),
    };
    sessions.set(sessionId, state);
    return state;
  }

  async function captureNewMessages(sessionId) {
    const state = sessions.get(sessionId);
    if (!state) return;
    const { convId } = await state.ready;
    if (!convId) return;
    let list;
    try {
      const response = await client.session.messages({ path: { id: sessionId } });
      list = response?.data ?? response;
    } catch (err) {
      console.warn(`[meko] failed to list session messages: ${err.message}`);
      return;
    }
    if (!Array.isArray(list)) return;
    const exchanges = extractExchanges(list, state.lastCapturedMessageId);
    for (const exchange of exchanges) {
      if (!exchange.input && !exchange.output) continue;
      try {
        await meko.addMessage(convId, agentId, exchange);
      } catch (err) {
        console.warn(`[meko] failed to capture exchange: ${err.message}`);
      }
    }
    if (exchanges.length) {
      state.lastCapturedMessageId = exchanges[exchanges.length - 1].assistantMessageId;
    }
  }

  return {
    event: async ({ event }) => {
      if (event.type === "session.created") {
        primeSession(event.properties.info.id);
      }
      if (event.type === "session.idle") {
        await captureNewMessages(event.properties.sessionID);
      }
    },
    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return;
      const state = sessions.get(input.sessionID) ?? primeSession(input.sessionID);
      if (state.memoriesInjected) return;
      const { memories } = await state.ready;
      state.memoriesInjected = true;
      if (memories.length) {
        output.system.push(
          `Relevant memories from Meko (agent: ${agentId}):\n${memories.join("\n")}`,
        );
      }
    },
    "experimental.session.compacting": async (input) => {
      await captureNewMessages(input.sessionID);
    },
  };
};

export default MekoMemoryPlugin;

export const __TEST__ = { deriveAgentId, extractExchanges, textOf, reasoningOf };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/opencode-plugin.test.mjs`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add assets/opencode-plugin/meko-memory.mjs test/opencode-plugin.test.mjs
git commit -m "Add opencode memory-capture plugin"
```

---

### Task 5: Wire the plugin into the adapter (`setHookEnvironment` + `uninstall`)

**Files:**
- Modify: `lib/clients/opencode.mjs`
- Modify: `test/opencode-client.test.mjs`

**Interfaces:**
- Consumes: `getOpencodePluginInstallPath`, `getOpencodePluginConfigPath` (Task 1); `resolveOpencodePluginSource`, `installStableTree`, `removePath` from `lib/clients/common.mjs` (Task 1 + pre-existing); `mergeAllowList`, `removeFromAllowList` from `lib/config.mjs` (pre-existing — reused, not reinvented, for the `plugin` array); `removeAgentsMdBlock` from `lib/clients/codex.mjs` (pre-existing).
- Produces: `setHookEnvironment({ url, apiKey, dryRun, verbose, log, scope, projectRoot })` and `uninstall({ name, scope, projectRoot })` on the adapter — `uninstall` returns `Array<{key, ok, message}>` (matches `lib/installer.mjs`'s expectation).

- [ ] **Step 1: Write the failing test**

Append to `test/opencode-client.test.mjs`:

```js
function makeFullFixture() {
  const dir = mkdtempSync(join(tmpdir(), "meko-opencode-test-"));
  const configPath = join(dir, "opencode.json");
  const agentsMdPath = join(dir, "AGENTS.md");
  const pluginInstallPath = join(dir, "plugin", "meko-memory.mjs");
  const pluginConfigPath = join(dir, "plugin", "meko-memory.config.json");
  const pluginSourcePath = join(
    process.cwd(),
    "assets",
    "opencode-plugin",
    "meko-memory.mjs",
  );
  const adapter = createOpencodeAdapter({
    getConfigPath: () => configPath,
    getAgentsMdPath: () => agentsMdPath,
    getPluginInstallPath: () => pluginInstallPath,
    getPluginConfigPath: () => pluginConfigPath,
    resolveOpencodePluginSource: () => pluginSourcePath,
  });
  return { dir, configPath, agentsMdPath, pluginInstallPath, pluginConfigPath, adapter };
}

test("setHookEnvironment copies the plugin, writes its config, and wires opencode.json", () => {
  const { dir, configPath, pluginInstallPath, pluginConfigPath, adapter } = makeFullFixture();
  try {
    adapter.setHookEnvironment({
      url: "https://mcp.mekodata.ai/mcp",
      apiKey: "test-key",
      dryRun: false,
      verbose: false,
      log: silentLog(),
      scope: "user",
    });

    assert.equal(existsSync(pluginInstallPath), true);
    const pluginConfig = JSON.parse(readFileSync(pluginConfigPath, "utf8"));
    assert.equal(pluginConfig.url, "https://mcp.mekodata.ai/mcp");
    assert.equal(pluginConfig.apiKey, "test-key");

    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    assert.ok(Array.isArray(cfg.plugin));
    assert.ok(cfg.plugin.includes(pluginInstallPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setHookEnvironment dryRun makes no changes", () => {
  const { dir, configPath, pluginInstallPath, adapter } = makeFullFixture();
  try {
    adapter.setHookEnvironment({
      url: "http://localhost:8000/mcp",
      apiKey: null,
      dryRun: true,
      verbose: false,
      log: silentLog(),
      scope: "user",
    });
    assert.equal(existsSync(pluginInstallPath), false);
    assert.equal(existsSync(configPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uninstall removes the mcp entry, the plugin, and the AGENTS.md block", () => {
  const { dir, configPath, agentsMdPath, pluginInstallPath, adapter } = makeFullFixture();
  try {
    adapter.registerServer({
      name: "meko",
      url: "http://localhost:8000/mcp",
      apiKey: null,
      dryRun: false,
      log: silentLog(),
      scope: "user",
    });
    adapter.setHookEnvironment({
      url: "http://localhost:8000/mcp",
      apiKey: null,
      dryRun: false,
      verbose: false,
      log: silentLog(),
      scope: "user",
    });
    adapter.installSkills({ name: "meko", dryRun: false, log: silentLog(), scope: "user" });

    const results = adapter.uninstall({ name: "meko", scope: "user" });
    assert.ok(results.every((r) => r.ok));

    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(cfg.mcp.meko, undefined);
    assert.ok(!(cfg.plugin ?? []).includes(pluginInstallPath));
    assert.equal(existsSync(pluginInstallPath), false);
    assert.doesNotMatch(readFileSync(agentsMdPath, "utf8"), /meko:start/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/opencode-client.test.mjs`
Expected: FAIL — `adapter.setHookEnvironment is not a function`.

- [ ] **Step 3: Add `setHookEnvironment` and `uninstall` to `lib/clients/opencode.mjs`**

Update the imports:

```js
import { mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  getOpencodeAgentsMdPath,
  getOpencodeConfigPath,
  getOpencodePluginConfigPath,
  getOpencodePluginInstallPath,
  mergeAllowList,
  readJsonFile,
  removeFromAllowList,
  writeJsonFile,
} from "../config.mjs";
import {
  getInstallerVersion,
  installStableTree,
  MEKO_MCP_USER_AGENT,
  removePath,
  resolveOpencodePluginSource,
} from "./common.mjs";
import { removeAgentsMdBlock, upsertAgentsMdBlock } from "./codex.mjs";
```

Add the two new resolvers to `createOpencodeAdapter`:

```js
export function createOpencodeAdapter(customPaths = {}) {
  const resolveConfigPath = customPaths.getConfigPath ?? getOpencodeConfigPath;
  const resolveAgentsMdPath = customPaths.getAgentsMdPath ?? getOpencodeAgentsMdPath;
  const resolvePluginInstallPath =
    customPaths.getPluginInstallPath ?? getOpencodePluginInstallPath;
  const resolvePluginConfigPath =
    customPaths.getPluginConfigPath ?? getOpencodePluginConfigPath;
  const resolvePluginSource =
    customPaths.resolveOpencodePluginSource ?? resolveOpencodePluginSource;
```

Add these two methods inside the returned object, after `installSkills`:

```js
    setHookEnvironment({ url, apiKey, dryRun, verbose, log, scope, projectRoot }) {
      const installPath = resolvePluginInstallPath(scope, projectRoot);
      const pluginConfigPath = resolvePluginConfigPath(scope, projectRoot);
      const opencodeConfigPath = resolveConfigPath(scope, projectRoot);

      if (dryRun) {
        log.dim(`  Would copy Meko memory plugin to ${installPath}`);
        log.dim(`  Would write plugin config at ${pluginConfigPath} (mode 0600)`);
        log.dim(`  Would add "${installPath}" to ${opencodeConfigPath}'s plugin array`);
        return;
      }

      installStableTree(resolvePluginSource(), installPath);
      mkdirSync(dirname(pluginConfigPath), { recursive: true });
      writeFileSync(
        pluginConfigPath,
        JSON.stringify({ url, apiKey: apiKey || "" }, null, 2) + "\n",
        { encoding: "utf8", mode: 0o600 },
      );
      chmodSync(pluginConfigPath, 0o600);
      mergeAllowList(opencodeConfigPath, "plugin", [installPath]);
      if (verbose) log.dim(`  Wired Meko memory plugin at ${installPath}`);
    },
    uninstall({ name, scope, projectRoot } = {}) {
      const results = [];
      try {
        this.removeRegistration(name, { scope, projectRoot });
        results.push({ key: "mcp", ok: true, message: `opencode MCP server "${name}" removed.` });
      } catch (err) {
        results.push({ key: "mcp", ok: false, message: `Could not remove opencode MCP server: ${err.message}` });
      }

      try {
        const installPath = resolvePluginInstallPath(scope, projectRoot);
        const opencodeConfigPath = resolveConfigPath(scope, projectRoot);
        removeFromAllowList(opencodeConfigPath, "plugin", [installPath]);
        removePath(dirname(installPath));
        results.push({ key: "plugin", ok: true, message: "Meko memory plugin removed." });
      } catch (err) {
        results.push({ key: "plugin", ok: false, message: `Could not remove Meko memory plugin: ${err.message}` });
      }

      try {
        const agentsMdPath = resolveAgentsMdPath(scope, projectRoot);
        const raw = safeReadFile(agentsMdPath);
        if (raw !== null) {
          const next = removeAgentsMdBlock(raw);
          if (next !== raw) writeFileSync(agentsMdPath, next, "utf8");
        }
        results.push({ key: "agents-md", ok: true, message: "Meko block stripped from AGENTS.md." });
      } catch (err) {
        results.push({ key: "agents-md", ok: false, message: `Could not update AGENTS.md: ${err.message}` });
      }

      return results;
    },
```

Add this helper at the bottom of the file (after the closing `}` of `createOpencodeAdapter`):

```js
function safeReadFile(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/opencode-client.test.mjs`
Expected: PASS (14 tests).

- [ ] **Step 5: Run the full test suite to confirm nothing else broke**

Run: `node --test "test/*.mjs"`
Expected: PASS — all tests across `opencode-config.test.mjs`, `opencode-client.test.mjs`, `opencode-plugin.test.mjs` pass.

- [ ] **Step 6: Commit**

```bash
git add lib/clients/opencode.mjs test/opencode-client.test.mjs
git commit -m "opencode adapter: wire memory-capture plugin + uninstall"
```

---

### Task 6: Wire `opencode` into the CLI entry point

**Files:**
- Modify: `bin/create-meko-setup.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `createOpencodeAdapter` is already registered in `lib/clients/index.mjs`'s `getClientAdapters()` (Task 2) — this task only needs `bin/create-meko-setup.mjs` to know the id `"opencode"` exists.

- [ ] **Step 1: Add `"opencode"` to `ALL_CLIENTS`**

In `bin/create-meko-setup.mjs`, change:

```js
const ALL_CLIENTS = ['claude-code', 'claude-desktop', 'cursor', 'codex'];
```

to:

```js
const ALL_CLIENTS = ['claude-code', 'claude-desktop', 'cursor', 'codex', 'opencode'];
```

- [ ] **Step 2: Add opencode to the interactive picker's `displayName` map**

Find this block inside `main()`:

```js
      const displayName = {
        'claude-code': 'Claude Code',
        'claude-desktop': 'Claude Desktop',
        cursor: 'Cursor',
        codex: 'OpenAI Codex (CLI + App)',
      }[id];
```

Change it to:

```js
      const displayName = {
        'claude-code': 'Claude Code',
        'claude-desktop': 'Claude Desktop',
        cursor: 'Cursor',
        codex: 'OpenAI Codex (CLI + App)',
        opencode: 'opencode',
      }[id];
```

- [ ] **Step 3: Update the `--client` help text and add a usage example**

In `printHelp()`'s template string, change:

```
  --client <list>       Target clients: one or more of claude-code, claude-desktop, cursor, codex.
```

to:

```
  --client <list>       Target clients: one or more of claude-code, claude-desktop, cursor, codex, opencode.
```

And add a new example after the existing Codex example (`# Install for OpenAI Codex ...`):

```
  # Install for opencode (local Meko, project scope):
  create-meko-setup --client opencode --local --scope project --yes
```

- [ ] **Step 4: Fix `package.json`'s `test:unit` script to point at real files**

The inherited script references `test/config.test.mjs test/validate.test.mjs test/clients.test.mjs`, none of which exist in this repo (the npm package's `files` list excludes `test/`). Update it to the files this plan actually created:

```json
    "test:unit": "node --test test/opencode-config.test.mjs test/opencode-client.test.mjs test/opencode-plugin.test.mjs",
```

- [ ] **Step 5: Manually verify the CLI recognizes the new client**

Run: `node bin/create-meko-setup.mjs --client opencode --local --yes --dry-run`
Expected: exits 0, prints a dry-run walkthrough for "opencode" (banner says `Meko Setup for opencode`), no "Unsupported client" or "Unknown client(s)" error.

- [ ] **Step 6: Run the full test suite one more time**

Run: `npm run test:unit`
Expected: PASS — all opencode tests green.

- [ ] **Step 7: Commit**

```bash
git add bin/create-meko-setup.mjs package.json
git commit -m "Wire opencode into the CLI entry point"
```

---

### Task 7: Manual smoke test against real opencode

**Files:** none (manual verification only — no source changes).

This task has no automated steps; it's the spec's "does it actually work end to end" gate, and it's where the three items ported/designed on inference rather than 100%-certain fact get their real confirmation: the `client.session.messages(...)` response shape (`response.data` vs bare array — the plugin code defensively handles both, confirm which one it actually is), whether opencode auto-loads a plugin referenced only via the `plugin` array (vs also needing the auto-discovery directory), and that `experimental.chat.system.transform`'s `output.system` really is a pre-populated, push-able array.

- [x] **Step 1: Dry-run against the local opencode config**

```bash
node bin/create-meko-setup.mjs --client opencode --local --yes --dry-run
```
Confirm the printed plan mentions `opencode.json`, the plugin path, and the AGENTS.md path under `~/.config/opencode/`.

- [x] **Step 2: Real run against local Meko (or cloud, with a test API key)**

**Adapted:** no Meko server was reachable (no local docker-compose stack — the server's source lives in the private `yugabyte/meko-mcp-server` repo we don't have access to — and no cloud API key). Rather than write into the real `~/.config/opencode/opencode.json` (which has substantial pre-existing provider/agent config) against a backend that couldn't be verified anyway, this ran isolated: `--client opencode --local --scope project --yes --skip-validation` inside a scratch directory. Confirmed: `opencode.json` got `mcp.meko` (type/url/enabled/headers) and a `plugin` array entry; `.opencode/plugin/meko-memory.mjs` and `meko-memory.config.json` (mode 0600) were created; `AGENTS.md` got the sentinel-fenced block.

- [x] **Step 3: Confirm the MCP entry and plugin load against the real opencode binary**

**Adapted (no TUI session, non-interactive check instead):** ran `opencode mcp list --print-logs` from inside the scratch project (real opencode v1.17.20 binary, not simulated). Confirmed: `meko` appears as a `remote` MCP server and opencode attempts to connect (`SSE error: Unable to connect` — the correct, expected failure with no server at `localhost:8000`, not a config-format rejection). This is what surfaced the plugin bug below.

- [ ] **Step 4: Have a real conversation and confirm capture worked** — **not done**, deferred. Requires a reachable Meko server (local repo access or a cloud API key), which wasn't available. Do this once one is available: send a couple of turns in a real opencode session, let it go idle, then check Meko for a conversation tagged `opencode:<repo-basename>`.

- [x] **Step 5: Uninstall and confirm cleanup**

Exercised via the unit tests in Task 5 (`uninstall removes the mcp entry, the plugin, and the AGENTS.md block`) rather than a second manual pass — the isolated scratch directories were deleted directly instead of round-tripped through `--uninstall`, since nothing in Step 2/3 depended on it surviving.

- [x] **Step 6: Record findings — two real bugs found and fixed**

1. **Plugin export contract (found via Step 3).** opencode's plugin loader treats every top-level export of a file in `opencode.json`'s `plugin` array as a plugin candidate and requires each to be callable — confirmed with a minimal repro (`export const X = async () => {}` plus one non-function named export fails with `"Plugin export is not a function"`; the same file without the non-function export loads cleanly). `meko-memory.mjs`'s `__TEST__` export (bundling `deriveAgentId`/`extractExchanges`/etc. for unit tests) broke real plugin loading. Fixed by moving those pure functions into `assets/opencode-plugin/exchange-helpers.mjs` (never referenced in opencode's `plugin` array, so opencode never introspects its exports) and adding a regression test asserting every export of `meko-memory.mjs` is a function. Re-verified against the real binary: no more `"failed to load plugin"` error.
2. **AGENTS.md skill-path mismatch (found by inspection during Step 2).** The reused Codex `renderAgentsMdBlock` hardcoded `~/.agents/skills/meko-mcp-tools/SKILL.md` in its output — a path the opencode adapter never installs anything at. Fixed by adding an optional `skillPath` param to `upsertAgentsMdBlock`/`renderAgentsMdBlock` (defaults to Codex's existing path, so Codex/Cursor/Claude Desktop output is unchanged) and having opencode's `installSkills` pass `skillPath: null` to omit the line.

Both fixes are committed with tests. Step 4 (real capture end-to-end) remains the one unverified piece — the design's biggest inference (the `client.session.messages()` response shape, `session.created`/`session.idle` timing, and `experimental.chat.system.transform`'s `output.system` being pre-populated/pushable) is still unconfirmed against a live Meko backend. Do Step 4 before considering this adapter fully proven, not just code-complete.
