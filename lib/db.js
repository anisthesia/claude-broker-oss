// SQLite connection, schema migrations, in-memory metrics and every prepared statement.
import Database from "better-sqlite3";
import { DB_PATH } from "./config.js";

// ── DB setup ──────────────────────────────────────────────────────────────────

export const db = new Database(DB_PATH);
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
  CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

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

// Server-side read cursors: highest message id delivered to a consumer (worker) per channel through
// turn_start / read_messages / wait_for_messages when the caller omits since_id. A fresh headless
// session therefore resumes where its predecessor stopped instead of re-reading the channel from 0.
db.exec(`
  CREATE TABLE IF NOT EXISTS cursors (
    consumer    TEXT    NOT NULL,
    channel     TEXT    NOT NULL,
    last_id     INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (consumer, channel)
  );
`);

// ── Prepared statements ───────────────────────────────────────────────────────

export const metrics = {
  started_at: Date.now(),
  messages_inserted: 0,
  http: {},            // "METHOD /path" → count
  tools: {},           // name → { calls, errors, total_ms, max_ms }
  long_polls_active: 0,
  long_polls_total: 0,
  long_polls_woken: 0, // resolved by a message (vs timeout/abort)
  cursor_reads: 0,     // reads that resumed from a stored consumer cursor
  tail_reads: 0,       // reads with no since_id and no cursor → newest N
  cursor_rewinds: 0,   // cursor moved back (handoff status, PUT /cursors, worker_cursor set_to)
  guard_refusals: 0,   // destructive calls refused by the PRUNE_EXEMPT guards
};
export function metricTool(name, ms, isError) {
  const t = metrics.tools[name] || (metrics.tools[name] = { calls: 0, errors: 0, total_ms: 0, max_ms: 0 });
  t.calls++; if (isError) t.errors++; t.total_ms += ms; if (ms > t.max_ms) t.max_ms = ms;
}
const stmtInsertRaw    = db.prepare("INSERT INTO messages (channel, sender, content, created_at) VALUES (?, ?, ?, ?)");
// Write guards (channel, sender, content) → refusal text or null, installed by lib/auth.js (reserved
// orchestrator senders) and lib/messages.js (hold mode). Every message insert goes through stmtInsert,
// so a refusal here covers every MCP tool and REST path; the first refusal wins. Each call adds a guard.
const insertGuards = [];
export function setInsertGuard(fn) { insertGuards.push(fn); }
export class SenderRefusedError extends Error { constructor(msg) { super(msg); this.status = 403; } }
export const stmtInsert       = { run: (...a) => {
  let refusal = null;
  for (const g of insertGuards) if ((refusal = g(a[0], a[1], a[2]))) break;
  if (refusal) { metrics.guard_refusals++; throw new SenderRefusedError(refusal); }
  metrics.messages_inserted++; return stmtInsertRaw.run(...a);
} };
export const stmtSelect       = db.prepare("SELECT id, sender, content, created_at FROM messages WHERE channel = ? AND id > ? ORDER BY id ASC LIMIT ?");
export const stmtSelectFilter = db.prepare(`
  SELECT id, sender, content, created_at FROM messages
  WHERE channel = ? AND id > ?
  AND (? IS NULL OR sender = ?)
  AND (? IS NULL OR (json_valid(content) AND json_extract(content, '$.type') = ?))
  ORDER BY id ASC LIMIT ?
`);
const stmtSelectFilterMulti = new Map(); // keyed by "nSenders_hasType"

