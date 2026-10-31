// Spend patrol (runner/spend-patrol.mjs, runner/README.md "Spend patrol"), against its own throwaway broker
// (free port, temp DB) and a temp usage-ledger dir seeded with 8 days of rows:
//   1. decide(): ok at 1x, finding above 3x, question at >= 10x, below-floor, no baseline (none / zero average)
//   2. telemetry: an hour's spend is the per-session delta of cumulative cost_since_start, never a sum of
//      totals; a session that has a ledger row is not counted again
//   3. empty SPEND_PATROL_NAMESPACES: exit 0, nothing read or posted
//   4. --dry-run: prints the table with per-ns coverage (history days, sources), posts nothing
//   5. live run: 1x silent; 3.5x one finding on <ns>-notes (valid against schemas/notes.json); 12x a finding
//      plus a question on <ns>-orchestrator (valid against the orchestrator-inbox shape); under 7 days of
//      history, a zero average and a jump under the $ floor all stay silent
//   6. dedupe: a rerun for the same hour posts nothing new
// Nothing reaches the live broker: BROKER_*, PORT, WATCHDOG_* and SPEND_PATROL_* are scrubbed.
import { spawnSync } from "child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import Ajv from "ajv";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startScratchBroker } from "./test-lib-broker.js";
import { decide, telemetryDeltas, evaluate, readLedger, lastHourStart, alertTaskId, HOUR, DAY } from "./runner/spend-patrol.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const TAG = Date.now().toString(36);
const SECRET = `spend-patrol-${process.pid}-${TAG}`;

let passed = 0, failed = 0;
function expect(cond, label, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); return true; }
  failed++; console.error(`  ✗ ${label}`);
  if (detail !== undefined) console.error(`     detail: ${String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 1500)}`);
  process.exitCode = 1; return false;
}
function cleanEnv(extra = {}) {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (/^(WATCHDOG|BROKER|FOLLOWUP|SPEND_PATROL)_/.test(k) || ["PORT", "DB_PATH", "TEST_PORT", "WORKERS_CONFIG", "SHARED_SECRET", "ADMIN_SECRET"].includes(k)) delete e[k];
  return { ...e, ...extra };
}

// ── 1. decide() ───────────────────────────────────────────────────────────────
console.log("\n1. decide()");
expect(decide({ spend: 5, avg: 5 }).level === "ok", "1x → ok");
expect(decide({ spend: 15, avg: 5 }).level === "ok", "exactly 3x → ok (alert needs > 3x)");
expect(decide({ spend: 17.5, avg: 5 }).level === "finding", "3.5x → finding");
expect(decide({ spend: 50, avg: 5 }).level === "question", "10x → question");
expect(decide({ spend: 1, avg: 0.1, minUsd: 2 }).level === "below-floor", "10x under the $2 floor → below-floor");
expect(decide({ spend: 100, avg: null }).level === "no-baseline", "no history → no-baseline, whatever the spend");
expect(decide({ spend: 100, avg: 0 }).level === "no-baseline", "zero average → no-baseline, whatever the spend");

// ── 2. telemetry deltas ───────────────────────────────────────────────────────
console.log("\n2. telemetry deltas");
{
  const H = Date.parse("2026-10-20T09:00:00Z");
  const hb = (sid, minOffset, usd, sender = "w") => ({ sender, content: { type: "heartbeat", from: sender, session_id: sid, ts: new Date(H + minOffset * 60000).toISOString(), cost_since_start: { estimated_usd: usd } } });
  const d = telemetryDeltas([hb("s1", -10, 5), hb("s1", 10, 5.2), hb("s1", 50, 5.5), hb("s2", 20, 1), hb("s2", 40, 1.75), hb("s3", 30, 9), hb("s4", 70, 99)], H, H + HOUR, new Set(["s3"]));
  const by = Object.fromEntries(d.map(x => [x.key, x.usd]));
  expect(Math.abs(by.s1 - 0.5) < 1e-9, "a session alive before the hour: latest in hour minus latest before (5.5 - 5)", by);
  expect(Math.abs(by.s2 - 0.75) < 1e-9, "a session started in the hour: latest minus earliest in hour", by);
  expect(!("s3" in by), "a session that has a ledger row is skipped", by);
  expect(!("s4" in by), "a heartbeat after the hour is ignored", by);
  const r = evaluate({ ns: "t", ledgerRows: [], telemetry: d, hourStart: H });
  expect(Math.abs(r.spend_usd - 1.25) < 1e-9 && r.coverage.sources.includes("telemetry"), "hour spend = sum of deltas (1.25), not of totals (6.5+)", r);
}

