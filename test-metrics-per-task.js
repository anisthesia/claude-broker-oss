// /metrics messages_per_task: messages per completed task, per namespace per ISO week.
//   - unit (own temp DB, lib/db.js imported directly, a fixed "now"): week bucketing on Monday 00:00 UTC,
//     ISO week labels across a year boundary, ratio math, tasks_done = distinct task_ids with a
//     PASS/FAIL/SKIP result on <ns>-status (not a status, not an APPROVE, not another channel),
//     a namespace with messages but 0 tasks gets ratio null, and rows older than 4 weeks are ignored
//   - idleChurn (same temp DB): per ns/sender/UTC day patrols/results/questions; >= 10 patrols with no
//     result or question flags the worker-day, a worker that also delivers or sits at 9 patrols does not
//   - HTTP (the scratch broker run-tests.js started): GET /metrics carries the block with 4 weeks,
//     and a second call inside 60 s is served from the cache (same computed_at)

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import "dotenv/config";

const BROKER_URL = process.env.BROKER_URL || "http://localhost:8080/mcp";
const BASE_URL   = BROKER_URL.replace(/\/mcp\/?$/, "");
const SECRET     = process.env.SHARED_SECRET || "";

let passed = 0, failed = 0;
function expect(cond, label, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); return true; }
  failed++; console.error(`  ✗ ${label}`); if (detail !== undefined) console.error(`     detail: ${JSON.stringify(detail).slice(0, 700)}`);
  process.exitCode = 1; return false;
}

