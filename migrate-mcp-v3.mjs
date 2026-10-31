#!/usr/bin/env node
// Moves an existing project's interactive broker connection to v3 identity (docs/protocol-v3.md
// "v3 adoption for existing projects"). Dry-run by default: prints what it would change and writes
// nothing.
//
//   node migrate-mcp-v3.mjs --project <path> [--ns <ns>]       one project, dry run
//   node migrate-mcp-v3.mjs --all                              every project in the workers config
//   node migrate-mcp-v3.mjs --project <path> --apply           write the .mcp.json changes
//   node migrate-mcp-v3.mjs --project <path> --apply --with-guide   ... and the CLAUDE.md guide block
//
//   --workers <file>      workers config (default $WORKERS_CONFIG, else ./workers-all.json)
//   --db <broker.db>      read-only: adoption state, registered manifests and last activity per
//                         namespace, for the rollout order (--all)
//   --claude-json <file>  Claude Code's user config (default ~/.claude.json), read-only: user- and
//                         local-scope broker entries, which shadow .mcp.json
//   --guide <file>        guide block text (default docs/agent-guides/broker-v3.md)
//   --backup-dir <dir>    where --apply keeps the originals (default <this repo>/backups/mcp-v3, git-ignored)
//   --with-worktrees      also write .mcp.json files that resolve outside --project (worker worktrees)
//
// What it touches, per project (ns):
//   .mcp.json  at the project root (interactive orchestrator: role=orchestrator&ns=) and in every
//              worker / worktree dir of the namespace that already has one (that worker's
//              role=&ns=&as=). Only the broker entry's URL query changes; other servers, the
//              headers and any other query parameter are kept. A URL that already has role= is
//              left alone. --apply backs each file up to <backup dir>/<project>/<path>.pre-v3 first
//              (mode 600, dirs 700: the original holds the bearer), never next to the target, so a
//              backup cannot be committed in the target repo. A file whose real path is outside
//              --project (a worktree elsewhere) is reported and skipped unless --with-worktrees. A missing .mcp.json
//              is never created: the report prints the `claude mcp add -s local` command instead.
//   CLAUDE.md  at the project root: the v3 guide block (sync-agent-guide.js markers). Shown in the
//              diff; written only with --apply --with-guide.
// ~/.claude.json is read, never written. Every Authorization value, credential header and
// secret/token/password/api-key-named JSON key, and every token-like query value is masked in all
// output ("Bearer ***"); the secret is never printed.
//
// Headless watchdog sessions do not read .mcp.json (the watchdog passes its own --mcp-config); they
// switch to role= when their namespace is adopted (adopt_namespace) or listed in
// WATCHDOG_ROLE_NAMESPACES. The report says which namespaces still need that.

import { readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync, mkdtempSync, rmSync, mkdirSync, chmodSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { PROFILES } from "./lib/profiles.js";
import { applyBlock, START, END } from "./sync-agent-guide.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WATCHDOG = join(HERE, "watchdog.sh");
const DEFAULT_GUIDE = join(HERE, "docs", "agent-guides", "broker-v3.md");
// Under backups/, which this repo's .gitignore ignores.
export const DEFAULT_BACKUP_DIR = join(HERE, "backups", "mcp-v3");
// Projects with long-lived interactive sessions go last in the rollout (task constraint).
const LAST = ["mg", "tally"];

// ── secrets ──────────────────────────────────────────────────────────────────
// Masks every Authorization value whatever its scheme (Bearer, Basic, Token, raw), credential
// headers (X-Auth-Token, X-Orchestrator-Token, X-Admin-Token, X-Api-Key, Cookie), any JSON key or
// header named like a secret (/secret|token|password|api[_-]?key/), bearer tokens anywhere and
// token-like query values. A ${VAR} placeholder is not a secret and is kept, so the diff still shows
// a tracked file's placeholder.
const CRED_NAME = String.raw`(?:authorization|cookie|x-auth-token|x-orchestrator-token|x-admin-token|x-api-key|api-key|[\w-]*(?:secret|token|password|api[_-]?key)[\w-]*)`;
export function maskSecrets(text) {
  return String(text)
    // JSON: "<cred name>": "<value>" — keep a scheme word (Bearer/Basic/Token) so the diff stays readable.
    .replace(new RegExp(String.raw`("${CRED_NAME}"\s*:\s*")(?!(?:(?:Bearer|Basic|Token)\s+)?\$\{)((?:Bearer|Basic|Token)\s+)?[^"]*`, "gi"), (m, k, scheme = "") => `${k}${scheme}***`)
    // Header lines: --header "Authorization: Basic xyz", X-Auth-Token: abc
    .replace(new RegExp(String.raw`(\b${CRED_NAME}\s*:\s*)(?!(?:(?:Bearer|Basic|Token)\s+)?(?:\$\{|\*\*\*))((?:Bearer|Basic|Token)\s+)?(?=[^\s"'\\,}])[^\s"'\\,}]+`, "gi"), (m, k, scheme = "") => `${k}${scheme}***`)
    .replace(/(Bearer\s+)(?!\$\{)(?!\*\*\*)[^\s"'\\]+/gi, "$1***")
    .replace(/([?&](?:token|secret|key|api_?key|auth|password|pass|admin_token|access_token)=)[^&\s"'#]+/gi, "$1***");
}

// ── URL ──────────────────────────────────────────────────────────────────────
// The v3 URL for an identity: role, ns, as first (as omitted for interactive sessions), then any
// other parameter the existing URL carried. Returns { url, status, note }.
//   status: change | already-v3 | unparsable
export function migrateUrl(url, { role, ns, as }) {
  let u;
  try { u = new URL(url); } catch { return { url, status: "unparsable", note: `broker URL '${url}' is not a URL` }; }
  const has = u.searchParams.get("role");
  if (has) {
    const gotNs = u.searchParams.get("ns");
    const note = gotNs !== ns
      ? `already role=${has} but ns=${gotNs ?? "(none)"}, expected ${ns} — left alone, check it by hand`
      : has !== role ? `already role=${has} (this plan would use role=${role}) — left alone` : undefined;
    return { url, status: "already-v3", note };
  }
  const q = new URLSearchParams();
  q.set("role", role);
  q.set("ns", ns);
  if (as) q.set("as", as);
  for (const [k, v] of u.searchParams) if (!["role", "ns", "as"].includes(k)) q.append(k, v);
  u.search = q.toString();
  return { url: u.toString(), status: "change" };
}

// New .mcp.json text with only the broker URL replaced. Edits the URL string in place when it
// occurs exactly once, so the file's formatting and key order survive; otherwise re-serializes.
function replaceUrl(text, cfg, oldUrl, newUrl) {
  const lit = JSON.stringify(oldUrl);
  if (text.split(lit).length === 2) {
    const next = text.replace(lit, () => JSON.stringify(newUrl));
    try { if (JSON.parse(next).mcpServers.broker.url === newUrl) return next; } catch { /* fall through */ }
  }
  const copy = structuredClone(cfg);
  copy.mcpServers.broker.url = newUrl;
  return JSON.stringify(copy, null, 2) + "\n";
}

// ── Claude Code scopes ───────────────────────────────────────────────────────
// Claude Code resolves a server name local scope > project (.mcp.json) > user scope.
export function readClaudeJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}
function scopes(claudeJson, dir) {
  return {
    local: claudeJson?.projects?.[dir]?.mcpServers?.broker ?? null,
    user: claudeJson?.mcpServers?.broker ?? null,
  };
}

// ── planning ─────────────────────────────────────────────────────────────────
// One .mcp.json. Returns { path, dir, identity, status, before, after, note, effective }.
//   status: change | already-v3 | missing | no-broker | invalid-json | unparsable
export function planMcpFile(dir, identity, { claudeJson = null } = {}) {
  const path = join(dir, ".mcp.json");
  const sc = scopes(claudeJson, dir);
  const plan = { path, dir, identity, effective: null };
  if (!existsSync(path)) {
    plan.status = "missing";
  } else {
    const before = readFileSync(path, "utf8");
    plan.before = before;
    let cfg;
    try { cfg = JSON.parse(before); } catch (e) { return { ...plan, status: "invalid-json", note: e.message, effective: effective(sc, null) }; }
    const b = cfg?.mcpServers?.broker;
    if (!b || typeof b.url !== "string") {
      plan.status = "no-broker";
    } else {
      const m = migrateUrl(b.url, identity);
      plan.status = m.status;
      plan.note = m.note;
      plan.url = { before: b.url, after: m.url };
      plan.placeholder = /\$\{/.test(b.headers?.Authorization ?? "");
      if (m.status === "change") plan.after = replaceUrl(before, cfg, b.url, m.url);
    }
  }
  plan.effective = effective(sc, plan.url?.before ?? null);
  if (plan.status === "missing" && !sc.local) {
    plan.command = `claude mcp add -s local --transport http broker "${migrateUrl(sc.user?.url ?? "http://localhost:8080/mcp", identity).url}" --header "Authorization: Bearer ***"   # run in ${dir}`;
  }
  if (sc.local && migrateUrl(sc.local.url ?? "", identity).status === "change") {
    plan.command = `claude mcp remove -s local broker && claude mcp add -s local --transport http broker "${migrateUrl(sc.local.url, identity).url}" --header "Authorization: Bearer ***"   # run in ${dir}`;
  }
  return plan;
}

function effective(sc, projectUrl) {
  if (sc.local) return { scope: "local", url: sc.local.url, shadows_mcp_json: projectUrl !== null };
  if (projectUrl) return { scope: "project", url: projectUrl };
  if (sc.user) return { scope: "user", url: sc.user.url };
  return { scope: "none", url: null };
}

// The project-root CLAUDE.md guide block. { path, status, before, after, note }
//   status: change | up-to-date | create | malformed
export function planGuide(project, guide) {
  const path = join(project, "CLAUDE.md");
  const existed = existsSync(path);
  const before = existed ? readFileSync(path, "utf8") : "";
  try {
    const after = applyBlock(before, guide);
    return { path, before, after, status: !existed ? "create" : after === before ? "up-to-date" : "change" };
  } catch (e) {
    return { path, before, status: "malformed", note: e.message };
  }
}

// Every tool the broker registers (lib/tools/*.js), for the role-file scan.
export function allTools(root = HERE) {
  const dir = join(root, "lib", "tools");
  const names = new Set();
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".js"))) {
    for (const m of readFileSync(join(dir, f), "utf8").matchAll(/registerTool\(\s*"([a-z_]+)"/g)) names.add(m[1]);
  }
  return [...names].sort();
}

// Tools a role file mentions that the role's profile lacks: once the session has role=, those
// calls return "not available to role". admin (null profile) sees everything.
// The v3 guide block itself is skipped: it names out-of-profile tools only to say they are missing.
export function toolsOutsideProfile(text, role, tools) {
  const profile = PROFILES[role];
  if (!profile) return [];
  const s = text.indexOf(START), e = text.indexOf(END);
  if (s >= 0 && e > s) text = text.slice(0, s) + text.slice(e + END.length);
  return tools.filter((t) => !profile.includes(t) && new RegExp(`\\b${t}\\b`).test(text));
}

// The watchdog's own identity derivation (--print-channels): role, as, inbox. Same call
// lib/adoption.js makes, so the identities here cannot drift from what the watchdog does.
// The child env is scrubbed of WATCHDOG_* / BROKER_* so a watchdog-launched caller's own identity
// cannot leak into it.
export function deriveIdentity(entry, { watchdog = WATCHDOG } = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(WATCHDOG_|BROKER_)/.test(k)));
  env.WATCHDOG_NAMESPACE = entry.ns;
  env.WATCHDOG_NS_ADOPTED = "1";
  const r = spawnSync(watchdog, [...(entry.args || []), "--print-channels"], { env, encoding: "utf8", timeout: 5000 });
  const out = Object.fromEntries((r.stdout || "").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  if (r.status !== 0 || !out.role) throw new Error(((r.stderr || "").trim() || `exit ${r.status}`).split("\n")[0]);
  return { role: out.role, as: out.as, inbox: out.inbox };
}

const argOf = (args, flag) => { const i = (args || []).indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
export function entryDirs(entry, fallbackRoot) {
  const repoRoot = argOf(entry.args, "--repo-root") ?? fallbackRoot;
  const workDir = argOf(entry.args, "--work-dir") ?? (repoRoot ? join(repoRoot, entry.args?.[0] ?? entry.name) : null);
  return { repoRoot, workDir };
}

// Project root of a namespace: the repo roots its entries name, preferring a main checkout
// (.git is a directory, not a worktree's .git file), then the shortest path.
export function projectRootOf(entries) {
  const roots = [...new Set(entries.map((e) => argOf(e.args, "--repo-root")).filter(Boolean))];
  const main = roots.filter((r) => { try { return readdirSync(join(r, ".git")) && true; } catch { return false; } });
  const pick = (main.length ? main : roots).sort((a, b) => a.length - b.length || a.localeCompare(b));
  return pick[0] ?? null;
}

// Whether path (resolved through symlinks, as far as it exists) lies under root.
const real = (p) => {
  p = resolve(p);
  try { return realpathSync(p); } catch { return dirname(p) === p ? p : join(real(dirname(p)), p.slice(dirname(p).length).replace(/^\/+/, "")); }
};
export function isInside(root, path) {
  const rel = relative(real(root), real(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// Where --apply keeps the original of target: <backupDir>/<project slug>/<path under project>.pre-v3
// (a target outside the project keeps its absolute path under _outside/).
export function backupPath(project, target, backupDir = DEFAULT_BACKUP_DIR) {
  const slug = resolve(project).replace(/^\/+/, "").replace(/[\/\\:]+/g, "_");
  const rel = relative(resolve(project), resolve(target));
  const sub = !rel.startsWith("..") && !isAbsolute(rel) ? rel : join("_outside", resolve(target).replace(/^\/+/, ""));
  return join(backupDir, slug, `${sub}.pre-v3`);
}
function backup(project, target, backupDir) {
  const dest = backupPath(project, target, backupDir);
  if (existsSync(dest)) return;
  // The original carries the bearer: directories 700, file 600.
  let d = dirname(dest);
  const made = [];
  while (!existsSync(d)) { made.unshift(d); d = dirname(d); }
  for (const m of made) { mkdirSync(m, { mode: 0o700 }); chmodSync(m, 0o700); }
  copyFileSync(target, dest);
  chmodSync(dest, 0o600);
}

// The whole plan for one project. Pure read.
export function planProject({ project, ns, entries, guide, claudeJson = null, tools = allTools(), derive = deriveIdentity }) {
  project = resolve(project);
  const identities = [], underivable = [];
  for (const e of entries) {
    const { repoRoot, workDir } = entryDirs(e, project);
    try { identities.push({ name: e.name, ...derive(e), repoRoot, workDir }); }
    catch (err) { underivable.push({ name: e.name, error: err.message }); }
  }
  // Which identity a directory's .mcp.json should carry: the project root is the interactive
  // orchestrator's (no as=); a dir serving exactly one entry carries that entry's identity.
  const dirs = new Map([[project, { role: "orchestrator", ns }]]);
  for (const id of identities) {
    for (const d of [id.workDir, id.repoRoot]) {
      if (!d || d === project) continue;
      const users = identities.filter((x) => x.workDir === d || x.repoRoot === d);
      const keys = new Set(users.map((x) => `${x.role}/${x.as}`));
      dirs.set(d, keys.size === 1 ? { role: users[0].role, ns, as: users[0].as } : { role: "orchestrator", ns });
    }
  }
  const mcp = [];
  for (const [dir, identity] of dirs) {
    const p = planMcpFile(dir, identity, { claudeJson });
    if (dir === project || p.status !== "missing") mcp.push({ ...p, headless: dir !== project, outside: !isInside(project, p.path) });
  }
  // Role files (CLAUDE.md / CLAUDE.local.md in each worker dir, plus the project root for the
  // interactive orchestrator) that mention tools outside the role's profile.
  const outside = [];
  const scan = (file, role, who) => {
    if (!existsSync(file)) return;
    const hits = toolsOutsideProfile(readFileSync(file, "utf8"), role, tools);
    if (hits.length) outside.push({ file, role, who, tools: hits });
  };
  for (const f of ["CLAUDE.md", "CLAUDE.local.md"]) scan(join(project, f), "orchestrator", "interactive orchestrator");
  const seen = new Set([project]);
  for (const id of identities) {
    if (!id.workDir || seen.has(id.workDir)) continue;
    seen.add(id.workDir);
    for (const f of ["CLAUDE.md", "CLAUDE.local.md"]) scan(join(id.workDir, f), id.role, id.name);
  }
  return {
    project, ns, entries: entries.length, identities, underivable, mcp,
    guide: guide === undefined ? null : planGuide(project, guide),
    outside_profile: outside,
  };
}

// ── output ───────────────────────────────────────────────────────────────────
export function unifiedDiff(file, before, after) {
  const dir = mkdtempSync(join(tmpdir(), "mcp-v3-"));
  try {
    writeFileSync(join(dir, "a"), before ?? "");
    writeFileSync(join(dir, "b"), after ?? "");
    const label = file.replace(/^\/+/, "");
    const r = spawnSync("diff", ["-u", "--label", `a/${label}`, "--label", `b/${label}`, join(dir, "a"), join(dir, "b")], { encoding: "utf8" });
    return maskSecrets(r.stdout);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// The human-readable report for one project; every line goes through maskSecrets.
export function renderProject(plan, { roleNamespaces = [], adoption = null } = {}) {
  const L = [];
  L.push(`=== ${plan.ns}  ${plan.project}  (${plan.entries} workers-config entries)`);
  for (const m of plan.mcp) {
    const who = m.identity.as ? `${m.identity.role}/${m.identity.as}` : `${m.identity.role} (interactive)`;
    const eff = m.effective;
    const effTxt = eff.scope === "none" ? "no broker entry in any scope"
      : `effective: ${eff.scope} scope ${eff.url}${eff.shadows_mcp_json ? " — shadows .mcp.json, so editing it changes nothing for sessions here" : ""}`;
    L.push(`-- ${m.path}  [${m.status}]  ${who}${m.headless ? "  (headless sessions ignore it: watchdog --mcp-config)" : ""}`);
    L.push(`   ${effTxt}`);
    if (m.note) L.push(`   note: ${m.note}`);
    if (m.placeholder) L.push("   Authorization is a ${…} placeholder (tracked file) — kept as is");
    if (m.outside) L.push("   outside --project (resolves elsewhere): --apply skips it unless --with-worktrees");
    if (m.status === "change") L.push(unifiedDiff(m.path, m.before, m.after).trimEnd());
    if (m.command) L.push(`   not written by --apply (Claude Code's own config is never edited) — run: ${m.command}`);
  }
  if (plan.guide) {
    const g = plan.guide;
    L.push(`-- ${g.path}  [guide block: ${g.status}]  written only with --apply --with-guide`);
    if (g.note) L.push(`   ${g.note}`);
    if (g.status === "change" || g.status === "create") L.push(unifiedDiff(g.path, g.before, g.after).trimEnd());
  }
  if (plan.underivable.length) {
    L.push(`-- underivable entries (watchdog --print-channels failed): ${plan.underivable.map((u) => `${u.name}: ${u.error}`).join("; ")}`);
  }
  if (plan.outside_profile.length) {
    L.push("-- role files that mention tools outside their role= profile (calls fail with \"not available to role\" once role= is on):");
    for (const o of plan.outside_profile) L.push(`   ${o.who} [${o.role}] ${o.file}: ${o.tools.join(", ")}`);
  } else {
    L.push("-- role files: no tool outside the role profiles is mentioned");
  }
  const headless = adoption?.adopted ? `adopted (adopt_namespace) — headless sessions already get role=`
    : roleNamespaces.includes(plan.ns) ? "in WATCHDOG_ROLE_NAMESPACES — headless sessions already get role="
    : `NOT adopted — headless sessions stay v2 until adopt_namespace(${plan.ns}) (or WATCHDOG_ROLE_NAMESPACES) + restart of its workers`;
  L.push(`-- headless: ${headless}`);
  return maskSecrets(L.join("\n"));
}

// Write the planned changes. .mcp.json always; the guide block only with withGuide. A file outside the
// project is written only with withWorktrees (skippedOutside lists the ones left alone). Originals go
// to backupDir, never next to the target.
export const skippedOutside = (plan, { withWorktrees = false } = {}) =>
  withWorktrees ? [] : plan.mcp.filter((m) => m.status === "change" && m.outside).map((m) => m.path);
export function applyPlan(plan, { withGuide = false, withWorktrees = false, backupDir = DEFAULT_BACKUP_DIR } = {}) {
  const done = [];
  for (const m of plan.mcp.filter((m) => m.status === "change" && (withWorktrees || !m.outside))) {
    backup(plan.project, m.path, backupDir);
    writeFileSync(m.path, m.after, "utf8");
    done.push(m.path);
  }
  if (withGuide && plan.guide && (plan.guide.status === "change" || plan.guide.status === "create")) {
    if (existsSync(plan.guide.path)) backup(plan.project, plan.guide.path, backupDir);
    writeFileSync(plan.guide.path, plan.guide.after, "utf8");
    done.push(plan.guide.path);
  }
  return done;
}

// ── broker DB (read-only) ────────────────────────────────────────────────────
export async function readBrokerDb(path, namespaces) {
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const out = {};
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
    for (const ns of namespaces) {
      // '.' sorts right after '-', so [ns-, ns.) is exactly the channels named ns-*; MAX(id) uses the index.
      const last = db.prepare("SELECT MAX(id) AS id FROM messages WHERE channel >= ? AND channel < ?").get(`${ns}-`, `${ns}.`).id;
      const at = last ? db.prepare("SELECT created_at FROM messages WHERE id = ?").get(last).created_at : null;
      const ad = tables.has("namespace_adoption") ? db.prepare("SELECT adopted, adopted_at FROM namespace_adoption WHERE ns = ?").get(ns) : null;
      const man = tables.has("namespaces") ? db.prepare("SELECT version FROM namespaces WHERE ns = ?").get(ns) : null;
      out[ns] = { last_activity: at, adopted: !!ad?.adopted, manifest_registered: !!man };
    }
    return out;
  } finally { db.close(); }
}

// Idle first (oldest last activity), mg and tally last whatever their activity.
export function rolloutOrder(namespaces, activity = {}) {
  const t = (ns) => activity[ns]?.last_activity ?? 0;
  const rest = namespaces.filter((n) => !LAST.includes(n)).sort((a, b) => t(a) - t(b) || a.localeCompare(b));
  return [...rest, ...LAST.filter((n) => namespaces.includes(n))];
}

// ── CLI ──────────────────────────────────────────────────────────────────────
async function main(argv) {
  const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const has = (n) => argv.includes(n);
  const apply = has("--apply"), withGuide = has("--with-guide"), all = has("--all"), withWorktrees = has("--with-worktrees");
  const backupDir = resolve(flag("--backup-dir") ?? DEFAULT_BACKUP_DIR);
  const project = flag("--project");
  if (!project && !all) {
    console.error("usage: node migrate-mcp-v3.mjs (--project <path> [--ns <ns>] | --all) [--apply [--with-guide] [--with-worktrees] [--backup-dir <dir>]] [--workers <file>] [--db <broker.db>] [--claude-json <file>] [--guide <file>]");
    return 2;
  }
  if (all && apply) { console.error("--apply takes one --project at a time (rollout is per project)"); return 2; }
  if (withGuide && !apply) { console.error("--with-guide only means something with --apply (the dry run always shows the guide diff)"); return 2; }
  const workersPath = flag("--workers") ?? process.env.WORKERS_CONFIG ?? join(process.cwd(), "workers-all.json");
  let workers = [];
  if (existsSync(workersPath)) {
    try { workers = JSON.parse(readFileSync(workersPath, "utf8")).filter((e) => e && e.name && e.ns); }
    catch (e) { console.error(`workers config ${workersPath}: ${e.message}`); return 2; }
  } else if (all || !flag("--ns")) {
    console.error(`workers config not found: ${workersPath} (pass --workers, or --project with --ns)`); return 2;
  }
  const guidePath = flag("--guide") ?? DEFAULT_GUIDE;
  const guide = readFileSync(guidePath, "utf8");
  const claudeJson = readClaudeJson(flag("--claude-json") ?? join(homedir(), ".claude.json"));
  const roleNamespaces = (process.env.WATCHDOG_ROLE_NAMESPACES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const tools = allTools();

  const byNs = new Map();
  for (const e of workers) byNs.set(e.ns, [...(byNs.get(e.ns) ?? []), e]);
  let targets;
  if (all) {
    targets = [...byNs].map(([ns, entries]) => ({ ns, entries, project: projectRootOf(entries) }));
  } else {
    const p = resolve(project);
    let ns = flag("--ns");
    if (!ns) {
      const owners = [...byNs].filter(([, es]) => es.some((e) => { const { repoRoot, workDir } = entryDirs(e, null); return repoRoot === p || workDir?.startsWith(p + "/"); }));
      if (owners.length !== 1) { console.error(`cannot tell the namespace of ${p} from ${workersPath} (${owners.length ? owners.map(([n]) => n).join(", ") : "no entry"}) — pass --ns`); return 2; }
      ns = owners[0][0];
    }
    targets = [{ ns, entries: byNs.get(ns) ?? [], project: p }];
  }

  const dbPath = flag("--db");
  const activity = dbPath ? await readBrokerDb(dbPath, targets.map((t) => t.ns)) : {};
  const out = [];
  out.push(maskSecrets(`# migrate-mcp-v3 ${apply ? "APPLY" : "dry run"} — ${new Date().toISOString()}`));
  out.push(`# workers config: ${workersPath}; claude config: ${claudeJson ? "read" : "not found"}; broker db: ${dbPath ?? "not given"}`);
  const summary = [];
  for (const t of targets) {
    if (!t.project || !existsSync(t.project)) {
      out.push(`=== ${t.ns}  ${t.project ?? "(no --repo-root in any entry)"}  — project dir unreadable, skipped`);
      summary.push({ ns: t.ns, project: t.project, unreadable: true });
      continue;
    }
    const plan = planProject({ project: t.project, ns: t.ns, entries: t.entries, guide, claudeJson, tools });
    out.push(renderProject(plan, { roleNamespaces, adoption: activity[t.ns] }));
    if (apply) {
      out.push(`-- applied: ${applyPlan(plan, { withGuide, withWorktrees, backupDir }).join(", ") || "nothing to change"} (originals under ${backupDir})`);
      const skipped = skippedOutside(plan, { withWorktrees });
      if (skipped.length) out.push(`-- skipped (outside --project; pass --with-worktrees): ${skipped.join(", ")}`);
    }
    summary.push({ ns: t.ns, project: t.project, plan });
  }

  if (all) {
    const order = rolloutOrder(summary.map((s) => s.ns), activity);
    out.push("", "=== Rollout order (idle first; mg and tally last)");
    order.forEach((ns, i) => {
      const s = summary.find((x) => x.ns === ns);
      const a = activity[ns];
      const changes = s.plan ? s.plan.mcp.filter((m) => m.status === "change").length : 0;
      const shadowed = s.plan?.mcp.find((m) => !m.headless)?.effective;
      const outsideN = s.plan ? new Set(s.plan.outside_profile.flatMap((o) => o.tools)).size : 0;
      out.push(`${String(i + 1).padStart(2)}. ${ns.padEnd(6)} last activity ${a?.last_activity ? new Date(a.last_activity).toISOString() : "unknown"}; `
        + `.mcp.json changes ${changes}; interactive ${shadowed ? `${shadowed.scope}${shadowed.url && new URL(shadowed.url).searchParams.get("role") ? " (already role=)" : " (v2)"}` : "n/a"}; `
        + `tools outside profile ${outsideN}; manifest ${a ? (a.manifest_registered ? "registered" : "NOT registered") : existsSync(join(HERE, "schemas", "manifests", `${ns}.json`)) ? "file present" : "NO FILE"}; `
        + `headless ${a?.adopted ? "adopted" : roleNamespaces.includes(ns) ? "WATCHDOG_ROLE_NAMESPACES" : "needs adopt_namespace"}`);
    });
    const need = order.filter((ns) => !activity[ns]?.adopted && !roleNamespaces.includes(ns));
    out.push("", `=== Namespaces whose headless sessions still connect without role= (adopt_namespace, or add to WATCHDOG_ROLE_NAMESPACES): ${need.join(", ") || "none"}`);
  }
  console.log(maskSecrets(out.join("\n")));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // exitCode, not exit(): exit() drops whatever of a large report a pipe has not drained yet.
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(maskSecrets(`migrate-mcp-v3: ${e.message}`)); process.exitCode = 1; });
}
