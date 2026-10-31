#!/usr/bin/env node
// Orchestration loop: the deterministic part of an orchestrator's turn, run as code instead of
// re-executed by a model every turn (docs/protocol-v3.md "Orchestration loop").
//
//   node runner/orchestrate.mjs --ns <ns> [--once] [--interval-ms 15000] [--state <file>] [--dry-run]
//                               [--max-starts-per-hour 3] [--start-cooldown-ms 120000]
//                               [--model <worker>=<id>]... [--reviewer reviewer] [--since-id <id>]
//                               [--sender orchestrator] [--review-head <ref>] [--review-base main] [--force-ns]
//
// Each tick reads the broker (get_task_ledger, open_questions, <ns>-held, GET /workers), computes the
// actions as a pure function of that snapshot + the state file (planActions), then applies them:
//   release  a task parked on <ns>-held (type held-task, envelope in body.task) is posted verbatim to its
//            inbox once every depends_on task has a done/skipped result (depends_on entries may carry the
//            documented ':worker' suffix; a dependency outside the sprint window is looked up in the whole
//            ledger), and a held-release record (schemas/cb-held.json) is written to <ns>-held. Only a held-task whose DB sender and
//            content.from (and task.from) are the configured --sender is released, and only to a known worker
//            inbox of this namespace (`${ns}-${task.to}`, which body.inbox may only repeat); any other is never
//            released and wakes the orchestrator instead: a worker cannot launder a dispatch through the loop
//   start    a stopped worker with an open ledger row (pending/in-progress/handoff/planning) is started,
//            at most --max-starts-per-hour per worker and not within --start-cooldown-ms of the last start
//   review   once every task dispatched since the last sprint-close review is done/skipped, one review
//            task goes to <ns>-<reviewer> — only with an explicit --review-head (or ORCHESTRATION_LOOP_REVIEW_HEAD):
//            without one the loop wakes the orchestrator with "ready for review" and dispatches nothing
//   wake     a decision only the orchestrator can take: an open question, a plan awaiting decision, a
//            FAIL/BLOCK (or harness-failed) result, an APPROVE/ADVISE on a sprint-close review (merge
//            approval), a start backoff, a release the broker rejected, a held-task refused, a sprint ready
//            for review with no review head
// A wake is written to stdout as one JSON line, posted as a type:note to <ns>-orchestrator, recorded in
// the state file (never surfaced twice), and the loop exits 0: the orchestrator's background shell
// returns and its session takes the decision. The loop never merges, purges, stops a worker, restarts
// the broker, decides a plan or answers a question. No LLM call is made here.
//
// Opt-in: refuses (exit 2) unless --ns is listed in ORCHESTRATION_LOOP_NAMESPACES or --force-ns is given.
// Broker: BROKER_URL (base URL, a trailing /mcp is accepted) + BROKER_SECRET (else SHARED_SECRET).
// ORCHESTRATOR_TOKEN, when set, is sent as X-Orchestrator-Token so a broker that reserves the
// orchestrator sender (ORCHESTRATOR_TRUST_NAMESPACES) accepts the loop's releases and reviews.
// State: --state, default ~/.claude-broker/orchestrate-<ns>.json (mode 600).
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const LOOP_SENDER = "orchestration-loop";
const OPEN_STATES = new Set(["pending", "in-progress", "handoff", "planning"]);
const FINISHED_OK = new Set(["done", "skipped"]);
const HOUR = 3600_000;
const DEFAULT_CHECKLIST = ["Secrets", "File ownership", "Test coverage", "No force-push markers", "No TODO/FIXME blocking"];

export const isReviewTask = (taskId) => /-review-sprint-close(-\d+)?$/.test(taskId || "");
// depends_on entries are 'task_id' or the documented 'task_id:worker' (task ids never contain ':').
export const depTaskId = (d) => String(d).split(":")[0];
const clip = (s, n) => (s = String(s ?? "")).length > n ? s.slice(0, n - 1) + "…" : s;

