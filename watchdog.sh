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
#   --repo-root <path>                Project root; the session runs in <repo-root>/<worker>. Omitted:
#                                     WATCHDOG_REPO_ROOT, else cwd / this script's dir / its parent,
#                                     whichever holds <worker>.
#   --inbox-channel <channel>         The channel this worker reads (e.g. team-backend). Omitted:
#                                     <ns>-<worker> (orchestrators/<x>: <ns>-<x>-orch), ns from
#                                     WATCHDOG_NAMESPACE — with neither, the watchdog exits with an error.
#   --patrol-interval <seconds>       Periodically wake an always-on worker (reviewer, QA).
#   --patrol-watch-channel <channel>  Channel checked for new content before a patrol fires
#                                     (default: "<namespace>-status", derived from the inbox channel).
#   --max-session-minutes <minutes>   Hard ceiling on a session's duration (default: 45).
#   --print-channels                  Print the derived sibling channels (telemetry, status,
#                                     rate-limits, patrol-watch), identity (role, as, MCP query) and
#                                     the verification switch, and exit — for tests and debugging.
#   --once                            Run at most one session, then exit (tests / one-shot runs).
#   --launcher <cli|sdk>              Session launcher for this worker; overrides WATCHDOG_LAUNCHER
#                                     (start_worker has no per-entry env, so this goes in the entry's args).
#
# Environment:
#   BROKER_URL      broker base URL (default http://localhost:8080) — injected by start_worker
#   BROKER_SECRET   bearer token; must match the broker SHARED_SECRET — injected by start_worker
#   CLAUDE_BIN      path to the claude binary (default: resolved from PATH)
#   CLAUDE_MODEL    pinned model for every session (start_worker sets it from model= or the entry's
#                   "model", with WATCHDOG_MODEL_PINNED=1). With WATCHDOG_MODEL_PINNED=0 it is only the
#                   default for unpinned sessions. Unpinned sessions are routed per launch — see
#                   "Model routing" below.
#   WATCHDOG_MODEL_PINNED  1/0, set by start_worker. Unset (a hand-run watchdog): CLAUDE_MODEL pins.
#   WATCHDOG_MODEL_BY_SCOPE  scope -> model for the next open task's scope (default
#                   small=claude-sonnet-5-5,medium=claude-sonnet-5-5,large=claude-opus-5-5)
#   WATCHDOG_ENTRY_MODEL_BY_SCOPE  the config entry's "model_by_scope", set by start_worker; wins per scope
#   WATCHDOG_REVIEWER  1/0, set by start_worker (entry role "reviewer" or name *-reviewer). Unset: the
#                   derived role below.
#   WATCHDOG_REVIEWER_MODEL  unpinned reviewer sessions (default claude-opus-5-5)
#   WATCHDOG_NO_TASK_MODEL   patrol sessions and sessions with no open task (default claude-haiku-4-5-20251001)
#   WATCHDOG_MODEL_WARNING   set by start_worker when this namespace's reviewer and a writer resolve to
#                   the same model; logged at startup and printed by --print-channels
#   NODE_BIN        node binary for JSON parsing (default: PATH, then /usr/local/bin, /opt/homebrew/bin,
#                   newest ~/.nvm version — a launchd-started broker passes a PATH without node)
#   MAX_SESSION_SECONDS / MAX_CONCURRENT  session ceiling when --max-session-minutes is absent
#                   (default 2700) / fleet-wide concurrent sessions (default 8)
#   WATCHDOG_MCP    1 (default): hand every session its own MCP config pointing at
#                   BROKER_URL/mcp?ns=&as= (+role= when opted in; --mcp-config, plus --strict-mcp-config when
#                   supported) so a worker never depends on a .mcp.json in its checkout or a
#                   user-scope registration — and can never silently attach to a different broker. 0: launch with no MCP flags.
#   WATCHDOG_NAMESPACE  the worker's namespace — exported by start_worker from the config entry's
#                   "ns"; else taken from the --inbox-channel prefix
#   WATCHDOG_ROLE / WATCHDOG_AS  override the derived MCP identity (role: worker|reviewer|
#                   orchestrator|admin; as: the session's sender name) — see "Identity" below.
#                   An explicit WATCHDOG_ROLE also puts role= in the URL.
#   WATCHDOG_SELF_SENDERS  extra comma list of sender names this worker posts as; with WATCHDOG_AS and the
#                   worker path basename they are excluded from the inbox and patrol wake checks
#   WATCHDOG_ROLE_URL 1: put role= in every session's MCP URL. Default 0: only ns=&as=, which the
#                   broker treats as no identity (pre-v3 tool list). Opting in also switches the
#                   heartbeat sender / cursor / ledger key from the worker path basename to WATCHDOG_AS.
#   WATCHDOG_ROLE_NAMESPACES  comma list of namespaces whose sessions get role= (per-namespace
#                   adoption); start_worker passes it through from the broker env. Default empty.
#   WATCHDOG_NS_ADOPTED  1: the namespace is adopted (adopt_namespace) — role= on, keys on WORKER_AS.
#                   start_worker always sets it from the broker DB at spawn time. An explicit
#                   WATCHDOG_ROLE_URL=0 overrides it.
#   WATCHDOG_MCP_INHERIT 1: also carry the user/local/project-scope MCP servers into that config
#                   (strict mode drops them otherwise). Unset or anything else: the broker only.
#   WATCHDOG_MCP_SERVERS  JSON array of MCP server names (the entry's "mcp_servers", set by start_worker):
#                   broker + exactly those servers from user/local/project scope, overriding
#                   WATCHDOG_MCP_INHERIT; [] = broker only. Unset/empty: WATCHDOG_MCP_INHERIT decides.
#   WATCHDOG_JITTER_MAX  start-up jitter ceiling in seconds (default 20; 0 in tests)
#   WATCHDOG_STREAM_JSON 1 (default): launch with --output-format stream-json --verbose so the
#                   watchdog can read the session's real context size from its own stdout. 0: plain
#                   text output (context size is then reported as 0, as before).
#   WATCHDOG_HEARTBEAT_INTERVAL  seconds between in-session heartbeats (default 30)
#   ROTATE_AT_TOKENS     context size at which heartbeats carry rotation_recommended:true
#                   (default 150000; 0 disables rotation)
#   ROTATE_KILL_AFTER_S  a session still over ROTATE_AT_TOKENS this many seconds after crossing it is
#                   terminated and relaunched fresh (default 300; 0 = only recommend, never kill)
#   WATCHDOG_ROTATION_HOOK  path to rotation.mjs (default: hooks/ next to this script). Installed for
#                   every namespace while ROTATE_AT_TOKENS > 0; missing = WARN, sessions run without it
#   NET_BACKOFF_BASE / NET_BACKOFF_MAX  exponential relaunch backoff, in seconds, after a session
#                   dies because the API is unreachable (ENOTFOUND, connection errors) —
#                   default 15 / 600; reset by the next successful session
#   WATCHDOG_LAUNCHER  cli (default): sessions run as `claude -p`. sdk: sessions run through
#                   runner/run-worker.mjs (Claude Agent SDK, API-key billing; see runner/README.md)
#                   with the same cwd, model, MCP config file and env. Any other value: exit 2.
#   WATCHDOG_RUNNER    path to run-worker.mjs for the sdk launcher (default: runner/ next to this script)
#   WATCHDOG_VERIFY_NAMESPACES  comma list of namespaces whose results are harness-verified: after each
#                   session, verify-result.mjs re-runs the dispatch checks[] of every new result with
#                   body.commits in a scratch worktree at its commit and stamps the outcome on the broker
#                   (get_task_ledger verified column). WATCHDOG_VERIFY=1 turns it on for any namespace,
#                   WATCHDOG_VERIFY=0 off for all. Default: off.
#                   VERIFIER_TRUST_NAMESPACES (or the broker's /health verifier_trust) lists namespaces
#                   verified by the standalone verifier instead (verify-result.mjs --watch): off here.
#   WATCHDOG_VERIFIER  path to verify-result.mjs (default: next to this script)
#   WATCHDOG_GUARDRAIL_NAMESPACES  comma list of namespaces whose sessions run with the guardrail
#                   PreToolUse hook (hooks/guardrails.mjs): denies force pushes, pushes to main/master,
#                   reset --hard / clean -f / rm -r outside the worktree, credential reads, --no-verify,
#                   and killing, launchctl-cycling or starting the broker on BROKER_URL's port.
#                   WATCHDOG_GUARDRAILS=1 turns it on for any namespace, WATCHDOG_GUARDRAILS=0 off for all.
#                   Default: off. Denies are copied into this log after each session.
#   WATCHDOG_GUARDRAILS_HOOK  path to guardrails.mjs (default: hooks/ next to this script)
#   WATCHDOG_GUARDRAILS_EXTRA_DENY  the config entry's guardrails.extra_deny (JSON array), set by start_worker
#   WATCHDOG_ALLOWED_TOOLS / WATCHDOG_DISALLOWED_TOOLS  the config entry's allowed_tools / disallowed_tools
#                   (JSON arrays), set by start_worker: --allowedTools / --disallowedTools (sdk: the
#                   runner's allowedTools / disallowedTools). With guardrails on, allowed_tools is enforced
#                   as a strict allowlist by the hook (bypass mode makes --allowedTools pre-approve only).
#
# Stop: Ctrl+C (or stop_worker from the broker).

set -euo pipefail

# Broker-only credentials never reach a session, even from a watchdog started by hand in a shell that
# holds them (start_worker already strips them, lib/workers.js spawnEnv): ADMIN_SECRET (exempt purges),
# ORCHESTRATOR_TOKEN* (reserved orchestrator senders), VERIFIER_TOKEN* (POST /verifications).
unset ADMIN_SECRET ${!ORCHESTRATOR_TOKEN@} ${!VERIFIER_TOKEN@}

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
WORK_DIR_OVERRIDE=""         # explicit session working dir (e.g. an isolated worktree)
MAX_SESSION_MINUTES=""
PRINT_CHANNELS=0
ONCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --inbox-channel)          INBOX_CHANNEL="$2";          shift 2 ;;
    --patrol-interval)        PATROL_INTERVAL="$2";        shift 2 ;;
    --patrol-watch-channel)   PATROL_WATCH_CHANNEL="$2";   shift 2 ;;
    --repo-root)              REPO_ROOT_OVERRIDE="$2";     shift 2 ;;
    --work-dir)               WORK_DIR_OVERRIDE="$2";      shift 2 ;;
    --max-session-minutes)    MAX_SESSION_MINUTES="$2";    shift 2 ;;
    --print-channels)         PRINT_CHANNELS=1;            shift ;;
    --once)                   ONCE=1;                      shift ;;
    --launcher)               WATCHDOG_LAUNCHER="$2";      shift 2 ;;
    *) echo "[watchdog:$WORKER] Unknown option: $1"; exit 1 ;;
  esac
