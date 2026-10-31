#!/usr/bin/env node
/**
 * claude-broker setup wizard.
 *
 *   npm run setup                         # interactive
 *   node setup.js --project /path/to/repo # point at the customer's project
 *   node setup.js --yes --project ...      # non-interactive (CI / scripted)
 *
 * What it does:
 *   1. Scans the target project for its components (backend, frontend, ...).
 *   2. Derives a namespace prefix and a channel layout.
 *   3. Generates a strong SHARED_SECRET and writes .env (preserving an existing secret).
 *   4. Writes workers.json describing the components.
 *   5. If the broker is already running, registers starter schemas on the channels.
 *   6. Prints the exact `claude mcp add` command to connect each session.
 *
 * Flags: --project <path>  --ns <prefix>  --port <n>  --no-schemas  --strict  --yes/-y
 *        --scaffold-roles  --install-roles  --isolate  --multi-repo  --worktree-base <path>
 *        --no-reviewer  --no-tmux  --tmux-session <name>  --mcp-settings / --no-mcp-settings
 *        --hooks / --no-hooks (orchestrator scope-guard hooks; worktree modes only)
 *        --no-role-append (leave existing CLAUDE.md files untouched instead of appending the role)
 *        --model <id> (per-worker model stamped into workers.json)
 *        --patrol <name[:interval[:watch-channel]]> (repeatable; autonomous patrol workers)
 *        --clusters "<cluster>:<comp>+<comp>[;<cluster>:...]" (cluster-orchestrator tier)
 *        --judge full|hold (judge worker: answers blocked questions from the record, or hold-only)
 *        --retro (weekly retro worker: compacts <ns>-notes into the knowledge file)
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, realpathSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { basename, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// Installed from npm (node_modules/@anisthesia/claude-broker) vs. run from a source checkout —
// the commands we print back to the operator differ.
const FROM_PACKAGE = SCRIPT_DIR.split("/").includes("node_modules");
const START_CMD = FROM_PACKAGE ? "npx claude-broker" : "npm start";
const SETUP_CMD = FROM_PACKAGE ? "npx claude-broker-setup" : "npm run setup";
// The retro's compacted team knowledge (retro/README.md): docs/knowledge/<ns>.md in this repo.
const KNOWLEDGE_DIR = process.env.BROKER_KNOWLEDGE_DIR || join(SCRIPT_DIR, "docs", "knowledge");
const OUT_DIR = process.cwd(); // where .env / workers.json are written

// ── arg parsing ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const has = (...names) => names.some((n) => argv.includes(n));
const opts = {
  project: flag("--project"),
  ns: flag("--ns"),
  port: flag("--port"),
  schemas: !has("--no-schemas"),
  strictSchemas: has("--strict"),
  scaffoldRoles: has("--scaffold-roles"),
  installRoles: has("--install-roles"),
  isolate: has("--isolate"),
  multiRepo: has("--multi-repo"),
  worktreeBase: flag("--worktree-base"),
  model: flag("--model"),
  patrol: argv.flatMap((a, i) => (a === "--patrol" && argv[i + 1] ? [argv[i + 1]] : [])),
  clusters: flag("--clusters"),
  judge: has("--judge") ? flag("--judge") || "" : null,
  retro: has("--retro"),
  rolesDir: flag("--roles-dir") || "roles",
  reviewer: !has("--no-reviewer"),
  tmux: !has("--no-tmux"),
  tmuxSession: flag("--tmux-session"),
  mcpSettings: has("--mcp-settings") ? true : has("--no-mcp-settings") ? false : null,
  hooks: has("--hooks") ? true : has("--no-hooks") ? false : null,
  roleAppend: !has("--no-role-append"),
  yes: has("--yes", "-y"),
};
const interactive = !opts.yes && process.stdin.isTTY;

const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
const ask = async (q, def) => {
  if (!interactive) return def ?? "";
  const a = (await rl.question(`  ${q}${def !== undefined && def !== "" ? ` [${def}]` : ""}: `)).trim();
  return a || def || "";
};
const askYesNo = async (q, def = true) => {
  if (!interactive) return def;
  const a = (await rl.question(`  ${q} (${def ? "Y/n" : "y/N"}): `)).trim().toLowerCase();
  return a === "" ? def : a.startsWith("y");
};

const c = { dim: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m` };
const line = (s = "") => console.log(s);

// ── component detection ──────────────────────────────────────────────────────
const IGNORE = new Set([
  "node_modules", ".git", ".venv", "venv", "dist", "build", "__pycache__", ".next",
  "target", "vendor", ".github", "docs", "doc", "scripts", "script", "tests", "test",
  ".idea", ".vscode", "coverage", "tmp", "temp", ".pytest_cache", ".ruff_cache",
  "migrations", "alembic", "public", "static", "assets", ".turbo", "bin",
]);
const MARKERS = [
  "package.json", "requirements.txt", "pyproject.toml", "go.mod", "Cargo.toml",
  "pom.xml", "build.gradle", "Gemfile", "composer.json", "Dockerfile", "tsconfig.json",
];
const KNOWN = new Set(["backend", "frontend", "api", "web", "server", "client", "worker", "mobile", "app", "services", "service", "gateway", "admin", "dashboard"]);

function detectComponents(projectPath) {
  let entries;
  try { entries = readdirSync(projectPath); } catch { return []; }
  const comps = [];
  for (const name of entries) {
    if (name.startsWith(".") || IGNORE.has(name)) continue;
    let s; try { s = statSync(join(projectPath, name)); } catch { continue; }
    if (!s.isDirectory()) continue;
    let files = [];
    try { files = readdirSync(join(projectPath, name)); } catch { /* unreadable */ }
    const looksLikeComponent = KNOWN.has(name.toLowerCase()) || MARKERS.some((m) => files.includes(m));
    if (looksLikeComponent) comps.push(name);
  }
  return comps;
}

// Multi-repo (polyrepo): each immediate subdirectory that is its own git repo is a worker.
function detectRepos(dir) {
  let entries; try { entries = readdirSync(dir); } catch { return []; }
  const repos = [];
  for (const name of entries) {
    if (name.startsWith(".") || IGNORE.has(name)) continue;
    const p = join(dir, name);
    let s; try { s = statSync(p); } catch { continue; }
    if (s.isDirectory() && existsSync(join(p, ".git"))) repos.push(name);
  }
  return repos;
}

const git = (cwd, ...args) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

// Locate tmux so start_worker can launch each watchdog in a named tmux window
// (tmux mode also auto-injects BROKER_SECRET into the watchdog environment).
function findTmux() {
  const r = spawnSync("which", ["tmux"], { encoding: "utf8" });
  const p = (r.stdout || "").split("\n")[0].trim();
  return r.status === 0 && p ? p : null;
}

// Give one repo an isolated worktree on branch worker/<name>, and exclude the per-worker
// root CLAUDE.md from commits. Used in multi-repo mode (one worker per repo).
function createRepoWorktree(repoPath, name, wtPath) {
  const branch = `worker/${name}`;
  if (git(repoPath, "rev-parse", "HEAD").status !== 0) return { name, status: "skipped — repo has no commits" };
  const listed = (git(repoPath, "worktree", "list", "--porcelain").stdout || "").split("\n");
  if (listed.includes(`worktree ${wtPath}`)) { ensureExclude(repoPath); return { name, status: "exists", wtPath, branch }; }
  if (existsSync(wtPath)) return { name, status: "skipped — path exists (not a worktree)" };
  const hasBranch = git(repoPath, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`).status === 0;
  const base = (git(repoPath, "branch", "--show-current").stdout || "").trim() || "HEAD";
  const r = hasBranch
    ? git(repoPath, "worktree", "add", wtPath, branch)
    : git(repoPath, "worktree", "add", "-b", branch, wtPath, base);
  if (r.status !== 0) return { name, status: `failed: ${(r.stderr || "").trim().slice(0, 80)}` };
  ensureExclude(repoPath);
  return { name, status: "created", wtPath, branch, base };
}

function ensureExclude(repoPath) {
  let common = (git(repoPath, "rev-parse", "--git-common-dir").stdout || "").trim();
  if (!common) return;
  if (!common.startsWith("/")) common = join(repoPath, common);
  const ex = join(common, "info", "exclude");
  try {
    mkdirSync(dirname(ex), { recursive: true });
    let cur = existsSync(ex) ? readFileSync(ex, "utf8") : "";
    const lines = cur.split("\n");
    const missing = ["/CLAUDE.md", "/CLAUDE.local.md"].filter((l) => !lines.includes(l));
    if (missing.length) {
      writeFileSync(ex, cur + "\n# claude-broker: per-worker role file — never commit\n" + missing.join("\n") + "\n");
    }
  } catch { /* best effort */ }
}

// Where a role goes inside a session dir. If the dir already has a CLAUDE.md that git tracks
// (a committed project CLAUDE.md shows up in every worktree), appending the role there would
// dirty the checkout and get committed by the worker's `git add -A`. Claude Code also loads
// CLAUDE.local.md alongside CLAUDE.md, so the role goes there instead and stays untracked.
function roleDestFile(destDir) {
  const claudeMd = join(destDir, "CLAUDE.md");
  if (!existsSync(claudeMd)) return claudeMd;
  const tracked = git(destDir, "ls-files", "--error-unmatch", "CLAUDE.md").status === 0;
  return tracked ? join(destDir, "CLAUDE.local.md") : claudeMd;
}

const sanitizeName = (n) => n.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 64) || "app";
function deriveNs(projectPath) {
  const base = basename(projectPath).toLowerCase();
  const parts = base.split(/[-_ ]+/).filter(Boolean);
  const initials = parts.length > 1 ? parts.map((p) => p[0]).join("").slice(0, 4) : base.replace(/[^a-z0-9]/g, "").slice(0, 3);
  return (initials || "app").replace(/[^a-z0-9]/g, "");
}

// ── existing .env secret preservation ────────────────────────────────────────
function existingSecret() {
  const p = join(OUT_DIR, ".env");
  if (!existsSync(p)) return null;
  const m = readFileSync(p, "utf8").match(/^SHARED_SECRET=(.+)$/m);
  return m && m[1].trim() && m[1].trim() !== "change-me-to-a-long-random-string" ? m[1].trim() : null;
}

// ── schema registration (only if broker is reachable) ────────────────────────
async function registerSchemas({ port, secret, ns, components, reviewer, strict, patrols = [], clusters = null, judge = null, retro = false }) {
  const url = `http://localhost:${port}`;
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) throw new Error("health not ok");
  } catch {
    return { ran: false, reason: `broker not reachable at ${url}` };
  }
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "setup-wizard", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${secret}` } } }));
  const read = (f) => readFileSync(join(SCRIPT_DIR, "schemas", f), "utf8");
  const plan = [
    [`${ns}-status`, "status.json"],
    [`${ns}-telemetry`, "telemetry.json"],
    [`${ns}-control`, "control.json"],
    [`${ns}-backlog`, "backlog.json"],
    [`${ns}-sprint-retrospective`, "backlog.json"],
    [`${ns}-notes`, "notes.json"],
    ...components.map((comp) => [`${ns}-${comp}`, "worker-inbox.json"]),
    ...patrols.map((p) => [`${ns}-${p.name}`, "worker-inbox.json"]),
    ...(judge ? [[`${ns}-judge`, "worker-inbox.json"]] : []),
    ...(retro ? [[`${ns}-retro`, "worker-inbox.json"]] : []),
    ...(clusters || []).flatMap((cl) => [
      [`${ns}-${cl.name}-orch`, "worker-inbox.json"],
      [`${ns}-${cl.name}-status`, "cluster-status.json"],
    ]),
    ...(reviewer ? [[`${ns}-reviewer`, "reviewer-inbox.json"]] : []),
  ];
  const done = [];
  for (const [channel, file] of plan) {
    const res = await client.callTool({ name: "register_channel_schema", arguments: { channel, schema: read(file), strict: !!strict, version: "1.0" } });
    done.push({ channel, file, ok: !res.isError });
  }
  await client.close();
  return { ran: true, done, strict: !!strict };
}

// ── broker v3 identity + guide ───────────────────────────────────────────────
// The session's MCP URL carries its identity (docs/protocol-v3.md "Role profiles"): role= picks the
// tool profile (lib/profiles.js), ns= and as= default the typed tools' namespace and sender. An
// interactive session gets no as= (one .mcp.json serves every session opened in the repo).
// Query parameters other than role/ns/as on an existing URL are kept.
function brokerMcpUrl(port, { role, ns, as } = {}, existingUrl = null) {
  const q = new URLSearchParams();
  if (role) q.set("role", role);
  if (ns) q.set("ns", ns);
  if (as) q.set("as", as);
  try {
    for (const [k, v] of new URL(existingUrl).searchParams) if (!["role", "ns", "as"].includes(k)) q.append(k, v);
  } catch { /* no or unparsable existing URL */ }
  const s = q.toString();
  return `http://localhost:${port}/mcp${s ? `?${s}` : ""}`;
}

