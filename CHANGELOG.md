# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
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

### Fixed
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