done

LAUNCHER="${WATCHDOG_LAUNCHER:-cli}"
case "$LAUNCHER" in
  cli) ;;
  sdk) RUNNER="${WATCHDOG_RUNNER:-$(cd "$(dirname "$0")" && pwd)/runner/run-worker.mjs}" ;;
  *) echo "[watchdog:$WORKER] ERROR: WATCHDOG_LAUNCHER='$LAUNCHER' — expected cli or sdk." >&2; exit 2 ;;
esac

# ── Identity ──────────────────────────────────────────────────────────────────
# Derived once and used everywhere: the session's MCP URL (/mcp?[role=&]ns=&as=), and (as WORKER_KEY,
# see below) the broker cursor rewind, the ledger follow-up and the heartbeat sender.
#   ns    WATCHDOG_NAMESPACE (start_worker exports the workers-config entry's "ns"), else the
#         --inbox-channel prefix. With neither there is nothing to derive from — error, never guess.
#   inbox --inbox-channel, else <ns>-<worker> (orchestrators/<x>: <ns>-<x>-orch), as the original
#         client-project watchdog did for its workers.json entries that never pass the flag.
#   as    WATCHDOG_AS, else the inbox minus "<ns>-" (cb-reviewer -> reviewer, cb-core -> core).
#   role  WATCHDOG_ROLE, else orchestrator for orchestrators/* or an *-orch / *-orchestrator inbox,
#         reviewer when the inbox or worker path names a reviewer, else worker. Sent as role= only
#         when opted in (WATCHDOG_ROLE, WATCHDOG_ROLE_URL=1, WATCHDOG_ROLE_NAMESPACES or WATCHDOG_NS_ADOPTED=1).
NAMESPACE="${WATCHDOG_NAMESPACE:-}"
if [[ -z "$INBOX_CHANNEL" ]]; then
  if [[ -z "$NAMESPACE" ]]; then
    echo "[watchdog:$WORKER] ERROR: no --inbox-channel and no WATCHDOG_NAMESPACE — cannot derive the inbox." >&2
    echo "  Pass --inbox-channel <ns>-<name>, set WATCHDOG_NAMESPACE, or start it with start_worker (exports the config entry's ns)." >&2
    exit 1
  fi
  case "$WORKER" in
    orchestrators/*) INBOX_CHANNEL="${NAMESPACE}-${WORKER#orchestrators/}-orch" ;;
    *)               INBOX_CHANNEL="${NAMESPACE}-${WORKER//\//-}" ;;
  esac
  INBOX_CHANNEL="${INBOX_CHANNEL//\//-}"
  [[ "$PRINT_CHANNELS" -eq 1 ]] || echo "[watchdog:$WORKER] no --inbox-channel — derived: $INBOX_CHANNEL"
fi
[[ -z "$NAMESPACE" ]] && NAMESPACE="${INBOX_CHANNEL%%-*}"
if [[ "$INBOX_CHANNEL" != "${NAMESPACE}-"?* ]]; then
  echo "[watchdog:$WORKER] ERROR: inbox '$INBOX_CHANNEL' is not in namespace '$NAMESPACE' (expected '${NAMESPACE}-<name>')." >&2
  exit 1
fi
WORKER_AS="${WATCHDOG_AS:-${INBOX_CHANNEL#"${NAMESPACE}"-}}"
if [[ -n "${WATCHDOG_ROLE:-}" ]]; then
  WORKER_ROLE="$WATCHDOG_ROLE"
else
  case "$WORKER|$INBOX_CHANNEL" in
    orchestrators\|*|orchestrators/*|*-orch|*-orchestrator) WORKER_ROLE=orchestrator ;;
    *reviewer*)                                            WORKER_ROLE=reviewer ;;
    *)                                                     WORKER_ROLE=worker ;;
  esac
fi
case "$WORKER_ROLE" in
  worker|reviewer|orchestrator|admin) ;;
  *) echo "[watchdog:$WORKER] ERROR: role '$WORKER_ROLE' — expected worker, reviewer, orchestrator or admin." >&2; exit 1 ;;
esac
for _id in "$NAMESPACE" "$WORKER_AS"; do
  if [[ ! "$_id" =~ ^[A-Za-z0-9_.-]{1,64}$ ]]; then
    echo "[watchdog:$WORKER] ERROR: identity '$_id' — letters, digits, _ . - only (max 64)." >&2; exit 1
  fi
done
# role= goes into the URL only when opted in — a role profile hides tools that role prompts may
# still instruct, so roles switch on per namespace at its adoption step. Without role= the session
# keeps the full tool list; ns= and as= are always sent.
ROLE_URL=0; ROLE_URL_REASON="off (set WATCHDOG_ROLE_URL=1 or list '$NAMESPACE' in WATCHDOG_ROLE_NAMESPACES)"
if [[ -n "${WATCHDOG_ROLE:-}" ]]; then
  ROLE_URL=1; ROLE_URL_REASON="on (WATCHDOG_ROLE set)"
elif [[ "${WATCHDOG_ROLE_URL:-0}" == "1" ]]; then
  ROLE_URL=1; ROLE_URL_REASON="on (WATCHDOG_ROLE_URL=1)"
elif [[ ",${WATCHDOG_ROLE_NAMESPACES// /}," == *",${NAMESPACE},"* ]]; then
  ROLE_URL=1; ROLE_URL_REASON="on (WATCHDOG_ROLE_NAMESPACES has '$NAMESPACE')"
elif [[ "${WATCHDOG_NS_ADOPTED:-0}" == "1" && "${WATCHDOG_ROLE_URL:-}" != "0" ]]; then
  ROLE_URL=1; ROLE_URL_REASON="on (namespace '$NAMESPACE' adopted — adopt_namespace)"
fi
# Harness verification (verify-result.mjs, see verify_results): opt-in per namespace, default off.
VERIFY=0; VERIFY_REASON="off (set WATCHDOG_VERIFY=1 or list '$NAMESPACE' in WATCHDOG_VERIFY_NAMESPACES)"
if [[ "${WATCHDOG_VERIFY:-}" == "1" ]]; then
  VERIFY=1; VERIFY_REASON="on (WATCHDOG_VERIFY=1)"
elif [[ "${WATCHDOG_VERIFY:-}" == "0" ]]; then
  VERIFY_REASON="off (WATCHDOG_VERIFY=0)"
elif [[ ",${WATCHDOG_VERIFY_NAMESPACES// /}," == *",${NAMESPACE},"* ]]; then
  VERIFY=1; VERIFY_REASON="on (WATCHDOG_VERIFY_NAMESPACES has '$NAMESPACE')"
fi
# A namespace whose verifications need the verifier credential is verified outside every worker's process
# tree (verify-result.mjs --watch, which holds VERIFIER_TOKEN); this watchdog would only get 403s.
if [[ "$VERIFY" -eq 1 && ",${VERIFIER_TRUST_NAMESPACES// /}," == *",${NAMESPACE},"* ]]; then
  VERIFY=0; VERIFY_REASON="external (VERIFIER_TRUST_NAMESPACES has '$NAMESPACE': the standalone verifier stamps results)"
fi
# Guardrail hook (hooks/guardrails.mjs, see setup_guardrails): opt-in per namespace, default off.
GUARDRAILS=0; GUARDRAILS_REASON="off (set WATCHDOG_GUARDRAILS=1 or list '$NAMESPACE' in WATCHDOG_GUARDRAIL_NAMESPACES)"
if [[ "${WATCHDOG_GUARDRAILS:-}" == "1" ]]; then
  GUARDRAILS=1; GUARDRAILS_REASON="on (WATCHDOG_GUARDRAILS=1)"
elif [[ "${WATCHDOG_GUARDRAILS:-}" == "0" ]]; then
  GUARDRAILS_REASON="off (WATCHDOG_GUARDRAILS=0)"
elif [[ ",${WATCHDOG_GUARDRAIL_NAMESPACES// /}," == *",${NAMESPACE},"* ]]; then
  GUARDRAILS=1; GUARDRAILS_REASON="on (WATCHDOG_GUARDRAIL_NAMESPACES has '$NAMESPACE')"
fi
# Other MCP servers reach the session only through the entry's list or an explicit WATCHDOG_MCP_INHERIT=1.
if [[ "${WATCHDOG_MCP:-1}" != "1" ]]; then MCP_INHERIT_REASON="n/a (WATCHDOG_MCP=0: no MCP flags, the session loads its own servers)"
elif [[ -n "${WATCHDOG_MCP_SERVERS:-}" ]]; then
  _l="${WATCHDOG_MCP_SERVERS//\"/}"; MCP_INHERIT_REASON="list ${_l// /} (entry mcp_servers; overrides WATCHDOG_MCP_INHERIT)"
elif [[ "${WATCHDOG_MCP_INHERIT:-}" == "1" ]]; then MCP_INHERIT_REASON="on (WATCHDOG_MCP_INHERIT=1)"
else MCP_INHERIT_REASON="off (broker only; WATCHDOG_MCP_INHERIT=1 to inherit)"; fi
# ── Model routing ─────────────────────────────────────────────────────────────
# Precedence, highest first: pinned (start_worker model= > entry "model", as CLAUDE_MODEL) > reviewer >
# scope of the next open task, else of a blocked / plan-review one (entry model_by_scope, then
# WATCHDOG_MODEL_BY_SCOPE) > no-task (patrol, or no task of this worker's open in the ledger) > default. Resolved before every launch (resolve_model);
# the model and its reason ride on every heartbeat (model, context.model_reason).
_MODEL_RE='^[A-Za-z0-9._:@/-]{1,100}$'
MODEL_PINNED=0
[[ "${WATCHDOG_MODEL_PINNED:-}" != "0" && -n "${CLAUDE_MODEL:-}" ]] && MODEL_PINNED=1
DEFAULT_MODEL="claude-sonnet-5-5"
[[ "$MODEL_PINNED" -eq 0 && -n "${CLAUDE_MODEL:-}" ]] && DEFAULT_MODEL="$CLAUDE_MODEL"
REVIEWER_MODEL="${WATCHDOG_REVIEWER_MODEL:-claude-opus-5-5}"
NO_TASK_MODEL="${WATCHDOG_NO_TASK_MODEL:-claude-haiku-4-5-20251001}"
SCOPE_MAP="small=claude-sonnet-5-5,medium=claude-sonnet-5-5,large=claude-opus-5-5"
IS_REVIEWER="${WATCHDOG_REVIEWER:-}"
[[ -z "$IS_REVIEWER" ]] && { [[ "$WORKER_ROLE" == "reviewer" ]] && IS_REVIEWER=1 || IS_REVIEWER=0; }
# Model for key $2 in "k=v,k=v" $1 (last wins), or empty — an invalid model id counts as absent.
_map_get() {
  local part v="" IFS=,
  for part in $1; do part="${part// /}"; [[ "${part%%=*}" == "$2" ]] && v="${part#*=}"; done
  [[ "$v" =~ $_MODEL_RE ]] && printf '%s' "$v"
  return 0
}
# Sets SESSION_MODEL / MODEL_REASON. $1 = start reason, $2 = scope of the next open task ("" = none, "-" = unscoped).
resolve_model() {
  local start="${1:-}" scope="${2:-}" m=""
  if [[ "$MODEL_PINNED" -eq 1 ]]; then SESSION_MODEL="$CLAUDE_MODEL"; MODEL_REASON="pinned"
  elif [[ "$IS_REVIEWER" == "1" ]]; then SESSION_MODEL="$REVIEWER_MODEL"; MODEL_REASON="reviewer"
  elif [[ "$start" == "patrol" || -z "$scope" ]]; then SESSION_MODEL="$NO_TASK_MODEL"; MODEL_REASON="no-task"
  else
    if [[ "$scope" != "-" ]]; then
      m=$(_map_get "${WATCHDOG_ENTRY_MODEL_BY_SCOPE:-}" "$scope")
      [[ -z "$m" ]] && m=$(_map_get "${WATCHDOG_MODEL_BY_SCOPE:-}" "$scope")
      [[ -z "$m" ]] && m=$(_map_get "$SCOPE_MAP" "$scope")
    fi
    if [[ -n "$m" ]]; then SESSION_MODEL="$m"; MODEL_REASON="scope:$scope"
    else SESSION_MODEL="$DEFAULT_MODEL"; MODEL_REASON="default"; fi
  fi
  if [[ ! "$SESSION_MODEL" =~ $_MODEL_RE ]]; then
    echo "[watchdog:$WORKER] WARN: model '$SESSION_MODEL' ($MODEL_REASON) is not a valid id — using claude-sonnet-5-5"
    SESSION_MODEL="claude-sonnet-5-5"; MODEL_REASON="default"
  fi
  return 0
}
if [[ "$MODEL_PINNED" -eq 1 ]]; then MODEL_ROUTE="pinned:$CLAUDE_MODEL"
elif [[ "$IS_REVIEWER" == "1" ]]; then MODEL_ROUTE="reviewer:$REVIEWER_MODEL"
else
  MODEL_ROUTE="scope("
  for _s in small medium large; do resolve_model inbox "$_s"; MODEL_ROUTE+="$_s=$SESSION_MODEL,"; done
  MODEL_ROUTE+="no-task=$NO_TASK_MODEL,default=$DEFAULT_MODEL)"
fi
SESSION_MODEL=""; MODEL_REASON=""

MCP_QUERY="ns=${NAMESPACE}&as=${WORKER_AS}"
[[ "$ROLE_URL" -eq 1 ]] && MCP_QUERY="role=${WORKER_ROLE}&${MCP_QUERY}"
# The name the broker knows this worker by: heartbeat/rate-limit sender, inbox cursor and ledger
# workers=. Not opted in: the worker path basename, exactly as the client project's watchdog keys them, so
# existing cursors and dashboards carry over. Opted in: WORKER_AS, the same name the session uses.
REGISTRY_NAME="${WORKER##*/}"
WORKER_KEY="$REGISTRY_NAME"
[[ "$ROLE_URL" -eq 1 ]] && WORKER_KEY="$WORKER_AS"
# Every name this worker posts as, passed as exclude_sender on the inbox and patrol checks so its own
# messages never count as pending work (a patrol on <ns>-status would otherwise wake on its own patrol
# status, forever). WORKER_AS is the MCP as= (the session's default sender), REGISTRY_NAME the heartbeat /
# rate-limit sender when not opted in; the judge (entry cb-judge, workers/judge, inbox cb-judge) is
# 'judge' under both. Names the session uses beyond these (a role file's hard-coded from/sender, the
# manifest worker name if it differs) go in WATCHDOG_SELF_SENDERS (comma list).
SELF_SENDERS=""
IFS=',' read -r -a _extra <<<"${WATCHDOG_SELF_SENDERS:-}"
for _n in "$WORKER_AS" "$REGISTRY_NAME" "$WORKER_KEY" ${_extra[@]+"${_extra[@]}"}; do
  _n="${_n#"${_n%%[![:space:]]*}"}"; _n="${_n%"${_n##*[![:space:]]}"}"   # trim
  [[ "$_n" =~ ^[A-Za-z0-9_.-]{1,64}$ && ",$SELF_SENDERS," != *",$_n,"* ]] && SELF_SENDERS="${SELF_SENDERS:+$SELF_SENDERS,}$_n"
done

# Sibling channels sit at the namespace root.
[[ -z "$PATROL_WATCH_CHANNEL" ]] && PATROL_WATCH_CHANNEL="${NAMESPACE}-status"
TELEMETRY_CHANNEL="${NAMESPACE}-telemetry"
STATUS_CHANNEL="${NAMESPACE}-status"
RATE_LIMIT_CHANNEL="${NAMESPACE}-rate-limits"

# Multi-hyphen inbox names (cb-protocol-qa, dv-backend-services) must map to the namespace ROOT
# channels; --print-channels exposes the derivation (channels and identity) so tests can pin it.
if [[ "$PRINT_CHANNELS" -eq 1 ]]; then
  printf 'namespace=%s\ntelemetry=%s\nstatus=%s\nrate_limits=%s\npatrol_watch=%s\ninbox=%s\nrole=%s\nas=%s\nkey=%s\nrole_url=%s\nmcp_query=%s\nverify=%s\nmodel_route=%s\nmodel_warning=%s\nguardrails=%s\nmcp_inherit=%s\nallowed_tools=%s\ndisallowed_tools=%s\nself_senders=%s\n' \
    "$NAMESPACE" "$TELEMETRY_CHANNEL" "$STATUS_CHANNEL" "$RATE_LIMIT_CHANNEL" "$PATROL_WATCH_CHANNEL" "$INBOX_CHANNEL" \
    "$WORKER_ROLE" "$WORKER_AS" "$WORKER_KEY" "$ROLE_URL_REASON" "$MCP_QUERY" "$VERIFY_REASON" "$MODEL_ROUTE" "${WATCHDOG_MODEL_WARNING:-none}" \
    "$GUARDRAILS_REASON" "$MCP_INHERIT_REASON" "${WATCHDOG_ALLOWED_TOOLS:-none}" "${WATCHDOG_DISALLOWED_TOOLS:-none}" "$SELF_SENDERS"
  exit 0
fi

# ── Paths ─────────────────────────────────────────────────────────────────────

# No --repo-root: WATCHDOG_REPO_ROOT, else the first of cwd / this script's dir / its parent that
# holds <worker> (the parent is where the original scripts/watchdog.sh resolved it), else cwd.
if [[ -n "$REPO_ROOT_OVERRIDE" ]]; then
  REPO_ROOT="$REPO_ROOT_OVERRIDE"
elif [[ -n "${WATCHDOG_REPO_ROOT:-}" ]]; then
  REPO_ROOT="$WATCHDOG_REPO_ROOT"
else
  REPO_ROOT="$(pwd)"
  _SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
  for _cand in "$(pwd)" "$_SELF_DIR" "$(dirname "$_SELF_DIR")"; do
    if [[ -d "$_cand/$WORKER" ]]; then REPO_ROOT="$_cand"; break; fi
  done
fi
# --work-dir wins (isolated-worktree mode: the session runs at the worktree root).
# Otherwise the session runs in <repo-root>/<worker>.
if [[ -n "$WORK_DIR_OVERRIDE" ]]; then
  WORKER_DIR="$WORK_DIR_OVERRIDE"
else
  WORKER_DIR="$REPO_ROOT/$WORKER"
fi
CLAUDE="${CLAUDE_BIN:-$(command -v claude 2>/dev/null || echo "$HOME/.local/bin/claude")}"
BROKER_URL="${BROKER_URL:-http://localhost:8080}"
BROKER_SECRET="${BROKER_SECRET:-}"

# The bearer token travels in a curl config file (mode 600), never on curl's argv where any
# local user could read it from `ps`.
_CURL_CFG=""
if [[ -n "$BROKER_SECRET" ]]; then
  _CURL_CFG=$(mktemp /tmp/watchdog-curl-XXXXXX); chmod 600 "$_CURL_CFG"
  printf 'header = "Authorization: Bearer %s"\n' "$BROKER_SECRET" > "$_CURL_CFG"
fi
_curl() { if [[ -n "$_CURL_CFG" ]]; then curl -K "$_CURL_CFG" "$@"; else curl "$@"; fi; }

# Every session gets the broker as an explicit MCP server. Without this a headless worker only
# has broker tools if its checkout happens to carry a .mcp.json (worktrees do not) or the machine
# has a user-scope registration — which may point at a *different* broker. The config lives in a
# mode-600 temp file (it carries the bearer token) and is removed on exit.
_MCP_CFG=""; _MCP_ARGS=()
if [[ "${WATCHDOG_MCP:-1}" == "1" ]]; then
  _MCP_CFG=$(mktemp /tmp/watchdog-mcp-XXXXXX); chmod 600 "$_MCP_CFG"
  if [[ -n "$BROKER_SECRET" ]]; then
    printf '{"mcpServers":{"broker":{"type":"http","url":"%s/mcp?%s","headers":{"Authorization":"Bearer %s"}}}}\n' "$BROKER_URL" "$MCP_QUERY" "$BROKER_SECRET" > "$_MCP_CFG"
  else
    printf '{"mcpServers":{"broker":{"type":"http","url":"%s/mcp?%s"}}}\n' "$BROKER_URL" "$MCP_QUERY" > "$_MCP_CFG"
  fi
  _MCP_ARGS=(--mcp-config "$_MCP_CFG")
fi

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
# node parses JSON below. A broker started by launchd hands its watchdogs a bare
# /usr/bin:/bin:/usr/sbin:/sbin PATH, so look past PATH too: NODE_BIN, then the usual install
# locations, then the newest nvm version.
NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null || true)}"
if [[ -z "$NODE_BIN" ]]; then
  for _cand in /usr/local/bin/node /opt/homebrew/bin/node $(ls -d "$HOME"/.nvm/versions/node/v*/bin/node 2>/dev/null | sort -V -r 2>/dev/null); do
    if [[ -x "$_cand" ]]; then NODE_BIN="$_cand"; break; fi
  done
