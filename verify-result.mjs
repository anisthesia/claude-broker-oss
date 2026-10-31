#!/usr/bin/env node
// Harness-verified checks: re-run a task's dispatch checks[] at the commit its result names, and stamp
// the outcome on the broker (POST /verifications) — the worker's self-reported required_checks are
// never trusted, and its message is never edited.
//
//   node verify-result.mjs --status-channel cb-status --repo <git dir> [--worker core] [--since-id N]
//                          [--broker http://localhost:8080] [--timeout-s 900] [--node <path>] [--dry-run]
//                          [--result-id N]
//   node verify-result.mjs --watch <ms> --status-channel cb-status --repo <git dir> [--state-dir <dir>] ...
//
// --watch <ms> (min 10000) is the standalone verifier: a long-running loop, meant for a launchd job outside
// every worker's process tree (runner/com.claude.broker.verifier.plist.example), that holds VERIFIER_TOKEN.
// Each cycle it asks GET /health whether the broker requires the verifier credential for this namespace
// (verifier_trust); if not, it idles (the watchdogs still verify). Otherwise it fetches the repo, verifies every
// pending result since its saved cursor (<state-dir>/<status>.since; first start = the channel's current max id)
// and logs one JSON line per cycle to stdout. A lock file (<state-dir>/<status>.lock) keeps two verifiers off one
// namespace. A live holder counts as a verifier only if its argv has verify-result.mjs, --watch and --status-channel
// <this channel>; then this start exits 1 and posts a type:note alert on the status channel (once a day). Any other
// live holder (a reused pid, a decoy) is taken over, with an ERROR and the same note posted after the lock is ours.
// Breaking a lock happens under <lock>.takeover (wx), so two concurrent starts never both hold it.
// --since-id seeds the cursor; --worker, --result-id and --dry-run are one-shot only.
//
// --result-id N re-verifies that one result even if it already has a verification (a false harness FAIL,
// a fixed environment): the new outcome replaces the row and the old one is kept in its history field
// (GET /verifications). Without it, verified results are never picked again. With --worker too, the result
// must be that worker's: a result posted by someone else is an error (exit 1), not a silent no-op.
//
// The broker (GET /verifications/pending) picks the candidates: the latest result per task with
// body.commits (or with no commits and a summary starting PASS: verified at the worker branch HEAD,
// origin/<branch> first, and that sha is recorded), not yet verified, whose first dispatch in a namespace inbox at or before the result
// was stored with the namespace orchestrator as sender and has checks[]. That sender is the DB column.
// In a namespace listed in the broker's ORCHESTRATOR_TRUST_NAMESPACES it is credential-bound (a write as
// the orchestrator needs X-Orchestrator-Token, lib/auth.js), so a worker cannot plant its own checks.
// Elsewhere send_message takes sender= freely, and this catches honest mistakes and stale claims only. Only those dispatch commands run — never a
// command found in a result body. Each candidate is checked out detached in a scratch worktree under the OS temp dir
// (never the worker's live worktree), each check runs there with `bash -c` under a timeout and an
// isolated PORT / TEST_PORT / DB_PATH with the broker credentials, WATCHDOG_* and other credentials
// (ANTHROPIC_*, CLAUDE_CODE_*, *_API_KEY, *_SECRET, *_TOKEN) removed, and the
// worktree is removed afterwards. A check passes iff it exits 0 within its timeout; pass_condition
// is prose and is recorded, not evaluated.
// A failing check whose full output (not only the tail) shows the verifier's environment, not the commit, as
// the cause is posted status ENV with env_reason (classifyEnv): node-abi (ERR_DLOPEN_FAILED on a node_modules .node file),
// syntax-error (bash: -c: … — the dispatch's own command line does not parse), command-not-found (the
// check's own first word, not a binary a shipped script calls), cross-branch (a run-tests summary whose
// only non-PASS suites are MISSING and absent at main's tip too). The broker stores a run whose non-PASS checks
// are all ENV as verified null; one real FAIL makes it false.
// Branch rule: the sha must be an ancestor of the candidate's branch (the broker's, never the result body's:
// worker/<result sender>, or the dispatch's own branch), origin/<branch> or <branch>, or of main (origin/main, main:
// merged or carried commits); otherwise one FAIL "branch" check, nothing runs. A cited sha main already contained at
// dispatch (an ancestor of main's newest first-parent commit dated <= dispatched_at) is FAIL "branch" too: citing
// main's tip is not the task's work. A sha not in --repo is ENV commit-missing (a clone may not have fetched it yet),
// as is a sha whose branch is unreachable and which main does not contain, and a short sha matching several commits
// (the tail says ambiguous; the broker's env_reason list has no separate value). A candidate without branch or dispatched_at (a broker older than these rules) skips them, with a WARN.
// Plan gate: a candidate whose task needs a plan that is not approved (plan_approved: false) gets one FAIL
// "plan-gate" check without any checkout — the same rule post_result enforces (lib/tools/sprint.js planApproval).
//
// A commit that tracks node_modules/ (at any depth, any letter case) is refused with a FAIL "node_modules" before checkout.
// Checks run under one chosen node, first on their PATH: --node / VERIFY_NODE_BIN when set, else the first
// candidate that loads the worktree's better-sqlite3 (its native addon is built for one ABI, so the wrong
// node fails every check that opens a DB; the probe runs with the checks' stripped env): this process's node, ~/.nvm/versions/node/*/bin/node newest
// first, /opt/homebrew/bin/node, /usr/local/bin/node. The choice and why heads every check's tail.
//
// Env: BROKER_URL, BROKER_SECRET (bearer for the broker; never passed to checks),
//      VERIFIER_TOKEN (sent as X-Verifier-Token: required by a broker with VERIFIER_TOKEN_SHA256 for the namespaces
//      in VERIFIER_TRUST_NAMESPACES; never passed to checks — STRIP_ENV drops *_TOKEN),
//      VERIFY_CHECK_TIMEOUT_S (default 900; a dispatch check's own timeout_s wins),
//      VERIFY_NODE_BIN (node for the checks; --node wins).
// Exit: 0 when every candidate was stamped (pass or fail), 1 on a usage or broker error.
// stdout: one JSON line {verified: [{task_id, result_id, verified, checks}], skipped: [...]}.

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, symlinkSync, mkdirSync, readdirSync, realpathSync, readFileSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 && i + 1 < args.length ? args[i + 1] : def; };
const flag = (name) => args.includes(`--${name}`);

