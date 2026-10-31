# claude-broker — shared project knowledge

> **Subdirectory guard.** If your session was started inside a worker or
> orchestrator subdirectory (`orchestrators/infra/`, `workers/core/`,
> `workers/protocol-qa/`), your role and identity are defined **entirely** by
> that subdirectory's CLAUDE.md. This file contains only shared project
> knowledge — read it for codebase context, not instructions.

## What this is

`claude-broker` is a tiny MCP HTTP server that lets multiple Claude Code sessions
exchange messages over named channels. It is the coordination backbone for
multi-session AI workflows (several client projects and its own maintenance team).

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
| `workers.json` | protocol-qa worker |
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

# Register the broker's own (cb) channel schemas (warn-only by default, STRICT=1 for strict)
node setup-schemas-cb.js
STRICT=1 node setup-schemas-cb.js

# Run every suite against a scratch broker
npm test
```

## Configuration (`.env`)

```
PORT=8080
SHARED_SECRET=<long random string>
DB_PATH=./broker.db
PRUNE_EXEMPT=cb-backlog,cb-notes,cb-held
WATCHDOG_BIN=/path/to/claude-broker/watchdog.sh
WATCHDOG_REPO_ROOT=/path/to/your-project               # for entries without --repo-root
WATCHDOG_MCP_INHERIT=1                                # sessions keep user/project MCP servers
WATCHDOG_ROLE_NAMESPACES=                             # namespaces opted in to ?role= (empty = none)
WORKERS_CONFIG=/path/to/claude-broker/workers.json
WORKERS_LOG_DIR=/path/to/claude-broker/worker-logs
```

`WATCHDOG_BIN` switched from the client project's script to the bundled `watchdog.sh` at v3 go-live
(2026-10-21). Running watchdogs keep the script they started with until `stop_worker` +
`start_worker`. Every `WATCHDOG_*` variable reaches tmux-launched watchdogs.

## MCP tools exposed by server.js

Server code is `server.js` (entry) + `lib/` modules. Protocol v3 reference: `docs/protocol-v3.md`.

v2 tools (34) — what a session sees with no `?role=` (byte-identical to pre-v3):

`send_message`, `send_message_batch`, `read_messages`, `wait_for_messages`,
`has_messages`, `read_last`, `list_channels`, `purge_channel`,
`purge_channels_by_prefix`, `delete_message`, `check_result`,
`check_results_batch`, `get_latest_per_sender`, `post_gated_message`,
`register_channel_schema`, `get_channel_schema`, `clear_channel_schema`,
`list_channel_schemas`, `register_capability`, `deregister_capability`,
`list_capabilities`, `list_workers`, `start_worker`, `stop_worker`,
`upsert_heartbeat`, `get_latest_heartbeats`, `turn_start`, `worker_cursor`,
`sprint_summary`, `sprint_file_conflicts`, `open_questions`, `get_task_ledger`,
`register_worker`, `deregister_worker`.

v3 tools (7) — only visible with `?role=`: `get_message` (one message or one field by path),
`register_namespace`, `get_namespace` (manifests), `dispatch_task`, `post_result`, `ask`,
`post_note` (typed envelopes built and validated server-side).

Connection identity: `/mcp?role=<worker|reviewer|orchestrator|admin>&ns=<ns>&as=<name>`. A role
shows only that profile's tools (`lib/profiles.js`, built from measured usage); `admin` sees all
41; no role = the 34 v2 tools regardless of `ns`/`as`. The watchdog sends `?ns=&as=` and adds
`role=` only for namespaces opted in via `WATCHDOG_ROLE_NAMESPACES` (or `WATCHDOG_ROLE_URL=1`).

REST: `GET /health`, `GET /inbox` (optional `wait_ms` long-poll), `POST /inbox/batch`,
`POST /messages`, `GET|PUT /cursors`, `GET|POST /workers…`, `GET /cost`, `GET /rate-limits`, `GET /metrics`,
`GET /dashboard`.

## Channel namespaces in use

| Prefix | Project |
|---|---|
| `cb-` | claude-broker self-maintenance (this team) |
| `pg-`, `ca-` | example client namespaces kept as worked examples (`schemas/manifests/`) |

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
| `cb-notes` | shared team knowledge: workers' findings + orchestrator decisions, `schemas/notes.json` (NEVER purge) |

## Key design invariants

- Every `type: result` needs a `summary` field (`"PASS — ..."` / `"FAIL — ..."`)
- `consent_basis` is required on any result for a production-touching task
- Purge requires `AskUserQuestion` — no exceptions. Server-side: a `PRUNE_EXEMPT` channel can only
  be purged with `force=true` **and** `admin_token` = the broker's `ADMIN_SECRET`, which worker
  sessions do not hold; `delete_message` on an exempt channel only works for the message's own
  sender (`sender=`), otherwise post `type: resolved`
- Channel schemas live in SQLite — hot-reload, no broker restart needed
- v3 validation: built-in base types (`schemas/base/`) + a per-namespace manifest
  (`schemas/manifests/<ns>.json`, `register_namespace`). A channel's v2 schema, if registered,
  always wins over its manifest; manifests are warn-only unless `strict: true`. Result summary
  prefixes are PASS/FAIL/SKIP plus per-role extras (`roles.<role>.summary_prefixes`)
- Messages over `MAX_CONTENT_BYTES` (default 32768) are rejected; put large output in
  `body.output_ref` / `refs` and read fields with `get_message(channel, id, path)`
- `wait_for_messages` is server-side long-poll (max 60s) — prefer over polling
- Reads resume from a server-side cursor per (worker, channel) when `since_id` is omitted or 0
  (`turn_start` keys it by `worker`, default the inbox channel); with no cursor they return the
  newest N, never the oldest. A `type: status` with `body.handoff_notes` rewinds the sender's inbox
  cursor so the replacement session sees the task again; the watchdog rewinds via `PUT /cursors`
  when it relaunches after a silent exit, timeout or crash.
- Sessions share nothing but the broker and git. Cross-session knowledge travels three ways only:
  the task envelope (`context`/`background`), `*-notes` findings/decisions, and `handoff_notes` on
  a rotating worker's last status (the fresh session resumes from them). `get_task_ledger` derives
  the orchestrator's ledger server-side so it is never rebuilt from message archaeology.

<!-- claude-broker v3 -->
## claude-broker v3

The `broker` MCP server keeps every v2 tool working; v3 adds typed tools that build the envelope for you.
Reference: `docs/protocol-v3.md` in the claude-broker repo.

### Everyone
- Headless sessions connect with `/mcp?role=<worker|reviewer|orchestrator>&ns=<ns>&as=<you>` (the watchdog sets it
  once your namespace is adopted): `ns` and `sender`/`from` default from the URL. An interactive orchestrator
  gets `?role=orchestrator&ns=<ns>` only, with no `as=` (the local entry is per repo, so it cannot carry a
  session identity): `ns` defaults, `sender` does not. Pass `sender=` on every write and `worker=` on every
  read. Without `role=` you see the 34 v2 tools only, no typed tools.
- Prefer `post_result`, `ask`, `post_note`, `dispatch_task` to a hand-written `send_message`: they fill
  type/from/to, pick the channel from the namespace manifest and reject a bad envelope before it lands. Keep
  `send_message` for shapes they do not build (`rotate`, `approval-token`, patrol notes).
- Read cheap: `read_messages(channel, projection="summary")`, then open one field with
  `get_message(channel, id, path="body.commits[0].sha")`. Omit `since_id`: the server cursor resumes for you.
- A write over 32768 bytes (`MAX_CONTENT_BYTES`) is rejected: put big output in a file, cite it in
  `body.output_ref` or `refs`.
- A result `summary` starts `PASS`, `FAIL` or `SKIP` (a reviewer may also use `APPROVE`, `ADVISE`, `BLOCK`).
- At 150k tokens of context post a `type: status` with `body.handoff_notes` and exit; the replacement resumes.
- Workers and reviewers have no `purge_channel`. A call to a tool outside your profile
  returns "not available to role"; do not retry it, post an `ask` instead.

### Worker
```
post_result(task_id="<ns>-2026-10-21-x", summary="PASS — what was done", affected_files=["a.js"],
            body={"required_checks": {"test": "PASS (29/29)"}, "commits": [{"sha": "abc1234", "branch": "b", "message": "m"}]})
