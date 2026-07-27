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
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { basename, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
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
    const cur = existsSync(ex) ? readFileSync(ex, "utf8") : "";
    if (!cur.split("\n").includes("/CLAUDE.md")) {
      writeFileSync(ex, cur + "\n# claude-broker: per-worker role file — never commit\n/CLAUDE.md\n");
    }
  } catch { /* best effort */ }
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
async function registerSchemas({ port, secret, ns, components, reviewer, strict, patrols = [], clusters = null }) {
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
    ...components.map((comp) => [`${ns}-${comp}`, "worker-inbox.json"]),
    ...patrols.map((p) => [`${ns}-${p.name}`, "worker-inbox.json"]),
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

// ── role scaffolding (optional) ──────────────────────────────────────────────
// Generates starter CLAUDE.md-style role files: one orchestrator + one per worker.
// Written to a local roles/ dir — never into the customer's project.
function orchestratorRole({ project, ns, port, components, reviewer, clusters }) {
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
  return `# Orchestrator — ${basename(project)}

## Identity

You are the **ORCHESTRATOR** for \`${basename(project)}\`. You manage a team of ${components.length} worker session(s).
You plan the work, split it into tasks, dispatch them to workers, watch for results and
conflicts, and gate merges. You do **NOT** write feature code yourself — you coordinate.

The broker MCP server is wired into your session (\`http://localhost:${port}/mcp\`); its tools are
available (\`send_message\`, \`read_messages\`, \`wait_for_messages\`, \`check_result\`, \`sprint_summary\`, …).

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
${clusterSection}
## Turn-start ritual

On the first turn of a session use \`since_id=0\` for every channel; remember the highest id seen
per channel and persist it across turns. Then, every turn:

1. \`read_messages(channel="${ns}-orchestrator", since_id=<last>)\` — your inbox.
2. \`read_messages(channel="${ns}-status", since_id=<last>)\` — new results, questions, blockers.
3. Update your task ledger (\`task_id → {worker, status, blockers}\`) from any \`type: result\`.
4. Answer any \`type: question\` addressed to you **first** — that worker is blocked until you do.
5. Worker health: if a result is overdue, \`list_workers\`; if the worker is stopped with a pending
   inbox, \`start_worker\` it (\`node check-worker-health.js --fix\` starts all stalled workers).

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

## Collecting results & gating the sprint

- \`check_result(channel="${ns}-status", task_id="…")\` — one task's latest result.
- \`check_results_batch(channel="${ns}-status", task_ids=[…])\` — many at once.
- \`sprint_summary(status_channel="${ns}-status")\` — dispatched/completed/failed/pending counts.
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
  items to \`${ns}-backlog\` before purging any channels.

## Rules

- One atomic task per dispatch; sequence with \`depends_on\` to avoid conflicts.
- Never \`purge_channel\` / \`purge_channels_by_prefix\` without explicit human confirmation
  (use AskUserQuestion) — deletion is irreversible.
- You coordinate; you do not write feature code.
`;
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
${gitSection}
## Channels

- \`${ns}-${worker}\` — your inbox (read first, every turn)
- \`${ns}-control\` — orchestrator broadcasts (check every turn)
- \`${status}\` — post all results + status here${status === `${ns}-status` ? "" : ` (your cluster's feed; \`${ns}-status\` is cross-cluster — don't post results there)`}
- \`${ns}-telemetry\` — post heartbeats here

## Cold start (first turn of a session)

Advertise what you own, once per session:
\`register_capability(worker="${worker}", owns=["${worker}"], channels=["${ns}-${worker}", "${status}", "${ns}-telemetry"])\`

## Turn-start ritual

1. \`turn_start(inbox_channel="${ns}-${worker}", telemetry_channel="${ns}-telemetry", worker="${worker}", ...)\`
   — records a heartbeat and returns your pending inbox in one call. (Manual equivalent:
   \`read_messages(channel="${ns}-${worker}", since_id=<last>)\` + \`upsert_heartbeat(channel="${ns}-telemetry", sender="${worker}", ...)\`.)
2. \`read_messages(channel="${ns}-control", since_id=<last>)\` — pick up broadcasts.
3. **Rotate check.** If any message is \`type: "rotate"\`, follow the Rotation protocol below and exit.
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
(post its result/status), post a \`type: status\` to \`${status}\` with \`handoff_notes\` (current
task_id, done vs pending, files touched), then **exit**. The watchdog restarts you; the new session
resumes from broker state.
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

## Channels

- \`${ns}-reviewer\` — your inbox (read first, every turn)
- \`${ns}-control\` — orchestrator broadcasts (check every turn)
- \`${ns}-status\` — post all findings + results here
- \`${ns}-telemetry\` — post heartbeats here

## Turn-start ritual

1. \`turn_start(inbox_channel="${ns}-reviewer", telemetry_channel="${ns}-telemetry", worker="reviewer", ...)\`
   — records a heartbeat and returns your pending inbox in one call.
2. \`read_messages(channel="${ns}-control", since_id=<last>)\` — pick up broadcasts.
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

## Channels

- \`${ns}-${name}\` — your inbox (read first, every turn)
- \`${ns}-control\` — orchestrator broadcasts (check every turn)
- \`${watch}\` — your patrol beat: read what changed since your last patrol
- \`${ns}-status\` — post all findings + results here
- \`${ns}-telemetry\` — post heartbeats here

## Turn-start ritual

1. \`turn_start(inbox_channel="${ns}-${name}", telemetry_channel="${ns}-telemetry", worker="${name}", ...)\`.
2. \`read_messages(channel="${ns}-control", since_id=<last>)\` — broadcasts; on \`type: rotate\`, exit cleanly.
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
1. \`turn_start(inbox_channel="${inbox}", control_channel="${ns}-control", inbox_since_id=<last>, control_since_id=<last>)\`
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

function scaffoldRoles({ project, ns, port, components, rolesDir, interactive, isolate, reviewer, patrols = [], clusters = null }) {
  const dir = resolve(OUT_DIR, rolesDir);
  mkdirSync(dir, { recursive: true });
  const written = [];
  const clusterFor = (w) => clusters?.find((cl) => cl.comps.includes(w)) || null;
  const files = [
    ["orchestrator.md", orchestratorRole({ project, ns, port, components, reviewer, clusters })],
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
    const dest = join(destDir, "CLAUDE.md");
    if (!existsSync(src)) { results.push({ comp, status: "no role file" }); continue; }
    if (!existsSync(destDir)) { results.push({ comp, status: "skipped — no dir" }); continue; }
    if (!roleAppend && existsSync(dest)) { results.push({ comp, status: "skipped — CLAUDE.md exists (--no-role-append)" }); continue; }
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
  const dest = join(destDir, "CLAUDE.md");
  if (!existsSync(src)) return { comp: label, status: "no role file" };
  if (!roleAppend && existsSync(dest)) return { comp: label, status: "skipped — CLAUDE.md exists (--no-role-append)" };
  mkdirSync(destDir, { recursive: true });
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
function writeMcpConfig(repoRoot, port, secret) {
  const p = join(repoRoot, ".mcp.json");
  let cfg = {};
  if (existsSync(p)) {
    try { cfg = JSON.parse(readFileSync(p, "utf8")); }
    catch { return { path: p, status: "skipped — existing .mcp.json is not valid JSON" }; }
  }
  cfg.mcpServers = cfg.mcpServers || {};
  cfg.mcpServers.broker = {
    type: "http",
    url: `http://localhost:${port}/mcp`,
    headers: { Authorization: `Bearer ${secret}` },
  };
  writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n", "utf8");

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
  const group = components.join("|");
  const inboxes = components.map((w) => `${ns}-${w}`).join(" / ");
  const deny = (reason) =>
    `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"${reason}"}}`;
  const editEntry = {
    matcher: "Edit|Write",
    hooks: [{
      type: "command",
      command: `path=$(jq -r '.tool_input.file_path // ""' 2>/dev/null); [[ "$path" =~ ${project}/(${group})/ ]] && [[ "$path" != */CLAUDE.md ]] && echo '${deny(`Orchestrator must not edit worker directories directly. Dispatch via broker to the appropriate worker inbox (${inboxes}). Exception: CLAUDE.md files may be edited directly.`)}' && exit 1; exit 0`,
      statusMessage: GUARD_EDIT_MSG,
    }],
  };
  const bashEntry = {
    matcher: "Bash",
    hooks: [{
      type: "command",
      command: `cmd=$(jq -r '.tool_input.command // ""' 2>/dev/null); echo "$cmd" | grep -qE '(>>|>|tee )\\s*${project}/(${group})/' && echo '${deny("Orchestrator must not write to worker directories via Bash redirection. Dispatch via broker to the appropriate worker.")}' && exit 1; exit 0`,
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
  const pruneExempt = [...new Set([...prevPrune, `${ns}-backlog`, `${ns}-sprint-retrospective`])].join(",");
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
  if (opts.schemas) schemaResult = await registerSchemas({ port, secret, ns, components, reviewer: opts.reviewer, strict: opts.strictSchemas, patrols, clusters });

  // 7b. Scaffold role files. --install-roles, --isolate, --multi-repo all imply scaffolding.
  let roles = null;
  const wantScaffold = opts.scaffoldRoles || opts.installRoles || useWorktrees ||
    (interactive && (await askYesNo("Scaffold starter orchestrator + worker role files?", false)));
  if (wantScaffold) roles = scaffoldRoles({ project, ns, port, components, rolesDir: opts.rolesDir, interactive, isolate: useWorktrees, reviewer: opts.reviewer, patrols, clusters });

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
    for (const cl of clusters || []) {
      installed.push(installStandaloneRole({ project, rolesDir: opts.rolesDir, roleFile: `${cl.name}-orch.md`, destSubdir: join("orchestrators", cl.name), label: `${cl.name}-orch`, roleAppend: opts.roleAppend }));
    }
  }

  // 7d. Wire the broker into the project's .mcp.json so sessions opened there get
  // the mcp__broker__* tools with no manual `claude mcp add`.
  let mcpWritten = null;
  const doMcp = opts.mcpSettings === true ||
    (opts.mcpSettings !== false && interactive &&
      (await askYesNo(`Write broker MCP config into ${basename(project)}/.mcp.json? (carries the secret; git-excluded locally — fine for a local broker)`, true)));
  if (doMcp) {
    const targets = opts.multiRepo ? components.map(repoPathFor) : [project];
    mcpWritten = targets.map((t) => writeMcpConfig(t, port, secret));
  }

  // 7e. Scope-guard hooks — keep the orchestrator out of worker-owned directories.
  // Worktree modes only: on a shared checkout the guard would block the workers themselves.
  let hooksWritten = null;
  if (useWorktrees) {
    const doHooks = opts.hooks === true ||
      (opts.hooks !== false && interactive &&
        (await askYesNo(`Add scope-guard hooks to ${basename(project)}/.claude/settings.json? (denies the orchestrator direct edits in worker dirs — dispatch via broker instead)`, true)));
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
    ...(clusters || []).flatMap((cl) => [`${ns}-${cl.name}-orch`, `${ns}-${cl.name}-status`]),
    ...(opts.reviewer ? [`${ns}-reviewer`] : []),
    `${ns}-backlog`, `${ns}-sprint-retrospective`,
  ];
  line();
  line(c.g("✓ Setup complete"));
  line();
  line(`  ${c.b("Project")}     ${project}`);
  line(`  ${c.b("Namespace")}   ${ns}`);
  line(`  ${c.b("Components")}  ${components.join(", ")}${patrols.length ? ` (+ patrol: ${patrols.map((p) => `${p.name}@${p.interval}s`).join(", ")})` : ""}${opts.reviewer ? " (+ reviewer)" : ""}`);
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
    line(`    Start the broker (${c.b("npm start")}), then re-run ${c.b("npm run setup")} to register them.`);
  }
  if (roles) {
    line(`  ${c.g("✓")} Scaffolded ${roles.written.length} role files in ${c.b(roles.dir + "/")} (orchestrator + ${components.length} worker${components.length === 1 ? "" : "s"}${patrols.length ? ` + ${patrols.length} patrol` : ""}${clusters ? ` + ${clusters.length} cluster orchestrator${clusters.length === 1 ? "" : "s"}` : ""}).`);
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
      line(`  ${w.status === "written" ? c.g("✓") : c.y("•")} MCP config ${w.status}: ${w.path}`);
    }
  }
  if (hooksWritten) {
    line(`  ${hooksWritten.status === "written" ? c.g("✓") : c.y("•")} Scope-guard hooks ${hooksWritten.status}: ${hooksWritten.path}`);
    if (hooksWritten.status === "written") line(`    ${c.dim("Sessions at the project root are denied direct edits in worker dirs — dispatch via broker. Requires jq.")}`);
  }
  line();
  line(c.b("  Next steps:"));
  line(`    1. Start the broker:   ${c.b("npm start")}`);
  if (mcpWritten && mcpWritten.some((w) => w.status === "written")) {
    line(`    2. Sessions opened inside the project pick up the broker automatically (.mcp.json).`);
    line(c.dim(`       For sessions elsewhere: claude mcp add --transport http broker http://localhost:${port}/mcp \\`));
    line(c.dim(`         --header "Authorization: Bearer ${secret}"`));
  } else {
    line(`    2. Connect each Claude Code session (run inside each project):`);
    line();
    line(c.dim(`       claude mcp add --transport http broker http://localhost:${port}/mcp \\`));
    line(c.dim(`         --header "Authorization: Bearer ${secret}"`));
  }
  line();
  line(`    3. Verify:             ${c.b(`curl -s localhost:${port}/health`)}`);
  line(`    4. Dashboard:          ${c.b(`http://localhost:${port}/dashboard`)}  (token: the secret above)`);
  line();
  line(c.dim("  Full runbook: CUSTOMER-SETUP.md"));
  line();
}

main().catch((e) => { console.error("setup failed:", e.message); process.exit(1); });