const BROKER = (opt("broker", process.env.BROKER_URL || "http://localhost:8080")).replace(/\/mcp\/?$/, "").replace(/\/$/, "");
const SECRET = process.env.BROKER_SECRET || "";
const VERIFIER_TOKEN = process.env.VERIFIER_TOKEN || "";
const STATUS = opt("status-channel");
const WORKER = opt("worker");
const REPO = opt("repo");
const SINCE = parseInt(opt("since-id", "0"), 10);
const TIMEOUT_S = parseInt(opt("timeout-s", process.env.VERIFY_CHECK_TIMEOUT_S || "900"), 10);
const NODE_FLAG = opt("node", ""), NODE_ENV = process.env.VERIFY_NODE_BIN || "";
const DRY = flag("dry-run");
const RESULT_ID = opt("result-id", "");
const WATCH_MS = flag("watch") ? parseInt(opt("watch", ""), 10) : null;
const STATE_DIR = opt("state-dir", join(homedir(), ".claude-broker", "verifier"));
const TAIL_LINES = 20, TAIL_CHARS = 2000, BUF_CHARS = 64 * 1024;

const log = (m) => console.error(`[verify] ${m}`);
if (!STATUS || !REPO || isNaN(SINCE) || isNaN(TIMEOUT_S) || TIMEOUT_S <= 0 || (RESULT_ID !== "" && !/^[1-9]\d*$/.test(RESULT_ID))
    || (WATCH_MS !== null && (isNaN(WATCH_MS) || WATCH_MS < 10000 || WORKER || RESULT_ID || DRY))) {
  console.error("usage: verify-result.mjs --status-channel <ns>-status --repo <git dir> [--worker <name>] [--since-id N] [--result-id N] [--timeout-s S] [--node <path>] [--dry-run]\n" +
                "       verify-result.mjs --watch <ms ≥ 10000> --status-channel <ns>-status --repo <git dir> [--state-dir <dir>] [--since-id N] [--timeout-s S] [--node <path>]");
  process.exit(1);
}