// The v3 section of a role file: typed tools first, send_message as the fallback (a namespace with
// no manifest, or a session connected without role=, has no typed tools). Every tool named here is
// in the role's profile (lib/profiles.js; test-setup-broker.js checks it).
//   kind: worker | reviewer | patrol | orchestrator | cluster-orch
function v3Guide({ kind, ns, port, me, status }) {
  const role = kind === "reviewer" ? "reviewer" : kind === "orchestrator" || kind === "cluster-orch" ? "orchestrator" : "worker";
  const interactive = kind === "orchestrator";
  const url = brokerMcpUrl(port, { role, ns, as: interactive ? undefined : me });
  const offStatus = status && status !== `${ns}-status`;
  const connect = interactive
    ? `This session connects as \`${url}\` (the project's \`.mcp.json\`): you see the orchestrator tools,
and \`ns\` defaults to \`${ns}\` but \`sender\` does not — the URL serves every session opened here, so
pass \`sender="${me}"\` on every write and \`worker="${me}"\` on every read.`
    : `Your watchdog connects you as \`${url}\` once an admin adopts namespace
\`${ns}\` (or lists it in \`WATCHDOG_ROLE_NAMESPACES\`): you then see the ${role} tools only, and \`ns\` and
\`sender\` default from the URL. Until then you have the v2 tools and use the fallback below.`;
  const lines = {
    worker: [
      offStatus
        ? `- Results and questions: \`post_result\` and \`ask\` post to \`${ns}-status\`, but yours belong on \`${status}\` —
  keep \`send_message\` for both.`
        : `- Report: \`post_result(task_id, summary="PASS — …", affected_files=[…], body={"required_checks": {…}, "commits": [{…}]})\` —
  fills type/from/to and the task's subject and rejects a bad envelope before it lands. \`affected_files\`
  is required when \`body.commits\` is non-empty.`,
      ...(offStatus ? [] : [`- Blocked: \`ask(task_id, question)\` — the task shows blocked until the answer reaches your inbox.`]),
      `- Learned something: \`post_note(kind="finding", subject, summary, scope=[…], evidence, confidence="confirmed")\`.`,
    ],
    patrol: [
      `- Patrol result: \`post_result(task_id="${me}-patrol-<YYYY-MM-DD-HHmm>", subject="${me} patrol", summary="PASS — …", body={"findings": […]})\`
  (\`subject\` is required: a patrol pass has no dispatched task to copy it from).`,
      `- Learned something: \`post_note(kind="finding", subject, summary, scope=[…], evidence, confidence="confirmed")\`.`,
    ],
    reviewer: [
      `- Verdict: \`post_result(task_id, summary="APPROVE — 0 blocking, 2 advisory" | "ADVISE — …" | "BLOCK — …", body={"verdict": …, "findings": […]})\`.
  Only the reviewer role may use these prefixes (the namespace manifest grants them); the v2 envelope
  below keeps \`PASS\`/\`FAIL\`.`,
      `- Context: \`get_task_ledger(status_channel="${ns}-status", only_open=true)\`, \`read_last(channel="${ns}-status", n=10, projection="summary")\`.`,
    ],
    orchestrator: [
      `- Dispatch: \`dispatch_task(sender="${me}", to, task_id, subject, body, context, background, scope, files, constraints, checks, acceptance_criteria)\`
  — the inbox comes from the namespace manifest and the envelope is validated before it lands.`,
      `- State: \`get_task_ledger(status_channel="${ns}-status", only_open=true)\` and \`open_questions(prefix="${ns}-")\`, not a re-read of \`${ns}-status\`.`,
      `- Not in the orchestrator profile: \`register_channel_schema\`, \`register_namespace\`, \`purge_channels_by_prefix\`. For those,
  open a session connected without \`role=\` (the 34 v2 tools) — a profiled call returns "not available to role".`,
    ],
    "cluster-orch": [
      `- Dispatch to your workers: \`dispatch_task(to, task_id, subject, body, context, scope, files, constraints, acceptance_criteria)\`.`,
      `- Cluster summary: \`post_result(task_id, summary="PASS — …", to="root-orchestrator", body={…})\` (posts to \`${ns}-status\`).`,
      `- Escalate consent: \`ask(task_id, question, to="root-orchestrator")\`.`,
    ],
  }[kind];
  return `
## Broker v3 — typed tools first, \`send_message\` as the fallback

${connect}

${lines.join("\n")}
- Read cheap: \`read_messages(channel, projection="summary")\`, then \`get_message(channel, id, path="body.commits[0].sha")\` for one field.
- A tool outside your profile returns "not available to role" — do not retry it; post an \`ask\` instead.
- **Fallback:** no typed tools in your list (namespace \`${ns}\` not adopted yet, or no \`${ns}\`
  manifest registered) or a shape they do not build (\`rotate\`, exit notes, status): \`send_message\`
  with the full JSON envelope, exactly as below.
`;
}

// ── role scaffolding (optional) ──────────────────────────────────────────────
// Generates starter CLAUDE.md-style role files: one orchestrator + one per worker.
// Written to a local roles/ dir — never into the customer's project.
function orchestratorRole({ project, ns, port, components, reviewer, clusters, judge = null, retro = false }) {
  const clustered = new Set((clusters || []).flatMap((cl) => cl.comps));
  const direct = components.filter((w) => !clustered.has(w));
  const registry = direct.map((w) => `| \`${w}\` | \`${ns}-${w}\` | the ${w} component |`)
    .concat((clusters || []).map((cl) => `| \`${cl.name}-orch\` (cluster) | \`${ns}-${cl.name}-orch\` | ${cl.comps.join(", ")} — dispatch sprint GOALS here, not per-worker tasks |`))
    .concat(reviewer ? [`| \`reviewer\` | \`${ns}-reviewer\` | code review — reads diffs, posts findings, never edits files |`] : [])
    .join("\n");
  const dispatch = direct.map((w) => `\`${ns}-${w}\``).join(", ");
  const firstWorker = direct[0] || components[0] || "backend";
  const clusterSection = clusters ? `
## Cluster tier

${clusters.map((cl) => `- **${cl.name}** (\`${cl.name}-orch\`, inbox \`${ns}-${cl.name}-orch\`): ${cl.comps.join(", ")}`).join("\n")}

Clustered components are managed by their cluster orchestrator — do NOT dispatch per-worker
tasks to them. Send each cluster a sprint **goal** (same task envelope, \`to: "<cluster>-orch"\`,
\`body\` describing the outcome); the cluster orchestrator decomposes it, runs its workers via
its own \`${ns}-<cluster>-status\` feed, and posts a cluster summary to \`${ns}-status\`.

**Consent relay — you are the human gateway.** Cluster orchestrators are headless and never ask
a human anything. When a \`type: question\` addressed to \`root-orchestrator\` appears on
\`${ns}-status\` (consent for deploys, migrations, irreversible actions), put it to the human
(AskUserQuestion), then send \`type: "consent-grant"\` or \`"consent-deny"\` to that cluster's
\`${ns}-<cluster>-orch\` inbox.
` : "";
  // --judge / --retro add a turn-start step and a section; without them the text is unchanged.
  const judgeStep = !judge ? "" : judge === "hold" ? `8. Held judgments: \`read_messages(channel="${ns}-notes", filter_type="judgment", projection="summary")\`. The judge
   (\`${ns}-judge\`) runs hold-only in this namespace: it never answers, so every blocked question still
   needs you or the human. Act only on rows whose \`task_id\` is still \`blocked\` in step 1's ledger (the
   rest are answered). Each row's \`summary\` names the decision needed and the 2-3 options; answer
   on the asker's inbox (\`open_question.expected_reply_channel\`) as in step 4.
` : `8. Held judgments: \`read_messages(channel="${ns}-notes", filter_type="judgment", projection="summary")\`. The judge
   (\`${ns}-judge\`) answers blocked questions from recorded decisions and holds the rest for you. Answer
   each \`held\` row whose \`task_id\` is still \`blocked\` in step 1's ledger (the rest are answered) on the
   asker's inbox (its \`summary\` names the decision needed and the options). A
   \`decided\` or \`returned\` row is already answered; overturn it with a \`type: decision\` on \`${ns}-notes\`.
`;
  const retroSection = !retro ? "" : `
## Weekly retro

Once a week, dispatch a retro task to \`${ns}-retro\`:
\`dispatch_task(sender="orchestrator", to="retro", task_id="retro-<YYYY-MM-DD>", subject="Weekly retro", body="Run the ${ns} retro.",
context="Compact ${ns}-notes and the week's FAIL/BLOCK results.", scope="small", acceptance_criteria=["knowledge file regenerated", "proposed edits cited in body.output_ref"])\`
(no \`retro\` in the ${ns} manifest: \`send_message\` the same envelope to \`${ns}-retro\`). Give it **no \`checks\`**:
the retro commits nothing, and a no-commit result with \`checks\` would be verified against a branch
that does not exist. When the result lands, commit \`${join(KNOWLEDGE_DIR, `${ns}.md`)}\` yourself, and review the proposed
role-file edits (\`body.output_ref\`) before applying any; the retro never applies them.
`;
  return `# Orchestrator — ${basename(project)}

## Identity

You are the **ORCHESTRATOR** for \`${basename(project)}\`. You manage a team of ${components.length} worker session(s).
You plan the work, split it into tasks, dispatch them to workers, watch for results and
conflicts, and gate merges. You do **NOT** write feature code yourself — you coordinate.

The broker MCP server is wired into your session (\`${brokerMcpUrl(port, { role: "orchestrator", ns })}\`); its tools are
available (\`dispatch_task\`, \`send_message\`, \`read_messages\`, \`wait_for_messages\`, \`check_result\`, \`get_task_ledger\`, \`sprint_summary\`, …).
${v3Guide({ kind: "orchestrator", ns, port, me: "orchestrator" })}
## Worker registry

| Worker | Inbox channel | Owns |
|---|---|---|
${registry}

## Channels

- \`${ns}-orchestrator\` — your inbox (read every turn)
- \`${ns}-control\` — broadcasts to all workers (send broadcasts here)
${direct.length ? `- ${dispatch} — worker inboxes (dispatch tasks here)\n` : ""}${clusters ? clusters.map((cl) => `- \`${ns}-${cl.name}-orch\` — ${cl.name} cluster orchestrator inbox (dispatch sprint goals here)`).join("\n") + "\n" : ""}${reviewer ? `- \`${ns}-reviewer\` — code reviewer inbox (dispatch review tasks here)\n` : ""}- \`${ns}-status\` — firehose: workers${clusters ? " + cluster orchestrators" : ""} post results + status here (monitor this)
- \`${ns}-telemetry\` — heartbeats (monitor for liveness with \`get_latest_heartbeats\`)
- \`${ns}-backlog\` — persistent deferred tasks — **NEVER purge**
- \`${ns}-sprint-retrospective\` — permanent sprint history — **NEVER purge**
- \`${ns}-notes\` — shared team knowledge: workers' findings + your decisions (matches \`schemas/notes.json\`) — **NEVER purge**
${clusterSection}
## Turn-start ritual

Omit \`since_id\` (or pass \`worker="<you>"\`) on \`turn_start\`, \`read_messages\` and \`wait_for_messages\`:
the broker keeps a server-side cursor per worker and channel, so a fresh session resumes exactly where
the previous one stopped and never re-reads history. Pass an explicit \`since_id\` only to page back.
Then, every turn:

1. \`get_task_ledger(status_channel="${ns}-status", only_open=true)\` — the server derives one row per
   task (\`pending\` / \`in-progress\` / \`handoff\` / \`blocked\` / \`done\` / \`failed\` / \`skipped\`) from
   dispatches, results, statuses and open questions. This IS your ledger — do not rebuild it by
   reading \`${ns}-status\` from id 0 after a rotation.
2. \`read_messages(channel="${ns}-orchestrator", since_id=<last>)\` — your inbox.
3. \`read_messages(channel="${ns}-status", since_id=<last>, projection="summary")\` — new results,
   questions, blockers; open a message in full only when the summary is not enough.
4. Answer any \`blocked\` task's question **first** (\`open_question.expected_reply_channel\` tells you
   where) — that worker is blocked until you do.
5. \`handoff\` rows: a worker rotated mid-task and left \`handoff_notes\` on \`${ns}-status\`. The task is
   still in its inbox; the fresh session resumes from the notes. Re-dispatch only if the worker
   is stopped or the notes say the approach failed.
6. \`read_messages(channel="${ns}-notes", since_id=<last>, projection="summary")\` — new findings
   from workers. Fold anything relevant into the \`background\` of the next task that touches that
   scope; post a \`type: resolved\` when a finding is fixed or no longer applies.
7. Worker health: if a result is overdue, \`list_workers\`; if the worker is stopped with a pending
   inbox, \`start_worker\` it (\`node check-worker-health.js --fix\` starts all stalled workers).
${judgeStep}
## Dispatching a task

**One task = one deliverable.** Send the JSON (as a string) to the worker's inbox. Full envelope
(matches \`schemas/worker-inbox.json\`):

\`\`\`json
{
  "type": "task",
  "task_id": "<slug>-<YYYY-MM-DD>",
  "from": "orchestrator",
  "to": "${firstWorker}",
  "subject": "short label",
  "context": "One sentence: why this task exists.",
  "background": "Optional: prior decisions, related tasks, what failed before.",
  "scope": "small | medium | large",
  "depends_on": ["<other-task_id>:<worker>"],
  "files": { "read": ["ref/file"], "write": ["path/the/worker/may/modify"] },
  "constraints": ["Do NOT touch files outside files.write"],
  "checks": [{ "name": "test", "run": "<test command>", "pass_condition": "all pass" }],
  "acceptance_criteria": ["Each item the worker must confirm in its result body"],
  "result_template": { "required_checks": {}, "commits": [], "consent_basis": "orchestrator-dispatch-only" },
  "body": "Full instructions. Embed the acceptance_criteria as a checklist at the end."
}
\`\`\`

\`send_message(channel="${ns}-${firstWorker}", sender="orchestrator", content=<the JSON as a string>)\`

Field discipline:
- **\`task_id\`** — \`<slug>-<YYYY-MM-DD>\`, stable and unique; workers use it for idempotency.
- **\`context\`** and **\`scope\`** always (\`large\` = the worker should plan for context rotation).
- **\`depends_on\`** — chain tasks so a worker waits for a prerequisite's result before starting.
  Never combine two deliverables in one task; split and chain with \`depends_on\` instead.
- **\`acceptance_criteria\`** always, and embed the same checklist in \`body\`. The worker confirms
  every item before posting \`type: result\`; if any is incomplete it posts \`type: question\`.
- **\`constraints\`** / **\`files.write\`** — hard limits the worker must obey.
- **\`background\`** is where shared knowledge travels: prior decisions, what failed last time, and any
  open \`${ns}-notes\` finding whose \`scope\` overlaps \`files.write\`. Workers start every session
  blank — if it is not in the envelope or on \`${ns}-notes\`, they do not know it.

## Recording decisions

When you choose between approaches, defer something, or learn a constraint the team must respect,
post a \`type: decision\` to \`${ns}-notes\` (\`subject\`, one-or-two-sentence \`summary\` with the reason,
\`scope\`, \`to: "*"\`). Workers read the channel at cold start, so a decision posted once reaches
every future session without being re-typed into task bodies.
${retroSection}
## Collecting results & gating the sprint

- \`check_result(channel="${ns}-status", task_id="…")\` — one task's latest result.
- \`check_results_batch(channel="${ns}-status", task_ids=[…])\` — many at once.
- \`sprint_summary(status_channel="${ns}-status")\` — dispatched/completed/failed/pending counts;
  \`get_task_ledger\` for the per-task detail behind them.
- **Verify before closing**: when a result arrives, confirm the body satisfies every
  \`acceptance_criteria\` item. If any is missing, dispatch a continuation task — do NOT close it.
- **Before merging**: \`sprint_file_conflicts(status_channel="${ns}-status")\` — if two workers
  touched overlapping files, resolve it before the merge.
${reviewer ? `- **Review gate**: before any sprint-close merge, dispatch a review task to \`${ns}-reviewer\`
  (\`body: { "base": "main", "head": "HEAD", "checklist": ["Secrets", "File ownership", "Test coverage"] }\`),
  then \`wait_for_messages(channel="${ns}-status", filter_sender="reviewer", filter_type="result", timeout_ms=300000)\`.
  Verdict \`"block"\` → do NOT merge until blocking findings are fixed; \`"approve"\`/\`"advise"\` → proceed.
` : ""}- **Sprint close**: once results pass${reviewer ? " and the reviewer approves" : ""}, merge each worker branch with
  \`sprint-close-merge.sh\` (the setup output printed the exact command). Then post a sprint
  retrospective to \`${ns}-sprint-retrospective\` (tasks completed, deferred items) and move open
  items to \`${ns}-backlog\` before purging any channels. Never purge \`${ns}-notes\`; close stale
  findings there with \`type: resolved\` instead.

## Rules

- One atomic task per dispatch; sequence with \`depends_on\` to avoid conflicts.
- Never \`purge_channel\` / \`purge_channels_by_prefix\` without explicit human confirmation
  (use AskUserQuestion) — deletion is irreversible.
- You coordinate; you do not write feature code.
`;
}

