/**
 * test-protocol-ops.js — coverage for the 2026-09-05 protocol/ops additions:
 *   register_channel_schema preserves strict/version when omitted
 *   read_messages / read_last / turn_start projection="summary"
 *   open_questions
 *   post_gated_message accepts "task_id:worker" depends_on
 *   *-telemetry transient-state compaction on send_message and POST /messages
 *   GET /inbox?wait_ms long-poll
 *   GET /metrics
 *   get_task_ledger (derived per-task state)
 *   schemas/notes.json on a <ns>-notes channel
 *
 * Runs against BROKER_URL (default http://localhost:8080/mcp) with SHARED_SECRET.
 * Uses throwaway channels prefixed "tpo-<run>-" and purges them at the end.
 */
import "dotenv/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BROKER_URL = process.env.BROKER_URL || "http://localhost:8080/mcp";
const HTTP       = BROKER_URL.replace(/\/mcp$/, "");
const SECRET     = process.env.SHARED_SECRET || "";
const RUN        = Date.now().toString(36);
const P          = `tpo${RUN}-`;                 // namespace prefix for this run
const hdr        = SECRET ? { Authorization: `Bearer ${SECRET}` } : {};

let passed = 0, failed = 0;
function assert(cond, label, extra = "") {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.log(`  ✗ ${label}${extra ? ": " + extra : ""}`); }
}

const client = new Client({ name: "test-protocol-ops", version: "1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(BROKER_URL), { requestInit: { headers: hdr } }));
const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); return { text: r.content?.[0]?.text ?? "", isError: !!r.isError }; };
const send = (channel, sender, obj) => call("send_message", { channel, sender, content: typeof obj === "string" ? obj : JSON.stringify(obj) });

console.log(`\n[test-protocol-ops] url=${BROKER_URL} prefix=${P}\n`);

// ── 1. register_channel_schema preserves strict + version when omitted ────────
console.log("1. register_channel_schema preserves strict/version");
{
  const ch = `${P}schema`;
  const schema = JSON.stringify({ type: "object", required: ["type"] });
  await call("register_channel_schema", { channel: ch, schema, strict: true, version: "1.0" });
  const r = await call("register_channel_schema", { channel: ch, schema: JSON.stringify({ type: "object", required: ["type", "task_id"] }) });
  assert(/strict=on/.test(r.text), "re-register without strict keeps strict=on", r.text);
  assert(/version=1\.0/.test(r.text), "re-register without version keeps version", r.text);
  assert(/preserved/.test(r.text), "response says mode was preserved", r.text);
  const rej = await send(ch, "x", { type: "task" });
  assert(rej.isError, "channel still rejects (strict preserved and new schema active)", rej.text);
  const off = await call("register_channel_schema", { channel: ch, schema, strict: false });
  assert(/strict=off/.test(off.text), "explicit strict=false still downgrades", off.text);
  const fresh = await call("register_channel_schema", { channel: `${P}schema2`, schema });
  assert(/strict=off/.test(fresh.text) && !/preserved/.test(fresh.text), "new channel without strict defaults to warn-only", fresh.text);
  await call("clear_channel_schema", { channel: ch });
  await call("clear_channel_schema", { channel: `${P}schema2` });
}

