# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **`get_task_ledger(status_channel, since_id?, only_open?)`.** Derives the orchestrator's task
  ledger server-side: every `type: task` dispatched into the namespace's inboxes joined with the
  latest result, latest status/handoff and any open question per `task_id`, with a `state` of
  `pending` / `in-progress` / `handoff` / `blocked` / `done` / `failed` / `skipped`. Orchestrator
  role files call it at turn-start instead of rebuilding the ledger from `read_messages` after a
  rotation. `open_questions` now shares its scanner with it. `prefix` and `workers` scope it for
  cluster orchestrators whose status channel is `<ns>-<cluster>-status`.
- **`schemas/notes.json` and a `<ns>-notes` channel.** Durable shared knowledge between sessions:
  workers post `type: finding` (subject, ≤400-char `summary`, `scope` of files/areas, evidence) about
  code outside their ownership; the orchestrator posts `type: decision`; `type: resolved` closes one
  by `ref_id`. Every worker reads it with `projection: "summary"` at cold start; the orchestrator
  folds relevant notes into task `background`. The wizard registers it, adds it to `PRUNE_EXEMPT`,
  and `finding`/`decision` join `PRUNE_SIGNAL_TYPES` by default. `-notes` is excluded from the
  dispatched-task scans like the other meta channels.
- **Handoff loop closed in every role file.** A rotating worker's last message is a `type: status`
  with `task_id` and `body.handoff_notes` (`done`, `pending`, `files_touched`, `next_step`); the
  fresh session's turn-start ritual now checks `read_last` on the status channel for those notes
  before starting the inbox task and resumes from them. Before, the notes were written but nothing
  read them, so a rotated task restarted from scratch.

## [2.2.1] — 2026-09-16

### Fixed
- **Headless workers now always reach the broker that started them.** `watchdog.sh` launches every
  session with `--mcp-config <mode-600 temp file>` naming one `broker` server at `BROKER_URL/mcp`
  with the injected token (plus `--strict-mcp-config` when the CLI supports it). Before, a worker
  only had broker tools if its checkout carried a `.mcp.json` (worktrees never do) or the machine
  had a user-scope registration — which could point at a different broker entirely. Found by a
  fresh-install trial; `WATCHDOG_MCP=0` restores the old behaviour.
- The wizard's non-interactive mode (`--yes`) now writes `.mcp.json` and the scope-guard hooks by
  default (`--no-mcp-settings` / `--no-hooks` opt out); a `--yes` run used to skip both silently.

### Added
- `claude-broker-setup` bin, so a package install can run the wizard with `npx claude-broker-setup`;
  the wizard prints `npx claude-broker` / `npx claude-broker-setup` when it runs from `node_modules`.
- `watchdog.sh --once` (run one session, then exit) and `WATCHDOG_JITTER_MAX` (start-up jitter
  ceiling), used by the new `test-watchdog-launch.js`, which runs the real watchdog against a fake
  `claude` and pins the launch contract: cwd, flags, MCP config contents and cleanup, heartbeats,
  cursor advance, and the `WATCHDOG_MCP=0` opt-out.

### Changed
- CUSTOMER-SETUP.md describes the marker-based role install (append, `CLAUDE.local.md` for tracked
  files, `--no-role-append`) instead of the pre-2.1 "skip if exists" behaviour.

## [2.2.0] — 2026-09-15

### Added
- **`test-heartbeat-pipeline.js`** — regression guard for the 2026-07-08 heartbeat-pipeline repair:
  `watchdog.sh` must derive namespace-root sibling channels from multi-hyphen inbox names
  (`cb-protocol-qa` → `cb-telemetry`, `dv-backend-services` → `dv-telemetry`), and the v1.1
  telemetry schema must accept working / session-end beats with `exit_code` nested in `activity`
  (via `send_message` and `upsert_heartbeat`) while rejecting a top-level `exit_code`.
- **`watchdog.sh --print-channels`** prints the derived namespace, telemetry, status, rate-limits
  and patrol-watch channels and exits — for tests and debugging.
- `assess-dv-strict.js` takes channel names and/or `prefix-` arguments (any namespace), checks the
  most recent rows via `read_last` (`ASSESS_LIMIT`, default 50) instead of the oldest 20, reports
  named channels that have no rows yet, and counts non-JSON content as a violation (strict channels
  reject it).