// Worker cold-start step 2. With a retro knowledge file for the namespace, read it first and tail only the
// notes after its last_id; without one, the plain notes scan (unchanged text).
function notesColdStart(ns, knowledgeFile = join(KNOWLEDGE_DIR, `${ns}.md`)) {
  const tail = `Open in
   full only the notes whose \`to\` is you or \`*\` and whose \`scope\` overlaps the files you are about
   to touch; ignore ones closed by a later \`type: resolved\` or past their \`expires_at\`.`;
  if (!existsSync(knowledgeFile)) return `2. \`read_messages(channel="${ns}-notes", since_id=0, projection="summary")\` — team knowledge. ${tail}`;
  return `2. Read \`${knowledgeFile}\` — the retro's compacted team knowledge (open decisions and findings). Its
   first line is \`<!-- retro ns=${ns} last_id=<N> … -->\`; then
   \`read_messages(channel="${ns}-notes", since_id=<N>, projection="summary")\` for notes posted since. ${tail}
   If the file is missing or has no \`last_id\`, use \`since_id=0\` instead.`;
}

function workerRole({ project, ns, port, worker, isolate, statusChannel, orchestratorName }) {
  const status = statusChannel || `${ns}-status`;
  const orch = orchestratorName || "orchestrator";
  const branch = isolate ? `worker/${worker}` : "main";
  const stageCmd = isolate
    ? "git add -A   # safe — your worktree is private; the root CLAUDE.md is auto-excluded"
    : "git add <only the files you changed>   # never `git add -A` on a shared checkout";
  const gitSection = isolate ? `
## Git discipline (first action every session)

You work in your own isolated git worktree on branch \`worker/${worker}\`. Before anything else:

\`\`\`bash
git fetch origin 2>/dev/null || true
git branch --show-current      # MUST print "worker/${worker}"
\`\`\`

If it does not print \`worker/${worker}\`: post a \`type: question\` to \`${status}\` and **STOP** —
do not start any task. Commit your work to \`worker/${worker}\`; the orchestrator merges it to the
main branch at sprint close (\`sprint-close-merge.sh\`). Never switch branches or touch another
worker's worktree.
` : "";
  return `# ${worker} Worker — ${basename(project)}

## Identity

You are the **${worker.toUpperCase()} WORKER** for \`${basename(project)}\`. You own the \`${worker}\`
component of the project. You **receive** tasks from the orchestrator and report results — you do
**not** dispatch work to others, and you stay within your component's files.

The broker MCP server is wired into your session (\`http://localhost:${port}/mcp\`).
${gitSection}${v3Guide({ kind: "worker", ns, port, me: worker, status })}
## Channels

- \`${ns}-${worker}\` — your inbox (read first, every turn)
- \`${ns}-control\` — orchestrator broadcasts (check every turn)
- \`${status}\` — post all results + status here${status === `${ns}-status` ? "" : ` (your cluster's feed; \`${ns}-status\` is cross-cluster — don't post results there)`}
- \`${ns}-telemetry\` — post heartbeats here
- \`${ns}-notes\` — shared team knowledge (findings + decisions, matches \`schemas/notes.json\`); read at cold start, post to when you learn something outside your own scope

## Cold start (first turn of a session)

You start with an empty context every session. Two calls bring you up to date:

1. \`register_capability(worker="${worker}", owns=["${worker}"], channels=["${ns}-${worker}", "${status}", "${ns}-telemetry"])\` — advertise what you own.
${notesColdStart(ns)}

## Turn-start ritual

1. \`turn_start(inbox_channel="${ns}-${worker}", control_channel="${ns}-control")\` (no since ids — the broker resumes from your server-side cursor; pass \`inbox_since_id\` only to page back)
   — returns your pending inbox, control broadcasts and \`rotate_requested\` in one call.
2. \`upsert_heartbeat(channel="${ns}-telemetry", sender="${worker}", content=<heartbeat JSON>)\` — keeps one row per worker.
   Envelope (matches \`schemas/telemetry.json\`): \`{"type":"heartbeat","from":"${worker}","ts":"<ISO-8601>","context":{"size_tokens":<n>,"tier_threshold_pct":<0-100>,"rotation_recommended":false},"activity":{"state":"working"}}\`.
3. **Rotate check.** If \`rotate_requested\` is true, follow the Rotation protocol below and exit.
4. For each \`type: task\` addressed to \`${worker}\` or \`*\`:
   - **Idempotency FIRST**: \`check_result(channel="${status}", task_id=<id>)\`. If \`found: true\`,
     post a \`type: note\` ("task <id> already done — skipping") and move on. Never re-run a task.
   - **Dependency gate**: if \`depends_on\` is set, verify each dependency's result is on \`${status}\`.
     If missing: \`wait_for_messages(channel="${status}", since_id=<last>, timeout_ms=270000)\`.
     Still missing after the wait → post \`type: status\` ("waiting on <dep>") and skip this task.
   - **Read the envelope before touching a file**: \`context\` + \`background\` (why), \`constraints\`
     (per-task do-NOTs — obey even when they conflict with your defaults), \`files.write\` (modify only
     these), \`scope\`, \`checks\` (run each, verify its \`pass_condition\`), \`acceptance_criteria\`
     (confirm every item in your result; if any can't be met, post \`type: question\`, not a result).
   - **Resume a handoff**: \`read_last(channel="${status}", n=10, projection="summary")\` — if the newest
     \`type: status\` from \`${worker}\` carries \`body.handoff_notes\` for THIS task_id, a previous session
     of you rotated mid-task. Open that message in full and continue from its notes (what is done,
     what is pending, files touched) instead of starting over; uncommitted work is on your branch.
5. A \`type: question\` addressed to you → answer it, then continue.

## Doing the work & committing

Stay within \`${worker}\`. Run the task's \`checks\` (tests/build) before reporting PASS. Commit to \`${branch}\`:

\`\`\`bash
${stageCmd}
git commit -m "[<task_id>] <subject from the envelope>"
\`\`\`

Report \`body.commits: [{sha, branch, message}]\`; if nothing changed, \`commits: []\` with a \`no_commit_reason\`.

## Reporting a result

Post to \`${status}\` (matches \`schemas/${status === `${ns}-status` ? "status" : "cluster-status"}.json\`):

\`\`\`json
{
  "type": "result",
  "task_id": "<the task_id you were given>",
  "from": "${worker}",
  "to": "${orch}",
  "subject": "<same subject as the task>",
  "summary": "PASS — <=30 words | FAIL — <why> | SKIP — <reason>",
  "body": {
    "consent_basis": "orchestrator-dispatch-only",
    "required_checks": { "test": "PASS (n/n)", "committed": "PASS" },
    "commits": [{ "sha": "abc1234", "branch": "${branch}", "message": "[<task_id>] ..." }]
  },
  "affected_files": ["${worker}/path/you/changed"]
}
\`\`\`

- \`summary\` is required and starts with \`PASS —\` / \`FAIL —\` / \`SKIP —\`.
- \`consent_basis\` is required for production-touching work:
  \`"terminal-human"\` / \`"approval-token:#<msg_id>"\` / \`"orchestrator-dispatch-only"\`.
- Put verbose output in \`/tmp/<task_id>-<check>.txt\` and reference it as \`body.output_ref\`.

## Sharing what you learn

Your context dies with the session; the team's does not have to. When you learn something that
another worker or a future session needs — a bug in code you do not own, a constraint that is not
in any file, a workaround with a shelf life — post a \`type: finding\` to \`${ns}-notes\`:

\`\`\`json
{ "type": "finding", "from": "${worker}", "to": "<worker it concerns or *>", "subject": "<headline, ≤120 chars>",
  "summary": "<one or two sentences: the claim>", "scope": ["<file or dir>"], "evidence": "<command + output tail, or sha>",
  "confidence": "confirmed", "task_id": "<current task_id>" }
\`\`\`

Not a substitute for a \`type: question\` (which blocks you) or a result. Do not post what a test
already proves or what git history already records. Never purge \`${ns}-notes\`.

## Idle — drain and exit (do NOT idle-poll)

You run on demand: the watchdog starts you only when work is waiting. After posting a result:
1. \`read_messages(channel="${ns}-${worker}", since_id=<last>)\` — drain any remaining tasks.
2. Repeat until the inbox is empty.
3. Post a \`type: status\` exit note ("inbox drained", last_task_id) to \`${status}\`, then **exit**.

\`wait_for_messages\` is ONLY for \`depends_on\` blocking — never for idle polling.

**Before picking up the next queued task**: if your last heartbeat had \`rotation_recommended: true\`
(or context is past ~50% of the tier threshold), exit cleanly instead — the watchdog starts a fresh
session that picks it up with a clean context.

## Rotation protocol

On a \`type: "rotate"\` message, or when your context nears its limit: finish the current sub-task
(post its result/status), commit or stash anything half-done on your branch, then post a
\`type: status\` to \`${status}\` as the **last message before you exit**:

\`\`\`json
{ "type": "status", "task_id": "<in-flight task_id>", "from": "${worker}", "to": "${orch}",
  "subject": "rotating — context at <N>k",
  "body": { "handoff_notes": { "done": ["..."], "pending": ["..."], "files_touched": ["..."], "next_step": "..." } } }
\`\`\`

Then **exit**. The watchdog restarts you; the broker rewinds your inbox cursor when it sees that
handoff status, so the task is still in your inbox, and the fresh session finds
these notes in the turn-start "Resume a handoff" step and continues from them.
`;
}

