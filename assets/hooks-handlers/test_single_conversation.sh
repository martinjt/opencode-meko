#!/usr/bin/env bash
#
# test_single_conversation.sh — Verify that exactly ONE Meko conversation
# is created per session, regardless of how many hook modes fire.
#
# Simulates the full hook lifecycle: session-start → checkpoint → pre-compact → session-end.
# Asserts the watermark conversation_id stays the same throughout.
#
# Usage:
#   ./test_single_conversation.sh [MCP_URL]
#
# Environment:
#   MEKO_MCP_URL  MCP server URL (default: http://localhost:8000/mcp)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CAPTURE_JS="$SCRIPT_DIR/lib/capture.js"
MCP_URL="${1:-${MEKO_MCP_URL:-http://localhost:8000/mcp}}"
AGENT_ID="${MEKO_AGENT_ID:-agent}"

# Temp dirs for isolation
WATERMARK_DIR="$(mktemp -d -t meko-test-wm-XXXXXX)"
TRANSCRIPT_DIR="$(mktemp -d -t meko-test-tx-XXXXXX)"
SESSION_ID="test-dedup-$(uuidgen | tr '[:upper:]' '[:lower:]')"
TRANSCRIPT_PATH="$TRANSCRIPT_DIR/${SESSION_ID}.jsonl"
WATERMARK_PATH="$WATERMARK_DIR/${SESSION_ID}.watermark.json"

PASS=0
FAIL=0
CONV_IDS_SEEN=()

cleanup() {
  rm -rf "$WATERMARK_DIR" "$TRANSCRIPT_DIR"
}
trap cleanup EXIT

log()  { printf "  %-50s" "$1"; }
pass() { printf "\033[32mPASS\033[0m %s\n" "${1:-}"; PASS=$((PASS + 1)); }
fail() { printf "\033[31mFAIL\033[0m %s\n" "${1:-}"; FAIL=$((FAIL + 1)); }

read_watermark_conv_id() {
  if [ -f "$WATERMARK_PATH" ]; then
    node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$WATERMARK_PATH','utf-8')).conversation_id||'')"
  fi
}

# Create mock transcript
USER_UUID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
cat > "$TRANSCRIPT_PATH" <<JSONL
{"type":"user","uuid":"$USER_UUID","message":{"content":"What is YugabyteDB?"}}
{"type":"assistant","uuid":"$(uuidgen | tr '[:upper:]' '[:lower:]')","message":{"content":"YugabyteDB is a distributed SQL database."}}
{"type":"user","uuid":"$(uuidgen | tr '[:upper:]' '[:lower:]')","message":{"content":"Does it support PostgreSQL extensions?"}}
{"type":"assistant","uuid":"$(uuidgen | tr '[:upper:]' '[:lower:]')","message":{"content":"Yes, including Apache AGE for graph queries."}}
JSONL

export MEKO_MCP_URL="$MCP_URL"
export MEKO_AGENT_ID="$AGENT_ID"
export MEKO_WATERMARK_DIR="$WATERMARK_DIR"

echo "============================================================"
echo "Test: Single Conversation Per Session (Dedup)"
echo "============================================================"
echo "  MCP URL:      $MCP_URL"
echo "  Session ID:   $SESSION_ID"
echo "  Transcript:   $TRANSCRIPT_PATH ($(wc -l < "$TRANSCRIPT_PATH") lines)"
echo "  Watermark:    $WATERMARK_DIR"
echo ""

# --- Step 1: session-start ---
echo "--- Step 1: session-start ---"

HOOK_INPUT=$(printf '{"transcript_path":"%s"}' "$TRANSCRIPT_PATH")
STDOUT=$(printf '%s' "$HOOK_INPUT" | node "$CAPTURE_JS" session-start 2>/dev/null || true)

log "Watermark file created"
if [ -f "$WATERMARK_PATH" ]; then
  pass
else
  fail "not found at $WATERMARK_PATH"
fi

CONV_A=$(read_watermark_conv_id)
log "Conversation ID assigned"
if [ -n "$CONV_A" ]; then
  pass "$CONV_A"
  CONV_IDS_SEEN+=("$CONV_A")
else
  fail "empty conversation_id in watermark"
fi

log "Hook output contains conversation ID"
if echo "$STDOUT" | grep -q "$CONV_A" 2>/dev/null; then
  pass
else
  fail "stdout did not contain $CONV_A"
fi

# --- Step 2: checkpoint ---
echo ""
echo "--- Step 2: checkpoint ---"

printf '%s' "$HOOK_INPUT" | node "$CAPTURE_JS" checkpoint 2>/dev/null || true

CONV_B=$(read_watermark_conv_id)
log "Watermark conversation unchanged after checkpoint"
if [ "$CONV_B" = "$CONV_A" ]; then
  pass "$CONV_B"
else
  fail "expected $CONV_A, got $CONV_B"
  CONV_IDS_SEEN+=("$CONV_B")
fi

# --- Step 3: pre-compact ---
echo ""
echo "--- Step 3: pre-compact ---"

printf '%s' "$HOOK_INPUT" | node "$CAPTURE_JS" pre-compact 2>/dev/null || true

CONV_C=$(read_watermark_conv_id)
log "Watermark conversation unchanged after pre-compact"
if [ "$CONV_C" = "$CONV_A" ]; then
  pass "$CONV_C"
else
  fail "expected $CONV_A, got $CONV_C"
  CONV_IDS_SEEN+=("$CONV_C")
fi

# --- Step 4: session-end ---
echo ""
echo "--- Step 4: session-end ---"

printf '%s' "$HOOK_INPUT" | node "$CAPTURE_JS" session-end 2>/dev/null || true

CONV_D=$(read_watermark_conv_id)
log "Watermark conversation unchanged after session-end"
if [ "$CONV_D" = "$CONV_A" ]; then
  pass "$CONV_D"
else
  fail "expected $CONV_A, got $CONV_D"
  CONV_IDS_SEEN+=("$CONV_D")
fi

# --- Step 5: Verify exactly one conversation in Meko ---
echo ""
echo "--- Step 5: Verify single conversation ---"

UNIQUE_IDS=($(printf '%s\n' "${CONV_IDS_SEEN[@]}" | sort -u))
log "Unique conversation IDs across all hooks"
if [ ${#UNIQUE_IDS[@]} -eq 1 ]; then
  pass "1 (${UNIQUE_IDS[0]})"
else
  fail "${#UNIQUE_IDS[@]} distinct IDs: ${UNIQUE_IDS[*]}"
fi

# --- Summary ---
echo ""
echo "============================================================"
TOTAL=$((PASS + FAIL))
echo "  Total: $TOTAL  |  Passed: $PASS  |  Failed: $FAIL"
echo "============================================================"

if [ "$FAIL" -gt 0 ]; then
  echo "  RESULT: FAILED"
  exit 1
else
  echo "  RESULT: ALL PASSED"
  exit 0
fi