- **`open_questions` tool** — lists `type: question` messages in a namespace that never got a reply on
  the asker's inbox (and no self-posted result), so blocked workers are visible at orchestrator turn-start.
- **`projection: "summary"`** on `read_messages`, `read_last` and `turn_start` — returns headline
  envelope fields only, so a 30-result scan costs ~3 KB instead of ~150 KB.
- **Compacting prune.** Chatter (heartbeats, status, notes, non-JSON) is pruned at `PRUNE_MAX_AGE_MS`
  (48h); signal types (`PRUNE_SIGNAL_TYPES`, default task/result/question/error/contract-*) live for
  `PRUNE_SIGNAL_MAX_AGE_MS` (30d).
- **Telemetry compaction.** On `*-telemetry` channels a new row from a sender evicts that sender's
  older transient-state rows (`HEARTBEAT_TRANSIENT_STATES`, default `working,idle-polling`), so
  30-second watchdog heartbeats posted via `POST /messages` no longer accumulate.
- **`GET /inbox?wait_ms=`** — server-side long-poll for watchdogs (max 60s), same response shape.
- **`GET /metrics`** — per-tool call/error/latency counters, long-poll wake ratio, per-route hits.
- `check_results_batch` now also returns `summaries` (latest result summary per task_id).
- `post_gated_message` accepts the envelope's `task_id:worker` form in `depends_on` and defaults
  `watch_channel` to `<ns>-status` for namespaced channels.
- `send_message_batch` reports warn-only schema mismatches per message instead of silently accepting.
- Ported the claude-broker self-maintenance fleet (`cb-` namespace: core, protocol-qa, infra-orch,
  cb-reviewer role files and turn-start helpers), the `/setup-broker` and `/teardown-broker` slash
  commands, `docs/protocol-v2.md`, and the per-project schema sets and registration scripts for the
  `cb`, `dv`, `dx`, `rp` and `sm` namespaces.

### Changed
- **Published as `@anisthesia/claude-broker`.** The unscoped `claude-broker` name on npm belongs to an
  unrelated project. The CLI/bin name stays `claude-broker`.
- **Telemetry envelope v1.1: `exit_code` lives in `activity`.** Every `schemas/*-telemetry.json`
  drops the top-level `exit_code` property (so `additionalProperties: false` rejects it) and declares
  `activity.exit_code` instead, with `activity.additionalProperties: false`. This matches what
  `watchdog.sh` has emitted since the pipeline repair.
- **15 warn-only channels promoted to strict** after the observation window (zero schema-warn lines):
  `cb-status`, `sm-status`, `rp-status`, `rp-control`, `rp-api`, `rp-admin`, `rp-web`, `rp-android`,
  `rp-ios`, `rp-qa`, `dx-control`, `dx-api`, `dx-web`, `dx-db`, `dx-qa`. The five dv channels stay
  warn-only — live violations on `dv-control`, `dv-customer-portal`, `dv-qa`.
- The cb `core` and `protocol-qa` workers run in their own git worktrees
  (`../claude-broker-oss-workers/<name>` on `worker/<name>`), so concurrent tasks can no longer
  commit onto whichever branch the shared checkout happens to have out.
- The npm package ships only the generic protocol schemas (`schemas/{backlog,cluster-status,control,
  reviewer-inbox,status,telemetry,worker-inbox}.json`). Per-project schema sets, registration scripts,
  fleet configs and role files stay in the repository but are not published.

### Fixed
- **`npx claude-broker` works.** `server.js` (the `bin` entry) was missing its `#!/usr/bin/env node`
  shebang, so the installed bin could not execute.
- **Branch-safety ritual never discards unpushed commits.** The core and protocol-qa role files
  used `git checkout -B worker/<name> origin/main` as a fallback, which once orphaned four unpushed
  commits. The ritual now refuses to reset a branch whose `origin/…..worker/<name>` log is non-empty:
  it switches without resetting, pushes, and stops with a `type: question` if the push fails.
- `workers/*/turn-start.js` fall back to `BROKER_SECRET` (what the watchdog injects) when
  `SHARED_SECRET` is not in the session environment.
