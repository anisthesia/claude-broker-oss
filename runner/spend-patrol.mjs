// Spend patrol: once an hour, compares each opted-in namespace's spend in the last complete hour with the
// trailing 7-day average of the same hour of day, and tells the namespace when it jumps.
//
//   > 3x the average   one type:finding on <ns>-notes (valid against schemas/notes.json)
//   >= 10x             also one type:question on <ns>-orchestrator
//   both need the hour's spend >= SPEND_PATROL_MIN_USD (default $2): a jump from cents to cents is not news
//   no baseline        under 7 days of history, or a zero average: never alerts (there is no ratio to judge)
//
// Each alert is deduped per namespace per hour by its task_id, spend-patrol-<ns>-<YYYY-MM-DDTHH> (UTC hour
// start), looked up on the target channel before posting, so a rerun of the same hour posts nothing new.
//
// Sources (docs: runner/README.md "Spend patrol"):
//   1. usage ledger JSONL dirs (SPEND_PATROL_LEDGER_DIRS, colon list; runner/usage-ledger.mjs rows): primary.
//      A row is one session's total cost_usd, counted in the hour of its ts (the session's end).
//   2. <ns>-telemetry heartbeats with cost_since_start.estimated_usd: last hour only, a supplement. The value is
//      cumulative per session, so the hour's spend is a per-session delta (latest in the hour minus latest
//      before it, else minus the earliest in the hour), never a sum of totals. A session that has a ledger row
//      is skipped here, so it is never counted twice. Telemetry is pruned at 48h and compacted, so it never
//      feeds the baseline.
//
// It never stops a worker, touches a key or restarts anything. Its only writes are those notes/questions,
// through the broker (POST /messages); reads go through MCP read_messages with no worker= (no cursor moves).
//
// Env: SPEND_PATROL_NAMESPACES (comma list; empty = exit 0, nothing done), SPEND_PATROL_LEDGER_DIRS,
//      SPEND_PATROL_MIN_USD, BROKER_URL (default http://localhost:8080), BROKER_SECRET (else SHARED_SECRET).
// Flags: --dry-run (print the table, write nothing), --now=<ISO> (pretend it is then), --json (table as JSON).
// Exit: 0 ok; 1 the broker failed while an alert had to be posted; 2 bad arguments.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { brokerBase, parseRows } from "./orchestrate.mjs";

export const PATROL_SENDER = "spend-patrol";
export const HOUR = 3600_000;
export const DAY = 24 * HOUR;
export const BASELINE_DAYS = 7;
export const FINDING_RATIO = 3;
export const QUESTION_RATIO = 10;
export const DEFAULT_MIN_USD = 2;

const round = (x, d = 4) => Math.round(x * 10 ** d) / 10 ** d;
const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : typeof x === "string" && x.trim() && Number.isFinite(+x) ? +x : null);

// ── config ────────────────────────────────────────────────────────────────────

export function parseConfig(argv = process.argv.slice(2), env = process.env) {
  const cfg = {
    namespaces: String(env.SPEND_PATROL_NAMESPACES || "").split(",").map(s => s.trim()).filter(Boolean),
    ledgerDirs: String(env.SPEND_PATROL_LEDGER_DIRS || "").split(":").map(s => s.trim()).filter(Boolean),
    minUsd: DEFAULT_MIN_USD,
    brokerUrl: env.BROKER_URL || "http://localhost:8080",
    secret: env.BROKER_SECRET || env.SHARED_SECRET || "",
    dryRun: false, json: false, now: new Date(),
  };
  if (env.SPEND_PATROL_MIN_USD !== undefined && env.SPEND_PATROL_MIN_USD !== "") {
    const m = num(env.SPEND_PATROL_MIN_USD);
    if (m === null || m < 0) throw new Error(`SPEND_PATROL_MIN_USD must be a number >= 0, got '${env.SPEND_PATROL_MIN_USD}'`);
    cfg.minUsd = m;
  }
  for (const a of argv) {
    if (a === "--dry-run") cfg.dryRun = true;
    else if (a === "--json") cfg.json = true;
    else if (a.startsWith("--now=")) {
      const t = new Date(a.slice(6));
      if (isNaN(t.getTime())) throw new Error(`bad --now: ${a.slice(6)}`);
      cfg.now = t;
    } else throw new Error(`unknown argument: ${a}`);
  }
  return cfg;
}

// The last complete hour: [start, start + 1h). Hours are aligned to the epoch (UTC), which for IST
// (+05:30) means hh:30 local; the same hour on earlier days is start - d * 24h.
export const lastHourStart = (now) => Math.floor(now.getTime() / HOUR) * HOUR - HOUR;
export const hourKey = (ms) => new Date(ms).toISOString().slice(0, 13);
export const alertTaskId = (ns, hourStart) => `spend-patrol-${ns}-${hourKey(hourStart)}`;

