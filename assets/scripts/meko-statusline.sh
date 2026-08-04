#!/usr/bin/env bash
# meko-statusline.sh — Claude Code statusline contribution showing the active Meko datapack pin.
#
# Composable: if --inner-cmd is provided (or MEKO_INNER_STATUSLINE env var), runs it first and
# appends our suffix. So a user with an existing statusLine doesn't lose it.
#
# Usage in ~/.claude/settings.json (after installer wires it):
#   { "statusLine": { "type": "command", "command": "$HOME/.claude/meko-statusline.sh --inner-cmd <existing-cmd>" } }
#
# Or, if you maintain the inner command separately, set MEKO_INNER_STATUSLINE=<cmd> in env.
#
# Outputs nothing (empty string) when no pin is set, so the indicator is invisible until you pin.
# The output goes on stdout — Claude Code displays it as-is, supporting ANSI color codes if you
# wrap the suffix.
#
# Reads JSON from stdin (Claude Code passes session metadata) and forwards it verbatim to the inner
# command. The inner command's stdout is printed first, then our suffix.

set -u

INNER_CMD=""
if [[ "${1:-}" == "--inner-cmd" && -n "${2:-}" ]]; then
  INNER_CMD="$2"
elif [[ -n "${MEKO_INNER_STATUSLINE:-}" ]]; then
  INNER_CMD="$MEKO_INNER_STATUSLINE"
fi

# Buffer stdin once so we can pipe the same JSON to both the inner command and our derivation.
STDIN_PAYLOAD=""
if [[ -p /dev/stdin || ! -t 0 ]]; then
  STDIN_PAYLOAD="$(cat)"
fi

# --- Inner command first (preserves any pre-existing statusline content) ---

if [[ -n "$INNER_CMD" ]]; then
  if [[ -n "$STDIN_PAYLOAD" ]]; then
    INNER_OUT="$(printf '%s' "$STDIN_PAYLOAD" | eval "$INNER_CMD" 2>/dev/null || true)"
  else
    INNER_OUT="$(eval "$INNER_CMD" 2>/dev/null || true)"
  fi
  # Strip a single trailing newline so our suffix appears on the same line.
  INNER_OUT="${INNER_OUT%$'\n'}"
  printf '%s' "$INNER_OUT"
fi

# --- Derive agent_id from cwd ---
#
# Mirrors deriveAgentId() in skills/hooks-handlers/lib/capture.js:51-65:
#   - basename of cwd, lowercased
#   - non-[a-z0-9-]+ → '-'
#   - trim leading/trailing '-'
#   - max 64 chars
#   - prefix with 'claude_code:'
#
# Then mirrors datapackPinSlug() in capture.js:341-348:
#   - non-[A-Za-z0-9._-]+ → '_'
#   - trim leading/trailing '_'
#
# Prefer cwd from the JSON stdin payload (Claude Code's session metadata format), falling back
# to PWD if stdin was empty / not piped.

CWD="$PWD"
if [[ -n "$STDIN_PAYLOAD" ]]; then
  # Best-effort extraction without requiring jq. Look for "cwd":"…" first; fall back to "workspace":{"current_dir":"…"}.
  # Isolate the exact key/value pair with grep -oE before extracting so a greedy `.*` can't grab a
  # different key that merely ends in `cwd`/`current_dir` earlier on the same line.
  EXTRACTED="$(printf '%s' "$STDIN_PAYLOAD" | grep -oE '"cwd"[[:space:]]*:[[:space:]]*"[^"]+"' | sed -E 's/.*"([^"]+)"$/\1/' | head -n 1)"
  if [[ -z "$EXTRACTED" ]]; then
    EXTRACTED="$(printf '%s' "$STDIN_PAYLOAD" | grep -oE '"current_dir"[[:space:]]*:[[:space:]]*"[^"]+"' | sed -E 's/.*"([^"]+)"$/\1/' | head -n 1)"
  fi
  if [[ -n "$EXTRACTED" ]]; then
    CWD="$EXTRACTED"
  fi
fi

# MEKO_AGENT_ID overrides the cwd-derived id, matching resolveSessionAgentId() in
# capture.js (the env override wins verbatim when non-empty).
if [[ -n "${MEKO_AGENT_ID:-}" ]]; then
  AGENT_ID="$MEKO_AGENT_ID"
else
  BASENAME="$(basename "$CWD")"
  PROJECT_SLUG="$(printf '%s' "$BASENAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9-]+/-/g; s/^-+|-+$//g')"
  PROJECT_SLUG="${PROJECT_SLUG:0:64}"

  if [[ -z "$PROJECT_SLUG" || "$PROJECT_SLUG" == "-" ]]; then
    AGENT_ID="claude_code"
  else
    AGENT_ID="claude_code:$PROJECT_SLUG"
  fi
fi

PIN_SLUG="$(printf '%s' "$AGENT_ID" | sed -E 's/[^A-Za-z0-9._-]+/_/g; s/^_+|_+$//g')"
# Match datapackPinSlug() in capture.js: an empty slug falls back to the common bucket
# (meko_agent), so both components look for the same pin file.
if [[ -z "$PIN_SLUG" ]]; then
  PIN_SLUG="meko_agent"
fi
PIN_FILE="${MEKO_WATERMARK_DIR:-$HOME/.claude/meko-capture}/pin-${PIN_SLUG}.json"

# --- Read the pin file and append the suffix if a valid pin is present ---

if [[ -f "$PIN_FILE" ]]; then
  # grep -oE isolates the exact "datapack_name":"…" pair before extracting, so a
  # greedy `.*` can't grab a different key that merely ends in datapack_name.
  PIN_NAME="$(grep -oE '"datapack_name"[[:space:]]*:[[:space:]]*"[^"]+"' "$PIN_FILE" | sed -E 's/.*"([^"]+)"$/\1/' | head -n 1)"
  if [[ -n "$PIN_NAME" ]]; then
    SUFFIX="Meko: $PIN_NAME"
    # Add a separator only if the inner command produced output.
    if [[ -n "${INNER_OUT:-}" ]]; then
      printf ' \xe2\x80\xa2 %s' "$SUFFIX"
    else
      printf '%s' "$SUFFIX"
    fi
  fi
fi

# Always finish with a newline so subsequent shell renders cleanly.
printf '\n'