fi
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "[watchdog:$WORKER] ERROR: node is required (used for JSON parsing) — not on PATH; set NODE_BIN"; exit 1
fi
node() { "$NODE_BIN" "$@"; }

# Other MCP servers in the config (user scope and local scope from ~/.claude.json, project scope from
# <work-dir>/.mcp.json, project wins), since --strict-mcp-config would otherwise drop them. "broker" is
# always ours. WATCHDOG_MCP_SERVERS (entry list) picks exactly the named ones and reports names found in
# no scope; else WATCHDOG_MCP_INHERIT=1 carries all of them; else the broker only.
if [[ -n "$_MCP_CFG" && ( -n "${WATCHDOG_MCP_SERVERS:-}" || "${WATCHDOG_MCP_INHERIT:-0}" == "1" ) ]]; then
  if _missing=$(node -e '
    const fs = require("fs"), [cfgPath, claudeJson, workDir, list] = process.argv.slice(1);
    const rd = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return {}; } };
    const user = rd(claudeJson), cfg = rd(cfgPath);
    const all = { ...(user.mcpServers || {}), ...(((user.projects || {})[workDir] || {}).mcpServers || {}),
                  ...(rd(workDir + "/.mcp.json").mcpServers || {}) };
    let servers = all, missing = [];
    if (list) {
      const names = JSON.parse(list);
      if (!Array.isArray(names)) throw new Error("WATCHDOG_MCP_SERVERS is not a JSON array");
      servers = {};
      for (const n of names) if (n !== "broker") { if (all[n]) servers[n] = all[n]; else missing.push(n); }
    }
    fs.writeFileSync(cfgPath, JSON.stringify({ mcpServers: { ...servers, broker: cfg.mcpServers.broker } }) + "\n");
    process.stdout.write(missing.join(","));
  ' "$_MCP_CFG" "${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json" "$(cd "$WORKER_DIR" && pwd)" "${WATCHDOG_MCP_SERVERS:-}"); then
    if [[ -n "$_missing" ]]; then
      MCP_INHERIT_REASON="${MCP_INHERIT_REASON/ (entry/ missing [$_missing] (entry}"
      echo "[watchdog:$WORKER] WARN: mcp_servers name(s) found in no MCP scope: $_missing — session starts without them"
    fi
  else
    echo "[watchdog:$WORKER] WARN: could not merge other MCP servers ($MCP_INHERIT_REASON); broker only"
  fi
