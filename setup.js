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
 * Flags: --project <path>  --ns <prefix>  --port <n>  --no-schemas  --yes/-y
 *        --scaffold-roles  --install-roles  --isolate  --multi-repo  --worktree-base <path>
 *        --no-reviewer  --no-tmux  --tmux-session <name>  --mcp-settings / --no-mcp-settings
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
  scaffoldRoles: has("--scaffold-roles"),
  installRoles: has("--install-roles"),
  isolate: has("--isolate"),
  multiRepo: has("--multi-repo"),
  worktreeBase: flag("--worktree-base"),
  rolesDir: flag("--roles-dir") || "roles",
  reviewer: !has("--no-reviewer"),
  tmux: !has("--no-tmux"),
  tmuxSession: flag("--tmux-session"),
  mcpSettings: has("--mcp-settings") ? true : has("--no-mcp-settings") ? false : null,
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
async function registerSchemas({ port, secret, ns, components, reviewer }) {
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
    ...components.map((comp) => [`${ns}-${comp}`, "worker-inbox.json"]),
    ...(reviewer ? [[`${ns}-reviewer`, "worker-inbox.json"]] : []),
  ];
  const done = [];
  for (const [channel, file] of plan) {
    const res = await client.callTool({ name: "register_channel_schema", arguments: { channel, schema: read(file), strict: false, version: "1.0" } });
    done.push({ channel, file, ok: !res.isError });
  }
  await client.close();
  return { ran: true, done };
}

