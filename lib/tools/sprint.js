// MCP tools: open questions, task ledger, sprint summary and file-conflict detection.
import { z } from "zod";
import { db, stmtSprintInfo, stmtSprintProgress, stmtResultRowsSince, stmtSprintDispatched, escLike, sprintScopePattern, nsPrefixOf, stmtLedgerTasks, stmtLedgerLatestByType, stmtVerifyChannel, stmtTaskDispatches, stmtFirstOfType } from "../db.js";
import { scanOpenQuestions } from "../messages.js";
import { getNamespace } from "../namespaces.js";
import { orchestratorNames } from "../auth.js";
import { nsOf } from "../util.js";

// ── Plan gate (docs/protocol-v3.md "Plan gate") ───────────────────────────────
// A worker posts type:plan to <ns>-status (post_plan); the orchestrator answers with type:plan-decision
// on the worker's inbox (decide_plan), so the watchdog relaunches the worker when it lands.

export const stmtLatestPlan = db.prepare(`
  SELECT id, channel, sender, content, created_at FROM messages
  WHERE channel = ? AND json_valid(content) AND json_extract(content, '$.type') = 'plan' AND json_extract(content, '$.task_id') = ?
  ORDER BY id DESC LIMIT 1
`);
// Latest plan-decision per task_id across a namespace's channels (they land on worker inboxes), from
// one of the senders in the JSON array bound second (the namespace's orchestrator names). Every namespace
// query here binds the raw '<ns>-' prefix and matches it exact-case with instr(), never LIKE (which is
// case-insensitive, so a decision posted on 'CB-core' would count as one on a 'cb-' inbox).
const stmtLatestDecisions = db.prepare(`
  WITH latest AS (
    SELECT json_extract(content, '$.task_id') AS task_id, MAX(id) AS max_id
    FROM messages
    WHERE instr(channel, ?) = 1 AND sender IN (SELECT value FROM json_each(?))
      AND json_valid(content) AND json_extract(content, '$.type') = 'plan-decision'
      AND json_extract(content, '$.task_id') IS NOT NULL
    GROUP BY task_id
  )
  SELECT l.task_id, m.id, m.channel, m.sender, m.content, m.created_at
  FROM latest l JOIN messages m ON m.id = l.max_id
`);
// Latest plan per task_id on every status channel of a namespace ('<ns>-status', '<ns>-<cluster>-status').
const stmtLatestPlans = db.prepare(`
  WITH latest AS (
    SELECT channel, json_extract(content, '$.task_id') AS task_id, MAX(id) AS max_id
    FROM messages
    WHERE instr(channel, ?) = 1 AND channel LIKE '%-status' AND json_valid(content)
      AND json_extract(content, '$.type') = 'plan' AND json_extract(content, '$.task_id') IS NOT NULL
    GROUP BY channel, task_id
  )
  SELECT l.task_id, m.id, m.channel, m.sender, m.content, m.created_at
  FROM latest l JOIN messages m ON m.id = l.max_id ORDER BY m.id ASC
`);
// Latest plan-decision for one task_id under a namespace prefix from the senders bound second (JSON array).
const stmtLatestDecisionFor = db.prepare(`
  SELECT id, channel, sender, content, created_at FROM messages
  WHERE instr(channel, ?) = 1 AND sender IN (SELECT value FROM json_each(?))
    AND json_valid(content) AND json_extract(content, '$.type') = 'plan-decision' AND json_extract(content, '$.task_id') = ?
  ORDER BY id DESC LIMIT 1
`);
const stmtResultAfter = db.prepare(`
  SELECT 1 FROM messages
  WHERE channel = ? AND id > ? AND json_valid(content) AND json_extract(content, '$.type') = 'result' AND json_extract(content, '$.task_id') = ?
  LIMIT 1
`);

const DECISIONS = ["approve", "amend", "reject"];
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

