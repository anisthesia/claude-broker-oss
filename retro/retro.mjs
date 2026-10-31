#!/usr/bin/env node
// Weekly retro run. Usage: node retro/retro.mjs --ns cb --db <READ-ONLY COPY of broker.db> [--out docs/knowledge]
//   [--envelope retro/out/<ns>-edits.json] [--full] [--dry-run] [--json] [--stale-days 7]
//   [--hub-max 8] [--hub-path <path>,<path>]
// Reads the DB read-only; writes only <out>/<ns>.md and the envelope file. Never posts, never edits role files.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { openDb, runRetro, HUB_DECISIONS } from "./retro-lib.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const ns = opt("ns"), dbPath = opt("db");
if (!ns || !dbPath) { console.error("usage: retro.mjs --ns <ns> --db <db copy> [--out dir] [--envelope file] [--full] [--dry-run]"); process.exit(2); }
const outDir = opt("out", "docs/knowledge");
const knowledgeFile = join(outDir, `${ns}.md`);
let lastId = 0;
if (!args.includes("--full") && existsSync(knowledgeFile)) {
  const m = /last_id=(\d+)/.exec(readFileSync(knowledgeFile, "utf8").slice(0, 200));
  if (m) lastId = parseInt(m[1], 10);
}
const staleDays = Number(opt("stale-days", 7));
if (!(staleDays > 0)) { console.error("--stale-days must be a positive number"); process.exit(2); }
const hubMax = Number(opt("hub-max", HUB_DECISIONS));
if (!(hubMax >= 1)) { console.error("--hub-max must be a number >= 1"); process.exit(2); }
const hubPaths = String(opt("hub-path", "")).split(",").filter(Boolean);
const res = runRetro(openDb(dbPath), ns, { lastId, staleDays, hubMax, hubPaths });
const k = res.knowledge;
const { text: _t, ...stats } = k;
const log = args.includes("--json") ? () => {} : console.log;
log(`[retro] ns=${ns} scanned notes=${res.scanned.notes} status(since #${lastId})=${res.scanned.status}`);
log(`[retro] knowledge ${k.bytes} B (cap 6144): ${k.kept} kept (${k.standing} standing rules), ${k.folded} folded, ${k.superseded} superseded, ${k.resolved} resolved/expired, ${k.dropped} dropped for size, ${k.merged} merged, over_cap=${k.over_cap}, of ${k.total}`);
const stale = [...res.clusters, ...res.finding_clusters].filter(c => c.stale);
log(`[retro] ${res.clusters.length} failure clusters, ${res.finding_clusters.length} repeated-finding clusters (${stale.length} stale), ${res.envelope.body.proposals.length} proposed role edits`);
for (const c of [...res.clusters, ...res.finding_clusters]) log(`[retro]   ${c.count}x last_seen ${c.last_seen ?? "?"} ${c.stale ? `STALE(${c.stale})` : "live"}: ${c.sample.slice(0, 80)}`);
if (args.includes("--json")) console.log(JSON.stringify({ ns, ...stats }));
if (!args.includes("--dry-run")) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(knowledgeFile, k.text);
  const envFile = opt("envelope");
  if (envFile) { mkdirSync(dirname(envFile), { recursive: true }); writeFileSync(envFile, JSON.stringify(res.envelope, null, 2) + "\n"); }
}