// ── Broker client ─────────────────────────────────────────────────────────────

export function brokerBase(url) {
  return String(url || "http://localhost:8080").replace(/\/+$/, "").replace(/\/mcp$/, "");
}

// MCP (v2 tools, no role) for messages and the ledger; REST for the worker list and starts.
// `contacted` holds every origin this client reached, so tests can prove nothing else was touched.
export async function connectBroker({ url, secret, orchestratorToken }) {
  const base = brokerBase(url);
  const headers = { ...(secret ? { Authorization: `Bearer ${secret}` } : {}), ...(orchestratorToken ? { "X-Orchestrator-Token": orchestratorToken } : {}) };
  const contacted = new Set([new URL(base).origin]);
  const client = new Client({ name: LOOP_SENDER, version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? "";
    if (r.isError) { const e = new Error(`${name}: ${text}`); e.toolError = true; throw e; }
    return text;
  };
  const json = async (name, args) => JSON.parse(await call(name, args));
  const rest = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, {
      method, headers: { ...headers, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  };
  return {
    base, contacted,
    ledger: (ns, since_id) => json("get_task_ledger", { status_channel: `${ns}-status`, since_id }),
    openQuestions: (ns) => json("open_questions", { prefix: `${ns}-` }),
    checkResult: (ns, task_id) => json("check_result", { channel: `${ns}-status`, task_id }),
    maxId: (channel) => json("has_messages", { channel, since_id: 0 }).then(r => r.max_id ?? 0),
    readHeld: async (ns, since_id) => parseRows(await call("read_messages", {
      channel: `${ns}-held`, filter_type: "held-task", limit: 500, ...(since_id > 0 ? { since_id } : {}),
    })),
    send: async (channel, sender, content) => {
      const text = await call("send_message", { channel, sender, content: JSON.stringify(content) });
      const m = /^Sent #(\d+)/.exec(text);
      return { id: m ? Number(m[1]) : null, text };
    },
    workers: async () => { const r = await rest("GET", "/workers"); return Array.isArray(r.data) ? r.data : []; },
    startWorker: (name, model) => rest("POST", `/workers/${encodeURIComponent(name)}/start`, model ? { model } : {}),
    close: () => client.close().catch(() => {}),
  };
}

// read_messages text → [{id, sender, content}] (content parsed as JSON when it is JSON).
export function parseRows(text) {
  const rows = [];
  for (const line of String(text).split("\n")) {
    const m = /^\[#(\d+)\] \S+ <([^>]*)>: (.*)$/.exec(line);
    if (m) rows.push({ id: Number(m[1]), sender: m[2], raw: m[3] });
    else if (rows.length && line && !line.startsWith("(next since_id")) rows[rows.length - 1].raw += "\n" + line;
  }
  return rows.map(r => { let content = null; try { content = JSON.parse(r.raw); } catch {} return { id: r.id, sender: r.sender, content }; });
}

// ── State ─────────────────────────────────────────────────────────────────────

export const defaultStatePath = (ns) => join(homedir(), ".claude-broker", `orchestrate-${ns}.json`);

export function loadState(file) {
  if (!file || !existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8"));
}

export function saveState(file, state) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

// First run: the sprint marker is the latest sprint-close review dispatch (tasks before it belong to a
// reviewed sprint), and results already on the status channel never wake. --since-id overrides both.
export async function initState(broker, ns, sinceId) {
  const state = { ns, sprint_marker: 0, last_review: null, result_baseline: 0, held_seen: 0, held: {}, surfaced: [], starts: {}, released: [], reviews: [] };
  if (sinceId != null) { state.sprint_marker = sinceId; state.result_baseline = sinceId; return state; }
  const full = await broker.ledger(ns, 0);
  for (const t of full.tasks) if (isReviewTask(t.task_id) && t.dispatch_id != null && t.dispatch_id > state.sprint_marker) {
    state.sprint_marker = t.dispatch_id; state.last_review = t.task_id;
  }
  state.result_baseline = await broker.maxId(`${ns}-status`);
  return state;
}

// ── Snapshot + pure planning ──────────────────────────────────────────────────

// The ledger window starts at the sprint marker; a held task may depend on one finished in an earlier
// sprint, so dependencies missing from the window are resolved against the whole ledger (depRows).
export async function snapshot(broker, ns, state) {
  const [ledger, questions, workers, held] = await Promise.all([
    broker.ledger(ns, Math.max(0, (state.sprint_marker || 0) - 1)),
    broker.openQuestions(ns),
    broker.workers(),
    broker.readHeld(ns, state.held_seen || 0),
  ]);
  const inWindow = new Set((ledger.tasks || []).map(r => r.task_id));
  const tasks = [...Object.values(state.held || {}).map(h => h.task), ...held.map(m => m.content?.body?.task)];
  const missing = new Set();
  for (const t of tasks) for (const d of Array.isArray(t?.depends_on) ? t.depends_on : []) if (!inWindow.has(depTaskId(d))) missing.add(depTaskId(d));
  const depRows = {};
  if (missing.size) for (const r of (await broker.ledger(ns, 0)).tasks || []) if (missing.has(r.task_id)) depRows[r.task_id] = r;
  return { now: Date.now(), ledger, questions: questions.open || [], workers: workers.filter(w => w.ns === ns), held, depRows };
}

// The ledger names a worker by the task's `to` (or the inbox suffix); the config by its entry name.
export function workerDefFor(worker, defs, ns) {
  const inboxOf = (d) => { const a = d.args || []; const i = a.indexOf("--inbox-channel"); return i >= 0 ? a[i + 1] : null; };
  return defs.find(d => inboxOf(d) === `${ns}-${worker}`) || defs.find(d => d.name === worker) || defs.find(d => d.name === `${ns}-${worker}`) || null;
}

// Inboxes of this namespace's configured workers (GET /workers entries with ns === ns).
export function knownInboxes(defs, ns) {
  const out = new Set();
  for (const d of defs || []) {
    const a = d.args || []; const i = a.indexOf("--inbox-channel");
    const inbox = i >= 0 ? a[i + 1] : (String(d.name).startsWith(`${ns}-`) ? d.name : `${ns}-${d.name}`);
    if (typeof inbox === "string" && inbox.startsWith(`${ns}-`)) out.add(inbox);
  }
  return out;
}

// Why a held-task may not be released (null = it may). The release is posted as the orchestrator, so it
// must have come from the orchestrator (DB sender, the field send_message stores; and the envelope's from)
// and may only go to a known worker inbox of this namespace.
export function heldRefusal(h, cfg, inboxes) {
  const t = h.task || {};
  if (h.sender !== cfg.sender) return `sender '${h.sender ?? "?"}' is not the orchestrator '${cfg.sender}'`;
  if (h.from !== cfg.sender) return `held-task from '${h.from ?? "?"}' is not the orchestrator '${cfg.sender}'`;
  if (t.from !== cfg.sender) return `task.from '${t.from ?? "?"}' is not the orchestrator '${cfg.sender}'`;
  if (typeof t.to !== "string" || !/^[a-z0-9][a-z0-9_.-]*$/i.test(t.to)) return `task.to ${JSON.stringify(t.to ?? null)} is not a worker name`;
  const inbox = `${cfg.ns}-${t.to}`;
  if (h.inbox != null && h.inbox !== inbox) return `body.inbox '${clip(h.inbox, 80)}' is not ${inbox}`;
  if (!inboxes.has(inbox)) return `${inbox} is not a known worker inbox of ${cfg.ns}`;
  return null;
}

// Returns { held, actions, sprint_marker, last_review }: `held` is the pending held queue after this snapshot
// and the sprint fields the marker it saw (state to carry), `actions` what to do. Pure: no I/O, no clock beyond snap.now.
export function planActions(snap, state, cfg) {
  const { ns } = cfg;
  const rows = snap.ledger.tasks || [];
  const byTask = new Map(rows.map(r => [r.task_id, r]));
  const depRow = (d) => byTask.get(depTaskId(d)) ?? snap.depRows?.[depTaskId(d)];
  const surfaced = new Set(state.surfaced || []);
  const actions = [];
  const wake = (key, w) => { if (!surfaced.has(key)) { surfaced.add(key); actions.push({ kind: "wake", key, wake: { ns, ...w } }); } };

  // Held queue: carried entries + new held-task messages (keyed by the parked task_id). Every entry is
  // (re)checked against heldRefusal before release, so a state file written by an older loop cannot bypass it.
  const held = { ...(state.held || {}) };
  const inboxes = knownInboxes(snap.workers, ns);
  const refuse = (h, why) => wake(`held-refused:${h.held_id}`, {
    wake: "held-refused", id: h.held_id, task_id: h.task?.task_id ?? null, channel: `${ns}-held`,
    line: `held-task #${h.held_id} (${clip(h.task?.task_id ?? "?", 80)}) not released: ${why}`,
  });
  for (const m of snap.held) {
    const t = m.content?.body?.task;
    if (m.content?.type !== "held-task" || !t || typeof t.task_id !== "string") continue;
    if ((state.released || []).includes(t.task_id)) continue;
    const h = { held_id: m.id, sender: m.sender, from: m.content.from, inbox: m.content.body.inbox ?? null, task: t };
    const why = heldRefusal(h, cfg, inboxes);
    if (why) { refuse(h, why); continue; }
    held[t.task_id] = h;
  }
  for (const [taskId, h] of Object.entries(held)) {
    if (byTask.get(taskId)?.dispatch_id != null) { delete held[taskId]; continue; } // dispatched by hand meanwhile
    const why = heldRefusal(h, cfg, inboxes);
    if (why) { delete held[taskId]; refuse(h, why); continue; }
    const deps = Array.isArray(h.task.depends_on) ? h.task.depends_on : [];
    if (deps.every(d => FINISHED_OK.has(depRow(d)?.state) && depRow(d)?.result_id != null)) {
      actions.push({ kind: "release", task_id: taskId, held_id: h.held_id, inbox: `${ns}-${h.task.to}`, envelope: h.task,
                     depends_on: deps.map(d => ({ task_id: depTaskId(d), result_id: depRow(d).result_id })) });
    }
  }

  // Decisions.
  for (const q of snap.questions) wake(`question:${q.id}`, {
    wake: "question", id: q.id, task_id: q.task_id ?? null, channel: q.channel ?? null,
    line: `question #${q.id} from ${q.from} on ${q.task_id ?? "(no task)"}: ${clip(q.subject, 100)}`,
  });
  for (const p of snap.ledger.plans_awaiting_decision || []) wake(`plan:${p.id}`, {
    wake: "plan", id: p.id, task_id: p.task_id, channel: p.channel,
    line: `plan #${p.id} from ${p.from} on ${p.task_id} awaits decide_plan`,
  });
  for (const r of rows) {
    if (r.result_id == null || r.result_id <= (state.result_baseline || 0)) continue;
    const s = r.summary || "";
    if (r.state === "failed" || /^(FAIL|BLOCK)/.test(s)) wake(`result:${r.result_id}`, {
      wake: "result", id: r.result_id, task_id: r.task_id, channel: `${ns}-status`,
      line: `result #${r.result_id} on ${r.task_id} from ${r.worker}: ${clip(s, 140)}${r.verification_failed ? ` (harness failed: ${r.verification_failed.join(", ")})` : ""}`,
    });
    else if (isReviewTask(r.task_id) && /^(APPROVE|ADVISE)/.test(s)) wake(`merge:${r.result_id}`, {
      wake: "merge-approval", id: r.result_id, task_id: r.task_id, channel: `${ns}-status`,
      line: `sprint-close review ${r.task_id} ${s.split(/\s/)[0]}: merge needs your approval — ${clip(s, 120)}`,
    });
  }

  // Start / relaunch.
  const started = new Set();
  for (const r of rows) {
    if (r.dispatch_id == null || !OPEN_STATES.has(r.state)) continue;
    const def = workerDefFor(r.worker, snap.workers, ns);
    if (!def || def.running || started.has(def.name)) continue;
    started.add(def.name);
    const history = (state.starts?.[def.name] || []).filter(ts => snap.now - ts < HOUR);
    if (history.length && snap.now - history[history.length - 1] < cfg.startCooldownMs) continue;
    if (history.length >= cfg.maxStartsPerHour) {
      wake(`backoff:${def.name}:${history[0]}`, {
        wake: "start-backoff", id: null, task_id: r.task_id, channel: r.worker ? `${ns}-${r.worker}` : null,
        line: `${def.name} started ${history.length}x in the last hour and is stopped again with ${r.task_id} ${r.state}: not starting it again`,
      });
      continue;
    }
    actions.push({ kind: "start", worker: def.name, model: cfg.models?.[def.name] || cfg.models?.[r.worker] || def.model || null, task_id: r.task_id });
  }

  // Sprint close: every task dispatched after the marker finished, nothing still held, last review answered.
  // A review the orchestrator dispatched by hand (the no-review-head path) moves the marker like the loop's own.
  let sprintMarker = state.sprint_marker || 0, lastReview = state.last_review || null;
  for (const r of rows) if (isReviewTask(r.task_id) && r.dispatch_id != null && r.dispatch_id > sprintMarker) {
    sprintMarker = r.dispatch_id; lastReview = r.task_id;
  }
  const sprint = rows.filter(r => r.dispatch_id != null && r.dispatch_id > sprintMarker && !isReviewTask(r.task_id));
  const lastReviewOpen = lastReview && byTask.get(lastReview)?.result_id == null;
  if (sprint.length && sprint.every(r => FINISHED_OK.has(r.state)) && !Object.keys(held).length && !lastReviewOpen && !cfg.reviewHead) {
    // Worker commits sit on worker/* branches until someone names the branch to review: never guess one.
    const last = Math.max(...sprint.map(r => r.dispatch_id));
    wake(`ready-for-review:${last}`, {
      wake: "ready-for-review", id: last, task_id: null, channel: `${ns}-status`,
      line: `sprint ready for review: every task since #${sprintMarker} has a result (${clip(sprint.map(r => r.task_id).join(", "), 300)}); no --review-head set, so no review was dispatched — build the review branch and dispatch it`,
    });
  } else if (sprint.length && sprint.every(r => FINISHED_OK.has(r.state)) && !Object.keys(held).length && !lastReviewOpen) {
    const date = new Date(snap.now).toISOString().slice(0, 10);
    const base = `${ns}-${date}-review-sprint-close`;
    const taken = new Set([...(state.reviews || []), ...rows.map(r => r.task_id)]);
    let taskId = base;
    for (let n = 2; taken.has(taskId); n++) taskId = `${base}-${n}`;
    actions.push({
      kind: "review", task_id: taskId, inbox: `${ns}-${cfg.reviewer}`,
      envelope: {
        type: "task", task_id: taskId, from: cfg.sender, to: cfg.reviewer, subject: "Sprint close review",
        context: `Dispatched by the orchestration loop: every task since #${sprintMarker} has a result (${sprint.map(r => r.task_id).join(", ")}).`,
        body: { base: cfg.reviewBase || "main", head: cfg.reviewHead, checklist: cfg.checklist || DEFAULT_CHECKLIST },
      },
    });
  }
  return { held, actions, sprint_marker: sprintMarker, last_review: lastReview };
}

// ── Apply ─────────────────────────────────────────────────────────────────────

// The held-release record (schemas/cb-held.json) for a posted release: which held-task went where, when.
export function releaseRecord(a, messageId, cfg, now = new Date()) {
  const subject = typeof a.envelope?.subject === "string" && a.envelope.subject.length >= 3 ? a.envelope.subject : null;
  return {
    type: "held-release", task_id: a.task_id, from: LOOP_SENDER, to: a.envelope?.to ?? cfg.sender,
    ...(subject && { subject }), released_at: now.toISOString(), target_channel: a.inbox,
    body: { held_id: a.held_id, message_id: messageId, released_as: cfg.sender, depends_on: a.depends_on ?? [] },
  };
}

// Applies actions in order (releases, starts, review, then wakes), mutating state. Returns the wakes.
export async function applyActions(broker, actions, state, cfg) {
  const wakes = [];
  const surface = async (key, w) => {
    if ((state.surfaced ||= []).includes(key)) return;
    state.surfaced.push(key);
    wakes.push(w);
    try {
      await broker.send(`${cfg.ns}-orchestrator`, LOOP_SENDER, {
        type: "note", task_id: w.task_id || `${cfg.ns}-orchestration-loop`, from: LOOP_SENDER, to: "orchestrator",
        subject: clip(`loop wake: ${w.wake}${w.task_id ? ` ${w.task_id}` : ""}`, 120), body: w.line,
      });
    } catch (e) { w.note_error = clip(e.message, 300); }
  };
  const order = { release: 0, start: 1, review: 2, wake: 3 };
  for (const a of [...actions].sort((x, y) => order[x.kind] - order[y.kind])) {
    if (a.kind === "release") {
      try {
        const r = await broker.send(a.inbox, cfg.sender, a.envelope);
        (state.released ||= []).push(a.task_id);
        delete state.held[a.task_id];
        log(`released ${a.task_id} → ${a.inbox} #${r.id}`);
        try { await broker.send(`${cfg.ns}-held`, LOOP_SENDER, releaseRecord(a, r.id, cfg)); }
        catch (e) { log(`held-release record for ${a.task_id} not written: ${clip(e.message, 200)}`); }
      } catch (e) {
        await surface(`release-failed:${a.held_id}`, { ns: cfg.ns, wake: "release-failed", id: a.held_id, task_id: a.task_id, channel: `${cfg.ns}-held`, line: `release of ${a.task_id} to ${a.inbox} rejected: ${clip(e.message, 200)}` });
      }
    } else if (a.kind === "start") {
      const r = await broker.startWorker(a.worker, a.model);
      ((state.starts ||= {})[a.worker] ||= []).push(Date.now());
      state.starts[a.worker] = state.starts[a.worker].filter(ts => Date.now() - ts < HOUR);
      log(`start ${a.worker}${a.model ? ` [${a.model}]` : ""} for ${a.task_id}: HTTP ${r.status}${r.data?.error ? ` ${r.data.error}` : ""}`);
    } else if (a.kind === "review") {
      try {
        const r = await broker.send(a.inbox, cfg.sender, a.envelope);
        state.sprint_marker = r.id ?? state.sprint_marker;
        state.last_review = a.task_id;
        (state.reviews ||= []).push(a.task_id);
        log(`dispatched ${a.task_id} → ${a.inbox} #${r.id}`);
      } catch (e) {
        await surface(`review-failed:${a.task_id}`, { ns: cfg.ns, wake: "review-failed", id: null, task_id: a.task_id, channel: a.inbox, line: `sprint-close review dispatch rejected: ${clip(e.message, 200)}` });
      }
    } else if (a.kind === "wake") {
      await surface(a.key, a.wake);
    }
  }
  state.surfaced ||= [];
  if (state.surfaced.length > 2000) state.surfaced = state.surfaced.slice(-2000);
  return wakes;
}

let log = (msg) => process.stderr.write(`[orchestrate] ${msg}\n`);
export function setLogger(fn) { log = fn; }

// One tick: snapshot → plan → apply (or, with dryRun, only plan). State is mutated in place.
export async function tick(broker, state, cfg) {
  const snap = await snapshot(broker, cfg.ns, state);
  const { held, actions, sprint_marker, last_review } = planActions(snap, state, cfg);
  if (cfg.dryRun) return { actions, wakes: actions.filter(a => a.kind === "wake").map(a => a.wake) };
  state.held = held;
  state.sprint_marker = sprint_marker; state.last_review = last_review;
  state.held_seen = Math.max(state.held_seen || 0, ...snap.held.map(m => m.id));
  const wakes = await applyActions(broker, actions, state, cfg);
  return { actions, wakes };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const cfg = { once: false, dryRun: false, forceNs: false, intervalMs: 15000, maxStartsPerHour: 3, startCooldownMs: 120000, models: {}, reviewer: "reviewer", sender: "orchestrator", sinceId: null, state: null, reviewHead: null, reviewBase: "main" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    const int = () => { const n = Number(v()); if (!Number.isInteger(n) || n < 0) throw new Error(`${a} needs a non-negative integer`); return n; };
    if (a === "--ns") cfg.ns = v();
    else if (a === "--once") cfg.once = true;
    else if (a === "--dry-run") cfg.dryRun = true;
    else if (a === "--force-ns") cfg.forceNs = true;
    else if (a === "--interval-ms") cfg.intervalMs = Math.max(1000, int());
    else if (a === "--max-starts-per-hour") cfg.maxStartsPerHour = int();
    else if (a === "--start-cooldown-ms") cfg.startCooldownMs = int();
    else if (a === "--since-id") cfg.sinceId = int();
    else if (a === "--state") cfg.state = resolve(v());
    else if (a === "--reviewer") cfg.reviewer = v();
    else if (a === "--sender") cfg.sender = v();
    else if (a === "--review-head") cfg.reviewHead = v();
    else if (a === "--review-base") cfg.reviewBase = v();
    else if (a === "--model") { const [w, ...m] = v().split("="); if (!w || !m.length) throw new Error("--model takes <worker>=<model-id>"); cfg.models[w] = m.join("="); }
    else throw new Error(`unknown argument ${a}`);
  }
  if (!cfg.ns || !/^[a-z0-9][a-z0-9-]*$/i.test(cfg.ns)) throw new Error("--ns <namespace> is required");
  return cfg;
}

export function optedIn(ns, env = process.env) {
  return (env.ORCHESTRATION_LOOP_NAMESPACES || "").split(",").map(s => s.trim()).filter(Boolean).includes(ns);
}

async function main() {
  let cfg;
  try { cfg = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(`orchestrate: ${e.message}`); process.exit(2); }
  if (!cfg.forceNs && !optedIn(cfg.ns)) {
    console.error(`orchestrate: namespace ${cfg.ns} is not opted in (ORCHESTRATION_LOOP_NAMESPACES, or --force-ns)`);
    process.exit(2);
  }
  cfg.state ||= defaultStatePath(cfg.ns);
  cfg.reviewHead ||= process.env.ORCHESTRATION_LOOP_REVIEW_HEAD || null;
  const broker = await connectBroker({ url: process.env.BROKER_URL, secret: process.env.BROKER_SECRET || process.env.SHARED_SECRET,
                                      orchestratorToken: process.env.ORCHESTRATOR_TOKEN || null });
  try {
    let state = loadState(cfg.state);
    if (!state) { state = await initState(broker, cfg.ns, cfg.sinceId); if (!cfg.dryRun) saveState(cfg.state, state); }
    for (;;) {
      const { actions, wakes } = await tick(broker, state, cfg);
      if (cfg.dryRun) { for (const a of actions) console.log(JSON.stringify({ dry_run: true, ...a })); return; }
      saveState(cfg.state, state);
      for (const w of wakes) console.log(JSON.stringify(w));
      if (wakes.length || cfg.once) return;
      await new Promise(r => setTimeout(r, cfg.intervalMs));
    }
  } finally {
    await broker.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(() => process.exit(0), (e) => { console.error(`orchestrate: ${e.stack || e.message}`); process.exit(1); });
}
