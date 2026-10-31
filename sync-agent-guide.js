#!/usr/bin/env node
// Writes the v3 agent guide (docs/agent-guides/broker-v3.md) into project files, between markers:
//   <!-- claude-broker v3 --> ... <!-- /claude-broker v3 -->
// Block absent -> appended at the end; present -> replaced in place; file missing -> created.
// Text outside the markers is never touched. Malformed markers (unpaired, repeated, reversed) in
// any file abort the whole run with exit 1 before anything is written.
//
//   node sync-agent-guide.js <file...> [--dry-run] [--guide=<path>]
//
// --dry-run prints a unified diff per changed file and writes nothing.

import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const START = "<!-- claude-broker v3 -->";
export const END = "<!-- /claude-broker v3 -->";
const DEFAULT_GUIDE = join(dirname(fileURLToPath(import.meta.url)), "docs", "agent-guides", "broker-v3.md");

const countOf = (text, s) => text.split(s).length - 1;

export function blockFor(guide) {
  return `${START}\n${guide.trim()}\n${END}`;
}

// Returns the new file text, or throws Error naming the marker problem.
export function applyBlock(text, guide) {
  const block = blockFor(guide);
  const starts = countOf(text, START), ends = countOf(text, END);
  if (starts === 0 && ends === 0) {
    if (text === "") return `${block}\n`;
    return `${text}${text.endsWith("\n") ? "" : "\n"}\n${block}\n`;
  }
  if (starts !== 1 || ends !== 1) throw new Error(`expected one '${START}' and one '${END}', found ${starts} and ${ends}`);
  const s = text.indexOf(START), e = text.indexOf(END);
  if (e < s) throw new Error(`'${END}' comes before '${START}'`);
  return text.slice(0, s) + block + text.slice(e + END.length);
}

function unifiedDiff(file, before, after) {
  const dir = mkdtempSync(join(tmpdir(), "agent-guide-"));
  try {
    writeFileSync(join(dir, "a"), before);
    writeFileSync(join(dir, "b"), after);
    const r = spawnSync("diff", ["-u", "--label", `a/${file}`, "--label", `b/${file}`, join(dir, "a"), join(dir, "b")], { encoding: "utf8" });
    return r.stdout;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function main(argv) {
  const dry = argv.includes("--dry-run");
  const guideArg = argv.find(a => a.startsWith("--guide="));
  const guidePath = guideArg ? resolve(guideArg.slice("--guide=".length)) : DEFAULT_GUIDE;
  const files = argv.filter(a => !a.startsWith("--"));
  if (files.length === 0) {
    console.error("usage: node sync-agent-guide.js <file...> [--dry-run] [--guide=<path>]");
    return 2;
  }
  if (!existsSync(guidePath)) { console.error(`guide not found: ${guidePath}`); return 2; }
  const guide = readFileSync(guidePath, "utf8");
  if (guide.includes(START) || guide.includes(END)) { console.error("guide must not contain the markers itself"); return 2; }

  const plans = [];
  let bad = 0;
  for (const f of files) {
    const before = existsSync(f) ? readFileSync(f, "utf8") : "";
    try { plans.push({ f, before, after: applyBlock(before, guide), existed: existsSync(f) }); }
    catch (e) { console.error(`${f}: malformed markers: ${e.message}`); bad++; }
  }
  if (bad) return 1;

  for (const p of plans) {
    if (p.after === p.before && p.existed) { console.log(`${p.f}: up to date`); continue; }
    if (dry) { process.stdout.write(unifiedDiff(p.f, p.before, p.after)); continue; }
    mkdirSync(dirname(resolve(p.f)), { recursive: true });
    writeFileSync(p.f, p.after);
    console.log(`${p.f}: ${p.existed ? (p.before.includes(START) ? "block replaced" : "block appended") : "created"}`);
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
