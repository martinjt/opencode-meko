/**
 * datapack.mjs — Resolve a migration's destination datapack.
 *
 * The migrator was historically silent about destination: tools were called
 * without `datapack_id`, the server filled in `tenant_ctx.default_datapack_id`,
 * and the user never saw which pack their data actually landed in. With
 * `--datapack <name-or-id>` we want both an explicit override and a printed
 * confirmation of the default-fallback case. This module owns the lookup.
 *
 * Wire model: the MCP server routes by `datapack_id` parameter, not URL host.
 * `datapack_list` returns the user's visible packs; we resolve here, then the
 * orchestrator threads `datapack_id` into every subsequent `tools/call`.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_DATAPACK_NAME = "meko_default_datapack";

export function isUuid(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

/**
 * Parse a `datapack_list` response body. Mirrors the shape-validation in
 * validate.mjs: accepts a JSON array whose elements look like datapack
 * records (`datapack_id` string present). Returns null on any other shape so
 * callers can produce a precise error rather than a TypeError on .find().
 *
 * Note: response bodies can include connection-string secrets — never log
 * `text` directly; only the resolved `{id, name}` is safe to surface.
 *
 * @param {string|null} text
 * @returns {Array|null}
 */
export function parseDatapackList(text) {
  if (!text) return null;
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(body)) return null;
  if (body.length === 0) return body;
  const allLook = body.every(
    (e) => e && typeof e === "object" && typeof e.datapack_id === "string",
  );
  return allLook ? body : null;
}

/**
 * Resolve the destination datapack for a migration.
 *
 * @param {object} opts
 * @param {{callTool: Function}} opts.client    Connected McpClient.
 * @param {string|null} opts.requested          Raw `--datapack` value (UUID or
 *                                              name) or null for default.
 * @returns {Promise<{
 *   ok: boolean,
 *   id?: string|null,
 *   name?: string|null,
 *   source?: "default"|"flag-id"|"flag-name"|"server-fallback",
 *   defaultId?: string|null,
 *   message?: string,
 * }>}
 *
 * `source` describes how the destination was picked:
 *   - `default`: requested=null and a `meko_default_datapack` row exists.
 *   - `flag-id` / `flag-name`: explicit override resolved.
 *   - `server-fallback`: requested=null and no default row found in the list;
 *     we let the server's own fallback chain handle it (id stays null).
 *
 * `defaultId` is the id of the `meko_default_datapack` row if visible — surfaced
 * even when `requested` is non-null so the caller can detect "user named the
 * default explicitly" and reuse the same on-disk state file.
 *
 * Failure cases (`ok: false`):
 *   - `datapack_list` call failed (auth, network, server error).
 *   - response body wasn't a recognizable datapack list.
 *   - explicit override didn't match any row.
 */
export async function resolveDestinationDatapack(opts) {
  const { client, requested } = opts;
  const res = await client.callTool("datapack_list", {
    scope: "read",
    conversation_id: "00000000-0000-0000-0000-000000000000",
  });
  if (!res.ok) {
    return {
      ok: false,
      message:
        `datapack_list failed: ${res.error?.message ?? "unknown"}. ` +
        `Cannot resolve --datapack.`,
    };
  }
  const list = parseDatapackList(res.text);
  if (!list) {
    return {
      ok: false,
      message:
        "datapack_list returned an unrecognized response shape. " +
        "Cannot resolve --datapack.",
    };
  }

  const defaultRow = list.find((d) => d.datapack_name === DEFAULT_DATAPACK_NAME);
  const defaultId = defaultRow?.datapack_id ?? null;

  if (!requested) {
    if (defaultRow) {
      return {
        ok: true,
        id: defaultRow.datapack_id,
        name: defaultRow.datapack_name,
        source: "default",
        defaultId,
      };
    }
    return { ok: true, id: null, name: null, source: "server-fallback", defaultId };
  }

  if (isUuid(requested)) {
    const hit = list.find((d) => d.datapack_id?.toLowerCase() === requested.toLowerCase());
    if (!hit) {
      return {
        ok: false,
        message:
          `--datapack ${requested}: no datapack with that id is visible to ` +
          `this API key. ${formatAvailable(list)}`,
      };
    }
    return {
      ok: true,
      id: hit.datapack_id,
      name: hit.datapack_name ?? null,
      source: "flag-id",
      defaultId,
    };
  }

  const hit = list.find((d) => d.datapack_name === requested);
  if (!hit) {
    return {
      ok: false,
      message:
        `--datapack ${JSON.stringify(requested)}: no datapack with that name. ` +
        formatAvailable(list),
    };
  }
  return {
    ok: true,
    id: hit.datapack_id,
    name: hit.datapack_name,
    source: "flag-name",
    defaultId,
  };
}

/**
 * Format a one-line "Available: a, b, c" hint. Names only — never ids,
 * because the underlying response can carry credentials.
 */
function formatAvailable(list) {
  const names = list
    .map((d) => d.datapack_name)
    .filter((n) => typeof n === "string" && n.length > 0);
  if (names.length === 0) return "(no datapacks visible to this API key.)";
  return `Available: ${names.join(", ")}.`;
}
