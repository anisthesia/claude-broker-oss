# runner/ — Agent SDK launcher for watchdog sessions

`run-worker.mjs` runs one worker session through the Claude Agent SDK (`query()` from
`@anthropic-ai/claude-agent-sdk`) instead of `claude -p`. The watchdog uses it when the launcher is `sdk`.
The role file, the broker, the heartbeats and the rotation stay as they are. The difference is billing: the
session runs on an Anthropic API key, so its usage and cost can be metered.

## Launch

The watchdog chooses the launcher per worker:

| Setting | Effect |
|---|---|
| (nothing) | `cli`, the `claude -p` launch line, unchanged |
| `--launcher sdk` in the worker's watchdog args | this worker only (the way to flip one worker: `start_worker` has no per-entry env) |
| `WATCHDOG_LAUNCHER=sdk` in the watchdog's env | every watchdog that inherits it |
| any other value | watchdog exits 2 |

With `sdk`, the watchdog's launch line becomes:

```
( cd "$WORKER_DIR"; exec "$NODE_BIN" runner/run-worker.mjs "$WORKER" --work-dir "$WORKER_DIR" \
    --inbox-channel "$INBOX_CHANNEL" --model "$CLAUDE_MODEL" --mcp-config "$_MCP_CFG" ) > "$TMPOUT" 2>&1 &
```

It uses the same cwd, model and env, and the same mode-600 MCP config file: one `broker` server with the
`[role=&]ns=&as=` URL and the bearer header. The runner does not build its own copy. `WATCHDOG_RUNNER`
overrides the script path.

### Run by hand

```
node runner/run-worker.mjs workers/analytics --repo-root /path/to/repo --inbox-channel mg-analytics
node runner/run-worker.mjs mg-analytics --config workers-all.json            # a config entry by name
node runner/run-worker.mjs mg-analytics --config workers-all.json --print-config   # resolved session, bearer redacted; no session
```

When the watchdog does not pass `--mcp-config`, the runner builds the broker server the way `watchdog.sh`
does. It reads `BROKER_URL` and `BROKER_SECRET`, and the identity variables `WATCHDOG_NAMESPACE`,
`WATCHDOG_AS`, `WATCHDOG_ROLE`, `WATCHDOG_ROLE_URL`, `WATCHDOG_ROLE_NAMESPACES` and `WATCHDOG_NS_ADOPTED`.
With `WATCHDOG_MCP=0` it builds no MCP server.

## Session options

| `query()` option | Value | Mirrors |
|---|---|---|
| `prompt` | `go` | `-p "go"` |
| `cwd` | the worker dir | `cd "$WORKER_DIR"` |
| `model` | `--model`, else the entry's `model`, else `CLAUDE_MODEL`, else `claude-haiku-4-5-20251001` | `--model` |
| `permissionMode` + `allowDangerouslySkipPermissions` | `bypassPermissions`, `true` | `--dangerously-skip-permissions` |
| `systemPrompt` | `{type: "preset", preset: "claude_code"}` | the CLI's own prompt (the SDK default is a minimal one) |
| `settingSources` | `["user", "project", "local"]` | CLI defaults; `project` loads `CLAUDE.md` and `.claude/` |
| `mcpServers` + `strictMcpConfig` | the watchdog's file, `true` | `--mcp-config` + `--strict-mcp-config` |
| `env` | the inherited env, plus `ANTHROPIC_API_KEY` | |

## Key

- The key is read from `~/.config/claude-broker/anthropic.env`, which holds the line `ANTHROPIC_API_KEY=...`.
  `RUNNER_KEY_FILE` overrides the path (tests use it).
- The file must exist, be a regular file, belong to the user running the runner and have mode exactly `600`. Otherwise the runner exits 2 with a
  one-line reason, and the SDK is never started.
- The value goes into the session's env only. It is never written to stdout, stderr, a log or a file.
- The runner removes every `ANTHROPIC_*` variable from the session's env before it sets the key. That covers
  auth tokens, an inherited key, and host, model or header overrides (`ANTHROPIC_BASE_URL`, `ANTHROPIC_API_URL`,
  `ANTHROPIC_MODEL`, `ANTHROPIC_CUSTOM_HEADERS`, …), so the fleet key only goes to the default API host. It also
  removes `CLAUDE_CODE_OAUTH_TOKEN` and `CLAUDE_CODE_USE_BEDROCK`, `_VERTEX` and `_FOUNDRY`.
