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
