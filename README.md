# claude-broker

**A tiny message broker that lets multiple AI agent sessions talk to each other.**

`claude-broker` is a small [MCP](https://modelcontextprotocol.io) HTTP server. Point
several [Claude Code](https://claude.com/claude-code) sessions (or any MCP client) at it and
they can exchange messages over named channels — the coordination backbone for multi-agent
workflows: an orchestrator dispatching tasks to workers, workers reporting results, heartbeats,
schema-validated protocols, and a live dashboard.

- **Transport** — Express + `@modelcontextprotocol/sdk` (Streamable HTTP)
- **Storage** — SQLite via `better-sqlite3` (WAL mode); a single file, no external services
- **Validation** — optional Ajv JSON-Schema enforcement, per channel, hot-reloadable
- **Auth** — shared bearer token, constant-time checked
- **Extras** — server-side long-poll, batch operations, capability registry, heartbeat/telemetry, an optional worker supervisor, and an HTML dashboard

---

## Requirements

- **Node.js ≥ 20** (uses the native `better-sqlite3` addon — a C toolchain is needed at install
  time; macOS ships one with Xcode CLT, most Linux distros need `build-essential`/`python3`).

## Quick start

```bash
git clone https://github.com/rideprodev/claude-broker.git
cd claude-broker
npm install

# Configure — at minimum set a strong SHARED_SECRET
cp .env.example .env
# edit .env, or generate a secret inline:
#   echo "SHARED_SECRET=$(openssl rand -hex 32)" >> .env

npm start
```

You should see:

```
[claude-broker] v2.1.0 listening on :8080  auth:on  prune:48h  exempt:[]
[claude-broker] dashboard: http://localhost:8080/dashboard
```

Check it's alive:

```bash
curl -s localhost:8080/health
# {"ok":true,...}
```

> The broker **refuses to start without `SHARED_SECRET`**. For a purely local, trusted setup you
> can run unauthenticated by setting `BROKER_ALLOW_NO_AUTH=1`, but never do that on an exposed host.

## Connect a Claude Code session

Register the broker as an MCP server (the bearer token must match `SHARED_SECRET`):

```bash
claude mcp add --transport http broker http://localhost:8080/mcp \
  --header "Authorization: Bearer <your-SHARED_SECRET>"
```

Now, in any session, the broker's tools are available. Two sessions can coordinate:

```
# Session A
send_message(channel="team-status", sender="alice", content="build is green")

# Session B
wait_for_messages(channel="team-status", since_id=0)   # long-polls until A posts
```

## A 60-second tour

```
send_message      — post a message to a channel
read_messages     — read messages after a given id
wait_for_messages — server-side long-poll (up to 60s); prefer over busy-polling
list_channels     — see active channels and message counts
purge_channel     — clear a channel
```

That's the core. There are ~30 tools in total — messaging, results, schemas, capabilities,
heartbeats, and worker supervision. See **[docs/API.md](docs/API.md)** for the full reference.

## The dashboard

Open **`http://localhost:8080/dashboard`** in a browser. It shows channels, message volume,
worker/heartbeat state, and (if you post cost/rate-limit telemetry) per-worker cost rollups.
Because browsers can't set an `Authorization` header on a plain page load, dashboard routes also
accept the secret as `?token=<secret>` — convenient locally, but see
**[docs/SECURITY.md](docs/SECURITY.md)** before exposing it.

## Schemas (optional)

Any channel can enforce a JSON Schema on message `content`. Register one and non-conforming
messages are rejected (or warned about). Example schemas — a task/result worker protocol — live
in [`schemas/`](schemas/); see [`schemas/README.md`](schemas/README.md).

```
register_channel_schema(channel="team-backend", schema=<json-schema>, strict=true)
```

## Worker supervision (optional, advanced)

The broker can supervise long-running agent processes via `start_worker` / `stop_worker` /
`list_workers`, driven by a `WORKERS_CONFIG` file (see [`workers.example.json`](workers.example.json))
and an external supervisor script you provide (`WATCHDOG_BIN`). This is an advanced,
opt-in subsystem — it stays dormant unless you configure it. See
**[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#worker-supervision)**.

## Configuration

All configuration is via environment variables (or `.env`). The full list, with defaults, is in
**[.env.example](.env.example)**. The essentials:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Listen port |
| `SHARED_SECRET` | — | Bearer token; **required** (or set `BROKER_ALLOW_NO_AUTH=1`) |
| `DB_PATH` | `./broker.db` | SQLite file |
| `PRUNE_MAX_AGE_MS` | 48h | Auto-delete messages older than this |
| `PRUNE_EXEMPT` | — | Channels never auto-pruned (comma-separated) |

## Testing

```bash
npm test          # spins up a scratch broker on a temp DB and runs every suite
```

The runner (`run-tests.js`) never touches your live `broker.db`.

## Documentation

- **[docs/API.md](docs/API.md)** — every MCP tool and HTTP endpoint
- **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** — production deployment, TLS, systemd/launchd, backups
- **[docs/SECURITY.md](docs/SECURITY.md)** — auth model, threat model, hardening checklist
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — how to contribute
- **[CHANGELOG.md](CHANGELOG.md)** — release history

## License

[MIT](LICENSE) © rideprodev
