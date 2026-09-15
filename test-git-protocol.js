/**
 * test-git-protocol.js — Git management protocol tests
 *
 * Covers the git operations described in the updated CLAUDE.md and setup-broker.md:
 *   A. Branch safety protocol  (workers/core/CLAUDE.md step 0)
 *   B. Sprint-close trial merge (orchestrators/infra/CLAUDE.md sprint-close step 5)
 *   C. Sprint-close actual merge
 *   D. Multi-repo sprint-close  (setup-broker.md REPO_MODE=multi-repo)
 *   E. Result envelope branch field
 *
 * No broker connection required. All tests use temporary git repos that are
 * cleaned up after each case.
 *
 * Usage:
 *   node test-git-protocol.js
 */

import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let passed = 0;
let failed = 0;

function ok(label) {
  console.log(`  ✓ ${label}`);
  passed++;
}

function fail(label, detail = "assertion failed") {
  console.error(`  ✗ ${label}: ${detail}`);
  failed++;
}

function assert(cond, label, detail = "") {
  cond ? ok(label) : fail(label, detail || "assertion failed");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function git(repo, ...args) {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

function gitTry(repo, ...args) {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf-8" });
  return { ok: r.status === 0, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}

function makeRepo(label) {
  const dir = mkdtempSync(join(tmpdir(), `broker-git-${label}-`));
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "test@broker.local");
  git(dir, "config", "user.name", "Broker Test");
  writeFileSync(join(dir, "README.md"), "# repo\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "init");
  return dir;
}

function cloneRepo(origin, label) {
  const dir = mkdtempSync(join(tmpdir(), `broker-git-${label}-clone-`));
  spawnSync("git", ["clone", origin, dir], { stdio: "ignore" });
  git(dir, "config", "user.email", "test@broker.local");
  git(dir, "config", "user.name", "Broker Test");
  return dir;
}

function cleanup(...dirs) {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
}

function addFile(repo, filename, content = `// ${filename}\n`) {
  const parts = filename.split("/");
  if (parts.length > 1) {
    mkdirSync(join(repo, ...parts.slice(0, -1)), { recursive: true });
  }
  writeFileSync(join(repo, filename), content);
}

// ── Section A: Branch safety protocol ────────────────────────────────────────

console.log("\n=== A. Branch safety protocol (workers/core/CLAUDE.md step 0) ===\n");

{
  // A1: creates worker/core from origin/main when origin/worker/core does not exist
  const origin = makeRepo("A1-origin");
  const clone = cloneRepo(origin, "A1");
  try {
    const r = spawnSync("bash", ["-c",
      `git -C ${clone} fetch origin && ` +
      `(git -C ${clone} checkout -B worker/core origin/worker/core 2>/dev/null || ` +
      ` git -C ${clone} checkout -B worker/core origin/main)`
    ], { encoding: "utf-8" });
    assert(r.status === 0, "A1: branch-safety checkout succeeds when origin/worker/core absent", r.stderr);
    const branch = git(clone, "branch", "--show-current");
    assert(branch === "worker/core", "A1: lands on worker/core", `got '${branch}'`);
    const tip = git(clone, "log", "--oneline", "-1");
    assert(tip.includes("init"), "A1: tip matches origin/main (init commit)", tip);
  } catch (e) { fail("A1: unexpected error", e.message); }
  finally { cleanup(origin, clone); }
}

{
  // A2: uses existing origin/worker/core when it has commits ahead of main
  const origin = makeRepo("A2-origin");
  git(origin, "checkout", "-b", "worker/core");
  addFile(origin, "server.js");
  git(origin, "add", "server.js");
  git(origin, "commit", "-m", "worker/core: server.js added");
  git(origin, "checkout", "main");

  const clone = cloneRepo(origin, "A2");
  try {
    const r = spawnSync("bash", ["-c",
      `git -C ${clone} fetch origin && ` +
      `(git -C ${clone} checkout -B worker/core origin/worker/core 2>/dev/null || ` +
      ` git -C ${clone} checkout -B worker/core origin/main)`
    ], { encoding: "utf-8" });
    assert(r.status === 0, "A2: branch-safety checkout succeeds when origin/worker/core exists", r.stderr);
    const branch = git(clone, "branch", "--show-current");
    assert(branch === "worker/core", "A2: lands on worker/core", `got '${branch}'`);
    const log = git(clone, "log", "--oneline", "worker/core", "^main");
    assert(log.includes("server.js added"), "A2: worker/core commits reachable (ahead of main)", log);
  } catch (e) { fail("A2: unexpected error", e.message); }
  finally { cleanup(origin, clone); }
}

{
  // A3: worker stages only owned files; git show HEAD --name-only must not include foreign files
  const repo = makeRepo("A3");
  try {
    git(repo, "checkout", "-b", "worker/core");
    addFile(repo, "server.js");
    addFile(repo, "schemas/cb-status.json");  // protocol-qa owned — must NOT be staged
    git(repo, "add", "server.js");
    git(repo, "commit", "-m", "[cb-test] add server.js");
    const names = git(repo, "show", "HEAD", "--name-only");
    assert(names.includes("server.js"), "A3: server.js in commit", names);
    assert(!names.includes("schemas"), "A3: schemas/ not in commit (worker staged only owned file)", names);
  } catch (e) { fail("A3: unexpected error", e.message); }
  finally { cleanup(repo); }
}

{
  // A4: branch safety halt — if branch is wrong, worker should detect it
  const repo = makeRepo("A4");
  try {
    // Simulate a worker that ended up on main (misconfigured)
    const branch = git(repo, "branch", "--show-current");
    // The protocol says: if branch !== worker/<name>, post question and STOP
    assert(branch !== "worker/core", "A4: fresh repo is NOT on worker/core (would trigger halt)", branch);
    // After running branch safety, it should be worker/core
    git(repo, "checkout", "-b", "worker/core");
    const after = git(repo, "branch", "--show-current");
    assert(after === "worker/core", "A4: branch safety checkout puts worker on worker/core", after);
  } catch (e) { fail("A4: unexpected error", e.message); }
  finally { cleanup(repo); }
}

// ── Section B: Sprint-close trial merge ──────────────────────────────────────

console.log("\n=== B. Sprint-close trial merge (orchestrators/infra/CLAUDE.md step 5) ===\n");

{
  // B1: trial merge exits 0 when two workers touch different files
  const repo = makeRepo("B1");
  try {
    git(repo, "checkout", "-b", "worker/core");
    addFile(repo, "server.js", "// core\n");
    git(repo, "add", "server.js");
    git(repo, "commit", "-m", "[cb-x] core change");

    git(repo, "checkout", "main");
    git(repo, "checkout", "-b", "worker/protocol-qa");
    addFile(repo, "schemas/cb-status.json", "{}");
    git(repo, "add", "schemas/");
    git(repo, "commit", "-m", "[cb-y] schema change");

    git(repo, "checkout", "main");
    const r1 = gitTry(repo, "merge", "--no-commit", "--no-ff", "worker/core");
    git(repo, "merge", "--abort");
    assert(r1.ok, "B1: trial merge worker/core exits 0 (no conflict)", r1.stderr);

    const r2 = gitTry(repo, "merge", "--no-commit", "--no-ff", "worker/protocol-qa");
    git(repo, "merge", "--abort");
    assert(r2.ok, "B1: trial merge worker/protocol-qa exits 0 (no conflict)", r2.stderr);
  } catch (e) { fail("B1: unexpected error", e.message); }
  finally { cleanup(repo); }
}

{
  // B2: trial merge exits non-zero when two workers touch the same line
  const repo = makeRepo("B2");
  try {
    // Seed a shared file on main
    addFile(repo, "server.js", `const V = "main";\n`);
    git(repo, "add", "server.js");
    git(repo, "commit", "-m", "add server.js");

    git(repo, "checkout", "-b", "worker/core");
    writeFileSync(join(repo, "server.js"), `const V = "core";\n`);
    git(repo, "add", "server.js");
    git(repo, "commit", "-m", "[cb-x] core version");

    git(repo, "checkout", "main");
    git(repo, "checkout", "-b", "worker/protocol-qa");
    writeFileSync(join(repo, "server.js"), `const V = "pqa";\n`);
    git(repo, "add", "server.js");
    git(repo, "commit", "-m", "[cb-y] pqa version");

    git(repo, "checkout", "main");
    // Merge core first (should succeed)
    git(repo, "merge", "--no-ff", "worker/core", "-m", "merge worker/core");
    // Trial merge pqa should now conflict
    const r = gitTry(repo, "merge", "--no-commit", "--no-ff", "worker/protocol-qa");
    const conflicted = !r.ok || r.stdout.toLowerCase().includes("conflict") || r.stderr.toLowerCase().includes("conflict");
    gitTry(repo, "merge", "--abort");
    assert(conflicted, "B2: trial merge worker/protocol-qa reports conflict after same-file edits");
  } catch (e) { fail("B2: unexpected error", e.message); }
  finally { cleanup(repo); }
}

{
  // B3: trial merge --no-commit --no-ff does not create a commit on main
  const repo = makeRepo("B3");
  try {
    git(repo, "checkout", "-b", "worker/core");
    addFile(repo, "server.js");
    git(repo, "add", "server.js");
    git(repo, "commit", "-m", "core change");

    git(repo, "checkout", "main");
    const beforeLog = git(repo, "log", "--oneline");
    gitTry(repo, "merge", "--no-commit", "--no-ff", "worker/core");
    git(repo, "merge", "--abort");
    const afterLog = git(repo, "log", "--oneline");
    assert(beforeLog === afterLog, "B3: trial merge + abort leaves main log unchanged", `before='${beforeLog}' after='${afterLog}'`);
  } catch (e) { fail("B3: unexpected error", e.message); }
  finally { cleanup(repo); }
}

{
  // B4: working tree is clean after --abort
  const repo = makeRepo("B4");
  try {
    git(repo, "checkout", "-b", "worker/core");
    addFile(repo, "server.js");
    git(repo, "add", "server.js");
    git(repo, "commit", "-m", "core change");

    git(repo, "checkout", "main");
    gitTry(repo, "merge", "--no-commit", "--no-ff", "worker/core");
    git(repo, "merge", "--abort");
    const status = git(repo, "status", "--porcelain");
    assert(status === "", "B4: working tree clean after merge --abort", `status='${status}'`);
  } catch (e) { fail("B4: unexpected error", e.message); }
  finally { cleanup(repo); }
}

// ── Section C: Sprint-close actual merge ─────────────────────────────────────

console.log("\n=== C. Sprint-close actual merge ===\n");

{
  // C1: core merged first, pqa second — both reachable from main
  const repo = makeRepo("C1");
  try {
    git(repo, "checkout", "-b", "worker/core");
    addFile(repo, "server.js");
    git(repo, "add", "server.js");
    git(repo, "commit", "-m", "[cb-sprint] core adds server.js");

    git(repo, "checkout", "main");
    git(repo, "checkout", "-b", "worker/protocol-qa");
    addFile(repo, "schemas/cb-status.json", "{}");
    git(repo, "add", "schemas/");
    git(repo, "commit", "-m", "[cb-sprint] pqa adds schema");

    git(repo, "checkout", "main");
    git(repo, "merge", "--no-ff", "worker/core", "-m", "sprint-close: merge worker/core");
    git(repo, "merge", "--no-ff", "worker/protocol-qa", "-m", "sprint-close: merge worker/protocol-qa");

    const coreInMain = git(repo, "log", "--oneline", "--", "server.js");
    assert(coreInMain.includes("server.js"), "C1: server.js commit reachable from main", coreInMain);
    const pqaInMain = git(repo, "log", "--oneline", "--", "schemas/cb-status.json");
    assert(pqaInMain.includes("schema"), "C1: schema commit reachable from main", pqaInMain);
  } catch (e) { fail("C1: unexpected error", e.message); }
  finally { cleanup(repo); }
}

{
  // C2: after sprint-close merge, both worker branches have 0 commits ahead of main
  const repo = makeRepo("C2");
  try {
    git(repo, "checkout", "-b", "worker/core");
    addFile(repo, "server.js");
    git(repo, "add", "server.js");
    git(repo, "commit", "-m", "core");

    git(repo, "checkout", "main");
    git(repo, "checkout", "-b", "worker/protocol-qa");
    addFile(repo, "schemas/s.json", "{}");
    git(repo, "add", "schemas/");
    git(repo, "commit", "-m", "pqa");

    git(repo, "checkout", "main");
    git(repo, "merge", "--no-ff", "worker/core", "-m", "sprint-close: merge worker/core");
    git(repo, "merge", "--no-ff", "worker/protocol-qa", "-m", "sprint-close: merge worker/protocol-qa");

    const coreAhead = git(repo, "log", "--oneline", "worker/core", "^main");
    assert(coreAhead === "", "C2: worker/core has 0 commits ahead of main after merge", coreAhead);
    const pqaAhead = git(repo, "log", "--oneline", "worker/protocol-qa", "^main");
    assert(pqaAhead === "", "C2: worker/protocol-qa has 0 commits ahead of main after merge", pqaAhead);
  } catch (e) { fail("C2: unexpected error", e.message); }
  finally { cleanup(repo); }
}

{
  // C3: merge commit message follows documented format "sprint-close: merge worker/<name>"
  const repo = makeRepo("C3");
  try {
    git(repo, "checkout", "-b", "worker/core");
    addFile(repo, "server.js");
    git(repo, "add", "server.js");
    git(repo, "commit", "-m", "core change");

    git(repo, "checkout", "main");
    git(repo, "merge", "--no-ff", "worker/core", "-m", "sprint-close: merge worker/core");

    const mergeMsg = git(repo, "log", "--format=%s", "-1");
    assert(mergeMsg === "sprint-close: merge worker/core",
      "C3: merge commit message matches documented format", `got '${mergeMsg}'`);
  } catch (e) { fail("C3: unexpected error", e.message); }
  finally { cleanup(repo); }
}

{
  // C4: git log --oneline -8 shows both merge commits (orchestrator's verification step)
  const repo = makeRepo("C4");
  try {
    git(repo, "checkout", "-b", "worker/core");
    addFile(repo, "server.js");
    git(repo, "add", "server.js");
    git(repo, "commit", "-m", "core work");

    git(repo, "checkout", "main");
    git(repo, "checkout", "-b", "worker/protocol-qa");
    addFile(repo, "schemas/s.json", "{}");
    git(repo, "add", "schemas/");
    git(repo, "commit", "-m", "pqa work");

    git(repo, "checkout", "main");
    git(repo, "merge", "--no-ff", "worker/core", "-m", "sprint-close: merge worker/core");
    git(repo, "merge", "--no-ff", "worker/protocol-qa", "-m", "sprint-close: merge worker/protocol-qa");

    const log = git(repo, "log", "--oneline", "-8");
    assert(log.includes("merge worker/core"), "C4: log -8 shows worker/core merge", log);
    assert(log.includes("merge worker/protocol-qa"), "C4: log -8 shows worker/protocol-qa merge", log);
  } catch (e) { fail("C4: unexpected error", e.message); }
  finally { cleanup(repo); }
}

// ── Section D: Multi-repo sprint-close ───────────────────────────────────────

console.log("\n=== D. Multi-repo sprint-close (setup-broker.md REPO_MODE=multi-repo) ===\n");

{
  // D1: each worker's commits stay in their own repo (no cross-repo contamination)
  const repo1 = makeRepo("D1-worker1");
  const repo2 = makeRepo("D1-worker2");
  try {
    git(repo1, "checkout", "-b", "worker/api");
    addFile(repo1, "api.js");
    git(repo1, "add", "api.js");
    git(repo1, "commit", "-m", "[proj] api change");

    git(repo2, "checkout", "-b", "worker/web");
    addFile(repo2, "web.js");
    git(repo2, "add", "web.js");
    git(repo2, "commit", "-m", "[proj] web change");

    // repo1 main should not have web.js; repo2 main should not have api.js
    const r1Files = gitTry(repo1, "ls-tree", "-r", "--name-only", "worker/api");
    const r2Files = gitTry(repo2, "ls-tree", "-r", "--name-only", "worker/web");
    assert(!r1Files.stdout.includes("web.js"), "D1: repo1 does not contain web.js", r1Files.stdout);
    assert(!r2Files.stdout.includes("api.js"), "D1: repo2 does not contain api.js", r2Files.stdout);
  } catch (e) { fail("D1: unexpected error", e.message); }
  finally { cleanup(repo1, repo2); }
}

{
  // D2: multi-repo sprint-close merges each repo to its own main independently
  const repo1 = makeRepo("D2-repo1");
  const repo2 = makeRepo("D2-repo2");
  try {
    git(repo1, "checkout", "-b", "worker/api");
    addFile(repo1, "api.js");
    git(repo1, "add", "api.js");
    git(repo1, "commit", "-m", "api work");
    git(repo1, "checkout", "main");
    git(repo1, "merge", "--no-ff", "worker/api", "-m", "sprint-close: merge worker/api");

    git(repo2, "checkout", "-b", "worker/web");
    addFile(repo2, "web.js");
    git(repo2, "add", "web.js");
    git(repo2, "commit", "-m", "web work");
    git(repo2, "checkout", "main");
    git(repo2, "merge", "--no-ff", "worker/web", "-m", "sprint-close: merge worker/web");

    const apiAhead = git(repo1, "log", "--oneline", "worker/api", "^main");
    assert(apiAhead === "", "D2: worker/api has 0 commits ahead of repo1 main after merge", apiAhead);
    const webAhead = git(repo2, "log", "--oneline", "worker/web", "^main");
    assert(webAhead === "", "D2: worker/web has 0 commits ahead of repo2 main after merge", webAhead);

    const apiInMain = git(repo1, "log", "--oneline", "--", "api.js");
    assert(apiInMain.includes("api work"), "D2: api.js present in repo1 main", apiInMain);
    const webInMain = git(repo2, "log", "--oneline", "--", "web.js");
    assert(webInMain.includes("web work"), "D2: web.js present in repo2 main", webInMain);
  } catch (e) { fail("D2: unexpected error", e.message); }
  finally { cleanup(repo1, repo2); }
}

{
  // D3: branch verification command catches an empty worker branch (no sprint commits)
  const repo = makeRepo("D3");
  try {
    // Worker branch exists but has no commits above main
    git(repo, "checkout", "-b", "worker/api");
    git(repo, "checkout", "main");
    const ahead = git(repo, "log", "--oneline", "worker/api", "^main");
    assert(ahead === "", "D3: empty worker branch shows 0 commits ahead of main (guard triggers)", `got: '${ahead}'`);
  } catch (e) { fail("D3: unexpected error", e.message); }
  finally { cleanup(repo); }
}

{
  // D4: multi-repo trial merge — no cross-repo interference possible (repos are independent)
  const repo1 = makeRepo("D4-repo1");
  const repo2 = makeRepo("D4-repo2");
  try {
    // Both repos have a file named "config.js" — in multi-repo there's no merge conflict
    git(repo1, "checkout", "-b", "worker/api");
    addFile(repo1, "config.js", `const X = "api";\n`);
    git(repo1, "add", "config.js");
    git(repo1, "commit", "-m", "api config");

    git(repo2, "checkout", "-b", "worker/web");
    addFile(repo2, "config.js", `const X = "web";\n`);
    git(repo2, "add", "config.js");
    git(repo2, "commit", "-m", "web config");

    git(repo1, "checkout", "main");
    git(repo2, "checkout", "main");

    const r1 = gitTry(repo1, "merge", "--no-commit", "--no-ff", "worker/api");
    git(repo1, "merge", "--abort");
    const r2 = gitTry(repo2, "merge", "--no-commit", "--no-ff", "worker/web");
    git(repo2, "merge", "--abort");

    assert(r1.ok, "D4: trial merge in repo1 succeeds (same-named file no cross-repo conflict)", r1.stderr);
    assert(r2.ok, "D4: trial merge in repo2 succeeds independently", r2.stderr);
  } catch (e) { fail("D4: unexpected error", e.message); }
  finally { cleanup(repo1, repo2); }
}

// ── Section E: Result envelope branch field ───────────────────────────────────

console.log("\n=== E. Result envelope branch field ===\n");

{
  // E1: after branch safety checkout, current branch is worker/<name> (not main)
  const repo = makeRepo("E1");
  try {
    git(repo, "checkout", "-b", "worker/core");
    const branch = git(repo, "branch", "--show-current");
    assert(branch === "worker/core",
      "E1: current branch is worker/core after checkout (correct value for body.commits[0].branch)",
      `got '${branch}'`);
    assert(branch !== "main", "E1: current branch is NOT main", branch);
  } catch (e) { fail("E1: unexpected error", e.message); }
  finally { cleanup(repo); }
}

{
  // E2: the branch read at commit time matches the branch name in the result envelope
  const repo = makeRepo("E2");
  try {
    git(repo, "checkout", "-b", "worker/protocol-qa");
    addFile(repo, "schemas/s.json", "{}");
    git(repo, "add", "schemas/");
    git(repo, "commit", "-m", "[cb-test] add schema");
    // Worker reads branch name to populate body.commits[0].branch
    const branch = git(repo, "branch", "--show-current");
    const sha = git(repo, "rev-parse", "--short", "HEAD");
    // These are what goes into body.commits
    assert(branch === "worker/protocol-qa",
      "E2: branch in result envelope would be worker/protocol-qa (not main)", `got '${branch}'`);
    assert(sha.length >= 7, "E2: SHA is at least 7 chars", sha);
  } catch (e) { fail("E2: unexpected error", e.message); }
  finally { cleanup(repo); }
}

{
  // E3: commit verify step confirms only owned files in the commit
  const repo = makeRepo("E3");
  try {
    git(repo, "checkout", "-b", "worker/core");
    // Simulate accidentally touching a foreign file but only staging owned file
    addFile(repo, "server.js", "// new\n");
    addFile(repo, "schemas/leak.json", "{}");
    git(repo, "add", "server.js");  // ONLY owned file
    git(repo, "commit", "-m", "[cb-test] core fix");
    const names = git(repo, "show", "HEAD", "--name-only");
    const lines = names.split("\n").filter(l => l && !l.startsWith("[") && !l.includes("Author") && !l.includes("Date") && !l.includes("commit"));
    const changedFiles = lines.filter(l => !l.startsWith(" ") && l.trim() !== "" && !l.includes("---") && !l.match(/^\s*$/));
    assert(names.includes("server.js"), "E3: git show HEAD --name-only includes server.js", names);
    assert(!names.includes("schemas/leak.json"), "E3: git show HEAD --name-only excludes foreign file", names);
  } catch (e) { fail("E3: unexpected error", e.message); }
  finally { cleanup(repo); }
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(55)}`);
console.log(`[git-protocol] ${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