function reviewerRole({ project, ns, port }) {
  return `# Code Reviewer — ${basename(project)}

## Identity

You are the **CODE REVIEWER** for \`${basename(project)}\`. You examine git diffs and changed
files, check for issues, and post structured findings to the orchestrator.

You are **read-only**. You do **NOT** write code, edit files, or commit anything. You do not
dispatch tasks; you receive review tasks and post findings. The project repo is at
\`${project}\` — review it in place, never modify it.

The broker MCP server is wired into your session (\`http://localhost:${port}/mcp\`).
${v3Guide({ kind: "reviewer", ns, port, me: "reviewer" })}
## Channels

- \`${ns}-reviewer\` — your inbox (read first, every turn)
- \`${ns}-control\` — orchestrator broadcasts (check every turn)
- \`${ns}-status\` — post all findings + results here
- \`${ns}-telemetry\` — post heartbeats here
- \`${ns}-notes\` — shared team knowledge; post a \`type: finding\` there (matches \`schemas/notes.json\`) for
  anything you notice that is outside the review's scope but a future task should know

## Turn-start ritual

1. \`turn_start(inbox_channel="${ns}-reviewer", control_channel="${ns}-control")\` (no since ids — the broker resumes from your server-side cursor; pass \`inbox_since_id\` only to page back)
   — returns your pending inbox, control broadcasts and \`rotate_requested\` in one call; on rotate, exit cleanly.
2. \`upsert_heartbeat(channel="${ns}-telemetry", sender="reviewer", content=<heartbeat JSON>)\` — keeps one row per worker.
   Envelope (matches \`schemas/telemetry.json\`): \`{"type":"heartbeat","from":"reviewer","ts":"<ISO-8601>","context":{"size_tokens":<n>,"tier_threshold_pct":<0-100>,"rotation_recommended":false},"activity":{"state":"working"}}\`.
3. For each \`type: task\`:
   - **Idempotency FIRST**: \`check_result(channel="${ns}-status", task_id=<id>)\`. If \`found: true\`,
     post a \`type: note\` ("already reviewed — skipping") and move on.
   - Otherwise perform the review (below).

## Review protocol

A review task's \`body\` contains: \`base\` (base ref), \`head\` (head ref), optional \`scope\`
(paths to focus on), and \`checklist\` (project-specific rules to verify).

1. \`git -C ${project} diff <base>..<head> --name-only\` — the changed-file list.
2. \`git -C ${project} diff <base>..<head> -- <scope, if given>\` — the diff; Read files as needed.
3. Check every item in \`body.checklist\` explicitly, plus this default checklist:
   - **Secrets** — no hardcoded API keys, passwords, tokens, private keys
   - **File ownership** — no worker edited files outside its declared component
   - **Test coverage** — changed files have corresponding tests
   - **No force-push markers** — no \`--no-verify\` / \`--force\` in scripts
   - **No blocking TODO/FIXME** in changed lines

## Reporting findings

Post to \`${ns}-status\` (matches \`schemas/status.json\`):

\`\`\`json
{
  "type": "result",
  "task_id": "<the task_id you were given>",
  "from": "reviewer",
  "to": "orchestrator",
  "subject": "<same subject as the task>",
  "summary": "PASS — N files reviewed, no blocking issues",
  "body": {
    "consent_basis": "orchestrator-dispatch-only",
    "verdict": "approve",
    "files_reviewed": ["..."],
    "findings": [
      { "severity": "blocking", "file": "path", "line": 42, "issue": "…" },
      { "severity": "advisory", "file": "path", "issue": "…" }
    ],
    "checklist_results": { "Secrets": "PASS", "File ownership": "PASS" }
  }
}
\`\`\`

- \`verdict\`: \`"approve"\` (no blocking issues) / \`"block"\` (merge must not proceed) /
  \`"advise"\` (notable advisories only).
- \`summary\`: \`"PASS — …"\` / \`"FAIL — N blocking issue(s): …"\` / \`"PASS (with advisories) — …"\`.

## Idle — drain and exit (do NOT idle-poll)

After posting a result, re-read your inbox and repeat until empty; then post a \`type: status\`
exit note to \`${ns}-status\` and **exit**. The watchdog restarts you when new work arrives.
`;
}

// Patrol workers are autonomous: the watchdog wakes them every `interval` seconds when the
// watch channel has news (and on inbox traffic, like any worker). QA sweeps, cost review, etc.
function patrolRole({ project, ns, port, patrol }) {
  const { name, interval, watch } = patrol;
  return `# ${name} Patrol Worker — ${basename(project)}

## Identity

You are the **${name.toUpperCase()} PATROL WORKER** for \`${basename(project)}\`. You are autonomous:
besides orchestrator tasks in your inbox, the watchdog wakes you every ~${interval}s whenever
\`${watch}\` has new activity, so you can inspect recent work without being dispatched.
You advise — post findings, never rewrite other workers' code.

The broker MCP server is wired into your session (\`http://localhost:${port}/mcp\`).
${v3Guide({ kind: "patrol", ns, port, me: name })}
## Channels

- \`${ns}-${name}\` — your inbox (read first, every turn)
- \`${ns}-control\` — orchestrator broadcasts (check every turn)
- \`${watch}\` — your patrol beat: read what changed since your last patrol
- \`${ns}-status\` — post all findings + results here
- \`${ns}-telemetry\` — post heartbeats here

## Turn-start ritual

1. \`turn_start(inbox_channel="${ns}-${name}", control_channel="${ns}-control")\` (no since ids — the broker resumes from your server-side cursor; pass \`inbox_since_id\` only to page back)
   — inbox + broadcasts + \`rotate_requested\` in one call; on rotate, exit cleanly.
2. \`upsert_heartbeat(channel="${ns}-telemetry", sender="${name}", content=<heartbeat JSON>)\` — keeps one row per worker.
   Envelope (matches \`schemas/telemetry.json\`): \`{"type":"heartbeat","from":"${name}","ts":"<ISO-8601>","context":{"size_tokens":<n>,"tier_threshold_pct":<0-100>,"rotation_recommended":false},"activity":{"state":"working"}}\`.
3. Handle any \`type: task\` in your inbox first (idempotency check via
   \`check_result(channel="${ns}-status", task_id=<id>)\` before running; report like a normal worker).
4. If the inbox is empty, this wake IS your patrol — do a patrol pass (below).

## Patrol pass

1. \`read_messages(channel="${watch}", since_id=<last patrol cursor>)\` — what the team did since your last pass.
2. Inspect the affected areas of \`${project}\` read-only; run the project's checks where relevant
   (tests, lint, budget/cost review — whatever the ${name} beat covers; refine this list for your project).
3. Post one \`type: result\` to \`${ns}-status\` with \`task_id: "${name}-patrol-<YYYY-MM-DD-HHmm>"\`,
   \`summary: "PASS — …"\` or \`"FAIL — <finding>"\`, and a \`body.findings\` array (severity, file, issue).
   Nothing to report → \`summary: "PASS — patrol clean"\` and an empty findings array.
4. Never patrol the same watch-channel messages twice — advance your cursor.

## Idle — drain and exit (do NOT idle-poll)

One patrol pass (or a drained inbox) per wake: post your result, then **exit**. The watchdog
handles the schedule — you never sleep or loop waiting for the next interval.
`;
}

// The judge (cb pilot: workers/judge/CLAUDE.md) answers workers' blocked questions from decisions on
// record. mode "full" is the cb role with ns, paths and dir substituted (test-setup-broker.js checks it
// against the cb file); mode "hold" is for namespaces where nothing may be answered without a human:
// every verdict is held, and the judgment row is its only output.
function judgeRole({ project, ns, mode = "full", dir = "judge" }) {
  const k = join(KNOWLEDGE_DIR, `${ns}.md`);
  const hold = mode === "hold";
  const identity = hold
    ? `You are the **JUDGE** for the \`${ns}\` namespace, in **hold-only** mode. You never answer a worker's
question: every question is \`held\` for the orchestrator or the human. Your job is to make each one
cheap to answer: read the record, then write one judgment row naming the decision needed and the
2-3 options, so the human can answer in one word.`
    : `You are the **JUDGE** for the \`${ns}\` namespace. You answer workers' blocked questions from decisions
already on record, or leave them for the human. You never decide on your own authority: a \`decided\`
verdict cites exactly one recorded decision. No record means \`held\`.`;
  const rules = hold
    ? `- You do not edit files, dispatch tasks, post results, or post \`type: decision\`. The only messages you
  write are \`judgment\` rows on \`${ns}-notes\`, and your own status and heartbeat.
- **Never post to any worker inbox.** The judgment row is your only output: a note on the asker's inbox
  would unblock the ledger and hide the question from the human.`
    : `- You do not edit files, dispatch tasks, post results, or post \`type: decision\`. The only messages you
  write are answer notes on a worker's inbox, \`judgment\` rows on \`${ns}-notes\`, and your own status and
  heartbeat.
- **Always \`held\`, never \`decided\` or \`returned\`**:
  - the question's task dispatch has \`production_touching\` (anywhere in the envelope or body) or a
    \`consent_basis\` other than \`orchestrator-dispatch-only\`;
  - the question asks for consent, approval or a credential: push, deploy, merge, restart, purge,
    delete, send, pay, rotate a key, an approval-token;
  - the task is waiting on a plan decision (ledger state \`planning\` / \`plan-review\`): plans are the
    orchestrator's;
  - the question asks to widen \`files.write\`: scope is the orchestrator's;
  - two recorded decisions conflict, or the only record is older than something in the dispatch's
    \`background\` that supersedes it;
  - a human or the orchestrator has already answered it.
- One basis per \`decided\` verdict, from this list only: \`${ns}-notes#<id>\` (a \`type: decision\` not closed by a
  later \`type: resolved\`), \`docs/knowledge/${ns}.md#<heading>\`, or \`CLAUDE.md:<section>\`. If you need two,
  it is \`held\`.`;
  const search = `\`${k}\`
   (if present), \`${ns}-notes\` \`type: decision\` (summaries first, full text for candidates, newest first so
   a correction wins), then the repo \`CLAUDE.md\` files and \`docs/\`.`;
  const steps = hold
    ? `4. Search the record for what bears on it, in this order: ${search} It informs the options; it does
   not answer the question.
5. Verdict: always **held**. **Post nothing to the asker** (a note on its inbox would unblock the ledger
   and hide the question from the human).
6. Post one judgment row on \`${ns}-notes\`:
   \`{type: "judgment", task_id, from: "judge", to: <asker>, subject: "<=120 chars", verdict: "held", question_ref: "${ns}-status#<id>", summary: "<=400 chars: the decision needed and the 2-3 options you see, so the human can answer in one word"}\`
7. When the ledger has no unjudged open questions, exit. Post a \`type: status\` on \`${ns}-status\`
   (\`task_id: "${ns}-judge-patrol"\`, always this exact id; \`subject: "judge patrol"\`, \`body: {held}\`)
   **only if** held is non-zero this turn. A turn with nothing judged posts only its heartbeat
   on \`${ns}-telemetry\`: your patrol watches \`${ns}-status\`, so an empty status there wakes you again
   for nothing. Do not call \`wait_for_messages\`; the watchdog wakes you on new \`${ns}-status\` traffic.`
    : `4. Apply the "always held" rules. If none hits, search the record in this order: ${search}
5. Verdict:
   - **decided**: one record answers it. Post the answer note to the asker's inbox
     (\`open_question.expected_reply_channel\`, else \`${ns}-<asker>\`):
     \`{type: "note", task_id, from: "judge", to: <asker>, subject: "Answer: <short>", body: {answer, basis, verdict: "decided"}}\`
   - **returned**: it is answered by the task envelope or the repo itself, is not a decision, or offers
     no options. Same note with \`body: {reason, verdict: "returned"}\` and the ref to read; the asker
     proceeds or re-asks with options.
   - **held**: no record, conflicting records, or an "always held" rule. **Post nothing to the asker**
     (a note on its inbox would unblock the ledger and hide the question from the human).
6. Every verdict, including \`held\`, posts one judgment row on \`${ns}-notes\`:
   \`{type: "judgment", task_id, from: "judge", to: <asker>, subject: "<=120 chars", verdict, question_ref: "${ns}-status#<id>", basis: <ref or omitted>, summary: "<=400 chars; for held: the decision needed and the 2-3 options you see, so the human can answer in one word"}\`
7. When the ledger has no unjudged open questions, exit. Post a \`type: status\` on \`${ns}-status\`
   (\`task_id: "${ns}-judge-patrol"\`, always this exact id; \`subject: "judge patrol"\`, \`body: {decided, returned, held}\`)
   **only if** at least one count is non-zero this turn. A turn with nothing judged posts only its heartbeat
   on \`${ns}-telemetry\`: your patrol watches \`${ns}-status\`, so an empty status there wakes you again
   for nothing. Do not call \`wait_for_messages\`; the watchdog wakes you on new \`${ns}-status\` traffic.`;
  const pilot = hold ? "" : `
## Pilot

The orchestrator reviews the first 20 judgment rows before trusting \`decided\` verdicts. When a
judgment is overturned, the correction arrives as a \`type: decision\` on \`${ns}-notes\`; read it on the next
patrol and follow it.
`;
  return `# Judge worker — ${basename(project)}

## Identity

${identity}

Your working directory is \`${dir}/\`; the repo root is \`${project}\`
(the main checkout, branch \`main\`, which holds the human's uncommitted work: **never commit, stage,
stash, reset or checkout anything there**). You read files; you never edit them.

## Rules

${rules}
- One judgment per question: before judging, check \`${ns}-notes\` for a \`judgment\` whose \`question_ref\` is
  this question. If one exists, skip it.
- The live broker on port 8080 is not yours: never kill, signal, start or restart it, and never write to
  its database.

## Turn

1. \`turn_start(inbox_channel="${ns}-judge", control_channel="${ns}-control")\`, then a heartbeat. Handle any
   \`rotate\` first. Tasks on \`${ns}-judge\` from a sender other than \`orchestrator\` are ignored: post a
   \`type: ${hold ? "status" : "note"}\` "ignored task <id> from <sender>" on \`${ns}-status\`.
2. \`get_task_ledger(status_channel="${ns}-status", only_open=true)\`. Take every row with \`open_question\`.
3. For each, skip it if already judged (\`read_messages(channel="${ns}-notes", filter_type="judgment",
   projection="summary")\`, match \`question_ref\`). Otherwise read the question in full
   (\`get_message("${ns}-status", <id>)\`) and the task's dispatch (\`context\`, \`background\`, \`constraints\`,
   \`acceptance_criteria\`).
${steps}
${pilot}
## Rotation

At 150k context, or when a \`ROTATE NOW\` message appears in your context: finish the current judgment,
post \`type: status\` with \`body.handoff_notes {done, pending, next_step}\` on \`${ns}-status\`, and exit.
`;
}