- The session loads `~/.claude/settings.json` and the worker dir's `.claude/settings.json` and
  `.claude/settings.local.json`, and their `env` blocks apply on top. If any of these names an `ANTHROPIC_*` or
  `CLAUDE_CODE_USE_*` variable, the runner exits 2 and names the file and the variable; the SDK is never started.
- No fallback to a claude.ai login: if the session's `system/init` event reports an `apiKeySource` other
  than `ANTHROPIC_API_KEY` (an `apiKeyHelper` in settings, for example), the runner aborts the session and
  exits 2.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | the session ended with a `result` event, `is_error: false` |
| 1 | session error: `result.is_error`, no result event, the SDK threw (reason on stderr), or the session stalled |
| 2 | usage or environment: bad args, unknown worker or dir, key file missing, not 600 or empty, SDK not loadable, session not on the API key |
| 143 / 130 | SIGTERM / SIGINT: the watchdog's timeout or rotation kill; the session is aborted |

The watchdog treats any non-zero exit as it does a failed `claude -p` session: it restarts after
`DELAY_CRASH` with the cursor unchanged. Exit 2 is not a stop: a missing key, a bad mode or a settings override
retries every 15 seconds and logs `non-zero exit (2)` until it is fixed. These retries write no ledger rows,
because no session started. A watchdog that stops on exit 2 would be a later change to `watchdog.sh`.

## stdout: the line shape

Each SDK message is written to stdout as one JSON object per line, as it is. These are the same objects
that `claude -p --output-format stream-json --verbose` prints. `tests/runner/fixtures/cli-stream-sample.jsonl`
is a recorded CLI session, and the parity test runs the watchdog's own `session_scan` over both outputs.
Diagnostics go to stderr as `[runner] ...` lines; the watchdog's `2>&1` puts them where its rate-limit and
network-error scans already look.

The lines `session_scan` and the usage ledger (R2) depend on:

```jsonc
{"type":"system","subtype":"init","session_id":"<uuid>","model":"…","apiKeySource":"ANTHROPIC_API_KEY","cwd":"…", …}
// context size = the latest top-level assistant event: input_tokens + cache_read_input_tokens + cache_creation_input_tokens
{"type":"assistant","parent_tool_use_id":null,"session_id":"<uuid>","message":{"model":"…","usage":{"input_tokens":8,"cache_read_input_tokens":21159,"cache_creation_input_tokens":158,"output_tokens":35, …}, …}}
{"type":"user", …}                       // tool results
{"type":"rate_limit_event", …}
// the last line: session totals
{"type":"result","subtype":"success","is_error":false,"session_id":"<uuid>","num_turns":2,"duration_ms":8986,
 "total_cost_usd":0.0192472,
 "usage":{"input_tokens":18,"cache_read_input_tokens":34962,"cache_creation_input_tokens":7514,"output_tokens":141, …},
 "modelUsage":{"claude-haiku-4-5-20251001":{"inputTokens":18,"outputTokens":141,"cacheReadInputTokens":34962,"cacheCreationInputTokens":7514,"costUSD":0.0192472, …}},
 "result":"…"}
```

The result event's `usage` is the session sum, not the context size. The usage ledger (below) reads
`total_cost_usd`, `usage` and `modelUsage` from it.

## Install

Run `npm ci` in the broker checkout with the node that runs the broker (launchd `com.claude.broker`:
`~/.nvm/versions/node/v20.19.0/bin/node`). Under another major version npm rebuilds `better-sqlite3` for the
wrong ABI, and the broker fails on its next restart (`ERR_DLOPEN_FAILED`):

```
cd /path/to/claude-broker && PATH=$HOME/.nvm/versions/node/v20.19.0/bin:$PATH npm ci
```

