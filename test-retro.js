// Fixture tests for retro/ (no broker needed): builds a temp sqlite DB shaped like broker.db.
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import Ajv from "ajv";
import { openDb, runRetro, openNotes, clusterFailures, clusterFindings, markStale, compact, proposeEdits, loadChannel, KNOWLEDGE_CAP_BYTES, OVER_CAP } from "./retro/retro-lib.mjs";

let passed = 0, failed = 0;
const expect = (c, l, d) => { if (c) { console.log(`  ✓ ${l}`); passed++; } else { console.error(`  ✗ ${l}`, d ?? ""); failed++; process.exitCode = 1; } };

const dir = mkdtempSync(join(tmpdir(), "retro-"));
const dbPath = join(dir, "t.db");
const db = new Database(dbPath);
db.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, sender TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL)");
const ins = db.prepare("INSERT INTO messages (channel, sender, content, created_at) VALUES (?, ?, ?, 0)");
const put = (ch, o) => ins.run(ch, o.from || "x", JSON.stringify(o)).lastInsertRowid;
const f = (subject, extra = {}) => put("t-notes", { type: "finding", from: "core", to: "*", subject, summary: `${subject} — long enough summary`, scope: ["lib/x.js"], ...extra });

const fixed = f("Watchdog suites fail with inherited WATCHDOG_NAMESPACE");
const dupA = f("Tests need node 20 for better-sqlite3 ABI");
const dupB = f("Tests need node 20: better-sqlite3 ABI mismatch");
const fallback = f("Loader drops roles key", { task_id: "t-1" });
const stays = f("Role files are gitignored setup output");
const expired = f("Temporary workaround", { expires_at: "2000-01-01T00:00:00Z" });
put("t-notes", { type: "resolved", from: "core", subject: "unrelated words entirely", ref_id: Number(fixed), outcome: "fixed" });
put("t-notes", { type: "resolved", from: "core", subject: "Loader drops roles key", outcome: "fixed", task_id: "t-1" });
put("t-notes", { type: "decision", from: "orchestrator", to: "*", subject: "Plan gate is opt-in", summary: "opt in per namespace manifest", scope: ["lib"] });
for (let i = 0; i < 3; i++) put("t-status", { type: "result", from: "protocol-qa", task_id: `t-${i}`, summary: `FAIL — run-tests ${10 + i} suites failed watchdog namespace leak` });
put("t-status", { type: "result", from: "core", task_id: "t-9", summary: "BLOCK — review found schema regression in manifest loader" });
put("t-status", { type: "result", from: "core", task_id: "t-8", summary: "PASS — all good" });

console.log("\n── resolution matching ──");
const notes = db.prepare("SELECT id, sender, content, created_at FROM messages WHERE channel='t-notes'").all()
  .map(r => ({ id: r.id, sender: r.sender, ...JSON.parse(r.content) }));
const open = openNotes(notes).map(n => n.id);
expect(!open.includes(Number(fixed)), "finding closed by ref_id even though the subject differs");
expect(!open.includes(Number(fallback)), "finding closed by subject/task_id when resolved has no ref_id");
expect(!open.includes(Number(expired)), "expired finding dropped");
expect(open.includes(Number(stays)) && open.includes(Number(dupA)), "unresolved findings stay open");

console.log("\n── clustering + compaction ──");
const ro = openDb(dbPath);
const res = runRetro(ro, "t", { date: "2026-10-29", now: new Date("2026-10-29T00:00:00Z") });
expect(res.clusters.length === 2 && res.clusters[0].count === 3, "3 similar FAILs form one cluster, BLOCK another; PASS ignored", res.clusters.map(c => c.count));
expect(res.envelope.body.proposals.length === 1 && res.envelope.body.proposals[0].target === "workers/protocol-qa/CLAUDE.md", "only the recurring cluster becomes a proposal, targeting the worker's role file");
expect(res.envelope.type === "note" && res.envelope.body.files_write.every(p => p.endsWith("CLAUDE.md")), "envelope is a type:note whose write set is role files only");
expect(/\(x2 repeats\)/.test(res.knowledge.text), "near-duplicate findings fold into one entry");
expect(res.knowledge.text.includes("## Decisions") && res.knowledge.text.includes("Plan gate is opt-in"), "decisions kept");
expect(!res.knowledge.text.includes("Temporary workaround") && !res.knowledge.text.includes("inherited WATCHDOG_NAMESPACE"), "resolved/expired findings absent from the knowledge file");
expect(/last_id=\d+/.test(res.knowledge.text), "header records last_id");


