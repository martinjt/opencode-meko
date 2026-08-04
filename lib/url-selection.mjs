import { MEKO_PRODUCTION_MCP_URL } from "./clients/common.mjs";

function validHttpUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const candidate = value.trim();
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return { value: candidate, comparisonKey: parsed.toString() };
  } catch {
    return null;
  }
}

/**
 * Select the URL offered by interactive/non-interactive setup.
 * Explicit CLI URLs are resolved before this helper is called.
 */
export function resolveSuggestedMcpUrl({
  adapters,
  clients,
  name = "meko",
  scope = "user",
  projectRoot = process.cwd(),
}) {
  const existingUrlsByKey = new Map();
  for (const client of clients) {
    const adapter = adapters[client];
    if (!adapter?.detectExisting) continue;
    try {
      const existing = adapter.detectExisting(name, { scope, projectRoot });
      const url = existing?.found ? validHttpUrl(existing.url) : null;
      if (url && !existingUrlsByKey.has(url.comparisonKey)) {
        existingUrlsByKey.set(url.comparisonKey, url.value);
      }
    } catch {
      // Existing-config discovery is advisory. Installation performs its own
      // prerequisite and config checks later with actionable errors.
    }
  }

  const uniqueUrls = [...existingUrlsByKey.values()];
  if (uniqueUrls.length === 1) {
    return { url: uniqueUrls[0], source: "existing", existingUrls: uniqueUrls };
  }
  if (uniqueUrls.length > 1) {
    return { url: null, source: "conflict", existingUrls: uniqueUrls };
  }
  return {
    url: MEKO_PRODUCTION_MCP_URL,
    source: "production-default",
    existingUrls: [],
  };
}
