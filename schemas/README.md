# Example schemas

These are **example** JSON Schemas you can register on channels with `register_channel_schema`.
They're not required — a channel with no schema accepts any message. They also serve as fixtures
for the test suite.

Together they model one common pattern: an **orchestrator dispatching tasks to workers**, workers
posting results, and heartbeat/telemetry on the side.

| File | Intended channel | Enforces |
|---|---|---|
| `worker-inbox.json` | a worker's inbox (e.g. `team-backend`) | Task/question/note envelope: `type`, `task_id`, `from`, `to`, `subject`, dependency and acceptance-criteria fields. |
| `status.json` | a status channel (e.g. `team-status`) | Result envelope: requires a `summary`, and (for production-touching work) a `consent_basis`. |
| `control.json` | a broadcast/control channel | Control messages (rotate, reload, approvals). |
| `telemetry.json` | a telemetry channel | Heartbeat/cost envelope read by the dashboard `/cost` view. |
| `backlog.json` | the persistent channels (`team-backlog`, `team-sprint-retrospective`) | Deferred-task and retrospective envelopes; resolution requires an outcome (`promoted`/`cancelled`/`superseded`). |
| `reviewer-inbox.json` | the reviewer's inbox (e.g. `team-reviewer`) | Review-task envelope: requires a `base`/`head`/`checklist` body; only `type: task` is allowed. |

## Registering one

```
register_channel_schema(
  channel = "team-backend",
  schema  = <contents of schemas/worker-inbox.json>,
  strict  = true         # true rejects non-conforming messages; false (default) only logs a warning
)
```

Schemas are stored in the database and hot-reloaded — no broker restart needed. Change or remove
one at any time with `register_channel_schema` / `clear_channel_schema`.

## Writing your own

Any [draft-07](https://json-schema.org/) schema works (Ajv with `ajv-formats`). Start from these
files, rename the channels to your namespace, and adjust the `enum`s and required fields to your
protocol. Register with `strict: false` first to see what would be rejected, then switch to `strict: true`.

The setup wizard registers all of these on your namespace automatically (warn mode by default;
`npm run setup -- --strict` registers them in strict mode).