// ── sources ───────────────────────────────────────────────────────────────────

// Usage-ledger rows with a numeric cost, deduped on (source, ref) (else session_id), from every *.jsonl
// in the dirs. Bad lines and unreadable files are skipped (counted in `skipped`).
export function readLedger(dirs) {
  const seen = new Set(), rows = [];
  let skipped = 0;
  for (const dir of dirs) {
    let files = [];
    try { files = readdirSync(dir).filter(f => f.endsWith(".jsonl")).sort(); } catch { skipped++; continue; }
    for (const f of files) {
      let text = "";
      try { text = readFileSync(join(dir, f), "utf8"); } catch { skipped++; continue; }
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let r; try { r = JSON.parse(line); } catch { skipped++; continue; }
        const ts = Date.parse(r?.ts), cost = num(r?.cost_usd);
        if (!r || typeof r.ns !== "string" || isNaN(ts) || cost === null) { skipped++; continue; }
        const key = `${r.source || "claude"}:${r.ref || r.session_id || `${f}:${rows.length}`}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({ ns: r.ns, ts, cost, session_id: r.session_id || r.ref || null, worker: r.worker || null });
      }
    }
  }
  return { rows, skipped };
}

// Heartbeats [{sender, content}] → per-session cost delta inside [start, end). Keyed by session_id, else sender.
// Sessions in `exclude` (ledger session ids) are skipped.
export function telemetryDeltas(heartbeats, start, end, exclude = new Set()) {
  const bySession = new Map();
  for (const h of heartbeats) {
    const c = h.content;
    if (!c || typeof c !== "object") continue;
    const usd = num(c.cost_since_start?.estimated_usd);
    const ts = Date.parse(c.ts || c.at);
    if (usd === null || isNaN(ts) || ts >= end) continue;
    const key = c.session_id || `sender:${h.sender}`;
    if (c.session_id && exclude.has(c.session_id)) continue;
    const s = bySession.get(key) || { key, worker: c.from || h.sender, before: null, first: null, last: null };
    if (ts < start) { if (!s.before || ts > s.before.ts) s.before = { ts, usd }; }
    else {
      if (!s.first || ts < s.first.ts) s.first = { ts, usd };
      if (!s.last || ts > s.last.ts) s.last = { ts, usd };
    }
    bySession.set(key, s);
  }
  const out = [];
  for (const s of bySession.values()) {
    if (!s.last) continue;
    const base = s.before ? s.before.usd : s.first.usd;
    const delta = s.last.usd - base;
    // A drop means a new session reused the key (sender fallback): count its in-hour growth only.
    out.push({ key: s.key, worker: s.worker, usd: delta >= 0 ? delta : Math.max(0, s.last.usd - s.first.usd) });
  }
  return out;
}

// ── the computation ───────────────────────────────────────────────────────────

// One namespace: spend in the hour, the 7 same-hour spends before it, coverage and the decision.
export function evaluate({ ns, ledgerRows, telemetry = [], telemetryOk = true, hourStart, minUsd = DEFAULT_MIN_USD }) {
  const mine = ledgerRows.filter(r => r.ns === ns);
  const inHour = (r, s) => r.ts >= s && r.ts < s + HOUR;
  const ledgerSpend = mine.filter(r => inHour(r, hourStart)).reduce((a, r) => a + r.cost, 0);
  const ledgerSessions = new Set(mine.map(r => r.session_id).filter(Boolean));
  const telemetrySpend = telemetry.reduce((a, t) => a + t.usd, 0);
  const spend = ledgerSpend + telemetrySpend;

  const earliest = mine.length ? Math.min(...mine.map(r => r.ts)) : null;
  const historyDays = earliest === null ? 0 : Math.max(0, (hourStart - earliest) / DAY);
  const days = [];
  for (let d = 1; d <= BASELINE_DAYS; d++) days.push(mine.filter(r => inHour(r, hourStart - d * DAY)).reduce((a, r) => a + r.cost, 0));
  const hasHistory = earliest !== null && earliest <= hourStart - BASELINE_DAYS * DAY;
  const avg = hasHistory ? days.reduce((a, x) => a + x, 0) / BASELINE_DAYS : null;
  const ratio = avg ? spend / avg : null;

  const d = decide({ spend, avg, minUsd });
  const sources = [mine.length ? "ledger" : null, telemetry.length ? "telemetry" : null].filter(Boolean);
  return {
    ns, hour: hourKey(hourStart), spend_usd: round(spend), ledger_usd: round(ledgerSpend), telemetry_usd: round(telemetrySpend),
    avg_usd: avg === null ? null : round(avg), ratio: ratio === null ? null : round(ratio, 2), same_hour_usd: days.map(x => round(x)),
    coverage: { history_days: round(historyDays, 1), ledger_rows: mine.length, ledger_sessions: ledgerSessions.size,
      telemetry_sessions: telemetry.length, telemetry: telemetryOk ? "read" : "unavailable", sources: sources.length ? sources : ["none"] },
    level: d.level, reason: d.reason,
  };
}

// level: ok | no-baseline | below-floor | finding | question (question implies a finding too).
export function decide({ spend, avg, minUsd = DEFAULT_MIN_USD }) {
  if (avg === null || avg === undefined) return { level: "no-baseline", reason: `under ${BASELINE_DAYS} days of history` };
  if (!(avg > 0)) return { level: "no-baseline", reason: "zero same-hour average" };
  const ratio = spend / avg;
  if (ratio <= FINDING_RATIO) return { level: "ok", reason: `${ratio.toFixed(2)}x` };
  if (spend < minUsd) return { level: "below-floor", reason: `${ratio.toFixed(2)}x but $${spend.toFixed(2)} < floor $${minUsd}` };
  if (ratio >= QUESTION_RATIO) return { level: "question", reason: `${ratio.toFixed(2)}x >= ${QUESTION_RATIO}x` };
  return { level: "finding", reason: `${ratio.toFixed(2)}x > ${FINDING_RATIO}x` };
}

// ── envelopes ─────────────────────────────────────────────────────────────────

const evidenceOf = (r) => `spend-patrol ${r.hour}:00Z ns=${r.ns} spend=$${r.spend_usd} (ledger $${r.ledger_usd} + telemetry $${r.telemetry_usd}) ` +
  `avg7=$${r.avg_usd} ratio=${r.ratio}x same-hour=[${r.same_hour_usd.join(",")}] history=${r.coverage.history_days}d ` +
  `sources=${r.coverage.sources.join("+")} ledger_sessions=${r.coverage.ledger_sessions} telemetry_sessions=${r.coverage.telemetry_sessions}`;

export function findingEnvelope(r, hourStart) {
  return {
    type: "finding", from: PATROL_SENDER, to: "orchestrator",
    subject: `Spend jump: ${r.ns} $${r.spend_usd.toFixed(2)} in hour ${r.hour}Z, ${r.ratio}x the 7-day same-hour average`.slice(0, 120),
    summary: `Namespace ${r.ns} spent $${r.spend_usd.toFixed(2)} in the hour from ${r.hour}:00Z against a trailing 7-day same-hour average of $${r.avg_usd.toFixed(2)} (${r.ratio}x). Check which sessions ran and whether a worker is looping.`.slice(0, 400),
    scope: [r.ns, "spend"],
    evidence: evidenceOf(r).slice(0, 1000),
    confidence: "confirmed",
    task_id: alertTaskId(r.ns, hourStart),
  };
}

export function questionEnvelope(r, hourStart) {
  return {
    type: "question", task_id: alertTaskId(r.ns, hourStart), from: PATROL_SENDER, to: "orchestrator",
    subject: `Spend ${r.ratio}x normal in ${r.ns} (hour ${r.hour}Z): stop or keep going?`,
    body: {
      question: `Namespace ${r.ns} spent $${r.spend_usd.toFixed(2)} in the hour from ${r.hour}:00Z, ${r.ratio}x its 7-day same-hour average ($${r.avg_usd.toFixed(2)}). The patrol stops nothing: is this spend expected, or should a worker be stopped?`,
      spend_usd: r.spend_usd, avg_usd: r.avg_usd, ratio: r.ratio, coverage: r.coverage,
    },
  };
}

// ── broker client ─────────────────────────────────────────────────────────────

export async function connectBroker({ url, secret }) {
  const base = brokerBase(url);
  const headers = secret ? { Authorization: `Bearer ${secret}` } : {};
  const client = new Client({ name: PATROL_SENDER, version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
  const read = async (args) => {
    const r = await client.callTool({ name: "read_messages", arguments: args });
    const text = r.content?.[0]?.text ?? "";
    if (r.isError) throw new Error(`read_messages ${args.channel}: ${text}`);
    return parseRows(text);
  };
  return {
    base,
    // Newest 500 heartbeats; no worker=, so no cursor is created or moved.
    telemetry: (ns) => read({ channel: `${ns}-telemetry`, limit: 500 }),
    // Whether the patrol already posted this task_id as `type` on the channel.
    posted: async (channel, type, taskId) => (await read({ channel, filter_sender: PATROL_SENDER, filter_type: type, limit: 500 }))
      .some(m => m.content?.task_id === taskId),
    post: async (channel, content) => {
      const res = await fetch(`${base}/messages`, {
        method: "POST", headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ channel, sender: PATROL_SENDER, content: JSON.stringify(content) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`POST /messages ${channel}: ${res.status} ${data.error || ""}`.trim());
      return data;
    },
    close: () => client.close().catch(() => {}),
  };
}

// ── run ───────────────────────────────────────────────────────────────────────

// Returns { rows, posts, errors }. `broker` may be null (unreachable): telemetry is then "unavailable"
// and any alert that has to be posted becomes an error.
export async function patrol(cfg, broker, log = () => {}) {
  const hourStart = lastHourStart(cfg.now);
  const ledger = readLedger(cfg.ledgerDirs);
  if (ledger.skipped) log(`ledger: skipped ${ledger.skipped} unreadable line(s)/file(s)`);
  const rows = [], posts = [], errors = [];
  for (const ns of cfg.namespaces) {
    let telemetry = [], telemetryOk = false;
    if (broker) {
      try {
        const exclude = new Set(ledger.rows.filter(r => r.ns === ns && r.session_id).map(r => r.session_id));
        telemetry = telemetryDeltas(await broker.telemetry(ns), hourStart, hourStart + HOUR, exclude).filter(t => t.usd > 0);
        telemetryOk = true;
      } catch (e) { log(`telemetry ${ns}: ${e.message}`); }
    }
    const r = evaluate({ ns, ledgerRows: ledger.rows, telemetry, telemetryOk, hourStart, minUsd: cfg.minUsd });
    rows.push(r);
    if (cfg.dryRun || (r.level !== "finding" && r.level !== "question")) continue;
    const wanted = [{ channel: `${ns}-notes`, type: "finding", env: findingEnvelope(r, hourStart) }];
    if (r.level === "question") wanted.push({ channel: `${ns}-orchestrator`, type: "question", env: questionEnvelope(r, hourStart) });
    for (const w of wanted) {
      try {
        if (!broker) throw new Error("broker unreachable");
        if (await broker.posted(w.channel, w.type, w.env.task_id)) { posts.push({ channel: w.channel, type: w.type, task_id: w.env.task_id, deduped: true }); continue; }
        const out = await broker.post(w.channel, w.env);
        posts.push({ channel: w.channel, type: w.type, task_id: w.env.task_id, id: out.id, ...(out.warn ? { warn: out.warn } : {}) });
      } catch (e) { errors.push(`${w.channel} ${w.type}: ${e.message}`); }
    }
  }
  return { hour: hourKey(hourStart), rows, posts, errors };
}

export function formatTable(result) {
  const head = ["ns", "hour(UTC)", "spend$", "ledger$", "telem$", "avg7$", "ratio", "level", "history_d", "sources", "sessions(l/t)", "telemetry"];
  const lines = result.rows.map(r => [r.ns, r.hour, r.spend_usd.toFixed(2), r.ledger_usd.toFixed(2), r.telemetry_usd.toFixed(2),
    r.avg_usd === null ? "-" : r.avg_usd.toFixed(2), r.ratio === null ? "-" : `${r.ratio}x`, r.level, String(r.coverage.history_days),
    r.coverage.sources.join("+"), `${r.coverage.ledger_sessions}/${r.coverage.telemetry_sessions}`, r.coverage.telemetry]);
  const w = head.map((h, i) => Math.max(h.length, ...lines.map(l => l[i].length)));
  const fmt = (l) => l.map((c, i) => c.padEnd(w[i])).join("  ").trimEnd();
  return [fmt(head), ...lines.map(fmt)].join("\n");
}

async function main() {
  let cfg;
  try { cfg = parseConfig(); } catch (e) { console.error(`[spend-patrol] ${e.message}`); process.exit(2); }
  const log = (m) => console.error(`[spend-patrol] ${m}`);
  if (!cfg.namespaces.length) { log("SPEND_PATROL_NAMESPACES is empty: nothing to do"); return 0; }
  for (const d of cfg.ledgerDirs) if (!existsSync(d)) log(`ledger dir missing: ${d}`);
  let broker = null;
  try { broker = await connectBroker({ url: cfg.brokerUrl, secret: cfg.secret }); }
  catch (e) { log(`broker ${brokerBase(cfg.brokerUrl)} unreachable: ${e.message}`); }
  try {
    const result = await patrol(cfg, broker, log);
    if (cfg.json) console.log(JSON.stringify({ dry_run: cfg.dryRun, ...result }));
    else {
      console.log(formatTable(result));
      if (cfg.dryRun) console.log("(dry run: nothing posted)");
      for (const p of result.posts) console.log(`${p.deduped ? "already posted" : `posted #${p.id}`}: ${p.type} ${p.channel} ${p.task_id}${p.warn ? ` (${p.warn})` : ""}`);
    }
    for (const e of result.errors) log(`ERROR ${e}`);
    return result.errors.length ? 1 : 0;
  } finally { if (broker) await broker.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => process.exit(code), e => { console.error(`[spend-patrol] FATAL: ${e.message}`); process.exit(1); });
}
