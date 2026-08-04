/**
 * prompt.mjs - Interactive terminal prompts using Node.js readline.
 *
 * Lazy-initializes the readline interface on first use so that importing
 * this module has no side-effects (no stdin/stdout hijacking until needed).
 * Zero external dependencies - Node.js built-ins only.
 */

import { createInterface } from "node:readline";
import { Writable } from "node:stream";

// ---------------------------------------------------------------------------
// Lazy readline singleton
// ---------------------------------------------------------------------------

/** @type {import('node:readline').Interface | null} */
let rl = null;

function getRL() {
  if (!rl) {
    rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }
  return rl;
}

/**
 * Thin promise wrapper around `rl.question`.
 * @param {string} query - The prompt text shown to the user.
 * @returns {Promise<string>}
 */
function question(query) {
  return new Promise((resolve) => {
    getRL().question(query, (answer) => resolve(answer));
  });
}

// ---------------------------------------------------------------------------
// askChoice
// ---------------------------------------------------------------------------

/**
 * Display a numbered list and return the selected option's label.
 *
 * @param {string} questionText
 * @param {{ label: string, description?: string }[]} options
 * @returns {Promise<string>} The `label` of the chosen option.
 *
 * @example
 *   const choice = await askChoice('Connection type:', [
 *     { label: 'Cloud Meko', description: 'Hosted at mekodata.ai' },
 *     { label: 'Local Meko', description: 'docker-compose stack' },
 *   ]);
 */
export async function askChoice(questionText, options) {
  console.log(`\n  ${questionText}`);
  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    const desc = opt.description ? `  - ${opt.description}` : "";
    console.log(`    ${i + 1}) ${opt.label}${desc}`);
  }

  while (true) {
    const raw = await question(`  Choice [1-${options.length}]: `);
    const idx = parseInt(raw.trim(), 10);
    if (idx >= 1 && idx <= options.length) {
      return options[idx - 1].label;
    }
    console.log(`  Please enter a number between 1 and ${options.length}.`);
  }
}

// ---------------------------------------------------------------------------
// askMultiChoice
// ---------------------------------------------------------------------------

/**
 * Display a numbered list and let the user pick multiple items.
 *
 * Input formats accepted (all case-insensitive):
 *   - `1,3,5` comma-separated indices
 *   - `1-3` range, or mixed `1,3-5`
 *   - `all` selects every option, `none` selects none
 *   - empty input accepts the default set shown in the prompt
 *
 * @param {string} questionText
 * @param {{ label: string, description?: string }[]} options
 * @param {{ defaults?: string[] }} [opts] - Labels to default-on; shown with
 *   `[x]` in the list and returned when the user presses Enter.
 * @returns {Promise<string[]>} Array of selected option `label`s.
 */
export async function askMultiChoice(questionText, options, opts = {}) {
  const defaults = new Set(opts.defaults ?? []);
  console.log(`\n  ${questionText}`);
  for (let i = 0; i < options.length; i++) {
    const o = options[i];
    const mark = defaults.has(o.label) ? "[x]" : "[ ]";
    const desc = o.description ? `  - ${o.description}` : "";
    console.log(`    ${mark} ${i + 1}) ${o.label}${desc}`);
  }
  console.log(`  (comma list like "1,3" or "1-3" / "all" / "none" / empty = keep defaults)`);

  while (true) {
    const raw = (await question(`  Choice: `)).trim().toLowerCase();
    if (!raw) {
      return options.filter((o) => defaults.has(o.label)).map((o) => o.label);
    }
    if (raw === "all") return options.map((o) => o.label);
    if (raw === "none") return [];

    const picked = new Set();
    let bad = false;
    for (const token of raw.split(",").map((t) => t.trim()).filter(Boolean)) {
      const rangeMatch = token.match(/^(\d+)-(\d+)$/);
      if (rangeMatch) {
        const lo = parseInt(rangeMatch[1], 10);
        const hi = parseInt(rangeMatch[2], 10);
        if (lo < 1 || hi > options.length || lo > hi) { bad = true; break; }
        for (let i = lo; i <= hi; i++) picked.add(i);
      } else {
        const n = parseInt(token, 10);
        if (!Number.isInteger(n) || n < 1 || n > options.length) { bad = true; break; }
        picked.add(n);
      }
    }
    if (bad || picked.size === 0) {
      console.log(`  Please enter numbers between 1 and ${options.length}, "all", or "none".`);
      continue;
    }
    return [...picked].sort((a, b) => a - b).map((i) => options[i - 1].label);
  }
}

