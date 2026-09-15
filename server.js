import "dotenv/config";
import express from "express";
import Database from "better-sqlite3";
import { EventEmitter } from "events";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { spawn, spawnSync } from "child_process";
import { readFileSync, writeFileSync, renameSync, mkdirSync, createWriteStream, openSync, closeSync, accessSync, constants as fsConstants } from "fs";
import { timingSafeEqual } from "crypto";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const VERSION = pkg.version;

const PORT               = Number(process.env.PORT)                   || 8080;
const SHARED_SECRET      = process.env.SHARED_SECRET                  || "";
const ALLOW_NO_AUTH      = process.env.BROKER_ALLOW_NO_AUTH === "1";
const DB_PATH            = process.env.DB_PATH                        || "./broker.db";
const PRUNE_INTERVAL_MS  = Number(process.env.PRUNE_INTERVAL_MS)      || 5 * 60 * 1000;   // 5 min
const PRUNE_MAX_AGE_MS   = Number(process.env.PRUNE_MAX_AGE_MS)       || 48 * 60 * 60 * 1000; // 48 h
const PRUNE_EXEMPT       = (process.env.PRUNE_EXEMPT || "").split(",").map(s => s.trim()).filter(Boolean);
// Compacting prune: "signal" message types (the audit trail) live longer than chatter.
// Heartbeats/status/notes go at PRUNE_MAX_AGE_MS; tasks/results/questions at PRUNE_SIGNAL_MAX_AGE_MS.
const PRUNE_SIGNAL_TYPES     = (process.env.PRUNE_SIGNAL_TYPES || "task,result,question,error,contract-change,contract-proposal").split(",").map(s => s.trim()).filter(Boolean);
const PRUNE_SIGNAL_MAX_AGE_MS = Number(process.env.PRUNE_SIGNAL_MAX_AGE_MS) || 30 * 24 * 60 * 60 * 1000; // 30 d
// On *-telemetry channels, a new row from a sender evicts that sender's older rows whose
// state is transient (working/idle-polling). Session-end and idle-exit rows are kept so
// cost history survives. Makes plain POST /messages heartbeats behave like upsert_heartbeat.
const HEARTBEAT_TRANSIENT_STATES = (process.env.HEARTBEAT_TRANSIENT_STATES || "working,idle-polling").split(",").map(s => s.trim()).filter(Boolean);
const TELEMETRY_CHANNEL  = process.env.TELEMETRY_CHANNEL              || "telemetry";
const RATE_LIMIT_CHANNEL = process.env.RATE_LIMIT_CHANNEL             || "rate-limits";
const WATCHDOG_BIN       = process.env.WATCHDOG_BIN                   || "";
const WORKERS_CONFIG     = process.env.WORKERS_CONFIG                 || "";
const WORKERS_LOG_DIR    = process.env.WORKERS_LOG_DIR                || "./worker-logs";
const WORKER_OFFLINE_THRESHOLD_S = Number(process.env.WORKER_OFFLINE_THRESHOLD_S) || 300;
const WORKERS_TMUX_SESSION       = process.env.WORKERS_TMUX_SESSION               || "";
const TMUX_BIN                   = process.env.TMUX_BIN                            || "tmux";

// Fail-fast: refuse to start unauthenticated unless the operator explicitly opts in.
// Auth via a single shared bearer secret; set SHARED_SECRET in .env for any networked deployment.
if (!SHARED_SECRET && !ALLOW_NO_AUTH) {
  console.error("[claude-broker] FATAL: SHARED_SECRET is not set. Set it in .env, or set BROKER_ALLOW_NO_AUTH=1 to run without auth (local/trusted networks only).");
  process.exit(1);
}

// Worker names become filesystem paths (log files) and tmux window names, so they must
// not contain path separators, "..", or shell/control characters. Reject anything unsafe.
const WORKER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
function assertSafeWorkerName(name) {
  if (typeof name !== "string" || !WORKER_NAME_RE.test(name) || name.includes("..")) {
    throw new Error(`invalid worker name "${name}" — allowed: letters, digits, dot, dash, underscore (max 64, no "..")`);
  }
  return name;
}

