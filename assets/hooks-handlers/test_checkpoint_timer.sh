#!/usr/bin/env bash
#
# test_checkpoint_timer.sh — Regression tests for issue #159:
#   - Defect 1: the checkpoint timer must spawn even when the transcript file
#     does not exist yet at SessionStart time (spawn race).
#   - Defect 3: the timer must self-exit (max-age / idle backstop) and
#     session-end.sh must kill it by transcript path when the pid file is gone,
#     so orphaned daemons cannot tick forever.
#
# These tests do NOT require a live Meko MCP server: the timer's self-guard and
# self-exit paths run before any capture.js checkpoint would reach MCP, and we
# assert on process liveness / pid-file presence only.
#
# Usage: ./test_checkpoint_timer.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TIMER_JS="$SCRIPT_DIR/lib/checkpoint-timer.js"
SESSION_START="$SCRIPT_DIR/session-start.sh"
SESSION_END="$SCRIPT_DIR/session-end.sh"

WM_DIR="$(mktemp -d -t meko-timer-test-XXXXXX)"
TX_ROOT="$(mktemp -d -t meko-timer-tx-XXXXXX)"
# Exercise session-end matching when the absolute transcript path contains
# characters that have special meaning in a regular expression.
TX_DIR="$TX_ROOT/path with [regex] chars"
mkdir -p "$TX_DIR"
SESSION_ID="timer-test-$$"
TRANSCRIPT_PATH="$TX_DIR/${SESSION_ID}.jsonl"
PID_FILE="$WM_DIR/${SESSION_ID}.timer.pid"

PASS=0
FAIL=0
SPAWNED_PIDS=()

cleanup() {
  for p in "${SPAWNED_PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  rm -rf "$WM_DIR" "$TX_ROOT"
}
trap cleanup EXIT

log()  { printf "  %-55s" "$1"; }
pass() { printf "\033[32mPASS\033[0m %s\n" "${1:-}"; PASS=$((PASS + 1)); }
fail() { printf "\033[31mFAIL\033[0m %s\n" "${1:-}"; FAIL=$((FAIL + 1)); }

# Poll up to N deciseconds for a process to die. Returns 0 if it died.
wait_gone() {
  local pid="$1" tries="${2:-50}"
  while [ "$tries" -gt 0 ]; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.1
    tries=$((tries - 1))
  done
  return 1
}

export MEKO_WATERMARK_DIR="$WM_DIR"

echo "============================================================"
echo "Test: checkpoint-timer regression (issue #159)"
echo "============================================================"
echo "  Watermark dir: $WM_DIR"
echo "  Transcript:    $TRANSCRIPT_PATH"
echo ""

# ---------------------------------------------------------------------------
# Defect 1 — timer spawns even though transcript does not exist yet.
# session-start.sh backgrounds the timer; capture.js session-start will fail to
# reach MCP but must not block the spawn. The timer must remain alive after its
# first tick while transcript creation is still within the startup grace period.
# ---------------------------------------------------------------------------
echo "--- Defect 1: spawn race (transcript absent at SessionStart) ---"
log "Transcript absent before hook"
[ ! -f "$TRANSCRIPT_PATH" ] && pass || fail "transcript unexpectedly exists"

# Spawn the timer directly the way the fixed session-start.sh does. A one-second
# interval guarantees the missing-transcript branch runs before the assertion.
MEKO_CHECKPOINT_INTERVAL=1 MEKO_TIMER_MAX_AGE=999 MEKO_TIMER_IDLE_EXIT=999 \
  MEKO_TIMER_STARTUP_GRACE=10 \
  nohup node "$TIMER_JS" "$TRANSCRIPT_PATH" </dev/null >/dev/null 2>&1 &
TIMER_PID=$!
SPAWNED_PIDS+=("$TIMER_PID")
sleep 1.5

log "Timer survives first tick with missing transcript"
if kill -0 "$TIMER_PID" 2>/dev/null; then pass "pid $TIMER_PID"; else fail "timer did not stay up"; fi

log "Timer wrote its pid file"
[ -f "$PID_FILE" ] && pass || fail "no pid file at $PID_FILE"

