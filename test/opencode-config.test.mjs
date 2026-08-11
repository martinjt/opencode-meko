import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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

test("resolveOpencodePluginSource: points at the plugin asset DIRECTORY, containing both the entry file and its sibling import", () => {
  // Regression guard for a real bug: this used to point at the single
  // meko-memory.mjs file, so installStableTree never copied its sibling
  // exchange-helpers.mjs (a relative import meko-memory.mjs depends on) —
  // the plugin failed to load at runtime with no error surfaced anywhere.
  const source = resolveOpencodePluginSource();
  assert.ok(source.endsWith("opencode-plugin"));
  assert.equal(existsSync(join(source, "meko-memory.mjs")), true);
  assert.equal(existsSync(join(source, "exchange-helpers.mjs")), true);
});