// Constant-time bearer-token check — avoids leaking the secret via response timing.
function secretMatches(header) {
  const expected = `Bearer ${SHARED_SECRET}`;
  const a = Buffer.from(String(header || ""));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
function tokenMatches(token) {
  if (!token) return false;
  const a = Buffer.from(String(token));
  const b = Buffer.from(SHARED_SECRET);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Worker definitions loaded from WORKERS_CONFIG JSON file.
// Format: [{ "name": "backend", "ns": "dv", "args": ["backend"] }, ...]
// ns is optional — if set, worker appears only on that namespace tab.
// args are passed directly to WATCHDOG_BIN.
function loadWorkerDefs() {
  if (!WORKERS_CONFIG) return [];
  try {
    const defs = JSON.parse(readFileSync(WORKERS_CONFIG, "utf8"));
    if (!Array.isArray(defs)) throw new Error("top-level value is not an array");
    return defs.filter(d => d && typeof d.name === "string" && d.name);
  } catch (e) {
    console.warn(`[claude-broker] WORKERS_CONFIG load failed: ${e.message}`);
    return [];
  }
}

// Write WORKERS_CONFIG atomically (temp file + rename) so a crash mid-write
// can never leave a truncated file that loadWorkerDefs would read as "no workers".
function saveWorkerDefs(defs) {
  const tmp = `${WORKERS_CONFIG}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(defs, null, 2) + "\n", "utf8");
  renameSync(tmp, WORKERS_CONFIG);
}

if (WORKERS_CONFIG) {
  console.log(`[claude-broker] WORKERS_CONFIG=${WORKERS_CONFIG} (hot-reload enabled)`);
}

// name → { pid, proc, startedAt }
// Spawned watchdog processes are detached (own process group) so killing -pid kills the full tree.
const watchdogProcs = new Map();

const startedAt = Date.now();

// ── DB setup ──────────────────────────────────────────────────────────────────

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    channel     TEXT    NOT NULL,
    sender      TEXT    NOT NULL,
    content     TEXT    NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages(channel, id);

  CREATE TABLE IF NOT EXISTS channel_schemas (
    channel     TEXT    PRIMARY KEY,
    schema      TEXT    NOT NULL,
    strict      INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS capabilities (
    worker      TEXT    PRIMARY KEY,
    owns        TEXT    NOT NULL,
    channels    TEXT    NOT NULL,
    updated_at  INTEGER NOT NULL
  );
`);

// Migration: add version column if absent (safe to run on every startup)
try { db.exec("ALTER TABLE channel_schemas ADD COLUMN version TEXT DEFAULT NULL"); } catch (_) {}

// ── Prepared statements ───────────────────────────────────────────────────────

const metrics = {
  started_at: Date.now(),
  messages_inserted: 0,
  http: {},            // "METHOD /path" → count
  tools: {},           // name → { calls, errors, total_ms, max_ms }
  long_polls_active: 0,
  long_polls_total: 0,
  long_polls_woken: 0, // resolved by a message (vs timeout/abort)
};
function metricTool(name, ms, isError) {
  const t = metrics.tools[name] || (metrics.tools[name] = { calls: 0, errors: 0, total_ms: 0, max_ms: 0 });
  t.calls++; if (isError) t.errors++; t.total_ms += ms; if (ms > t.max_ms) t.max_ms = ms;
}
const stmtInsertRaw    = db.prepare("INSERT INTO messages (channel, sender, content, created_at) VALUES (?, ?, ?, ?)");
const stmtInsert       = { run: (...a) => { metrics.messages_inserted++; return stmtInsertRaw.run(...a); } };
const stmtSelect       = db.prepare("SELECT id, sender, content, created_at FROM messages WHERE channel = ? AND id > ? ORDER BY id ASC LIMIT ?");
const stmtSelectFilter = db.prepare(`
  SELECT id, sender, content, created_at FROM messages
  WHERE channel = ? AND id > ?
  AND (? IS NULL OR sender = ?)
  AND (? IS NULL OR (json_valid(content) AND json_extract(content, '$.type') = ?))
  ORDER BY id ASC LIMIT ?
`);
const stmtSelectFilterMulti = new Map(); // keyed by "nSenders_hasType"

function getMultiSenderStmt(nSenders, hasType) {
  const key = `${nSenders}_${hasType ? 1 : 0}`;
  if (!stmtSelectFilterMulti.has(key)) {
    const ph = Array(nSenders).fill("?").join(",");
    let sql = `SELECT id, sender, content, created_at FROM messages WHERE channel = ? AND id > ? AND sender IN (${ph})`;
    if (hasType) sql += ` AND json_valid(content) AND json_extract(content, '$.type') = ?`;
    sql += ` ORDER BY id ASC LIMIT ?`;
    stmtSelectFilterMulti.set(key, db.prepare(sql));
  }
  return stmtSelectFilterMulti.get(key);
}
const stmtDeleteOne    = db.prepare("DELETE FROM messages WHERE id = ? AND channel = ?");
const stmtChans        = db.prepare("SELECT channel, COUNT(*) AS n, MAX(id) AS last_id, MAX(created_at) AS last_ts FROM messages GROUP BY channel ORDER BY channel");
const stmtChansByPrefix = db.prepare("SELECT DISTINCT channel FROM messages WHERE channel LIKE ? ORDER BY channel");
const stmtPurge        = db.prepare("DELETE FROM messages WHERE channel = ?");
const stmtPruneOlder   = db.prepare("DELETE FROM messages WHERE channel = ? AND created_at < ?");
// Chatter (anything not a signal type, including non-JSON) at the short cutoff …
const stmtPruneAllOld  = db.prepare(`
  DELETE FROM messages WHERE channel NOT IN (SELECT value FROM json_each(?)) AND created_at < ?
    AND NOT (json_valid(content) AND json_extract(content, '$.type') IN (SELECT value FROM json_each(?)))
`);
// … signal types at the long cutoff.
const stmtPruneSignalOld = db.prepare(`
  DELETE FROM messages WHERE channel NOT IN (SELECT value FROM json_each(?)) AND created_at < ?
    AND json_valid(content) AND json_extract(content, '$.type') IN (SELECT value FROM json_each(?))
`);
const stmtDeleteTransientHeartbeats = db.prepare(`
  DELETE FROM messages WHERE channel = ? AND sender = ? AND id != ?
    AND json_valid(content)
    AND COALESCE(json_extract(content, '$.activity.state'), json_extract(content, '$.state')) IN (SELECT value FROM json_each(?))
`);
const stmtQuestions = db.prepare(`
  SELECT id, channel, sender, content, created_at FROM messages
  WHERE channel LIKE ? AND json_valid(content) AND json_extract(content, '$.type') = 'question'
  ORDER BY id ASC
`);
// A question is answered when something lands on the asker's inbox after it that names the
// task_id, or when the asker itself posts a result for that task_id (self-resolved).
const stmtQuestionReply = db.prepare(`
  SELECT id, sender, created_at FROM messages
  WHERE channel = ? AND id > ?
    AND (json_extract(content, '$.task_id') = ? OR (? IS NOT NULL AND instr(content, ?) > 0))
  ORDER BY id ASC LIMIT 1
`);
const stmtQuestionSelfResult = db.prepare(`
  SELECT id FROM messages
  WHERE channel LIKE ? AND id > ? AND sender = ?
    AND json_valid(content) AND json_extract(content, '$.type') = 'result' AND json_extract(content, '$.task_id') = ?
  LIMIT 1
`);
// summary must come from the newest result row (highest id), not a lexicographic MAX
// over summary strings — a stale 'PASS — ...' would shadow a later 'FAIL — ...'.
// SQLite guarantees bare columns resolve from the MAX(id) row when the query has a
// single min()/max() aggregate.
const stmtCheckResult  = db.prepare(`
  SELECT COUNT(*) AS n,
         MAX(id) AS latest_id,
         json_extract(content, '$.summary') AS summary
  FROM messages WHERE channel = ? AND json_valid(content)
    AND json_extract(content, '$.task_id') = ? AND json_extract(content, '$.type') = 'result'
`);

const stmtSchemaGet    = db.prepare("SELECT channel, schema, strict, updated_at, version FROM channel_schemas WHERE channel = ?");
const stmtSchemaUpsert = db.prepare(`
  INSERT INTO channel_schemas (channel, schema, strict, updated_at, version) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(channel) DO UPDATE SET schema=excluded.schema, strict=excluded.strict, updated_at=excluded.updated_at, version=excluded.version
`);
const stmtSchemaDel         = db.prepare("DELETE FROM channel_schemas WHERE channel = ?");
const stmtSchemaList        = db.prepare("SELECT channel, strict, updated_at, version FROM channel_schemas ORDER BY channel");
const stmtSchemaListPrefix  = db.prepare("SELECT channel, strict, updated_at, version FROM channel_schemas WHERE channel LIKE ? ORDER BY channel");

// One-shot migration: purge reg-* test debris
if (db.prepare("SELECT COUNT(*) AS n FROM channel_schemas WHERE channel LIKE 'reg-%'").get().n > 0) {
  db.prepare("DELETE FROM channel_schemas WHERE channel LIKE 'reg-%'").run();
}

const stmtLatestPerSender = db.prepare(`
  SELECT m.id, m.sender, m.content, m.created_at
  FROM messages m
  INNER JOIN (
    SELECT sender, MAX(id) AS max_id FROM messages WHERE channel = ? GROUP BY sender
  ) latest ON m.id = latest.max_id
  ORDER BY m.sender
`);

const stmtLatestMsgPerChannel = db.prepare(`
  SELECT m.channel, m.sender, m.content, m.created_at
  FROM messages m
  INNER JOIN (
    SELECT channel, MAX(id) AS max_id FROM messages GROUP BY channel
  ) latest ON m.channel = latest.channel AND m.id = latest.max_id
`);

// Sprint info: latest sprint-boundary note on a control channel
const stmtSprintInfo = db.prepare(`
  SELECT content, created_at FROM messages
  WHERE channel = ?
    AND json_valid(content)
    AND json_extract(content, '$.type') = 'note'
    AND json_extract(content, '$.subject') LIKE 'sprint-%'
  ORDER BY id DESC LIMIT 1
`);

// Sprint progress: result/failed counts from the status channel.
// Dispatched count comes from stmtSprintDispatched (inbox channels) — tasks never appear on the status channel.
const stmtSprintProgress = db.prepare(`
  SELECT
    COUNT(CASE WHEN json_valid(content) AND json_extract(content, '$.type') = 'result' THEN 1 END) AS completed,
    COUNT(CASE WHEN json_valid(content) AND json_extract(content, '$.type') = 'result'
               AND json_extract(content, '$.summary') LIKE 'FAIL%' THEN 1 END) AS failed
  FROM messages WHERE channel = ?
`);

const stmtHasMessages = db.prepare(
  "SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS max_id FROM messages WHERE channel = ? AND id > ?"
);

const stmtDeleteOtherHeartbeats = db.prepare(
  "DELETE FROM messages WHERE channel = ? AND sender = ? AND id != ?"
);

// Cached per-N prepared statements for check_results_batch
const stmtBatchResultsCache = new Map();
function getBatchResultsStmt(n) {
  if (!stmtBatchResultsCache.has(n)) {
    const ph = Array(n).fill("?").join(",");
    stmtBatchResultsCache.set(n, db.prepare(
      `SELECT DISTINCT json_extract(content, '$.task_id') AS task_id
       FROM messages WHERE channel = ? AND json_valid(content)
         AND json_extract(content, '$.type') = 'result'
         AND json_extract(content, '$.task_id') IN (${ph})`
    ));
  }
  return stmtBatchResultsCache.get(n);
}
const stmtChanViewRows = db.prepare(
  "SELECT id, sender, content, created_at FROM messages WHERE channel = ? AND id > ? ORDER BY id DESC LIMIT ?"
);
const stmtChanCount = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE channel = ?");
const stmtResultRowsSince = db.prepare(`
  SELECT sender, content FROM messages
  WHERE channel = ? AND id > ? AND json_valid(content) AND json_extract(content, '$.type') = 'result'
  ORDER BY id ASC
`);
const stmtReadLast = db.prepare(
  "SELECT id, sender, content, created_at FROM messages WHERE channel = ? ORDER BY id DESC LIMIT ?"
);

// Count type:task messages dispatched into worker inboxes for a namespace (derived from status channel).
// Excludes meta-channels (status, control, telemetry, backlog, sprint-retrospective).
const stmtSprintDispatched = db.prepare(`
  SELECT COUNT(*) AS n FROM messages
  WHERE channel LIKE ?
    AND channel NOT LIKE '%-status' AND channel NOT LIKE '%-control'
    AND channel NOT LIKE '%-telemetry' AND channel NOT LIKE '%-backlog'
    AND channel NOT LIKE '%-sprint-retrospective'
    AND json_valid(content) AND json_extract(content, '$.type') = 'task'
`);

// Module-level prepared statements for /cost, /rate-limits, and dashboard (avoids inline prepare on each request).
const stmtCostEndpointRows = db.prepare(
  `SELECT sender, content, created_at FROM messages WHERE channel = ? AND created_at >= ? ORDER BY id ASC`
);
const stmtRlEndpointRows = db.prepare(
  `SELECT sender, content, created_at FROM messages WHERE channel = ? AND created_at >= ? ORDER BY id ASC`
);
const stmtDashCostRows = db.prepare(
  `SELECT sender, content FROM messages WHERE (channel = ? OR channel LIKE '%-telemetry') AND created_at >= ? ORDER BY id ASC`
);
const stmtDashRlRows = db.prepare(
  `SELECT sender, content FROM messages WHERE (channel = ? OR channel LIKE '%-rate-limits') AND created_at >= ? ORDER BY id ASC`
);
const stmtDashChanRows = db.prepare(
  `SELECT sender, content FROM messages WHERE channel = ? AND created_at >= ? ORDER BY id ASC`
);

// Per-worker task timing: join dispatch (worker inbox) with result (status channel) on task_id
const stmtWorkerTiming = db.prepare(`
  WITH dispatches AS (
    SELECT json_extract(content,'$.task_id') AS task_id,
           created_at AS dispatched_at,
           SUBSTR(channel, INSTR(channel,'-')+1) AS worker
    FROM messages
    WHERE json_valid(content) AND json_extract(content,'$.type') = 'task'
      AND channel NOT LIKE 'test%'
      AND channel NOT LIKE '%-status' AND channel NOT LIKE '%-telemetry'
      AND channel NOT LIKE '%-control' AND channel NOT LIKE '%-backlog'
      AND channel NOT LIKE '%-sprint-retrospective'
  ),
  results AS (
    SELECT json_extract(content,'$.task_id') AS task_id,
           sender AS worker,
           created_at AS completed_at
    FROM messages
    WHERE json_valid(content) AND json_extract(content,'$.type') = 'result'
      AND channel LIKE '%-status'
  )
  SELECT r.worker,
         COUNT(*) AS tasks_done,
         ROUND(AVG(r.completed_at - d.dispatched_at) / 60000.0, 1) AS avg_min,
         ROUND(MIN(r.completed_at - d.dispatched_at) / 60000.0, 1) AS min_min,
         ROUND(MAX(r.completed_at - d.dispatched_at) / 60000.0, 1) AS max_min,
         MAX(r.completed_at) AS last_result_at
  FROM results r
  JOIN dispatches d ON r.task_id = d.task_id AND r.worker = d.worker
  WHERE r.completed_at > d.dispatched_at
  GROUP BY r.worker
`);

const feedStmtCache = new Map(); // keyed by "nChannels_signalOnly"
function getFeedStmt(nChannels, signalOnly) {
  const key = `${nChannels}_${signalOnly ? 1 : 0}`;
  if (!feedStmtCache.has(key)) {
    const ph = Array(nChannels).fill("?").join(",");
    const typeClause = signalOnly
      ? `AND json_valid(content) AND json_extract(content, '$.type') IN ('task', 'result', 'question', 'error')`
      : `AND json_valid(content)`;
    feedStmtCache.set(key, db.prepare(
      `SELECT id, channel, sender, content, created_at FROM messages WHERE channel IN (${ph}) ${typeClause} ORDER BY id DESC LIMIT ?`
    ));
  }
  return feedStmtCache.get(key);
}

const stmtCapUpsert = db.prepare(`
  INSERT INTO capabilities (worker, owns, channels, updated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(worker) DO UPDATE SET owns=excluded.owns, channels=excluded.channels, updated_at=excluded.updated_at
`);
const stmtCapList   = db.prepare("SELECT worker, owns, channels, updated_at FROM capabilities ORDER BY worker");
const stmtCapDel    = db.prepare("DELETE FROM capabilities WHERE worker = ?");

// ── Helpers ───────────────────────────────────────────────────────────────────

// Reject channel names containing control characters or newlines (prevents log injection).
function isValidChannelName(ch) {
  return /^[^\x00-\x1f\x7f]+$/.test(ch);
}

// Expand ${VAR_NAME} placeholders in watchdog args using process.env, so the workers
// config can use ${REPO_ROOT}/backend instead of hardcoded absolute paths.
function expandArgs(args) {
  return args.map(a => String(a).replace(/\$\{([^}]+)\}/g, (_, k) => process.env[k] ?? `\${${k}}`));
}

// Shared watchdog spawn logic. Throws on failure; callers handle errors.
// model: optional model ID to override CLAUDE_MODEL env var for this session.
// Precedence: explicit model arg > "model" field on the worker's config entry > CLAUDE_MODEL env.
function spawnWatchdogProc(def, { model } = {}) {
  model = model || def.model;
  assertSafeWorkerName(def.name);
  // spawn() reports a missing or non-executable binary asynchronously as an 'error' event;
  // check up front so the caller gets a clear tool error instead of a crash.
  try { accessSync(WATCHDOG_BIN, fsConstants.X_OK); }
  catch { throw new Error(`WATCHDOG_BIN is not an executable file: ${WATCHDOG_BIN}`); }
  mkdirSync(WORKERS_LOG_DIR, { recursive: true });
  const outFd = openSync(`${WORKERS_LOG_DIR}/${def.name}.out.log`, "a");
  const errFd = openSync(`${WORKERS_LOG_DIR}/${def.name}.err.log`, "a");
  // Give the watchdog the credentials it needs to reach an authenticated broker
  // (/inbox polling + heartbeat writes). Existing env values win if already set.
  const env = {
    ...process.env,
    BROKER_URL: process.env.BROKER_URL || `http://localhost:${PORT}`,
    BROKER_SECRET: process.env.BROKER_SECRET || SHARED_SECRET,
    ...(model ? { CLAUDE_MODEL: model } : {}),
  };
  let proc;
  try {
    proc = spawn(WATCHDOG_BIN, expandArgs(def.args || []), { stdio: ["ignore", outFd, errFd], detached: true, env });
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
  proc.unref();
  // Belt and braces: an unhandled 'error' event on a ChildProcess is an uncaught exception.
  proc.on("error", (e) => {
    console.error(`[claude-broker] watchdog "${def.name}" spawn error: ${e.message}`);
    watchdogProcs.delete(def.name);
  });
  proc.on("exit", (code) => {
    console.log(`[claude-broker] watchdog "${def.name}" exited (code ${code ?? "?"})`);
    watchdogProcs.delete(def.name);
  });
  watchdogProcs.set(def.name, { pid: proc.pid, proc, startedAt: Date.now() });
  console.log(`[claude-broker] started watchdog "${def.name}" (pid ${proc.pid}) → logs: ${WORKERS_LOG_DIR}/${def.name}.{out,err}.log`);
  return proc;
}

// ── tmux helpers (used only when WORKERS_TMUX_SESSION is set) ────────────────

function tmuxWindowExists(winName) {
  try {
    const r = spawnSync(TMUX_BIN, ["list-windows", "-t", WORKERS_TMUX_SESSION, "-F", "#{window_name}"], { encoding: "utf8" });
    return (r.stdout || "").split("\n").some(l => l.trim() === winName);
  } catch { return false; }
}

function tmuxPanePid(winName) {
  try {
    const r = spawnSync(TMUX_BIN, ["display-message", "-t", `${WORKERS_TMUX_SESSION}:${winName}`, "-p", "#{pane_pid}"], { encoding: "utf8" });
    const pid = parseInt((r.stdout || "").trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch { return null; }
}

function spawnWatchdogTmux(def, { model } = {}) {
  model = model || def.model;
  assertSafeWorkerName(def.name);
  // Ensure target session exists
  const hasSession = spawnSync(TMUX_BIN, ["has-session", "-t", WORKERS_TMUX_SESSION], { encoding: "utf8" });
  if (hasSession.status !== 0) {
    spawnSync(TMUX_BIN, ["new-session", "-d", "-s", WORKERS_TMUX_SESSION], { encoding: "utf8" });
  }
  const envParts = [
    ["BROKER_SECRET", SHARED_SECRET],
    ["BROKER_URL",    process.env.BROKER_URL],
    ["CLAUDE_BIN",    process.env.CLAUDE_BIN],
    ["CLAUDE_MODEL",  model || process.env.CLAUDE_MODEL],
  ].filter(([, v]) => v);
  const shellQ = v => "'" + String(v).replace(/'/g, "'\\''") + "'";
  const envPrefix = envParts.map(([k, v]) => `${k}=${shellQ(v)}`).join(" ") + (envParts.length ? " " : "");
  const args = expandArgs(def.args || []);
  // Single-quote every arg (and the binary path) so shell metacharacters in worker
  // config / register_worker input can never break out of the tmux new-window command.
  const shellCmd = `${envPrefix}${shellQ(WATCHDOG_BIN)} ${args.map(shellQ).join(" ")}`;
  const r = spawnSync(TMUX_BIN, ["new-window", "-t", WORKERS_TMUX_SESSION, "-n", def.name, shellCmd], { encoding: "utf8" });
  if (r.status !== 0) throw new Error((r.stderr || "").trim() || "tmux new-window failed");
  const pid = tmuxPanePid(def.name);
  watchdogProcs.set(def.name, { pid, startedAt: Date.now(), tmux: true });
  console.log(`[claude-broker] started watchdog "${def.name}" in tmux ${WORKERS_TMUX_SESSION}:${def.name} (pid ${pid})`);
  return { pid };
}

// ── Worker lifecycle (shared by MCP tools and REST routes) ───────────────────
// Both surfaces must agree on tmux vs subprocess mode — the dashboard buttons call
// the REST routes, so a REST-only subprocess spawn in tmux mode would duplicate a
// worker already running in a tmux window and never be stoppable.

class WorkerError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Returns { pid, startedAt, tmux } if running, else null. Reconciles the in-memory map in tmux mode.
function workerRunningInfo(name) {
  if (WORKERS_TMUX_SESSION) {
    if (!tmuxWindowExists(name)) { watchdogProcs.delete(name); return null; }
    const entry = watchdogProcs.get(name);
    return { pid: tmuxPanePid(name), startedAt: entry?.startedAt ?? null, tmux: true };
  }
  const entry = watchdogProcs.get(name);
  return entry ? { pid: entry.pid, startedAt: entry.startedAt, tmux: false } : null;
}

// Returns { pid, tmux, already } — already=true means it was running and nothing was spawned.
function startWorker(name, { model } = {}) {
  if (!WATCHDOG_BIN) throw new WorkerError(503, "WATCHDOG_BIN not configured on broker — cannot start workers.");
  const def = loadWorkerDefs().find(w => w.name === name);
  if (!def) throw new WorkerError(404, `Worker "${name}" not found in config. Use list_workers to see available workers.`);
  const running = workerRunningInfo(name);
  if (running) return { pid: running.pid, tmux: running.tmux, already: true };
  try {
    if (WORKERS_TMUX_SESSION) {
      const { pid } = spawnWatchdogTmux(def, { model });
      return { pid, tmux: true, already: false };
    }
    const proc = spawnWatchdogProc(def, { model });
    return { pid: proc.pid, tmux: false, already: false };
  } catch (e) {
    throw new WorkerError(500, `Failed to start "${name}": ${e.message}`);
  }
}

// Returns { pid, tmux }. Throws WorkerError(404) if not running, (500) if the kill failed.
function stopWorker(name) {
  if (WORKERS_TMUX_SESSION) {
    if (!tmuxWindowExists(name)) {
      watchdogProcs.delete(name);
      throw new WorkerError(404, `Worker "${name}" is not running (no tmux window found in ${WORKERS_TMUX_SESSION}).`);
    }
    const pid = tmuxPanePid(name);
    const r = spawnSync(TMUX_BIN, ["kill-window", "-t", `${WORKERS_TMUX_SESSION}:${name}`], { encoding: "utf8" });
    watchdogProcs.delete(name);
    if (r.status !== 0) throw new WorkerError(500, `tmux kill-window failed: ${(r.stderr || "").trim() || "unknown error"}`);
    console.log(`[claude-broker] stopped watchdog "${name}" via tmux kill-window`);
    return { pid, tmux: true };
  }
  const entry = watchdogProcs.get(name);
  if (!entry) throw new WorkerError(404, `Worker "${name}" is not running.`);
  watchdogProcs.delete(name);
  try {
    process.kill(-entry.pid, "SIGTERM"); // kill entire process group (watchdog + in-flight claude)
  } catch (e) {
    throw new WorkerError(500, `kill failed: ${e.message}`);
  }
  console.log(`[claude-broker] stopped watchdog "${name}" (pid ${entry.pid})`);
  return { pid: entry.pid, tmux: false };
}

// ── AJV schema validation ─────────────────────────────────────────────────────

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validatorCache = new Map();

function getValidator(channel) {
  const row = stmtSchemaGet.get(channel);
  if (!row) { validatorCache.delete(channel); return null; }
  const cached = validatorCache.get(channel);
  if (cached && cached.updated_at === row.updated_at) return { validate: cached.validate, strict: row.strict };
  let validate;
  try { validate = ajv.compile(JSON.parse(row.schema)); }
  catch (e) { console.error(`[claude-broker] schema compile error '${channel}': ${e.message}`); return null; }
  validatorCache.set(channel, { validate, updated_at: row.updated_at });
  return { validate, strict: row.strict };
}

function validateContent(channel, content) {
  const v = getValidator(channel);
  if (!v) return { ok: true };
  let parsed;
  try { parsed = JSON.parse(content); }
  catch (e) {
    // A channel with a schema expects JSON envelopes — plain text can never satisfy it.
    // strict → reject, warn-only → warn + accept (same contract as a schema mismatch).
    return { ok: false, strict: !!v.strict, errors: `content is not valid JSON (${e.message})` };
  }
  if (v.validate(parsed)) return { ok: true };
  const errors = (v.validate.errors || []).map(e => `${e.instancePath || "/"} ${e.message}`).join("; ");
  return { ok: false, strict: !!v.strict, errors };
}

// ── Message bus ───────────────────────────────────────────────────────────────

const messageBus = new EventEmitter();
messageBus.setMaxListeners(0);

// Compact view of a message for projection="summary": envelope headline fields only.
// Lets an orchestrator scan 30 results in ~3 KB instead of ~150 KB, then open the ones it needs.
function summarizeContent(content) {
  const bytes = Buffer.byteLength(content, "utf8");
  try {
    const p = JSON.parse(content);
    if (!p || typeof p !== "object") throw 0;
    const out = { bytes };
    for (const k of ["type", "task_id", "from", "to", "subject", "summary"]) if (p[k] != null) out[k] = p[k];
    if (Array.isArray(p.depends_on) && p.depends_on.length) out.depends_on = p.depends_on;
    if (Array.isArray(p.affected_files)) out.affected_files_count = p.affected_files.length;
    return out;
  } catch {
    return { bytes, text: content.length > 120 ? content.slice(0, 120) + "…" : content };
  }
}

function formatRows(rows, channel, sinceId, projection) {
  if (rows.length === 0) return { content: [{ type: "text", text: `No new messages on '${channel}' (since_id=${sinceId}).` }] };
  const lines = rows.map(r => `[#${r.id}] ${new Date(r.created_at).toISOString()} <${r.sender}>: ${projection === "summary" ? JSON.stringify(summarizeContent(r.content)) : r.content}`);
  lines.push(`\n(next since_id: ${rows[rows.length - 1].id})`);
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

function fetchFiltered(channel, sinceId, lim, filterSender, filterType) {
  if (filterSender && filterSender.includes(",")) {
    const senders = filterSender.split(",").map(s => s.trim()).filter(Boolean);
    const stmt = getMultiSenderStmt(senders.length, !!filterType);
    const params = [channel, sinceId, ...senders, ...(filterType ? [filterType] : []), lim];
    return stmt.all(...params);
  }
  if (filterSender || filterType) {
    return stmtSelectFilter.all(
      channel, sinceId,
      filterSender ?? null, filterSender ?? null,
      filterType   ?? null, filterType   ?? null,
      lim
    );
  }
  return stmtSelect.all(channel, sinceId, lim);
}

function fetchFeedRows(channels, signalOnly, limit) {
  if (channels.length === 0) return [];
  return getFeedStmt(channels.length, signalOnly).all(...channels, limit);
}

// ── Background auto-pruning ───────────────────────────────────────────────────

function runAutoPrune() {
  const now = Date.now();
  const exemptJson = JSON.stringify(PRUNE_EXEMPT);
  const signalJson = JSON.stringify(PRUNE_SIGNAL_TYPES);
  const r1 = stmtPruneAllOld.run(exemptJson, now - PRUNE_MAX_AGE_MS, signalJson);
  const r2 = stmtPruneSignalOld.run(exemptJson, now - PRUNE_SIGNAL_MAX_AGE_MS, signalJson);
  if (r1.changes > 0 || r2.changes > 0) {
    console.log(`[claude-broker] auto-pruned ${r1.changes} chatter msgs older than ${PRUNE_MAX_AGE_MS / 3600000}h and ${r2.changes} signal msgs older than ${Math.round(PRUNE_SIGNAL_MAX_AGE_MS / 86400000)}d (exempt: ${PRUNE_EXEMPT.join(", ") || "none"})`);
  }
}

// Evict a telemetry sender's older transient-state rows after a new row lands.
function compactTelemetry(channel, sender, newId) {
  if (!channel.endsWith("-telemetry") || HEARTBEAT_TRANSIENT_STATES.length === 0) return 0;
  return stmtDeleteTransientHeartbeats.run(channel, sender, newId, JSON.stringify(HEARTBEAT_TRANSIENT_STATES)).changes;
}
setInterval(runAutoPrune, PRUNE_INTERVAL_MS).unref();

// ── MCP server builder ────────────────────────────────────────────────────────

function buildServer() {
  const server = new McpServer({ name: "claude-broker", version: VERSION });

  // Count calls / errors / latency per tool without touching each handler.
  const registerToolRaw = server.registerTool.bind(server);
  server.registerTool = (name, cfg, handler) => registerToolRaw(name, cfg, async (...args) => {
    const t0 = Date.now();
    let isError = false;
    try {
      const out = await handler(...args);
      isError = !!out?.isError;
      return out;
    } catch (e) { isError = true; throw e; }
    finally { metricTool(name, Date.now() - t0, isError); }
  });

  // ── send_message ────────────────────────────────────────────────────────────
  server.registerTool("send_message", {
    title: "Send a message",
    description: "Post a message to a named channel. Other Claude Code sessions can read it via read_messages or wait_for_messages.",
    inputSchema: {
      channel: z.string().min(1).describe("Channel name."),
      sender:  z.string().min(1).describe("Sender identifier."),
      content: z.string().min(1).describe("Message body — plain text or JSON-as-string."),
    },
  }, async ({ channel, sender, content }) => {
    if (!isValidChannelName(channel))
      return { content: [{ type: "text", text: `invalid channel name '${channel}': control characters are not allowed.` }], isError: true };
    const check = validateContent(channel, content);
    if (!check.ok && check.strict) {
      return { content: [{ type: "text", text: `schema validation failed on '${channel}': ${check.errors}. Call get_channel_schema('${channel}') to see required fields.` }], isError: true };
    }
    const now = Date.now();
    const r = stmtInsert.run(channel, sender, content, now);
    compactTelemetry(channel, sender, r.lastInsertRowid);
    messageBus.emit(`msg:${channel}`, { id: r.lastInsertRowid, sender, content });
    const warn = (!check.ok && !check.strict) ? `  [WARN schema mismatch: ${check.errors}]` : "";
    return { content: [{ type: "text", text: `Sent #${r.lastInsertRowid} to '${channel}' as '${sender}' at ${new Date(now).toISOString()}.${warn}` }] };
  });

  // ── read_messages ───────────────────────────────────────────────────────────
  server.registerTool("read_messages", {
    title: "Read messages",
    description: "Read messages from a channel newer than since_id. Supports optional sender and type filters.",
    inputSchema: {
      channel:       z.string().min(1),
      since_id:      z.number().int().nonnegative().optional().describe("Only return msgs with id > since_id. Omit for all."),
      limit:         z.number().int().positive().max(500).optional().describe("Max messages (default 100)."),
      filter_sender: z.string().optional().describe("Only return messages from this sender."),
      filter_type:   z.string().optional().describe("Only return messages where JSON content has type === this value."),
      projection:    z.enum(["full", "summary"]).optional().describe("'summary' returns only headline envelope fields (type, task_id, from, to, subject, summary, bytes) per message — scan first, then read_messages(full) or delete/act on the ids you need. Default 'full'."),
    },
  }, async ({ channel, since_id, limit, filter_sender, filter_type, projection }) => {
    const rows = fetchFiltered(channel, since_id ?? 0, limit ?? 100, filter_sender, filter_type);
    return formatRows(rows, channel, since_id ?? 0, projection);
  });

  // ── wait_for_messages ───────────────────────────────────────────────────────
  server.registerTool("wait_for_messages", {
    title: "Wait for new messages",
    description: "Long-polls until a matching message arrives or timeout_ms elapses. Supports filter_sender and filter_type — waits until a message matching the filters arrives, skipping non-matching ones. Default timeout 60s, max 300s.",
    inputSchema: {
      channel:       z.string().min(1),
      since_id:      z.number().int().nonnegative().optional(),
      timeout_ms:    z.number().int().positive().max(300000).optional().describe("Max wait in ms. Default 60000. Max 300000."),
      limit:         z.number().int().positive().max(500).optional(),
      filter_sender: z.string().optional().describe("Only wake/return for messages from this sender."),
      filter_type:   z.string().optional().describe("Only wake/return for messages where JSON content.type === this value."),
    },
  }, async ({ channel, since_id, timeout_ms, limit, filter_sender, filter_type }, extra) => {
    const sinceId = since_id ?? 0;
    const lim     = limit ?? 100;
    const timeout = Math.min(timeout_ms ?? 60000, 300000);
    const event   = `msg:${channel}`;
    // Aborted by the SDK when the client disconnects (transport.close() on res 'close'
    // in the /mcp handler) — without it, the listener + timer below would linger for
    // the full timeout (up to 300s) after the caller is gone.
    const signal  = extra?.signal;

    return new Promise((resolve) => {
      let timer = null;
      let resolved = false;

      let cleanup = function () {
        if (timer) { clearTimeout(timer); timer = null; }
        messageBus.off(event, onMessage);
        signal?.removeEventListener("abort", onAbort);
      };

      function settle(result) {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve(result);
      }

      function onMessage() {
        const rows = fetchFiltered(channel, sinceId, lim, filter_sender, filter_type);
        if (rows.length > 0) { metrics.long_polls_woken++; settle(formatRows(rows, channel, sinceId)); }
        // Non-matching message — keep listener registered, timer keeps running
      }

      function onAbort() {
        // Client gone — response is never delivered; settle only to free listener + timer.
        settle({ content: [{ type: "text", text: `Wait on '${channel}' aborted — client disconnected.` }] });
      }

      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener("abort", onAbort);

      // Register listener BEFORE initial DB check to close the race window:
      // a send_message that arrives between check and registration would be missed.
      messageBus.on(event, onMessage);

      // Check for messages already present (including any that arrived before registration)
      const immediate = fetchFiltered(channel, sinceId, lim, filter_sender, filter_type);
      if (immediate.length > 0) { settle(formatRows(immediate, channel, sinceId)); return; }

      metrics.long_polls_total++; metrics.long_polls_active++;
      const dec = () => { metrics.long_polls_active--; };
      const origCleanup = cleanup;
      cleanup = () => { origCleanup(); dec(); };

      timer = setTimeout(() => {
        settle({ content: [{ type: "text", text: `No new messages on '${channel}' within ${timeout}ms (since_id=${sinceId}).` }] });
      }, timeout);
    });
  });

  // ── delete_message ──────────────────────────────────────────────────────────
  server.registerTool("delete_message", {
    title: "Delete a single message",
    description: "Delete one message by id. Requires the channel for safety — prevents deleting a message from the wrong channel by accident.",
    inputSchema: {
      channel: z.string().min(1).describe("Channel the message belongs to."),
      id:      z.number().int().positive().describe("Message id (from the #N prefix in read_messages output)."),
    },
  }, async ({ channel, id }) => {
    const r = stmtDeleteOne.run(id, channel);
    if (r.changes === 0) return { content: [{ type: "text", text: `Message #${id} not found on '${channel}'.` }], isError: true };
    return { content: [{ type: "text", text: `Deleted message #${id} from '${channel}'.` }] };
  });

  // ── post_gated_message ──────────────────────────────────────────────────────
  server.registerTool("post_gated_message", {
    title: "Post a message gated on task results",
    description: "Post a message only after all listed task_ids have a type:result message on the watch_channel. Blocks until all dependencies are satisfied or timeout_ms elapses. Use this to enforce depends_on at the broker level rather than relying on workers to self-block.",
    inputSchema: {
      channel:       z.string().min(1).describe("Channel to post to when all deps are satisfied."),
      sender:        z.string().min(1),
      content:       z.string().min(1).describe("Message body to post when unblocked."),
      depends_on:    z.array(z.string().min(1)).min(1).describe("Array of task_ids to wait for (the envelope's 'task_id:worker' form is accepted; the worker suffix is ignored). Each must have a type:result message on watch_channel."),
      watch_channel: z.string().optional().describe("Channel to watch for result messages. Default: <ns>-status derived from a namespaced channel (e.g. team-backend → team-status), else 'status'."),
      timeout_ms:    z.number().int().positive().max(300000).optional().describe("Max wait in ms. Default 60000. Max 300000."),
    },
  }, async ({ channel, sender, content, depends_on, watch_channel, timeout_ms }, extra) => {
    const watchChan = watch_channel ?? (channel.includes("-") ? `${nsOf(channel)}-status` : "status");
    // Envelope convention writes depends_on as "task_id:worker"; results are keyed by task_id alone.
    depends_on = depends_on.map(d => (d.includes(":") ? d.slice(0, d.indexOf(":")) : d));
    const timeout   = Math.min(timeout_ms ?? 60000, 300000);
    const event     = `msg:${watchChan}`;
    // Same disconnect-cleanup contract as wait_for_messages.
    const signal    = extra?.signal;

    function allSatisfied() {
      return depends_on.every(taskId => stmtCheckResult.get(watchChan, taskId).n > 0);
    }

    function pendingList() {
      return depends_on.filter(taskId => stmtCheckResult.get(watchChan, taskId).n === 0);
    }

    if (allSatisfied()) {
      const check = validateContent(channel, content);
      if (!check.ok && check.strict) {
        return { content: [{ type: "text", text: `schema validation failed on '${channel}': ${check.errors}` }], isError: true };
      }
      const now = Date.now();
      const r = stmtInsert.run(channel, sender, content, now);
      messageBus.emit(`msg:${channel}`, { id: r.lastInsertRowid, sender, content });
      return { content: [{ type: "text", text: `All deps satisfied immediately. Sent #${r.lastInsertRowid} to '${channel}'.` }] };
    }

    return new Promise((resolve) => {
      let timer = null;
      let settled = false;

      function cleanup() {
        if (timer) { clearTimeout(timer); timer = null; }
        messageBus.off(event, onResult);
        signal?.removeEventListener("abort", onAbort);
      }

      function settle(result) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      }

      function onAbort() {
        // Client gone — do NOT post the gated message on a dead request; just free resources.
        settle({ content: [{ type: "text", text: `Gated post to '${channel}' aborted — client disconnected.` }], isError: true });
      }

      function tryPost() {
        const check = validateContent(channel, content);
        if (!check.ok && check.strict) {
          settle({ content: [{ type: "text", text: `Deps satisfied but schema validation failed: ${check.errors}` }], isError: true });
          return;
        }
        const now = Date.now();
        const r = stmtInsert.run(channel, sender, content, now);
        messageBus.emit(`msg:${channel}`, { id: r.lastInsertRowid, sender, content });
        settle({ content: [{ type: "text", text: `Deps satisfied. Sent #${r.lastInsertRowid} to '${channel}'.` }] });
      }

      function onResult() {
        if (!allSatisfied()) return;
        tryPost();
      }

      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener("abort", onAbort);

      // Register listener BEFORE re-check so no result event is missed between
      // the initial allSatisfied() check above and this listener registration.
      messageBus.on(event, onResult);

      // Re-check now that listener is wired (mirrors wait_for_messages pattern).
      if (allSatisfied()) { tryPost(); return; }

      timer = setTimeout(() => {
        settle({ content: [{ type: "text", text: `Timed out after ${timeout}ms waiting for deps: ${pendingList().join(", ")}` }], isError: true });
      }, timeout);
    });
  });

  // ── check_result ────────────────────────────────────────────────────────────
  server.registerTool("check_result", {
    title: "Check if a task result exists",
    description: "Returns whether a type:result message with the given task_id exists on a channel. Use this for idempotency checks — a single indexed SQL query vs. transferring the full channel history with read_messages(since_id=0).",
    inputSchema: {
      channel: z.string().min(1).describe("Channel to check (typically status)."),
      task_id: z.string().min(1).describe("The task_id to look for."),
    },
  }, async ({ channel, task_id }) => {
    const row = stmtCheckResult.get(channel, task_id);
    return { content: [{ type: "text", text: JSON.stringify({ found: row.n > 0, task_id, channel, summary: row.summary ?? null }) }] };
  });

  // ── check_results_batch ─────────────────────────────────────────────────────
  server.registerTool("check_results_batch", {
    title: "Batch-check task results",
    description: "Check multiple task_ids for type:result messages in one call. Returns results (task_id → found boolean) and summaries (task_id → latest result summary or null). Use at turn-start when multiple tasks may be queued — replaces N sequential check_result calls with one round-trip.",
    inputSchema: {
      channel:  z.string().min(1).describe("Channel to check (typically status)."),
      task_ids: z.array(z.string().min(1)).min(1).max(50).describe("Task IDs to check."),
    },
  }, async ({ channel, task_ids }) => {
    const foundRows = getBatchResultsStmt(task_ids.length).all(channel, ...task_ids);
    const foundSet  = new Set(foundRows.map(r => r.task_id));
    const result    = {};
    const summaries = {};
    for (const task_id of task_ids) {
      result[task_id] = foundSet.has(task_id);
      // Latest summary so batch callers can tell PASS from FAIL without a second round-trip.
      summaries[task_id] = result[task_id] ? (stmtCheckResult.get(channel, task_id).summary ?? null) : null;
    }
    return { content: [{ type: "text", text: JSON.stringify({ channel, results: result, summaries }) }] };
  });

  // ── has_messages ────────────────────────────────────────────────────────────
  server.registerTool("has_messages", {
    title: "Check if a channel has messages (no content transfer)",
    description: "Returns {pending, max_id, channel} — lightweight pre-check before read_messages. Use to gate control reads: skip entirely if pending=false. Zero content transferred.",
    inputSchema: {
      channel:  z.string().min(1).describe("Channel to check."),
      since_id: z.number().int().min(0).default(0).describe("Only count messages with id > since_id."),
    },
  }, async ({ channel, since_id }) => {
    const row = stmtHasMessages.get(channel, since_id ?? 0);
    return { content: [{ type: "text", text: JSON.stringify({ pending: row.n > 0, max_id: row.max_id, channel }) }] };
  });

  // ── read_last ────────────────────────────────────────────────────────────────
  server.registerTool("read_last", {
    title: "Read the last N messages from a channel",
    description: "Returns the N most recent messages in chronological order (oldest-first). Use for compaction recovery instead of read_messages(since_id=0) — transfers only the tail of history, not the full archive. Default n=20, max 100.",
    inputSchema: {
      channel: z.string().min(1).describe("Channel to read."),
      n:       z.number().int().min(1).max(100).default(20).describe("Number of most-recent messages to return."),
      projection: z.enum(["full", "summary"]).optional().describe("'summary' returns headline envelope fields only. Default 'full'."),
    },
  }, async ({ channel, n, projection }) => {
    const rows = stmtReadLast.all(channel, n ?? 20);
    rows.reverse();
    if (!rows.length) return { content: [{ type: "text", text: "No messages." }] };
    const text = rows.map(r => `[${r.id}] ${r.sender}: ${projection === "summary" ? JSON.stringify(summarizeContent(r.content)) : r.content}`).join("\n");
    return { content: [{ type: "text", text: text }] };
  });

  // ── list_channels ───────────────────────────────────────────────────────────
  server.registerTool("list_channels", {
    title: "List channels",
    description: "List all channels with message counts, latest id, and last activity.",
    inputSchema: {},
  }, async () => {
    const rows = stmtChans.all();
    if (rows.length === 0) return { content: [{ type: "text", text: "(no channels yet)" }] };
    const text = rows.map(r => `${r.channel}\t${r.n} msgs\tlast_id=${r.last_id}\tlast_activity=${new Date(r.last_ts).toISOString()}`).join("\n");
    return { content: [{ type: "text", text }] };
  });

  // ── purge_channel ───────────────────────────────────────────────────────────
  server.registerTool("purge_channel", {
    title: "Purge channel",
    description: "Delete messages from a channel. Without older_than_ms, deletes all messages. With older_than_ms, deletes only messages older than that many milliseconds. Channels in PRUNE_EXEMPT are refused unless force=true.",
    inputSchema: {
      channel:       z.string().min(1),
      older_than_ms: z.number().int().positive().optional().describe("If set, only delete messages older than this many ms. Omit to delete all."),
      force:         z.boolean().optional().describe("Required to purge a channel listed in PRUNE_EXEMPT (e.g. *-backlog). Default false."),
    },
  }, async ({ channel, older_than_ms, force }) => {
    if (PRUNE_EXEMPT.includes(channel) && !force) {
      return { content: [{ type: "text", text: `Refused: '${channel}' is in PRUNE_EXEMPT. Pass force=true to purge it anyway.` }], isError: true };
    }
    let r;
    if (older_than_ms != null) {
      r = stmtPruneOlder.run(channel, Date.now() - older_than_ms);
      return { content: [{ type: "text", text: `Pruned ${r.changes} messages older than ${older_than_ms}ms from '${channel}'.` }] };
    }
    r = stmtPurge.run(channel);
    return { content: [{ type: "text", text: `Purged ${r.changes} messages from '${channel}'.` }] };
  });

  // ── purge_channels_by_prefix ─────────────────────────────────────────────────
  server.registerTool("purge_channels_by_prefix", {
    title: "Purge channels by prefix",
    description: "Delete messages from all channels matching a prefix. Without older_than_ms, deletes all messages. With older_than_ms, deletes only messages older than that many milliseconds. Skips channels in PRUNE_EXEMPT.",
    inputSchema: {
      prefix:        z.string().min(1).describe("Delete messages from all channels whose name starts with this prefix."),
      older_than_ms: z.number().int().positive().optional().describe("If set, only delete messages older than this many ms. Omit to delete all."),
    },
  }, async ({ prefix, older_than_ms }) => {
    const channels = stmtChansByPrefix.all(prefix + "%");
    const purged = [];
    const skipped_exempt = [];
    let total_deleted = 0;

    for (const row of channels) {
      if (PRUNE_EXEMPT.includes(row.channel)) {
        skipped_exempt.push(row.channel);
        continue;
      }

      let r;
      if (older_than_ms != null) {
        r = stmtPruneOlder.run(row.channel, Date.now() - older_than_ms);
      } else {
        r = stmtPurge.run(row.channel);
      }
      purged.push({ channel: row.channel, deleted_count: r.changes });
      total_deleted += r.changes;
    }

    const result = {
      purged,
      skipped_exempt,
      total_deleted,
    };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  // ── register_capability ─────────────────────────────────────────────────────
  server.registerTool("register_capability", {
    title: "Register worker capability",
    description: "Declare what a worker owns and which channels it uses. Workers should call this at startup so the orchestrator can route by capability instead of hardcoded role names.",
    inputSchema: {
      worker:   z.string().min(1).describe("Worker identifier, e.g. 'backend', 'frontend'."),
      owns:     z.array(z.string()).describe("List of domains/responsibilities this worker owns."),
      channels: z.array(z.string()).describe("List of channels this worker reads/writes."),
    },
  }, async ({ worker, owns, channels }) => {
    const now = Date.now();
    stmtCapUpsert.run(worker, JSON.stringify(owns), JSON.stringify(channels), now);
    return { content: [{ type: "text", text: `Registered capabilities for '${worker}' at ${new Date(now).toISOString()}.` }] };
  });

  // ── list_capabilities ───────────────────────────────────────────────────────
  server.registerTool("list_capabilities", {
    title: "List worker capabilities",
    description: "Show the capability registry — what each worker owns and which channels it uses.",
    inputSchema: {},
  }, async () => {
    const rows = stmtCapList.all();
    if (rows.length === 0) return { content: [{ type: "text", text: "(no capabilities registered yet)" }] };
    const lines = rows.map(r =>
      `${r.worker}\towns=${r.owns}\tchannels=${r.channels}\tupdated=${new Date(r.updated_at).toISOString()}`
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  });

  // ── deregister_capability ───────────────────────────────────────────────────
  server.registerTool("deregister_capability", {
    title: "Deregister worker capability",
    description: "Remove a worker from the capability registry.",
    inputSchema: {
      worker: z.string().min(1),
    },
  }, async ({ worker }) => {
    const r = stmtCapDel.run(worker);
    return { content: [{ type: "text", text: r.changes ? `Deregistered '${worker}'.` : `No capability entry found for '${worker}'.` }] };
  });

  // ── get_latest_per_sender ───────────────────────────────────────────────────
  server.registerTool("get_latest_per_sender", {
    title: "Get latest message per distinct sender",
    description: "Return the most recent message per sender on a channel. Designed for heartbeat/telemetry channels — one snapshot per worker without paginating history.",
    inputSchema: {
      channel: z.string().min(1),
    },
  }, async ({ channel }) => {
    const rows = stmtLatestPerSender.all(channel);
    if (rows.length === 0) return { content: [{ type: "text", text: `No messages on '${channel}'.` }] };
    const lines = rows.map(r => `[#${r.id}] ${new Date(r.created_at).toISOString()} <${r.sender}>: ${r.content}`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  });

  // ── get_latest_heartbeats ────────────────────────────────────────────────────
  server.registerTool("get_latest_heartbeats", {
    title: "Get latest heartbeat per worker (structured)",
    description: "Convenience wrapper around get_latest_per_sender that parses heartbeat JSON and returns structured worker state. Also computes a summary of rotating and stale workers. Use instead of get_latest_per_sender when you need parsed fields rather than raw text.",
    inputSchema: {
      channel: z.string().min(1).optional().describe("Telemetry channel to query. Default: 'telemetry'."),
    },
  }, async ({ channel = TELEMETRY_CHANNEL }) => {
    const rows = stmtLatestPerSender.all(channel);
    const nowMs = Date.now();
    const STALE_MS = WORKER_OFFLINE_THRESHOLD_S * 1000; // same threshold the dashboard uses

    const workers = rows.map(row => {
      let hb = {};
      try { hb = JSON.parse(row.content); } catch {}
      return {
        sender:               row.sender,
        ts:                   hb.ts ?? new Date(row.created_at).toISOString(),
        state:                hb.activity?.state ?? hb.state ?? "unknown",
        tier_threshold_pct:   hb.context?.tier_threshold_pct ?? null,
        rotation_recommended: hb.context?.rotation_recommended ?? false,
        cost_usd:             hb.cost_since_start?.estimated_usd ?? null,
        session_id:           hb.session_id ?? null,
      };
    });

    const rotating   = workers.filter(w => w.rotation_recommended).map(w => w.sender);
    const stale_5min = rows
      .filter(r => nowMs - r.created_at > STALE_MS)
      .map(r => r.sender);

    const result = {
      channel,
      workers,
      summary: { total_workers: workers.length, rotating, stale_5min },
    };
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });

  // ── register_channel_schema ─────────────────────────────────────────────────
  server.registerTool("register_channel_schema", {
    title: "Register or replace a channel schema",
    description: "Bind a JSON Schema (draft-07) to a channel. Messages are validated on send_message.",
    inputSchema: {
      channel: z.string().min(1),
      schema:  z.string().min(2).describe("JSON Schema as a JSON-encoded string."),
      strict:  z.boolean().optional().describe("If true, invalid messages are rejected. Omit to keep the channel's current mode (warn-only for a new channel) — re-registering a schema never silently downgrades a strict channel."),
      version: z.string().optional().describe("Optional schema version string, e.g. '1.0'. Omit to keep the current version."),
    },
  }, async ({ channel, schema, strict, version }) => {
    let parsed;
    try { parsed = JSON.parse(schema); }
    catch (e) { return { content: [{ type: "text", text: `schema is not valid JSON: ${e.message}` }], isError: true }; }
    try { ajv.compile(parsed); }
    catch (e) { return { content: [{ type: "text", text: `schema does not compile as JSON Schema: ${e.message}` }], isError: true }; }
    const now = Date.now();
    const existing  = stmtSchemaGet.get(channel);
    const strictVal = strict === undefined ? (existing ? existing.strict : 0) : (strict ? 1 : 0);
    const versionVal = version ?? existing?.version ?? null;
    stmtSchemaUpsert.run(channel, schema, strictVal, now, versionVal);
    validatorCache.delete(channel);
    const kept = strict === undefined && existing ? " (strict mode preserved)" : "";
    return { content: [{ type: "text", text: `Registered schema for '${channel}' (strict=${strictVal ? "on" : "off"}${versionVal ? `, version=${versionVal}` : ""})${kept} at ${new Date(now).toISOString()}.` }] };
  });

  // ── get_channel_schema ──────────────────────────────────────────────────────
  server.registerTool("get_channel_schema", {
    title: "Get a channel's schema",
    description: "Return the JSON Schema bound to a channel, or indicate it is free-form.",
    inputSchema: {
      channel: z.string().min(1),
    },
  }, async ({ channel }) => {
    const row = stmtSchemaGet.get(channel);
    if (!row) return { content: [{ type: "text", text: `No schema registered for '${channel}' (free-form).` }] };
    const versionLine = row.version != null ? `\nVersion: ${row.version}` : "";
    return { content: [{ type: "text", text: `Channel: ${row.channel}\nStrict: ${row.strict ? "on" : "off (warn-only)"}${versionLine}\nUpdated: ${new Date(row.updated_at).toISOString()}\n\n${row.schema}` }] };
  });

  // ── clear_channel_schema ────────────────────────────────────────────────────
  server.registerTool("clear_channel_schema", {
    title: "Clear a channel's schema",
    description: "Remove the schema binding from a channel. The channel reverts to free-form.",
    inputSchema: {
      channel: z.string().min(1),
    },
  }, async ({ channel }) => {
    stmtSchemaDel.run(channel);
    validatorCache.delete(channel);
    return { content: [{ type: "text", text: `Cleared schema for '${channel}'.` }] };
  });

  // ── list_channel_schemas ────────────────────────────────────────────────────
  server.registerTool("list_channel_schemas", {
    title: "List channel schemas",
    description: "Show all channels with a schema bound, including strict-mode status. Pass prefix to filter by channel name prefix (e.g. 'cb-' returns only cb-* entries). Omit prefix to return all.",
    inputSchema: {
      prefix: z.string().optional().describe("Only return schemas for channels starting with this prefix, e.g. 'cb-'. Omit for all."),
    },
  }, async ({ prefix } = {}) => {
    const rows = prefix ? stmtSchemaListPrefix.all(`${prefix}%`) : stmtSchemaList.all();
    if (rows.length === 0) return { content: [{ type: "text", text: "(no channel schemas registered)" }] };
    const text = rows.map(r => `${r.channel}\tstrict=${r.strict ? "on" : "off"}\tversion=${r.version ?? "null"}\tupdated=${new Date(r.updated_at).toISOString()}`).join("\n");
    return { content: [{ type: "text", text }] };
  });

  // ── list_workers ────────────────────────────────────────────────────────────
  server.registerTool("list_workers", {
    title: "List workers",
    description: "List all workers defined in the worker config with their running state, PID, and uptime. Use this to check which watchdogs are active before starting or stopping one.",
    inputSchema: {},
  }, async () => {
    const defs = loadWorkerDefs();
    if (!defs.length) return { content: [{ type: "text", text: "(no workers configured — set WORKERS_CONFIG)" }] };
    const lines = defs.map(w => {
      const info = workerRunningInfo(w.name);
      let state = "stopped";
      if (info) {
        const uptime = info.startedAt ? `${Math.floor((Date.now() - info.startedAt) / 1000)}s` : "?";
        state = `running  pid=${info.pid ?? "?"}  uptime=${uptime}${info.tmux ? `  tmux=${WORKERS_TMUX_SESSION}:${w.name}` : ""}`;
      }
      return `${w.name}\t${state}${w.model ? `\tmodel=${w.model}` : ""}`;
    });
    return { content: [{ type: "text", text: lines.join("\n") }] };
  });

  // ── start_worker ─────────────────────────────────────────────────────────────
  server.registerTool("start_worker", {
    title: "Start a worker watchdog",
    description: "Start the watchdog process for a named worker. The worker must be defined in the worker config (WORKERS_CONFIG). Returns the PID on success. No-ops (returns current PID) if already running. Pass model to override the default CLAUDE_MODEL for this session (e.g. 'claude-opus-4-7' for demanding tasks).",
    inputSchema: {
      name:  z.string().min(1).describe("Worker name as defined in WORKERS_CONFIG, e.g. 'backend', 'platform-orch'."),
      model: z.string().min(1).optional().describe("Claude model ID to use for this session, e.g. 'claude-opus-4-7'. Overrides the worker's configured model and the CLAUDE_MODEL env var. Omit to use the worker's \"model\" field from WORKERS_CONFIG, falling back to CLAUDE_MODEL (default claude-haiku-4-5-20251001)."),
    },
  }, async ({ name, model }) => {
    let r;
    try { r = startWorker(name, { model }); }
    catch (e) { return { content: [{ type: "text", text: e.message }], isError: true }; }
    if (r.already) {
      const where = r.tmux ? ` in tmux ${WORKERS_TMUX_SESSION}:${name}` : "";
      return { content: [{ type: "text", text: `Worker "${name}" already running${where} (pid ${r.pid ?? "?"}).` }] };
    }
    const modelNote = model ? ` [model: ${model}]` : "";
    const text = r.tmux
      ? `Started "${name}" in tmux session "${WORKERS_TMUX_SESSION}" window "${name}" (pid ${r.pid ?? "?"})${modelNote}.`
      : `Started "${name}" (pid ${r.pid})${modelNote}. Logs: ${WORKERS_LOG_DIR}/${name}.{out,err}.log`;
    return { content: [{ type: "text", text }] };
  });

  // ── turn_start ───────────────────────────────────────────────────────────────
  server.registerTool("turn_start", {
    title: "Turn-start ritual in one call",
    description: "Read inbox + control channels in a single round-trip. Returns JSON: {inbox, control, rotate_requested, inbox_next_id, control_next_id}. Replaces the 2 sequential read_messages calls that every worker does at turn start. rotate_requested is true if any unread control message has type='rotate'.",
    inputSchema: {
      inbox_channel:    z.string().min(1).describe("Worker inbox channel, e.g. backend."),
      control_channel:  z.string().min(1).describe("Broadcast control channel, e.g. control."),
      inbox_since_id:   z.number().int().nonnegative().default(0).describe("Return inbox messages with id > this. Default 0."),
      control_since_id: z.number().int().nonnegative().default(0).describe("Return control messages with id > this. Default 0."),
      limit:            z.number().int().positive().max(500).optional().describe("Max messages per channel. Default 100."),
      projection:       z.enum(["full", "summary"]).optional().describe("'summary' replaces each message's content with headline envelope fields (type, task_id, subject, summary, bytes). Default 'full'."),
    },
  }, async ({ inbox_channel, control_channel, inbox_since_id, control_since_id, limit, projection }) => {
    const lim         = limit ?? 100;
    const inboxRows   = fetchFiltered(inbox_channel,   inbox_since_id   ?? 0, lim, null, null);
    const controlRows = fetchFiltered(control_channel, control_since_id ?? 0, lim, null, null);

    const rotateRequested = controlRows.some(r => {
      try { return JSON.parse(r.content).type === "rotate"; } catch { return false; }
    });

    const toMsgObj = r => ({ id: r.id, sender: r.sender, ts: new Date(r.created_at).toISOString(),
      ...(projection === "summary" ? { summary: summarizeContent(r.content) } : { content: r.content }) });

    return { content: [{ type: "text", text: JSON.stringify({
      inbox:            inboxRows.map(toMsgObj),
      control:          controlRows.map(toMsgObj),
      rotate_requested: rotateRequested,
      inbox_next_id:    inboxRows.length   > 0 ? inboxRows[inboxRows.length - 1].id   : (inbox_since_id   ?? 0),
      control_next_id:  controlRows.length > 0 ? controlRows[controlRows.length - 1].id : (control_since_id ?? 0),
    }) }] };
  });

  // ── send_message_batch ───────────────────────────────────────────────────────
  server.registerTool("send_message_batch", {
    title: "Send multiple messages in one call",
    description: "Post an array of messages in a single SQLite transaction. Returns [{id, channel, sender}] for each message. Use when dispatching tasks to multiple workers simultaneously — replaces N send_message calls with one round-trip. Max 50 messages per call.",
    inputSchema: {
      messages: z.array(z.object({
        channel: z.string().min(1),
        sender:  z.string().min(1),
        content: z.string().min(1),
      })).min(1).max(50).describe("Array of messages to post."),
    },
  }, async ({ messages }) => {
    const now     = Date.now();
    const results = [];

    // Validate all first; abort before any inserts if a strict schema fails
    const warns = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const check = validateContent(msg.channel, msg.content);
      if (!check.ok && check.strict) {
        return { content: [{ type: "text", text: `schema validation failed on '${msg.channel}' (message ${i + 1}/${messages.length}): ${check.errors}` }], isError: true };
      }
      if (!check.ok) warns.push(`message ${i + 1} → '${msg.channel}': ${check.errors}`);
    }

    db.transaction((msgs) => {
      for (let i = 0; i < msgs.length; i++) {
        const r = stmtInsert.run(msgs[i].channel, msgs[i].sender, msgs[i].content, now);
        results.push({ id: r.lastInsertRowid, channel: msgs[i].channel, sender: msgs[i].sender, content: msgs[i].content });
      }
    })(messages);

    for (const r of results) {
      messageBus.emit(`msg:${r.channel}`, { id: r.id, sender: r.sender, content: r.content });
    }

    const summary = results.map(r => `#${r.id} → ${r.channel}`).join(", ");
    const warnText = warns.length ? `  [WARN schema mismatch: ${warns.join("; ")}]` : "";
    return { content: [{ type: "text", text: `Sent ${results.length} messages: ${summary}${warnText}` }] };
  });

  // ── upsert_heartbeat ─────────────────────────────────────────────────────────
  server.registerTool("upsert_heartbeat", {
    title: "Post a heartbeat (keep-latest-per-sender)",
    description: "Post a message and immediately delete all older messages from this sender on this channel. Keeps the channel at exactly one row per sender — prevents telemetry channel bloat. Use instead of send_message for telemetry heartbeats. Readable via get_latest_per_sender or read_messages as normal.",
    inputSchema: {
      channel: z.string().min(1).describe("Heartbeat channel, e.g. telemetry."),
      sender:  z.string().min(1).describe("Worker identifier."),
      content: z.string().min(1).describe("Heartbeat payload — plain text or JSON-as-string."),
    },
  }, async ({ channel, sender, content }) => {
    // Enforce channel schemas exactly like send_message: strict → reject, warn-only → warn + accept.
    const check = validateContent(channel, content);
    if (!check.ok && check.strict) {
      return { content: [{ type: "text", text: `schema validation failed on '${channel}': ${check.errors}. Call get_channel_schema('${channel}') to see required fields.` }], isError: true };
    }
    if (!check.ok && !check.strict) {
      console.warn(`[claude-broker] WARN schema mismatch on '${channel}' (upsert_heartbeat): ${check.errors}`);
    }
    const now = Date.now();
    const r   = stmtInsert.run(channel, sender, content, now);
    const id  = r.lastInsertRowid;
    stmtDeleteOtherHeartbeats.run(channel, sender, id);
    messageBus.emit(`msg:${channel}`, { id, sender, content });
    const warn = (!check.ok && !check.strict) ? `  [WARN schema mismatch: ${check.errors}]` : "";
    return { content: [{ type: "text", text: `Heartbeat #${id} posted for '${sender}' on '${channel}' at ${new Date(now).toISOString()}.${warn}` }] };
  });

  // ── open_questions ───────────────────────────────────────────────────────────
  // Production data (2026-09-05): 4 of 6 type:question messages never received a reply
  // and nothing surfaced it. This lists questions with no answer on the asker's inbox.
  server.registerTool("open_questions", {
    title: "List unanswered questions in a namespace",
    description: "Scans every channel under prefix (e.g. 'team-') for type:question messages and returns those with no later message on the asker's inbox (<prefix><from>) that references the question's task_id, and no self-posted result for it. Use at orchestrator turn-start so blocked workers are never left waiting.",
    inputSchema: {
      prefix:      z.string().min(1).describe("Namespace prefix including the dash, e.g. 'team-' or 'cb-'."),
      max_age_ms:  z.number().int().positive().optional().describe("Ignore questions older than this. Default: no limit."),
    },
  }, async ({ prefix, max_age_ms }) => {
    const now  = Date.now();
    const rows = stmtQuestions.all(`${prefix}%`);
    const open = [];
    let answered = 0;
    for (const r of rows) {
      if (max_age_ms && now - r.created_at > max_age_ms) continue;
      let q = {};
      try { q = JSON.parse(r.content); } catch { continue; }
      const asker  = typeof q.from === "string" && q.from ? q.from : r.sender;
      const taskId = typeof q.task_id === "string" && q.task_id ? q.task_id : null;
      const inbox  = `${prefix}${asker}`;
      const reply  = stmtQuestionReply.get(inbox, r.id, taskId, taskId, taskId);
      const self   = taskId ? stmtQuestionSelfResult.get(`${prefix}%`, r.id, r.sender, taskId) : null;
      if (reply || self) { answered++; continue; }
      open.push({
        id: r.id, channel: r.channel, from: asker, to: q.to ?? null, task_id: taskId,
        subject: typeof q.subject === "string" ? q.subject : null,
        asked_at: new Date(r.created_at).toISOString(),
        age_min: Math.round((now - r.created_at) / 60000),
        expected_reply_channel: inbox,
      });
    }
    return { content: [{ type: "text", text: JSON.stringify({ prefix, open, open_count: open.length, answered_count: answered }) }] };
  });

  // ── sprint_summary ───────────────────────────────────────────────────────────
  server.registerTool("sprint_summary", {
    title: "Get sprint progress summary",
    description: "Returns dispatched/completed/failed task counts for a status channel, plus the latest sprint boundary note from the control channel. One SQL aggregation instead of reading the full channel history. Use for orchestrator ledger sync at turn-start.",
    inputSchema: {
      status_channel:  z.string().min(1).describe("The status channel, e.g. status."),
      control_channel: z.string().optional().describe("If set, include the latest sprint boundary note from this channel."),
    },
  }, async ({ status_channel, control_channel }) => {
    const progress   = stmtSprintProgress.get(status_channel) || { completed: 0, failed: 0 };
    // Derive namespace prefix (e.g. "dv" from "status") to query worker inbox channels.
    const ns         = status_channel.includes('-') ? status_channel.slice(0, status_channel.lastIndexOf('-')) : status_channel;
    const dispatched = stmtSprintDispatched.get(`${ns}-%`).n;
    let sprint = null;
    if (control_channel) {
      const row = stmtSprintInfo.get(control_channel);
      if (row) {
        let subject = "", body = "";
        try { const p = JSON.parse(row.content); subject = p.subject || ""; body = typeof p.body === "string" ? p.body : ""; } catch {}
        sprint = { subject, body, started_at: new Date(row.created_at).toISOString() };
      }
    }
    return { content: [{ type: "text", text: JSON.stringify({
      status_channel,
      dispatched,
      completed:   progress.completed,
      failed:      progress.failed,
      pending:     dispatched - progress.completed,
      sprint,
    }) }] };
  });

  // ── sprint_file_conflicts ────────────────────────────────────────────────────
  // Pre-sprint-close conflict detector: aggregates affected_files from all
  // type:result messages and surfaces files touched by more than one worker.
  //
  // Real incident: worker/bs cherry-picked orphaned commits that created
  // deposit-reconciliation.service.ts; worker/backend also created the same
  // file with different content (added try/catch). Sprint-close hit an add/add
  // conflict that required manual --ours resolution + push before re-run.
  // Running this tool first would have caught it before the merge script ran.
  server.registerTool("sprint_file_conflicts", {
    title: "Pre-sprint-close file conflict detector",
    description: "Aggregates affected_files from all type:result messages on a status channel and returns files touched by more than one worker. Run before the sprint-close merge script to surface add/add or edit/edit conflicts that would otherwise fail mid-merge. Also reports workers whose results omit affected_files (blind spots where conflicts cannot be detected). One SQL scan — no channel history transfer needed.",
    inputSchema: {
      status_channel: z.string().min(1).describe("Status channel to scan, e.g. 'status'."),
      since_id: z.number().int().min(0).optional().describe("Only consider results with id > since_id. Omit to scan all messages on the channel (full sprint scan)."),
    },
  }, async ({ status_channel, since_id = 0 }) => {
    const rows = stmtResultRowsSince.all(status_channel, since_id);

    // file → [{worker, task_id}]
    const fileMap = new Map();
    // workers that posted results without affected_files (undetectable conflicts)
    const blindSpots = new Set();

    for (const row of rows) {
      let msg;
      try { msg = JSON.parse(row.content); } catch { continue; }
      const worker = msg.from || row.sender;
      const taskId = msg.task_id || "?";
      const summary = typeof msg.summary === "string" ? msg.summary : "";
      if (summary.startsWith("SKIP")) continue; // SKIP results don't touch files

      const files = Array.isArray(msg.affected_files) ? msg.affected_files : null;
      if (!files || files.length === 0) {
        blindSpots.add(worker);
        continue;
      }
      for (const f of files) {
        if (!fileMap.has(f)) fileMap.set(f, []);
        fileMap.get(f).push({ worker, task_id: taskId });
      }
    }

    const conflicts = [];
    let cleanCount = 0;
    for (const [file, touches] of fileMap.entries()) {
      const workers = [...new Set(touches.map(t => t.worker))];
      if (workers.length > 1) {
        conflicts.push({ file, workers, touches });
      } else {
        cleanCount++;
      }
    }

    const blindList = [...blindSpots];
    const summary =
      conflicts.length === 0
        ? blindList.length > 0
          ? `No detected conflicts — but ${blindList.length} worker(s) omitted affected_files: ${blindList.join(", ")}`
          : "No conflicts detected — safe to run sprint-close"
        : `${conflicts.length} conflict(s) detected — resolve before running sprint-close`;

    return { content: [{ type: "text", text: JSON.stringify({
      status_channel,
      since_id,
      conflicts,               // files touched by 2+ workers → merge conflict risk
      clean_count: cleanCount, // single-owner files (safe)
      blind_spots: blindList,  // workers that omitted affected_files
      summary,
    }) }] };
  });

  // ── stop_worker ──────────────────────────────────────────────────────────────
  server.registerTool("stop_worker", {
    title: "Stop a worker watchdog",
    description: "Stop the watchdog process for a named worker (SIGTERM to entire process group — kills watchdog + any in-flight Claude session). The worker will not restart until started again.",
    inputSchema: {
      name: z.string().min(1).describe("Worker name as defined in WORKERS_CONFIG, e.g. 'backend', 'platform-orch'."),
    },
  }, async ({ name }) => {
    let r;
    try { r = stopWorker(name); }
    catch (e) { return { content: [{ type: "text", text: e.message }], isError: true }; }
    const text = r.tmux
      ? `Stopped "${name}" (killed tmux window ${WORKERS_TMUX_SESSION}:${name}).`
      : `Stopped "${name}" (pid ${r.pid}).`;
    return { content: [{ type: "text", text }] };
  });

  // ── register_worker ──────────────────────────────────────────────────────────
  server.registerTool("register_worker", {
    title: "Register a new worker in WORKERS_CONFIG",
    description: "Add or update a worker definition in WORKERS_CONFIG. Constructs the args array from provided parameters and performs an atomic upsert: if a worker with the same name exists, it is replaced; otherwise a new entry is appended. No broker restart is required — the next worker start will use the updated definition.",
    inputSchema: {
      name: z.string().min(1).describe("Worker name, e.g. 'backend', 'qa-reviewer'. Letters, digits, dot, dash, underscore only (becomes a log filename and tmux window name)."),
      ns: z.string().min(1).describe("Namespace, e.g. 'team-a', 'infra' — used for tab organization in multi-session dashboards."),
      worker_dir: z.string().min(1).describe("Worker directory path relative to repo_root, e.g. 'workers/backend' or 'orchestrators/infra'."),
      repo_root: z.string().min(1).describe("Absolute path to the repository root, e.g. '/home/me/myrepo'."),
      inbox_channel: z.string().min(1).describe("Channel name for worker inbox, e.g. 'team-backend' or 'core'."),
    },
  }, async ({ name, ns, worker_dir, repo_root, inbox_channel }) => {
    if (!WORKERS_CONFIG)
      return { content: [{ type: "text", text: "Error: WORKERS_CONFIG env var not set" }], isError: true };

    try {
      assertSafeWorkerName(name);
      let defs = JSON.parse(readFileSync(WORKERS_CONFIG, "utf8"));
      const idx = defs.findIndex(w => w.name === name);
      // Keep fields the tool does not manage (model, notes, …) when replacing an existing entry.
      const prev  = idx >= 0 ? defs[idx] : {};
      const entry = { ...prev, name, ns, args: [worker_dir, "--repo-root", repo_root, "--inbox-channel", inbox_channel] };

      if (idx >= 0) {
        defs[idx] = entry;
      } else {
        defs.push(entry);
      }

      saveWorkerDefs(defs);
      console.log(`[claude-broker] registered worker "${name}" in WORKERS_CONFIG`);
      return { content: [{ type: "text", text: JSON.stringify({ registered: { name, ns, args: entry.args } }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  });

  // ── deregister_worker ────────────────────────────────────────────────────────
  server.registerTool("deregister_worker", {
    title: "Remove a worker from WORKERS_CONFIG",
    description: "Remove a worker definition from WORKERS_CONFIG. Errors if the worker is currently running (must stop it first). The file is updated atomically; no broker restart required.",
    inputSchema: {
      name: z.string().min(1).describe("Worker name to remove, e.g. 'backend', 'qa-reviewer'."),
    },
  }, async ({ name }) => {
    if (!WORKERS_CONFIG)
      return { content: [{ type: "text", text: "Error: WORKERS_CONFIG env var not set" }], isError: true };

    // Check if worker is running
    if (workerRunningInfo(name))
      return { content: [{ type: "text", text: `Error: worker "${name}" is currently running — stop it first` }], isError: true };

    try {
      let defs = JSON.parse(readFileSync(WORKERS_CONFIG, "utf8"));
      const idx = defs.findIndex(w => w.name === name);

      if (idx < 0)
        return { content: [{ type: "text", text: `Error: worker "${name}" not found in WORKERS_CONFIG` }], isError: true };

      defs.splice(idx, 1);
      saveWorkerDefs(defs);
      console.log(`[claude-broker] deregistered worker "${name}" from WORKERS_CONFIG`);
      return { content: [{ type: "text", text: `Deregistered worker "${name}" from WORKERS_CONFIG.` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  });

  return server;
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();

// Reusable auth middleware — pass as route-level middleware on protected endpoints.
function auth(req, res, next) {
  if (!SHARED_SECRET) return next();
  if (!secretMatches(req.headers.authorization)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// Dashboard auth — browsers can't set an Authorization header on page loads,
// so the dashboard routes also accept ?token=<secret>. Rendered links must
// propagate the token (see tokenParam in the dashboard handlers).
function dashboardAuth(req, res, next) {
  if (!SHARED_SECRET) return next();
  if (secretMatches(req.headers.authorization) || tokenMatches(req.query.token)) return next();
  return res.status(401).json({ error: "Unauthorized" });
}
app.use(express.json({ limit: "1mb" }));

// Per-route hit counter (path only — no query strings, so tokens never land in metrics).
app.use((req, _res, next) => {
  const key = `${req.method} ${req.path.replace(/^\/workers\/[^/]+\//, "/workers/:name/")}`;
  metrics.http[key] = (metrics.http[key] || 0) + 1;
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now(), uptime_s: Math.floor((Date.now() - startedAt) / 1000) }));

// In-memory counters since process start. Answers "which tools are actually used, how often
// do long-polls wake vs time out, what's slow" without guessing.
app.get("/metrics", auth, (_req, res) => {
  const tools = Object.fromEntries(Object.entries(metrics.tools).map(([k, v]) => [k, { ...v, avg_ms: v.calls ? Math.round(v.total_ms / v.calls) : 0 }]));
  const db_rows = stmtChans.all().reduce((s, r) => s + r.n, 0);
  res.json({
    uptime_s: Math.floor((Date.now() - metrics.started_at) / 1000),
    messages_inserted: metrics.messages_inserted,
    db_rows,
    long_polls: { active: metrics.long_polls_active, total: metrics.long_polls_total, woken: metrics.long_polls_woken },
    tools,
    http: metrics.http,
  });
});

// Lightweight inbox pre-check — no Claude session needed.
// Returns {pending, count, max_id} so watchdog can avoid starting Claude when idle.
// Optional wait_ms (max 60000): long-poll — respond as soon as a message lands on the channel
// instead of making the watchdog sleep-and-retry. Response shape is identical.
app.get("/inbox", auth, (req, res) => {
  const { channel, since_id = "0" } = req.query;
  if (!channel || typeof channel !== "string") return res.status(400).json({ error: "channel required" });
  const sinceId = parseInt(since_id, 10);
  if (isNaN(sinceId)) return res.status(400).json({ error: "since_id must be numeric" });
  const waitMs = Math.min(Math.max(parseInt(req.query.wait_ms, 10) || 0, 0), 60000);
  const reply = () => {
    const row = stmtHasMessages.get(channel, sinceId);
    return { channel, since_id: sinceId, pending: row.n > 0, count: row.n, max_id: row.max_id };
  };
  const first = reply();
  if (first.pending || waitMs === 0) return res.json(first);

  req.socket.setTimeout(0);
  const event = `msg:${channel}`;
  let done = false;
  let timer = null;
  const finish = (woken) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    messageBus.off(event, onMsg);
    metrics.long_polls_active--;
    if (woken) metrics.long_polls_woken++;
    if (!res.writableEnded && !res.destroyed) res.json(reply());
  };
  const onMsg = () => { if (stmtHasMessages.get(channel, sinceId).n > 0) finish(true); };
  metrics.long_polls_total++; metrics.long_polls_active++;
  messageBus.on(event, onMsg);
  res.on("close", () => finish(false));
  timer = setTimeout(() => finish(false), waitMs);
});

// Batch inbox pre-check — single round-trip for N channels.
// POST body: { "channel-name": since_id, ... }
// Response:  { "channel-name": { pending, count, max_id }, ... }
app.post("/inbox/batch", auth, (req, res) => {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({ error: "body must be an object mapping channel to since_id" });
  }
  const result = {};
  for (const [channel, rawSinceId] of Object.entries(body)) {
    const sinceId = parseInt(rawSinceId, 10);
    if (isNaN(sinceId)) { result[channel] = { error: "since_id must be numeric" }; continue; }
    const row = stmtHasMessages.get(channel, sinceId);
    result[channel] = { pending: row.n > 0, count: row.n, max_id: row.max_id };
  }
  res.json(result);
});

// REST send endpoint — lets non-MCP clients (watchdog.sh, scripts) post messages.
// POST /messages  body: { channel, sender, content }
// Auth required when SHARED_SECRET is set (set BROKER_SECRET in watchdog env to match).
app.post("/messages", auth, (req, res) => {
  const { channel, sender, content } = req.body || {};
  if (!channel || !sender || content === undefined)
    return res.status(400).json({ error: "channel, sender, content required" });
  if (!isValidChannelName(channel))
    return res.status(400).json({ error: `invalid channel name: control characters are not allowed` });
  const contentStr = typeof content === "string" ? content : JSON.stringify(content);
  // Enforce channel schemas exactly like MCP send_message: strict → reject, warn-only → log + accept.
  const check = validateContent(channel, contentStr);
  if (!check.ok && check.strict) {
    return res.status(400).json({ error: `schema validation failed on '${channel}': ${check.errors}` });
  }
  if (!check.ok && !check.strict) {
    console.warn(`[claude-broker] WARN schema mismatch on '${channel}' (POST /messages): ${check.errors}`);
  }
  const row = stmtInsert.run(channel, sender, contentStr, Date.now());
  compactTelemetry(channel, sender, row.lastInsertRowid);
  messageBus.emit(`msg:${channel}`, { id: row.lastInsertRowid, channel, sender, content: contentStr });
  const out = { id: row.lastInsertRowid, channel, sender };
  if (!check.ok && !check.strict) out.warn = `schema mismatch: ${check.errors}`;
  res.json(out);
});

// ── Worker control endpoints ───────────────────────────────────────────────────

app.get("/workers", auth, (_req, res) => {
  res.json(loadWorkerDefs().map(w => {
    const info = workerRunningInfo(w.name);
    return {
      name:      w.name,
      ns:        w.ns   || null,
      args:      w.args || [],
      model:     w.model || null,
      running:   !!info,
      pid:       info?.pid       ?? null,
      startedAt: info?.startedAt ?? null,
      ...(info?.tmux && { tmux: `${WORKERS_TMUX_SESSION}:${w.name}` }),
    };
  }));
});

app.post("/workers/:name/start", auth, (req, res) => {
  const { name } = req.params;
  const model = typeof req.body?.model === "string" && req.body.model.trim() ? req.body.model.trim() : undefined;
  // Unknown worker → 404 before the WATCHDOG_BIN 503 check: a missing binary means nothing can start regardless.
  if (!loadWorkerDefs().some(w => w.name === name)) return res.status(404).json({ error: `Worker "${name}" not in config` });
  try {
    const r = startWorker(name, { model });
    if (r.already) return res.status(409).json({ error: `Worker "${name}" already running (pid ${r.pid ?? "?"})` });
    res.json({ ok: true, name, pid: r.pid, ...(r.tmux && { tmux: `${WORKERS_TMUX_SESSION}:${name}` }), ...(model && { model }) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post("/workers/:name/stop", auth, (req, res) => {
  const { name } = req.params;
  try {
    const r = stopWorker(name);
    res.json({ ok: true, name, pid: r.pid });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// GET /cost?since=<ISO-date> — aggregate session costs from telemetry.
// Returns { total_usd, sessions, by_worker: [{worker, sessions, total_usd}] }
app.get("/cost", dashboardAuth, (req, res) => {
  let since = Date.now() - 24 * 60 * 60 * 1000; // default: last 24h
  if (req.query.since) {
    const parsed = new Date(req.query.since).getTime();
    if (isNaN(parsed)) return res.status(400).json({ error: "Invalid since date" });
    since = parsed;
  }

  const rows = stmtCostEndpointRows.all(TELEMETRY_CHANNEL, since);

  const byWorker = {};
  for (const row of rows) {
    let hb = {};
    try { hb = JSON.parse(row.content); } catch { continue; }
    const usd = parseFloat(hb.cost_since_start?.estimated_usd ?? 0);
    if (!usd || isNaN(usd)) continue;
    const w = row.sender;
    if (!byWorker[w]) byWorker[w] = { worker: w, sessions: 0, total_usd: 0 };
    byWorker[w].sessions++;
    byWorker[w].total_usd = Math.round((byWorker[w].total_usd + usd) * 10000) / 10000;
  }

  const workers = Object.values(byWorker).sort((a, b) => b.total_usd - a.total_usd);
  const total_usd = Math.round(workers.reduce((s, w) => s + w.total_usd, 0) * 10000) / 10000;
  res.json({ total_usd, sessions: workers.reduce((s, w) => s + w.sessions, 0), since: new Date(since).toISOString(), by_worker: workers });
});

// GET /rate-limits?since=<ISO-date>&worker=<name>
// Returns rate limit hit log from rate-limits channel.
// { total_hits, by_worker: [{worker, hits, models, total_backoff_s, last_hit}], events: [...] }
app.get("/rate-limits", dashboardAuth, (req, res) => {
  let since = Date.now() - 7 * 24 * 60 * 60 * 1000; // default: last 7 days
  if (req.query.since) {
    const parsed = new Date(req.query.since).getTime();
    if (isNaN(parsed)) return res.status(400).json({ error: "Invalid since date" });
    since = parsed;
  }

  const rows = stmtRlEndpointRows.all(RATE_LIMIT_CHANNEL, since);

  const byWorker = {};
  const events = [];
  for (const row of rows) {
    let r = {};
    try { r = JSON.parse(row.content); } catch { continue; }
    const w = row.sender;
    if (!byWorker[w]) byWorker[w] = { worker: w, hits: 0, models: {}, total_backoff_s: 0, last_hit: null };
    byWorker[w].hits++;
    byWorker[w].total_backoff_s += r.backoff_s || 0;
    byWorker[w].last_hit = r.ts || new Date(row.created_at).toISOString();
    const model = r.model || 'unknown';
    byWorker[w].models[model] = (byWorker[w].models[model] || 0) + 1;
    events.push({ worker: w, ts: r.ts, model, backoff_s: r.backoff_s, start_reason: r.start_reason, restart_count: r.restart_count });
  }

  const workers = Object.values(byWorker).sort((a, b) => b.hits - a.hits);
  res.json({ total_hits: workers.reduce((s, w) => s + w.hits, 0), since: new Date(since).toISOString(), by_worker: workers, events });
});

// Dashboard helpers
function nsOf(channel) {
  const idx = channel.indexOf("-");
  return idx > 0 ? channel.slice(0, idx) : channel;
}
function agoStr(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s/60)}m ago` : `${Math.floor(s/3600)}h ago`;
}
// Namespace query params are interpolated into HTML and hrefs — allow only [A-Za-z0-9_.-].
function safeNs(v) {
  return typeof v === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(v) ? v : "all";
}
function escHtml(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// Dashboard
app.get("/dashboard", dashboardAuth, (req, res) => {
  const now         = Date.now();
  const allChannels = stmtChans.all();
  const allCaps     = stmtCapList.all();
  const allSchemas  = stmtSchemaList.all();
  const latestMsgs  = stmtLatestMsgPerChannel.all();  // last msg per channel

  // Build preview map: channel -> {sender, content, created_at}
  const previewMap = new Map(latestMsgs.map(r => [r.channel, r]));

  // Auto-detect namespaces
  const nsSet = new Set(allChannels.map(r => nsOf(r.channel)).filter(Boolean));
  allCaps.forEach(r => { try { JSON.parse(r.channels).forEach(c => nsSet.add(nsOf(c))); } catch {} });
  const namespaces = [...nsSet].sort();

  // ns is reflected into the page; restrict to the charset namespaces actually use.
  const selectedNs = safeNs(req.query.ns);
  const isAll      = selectedNs === "all";
  const live       = req.query.live === "1";
  const tokenParam = req.query.token ? `token=${encodeURIComponent(req.query.token)}` : "";

  function matchesNs(ch) { return isAll || nsOf(ch) === selectedNs; }

  const channels  = allChannels.filter(r => matchesNs(r.channel));
  const caps      = allCaps.filter(r => {
    if (isAll) return true;
    try { return JSON.parse(r.channels).some(c => nsOf(c) === selectedNs); } catch { return false; }
  });
  const schemas   = allSchemas.filter(r => matchesNs(r.channel));
  const schemaMap = new Map(schemas.map(s => [s.channel, s]));

  // ── Sprint info ───────────────────────────────────────────────────────────────
  // Collect sprint info per namespace (or just for the selected one)
  function getSprintInfo(ns) {
    const controlChan = `${ns}-control`;
    const statusChan  = `${ns}-status`;
    const row = stmtSprintInfo.get(controlChan);
    if (!row) return null;
    let subject = "", body = "";
    try { const p = JSON.parse(row.content); subject = p.subject || ""; body = typeof p.body === "string" ? p.body : ""; } catch {}
    const slug       = subject.split(/\s+/)[0] || subject;
    const progress   = stmtSprintProgress.get(statusChan) || { completed: 0, failed: 0 };
    const dispatched = stmtSprintDispatched.get(`${ns}-%`).n;
    return { ns, slug, startedAt: row.created_at, body, dispatched, ...progress };
  }

  const sprintInfos = isAll
    ? namespaces.map(getSprintInfo).filter(Boolean)
    : [getSprintInfo(selectedNs)].filter(Boolean);

  // ── Today's cost summary from telemetry (session-end heartbeats) ─────────────
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const costRows = isAll
    ? stmtDashCostRows.all(TELEMETRY_CHANNEL, todayStart.getTime())
    : stmtDashChanRows.all(`${selectedNs}-telemetry`, todayStart.getTime());
  const costByWorker = {};
  for (const r of costRows) {
    let hb = {}; try { hb = JSON.parse(r.content); } catch { continue; }
    const usd = parseFloat(hb.cost_since_start?.estimated_usd ?? 0);
    if (!usd || isNaN(usd)) continue;
    if (!costByWorker[r.sender]) costByWorker[r.sender] = 0;
    costByWorker[r.sender] = Math.round((costByWorker[r.sender] + usd) * 10000) / 10000;
  }
  const totalCostToday = Math.round(Object.values(costByWorker).reduce((s, v) => s + v, 0) * 10000) / 10000;

  // ── Rate limit hits today ─────────────────────────────────────────────────────
  const rlChan = isAll ? RATE_LIMIT_CHANNEL : `${selectedNs}-rate-limits`;
  const rlRows = isAll
    ? stmtDashRlRows.all(RATE_LIMIT_CHANNEL, todayStart.getTime())
    : stmtDashChanRows.all(rlChan, todayStart.getTime());
  const rlByWorker = {};
  for (const r of rlRows) {
    let rec = {}; try { rec = JSON.parse(r.content); } catch { continue; }
    rlByWorker[r.sender] = (rlByWorker[r.sender] || 0) + 1;
  }
  const totalRlToday = Object.values(rlByWorker).reduce((s, v) => s + v, 0);

  // ── Worker liveness from telemetry ──────────────────────────────────────────
  // For selected ns, read <ns>-telemetry (or all *-telemetry channels if "all")
  const telemetryChan = isAll ? null : `${selectedNs}-telemetry`;
  const telemetryRows = telemetryChan
    ? stmtLatestPerSender.all(telemetryChan).map(r => ({...r, _ns: selectedNs}))
    : (() => {
        const tChans = allChannels.filter(r => r.channel.endsWith("-telemetry")).map(r => r.channel);
        return tChans.flatMap(c => {
          const ns = nsOf(c);
          return stmtLatestPerSender.all(c).map(r => ({...r, _ns: ns}));
        });
      })();

  // channel → message count, used for inbox-pending lookups
  const channelCountMap = new Map(allChannels.map(r => [r.channel, r.n]));
  const SPECIAL_SUFFIXES = new Set(["status", "control", "telemetry", "backlog"]);

  const workers = telemetryRows.map(row => {
    let hb = {};
    try { hb = JSON.parse(row.content); } catch {}
    const ageSec     = Math.floor((now - row.created_at) / 1000);
    const state      = hb.activity?.state || hb.state || "unknown";
    const task       = hb.activity?.current_task_id || null;
    const cost       = hb.cost_since_start?.estimated_usd ?? null;
    const rotating   = hb.context?.rotation_recommended === true;
    const tierPct    = hb.context?.tier_threshold_pct ?? null;
    const model      = hb.model || null;
    const inboxChan  = `${row._ns}-${row.sender}`;
    const inboxCount = channelCountMap.get(inboxChan) || 0;

    // on-demand model: offline between tasks is normal — use WORKER_OFFLINE_THRESHOLD_S (default 300s)
    let status;
    if (state === "blocked-on-question") {
      status = "blocked";
    } else if (state === "rotating") {
      status = "rotating";
    } else if (state === "working" && ageSec <= 600) {
      status = "running";
    } else if (state === "working" && ageSec > 600) {
      status = "crashed";
    } else if (ageSec <= WORKER_OFFLINE_THRESHOLD_S) {
      status = inboxCount > 0 ? "queued" : "idle";
    } else {
      status = inboxCount > 0 ? "queued" : "offline";
    }

    return { sender: row.sender, _ns: row._ns, state, task, cost, ageSec, status, rotating, tierPct, model, inboxCount };
  });

  // Also surface workers with pending inbox but no telemetry (never ran or pre-first-heartbeat crash)
  if (!isAll) {
    const coveredChans = new Set(workers.map(w => `${w._ns}-${w.sender}`));
    allChannels
      .filter(r => {
        if (nsOf(r.channel) !== selectedNs || r.n === 0) return false;
        const suffix = r.channel.slice(selectedNs.length + 1);
        if (SPECIAL_SUFFIXES.has(suffix) || suffix.endsWith("-orch")) return false;
        return !coveredChans.has(r.channel);
      })
      .forEach(r => workers.push({
        sender: r.channel.slice(selectedNs.length + 1),
        _ns: selectedNs,
        state: "unknown",
        task: null,
        cost: null,
        ageSec: null,
        status: "queued",
        rotating: false,
        inboxCount: r.n,
      }));
  }

  workers.sort((a,b) => a.sender.localeCompare(b.sender));

  // ── Merge configured workers not yet in telemetry or inbox lists ──────────────
  if (!isAll && WATCHDOG_BIN) {
    const coveredNames = new Set(workers.map(w => w.sender));
    loadWorkerDefs()
      .filter(d => (!d.ns || d.ns === selectedNs) && !coveredNames.has(d.name))
      .forEach(d => workers.push({
        sender:    d.name,
        _ns:       selectedNs,
        state:     "never-started",
        task:      null, cost: null, ageSec: null,
        status:    "offline",
        rotating:  false,
        inboxCount: channelCountMap.get(`${selectedNs}-${d.name}`) || 0,
      }));
    workers.sort((a,b) => a.sender.localeCompare(b.sender));
  }

  // ── Per-worker task timing ────────────────────────────────────────────────────
  const timingMap = new Map();
  try { stmtWorkerTiming.all().forEach(r => timingMap.set(r.worker, r)); } catch {}

  // ── Activity feed ─────────────────────────────────────────────────────────────
  const feedSignalOnly = req.query.feed !== "all";
  const FEED_META = new Set(["telemetry", "control", "backlog", "sprint-retrospective"]);
  const feedChannels = allChannels.filter(r => {
    if (r.channel.startsWith("test")) return false;
    const ns     = nsOf(r.channel);
    const suffix = r.channel.slice(ns.length + 1);
    if (FEED_META.has(suffix)) return false;
    if (!isAll && ns !== selectedNs) return false;
    return true;
  }).map(r => r.channel);
  const feedRows = feedChannels.length ? getFeedStmt(feedChannels.length, feedSignalOnly).all(...feedChannels, 100) : [];
  const questionRows = feedRows.filter(r => {
    try { return JSON.parse(r.content).type === "question"; } catch { return false; }
  });

  const feedHref = (showAll) => {
    const p = [];
    if (selectedNs !== "all") p.push(`ns=${selectedNs}`);
    if (live) p.push("live=1");
    if (showAll) p.push("feed=all");
    if (tokenParam) p.push(tokenParam);
    return `/dashboard${p.length ? "?" + p.join("&") : ""}`;
  };

  const renderFeedRow = (r) => {
    let parsed = {};
    try { parsed = JSON.parse(r.content); } catch {}
    const type    = parsed.type || "?";
    const rawText = parsed.summary || parsed.subject || (typeof parsed.body === "string" ? parsed.body : null) || r.content;
    const summary = String(rawText).slice(0, 100);
    const taskId  = parsed.task_id ? String(parsed.task_id) : "";
    const from    = escHtml(parsed.from || r.sender);
    const to      = parsed.to ? escHtml(String(parsed.to)) : "";
    const chanTag = isAll ? `<span class="feed-chan">${escHtml(r.channel)}</span>` : "";
    const dirCell = to
      ? `${from} <span class="feed-arrow">→</span> <span class="feed-to">${to}</span>${chanTag}`
      : `${from}${chanTag}`;
    let badgeClass;
    if      (type === "result")   badgeClass = "feed-result";
    else if (type === "question") badgeClass = "feed-question";
    else if (type === "error")    badgeClass = "feed-error";
    else if (type === "task")     badgeClass = "feed-task";
    else                          badgeClass = "feed-other";
    return `<tr class="${type === "question" ? "feed-row-q" : ""}">
      <td class="feed-time">${agoStr(r.created_at)}</td>
      <td><span class="feed-badge ${badgeClass}">${escHtml(type)}</span></td>
      <td class="feed-sender">${dirCell}</td>
      <td class="feed-taskid-col" title="${escHtml(taskId)}">${taskId ? escHtml(taskId.slice(-22)) : '<span class="dim">—</span>'}</td>
      <td class="feed-content">${escHtml(summary)}${summary.length >= 100 ? "…" : ""}</td>
    </tr>`;
  };

  const questionsAlertHtml = questionRows.length > 0 ? (() => {
    const items = questionRows.slice(0, 5).map(r => {
      let p = {};
      try { p = JSON.parse(r.content); } catch {}
      const from = escHtml(p.from || r.sender);
      const bodyText = p.subject || (typeof p.body === 'string' ? p.body : null) || r.content;
      const body = escHtml(String(bodyText).slice(0, 200));
      const tid  = p.task_id ? ` <span class="feed-taskid">[${escHtml(p.task_id)}]</span>` : "";
      return `<div class="questions-alert-item"><strong>${from}</strong>: ${body}${tid}</div>`;
    }).join("");
    return `<div class="questions-alert">
  <div class="questions-alert-title">⚠ ${questionRows.length} pending question${questionRows.length > 1 ? "s" : ""} — need your attention</div>
  ${items}
</div>`;
  })() : "";

  const feedTableHtml = feedRows.length === 0
    ? `<div class="empty">No ${feedSignalOnly ? "signal " : ""}messages yet${feedChannels.length > 0 ? ` on ${escHtml(feedChannels.slice(0,5).join(", "))}${feedChannels.length > 5 ? ` +${feedChannels.length - 5} more` : ""}` : " (no channels found)"}.</div>`
    : `<table><thead><tr><th>Time</th><th>Type</th><th>From${isAll ? " / Channel" : ""} → To</th><th>Task ID</th><th>Summary</th></tr></thead><tbody>${feedRows.map(renderFeedRow).join("\n")}</tbody></table>`;

  // Annotate each worker with managed/running flags for Start/Stop buttons
  const defs = loadWorkerDefs();
  workers.forEach(w => {
    w.isManaged = WATCHDOG_BIN.length > 0 &&
                  defs.some(d => d.name === w.sender && (!d.ns || d.ns === w._ns));
    w.isRunning  = !!workerRunningInfo(w.sender);
  });

  const hasActions = WATCHDOG_BIN.length > 0;

  // ── HTML helpers ─────────────────────────────────────────────────────────────
  const uptime = (() => {
    const s = Math.floor((now - startedAt) / 1000);
    return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m ${s%60}s`;
  })();

  const tabHref = (ns, lv) => {
    const params = [];
    if (ns !== "all") params.push(`ns=${ns}`);
    if (lv) params.push("live=1");
    if (tokenParam) params.push(tokenParam);
    return `/dashboard${params.length ? "?" + params.join("&") : ""}`;
  };

  const tabs = ["all", ...namespaces].map(ns => {
    const active = ns === selectedNs;
    const count  = ns === "all" ? allChannels.length : allChannels.filter(r => nsOf(r.channel) === ns).length;
    return `<a href="${escHtml(tabHref(ns, live))}" class="tab${active ? " tab-active" : ""}">${ns === "all" ? "All" : escHtml(ns)} <span class="tab-count">${count}</span></a>`;
  }).join("\n");

  // ── Channel rows (with preview) ───────────────────────────────────────────────
  const chanRows = channels.map(r => {
    const exempt      = PRUNE_EXEMPT.includes(r.channel) ? '<span class="badge badge-yellow">exempt</span>' : '';
    const schemaInfo  = schemaMap.get(r.channel);
    const schema      = schemaInfo
      ? (schemaInfo.strict
          ? '<span class="badge badge-blue">strict</span>'
          : '<span class="badge badge-orange">warn</span>')
      : '';
    const prev    = previewMap.get(r.channel);
    let preview   = "";
    if (prev) {
      let text = prev.content;
      try { const p = JSON.parse(text); text = p.subject || p.type || text; } catch {}
      preview = `<span class="preview">${escHtml(String(text).slice(0,80))}${text.length > 80 ? "…" : ""}</span>`;
    }
    const chanHref = `/dashboard/channel?name=${encodeURIComponent(r.channel)}${selectedNs !== "all" ? `&ns=${selectedNs}` : ""}${tokenParam ? `&${tokenParam}` : ""}`;
    return `<tr>
      <td><a href="${chanHref}" class="chan-link">${escHtml(r.channel)}</a>${exempt}${schema}</td>
      <td>${r.n}</td>
      <td>#${r.last_id}</td>
      <td>${agoStr(r.last_ts)}</td>
      <td class="preview-cell">${preview}</td>
    </tr>`;
  }).join("\n");

  // ── Worker liveness rows ──────────────────────────────────────────────────────
  const workerRows = workers.map(w => {
    let dotClass;
    if      (w.status === "running" || w.status === "idle")    dotClass = "dot-green";
    else if (w.status === "queued" || w.status === "rotating") dotClass = "dot-yellow";
    else if (w.status === "offline")                           dotClass = "dot-grey";
    else                                                       dotClass = "dot-red";

    const tierLabel = (w.tierPct !== null && w.status === "running")
      ? ` <span class="ctx-fill${w.tierPct >= 80 ? " ctx-fill-warn" : ""}" title="context fill">${Math.round(w.tierPct)}%</span>`
      : "";
    const stateLabel = w.ageSec === null
      ? '<span class="dim">—</span>'
      : w.status === "offline" || w.status === "crashed"
        ? w.status
        : (w.state === "idle-polling" || w.state === "idle-exit" || w.state === "session-end")
          ? "idle"
          : w.state === "blocked-on-question"
            ? '<span style="color:#f85149;font-weight:bold">blocked</span>'
            : w.status === "running"
              ? `working${tierLabel}`
              : w.state;
    const taskCell   = w.task ? `<span class="task-label">${escHtml(String(w.task).slice(0,40))}</span>` : '<span class="dim">—</span>';
    const costCell   = w.cost != null ? `$${Number(w.cost).toFixed(3)}` : '<span class="dim">—</span>';
    const rotBadge   = w.rotating ? '<span class="badge badge-orange">rotate</span>' : '';
    const inboxCell  = w.inboxCount > 0 ? `<span class="inbox-count">${w.inboxCount}</span>` : '<span class="dim">—</span>';
    const lastSeen   = w.ageSec !== null ? agoStr(now - w.ageSec * 1000) : '<span class="dim">—</span>';
    const actionCell = w.isManaged
      ? w.isRunning
        ? `<button class="btn-stop"  onclick="workerAction('${escHtml(w.sender)}','stop')">Stop</button>`
        : `<button class="btn-start" onclick="workerAction('${escHtml(w.sender)}','start')">Start</button>`
      : (hasActions ? '<span class="dim">—</span>' : "");
    const t = timingMap.get(w.sender);
    const timingCell = t
      ? `<span class="timing-avg" title="min ${t.min_min}m · max ${t.max_min}m · ${t.tasks_done} task${t.tasks_done !== 1 ? 's' : ''}">${t.avg_min}m avg</span>`
      : '<span class="dim">—</span>';

    let idleCell = '<span class="dim">—</span>';
    if (w.status === "running") {
      idleCell = '<span class="dim">active</span>';
    } else if (t && t.last_result_at) {
      idleCell = `<span class="idle-time">${agoStr(t.last_result_at)}</span>`;
    }

    const modelTag = w.model
      ? `<span class="worker-model" title="${escHtml(w.model)}">${escHtml(w.model.replace(/^claude-/,"").replace(/-\d{8}$/,"").slice(0,14))}</span>`
      : "";

    return `<tr>
      <td><span class="dot ${dotClass}"></span> ${escHtml(w.sender)}${rotBadge}${modelTag}</td>
      <td>${stateLabel}</td>
      <td>${taskCell}</td>
      <td>${costCell}</td>
      <td>${timingCell}</td>
      <td>${idleCell}</td>
      <td>${inboxCell}</td>
      <td>${lastSeen}</td>
      ${hasActions ? `<td>${actionCell}</td>` : ""}
    </tr>`;
  }).join("\n");

  // ── Cap rows ──────────────────────────────────────────────────────────────────
  const capRows = caps.map(r => {
    const owns  = JSON.parse(r.owns).join(", ");
    const chans = JSON.parse(r.channels).join(", ");
    return `<tr><td>${escHtml(r.worker)}</td><td>${escHtml(owns)}</td><td>${escHtml(chans)}</td><td>${agoStr(r.updated_at)}</td></tr>`;
  }).join("\n");

  const schemaRows = schemas.map(r =>
    `<tr><td>${escHtml(r.channel)}</td><td>${r.strict ? '<span class="badge badge-blue">strict</span>' : '<span class="badge badge-orange">warn</span>'}</td><td>${r.version ? escHtml(r.version) : '<span class="dim">—</span>'}</td><td>${new Date(r.updated_at).toISOString()}</td></tr>`
  ).join("\n");

  const totalMsgs = channels.reduce((a, r) => a + r.n, 0);
  const nsLabel   = !isAll ? `<span class="ns-label">${selectedNs}</span>` : "";

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>claude-broker${selectedNs !== "all" ? ` · ${selectedNs}` : ""}</title>
${live ? `<meta http-equiv="refresh" content="30">` : ""}
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:ui-monospace,monospace;background:#0d1117;color:#c9d1d9;padding:24px;font-size:13px}
  h1{color:#58a6ff;font-size:18px;margin-bottom:4px}
  .meta{color:#8b949e;margin-bottom:16px;font-size:12px}
  h2{color:#8b949e;font-size:12px;text-transform:uppercase;letter-spacing:.08em;border-bottom:1px solid #21262d;padding-bottom:6px;margin:20px 0 10px}
  table{width:100%;border-collapse:collapse;margin-bottom:4px}
  th{background:#161b22;color:#8b949e;text-align:left;padding:6px 12px;font-weight:normal;font-size:11px;text-transform:uppercase;letter-spacing:.06em}
  td{padding:6px 12px;border-bottom:1px solid #161b22;vertical-align:middle;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:#161b22}
  .badge{display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;margin-left:6px;vertical-align:middle}
  .badge-yellow{background:#6e4c00;color:#e3b341}
  .badge-blue{background:#0d419d;color:#79c0ff}
  .badge-orange{background:#5a3500;color:#f0883e}
  .empty{color:#484f58;font-style:italic;padding:10px 0}
  .config{background:#161b22;border:1px solid #21262d;border-radius:6px;padding:12px 16px;margin-bottom:16px;display:flex;gap:24px;flex-wrap:wrap}
  .config-item{display:flex;flex-direction:column;gap:2px}
  .config-label{color:#8b949e;font-size:10px;text-transform:uppercase;letter-spacing:.06em}
  .config-value{color:#c9d1d9}
  .auth-on{color:#3fb950}.auth-off{color:#f85149}
  .sprint-bar{display:flex;gap:0;flex-wrap:wrap;margin-bottom:16px}
  .sprint-card{background:#161b22;border:1px solid #21262d;border-radius:6px;padding:10px 16px;margin-right:10px;margin-bottom:8px;min-width:260px;flex:1}
  .sprint-name{color:#e3b341;font-size:13px;font-weight:bold;margin-bottom:6px}
  .sprint-meta{color:#8b949e;font-size:11px;margin-bottom:8px}
  .sprint-progress{display:flex;gap:16px}
  .sprint-stat{display:flex;flex-direction:column;gap:1px}
  .sprint-stat-val{font-size:18px;font-weight:bold;color:#c9d1d9}
  .sprint-stat-val.done{color:#3fb950}
  .sprint-stat-val.fail{color:#f85149}
  .sprint-stat-val.open{color:#79c0ff}
  .sprint-stat-lbl{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#8b949e}
  .progress-bar{height:4px;background:#21262d;border-radius:2px;margin-top:8px;overflow:hidden}
  .progress-fill{height:100%;background:#3fb950;border-radius:2px;transition:width .3s}
  .tabs{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:20px;border-bottom:1px solid #21262d;padding-bottom:0;align-items:flex-end}
  .tab{display:inline-block;padding:6px 14px;border-radius:6px 6px 0 0;font-size:12px;color:#8b949e;text-decoration:none;border:1px solid transparent;border-bottom:none;margin-bottom:-1px}
  .tab:hover{color:#c9d1d9;background:#161b22}
  .tab-active{color:#c9d1d9;background:#161b22;border-color:#21262d;border-bottom-color:#161b22}
  .tab-count{display:inline-block;background:#21262d;color:#8b949e;border-radius:10px;padding:0 6px;font-size:10px;margin-left:4px}
  .tab-active .tab-count{background:#30363d;color:#c9d1d9}
  .ns-label{display:inline-block;background:#1f3a5f;color:#79c0ff;border-radius:4px;padding:2px 8px;font-size:11px;margin-left:8px;vertical-align:middle}
  .preview{color:#484f58;font-size:11px}
  .preview-cell{max-width:280px}
  .dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;vertical-align:middle;flex-shrink:0}
  .dot-green{background:#3fb950}
  .dot-yellow{background:#e3b341}
  .dot-red{background:#f85149;box-shadow:0 0 4px #f85149}
  .dot-grey{background:#484f58}
  .task-label{color:#79c0ff;font-size:11px}
  .inbox-count{color:#e3b341;font-weight:bold}
  .dim{color:#484f58}
  .live-btn{margin-left:auto;padding:4px 12px;border-radius:6px 6px 0 0;font-size:11px;font-family:inherit;cursor:pointer;border:1px solid #21262d;border-bottom:none;margin-bottom:-1px;text-decoration:none}
  .live-on{background:#0d2b0d;color:#3fb950;border-color:#1f5c1f}
  .live-off{background:#161b22;color:#8b949e}
  .btn-start,.btn-stop{padding:2px 10px;border-radius:4px;font-size:11px;font-family:inherit;cursor:pointer;border:1px solid}
  .btn-start{background:#0d2b0d;color:#3fb950;border-color:#1f5c1f}
  .btn-start:hover{background:#163d16}
  .btn-stop{background:#2b0d0d;color:#f85149;border-color:#5c1f1f}
  .btn-stop:hover{background:#3d1616}
  .btn-start:disabled,.btn-stop:disabled{opacity:.4;cursor:default}
  .cost-bar{display:flex;align-items:center;gap:10px;background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:8px 14px;margin-bottom:12px;font-size:12px;flex-wrap:wrap}
  .cost-bar-label{color:#8b949e;text-transform:uppercase;letter-spacing:.06em;font-size:11px}
  .cost-bar-total{color:#58a6ff;font-weight:bold;font-size:14px;min-width:60px}
  .cost-bar-worker{color:#e6edf3;background:#161b22;border-radius:4px;padding:2px 7px}
  .cost-bar-wname{color:#8b949e;margin-right:4px}
  .cost-bar-link{margin-left:auto;color:#8b949e;font-size:11px;text-decoration:none}
  .cost-bar-link:hover{color:#58a6ff}
  .questions-alert{background:#2b1d00;border:1px solid #6e4c00;border-radius:6px;padding:10px 16px;margin-bottom:16px}
  .questions-alert-title{color:#e3b341;font-weight:bold;margin-bottom:6px;font-size:12px}
  .questions-alert-item{padding:3px 0;border-bottom:1px solid #3b2800;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .questions-alert-item:last-child{border-bottom:none}
  .section-hdr{display:flex;align-items:center;color:#8b949e;font-size:12px;text-transform:uppercase;letter-spacing:.08em;border-bottom:1px solid #21262d;padding-bottom:6px;margin:20px 0 10px}
  .section-hdr-controls{margin-left:auto;text-transform:none;letter-spacing:normal;display:flex;gap:4px}
  .feed-toggle{padding:1px 8px;border-radius:3px;font-size:10px;text-decoration:none;color:#8b949e;border:1px solid #21262d}
  .feed-toggle-active{color:#c9d1d9;background:#21262d;border-color:#30363d}
  .feed-badge{display:inline-block;padding:1px 7px;border-radius:10px;font-size:10px;font-weight:bold;text-transform:uppercase;letter-spacing:.04em}
  .feed-result{background:#0d2b0d;color:#3fb950}
  .feed-question{background:#3b2800;color:#e3b341}
  .feed-error{background:#2b0d0d;color:#f85149}
  .feed-task{background:#0d1b3e;color:#79c0ff}
  .feed-other{background:#21262d;color:#8b949e}
  .feed-time{color:#8b949e;font-size:11px;white-space:nowrap;width:80px}
  .feed-sender{color:#79c0ff;white-space:nowrap;max-width:140px;overflow:hidden;text-overflow:ellipsis}
  .feed-content{max-width:480px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .feed-chan{font-size:10px;color:#484f58;margin-left:6px}
  .feed-taskid{font-size:10px;color:#484f58;margin-left:8px}
  .feed-row-q td{background:#1a1400}
  .feed-row-q:hover td{background:#241c00 !important}
  .feed-taskid-col{font-size:10px;color:#484f58;white-space:nowrap;max-width:180px;overflow:hidden;text-overflow:ellipsis}
  .feed-arrow{color:#484f58;margin:0 2px}
  .feed-to{color:#e3b341}
  .timing-avg{color:#79c0ff;cursor:default}
  .idle-time{color:#8b949e}
  .ctx-fill{color:#79c0ff;font-size:10px;margin-left:4px}
  .ctx-fill-warn{color:#f0883e}
  .worker-model{color:#484f58;font-size:10px;margin-left:6px;vertical-align:middle}
  .chan-link{color:#c9d1d9;text-decoration:none}
  .chan-link:hover{color:#58a6ff;text-decoration:underline}
</style>
</head>
<body>
<h1>claude-broker <span style="font-size:13px;color:#8b949e;font-weight:normal">v${VERSION}</span></h1>
<div class="meta">uptime: ${uptime} &nbsp;·&nbsp; db: ${DB_PATH} &nbsp;·&nbsp; auth: <span class="${SHARED_SECRET ? "auth-on" : "auth-off"}">${SHARED_SECRET ? "on" : "OFF"}</span>${hasActions ? ` &nbsp;·&nbsp; workers: ${loadWorkerDefs().length} configured` : ""}${live ? ' &nbsp;·&nbsp; <span style="color:#3fb950">● live (30s)</span>' : ""}</div>

<div class="config">
  <div class="config-item"><span class="config-label">Auto-prune</span><span class="config-value">every ${PRUNE_INTERVAL_MS/60000}m · max age ${PRUNE_MAX_AGE_MS/3600000}h</span></div>
  <div class="config-item"><span class="config-label">Exempt</span><span class="config-value">${PRUNE_EXEMPT.join(", ") || "(none)"}</span></div>
  <div class="config-item"><span class="config-label">Channels${isAll ? "" : ` (${selectedNs})`}</span><span class="config-value">${channels.length} / ${allChannels.length}</span></div>
  <div class="config-item"><span class="config-label">Messages${isAll ? "" : ` (${selectedNs})`}</span><span class="config-value">${totalMsgs}</span></div>
  <div class="config-item"><span class="config-label">Schemas${isAll ? "" : ` (${selectedNs})`}</span><span class="config-value">${schemas.length} / ${allSchemas.length}</span></div>
  <div class="config-item"><span class="config-label">Projects</span><span class="config-value">${namespaces.join(", ") || "(none yet)"}</span></div>
</div>

${sprintInfos.length > 0 ? `
<div class="sprint-bar">
${sprintInfos.map(s => {
  const open   = Math.max(0, s.dispatched - s.completed);
  const pct    = s.dispatched > 0 ? Math.round((s.completed / s.dispatched) * 100) : 0;
  const nsTag  = isAll ? `<span style="font-size:10px;color:#8b949e;font-weight:normal;margin-left:6px">${escHtml(s.ns)}</span>` : "";
  return `<div class="sprint-card">
  <div class="sprint-name">${escHtml(s.slug)}${nsTag}</div>
  <div class="sprint-meta">started ${agoStr(s.startedAt)}</div>
  <div class="sprint-progress">
    <div class="sprint-stat"><span class="sprint-stat-val">${s.dispatched}</span><span class="sprint-stat-lbl">dispatched</span></div>
    <div class="sprint-stat"><span class="sprint-stat-val done">${s.completed}</span><span class="sprint-stat-lbl">completed</span></div>
    <div class="sprint-stat"><span class="sprint-stat-val open">${open}</span><span class="sprint-stat-lbl">open</span></div>
    ${s.failed > 0 ? `<div class="sprint-stat"><span class="sprint-stat-val fail">${s.failed}</span><span class="sprint-stat-lbl">failed</span></div>` : ""}
  </div>
  <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
</div>`;
}).join("\n")}
</div>` : ""}

<div class="tabs">
${tabs}
<a href="${tabHref(selectedNs, !live)}" class="live-btn ${live ? "live-on" : "live-off"}">${live ? "● Live" : "Live"}</a>
</div>

${questionsAlertHtml}
${totalCostToday > 0 ? `<div class="cost-bar">
  <span class="cost-bar-label">Today's spend</span>
  <span class="cost-bar-total">$${totalCostToday.toFixed(4)}</span>
  ${Object.entries(costByWorker).sort((a,b)=>b[1]-a[1]).map(([w,c])=>`<span class="cost-bar-worker"><span class="cost-bar-wname">${escHtml(w)}</span> $${c.toFixed(4)}</span>`).join("")}
  <a href="/cost${tokenParam ? "?" + tokenParam : ""}" class="cost-bar-link" target="_blank">JSON</a>
</div>` : ""}
${totalRlToday > 0 ? `<div class="cost-bar" style="border-color:#6e4c00">
  <span class="cost-bar-label" style="color:#e3b341">Rate limits today</span>
  <span class="cost-bar-total" style="color:#e3b341">${totalRlToday} hit${totalRlToday !== 1 ? "s" : ""}</span>
  ${Object.entries(rlByWorker).sort((a,b)=>b[1]-a[1]).map(([w,n])=>`<span class="cost-bar-worker"><span class="cost-bar-wname">${escHtml(w)}</span> ${n}×</span>`).join("")}
  <a href="/rate-limits${tokenParam ? "?" + tokenParam : ""}" class="cost-bar-link" target="_blank">JSON</a>
</div>` : ""}

<div class="section-hdr">
  Activity Feed ${nsLabel}
  <span class="section-hdr-controls">
    <a href="${feedHref(false)}" class="feed-toggle${feedSignalOnly ? " feed-toggle-active" : ""}">Signal</a>
    <a href="${feedHref(true)}" class="feed-toggle${!feedSignalOnly ? " feed-toggle-active" : ""}">All</a>
  </span>
</div>
${feedTableHtml}

<h2>Worker Liveness ${nsLabel}</h2>
${workers.length === 0
  ? `<div class="empty">No telemetry yet${isAll ? "" : ` for "${selectedNs}"`}. Workers emit heartbeats to <code>${isAll ? "*-telemetry" : telemetryChan}</code>.</div>`
  : `<table><thead><tr><th>Worker</th><th>State</th><th>Current Task</th><th>Cost</th><th>Avg Task Time</th><th>Idle Since</th><th>Inbox</th><th>Last Seen</th>${hasActions ? "<th>Actions</th>" : ""}</tr></thead><tbody>${workerRows}</tbody></table>`}

<h2>Channels ${nsLabel}</h2>
${channels.length === 0
  ? `<div class="empty">No channels${isAll ? " yet." : ` for "${selectedNs}".`}</div>`
  : `<table><thead><tr><th>Channel</th><th>Messages</th><th>Last ID</th><th>Last Activity</th><th>Last Message</th></tr></thead><tbody>${chanRows}</tbody></table>`}

<h2>Worker Capabilities ${nsLabel}</h2>
${caps.length === 0
  ? `<div class="empty">No capabilities registered${isAll ? ". Workers should call register_capability at startup." : ` for "${selectedNs}".`}</div>`
  : `<table><thead><tr><th>Worker</th><th>Owns</th><th>Channels</th><th>Registered</th></tr></thead><tbody>${capRows}</tbody></table>`}

<h2>Channel Schemas ${nsLabel}</h2>
${schemas.length === 0
  ? `<div class="empty">No schemas${isAll ? " registered." : ` for "${selectedNs}".`}</div>`
  : `<table><thead><tr><th>Channel</th><th>Mode</th><th>Version</th><th>Updated</th></tr></thead><tbody>${schemaRows}</tbody></table>`}

<p style="margin-top:24px;color:#484f58;font-size:11px">Refreshed at ${new Date().toISOString()} &nbsp;·&nbsp; <a href="${tabHref(selectedNs, live)}" style="color:#58a6ff">reload</a></p>
<script>
function workerAction(name, action) {
  const btn = event.target;
  btn.disabled = true;
  btn.textContent = action === 'start' ? 'Starting…' : 'Stopping…';
  const token = new URLSearchParams(location.search).get('token');
  fetch('/workers/' + encodeURIComponent(name) + '/' + action, { method: 'POST', headers: token ? { 'Authorization': 'Bearer ' + token } : {} })
    .then(r => r.json())
    .then(d => { if (d.ok) location.reload(); else { alert(d.error || 'Error'); btn.disabled = false; btn.textContent = action === 'start' ? 'Start' : 'Stop'; } })
    .catch(() => { alert('Request failed'); btn.disabled = false; });
}
</script>
</body></html>`);
});

// Channel message viewer
app.get("/dashboard/channel", dashboardAuth, (req, res) => {
  const channel = typeof req.query.name === "string" ? req.query.name : "";
  const backNs  = safeNs(req.query.ns);
  const limitRaw = parseInt(req.query.limit, 10);
  const limit   = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;
  const sinceRaw = parseInt(req.query.since_id, 10);
  const since   = Number.isFinite(sinceRaw) && sinceRaw >= 0 ? sinceRaw : 0;

  if (!channel) return res.status(400).send("channel required");

  const tokenParam = req.query.token ? `token=${encodeURIComponent(req.query.token)}` : "";
  const backHref = backNs === "all"
    ? `/dashboard${tokenParam ? "?" + tokenParam : ""}`
    : `/dashboard?ns=${backNs}${tokenParam ? "&" + tokenParam : ""}`;

  const rows      = stmtChanViewRows.all(channel, since, limit);
  const schemaRow = stmtSchemaGet.get(channel);
  const totalRow  = stmtChanCount.get(channel);

  const msgRows = rows.map(r => {
    let parsed = null;
    let contentHtml = "";
    try {
      parsed = JSON.parse(r.content);
      contentHtml = `<pre class="msg-json">${escHtml(JSON.stringify(parsed, null, 2))}</pre>`;
    } catch {
      contentHtml = `<pre class="msg-raw">${escHtml(r.content)}</pre>`;
    }
    const type = parsed?.type || null;
    let badgeClass = "feed-other";
    if      (type === "result")   badgeClass = "feed-result";
    else if (type === "question") badgeClass = "feed-question";
    else if (type === "error")    badgeClass = "feed-error";
    else if (type === "task")     badgeClass = "feed-task";
    else if (type === "heartbeat") badgeClass = "feed-other";
    const taskId = parsed?.task_id ? `<span class="msg-taskid">${escHtml(parsed.task_id)}</span>` : "";
    const typeBadge = type ? `<span class="feed-badge ${badgeClass}">${escHtml(type)}</span>` : "";
    return `<div class="msg-card${type === "question" ? " msg-card-q" : ""}">
  <div class="msg-card-hdr">
    <span class="msg-id">#${r.id}</span>
    ${typeBadge}
    <span class="msg-sender">${escHtml(r.sender)}</span>
    ${taskId}
    <span class="msg-time">${new Date(r.created_at).toISOString().replace("T"," ").slice(0,19)}</span>
  </div>
  ${contentHtml}
</div>`;
  }).join("\n");

  const schemaBadge = schemaRow
    ? (schemaRow.strict
        ? `<span class="badge badge-blue">strict</span>${schemaRow.version ? ` <span class="badge" style="background:#21262d;color:#8b949e">v${escHtml(schemaRow.version)}</span>` : ""}`
        : `<span class="badge badge-orange">warn</span>${schemaRow.version ? ` <span class="badge" style="background:#21262d;color:#8b949e">v${escHtml(schemaRow.version)}</span>` : ""}`)
    : '<span style="color:#484f58">no schema</span>';

  const olderHref = rows.length === limit
    ? `/dashboard/channel?name=${encodeURIComponent(channel)}&ns=${backNs}&limit=${limit}&since_id=${rows[rows.length-1].id - 1}${tokenParam ? `&${tokenParam}` : ""}`
    : null;

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(channel)} — claude-broker</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:ui-monospace,monospace;background:#0d1117;color:#c9d1d9;padding:24px;font-size:13px}
  .back{color:#58a6ff;text-decoration:none;font-size:12px}
  .back:hover{text-decoration:underline}
  h1{color:#c9d1d9;font-size:16px;margin:8px 0 4px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .chan-meta{color:#8b949e;font-size:12px;margin-bottom:20px}
  .msg-card{background:#161b22;border:1px solid #21262d;border-radius:6px;margin-bottom:10px;overflow:hidden}
  .msg-card-q{border-color:#6e4c00}
  .msg-card-hdr{display:flex;align-items:center;gap:10px;padding:8px 14px;border-bottom:1px solid #21262d;flex-wrap:wrap}
  .msg-id{color:#484f58;font-size:11px;min-width:50px}
  .msg-sender{color:#79c0ff;font-weight:bold}
  .msg-taskid{color:#484f58;font-size:11px;font-style:italic}
  .msg-time{color:#484f58;font-size:11px;margin-left:auto}
  .msg-json{padding:12px 14px;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-all;color:#c9d1d9;max-height:600px;overflow-y:auto}
  .msg-raw{padding:12px 14px;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-all;color:#8b949e}
  .badge{display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;margin-left:6px;vertical-align:middle}
  .badge-yellow{background:#6e4c00;color:#e3b341}
  .badge-blue{background:#0d419d;color:#79c0ff}
  .badge-orange{background:#5a3500;color:#f0883e}
  .feed-badge{display:inline-block;padding:1px 7px;border-radius:10px;font-size:10px;font-weight:bold;text-transform:uppercase;letter-spacing:.04em}
  .feed-result{background:#0d2b0d;color:#3fb950}
  .feed-question{background:#3b2800;color:#e3b341}
  .feed-error{background:#2b0d0d;color:#f85149}
  .feed-task{background:#0d1b3e;color:#79c0ff}
  .feed-other{background:#21262d;color:#8b949e}
  .empty{color:#484f58;font-style:italic;padding:20px 0}
  .pager{margin-top:16px;display:flex;gap:12px;align-items:center}
  .pager a{color:#58a6ff;font-size:12px;text-decoration:none}
  .pager a:hover{text-decoration:underline}
  .pager-info{color:#484f58;font-size:11px}
</style>
</head>
<body>
<a href="${backHref}" class="back">← back to dashboard</a>
<h1>${escHtml(channel)} ${schemaBadge}</h1>
<div class="chan-meta">${totalRow.n} total messages &nbsp;·&nbsp; showing last ${Math.min(rows.length, limit)}</div>
${rows.length === 0
  ? `<div class="empty">No messages on this channel yet.</div>`
  : msgRows}
${olderHref ? `<div class="pager"><a href="${escHtml(olderHref)}">← older messages</a><span class="pager-info">showing ${limit} of ${totalRow.n}</span></div>` : ""}
</body></html>`);
});

// Auth middleware
if (SHARED_SECRET) {
  app.use("/mcp", auth);
} else {
  console.warn("[claude-broker] WARNING: SHARED_SECRET is not set — broker is UNAUTHENTICATED (BROKER_ALLOW_NO_AUTH=1). Do not expose to any untrusted network.");
}

app.post("/mcp", async (req, res) => {
  // Disable socket inactivity timeout so long-polling tools (wait_for_messages up to 300s)
  // don't get dropped mid-call by Node.js's default socket timeout.
  req.socket.setTimeout(0);
  try {
    const server    = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[claude-broker] handler error:", err);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
});

const httpServer = app.listen(PORT, () => {
  console.log(`[claude-broker] v${VERSION} listening on :${PORT}  auth:${SHARED_SECRET ? "on" : "OFF"}  prune:${PRUNE_MAX_AGE_MS / 3600000}h  exempt:[${PRUNE_EXEMPT.join(",")}]`);
  console.log(`[claude-broker] dashboard: http://localhost:${PORT}/dashboard`);
});
// Disable server-level request timeout: long-poll tools can legitimately take up to 300s.
httpServer.requestTimeout = 0;

// ── Graceful shutdown ────────────────────────────────────────────────────────
// Close the listener, checkpoint the WAL, and close the DB so no data is lost and
// the -wal file doesn't grow unbounded across restarts.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[claude-broker] ${signal} received — shutting down`);
  httpServer.close(() => {
    try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* best effort */ }
    try { db.close(); } catch { /* already closed */ }
    console.log("[claude-broker] shutdown complete");
    process.exit(0);
  });
  // Force-exit if connections don't drain in time.
  setTimeout(() => {
    console.warn("[claude-broker] forced exit after timeout");
    try { db.pragma("wal_checkpoint(TRUNCATE)"); db.close(); } catch { /* best effort */ }
    process.exit(1);
  }, 10000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
