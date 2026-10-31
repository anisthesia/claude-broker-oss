# claude-broker

**A persistent, schema-enforced message bus for fleets of Claude Code sessions that must outlive a single run.**

`claude-broker` is a small [MCP](https://modelcontextprotocol.io) HTTP server backed by one
SQLite file. Point several [Claude Code](https://claude.com/claude-code) sessions (or any MCP
client) at it and they exchange messages over named channels. Messages persist, so a worker that
restarts picks up exactly where it left off. Channels can enforce a JSON Schema, so a malformed
result is rejected instead of silently confusing the next reader. A gated-message primitive lets
a human approve a step before it lands. Everything is queryable afterwards, so you can read what
happened a week later.

It is the coordination backbone behind long-running orchestrator/worker setups: one session
dispatching tasks, several sessions doing them, reviewer and judge sessions checking the work,
heartbeats, schema-validated protocols, guardrail hooks, and a live dashboard.

- **Transport** — Express + `@modelcontextprotocol/sdk` (Streamable HTTP)
- **Storage** — SQLite via `better-sqlite3` (WAL mode); a single file, no external services
- **Validation** — Ajv JSON Schema per channel (hot-reloadable) plus per-namespace manifests built from typed base envelopes
- **Auth** — shared bearer token, constant-time checked; separate admin and verifier credentials for destructive or trust-bearing operations
- **Extras** — server-side long-poll, server-side read cursors, a derived task ledger, capability registry, heartbeat/cost telemetry, an optional worker supervisor, PreToolUse guardrails, and an HTML dashboard

## Where it runs

This is the public cut of the broker I run my own companies on. Since May 2026 it has coordinated
**161 Claude Code sessions across 15 projects** (product engineering plus a marketing team). From
June to October 2026 it carried **1,117 dispatched tasks, 375 code reviews by reviewer agents and
154 questions escalated to a human** for a decision. Every incident in that period became a guard
and a regression test, which is why the repo ships with 40+ test suites. One example: a worker
session once ran `pkill` against the broker it was talking through and restarted it on the wrong
port, an 18-minute outage. That is now a denied command in [`hooks/guardrails.mjs`](hooks/guardrails.mjs)
and a case in `test-guardrail-hooks.js`.

The history was squashed for publication and client-specific namespaces were removed; the
broker's own self-maintenance namespace (`cb`) and two small example namespaces are kept as
worked examples.

## Architecture

```
            ┌────────────────────────┐   ?role=orchestrator&ns=cb
            │ orchestrator (Claude   │ ──────────────┐
            │ Code, interactive)     │               │
            └────────────────────────┘               ▼
                                            ┌──────────────────────────────┐
  ?role=worker&ns=cb&as=core                │  claude-broker  (server.js)  │
 ┌──────────────┐  dispatch_task / result    │  MCP over Streamable HTTP    │
 │ worker: core │ ◄────────────────────────► │  Ajv schemas + manifests     │
 └──────────────┘                            │  SQLite (WAL) + cursors      │
 ┌──────────────┐  APPROVE / ADVISE / BLOCK  │  long-poll, task ledger      │
 │ reviewer     │ ◄────────────────────────► │  REST + dashboard            │
 └──────────────┘                            └──────────────┬───────────────┘
 ┌──────────────┐  held questions, findings                  │
 │ judge / retro│ ◄──────────────────────────────────────────┘
 └──────────────┘          ▲
        watchdog.sh / runner/ ─ launches, heartbeats, rotates and relaunches each session
```

- **Channels and namespaces.** Every project gets a namespace prefix (`cb-`, `pg-`, …) with an
  inbox per worker plus `-orchestrator`, `-status`, `-control`, `-telemetry`, `-backlog` and
  `-notes` channels. A manifest ([`schemas/manifests/`](schemas/manifests/)) declares the
  workers, their roles and which base envelope types each channel accepts.
- **Typed envelopes.** `task`, `result`, `question`, `status`, `finding`, `decision`, `plan` and
  friends are JSON Schemas in [`schemas/base/`](schemas/base/). v3 tools (`dispatch_task`,
  `post_result`, `ask`, `post_note`) build and validate the envelope server-side so a session
  cannot post a malformed one.
- **Roles.** A session connects as `worker`, `reviewer`, `orchestrator` or `admin`; each role sees
  only the tools it needs (measured from real usage to keep the tool list small). Only a reviewer
  may post `APPROVE`/`ADVISE`/`BLOCK`; only the orchestrator may dispatch; purging a durable
  channel needs the admin secret.
- **Rules ratchet.** Agents can make a namespace stricter on their own (register a stricter
  schema, flip a channel to strict, add a guardrail); loosening a rule needs a human-held
  credential. The judge worker answers blocked questions only from recorded decisions and holds
  anything else for a human.
- **Durability and recovery.** Server-side cursors per (worker, channel) mean a replacement
  session resumes exactly where the last one stopped; a handoff status rewinds the cursor so the
  task is seen again; the watchdog relaunches on silent exit, timeout or crash.
- **Verification.** A result's `required_checks` can be re-run by an independent verifier process
  holding its own token; the broker stores the verdict next to the result.
- **Cost governance.** Heartbeats carry context size and model usage; the runner writes a
  per-task usage ledger, and an hourly spend patrol posts a finding (and at 10x an escalation
  question to the orchestrator) when a namespace's spend jumps against its 7-day baseline.
- **Retro.** A weekly retro compacts a namespace's findings and decisions into a ≤6 KB knowledge
  file every worker reads at cold start, and proposes role-file edits for the human to accept.

## Do you need this?

Claude Code already ships several ways to run more than one agent. Most multi-agent needs are
covered by those, and the broker adds nothing for them. Reach for it only when the last row fits.

| You want to… | Use |
|---|---|
| Fan work out inside one task (review five files, try three approaches) | Built-in subagents / the Workflow tool. The parent keeps the result. |
| Let two sessions on one machine trade a few notes this afternoon | Built-in `SendMessage` and teams. |
| Run something every morning or every ten minutes | `/loop`, `/schedule`, cron. |
| Coordinate **independent, long-lived** sessions that must survive restarts, follow a message contract, pause for human consent, and leave an audit trail | **claude-broker.** |

If your sessions are short and one of them owns the outcome, stay with the built-ins. If workers
run for hours or days, get restarted, and hand each other work that has to be well-formed, a
durable bus with schemas is the missing piece. That is what this is.

---

## Requirements

- **Node.js ≥ 20** (uses the native `better-sqlite3` addon — a C toolchain is needed at install
  time; macOS ships one with Xcode CLT, most Linux distros need `build-essential`/`python3`).

## Install

From source (the package is not on npm yet):

```bash
git clone https://github.com/anisthesia/claude-broker-oss.git
cd claude-broker-oss
npm install
```

## Quick start

```bash
# Configure — the wizard writes .env + workers.json and generates a secret.
# Point --project at the repo you want to coordinate (or omit for a bare setup).
npm run setup -- --project /path/to/your/project
# (manual alternative: cp .env.example .env, then set SHARED_SECRET)

npm start
```

You should see:

```
[claude-broker] v2.2.1 listening on :8080  auth:on  prune:48h  exempt:[]
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
read_messages     — read messages after a given id, or resume from your server-side cursor
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

## Namespaces, roles and typed tools (protocol v3)

```bash
node setup.js --project /path/to/your/project --ns myapp --scaffold-roles   # wizard: .env, workers.json, manifest, role files
node setup-schemas-cb.js                                                   # or register a namespace's channel schemas by hand
```

Connect a session with its identity in the URL and it gets the typed tools for its role:

```
http://localhost:8080/mcp?role=worker&ns=myapp&as=backend
```

```
dispatch_task(to="backend", task_id="myapp-2026-11-01-a", subject="...", scope="small",
              checks=[{"name": "test", "run": "npm test", "pass_condition": "all pass"}])
post_result(task_id="myapp-2026-11-01-a", summary="PASS — ...", body={"required_checks": {...}, "commits": [...]})
ask(task_id="myapp-2026-11-01-a", question="A or B?")        # task shows as blocked until answered
get_task_ledger(status_channel="myapp-status", only_open=true)
```

The full design, including the plan gate, guardrails, model routing, verified checks and the
judge and retro workers, is in **[docs/protocol-v3.md](docs/protocol-v3.md)**. The broker's own
maintenance team (orchestrator, core, protocol-qa, reviewer, judge, retro) lives in
[`orchestrators/`](orchestrators/) and [`workers/`](workers/) as a worked example of the role files.

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
| `PRUNE_MAX_AGE_MS` | 48h | Auto-delete chatter (heartbeats, status, notes) older than this |
| `PRUNE_SIGNAL_MAX_AGE_MS` | 30d | Retention for signal-type messages (the audit trail) |
| `PRUNE_EXEMPT` | — | Channels never auto-pruned (comma-separated) |

## Testing

```bash
npm test          # spins up a scratch broker on a temp DB and runs every suite (40+)
```

The runner (`run-tests.js`) never touches your live `broker.db`.

## Documentation

- **[docs/API.md](docs/API.md)** — every MCP tool and HTTP endpoint
- **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** — production deployment, TLS, systemd/launchd, backups
- **[docs/SECURITY.md](docs/SECURITY.md)** — auth model, threat model, hardening checklist
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — how to contribute
- **[CHANGELOG.md](CHANGELOG.md)** — release history

## License

[MIT](LICENSE) © Anis Khan