// ── role scaffolding (optional) ──────────────────────────────────────────────
// Generates starter CLAUDE.md-style role files: one orchestrator + one per worker.
// Written to a local roles/ dir — never into the customer's project.
function orchestratorRole({ project, ns, port, components, reviewer }) {
  const registry = components.map((w) => `| \`${w}\` | \`${ns}-${w}\` | the ${w} component |`)
    .concat(reviewer ? [`| \`reviewer\` | \`${ns}-reviewer\` | code review — reads diffs, posts findings, never edits files |`] : [])
    .join("\n");
  const dispatch = components.map((w) => `\`${ns}-${w}\``).join(", ");
  const firstWorker = components[0] || "backend";
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
- ${dispatch} — worker inboxes (dispatch tasks here)
${reviewer ? `- \`${ns}-reviewer\` — code reviewer inbox (dispatch review tasks here)\n` : ""}- \`${ns}-status\` — firehose: workers post results + status here (monitor this)
- \`${ns}-telemetry\` — heartbeats (monitor for liveness with \`get_latest_heartbeats\`)
- \`${ns}-backlog\` — persistent deferred tasks — **NEVER purge**
- \`${ns}-sprint-retrospective\` — permanent sprint history — **NEVER purge**

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

function workerRole({ project, ns, port, worker, isolate }) {
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

If it does not print \`worker/${worker}\`: post a \`type: question\` to \`${ns}-status\` and **STOP** —
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
- \`${ns}-status\` — post all results + status here
- \`${ns}-telemetry\` — post heartbeats here

## Cold start (first turn of a session)

Advertise what you own, once per session:
\`register_capability(worker="${worker}", owns=["${worker}"], channels=["${ns}-${worker}", "${ns}-status", "${ns}-telemetry"])\`

## Turn-start ritual

1. \`turn_start(inbox_channel="${ns}-${worker}", telemetry_channel="${ns}-telemetry", worker="${worker}", ...)\`
   — records a heartbeat and returns your pending inbox in one call. (Manual equivalent:
   \`read_messages(channel="${ns}-${worker}", since_id=<last>)\` + \`upsert_heartbeat(channel="${ns}-telemetry", sender="${worker}", ...)\`.)
2. \`read_messages(channel="${ns}-control", since_id=<last>)\` — pick up broadcasts.
3. **Rotate check.** If any message is \`type: "rotate"\`, follow the Rotation protocol below and exit.
4. For each \`type: task\` addressed to \`${worker}\` or \`*\`:
   - **Idempotency FIRST**: \`check_result(channel="${ns}-status", task_id=<id>)\`. If \`found: true\`,
     post a \`type: note\` ("task <id> already done — skipping") and move on. Never re-run a task.
   - **Dependency gate**: if \`depends_on\` is set, verify each dependency's result is on \`${ns}-status\`.
     If missing: \`wait_for_messages(channel="${ns}-status", since_id=<last>, timeout_ms=270000)\`.
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

Post to \`${ns}-status\` (matches \`schemas/status.json\`):

\`\`\`json
{
  "type": "result",
  "task_id": "<the task_id you were given>",
  "from": "${worker}",
  "to": "orchestrator",
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
3. Post a \`type: status\` exit note ("inbox drained", last_task_id) to \`${ns}-status\`, then **exit**.

\`wait_for_messages\` is ONLY for \`depends_on\` blocking — never for idle polling.

**Before picking up the next queued task**: if your last heartbeat had \`rotation_recommended: true\`
(or context is past ~50% of the tier threshold), exit cleanly instead — the watchdog starts a fresh
session that picks it up with a clean context.

## Rotation protocol

On a \`type: "rotate"\` message, or when your context nears its limit: finish the current sub-task
(post its result/status), post a \`type: status\` to \`${ns}-status\` with \`handoff_notes\` (current
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

function scaffoldRoles({ project, ns, port, components, rolesDir, interactive, isolate, reviewer }) {
  const dir = resolve(OUT_DIR, rolesDir);
  mkdirSync(dir, { recursive: true });
  const written = [];
  const files = [
    ["orchestrator.md", orchestratorRole({ project, ns, port, components, reviewer })],
    ...components.map((w) => [`${w}.md`, workerRole({ project, ns, port, worker: w, isolate })]),
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

// Copies each worker's role file into <project>/<component>/CLAUDE.md so the watchdog
// session picks it up. Never overwrites an existing CLAUDE.md; skips missing dirs.
// baseDir: the directory whose <comp>/ subdir receives the role file as CLAUDE.md.
// Normal mode → the project (writes to <project>/<comp>/CLAUDE.md).
// Isolate mode → the worktree base (writes to <worktree-base>/<comp>/CLAUDE.md = the worktree root).
function installRoles({ baseDir, components, rolesDir }) {
  const srcDir = resolve(OUT_DIR, rolesDir);
  const results = [];
  for (const comp of components) {
    const src = join(srcDir, `${comp}.md`);
    const destDir = join(baseDir, comp);
    const dest = join(destDir, "CLAUDE.md");
    if (!existsSync(src)) { results.push({ comp, status: "no role file" }); continue; }
    if (!existsSync(destDir)) { results.push({ comp, status: "skipped — no dir" }); continue; }
    if (existsSync(dest)) { results.push({ comp, status: "skipped — CLAUDE.md exists" }); continue; }
    writeFileSync(dest, readFileSync(src, "utf8"), "utf8");
    results.push({ comp, status: "installed", path: dest.replace(dirname(baseDir) + "/", "") });
  }
  return results;
}

// The reviewer has no component dir of its own — it lives in <project>/reviewer/ (created
// here) and reviews the main checkout read-only, so it is safe in every isolation mode.
function installReviewerRole({ project, rolesDir }) {
  const src = resolve(OUT_DIR, rolesDir, "reviewer.md");
  const destDir = join(project, "reviewer");
  const dest = join(destDir, "CLAUDE.md");
  if (!existsSync(src)) return { comp: "reviewer", status: "no role file" };
  if (existsSync(dest)) return { comp: "reviewer", status: "skipped — CLAUDE.md exists" };
  mkdirSync(destDir, { recursive: true });
  writeFileSync(dest, readFileSync(src, "utf8"), "utf8");
  return { comp: "reviewer", status: "installed", path: dest.replace(dirname(project) + "/", "") };
}

// Wire the broker into a repo's .claude/settings.json (merge-preserving). Local-only:
// the file carries the bearer secret, which is fine for a localhost broker.
function writeMcpSettings(repoRoot, port, secret) {
  const dir = join(repoRoot, ".claude");
  const p = join(dir, "settings.json");
  let cfg = {};
  if (existsSync(p)) {
    try { cfg = JSON.parse(readFileSync(p, "utf8")); }
    catch { return { path: p, status: "skipped — existing file is not valid JSON" }; }
  }
  cfg.mcpServers = cfg.mcpServers || {};
  cfg.mcpServers.broker = {
    type: "http",
    url: `http://localhost:${port}/mcp`,
    headers: { Authorization: `Bearer ${secret}` },
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  return { path: p, status: "written" };
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
      `PRUNE_EXEMPT=${ns}-backlog,${ns}-sprint-retrospective`,
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
  const workers = components.map((comp) => ({
    name: comp, ns,
    args: useWorktrees
      ? [comp, "--work-dir", join(worktreeBase, comp), "--inbox-channel", `${ns}-${comp}`]
      : [comp, "--repo-root", project, "--inbox-channel", `${ns}-${comp}`],
  }));
  // The reviewer always runs against the main checkout (read-only), never a worktree.
  if (opts.reviewer) workers.push({ name: "reviewer", ns, args: ["reviewer", "--repo-root", project, "--inbox-channel", `${ns}-reviewer`] });
  const workersPath = join(OUT_DIR, "workers.json");
  let writeWorkers = true;
  if (existsSync(workersPath) && interactive) writeWorkers = await askYesNo("workers.json exists — overwrite it?", true);
  if (writeWorkers) writeFileSync(workersPath, JSON.stringify(workers, null, 2) + "\n", "utf8");

  // 7. Register starter schemas (best-effort, only if broker is up)
  let schemaResult = { ran: false, reason: "skipped (--no-schemas)" };
  if (opts.schemas) schemaResult = await registerSchemas({ port, secret, ns, components, reviewer: opts.reviewer });

  // 7b. Scaffold role files. --install-roles, --isolate, --multi-repo all imply scaffolding.
  let roles = null;
  const wantScaffold = opts.scaffoldRoles || opts.installRoles || useWorktrees ||
    (interactive && (await askYesNo("Scaffold starter orchestrator + worker role files?", false)));
  if (wantScaffold) roles = scaffoldRoles({ project, ns, port, components, rolesDir: opts.rolesDir, interactive, isolate: useWorktrees, reviewer: opts.reviewer });

  // 7c. Install worker role files as CLAUDE.md where each session runs.
  // Worktree modes → the worktree root (auto). Otherwise → the project's component dir (opt-in).
  let installed = null;
  const installBase = useWorktrees ? worktreeBase : project;
  const doInstall = useWorktrees || opts.installRoles ||
    (interactive && (await askYesNo(`Install worker roles as CLAUDE.md into ${basename(project)}/<component>/? (writes into the project)`, false)));
  if (roles && doInstall) {
    installed = installRoles({ baseDir: installBase, components, rolesDir: opts.rolesDir });
    if (opts.reviewer) installed.push(installReviewerRole({ project, rolesDir: opts.rolesDir }));
  }

  // 7d. Wire the broker into the project's .claude/settings.json so sessions opened
  // there get the mcp__broker__* tools with no manual `claude mcp add`.
  let mcpWritten = null;
  const doMcp = opts.mcpSettings === true ||
    (opts.mcpSettings !== false && interactive &&
      (await askYesNo(`Write broker MCP config into ${basename(project)}/.claude/settings.json? (writes the secret into the project — fine for a local broker)`, true)));
  if (doMcp) {
    const targets = opts.multiRepo ? components.map(repoPathFor) : [project];
    mcpWritten = targets.map((t) => writeMcpSettings(t, port, secret));
  }

  if (rl) rl.close();

  // 8. Summary
  const channels = [
    `${ns}-status`, `${ns}-control`, `${ns}-telemetry`,
    ...components.map((x) => `${ns}-${x}`),
    ...(opts.reviewer ? [`${ns}-reviewer`] : []),
    `${ns}-backlog`, `${ns}-sprint-retrospective`,
  ];
  line();
  line(c.g("✓ Setup complete"));
  line();
  line(`  ${c.b("Project")}     ${project}`);
  line(`  ${c.b("Namespace")}   ${ns}`);
  line(`  ${c.b("Components")}  ${components.join(", ")}${opts.reviewer ? " (+ reviewer)" : ""}`);
  line(`  ${c.b("Wrote")}       ${writeEnv ? ".env" : "(kept .env)"}, ${writeWorkers ? "workers.json" : "(kept workers.json)"}`);
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
    line(`  ${c.g("✓")} Registered ${ok}/${schemaResult.done.length} starter schemas (warn mode) on the running broker.`);
  } else {
    line(`  ${c.y("•")} Schemas not registered — ${schemaResult.reason}.`);
    line(`    Start the broker (${c.b("npm start")}), then re-run ${c.b("npm run setup")} to register them.`);
  }
  if (roles) {
    line(`  ${c.g("✓")} Scaffolded ${roles.written.length} role files in ${c.b(roles.dir + "/")} (orchestrator + ${components.length} worker${components.length === 1 ? "" : "s"}).`);
    if (!installed) line(`    ${c.dim("Use each file as the CLAUDE.md / system prompt for that session (see below).")}`);
  }
  if (installed) {
    const ok = installed.filter((r) => r.status === "installed");
    const skipped = installed.filter((r) => r.status !== "installed");
    if (ok.length) line(`  ${c.g("✓")} Installed ${ok.length} worker role file(s) into the project: ${ok.map((r) => r.path).join(", ")}`);
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
      line(`  ${w.status === "written" ? c.g("✓") : c.y("•")} MCP settings ${w.status}: ${w.path}`);
    }
  }
  line();
  line(c.b("  Next steps:"));
  line(`    1. Start the broker:   ${c.b("npm start")}`);
  if (mcpWritten && mcpWritten.some((w) => w.status === "written")) {
    line(`    2. Sessions opened inside the project pick up the broker automatically (.claude/settings.json).`);
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
