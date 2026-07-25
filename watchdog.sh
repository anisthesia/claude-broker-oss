#!/usr/bin/env bash
# claude-broker worker watchdog — on-demand mode.
#
# Pre-checks a worker's broker inbox and only launches a Claude Code session when
# there is pending work (or a patrol interval elapses). The worker drains its inbox
# and exits; the watchdog restarts it when new work arrives. This is what turns a set
# of channels into an autonomous, hands-off worker fleet.
#
# The broker spawns this via start_worker (WATCHDOG_BIN=./watchdog.sh), passing the
# args from your workers.json. You can also run it directly:
#
#   ./watchdog.sh <worker> --repo-root <path> --inbox-channel <channel> [options]
#
# Options:
#   --repo-root <path>                Project root; the session runs in <repo-root>/<worker>.
#   --inbox-channel <channel>         REQUIRED. The channel this worker reads (e.g. team-backend).
#   --patrol-interval <seconds>       Periodically wake an always-on worker (reviewer, QA).
#   --patrol-watch-channel <channel>  Channel checked for new content before a patrol fires
#                                     (default: "<namespace>-status", derived from the inbox channel).
#   --max-session-minutes <minutes>   Hard ceiling on a session's duration (default: 45).
#
# Environment:
#   BROKER_URL      broker base URL (default http://localhost:8080) — injected by start_worker
#   BROKER_SECRET   bearer token; must match the broker SHARED_SECRET — injected by start_worker
#   CLAUDE_BIN      path to the claude binary (default: resolved from PATH)
#   CLAUDE_MODEL    model id for sessions (default: claude-haiku-4-5-20251001)
#
# Stop: Ctrl+C (or stop_worker from the broker).

set -euo pipefail

# ── Parse args ────────────────────────────────────────────────────────────────

WORKER=${1:-}
if [[ -z "$WORKER" ]]; then
  echo "Usage: $0 <worker> --repo-root <path> --inbox-channel <channel> [--patrol-interval <s>] [--max-session-minutes <m>]"
  exit 1
fi
shift

INBOX_CHANNEL=""
PATROL_INTERVAL=""
PATROL_WATCH_CHANNEL=""      # default derived from the inbox namespace below
REPO_ROOT_OVERRIDE=""
MAX_SESSION_MINUTES=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --inbox-channel)          INBOX_CHANNEL="$2";          shift 2 ;;
    --patrol-interval)        PATROL_INTERVAL="$2";        shift 2 ;;
    --patrol-watch-channel)   PATROL_WATCH_CHANNEL="$2";   shift 2 ;;
    --repo-root)              REPO_ROOT_OVERRIDE="$2";     shift 2 ;;
    --max-session-minutes)    MAX_SESSION_MINUTES="$2";    shift 2 ;;
    *) echo "[watchdog:$WORKER] Unknown option: $1"; exit 1 ;;
  esac
done

if [[ -z "$INBOX_CHANNEL" ]]; then
  echo "[watchdog:$WORKER] ERROR: --inbox-channel is required (e.g. --inbox-channel myns-$WORKER)"
  exit 1
fi

# Derive the namespace ("vp" from "vp-backend") for sibling channels.
NAMESPACE="${INBOX_CHANNEL%%-*}"
[[ -z "$PATROL_WATCH_CHANNEL" ]] && PATROL_WATCH_CHANNEL="${NAMESPACE}-status"
TELEMETRY_CHANNEL="${NAMESPACE}-telemetry"

# ── Paths ─────────────────────────────────────────────────────────────────────

if [[ -n "$REPO_ROOT_OVERRIDE" ]]; then
  REPO_ROOT="$REPO_ROOT_OVERRIDE"
else
  REPO_ROOT="$(pwd)"
fi
WORKER_DIR="$REPO_ROOT/$WORKER"
CLAUDE="${CLAUDE_BIN:-$(command -v claude 2>/dev/null || echo "$HOME/.local/bin/claude")}"
BROKER_URL="${BROKER_URL:-http://localhost:8080}"
BROKER_SECRET="${BROKER_SECRET:-}"

if [[ ! -d "$WORKER_DIR" ]]; then
  echo "[watchdog:$WORKER] ERROR: directory not found: $WORKER_DIR"
  exit 1