async function unit() {
  console.log("\n[1] messagesPerTask on a temp DB");
  const dir = mkdtempSync(join(tmpdir(), "mpt-"));
  process.env.DB_PATH = join(dir, "b.db");
  try {
    const { db, messagesPerTask } = await import("./lib/db.js");
    const ins = db.prepare("INSERT INTO messages (channel, sender, content, created_at) VALUES (?, ?, ?, ?)");
    const at = (iso) => Date.parse(iso);
    const res = (task, summary) => JSON.stringify({ type: "result", task_id: task, summary });
    // now = Wed 2026-01-07: current ISO week 2026-W02 (Mon 01-05), then W01 (Mon 2025-12-29), 2025-W52, 2025-W51.
    const now = at("2026-01-07T12:00:00Z");

    // Current week (W02): cb has 8 messages, 2 tasks done (t1 PASS twice → 1, t2 FAIL), and noise that is not a done task.
    ins.run("cb-core", "orchestrator", JSON.stringify({ type: "task", task_id: "t1" }), at("2026-01-05T00:00:00Z"));   // Monday 00:00 → W02
    ins.run("cb-status", "core", res("t1", "PASS — a"), at("2026-01-05T01:00:00Z"));
    ins.run("cb-status", "core", res("t1", "PASS — again"), at("2026-01-06T01:00:00Z"));
    ins.run("cb-status", "core", res("t2", "FAIL — b"), at("2026-01-06T02:00:00Z"));
    ins.run("cb-status", "core", JSON.stringify({ type: "status", task_id: "t3", subject: "working" }), at("2026-01-06T03:00:00Z"));
    ins.run("cb-status", "rev", res("t4", "APPROVE — reviewer prefix is not PASS/FAIL/SKIP"), at("2026-01-06T04:00:00Z"));
    ins.run("cb-telemetry", "core", JSON.stringify({ type: "heartbeat" }), at("2026-01-06T05:00:00Z"));
    ins.run("cb-core", "core", res("t5", "PASS — a result on an inbox, not <ns>-status"), at("2026-01-06T06:00:00Z"));
    // Previous week (W01): Sunday 23:59 belongs to the week before Monday 00:00. 3 messages, 1 SKIP.
    ins.run("cb-status", "core", res("t6", "SKIP — c"), at("2026-01-04T23:59:59Z"));
    ins.run("cb-core", "orchestrator", "plain text", at("2025-12-29T00:00:00Z"));
    ins.run("cb-notes", "core", "{not json", at("2026-01-01T10:00:00Z"));
    // dv: messages only, no done tasks → ratio null (never Infinity).
    ins.run("dv-backend", "orchestrator", JSON.stringify({ type: "task", task_id: "d1" }), at("2026-01-06T00:00:00Z"));
    ins.run("dv-status", "backend", JSON.stringify({ type: "status", task_id: "d1" }), at("2026-01-06T00:10:00Z"));
    // Out of the window (2025-W50) and a bare channel with no namespace: ignored.
    ins.run("cb-status", "core", res("old", "PASS — old"), at("2025-12-14T00:00:00Z"));
    ins.run("status", "x", res("bare", "PASS — bare"), at("2026-01-06T00:00:00Z"));

    const m = messagesPerTask(now);
    expect(Array.isArray(m.weeks) && m.weeks.map(w => w.week).join() === "2025-W51,2025-W52,2026-W01,2026-W02",
      "4 ISO weeks, oldest first, labels across the year boundary (2025-12-29 is 2026-W01)", m.weeks);
    expect(m.weeks[3].start === "2026-01-05" && m.weeks[0].start === "2025-12-15", "weeks start Monday 00:00 UTC", m.weeks);
    expect(Object.keys(m.namespaces).sort().join() === "cb,dv", "namespaces = channel prefix before the first '-'; bare channels skipped", Object.keys(m.namespaces));
    const cb = m.namespaces.cb || [], dv = m.namespaces.dv || [];
    expect(cb.length === 4 && dv.length === 4, "every namespace lists all 4 weeks", { cb, dv });
    const w2 = cb[3] || {}, w1 = cb[2] || {};
    expect(w2.week === "2026-W02" && w2.messages === 8, "cb current week: 8 messages on cb-* (status, inbox, telemetry alike)", w2);
    expect(w2.tasks_done === 2, "cb current week: tasks_done 2 (t1 counted once, t2 FAIL; status / APPROVE / inbox result not counted)", w2);
    expect(w2.ratio === 4, "ratio = messages / tasks_done = 4", w2);
    expect(w1.messages === 3 && w1.tasks_done === 1 && w1.ratio === 3, "previous week: Sunday 23:59:59 and Monday 00:00 bucket apart; 3 msgs / 1 SKIP = 3", w1);
    expect(cb[0].messages === 0 && cb[0].tasks_done === 0 && cb[0].ratio === null, "an empty week: 0 / 0 → ratio null", cb[0]);
    expect(dv[3].messages === 2 && dv[3].tasks_done === 0 && dv[3].ratio === null, "a namespace with 0 tasks: ratio null, not Infinity", dv[3]);
    expect(!JSON.stringify(m).includes("Infinity") && !JSON.stringify(m).includes("NaN"), "no Infinity / NaN anywhere");
    expect(cb.reduce((s, w) => s + w.messages, 0) === 11, "the 2025-W50 row is outside the window", cb);

    ins.run("cb-status", "core", res("t7", "PASS — d"), at("2026-01-07T00:00:00Z"));
    ins.run("cb-status", "core", res("t8", "PASS — e"), at("2026-01-07T00:00:01Z"));
    expect(messagesPerTask(now).namespaces.cb[3].ratio === 2.5, "ratio rounded to 2 decimals (10 / 4 = 2.5)", messagesPerTask(now).namespaces.cb[3]);
    ins.run("cb-core", "x", "{}", at("2026-01-07T00:00:02Z"));
    expect(messagesPerTask(now).namespaces.cb[3].ratio === 2.75, "11 / 4 = 2.75", messagesPerTask(now).namespaces.cb[3]);

    console.log("\n[1b] idleChurn on the same DB");
    const { idleChurn } = await import("./lib/db.js");
    const st = (task_id, subject) => JSON.stringify({ type: "status", task_id, subject });
    // Wed 2026-01-07: judge posts 10 patrols (5 by subject, 5 by task_id suffix) and nothing else → flagged.
    for (let i = 0; i < 5; i++) ins.run("cb-status", "judge", st("judge-x", "Judge Patrol"), at(`2026-01-07T0${i}:00:00Z`));
    for (let i = 0; i < 5; i++) ins.run("cb-status", "judge", st("cb-judge-patrol", "nothing"), at(`2026-01-07T0${i}:30:00Z`));
    ins.run("cb-status", "judge", st("judge-y", "working"), at("2026-01-07T09:00:00Z"));          // not a patrol
    // Tue 2026-01-06: judge at 9 patrols → below the threshold.
    for (let i = 0; i < 9; i++) ins.run("cb-status", "judge", st("cb-judge-patrol", "p"), at(`2026-01-06T0${i}:00:00Z`));
    // Wed: retro patrols 12 times but also asks a question → not flagged; core patrols 11 times and posts a result → not flagged.
    for (let i = 0; i < 12; i++) ins.run("cb-status", "retro", st("cb-retro-patrol", "p"), at(`2026-01-07T${String(i + 10)}:00:00Z`));
    ins.run("cb-status", "retro", JSON.stringify({ type: "question", task_id: "q1" }), at("2026-01-07T23:00:00Z"));
    for (let i = 0; i < 11; i++) ins.run("cb-status", "core2", st("cb-x-patrol", "p"), at(`2026-01-07T${String(i + 10)}:10:00Z`));
    ins.run("cb-status", "core2", res("t9", "PASS — f"), at("2026-01-07T23:10:00Z"));
    // Out of the 7-day window (Wed 2025-12-31 is day -7).
    for (let i = 0; i < 10; i++) ins.run("cb-status", "old", st("old-patrol", "p"), at(`2025-12-31T0${i}:00:00Z`));

    const c = idleChurn(now);
    expect(c.days.length === 7 && c.days[0] === "2026-01-01" && c.days[6] === "2026-01-07", "7 UTC days, oldest first, ending today", c.days);
    const j = c.namespaces.cb?.judge || [];
    const jw = j.find(x => x.day === "2026-01-07") || {}, jt = j.find(x => x.day === "2026-01-06") || {};
    expect(jw.patrols === 10 && jw.results === 0 && jw.questions === 0 && jw.flagged === true,
      "judge Wed: 10 patrols (subject 'patrol' case-insensitive + task_id '-patrol'), non-patrol status ignored → flagged", jw);
    expect(jt.patrols === 9 && jt.flagged === false, "judge Tue: 9 patrols → not flagged", jt);
    const r = (c.namespaces.cb?.retro || [])[0] || {}, k = (c.namespaces.cb?.core2 || [])[0] || {};
    expect(r.patrols === 12 && r.questions === 1 && r.flagged === false, "a worker that asks a question is not idle-churning", r);
    expect(k.patrols === 11 && k.results === 1 && k.flagged === false, "a worker that posts a result is not idle-churning", k);
    expect(!c.namespaces.cb?.old, "patrols older than 7 days are outside the window", c.namespaces.cb?.old);
    expect(c.flagged.length === 1 && c.flagged[0].sender === "judge" && c.flagged[0].day === "2026-01-07" && c.flagged[0].ns === "cb",
      "flagged lists exactly the judge's Wednesday", c.flagged);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

async function http() {
  console.log("\n[2] GET /metrics on the scratch broker");
  const get = async () => (await fetch(`${BASE_URL}/metrics`, { headers: SECRET ? { authorization: `Bearer ${SECRET}` } : {} })).json();
  const a = await get();
  const b = a.messages_per_task || {};
  expect(Array.isArray(b.weeks) && b.weeks.length === 4 && /^\d{4}-W\d{2}$/.test(b.weeks[3]?.week), "messages_per_task.weeks: 4 ISO weeks", b);
  expect(b.namespaces && typeof b.namespaces === "object", "messages_per_task.namespaces is an object", b);
  expect(Number.isInteger(b.compute_ms) && b.cache_s === 60 && typeof b.computed_at === "string", "compute_ms, cache_s 60, computed_at reported", b);
  const ic = a.idle_churn || {};
  expect(Array.isArray(ic.days) && ic.days.length === 7 && ic.min_patrols === 10 && Array.isArray(ic.flagged) && typeof ic.namespaces === "object",
    "idle_churn: 7 days, min_patrols 10, namespaces, flagged", ic);
  const a2 = await get(), c = a2.messages_per_task || {};
  expect(c.computed_at === b.computed_at, "a second call within 60 s is served from the cache", { first: b.computed_at, second: c.computed_at });
  expect(a2.idle_churn?.computed_at === ic.computed_at, "idle_churn is cached too", { first: ic.computed_at, second: a2.idle_churn?.computed_at });
}

async function main() {
  await unit();
  await http();
  console.log(`\n[metrics-per-task] ${passed} passed, ${failed} failed`);
}
main().catch(e => { console.error(e); process.exit(1); });