- **Watchdogs survive a broker restart without becoming orphans.** Subprocess spawns write
  `WORKERS_LOG_DIR/<name>.pid`; at startup the broker re-adopts live pids that still run
  `WATCHDOG_BIN`, so `list_workers`/`stop_worker` work and `start_worker` cannot double-start.
- **Secrets are off command lines.** tmux workers get credentials via `new-window -e` (tmux ≥ 3.2;
  older versions fall back with a warning) and `watchdog.sh` sends the bearer token through a
  mode-600 curl config file instead of an `-H` argument visible in `ps`.
- **`watchdog.sh` no longer discards tasks on a silent clean exit.** For inbox-triggered runs the
  cursor advances only if the session posted to `<ns>-status`; silent runs are retried and the
  cursor moves on after three of them with a warning.
- **`watchdog.sh` posts `type: rate-limit` events** to `<ns>-rate-limits`, so `/rate-limits` and
  the dashboard panel show real data.
- **`sprint_summary` counts distinct tasks and judges each by its latest result**; re-posted or
  retried results no longer inflate "completed" or push "pending" negative. A bare `status` channel
  scopes dispatches across all channels instead of a nonsensical `status-%` pattern, and LIKE
  wildcards in namespace names are escaped.
- Dashboard cost / context-fill / model columns fall back to the sender's latest cost-bearing
  heartbeat when the newest row is a cost-less watchdog ping.
- `GET`/`DELETE /mcp` return a JSON-RPC-shaped 405 instead of an HTML 404. Removed the dead
  `test-client.js`.
- **Generated worker roles called a `turn_start` signature that does not exist** (`telemetry_channel`,
  `worker`). Roles now call `turn_start(inbox_channel, control_channel, …)` and post their heartbeat
  with `upsert_heartbeat` using an envelope that matches `schemas/telemetry.json`.
- **Role install no longer dirties isolated worktrees.** When the session dir already tracks a
  `CLAUDE.md`, the role is written to `CLAUDE.local.md` (which Claude Code loads alongside it) and
  excluded from git, so sprint-close preflight passes and `git add -A` cannot commit the role.
- **The wizard never writes the bearer secret into a tracked `.mcp.json`.** If the file is already
  in git it writes `"Bearer ${BROKER_SECRET}"` (Claude Code expands it) and prints the export line.
- **Scope-guard hooks are POSIX `sh`** (they were bash-only and silently inert under dash) and the
  project path is shell-quoted and regex-escaped, so paths with spaces or dots neither break nor
  widen the guard.
- **`--yes` no longer drops unmanaged `.env` settings.** Keys the wizard does not own
  (`PRUNE_MAX_AGE_MS`, `WORKERS_LOG_DIR`, …) are carried over under a "Preserved" header.
- **A missing or non-executable `WATCHDOG_BIN` no longer crashes the broker.** `start_worker` checks
  the binary up front and returns a tool error; the spawned process also gets an `error` handler so
  a late spawn failure is logged instead of raised as an uncaught exception.
- Dashboard Start/Stop buttons reflect tmux window state (previously only the in-memory map, so
  running workers showed "Start" after a broker restart).
- `register_worker` keeps `model` and other unmanaged fields when replacing an existing entry.
- The dashboard's JSON links to `/cost` and `/rate-limits` carry `?token=` and those routes accept
  it, so they no longer 401 under token auth.
- `.env.example` documents the watchdog-side variables (`BROKER_URL`, `BROKER_SECRET`, `CLAUDE_BIN`,
  `CLAUDE_MODEL`).
- **Strict schemas now reject non-JSON content.** Plain text on a strict channel was accepted
  unvalidated; it is now rejected (warn-only channels warn and accept).
- **Dashboard XSS.** The `ns` query parameter and namespaces derived from channel names were
  interpolated into the page unescaped. `ns` is now validated and tab/sprint labels are escaped.
- **Worker controls agree on tmux mode.** The REST routes behind the dashboard Start/Stop buttons
  spawned detached subprocesses even in tmux mode and could double-start a worker; MCP tools and
  REST now share one lifecycle (`workerRunningInfo`/`startWorker`/`stopWorker`).
- `purge_channel` honours `PRUNE_EXEMPT` (refuses unless `force: true`), as documented.
- `register_channel_schema` keeps the existing `strict`/`version` when they are omitted instead of
  silently downgrading a strict channel to warn-only.