// ---------------------------------------------------------------------------
// askText
// ---------------------------------------------------------------------------

/**
 * Free-text input with an optional default shown in brackets.
 *
 * @param {string} questionText
 * @param {string} [defaultValue]
 * @returns {Promise<string>}
 */
export async function askText(questionText, defaultValue) {
  const suffix = defaultValue != null ? ` [${defaultValue}]` : "";
  const raw = await question(`  ${questionText}${suffix} `);
  const trimmed = raw.trim();
  return trimmed || defaultValue || "";
}

// ---------------------------------------------------------------------------
// askSecret
// ---------------------------------------------------------------------------

/**
 * Hidden input — uses a muted Writable so readline never echoes typed
 * characters. Matches the behavior of `sudo`, `ssh`, `git`, and `npm login`:
 * the cursor sits in place while you type or paste, then a newline appears
 * on submit. No `*` masking (we tried that for four releases and shipped a
 * security bug each time — readline already handles ANSI sequences,
 * bracketed paste, backspace, arrows, and UTF-8 correctly).
 *
 * @param {string} questionText
 * @returns {Promise<string>}
 */
export async function askSecret(questionText) {
  // Close the visible singleton so the muted readline gets exclusive stdin.
  // getRL() recreates it cleanly on the next askText/askYesNo call.
  if (rl) {
    rl.close();
    rl = null;
  }
  // `readline.createInterface` expects stdin in paused mode — it calls
  // `input.resume()` itself when it attaches its `data` listener. Closing
  // the previous readline above leaves stdin in the flowing state it was
  // using, so the muted readline we're about to create reads the user's
  // first keypress through a partially-attached listener chain. Pausing
  // here resets the precondition. Without this, the *next* readline (the
  // post-askSecret singleton recreated in getRL()) never fires `line` and
  // the install hangs with `unsettled top-level await` (issue #81).
  process.stdin.pause();

  // Print the prompt through the real stdout so the user sees it.
  process.stdout.write(`  ${questionText} `);

  // Muted Writable: swallows every byte readline tries to echo. The prompt
  // has already been written above; from here on, silence until we print
  // our own newline after Enter.
  const muted = new Writable({
    write(_chunk, _enc, cb) { cb(); },
  });

  const secretRL = createInterface({
    input: process.stdin,
    output: muted,
    terminal: true,
  });

  // Shared teardown: close the muted readline, re-pause stdin so the next
  // `createInterface` (typically the post-askSecret singleton from getRL())
  // starts from the same precondition Node readline expects, and emit our
  // own newline since the muted output swallowed the one readline would
  // normally print on submit.
  const finish = () => {
    secretRL.close();
    process.stdin.pause();
    process.stdout.write("\n");
  };

  return new Promise((resolve, reject) => {
    secretRL.once("SIGINT", () => {
      finish();
      reject(new Error("User cancelled"));
    });

    secretRL.question("", (answer) => {
      finish();
      resolve(answer);
    });
  });
}

// ---------------------------------------------------------------------------
// askYesNo
// ---------------------------------------------------------------------------

/**
 * Y/n confirmation prompt. Returns a boolean.
 *
 * @param {string} questionText
 * @param {boolean} [defaultYes=true] - When true the prompt shows `[Y/n]`,
 *   otherwise `[y/N]`. Pressing Enter without input uses the default.
 * @returns {Promise<boolean>}
 */
export async function askYesNo(questionText, defaultYes = true) {
  const hint = defaultYes ? "Y/n" : "y/N";
  const raw = await question(`  ${questionText} [${hint}] `);
  const trimmed = raw.trim().toLowerCase();

  if (trimmed === "") return defaultYes;
  return trimmed === "y" || trimmed === "yes";
}

// ---------------------------------------------------------------------------
// close
// ---------------------------------------------------------------------------

/**
 * Tear down the readline interface so the process can exit cleanly.
 * Safe to call multiple times or before any prompt was used.
 */
export function close() {
  if (rl) {
    rl.close();
    rl = null;
  }
}
