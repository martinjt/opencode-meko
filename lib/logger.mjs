/**
 * logger.mjs - Console output helpers with ANSI colors.
 *
 * Respects the NO_COLOR convention (https://no-color.org/).
 * Zero external dependencies - Node.js built-ins only.
 */

const useColor = !process.env.NO_COLOR;

// ANSI codes, collapsed to empty strings when color is suppressed.
const RESET = useColor ? "\x1b[0m" : "";
const BLUE = useColor ? "\x1b[34m" : "";
const GREEN = useColor ? "\x1b[32m" : "";
const YELLOW = useColor ? "\x1b[33m" : "";
const RED = useColor ? "\x1b[31m" : "";
const GRAY = useColor ? "\x1b[90m" : "";
const BOLD = useColor ? "\x1b[1m" : "";

// Unicode symbols with plain-text fallbacks when color is off.
const CHECK = useColor ? "\u2713" : "OK";
const CROSS = useColor ? "\u2717" : "FAIL";
const BULLET = useColor ? "\u2022" : "*";

/**
 * Print an informational message.
 * Example: ℹ  Checking prerequisites...
 */
export function info(msg) {
  console.log(`${BLUE}${BULLET}${RESET} ${msg}`);
}

/**
 * Print a success message.
 * Example: ✓ Server registered
 */
export function success(msg) {
  console.log(`${GREEN}${CHECK}${RESET} ${msg}`);
}

/**
 * Print a warning message.
 * Example: ⚠ Config already exists
 */
export function warn(msg) {
  console.log(`${YELLOW}!${RESET} ${msg}`);
}

/**
 * Print an error message.
 * Example: ✗ Connection failed
 */
export function error(msg) {
  console.error(`${RED}${CROSS}${RESET} ${msg}`);
}

/**
 * Print a numbered step that is in progress.
 * Example: [1/5] Registering MCP server...
 */
export function step(n, total, msg) {
  console.log(`${BLUE}[${n}/${total}]${RESET} ${msg}`);
}

/**
 * Print a numbered step that succeeded.
 * Example: ✓ [1/5] MCP server registered.
 */
export function stepOk(n, total, msg) {
  console.log(`${GREEN}${CHECK}${RESET} ${BLUE}[${n}/${total}]${RESET} ${msg}`);
}

/**
 * Print a numbered step that failed.
 * Example: ✗ [3/5] Registering plugin marketplace failed: ...
 */
export function stepFail(n, total, msg) {
  console.log(`${RED}${CROSS}${RESET} ${BLUE}[${n}/${total}]${RESET} ${msg}`);
}

/**
 * Print a prominent banner / header line.
 * Example:
 *   ━━━ Meko Setup for Claude Code ━━━
 */
export function banner(title) {
  const rule = useColor ? "\u2501".repeat(3) : "---";
  console.log("");
  console.log(`${BOLD}${BLUE}${rule} ${title} ${rule}${RESET}`);
  console.log("");
}

/**
 * Print dimmed / secondary text (e.g. URLs, paths, hints).
 */
export function dim(msg) {
  console.log(`${GRAY}${msg}${RESET}`);
}