const L = (i) => i.toString(26).replace(/[0-9]/g, c => "qrstuvwxyz"[c]).replace(/[a-p]/g, c => String.fromCharCode(c.charCodeAt(0) + 17));
console.log("\n── v2: scope-aware clustering ──");
const sc = ["run-tests.js", "test-watchdog-v3.js", "test-watchdog-launch.js"];
const leak = [
  ["run-tests fails 24/27 inside watchdog sessions", "inherited WATCHDOG_NAMESPACE leaks into watchdog tests"],
  ["Session env leaks BROKER_URL into run-tests", "watchdog suites fail unless WATCHDOG_NAMESPACE is unset"],
  ["Watchdog tests fail when run from a watchdog-launched session", "inherited WATCHDOG_NAMESPACE leaks, suites reject the namespace"],
].map(([subject, summary], i) => ({ id: 100 + i, type: "finding", from: ["core", "protocol-qa", "core"][i], subject, summary, scope: sc }));
const unrelated = { id: 110, type: "finding", from: "core", subject: "node is not on PATH in worker sessions", summary: "use nvm v20 binary before running anything", scope: ["run-tests.js"] };
const sameFile = { id: 111, type: "finding", from: "core", subject: "Manifest loader rejects roles key", summary: "schema lacks roles property", scope: ["run-tests.js", "test-watchdog-v3.js"] };
const fc = clusterFindings([...leak, unrelated, sameFile]);
expect(fc.length === 1 && fc[0].count === 3 && fc[0].workers.length === 2, "env-leak findings with different subjects cluster by shared scope (x3, 2 senders)", fc.map(c => c.ids));
expect(!fc[0].ids.includes(110) && !fc[0].ids.includes(111), "negative: one shared path, or shared paths without key terms, does not merge");
const fcomp = compact("t", [...leak, unrelated, sameFile], { lastId: 111 });
expect(/\(x3 repeats\)/.test(fcomp.text) && fcomp.folded === 2, "repeat folds into one '(x3 repeats)' entry, folded=2", fcomp.text);
const fclu = clusterFailures([
  { id: 1, type: "result", from: "a", summary: "FAIL — suite exploded", affected_files: ["x.js", "y.js"] },
  { id: 2, type: "result", from: "b", summary: "FAIL — suite exploded again watchdog", affected_files: ["x.js", "y.js"] },
  { id: 3, type: "result", from: "c", summary: "FAIL — unrelated words completely different", affected_files: ["x.js", "y.js"] },
], 0.9);
expect(fclu[0].count === 2 && fclu[0].ids.join() === "1,2", "failure clusters also join on affected_files overlap plus shared words", fclu.map(c => c.ids));

