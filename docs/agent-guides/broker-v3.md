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