export function getMultiSenderStmt(nSenders, hasType) {
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
export const stmtDeleteOne    = db.prepare("DELETE FROM messages WHERE id = ? AND channel = ?");
export const stmtChans        = db.prepare("SELECT channel, COUNT(*) AS n, MAX(id) AS last_id, MAX(created_at) AS last_ts FROM messages GROUP BY channel ORDER BY channel");
export const stmtChansByPrefix = db.prepare("SELECT DISTINCT channel FROM messages WHERE channel LIKE ? ESCAPE '\\' ORDER BY channel");
export const stmtMsgSender     = db.prepare("SELECT sender FROM messages WHERE id = ? AND channel = ?");
export const stmtMsgGet        = db.prepare("SELECT id, sender, content, created_at FROM messages WHERE id = ? AND channel = ?");
export const escapeLike        = (s) => s.replace(/[\\%_]/g, (c) => "\\" + c);
export const stmtPurge        = db.prepare("DELETE FROM messages WHERE channel = ?");
export const stmtPruneOlder   = db.prepare("DELETE FROM messages WHERE channel = ? AND created_at < ?");
// Chatter (anything not a signal type, including non-JSON) at the short cutoff …
export const stmtPruneAllOld  = db.prepare(`
  DELETE FROM messages WHERE channel NOT IN (SELECT value FROM json_each(?)) AND created_at < ?
    AND NOT (json_valid(content) AND json_extract(content, '$.type') IN (SELECT value FROM json_each(?)))
`);
// … signal types at the long cutoff.
export const stmtPruneSignalOld = db.prepare(`
  DELETE FROM messages WHERE channel NOT IN (SELECT value FROM json_each(?)) AND created_at < ?
    AND json_valid(content) AND json_extract(content, '$.type') IN (SELECT value FROM json_each(?))
`);
export const stmtDeleteTransientHeartbeats = db.prepare(`
  DELETE FROM messages WHERE channel = ? AND sender = ? AND id != ?
    AND json_valid(content)
    AND COALESCE(json_extract(content, '$.activity.state'), json_extract(content, '$.state')) IN (SELECT value FROM json_each(?))
`);
export const stmtQuestions = db.prepare(`
  SELECT id, channel, sender, content, created_at FROM messages
  WHERE channel LIKE ? AND json_valid(content) AND json_extract(content, '$.type') = 'question'
  ORDER BY id ASC
`);
// A question is answered when something lands on the asker's inbox after it that names the
// task_id, or when the asker itself posts a result for that task_id (self-resolved).
export const stmtQuestionReply = db.prepare(`
  SELECT id, sender, created_at FROM messages
  WHERE channel = ? AND id > ?
    AND (json_extract(content, '$.task_id') = ? OR (? IS NOT NULL AND instr(content, ?) > 0))
  ORDER BY id ASC LIMIT 1
`);
// Answered from anywhere in the namespace: a later message whose ref_id is the question's id
// (an orchestrator reply on a side channel such as cb-assessment-reply), or a type:answer for
// the same task_id. A bare text mention of the id (a decision note citing #N) does not count.
export const stmtQuestionAnswerAnywhere = db.prepare(`
  SELECT id FROM messages
  WHERE channel LIKE ? AND id > ? AND json_valid(content)
    AND (CAST(json_extract(content, '$.ref_id') AS TEXT) = ?
         OR (? IS NOT NULL AND json_extract(content, '$.type') = 'answer' AND json_extract(content, '$.task_id') = ?))
  ORDER BY id ASC LIMIT 1
`);
export const stmtQuestionSelfResult = db.prepare(`
  SELECT id FROM messages
  WHERE channel LIKE ? AND id > ? AND sender = ?
    AND json_valid(content) AND json_extract(content, '$.type') = 'result' AND json_extract(content, '$.task_id') = ?
  LIMIT 1
`);
// summary must come from the newest result row (highest id), not a lexicographic MAX
// over summary strings — a stale 'PASS — ...' would shadow a later 'FAIL — ...'.
// SQLite guarantees bare columns resolve from the MAX(id) row when the query has a
// single min()/max() aggregate.
export const stmtCheckResult  = db.prepare(`
  SELECT COUNT(*) AS n,
         MAX(id) AS latest_id,
         json_extract(content, '$.summary') AS summary
  FROM messages WHERE channel = ? AND json_valid(content)
    AND json_extract(content, '$.task_id') = ? AND json_extract(content, '$.type') = 'result'
`);

export const stmtSchemaGet    = db.prepare("SELECT channel, schema, strict, updated_at, version FROM channel_schemas WHERE channel = ?");
export const stmtSchemaUpsert = db.prepare(`
  INSERT INTO channel_schemas (channel, schema, strict, updated_at, version) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(channel) DO UPDATE SET schema=excluded.schema, strict=excluded.strict, updated_at=excluded.updated_at, version=excluded.version
`);
export const stmtSchemaDel         = db.prepare("DELETE FROM channel_schemas WHERE channel = ?");
export const stmtSchemaList        = db.prepare("SELECT channel, strict, updated_at, version FROM channel_schemas ORDER BY channel");
export const stmtSchemaListPrefix  = db.prepare("SELECT channel, strict, updated_at, version FROM channel_schemas WHERE channel LIKE ? ORDER BY channel");

// v3 namespace manifests (lib/namespaces.js). One row per namespace prefix; hot-reloaded by updated_at.
db.exec(`
  CREATE TABLE IF NOT EXISTS namespaces (
    ns          TEXT    PRIMARY KEY,
    manifest    TEXT    NOT NULL,
    version     TEXT    DEFAULT NULL,
    updated_at  INTEGER NOT NULL
  );
`);
export const stmtNsStamp  = db.prepare("SELECT updated_at FROM namespaces WHERE ns = ?");
export const stmtNsGet    = db.prepare("SELECT ns, manifest, version, updated_at FROM namespaces WHERE ns = ?");
export const stmtNsList   = db.prepare("SELECT ns, version, updated_at, length(manifest) AS bytes FROM namespaces ORDER BY ns");
export const stmtNsUpsert = db.prepare(`
  INSERT INTO namespaces (ns, manifest, version, updated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(ns) DO UPDATE SET manifest=excluded.manifest, version=excluded.version, updated_at=excluded.updated_at
`);

// Per-namespace v3 adoption (lib/adoption.js): read by start_worker at spawn time, so flipping it
// needs no broker restart. `report` is the last adopt/revert's JSON report (entries, cursor copies).
db.exec(`
  CREATE TABLE IF NOT EXISTS namespace_adoption (
    ns          TEXT    PRIMARY KEY,
    adopted     INTEGER NOT NULL,
    adopted_at  INTEGER DEFAULT NULL,
    reverted_at INTEGER DEFAULT NULL,
    updated_at  INTEGER NOT NULL,
    report      TEXT    DEFAULT NULL
  );
`);
export const stmtAdoptGet    = db.prepare("SELECT ns, adopted, adopted_at, reverted_at, updated_at, report FROM namespace_adoption WHERE ns = ?");
export const stmtAdoptList   = db.prepare("SELECT ns, adopted, adopted_at, reverted_at, updated_at FROM namespace_adoption ORDER BY ns");
export const stmtAdoptUpsert = db.prepare(`
  INSERT INTO namespace_adoption (ns, adopted, adopted_at, reverted_at, updated_at, report) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(ns) DO UPDATE SET adopted=excluded.adopted, adopted_at=excluded.adopted_at,
    reverted_at=excluded.reverted_at, updated_at=excluded.updated_at, report=excluded.report
`);

// Harness-verified checks (verify-result.mjs → POST /verifications): the outcome of re-running a task's
// dispatch checks[] at the result's commit, stored beside the worker's message instead of in it.
// One row per (status channel, result message); get_task_ledger reads the row for the latest result.
db.exec(`
  CREATE TABLE IF NOT EXISTS verifications (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    status_channel TEXT    NOT NULL,
    task_id        TEXT    NOT NULL,
    result_id      INTEGER NOT NULL,
    dispatch_id    INTEGER DEFAULT NULL,
    sha            TEXT    DEFAULT NULL,
    verified       INTEGER NOT NULL,
    checks         TEXT    NOT NULL,
    created_at     INTEGER NOT NULL,
    UNIQUE (status_channel, result_id)
  );
  CREATE INDEX IF NOT EXISTS idx_verifications_task ON verifications(status_channel, task_id);
`);
// history: JSON array of the outcomes a re-verify (verify-result.mjs --result-id) replaced, oldest first.
try { db.exec("ALTER TABLE verifications ADD COLUMN history TEXT DEFAULT NULL"); } catch (_) {}
export const stmtVerifyUpsert = db.prepare(`
  INSERT INTO verifications (status_channel, task_id, result_id, dispatch_id, sha, verified, checks, created_at, history)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(status_channel, result_id) DO UPDATE SET task_id=excluded.task_id, dispatch_id=excluded.dispatch_id,
    sha=excluded.sha, verified=excluded.verified, checks=excluded.checks, created_at=excluded.created_at, history=excluded.history
`);
export const stmtVerifyByResult = db.prepare("SELECT id, task_id, result_id, dispatch_id, sha, verified, checks, created_at, history FROM verifications WHERE status_channel = ? AND result_id = ?");
export const stmtVerifyByTask   = db.prepare("SELECT id, task_id, result_id, dispatch_id, sha, verified, checks, created_at, history FROM verifications WHERE status_channel = ? AND task_id = ? ORDER BY result_id DESC");
export const stmtVerifyChannel  = db.prepare("SELECT id, task_id, result_id, verified, checks FROM verifications WHERE status_channel = ?");
// Verifier candidates on a status channel after since_id, oldest first: results that carry body.commits,
// and results with no commits (array empty or absent) whose summary starts with PASS — a no-code PASS is
// verified too when its dispatch has checks (rest.js keeps only those). FAIL/SKIP and reviewer verdicts
// (APPROVE/ADVISE/BLOCK, which never carry commits) are not.
export const stmtVerifyCandidates = db.prepare(`
  SELECT id, sender, content, created_at FROM messages
  WHERE channel = ? AND id > ? AND json_valid(content) AND json_extract(content, '$.type') = 'result'
    AND ((json_type(content, '$.body.commits') = 'array' AND json_array_length(content, '$.body.commits') > 0)
      OR substr(COALESCE(json_extract(content, '$.summary'), ''), 1, 4) = 'PASS')
  ORDER BY id ASC LIMIT 200
`);
// The first dispatch of task_id into any inbox of the namespace from the trusted sender, at or before
// the result being verified (id <= ?). Keyed on the DB sender column rather than the JSON 'from'. In a
// namespace listed in ORCHESTRATOR_TRUST_NAMESPACES that column is credential-bound for orchestrator
// names (lib/auth.js reservedSenderRefusal); elsewhere send_message takes sender= freely. Taking the
// first dispatch at or before the result means a later or re-posted copy cannot replace the real checks.
// Same meta-channel exclusions as stmtLedgerTasks. The first parameter is the raw '<ns>-' prefix, matched
// exact-case with instr(): LIKE is case-insensitive for ASCII, so 'CB-core' would count as a 'cb-' inbox, and
// the reserved-sender guard only covers the exact-case namespace (review-6 #1).
export const stmtTrustedDispatch = db.prepare(`
  SELECT id, channel, content, created_at FROM messages
  WHERE instr(channel, ?) = 1 AND sender = ?
    AND channel NOT LIKE '%-status' AND channel NOT LIKE '%-control'
    AND channel NOT LIKE '%-telemetry' AND channel NOT LIKE '%-backlog'
    AND channel NOT LIKE '%-sprint-retrospective' AND channel NOT LIKE '%-notes'
    AND json_valid(content) AND json_extract(content, '$.type') = 'task' AND json_extract(content, '$.task_id') = ?
    AND id <= ?
  ORDER BY id ASC LIMIT 1
`);
// Every dispatch of task_id into a namespace inbox from one of the senders in the JSON array bound second
// (the namespace's orchestrator names), oldest first — the plan gate reads scope / plan_required from them.
// First parameter: the raw '<ns>-' prefix, matched exact-case (see stmtTrustedDispatch).
export const stmtTaskDispatches = db.prepare(`
  SELECT id, channel, content FROM messages
  WHERE instr(channel, ?) = 1 AND sender IN (SELECT value FROM json_each(?))
    AND channel NOT LIKE '%-status' AND channel NOT LIKE '%-control'
    AND channel NOT LIKE '%-telemetry' AND channel NOT LIKE '%-backlog'
    AND channel NOT LIKE '%-sprint-retrospective' AND channel NOT LIKE '%-notes'
    AND json_valid(content) AND json_extract(content, '$.type') = 'task' AND json_extract(content, '$.task_id') = ?
  ORDER BY id ASC
`);
// The first message of a type on a channel (the plan gate's gate-live marker).
export const stmtFirstOfType = db.prepare(`
  SELECT MIN(id) AS id FROM messages WHERE channel = ? AND json_valid(content) AND json_extract(content, '$.type') = ?
`);

// One-shot migration: purge reg-* test debris
if (db.prepare("SELECT COUNT(*) AS n FROM channel_schemas WHERE channel LIKE 'reg-%'").get().n > 0) {
  db.prepare("DELETE FROM channel_schemas WHERE channel LIKE 'reg-%'").run();
}

export const stmtLatestPerSender = db.prepare(`
  SELECT m.id, m.sender, m.content, m.created_at
  FROM messages m
  INNER JOIN (
    SELECT sender, MAX(id) AS max_id FROM messages WHERE channel = ? GROUP BY sender
  ) latest ON m.id = latest.max_id
  ORDER BY m.sender
`);

// Latest row per sender that carries a cost figure — the newest heartbeat is often a cost-less
// watchdog "working" ping, so the dashboard's cost/context columns fall back to this one.
export const stmtLatestCostPerSender = db.prepare(`
  SELECT m.sender, m.content FROM messages m
  INNER JOIN (
    SELECT sender, MAX(id) AS max_id FROM messages
    WHERE channel = ? AND json_valid(content) AND json_extract(content, '$.cost_since_start.estimated_usd') IS NOT NULL
    GROUP BY sender
  ) latest ON m.id = latest.max_id
`);

export const stmtLatestMsgPerChannel = db.prepare(`
  SELECT m.channel, m.sender, m.content, m.created_at
  FROM messages m
  INNER JOIN (
    SELECT channel, MAX(id) AS max_id FROM messages GROUP BY channel
  ) latest ON m.channel = latest.channel AND m.id = latest.max_id
`);

// Sprint info: latest sprint-boundary note on a control channel
export const stmtSprintInfo = db.prepare(`
  SELECT content, created_at FROM messages
  WHERE channel = ?
    AND json_valid(content)
    AND json_extract(content, '$.type') = 'note'
    AND json_extract(content, '$.subject') LIKE 'sprint-%'
  ORDER BY id DESC LIMIT 1
`);

// Sprint progress: result/failed counts from the status channel.
// Dispatched count comes from stmtSprintDispatched (inbox channels) — tasks never appear on the status channel.
// One row per task_id, judged by its LATEST result: a retry that passes after a FAIL counts as
// completed, not as one completed and one failed; re-posted results never inflate "completed".
export const stmtSprintProgress = db.prepare(`
  WITH latest AS (
    SELECT json_extract(content, '$.task_id') AS task_id, MAX(id) AS max_id
    FROM messages
    WHERE channel = ? AND json_valid(content) AND json_extract(content, '$.type') = 'result'
    GROUP BY task_id
  )
  SELECT COUNT(*) AS completed,
         COALESCE(SUM(CASE WHEN json_extract(m.content, '$.summary') LIKE 'FAIL%' THEN 1 ELSE 0 END), 0) AS failed
  FROM latest l JOIN messages m ON m.id = l.max_id
`);

export const stmtHasMessages = db.prepare(
  "SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS max_id FROM messages WHERE channel = ? AND id > ?"
);
// GET /inbox exclude_sender: the excluded senders' messages do not count, but max_id still covers
// them so the caller's cursor moves past its own posts. @excluded = JSON array of sender names.
// A message is the caller's own only when its sender is excluded AND its envelope does not say
// otherwise: no JSON object content, no string 'from', or a 'from' that is excluded too. Sender names
// are not namespaced, so another fleet's 'core' posting {from:"dv-core"} to cb-core still wakes cb's core.
const FOREIGN_POST = `CASE
            WHEN sender NOT IN (SELECT value FROM json_each(@excluded)) THEN 1
            WHEN NOT json_valid(content) OR json_type(content, '$.from') IS NOT 'text' THEN 0
            WHEN json_extract(content, '$.from') IN (SELECT value FROM json_each(@excluded)) THEN 0
            ELSE 1 END`;
export const stmtHasMessagesExcluding = db.prepare(
  `SELECT COALESCE(SUM(${FOREIGN_POST}), 0) AS n, COALESCE(MAX(id), 0) AS max_id
   FROM messages WHERE channel = @channel AND id > @since_id`
);
// wait_for_messages exclude_self: how many of these rows (@ids = JSON array of ids) are not the caller's own, by the same rule.
export const stmtCountForeignIn = db.prepare(
  `SELECT COALESCE(SUM(${FOREIGN_POST}), 0) AS n FROM messages WHERE id IN (SELECT value FROM json_each(@ids))`
);

export const stmtDeleteOtherHeartbeats = db.prepare(
  "DELETE FROM messages WHERE channel = ? AND sender = ? AND id != ?"
);

// Cached per-N prepared statements for check_results_batch
const stmtBatchResultsCache = new Map();
export function getBatchResultsStmt(n) {
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
export const stmtChanViewRows = db.prepare(
  "SELECT id, sender, content, created_at FROM messages WHERE channel = ? AND id > ? ORDER BY id DESC LIMIT ?"
);
export const stmtChanCount = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE channel = ?");
export const stmtResultRowsSince = db.prepare(`
  SELECT sender, content FROM messages
  WHERE channel = ? AND id > ? AND json_valid(content) AND json_extract(content, '$.type') = 'result'
  ORDER BY id ASC
`);
export const stmtReadLast = db.prepare(
  "SELECT id, sender, content, created_at FROM messages WHERE channel = ? ORDER BY id DESC LIMIT ?"
);

// Count type:task messages dispatched into worker inboxes for a namespace (derived from status channel).
// Excludes meta-channels (status, control, telemetry, backlog, sprint-retrospective, notes).
export const stmtSprintDispatched = db.prepare(`
  SELECT COUNT(DISTINCT json_extract(content, '$.task_id')) AS n FROM messages
  WHERE channel LIKE ? ESCAPE '\\'
    AND channel NOT LIKE '%-status' AND channel NOT LIKE '%-control'
    AND channel NOT LIKE '%-telemetry' AND channel NOT LIKE '%-backlog'
    AND channel NOT LIKE '%-sprint-retrospective' AND channel NOT LIKE '%-notes'
    AND json_valid(content) AND json_extract(content, '$.type') = 'task'
`);
// LIKE pattern for the worker-inbox channels a status channel governs: "<ns>-%" for a
// namespaced channel, every channel for a bare "status". LIKE wildcards in the name are escaped.
export function escLike(s) { return String(s).replace(/[\\%_]/g, m => "\\" + m); }
export function sprintScopePattern(statusChannel) {
  if (!statusChannel.includes("-")) return "%";
  return `${escLike(statusChannel.slice(0, statusChannel.lastIndexOf("-")))}-%`;
}
// Namespace prefix a status channel belongs to: "cb-" for "cb-status", "" for a bare "status".
export function nsPrefixOf(statusChannel) {
  if (!statusChannel.includes("-")) return "";
  return statusChannel.slice(0, statusChannel.lastIndexOf("-") + 1);
}

// get_task_ledger: every type:task dispatched into the namespace's worker inboxes (same
// meta-channel exclusions as stmtSprintDispatched), oldest first.
export const stmtLedgerTasks = db.prepare(`
  SELECT id, channel, content, created_at FROM messages
  WHERE channel LIKE ? ESCAPE '\\' AND id > ?
    AND channel NOT LIKE '%-status' AND channel NOT LIKE '%-control'
    AND channel NOT LIKE '%-telemetry' AND channel NOT LIKE '%-backlog'
    AND channel NOT LIKE '%-sprint-retrospective' AND channel NOT LIKE '%-notes'
    AND json_valid(content) AND json_extract(content, '$.type') = 'task'
  ORDER BY id ASC
`);
// Latest row per task_id on a channel whose type is in the JSON array parameter.
export const stmtLedgerLatestByType = db.prepare(`
  WITH latest AS (
    SELECT json_extract(content, '$.task_id') AS task_id, MAX(id) AS max_id
    FROM messages
    WHERE channel = ? AND json_valid(content)
      AND json_extract(content, '$.type') IN (SELECT value FROM json_each(?))
      AND json_extract(content, '$.task_id') IS NOT NULL
    GROUP BY task_id
  )
  SELECT l.task_id, m.id, m.sender, m.content, m.created_at
  FROM latest l JOIN messages m ON m.id = l.max_id
`);

// Module-level prepared statements for /cost, /rate-limits, and dashboard (avoids inline prepare on each request).
// The REST rollups read the configured channel plus every namespaced sibling (<ns>-telemetry,
// <ns>-rate-limits), matching the dashboard's "all" view, so a multi-project broker is covered.
export const stmtCostEndpointRows = db.prepare(
  `SELECT sender, content, created_at FROM messages WHERE (channel = ? OR channel LIKE '%-telemetry') AND created_at >= ? ORDER BY id ASC`
);
export const stmtRlEndpointRows = db.prepare(
  `SELECT sender, content, created_at FROM messages WHERE (channel = ? OR channel LIKE '%-rate-limits') AND created_at >= ? ORDER BY id ASC`
);
export const stmtDashCostRows = db.prepare(
  `SELECT sender, content FROM messages WHERE (channel = ? OR channel LIKE '%-telemetry') AND created_at >= ? ORDER BY id ASC`
);
export const stmtDashRlRows = db.prepare(
  `SELECT sender, content FROM messages WHERE (channel = ? OR channel LIKE '%-rate-limits') AND created_at >= ? ORDER BY id ASC`
);
export const stmtDashChanRows = db.prepare(
  `SELECT sender, content FROM messages WHERE channel = ? AND created_at >= ? ORDER BY id ASC`
);

// Per-worker task timing: join dispatch (worker inbox) with result (status channel) on task_id
export const stmtWorkerTiming = db.prepare(`
  WITH dispatches AS (
    SELECT json_extract(content,'$.task_id') AS task_id,
           created_at AS dispatched_at,
           SUBSTR(channel, INSTR(channel,'-')+1) AS worker
    FROM messages
    WHERE json_valid(content) AND json_extract(content,'$.type') = 'task'
      AND channel NOT LIKE 'test%'
      AND channel NOT LIKE '%-status' AND channel NOT LIKE '%-telemetry'
      AND channel NOT LIKE '%-control' AND channel NOT LIKE '%-backlog'
      AND channel NOT LIKE '%-sprint-retrospective' AND channel NOT LIKE '%-notes'
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
export function getFeedStmt(nChannels, signalOnly) {
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

export const stmtCapUpsert = db.prepare(`
  INSERT INTO capabilities (worker, owns, channels, updated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(worker) DO UPDATE SET owns=excluded.owns, channels=excluded.channels, updated_at=excluded.updated_at
`);
export const stmtCapList   = db.prepare("SELECT worker, owns, channels, updated_at FROM capabilities ORDER BY worker");
export const stmtCapDel    = db.prepare("DELETE FROM capabilities WHERE worker = ?");

// ── Server-side read cursors ──────────────────────────────────────────────────
export const stmtCursorGet  = db.prepare("SELECT last_id FROM cursors WHERE consumer = ? AND channel = ?");
export const stmtCursorList = db.prepare("SELECT consumer, channel, last_id, updated_at FROM cursors WHERE consumer = ? ORDER BY channel");
export const stmtCursorSet  = db.prepare(`
  INSERT INTO cursors (consumer, channel, last_id, updated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(consumer, channel) DO UPDATE SET last_id = excluded.last_id, updated_at = excluded.updated_at
`);
export const stmtCursorAdvance = db.prepare(`
  INSERT INTO cursors (consumer, channel, last_id, updated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(consumer, channel) DO UPDATE SET last_id = MAX(cursors.last_id, excluded.last_id), updated_at = excluded.updated_at
`);
// Rewinds only ever lower a cursor (last_id > target), so a late rewind cannot skip messages.
export const stmtCursorRewindChannel  = db.prepare("UPDATE cursors SET last_id = ?, updated_at = ? WHERE channel = ? AND last_id > ?");
export const stmtCursorRewindConsumer = db.prepare("UPDATE cursors SET last_id = ?, updated_at = ? WHERE consumer = ? AND channel = ? AND last_id > ?");
// Latest dispatch of a task into any channel the consumer holds a cursor on (its inbox, in practice).
export const stmtTaskDispatchForConsumer = db.prepare(`
  SELECT id, channel FROM messages
  WHERE channel IN (SELECT channel FROM cursors WHERE consumer = ?)
    AND json_valid(content) AND json_extract(content, '$.type') = 'task' AND json_extract(content, '$.task_id') = ?
  ORDER BY id DESC LIMIT 1
`);
// Latest dispatch of task_id into one inbox (post_result copies its subject).
export const stmtTaskInInbox = db.prepare(`
  SELECT id, content FROM messages
  WHERE channel = ? AND json_valid(content) AND json_extract(content, '$.type') = 'task' AND json_extract(content, '$.task_id') = ?
  ORDER BY id DESC LIMIT 1
`);
// Tail / count statements per filter shape, mirroring fetchFiltered's WHERE clause.
const stmtTailCache = new Map();
export function tailStmts(nSenders, hasType) {
  const key = `${nSenders}_${hasType ? 1 : 0}`;
  if (!stmtTailCache.has(key)) {
    let where = "channel = ?";
    if (nSenders === 1) where += " AND sender = ?";
    else if (nSenders > 1) where += ` AND sender IN (${Array(nSenders).fill("?").join(",")})`;
    if (hasType) where += " AND json_valid(content) AND json_extract(content, '$.type') = ?";
    stmtTailCache.set(key, {
      start:  db.prepare(`SELECT MIN(id) AS id FROM (SELECT id FROM messages WHERE ${where} ORDER BY id DESC LIMIT ?)`),
      before: db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${where} AND id < ?`),
      after:  db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${where} AND id > ?`),
    });
  }
  return stmtTailCache.get(key);
}

// Messages per completed task, per namespace (channel prefix before the first '-') per ISO week, for
// the last 4 weeks (Monday 00:00 UTC). tasks_done = distinct task_ids with a PASS/FAIL/SKIP result on
// <ns>-status that week; ratio is null for a week with no done task. Read-only; /metrics caches it.
const WEEK_MS = 7 * 86400000;
const stmtMptMessages = db.prepare(`
  SELECT substr(channel, 1, instr(channel, '-') - 1) AS ns, CAST((created_at - @start) / ${WEEK_MS} AS INTEGER) AS wk, COUNT(*) AS n
  FROM messages WHERE created_at >= @start AND created_at < @end AND instr(channel, '-') > 1
  GROUP BY ns, wk`);
const stmtMptTasks = db.prepare(`
  SELECT substr(channel, 1, instr(channel, '-') - 1) AS ns, CAST((created_at - @start) / ${WEEK_MS} AS INTEGER) AS wk,
         COUNT(DISTINCT json_extract(content, '$.task_id')) AS n
  FROM messages WHERE created_at >= @start AND created_at < @end
    AND channel = substr(channel, 1, instr(channel, '-') - 1) || '-status'
    AND json_valid(content) AND json_extract(content, '$.type') = 'result'
    AND substr(json_extract(content, '$.summary'), 1, 4) IN ('PASS', 'FAIL', 'SKIP')
  GROUP BY ns, wk`);
function isoWeek(mondayMs) {
  const thu = new Date(mondayMs + 3 * 86400000), year = thu.getUTCFullYear();
  const week = Math.ceil(((thu - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}
export function messagesPerTask(now = Date.now()) {
  const d = new Date(now);
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - ((d.getUTCDay() + 6) % 7) * 86400000;
  const start = monday - 3 * WEEK_MS, end = monday + WEEK_MS;
  const weeks = [0, 1, 2, 3].map((i) => ({ week: isoWeek(start + i * WEEK_MS), start: new Date(start + i * WEEK_MS).toISOString().slice(0, 10) }));
  const namespaces = {};
  const row = (ns) => (namespaces[ns] ??= weeks.map((w) => ({ week: w.week, messages: 0, tasks_done: 0, ratio: null })));
  for (const r of stmtMptMessages.all({ start, end })) row(r.ns)[r.wk].messages = r.n;
  for (const r of stmtMptTasks.all({ start, end })) row(r.ns)[r.wk].tasks_done = r.n;
  for (const ws of Object.values(namespaces)) for (const w of ws) w.ratio = w.tasks_done ? Math.round((w.messages / w.tasks_done) * 100) / 100 : null;
  return { weeks, namespaces };
}

// Idle churn: per namespace, per sender, per UTC day for the last 7 days, {patrols, results, questions}.
// patrols = type:status whose subject contains 'patrol' or whose task_id ends in '-patrol'. A worker-day
// is flagged when patrols >= 10 and results + questions == 0: it is waking and reporting, not working.
const DAY_MS = 86400000;
export const IDLE_CHURN_MIN_PATROLS = 10;
const stmtIdleChurn = db.prepare(`
  SELECT ns, sender, day,
         SUM(t = 'status' AND (instr(lower(subj), 'patrol') > 0 OR tid LIKE '%-patrol')) AS patrols,
         SUM(t = 'result') AS results, SUM(t = 'question') AS questions
  FROM (SELECT substr(channel, 1, instr(channel, '-') - 1) AS ns, sender, CAST((created_at - @start) / ${DAY_MS} AS INTEGER) AS day,
               json_extract(content, '$.type') AS t, coalesce(json_extract(content, '$.subject'), '') AS subj,
               coalesce(json_extract(content, '$.task_id'), '') AS tid
        FROM messages WHERE created_at >= @start AND created_at < @end AND instr(channel, '-') > 1 AND json_valid(content))
  WHERE t IN ('status', 'result', 'question')
  GROUP BY ns, sender, day`);
export function idleChurn(now = Date.now()) {
  const d = new Date(now);
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const start = today - 6 * DAY_MS, end = today + DAY_MS;
  const days = [0, 1, 2, 3, 4, 5, 6].map((i) => new Date(start + i * DAY_MS).toISOString().slice(0, 10));
  const namespaces = {}, flagged = [];
  for (const r of stmtIdleChurn.all({ start, end })) {
    if (!r.patrols && !r.results && !r.questions) continue;
    const isFlagged = r.patrols >= IDLE_CHURN_MIN_PATROLS && r.results + r.questions === 0;
    ((namespaces[r.ns] ??= {})[r.sender] ??= []).push({ day: days[r.day], patrols: r.patrols, results: r.results, questions: r.questions, flagged: isFlagged });
    if (isFlagged) flagged.push({ ns: r.ns, sender: r.sender, day: days[r.day], patrols: r.patrols });
  }
  return { days, min_patrols: IDLE_CHURN_MIN_PATROLS, namespaces, flagged };
}