console.log("\n── v2: trim policy ──");
const DAYS = 86400000, now = new Date("2026-10-29T00:00:00Z");
const dec = (id, subject, ageDays, scope) => ({ id, type: "decision", to: "*", from: "orchestrator", subject, summary: "rule text ".repeat(20), scope, ts: now.getTime() - ageDays * DAYS });
const fin = (id, subject) => ({ id, type: "finding", to: "*", from: "core", subject, summary: `finding text ${L(id)}${L(id + 7)} `.repeat(20), scope: [`f${id}.js`], ts: now.getTime() - 20 * DAYS });
const policy = [
  dec(1, "Never touch the live broker", 30, ["server.js"]),
  dec(2, "Old rule superseded", 25, ["lib/a.js"]),
  dec(3, "Newer rule replaces it", 20, ["lib/a.js"]),
  dec(4, "Fresh decision", 2, ["lib/b.js"]),
  ...Array.from({ length: 40 }, (_, i) => fin(10 + i, `alpha${L(i)} beta${L(i)} gamma${L(i)}`)),
];
const pol = compact("t", policy, { lastId: 60, now, cap: 6144 });
expect(pol.bytes <= 6144, `fits cap (${pol.bytes} B)`);
expect(/## Standing rules\n(- #3 .*\n)?- #1 Never touch the live broker\n/.test(pol.text) && !/Never touch the live broker.*rule text/.test(pol.text), "old decision kept as a one-line standing rule (subject + id, no body)");
expect(/## Decisions \(last 14 days\)\n- #4 .*rule text/.test(pol.text), "decision from the last 14 days kept in full");
expect(!/#2 \[/.test(pol.text) && /#2 by #3/.test(pol.text), "superseded decision dropped and the header names the superseding id");
expect(/shortened to \d+ chars/.test(pol.text) || pol.dropped === 0, "text shortened before any finding is dropped, and the header says so");
expect(pol.standing === 2 && pol.superseded === 1 && /standing rules/.test(pol.text), "header states counts", pol.text.split("\n")[3]);
const tight = compact("t", policy, { lastId: 60, now, cap: 1300 });
expect(tight.bytes <= 1300 && tight.dropped > 0 && /- #1 Never/.test(tight.text) && /- #4 \[/.test(tight.text), "under a tight cap findings are dropped; decisions and standing rules never are", tight.bytes);
expect(/dropped for size/.test(tight.text) && new RegExp(`${tight.dropped} dropped for size`).test(tight.text), "header counts dropped separately from folded");

console.log("\n── retro fixes: string scope, 70-char floor, per-sender targets, note envelope ──");
const strScope = [
  { id: 201, type: "finding", from: "core", to: "*", subject: "Single string scope finding one", summary: "scope given as a bare string", scope: "lib/a.js" },
  { id: 202, type: "finding", from: "core", to: "*", subject: "Single string scope finding two", summary: "scope given as a bare string again", scope: "lib/a.js" },
];
let strOk = true;
try { compact("t", strScope, { lastId: 202 }); clusterFindings(strScope); } catch (e) { strOk = false; }
expect(strOk, "string scope does not crash compact/clusterFindings");
const strRows = db.prepare("INSERT INTO messages (channel, sender, content, created_at) VALUES ('s-notes','core',?,0)");
strRows.run(JSON.stringify({ type: "finding", from: "core", subject: "String scope via loadChannel", summary: "x", scope: "lib/a.js" }));
expect(loadChannel(openDb(dbPath), "s-notes")[0].scope.join() === "lib/a.js", "loadChannel normalises string scope to [string]");

const bigPol = [...policy, ...Array.from({ length: 40 }, (_, i) => fin(100 + i, `delta${L(i)} epsilon${L(i)} zeta${L(i)}`))];
for (const cap of [1500, 2500, 3500, 5000]) {
  const c = compact("t", bigPol, { lastId: 200, now, cap });
  const lens = [...c.text.matchAll(/^- #(?:[1-9]\d{1,2}) \[[^\n]*?: (.*)$/gm)].map(m => m[1].length);
  expect(lens.length > 0 && c.shortened_to >= 70 && lens.every(n => n >= Math.min(70, 220)), `cap ${cap}: no entry shortened below 70 chars (shortened_to=${c.shortened_to})`, lens.filter(n => n < 70));
}

const multi = [
  { id: 301, type: "result", from: "core", summary: "FAIL — suite exploded watchdog namespace leak", affected_files: ["x.js", "y.js"] },
  { id: 302, type: "result", from: "protocol-qa", summary: "FAIL — suite exploded watchdog namespace leak again", affected_files: ["x.js", "y.js"] },
];
const mp = proposeEdits("t", clusterFailures(multi), { date: "2026-10-29" });
expect(mp.body.proposals.map(p => p.target).sort().join() === "workers/core/CLAUDE.md,workers/protocol-qa/CLAUDE.md", "multi-sender cluster targets each sender's role file", mp.body.proposals.map(p => p.target));

const orchInbox = JSON.parse(readFileSync("schemas/cb-orchestrator-inbox.json", "utf8"));
const validate = new Ajv({ allErrors: true, strict: false }).compile(orchInbox);
expect(mp.type === "note" && validate(mp), "retro envelope is type:note and validates against cb-orchestrator-inbox", validate.errors);
expect(validate(res.envelope), "empty-proposals envelope validates too", validate.errors);

console.log("\n── size cap ──");
const many = Array.from({ length: 200 }, (_, i) => ({ id: i + 1, type: "finding", to: "*", subject: `alpha${L(i)} beta${L(i)} gamma${L(i)}`, summary: "s".repeat(200), scope: ["a"] }));
const big = compact("t", many, { lastId: 200 });
expect(big.bytes <= KNOWLEDGE_CAP_BYTES && big.replaced > 0, `200 notes compact to ${big.bytes} B ≤ cap`, big.bytes);

console.log("\n── decision pressure: shorten, merge, then allowed overflow ──");
let seed = 12345; // deterministic distinct words: dedupe must not fold these fixtures
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const word = () => Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(rnd() * 26))).join("");
const longDec = (id, scope, ageDays = 2) => dec(id, `Decision ${Array.from({ length: 14 }, word).join(" ")}`, ageDays, scope);
const idsIn = (text) => new Set([...text.matchAll(/^- #(\d+) /gm)].map(m => Number(m[1])));
// ids a reader can find: header "#a by #b" pairs (first 4) plus every id in a kept line's "(merges #a, #b)".
const mergedIds = (text) => new Set([...text.matchAll(/#(\d+) by #\d+/g)].map(m => Number(m[1]))
  .concat([...text.matchAll(/\(merges ([^)]*)\)/g)].flatMap(m => [...m[1].matchAll(/#(\d+)/g)].map(x => Number(x[1])))));

// (1) subjects are shortened (never below 70 chars) before anything is merged.
const subjOnly = Array.from({ length: 30 }, (_, i) => longDec(100 + i, [`own${i}.js`]));
const so = compact("t", subjOnly, { lastId: 1, now, cap: 6144 });
expect(so.bytes <= 6144 && so.merged === 0 && !so.over_cap, `subject shortening alone fits (${so.bytes} B), nothing merged, no warning`, { bytes: so.bytes, merged: so.merged, subject_max: so.subject_max });
expect(so.subject_max >= 70 && so.subject_max < Infinity && /decision subjects to \d+ chars/.test(so.text), `header says decision subjects were shortened (to ${so.subject_max})`);
expect(subjOnly.every(d => idsIn(so.text).has(d.id)), "every decision still listed after shortening");
const subjLens = [...so.text.matchAll(/^- #\d+ \[\*\] (.*?) — /gm)].map(m => m[1].length);
expect(subjLens.length > 0 && subjLens.every(n => n >= 70 || n >= Math.min(...subjLens)) && Math.max(...subjLens) <= so.subject_max, "decision subjects are clipped to the step and never below 70 chars", subjLens.slice(0, 5));

// (2) overlapping scope: older merged into the later, only as many as the cap needs; both ids cited.
const shared = Array.from({ length: 60 }, (_, i) => longDec(200 + i, ["lib/shared.js", `own${i}.js`]));
const r2 = compact("t", shared, { lastId: 1, now, cap: 6144, hubMax: Infinity }); // one path on all 60 is a hub by default; this block tests the bare merge rule
const ids2 = idsIn(r2.text), gone2 = mergedIds(r2.text);
expect(r2.merged > 0 && r2.bytes <= 6144 && !r2.over_cap, `overlapping scope: merged ${r2.merged} of 60, fits ${r2.bytes} B, no warning`, { merged: r2.merged, bytes: r2.bytes });
expect(r2.merged < 59, "merging stops once the cap is met (not everything collapses into one)", r2.merged);
expect(shared.every(d => ids2.has(d.id) || gone2.has(d.id)), "every decision is listed or named in the header as merged (none silently dropped)");
expect(!shared.some(d => ids2.has(d.id) && gone2.has(d.id)), "a merged decision is not also listed");
const chain = [...r2.text.matchAll(/\(merges ((?:#\d+(?:, )?)+)\)/g)].map(m => m[1].split(", ").length);
expect(chain.length > 0 && /decisions merged into a later one \(#\d+ by #\d+/.test(r2.text), "kept line and header cite the ids", chain);
expect(compact("t", shared.slice(0, 3), { lastId: 1, now, cap: 6144 }).merged === 0, "under the cap nothing is merged, overlapping scope or not");
const chained = compact("t", [longDec(1, ["a.js", "b.js"]), longDec(2, ["b.js", "c.js"]), longDec(3, ["c.js"])], { lastId: 1, now, cap: 700 });
expect(/#3 .*\(merges #(2, #1|1, #2)\)/.test(chained.text) && idsIn(chained.text).size === 1 && chained.merged === 2, "a chain of three keeps the newest, citing every merged id", chained.text.slice(0, 500));
expect(compact("t", shared.slice(0, 3), { lastId: 1, now, cap: 6144 }).merged === 0, "under the cap nothing is merged, overlapping scope or not");

// (2b) narrowed rule: same subject or a shared exact file path merges; directory/glob scopes never do.
const sameSubj = Array.from({ length: 60 }, (_, i) => ({ ...longDec(300 + i, [`own${i}.js`]), subject: (i % 2 ? "Go on, to do it!" : "go on to DO it") }));
// (dedupe already folds subjects that share key terms; this subject has none, so only the merge rule can join them)
const rs = compact("t", sameSubj, { lastId: 1, now, cap: 2500 });
expect(rs.merged > 0, "same subject (case-insensitive) merges under pressure", rs.merged);
const dirs = compact("t", Array.from({ length: 60 }, (_, i) => longDec(400 + i, ["lib/", `own${i}.js`])), { lastId: 1, now, cap: 2500 });
expect(dirs.merged === 0 && dirs.over_cap, "shared 'lib/' does not merge (overflows with the over-cap header)", { merged: dirs.merged, over_cap: dirs.over_cap });
const globs = compact("t", Array.from({ length: 60 }, (_, i) => longDec(500 + i, ["retro/*", `own${i}.js`])), { lastId: 1, now, cap: 2500 });
expect(globs.merged === 0, "shared glob 'retro/*' does not merge", globs.merged);
const files = compact("t", Array.from({ length: 60 }, (_, i) => longDec(600 + i, ["lib/shared.js", `own${i}.js`])), { lastId: 1, now, cap: 2500, hubMax: Infinity });
expect(files.merged > 0, "shared exact file path merges", files.merged);

// (2c) hubs: a path on more than hubMax (default 8) open decisions, or named in hubPaths, is a topic, not a shared file.
const mergeCause = (r, ids) => [...r.text.matchAll(/\(merges ((?:#\d+(?:, )?)+)\)/g)].flatMap(m => [...m[1].matchAll(/#(\d+)/g)].map(x => Number(x[1]))).filter(i => ids.includes(i));
const topic = Array.from({ length: 30 }, (_, i) => longDec(700 + i, ["brand-a", `own${i}.js`]));
const pair = [longDec(760, ["lib/real.js", "p0.js"]), longDec(761, ["lib/real.js", "p1.js"])];
const hubOn = compact("t", [...topic, ...pair], { lastId: 1, now, cap: 2500 });
expect(hubOn.merged === 1 && mergeCause(hubOn, [760]).length === 1, "a topic tag on 30 decisions is a hub: only the pair sharing lib/real.js merges", { merged: hubOn.merged, text: hubOn.text.slice(0, 300) });
const hubOff = compact("t", [...topic, ...pair], { lastId: 1, now, cap: 2500, hubMax: Infinity });
expect(hubOff.merged > 1, `hub exclusion off (hubMax Infinity): the tag merges unrelated decisions too (${hubOff.merged})`, hubOff.merged);
const eight = Array.from({ length: 8 }, (_, i) => longDec(800 + i, ["docs/eight.md", `e${i}.js`])), nine = Array.from({ length: 9 }, (_, i) => longDec(820 + i, ["docs/nine.md", `n${i}.js`]));
const filler = Array.from({ length: 25 }, (_, i) => longDec(850 + i, [`own${i}.js`]));
expect(compact("t", [...eight, ...filler], { lastId: 1, now, cap: 2500 }).merged > 0, "a path on exactly hubMax (8) decisions is not a hub: it merges");
expect(compact("t", [...nine, ...filler], { lastId: 1, now, cap: 2500 }).merged === 0, "a path on 9 decisions is a hub: no merge");
expect(compact("t", [...nine, ...filler], { lastId: 1, now, cap: 2500, hubMax: 9 }).merged > 0, "hubMax 9 makes the same path a merge key again");
expect(compact("t", [...eight, ...filler], { lastId: 1, now, cap: 2500, hubPaths: ["docs/eight.md"] }).merged === 0, "hubPaths names a path as a hub whatever its count");
// Counted before superseded decisions are dropped: 14 decisions on one tag, 7 of them superseded by an identical-scope successor, still make it a hub.
const sup = [];
for (let i = 0; i < 6; i++) sup.push(longDec(900 + i, ["topic2", `s${i}.js`]));
for (let i = 0; i < 4; i++) { sup.push(longDec(910 + i, ["topic2", "dup.js"])); sup.push(longDec(920 + i, ["topic2", "dup.js"])); }
expect(compact("t", [...sup, ...filler], { lastId: 1, now, cap: 2500 }).merged === 0, "hub count includes superseded decisions (tag on 14 open decisions stays a hub)");

// (3) still over: write anyway, header names the real size, decisions kept.
const flood = Array.from({ length: 400 }, (_, i) => longDec(1000 + i, [`own${i}.js`]));
const fl = compact("t", flood, { lastId: 7, now, cap: 6144 });
const warn = /^<!-- over cap: (\d+) B > 6144 B, decisions kept -->$/m.exec(fl.text);
expect(fl.over_cap && fl.bytes > 6144 && warn && Number(warn[1]) === fl.bytes, "over cap: file written with the warning line stating its own size", { bytes: fl.bytes, warn: warn?.[0] });
expect(fl.text.split("\n")[1] === OVER_CAP(fl.bytes, 6144).trimEnd() && /last_id=7/.test(fl.text.slice(0, 200)), "warning is the 2nd line; last_id stays within the first 200 chars");
expect(flood.every(d => idsIn(fl.text).has(d.id)), "over cap: all 400 decisions still listed");
expect(!so.text.includes("over cap"), "no warning when the file fits");

// (4) findings go first: decisions are not touched while dropping findings suffices.
const mixed = [dec(1, "Keep me whole", 1, ["a.js"]), ...Array.from({ length: 60 }, (_, i) => fin(10 + i, `${word()} ${word()} ${word()}`))];
const mx = compact("t", mixed, { lastId: 1, now, cap: 4000 });
expect(mx.bytes <= 4000 && mx.dropped > 0 && mx.subject_max === Infinity && mx.merged === 0, "findings are dropped before decision subjects are shortened or merged", { dropped: mx.dropped, subject_max: mx.subject_max });

console.log("\n── cb manifest: one retro worker, one cb-retro inbox ──");
const cbm = JSON.parse(readFileSync("schemas/manifests/cb.json", "utf8"));
const retroWorkers = cbm.workers.filter(w => /retro/.test(w.name) || /retro/.test(w.inbox));
expect(retroWorkers.length === 1 && retroWorkers[0].name === "retro" && retroWorkers[0].inbox === "cb-retro", "workers[] has exactly one retro entry: name 'retro' (the watchdog's cursor key), inbox cb-retro", retroWorkers);
expect(cbm.channels.filter(c => c.name === "cb-retro").length === 1 && !cbm.workers.some(w => w.name === "cb-retro"), "cb-retro is one channel (the inbox) and not a second worker");
expect(new Set(cbm.workers.map(w => w.inbox)).size === cbm.workers.length, "no two workers share an inbox");

console.log("\n── README: weekly dispatch example is strict-valid ──");
const readme = readFileSync("retro/README.md", "utf8");
const exJson = /```json\n([\s\S]*?)\n```/.exec(readme)?.[1];
const ex = exJson && JSON.parse(exJson);
const inboxV = new Ajv({ allErrors: true, strict: false });
const checkInbox = inboxV.compile(JSON.parse(readFileSync("schemas/cb-worker-inbox.json", "utf8")));
expect(ex && checkInbox(ex), "the example task validates against the strict cb-worker-inbox.json", ex && checkInbox.errors?.slice(0, 3));
expect(ex?.scope && Array.isArray(ex?.acceptance_criteria) && ex.acceptance_criteria.length > 0, "example carries scope and acceptance_criteria");
expect(!/\bcommit(s)? docs\/knowledge/i.test(readme.split("## Weekly dispatch")[1] || "") || /orchestrator commits/.test(readme), "README does not tell the retro to commit");

console.log("\n── staleness ──");
{
  const NOW = new Date("2026-10-30T00:00:00Z"), D = 86400000;
  const sdb = new Database(join(dir, "s.db"));
  sdb.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, sender TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL)");
  const sins = sdb.prepare("INSERT INTO messages (channel, sender, content, created_at) VALUES (?, ?, ?, ?)");
  const sput = (ch, o, ageDays) => Number(sins.run(ch, o.from || "x", JSON.stringify(o), NOW.getTime() - ageDays * D).lastInsertRowid);
  const fail = (task, text, files, age) => sput("s-status", { type: "result", from: "core", task_id: task, subject: text, summary: `FAIL — ${text}`, affected_files: files }, age);
  // A: fixed by a later PASS sharing two files. B: only one shared file with a later PASS (must stay live).
  // C: closed by type:resolved with ref_id on a cluster member. D: untouched but older than 7 days. E: fresh and unfixed.
  const a = [1, 2].map(i => fail(`a-${i}`, "alpha gadget crashes on startup handshake", ["lib/a.js", "lib/b.js"], 3));
  const b = [1, 2].map(i => fail(`b-${i}`, "bravo widget loses frames under backpressure", ["lib/c.js", "lib/d.js"], 3));
  const c = [1, 2].map(i => fail(`c-${i}`, "charlie spooler drops queued entries after restart", ["lib/e.js", "lib/f.js"], 3));
  const d = [1, 2].map(i => fail(`d-${i}`, "delta indexer stalls while compacting segments", ["lib/g.js", "lib/h.js"], 9));
  const e = [1, 2].map(i => fail(`e-${i}`, "echo balancer starves low priority lanes", ["lib/i.js", "lib/j.js"], 1));
  sput("s-status", { type: "result", from: "protocol-qa", task_id: "a-fix", subject: "unrelated words", summary: "PASS — fixed", affected_files: ["lib/a.js", "lib/b.js", "x.js"] }, 2);
  sput("s-status", { type: "result", from: "protocol-qa", task_id: "b-fix", subject: "other words", summary: "PASS — touched one file", affected_files: ["lib/c.js"] }, 2);
  sput("s-notes", { type: "resolved", from: "orchestrator", subject: "closed", ref_id: c[1], outcome: "fixed" }, 1);
  const r = runRetro(openDb(join(dir, "s.db")), "s", { now: NOW });
  const by = (id) => r.clusters.find(x => x.ids.includes(id));
  expect(by(a[0]).stale === "fixed", "later PASS sharing two files marks the FAIL cluster stale (fixed)", by(a[0]));
  expect(!by(b[0]).stale, "negative: a later PASS sharing only one file does not mark it stale", by(b[0]).stale);
  expect(by(c[0]).stale === "resolved", "type:resolved with ref_id on a cluster member marks it stale (resolved)", by(c[0]).stale);
  expect(by(d[0]).stale === "old", "no new evidence for more than 7 days: stale (old)", by(d[0]));
  expect(!by(e[0]).stale, "fresh, unfixed cluster stays live", by(e[0]).stale);
  expect(by(e[0]).last_seen === new Date(NOW.getTime() - D).toISOString() && by(a[0]).last_seen, "clusters carry last_seen", by(e[0]).last_seen);
  expect(r.envelope.body.proposals.map(p => p.evidence_ids.join()).sort().join("|") === [b, e].map(x => x.join()).sort().join("|"),
    "only the live clusters (b, e) become proposals", r.envelope.body.proposals.map(p => p.evidence_ids));
  const wide = runRetro(openDb(join(dir, "s.db")), "s", { now: NOW, staleDays: 30 });
  expect(!wide.clusters.find(x => x.ids.includes(d[0])).stale && wide.envelope.body.proposals.length === 3, "staleDays is configurable (30 d keeps d live)", wide.envelope.body.proposals.length);
  // Same task_id: a retry that passes under the same id fixes a single-file cluster.
  const solo = markStale(clusterFailures([{ id: 1, type: "result", from: "core", task_id: "t-same", subject: "solo failure here", summary: "FAIL — solo failure here", affected_files: ["x.js"], ts: NOW.getTime() }]),
    { results: [{ id: 2, type: "result", task_id: "t-same", subject: "zzz", summary: "PASS — ok" }], now: NOW });
  expect(solo[0].stale === "fixed", "a later PASS with the same task_id marks it stale");
  const earlier = markStale(clusterFailures([{ id: 5, type: "result", from: "core", task_id: "t-same", subject: "solo failure here", summary: "FAIL — solo failure here", affected_files: ["x.js"], ts: NOW.getTime() }]),
    { results: [{ id: 2, type: "result", task_id: "t-same", subject: "zzz", summary: "PASS — ok" }], now: NOW });
  expect(!earlier[0].stale, "a PASS from before the failure does not count");
  // Finding clusters (the WATCHDOG_NAMESPACE-leak shape) go through the same rules.
  const fs = [1, 2, 3].map(i => ({ id: 10 + i, type: "finding", from: "core", to: "*", subject: `suite leaks inherited env variable ${i}`, summary: "watchdog suites reject test inboxes", scope: ["run-tests.js", "test-watchdog-v3.js"], ts: NOW.getTime() - D }));
  const fc2 = clusterFindings(fs);
  expect(fc2.length === 1 && markStale(fc2, { results: [{ id: 99, type: "result", summary: "PASS — suites green", affected_files: ["run-tests.js", "test-watchdog-v3.js"] }], now: NOW })[0].stale === "fixed", "finding cluster with a later PASS on the same files is stale");
}

console.log("\n── CLI ──");
const out = join(dir, "k");
const run = (...a) => execFileSync(process.execPath, ["retro/retro.mjs", "--ns", "t", "--db", dbPath, "--out", out, ...a], { encoding: "utf8" });
expect(!existsSync(join(out, "t.md")) && /knowledge/.test(run("--dry-run")) && !existsSync(join(out, "t.md")), "--dry-run writes nothing");
const lg = run("--dry-run");
expect(/\d+ merged, over_cap=(true|false), of \d+/.test(lg), "log line carries merged and over_cap", lg);
const js = JSON.parse(run("--dry-run", "--json"));
expect(Number.isInteger(js.merged) && typeof js.over_cap === "boolean" && "kept" in js && "total" in js && !("text" in js), "--json carries merged, over_cap, kept, total (no text)", js);
run("--envelope", join(dir, "env.json"));
expect(existsSync(join(out, "t.md")) && existsSync(join(dir, "env.json")), "CLI writes knowledge + envelope");
const before = Number(db.prepare("SELECT COUNT(*) c FROM messages").get().c);
expect(/clusters/.test(run()) && /\b0 failure clusters/.test(run()), "second run resumes from last_id: no new failures");
expect(Number(db.prepare("SELECT COUNT(*) c FROM messages").get().c) === before, "DB unchanged");
let ro2 = false;
try { openDb(dbPath).prepare("INSERT INTO messages (channel,sender,content,created_at) VALUES ('a','b','c',0)").run(); } catch { ro2 = true; }
expect(ro2, "DB handle is read-only");

rmSync(dir, { recursive: true, force: true });
console.log(`\n[test-retro] passed=${passed} failed=${failed}`);
