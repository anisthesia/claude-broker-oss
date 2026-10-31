/**
 * test-mcp-v3-migration.js — migrate-mcp-v3.mjs on fixture projects (no broker needed).
 *
 * Fixtures: an unmigrated project (literal secret, a second MCP server, an extra query param), an
 * already-v3 project, a tracked-placeholder project, a project with no .mcp.json (user scope only),
 * one shadowed by a local-scope entry, and a worker dir with its own .mcp.json. Covers: dry run
 * writes nothing, secrets are masked everywhere, --apply writes only .mcp.json (+ a .pre-v3 backup
 * under the git-ignored backup dir, never next to the target) and is idempotent, a worktree outside
 * --project is skipped unless --with-worktrees, --with-guide adds the CLAUDE.md block, the role-file scan, the rollout order
 * and the read-only broker DB summary.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, rmSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  maskSecrets, migrateUrl, planMcpFile, planGuide, planProject, toolsOutsideProfile, allTools,
  rolloutOrder, readBrokerDb, applyPlan, renderProject, backupPath, isInside, DEFAULT_BACKUP_DIR,
} from "./migrate-mcp-v3.mjs";
import { START, END } from "./sync-agent-guide.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "migrate-mcp-v3.mjs");
const SECRET = "fixture-s3cr3t-0123456789abcdef0123456789abcdef";

let passed = 0, failed = 0;
const assert = (cond, label, detail = "") => {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? `: ${detail}` : ""}`); failed++; }
};

const T = mkdtempSync(join(tmpdir(), "mcp-v3-mig-"));
const write = (p, s) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };
const json = (o) => JSON.stringify(o, null, 2) + "\n";
const mcp = (url, auth = `Bearer ${SECRET}`, extra = {}) => json({ mcpServers: { ...extra, broker: { type: "http", url, headers: { Authorization: auth } } } });
// Hash every file under a dir, to prove a dry run writes nothing.
const snapshot = (dir) => {
  const out = {};
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else out[p] = createHash("sha1").update(readFileSync(p)).digest("hex"); } };
  walk(dir);
  return out;
};
// The CLI with a scrubbed env: a watchdog-launched caller's identity must not leak in.
const cli = (args) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(WATCHDOG_|BROKER_|WORKERS_CONFIG)/.test(k)));
  return spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: "utf8", cwd: T });
};

// ── fixtures ─────────────────────────────────────────────────────────────────
const P = (n) => join(T, n);
// ab: unmigrated root .mcp.json (another server + extra query param) + a worker dir with its own .mcp.json
write(join(P("ab"), ".mcp.json"), mcp("http://localhost:8080/mcp?trace=1", `Bearer ${SECRET}`, { other: { type: "stdio", command: "x" } }));
write(join(P("ab"), "CLAUDE.md"), "# ab project\n\nUse `send_message`.\n");
write(join(P("ab"), "backend", ".mcp.json"), mcp("http://localhost:8080/mcp"));
write(join(P("ab"), "backend", "CLAUDE.md"), "# backend worker\nCall `dispatch_task` and `turn_start`.\n");
write(join(P("ab"), "reviewer", "CLAUDE.md"), "# reviewer\nCall `read_last`.\n");
// cd: already v3
write(join(P("cd"), ".mcp.json"), mcp("http://localhost:8080/mcp?role=orchestrator&ns=cd"));
// ef: tracked placeholder
write(join(P("ef"), ".mcp.json"), mcp("http://localhost:8080/mcp", "Bearer ${BROKER_SECRET}"));
// gh: no .mcp.json at all (user scope only); ij: .mcp.json shadowed by a v2 local-scope entry
mkdirSync(P("gh"), { recursive: true });
write(join(P("ij"), ".mcp.json"), mcp("http://localhost:8080/mcp"));
const claudeJson = {
  mcpServers: { broker: { type: "http", url: "http://localhost:8080/mcp", headers: { Authorization: `Bearer ${SECRET}` } } },
  projects: { [P("ij")]: { mcpServers: { broker: { type: "http", url: "http://localhost:8080/mcp?token=" + SECRET, headers: { Authorization: `Bearer ${SECRET}` } } } } },
};
write(join(T, "claude.json"), JSON.stringify(claudeJson));
// kl: a worker whose worktree lives outside the project dir (--work-dir elsewhere), with its own .mcp.json
write(join(P("kl"), ".mcp.json"), mcp("http://localhost:8080/mcp"));
write(join(T, "kl-wt", "api", ".mcp.json"), mcp("http://localhost:8080/mcp"));
const entry = (ns, root, name, extra = []) => ({ name, ns, args: [name, "--repo-root", root, "--inbox-channel", `${ns}-${name}`, ...extra] });
const workers = [
  entry("ab", P("ab"), "backend"), entry("ab", P("ab"), "reviewer"),
  entry("cd", P("cd"), "api"), entry("ef", P("ef"), "web"), entry("gh", P("gh"), "core"), entry("ij", P("ij"), "core"),
  entry("kl", P("kl"), "api", ["--work-dir", join(T, "kl-wt", "api")]),
];
write(join(T, "workers.json"), JSON.stringify(workers));
const GUIDE = "## claude-broker v3\n\nUse typed tools. (Not for you: `register_namespace`.)\n";
write(join(T, "guide.md"), GUIDE);
const BACKUPS = join(T, "backups");
const common = ["--workers", join(T, "workers.json"), "--claude-json", join(T, "claude.json"), "--guide", join(T, "guide.md"), "--backup-dir", BACKUPS];

try {
  // ── 1. secrets ─────────────────────────────────────────────────────────────
  console.log("\n1. Secret masking");
  const masked = maskSecrets(`"Authorization": "Bearer ${SECRET}" url?token=${SECRET}&ns=ab --header "Authorization: Bearer ${SECRET}" "X-Admin-Token": "${SECRET}"`);
  assert(!masked.includes(SECRET), "Bearer, header and token query values are masked", masked);
  assert(masked.includes("Bearer ***") && masked.includes("token=***&ns=ab"), "masked as 'Bearer ***' / 'token=***', other params kept");
  assert(maskSecrets("Bearer ${BROKER_SECRET}") === "Bearer ${BROKER_SECRET}", "a ${VAR} placeholder is not masked");
  // Every credential form the migration may print: JSON keys, header lines, any scheme.
  const forms = [
    [`"Authorization": "Bearer ${SECRET}"`, `"Authorization": "Bearer ***"`],
    [`"Authorization": "Basic ${SECRET}"`, `"Authorization": "Basic ***"`],
    [`"Authorization": "Token ${SECRET}"`, `"Authorization": "Token ***"`],
    [`"Authorization": "${SECRET}"`, `"Authorization": "***"`],
    [`"X-Auth-Token": "${SECRET}"`, `"X-Auth-Token": "***"`],
    [`"X-Orchestrator-Token": "${SECRET}"`, `"X-Orchestrator-Token": "***"`],
    [`"X-Admin-Token": "${SECRET}"`, `"X-Admin-Token": "***"`],
    [`"X-Api-Key": "${SECRET}"`, `"X-Api-Key": "***"`],
    [`"Cookie": "sid=${SECRET}"`, `"Cookie": "***"`],
    [`"client_secret": "${SECRET}"`, `"client_secret": "***"`],
    [`"refreshToken": "${SECRET}"`, `"refreshToken": "***"`],
    [`"db_password": "${SECRET}"`, `"db_password": "***"`],
    [`"api_key": "${SECRET}"`, `"api_key": "***"`],
    [`--header "Authorization: Basic ${SECRET}"`, `--header "Authorization: Basic ***"`],
    [`X-Orchestrator-Token: ${SECRET}`, `X-Orchestrator-Token: ***`],
    [`"X-Auth-Token": "\${TOK}"`, `"X-Auth-Token": "\${TOK}"`],
    [`"tokens_used": 5, "type": "http"`, `"tokens_used": 5, "type": "http"`],
  ];
  const bad = forms.filter(([i, o]) => maskSecrets(i) !== o).map(([i]) => `${i} → ${maskSecrets(i)}`);
  assert(bad.length === 0, `masking covers every Authorization scheme, credential header and secret-named key (${forms.length} forms)`, bad.join(" | "));

  // ── 2. URL ─────────────────────────────────────────────────────────────────
  console.log("\n2. URL migration");
  assert(migrateUrl("http://localhost:8080/mcp", { role: "orchestrator", ns: "ab" }).url === "http://localhost:8080/mcp?role=orchestrator&ns=ab", "interactive: role=orchestrator&ns=, no as=");
  assert(migrateUrl("http://localhost:8080/mcp?trace=1", { role: "worker", ns: "ab", as: "backend" }).url === "http://localhost:8080/mcp?role=worker&ns=ab&as=backend&trace=1", "headless: role=&ns=&as=, other params kept");
  const already = migrateUrl("http://h/mcp?role=orchestrator&ns=zz", { role: "orchestrator", ns: "ab" });
  assert(already.status === "already-v3" && /ns=zz/.test(already.note), "a URL with role= is left alone, an ns mismatch is noted");
  assert(migrateUrl("not a url", { role: "worker", ns: "ab" }).status === "unparsable", "an unparsable URL is reported, not rewritten");

  // ── 3. planning ────────────────────────────────────────────────────────────
  console.log("\n3. Planning (pure read)");
  const before = snapshot(T);
  const root = planMcpFile(P("ab"), { role: "orchestrator", ns: "ab" }, { claudeJson });
  const parsed = JSON.parse(root.after);
  assert(root.status === "change" && parsed.mcpServers.broker.url === "http://localhost:8080/mcp?role=orchestrator&ns=ab&trace=1", "root .mcp.json: broker URL gets role/ns", root.status);
  assert(parsed.mcpServers.other?.command === "x" && parsed.mcpServers.broker.headers.Authorization === `Bearer ${SECRET}`, "other servers and the headers are untouched");
  assert(root.after.replace("?role=orchestrator&ns=ab&trace=1", "?trace=1") === root.before, "only the URL string changes (formatting kept)");
  assert(planMcpFile(P("cd"), { role: "orchestrator", ns: "cd" }).status === "already-v3", "already-v3 project: no change");
  const ef = planMcpFile(P("ef"), { role: "orchestrator", ns: "ef" });
  assert(ef.placeholder && JSON.parse(ef.after).mcpServers.broker.headers.Authorization === "Bearer ${BROKER_SECRET}", "tracked placeholder kept, never inlined");
  const gh = planMcpFile(P("gh"), { role: "orchestrator", ns: "gh" }, { claudeJson });
  assert(gh.status === "missing" && gh.effective.scope === "user" && /claude mcp add -s local .*role=orchestrator&ns=gh/.test(gh.command), "no .mcp.json: user scope reported, local-scope command suggested");
  assert(gh.command.includes("Bearer ***") && !gh.command.includes(SECRET), "the suggested command carries no secret");
  const ij = planMcpFile(P("ij"), { role: "orchestrator", ns: "ij" }, { claudeJson });
  assert(ij.effective.scope === "local" && ij.effective.shadows_mcp_json && /claude mcp remove -s local broker/.test(ij.command), "a v2 local-scope entry shadows .mcp.json and gets its own command");

  const plan = planProject({ project: P("ab"), ns: "ab", entries: workers.filter((w) => w.ns === "ab"), guide: GUIDE, claudeJson });
  const backend = plan.mcp.find((m) => m.dir === join(P("ab"), "backend"));
  assert(plan.underivable.length === 0 && plan.identities.length === 2, "identities derived by watchdog.sh --print-channels", JSON.stringify(plan.underivable));
  assert(backend && JSON.parse(backend.after).mcpServers.broker.url === "http://localhost:8080/mcp?role=worker&ns=ab&as=backend", "worker dir .mcp.json gets that worker's role/ns/as");
  assert(plan.identities.find((i) => i.name === "reviewer")?.role === "reviewer", "reviewer role derived from the inbox name");
  assert(plan.guide.status === "change" && plan.guide.after.includes(START), "guide block planned for the root CLAUDE.md");
  const out = plan.outside_profile.find((o) => o.who === "backend");
  assert(out && out.tools.includes("dispatch_task") && !out.tools.includes("turn_start"), "role-file scan: dispatch_task flagged for a worker, turn_start not");
  assert(!plan.outside_profile.some((o) => o.who === "reviewer"), "reviewer file with in-profile tools only: not flagged");
  const rendered = renderProject(plan);
  assert(!rendered.includes(SECRET) && rendered.includes("Bearer ***"), "rendered report masks the secret in the diff");
  assert(JSON.stringify(snapshot(T)) === JSON.stringify(before), "planning wrote nothing");

  // ── 4. role-file scan ──────────────────────────────────────────────────────
  console.log("\n4. Role-file scan");
  const tools = allTools();
  assert(tools.includes("send_message") && tools.includes("post_result") && tools.length >= 40, `all broker tools found in lib/tools (${tools.length})`);
  const withBlock = `x\n${START}\nnot available: \`register_namespace\`\n${END}\n`;
  assert(toolsOutsideProfile(withBlock, "orchestrator", tools).length === 0, "text inside the v3 guide block is not scanned");
  assert(toolsOutsideProfile("call purge_channel", "worker", tools).includes("purge_channel"), "purge_channel is outside the worker profile");
  assert(toolsOutsideProfile("call purge_channel", "admin", tools).length === 0, "admin sees every tool");

  // ── 5. CLI dry run ─────────────────────────────────────────────────────────
  console.log("\n5. CLI dry run");
  const snap = snapshot(T);
  const dry = cli(["--all", ...common]);
  assert(dry.status === 0, "--all exits 0", dry.stderr);
  assert(!dry.stdout.includes(SECRET) && !dry.stderr.includes(SECRET), "secret never printed (stdout + stderr)");
  assert(/=== Rollout order/.test(dry.stdout) && /=== ab /.test(dry.stdout) && /=== ij /.test(dry.stdout), "report covers every namespace and prints a rollout order");
  assert(/needs adopt_namespace/.test(dry.stdout), "rollout lists namespaces whose headless sessions still need adoption");
  assert(JSON.stringify(snapshot(T)) === JSON.stringify(snap), "dry run wrote nothing");
  const one = cli(["--project", P("ab"), ...common]);
  assert(one.status === 0 && /dry run/.test(one.stdout) && /role=worker&ns=ab&as=backend/.test(one.stdout), "--project derives ns from the workers config", one.stderr);
  assert(cli(["--all", "--apply", ...common]).status === 2, "--all --apply is refused");
  assert(cli(["--project", P("ab"), "--with-guide", ...common]).status === 2, "--with-guide without --apply is refused");
  assert(cli(["--project", join(T, "nowhere"), ...common]).status === 2, "unknown project without --ns is refused");

  // ── 6. --apply ─────────────────────────────────────────────────────────────
  console.log("\n6. --apply (fixtures only)");
  const claudeBefore = readFileSync(join(T, "claude.json"), "utf8");
  const a1 = cli(["--project", P("ab"), "--apply", ...common]);
  assert(a1.status === 0, "--apply exits 0", a1.stderr);
  assert(JSON.parse(readFileSync(join(P("ab"), ".mcp.json"), "utf8")).mcpServers.broker.url.includes("role=orchestrator&ns=ab"), "root .mcp.json written");
  const bak = backupPath(P("ab"), join(P("ab"), ".mcp.json"), BACKUPS);
  assert(bak.startsWith(BACKUPS + "/") && existsSync(bak) && readFileSync(bak, "utf8").includes("mcp?trace=1"), ".pre-v3 backup under --backup-dir holds the original", bak);
  assert(!existsSync(join(P("ab"), ".mcp.json.pre-v3")) && !existsSync(join(P("ab"), "backend", ".mcp.json.pre-v3")), "no backup written next to the target (cannot be committed there)");
  assert((statSync(bak).mode & 0o777) === 0o600 && (statSync(dirname(bak)).mode & 0o777) === 0o700 && (statSync(BACKUPS).mode & 0o777) === 0o700,
    "backup file mode 600, its directories 700 (it holds the bearer)", `${(statSync(bak).mode & 0o777).toString(8)} ${(statSync(dirname(bak)).mode & 0o777).toString(8)}`);
  const defBak = backupPath(P("ab"), join(P("ab"), ".mcp.json"));
  const ign = spawnSync("git", ["check-ignore", "-q", defBak.slice(HERE.length + 1)], { cwd: HERE });
  assert(defBak.startsWith(DEFAULT_BACKUP_DIR + "/") && ign.status === 0, "default backup path is git-ignored in this repo (git check-ignore)", `${defBak} exit ${ign.status}`);
  assert(!readFileSync(join(P("ab"), "CLAUDE.md"), "utf8").includes(START), "CLAUDE.md untouched without --with-guide");
  assert(readFileSync(join(T, "claude.json"), "utf8") === claudeBefore, "Claude Code config never written");
  const snap2 = snapshot(T);
  const a2 = cli(["--project", P("ab"), "--apply", ...common]);
  assert(a2.status === 0 && /applied: nothing to change/.test(a2.stdout) && JSON.stringify(snapshot(T)) === JSON.stringify(snap2), "second --apply is a no-op (idempotent)");
  const a3 = cli(["--project", P("ab"), "--apply", "--with-guide", ...common]);
  const md = readFileSync(join(P("ab"), "CLAUDE.md"), "utf8");
  assert(a3.status === 0 && md.startsWith("# ab project") && md.includes(START) && md.includes("Use typed tools"), "--with-guide appends the guide block, keeps the file's own text");
  assert(applyPlan(planProject({ project: P("ab"), ns: "ab", entries: workers.filter((w) => w.ns === "ab"), guide: GUIDE }), { withGuide: true }).length === 0, "after both applies nothing is left to change");

  // ── 6b. writes confined to --project ───────────────────────────────────────
  console.log("\n6b. --apply stays inside --project unless --with-worktrees");
  const wt = join(T, "kl-wt", "api", ".mcp.json");
  const wtBefore = readFileSync(wt, "utf8");
  const k1 = cli(["--project", P("kl"), "--apply", ...common]);
  assert(k1.status === 0 && /outside --project/.test(k1.stdout) && /skipped \(outside --project; pass --with-worktrees\): .*kl-wt/.test(k1.stdout), "a worktree outside --project is reported as skipped", k1.stdout + k1.stderr);
  assert(readFileSync(wt, "utf8") === wtBefore && JSON.parse(readFileSync(join(P("kl"), ".mcp.json"), "utf8")).mcpServers.broker.url.includes("role=orchestrator&ns=kl"), "... and left untouched while the project root is written");
  const k2 = cli(["--project", P("kl"), "--apply", "--with-worktrees", ...common]);
  assert(k2.status === 0 && JSON.parse(readFileSync(wt, "utf8")).mcpServers.broker.url.includes("role=worker&ns=kl&as=api"), "--with-worktrees writes it", k2.stdout + k2.stderr);
  assert(existsSync(backupPath(P("kl"), wt, BACKUPS)) && backupPath(P("kl"), wt, BACKUPS).includes("/_outside/") && !existsSync(`${wt}.pre-v3`), "its backup goes under the backup dir (_outside/), not next to it");
  mkdirSync(join(T, "elsewhere"), { recursive: true });
  symlinkSync(join(T, "elsewhere"), join(P("kl"), "linked"));
  assert(!isInside(P("kl"), join(P("kl"), "linked", ".mcp.json")) && isInside(P("kl"), join(P("kl"), "sub", ".mcp.json")), "a symlink inside the project that resolves outside counts as outside");

  // ── 7. guide markers ───────────────────────────────────────────────────────
  console.log("\n7. Guide block");
  write(join(P("cd"), "CLAUDE.md"), `${START}\nx\n${START}\n`);
  assert(planGuide(P("cd"), GUIDE).status === "malformed", "malformed markers reported, not rewritten");
  assert(planGuide(P("gh"), GUIDE).status === "create", "missing CLAUDE.md → create (only with --with-guide)");

  // ── 8. rollout order + broker DB ───────────────────────────────────────────
  console.log("\n8. Rollout order and broker DB (read-only)");
  const order = rolloutOrder(["tally", "mg", "dv", "dx", "cb"], { dv: { last_activity: 300 }, dx: { last_activity: 100 }, cb: { last_activity: 200 }, mg: { last_activity: 1 }, tally: { last_activity: 2 } });
  assert(order.join(",") === "dx,cb,dv,mg,tally", `idle first, mg and tally last (${order.join(",")})`);
  const dbPath = join(T, "broker.db");
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, sender TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL);
           CREATE TABLE namespace_adoption (ns TEXT PRIMARY KEY, adopted INTEGER NOT NULL, adopted_at INTEGER, reverted_at INTEGER, updated_at INTEGER NOT NULL, report TEXT);
           CREATE TABLE namespaces (ns TEXT PRIMARY KEY, manifest TEXT NOT NULL, version TEXT, updated_at INTEGER NOT NULL);`);
  const ins = db.prepare("INSERT INTO messages (channel, sender, content, created_at) VALUES (?, 'x', '{}', ?)");
  ins.run("ab-status", 1000); ins.run("abc-status", 5000); ins.run("ab-core", 2000); ins.run("cd-status", 500);
  db.prepare("INSERT INTO namespace_adoption VALUES ('ab', 1, 1, NULL, 1, NULL)").run();
  db.prepare("INSERT INTO namespaces VALUES ('ab', '{}', '1', 1)").run();
  db.close();
  const dbBefore = createHash("sha1").update(readFileSync(dbPath)).digest("hex");
  const act = await readBrokerDb(dbPath, ["ab", "cd", "zz"]);
  assert(act.ab.last_activity === 2000, "last activity counts only <ns>-* channels (abc-* excluded)", JSON.stringify(act.ab));
  assert(act.ab.adopted && act.ab.manifest_registered && !act.cd.adopted && !act.cd.manifest_registered && act.zz.last_activity === null, "adoption and manifest state read per namespace");
  assert(createHash("sha1").update(readFileSync(dbPath)).digest("hex") === dbBefore, "broker DB opened read-only (unchanged)");
  const withDb = cli(["--all", "--db", dbPath, ...common]);
  assert(withDb.status === 0 && / ab .*headless adopted/.test(withDb.stdout) && /still connect without role=.*cd/.test(withDb.stdout), "--db feeds adoption into the rollout table", withDb.stderr);
} finally {
  rmSync(T, { recursive: true, force: true });
}

console.log(`\n${"─".repeat(50)}\n  passed: ${passed}   failed: ${failed}`);
if (failed) { console.error("  SOME TESTS FAILED"); process.exit(1); }
console.log("  ALL TESTS PASSED");