fi
if [[ ! -f "$WORKER_DIR/CLAUDE.md" ]]; then
  echo "[watchdog:$WORKER] WARN: no CLAUDE.md in $WORKER_DIR — the session runs without a role file."
  echo "  Place this worker's role file there (e.g. from 'npm run setup --scaffold-roles')."
fi
if [[ ! -x "$CLAUDE" ]]; then
  echo "[watchdog:$WORKER] ERROR: claude binary not found at '$CLAUDE'"
  echo "  Install Claude Code, or set CLAUDE_BIN to its path."
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "[watchdog:$WORKER] ERROR: node is required (used for JSON parsing)"; exit 1
fi

# ── Cursor / lock files ───────────────────────────────────────────────────────

SAFE_NAME="${WORKER//\//-}"
REGISTRY_NAME="${WORKER##*/}"
_SAFE_CHANNEL="${INBOX_CHANNEL//[^a-zA-Z0-9]/-}"
CURSOR_FILE="/tmp/watchdog-${SAFE_NAME}-${_SAFE_CHANNEL}-cursor"
PATROL_CURSOR_FILE="/tmp/watchdog-${SAFE_NAME}-${_SAFE_CHANNEL}-patrol"
LOCK_FILE="/tmp/watchdog-${SAFE_NAME}-${_SAFE_CHANNEL}.lock"
HEARTBEAT_INTERVAL=30

read_cursor()          { [[ -f "$CURSOR_FILE" ]] && cat "$CURSOR_FILE" || echo "0"; }
write_cursor()         { echo "$1" > "$CURSOR_FILE"; }
read_patrol_cursor()   { [[ -f "$PATROL_CURSOR_FILE" ]] && cat "$PATROL_CURSOR_FILE" || echo "0"; }
write_patrol_cursor()  { echo "$1" > "$PATROL_CURSOR_FILE"; }

# ── JSON helpers (Node — guaranteed present, no python3 dependency) ────────────

json_pending() {  # exit 0 if .pending truthy
  [[ -z "$1" ]] && return 1
  printf '%s' "$1" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.exit(JSON.parse(d).pending?0:1)}catch{process.exit(1)}})'
}
json_max_id() {
  [[ -z "$1" ]] && { echo "0"; return; }
  printf '%s' "$1" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).max_id||0)}catch{console.log(0)}})'
}
json_encode() {  # JSON-string-encode stdin
  node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.stringify(d)))'
}

# ── Broker checks (authenticated — /inbox requires the bearer token) ───────────

_auth_hdr() { [[ -n "${BROKER_SECRET:-}" ]] && printf '%s\n%s' "-H" "Authorization: Bearer ${BROKER_SECRET}"; }

check_channel() {
  local channel="$1" since_id="$2"
  local hdr=(); [[ -n "${BROKER_SECRET:-}" ]] && hdr=(-H "Authorization: Bearer ${BROKER_SECRET}")
  curl -sf --max-time 5 "${hdr[@]}" "${BROKER_URL}/inbox?channel=${channel}&since_id=${since_id}" 2>/dev/null || echo ""
}
check_inbox() { check_channel "$INBOX_CHANNEL" "$1"; }

emit_heartbeat() {
  local state="$1" exit_code="${2:-}"
  local ts hb
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  if [[ -n "$exit_code" ]]; then
    hb=$(printf '{"type":"heartbeat","from":"%s","ts":"%s","model":"%s","context":{"size_tokens":0,"tier_threshold_pct":0,"rotation_recommended":false},"activity":{"state":"%s","exit_code":%s}}' \
      "$REGISTRY_NAME" "$ts" "${CLAUDE_MODEL:-claude-haiku-4-5-20251001}" "$state" "$exit_code")
  else
    hb=$(printf '{"type":"heartbeat","from":"%s","ts":"%s","model":"%s","context":{"size_tokens":0,"tier_threshold_pct":0,"rotation_recommended":false},"activity":{"state":"%s"}}' \
      "$REGISTRY_NAME" "$ts" "${CLAUDE_MODEL:-claude-haiku-4-5-20251001}" "$state")
  fi
  local hdr=(); [[ -n "${BROKER_SECRET:-}" ]] && hdr=(-H "Authorization: Bearer ${BROKER_SECRET}")
  curl -sf -X POST "${BROKER_URL}/messages" "${hdr[@]}" -H "Content-Type: application/json" \
    -d "{\"channel\":\"${TELEMETRY_CHANNEL}\",\"sender\":\"${REGISTRY_NAME}\",\"content\":$(printf '%s' "$hb" | json_encode)}" \
    >/dev/null 2>&1 || true
}

