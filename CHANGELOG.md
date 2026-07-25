# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

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