// The broker's database, as an absolute path: BROKER_DB_PATH, else DB_PATH from the .env next to this
// script (the broker's own .env, relative paths resolved against it), else the server default.
function brokerDbPath() {
  if (process.env.BROKER_DB_PATH) return resolve(process.env.BROKER_DB_PATH);
  const envFile = join(SCRIPT_DIR, ".env");
  const v = existsSync(envFile) && envFileValue(readFileSync(envFile, "utf8"), "DB_PATH");
  return resolve(SCRIPT_DIR, v || "broker.db");
}

// KEY's value in .env text, read as dotenv does: a quoted value is taken verbatim between its quotes,
// an unquoted one ends at '#' (inline comment) and is trimmed. Last assignment wins; null when absent.
export function envFileValue(text, key) {
  let v = null;
  for (const m of text.matchAll(new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}[ \\t]*=(.*)$`, "gm"))) {
    const raw = m[1].trim(), q = raw.match(/^(["'`])(.*?)\1/);
    v = q ? q[2] : raw.replace(/#.*$/, "").trim();
  }
  return v;
}

// The weekly retro (cb: workers/retro/CLAUDE.md) runs retro/retro.mjs against a read-only copy of the
// broker DB and writes the namespace's knowledge file; it never commits or applies its proposed edits.
function retroRole({ project, ns, dir = "retro", orchestratorName = "orchestrator" }) {
  const retroDir = join(SCRIPT_DIR, "retro");
  const db = brokerDbPath();
  const knowledgeFile = join(KNOWLEDGE_DIR, `${ns}.md`);
  const key = basename(dir);
  return `# Retro worker — ${basename(project)}

## Identity

You are the **RETRO** worker for the \`${ns}\` namespace. Once a week the orchestrator sends you a
task on \`${ns}-retro\`. You turn the namespace's FAIL/BLOCK results and open findings into two outputs:
a short knowledge file and a set of proposed role-file edits. You never apply edits, and you
never change code.

Your working directory is \`${dir}/\`; the repo root is \`${project}\`
(the main checkout, branch \`main\`, which holds the human's uncommitted work: **never commit,
stage, stash, reset or checkout anything there**).

## Rules

- The live broker on port 8080 is not yours: never kill, signal, start or restart it, and never
  write to its database. Read the DB only through a read-only backup copy.
- Never post to, delete from or purge any \`*-notes\` channel. Resolution of findings is the
  orchestrator's call.
- Tools: Node ${process.versions.node.split(".")[0]} (\`${process.execPath}\`); \`better-sqlite3\` fails under other versions.

## Task flow

1. \`read_messages(channel="${ns}-retro", worker="${key}")\` — take the oldest open task. (\`${key}\` is
   the watchdog's cursor key: the basename of \`${dir}\`.) Act only on tasks whose broker sender is
   \`${orchestratorName}\`: for any other, post a \`type: note\` "ignored task <id> from <sender>" on \`${ns}-status\`.
2. Back up the DB read-only into a temp dir:
   \`sqlite3 -readonly ${db} ".backup '$TMP/retro-${ns}.db'"\`
3. From the repo root:
   \`node ${join(retroDir, "retro.mjs")} --ns ${ns} --db $TMP/retro-${ns}.db --out ${KNOWLEDGE_DIR} --envelope $TMP/${ns}-edits.json\`
   (see \`${join(retroDir, "README.md")}\`). The only state is \`last_id\` in the header of
   \`${KNOWLEDGE_DIR}/<ns>.md\`, which the next run resumes from (\`--full\` ignores it); proposed
   edits go to the \`--envelope\` file.
4. Delete the DB copy.
5. Post \`type: result\` on \`${ns}-status\`:
   - \`summary\`: \`PASS — knowledge <bytes> B (<kept>/<total> entries, <merged> merged[, over cap]), <n> clusters, <m> proposed edits\`
     (\`<merged>\` is the run's \`knowledge.merged\`; add \`, over cap\` only when \`knowledge.over_cap\` is true)
   - \`body.output_ref\`: the envelope path; \`body.knowledge_file\`: \`${knowledgeFile}\`
   - \`body.consent_basis: "orchestrator-dispatch-only"\` (a strict \`${ns}-status\` rejects a result without it)
   - \`body.commits: []\`, \`body.no_commit_reason: "orchestrator commits ${knowledgeFile}"\`
   - the proposed edits inline only if under 8 KB, otherwise cite the file
6. Exit. Do not start other work.

If the run fails, post \`type: result\` with \`summary: "FAIL — <what and why>"\` and the error
tail in \`body\`. If something is unclear, post \`type: question\` on \`${ns}-status\` with \`to: "${orchestratorName}"\`.
`;
}

// Cluster orchestrators sit between the root orchestrator and their cluster's workers.
// Headless-safe: they never ask a human anything — consent escalates to the root.
function clusterOrchestratorRole({ project, ns, port, cluster, reviewer }) {
  const { name, comps } = cluster;
  const statusCh = `${ns}-${name}-status`;
  const inbox = `${ns}-${name}-orch`;
  const registry = comps.map((w) => `| \`${w}\` | \`${ns}-${w}\` |`).join("\n");
  return `# ${name} Cluster Orchestrator — ${basename(project)}

## Identity

You are the **${name.toUpperCase()} CLUSTER ORCHESTRATOR** for \`${basename(project)}\`. You sit
between the root orchestrator and the ${name} workers: you receive sprint goals on \`${inbox}\`,
decompose them into tasks, dispatch to your cluster's workers, track progress, and post a cluster
summary back to \`${ns}-status\` for the root. You do **NOT** write code.

**You are headless-safe.** Never call \`AskUserQuestion\` — no human is watching this session.
Any consent decision (prod deploys, migrations, irreversible actions) escalates to the root:
post \`type: "question", to: "root-orchestrator"\` on \`${ns}-status\` and wait for a
\`consent-grant\` / \`consent-deny\` in your inbox before proceeding.

The broker MCP server is wired into your session (\`http://localhost:${port}/mcp\`).
${v3Guide({ kind: "cluster-orch", ns, port, me: `${name}-orch` })}
## Cluster ownership — dispatch ONLY to these workers

| Worker | Inbox |
|---|---|
${registry}

Work for components outside your cluster → post a \`type: question\` to \`${ns}-status\` addressed
to \`root-orchestrator\`; never cross cluster boundaries yourself.

## Channels (keep an independent \`since_id\` cursor per channel)

- \`${inbox}\` — your inbox: goals + consent grants from root
- \`${ns}-control\` — broadcasts (check every turn)
- \`${statusCh}\` — your workers' feed: they post status/results here (monitor this)
- \`${ns}-status\` — cross-cluster: post cluster summaries + escalations here; do NOT use it for intra-cluster monitoring
- \`${ns}-telemetry\` — post your heartbeats here

## Turn-start ritual

0. Cold start only: \`register_capability(worker="${name}-orch", owns=[${JSON.stringify(name + "-cluster")}, ${comps.map((x) => JSON.stringify(x)).join(", ")}], channels=["${inbox}", "${statusCh}", "${ns}-status", "${ns}-telemetry"])\`.
1. \`turn_start(inbox_channel="${inbox}", control_channel="${ns}-control")\` (no since ids — the broker resumes from your server-side cursor; pass \`inbox_since_id\` only to page back)
   — if \`rotate_requested\`, follow the Rotation protocol.
2. \`read_messages(channel="${statusCh}", since_id=<last>)\` — update your cluster ledger
   (\`task_id → {worker, status, blockers, depends_on, dispatched_at}\`) from results and checkpoints.
   **Consent intercept**: a worker \`type: question\` mentioning consent → relay it to \`${ns}-status\`
   (\`to: "root-orchestrator"\`), wait for the grant in your inbox, forward it to the worker verbatim.
3. Handle root's \`type: task\` / \`type: question\` from your inbox; dispatch worker tasks as needed.

## Dispatching

Use the standard task envelope (see \`schemas/worker-inbox.json\`): one task = one deliverable,
\`task_id = <slug>-<YYYY-MM-DD>\`, always \`context\`, \`acceptance_criteria\`, \`files.write\`,
\`constraints\`; chain with \`depends_on\`. Your workers post results to \`${statusCh}\`.

## Cluster close (per sprint goal)

1. Confirm every dispatched task_id has \`type: result\` on \`${statusCh}\` and each result's body
   satisfies the task's \`acceptance_criteria\`.
${reviewer ? `2. Dispatch a review task to \`${ns}-reviewer\` (\`body: {"base": "main", "head": "HEAD", "checklist": [...]}\`),
   then \`wait_for_messages(channel="${ns}-status", filter_sender="reviewer", filter_type="result", timeout_ms=300000)\`.
   Verdict \`"block"\` → do NOT post the cluster summary; fix blocking findings first.
3. ` : `2. `}Post the cluster completion summary (\`type: result\`, \`from: "${name}-orch"\`, \`to: "root-orchestrator"\`)
   to \`${ns}-status\`.

## Idle — two-phase loop, then park

After dispatching, loop:
1. \`has_messages("${inbox}", since_id=<last>)\` — root sent something? Read and handle it.
2. \`wait_for_messages(channel="${statusCh}", since_id=<last>, filter_type="result", timeout_ms=25000)\`
   — wake on actual worker results, not notes/heartbeats.
After **3 consecutive empty polls with no open tasks in the ledger**: post an idle heartbeat to
\`${ns}-telemetry\` and **exit** — the watchdog restarts you when new work arrives.

## Rotation

On \`rotate_requested\` or context past ~150k tokens: post a ledger snapshot (\`type: status\`,
open task_ids + state) to \`${statusCh}\` AND \`${ns}-status\`, heartbeat \`state: "rotating"\`, exit.
`;
}

