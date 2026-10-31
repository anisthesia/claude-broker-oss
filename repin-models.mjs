#!/usr/bin/env node
// Re-pin worker models in a workers config to the 5.5 ids and split reviewer models from the writers'.
//   node repin-models.mjs <workers-config.json> [--apply]
// Dry-run by default (prints a table, writes nothing). --apply writes <config>.<timestamp>.bak first,
// then rewrites the file with its own indent and key order (refuses if the file would not round-trip).
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SONNET = "claude-sonnet-5-5";
const OPUS = "claude-opus-5-5";
// Previous-generation ids -> 5.5. Haiku, 5.5 ids and entries without a model are left alone.
export const MODEL_MAP = { "claude-sonnet-5": SONNET, sonnet: SONNET, "claude-opus-5": OPUS };
const family = (m) => m === SONNET ? "sonnet" : m === OPUS ? "opus" : null;
const isReviewer = (e) => /(^|-)reviewer$/.test(e.name || "");
const isOrch = (e) => /(^|-)(orch|orchestrator)$/.test(e.name || "");

// Returns [{ index, name, ns, from, to, reason }] without touching `entries`.
export function plan(entries) {
  const changes = [];
  const next = entries.map(e => MODEL_MAP[e.model] ?? e.model);
  entries.forEach((e, i) => {
    if (MODEL_MAP[e.model]) changes.push({ index: i, name: e.name, ns: e.ns, from: e.model, to: MODEL_MAP[e.model], reason: "repin" });
  });
  // Reviewer split. Writers = non-reviewer, non-orchestrator entries pinned to sonnet/opus; their
  // majority family (ties: opus) is "the writers' model". A reviewer on that family moves to the other one.
  for (const ns of new Set(entries.map(e => e.ns))) {
    const idx = entries.map((e, i) => i).filter(i => entries[i].ns === ns);
    const count = { sonnet: 0, opus: 0 };
    for (const i of idx) if (!isReviewer(entries[i]) && !isOrch(entries[i]) && family(next[i])) count[family(next[i])]++;
    if (!count.sonnet && !count.opus) continue;
    const writers = count.opus >= count.sonnet ? "opus" : "sonnet";
    const target = writers === "opus" ? SONNET : OPUS;
    for (const i of idx.filter(i => isReviewer(entries[i]) && family(next[i]) === writers)) {
      const prev = changes.find(c => c.index === i);
      if (prev) { prev.to = target; prev.reason = "repin+split"; }
      else changes.push({ index: i, name: entries[i].name, ns, from: entries[i].model, to: target, reason: "split" });
    }
  }
  return changes.sort((a, b) => a.index - b.index);
}

export function applyPlan(entries, changes) {
  for (const c of changes) entries[c.index].model = c.to;
  return entries;
}

// Indent of the file's first nested line (the top-level array's first element), so the rewrite keeps it.
const indentOf = (text) => /^([ \t]+)\S/m.exec(text)?.[1] ?? "  ";

export function summarize(changes) {
  const by = {};
  for (const c of changes) { const k = `${c.from ?? "(none)"} -> ${c.to} [${c.reason}]`; by[k] = (by[k] || 0) + 1; }
  return by;
}

function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith("--"));
  const doApply = args.includes("--apply");
  if (!file) { console.error("usage: repin-models.mjs <workers-config.json> [--apply]"); process.exit(2); }
  const text = readFileSync(file, "utf8");
  const entries = JSON.parse(text);
  if (!Array.isArray(entries)) { console.error("config must be a JSON array of worker entries"); process.exit(2); }
  const changes = plan(entries);
  const w = Math.max(4, ...changes.map(c => c.name.length));
  console.log(`${"NS".padEnd(8)}${"NAME".padEnd(w + 2)}${"FROM".padEnd(28)}TO`);
  for (const c of changes) console.log(`${c.ns.padEnd(8)}${c.name.padEnd(w + 2)}${String(c.from ?? "(none)").padEnd(28)}${c.to}  (${c.reason})`);
  console.log(`\n${changes.length} of ${entries.length} entries change:`);
  for (const [k, v] of Object.entries(summarize(changes))) console.log(`  ${String(v).padStart(3)}  ${k}`);
  if (!doApply) { console.log("\ndry-run: nothing written (pass --apply)"); return; }
  if (!changes.length) { console.log("\nnothing to apply"); return; }
  const indent = indentOf(text);
  const nl = text.endsWith("\n") ? "\n" : "";
  if (JSON.stringify(entries, null, indent) + nl !== text) {
    console.error(`refusing --apply: ${file} does not round-trip with indent ${JSON.stringify(indent)}; formatting would change`);
    process.exit(1);
  }
  const bak = `${file}.${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
  copyFileSync(file, bak);
  writeFileSync(file, JSON.stringify(applyPlan(entries, changes), null, indent) + nl);
  console.log(`\napplied; backup: ${bak}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