ask(task_id="<ns>-2026-10-21-x", question="Which of A or B?")      # task shows blocked until answered
post_note(kind="finding", subject="<=120 chars", summary="the claim", scope=["lib/x.js"],
          evidence="cmd + tail", confidence="confirmed")
```
`post_result` copies the task's subject; `affected_files` is required when `body.commits` is non-empty.

### Reviewer
```
post_result(task_id="<ns>-2026-10-21-x", summary="APPROVE — 0 blocking, 2 advisory", body={"findings": []})
get_task_ledger(status_channel="<ns>-status", only_open=true)
read_last(channel="<ns>-status", n=10, projection="summary")
```
Only the reviewer role may use `APPROVE|ADVISE|BLOCK` (the manifest decides, not the URL).

### Orchestrator
```
dispatch_task(sender="<you>", to="core", task_id="<ns>-2026-10-21-x", subject="...", body="what and why", context="...",
              scope="small", files={"write": ["lib/x.js"]},
              checks=[{"name": "test", "run": "node run-tests.js", "pass_condition": "all pass"}])
read_messages(channel="<ns>-orchestrator", worker="<you>")       # worker= keys your cursor
get_task_ledger(status_channel="<ns>-status", only_open=true)    # not a re-read of the status channel
open_questions(prefix="<ns>-")
```
The orchestrator profile adds `dispatch_task`, `open_questions`, `list_workers`, `start_worker`, `stop_worker`,
`get_latest_heartbeats`, `sprint_summary`, `sprint_file_conflicts`, `get_latest_per_sender`, `list_channels`.
It also has `purge_channel`, but purge only after `AskUserQuestion` (a PRUNE_EXEMPT channel additionally needs
`force` + `admin_token`). Anything it lacks (`register_channel_schema`, `register_namespace`, `adopt_namespace`) stays
v2: an interactive orchestrator connected without `role=` keeps all 34 v2 tools and its existing instructions.
<!-- /claude-broker v3 -->