function scaffoldRoles({ project, ns, port, components, rolesDir, interactive, isolate, reviewer, patrols = [], clusters = null, judge = null, retro = false }) {
  const dir = resolve(OUT_DIR, rolesDir);
  mkdirSync(dir, { recursive: true });
  const written = [];
  const clusterFor = (w) => clusters?.find((cl) => cl.comps.includes(w)) || null;
  const files = [
    ["orchestrator.md", orchestratorRole({ project, ns, port, components, reviewer, clusters, judge, retro })],
    ...components.map((w) => {
      const cl = clusterFor(w);
      return [`${w}.md`, workerRole({
        project, ns, port, worker: w, isolate,
        statusChannel: cl ? `${ns}-${cl.name}-status` : undefined,
        orchestratorName: cl ? `${cl.name}-orch` : undefined,
      })];
    }),
    ...patrols.map((p) => [`${p.name}.md`, patrolRole({ project, ns, port, patrol: p })]),
    ...(clusters || []).map((cl) => [`${cl.name}-orch.md`, clusterOrchestratorRole({ project, ns, port, cluster: cl, reviewer })]),
    ...(reviewer ? [["reviewer.md", reviewerRole({ project, ns, port })]] : []),
    ...(judge ? [["judge.md", judgeRole({ project, ns, mode: judge })]] : []),
    ...(retro ? [["retro.md", retroRole({ project, ns })]] : []),
  ];
  for (const [name, content] of files) {
    const p = join(dir, name);
    if (existsSync(p) && interactive) { /* keep it simple: overwrite in scaffold */ }
    writeFileSync(p, content, "utf8");
    written.push(join(rolesDir, name));
  }
  return { dir: rolesDir, written };
}

// Writes a role into a CLAUDE.md without destroying the customer's own content.
// The role lives between markers; everything outside them is never touched:
//   - no file            → create it with the marked role block
//   - markers present    → replace only the marked section (idempotent re-runs)
//   - file == old role   → a pre-marker wizard install; rewrite it with markers
//   - anything else      → append the marked block, keep the existing content
// Claude Code reads CLAUDE.md hierarchically, so project conventions and the
// broker protocol compose either way.
const ROLE_START = "<!-- claude-broker:role:start (managed by setup.js — edits inside this section are overwritten on re-run) -->";
const ROLE_END = "<!-- claude-broker:role:end -->";
function writeRoleInto(dest, content) {
  const block = `${ROLE_START}\n${content.trimEnd()}\n${ROLE_END}\n`;
  if (!existsSync(dest)) { writeFileSync(dest, block, "utf8"); return "installed"; }
  const cur = readFileSync(dest, "utf8");
  const s = cur.indexOf(ROLE_START), e = cur.indexOf(ROLE_END);
  if (s >= 0 && e > s) {
    const next = cur.slice(0, s) + block.trimEnd() + cur.slice(e + ROLE_END.length);
    if (next === cur) return "up to date";
    writeFileSync(dest, next, "utf8");
    return "updated role section";
  }
  if (cur.trim() === content.trim()) { writeFileSync(dest, block, "utf8"); return "updated (added markers)"; }
  writeFileSync(dest, cur.trimEnd() + "\n\n" + block, "utf8");
  return "appended role (existing content kept)";
}

// Installs each worker's role into <project>/<component>/CLAUDE.md so the watchdog
// session picks it up. Skips missing dirs. With roleAppend=false, an existing
// CLAUDE.md is left alone entirely (legacy behavior, --no-role-append).
// baseDir: the directory whose <comp>/ subdir receives the role file as CLAUDE.md.
// Normal mode → the project (writes to <project>/<comp>/CLAUDE.md).
// Isolate mode → the worktree base (writes to <worktree-base>/<comp>/CLAUDE.md = the worktree root).
function installRoles({ baseDir, components, rolesDir, roleAppend = true }) {
  const srcDir = resolve(OUT_DIR, rolesDir);
  const results = [];
  for (const comp of components) {
    const src = join(srcDir, `${comp}.md`);
    const destDir = join(baseDir, comp);
    if (!existsSync(src)) { results.push({ comp, status: "no role file" }); continue; }
    if (!existsSync(destDir)) { results.push({ comp, status: "skipped — no dir" }); continue; }
    const dest = roleDestFile(destDir);
    if (!roleAppend && existsSync(dest)) { results.push({ comp, status: `skipped — ${basename(dest)} exists (--no-role-append)` }); continue; }
    const status = writeRoleInto(dest, readFileSync(src, "utf8"));
    results.push({ comp, status, path: dest.replace(dirname(baseDir) + "/", "") });
  }
  return results;
}

// Installs a role whose session dir does not pre-exist in the project (reviewer, patrol
// workers, cluster orchestrators): creates <project>/<destSubdir>/ and drops the role in
// as CLAUDE.md. These always run against the main checkout, never a worktree.
function installStandaloneRole({ project, rolesDir, roleFile, destSubdir, label, roleAppend = true }) {
  const src = resolve(OUT_DIR, rolesDir, roleFile);
  const destDir = join(project, destSubdir);
  if (!existsSync(src)) return { comp: label, status: "no role file" };
  mkdirSync(destDir, { recursive: true });
  const dest = roleDestFile(destDir);
  if (!roleAppend && existsSync(dest)) return { comp: label, status: `skipped — ${basename(dest)} exists (--no-role-append)` };
  const status = writeRoleInto(dest, readFileSync(src, "utf8"));
  return { comp: label, status, path: dest.replace(dirname(project) + "/", "") };
}
function installReviewerRole({ project, rolesDir, roleAppend }) {
  return installStandaloneRole({ project, rolesDir, roleFile: "reviewer.md", destSubdir: "reviewer", label: "reviewer", roleAppend });
}

// Wire the broker into a repo via .mcp.json at the repo root — the only project-level
// file Claude Code reads MCP servers from (.claude/settings.json mcpServers is ignored).
// Also pre-approves the server through enabledMcpjsonServers so sessions don't prompt,
// and git-excludes .mcp.json locally since it carries the bearer secret.
// identity ({ role, ns, as }) goes into the URL query (brokerMcpUrl): the project root gets the
// interactive orchestrator's role=orchestrator&ns=, a multi-repo component repo its worker's
// role=worker&ns=&as=. Headless watchdog sessions ignore this file's broker entry (--mcp-config).
function writeMcpConfig(repoRoot, port, secret, identity = {}) {
  const p = join(repoRoot, ".mcp.json");
  let cfg = {};
  if (existsSync(p)) {
    try { cfg = JSON.parse(readFileSync(p, "utf8")); }
    catch { return { path: p, status: "skipped — existing .mcp.json is not valid JSON" }; }
  }
  // Claude Code documents .mcp.json as a file to check in and share. If this repo already
  // tracks it, a literal secret would be committed — write a ${BROKER_SECRET} placeholder
  // instead (Claude Code expands ${VAR} in headers) and tell the operator to export it.
  const tracked = existsSync(join(repoRoot, ".git")) && git(repoRoot, "ls-files", "--error-unmatch", ".mcp.json").status === 0;
  cfg.mcpServers = cfg.mcpServers || {};
  cfg.mcpServers.broker = {
    type: "http",
    url: brokerMcpUrl(port, identity, cfg.mcpServers.broker?.url),
    headers: { Authorization: tracked ? "Bearer ${BROKER_SECRET}" : `Bearer ${secret}` },
  };
  writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  if (tracked) return { path: p, status: "written with ${BROKER_SECRET} placeholder (.mcp.json is tracked in git)", placeholder: true };

  // The secret must not land in version control: ignore .mcp.json locally (no-op if
  // already tracked or not a git repo — then the summary warning below still applies).
  const excludePath = join(repoRoot, ".git", "info", "exclude");
  if (existsSync(join(repoRoot, ".git"))) {
    try {
      mkdirSync(dirname(excludePath), { recursive: true });
      const cur = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
      if (!cur.split("\n").includes("/.mcp.json")) writeFileSync(excludePath, cur + (cur.endsWith("\n") || !cur ? "" : "\n") + "/.mcp.json\n", "utf8");
    } catch { /* best-effort */ }
  }

  // settings.json: pre-approve the broker server; drop a stale mcpServers block that an
  // older setup.js wrote there (Claude Code never read it).
  const sDir = join(repoRoot, ".claude");
  const sPath = join(sDir, "settings.json");
  let s = {};
  if (existsSync(sPath)) {
    try { s = JSON.parse(readFileSync(sPath, "utf8")); }
    catch { return { path: p, status: "written (settings.json invalid JSON — approve the broker server manually on first session)" }; }
  }
  if (s.mcpServers) { delete s.mcpServers.broker; if (!Object.keys(s.mcpServers).length) delete s.mcpServers; }
  s.enabledMcpjsonServers = [...new Set([...(s.enabledMcpjsonServers || []), "broker"])];
  mkdirSync(sDir, { recursive: true });
  writeFileSync(sPath, JSON.stringify(s, null, 2) + "\n", "utf8");
  return { path: p, status: "written" };
}

