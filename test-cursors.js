/**
 * test-cursors.js — server-side read cursors + newest-first default (2026-10-01).
 *
 *   read_messages / wait_for_messages / turn_start with since_id omitted or 0:
 *     - no cursor for the consumer → newest `limit` messages (tail), with a "N older not shown" header
 *     - cursor present              → resume after it; each unfiltered delivery advances it
 *     - explicit since_id > 0       → unchanged paging semantics, cursor still advanced
 *   filtered reads never advance the cursor
 *   turn_start defaults consumer to inbox_channel; worker= overrides
 *   a `type: status` with body.handoff_notes rewinds the sender's inbox cursor to before the task
 *   worker_cursor lists / sets; PUT /cursors rewinds (channel-wide or per worker); GET /cursors lists
 *
 * Runs against BROKER_URL (default http://localhost:8080/mcp) with SHARED_SECRET.
 * Uses throwaway channels prefixed "tcur-<run>-" and purges them at the end.
 */
import "dotenv/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BROKER_URL = process.env.BROKER_URL || "http://localhost:8080/mcp";
const HTTP       = BROKER_URL.replace(/\/mcp$/, "");
const SECRET     = process.env.SHARED_SECRET || "";
const RUN        = Date.now().toString(36);
const P          = `tcur${RUN}-`;
const hdr        = SECRET ? { Authorization: `Bearer ${SECRET}` } : {};

let passed = 0, failed = 0;
function assert(cond, label, extra = "") {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.log(`  ✗ ${label}${extra ? ": " + String(extra).slice(0, 300) : ""}`); }
}