The runner itself runs under the watchdog's `$NODE_BIN`. A watchdog started by the broker gets launchd's bare PATH,
so that is the first of `/usr/local/bin/node` (v24.3.0 on this Mac), `/opt/homebrew/bin/node` and the newest nvm
node. The SDK has no node addon (`.node` file), so it runs under any node >= 18.14 (its `engines`). It does ship a
per-platform Claude Code executable as an optional dependency (`@anthropic-ai/claude-agent-sdk-darwin-x64` on this
Mac: a Mach-O binary it runs as a subprocess). That binary depends on the OS and CPU, not the node version. `npm ci`
must keep optional dependencies (the default; never `--omit=optional`). Only the broker's `better-sqlite3` depends
on the node version.

`package.json` pins the SDK's zod peer to the broker's
own zod through `overrides`: the SDK declares `zod ^4` for its `tool()` helpers, which the runner does not
use, and the broker is on zod 3.

## Tests

```
node --test tests/runner/
```

No API call and no live broker. `RUNNER_SDK_MODULE` points the runner at `tests/runner/fixtures/stub-sdk.mjs`,
which replays the recorded CLI session. The watchdog end-to-end tests run the real `watchdog.sh --once`
against a fake broker on 127.0.0.1.

## Usage ledger

Each session that reached the API (an `init` event or a `result` was seen) appends exactly one JSON line to
`<dir>/<YYYY-MM-DD>.jsonl`. The date is the machine's local date; `ts` is UTC. Code: `runner/usage-ledger.mjs`.

| `<dir>` | When |
|---|---|
| `--usage-dir <dir>` | given to the runner (created if missing) |
| `RUNNER_USAGE_DIR` | set in the watchdog's env (created if missing) |
| `<repo root>/ops/usage` | that directory already exists; the repo root is the `--work-dir` minus the worker path |
| none | nothing above applies: no ledger, no message |

The broker repo names no consumer's path: a repo opts in by having `ops/usage/` (brand-c ships
`ops/usage/.gitkeep`). A failed write (disk full, a bad directory) prints one line,
`[runner] WARN: usage ledger write failed (<dir>): <code>`, and the exit code stays the session's.

```jsonc
{"v":1,"ts":"2026-10-29T04:12:09.114Z","source":"claude","ref":"<session id>","ns":"mg","worker":"analytics",
 "brand":"brand-a","task_id":"mg-2026-10-29-x","task_ids":["mg-2026-10-29-x"],
 "model":"claude-haiku-4-5-20251001","session_id":"<session id>",
 "input_tokens":18,"cache_read":34962,"cache_create":7514,"output_tokens":141,"cost_usd":0.0192472,
 "model_usage":{"claude-haiku-4-5-20251001":{"input_tokens":18,"output_tokens":141,"cache_read":34962,"cache_create":7514,"cost_usd":0.0192472}},
 "is_error":false,"exit_code":0,"num_turns":2,"duration_ms":8986,"launcher":"sdk"}
```

- Counts and `cost_usd` are the `result` event's session totals (`usage`, `total_cost_usd`, `modelUsage`). A session
  without a result (the SDK threw, SIGTERM, not on the API key) still gets its row, with `null` counts and
  `is_error: true`. `model` is the configured model; `model_usage` has every model the session used.
- `source` + `ref` make a row idempotent on `(source, ref)`. Other row kinds (voice minutes, TTS characters)
  add their own `source`, `ref` and a `units` object; this shape does not change.
- `worker` is the broker identity (`as`). `task_ids` lists every task the session posted a `result` or an `ask`
  for, through `post_result`, `ask` or a `send_message` of `type: result`. `task_id` is the first of them, or
  else the one task envelope the session read, when it read exactly one.
- `brand` is the `brand` field of that task's envelope as the session read it from the broker. Failing that,
  it is a top-level `brand` on one of the session's broker writes (`post_result`/`post_note` input or its
  `body`, or `send_message` content), which is how a patrol can tag itself. Otherwise `null`.
- Rows hold ids, counts and the brand slug only: no message content, no tool output, no phone number.

## Orchestration loop (`orchestrate.mjs`)

The deterministic part of an orchestrator's turn, as code: it releases parked tasks, starts stopped
workers that have open tasks, dispatches the sprint-close review (given `--review-head`), and wakes the orchestrator session only
for a decision. No LLM call is made. Contract and scope: `docs/protocol-v3.md` "Orchestration loop".