# ── Restart delays / limits ───────────────────────────────────────────────────

DELAY_IDLE=10; DELAY_NORMAL=2; DELAY_CRASH=15
DELAY_RATE_LIMIT=60; RATE_LIMIT_MAX=300
if [[ -n "$MAX_SESSION_MINUTES" ]]; then MAX_SESSION_SECONDS=$(( MAX_SESSION_MINUTES * 60 )); else MAX_SESSION_SECONDS=${MAX_SESSION_SECONDS:-2700}; fi
MAX_CONCURRENT=${MAX_CONCURRENT:-8}
_CONCURRENT_DIR="/tmp/watchdog-concurrent"
_SLOT_FILE=""

# ── Instance lock ─────────────────────────────────────────────────────────────
_try_lock() {
  if ( set -o noclobber; echo $$ > "$LOCK_FILE" ) 2>/dev/null; then return 0; fi
  local ex; ex=$(cat "$LOCK_FILE" 2>/dev/null || echo "")
  if [[ -n "$ex" ]] && kill -0 "$ex" 2>/dev/null; then
    echo "[watchdog:$WORKER] already running (pid $ex) — exiting"; exit 1
  fi
  echo "[watchdog:$WORKER] removing stale lock (pid ${ex:-?})"; rm -f "$LOCK_FILE"
  ( set -o noclobber; echo $$ > "$LOCK_FILE" ) 2>/dev/null || { echo "[watchdog:$WORKER] lock race — exiting"; exit 1; }
}
_try_lock

# ── Concurrency semaphore ─────────────────────────────────────────────────────
_acquire_slot() {
  mkdir -p "$_CONCURRENT_DIR"
  local i sf spid
  for i in $(seq 1 "$MAX_CONCURRENT"); do
    sf="$_CONCURRENT_DIR/slot-${i}"
    if [[ -f "$sf" ]]; then
      spid=$(cat "$sf" 2>/dev/null || echo "")
      { [[ -z "$spid" ]] || ! kill -0 "$spid" 2>/dev/null; } && rm -f "$sf"
    fi
    if ( set -o noclobber; echo $$ > "$sf" ) 2>/dev/null; then _SLOT_FILE="$sf"; return 0; fi
  done
  return 1
}
_release_slot() { [[ -n "$_SLOT_FILE" ]] && rm -f "$_SLOT_FILE"; _SLOT_FILE=""; }

trap 'rm -f "$LOCK_FILE"; _release_slot; echo "[watchdog:$WORKER] stopping"; exit 0' INT TERM

_JITTER=$(( RANDOM % 20 )); [[ $_JITTER -gt 0 ]] && sleep "$_JITTER"

echo "[watchdog:$WORKER] starting — dir: $WORKER_DIR  inbox: $INBOX_CHANNEL  max-session: $(( MAX_SESSION_SECONDS / 60 ))min"
[[ -n "$PATROL_INTERVAL" ]] && echo "[watchdog:$WORKER] patrol every ${PATROL_INTERVAL}s (watch: $PATROL_WATCH_CHANNEL)"

RESTART_COUNT=0; RATE_LIMIT_BACKOFF=$DELAY_RATE_LIMIT
LAST_PATROL_START=0; PATROL_JSON=""