// task_id → latest plan-decision under prefix. Only the orchestrator decides: a decision counts when its
// DB sender is one of the namespace's orchestrator names (lib/auth.js orchestratorNames; credential-bound
// in ORCHESTRATOR_TRUST_NAMESPACES), so a peer worker's decision under its own name is ignored and cannot
// hide an earlier real one. A decision whose sender is also the plan's author is ignored by the callers.
function decisionOf(r) {
  if (!r) return null;
  const body = parse(r.content)?.body;
  const decision = body && typeof body === "object" ? body.decision : undefined;
  if (!DECISIONS.includes(decision)) return null;
  return { id: r.id, channel: r.channel, sender: r.sender, decision, waiver: body.waiver === true, at: new Date(r.created_at).toISOString() };
}
export function latestDecisions(prefix) {
  const out = new Map();
  for (const r of stmtLatestDecisions.all(prefix, JSON.stringify([...orchestratorNames(nsOf(prefix))]))) {
    const d = decisionOf(r);
    if (d) out.set(r.task_id, d);
  }
  return out;
}

// ── Verification verdict (verify-result.mjs → POST /verifications → ledger) ────
// A check is PASS, FAIL, or ENV (the verifier's environment failed it, with env_reason). true = all PASS,
// false = any FAIL, null = the only non-PASS checks are ENV: unverified, to re-run with --result-id.
// commit-missing: the result's sha is not in the verifier's --repo (a clone that does not share the workers' objects).
export const ENV_REASONS = ["node-abi", "syntax-error", "command-not-found", "cross-branch", "commit-missing"];
export const verificationVerdict = (checks) =>
  checks.some(c => c.status === "FAIL") ? false : checks.every(c => c.status === "PASS") ? true : null;

// ── Plan verdict: one rule for the ledger, post_result and the verifier ────────
// plan_required is the latest dispatch's explicit value, else true for scope medium|large — except for a
// task addressed to a reviewer-role worker, which needs an explicit plan_required: true (reviews have no plan step).
export const planRequired = ({ explicit, scope, role }) =>
  explicit ?? (role !== "reviewer" && (scope === "medium" || scope === "large"));
// A result an unapproved planned task may still post: the worker must be able to say it cannot proceed.
export const allowedUnapproved = (summary) => /^(FAIL|SKIP|BLOCK)\b/.test(typeof summary === "string" ? summary : "");

// The state of one gated task's plan. plan: the latest type:plan {id, sender} or null; decision: the latest
// orchestrator plan-decision (decisionOf) or null; author: whoever may not decide it (the plan's sender, else
// the task's worker); lastDispatchId: the newest dispatch of the task.
//   planning     no plan yet, or the last decision was amend
//   plan-review  a plan newer than any decision
//   approved     approve newer than the latest plan, or an approve with body.waiver: true for a task with no plan
//   rejected     a reject is terminal until the orchestrator re-dispatches (a newer dispatch); plans posted
//                before that re-dispatch are void
export function planVerdict({ plan, decision, author, lastDispatchId }) {
  let d = decision && decision.sender !== author ? decision : null;
  if (d?.decision === "reject" && lastDispatchId != null && lastDispatchId > d.id) {
    d = null;
    if (plan && plan.id < lastDispatchId) plan = null;
  }
  if (d?.decision === "reject") return { state: "rejected", plan, decided: d };
  const decided = d && (!plan || d.id > plan.id) ? d : null;
  if (plan && !decided) return { state: "plan-review", plan, decided: null };
  if (decided?.decision === "approve" && (plan || decided.waiver)) return { state: "approved", plan, decided };
  return { state: "planning", plan, decided };
}

// Gate-live marker: the first type:plan on the status channel. A task first dispatched before it predates the
// gate and is never refused or marked unapproved, so history is not rewritten. For cb-status the marker is
// #185384 (protocol-qa's plan for cb-2026-10-29-retro-quality). Cached once found (it only moves on a purge).
const gateLive = new Map();
export function gateLiveId(status_channel) {
  if (!gateLive.has(status_channel)) {
    const id = stmtFirstOfType.get(status_channel, "plan")?.id ?? null;
    if (id == null) return null;
    gateLive.set(status_channel, id);
  }
  return gateLive.get(status_channel);
}