```bash
ORCHESTRATION_LOOP_NAMESPACES=cb BROKER_URL=http://localhost:8080 BROKER_SECRET=<secret> \
  node runner/orchestrate.mjs --ns cb --model core=claude-opus-5-5 --model cb-reviewer=claude-opus-5-5
```

| Flag | Default | |
|---|---|---|
| `--ns <ns>` | required | must be in `ORCHESTRATION_LOOP_NAMESPACES` (comma list, empty = off), else exit 2 |
| `--force-ns` | off | run a namespace that is not opted in (tests, one-off runs) |
| `--once` | off | one tick, print the wakes, exit 0 |
| `--interval-ms` | 15000 | tick period in loop mode |
| `--dry-run` | off | one tick, print the planned actions as JSON lines (`"dry_run": true`); applies nothing, writes no state |
| `--state <file>` | `~/.claude-broker/orchestrate-<ns>.json` | mode 600; holds surfaced decisions, start history, the held queue and the sprint marker |
| `--since-id <id>` | see below | first run only: sprint marker and result baseline |
| `--max-starts-per-hour` | 3 | per worker; one more stop in the hour becomes a `start-backoff` wake |
| `--start-cooldown-ms` | 120000 | minimum gap between two starts of one worker |
| `--model <worker>=<id>` | config `model` | repeatable; `<worker>` is the config entry name or the ledger name |
| `--reviewer` / `--sender` | `reviewer` / `orchestrator` | review inbox suffix, sender of released and review tasks; only a `held-task` stored by `--sender` (and `from` it) into a configured `<ns>-<task.to>` inbox is released, any other wakes `held-refused` |
| `--review-head <ref>` | `ORCHESTRATION_LOOP_REVIEW_HEAD`, else unset | branch the sprint-close review diffs; unset = no review is dispatched, the loop wakes `ready-for-review` instead |
| `--review-base <ref>` | `main` | base of the sprint-close review |

Loop mode exits 0 at the first tick that has a wake, with one JSON line per decision on stdout
(`{"ns","wake","id","task_id","channel","line"}`), so it runs as the orchestrator's background watcher: the
shell returns, the session reads the lines and decides, then starts the loop again. Actions go to stderr.
Exit 2: bad arguments or the namespace is not opted in. Exit 1: the broker is unreachable or a call failed.

First run with no state file and no `--since-id`: the sprint marker is the latest `*-review-sprint-close*`
dispatch in the ledger and the result baseline is the newest id on `<ns>-status`, so results that are
already there never wake. Open questions and undecided plans wake regardless of age.

Tests: `node test-orchestration-loop.js` (own scratch broker on a free port, stub `WATCHDOG_BIN`).

## Spend patrol (`spend-patrol.mjs`)

Once an hour it compares each opted-in namespace's spend in the last complete hour with the average of the same
hour on the previous 7 days, and tells the namespace when spend jumps. It never stops a worker, touches a key or
restarts anything. Its only writes are the alerts below, posted through `POST /messages` as sender `spend-patrol`.
Reads go through MCP `read_messages` with no `worker=`, so no cursor is created or moved.

| Spend in the hour vs the 7-day same-hour average | Posts |
|---|---|
| <= 3x | nothing |
| > 3x | one `type: finding` on `<ns>-notes` (valid against `schemas/notes.json`) |
| >= 10x | that finding, plus one `type: question` on `<ns>-orchestrator` |
| any ratio, but the hour's spend is under `SPEND_PATROL_MIN_USD` (default `$2`) | nothing (`below-floor`) |
| no baseline: under 7 days of history for the ns, or a zero same-hour average | nothing (`no-baseline`), whatever the spend |

The $2 floor is the absolute minimum spend for any alert: a jump from $0.10 to $0.50 is 5x but not news. Without
a baseline there is no ratio, and the patrol does not alert on an absolute amount alone.

Each alert's `task_id` is `spend-patrol-<ns>-<YYYY-MM-DDTHH>` (the hour's UTC start). Before posting, the patrol
looks for its own message of that type and task_id on the target channel, so a rerun of the same hour posts
nothing new. Hours are aligned to UTC, so on IST the hour runs hh:30 to hh:30 local.

### Sources

