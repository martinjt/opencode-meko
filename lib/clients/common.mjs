import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  symlinkSync,
  cpSync,
  lstatSync,
  statSync,
  unlinkSync,
  rmSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MEKO_MCP_USER_AGENT = "meko-mcp-installer/1.0";
export const MEKO_PRODUCTION_MCP_URL = "https://mcp.mekodata.ai/mcp";
export const MEKO_PRODUCTION_CONSOLE_URL = "https://cloud.mekodata.ai";

/**
 * @returns {string} Absolute repository root path.
 */
export function getRepoRoot() {
  const libDir = dirname(fileURLToPath(import.meta.url));
  return resolve(libDir, "..", "..", "..");
}

/**
 * Locate the root of installable assets (skills, hook handlers).
 *
 * When the installer is published to npm, `prepack` copies the assets into
 * `installer/assets/`; that path wins because it guarantees the shipped
 * version of each skill/hook. When running from a source checkout without a
 * packed `assets/` dir, fall back to the repo's `skills/` directory.
 *
 * Layout under both roots mirrors the source tree — callers use
 * `resolveSkillSource`/`resolveHooksRoot` rather than building paths manually.
 *
 * @returns {string} Absolute path to the asset root.
 */
export function getAssetRoot() {
  const libDir = dirname(fileURLToPath(import.meta.url));
  const packed = resolve(libDir, "..", "..", "assets");
  if (existsSync(packed)) return packed;
  return join(getRepoRoot(), "skills");
}

/**
 * True when the installer is running from an npm tarball (prepack-bundled
 * `installer/assets/` exists), false when running from a source checkout.
 * Use this to branch UX between the two install paths — e.g. hiding options
 * that only make sense for repo cloners.
 *
 * @returns {boolean}
 */
export function isPackagedInstall() {
  const libDir = dirname(fileURLToPath(import.meta.url));
  return existsSync(resolve(libDir, "..", "..", "assets"));
}

/**
 * The command a user would run to re-invoke this installer from a fresh
 * shell. Differs between npm/npx (no global bin — must re-invoke via npx)
 * and repo clones (bin isn't on PATH either, so use `node ...`).
 *
 * @returns {string}
 */
export function selfInvocation() {
  return isPackagedInstall()
    ? "npx @yugabytedb/meko-mcp"
    : "node installer/bin/create-meko-setup.mjs";
}

/**
 * @param {string} name - skill directory name (e.g. "meko-mcp-tools")
 * @returns {string} absolute path to the skill source directory
 */
export function resolveSkillSource(name) {
  return join(getAssetRoot(), "skills", name);
}

/**
 * @returns {string} absolute path to the hooks-handlers directory
 */
export function resolveHooksRoot() {
  return join(getAssetRoot(), "hooks-handlers");
}

/**
 * @returns {string} absolute path to the statusline script source.
 *   Lives under skills/scripts/ in source, mirrored under assets/scripts/ in
 *   the npm-packed install — both roots are siblings of skills/hooks-handlers/
 *   and skills/skills/.
 */
export function resolveStatuslineSource() {
  return join(getAssetRoot(), "scripts", "meko-statusline.sh");
}

/**
 * @returns {string} absolute path to the opencode plugin source file.
 *   Lives under skills/opencode-plugin/ in source, mirrored under
 *   assets/opencode-plugin/ in the npm-packed install.
 */
export function resolveOpencodePluginSource() {
  return join(getAssetRoot(), "opencode-plugin", "meko-memory.mjs");
}

/**
 * Run a shell command and return stdout.
 * @param {string} cmd
 * @returns {string}
 */
export function run(cmd) {
  return execSync(cmd, { encoding: "utf8", stdio: "pipe" }).trim();
}

/**
 * @param {string|null|undefined} apiKey
 * @returns {string}
 */
export function redactKey(apiKey) {
  return apiKey ? "<set>" : "<not set>";
}

/**
 * Safely quote a string for shell usage.
 * @param {string} value
 * @returns {string}
 */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// statSync error codes that mean a symlink is broken — its target cannot be
// resolved to a real inode. We deliberately do NOT include EACCES / EPERM:
// those mean "target may exist but I can't see it", and silently removing
// someone else's link based on a permission failure is unsafe.
const BROKEN_SYMLINK_STAT_CODES = new Set([
  "ENOENT", // target does not exist (the textbook "dangling symlink")
  "ENOTDIR", // a non-directory component appears mid-path (e.g. link -> file/child)
  "ELOOP", // too many redirections (cyclic symlinks)
]);

