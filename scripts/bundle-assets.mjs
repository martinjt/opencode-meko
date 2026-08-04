#!/usr/bin/env node
/**
 * Copy skill/hook assets from the repo into installer/assets/ so the npm
 * tarball can be installed without a repo checkout. Invoked by `prepack`;
 * `postpack` re-runs this with --clean.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const installerRoot = resolve(scriptDir, "..");
const repoRoot = resolve(installerRoot, "..");
const assetsDir = join(installerRoot, "assets");

const PAYLOAD = [
  {
    from: join(repoRoot, "skills", "skills", "meko-mcp-tools"),
    to: join(assetsDir, "skills", "meko-mcp-tools"),
  },
  {
    from: join(repoRoot, "skills", "skills", "meko-mcp-tools-desktop"),
    to: join(assetsDir, "skills", "meko-mcp-tools-desktop"),
  },
  {
    from: join(repoRoot, "skills", "skills", "meko-select-datapack-desktop"),
    to: join(assetsDir, "skills", "meko-select-datapack-desktop"),
  },
  {
    from: join(repoRoot, "skills", "hooks-handlers"),
    to: join(assetsDir, "hooks-handlers"),
  },
  {
    from: join(repoRoot, "skills", "scripts", "package-desktop-skill.sh"),
    to: join(assetsDir, "scripts", "package-desktop-skill.sh"),
  },
  {
    from: join(repoRoot, "skills", "scripts", "meko-statusline.sh"),
    to: join(assetsDir, "scripts", "meko-statusline.sh"),
  },
];

const cleaning = process.argv.includes("--clean");

if (cleaning) {
  if (existsSync(assetsDir)) {
    rmSync(assetsDir, { recursive: true, force: true });
  }
  process.exit(0);
}

if (existsSync(assetsDir)) {
  rmSync(assetsDir, { recursive: true, force: true });
}
mkdirSync(assetsDir, { recursive: true });

for (const { from, to } of PAYLOAD) {
  if (!existsSync(from)) {
    console.error(`bundle-assets: missing source ${from}`);
    process.exit(1);
  }
  cpSync(from, to, { recursive: true });
}

console.log(`bundle-assets: wrote ${PAYLOAD.length} paths under ${assetsDir}`);
