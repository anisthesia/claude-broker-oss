# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