fi
# --strict-mcp-config ignores every other MCP source (user/project scope) so the session sees
# exactly one broker. Older CLIs lack the flag; fall back to --mcp-config alone.
if [[ -n "$_MCP_CFG" ]] && "$CLAUDE" --help 2>/dev/null | grep -q -- "--strict-mcp-config"; then
  _MCP_ARGS+=(--strict-mcp-config)
fi

# ── Tool lists and guardrails ─────────────────────────────────────────────────
# The config entry's allowed_tools / disallowed_tools arrive as JSON arrays (start_worker always sets
# both, "" when the entry has none). cli: --allowedTools / --disallowedTools, one argv per rule;
# sdk: the arrays go to the runner as they are. An invalid value is ignored with a warning.
_json_list() {  # $1 = label, $2 = JSON array of strings; prints one item per line, empty on invalid
  [[ -z "$2" ]] && return 0
  node -e 'try { const a = JSON.parse(process.argv[1]); if (!Array.isArray(a) || a.some(x => typeof x !== "string" || !x.trim() || /[\n\r]/.test(x))) throw 0;
             process.stdout.write(a.map(x => x.trim() + "\n").join("")); } catch { process.exit(3); }' "$2" \
    || echo "[watchdog:$WORKER] WARN: $1 is not a JSON array of tool names — ignored: $2" >&2
}
_TOOL_ARGS=(); _SDK_TOOL_ARGS=(); ALLOWED_JSON=""
for _pair in "allowedTools:${WATCHDOG_ALLOWED_TOOLS:-}" "disallowedTools:${WATCHDOG_DISALLOWED_TOOLS:-}"; do
  _flag="${_pair%%:*}"; _items=()
  while IFS= read -r _it; do [[ -n "$_it" ]] && _items+=("$_it"); done < <(_json_list "WATCHDOG_${_flag}" "${_pair#*:}")
  [[ ${#_items[@]} -eq 0 ]] && continue
  _TOOL_ARGS+=("--$_flag" "${_items[@]}")
  _SDK_TOOL_ARGS+=("--$( [[ "$_flag" == allowedTools ]] && echo allowed-tools || echo disallowed-tools )" "${_pair#*:}")
  [[ "$_flag" == allowedTools ]] && ALLOWED_JSON="${_pair#*:}"
done

# Guardrails on: one config (worker, worktree root, deny log, broker port, extra_deny, allowed_tools) read by the hook
# on both launch paths. cli gets it through a --settings file whose hooks.PreToolUse runs the hook; sdk
# through the runner's --guardrails flag. Opted in but no hook file: refuse to run unguarded.
_GUARD_CFG=""; _GUARD_LOG=""; _GUARD_SETTINGS=""; _GUARD_ARGS=(); GUARD_DENIES=0
if [[ "$GUARDRAILS" -eq 1 ]]; then
  GUARD_HOOK="${WATCHDOG_GUARDRAILS_HOOK:-$(cd "$(dirname "$0")" && pwd)/hooks/guardrails.mjs}"
  if [[ ! -f "$GUARD_HOOK" ]]; then
    echo "[watchdog:$WORKER] ERROR: guardrails $GUARDRAILS_REASON but the hook is missing: $GUARD_HOOK" >&2; exit 1
  fi
  _GUARD_ROOT=$(git -C "$WORKER_DIR" rev-parse --show-toplevel 2>/dev/null || (cd "$WORKER_DIR" && pwd))
  _GUARD_CFG=$(mktemp /tmp/watchdog-guard-cfg-XXXXXX); _GUARD_LOG=$(mktemp /tmp/watchdog-guard-log-XXXXXX)
  _GUARD_SETTINGS=$(mktemp /tmp/watchdog-guard-settings-XXXXXX); chmod 600 "$_GUARD_CFG" "$_GUARD_SETTINGS"
  node -e '
    const fs = require("fs"), [cfgPath, setPath, worker, root, log, extra, allowed, nodeBin, hook, brokerUrl] = process.argv.slice(1);
    const arr = (s, label) => { if (!s) return []; try { const a = JSON.parse(s); if (Array.isArray(a)) return a; } catch {}
                                console.error(`WARN: ${label} is not a JSON array — ignored`); return []; };
    let broker_port = 8080; try { const u = new URL(brokerUrl); broker_port = Number(u.port) || (u.protocol === "https:" ? 443 : 80); } catch {}
    fs.writeFileSync(cfgPath, JSON.stringify({ worker, root, log, broker_port, extra_deny: arr(extra, "WATCHDOG_GUARDRAILS_EXTRA_DENY"), allowed_tools: arr(allowed, "WATCHDOG_ALLOWED_TOOLS") }) + "\n");
    const q = (s) => "\x27" + String(s).replace(/\x27/g, "\x27\\\x27\x27") + "\x27";
    const command = [nodeBin, hook, cfgPath].map(q).join(" ");
    fs.writeFileSync(setPath, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command, timeout: 30 }] }] } }) + "\n");
  ' "$_GUARD_CFG" "$_GUARD_SETTINGS" "$WORKER_AS" "$_GUARD_ROOT" "$_GUARD_LOG" "${WATCHDOG_GUARDRAILS_EXTRA_DENY:-}" "$ALLOWED_JSON" "$NODE_BIN" "$GUARD_HOOK" "$BROKER_URL" 2>&1 \
    | while IFS= read -r _l; do echo "[watchdog:$WORKER] $_l"; done
  _GUARD_ARGS=(--settings "$_GUARD_SETTINGS")
fi
# Copy this session's denies (one line each, from the hook) into the watchdog log; GUARD_DENIES = count.
flush_guard_log() {
  GUARD_DENIES=0
  [[ -n "$_GUARD_LOG" && -s "$_GUARD_LOG" ]] || return 0
  GUARD_DENIES=$(wc -l < "$_GUARD_LOG" | tr -d ' ')
  while IFS= read -r _l; do echo "[watchdog:$WORKER] guardrail $_l"; done < "$_GUARD_LOG"
  : > "$_GUARD_LOG"
}

# ── Cursor / lock files ───────────────────────────────────────────────────────

SAFE_NAME="${WORKER//\//-}"
_SAFE_CHANNEL="${INBOX_CHANNEL//[^a-zA-Z0-9]/-}"
CURSOR_FILE="/tmp/watchdog-${SAFE_NAME}-${_SAFE_CHANNEL}-cursor"
PATROL_CURSOR_FILE="/tmp/watchdog-${SAFE_NAME}-${_SAFE_CHANNEL}-patrol"
LOCK_FILE="/tmp/watchdog-${SAFE_NAME}-${_SAFE_CHANNEL}.lock"
HEARTBEAT_INTERVAL=${WATCHDOG_HEARTBEAT_INTERVAL:-30}
ROTATE_AT_TOKENS=${ROTATE_AT_TOKENS:-150000}
ROTATE_KILL_AFTER_S=${ROTATE_KILL_AFTER_S:-300}
# Rotation signal: when rotation_due first fires in a session, the heartbeat loop writes this flag
# {size, threshold, crossed_at, status_base}; hooks/rotation.mjs (PostToolUse, every namespace,
# independent of guardrails) reads it and tells the session to hand off and exit. Deleted, with its
# .count, before every launch.
ROTATE_FLAG="/tmp/watchdog-${SAFE_NAME}-${_SAFE_CHANNEL}-rotate-flag"
_ROTATION_ON=0
if [[ "$ROTATE_AT_TOKENS" -gt 0 ]]; then
  ROTATION_HOOK="${WATCHDOG_ROTATION_HOOK:-$(cd "$(dirname "$0")" && pwd)/hooks/rotation.mjs}"
  if [[ -f "$ROTATION_HOOK" ]]; then _ROTATION_ON=1
  else echo "[watchdog:$WORKER] WARN: rotation hook missing ($ROTATION_HOOK) — sessions get no ROTATE NOW signal"; fi
