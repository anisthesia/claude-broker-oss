# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
- **MCP wiring now lands where Claude Code actually reads it.** The wizard used to write the broker
  `mcpServers` entry into `<project>/.claude/settings.json`, a location Claude Code ignores for MCP
  servers — sessions in a freshly set-up project got no broker tools without a manual
  `claude mcp add`. It now writes `<project>/.mcp.json` (project-scope MCP config), pre-approves
  the server via `enabledMcpjsonServers` in `.claude/settings.json`, removes a stale `mcpServers`
  block left by earlier versions, and adds `/.mcp.json` to the repo's local `.git/info/exclude`
  so the bearer secret never lands in version control.

### Added
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
