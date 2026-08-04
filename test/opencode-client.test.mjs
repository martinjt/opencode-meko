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
    const content = readFileSync(agentsMdPath, "utf8");
    assert.match(content, /meko:start/);
    assert.match(content, /mcp__meko__memory_search/);
    // Found during the manual smoke test: opencode has no skills directory
    // (unlike Codex, which the shared block-render logic was written for) —
    // the block must not reference a Codex-only path that opencode never
    // installs.
    assert.doesNotMatch(content, /Skill details/);
    assert.doesNotMatch(content, /\.agents\/skills/);
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
    const first = readFileSync(agentsMdPath, "utf8");
    adapter.installSkills({ name: "meko", dryRun: false, log: silentLog(), scope: "user" });
    const second = readFileSync(agentsMdPath, "utf8");
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