/**
 * True when `targetPath` is a symlink whose target cannot be resolved. A
 * regular file/dir or a working symlink returns false; a missing path also
 * returns false. See `BROKEN_SYMLINK_STAT_CODES` for which resolution
 * failures count.
 *
 * Why this matters: `existsSync` returns false for a broken symlink, so a
 * naive `if (existsSync(dest)) {...}` branch falls through and tries to write
 * over the symlink. On macOS, `cpSync` then aborts the entire process via an
 * uncaught libc++ `filesystem_error` ("Operation not supported" inside
 * `std::filesystem::equivalent`) whenever one operand is a broken symlink —
 * not just the ENOENT case but also ENOTDIR (`link -> file/child`) and ELOOP.
 * Detecting any of these lets callers either treat the path as an existing
 * entry or clear it before writing.
 *
 * @param {string} targetPath
 * @returns {boolean}
 */
export function isDanglingSymlink(targetPath) {
  let stat;
  try {
    stat = lstatSync(targetPath);
  } catch {
    return false;
  }
  if (!stat.isSymbolicLink()) return false;
  try {
    statSync(targetPath);
    return false;
  } catch (err) {
    return BROKEN_SYMLINK_STAT_CODES.has(err.code);
  }
}

/**
 * Unlink that tolerates the narrow race window where another process
 * already removed `targetPath` between our check and our write (ENOENT)
 * but propagates every other failure (EACCES, EPERM, EBUSY, etc.) as a
 * normal JS error.
 *
 * Why not `removePath`: that helper swallows ALL errors, which is fine
 * for cleanup paths but dangerous in front of `cpSync`. If unlink truly
 * fails (e.g. read-only parent dir), the broken symlink is still on
 * disk; cpSync would then dive into the macOS libc++ `filesystem_error`
 * abort path described in `isDanglingSymlink`. Surfacing the unlink
 * error here lets the surrounding installer surface a clean error
 * instead of aborting the process.
 *
 * @param {string} targetPath
 */
function unlinkAllowingMissing(targetPath) {
  try {
    unlinkSync(targetPath);
  } catch (err) {
    if (err && err.code === "ENOENT") return;
    throw err;
  }
}

/**
 * Create symlink when possible; fallback to copy.
 *
 * Pre-clears a broken symlink at `destination` so the copy fallback path
 * doesn't crash. See `isDanglingSymlink` above for the macOS libc++ trap.
 * Uses `unlinkAllowingMissing` rather than `removePath` so an unlink
 * failure (e.g. read-only parent dir) surfaces as a normal JS error
 * instead of silently leaving the broken link in place — otherwise
 * `cpSync` below would still abort the process.
 *
 * @param {string} source
 * @param {string} destination
 * @returns {"symlink"|"copy"}
 */
export function symlinkOrCopy(source, destination, { preferCopy = false } = {}) {
  mkdirSync(dirname(destination), { recursive: true });
  if (isDanglingSymlink(destination)) {
    unlinkAllowingMissing(destination);
  }
  if (preferCopy) {
    cpSync(source, destination, { recursive: true });
    return "copy";
  }
  try {
    symlinkSync(source, destination, "junction");
    return "symlink";
  } catch {
    cpSync(source, destination, { recursive: true });
    return "copy";
  }
}