kill "$TIMER_PID" 2>/dev/null || true
wait_gone "$TIMER_PID" || true
rm -f "$PID_FILE"

# ---------------------------------------------------------------------------
# Defect 3a — max-age self-exit. Transcript exists and is fresh, but max-age is
# tiny, so the first tick must self-exit and remove its pid file.
# ---------------------------------------------------------------------------
echo ""
echo "--- Defect 3a: max-age self-exit backstop ---"
printf '{"type":"user","uuid":"u1","message":{"content":"hi"}}\n' > "$TRANSCRIPT_PATH"

MEKO_CHECKPOINT_INTERVAL=1 MEKO_TIMER_MAX_AGE=1 MEKO_TIMER_IDLE_EXIT=999 \
  nohup node "$TIMER_JS" "$TRANSCRIPT_PATH" </dev/null >/dev/null 2>&1 &
TIMER_PID=$!
SPAWNED_PIDS+=("$TIMER_PID")

log "Timer self-exits after max-age"
if wait_gone "$TIMER_PID" 60; then pass; else fail "still running after max-age"; fi

log "Pid file removed on self-exit"
[ ! -f "$PID_FILE" ] && pass || fail "stale pid file remains"

# ---------------------------------------------------------------------------
# Defect 3b — idle self-exit. Make the transcript look old (mtime in the past)
# so the idle backstop trips on the first tick.
# ---------------------------------------------------------------------------
echo ""
echo "--- Defect 3b: idle self-exit backstop ---"
printf '{"type":"user","uuid":"u1","message":{"content":"hi"}}\n' > "$TRANSCRIPT_PATH"
touch -t 202001010000 "$TRANSCRIPT_PATH"   # far in the past

MEKO_CHECKPOINT_INTERVAL=1 MEKO_TIMER_MAX_AGE=999 MEKO_TIMER_IDLE_EXIT=1 \
  nohup node "$TIMER_JS" "$TRANSCRIPT_PATH" </dev/null >/dev/null 2>&1 &
TIMER_PID=$!
SPAWNED_PIDS+=("$TIMER_PID")

log "Timer self-exits on idle transcript"
if wait_gone "$TIMER_PID" 60; then pass; else fail "still running with idle transcript"; fi

# ---------------------------------------------------------------------------
# Defect 3c — session-end.sh kills by transcript path when the pid file is gone.
# ---------------------------------------------------------------------------
echo ""
echo "--- Defect 3c: session-end path-based kill (no pid file) ---"
printf '{"type":"user","uuid":"u1","message":{"content":"hi"}}\n' > "$TRANSCRIPT_PATH"

# Long-lived timer; then delete its pid file to simulate the orphan condition.
MEKO_CHECKPOINT_INTERVAL=999 MEKO_TIMER_MAX_AGE=999 MEKO_TIMER_IDLE_EXIT=999 \
  nohup node "$TIMER_JS" "$TRANSCRIPT_PATH" </dev/null >/dev/null 2>&1 &
TIMER_PID=$!
SPAWNED_PIDS+=("$TIMER_PID")
sleep 0.5
rm -f "$PID_FILE"   # pid file vanished out of band -> classic orphan setup

log "Orphan timer running with no pid file"
if kill -0 "$TIMER_PID" 2>/dev/null && [ ! -f "$PID_FILE" ]; then pass "pid $TIMER_PID"; else fail "precondition not met"; fi

# session-end.sh must find it by transcript path and kill it.
printf '{"transcript_path":"%s"}' "$TRANSCRIPT_PATH" | bash "$SESSION_END" >/dev/null 2>&1 || true

log "session-end.sh killed the orphan by transcript path"
if wait_gone "$TIMER_PID" 30; then pass; else fail "orphan survived session-end"; fi

# ---------------------------------------------------------------------------
echo ""
echo "============================================================"
TOTAL=$((PASS + FAIL))
echo "  Total: $TOTAL  |  Passed: $PASS  |  Failed: $FAIL"
echo "============================================================"
[ "$FAIL" -gt 0 ] && { echo "  RESULT: FAILED"; exit 1; } || { echo "  RESULT: ALL PASSED"; exit 0; }
