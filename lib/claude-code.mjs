/**
 * Backward-compatible exports.
 * Legacy callers importing ./claude-code.mjs continue to work, but all logic
 * now routes through the multi-client installer with Claude Code selected.
 */
import { install as installGeneric, uninstall as uninstallGeneric } from "./installer.mjs";

export async function install(options) {
  return installGeneric({ ...options, client: "claude-code" });
}

export async function uninstall(options = {}) {
  return uninstallGeneric({ ...options, client: "claude-code" });
}