- `get_latest_heartbeats` uses `WORKER_OFFLINE_THRESHOLD_S` for its stale check instead of a
  hard-coded 5 minutes; `sprint_summary` counts only summaries that start with `FAIL`.
- `WORKERS_CONFIG` is written atomically (temp file + rename) and non-array/invalid entries are ignored on load.
- MCP server advertises the real package version; `wait_for_messages` documents its actual 60s default.
- `/dashboard/channel` validates `limit`/`since_id` and uses prepared statements.
- `npm test` no longer inherits `WORKERS_TMUX_SESSION` from the live `.env` into the scratch broker.

### Fixed
- **MCP wiring now lands where Claude Code actually reads it.** The wizard used to write the broker
  `mcpServers` entry into `<project>/.claude/settings.json`, a location Claude Code ignores for MCP
  servers — sessions in a freshly set-up project got no broker tools without a manual
  `claude mcp add`. It now writes `<project>/.mcp.json` (project-scope MCP config), pre-approves
  the server via `enabledMcpjsonServers` in `.claude/settings.json`, removes a stale `mcpServers`
  block left by earlier versions, and adds `/.mcp.json` to the repo's local `.git/info/exclude`
  so the bearer secret never lands in version control.

### Added
- **Marker-based role install.** Role files now land in `CLAUDE.md` between
  `<!-- claude-broker:role:start/end -->` markers. An existing customer CLAUDE.md is no longer a
  silent dead end (previously the install skipped and workers launched with no broker protocol —
  guaranteed with a committed root CLAUDE.md in worktree mode): the role is appended below the
  existing content, re-runs replace only the marked section, and pre-marker wizard installs are
  upgraded in place. `--no-role-append` opts out.
- **Cluster-orchestrator tier.** `npm run setup -- --clusters "platform:backend+api;consumer:frontend"`
  scaffolds mid-level cluster orchestrators: each gets a `<ns>-<cluster>-orch` inbox, a private
  `<ns>-<cluster>-status` worker feed (new `schemas/cluster-status.json`), a headless-safe role
  (never prompts a human; consent escalates to the root orchestrator via `<ns>-status`), a
  `workers.json` entry, and a session dir at `<project>/orchestrators/<cluster>/`. Clustered
  workers report to their cluster feed; the root orchestrator role gains a cluster registry,
  goal-level dispatch, and a consent-relay protocol.
- **Patrol workers.** `--patrol <name[:interval[:watch-channel]]>` (repeatable) scaffolds
  autonomous workers the watchdog wakes on an interval when the watch channel has news (QA
  sweeps, cost review), with role file, inbox channel, schema, and `workers.json` entry using
  the watchdog's existing `--patrol-interval` / `--patrol-watch-channel` flags.
- **Per-worker model.** `workers.json` entries may carry a `"model"` field; `start_worker`
  (MCP and HTTP) now uses it as the worker's default session model, still overridable by the
  explicit `model` argument. The wizard stamps it with `--model <id>`; `list_workers` shows it.
- **Multi-project merge.** Re-running setup for a second project on the same broker no longer
  clobbers the first: `workers.json` keeps entries from other namespaces, `.env` `PRUNE_EXEMPT`
  is unioned across namespaces, and colliding worker names are auto-prefixed with the namespace
  (names are registry-wide keys for `start_worker`/tmux/logs; behavior is otherwise unchanged).
- **Backlog and reviewer schemas.** New `schemas/backlog.json` (deferred/deferred-resolved/
  retrospective envelope for the persistent `<ns>-backlog` and `<ns>-sprint-retrospective`
  channels) and `schemas/reviewer-inbox.json` (review-task envelope requiring a
  `base`/`head`/`checklist` body). The wizard now registers both, and the reviewer inbox uses the
  dedicated schema instead of the generic worker-inbox one.
- **`--strict` schema registration.** `npm run setup -- --strict` registers all starter schemas
  with `strict: true` (malformed messages are rejected, not just warned about). Default remains
  warn mode; the summary now says which mode was used.
