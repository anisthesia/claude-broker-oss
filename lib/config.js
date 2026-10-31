// Runtime configuration: package version and every env-derived setting, read once at startup.
import "dotenv/config";
import { readFileSync } from "fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
export const VERSION = pkg.version;

export const PORT               = Number(process.env.PORT)                   || 8080;
export const SHARED_SECRET      = process.env.SHARED_SECRET                  || "";
// Separate secret for destructive operations on PRUNE_EXEMPT channels (force-purge). Headless
// workers hold SHARED_SECRET; this one is meant to live only with the human / ops tooling.
export const ADMIN_SECRET       = process.env.ADMIN_SECRET                   || "";
const ALLOW_NO_AUTH      = process.env.BROKER_ALLOW_NO_AUTH === "1";
export const DB_PATH            = process.env.DB_PATH                        || "./broker.db";
export const PRUNE_INTERVAL_MS  = Number(process.env.PRUNE_INTERVAL_MS)      || 5 * 60 * 1000;   // 5 min
export const PRUNE_MAX_AGE_MS   = Number(process.env.PRUNE_MAX_AGE_MS)       || 48 * 60 * 60 * 1000; // 48 h
export const PRUNE_EXEMPT       = (process.env.PRUNE_EXEMPT || "").split(",").map(s => s.trim()).filter(Boolean);
// Compacting prune: "signal" message types (the audit trail) live longer than chatter.
// Heartbeats/status/notes go at PRUNE_MAX_AGE_MS; tasks/results/questions at PRUNE_SIGNAL_MAX_AGE_MS.
export const PRUNE_SIGNAL_TYPES     = (process.env.PRUNE_SIGNAL_TYPES || "task,result,question,error,contract-change,contract-proposal,finding,decision").split(",").map(s => s.trim()).filter(Boolean);
export const PRUNE_SIGNAL_MAX_AGE_MS = Number(process.env.PRUNE_SIGNAL_MAX_AGE_MS) || 30 * 24 * 60 * 60 * 1000; // 30 d
// On *-telemetry channels, a new row from a sender evicts that sender's older rows whose
// state is transient (working/idle-polling). Session-end and idle-exit rows are kept so
// cost history survives. Makes plain POST /messages heartbeats behave like upsert_heartbeat.
export const HEARTBEAT_TRANSIENT_STATES = (process.env.HEARTBEAT_TRANSIENT_STATES || "working,idle-polling").split(",").map(s => s.trim()).filter(Boolean);
// Upper bound on one message's content (UTF-8 bytes), enforced on every write path. Large payloads
// belong in a file or repo and travel as refs; readers fetch single fields with get_message(path).
export const MAX_CONTENT_BYTES  = Number(process.env.MAX_CONTENT_BYTES)      || 32768;
export const TELEMETRY_CHANNEL  = process.env.TELEMETRY_CHANNEL              || "telemetry";
export const RATE_LIMIT_CHANNEL = process.env.RATE_LIMIT_CHANNEL             || "rate-limits";
export const WATCHDOG_BIN       = process.env.WATCHDOG_BIN                   || "";
export const WORKERS_CONFIG     = process.env.WORKERS_CONFIG                 || "";
export const WORKERS_LOG_DIR    = process.env.WORKERS_LOG_DIR                || "./worker-logs";
export const WORKER_OFFLINE_THRESHOLD_S = Number(process.env.WORKER_OFFLINE_THRESHOLD_S) || 300;
export const WORKERS_TMUX_SESSION       = process.env.WORKERS_TMUX_SESSION               || "";
export const TMUX_BIN                   = process.env.TMUX_BIN                            || "tmux";

// Fail-fast: refuse to start unauthenticated unless the operator explicitly opts in.
// Auth via a single shared bearer secret; set SHARED_SECRET in .env for any networked deployment.
if (!SHARED_SECRET && !ALLOW_NO_AUTH) {
  console.error("[claude-broker] FATAL: SHARED_SECRET is not set. Set it in .env, or set BROKER_ALLOW_NO_AUTH=1 to run without auth (local/trusted networks only).");
  process.exit(1);
}

export const startedAt = Date.now();

// Session model routing (watchdog.sh resolve_model mirrors this; lib/workers.js uses it for the
// spawn env and the same-model warning). Precedence, highest first: start_worker model= > config
// entry "model" (both pinned, never changed) > reviewer > scope of the next open task (entry
// "model_by_scope", then WATCHDOG_MODEL_BY_SCOPE) > no-task model > default.
// A broker-level CLAUDE_MODEL is the default for unpinned workers, not a pin.
export const MODEL_ID_RE = /^[A-Za-z0-9._:@\/-]{1,100}$/;
export const SCOPES = ["small", "medium", "large"];
// "small=a,medium=b,large=c" -> { small: "a", ... }; unknown scopes and malformed ids are dropped.
export function parseModelByScope(s) {
  const out = {};
  for (const part of String(s || "").split(",")) {
    const [k, v] = part.split("=").map(x => (x || "").trim());
    if (SCOPES.includes(k) && MODEL_ID_RE.test(v)) out[k] = v;
  }
  return out;
}
export const DEFAULT_MODEL  = process.env.CLAUDE_MODEL            || "claude-sonnet-5-5";
export const NO_TASK_MODEL  = process.env.WATCHDOG_NO_TASK_MODEL  || "claude-haiku-4-5-20251001";
export const REVIEWER_MODEL = process.env.WATCHDOG_REVIEWER_MODEL || "claude-opus-5-5";
export const MODEL_BY_SCOPE = {
  small: "claude-sonnet-5-5", medium: "claude-sonnet-5-5", large: "claude-opus-5-5",
  ...parseModelByScope(process.env.WATCHDOG_MODEL_BY_SCOPE),
};
