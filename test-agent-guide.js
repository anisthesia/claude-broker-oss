// sync-agent-guide.js + docs/agent-guides/broker-v3.md. Fixtures only: no broker, no project repo is touched.
//   - insert at end, replace in place, idempotent second run, create missing file (and its directory)
//   - text outside the markers byte-identical (incl. no trailing newline, CRLF, text after the block)
//   - malformed markers (start only, end only, reversed, duplicated) exit non-zero and write nothing
//   - --dry-run prints a unified diff and writes nothing
//   - the guide is <= 70 lines, has the role sections, and every tool it names exists in the profiles

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROFILES, V3_TOOLS } from "./lib/profiles.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SYNC = join(ROOT, "sync-agent-guide.js");
const GUIDE = join(ROOT, "docs", "agent-guides", "broker-v3.md");
const START = "<!-- claude-broker v3 -->", END = "<!-- /claude-broker v3 -->";

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); return true; }
  failed++; console.error(`  ✗ ${label}`); return false;
}
const run = (...args) => spawnSync(process.execPath, [SYNC, ...args], { encoding: "utf8" });
const dir = mkdtempSync(join(tmpdir(), "agent-guide-test-"));
const f = (n) => join(dir, n);
const guide = readFileSync(GUIDE, "utf8");
const block = `${START}\n${guide.trim()}\n${END}`;

try {
  console.log("guide");
  const lines = guide.replace(/\n$/, "").split("\n").length;
  ok(lines <= 70, `guide is ${lines} lines (<= 70)`);
  for (const h of ["### Everyone", "### Worker", "### Reviewer", "### Orchestrator"]) ok(guide.includes(h), `section ${h}`);
  ok(!guide.includes(START) && !guide.includes(END), "guide carries no markers itself");
  const known = new Set([...PROFILES.orchestrator, ...V3_TOOLS, "purge_channel", "register_channel_schema", "list_workers"]);
  const named = [...new Set([...guide.matchAll(/\b([a-z]+(?:_[a-z]+)+)\(/g)].map(m => m[1]))];
  ok(named.length >= 6 && named.every(t => known.has(t)), `every called tool exists in a profile (${named.join(", ")})`);
  ok(/post_result\(/.test(guide) && /ask\(/.test(guide) && /post_note\(/.test(guide) && /dispatch_task\(/.test(guide) && /get_message\(/.test(guide), "typed tools + get_message shown");
  ok(guide.includes("32768") && guide.includes("150k") && /not available to role/.test(guide), "32 KB cap, 150k rotation, profile refusal stated");

  console.log("insert");
  writeFileSync(f("a.md"), "# Project\n\nOwn text.\n");
  let r = run(f("a.md"));
  ok(r.status === 0, "exit 0");
  ok(readFileSync(f("a.md"), "utf8") === `# Project\n\nOwn text.\n\n${block}\n`, "block appended after a blank line, text before it untouched");
  writeFileSync(f("nonl.md"), "no newline at end");
  run(f("nonl.md"));
  ok(readFileSync(f("nonl.md"), "utf8") === `no newline at end\n\n${block}\n`, "file without trailing newline gets one before the block");
  writeFileSync(f("empty.md"), "");
  run(f("empty.md"));
  ok(readFileSync(f("empty.md"), "utf8") === `${block}\n`, "empty file becomes just the block");

  console.log("idempotent");
  const once = readFileSync(f("a.md"), "utf8");
  r = run(f("a.md"));
  ok(r.status === 0 && readFileSync(f("a.md"), "utf8") === once, "second run leaves the file byte-identical");
  ok(/up to date/.test(r.stdout), "second run reports up to date");

  console.log("replace");
  const before = "top\r\nline with CRLF\r\n\n", after = "\n\n## Later section\ntail without newline";
  writeFileSync(f("b.md"), `${before}${START}\nOLD GUIDE\nmore old\n${END}${after}`);
  r = run(f("b.md"));
  ok(r.status === 0, "exit 0");
  ok(readFileSync(f("b.md"), "utf8") === `${before}${block}${after}`, "old block replaced in place; text before and after byte-identical (CRLF, no final newline)");
  ok(countOf(readFileSync(f("b.md"), "utf8"), START) === 1, "one block");
  const guide2 = join(dir, "guide2.md");
  writeFileSync(guide2, "NEW GUIDE\n");
  run(f("b.md"), `--guide=${guide2}`);
  ok(readFileSync(f("b.md"), "utf8") === `${before}${START}\nNEW GUIDE\n${END}${after}`, "--guide swaps the content, outside text unchanged");

  console.log("create");
  r = run(f("sub/dir/new.md"));
  ok(r.status === 0 && readFileSync(f("sub/dir/new.md"), "utf8") === `${block}\n`, "missing file (and directory) created with the block");

  console.log("malformed");
  const cases = {
    "start-only.md": `x\n${START}\nhalf\n`,
    "end-only.md": `x\n${END}\n`,
    "reversed.md": `${END}\nmid\n${START}\n`,
    "twice.md": `${block}\n${block}\n`,
  };
  for (const [name, text] of Object.entries(cases)) {
    writeFileSync(f(name), text);
    r = run(f(name));
    ok(r.status !== 0 && /malformed markers/.test(r.stderr) && readFileSync(f(name), "utf8") === text, `${name}: non-zero exit, file untouched`);
  }
  writeFileSync(f("good.md"), "fresh\n");
  r = run(f("good.md"), f("start-only.md"));
  ok(r.status !== 0 && readFileSync(f("good.md"), "utf8") === "fresh\n", "one malformed file aborts the run before any write");
  ok(run().status !== 0, "no file argument is a usage error");

  console.log("dry-run");
  writeFileSync(f("d.md"), "keep\n");
  r = run(f("d.md"), f("dnew.md"), "--dry-run");
  ok(r.status === 0 && readFileSync(f("d.md"), "utf8") === "keep\n" && !existsSync(f("dnew.md")), "nothing written, nothing created");
  ok(/^--- a\/.*d\.md/m.test(r.stdout) && /^\+\+\+ b\/.*d\.md/m.test(r.stdout) && /^@@ /m.test(r.stdout) && r.stdout.includes(`+${START}`), "unified diff for an existing file");
  ok(r.stdout.includes("dnew.md") && /^@@ -0,0 \+1,/m.test(r.stdout), "diff against nothing for a file that would be created");
  r = run(f("a.md"), "--dry-run");
  ok(r.status === 0 && !/^@@/m.test(r.stdout), "up-to-date file prints no diff");
  writeFileSync(f("bad2.md"), `${START}\n`);
  ok(run(f("bad2.md"), "--dry-run").status !== 0, "dry-run still exits non-zero on malformed markers");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

function countOf(t, s) { return t.split(s).length - 1; }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