- **Orchestrator scope-guard hooks** (`--hooks` / `--no-hooks`, interactive prompt in worktree
  modes). The wizard can add `PreToolUse` hooks to `<project>/.claude/settings.json` that deny
  sessions at the project root direct `Edit`/`Write` or Bash-redirection access to worker-owned
  directories, pointing them at the broker inboxes instead (`CLAUDE.md` files stay editable;
  requires `jq`). Offered only with `--isolate`/`--multi-repo` — on a shared checkout the guard
  would block the workers themselves. Re-runnable: previously generated entries are replaced,
  other hooks are preserved.

### Changed
- **Scaffolded role files now encode the full operational protocol**, not just the core loop. Worker
  roles gained: cold-start capability registration, idempotency-first (`check_result` before running),
  dependency gating (`depends_on` + `wait_for_messages`), envelope-field discipline
  (`context`/`constraints`/`files.write`/`scope`/`checks`/`acceptance_criteria`), a commit protocol,
  a consent-basis-aware result envelope, the drain-and-exit idle loop, and a rotation protocol.
  Orchestrator roles gained the full task envelope, dependency chaining, acceptance-criteria
  verification before closing, and `sprint_file_conflicts` gating. All examples validated against the
  strict schemas. (Roles roughly doubled in depth — the behavioral protocol now matches the data
  contract the schemas already enforce.)

### Added
- **Multi-repo (polyrepo) support.** `npm run setup --multi-repo` treats a folder of separate git
  repos as the project: each sub-repo becomes a worker with a worktree of *its own* repo on a
  `worker/<name>` branch. `sprint-close-merge.sh` is run once per repo to integrate each
  independently. Non-repo directories are ignored.
- **Git isolation for concurrent workers.** `npm run setup --isolate` gives each worker its own
  git worktree on a `worker/<name>` branch, so parallel workers can't clobber each other on a
  shared checkout. Ships two scripts: `worktree-setup.sh` (creates the worktrees) and
  `sprint-close-merge.sh` (merges worker branches into main with a dirty-tree preflight and
  phase-scoped recovery advice, then resets worktrees). Isolated worker role files gain a
  branch-safety turn-start ritual, and the per-worker root `CLAUDE.md` is auto-excluded from
  commits so it never pollutes a merge. The watchdog gained `--work-dir` to run a session at a
  worktree root.

- **`watchdog.sh`** — a bundled worker supervisor. `start_worker` now spawns autonomous,
  on-demand worker sessions out of the box (poll inbox → launch on pending work → drain → exit →
  restart), with rate-limit backoff, a max-session ceiling, a concurrency cap, and heartbeats.
  `npm run setup` wires `WATCHDOG_BIN` automatically. Depends only on `node` + `curl`.

### Changed
- Subprocess-mode workers now receive `BROKER_URL` and `BROKER_SECRET` from the broker, so the
  watchdog can poll the now-authenticated `/inbox` and post heartbeats.

## [2.1.0] — 2026-07-25

First public release. Hardened and cleaned for general use.

### Security
- **Auth is now required by default.** The broker refuses to start without `SHARED_SECRET`
  unless `BROKER_ALLOW_NO_AUTH=1` is set explicitly.
- Bearer-token comparison is now **constant-time** (`crypto.timingSafeEqual`) everywhere.
- **`GET /inbox` and `POST /inbox/batch` now require authentication** (previously public). Clients
  that poll these — including worker watchdogs — must send the bearer token.
- **Worker names are validated** (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, no `..`) before use as log
  paths or tmux window names, closing a path-traversal vector in `register_worker`/`start_worker`.
- **tmux worker spawns single-quote all arguments and the binary path**, closing a shell
  command-injection vector via worker config / `register_worker` input.

### Added
- Graceful shutdown: `SIGTERM`/`SIGINT` drain connections, checkpoint the WAL, and close the DB.
- `TELEMETRY_CHANNEL` / `RATE_LIMIT_CHANNEL` env vars make the `/cost` and `/rate-limits` dashboard
  views work for any channel naming (no longer hardcoded).
- Product documentation: `docs/API.md`, `docs/DEPLOYMENT.md`, `docs/SECURITY.md`,
  `CONTRIBUTING.md`, and this changelog.
- `LICENSE` (MIT); `package.json` now carries `engines`, `license`, `repository`, and `bin`.
- Generic example schemas (`schemas/`) and `workers.example.json`.

### Changed
- Version string is read from `package.json` (no longer hardcoded).
- Defaults are namespace-neutral; project-specific channels and configs have been removed from the
  distribution.