while true; do
  CURSOR=$(read_cursor); NOW=$(date +%s); START_REASON=""

  INBOX_JSON=$(check_inbox "$CURSOR")
  json_pending "$INBOX_JSON" && START_REASON="inbox"

  if [[ -z "$START_REASON" && -n "$PATROL_INTERVAL" ]]; then
    if [[ $(( NOW - LAST_PATROL_START )) -ge $PATROL_INTERVAL ]]; then
      PATROL_JSON=$(check_channel "$PATROL_WATCH_CHANNEL" "$(read_patrol_cursor)")
      if json_pending "$PATROL_JSON"; then START_REASON="patrol"; else LAST_PATROL_START=$NOW; fi
    fi
  fi

  if [[ -z "$START_REASON" ]]; then sleep $DELAY_IDLE; continue; fi

  if ! _acquire_slot; then
    echo "[watchdog:$WORKER] all $MAX_CONCURRENT slots busy — retrying in ${DELAY_IDLE}s"; sleep $DELAY_IDLE; continue
  fi

  MAX_ID=$(json_max_id "$INBOX_JSON")
  echo "[watchdog:$WORKER] --- restart #$RESTART_COUNT [reason: $START_REASON, inbox_max_id: $MAX_ID] ---"
  RESTART_COUNT=$((RESTART_COUNT + 1))
  [[ "$START_REASON" == "patrol" ]] && LAST_PATROL_START=$NOW

  TMPOUT=$(mktemp /tmp/watchdog-${SAFE_NAME}-XXXXXX)
  _TFLAG=$(mktemp /tmp/watchdog-${SAFE_NAME}-timeout-XXXXXX); rm -f "$_TFLAG"

  set +e
  ( cd "$WORKER_DIR"; exec "$CLAUDE" -p "go" --dangerously-skip-permissions --model "${CLAUDE_MODEL:-claude-haiku-4-5-20251001}" ) > "$TMPOUT" 2>&1 &
  _BGPID=$!

  ( _START=$(date +%s)
    while kill -0 "$_BGPID" 2>/dev/null; do
      _EL=$(( $(date +%s) - _START ))
      [[ $(( _EL % HEARTBEAT_INTERVAL )) -lt 1 ]] && emit_heartbeat "working" >/dev/null 2>&1 || true
      if [[ $_EL -ge $MAX_SESSION_SECONDS ]]; then
        touch "$_TFLAG"; echo "[watchdog:$WORKER] max-session reached — terminating"
        kill -TERM "$_BGPID" 2>/dev/null; sleep 5; kill -KILL "$_BGPID" 2>/dev/null; break
      fi
      sleep 1
    done ) &
  _TPID=$!

  wait "$_BGPID" 2>/dev/null; _WAIT_CODE=$?
  kill "$_TPID" 2>/dev/null; wait "$_TPID" 2>/dev/null || true
  [[ -f "$_TFLAG" ]] && EXIT_CODE=124 || EXIT_CODE=$_WAIT_CODE
  rm -f "$_TFLAG"; _release_slot; set -e

  RATE_LIMITED=false
  grep -qiE "rate.limit|429|too many requests|overloaded|capacity|hit your limit|usage limit" "$TMPOUT" 2>/dev/null && RATE_LIMITED=true
  emit_heartbeat "session-end" "$EXIT_CODE"
  rm -f "$TMPOUT"

  if [[ $EXIT_CODE -eq 0 ]]; then
    [[ "$MAX_ID" -gt "$CURSOR" ]] && write_cursor "$MAX_ID"
    if [[ -n "$PATROL_INTERVAL" ]]; then
      PL=$(json_max_id "$PATROL_JSON"); [[ "$PL" -gt "0" ]] && write_patrol_cursor "$PL"
    fi
    echo "[watchdog:$WORKER] clean exit — cursor=$MAX_ID, restarting in ${DELAY_NORMAL}s"
    RATE_LIMIT_BACKOFF=$DELAY_RATE_LIMIT; sleep $DELAY_NORMAL
  elif [[ "$RATE_LIMITED" == "true" ]]; then
    JIT=$(( RANDOM % 16 )); WAIT=$(( RATE_LIMIT_BACKOFF + JIT ))
    echo "[watchdog:$WORKER] RATE LIMITED — backing off ${WAIT}s"
    sleep $WAIT
    RATE_LIMIT_BACKOFF=$(( RATE_LIMIT_BACKOFF * 2 )); [[ $RATE_LIMIT_BACKOFF -gt $RATE_LIMIT_MAX ]] && RATE_LIMIT_BACKOFF=$RATE_LIMIT_MAX
  elif [[ $EXIT_CODE -eq 124 ]]; then
    echo "[watchdog:$WORKER] session timeout — restarting in ${DELAY_CRASH}s (cursor unchanged)"
    RATE_LIMIT_BACKOFF=$DELAY_RATE_LIMIT; sleep $DELAY_CRASH
  else
    echo "[watchdog:$WORKER] non-zero exit ($EXIT_CODE) — restarting in ${DELAY_CRASH}s (cursor unchanged)"
    RATE_LIMIT_BACKOFF=$DELAY_RATE_LIMIT; sleep $DELAY_CRASH
  fi
done