// ── fixtures: ledger dir ──────────────────────────────────────────────────────
const NOW = new Date("2026-10-20T10:05:00Z");
const H = lastHourStart(NOW);
const ns = (s) => `sp${TAG}${s}`;
const NS = { one: ns("one"), three: ns("three"), ten: ns("ten"), fresh: ns("new"), zero: ns("zero"), floor: ns("floor") };
const dir = mkdtempSync(join(tmpdir(), "spend-patrol-"));
const ledgerDir = join(dir, "usage");
mkdirSync(ledgerDir);
let seq = 0;
const rows = [];
const row = (n, ts, cost, sid = `sess-${n}-${seq++}`) => rows.push({ v: 1, ts: new Date(ts).toISOString(), source: "claude", ref: sid, ns: n, worker: "w", session_id: sid, cost_usd: cost, launcher: "sdk" });
// Baseline: $1 in the same hour on each of the previous 8 days (avg over 7 = $1), for one/three/ten.
for (const n of [NS.one, NS.three, NS.ten]) for (let d = 1; d <= 8; d++) { row(n, H - d * DAY + 600000, 0.4); row(n, H - d * DAY + 1800000, 0.6); }
row(NS.one, H + 600000, 1);
row(NS.three, H + 600000, 3);              // + $0.5 telemetry delta below = $3.5
row(NS.ten, H + 600000, 12);
row(NS.ten, H + 600000, 12, rows.at(-1).session_id);  // a duplicate (same source+ref) row is not counted twice
// Under 7 days of history: 3 days, big spend.
for (let d = 1; d <= 3; d++) row(NS.fresh, H - d * DAY + 600000, 1);
row(NS.fresh, H + 600000, 50);
// 8 days of history, but never in this hour: zero same-hour average.
for (let d = 1; d <= 8; d++) row(NS.zero, H - d * DAY + 5 * HOUR, 1);
row(NS.zero, H + 600000, 40);
// 5x jump, but $0.50 is under the $2 floor.
for (let d = 1; d <= 8; d++) row(NS.floor, H - d * DAY + 600000, 0.1);
row(NS.floor, H + 600000, 0.5);
// Spread across two files by local date, plus a junk line.
const half = Math.floor(rows.length / 2);
writeFileSync(join(ledgerDir, "2026-10-12.jsonl"), rows.slice(0, half).map(r => JSON.stringify(r)).join("\n") + "\n{not json\n");
writeFileSync(join(ledgerDir, "2026-10-20.jsonl"), rows.slice(half).map(r => JSON.stringify(r)).join("\n") + "\n");
{
  const l = readLedger([ledgerDir]);
  expect(l.rows.length === rows.length - 1 && l.skipped === 1, "readLedger: dedupes (source, ref), skips a bad line", { rows: l.rows.length, skipped: l.skipped });
}

// ── scratch broker ────────────────────────────────────────────────────────────
let brokerProc, BASE, brokerLog = "";
const h = await startScratchBroker({ root: ROOT, onData: d => { brokerLog += d; },
  env: (port) => cleanEnv({ PORT: String(port), DB_PATH: join(dir, "broker.db"), SHARED_SECRET: SECRET, ADMIN_SECRET: `${SECRET}-a`,
    WATCHDOG_BIN: "", WORKERS_CONFIG: "", WORKERS_LOG_DIR: join(dir, "logs"), WORKERS_TMUX_SESSION: "", TMUX_BIN: "", PRUNE_EXEMPT: "" }) });