// ── 2. projection="summary" ──────────────────────────────────────────────────
console.log("\n2. projection=summary");
{
  const ch = `${P}status`;
  const big = "x".repeat(4000);
  await send(ch, "backend", { type: "result", task_id: "t-1", from: "backend", to: "orchestrator", subject: "big one", summary: "PASS — done", body: big, affected_files: ["a", "b"] });
  await send(ch, "human", "plain text message that is not json at all");
  const full = await call("read_messages", { channel: ch });
  const sum  = await call("read_messages", { channel: ch, projection: "summary" });
  assert(full.text.includes(big), "full projection includes body");
  assert(!sum.text.includes(big), "summary projection omits body");
  assert(/"summary":"PASS — done"/.test(sum.text) && /"affected_files_count":2/.test(sum.text) && /"bytes":\d+/.test(sum.text), "summary carries headline fields", sum.text.slice(0, 200));
  assert(/"text":"plain text message/.test(sum.text), "non-JSON rows summarised as text", sum.text);
  assert(/next since_id/.test(sum.text), "summary projection still reports next since_id");
  const last = await call("read_last", { channel: ch, n: 5, projection: "summary" });
  assert(!last.text.includes(big) && /PASS — done/.test(last.text), "read_last honours projection");
  const ts = JSON.parse((await call("turn_start", { inbox_channel: ch, control_channel: `${P}control`, projection: "summary" })).text);
  assert(ts.inbox.length === 2 && ts.inbox[0].summary && ts.inbox[0].content === undefined, "turn_start summary replaces content", JSON.stringify(ts.inbox[0]).slice(0, 200));
  const tsFull = JSON.parse((await call("turn_start", { inbox_channel: ch, control_channel: `${P}control` })).text);
  assert(typeof tsFull.inbox[0].content === "string", "turn_start default still returns content");
}

// ── 3. open_questions ────────────────────────────────────────────────────────
console.log("\n3. open_questions");
{
  const status = `${P}status`;
  await send(status, "devops", { type: "question", task_id: "q-answered", from: "devops", to: "orchestrator", subject: "which port?" });
  await send(`${P}devops`, "orchestrator", { type: "note", task_id: "q-answered", from: "orchestrator", to: "devops", subject: "re: which port?", body: "8080" });
  await send(status, "frontend", { type: "question", task_id: "q-self", from: "frontend", to: "orchestrator", subject: "may I?" });
  await send(status, "frontend", { type: "result", task_id: "q-self", from: "frontend", to: "orchestrator", subject: "did it", summary: "PASS — went ahead" });
  await send(status, "backend", { type: "question", task_id: "q-open", from: "backend", to: "orchestrator", subject: "blocked on schema" });
  await send(status, "backend", { type: "question", from: "backend", to: "orchestrator", subject: "no task id" });
  const r = JSON.parse((await call("open_questions", { prefix: P })).text);
  const ids = r.open.map(o => o.task_id);
  assert(r.open_count === 2, `two open questions (got ${r.open_count})`, JSON.stringify(r));
  assert(ids.includes("q-open"), "unanswered question with task_id is open");
  assert(ids.includes(null), "unanswered question without task_id is open");
  assert(!ids.includes("q-answered"), "question with reply on asker inbox is not open");
  assert(!ids.includes("q-self"), "question self-resolved by a result is not open");
  assert(r.answered_count === 2, "answered_count=2");
  const o = r.open.find(x => x.task_id === "q-open");
  assert(o.expected_reply_channel === `${P}backend` && typeof o.age_min === "number", "open entry names the inbox to reply on");
  const aged = JSON.parse((await call("open_questions", { prefix: P, max_age_ms: 1 })).text);
  assert(aged.open_count === 0, "max_age_ms filters out old questions");
}

// ── 4. post_gated_message accepts task_id:worker ─────────────────────────────
console.log("\n4. post_gated_message depends_on suffix");
{
  const status = `${P}status`;
  const r = await call("post_gated_message", { channel: `${P}backend`, sender: "orchestrator", content: JSON.stringify({ type: "task" }), depends_on: ["t-1:backend"], watch_channel: status, timeout_ms: 2000 });
  assert(!r.isError && /satisfied/.test(r.text), "'task_id:worker' form matches result keyed by task_id", r.text);
  const r2 = await call("post_gated_message", { channel: `${P}backend`, sender: "orchestrator", content: JSON.stringify({ type: "task" }), depends_on: ["nope:backend"], watch_channel: status, timeout_ms: 500 });
  assert(r2.isError && /nope/.test(r2.text), "unsatisfied dep still times out and names the bare task_id", r2.text);
}

// ── 5. telemetry transient-state compaction ──────────────────────────────────
console.log("\n5. *-telemetry compaction");
{
  const ch = `${P}telemetry`;
  const hb = (state, extra = {}) => JSON.stringify({ type: "heartbeat", state, ts: new Date().toISOString(), ...extra });
  await send(ch, "backend", hb("working"));
  await send(ch, "backend", hb("working"));
  await send(ch, "backend", hb("working"));
  let rows = (await call("read_messages", { channel: ch })).text.split("\n").filter(l => l.startsWith("[#"));
  assert(rows.length === 1, `three working heartbeats collapse to one (got ${rows.length})`);
  await send(ch, "backend", hb("session-end", { cost_since_start: { estimated_usd: 0.5 } }));
  await send(ch, "backend", hb("working"));
  await send(ch, "backend", hb("session-end", { cost_since_start: { estimated_usd: 0.7 } }));
  rows = (await call("read_messages", { channel: ch })).text.split("\n").filter(l => l.startsWith("[#"));
  assert(rows.length === 2 && rows.every(l => /session-end/.test(l)), `session-end rows survive, working rows evicted (got ${rows.length})`, rows.join(" | "));
  await send(ch, "frontend", hb("working"));
  rows = (await call("read_messages", { channel: ch })).text.split("\n").filter(l => l.startsWith("[#"));
  assert(rows.length === 3, "other senders' rows untouched");
  // REST path
  const rest = await fetch(`${HTTP}/messages`, { method: "POST", headers: { ...hdr, "Content-Type": "application/json" }, body: JSON.stringify({ channel: ch, sender: "frontend", content: hb("working") }) });
  assert(rest.status === 200, "POST /messages heartbeat accepted");
  rows = (await call("read_messages", { channel: ch })).text.split("\n").filter(l => l.startsWith("[#"));
  assert(rows.length === 3, "POST /messages working heartbeat also compacts");
  // non-telemetry channel is never compacted
  await send(`${P}other`, "backend", hb("working"));
  await send(`${P}other`, "backend", hb("working"));
  rows = (await call("read_messages", { channel: `${P}other` })).text.split("\n").filter(l => l.startsWith("[#"));
  assert(rows.length === 2, "non-telemetry channel keeps every row");
}

// ── 6. GET /inbox?wait_ms long-poll ──────────────────────────────────────────
console.log("\n6. /inbox wait_ms");
{
  const ch = `${P}inbox-wait`;
  let t0 = Date.now();
  const timedOut = await (await fetch(`${HTTP}/inbox?channel=${ch}&since_id=0&wait_ms=700`, { headers: hdr })).json();
  const dt = Date.now() - t0;
  assert(timedOut.pending === false && dt >= 650, `times out empty after wait_ms (${dt}ms)`);
  t0 = Date.now();
  const p = fetch(`${HTTP}/inbox?channel=${ch}&since_id=0&wait_ms=10000`, { headers: hdr }).then(r => r.json());
  setTimeout(() => send(ch, "orchestrator", { type: "task" }), 150);
  const woken = await p;
  const dt2 = Date.now() - t0;
  assert(woken.pending === true && woken.count === 1 && dt2 < 5000, `wakes on message (${dt2}ms)`, JSON.stringify(woken));
  const immediate = await (await fetch(`${HTTP}/inbox?channel=${ch}&since_id=0&wait_ms=5000`, { headers: hdr })).json();
  assert(immediate.pending === true, "returns immediately when already pending");
  const plain = await (await fetch(`${HTTP}/inbox?channel=${ch}&since_id=${woken.max_id}`, { headers: hdr })).json();
  assert(plain.pending === false, "no wait_ms → unchanged immediate semantics");
}

// ── 7. GET /metrics ──────────────────────────────────────────────────────────
console.log("\n7. /metrics");
{
  const unauth = await fetch(`${HTTP}/metrics`);
  assert(!SECRET || unauth.status === 401, "metrics requires auth when SHARED_SECRET set");
  const m = await (await fetch(`${HTTP}/metrics`, { headers: hdr })).json();
  assert(typeof m.messages_inserted === "number" && m.messages_inserted > 0, "messages_inserted counted");
  assert(m.tools.send_message?.calls > 0 && typeof m.tools.send_message.avg_ms === "number", "per-tool call counters present");
  assert(m.tools.post_gated_message?.errors >= 1, "tool errors counted (post_gated timeout above)");
  assert(m.long_polls.total >= 2 && m.long_polls.woken >= 1 && m.long_polls.active === 0, "long-poll counters track /inbox waits", JSON.stringify(m.long_polls));
  assert((m.http["GET /inbox"] || 0) >= 4 && (m.http["POST /messages"] || 0) >= 1, "http route counters present", JSON.stringify(m.http));
  assert(!JSON.stringify(m.http).includes("token="), "no query strings in http counters");
}

// ── 8. get_task_ledger ───────────────────────────────────────────────────────
console.log("\n8. get_task_ledger");
{
  const NS = `${P}ldg`;                       // its own namespace: <NS>-status, <NS>-backend, …
  const st = `${NS}-status`;
  const task = (id, to, extra = {}) => ({ type: "task", task_id: id, from: "orchestrator", to, subject: `do ${id}`, body: "x", ...extra });
  await send(`${NS}-backend`,  "orchestrator", task("t-pending",  "backend"));
  await send(`${NS}-backend`,  "orchestrator", task("t-progress", "backend"));
  await send(`${NS}-backend`,  "orchestrator", task("t-handoff",  "backend", { scope: "large" }));
  await send(`${NS}-frontend`, "orchestrator", task("t-blocked",  "frontend"));
  await send(`${NS}-frontend`, "orchestrator", task("t-done",     "frontend", { depends_on: ["t-progress:backend"] }));
  await send(`${NS}-frontend`, "orchestrator", task("t-retry",    "frontend"));
  await send(`${NS}-frontend`, "orchestrator", task("t-retry",    "frontend"));   // re-dispatch
  await send(`${NS}-control`,  "orchestrator", task("t-broadcast", "*"));          // meta channel: not a dispatch
  await send(`${NS}-notes`,    "backend",      task("t-note",      "backend"));    // meta channel: not a dispatch
  await send(st, "backend",  { type: "status", task_id: "t-progress", from: "backend", to: "orchestrator", subject: "waiting on tests" });
  await send(st, "backend",  { type: "status", task_id: "t-handoff",  from: "backend", to: "orchestrator", subject: "rotating — context at 150k", body: { handoff_notes: "done: parser; pending: tests" } });
  await send(st, "frontend", { type: "question", task_id: "t-blocked", from: "frontend", to: "orchestrator", subject: "which API?" });
  await send(st, "frontend", { type: "status", task_id: "t-done", from: "frontend", to: "orchestrator", subject: "starting" });
  await send(st, "frontend", { type: "result", task_id: "t-done",  from: "frontend", to: "orchestrator", subject: "done", summary: "PASS — shipped", body: { consent_basis: "orchestrator-dispatch-only" } });
  await send(st, "frontend", { type: "result", task_id: "t-retry", from: "frontend", to: "orchestrator", subject: "retry", summary: "FAIL — flaky", body: {} });
  await send(st, "frontend", { type: "result", task_id: "t-retry", from: "frontend", to: "orchestrator", subject: "retry", summary: "SKIP — already merged", body: {} });
  await send(st, "patrol",   { type: "result", task_id: "patrol-0001", from: "patrol", to: "orchestrator", subject: "patrol", summary: "PASS — clean", body: {} });

  const led = JSON.parse((await call("get_task_ledger", { status_channel: st })).text);
  const by  = Object.fromEntries(led.tasks.map(t => [t.task_id, t]));
  assert(led.prefix === `${NS}-`, "prefix derived from status channel", led.prefix);
  assert(led.counts.total === 7, `7 distinct tasks (6 dispatched + 1 undispatched result), got ${led.counts.total}`, JSON.stringify(led.counts));
  assert(!by["t-broadcast"] && !by["t-note"], "tasks on -control / -notes are not counted as dispatches");
  assert(by["t-pending"]?.state === "pending" && by["t-pending"].worker === "backend", "pending: dispatched, nothing heard", JSON.stringify(by["t-pending"]));
  assert(by["t-progress"]?.state === "in-progress" && by["t-progress"].last_status?.subject === "waiting on tests", "in-progress: worker posted a status", JSON.stringify(by["t-progress"]));
  assert(by["t-handoff"]?.state === "handoff" && by["t-handoff"].last_status?.handoff === true, "handoff: status carries body.handoff_notes", JSON.stringify(by["t-handoff"]));
  assert(by["t-blocked"]?.state === "blocked" && by["t-blocked"].open_question?.expected_reply_channel === `${NS}-frontend`, "blocked: open question, reply expected on asker inbox", JSON.stringify(by["t-blocked"]));
  assert(by["t-done"]?.state === "done" && by["t-done"].summary === "PASS — shipped" && by["t-done"].result_id > by["t-done"].last_status.id, "done: result wins over earlier status", JSON.stringify(by["t-done"]));
  assert(Array.isArray(by["t-done"]?.depends_on) && by["t-done"].depends_on[0] === "t-progress:backend", "depends_on carried through");
  assert(by["t-retry"]?.state === "skipped" && by["t-retry"].dispatch_count === 2, "latest result decides; re-dispatch counted once", JSON.stringify(by["t-retry"]));
  assert(by["patrol-0001"]?.state === "done" && by["patrol-0001"].dispatched_at === null && by["patrol-0001"].worker === "patrol", "undispatched result listed with dispatched_at null");
  assert(led.counts.pending === 1 && led.counts["in-progress"] === 1 && led.counts.handoff === 1 && led.counts.blocked === 1 && led.counts.done === 2 && led.counts.skipped === 1, "counts per state", JSON.stringify(led.counts));
  const ids = led.tasks.map(t => t.dispatch_id ?? t.result_id);
  assert(ids.every((v, i) => i === 0 || v >= ids[i - 1]), "rows ordered by dispatch id");

  const open = JSON.parse((await call("get_task_ledger", { status_channel: st, only_open: true })).text);
  assert(open.tasks.length === 4 && open.counts.total === 7, "only_open drops finished rows but counts stay whole", JSON.stringify(open.tasks.map(t => t.task_id)));

  await send(`${NS}-frontend`, "orchestrator", { type: "note", task_id: "t-blocked", from: "orchestrator", to: "frontend", subject: "answer", body: "use v2" });
  const after = JSON.parse((await call("get_task_ledger", { status_channel: st })).text);
  assert(after.tasks.find(t => t.task_id === "t-blocked").state === "pending", "answered question unblocks the task");

  const since = JSON.parse((await call("get_task_ledger", { status_channel: st, since_id: by["t-handoff"].dispatch_id })).text);
  assert(!since.tasks.find(t => t.task_id === "t-pending") && since.tasks.find(t => t.task_id === "t-blocked"), "since_id bounds the dispatch scan");

  // Cluster layout: workers post to <ns>-<cluster>-status but their inboxes are <ns>-<worker>.
  const cst = `${NS}-alpha-status`;
  await send(cst, "backend", { type: "result", task_id: "t-progress", from: "backend", to: "alpha-orch", subject: "x", summary: "PASS — via cluster", body: {} });
  const naive = JSON.parse((await call("get_task_ledger", { status_channel: cst })).text);
  assert(naive.counts.total === 1 && naive.tasks[0].dispatched_at === null, "without prefix a cluster status channel sees no dispatches", JSON.stringify(naive.counts));
  const clus = JSON.parse((await call("get_task_ledger", { status_channel: cst, prefix: `${NS}-`, workers: ["backend"] })).text);
  assert(clus.counts.total === 3 && clus.tasks.every(t => t.worker === "backend"), "prefix + workers scope the ledger to the cluster's workers", JSON.stringify(clus.tasks.map(t => [t.task_id, t.worker])));
  assert(clus.tasks.find(t => t.task_id === "t-progress").state === "done", "cluster status channel supplies the result");
  assert(!clus.tasks.find(t => t.task_id === "t-blocked"), "other clusters' workers are excluded");
}

// ── 9. schemas/notes.json ────────────────────────────────────────────────────
console.log("\n9. notes schema");
{
  const { readFileSync } = await import("node:fs");
  const ch = `${P}notes`;
  const reg = await call("register_channel_schema", { channel: ch, schema: readFileSync("schemas/notes.json", "utf8"), strict: true, version: "1.0" });
  assert(/Registered schema/.test(reg.text), "notes schema registers", reg.text);
  const finding = { type: "finding", from: "core", to: "protocol-qa", subject: "schema loader swallows parse errors", summary: "loadSchema() returns null on invalid JSON instead of throwing, so a bad schema file registers as 'no schema'.", scope: ["server.js", "schemas/"], evidence: "node -e 'require(\"./server.js\")' with a truncated schemas/x.json", confidence: "confirmed", task_id: "cb-2026-09-17-x" };
  const ok = await send(ch, "core", finding);
  assert(!ok.isError, "finding with scope + summary accepted", ok.text);
  const dec = await send(ch, "orchestrator", { type: "decision", from: "orchestrator", to: "*", subject: "keep -notes prune-exempt", summary: "Notes are read at cold start by every worker; a 48h prune would silently drop them. Exempt like -backlog.", scope: ["config"] });
  assert(!dec.isError, "decision accepted", dec.text);
  const noScope = await send(ch, "core", { type: "finding", from: "core", to: "*", subject: "vague", summary: "something is off somewhere in the code" });
  assert(noScope.isError, "finding without scope rejected");
  const extra = await send(ch, "core", { ...finding, body: "free text" });
  assert(extra.isError, "unknown top-level field rejected (no free-form body)");
  const findingId = Number(ok.text.match(/#(\d+)/)?.[1] || 0);
  const res = await send(ch, "protocol-qa", { type: "resolved", from: "protocol-qa", subject: "loader fixed", ref_id: findingId || 1, outcome: "fixed", task_id: "cb-2026-09-17-y" });
  assert(!res.isError, "resolved with ref_id + outcome accepted", res.text);
  const badRes = await send(ch, "protocol-qa", { type: "resolved", from: "protocol-qa", subject: "loader fixed", ref_id: 1 });
  assert(badRes.isError, "resolved without outcome rejected");
  const summ = (await call("read_messages", { channel: ch, since_id: 0, projection: "summary" })).text;
  assert(summ.includes("schema loader swallows parse errors") && summ.includes("loadSchema() returns null"), "summary projection shows subject + summary of a note");
  await call("clear_channel_schema", { channel: ch });
}

// ── cleanup ──────────────────────────────────────────────────────────────────
await call("purge_channels_by_prefix", { prefix: P });
await client.close();
console.log(`\n  passed: ${passed}   failed: ${failed}\n`);
process.exit(failed ? 1 : 0);