// The plan gate for one task as post_result and the verifier see it, from the trusted (orchestrator-sent)
// dispatches only. m: the namespace manifest (getNamespace). → { required: false } outside the gate, else
// { required: true, approved, state, plan_id, decision }.
export function planApproval(m, status_channel, task_id) {
  if (!m?.planGate) return { required: false };
  const prefix = `${m.ns}-`;
  const dispatches = stmtTaskDispatches.all(prefix, JSON.stringify([...orchestratorNames(m.ns)]), task_id);
  const live = gateLiveId(status_channel);
  if (!dispatches.length || live == null || dispatches[0].id < live) return { required: false };
  const first = parse(dispatches[0].content) ?? {};
  let explicit;
  for (const r of dispatches) { const p = parse(r.content); if (typeof p?.plan_required === "boolean") explicit = p.plan_required; }
  const worker = typeof first.to === "string" && first.to && first.to !== "*" ? first.to : dispatches[0].channel.slice(prefix.length);
  if (!planRequired({ explicit, scope: first.scope, role: m.workers.get(worker)?.role })) return { required: false };
  const planRow = stmtLatestPlan.get(status_channel, task_id);
  const plan = planRow ? { id: planRow.id, sender: planRow.sender } : null;
  const decision = decisionOf(stmtLatestDecisionFor.get(prefix, JSON.stringify([...orchestratorNames(m.ns)]), task_id));
  const v = planVerdict({ plan, decision, author: plan?.sender ?? worker, lastDispatchId: dispatches.at(-1).id });
  return { required: true, approved: v.state === "approved", state: v.state, plan_id: v.plan?.id ?? null,
           decision: v.decided ? { id: v.decided.id, decision: v.decided.decision, ...(v.decided.waiver && { waiver: true }) } : null };
}

// Plans with no later decision and no result: what the orchestrator still has to review.
export function scanOpenPlans(prefix, max_age_ms) {
  const now = Date.now();
  const decisions = latestDecisions(prefix);
  const open = [];
  let decided = 0;
  for (const r of stmtLatestPlans.all(prefix)) {
    if (max_age_ms && now - r.created_at > max_age_ms) continue;
    const p = parse(r.content) ?? {};
    const from = typeof p.from === "string" && p.from ? p.from : r.sender;
    const d = decisions.get(r.task_id);
    if ((d && d.id > r.id && d.sender !== r.sender) || stmtResultAfter.get(r.channel, r.id, r.task_id)) { decided++; continue; }
    const body = p.body && typeof p.body === "object" ? p.body : {};
    open.push({
      id: r.id, channel: r.channel, task_id: r.task_id, from, subject: typeof p.subject === "string" ? p.subject : null,
      approach: typeof body.approach === "string" ? (body.approach.length > 160 ? body.approach.slice(0, 160) + "…" : body.approach) : null,
      steps: Array.isArray(body.steps) ? body.steps.length : 0,
      files_write: Array.isArray(body.files?.write) ? body.files.write : [],
      open_questions: Array.isArray(body.open_questions) ? body.open_questions.length : 0,
      posted_at: new Date(r.created_at).toISOString(),
      age_min: Math.round((now - r.created_at) / 60000),
      // the decision this plan supersedes (an amend), if any
      previous_decision: d ? { id: d.id, decision: d.decision } : null,
    });
  }
  return { open, decided };
}

