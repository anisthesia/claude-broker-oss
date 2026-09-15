# claude-broker — shared project knowledge

> **Subdirectory guard.** If your session was started inside a worker or
> orchestrator subdirectory (`orchestrators/infra/`, `workers/core/`,
> `workers/protocol-qa/`), your role and identity are defined **entirely** by
> that subdirectory's CLAUDE.md. This file contains only shared project
> knowledge — read it for codebase context, not instructions.

## What this is

`claude-broker` is a tiny MCP HTTP server that lets multiple Claude Code sessions
exchange messages over named channels. It is the coordination backbone for
multi-session AI workflows (dogsvilla, dollex, and its own maintenance team).

- **Transport**: Express + `@modelcontextprotocol/sdk` (Streamable HTTP)
- **Storage**: SQLite via `better-sqlite3` (WAL mode)
- **Validation**: Ajv JSON Schema on registered channels
- **Auth**: Bearer token (`SHARED_SECRET` env var)
- **Port**: 8080 (configurable via `PORT`)

## File ownership

| File / directory | Owner |
|---|---|
| `server.js` | core worker |
| `package.json`, `.env`, `.env.example` | core worker |
| `schemas/` | protocol-qa worker |
| `test-*.js` | protocol-qa worker |
| `setup-schemas*.js` | protocol-qa worker |
| `docs/protocol-v2.md` | protocol-qa worker |
| `workers-broker.json`, `workers-dogsvilla.json` | protocol-qa worker |
| `orchestrators/`, `workers/` (CLAUDE.md files only) | orchestrator |

## Essential commands

```bash
# Start broker (production)
npm start

# Start with auto-restart on file changes
npm run dev

# Run v2 test suite (exercises all MCP tools)
node test-v2.js

# Run schema validation tests
node test-schema-validation.js

# Run regression and fix tests
node test-fixes.js
node test-regression-fixes.js

# Register dogsvilla schemas (warn-only by default, STRICT=1 for strict)
node setup-schemas.js
STRICT=1 node setup-schemas.js

# Register dollex schemas
node setup-schemas-dollex.js
```

## Configuration (`.env`)

```
PORT=8080
SHARED_SECRET=<long random string>
DB_PATH=./broker.db
PRUNE_EXEMPT=dv-backlog,dv-sprint-retrospective,cb-backlog,dv-rate-limits
WATCHDOG_BIN=/Users/anis/myprojects/dogsvilla/scripts/watchdog.sh
WORKERS_CONFIG=/Users/anis/myprojects/claude-broker-oss/workers-dogsvilla.json
WORKERS_LOG_DIR=/Users/anis/myprojects/claude-broker-oss/worker-logs
```

## MCP tools exposed by server.js

`send_message`, `send_message_batch`, `read_messages`, `wait_for_messages`,
`has_messages`, `read_last`, `list_channels`, `purge_channel`,
`purge_channels_by_prefix`, `delete_message`, `check_result`,
`check_results_batch`, `get_latest_per_sender`, `post_gated_message`,
`register_channel_schema`, `get_channel_schema`, `clear_channel_schema`,
`list_channel_schemas`, `register_capability`, `deregister_capability`,
`list_capabilities`, `list_workers`, `start_worker`, `stop_worker`,
`upsert_heartbeat`, `get_latest_heartbeats`, `turn_start`,
`sprint_summary`, `sprint_file_conflicts`, `open_questions`,
`register_worker`, `deregister_worker`.

REST: `GET /health`, `GET /inbox` (optional `wait_ms` long-poll), `POST /inbox/batch`,
`POST /messages`, `GET|POST /workers…`, `GET /cost`, `GET /rate-limits`, `GET /metrics`,
`GET /dashboard`.

## Channel namespaces in use

| Prefix | Project |
|---|---|
| `dv-` | dogsvilla (primary client) |
| `dx-` | dollex-erp |
| `cb-` | claude-broker self-maintenance (this team) |

## Broker-self channel layout (`cb-` namespace)

| Channel | Purpose |
|---|---|
| `cb-orchestrator` | orchestrator inbox |
| `cb-core` | core worker inbox |
| `cb-protocol-qa` | protocol-qa worker inbox |
| `cb-control` | orchestrator broadcasts |
| `cb-status` | all workers post status + results |
| `cb-telemetry` | heartbeats |
| `cb-backlog` | persistent deferred tasks (NEVER purge) |

## Key design invariants

- Every `type: result` needs a `summary` field (`"PASS — ..."` / `"FAIL — ..."`)
- `consent_basis` is required on any result for a production-touching task
- Purge requires `AskUserQuestion` — no exceptions, no token bypass
- Channel schemas live in SQLite — hot-reload, no broker restart needed
- `wait_for_messages` is server-side long-poll (max 60s) — prefer over polling