fi
# cli: one --settings file carries the guardrail PreToolUse hook (if on) and the rotation PostToolUse
# hook (if on). sdk: the runner gets --guardrails / --rotation-flag instead.
if [[ $_ROTATION_ON -eq 1 ]]; then
  [[ -z "$_GUARD_SETTINGS" ]] && { _GUARD_SETTINGS=$(mktemp /tmp/watchdog-hook-settings-XXXXXX); chmod 600 "$_GUARD_SETTINGS"; echo '{}' > "$_GUARD_SETTINGS"; }
  node -e '
    const fs = require("fs"), [setPath, nodeBin, hook, flag] = process.argv.slice(1);
    const q = (s) => "\x27" + String(s).replace(/\x27/g, "\x27\\\x27\x27") + "\x27";
    const set = JSON.parse(fs.readFileSync(setPath, "utf8") || "{}"); set.hooks = set.hooks || {};
    set.hooks.PostToolUse = [{ matcher: "*", hooks: [{ type: "command", command: [nodeBin, hook, flag].map(q).join(" "), timeout: 10 }] }];
    fs.writeFileSync(setPath, JSON.stringify(set) + "\n");
  ' "$_GUARD_SETTINGS" "$NODE_BIN" "$ROTATION_HOOK" "$ROTATE_FLAG"
fi
[[ -n "$_GUARD_SETTINGS" ]] && _GUARD_ARGS=(--settings "$_GUARD_SETTINGS")
_ROT_SDK_ARGS=(); [[ $_ROTATION_ON -eq 1 ]] && _ROT_SDK_ARGS=(--rotation-flag "$ROTATE_FLAG")
_OUT_ARGS=()
[[ "${WATCHDOG_STREAM_JSON:-1}" == "1" ]] && _OUT_ARGS=(--output-format stream-json --verbose)

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

# Context size comes from the session's own stream-json stdout (captured in $TMPOUT): each
# top-level assistant event carries the usage of the request that produced it, and
# input + cache_read + cache_creation of the LATEST one is exactly the prompt the model just saw.
# Not the transcript JSONL: its path depends on CLAUDE_CONFIG_DIR and an undocumented cwd-slug
# rule, and it interleaves sidechains. Not the final result event: its usage is the session SUM.
# Subagent turns (parent_tool_use_id set) run in their own context and are skipped.
# Line 1: "<size> <cache_read> <cache_create> <session_id|-> <result_is_error 0|1>".
# With a second arg "diag", the rest is the text error classification greps: non-JSON lines
# (stderr, plain-text output) plus the result/error/retry events — never tool output, which
# stream-json also carries and which would false-match "429" or "ENOTFOUND".
session_scan() {  # $1 = output file, $2 = "diag" to append diagnostic text
  node -e '
    const fs = require("fs"); let s = ""; try { s = fs.readFileSync(process.argv[1], "utf8"); } catch {}
    const diag = process.argv[2] === "diag", out = [];
    // A rate limit is judged on error text only (stderr lines, error events, an is_error result),
    // never on a successful result or tool output: "429" in a message id or a worker discussing
    // rate limits is not one. The diag text (NET_DOWN) keeps its wider net.
    const RL = /rate.limit|\b429\b|too many requests|overloaded|capacity|hit your limit|usage limit|resets [0-9]/i;
    let u = null, sid = "", isErr = 0, rl = 0;
    const errText = (t) => { if (!rl && typeof t === "string" && RL.test(t)) rl = 1; };
    const status429 = (p) => { if ([p.api_error_status, p.error_status, p.status].includes(429)) rl = 1; };
    for (const l of s.split("\n")) {
      if (!l) continue;
      let p = null;
      if (l[0] === "{") { try { p = JSON.parse(l); } catch {} }
      if (!p || typeof p !== "object") { errText(l); if (diag) out.push(l); continue; }
      if (typeof p.session_id === "string" && /^[\w-]+$/.test(p.session_id)) sid = p.session_id;
      if (p.type === "assistant" && !p.parent_tool_use_id && p.message && p.message.usage) u = p.message.usage;
      if (p.type === "result") {
        if (p.is_error) { isErr = 1; status429(p); errText(p.result); errText(p.subtype); }
        if (p.errors) errText(JSON.stringify(p.errors));
        if (diag) { if (typeof p.result === "string") out.push(p.result); if (p.errors) out.push(JSON.stringify(p.errors)); if (p.is_error) out.push(String(p.subtype || "")); }
      } else if (p.error || /error|retry/i.test(String(p.subtype || ""))) {
        status429(p); errText(JSON.stringify({ error: p.error, subtype: p.subtype }));
        if (p.error && p.message && Array.isArray(p.message.content)) for (const c of p.message.content) if (c && c.type === "text") errText(c.text);
        if (diag) out.push(JSON.stringify(p));
      }
    }
    const n = (v) => Number.isInteger(v) && v > 0 ? v : 0;
    const read = u ? n(u.cache_read_input_tokens) : 0, create = u ? n(u.cache_creation_input_tokens) : 0;
    const size = u ? n(u.input_tokens) + read + create : 0;
    process.stdout.write(`${size} ${read} ${create} ${sid || "-"} ${isErr} ${rl}\n` + (diag ? out.join("\n") + "\n" : ""));
  ' "$1" "${2:-}" 2>/dev/null || echo "0 0 0 - 0 0"
}
# Sets CTX_SIZE / CTX_READ / CTX_CREATE / CTX_SID / RESULT_ERR / RATE_ERR from a session_scan header line.
set_usage() { read -r CTX_SIZE CTX_READ CTX_CREATE CTX_SID RESULT_ERR RATE_ERR <<<"$1"; [[ "$CTX_SID" == "-" ]] && CTX_SID=""; return 0; }
CTX_SIZE=0; CTX_READ=0; CTX_CREATE=0; CTX_SID=""; RESULT_ERR=0; RATE_ERR=0
rotation_due() { [[ "$ROTATE_AT_TOKENS" -gt 0 && "${CTX_SIZE:-0}" -ge "$ROTATE_AT_TOKENS" ]]; }

# ── Broker checks (authenticated — /inbox requires the bearer token) ───────────

check_channel() {
  local channel="$1" since_id="$2"
  _curl -sf --max-time 5 "${BROKER_URL}/inbox?channel=${channel}&since_id=${since_id}" 2>/dev/null || echo ""
}
# Wake checks: the worker's own posts (SELF_SENDERS) do not count as pending; max_id still covers them.
check_channel_for_work() {
  _curl -sf --max-time 5 "${BROKER_URL}/inbox?channel=${1}&since_id=${2}&exclude_sender=${SELF_SENDERS}" 2>/dev/null || echo ""
}
check_inbox() { check_channel_for_work "$INBOX_CHANNEL" "$1"; }

# The broker keeps a server-side read cursor per (worker, channel); a session's turn_start advances
# it as soon as the inbox batch is delivered. When we relaunch because the previous session took the
# batch but never finished (silent exit, timeout, crash), pull every cursor on the inbox back to our
# own cursor so the retry sees the same messages again. Best effort; older brokers return 404.
rewind_broker_cursor() {  # $1 = last inbox id the previous session had already handled
  _curl -sf -X PUT "${BROKER_URL}/cursors" -H "Content-Type: application/json" \
    -d "{\"channel\":\"${INBOX_CHANNEL}\",\"last_id\":${1:-0}}" >/dev/null 2>&1 || true
}

# Pull only this worker's cursor on the inbox back to $1 (lower-only). Used before a follow-up
# launch so turn_start re-delivers tasks that are still open in the ledger.
rewind_worker_cursor() {  # $1 = last_id
  _curl -sf -X PUT "${BROKER_URL}/cursors" -H "Content-Type: application/json" \
    -d "{\"channel\":\"${INBOX_CHANNEL}\",\"worker\":\"${WORKER_KEY}\",\"last_id\":${1:-0}}" >/dev/null 2>&1 || true
}

# Open tasks for this worker per get_task_ledger (MCP — the ledger has no REST twin; the broker's
# transport is stateless, so a bare tools/call works). Counts pending / planning / in-progress / handoff;
# blocked tasks wait on an answer and plan-review tasks on a plan-decision, not on a session — the
# answer or decision lands on the inbox, which launches the next session. Prints "<count> <min_dispatch_id> <scope>" — scope of
# that oldest open task, "-" when it has none. With nothing open, scope is that of the oldest blocked or plan-review task
# (the session answering it is still task work and routes by its scope, never no-task), "none" when there is none either,
# and "0 0 none" when the broker is unreachable or predates the ledger. A 4th field names the in-flight task
# (the fallback handoff's task_id): first by state in-progress, handoff, plan-review, planning, pending, then
# oldest dispatch_id; "-" when none.
ledger_open() {
  local body
  body=$(printf '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_task_ledger","arguments":{"status_channel":"%s","prefix":"%s-","only_open":true,"workers":["%s"]}}}' \
    "$STATUS_CHANNEL" "$NAMESPACE" "$WORKER_KEY")
  _curl -sf --max-time 10 -X POST "${BROKER_URL}/mcp" -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" -d "$body" 2>/dev/null | node -e '
      let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{ try {
        const line = d.split("\n").find(l => l.startsWith("data:")); const rpc = JSON.parse(line ? line.slice(5) : d);
        const led = JSON.parse(rpc.result.content[0].text);
        const open = led.tasks.filter(t => ["pending","planning","in-progress","handoff"].includes(t.state) && t.dispatch_id);
        const next = open.reduce((a, t) => (!a || t.dispatch_id < a.dispatch_id ? t : a), null);
        const waiting = led.tasks.filter(t => ["blocked","plan-review"].includes(t.state) && t.dispatch_id);
        const route = next || waiting.reduce((a, t) => (!a || t.dispatch_id < a.dispatch_id ? t : a), null);
        const scope = !route ? "none" : /^(small|medium|large)$/.test(route.scope || "") ? route.scope : "-";
        const oldest = (s) => led.tasks.filter(t => t.state === s && t.dispatch_id).reduce((a, t) => (!a || t.dispatch_id < a.dispatch_id ? t : a), null);
        const live = ["in-progress","handoff","plan-review","planning","pending"].map(oldest).find(Boolean);
        console.log(open.length + " " + (next ? next.dispatch_id : 0) + " " + scope + " " + (live ? live.task_id : "-"));
      } catch { console.log("0 0 none -"); } })' 2>/dev/null || echo "0 0 none -"
}