async function broker(method, path, body) {
  const res = await fetch(`${BROKER}${path}`, {
    method, signal: AbortSignal.timeout(15000),
    headers: { "Content-Type": "application/json", ...(SECRET && { Authorization: `Bearer ${SECRET}` }),
               ...(VERIFIER_TOKEN && { "X-Verifier-Token": VERIFIER_TOKEN }) },
    ...(body && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (res.status === 403 && path.startsWith("/verifications"))
    throw new Error(`${method} ${path} → 403: this namespace needs the verifier credential (VERIFIER_TOKEN ${VERIFIER_TOKEN ? "does not match" : "is unset"}) — ${text.slice(0, 200)}`);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const git = (...a) => spawnSync("git", ["-C", REPO, ...a], { encoding: "utf8" });

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}

// Node for the checks: { bin, why }. Probed in the scratch worktree, so the addon tried is the one the checks load.
const NODE_PROBE = `let p; try { p = require.resolve("better-sqlite3"); } catch { process.exit(3); } new (require(p))(":memory:").close();`;
function nodeCandidates() {
  const nvm = join(process.env.NVM_DIR || join(homedir(), ".nvm"), "versions", "node");
  let vers = [];
  try { vers = readdirSync(nvm).filter(v => /^v\d+\.\d+\.\d+$/.test(v)); } catch {}
  const num = (v) => v.slice(1).split(".").map(Number);
  vers.sort((a, b) => { const x = num(a), y = num(b); return y[0] - x[0] || y[1] - x[1] || y[2] - x[2]; });
  const seen = new Set(), out = [];
  for (const c of [process.execPath, ...vers.map(v => join(nvm, v, "bin", "node")), "/opt/homebrew/bin/node", "/usr/local/bin/node"]) {
    let r; try { r = realpathSync(c); } catch { continue; }
    if (!seen.has(r)) { seen.add(r); out.push(c); }
  }
  return out;
}
function selectNode(cwd) {
  if (NODE_FLAG) return { bin: NODE_FLAG, why: "--node" };
  if (NODE_ENV) return { bin: NODE_ENV, why: "VERIFY_NODE_BIN" };
  const tried = [];
  for (const bin of nodeCandidates()) {
    // The probe loads the worktree's better-sqlite3, i.e. commit code: it gets the checks' stripped env.
    const r = spawnSync(bin, ["-e", NODE_PROBE], { cwd, env: strippedEnv(), encoding: "utf8", timeout: 15000 });
    if (r.status === 3) return { bin: process.execPath, why: "probe: no better-sqlite3 in the worktree, the verifier's own node" };
    if (r.status === 0) return { bin, why: `probe: first candidate that loads better-sqlite3${tried.length ? ` (rejected: ${tried.join(", ")})` : ""}` };
    const abi = /NODE_MODULE_VERSION (\d+)[\s\S]*?NODE_MODULE_VERSION (\d+)/.exec(r.stderr || "");
    tried.push(`${bin}${abi ? ` ABI ${abi[2]} ≠ addon ${abi[1]}` : ` exit ${r.status ?? r.signal}`}`);
  }
  return { bin: process.execPath, why: `probe: no candidate loads better-sqlite3 (${tried.join(", ")}), the verifier's own node` };
}

// Why a failed check is the environment's fault, or null: see the header. out is the whole buffered output.
// node-abi and cross-branch must not be reachable by the commit under test: node-abi needs Node's own dlopen
// failure on a node_modules .node file (not a printed NODE_MODULE_VERSION), and cross-branch needs every MISSING
// suite to be absent at main's tip too (added on another branch), so deleting a suite stays a FAIL.
const DLOPEN_ABI = /The module '[^'\n]*[\\/]node_modules[\\/][^'\n]*\.node'\s+was compiled against a different Node\.js version using\s+NODE_MODULE_VERSION \d+/;
function mainTip() {
  for (const ref of ["origin/main", "main"]) if (git("rev-parse", "--verify", "-q", `${ref}^{commit}`).status === 0) return ref;
  return null;
}
function classifyEnv(run, out) {
  if (DLOPEN_ABI.test(out) && /\bERR_DLOPEN_FAILED\b/.test(out)) return "node-abi";
  if (/^bash: -c: .*syntax error/m.test(out)) return "syntax-error";
  const first = String(run).trim().split(/\s+/)[0];
  for (const m of out.matchAll(/^bash: (?:line \d+: )?(\S+): command not found$/gm)) if (m[1] === first) return "command-not-found";
  const i = out.lastIndexOf("[run-tests] summary");
  if (i >= 0) {
    const rows = out.slice(i).split("\n").slice(1).filter(l => /^ {2}\S/.test(l)).map(l => l.trim().split(/\s+/));
    const st = rows.map(r => r[0]), missing = rows.filter(r => r[0] === "MISSING").map(r => r[1]).filter(Boolean);
    if (missing.length && st.includes("PASS") && st.every(s => s === "PASS" || s === "MISSING")) {
      const main = mainTip();
      if (main && missing.every(f => git("cat-file", "-e", `${main}:${f}`).status !== 0)) return "cross-branch";
    }
  }
  return null;
}

const tail = (s) => s.split("\n").slice(-TAIL_LINES - 1).join("\n").trimEnd().slice(-TAIL_CHARS);

// What a check may see of our environment: nothing that reaches the live broker or steers a watchdog,
// no credentials (Anthropic / Claude Code / GitHub tokens, any *_API_KEY, *_SECRET, *_TOKEN), and none of
// the verifier's own VERIFY_* / VERIFIER_* settings (a VERIFY_NODE_BIN reaching a check that runs this verifier
// overrides its node probe); the chosen node reaches the checks only as the head of PATH.
const STRIP_ENV = /^(WATCHDOG|BROKER|FOLLOWUP|ANTHROPIC|CLAUDE_CODE|VERIFY|VERIFIER)_|_(API_KEY|SECRET|TOKEN)$/;
function strippedEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (STRIP_ENV.test(k) || ["PORT", "TEST_PORT", "DB_PATH", "WORKERS_CONFIG"].includes(k)) delete env[k];
  }
  return env;
}
function checkEnv(scratch, port, testPort, nodeBin) {
  const env = strippedEnv();
  const data = join(scratch, ".verify");
  mkdirSync(data, { recursive: true });
  return { ...env, PORT: String(port), TEST_PORT: String(testPort), DB_PATH: join(data, "broker.db"),
           VERIFY_RUN: "1", PATH: `${dirname(nodeBin)}:${env.PATH || "/usr/bin:/bin"}` };
}

function runCheck(check, cwd, env, nodeLog) {
  const limit = (check.timeout_s || TIMEOUT_S) * 1000;
  return new Promise((done) => {
    const started = Date.now();
    let out = "", timedOut = false, killer = null;
    // detached: its own process group, so a timeout kills the whole tree (a check's scratch broker too).
    const child = spawn("bash", ["-c", check.run], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const onData = (d) => { out += d; if (out.length > BUF_CHARS) out = out.slice(-BUF_CHARS); };
    child.stdout.on("data", onData); child.stderr.on("data", onData);
    const kill = (sig) => { try { process.kill(-child.pid, sig); } catch {} };
    const timer = setTimeout(() => { timedOut = true; kill("SIGTERM"); killer = setTimeout(() => kill("SIGKILL"), 5000); }, limit);
    child.on("close", (code, signal) => {
      clearTimeout(timer); clearTimeout(killer);
      kill("SIGKILL"); // stragglers that outlived the shell
      const exit_code = Number.isInteger(code) ? code : null;
      const env_reason = !timedOut && exit_code !== 0 ? classifyEnv(check.run, out) : null;
      const status = !timedOut && exit_code === 0 ? "PASS" : env_reason ? "ENV" : "FAIL";
      const t = timedOut ? `${tail(out)}\n[verify] timed out after ${limit / 1000}s` : signal ? `${tail(out)}\n[verify] killed by ${signal}` : tail(out);
      done({ name: check.name, status, ...(env_reason && { env_reason }), exit_code, ...(timedOut && { timed_out: true }), duration_ms: Date.now() - started, tail: `${nodeLog}\n${t}`.trim() });
    });
    child.on("error", (e) => { clearTimeout(timer); done({ name: check.name, status: "FAIL", exit_code: null, duration_ms: Date.now() - started, tail: `${nodeLog}\n[verify] spawn failed: ${e.message}` }); });
  });
}

// node_modules is untracked (a commit that tracks it is refused), so a fresh worktree has none: borrow the
// repo's (worker worktree, else main).
function linkNodeModules(scratch) {
  if (existsSync(join(scratch, "node_modules"))) return;
  const top = git("rev-parse", "--show-toplevel").stdout.trim();
  const common = git("rev-parse", "--path-format=absolute", "--git-common-dir").stdout.trim();
  for (const dir of [top, common && dirname(common)]) {
    if (dir && existsSync(join(dir, "node_modules"))) { try { symlinkSync(join(dir, "node_modules"), join(scratch, "node_modules")); } catch {} return; }
  }
}

// The commit to verify: the result's own sha, else (a result with no commits) the worker branch HEAD.
function resolveSha(c) {
  if (c.sha !== null || typeof c.branch !== "string" || !c.branch) return c.sha;
  for (const ref of [`origin/${c.branch}`, c.branch]) {
    const r = git("rev-parse", "--verify", "-q", `${ref}^{commit}`);
    if (r.status === 0) return r.stdout.trim();
  }
  return null;
}

// The refs of a branch that resolve in --repo, origin/<branch> first.
const refsOf = (branch) => [`origin/${branch}`, branch].filter(ref => git("rev-parse", "--verify", "-q", `${ref}^{commit}`).status === 0);

async function verify(c) {
  const fail = (name, msg) => [{ name, status: "FAIL", exit_code: null, tail: msg }];
  const envMissing = (msg) => [{ name: "commit", status: "ENV", env_reason: "commit-missing", exit_code: null, tail: msg }];
  if (c.plan_approved === false) return fail("plan-gate", `refused: ${c.task_id} needs an approved plan and has none — checks not run`);
  const hasBranch = typeof c.branch === "string" && c.branch !== "";
  if (!hasBranch) log(`WARN: ${c.task_id} #${c.result_id}: the broker sent no branch (older than the branch rule) — not checking that ${c.sha} is on the sender's branch`);
  const branchRefs = hasBranch ? refsOf(c.branch) : [];
  const cited = c.sha !== null;
  if (c.sha === null && c.branch) {
    c.sha = resolveSha(c);
    if (!c.sha) return fail("commit", `result has no commits and branch ${c.branch} is not in ${REPO} (origin/${c.branch} or ${c.branch})`);
    log(`${c.task_id} #${c.result_id}: no commits in the result — verifying ${c.branch} HEAD ${c.sha.slice(0, 12)}`);
  }
  if (typeof c.sha !== "string" || !/^[0-9a-f]{7,40}$/i.test(c.sha)) return fail("commit", `result has no valid body.commits[].sha (${JSON.stringify(c.sha)})`);
  const full = git("rev-parse", "--verify", "-q", `${c.sha}^{commit}`);
  // Not in --repo: ENV either way, so the result stays unverified (null), never verified. A --repo clone may not have
  // fetched the commit yet even when it has the branch ref, and a short sha can match several commits.
  if (full.status !== 0) {
    const commits = c.sha.length < 40
      ? git("rev-parse", `--disambiguate=${c.sha}`).stdout.split("\n").filter(o => o && git("cat-file", "-t", o).stdout.trim() === "commit") : [];
    if (commits.length > 1)
      return envMissing(`short sha ${c.sha} is ambiguous: it matches ${commits.length} commits in ${REPO} (${commits.map(o => o.slice(0, 12)).join(", ")}) — cite the full sha`);
    return envMissing(`commit ${c.sha} not found in ${REPO}${branchRefs.length ? `, which has ${branchRefs[0]}` : hasBranch ? ` and ${c.branch} is not there either` : " and no branch to check"} (not fetched or never pushed) — re-verify with --result-id once it is there`);
  }
  const sha = full.stdout.trim();
  // A tracked node_modules/ would replace the borrowed one and run commit code on require (the node probe
  // included): refuse the commit outright rather than trust any module in it.
  const tree = spawnSync("git", ["-C", REPO, "ls-tree", "-r", "-t", "-z", "--name-only", sha], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (tree.status !== 0) return fail("commit", `git ls-tree ${sha} failed: ${(tree.stderr || "").trim().slice(-300)}`);
  const nm = tree.stdout.split("\0").find(p => /(^|\/)node_modules$/i.test(p)); // dir, file or symlink; any case (macOS/Windows checkouts fold it onto the borrowed one)
  if (nm) return fail("node_modules", `refused: commit ${sha.slice(0, 12)} tracks ${nm} — node_modules is never taken from a commit`);
  // The sha must be on the sender's branch (or main): otherwise a worker could cite any passing commit.
  if (hasBranch) {
    const main = ["origin/main", "main"].filter(ref => git("rev-parse", "--verify", "-q", `${ref}^{commit}`).status === 0);
    const on = [...branchRefs, ...main].find(ref => git("merge-base", "--is-ancestor", sha, ref).status === 0);
    if (!on && !branchRefs.length)
      return envMissing(`${c.branch} (origin/${c.branch} or ${c.branch}) is not in ${REPO} and main does not contain ${sha.slice(0, 12)} — cannot check the commit is ${c.sender ? `${c.sender}'s` : "the sender's"}; re-verify with --result-id once it is there`);
    if (!on) return fail("branch", `refused: commit ${sha.slice(0, 12)} is not on ${c.branch} (${branchRefs.join(", ")}) nor on main — a result must cite a commit of ${c.sender ? `${c.sender}'s` : "its sender's"} branch; checks not run`);
    // A cited commit main already had when the task was dispatched is not the task's work, even though it is on
    // every branch cut from main. Main at dispatch = the newest first-parent commit dated at or before dispatched_at
    // (sprint-close merges are dated when they land). A commit made after dispatch and merged since is not under it.
    // A no-commit result verifies the branch HEAD, which may well be main's tip: not a citation, so not refused.
    const at = Date.parse(c.dispatched_at ?? "");
    if (!Number.isFinite(at)) log(`WARN: ${c.task_id} #${c.result_id}: the broker sent no dispatched_at (older than the dispatch-time rule) — not checking that ${sha.slice(0, 12)} postdates the dispatch`);
    else if (cited) {
      for (const ref of main) {
        const tip = git("rev-list", "-1", "--first-parent", `--before=${Math.floor(at / 1000)}`, ref).stdout.trim();
        if (tip && git("merge-base", "--is-ancestor", sha, tip).status === 0)
          return fail("branch", `refused: commit ${sha.slice(0, 12)} was already on ${ref} when ${c.task_id} was dispatched (${c.dispatched_at}; ${ref} was at ${tip.slice(0, 12)}) — a result must cite the task's own commit; checks not run`);
      }
    }
  }
  // Named by result id, not task_id: a check sees its checkout path (resolve(".")), and a task_id puts "<ns>-" in it.
  const scratch = mkdtempSync(join(tmpdir(), `verify-r${c.result_id}-`));
  try {
    const add = git("worktree", "add", "--detach", scratch, sha);
    if (add.status !== 0) return fail("checkout", `git worktree add ${sha} failed: ${(add.stderr || "").trim().slice(-500)}`);
    linkNodeModules(scratch);
    const node = selectNode(scratch);
    const version = spawnSync(node.bin, ["--version"], { encoding: "utf8" }).stdout?.trim() || "?";
    const nodeLog = `[verify] node: ${node.bin} ${version} (${node.why})`;
    log(`${c.task_id} #${c.result_id}: ${nodeLog.slice(9)}`);
    const results = [];
    for (const check of c.checks) {
      const env = checkEnv(scratch, await freePort(), await freePort(), node.bin);
      log(`${c.task_id} #${c.result_id} @${sha.slice(0, 8)}: ${check.name} — ${check.run}`);
      const r = await runCheck(check, scratch, env, nodeLog);
      log(`  ${r.status}${r.env_reason ? ` ${r.env_reason}` : ""} (exit ${r.exit_code}${r.timed_out ? ", timed out" : ""}, ${Math.round(r.duration_ms / 1000)}s)`);
      results.push(r);
    }
    return results;
  } finally {
    git("worktree", "remove", "--force", scratch);
    rmSync(scratch, { recursive: true, force: true });
    git("worktree", "prune");
  }
}

// One pass: verify every pending candidate after `since` and stamp it.
async function verifyPending(since) {
  const q = new URLSearchParams({ status_channel: STATUS, since_id: String(since), ...(WORKER && { worker: WORKER }), ...(RESULT_ID && { result_id: RESULT_ID }) });
  const plan = await broker("GET", `/verifications/pending?${q}`);
  for (const s of plan.skipped) log(`skip ${s.task_id} #${s.result_id}: ${s.reason}`);
  if (DRY) return { plan };
  if (WATCH_MS !== null && plan.candidates.length) {
    const f = git("fetch", "--quiet", "origin");
    if (f.status !== 0) log(`git fetch origin failed (verifying with what ${REPO} has): ${(f.stderr || "").trim().slice(-200)}`);
  }
  const out = [];
  for (const c of plan.candidates) {
    const checks = await verify(c);
    const r = await broker("POST", "/verifications", { status_channel: STATUS, result_id: c.result_id, dispatch_id: c.dispatch_id, sha: c.sha, checks });
    log(`${c.task_id} #${c.result_id}: verified=${r.verified}`);
    out.push({ task_id: c.task_id, result_id: c.result_id, verified: r.verified, checks: r.checks });
  }
  return { verified: out, skipped: plan.skipped, candidates: plan.candidates.length, pool_full: plan.pool_full === true, pool_last_id: plan.pool_last_id };
}

async function main() {
  const r = await verifyPending(SINCE);
  if (DRY) { console.log(JSON.stringify({ dry_run: true, orchestrator: r.plan.orchestrator, candidates: r.plan.candidates, skipped: r.plan.skipped })); return; }
  console.log(JSON.stringify({ verified: r.verified, skipped: r.skipped }));
}

// ── --watch: the standalone verifier ──────────────────────────────────────────
const stateBase = () => join(STATE_DIR, STATUS.replace(/[^A-Za-z0-9_.-]/g, "_"));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
// The command line of a live pid ("" when ps cannot see it).
const commandOf = (pid) => (spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout || "").trim();
// A holder is a verifier for this namespace only if its argv runs verify-result.mjs with --watch and
// --status-channel <STATUS> (tokens, not a substring: `bash -c 'sleep 1e9' verify-result.mjs` is not one).
function isVerifierCmd(cmd) {
  const t = cmd.split(/\s+/), i = t.indexOf("--status-channel");
  return t.some(a => /(^|\/)verify-result\.mjs$/.test(a)) && t.includes("--watch") && i >= 0 && t[i + 1] === STATUS;
}
// A type:note alert on the status channel for the orchestrator (one task_id per day). kind "held": another
// verifier holds the lock and this start exits; posted once a day per namespace (<state>.alerted), since launchd
// restarts it every cycle. kind "takeover": a lock held by a live non-verifier pid (pid 1 reads as alive, a reused
// pid, a decoy) was taken over; posted only once this process holds the lock.
async function lockAlert(kind, lock, pid, cmd) {
  const day = new Date().toISOString().slice(0, 10);
  const shown = cmd ? JSON.stringify(cmd.slice(0, 200)) : "command not visible";
  const msg = kind === "held" ? `lock ${lock} held by verifier pid ${pid} (${shown}) — this verifier (pid ${process.pid}) exits`
                              : `lock ${lock} held by pid ${pid}, which is not a verifier (${shown}) — taken over`;
  log(`ERROR: ${msg}`);
  const mark = `${stateBase()}.alerted`;
  if (kind === "held") {
    let seen = ""; try { seen = readFileSync(mark, "utf8"); } catch {}
    if (seen.trim() === day) return;
  }
  const content = { type: "note", task_id: `verifier-lock-${day}`, from: "verifier", to: "orchestrator",
                    subject: kind === "held" ? `verifier: another verifier holds the lock on ${STATUS}` : `verifier: foreign lock on ${STATUS}`,
                    summary: msg, body: { kind, lock, pid, command: cmd.slice(0, 200), verifier_pid: process.pid } };
  try {
    await broker("POST", "/messages", { channel: STATUS, sender: "verifier", content });
    if (kind === "held") writeFileSync(mark, `${day}\n`);
  } catch (e) { log(`ERROR: could not post the lock alert to ${STATUS}: ${e.message}`); }
}
const lockPid = (lock) => { try { return parseInt(readFileSync(lock, "utf8"), 10) || 0; } catch { return 0; } };
const ageMs = (f) => { try { return Date.now() - statSync(f).mtimeMs; } catch { return Infinity; } };
const pause = (ms) => new Promise(res => setTimeout(res, ms));
async function takeLock() {
  mkdirSync(STATE_DIR, { recursive: true });
  const lock = `${stateBase()}.lock`, guard = `${lock}.takeover`;
  let foreign = null;
  const create = () => { try { writeFileSync(lock, `${process.pid}\n`, { flag: "wx" }); return true; } catch (e) { if (e.code !== "EEXIST") throw e; return false; } };
  for (let i = 0; i < 50; i++) {
    if (create()) break;
    const pid = lockPid(lock);
    // No readable pid in a fresh lock is a starter between its wx create and its write: not stale yet.
    if (!pid && ageMs(lock) < 2000) { await pause(100); continue; }
    if (pid && pid !== process.pid && alive(pid)) {
      const cmd = commandOf(pid);
      if (isVerifierCmd(cmd)) { await lockAlert("held", lock, pid, cmd); throw new Error(`another verifier (pid ${pid}) holds ${lock}`); }
      foreign = { pid, cmd };
    } else log(`removing stale lock ${lock} (pid ${pid || "?"} is gone)`);
    // Break the lock only under the takeover guard (wx), and only if it still holds the pid judged above: two
    // starters that saw the same stale or foreign lock cannot both remove-and-create; the loser re-reads the winner.
    try { writeFileSync(guard, `${process.pid}\n`, { flag: "wx" }); }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (ageMs(guard) > 30000) { try { unlinkSync(guard); } catch {} } // a starter that died mid-takeover
      await pause(100); continue;
    }
    let ok;
    try { if (lockPid(lock) === pid) { try { unlinkSync(lock); } catch {} } ok = create(); }
    finally { try { unlinkSync(guard); } catch {} }
    if (ok) break;
  }
  if (lockPid(lock) !== process.pid) throw new Error(`could not take ${lock}`);
  if (foreign) await lockAlert("takeover", lock, foreign.pid, foreign.cmd); // only once the lock is ours
  return lock;
}
// Whether the broker requires the verifier credential for this status channel (GET /health verifier_trust).
async function enforced() {
  const t = (await broker("GET", "/health")).verifier_trust;
  const lc = STATUS.toLowerCase();
  return !!(t && t.enabled && t.namespaces.some(n => lc.startsWith(`${n.toLowerCase()}-`)));
}
const channelMax = async () => (await broker("GET", `/inbox?${new URLSearchParams({ channel: STATUS, since_id: "0" })}`)).max_id || 0;

async function watch() {
  const lock = await takeLock();
  process.on("exit", () => { try { if (readFileSync(lock, "utf8").trim() === String(process.pid)) unlinkSync(lock); } catch {} });
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => process.exit(0));
  const sinceFile = `${stateBase()}.since`;
  const save = (n) => writeFileSync(sinceFile, `${n}\n`);
  let since = args.includes("--since-id") ? SINCE : (() => { try { return parseInt(readFileSync(sinceFile, "utf8"), 10); } catch { return NaN; } })();
  if (!VERIFIER_TOKEN) log("WARN: VERIFIER_TOKEN is unset — a broker that enforces the verifier credential refuses every stamp (403)");
  log(`watching ${STATUS} every ${WATCH_MS / 1000}s (repo ${REPO}, cursor ${sinceFile}, lock ${lock})`);
  const line = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), status_channel: STATUS, ...o }));
  for (;;) {
    try {
      if (isNaN(since)) { since = await channelMax(); save(since); log(`no cursor yet — starting after #${since} (the channel's current max)`); }
      if (!(await enforced())) line({ since_id: since, state: "idle", reason: "broker /health verifier_trust does not list this namespace — its watchdogs verify" });
      else {
        const max = await channelMax(); // every result ≤ max is in this pass's pool, unless the pool is full
        const r = await verifyPending(since);
        // A full pool (200 rows, verified ones included) stopped at pool_last_id: resume right after it, never at max.
        const next = r.pool_full ? r.pool_last_id : max;
        if (next > since) { since = next; save(since); }
        line({ since_id: since, candidates: r.candidates, skipped: r.skipped.length, ...(r.pool_full && { pool_full: true }),
               outcomes: r.verified.map(v => ({ task_id: v.task_id, result_id: v.result_id, verified: v.verified })) });
        if (r.pool_full) continue; // more pending past the page (pool_last_id > the old since): next pass now, not after WATCH_MS
      }
    } catch (e) { line({ since_id: since, state: "error", error: e.message }); }
    await new Promise(res => setTimeout(res, WATCH_MS));
  }
}

(WATCH_MS !== null ? watch() : main()).catch((e) => { log(`ERROR: ${e.message}`); process.exit(1); });