export function registerSprintTools(server) {
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
    const { open, answered } = scanOpenQuestions(prefix, max_age_ms);
    return { content: [{ type: "text", text: JSON.stringify({ prefix, open, open_count: open.length, answered_count: answered }) }] };
  });

  // ── get_task_ledger ──────────────────────────────────────────────────────────
  // The orchestrator role files keep a "task ledger" (task_id → worker/status/blockers) in
  // context and rebuild it from message archaeology after every rotation. This derives it
  // server-side in three indexed scans so a fresh orchestrator session starts from the
  // current state instead of re-reading the status channel from id 0.
  server.registerTool("get_task_ledger", {
    title: "Derive the task ledger for a namespace",
    description: "Joins every type:task dispatched into the namespace's worker inboxes against the latest result, latest status/handoff and any open question per task_id, and returns one row per task with a derived state: pending (dispatched, nothing heard), in-progress (worker posted a status), handoff (worker rotated mid-task and left handoff notes), blocked (open question), done / failed / skipped (by the latest result's summary prefix). Results whose task was never dispatched (or whose dispatch was pruned) are included with dispatched_at null. Use at orchestrator turn-start instead of rebuilding the ledger from read_messages; pass only_open=true to skip finished tasks.",
    inputSchema: {
      status_channel: z.string().min(1).describe("The namespace's status channel, e.g. 'cb-status'. Inboxes are every '<ns>-*' channel except the meta channels."),
      since_id:       z.number().int().nonnegative().default(0).describe("Only consider tasks dispatched with message id > this. Default 0 (whole history)."),
      only_open:      z.boolean().default(false).describe("Omit done / failed / skipped tasks. Default false."),
      prefix:         z.string().optional().describe("Namespace prefix for the inbox and question scan, e.g. 'dv-'. Default: derived from status_channel. Cluster orchestrators whose status channel is '<ns>-<cluster>-status' must pass '<ns>-' or their workers' inboxes are not found."),
      workers:        z.array(z.string().min(1)).max(100).optional().describe("Only include tasks for these workers (matched against the task's 'to' or the inbox suffix). Cluster orchestrators pass their own workers."),
    },
  }, async ({ status_channel, since_id, only_open, prefix: prefixOpt, workers }) => {
    const prefix   = prefixOpt ?? nsPrefixOf(status_channel);
    const pattern  = prefixOpt ? `${escLike(prefixOpt)}%` : sprintScopePattern(status_channel);
    const workerSet = workers && workers.length ? new Set(workers) : null;
    const tasks    = new Map();
    // Plan gate only where the namespace's manifest enables it; elsewhere rows, states and counts are as before it.
    const manifest = getNamespace(prefix.replace(/-$/, ""));
    const planGate = !!manifest?.planGate;
    const explicitPlan = new Map(); // task_id → plan_required as dispatched (true|false), latest dispatch wins
    const lastDispatch = new Map(); // task_id → newest dispatch id (a re-dispatch reopens a rejected plan)
    const clip     = (v) => typeof v === "string" && v.length > 160 ? v.slice(0, 160) + "…" : v;

    for (const r of stmtLedgerTasks.all(pattern, since_id ?? 0)) {
      let p; try { p = JSON.parse(r.content); } catch { continue; }
      const taskId = typeof p.task_id === "string" && p.task_id ? p.task_id : null;
      if (!taskId) continue;
      const worker = typeof p.to === "string" && p.to && p.to !== "*" ? p.to : r.channel.slice(prefix.length);
      if (workerSet && !workerSet.has(worker) && !workerSet.has(r.channel.slice(prefix.length))) continue;
      if (typeof p.plan_required === "boolean") explicitPlan.set(taskId, p.plan_required);
      lastDispatch.set(taskId, r.id);
      const prev = tasks.get(taskId);
      if (prev) { prev.dispatch_count++; continue; }
      tasks.set(taskId, {
        task_id: taskId, worker, subject: clip(p.subject ?? null),
        scope: typeof p.scope === "string" ? p.scope : null,
        depends_on: Array.isArray(p.depends_on) && p.depends_on.length ? p.depends_on : null,
        dispatch_id: r.id, dispatched_at: new Date(r.created_at).toISOString(), dispatch_count: 1,
        state: "pending", summary: null, result_id: null, completed_at: null, verified: null,
        last_status: null, open_question: null,
      });
    }

    for (const r of stmtLedgerLatestByType.all(status_channel, JSON.stringify(["result"]))) {
      let p; try { p = JSON.parse(r.content); } catch { continue; }
      let t = tasks.get(r.task_id);
      if (!t) {
        const w = typeof p.from === "string" ? p.from : r.sender;
        if (workerSet && !workerSet.has(w)) continue;
        t = { task_id: r.task_id, worker: w, subject: clip(p.subject ?? null),
              scope: null, depends_on: null, dispatch_id: null, dispatched_at: null, dispatch_count: 0,
              state: "pending", summary: null, result_id: null, completed_at: null, verified: null, last_status: null, open_question: null };
        tasks.set(r.task_id, t);
      }
      const summary = typeof p.summary === "string" ? p.summary : "";
      t.state = summary.startsWith("FAIL") ? "failed" : summary.startsWith("SKIP") ? "skipped" : "done";
      t.summary = clip(summary) || null;
      t.result_id = r.id;
      t.completed_at = new Date(r.created_at).toISOString();
    }

    // Harness verification of the latest result (verify-result.mjs, docs/protocol-v3.md): verified is
    // true|false|null (verificationVerdict), and a failed one overrides a self-reported PASS. An env-only
    // run (verification_env: the ENV check names) keeps the worker's state and verified null; only_open
    // still lists it, so a self-reported PASS behind a broken verifier stays in sight until re-verified.
    // Not in the tool description: the no-role tools/list is pinned byte-identical to v2 (test-role-profiles.js).
    const verifications = new Map(stmtVerifyChannel.all(status_channel).map(v => [v.result_id, v]));
    for (const t of tasks.values()) {
      const v = t.result_id != null ? verifications.get(t.result_id) : null;
      if (!v) continue;
      let checks = []; try { checks = JSON.parse(v.checks); } catch {}
      t.verified = verificationVerdict(checks);
      if (t.verified === true) continue;
      const env = checks.filter(c => c.status === "ENV").map(c => c.name);
      if (env.length) t.verification_env = env;
      if (t.verified === null) continue;
      t.verification_failed = checks.filter(c => c.status === "FAIL").map(c => c.name);
      if (t.state === "done") t.state = "failed";
    }

    for (const r of stmtLedgerLatestByType.all(status_channel, JSON.stringify(["status", "handoff"]))) {
      const t = tasks.get(r.task_id);
      if (!t) continue;
      let p; try { p = JSON.parse(r.content); } catch { continue; }
      const handoff = p.type === "handoff" || (p.body && typeof p.body === "object" && p.body.handoff_notes != null);
      t.last_status = { id: r.id, from: typeof p.from === "string" ? p.from : r.sender, subject: clip(p.subject ?? null),
                        at: new Date(r.created_at).toISOString(), handoff };
      // A status only moves a task that has no result yet; it never shadows a result.
      if (t.result_id == null) t.state = handoff ? "handoff" : "in-progress";
    }

    // Plan gate (gated namespaces only): plan_required is the latest dispatched value, else true for scope
    // medium|large (not for a reviewer's task) — derived here so dispatch_task never writes the key unasked
    // (planRequired). A task that requires a plan, or one its worker posted a plan for, follows planVerdict:
    // planning → plan-review → in-progress on approve / failed on reject (terminal until re-dispatched).
    // A question still blocks; a handoff newer than the last decision stays handoff so the relaunched
    // session sees its notes. A result wins, except that a result a gated task may not post unapproved
    // (anything but FAIL|SKIP|BLOCK, e.g. a raw send_message PASS) is failed with plan_unapproved: true —
    // only for tasks dispatched after the gate-live marker (gateLiveId).
    // States and the plan fields are not in the tool description (no-role tools/list is pinned).
    const plans = planGate ? new Map(stmtLedgerLatestByType.all(status_channel, JSON.stringify(["plan"])).map(r => [r.task_id, r])) : new Map();
    if (planGate) for (const t of tasks.values()) {
      t.plan_required = t.dispatch_id != null
        ? planRequired({ explicit: explicitPlan.get(t.task_id), scope: t.scope, role: manifest.workers.get(t.worker)?.role })
        : (explicitPlan.get(t.task_id) ?? false);
    }
    const gated = planGate ? [...tasks.values()].filter(t => t.plan_required || plans.has(t.task_id)) : [];
    const decisions = gated.length ? latestDecisions(prefix) : new Map();
    const live = gated.length ? gateLiveId(status_channel) : null;
    for (const t of gated) {
      const plan = plans.get(t.task_id) ?? null;
      const v = planVerdict({ plan: plan && { id: plan.id, sender: plan.sender }, decision: decisions.get(t.task_id) ?? null,
                              author: plan?.sender ?? t.worker, lastDispatchId: lastDispatch.get(t.task_id) ?? null });
      const decided = v.decided;
      t.plan = plan ? { id: plan.id, at: new Date(plan.created_at).toISOString(),
                        decision: decided ? { id: decided.id, decision: decided.decision, at: decided.at, ...(decided.waiver && { waiver: true }) } : null } : null;
      if (t.result_id != null) {
        if (t.plan_required && v.state !== "approved" && !allowedUnapproved(t.summary)
            && live != null && t.dispatch_id != null && t.dispatch_id >= live) {
          t.state = "failed";
          t.plan_unapproved = true;
        }
        continue;
      }
      // Not required, and its only plan was voided by a re-dispatch: an ordinary task again.
      if (!t.plan_required && !v.plan) continue;
      if (v.state === "plan-review") t.state = "plan-review";
      else if (v.state === "rejected") t.state = "failed";
      else if (v.state === "approved") { if (t.state === "pending") t.state = "in-progress"; }
      else if (!(t.state === "handoff" && t.last_status.id > (decided?.id ?? 0))) t.state = "planning";
    }

    for (const q of scanOpenQuestions(prefix, undefined).open) {
      if (!q.task_id) continue;
      const t = tasks.get(q.task_id);
      if (!t) continue;
      t.open_question = { id: q.id, from: q.from, subject: clip(q.subject), age_min: q.age_min, expected_reply_channel: q.expected_reply_channel };
      if (t.result_id == null && t.state !== "failed") t.state = "blocked";
    }

    const counts = planGate
      ? { total: 0, pending: 0, planning: 0, "plan-review": 0, "in-progress": 0, handoff: 0, blocked: 0, done: 0, failed: 0, skipped: 0 }
      : { total: 0, pending: 0, "in-progress": 0, handoff: 0, blocked: 0, done: 0, failed: 0, skipped: 0 };
    const rows = [];
    for (const t of tasks.values()) {
      counts.total++; counts[t.state]++;
      if (only_open && (t.state === "done" || t.state === "failed" || t.state === "skipped") && !(t.verified === null && t.verification_env)) continue;
      rows.push(t);
    }
    rows.sort((a, b) => (a.dispatch_id ?? a.result_id ?? 0) - (b.dispatch_id ?? b.result_id ?? 0));
    // The orchestrator's review queue, open_questions-style: plans on this channel with no later decision
    // and no result (a field rather than its own tool, to keep the orchestrator tools/list in budget).
    const out = { status_channel, prefix, workers: workers ?? null, counts, tasks: rows };
    if (planGate) out.plans_awaiting_decision = plans.size
      ? scanOpenPlans(prefix).open.filter(pl => pl.channel === status_channel && (!workerSet || workerSet.has(pl.from)))
      : [];
    return { content: [{ type: "text", text: JSON.stringify(out) }] };
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
    const dispatched = stmtSprintDispatched.get(sprintScopePattern(status_channel)).n;
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
}