# First crossing of ROTATE_AT_TOKENS in a session: write the flag hooks/rotation.mjs reads (atomic).
# status_base = the status channel's max id at crossing, so the fallback looks for a handoff after it.
write_rotate_flag() {
  local sb; sb=$(json_max_id "$(check_channel "$STATUS_CHANNEL" 0)")
  printf '{"size":%s,"threshold":%s,"crossed_at":"%s","status_base":%s}\n' "${CTX_SIZE:-0}" "$ROTATE_AT_TOKENS" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${sb:-0}" > "$ROTATE_FLAG.tmp" && mv -f "$ROTATE_FLAG.tmp" "$ROTATE_FLAG"
}

# Text of an MCP tools/call on the broker ($1 = tool, $2 = arguments JSON); empty on any failure.
mcp_tool_text() {
  _curl -sf --max-time 10 -X POST "${BROKER_URL}/mcp" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}" 2>/dev/null | node -e '
      let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{ try {
        const line = d.split("\n").find(l => l.startsWith("data:")); const rpc = JSON.parse(line ? line.slice(5) : d);
        process.stdout.write(rpc.result.content[0].text || "");
      } catch {} })' 2>/dev/null || true
}

# A session killed for rotation or timeout, or one that crashed leaving its worktree dirty, often dies
# without handoff_notes. If it posted none (as WORKER_KEY / WORKER_AS) since crossing the threshold
# (session start when it never crossed), post one for it: sender = WORKER_KEY, task_id = the ledger's
# in-flight task, notes built from the worker repo's git state. The broker's handoff rewind then pulls
# the inbox cursor back to the dispatch, so the next session re-reads the task and knows work is uncommitted.
# At most one per (task, git HEAD, git status): when WORKER_KEY's newest status for the task is already a
# watchdog fallback with the same git.head and status_short (from this or any earlier session), nothing is
# posted, so a crash loop on a dirty worktree does not flood the status channel or keep rewinding the cursor.
fallback_handoff() {  # $1 = kill-rotation | timeout | crash
  local why="$1" base="${STATUS_BASE:-0}" fb root="" task posted body res prev dup
  if [[ -f "$ROTATE_FLAG" ]]; then
    fb=$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).status_base||0)}catch{console.log(0)}' "$ROTATE_FLAG" 2>/dev/null)
    [[ "${fb:-0}" -gt 0 ]] && base=$fb
  fi
  root=$(git -C "$WORKER_DIR" rev-parse --show-toplevel 2>/dev/null || true)
  if [[ "$why" == "crash" ]] && { [[ -z "$root" ]] || [[ -z "$(git -C "$root" status --short 2>/dev/null)" ]]; }; then return 0; fi
  posted=$(mcp_tool_text read_messages "{\"channel\":\"${STATUS_CHANNEL}\",\"since_id\":${base},\"filter_type\":\"status\",\"limit\":500}" | node -e '
    let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{ const who = process.argv.slice(1);
      const hit = d.split("\n").some(l => { const m = /^\[#\d+\] \S+ <([^>]*)>: (.*)$/.exec(l); if (!m || !who.includes(m[1])) return false;
        try { const p = JSON.parse(m[2]); return !!(p.body && p.body.handoff_notes); } catch { return false; } });
      console.log(hit ? 1 : 0); })' "$WORKER_KEY" "$WORKER_AS" 2>/dev/null)
  if [[ "$posted" == "1" ]]; then echo "[watchdog:$WORKER] session posted its own handoff_notes — no fallback handoff"; return 0; fi
  read -r _ _ _ task <<<"$(ledger_open)"
  if [[ -z "$task" || "$task" == "-" ]]; then echo "[watchdog:$WORKER] $why with no handoff_notes, but no in-flight task in the ledger — no fallback handoff"; return 0; fi
  body=$(node -e '
    const [channel, sender, task, why, size, branch, head, status, stat] = process.argv.slice(1);
    const cap = (s, lines, bytes) => { const a = String(s || "").split("\n").filter(Boolean); const more = a.length > lines ? [`… ${a.length - lines} more`] : [];
                                       return a.slice(0, lines).concat(more).join("\n").slice(0, bytes); };
    const st = cap(status, 60, 6000);
    const files = st.split("\n").filter(l => l && !l.startsWith("…")).map(l => l.slice(3));
    const content = { type: "status", task_id: task, from: sender, to: "orchestrator",
      subject: `watchdog fallback handoff — ${why} at ${size} tokens`,
      body: { handoff_notes: { done: [], pending: ["session ended (" + why + ") before posting handoff_notes; see git state"],
                               files_touched: files, next_step: `inspect uncommitted work on ${branch || "the worker branch"} and continue the task` },
              git: { branch, head, status_short: st, diff_stat: cap(stat, 40, 3000) }, source: "watchdog" } };
    process.stdout.write(JSON.stringify({ channel, sender, content: JSON.stringify(content) }));
  ' "$STATUS_CHANNEL" "$WORKER_KEY" "$task" "$why" "${CTX_SIZE:-0}" \
    "$([[ -n "$root" ]] && git -C "$root" rev-parse --abbrev-ref HEAD 2>/dev/null)" "$([[ -n "$root" ]] && git -C "$root" rev-parse --short HEAD 2>/dev/null)" \
    "$([[ -n "$root" ]] && git -C "$root" status --short 2>/dev/null)" "$([[ -n "$root" ]] && git -C "$root" diff --stat HEAD 2>/dev/null)")
  prev=$(mcp_tool_text read_messages "{\"channel\":\"${STATUS_CHANNEL}\",\"filter_sender\":\"${WORKER_KEY}\",\"filter_type\":\"status\",\"limit\":100}")
  if [[ -z "$prev" ]]; then
    echo "[watchdog:$WORKER] WARN: could not read $STATUS_CHANNEL to dedupe the fallback handoff for $task — posting anyway"
  else
    dup=$(printf '%s' "$prev" | node -e '
      let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{ try {
        const want = JSON.parse(JSON.parse(process.argv[1]).content), g = want.body.git;
        let last = null;
        for (const l of d.split("\n")) { const m = /^\[#\d+\] \S+ <[^>]*>: (.*)$/.exec(l); if (!m) continue;
          try { const p = JSON.parse(m[1]); if (p.task_id === want.task_id) last = p; } catch {} }
        const lg = last?.body?.git;
        console.log(last?.body?.source === "watchdog" && lg && lg.head === g.head && lg.status_short === g.status_short ? 1 : 0);
      } catch { console.log(0); } })' "$body" 2>/dev/null)
    if [[ "$dup" == "1" ]]; then
      echo "[watchdog:$WORKER] $why: newest status for $task is already a watchdog fallback at the same git HEAD and status — not posting another"
      return 0
    fi
  fi
  res=$(_curl -sf --max-time 10 -X POST "${BROKER_URL}/messages" -H "Content-Type: application/json" -d "$body" 2>/dev/null || true)
  if [[ -n "$res" ]]; then echo "[watchdog:$WORKER] fallback handoff posted for $task ($why, no handoff_notes from the session): $res"
  else echo "[watchdog:$WORKER] WARN: fallback handoff for $task ($why) could not be posted"; fi
  return 0
}

# Heartbeat with the session's real context usage (CTX_* — see session_scan). $3 is an optional
# extra member for the context object (e.g. ',"backoff":{...}'): context is the one open object in
# the strict *-telemetry schemas, so watchdog annotations travel there.
emit_heartbeat() {
  local state="$1" exit_code="${2:-}" extra="${3:-}"
  local ts hb pct=0 rec=false sid="" act
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  if [[ "$ROTATE_AT_TOKENS" -gt 0 ]]; then pct=$(( ${CTX_SIZE:-0} * 100 / ROTATE_AT_TOKENS )); fi
  rotation_due && rec=true
  [[ -n "${CTX_SID:-}" ]] && sid=$(printf ',"session_id":"%s"' "$CTX_SID")
  if [[ -n "$exit_code" ]]; then act=$(printf '{"state":"%s","exit_code":%s}' "$state" "$exit_code")
  else act=$(printf '{"state":"%s"}' "$state"); fi
  [[ -n "$MODEL_REASON" ]] && extra=$(printf ',"model_reason":"%s"%s' "$MODEL_REASON" "$extra")
  hb=$(printf '{"type":"heartbeat","from":"%s","ts":"%s","model":"%s"%s,"context":{"size_tokens":%s,"cache_read":%s,"cache_create":%s,"tier_threshold_pct":%s,"rotation_recommended":%s%s},"activity":%s}' \
    "$WORKER_KEY" "$ts" "${SESSION_MODEL:-$DEFAULT_MODEL}" "$sid" "${CTX_SIZE:-0}" "${CTX_READ:-0}" "${CTX_CREATE:-0}" "$pct" "$rec" "$extra" "$act")
  _curl -sf -X POST "${BROKER_URL}/messages" -H "Content-Type: application/json" \
    -d "{\"channel\":\"${TELEMETRY_CHANNEL}\",\"sender\":\"${WORKER_KEY}\",\"content\":$(printf '%s' "$hb" | json_encode)}" \
    >/dev/null 2>&1 || true
}

# Rate-limit event for the broker's /rate-limits view and dashboard panel.
emit_rate_limit() {  # $1 = backoff seconds
  local ts ev
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  ev=$(printf '{"type":"rate-limit","from":"%s","ts":"%s","model":"%s","backoff_s":%s,"start_reason":"%s","restart_count":%s}' \
    "$WORKER_KEY" "$ts" "${SESSION_MODEL:-$DEFAULT_MODEL}" "$1" "${START_REASON:-unknown}" "$RESTART_COUNT")
  _curl -sf -X POST "${BROKER_URL}/messages" -H "Content-Type: application/json" \
    -d "{\"channel\":\"${RATE_LIMIT_CHANNEL}\",\"sender\":\"${WORKER_KEY}\",\"content\":$(printf '%s' "$ev" | json_encode)}" \
    >/dev/null 2>&1 || true
}

# ── Restart delays / limits ───────────────────────────────────────────────────

# WATCHDOG_DELAY_CRASH / WATCHDOG_DELAY_RATE_LIMIT exist for the tests (crash loops in seconds, not minutes).
DELAY_IDLE=10; DELAY_NORMAL=2; DELAY_CRASH=${WATCHDOG_DELAY_CRASH:-15}
DELAY_RATE_LIMIT=${WATCHDOG_DELAY_RATE_LIMIT:-60}; RATE_LIMIT_MAX=300
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

_cleanup() { rm -f "$LOCK_FILE" "$_CURL_CFG" "$_MCP_CFG" "$_GUARD_CFG" "$_GUARD_LOG" "$_GUARD_SETTINGS" "$ROTATE_FLAG" "$ROTATE_FLAG.count"; _release_slot; }
trap '_cleanup; echo "[watchdog:$WORKER] stopping"; exit 0' INT TERM
# After a session: with --once, exit instead of waiting for the next one.
_pause() { if [[ $ONCE -eq 1 ]]; then _cleanup; echo "[watchdog:$WORKER] --once: session complete — exiting"; exit 0; fi; sleep "$1"; }

_JMAX=${WATCHDOG_JITTER_MAX:-20}
if [[ "$_JMAX" -gt 0 ]]; then _JITTER=$(( RANDOM % _JMAX )); [[ $_JITTER -gt 0 ]] && sleep "$_JITTER"; fi

echo "[watchdog:$WORKER] starting — dir: $WORKER_DIR  inbox: $INBOX_CHANNEL  max-session: $(( MAX_SESSION_SECONDS / 60 ))min"
echo "[watchdog:$WORKER] identity: role=$WORKER_ROLE as=$WORKER_AS key=$WORKER_KEY — role= $ROLE_URL_REASON"
echo "[watchdog:$WORKER] model routing: $MODEL_ROUTE"
echo "[watchdog:$WORKER] guardrails: $GUARDRAILS_REASON — MCP inherit: $MCP_INHERIT_REASON"
[[ ${#_TOOL_ARGS[@]} -gt 0 ]] && echo "[watchdog:$WORKER] tools: ${_TOOL_ARGS[*]}"
[[ -n "${WATCHDOG_MODEL_WARNING:-}" ]] && echo "[watchdog:$WORKER] WARN model routing: $WATCHDOG_MODEL_WARNING"
[[ -n "$PATROL_INTERVAL" ]] && echo "[watchdog:$WORKER] patrol every ${PATROL_INTERVAL}s (watch: $PATROL_WATCH_CHANNEL)"

RESTART_COUNT=0; RATE_LIMIT_BACKOFF=$DELAY_RATE_LIMIT
NO_OUTPUT_RUNS=0; NO_OUTPUT_MAX=3
LAST_PATROL_START=0; PATROL_JSON=""
# API unreachable (DNS / connection failures): exponential backoff, reset by a successful session.
NET_BACKOFF_BASE=${NET_BACKOFF_BASE:-15}; NET_BACKOFF_MAX=${NET_BACKOFF_MAX:-600}; NET_FAILS=0
NET_DOWN_RE="ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|getaddrinfo|Connection error|Unable to connect|fetch failed|network is unreachable"
# Follow-up launches: a session that exits cleanly while the ledger still holds open tasks for
# this worker (it rotated with handoff_notes, or stopped before idle pickup) is relaunched instead
# of idling until the next inbox message. Capped so a task that cannot progress does not loop.
FORCE_START=""; FOLLOWUP_RUNS=0; FOLLOWUP_MAX=${FOLLOWUP_MAX:-3}; PREV_OPEN=0
# A follow-up or rotation launch whose session failed is retried after the failure's delay — an
# idle inbox would otherwise strand it.
_keep_forced_start() { case "$START_REASON" in followup|startup-followup|rotate) FORCE_START="$START_REASON" ;; esac; }

VERIFIER="${WATCHDOG_VERIFIER:-$(cd "$(dirname "$0")" && pwd)/verify-result.mjs}"
# Re-run the dispatch checks[] of results this session posted (status ids > $1). Never fatal: a broken
# verifier leaves those results unverified (verified: null), it does not stop the worker.
verify_results() {  # $1 = status max id before the session
  [[ "$VERIFY" -eq 1 ]] || return 0
  if [[ ! -f "$VERIFIER" ]]; then echo "[watchdog:$WORKER] WARN: verification on but $VERIFIER is missing — skipped"; return 0; fi
  # The broker may have started enforcing the verifier credential after this watchdog started (its env
  # predates VERIFIER_TRUST_NAMESPACES): ask /health so the switch-over needs no watchdog restart.
  if _curl -s --max-time 5 "$BROKER_URL/health" 2>/dev/null | NS="$NAMESPACE" node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const t=JSON.parse(d).verifier_trust;process.exit(t&&t.enabled&&t.namespaces.some(n=>n.toLowerCase()===process.env.NS.toLowerCase())?0:1)}catch{process.exit(1)}})'; then
    echo "[watchdog:$WORKER] verification: external (broker verifier_trust has '$NAMESPACE') — skipped"; return 0
  fi
  local out
  out=$(cd "$WORKER_DIR" && BROKER_URL="$BROKER_URL" BROKER_SECRET="$BROKER_SECRET" "$NODE_BIN" "$VERIFIER" \
        --status-channel "$STATUS_CHANNEL" --worker "$WORKER_AS" --repo "$WORKER_DIR" --since-id "${1:-0}" 2>&1) \
    || echo "[watchdog:$WORKER] WARN: verifier failed — results stay unverified"
  [[ -n "$out" ]] && while IFS= read -r _l; do echo "[watchdog:$WORKER] $_l"; done <<<"$out"
  return 0
}

# Startup follow-up: a fresh watchdog whose cursor already equals the inbox max would otherwise idle
# with a task still open for it (a restart mid-task, an adoption restart). Same ledger check, key
# and FOLLOWUP_MAX budget as the post-exit follow-up; an unreachable broker reads as "0 0" — skip.
read -r OPEN_N OPEN_MIN _ <<<"$(ledger_open)"
PREV_OPEN=$OPEN_N
if [[ "$OPEN_N" -gt 0 && $FOLLOWUP_RUNS -lt $FOLLOWUP_MAX ]]; then
  FOLLOWUP_RUNS=$((FOLLOWUP_RUNS + 1))
  rewind_worker_cursor $(( OPEN_MIN - 1 ))
  FORCE_START="startup-followup"
  echo "[watchdog:$WORKER] startup — $OPEN_N open task(s) in the ledger — follow-up launch $FOLLOWUP_RUNS/$FOLLOWUP_MAX"
fi

while true; do
  CURSOR=$(read_cursor); NOW=$(date +%s); START_REASON=""

  INBOX_JSON=$(check_inbox "$CURSOR")
  json_pending "$INBOX_JSON" && START_REASON="inbox"
  if [[ -n "$FORCE_START" ]]; then
    [[ -z "$START_REASON" ]] && START_REASON="$FORCE_START"
    FORCE_START=""
  fi
  [[ "$START_REASON" == "inbox" ]] && FOLLOWUP_RUNS=0

  if [[ -z "$START_REASON" && -n "$PATROL_INTERVAL" ]]; then
    if [[ $(( NOW - LAST_PATROL_START )) -ge $PATROL_INTERVAL ]]; then
      PATROL_JSON=$(check_channel_for_work "$PATROL_WATCH_CHANNEL" "$(read_patrol_cursor)")
      if json_pending "$PATROL_JSON"; then START_REASON="patrol"; else LAST_PATROL_START=$NOW; fi
    fi
  fi

  if [[ -z "$START_REASON" ]]; then sleep $DELAY_IDLE; continue; fi

  if ! _acquire_slot; then
    echo "[watchdog:$WORKER] all $MAX_CONCURRENT slots busy — retrying in ${DELAY_IDLE}s"; sleep $DELAY_IDLE; continue
  fi

  MAX_ID=$(json_max_id "$INBOX_JSON")
  # Remember where the status channel stood, so a clean exit can be checked for actual output.
  STATUS_BASE=$(json_max_id "$(check_channel "$STATUS_CHANNEL" 0)")
  # The next open task's scope routes the model (a blocked or plan-review task's when nothing else is
  # open); pinned and reviewer sessions skip the lookup.
  NEXT_SCOPE=""
  if [[ "$MODEL_PINNED" -eq 0 && "$IS_REVIEWER" != "1" && "$START_REASON" != "patrol" ]]; then
    read -r _N _MIN NEXT_SCOPE _ <<<"$(ledger_open)"
    [[ "$NEXT_SCOPE" == "none" ]] && NEXT_SCOPE=""
  fi
  resolve_model "$START_REASON" "$NEXT_SCOPE"
  echo "[watchdog:$WORKER] --- restart #$RESTART_COUNT [reason: $START_REASON, inbox_max_id: $MAX_ID] --- model: $SESSION_MODEL ($MODEL_REASON)"
  RESTART_COUNT=$((RESTART_COUNT + 1))
  [[ "$START_REASON" == "patrol" ]] && LAST_PATROL_START=$NOW

  TMPOUT=$(mktemp /tmp/watchdog-${SAFE_NAME}-XXXXXX)
  _TFLAG=$(mktemp /tmp/watchdog-${SAFE_NAME}-timeout-XXXXXX); rm -f "$_TFLAG"
  _RFLAG="${_TFLAG%-timeout-*}-rotate-${_TFLAG##*-}"; rm -f "$_RFLAG"
  CTX_SIZE=0; CTX_READ=0; CTX_CREATE=0; CTX_SID=""; RESULT_ERR=0; RATE_ERR=0
  rm -f "$ROTATE_FLAG" "$ROTATE_FLAG.count" "$ROTATE_FLAG.tmp"

  set +e
  if [[ "$LAUNCHER" == "sdk" ]]; then
  ( cd "$WORKER_DIR"; exec "$NODE_BIN" "$RUNNER" "$WORKER" --work-dir "$WORKER_DIR" --inbox-channel "$INBOX_CHANNEL" --model "$SESSION_MODEL" ${_MCP_CFG:+--mcp-config "$_MCP_CFG"} \
      ${_SDK_TOOL_ARGS[@]+"${_SDK_TOOL_ARGS[@]}"} ${_GUARD_CFG:+--guardrails "$_GUARD_CFG"} ${_ROT_SDK_ARGS[@]+"${_ROT_SDK_ARGS[@]}"} ) > "$TMPOUT" 2>&1 &
  else
  ( cd "$WORKER_DIR"; exec "$CLAUDE" -p "go" --dangerously-skip-permissions --model "$SESSION_MODEL" ${_TOOL_ARGS[@]+"${_TOOL_ARGS[@]}"} ${_OUT_ARGS[@]+"${_OUT_ARGS[@]}"} \
      ${_MCP_ARGS[@]+"${_MCP_ARGS[@]}"} ${_GUARD_ARGS[@]+"${_GUARD_ARGS[@]}"} ) > "$TMPOUT" 2>&1 &
  fi
  _BGPID=$!

  # Heartbeats carry the live context size. Over ROTATE_AT_TOKENS they recommend rotation; a session
  # that is still over it ROTATE_KILL_AFTER_S later is terminated so the next launch starts fresh.
  ( _START=$(date +%s); _OVER_SINCE=0
    while kill -0 "$_BGPID" 2>/dev/null; do
      _NOW=$(date +%s); _EL=$(( _NOW - _START ))
      if [[ $(( _EL % HEARTBEAT_INTERVAL )) -lt 1 ]]; then
        set_usage "$(session_scan "$TMPOUT")"
        emit_heartbeat "working" >/dev/null 2>&1 || true
        if rotation_due; then
          [[ $_OVER_SINCE -eq 0 ]] && { _OVER_SINCE=$_NOW; write_rotate_flag; echo "[watchdog:$WORKER] context ${CTX_SIZE} >= ${ROTATE_AT_TOKENS} tokens — rotation recommended"; }
          if [[ $ROTATE_KILL_AFTER_S -gt 0 && $(( _NOW - _OVER_SINCE )) -ge $ROTATE_KILL_AFTER_S ]]; then
            touch "$_RFLAG"; echo "[watchdog:$WORKER] context still ${CTX_SIZE} tokens ${ROTATE_KILL_AFTER_S}s after crossing the threshold — terminating for rotation"
            kill -TERM "$_BGPID" 2>/dev/null; sleep 5; kill -KILL "$_BGPID" 2>/dev/null; break
          fi
        fi
      fi
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
  ROTATED=false; [[ -f "$_RFLAG" ]] && ROTATED=true
  rm -f "$_TFLAG" "$_RFLAG"; _release_slot; set -e

  flush_guard_log
  _GUARD_HB=""; [[ "$GUARDRAILS" -eq 1 ]] && _GUARD_HB=",\"guardrail_denies\":$GUARD_DENIES"
  _SCAN=$(session_scan "$TMPOUT" diag)
  set_usage "$(head -n 1 <<<"$_SCAN")"
  _DIAG=$(tail -n +2 <<<"$_SCAN")
  rm -f "$TMPOUT"
  RATE_LIMITED=false; NET_DOWN=false
  [[ "$RATE_ERR" == "1" ]] && RATE_LIMITED=true
  # Only a failed session counts as API-unreachable: non-zero exit (not our own timeout/rotation
  # kill), or a clean exit whose result event is an error.
  if [[ "$RATE_LIMITED" == "false" && "$ROTATED" == "false" && $EXIT_CODE -ne 124 ]] \
     && { [[ $EXIT_CODE -ne 0 ]] || [[ "$RESULT_ERR" == "1" ]]; } \
     && grep -qE "$NET_DOWN_RE" <<<"$_DIAG"; then
    NET_DOWN=true
  fi

  if [[ "$NET_DOWN" == "true" ]]; then
    NET_FAILS=$((NET_FAILS + 1))
    WAIT=$NET_BACKOFF_BASE
    for (( _i = 1; _i < NET_FAILS && WAIT < NET_BACKOFF_MAX; _i++ )); do WAIT=$(( WAIT * 2 )); done
    [[ $WAIT -gt $NET_BACKOFF_MAX ]] && WAIT=$NET_BACKOFF_MAX
    _RESUME=$(date -u -r $(( $(date +%s) + WAIT )) +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$(( $(date +%s) + WAIT ))" +%Y-%m-%dT%H:%M:%SZ)
    emit_heartbeat "session-end" "$EXIT_CODE" "$_GUARD_HB$(printf ',"backoff":{"reason":"api-unreachable","attempt":%s,"delay_s":%s,"resume_at":"%s"}' "$NET_FAILS" "$WAIT" "$_RESUME")"
    echo "[watchdog:$WORKER] API unreachable (exit $EXIT_CODE, failure #$NET_FAILS) — backing off ${WAIT}s (cursor unchanged)"
    rewind_broker_cursor "$CURSOR"
    _keep_forced_start
    _pause $WAIT
    continue
  fi
  emit_heartbeat "session-end" "$EXIT_CODE" "$_GUARD_HB"
  verify_results "$STATUS_BASE"
  # A rate-limited session ended because of the API, not the task: the next attempt resumes the same task.
  # A rotation kill is ours, though: its fallback handoff fires whatever errors the session saw.
  if [[ "$ROTATED" == "true" ]]; then fallback_handoff kill-rotation
  elif [[ "$RATE_LIMITED" == "true" ]]; then
    [[ $EXIT_CODE -ne 0 ]] && echo "[watchdog:$WORKER] rate-limited exit — no fallback handoff"
  elif [[ $EXIT_CODE -eq 124 ]]; then fallback_handoff timeout
  elif [[ $EXIT_CODE -ne 0 ]]; then fallback_handoff crash; fi
  rm -f "$ROTATE_FLAG" "$ROTATE_FLAG.count"

  if [[ "$ROTATED" == "true" ]]; then
    # Killed for context size. The fresh session resumes from the handoff status if the old one got
    # to post it (the broker already rewound its cursor), else from the rewound inbox cursor.
    echo "[watchdog:$WORKER] rotated at ${CTX_SIZE} tokens — relaunching a fresh session in ${DELAY_NORMAL}s (cursor unchanged)"
    rewind_broker_cursor "$CURSOR"
    NET_FAILS=0; FORCE_START="rotate"; _pause $DELAY_NORMAL
  elif [[ $EXIT_CODE -eq 0 ]]; then
    NET_FAILS=0
    # A clean exit alone does not prove the session handled its inbox — a session that decides
    # "nothing to do" also exits 0. For inbox-triggered runs, advance the cursor only if the
    # session posted something to the status channel; otherwise keep it and retry, giving up
    # after NO_OUTPUT_MAX silent runs so one bad message cannot pin the worker in a loop.
    if [[ "$START_REASON" != "inbox" ]] || json_pending "$(check_channel "$STATUS_CHANNEL" "$STATUS_BASE")"; then
      [[ "$MAX_ID" -gt "$CURSOR" ]] && write_cursor "$MAX_ID"
      NO_OUTPUT_RUNS=0
      if [[ -n "$PATROL_INTERVAL" ]]; then
        PL=$(json_max_id "$PATROL_JSON"); [[ "$PL" -gt "0" ]] && write_patrol_cursor "$PL"
      fi
      read -r OPEN_N OPEN_MIN _ <<<"$(ledger_open)"
      [[ "$OPEN_N" -lt "$PREV_OPEN" ]] && FOLLOWUP_RUNS=0
      PREV_OPEN=$OPEN_N
      if [[ "$OPEN_N" -gt 0 && $FOLLOWUP_RUNS -lt $FOLLOWUP_MAX ]]; then
        FOLLOWUP_RUNS=$((FOLLOWUP_RUNS + 1))
        rewind_worker_cursor $(( OPEN_MIN - 1 ))
        FORCE_START="followup"
        echo "[watchdog:$WORKER] clean exit — cursor=$(read_cursor), $OPEN_N open task(s) in the ledger — follow-up launch $FOLLOWUP_RUNS/$FOLLOWUP_MAX in ${DELAY_NORMAL}s"
      elif [[ "$OPEN_N" -gt 0 ]]; then
        echo "[watchdog:$WORKER] clean exit — cursor=$(read_cursor); WARN: $OPEN_N open task(s) after $FOLLOWUP_MAX follow-up launches without progress — idling until new inbox work"
      else
        echo "[watchdog:$WORKER] clean exit — cursor=$(read_cursor), restarting in ${DELAY_NORMAL}s"
      fi
      RATE_LIMIT_BACKOFF=$DELAY_RATE_LIMIT; _pause $DELAY_NORMAL
    else
      NO_OUTPUT_RUNS=$((NO_OUTPUT_RUNS + 1))
      if [[ $NO_OUTPUT_RUNS -ge $NO_OUTPUT_MAX ]]; then
        echo "[watchdog:$WORKER] WARN: $NO_OUTPUT_RUNS clean exits with nothing posted to $STATUS_CHANNEL — advancing cursor to $MAX_ID anyway"
        [[ "$MAX_ID" -gt "$CURSOR" ]] && write_cursor "$MAX_ID"
        NO_OUTPUT_RUNS=0
      else
        echo "[watchdog:$WORKER] clean exit but nothing posted to $STATUS_CHANNEL — cursor unchanged (attempt $NO_OUTPUT_RUNS/$NO_OUTPUT_MAX), retrying in ${DELAY_CRASH}s"
        rewind_broker_cursor "$CURSOR"
      fi
      RATE_LIMIT_BACKOFF=$DELAY_RATE_LIMIT; _pause $DELAY_CRASH
    fi
  elif [[ "$RATE_LIMITED" == "true" ]]; then
    JIT=$(( RANDOM % 16 )); WAIT=$(( RATE_LIMIT_BACKOFF + JIT ))
    echo "[watchdog:$WORKER] RATE LIMITED — backing off ${WAIT}s"
    echo "[watchdog:$WORKER] next retry at $(date -u -v+${WAIT}S +%H:%M:%SZ 2>/dev/null || date -u -d "+${WAIT} seconds" +%H:%M:%SZ 2>/dev/null || echo unknown)"
    emit_rate_limit "$WAIT"
    _keep_forced_start
    _pause $WAIT
    RATE_LIMIT_BACKOFF=$(( RATE_LIMIT_BACKOFF * 2 )); [[ $RATE_LIMIT_BACKOFF -gt $RATE_LIMIT_MAX ]] && RATE_LIMIT_BACKOFF=$RATE_LIMIT_MAX
  elif [[ $EXIT_CODE -eq 124 ]]; then
    echo "[watchdog:$WORKER] session timeout — restarting in ${DELAY_CRASH}s (cursor unchanged)"
    rewind_broker_cursor "$CURSOR"; _keep_forced_start
    RATE_LIMIT_BACKOFF=$DELAY_RATE_LIMIT; _pause $DELAY_CRASH
  else
    echo "[watchdog:$WORKER] non-zero exit ($EXIT_CODE) — restarting in ${DELAY_CRASH}s (cursor unchanged)"
    rewind_broker_cursor "$CURSOR"; _keep_forced_start
    RATE_LIMIT_BACKOFF=$DELAY_RATE_LIMIT; _pause $DELAY_CRASH
  fi
done