// Scope-guard hooks: deny the orchestrator (any session at the project root) direct edits
// to worker-owned directories — work there must be dispatched via the broker. Only safe in
// worktree modes: on a shared checkout the workers themselves run inside <project>/<comp>
// and would be blocked by their own guard. CLAUDE.md files stay editable (role updates).
// Re-runnable: previously generated entries are recognized by statusMessage and replaced.
const GUARD_EDIT_MSG = "Checking orchestrator scope boundary (Edit/Write)...";
const GUARD_BASH_MSG = "Checking orchestrator scope boundary (Bash)...";
function writeScopeGuardHooks({ project, ns, components }) {
  const sDir = join(project, ".claude");
  const sPath = join(sDir, "settings.json");
  let s = {};
  if (existsSync(sPath)) {
    try { s = JSON.parse(readFileSync(sPath, "utf8")); }
    catch { return { path: sPath, status: "skipped — existing settings.json is not valid JSON" }; }
  }
  // Hooks run under `sh -c` (dash on Debian/Ubuntu), so no bash-isms: `case` globbing instead
  // of [[ =~ ]]. The project path is shell-quoted and, for grep, regex-escaped, so a path with
  // spaces, dots or quotes can neither break the command nor widen the match.
  const sq = (v) => "'" + String(v).replace(/'/g, "'\\''") + "'";
  const ereEsc = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const inboxes = components.map((w) => `${ns}-${w}`).join(" / ");
  // A deny decision on stdout is honoured on exit 0; exit 2 would block without the reason text.
  const deny = (reason) =>
    `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"${reason.replace(/"/g, "")}"}}`;
  const editGlobs = components.map((w) => sq(`${project}/${w}/`) + "*").join("|");
  const editEntry = {
    matcher: "Edit|Write",
    hooks: [{
      type: "command",
      command: `path=$(jq -r '.tool_input.file_path // ""' 2>/dev/null); case "$path" in */CLAUDE.md|*/CLAUDE.local.md) exit 0;; esac; case "$path" in ${editGlobs}) printf '%s\\n' ${sq(deny(`Orchestrator must not edit worker directories directly. Dispatch via broker to the appropriate worker inbox (${inboxes}). Exception: CLAUDE.md files may be edited directly.`))}; exit 0;; esac; exit 0`,
      statusMessage: GUARD_EDIT_MSG,
    }],
  };
  const bashRe = `(>>|>|tee )[[:space:]]*${ereEsc(project)}/(${components.map(ereEsc).join("|")})/`;
  const bashEntry = {
    matcher: "Bash",
    hooks: [{
      type: "command",
      command: `cmd=$(jq -r '.tool_input.command // ""' 2>/dev/null); if printf '%s' "$cmd" | grep -qE ${sq(bashRe)}; then printf '%s\\n' ${sq(deny("Orchestrator must not write to worker directories via Bash redirection. Dispatch via broker to the appropriate worker."))}; exit 0; fi; exit 0`,
      statusMessage: GUARD_BASH_MSG,
    }],
  };
  s.hooks = s.hooks || {};
  const kept = (s.hooks.PreToolUse || []).filter(
    (e) => !(e.hooks || []).some((h) => h.statusMessage === GUARD_EDIT_MSG || h.statusMessage === GUARD_BASH_MSG));
  s.hooks.PreToolUse = [...kept, editEntry, bashEntry];
  mkdirSync(sDir, { recursive: true });
  writeFileSync(sPath, JSON.stringify(s, null, 2) + "\n", "utf8");
  return { path: sPath, status: "written" };
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  line();
  line(c.b("claude-broker setup"));
  line(c.dim("Configures this broker for one project. Re-runnable and non-destructive."));
  line();

  // 1. Project path
  let project = opts.project || (await ask("Path to the project repo to coordinate", ""));
  if (!project) { line(c.y("A project path is required (pass --project or answer the prompt).")); process.exit(1); }
  project = resolve(project);
  if (!existsSync(project) || !statSync(project).isDirectory()) {
    line(c.y(`Not a directory: ${project}`)); process.exit(1);
  }

  // 2. Components — in multi-repo mode, each sub-repo is a worker (and maps to its own repo path).
  let components, repoPathFor = null;
  if (opts.multiRepo) {
    const repos = detectRepos(project);
    if (!repos.length) {
      line(c.y(`  No git repositories found directly under ${project}. --multi-repo expects a folder of repos.`));
      if (rl) rl.close(); process.exit(1);
    }
    const map = {};
    for (const r of repos) map[sanitizeName(r)] = join(project, r);
    components = Object.keys(map);
    repoPathFor = (name) => map[name];
    line(`  Detected repos: ${c.b(components.join(", "))}`);
  } else {
    components = detectComponents(project).map(sanitizeName);
    if (components.length) {
      line(`  Detected components: ${c.b(components.join(", "))}`);
      if (interactive && !(await askYesNo("Use these?", true))) {
        const custom = await ask("Enter components (comma-separated)", components.join(","));
        components = custom.split(",").map((s) => sanitizeName(s.trim())).filter(Boolean);
      }
    } else {
      const custom = await ask("No components auto-detected — enter them (comma-separated)", "app");
      components = custom.split(",").map((s) => sanitizeName(s.trim())).filter(Boolean);
    }
  }
  components = [...new Set(components)];

  // 3. Namespace + port
  const ns = (opts.ns || (await ask("Namespace prefix (short, lowercase)", deriveNs(project)))).toLowerCase().replace(/[^a-z0-9]/g, "");
  const port = Number(opts.port || (await ask("Broker port", "8080"))) || 8080;

  // 3b. Patrol workers — autonomous sessions the watchdog wakes on an interval (QA, cost
  // review, SEO checks) in addition to inbox-driven wakes. --patrol name[:interval[:watch]].
  const patrols = opts.patrol.map((raw) => {
    const [name, interval, watch] = raw.split(":");
    return { name: sanitizeName(name), interval: Number(interval) || 1800, watch: watch || `${ns}-status` };
  });
  for (const p of patrols) {
    if (!p.name || components.includes(p.name) || p.name === "reviewer") {
      line(c.y(`  Invalid --patrol name "${p.name}" (empty, or collides with a component/reviewer).`)); if (rl) rl.close(); process.exit(1);
    }
  }

  // 3b'. Judge / retro workers (--judge full|hold, --retro): inboxes <ns>-judge / <ns>-retro.
  if (opts.judge !== null && !["full", "hold"].includes(opts.judge)) {
    line(c.y(`  Invalid --judge "${opts.judge}" (expected full or hold).`)); if (rl) rl.close(); process.exit(1);
  }
  for (const [on, name] of [[opts.judge, "judge"], [opts.retro, "retro"]]) {
    if (on && (components.includes(name) || patrols.some((p) => p.name === name))) {
      line(c.y(`  --${name} collides with a component or patrol named "${name}".`)); if (rl) rl.close(); process.exit(1);
    }
  }

  // 3c. Cluster tier — group components under mid-level orchestrators so the root
  // orchestrator dispatches sprint goals per cluster instead of per worker.
  // --clusters "platform:backend+devops;consumer:frontend"
  let clusters = null;
  if (opts.clusters) {
    clusters = opts.clusters.split(";").map((s) => {
      const [name, comps] = s.split(":");
      return { name: sanitizeName(name || ""), comps: (comps || "").split("+").map((x) => sanitizeName(x.trim())).filter(Boolean) };
    }).filter((cl) => cl.name);
    const seen = new Set();
    for (const cl of clusters) {
      if (components.includes(cl.name) || !cl.comps.length) {
        line(c.y(`  Invalid cluster "${cl.name}" (collides with a component, or has no members).`)); if (rl) rl.close(); process.exit(1);
      }
      for (const comp of cl.comps) {
        if (!components.includes(comp)) { line(c.y(`  Cluster "${cl.name}" member "${comp}" is not a detected component (${components.join(", ")}).`)); if (rl) rl.close(); process.exit(1); }
        if (seen.has(comp)) { line(c.y(`  Component "${comp}" appears in two clusters.`)); if (rl) rl.close(); process.exit(1); }
        seen.add(comp);
      }
    }
    if (!clusters.length) clusters = null;
  }
  // Which status channel a component reports to: its cluster's feed, or the global one.
  const clusterOf = (comp) => clusters?.find((cl) => cl.comps.includes(comp)) || null;
  const statusChannelFor = (comp) => { const cl = clusterOf(comp); return cl ? `${ns}-${cl.name}-status` : `${ns}-status`; };

  // 4. Secret (preserve existing)
  const preserved = existingSecret();
  const secret = preserved || randomBytes(32).toString("hex");

  // 5. Write .env
  const envPath = join(OUT_DIR, ".env");
  let writeEnv = true;
  if (existsSync(envPath) && interactive) {
    writeEnv = await askYesNo(`.env exists${preserved ? " (secret will be kept)" : ""} — overwrite it?`, true);
  }
  const tmuxBin = opts.tmux ? findTmux() : null;
  const tmuxSession = opts.tmuxSession || "claude-broker";
  // Union with any existing exemptions so a second project's setup keeps the first
  // project's backlog/retrospective channels prune-exempt.
  const prevPrune = existsSync(envPath)
    ? (readFileSync(envPath, "utf8").match(/^PRUNE_EXEMPT=(.*)$/m)?.[1] || "").split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const pruneExempt = [...new Set([...prevPrune, `${ns}-backlog`, `${ns}-sprint-retrospective`, `${ns}-notes`])].join(",");
  // Anything the wizard does not manage (PRUNE_MAX_AGE_MS, WORKERS_LOG_DIR, DB tuning, …) is
  // carried over verbatim, so a re-run — interactive or --yes — never silently drops settings.
  const MANAGED_ENV = new Set(["PORT", "SHARED_SECRET", "DB_PATH", "TELEMETRY_CHANNEL", "RATE_LIMIT_CHANNEL", "PRUNE_EXEMPT", "WORKERS_CONFIG", "WATCHDOG_BIN", "WORKERS_TMUX_SESSION", "TMUX_BIN"]);
  const preservedEnv = existsSync(envPath)
    ? readFileSync(envPath, "utf8").split("\n").filter((l) => { const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/); return m && !MANAGED_ENV.has(m[1]); })
    : [];
  if (preservedEnv.length) preservedEnv.unshift("", "# Preserved from the previous .env (not managed by setup)");
  if (writeEnv) {
    const env = [
      `# Generated by \`npm run setup\` for ${basename(project)}`,
      `PORT=${port}`,
      `SHARED_SECRET=${secret}`,
      `DB_PATH=./broker.db`,
      ``,
      `# Channel layout for this project`,
      `TELEMETRY_CHANNEL=${ns}-telemetry`,
      `RATE_LIMIT_CHANNEL=${ns}-rate-limits`,
      `PRUNE_EXEMPT=${pruneExempt}`,
      ``,
      `# Worker roster (list_workers reads this).`,
      `WORKERS_CONFIG=./workers.json`,
      `# Supervisor that start_worker spawns to run workers autonomously (ships with the broker).`,
      `# See docs/DEPLOYMENT.md#worker-supervision.`,
      `WATCHDOG_BIN=${join(SCRIPT_DIR, "watchdog.sh")}`,
      ...(tmuxBin ? [
        ``,
        `# Workers run headless in tmux windows; BROKER_SECRET is auto-injected per watchdog.`,
        `WORKERS_TMUX_SESSION=${tmuxSession}`,
        `TMUX_BIN=${tmuxBin}`,
      ] : []),
      ...preservedEnv,
      ``,
    ].join("\n");
    writeFileSync(envPath, env, "utf8");
  }

  // 5b. Git isolation. Two shapes:
  //   --isolate     : one repo, N worktrees (each worker a worktree of the same repo).
  //   --multi-repo  : N repos, each worker gets a worktree of ITS OWN repo.
  const useWorktrees = opts.isolate || opts.multiRepo;
  let worktreeBase = null;
  if (opts.multiRepo) {
    worktreeBase = opts.worktreeBase ? resolve(opts.worktreeBase) : join(project, ".claude-worktrees");
    mkdirSync(worktreeBase, { recursive: true });
    line(`\n  Multi-repo mode — one worktree per repo under ${c.b(worktreeBase)}`);
    let failed = false;
    for (const comp of components) {
      const res = createRepoWorktree(repoPathFor(comp), comp, join(worktreeBase, comp));
      line(`    ${res.status.startsWith("created") || res.status === "exists" ? c.g("✓") : c.y("•")} ${comp} → ${res.status}${res.wtPath ? ` (${res.branch})` : ""}`);
      if (res.status.startsWith("failed") || res.status.startsWith("skipped")) failed = true;
    }
    if (failed) { line(c.y("  Some repos could not be isolated — fix them (each needs ≥1 commit) and re-run.")); if (rl) rl.close(); process.exit(1); }
  } else if (opts.isolate) {
    worktreeBase = opts.worktreeBase ? resolve(opts.worktreeBase) : join(dirname(project), `${basename(project)}-workers`);
    line(`\n  Isolation mode — creating a git worktree per worker under ${c.b(worktreeBase)}`);
    const r = spawnSync("bash", [join(SCRIPT_DIR, "worktree-setup.sh"), "--project", project, "--worktree-base", worktreeBase, ...components], { stdio: "inherit" });
    if (r.status !== 0) {
      line(c.y("  worktree setup failed (is the project a git repo?). Aborting so you don't get an unsafe shared-checkout config."));
      if (rl) rl.close();
      process.exit(1);
    }
  }

  // 6. Write workers.json — worktree modes point each worker at its own worktree.
  const withModel = (w) => (opts.model ? { ...w, model: opts.model } : w);
  const workers = components.map((comp) => withModel({
    name: comp, ns,
    args: useWorktrees
      ? [comp, "--work-dir", join(worktreeBase, comp), "--inbox-channel", `${ns}-${comp}`]
      : [comp, "--repo-root", project, "--inbox-channel", `${ns}-${comp}`],
  }));
  // The reviewer always runs against the main checkout (read-only), never a worktree.
  if (opts.reviewer) workers.push(withModel({ name: "reviewer", ns, args: ["reviewer", "--repo-root", project, "--inbox-channel", `${ns}-reviewer`] }));
  // Patrol workers run against the main checkout too — the watchdog wakes them on the
  // interval (when the watch channel has news) as well as on inbox traffic.
  for (const p of patrols) {
    workers.push(withModel({
      name: p.name, ns,
      args: [p.name, "--repo-root", project, "--inbox-channel", `${ns}-${p.name}`,
             "--patrol-interval", String(p.interval), "--patrol-watch-channel", p.watch],
    }));
  }
  // The judge patrols <ns>-status every 300s; the retro is dispatched weekly (no patrol). Main checkout.
  if (opts.judge) {
    workers.push(withModel({
      name: "judge", ns,
      args: ["judge", "--repo-root", project, "--inbox-channel", `${ns}-judge`, "--patrol-interval", "300", "--patrol-watch-channel", `${ns}-status`],
    }));
  }
  if (opts.retro) workers.push(withModel({ name: "retro", ns, args: ["retro", "--repo-root", project, "--inbox-channel", `${ns}-retro`] }));
  // Cluster orchestrators live at <project>/orchestrators/<cluster> (main checkout).
  for (const cl of clusters || []) {
    workers.push(withModel({
      name: `${cl.name}-orch`, ns,
      args: [`orchestrators/${cl.name}`, "--repo-root", project, "--inbox-channel", `${ns}-${cl.name}-orch`],
    }));
  }
  const workersPath = join(OUT_DIR, "workers.json");
  // One broker can serve several projects: entries from OTHER namespaces are always kept,
  // so a second `npm run setup` never clobbers the first project's fleet.
  let keptWorkers = [];
  let writeWorkers = true;
  if (existsSync(workersPath)) {
    let existing = null;
    try { existing = JSON.parse(readFileSync(workersPath, "utf8")); } catch { /* unparseable → treat as plain overwrite below */ }
    if (Array.isArray(existing)) {
      keptWorkers = existing.filter((w) => w && w.ns && w.ns !== ns);
      const replacing = existing.length - keptWorkers.length;
      if (interactive) {
        writeWorkers = await askYesNo(
          keptWorkers.length
            ? `workers.json exists — replace its ${replacing} "${ns}" worker(s) and keep the ${keptWorkers.length} from other namespaces?`
            : "workers.json exists — overwrite it?", true);
      }
    } else if (interactive) {
      writeWorkers = await askYesNo("workers.json exists (not a valid worker array) — overwrite it?", true);
    }
  }
  // start_worker / tmux windows / logs are keyed by name, so names must be unique across
  // namespaces. On collision with a kept worker, prefix ours with the namespace (the
  // worker's session dir and inbox channel come from args, so behavior is unchanged).
  let renamedWorkers = [];
  if (writeWorkers && keptWorkers.length) {
    const taken = new Set(keptWorkers.map((w) => w.name));
    for (const w of workers) {
      if (taken.has(w.name)) { const nn = `${ns}-${w.name}`; renamedWorkers.push(`${w.name} → ${nn}`); w.name = nn; }
      taken.add(w.name);
    }
  }
  if (writeWorkers) writeFileSync(workersPath, JSON.stringify([...keptWorkers, ...workers], null, 2) + "\n", "utf8");

  // 7. Register starter schemas (best-effort, only if broker is up)
  let schemaResult = { ran: false, reason: "skipped (--no-schemas)" };
  if (opts.schemas) schemaResult = await registerSchemas({ port, secret, ns, components, reviewer: opts.reviewer, strict: opts.strictSchemas, patrols, clusters, judge: opts.judge, retro: opts.retro });

  // 7b. Scaffold role files. --install-roles, --isolate, --multi-repo all imply scaffolding.
  let roles = null;
  const wantScaffold = opts.scaffoldRoles || opts.installRoles || useWorktrees ||
    (interactive && (await askYesNo("Scaffold starter orchestrator + worker role files?", false)));
  if (wantScaffold) roles = scaffoldRoles({ project, ns, port, components, rolesDir: opts.rolesDir, interactive, isolate: useWorktrees, reviewer: opts.reviewer, patrols, clusters, judge: opts.judge, retro: opts.retro });

  // 7c. Install worker role files as CLAUDE.md where each session runs.
  // Worktree modes → the worktree root (auto). Otherwise → the project's component dir (opt-in).
  let installed = null;
  const installBase = useWorktrees ? worktreeBase : project;
  const doInstall = useWorktrees || opts.installRoles ||
    (interactive && (await askYesNo(`Install worker roles as CLAUDE.md into ${basename(project)}/<component>/? (writes into the project)`, false)));
  if (roles && doInstall) {
    installed = installRoles({ baseDir: installBase, components, rolesDir: opts.rolesDir, roleAppend: opts.roleAppend });
    if (opts.reviewer) installed.push(installReviewerRole({ project, rolesDir: opts.rolesDir, roleAppend: opts.roleAppend }));
    for (const p of patrols) {
      installed.push(installStandaloneRole({ project, rolesDir: opts.rolesDir, roleFile: `${p.name}.md`, destSubdir: p.name, label: p.name, roleAppend: opts.roleAppend }));
    }
    for (const name of [opts.judge && "judge", opts.retro && "retro"].filter(Boolean)) {
      installed.push(installStandaloneRole({ project, rolesDir: opts.rolesDir, roleFile: `${name}.md`, destSubdir: name, label: name, roleAppend: opts.roleAppend }));
    }
    for (const cl of clusters || []) {
      installed.push(installStandaloneRole({ project, rolesDir: opts.rolesDir, roleFile: `${cl.name}-orch.md`, destSubdir: join("orchestrators", cl.name), label: `${cl.name}-orch`, roleAppend: opts.roleAppend }));
    }
  }

  // 7d. Wire the broker into the project's .mcp.json so sessions opened there get
  // the mcp__broker__* tools with no manual `claude mcp add`.
  let mcpWritten = null;
  // Non-interactive (--yes) defaults to writing it: a fleet whose sessions cannot reach the
  // broker is not a working setup. --no-mcp-settings opts out.
  const doMcp = opts.mcpSettings === true ||
    (opts.mcpSettings !== false && (!interactive ||
      (await askYesNo(`Write broker MCP config into ${basename(project)}/.mcp.json? (carries the secret; git-excluded locally — fine for a local broker)`, true))));
  if (doMcp) {
    mcpWritten = opts.multiRepo
      ? components.map((comp) => writeMcpConfig(repoPathFor(comp), port, secret, { role: "worker", ns, as: comp }))
      : [writeMcpConfig(project, port, secret, { role: "orchestrator", ns })];
  }

  // 7e. Scope-guard hooks — keep the orchestrator out of worker-owned directories.
  // Worktree modes only: on a shared checkout the guard would block the workers themselves.
  let hooksWritten = null;
  if (useWorktrees) {
    const doHooks = opts.hooks === true ||
      (opts.hooks !== false && (!interactive ||
        (await askYesNo(`Add scope-guard hooks to ${basename(project)}/.claude/settings.json? (denies the orchestrator direct edits in worker dirs — dispatch via broker instead)`, true))));
    if (doHooks) hooksWritten = writeScopeGuardHooks({ project, ns, components });
  } else if (opts.hooks === true) {
    line(c.y("  • --hooks skipped: scope-guard hooks need --isolate or --multi-repo (on a shared checkout they would block the workers themselves)."));
  }

  if (rl) rl.close();

  // 8. Summary
  const channels = [
    `${ns}-status`, `${ns}-control`, `${ns}-telemetry`,
    ...components.map((x) => `${ns}-${x}`),
    ...patrols.map((p) => `${ns}-${p.name}`),
    ...(opts.judge ? [`${ns}-judge`] : []),
    ...(opts.retro ? [`${ns}-retro`] : []),
    ...(clusters || []).flatMap((cl) => [`${ns}-${cl.name}-orch`, `${ns}-${cl.name}-status`]),
    ...(opts.reviewer ? [`${ns}-reviewer`] : []),
    `${ns}-backlog`, `${ns}-sprint-retrospective`, `${ns}-notes`,
  ];
  line();
  line(c.g("✓ Setup complete"));
  line();
  line(`  ${c.b("Project")}     ${project}`);
  line(`  ${c.b("Namespace")}   ${ns}`);
  line(`  ${c.b("Components")}  ${components.join(", ")}${patrols.length ? ` (+ patrol: ${patrols.map((p) => `${p.name}@${p.interval}s`).join(", ")})` : ""}${opts.reviewer ? " (+ reviewer)" : ""}${opts.judge ? ` (+ judge: ${opts.judge})` : ""}${opts.retro ? " (+ retro)" : ""}`);
  if (clusters) line(`  ${c.b("Clusters")}    ${clusters.map((cl) => `${cl.name}[${cl.comps.join(",")}]`).join("  ")}`);
  if (opts.model) line(`  ${c.b("Model")}       ${opts.model} (per-worker default in workers.json; start_worker model arg overrides)`);
  line(`  ${c.b("Wrote")}       ${writeEnv ? ".env" : "(kept .env)"}, ${writeWorkers ? "workers.json" : "(kept workers.json)"}${keptWorkers.length ? ` (kept ${keptWorkers.length} worker(s) from other namespaces)` : ""}`);
  if (renamedWorkers.length) line(`  ${c.b("Renamed")}     ${renamedWorkers.join(", ")} ${c.dim("(worker names are registry-wide; behavior unchanged)")}`);
  line(`  ${c.b("Channels")}    ${channels.join(", ")}`);
  if (opts.multiRepo) {
    line(`  ${c.b("Isolation")}   multi-repo: one worktree per repo under ${worktreeBase} (branch worker/<name>)`);
  } else if (opts.isolate) {
    line(`  ${c.b("Isolation")}   git worktree per worker under ${worktreeBase} (branch worker/<name>)`);
  }
  line();
  if (opts.multiRepo) {
    line(`  ${c.g("✓")} Each worker owns its own repo, isolated on branch worker/<name> — safe for concurrent work.`);
    line(`    ${c.dim("At sprint close, merge each repo independently:")}`);
    for (const comp of components) {
      line(`    ${c.dim(`  ./sprint-close-merge.sh --project ${repoPathFor(comp)} --worktree-base ${worktreeBase} ${comp}`)}`);
    }
  } else if (opts.isolate) {
    line(`  ${c.g("✓")} Each worker has an isolated worktree on its own branch — safe for concurrent code changes.`);
    line(`    ${c.dim(`Merge a sprint back to main with:  ./sprint-close-merge.sh --project ${project} ${components.join(" ")}`)}`);
  }
  if (schemaResult.ran) {
    const ok = schemaResult.done.filter((d) => d.ok).length;
    line(`  ${c.g("✓")} Registered ${ok}/${schemaResult.done.length} starter schemas (${schemaResult.strict ? "strict" : "warn"} mode) on the running broker.`);
    if (!schemaResult.strict) line(`    ${c.dim("Malformed messages warn but still deliver. Re-run with --strict to reject them instead.")}`);
  } else {
    line(`  ${c.y("•")} Schemas not registered — ${schemaResult.reason}.`);
    line(`    Start the broker (${c.b(START_CMD)}), then re-run ${c.b(SETUP_CMD)} to register them.`);
  }
  if (roles) {
    line(`  ${c.g("✓")} Scaffolded ${roles.written.length} role files in ${c.b(roles.dir + "/")} (orchestrator + ${components.length} worker${components.length === 1 ? "" : "s"}${patrols.length ? ` + ${patrols.length} patrol` : ""}${opts.judge ? " + judge" : ""}${opts.retro ? " + retro" : ""}${clusters ? ` + ${clusters.length} cluster orchestrator${clusters.length === 1 ? "" : "s"}` : ""}).`);
    if (!installed) line(`    ${c.dim("Use each file as the CLAUDE.md / system prompt for that session (see below).")}`);
  }
  if (installed) {
    const isOk = (r) => r.status === "installed" || r.status.startsWith("updated") || r.status.startsWith("appended") || r.status === "up to date";
    const ok = installed.filter(isOk);
    const skipped = installed.filter((r) => !isOk(r));
    if (ok.length) line(`  ${c.g("✓")} Role protocol in place for ${ok.length} worker(s): ${ok.map((r) => `${r.path || r.comp}${r.status === "installed" ? "" : ` (${r.status})`}`).join(", ")}`);
    for (const s of skipped) line(`  ${c.y("•")} ${s.comp}: ${s.status}`);
    line(`    ${c.dim("Orchestrator role stays in roles/orchestrator.md — run the orchestrator interactively with it (not headless).")}`);
  }
  if (tmuxBin) {
    line(`  ${c.g("✓")} tmux mode on — start_worker launches each watchdog in tmux session ${c.b(tmuxSession)} (inspect: ${c.b(`tmux attach -t ${tmuxSession}`)}).`);
  } else if (opts.tmux) {
    line(`  ${c.y("•")} tmux not found — workers will run as detached subprocesses (logs in WORKERS_LOG_DIR). Install tmux and re-run to enable tmux windows.`);
  }
  if (mcpWritten) {
    for (const w of mcpWritten) {
      line(`  ${w.status === "written" || w.placeholder ? c.g("✓") : c.y("•")} MCP config ${w.status}: ${w.path}`);
    }
    if (mcpWritten.some((w) => w.placeholder)) {
      line(`    ${c.y("Export the secret in every shell that runs claude there:")} ${c.b(`export BROKER_SECRET=${secret}`)}`);
    }
  }
  if (hooksWritten) {
    line(`  ${hooksWritten.status === "written" ? c.g("✓") : c.y("•")} Scope-guard hooks ${hooksWritten.status}: ${hooksWritten.path}`);
    if (hooksWritten.status === "written") line(`    ${c.dim("Sessions at the project root are denied direct edits in worker dirs — dispatch via broker. Requires jq.")}`);
  }
  line();
  line(c.b("  Next steps:"));
  line(`    1. Start the broker:   ${c.b(START_CMD)}`);
  if (mcpWritten && mcpWritten.some((w) => w.status === "written")) {
    line(`    2. Sessions opened inside the project pick up the broker automatically (.mcp.json).`);
    line(c.dim(`       For sessions elsewhere: claude mcp add --transport http broker http://localhost:${port}/mcp \\`));
    line(c.dim(`         --header "Authorization: Bearer ${secret}"`));
  } else {
    line(`    2. Connect the orchestrator session (run inside the project; role=/ns= give it the v3 orchestrator tools):`);
    line();
    line(c.dim(`       claude mcp add -s local --transport http broker "${brokerMcpUrl(port, { role: "orchestrator", ns })}" \\`));
    line(c.dim(`         --header "Authorization: Bearer ${secret}"`));
  }
  line();
  line(`    3. Verify:             ${c.b(`curl -s localhost:${port}/health`)}`);
  line(`    4. Dashboard:          ${c.b(`http://localhost:${port}/dashboard`)}  (token: the secret above)`);
  line();
  line(c.dim("  Full runbook: CUSTOMER-SETUP.md"));
  line();
}

// Run as a script (also via the npm bin symlink); importing it (tests) only loads the exports.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((e) => { console.error("setup failed:", e.message); process.exit(1); });