brokerProc = h.proc; BASE = h.base;

const client = new Client({ name: "test-spend-patrol", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${SECRET}` } } }));
async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  return { text: r.content?.[0]?.text ?? "", isError: !!r.isError };
}
async function post(channel, sender, obj) {
  const r = await call("send_message", { channel, sender, content: JSON.stringify(obj) });
  if (r.isError) throw new Error(`post to ${channel} failed: ${r.text}`);
}
async function messages(channel) {
  const r = await call("read_messages", { channel, since_id: 0, limit: 500 });
  return r.text.split("\n").filter(l => /^\[#\d+\]/.test(l)).map(l => {
    const m = /^\[#(\d+)\] \S+ <([^>]*)>: (.*)$/.exec(l);
    return { id: Number(m[1]), sender: m[2], content: JSON.parse(m[3]) };
  });
}
const hbAt = (sid, ms, usd) => ({ type: "heartbeat", from: "w", state: "running", session_id: sid, ts: new Date(ms).toISOString(), cost_since_start: { estimated_usd: usd } });
// three: an unmetered (no ledger row) session at $5 before the hour and $5.5 in it → +$0.5.
await post(`${NS.three}-telemetry`, "w", hbAt("tele-1", H - 600000, 5));
await post(`${NS.three}-telemetry`, "w2", hbAt("tele-1", H + 1200000, 5.5));
// ten: a heartbeat for a session the ledger already has: not counted again.
await post(`${NS.ten}-telemetry`, "w", hbAt(rows.find(r => r.ns === NS.ten && r.cost_usd === 12).session_id, H + 1200000, 12));

const ALL = Object.values(NS).join(",");
function runPatrol(extraEnv = {}, args = []) {
  return spawnSync(process.execPath, [join(ROOT, "runner/spend-patrol.mjs"), `--now=${NOW.toISOString()}`, ...args], {
    env: cleanEnv({ BROKER_URL: BASE, BROKER_SECRET: SECRET, SPEND_PATROL_LEDGER_DIRS: ledgerDir, SPEND_PATROL_NAMESPACES: ALL, ...extraEnv }),
    encoding: "utf8", timeout: 60000,
  });
}
const alertChannels = Object.values(NS).flatMap(n => [`${n}-notes`, `${n}-orchestrator`]);
const countAlerts = async () => (await Promise.all(alertChannels.map(messages))).reduce((a, m) => a + m.length, 0);

try {
  // ── 3. opt-in ──────────────────────────────────────────────────────────────
  console.log("\n3. opt-in");
  {
    const r = runPatrol({ SPEND_PATROL_NAMESPACES: "" });
    expect(r.status === 0 && /nothing to do/.test(r.stderr) && r.stdout.trim() === "", "empty SPEND_PATROL_NAMESPACES: exit 0, no table", { status: r.status, out: r.stdout, err: r.stderr });
    expect(await countAlerts() === 0, "empty SPEND_PATROL_NAMESPACES: nothing posted");
  }

  // ── 4. dry run ─────────────────────────────────────────────────────────────
  console.log("\n4. --dry-run");
  {
    const r = runPatrol({}, ["--dry-run"]);
    expect(r.status === 0, "dry run exits 0", r.stderr);
    expect(/history_d/.test(r.stdout) && /sources/.test(r.stdout) && /dry run: nothing posted/.test(r.stdout), "dry run prints the table with coverage columns", r.stdout);
    const line = (n) => r.stdout.split("\n").find(l => l.startsWith(n + " ")) || "";
    expect(/question/.test(line(NS.ten)) && /finding/.test(line(NS.three)) && /\bok\b/.test(line(NS.one)), "dry run table shows the levels it would act on", r.stdout);
    expect(/ledger\+telemetry/.test(line(NS.three)) && /\b8\b/.test(line(NS.three)), "coverage: history days and sources per ns", line(NS.three));
    expect(/\b3\b/.test(line(NS.fresh)) && /no-baseline/.test(line(NS.fresh)), "coverage shows a 3-day namespace as no-baseline", line(NS.fresh));
    expect(await countAlerts() === 0, "dry run posts nothing");
    const j = runPatrol({}, ["--dry-run", "--json"]);
    const out = JSON.parse(j.stdout);
    const by = Object.fromEntries(out.rows.map(x => [x.ns, x]));
    expect(out.dry_run === true && out.posts.length === 0, "--json dry run: no posts", out.posts);
    expect(by[NS.three].spend_usd === 3.5 && by[NS.three].telemetry_usd === 0.5 && by[NS.three].avg_usd === 1, "three: $3 ledger + $0.5 telemetry delta vs $1 average", by[NS.three]);
    expect(by[NS.ten].spend_usd === 12 && by[NS.ten].ratio === 12, "ten: duplicate ledger row and its heartbeat not double-counted (12x)", by[NS.ten]);
    expect(by[NS.zero].level === "no-baseline" && by[NS.zero].avg_usd === 0, "zero same-hour average → no-baseline", by[NS.zero]);
    expect(by[NS.floor].level === "below-floor", "5x at $0.50 → below-floor", by[NS.floor]);
  }

  // ── 5. live run ────────────────────────────────────────────────────────────
  console.log("\n5. alerts");
  const notesSchema = JSON.parse(readFileSync(join(ROOT, "schemas/notes.json"), "utf8"));
  const orchSchema = JSON.parse(readFileSync(join(ROOT, "schemas/cb-orchestrator-inbox.json"), "utf8"));
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
  const validNote = ajv.compile(notesSchema), validQuestion = ajv.compile(orchSchema);
  {
    const r = runPatrol();
    expect(r.status === 0, "live run exits 0", r.stdout + r.stderr);
    const n3 = await messages(`${NS.three}-notes`), o3 = await messages(`${NS.three}-orchestrator`);
    expect(n3.length === 1 && n3[0].content.type === "finding" && n3[0].sender === "spend-patrol", "3.5x: one finding on <ns>-notes", n3);
    expect(n3[0] && validNote(n3[0].content), "the finding validates against schemas/notes.json", validNote.errors);
    expect(n3[0]?.content.task_id === alertTaskId(NS.three, H), "finding task_id is spend-patrol-<ns>-<hour>", n3[0]?.content.task_id);
    expect(o3.length === 0, "3.5x: no question", o3);
    const n10 = await messages(`${NS.ten}-notes`), o10 = await messages(`${NS.ten}-orchestrator`);
    expect(n10.length === 1 && validNote(n10[0].content), "12x: one valid finding", n10);
    expect(o10.length === 1 && o10[0].content.type === "question" && validQuestion(o10[0].content), "12x: one question on <ns>-orchestrator, valid inbox shape", { o10, errors: validQuestion.errors });
    for (const k of ["one", "fresh", "zero", "floor"]) {
      const m = [...await messages(`${NS[k]}-notes`), ...await messages(`${NS[k]}-orchestrator`)];
      expect(m.length === 0, `${k}: no alert`, m);
    }
  }

  // ── 6. dedupe ──────────────────────────────────────────────────────────────
  console.log("\n6. dedupe");
  {
    const before = await countAlerts();
    const r = runPatrol();
    expect(r.status === 0 && /already posted/.test(r.stdout), "rerun of the same hour reports already posted", r.stdout + r.stderr);
    expect(await countAlerts() === before, "rerun posts nothing new", { before, after: await countAlerts() });
  }
} finally {
  await client.close().catch(() => {});
  try { brokerProc.kill("SIGTERM"); } catch {}
  if (process.env.TEST_KEEP !== "1") rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.error(brokerLog.slice(-2000)); process.exit(1); }
process.exit(0);
