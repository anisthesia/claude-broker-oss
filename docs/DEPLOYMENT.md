# Deployment

The broker is a single Node process backed by a single SQLite file. There is nothing else to
run. This guide covers taking it from `npm start` on a laptop to a supervised, TLS-terminated
service.

## 1. Prerequisites

- Node.js ≥ 20 with a C toolchain (for `better-sqlite3`):
  - **macOS**: `xcode-select --install`
  - **Debian/Ubuntu**: `sudo apt-get install -y build-essential python3`
- A strong secret: `openssl rand -hex 32`

## 2. Install & configure

```bash
git clone https://github.com/rideprodev/claude-broker.git
cd claude-broker
npm ci --omit=dev
cp .env.example .env
# set SHARED_SECRET, DB_PATH (an absolute path in production), PORT
```

Put `DB_PATH` somewhere durable and backed up (e.g. `/var/lib/claude-broker/broker.db`).

## 3. TLS

The broker speaks plain HTTP and has **no built-in TLS**. Terminate TLS in front of it. The
bearer secret and the dashboard `?token=` travel in the clear over HTTP — treat HTTPS as
mandatory for any non-loopback deployment.

Minimal nginx reverse proxy:

```nginx
server {
  listen 443 ssl;
  server_name broker.example.com;
  ssl_certificate     /etc/letsencrypt/live/broker.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/broker.example.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_read_timeout 120s;   # wait_for_messages long-polls up to 60s
  }
}
```

Bind the broker itself to loopback (`PORT=8080`, proxy connects to `127.0.0.1:8080`) so it is
never reachable except through the proxy.

## 4. Process supervision

### systemd (Linux)

`/etc/systemd/system/claude-broker.service`:

```ini
[Unit]
Description=claude-broker
After=network.target

[Service]
Type=simple
User=claude-broker
WorkingDirectory=/opt/claude-broker
EnvironmentFile=/opt/claude-broker/.env
ExecStart=/usr/bin/node server.js
Restart=on-failure
# The broker handles SIGTERM: it drains connections, checkpoints the WAL, and closes the DB.
KillSignal=SIGTERM
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now claude-broker
journalctl -u claude-broker -f
```

### launchd (macOS)

A `~/Library/LaunchAgents/com.rideprodev.claude-broker.plist` with `ProgramArguments`
= `[node, /path/to/server.js]`, `KeepAlive`, and `EnvironmentVariables` (or a `.env` in the
working dir) works the same way. Note: launchd runs with a minimal `PATH`; if you use tmux worker
mode, set `TMUX_BIN` to the absolute tmux path.

## 5. Graceful shutdown

The broker installs `SIGTERM`/`SIGINT` handlers that stop accepting connections, run
`wal_checkpoint(TRUNCATE)`, close the database, then exit — so restarts are clean and the
`-wal` file doesn't grow unbounded. Give your supervisor ≥10s to let it drain.

## 6. Backups

Because it's one SQLite file, backups are simple. Prefer the online backup API so you don't copy
a half-written WAL:

```bash
sqlite3 /var/lib/claude-broker/broker.db ".backup '/backups/broker-$(date +%F).db'"
```

Message data is largely ephemeral (auto-pruned after `PRUNE_MAX_AGE_MS`, default 48h). The things
worth preserving are channel **schemas** and any `PRUNE_EXEMPT` backlog channels.

## 7. Housekeeping

A background pruner deletes messages older than `PRUNE_MAX_AGE_MS` every `PRUNE_INTERVAL_MS`.
Exempt persistent channels via `PRUNE_EXEMPT`. Tune these to your retention needs; the defaults
(48h age, 5-min interval) suit a busy coordination bus.

## 8. Upgrades

```bash
git pull
npm ci --omit=dev
sudo systemctl restart claude-broker
```

The schema is created/extended idempotently on boot (additive `ALTER TABLE`s). There is no
destructive migration step, so rolling forward is safe; keep a pre-upgrade backup regardless.

---

## Worker supervision

*Optional and advanced.* The broker can start/stop long-running agent processes so an
orchestrator agent can bring workers up and down over MCP. It stays completely dormant unless
you configure it.

**How it works.** `start_worker(name)` looks up `name` in the JSON file at `WORKERS_CONFIG`
and spawns `WATCHDOG_BIN` with that entry's `args`. `WATCHDOG_BIN` is **your** supervisor
executable — the contract is only "a program that takes these args and runs a worker until
killed." Two spawn modes:

- **Subprocess mode** (default): detached child; stdout/stderr go to
  `WORKERS_LOG_DIR/<name>.{out,err}.log`; stopped via SIGTERM to the process group.
- **tmux mode** (`WORKERS_TMUX_SESSION` set): each worker runs in its own tmux window; the broker
  injects `BROKER_SECRET`/`BROKER_URL`/`CLAUDE_*` env vars into the window.

**Config file** — see [`workers.example.json`](../workers.example.json):

```json
[
  { "name": "backend", "ns": "team", "args": ["backend", "--repo-root", "${REPO_ROOT}"] }
]
```

`${VAR}` placeholders in `args` are expanded from the broker's environment, so you can keep
machine-specific paths out of the file.

**Security note.** `register_worker` and `start_worker` let a token holder cause the broker to
spawn processes. Worker names are validated (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, no `..`) and
all spawn arguments are single-quoted before reaching a shell, so config values can't break out.
Still: only hand the bearer token to trusted operators, and point `WATCHDOG_BIN` at a script you
control. See [SECURITY.md](SECURITY.md).
