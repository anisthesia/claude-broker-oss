// REST endpoints: body parsing, hit counter, /health, /metrics, /inbox, /messages, /cursors, /namespaces/:ns/adopt, /verifications, /workers, /cost, /rate-limits.
import express from "express";
import { TELEMETRY_CHANNEL, RATE_LIMIT_CHANNEL, WORKERS_TMUX_SESSION, startedAt } from "./config.js";
import { auth, dashboardAuth, requestContext, orchestratorTokenOk, reservedSenderRefusal, orchestratorTrust, verifierTokenOk, verifierRequired, verifierTrust } from "./auth.js";
import { loadWorkerDefs, workerRunningInfo, startWorker, stopWorker } from "./workers.js";
import { metrics, stmtInsert, stmtChans, stmtHasMessages, stmtHasMessagesExcluding, stmtCostEndpointRows, stmtRlEndpointRows, stmtCursorList, stmtCursorSet, stmtCursorRewindChannel, stmtCursorRewindConsumer,
  stmtVerifyUpsert, stmtVerifyByResult, stmtVerifyByTask, stmtVerifyCandidates, stmtTrustedDispatch, stmtMsgGet, nsPrefixOf, messagesPerTask, idleChurn } from "./db.js";
import { validateContent } from "./validate.js";
import { isValidChannelName, messageBus, compactTelemetry, contentSizeError, holdRefusal } from "./messages.js";
import { handoffRewind } from "./cursors.js";
import { adoptNamespace } from "./adoption.js";
import { getNamespace } from "./namespaces.js";
import { app } from "./app.js";
import { planApproval, verificationVerdict, ENV_REASONS } from "./tools/sprint.js";

app.use(express.json({ limit: "1mb" }));

// Run the rest of the request (REST routes and /mcp tool handlers) in a context that records whether
// it presented the orchestrator credential (the message insert path reads it, lib/auth.js) and the URL's
// self-declared ?ns=&as= identity, with or without role= (holdRefusal reads it, lib/messages.js).
const queryName = (v) => (typeof v === "string" && v ? v : undefined);
app.use((req, _res, next) => requestContext.run({ orchestrator: orchestratorTokenOk(req.get("x-orchestrator-token")), ns: queryName(req.query?.ns), as: queryName(req.query?.as) }, next));

// Per-route hit counter (path only — no query strings, so tokens never land in metrics).
app.use((req, _res, next) => {
  const key = `${req.method} ${req.path.replace(/^\/workers\/[^/]+\//, "/workers/:name/")}`;
  metrics.http[key] = (metrics.http[key] || 0) + 1;
  next();
});

// orchestrator_trust: whether the orchestrator credential is enforced, and for which namespaces (docs/protocol-v3.md).
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now(), uptime_s: Math.floor((Date.now() - startedAt) / 1000), orchestrator_trust: orchestratorTrust(), verifier_trust: verifierTrust() }));

// messages_per_task and idle_churn scan weeks of messages, so each is computed at most once a minute.
const MPT_CACHE_S = 60;
function cachedMetric(fn) {
  let cache = null;
  return () => {
    if (cache && Date.now() - cache.at < MPT_CACHE_S * 1000) return cache.value;
    const t0 = Date.now(), m = fn(t0);
    cache = { at: t0, value: { ...m, compute_ms: Date.now() - t0, cache_s: MPT_CACHE_S, computed_at: new Date(t0).toISOString() } };
    return cache.value;
  };
}
const messagesPerTaskCached = cachedMetric(messagesPerTask);
const idleChurnCached = cachedMetric(idleChurn);

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
    cursor_reads: metrics.cursor_reads, tail_reads: metrics.tail_reads, cursor_rewinds: metrics.cursor_rewinds,
    guard_refusals: metrics.guard_refusals,
    tools,
    http: metrics.http,
    messages_per_task: messagesPerTaskCached(),
    idle_churn: idleChurnCached(),
  });
});

