# API Reference

The broker exposes two surfaces:

1. **MCP tools** — over `POST /mcp` (Streamable HTTP). This is what agent sessions use.
2. **HTTP endpoints** — plain REST/JSON, for health checks, lightweight polling, the dashboard, and worker control.

All authenticated requests carry `Authorization: Bearer <SHARED_SECRET>`.

---

## Message model

Every message is a row: `{ id, channel, sender, content, created_at }`. `id` is a
monotonically increasing integer per broker — clients track "last seen id" and ask for
everything after it. `content` is an arbitrary string (commonly JSON-as-string). Channels are
created implicitly on first write; there is no separate "create channel" step.

---

## MCP tools

### Messaging

| Tool | Purpose |
|---|---|
| `send_message` | Post one message to a channel. |
| `send_message_batch` | Post many messages in one call (atomic; aborts on schema failure). |
| `read_messages` | Read messages on a channel with `id` greater than `since_id`. |
| `read_last` | Read the most recent N messages on a channel. |

`read_messages`, `read_last` and `turn_start` accept `projection: "summary"`, which replaces each message body with its headline envelope fields (`type`, `task_id`, `from`, `to`, `subject`, `summary`, `bytes`) so an orchestrator can scan a long channel cheaply and then fetch only the messages it needs in full.
| `has_messages` | Cheap check: are there messages after `since_id`? Returns counts only. |
| `wait_for_messages` | **Server-side long-poll** (up to 60s). Returns as soon as a matching message arrives, or on timeout. Prefer this over busy-polling `read_messages`. Supports `filter_type`. |
| `delete_message` | Delete a single message by id. |
| `get_latest_per_sender` | One most-recent message per distinct sender on a channel. |
| `post_gated_message` | Post a message only once a set of dependency task-ids have posted results (dependency gate). |

### Results

| Tool | Purpose |
|---|---|
| `check_result` | Look up the latest `type:result` message for a `task_id` on a channel. |
| `check_results_batch` | Same, for up to 50 task-ids in one call. Returns `results` (task_id → found) and `summaries` (task_id → latest result summary or null). |

### Channel management

| Tool | Purpose |
|---|---|
| `list_channels` | List channels with message counts and last-activity. |
| `purge_channel` | Delete all (or older-than-`older_than_ms`) messages on a channel. Refuses channels in `PRUNE_EXEMPT` unless `force: true`. |
| `purge_channels_by_prefix` | Purge every channel whose name starts with a prefix. Skips `PRUNE_EXEMPT`. |

### Schemas

| Tool | Purpose |
|---|---|
| `register_channel_schema` | Attach a JSON Schema to a channel. `strict: true` rejects non-conforming messages; `strict: false` (default) logs a warning only. Optional `version` string. Omitting `strict` or `version` on re-registration keeps the channel's current values, so a schema refresh never silently downgrades a strict channel. |
| `get_channel_schema` | Fetch the schema registered on a channel. |
| `list_channel_schemas` | List all channels that have a schema. |
| `clear_channel_schema` | Remove a channel's schema. |

Schemas are stored in SQLite and hot-reloaded — no restart needed.

### Capabilities (service discovery)

| Tool | Purpose |
|---|---|
| `register_capability` | Advertise that a worker provides a named capability. |
| `list_capabilities` | Discover who provides what. |
| `deregister_capability` | Withdraw a capability. |

### Heartbeats & telemetry

| Tool | Purpose |
|---|---|
| `upsert_heartbeat` | Post/replace a worker's heartbeat (keeps one row per worker). |
| `get_latest_heartbeats` | Current heartbeat per worker, with an `online`/`offline` flag driven by `WORKER_OFFLINE_THRESHOLD_S`. |
| `turn_start` | Convenience call an agent makes at the start of a turn: reads its inbox and the control channel in one round-trip and reports whether a `rotate` was requested. It does not post a heartbeat — use `upsert_heartbeat` for that. |

### Sprint / coordination helpers

| Tool | Purpose |
|---|---|
| `sprint_summary` | Roll up dispatched/completed/failed/pending task counts for a status channel. |
| `sprint_file_conflicts` | Detect workers touching overlapping files (from result metadata). |
| `open_questions` | List `type: question` messages under a namespace prefix that have no later reply on the asker's inbox and no self-posted result — surfaces blocked workers at orchestrator turn-start. |

### Worker supervision (opt-in)

Active only when `WORKERS_CONFIG` / `WATCHDOG_BIN` are set. See
[DEPLOYMENT.md](DEPLOYMENT.md#worker-supervision).

| Tool | Purpose |
|---|---|
| `list_workers` | List configured workers and their running state. |
| `start_worker` | Spawn a worker's supervisor process (or tmux window). Optional `model` override. |
| `stop_worker` | Stop a worker (SIGTERM to its process group / kill its tmux window). |
| `register_worker` | Add/update a worker entry in `WORKERS_CONFIG`. Name must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. |
| `deregister_worker` | Remove a worker entry (must be stopped first). |

---

## HTTP endpoints

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /health` | none | Liveness probe: `{ ok, ts, uptime_s }`. |
| `GET /metrics` | bearer | In-memory counters since start: messages inserted, DB rows, long-poll totals, per-tool call/error/latency stats, per-route hit counts. |
| `POST /mcp` | bearer | The MCP transport endpoint. |
| `GET /inbox?channel=&since_id=[&wait_ms=]` | bearer | Lightweight pre-check: `{ pending, count, max_id }`. With `wait_ms` (max 60000) it long-polls and returns as soon as a message lands. |
| `POST /inbox/batch` | bearer | Same, for many channels in one body `{ "channel": since_id, ... }`. |
| `POST /messages` | bearer | Post a message over plain REST (body `{ channel, sender, content }`). |
| `GET /cost` | bearer or `?token=` | Aggregated session-cost rollup from `TELEMETRY_CHANNEL`. |
| `GET /rate-limits` | bearer or `?token=` | Rate-limit event log from `RATE_LIMIT_CHANNEL`. |
| `GET /workers` | bearer | Configured workers + running state (JSON). |
| `POST /workers/:name/start` | bearer | Start a worker. |
| `POST /workers/:name/stop` | bearer | Stop a worker. |
| `GET /dashboard` | bearer or `?token=` | HTML dashboard. |
| `GET /dashboard/channel` | bearer or `?token=` | HTML view of one channel. |

> `/health` is intentionally public so external supervisors/load balancers can probe it without
> credentials. Every other endpoint requires the secret when one is configured.
