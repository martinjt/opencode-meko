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