// Lightweight inbox pre-check — no Claude session needed.
// Returns {pending, count, max_id} so watchdog can avoid starting Claude when idle.
// Optional wait_ms (max 60000): long-poll — respond as soon as a message lands on the channel
// instead of making the watchdog sleep-and-retry. Response shape is identical.
// Optional exclude_sender (comma list): those senders' messages do not count toward pending/count
// (max_id still covers them) — the watchdog passes the worker's own names so its posts never wake it.
// A post by an excluded sender whose JSON 'from' names someone else still counts (see stmtHasMessagesExcluding).
app.get("/inbox", auth, (req, res) => {
  const { channel, since_id = "0" } = req.query;
  if (!channel || typeof channel !== "string") return res.status(400).json({ error: "channel required" });
  const sinceId = parseInt(since_id, 10);
  if (isNaN(sinceId)) return res.status(400).json({ error: "since_id must be numeric" });
  const waitMs = Math.min(Math.max(parseInt(req.query.wait_ms, 10) || 0, 0), 60000);
  const excluded = typeof req.query.exclude_sender === "string"
    ? [...new Set(req.query.exclude_sender.split(",").map((s) => s.trim()).filter(Boolean))] : [];
  const count = excluded.length
    ? () => stmtHasMessagesExcluding.get({ channel, since_id: sinceId, excluded: JSON.stringify(excluded) })
    : () => stmtHasMessages.get(channel, sinceId);
  const reply = () => {
    const row = count();
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
  const onMsg = () => { if (count().n > 0) finish(true); };
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
  const refusal = reservedSenderRefusal(channel, sender) ?? holdRefusal(channel, sender, contentStr);
  if (refusal) return res.status(403).json({ error: `refused on '${channel}': ${refusal}` });
  const tooBig = contentSizeError(contentStr);
  if (tooBig) return res.status(413).json({ error: `rejected on '${channel}': ${tooBig}` });
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
  handoffRewind(sender, contentStr);
  messageBus.emit(`msg:${channel}`, { id: row.lastInsertRowid, channel, sender, content: contentStr });
  const out = { id: row.lastInsertRowid, channel, sender };
  if (!check.ok && !check.strict) out.warn = `schema mismatch: ${check.errors}`;
  res.json(out);
});

// ── Server-side read cursors (REST) ───────────────────────────────────────────
// GET /cursors?worker=<name>            → that consumer's cursors
// PUT /cursors {channel, last_id, worker?} → rewind: lowers cursors above last_id on the channel
//   (every consumer, or just `worker`). The watchdog calls it before relaunching a session whose
//   predecessor took its inbox batch but never posted anything, so the retry sees the batch again.
//   Pass force:true to move a single worker's cursor forward as well.
app.get("/cursors", auth, (req, res) => {
  const { worker } = req.query;
  if (!worker || typeof worker !== "string") return res.status(400).json({ error: "worker required" });
  res.json({ worker, cursors: stmtCursorList.all(worker) });
});
app.put("/cursors", auth, (req, res) => {
  const { channel, last_id, worker, force } = req.body || {};
  const target = parseInt(last_id, 10);
  if (!channel || typeof channel !== "string" || isNaN(target) || target < 0)
    return res.status(400).json({ error: "channel and numeric last_id required" });
  const now = Date.now();
  let changed;
  if (worker && force) { stmtCursorSet.run(worker, channel, target, now); changed = 1; }
  else if (worker)     changed = stmtCursorRewindConsumer.run(target, now, worker, channel, target).changes;
  else                 changed = stmtCursorRewindChannel.run(target, now, channel, target).changes;
  if (changed) metrics.cursor_rewinds += changed;
  res.json({ channel, last_id: target, ...(worker ? { worker } : {}), rewound: changed });
});

// v3 adoption for a namespace (same as the admin-only adopt_namespace tool).
// Body: { dry_run?: bool, revert?: bool, admin_token?: string } (or an X-Admin-Token header).
// Adopt/revert: 403 without admin_token == ADMIN_SECRET, 503 when ADMIN_SECRET is unset; dry_run
// needs neither. 409 when the namespace has no registered manifest.
app.post("/namespaces/:ns/adopt", auth, async (req, res) => {
  const { dry_run, revert, admin_token } = req.body || {};
  try { res.json(await adoptNamespace(req.params.ns, { dry_run: dry_run === true, revert: revert === true, admin_token: admin_token ?? req.get("x-admin-token") })); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ── Harness-verified checks (verify-result.mjs) ──────────────────────────────
// A worker's result self-reports required_checks; the verifier re-runs the task's dispatch checks[]
// at the result's commit and stamps the outcome here. Checks come only from the dispatch message in
// a namespace inbox whose DB sender is the namespace orchestrator (manifest orchestrator-role
// worker, else "orchestrator") — never from the result body, which the worker writes.
function trustedOrchestrator(ns) {
  const m = ns ? getNamespace(ns) : null;
  if (m) for (const [name, w] of m.workers) if (w.role === "orchestrator") return name;
  return "orchestrator";
}
const shaOf = (body) => {
  const commits = Array.isArray(body?.commits) ? body.commits : [];
  const c = commits[commits.length - 1];
  return c && typeof c.sha === "string" ? c.sha : null;
};

// GET /verifications/pending?status_channel=<ns>-status&worker=<name>[&since_id=N][&result_id=N]
// result_id: exactly that result, even if already verified (a re-verify; POST /verifications keeps the old outcome in history).
// result_id with a worker who did not post it → 409 naming the sender (the verifier exits 1 rather than verify nothing).
// → { orchestrator, candidates: [{task_id, result_id, dispatch_id, dispatched_at, sender, sha, branch, plan_approved, checks}], skipped: [{task_id, result_id, reason}],
//     pool_full, pool_last_id }
// pool_full: the after-since_id pool hit its row cap (stmtVerifyCandidates LIMIT, already-verified rows included), so
// results after pool_last_id (the last row examined) were not looked at: a cursor must advance to pool_last_id, not further.
// Candidates: the latest result per task (after since_id, from `worker` when given) with body.commits, or
// with no commits and a summary starting PASS, not yet verified, whose trusted dispatch has a non-empty
// checks[]. sha is the last commit's, else null (verify the branch HEAD). sender is the result's DB sender; branch
// is where the sha must be (the dispatch's own top-level branch string if it names one, else worker/<sender>).
// plan_approved: null outside the plan gate, else whether the task's plan is approved (planApproval); the
// verifier fails an unapproved one without running its checks.
const VERIFY_POOL_LIMIT = 200; // = stmtVerifyCandidates LIMIT (lib/db.js)
app.get("/verifications/pending", auth, (req, res) => {
  const { status_channel, worker } = req.query;
  if (!status_channel || typeof status_channel !== "string") return res.status(400).json({ error: "status_channel required" });
  const sinceId = parseInt(req.query.since_id ?? "0", 10);
  if (isNaN(sinceId) || sinceId < 0) return res.status(400).json({ error: "since_id must be a non-negative integer" });
  const prefix = nsPrefixOf(status_channel);
  const orchestrator = trustedOrchestrator(prefix.slice(0, -1));
  const latest = new Map();
  const only = req.query.result_id === undefined ? null : parseInt(req.query.result_id, 10);
  if (only !== null && (isNaN(only) || only <= 0)) return res.status(400).json({ error: "result_id must be a positive integer" });
  const pool = only === null ? stmtVerifyCandidates.all(status_channel, sinceId) : stmtVerifyCandidates.all(status_channel, only - 1).filter(r => r.id === only);
  if (only !== null && !pool.length) return res.status(404).json({ error: `no type:result #${only} to verify on '${status_channel}' (needs body.commits, or a summary starting PASS)` });
  if (only !== null && worker && pool[0].sender !== worker)
    return res.status(409).json({ error: `result #${only} was posted by '${pool[0].sender}', not '${worker}'` });
  const manifest = getNamespace(prefix.slice(0, -1));
  for (const r of pool) {
    let p; try { p = JSON.parse(r.content); } catch { continue; }
    if (typeof p.task_id !== "string" || !p.task_id) continue;
    if (worker && r.sender !== worker) continue;
    latest.set(p.task_id, { r, p });
  }
  const candidates = [], skipped = [];
  for (const [task_id, { r, p }] of latest) {
    if (only === null && stmtVerifyByResult.get(status_channel, r.id)) continue;
    const d = stmtTrustedDispatch.get(prefix, orchestrator, task_id, r.id);
    if (!d) { skipped.push({ task_id, result_id: r.id, reason: `no dispatch from '${orchestrator}' in a ${prefix}* inbox` }); continue; }
    let task; try { task = JSON.parse(d.content); } catch { task = {}; }
    const checks = (Array.isArray(task.checks) ? task.checks : [])
      .filter(c => c && typeof c.run === "string" && c.run.trim())
      .map((c, i) => ({ name: typeof c.name === "string" && c.name ? c.name : `check-${i + 1}`, run: c.run,
                        ...(typeof c.pass_condition === "string" && { pass_condition: c.pass_condition }),
                        ...(Number.isInteger(c.timeout_s) && c.timeout_s > 0 && { timeout_s: c.timeout_s }) }));
    if (!checks.length) { skipped.push({ task_id, result_id: r.id, reason: "dispatch has no checks[]" }); continue; }
    const sha = shaOf(p.body);
    const gate = planApproval(manifest, status_channel, task_id);
    const branch = typeof task.branch === "string" && task.branch.trim() ? task.branch.trim() : `worker/${r.sender}`;
    candidates.push({ task_id, result_id: r.id, dispatch_id: d.id, dispatch_channel: d.channel, dispatched_at: new Date(d.created_at).toISOString(), sender: r.sender, sha, branch,
                      plan_approved: gate.required ? gate.approved : null, checks });
  }
  res.json({ status_channel, orchestrator, candidates, skipped,
             pool_full: only === null && pool.length >= VERIFY_POOL_LIMIT, pool_last_id: pool.length ? pool[pool.length - 1].id : null });
});

// POST /verifications { status_channel, result_id, dispatch_id?, sha?, checks: [{name, status: PASS|FAIL|ENV, env_reason?, exit_code, tail?, duration_ms?, timed_out?}] }
// Stores (or replaces) the verification of one result message. verified (verificationVerdict): true = every
// check PASS, false = any FAIL, null = the only non-PASS checks are ENV (the verifier's environment failed,
// not the commit). The column is NOT NULL, so it keeps 0 for an env-only run; readers derive null from checks.
// In a VERIFIER_TRUST_NAMESPACES namespace the request needs X-Verifier-Token (lib/auth.js verifierRequired), else 403.
app.post("/verifications", auth, (req, res) => {
  const { status_channel, result_id, dispatch_id, sha, checks } = req.body || {};
  const rid = parseInt(result_id, 10);
  if (!status_channel || typeof status_channel !== "string" || isNaN(rid))
    return res.status(400).json({ error: "status_channel and numeric result_id required" });
  const vns = verifierRequired(status_channel);
  if (vns && !verifierTokenOk(req.get("x-verifier-token")))
    return res.status(403).json({ error: `verifications in namespace '${vns}' (VERIFIER_TRUST_NAMESPACES) need an X-Verifier-Token header whose sha256 ` +
      `matches the broker's VERIFIER_TOKEN_SHA256 — only the standalone verifier (verify-result.mjs --watch) holds it` });
  if (!Array.isArray(checks) || checks.length === 0 || checks.length > 50)
    return res.status(400).json({ error: "checks must be a non-empty array (max 50)" });
  const row = stmtMsgGet.get(rid, status_channel);
  let p = null; try { p = row && JSON.parse(row.content); } catch {}
  if (!p || p.type !== "result" || typeof p.task_id !== "string")
    return res.status(404).json({ error: `no type:result #${rid} on '${status_channel}'` });
  const clean = [];
  for (const c of checks) {
    if (!c || typeof c.name !== "string" || !c.name || !["PASS", "FAIL", "ENV"].includes(c.status))
      return res.status(400).json({ error: "each check needs name and status PASS|FAIL|ENV" });
    if (c.status === "ENV" && !ENV_REASONS.includes(c.env_reason))
      return res.status(400).json({ error: `an ENV check needs env_reason ${ENV_REASONS.join("|")}` });
    clean.push({ name: c.name.slice(0, 120), status: c.status, ...(c.status === "ENV" && { env_reason: c.env_reason }), exit_code: Number.isInteger(c.exit_code) ? c.exit_code : null,
                 ...(c.timed_out === true && { timed_out: true }),
                 ...(Number.isFinite(c.duration_ms) && { duration_ms: Math.round(c.duration_ms) }),
                 ...(typeof c.tail === "string" && { tail: c.tail.slice(-2000) }) });
  }
  const verified = verificationVerdict(clean);
  const now = Date.now();
  const did = parseInt(dispatch_id, 10);
  // A re-verify replaces the row; the outcome it replaces moves into history (names and statuses, not tails).
  const prev = stmtVerifyByResult.get(status_channel, rid);
  let history = null;
  if (prev) {
    let h = []; try { h = prev.history ? JSON.parse(prev.history) : []; } catch {}
    const prevChecks = JSON.parse(prev.checks);
    h.push({ verified: verificationVerdict(prevChecks), sha: prev.sha, at: new Date(prev.created_at).toISOString(),
             checks: prevChecks.map(c => ({ name: c.name, status: c.status, ...(c.env_reason && { env_reason: c.env_reason }), exit_code: c.exit_code })) });
    history = JSON.stringify(h.slice(-10));
  }
  stmtVerifyUpsert.run(status_channel, p.task_id, rid, isNaN(did) ? null : did, typeof sha === "string" ? sha.slice(0, 64) : null,
                       verified === true ? 1 : 0, JSON.stringify(clean), now, history);
  res.json({ status_channel, task_id: p.task_id, result_id: rid, verified, checks: clean.map(c => ({ name: c.name, status: c.status, ...(c.env_reason && { env_reason: c.env_reason }) })),
             ...(prev && { replaced: { verified: verificationVerdict(JSON.parse(prev.checks)) } }) });
});

// GET /verifications?status_channel=&task_id= → every stored verification of the task, newest result first.
app.get("/verifications", auth, (req, res) => {
  const { status_channel, task_id } = req.query;
  if (!status_channel || !task_id || typeof status_channel !== "string" || typeof task_id !== "string")
    return res.status(400).json({ error: "status_channel and task_id required" });
  res.json({ status_channel, task_id, verifications: stmtVerifyByTask.all(status_channel, task_id).map(v => ({
    ...v, verified: verificationVerdict(JSON.parse(v.checks)), checks: JSON.parse(v.checks), history: v.history ? JSON.parse(v.history) : [], created_at: new Date(v.created_at).toISOString() })) });
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
