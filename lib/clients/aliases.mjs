// Tokens the cloud UI or older docs pass on `--client` that should map to a
// canonical adapter ID. Kept in a tiny, side-effect-free module so tests can
// import it without booting the bin entry point.
export const CLIENT_ALIASES = Object.freeze({
  claude: "claude-code",
});

/**
 * Parse a `--client` argument into a deduplicated list of client IDs.
 *
 * @param {string|null|undefined} raw - Raw CLI argument value.
 * @param {string[]} allClients - Canonical IDs accepted by the installer.
 * @returns {{clients: string[], invalid: string[]}}
 */
export function parseClientList(raw, allClients) {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { clients: ["claude-code"], invalid: [] };
  if (trimmed.toLowerCase() === "all") {
    return { clients: [...allClients], invalid: [] };
  }

  const tokens = trimmed
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => CLIENT_ALIASES[t] ?? t);
  const invalid = tokens.filter((t) => !allClients.includes(t));
  const clients = [...new Set(tokens.filter((t) => allClients.includes(t)))];
  return { clients, invalid };
}