const client = new Client({ name: "test-cursors", version: "1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(BROKER_URL), { requestInit: { headers: hdr } }));
const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); return { text: r.content?.[0]?.text ?? "", isError: !!r.isError }; };
const send = async (channel, sender, obj) => {
  const r = await call("send_message", { channel, sender, content: typeof obj === "string" ? obj : JSON.stringify(obj) });
  return parseInt((r.text.match(/#(\d+)/) || [])[1], 10);
};
const ids = (text) => [...text.matchAll(/^\[#(\d+)\]/gm)].map(m => parseInt(m[1], 10));
const json = (text) => { try { return JSON.parse(text); } catch { return null; } };

console.log(`\n[test-cursors] url=${BROKER_URL} prefix=${P}\n`);

// ── 1. newest-first default ──────────────────────────────────────────────────
console.log("1. read_messages without since_id returns the newest N");
const chA = `${P}a`;
const a = [];
for (let i = 1; i <= 7; i++) a.push(await send(chA, "s", { type: "note", n: i }));
{
  const r = await call("read_messages", { channel: chA, limit: 3 });
  assert(JSON.stringify(ids(r.text)) === JSON.stringify(a.slice(4)), "no since_id, limit 3 → the 3 newest", r.text);
  assert(/newest 3 of 7/.test(r.text) && /4 older not shown/.test(r.text), "header says newest 3 of 7, 4 older not shown", r.text);
  assert(r.text.includes(`(next since_id: ${a[6]})`), "next since_id is the newest id", r.text);
  const r0 = await call("read_messages", { channel: chA, since_id: 0, limit: 3 });
  assert(JSON.stringify(ids(r0.text)) === JSON.stringify(a.slice(4)), "since_id=0 behaves like omitted (tail)", r0.text);
  const rp = await call("read_messages", { channel: chA, since_id: a[1], limit: 3 });
  assert(JSON.stringify(ids(rp.text)) === JSON.stringify(a.slice(2, 5)), "explicit since_id still pages oldest-first", rp.text);
  assert(/2 more pending beyond limit/.test(rp.text), "explicit page reports how many remain beyond the limit", rp.text);
  const rt = await call("read_messages", { channel: chA, filter_type: "note", limit: 2 });
  assert(JSON.stringify(ids(rt.text)) === JSON.stringify(a.slice(5)), "tail honours filter_type", rt.text);
  const all = await call("read_messages", { channel: chA });
  assert(ids(all.text).length === 7 && !/older not shown/.test(all.text), "channel under the limit: everything, no header", all.text);
}

// ── 2. cursor via read_messages(worker=) ─────────────────────────────────────
console.log("\n2. read_messages(worker=) resumes from the server-side cursor");
{
  const r1 = await call("read_messages", { channel: chA, worker: "w1", limit: 3 });
  assert(JSON.stringify(ids(r1.text)) === JSON.stringify(a.slice(4)), "first read with worker and no cursor → tail", r1.text);
  const n8 = await send(chA, "s", { type: "note", n: 8 });
  const r2 = await call("read_messages", { channel: chA, worker: "w1" });
  assert(JSON.stringify(ids(r2.text)) === JSON.stringify([n8]), "second read → only the message after the cursor", r2.text);
  assert(/resumed from server cursor/.test(r2.text), "output says it resumed from the server cursor", r2.text);
  const r3 = await call("read_messages", { channel: chA, worker: "w1" });
  assert(/No new messages/.test(r3.text) && /server cursor/.test(r3.text), "third read → nothing new, cursor noted", r3.text);
  const c = json((await call("worker_cursor", { worker: "w1" })).text);
  assert(c && c.cursors.length === 1 && c.cursors[0].channel === chA && c.cursors[0].last_id === n8, "worker_cursor lists last_id = newest delivered", JSON.stringify(c));

  const n9 = await send(chA, "s", { type: "other", n: 9 });
  const rf = await call("read_messages", { channel: chA, worker: "w1", filter_type: "nomatch" });
  assert(/No new messages/.test(rf.text), "filtered read finds nothing", rf.text);
  const r4 = await call("read_messages", { channel: chA, worker: "w1" });
  assert(JSON.stringify(ids(r4.text)) === JSON.stringify([n9]), "filtered read did NOT advance the cursor", r4.text);
  const other = await call("read_messages", { channel: chA, worker: "w-other", limit: 2 });
  assert(JSON.stringify(ids(other.text)) === JSON.stringify([n8, n9]), "cursors are per worker: another consumer still gets the tail", other.text);
  const rx = await call("read_messages", { channel: chA, worker: "w1", since_id: a[5] });
  assert(JSON.stringify(ids(rx.text)) === JSON.stringify([a[6], n8, n9]), "explicit since_id overrides the cursor", rx.text);
}

// ── 3. turn_start ─────────────────────────────────────────────────────────────
console.log("\n3. turn_start cursors");
const inbox = `${P}inbox`, control = `${P}control`, status = `${P}status`;
const t1 = await send(inbox, "orchestrator", { type: "task", task_id: "t-1", from: "orchestrator", to: "w2", subject: "one" });
const t2 = await send(inbox, "orchestrator", { type: "task", task_id: "t-2", from: "orchestrator", to: "w2", subject: "two" });
const c1 = await send(control, "orchestrator", { type: "note", subject: "hello" });
{
  const s1 = json((await call("turn_start", { inbox_channel: inbox, control_channel: control, worker: "w2" })).text);
  assert(s1.inbox.map(m => m.id).join() === [t1, t2].join() && s1.control.length === 1, "fresh consumer → whole (small) inbox + control", JSON.stringify(s1));
  assert(s1.inbox_source === "tail" && s1.control_source === "tail" && s1.consumer === "w2", "sources reported as tail, consumer = worker", JSON.stringify(s1));
  assert(s1.inbox_next_id === t2 && s1.control_next_id === c1, "next ids are the newest delivered", JSON.stringify(s1));

  const s2 = json((await call("turn_start", { inbox_channel: inbox, control_channel: control, worker: "w2" })).text);
  assert(s2.inbox.length === 0 && s2.control.length === 0, "same consumer again, since omitted → nothing re-delivered", JSON.stringify(s2));
  assert(s2.inbox_source === "cursor" && s2.inbox_next_id === t2 && s2.control_next_id === c1, "resumed from cursor; next ids unchanged", JSON.stringify(s2));

  const s0 = json((await call("turn_start", { inbox_channel: inbox, control_channel: control, worker: "w2", inbox_since_id: 0, control_since_id: 0 })).text);
  assert(s0.inbox.length === 0 && s0.inbox_source === "cursor", "explicit since_id=0 is treated like omitted (cursor wins)", JSON.stringify(s0));

  const t3 = await send(inbox, "orchestrator", { type: "task", task_id: "t-3", from: "orchestrator", to: "w2", subject: "three" });
  const s3 = json((await call("turn_start", { inbox_channel: inbox, control_channel: control, worker: "w2" })).text);
  assert(s3.inbox.map(m => m.id).join() === String(t3), "new task delivered once", JSON.stringify(s3));

  // consumer defaults to inbox_channel when worker is omitted (independent cursor from "w2")
  const d1 = json((await call("turn_start", { inbox_channel: inbox, control_channel: control })).text);
  assert(d1.consumer === inbox && d1.inbox.length === 3, "worker omitted → consumer = inbox_channel, first call gets the tail", JSON.stringify(d1));
  const d2 = json((await call("turn_start", { inbox_channel: inbox, control_channel: control })).text);
  assert(d2.inbox.length === 0 && d2.inbox_source === "cursor", "second call without worker resumes from the channel-named cursor", JSON.stringify(d2));

  // explicit since_id in-session still advances the cursor
  const t4 = await send(inbox, "orchestrator", { type: "task", task_id: "t-4", from: "orchestrator", to: "w2", subject: "four" });
  const e1 = json((await call("turn_start", { inbox_channel: inbox, control_channel: control, worker: "w2", inbox_since_id: t2, control_since_id: c1 })).text);
  assert(e1.inbox_source === "explicit" && e1.inbox.map(m => m.id).join() === [t3, t4].join(), "explicit since pages from there", JSON.stringify(e1));
  const e2 = json((await call("turn_start", { inbox_channel: inbox, control_channel: control, worker: "w2" })).text);
  assert(e2.inbox.length === 0 && e2.inbox_next_id === t4, "cursor advanced by the explicit read", JSON.stringify(e2));

  // tail with more than `limit` inbox messages → newest N, skipped count, never the oldest N
  const big = `${P}big`;
  const b = []; for (let i = 0; i < 6; i++) b.push(await send(big, "orchestrator", { type: "task", task_id: `b-${i}`, subject: `b${i}` }));
  const bs = json((await call("turn_start", { inbox_channel: big, control_channel: control, worker: "w-big", limit: 4 })).text);
  assert(bs.inbox.map(m => m.id).join() === b.slice(2).join() && bs.inbox_skipped === 2, "oversized inbox → newest 4, inbox_skipped=2", JSON.stringify(bs));

  // handoff status rewinds the inbox cursor to before the task
  const t5 = await send(inbox, "orchestrator", { type: "task", task_id: "t-5", from: "orchestrator", to: "w2", subject: "five" });
  const h1 = json((await call("turn_start", { inbox_channel: inbox, control_channel: control, worker: "w2" })).text);
  assert(h1.inbox.map(m => m.id).join() === String(t5), "t-5 delivered", JSON.stringify(h1));
  await send(status, "w2", { type: "status", task_id: "t-5", from: "w2", to: "orchestrator", subject: "rotating", body: { handoff_notes: { done: ["a"], pending: ["b"], files_touched: [], next_step: "b" } } });
  const h2 = json((await call("turn_start", { inbox_channel: inbox, control_channel: control, worker: "w2" })).text);
  assert(h2.inbox.map(m => m.id).join() === String(t5) && h2.inbox_source === "cursor", "handoff status → replacement session sees t-5 again", JSON.stringify(h2));
  await send(status, "w2", { type: "status", task_id: "t-5", from: "w2", to: "orchestrator", subject: "checkpoint", body: { step: 1 } });
  const h3 = json((await call("turn_start", { inbox_channel: inbox, control_channel: control, worker: "w2" })).text);
  assert(h3.inbox.length === 0, "a plain status (no handoff_notes) does not rewind", JSON.stringify(h3));

  // worker_cursor set_to rewinds
  const w = json((await call("worker_cursor", { worker: "w2", channel: inbox, set_to: t3 })).text);
  assert(w.before === t5 && w.after === t3, "worker_cursor set_to reports before/after", JSON.stringify(w));
  const h4 = json((await call("turn_start", { inbox_channel: inbox, control_channel: control, worker: "w2" })).text);
  assert(h4.inbox.map(m => m.id).join() === [t4, t5].join(), "after set_to, messages past it are re-delivered", JSON.stringify(h4));
  const bad = await call("worker_cursor", { worker: "w2", set_to: 1 });
  assert(bad.isError, "set_to without channel is an error", bad.text);
}

// ── 4. wait_for_messages ─────────────────────────────────────────────────────
console.log("\n4. wait_for_messages cursors + projection");
{
  const chW = `${P}w`;
  const body = "y".repeat(3000);
  const w1 = await send(chW, "s", { type: "result", task_id: "r-1", summary: "PASS — ok", body });
  const r1 = await call("wait_for_messages", { channel: chW, worker: "w3", projection: "summary", timeout_ms: 2000 });
  assert(ids(r1.text).join() === String(w1) && !r1.text.includes(body), "immediate tail delivery, summary projection drops the body", r1.text.slice(0, 200));
  const r2 = await call("wait_for_messages", { channel: chW, worker: "w3", timeout_ms: 1200 });
  assert(/No new messages/.test(r2.text), "second wait resumes from cursor → times out empty", r2.text);
  const pending = call("wait_for_messages", { channel: chW, worker: "w3", timeout_ms: 5000 });
  await new Promise(r => setTimeout(r, 300));
  const w2 = await send(chW, "s", { type: "result", task_id: "r-2", summary: "PASS — ok2", body: "x" });
  const r3 = await pending;
  assert(ids(r3.text).join() === String(w2), "woken wait delivers only the new message", r3.text);
  const r4 = await call("wait_for_messages", { channel: chW, worker: "w3", timeout_ms: 800 });
  assert(/No new messages/.test(r4.text), "woken delivery advanced the cursor", r4.text);
  const f1 = call("wait_for_messages", { channel: chW, worker: "w3", filter_type: "task", timeout_ms: 5000 });
  await new Promise(r => setTimeout(r, 200));
  const w3 = await send(chW, "s", { type: "note", summary: "not a task" });
  const w4 = await send(chW, "s", { type: "task", task_id: "r-3", subject: "a task" });
  const f1r = await f1;
  assert(ids(f1r.text).join() === String(w4), "filtered wait skips non-matching and returns the task", f1r.text);
  const r5 = await call("wait_for_messages", { channel: chW, worker: "w3", timeout_ms: 800 });
  assert(ids(r5.text).join() === [w3, w4].join(), "filtered wait did not advance the cursor", r5.text);
}

// ── 5. REST ──────────────────────────────────────────────────────────────────
console.log("\n5. GET/PUT /cursors");
{
  const g = await (await fetch(`${HTTP}/cursors?worker=w2`, { headers: hdr })).json();
  assert(g.worker === "w2" && g.cursors.some(c => c.channel === inbox), "GET /cursors lists the worker's cursors", JSON.stringify(g));
  const p1 = await (await fetch(`${HTTP}/cursors`, { method: "PUT", headers: { ...hdr, "Content-Type": "application/json" }, body: JSON.stringify({ channel: inbox, last_id: 0 }) })).json();
  assert(p1.rewound >= 2, "PUT /cursors without worker rewinds every consumer on the channel", JSON.stringify(p1));
  const s = json((await call("turn_start", { inbox_channel: inbox, control_channel: control, worker: "w2" })).text);
  assert(s.inbox.length === 5 && s.inbox_source === "cursor", "after channel-wide rewind to 0 the whole inbox is re-delivered (cursor=0)", JSON.stringify(s));
  const p2 = await (await fetch(`${HTTP}/cursors`, { method: "PUT", headers: { ...hdr, "Content-Type": "application/json" }, body: JSON.stringify({ channel: inbox, last_id: 999999999, worker: "w2" }) })).json();
  assert(p2.rewound === 0, "PUT /cursors never moves a cursor forward without force", JSON.stringify(p2));
  const p3 = await fetch(`${HTTP}/cursors`, { method: "PUT", headers: { ...hdr, "Content-Type": "application/json" }, body: JSON.stringify({ channel: inbox }) });
  assert(p3.status === 400, "PUT /cursors without last_id → 400");
  const noauth = await fetch(`${HTTP}/cursors?worker=w2`);
  assert(SECRET ? noauth.status === 401 : true, "GET /cursors requires auth");
  const m = await (await fetch(`${HTTP}/metrics`, { headers: hdr })).json();
  assert(typeof m.cursor_reads === "number" && m.cursor_reads > 0 && m.cursor_rewinds > 0, "metrics expose cursor_reads / cursor_rewinds", JSON.stringify({ cr: m.cursor_reads, tr: m.tail_reads, rw: m.cursor_rewinds }));
}

// ── cleanup ──────────────────────────────────────────────────────────────────
await call("purge_channels_by_prefix", { prefix: P }).catch(() => {});
for (const ch of [chA, inbox, control, status, `${P}big`, `${P}w`]) await call("purge_channel", { channel: ch }).catch(() => {});

console.log(`\n[test-cursors] ${passed} passed, ${failed} failed\n`);
await client.close();
process.exit(failed ? 1 : 0);