1. **Usage ledger (primary).** Every `*.jsonl` in `SPEND_PATROL_LEDGER_DIRS` (rows from `usage-ledger.mjs`,
   deduped on `(source, ref)`). A row is one session's total `cost_usd`, counted in the hour of its `ts`, which is
   when the session ended: a long session's spend lands in the hour it ends. The ledger is the only source with 7
   days of history, so it alone feeds the baseline.
2. **Telemetry (supplement, last hour only).** `cost_since_start.estimated_usd` on `<ns>-telemetry` heartbeats.
   The value is cumulative per session, so the hour's spend is a per-session delta (keyed by `session_id`, else the
   sender): the latest value in the hour minus the latest before it, or minus the earliest in the hour when there
   is none before (an undercount, never an overcount). A session that has a ledger row is skipped here. Telemetry is
   pruned at 48h and compacted to one row per sender, so it never feeds the baseline.

> **Coverage gap.** Watchdog (tmux, `claude -p`) sessions record no cost anywhere today: `watchdog.sh`
> heartbeats carry context tokens but no `cost_since_start`, and only SDK-launcher sessions write ledger rows.
> So the patrol sees runner (SDK) sessions and the few senders that report cost (voice), and is blind to the
> cb/dv/ca/rt watchdog fleets until the watchdog records cost (cb-backlog `cb-2026-11-02-watchdog-cost`).
> `--dry-run` prints per-ns coverage so a blind namespace is visible: `history_d` 0 and `sources` `none`.

### Run

```bash
SPEND_PATROL_NAMESPACES=mg,voice SPEND_PATROL_LEDGER_DIRS=/path/to/brand-c/ops/usage \
  BROKER_URL=http://localhost:8080 BROKER_SECRET=<secret> node runner/spend-patrol.mjs --dry-run
```

| Env / flag | Default | |
|---|---|---|
| `SPEND_PATROL_NAMESPACES` | empty | comma list of opted-in namespaces; empty = exit 0, nothing read or posted |
| `SPEND_PATROL_LEDGER_DIRS` | empty | colon list of usage-ledger directories |
| `SPEND_PATROL_MIN_USD` | `2` | minimum spend in the hour for any alert |
| `BROKER_URL` | `http://localhost:8080` | a trailing `/mcp` is accepted |
| `BROKER_SECRET` | `SHARED_SECRET` | bearer token |
| `--dry-run` | off | print the table (spend, ledger/telemetry split, average, ratio, level, per-ns coverage: days of history, sources, sessions seen); post nothing |
| `--json` | off | the same result as one JSON line |
| `--now=<ISO>` | now | evaluate the hour before this instant (tests, backfills) |

Exit 0: done (also when the broker is unreachable and nothing had to be posted: telemetry then shows
`unavailable`). Exit 1: an alert could not be posted. Exit 2: bad arguments or `SPEND_PATROL_MIN_USD`.

### Schedule (the orchestrator's step)

Hourly at minute 35, so on IST the UTC-aligned hour (hh:30 local) has just closed, from a launchd agent. Nothing
is installed by this repo. The orchestrator creates `~/Library/LaunchAgents/com.claude.broker.spend-patrol.plist`
with `ProgramArguments` = the broker's node (`~/.nvm/versions/node/v20.19.0/bin/node`) and
`/path/to/claude-broker/runner/spend-patrol.mjs`, `StartCalendarInterval` `{Minute: 35}`,
`EnvironmentVariables` holding the env above (it holds the secret: keep the plist mode 600), and
`StandardOutPath`/`StandardErrorPath` under `worker-logs/`. It runs `--dry-run` by hand first and checks the
coverage columns, then loads the agent (`launchctl bootstrap gui/$(id -u) <plist>`). Unload it with
`launchctl bootout`; emptying `SPEND_PATROL_NAMESPACES` also turns it into a no-op.

Tests: `node test-spend-patrol.js` (own scratch broker on a free port, a temp ledger dir seeded with 8 days).

## Not done here

- One API key per brand: today there is one fleet key file.
- A live session on the SDK launcher: R5, after the human places the key and flips one worker.
- `watchdog.sh` still needs `CLAUDE_BIN` to exist in `sdk` mode (the existing preflight checks are unchanged).
  The SDK uses its own bundled Claude Code binary.
- Rows for the `cli` launcher: `claude -p` on the subscription login is not metered.