/** Atomically refresh a runtime-owned directory at a stable path. */
export function installStableTree(source, destination) {
  if (resolve(source) === resolve(destination)) return;
  const suffix = `${process.pid}-${Date.now()}`;
  const staging = `${destination}.tmp-${suffix}`;
  const backup = `${destination}.bak-${suffix}`;

  mkdirSync(dirname(destination), { recursive: true });
  try {
    cpSync(source, staging, { recursive: true });
    if (existsSync(destination)) renameSync(destination, backup);
    try {
      renameSync(staging, destination);
    } catch (err) {
      if (existsSync(backup)) renameSync(backup, destination);
      throw err;
    }
    rmSync(backup, { recursive: true, force: true });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Remove path if it is a symlink or directory/file.
 * @param {string} targetPath
 */
export function removePath(targetPath) {
  try {
    const stat = lstatSync(targetPath);
    if (stat.isSymbolicLink()) {
      unlinkSync(targetPath);
      return;
    }
    rmSync(targetPath, { recursive: true, force: true });
  } catch {
    // no-op
  }
}

// ---------------------------------------------------------------------------
// Installer version markers
// ---------------------------------------------------------------------------
//
// Each artifact the installer owns (a deployed skill dir, a built .skill
// bundle, the Claude Code meko-capture dir, etc.) gets a `.meko-installer`
// marker file stamped with the installer's version. On re-run we compare the
// marker's version against the current installer to decide whether we need
// to force-refresh a managed artifact. Without a marker the artifact is
// treated as user-managed and left alone — we never clobber a dir we didn't
// produce ourselves.
//
// The marker format is deliberately plain text, one `key=value` per line,
// so a human inspecting it with `cat` can immediately see what produced
// the artifact and when.

const MARKER_FILENAME = ".meko-installer";

/**
 * Read the installer's package.json `version` field. Mirrors the read
 * performed in bin/create-meko-setup.mjs:56-59 so the marker and the
 * CLI's --version report agree.
 *
 * @returns {string}
 */
export function getInstallerVersion() {
  const libDir = dirname(fileURLToPath(import.meta.url));
  const pkgPath = resolve(libDir, "..", "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  return pkg.version;
}

/**
 * Write a `.meko-installer` marker inside `dir`. Format is one `key=value`
 * line per field, e.g.
 *
 *   version=1.0.8
 *   installedAt=2026-04-30T14:22:11.123Z
 *
 * Extra key/value pairs can be appended via `extra`. `dir` must exist; this
 * function will not create it (the caller has already done mkdir).
 *
 * @param {string} dir
 * @param {{extra?: Record<string,string>}} [opts]
 * @returns {{path: string, version: string, installedAt: string}}
 */
export function writeInstallerMarker(dir, { extra = {} } = {}) {
  const version = getInstallerVersion();
  const installedAt = new Date().toISOString();
  const lines = [`version=${version}`, `installedAt=${installedAt}`];
  for (const [key, value] of Object.entries(extra)) {
    lines.push(`${key}=${value}`);
  }
  const markerPath = join(dir, MARKER_FILENAME);
  writeFileSync(markerPath, lines.join("\n") + "\n", "utf8");
  return { path: markerPath, version, installedAt };
}

/**
 * Parse a `.meko-installer` marker from `dir`. Returns null if the marker
 * is missing or unreadable. Callers treat null as "not ours / user-managed".
 *
 * Marker format evolved across installer versions:
 *   - pre-1.0.9: a single line containing the word "managed". No version.
 *   - 1.0.9+:    `key=value` lines, including `version=` and `installedAt=`.
 *
 * Both shapes indicate "we own this artifact"; the caller needs to know
 * which shape it got so it can decide whether to force a refresh. Legacy
 * markers have no version to compare against, so they are returned with
 * `legacy: true` and no `version` — `markerIsStale` then treats them as
 * stale (any current version mismatches) and triggers a refresh. That's
 * exactly the behavior users hitting the "stale skill" bug from 1.0.8
 * need on their next re-install.
 *
 * @param {string} dir
 * @returns {{version?: string, installedAt?: string, legacy?: boolean, [k: string]: string|boolean|undefined}|null}
 */
export function readInstallerMarker(dir) {
  const markerPath = join(dir, MARKER_FILENAME);
  let raw;
  try {
    raw = readFileSync(markerPath, "utf8");
  } catch {
    return null;
  }
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!key) continue;
    out[key] = value;
  }
  if (out.version) return out;

  // Legacy marker path: pre-1.0.9 installs wrote the literal text
  // `managed\n` (no `=`). Recognize it so we don't mistake an older
  // managed dir for a user-managed one. Returning a parsed object with
  // `legacy: true` lets markerIsStale do the right thing (stale → refresh).
  if (raw.trim() === "managed") {
    return { legacy: true };
  }
  return null;
}

/**
 * True when the artifact at `dir` was produced by a different installer
 * version than `currentVersion`. Also true when the marker is missing or
 * unparseable — in that case the caller still needs to check whether the
 * artifact dir exists (missing marker + missing dir = fresh install; missing
 * marker + existing dir = user-managed, handle separately).
 *
 * Strict inequality by design — any version change forces a refresh, even
 * a downgrade. We don't want to play semver-comparison games when the
 * artifact content may have changed in either direction.
 *
 * @param {string} dir
 * @param {string} currentVersion
 * @returns {boolean}
 */
export function markerIsStale(dir, currentVersion) {
  const marker = readInstallerMarker(dir);
  if (!marker) return true;
  // Legacy `managed\n` marker has no version recorded — always stale.
  if (marker.legacy) return true;
  return marker.version !== currentVersion;
}
