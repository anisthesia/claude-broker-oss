# /teardown-broker — Remove a broker-worker project setup

Reverse of `/setup-broker`. Stops running workers, clears channel schemas, optionally
purges channels, and removes all generated files from both the target project and the
broker repo.

**Complete every step in order. Do not skip steps.**

---

## Step 1 — Collect config

Before asking questions, run:

```bash
ls ~/myprojects/ 2>/dev/null || ls ~/projects/ 2>/dev/null || echo "(no default projects dir found)"
```

**Use `AskUserQuestion`** with up to 3 questions in one call:

1. "What namespace prefix to remove? (2-4 lowercase letters, e.g. sm, rp, dx)"
   — Other (free text)
2. "What is the absolute path to the TARGET project to remove the setup from?"
   — Other (free text)
3. "What is the absolute path to the claude-broker repo?"
   — options: `/Users/anis/myprojects/claude-broker-oss` (Recommended), Other

After responses, derive:
- `PREFIX` = the chosen prefix
- `TARGET_ROOT` = absolute path to the target project
- `BROKER_REPO` = absolute path to the broker repo
- `PROJECT_NAME` = basename of `TARGET_ROOT` (e.g. `/Users/anis/myprojects/myapp` → `myapp`)

---

## Step 2 — Inventory

Discover what actually exists before confirming. Run all of the following:

```bash
# Target project
ls <TARGET_ROOT>/orchestrators/<PROJECT_NAME>/CLAUDE.md 2>/dev/null && echo exists || echo missing
ls <TARGET_ROOT>/workers/ 2>/dev/null
cat <TARGET_ROOT>/.claude/settings.json 2>/dev/null

# Broker repo
ls <BROKER_REPO>/schemas/<PREFIX>-*.json 2>/dev/null
ls <BROKER_REPO>/setup-schemas-<PREFIX>.js 2>/dev/null && echo exists || echo missing
grep WORKERS_CONFIG <BROKER_REPO>/.env
grep <PREFIX>-backlog <BROKER_REPO>/.env
```

Also call MCP tools to check live state:
- `list_workers` — identify any running `<PREFIX>-*` workers
- `list_channel_schemas` — identify registered `<PREFIX>-*` schemas

---

## Step 3 — Confirm plan

Use `AskUserQuestion` to display the full plan:

```
PREFIX:   <PREFIX>
PROJECT:  <PROJECT_NAME>
TARGET:   <TARGET_ROOT>

WILL STOP workers:   <list of running PREFIX-* workers, or "none running">
WILL CLEAR schemas:  <list of PREFIX-* channels with schemas, or "none registered">
WILL PURGE channels: <list of PREFIX-* channels except PREFIX-backlog> (requires separate confirmation)
WILL REMOVE from broker repo:
  schemas/<PREFIX>-*.json (N files)
  setup-schemas-<PREFIX>.js
  <WORKERS_CONFIG_FILE> — remove N entries where ns === "<PREFIX>"
  .env PRUNE_EXEMPT — remove <PREFIX>-backlog

WILL REMOVE from target project:
  orchestrators/<PROJECT_NAME>/CLAUDE.md
  workers/<worker>/CLAUDE.md (× N)
  .claude/settings.json — strip mcpServers.broker block

<PREFIX>-backlog: WILL NOT purge automatically — shown separately below.
```

Ask: "Proceed with teardown?" — Yes / No
If No: stop immediately.

---

## Step 4 — Stop running workers

For each running `<PREFIX>-*` worker found in Step 2:
```
stop_worker(name="<PREFIX>-<worker>")
```
Print confirmation per worker. If none running: print `No workers running — skipping.`

---

## Step 5 — Clear channel schemas

For each `<PREFIX>-*` channel that has a registered schema:
```
clear_channel_schema(channel="<PREFIX>-<channel>")
```
Print confirmation per channel. If none registered: print `No schemas registered — skipping.`

---

## Step 6 — Purge channels (requires explicit AskUserQuestion)

NEVER purge without an explicit `AskUserQuestion`. Show channel names and message counts.

Use `AskUserQuestion`:
```
Purge these <PREFIX>-* channels? (message counts shown)
  <PREFIX>-orchestrator   N msgs
  <PREFIX>-control        N msgs
  <PREFIX>-status         N msgs
  <PREFIX>-telemetry      N msgs
  <PREFIX>-<worker1>      N msgs
  ... (all except <PREFIX>-backlog)
```

Options: "Purge all listed" / "Skip purge (keep messages)"

If Skip: print `Channel messages preserved. Run purge_channel manually if needed.`
If Purge: call `purge_channel` for each listed channel (NOT `<PREFIX>-backlog`).

### Step 6b — Backlog decision (separate gate)

Use `AskUserQuestion`:
```
<PREFIX>-backlog contains N messages (deferred tasks). What should happen to it?
```
Options:
- "Leave it (Recommended)" — print a reminder: `To read later: read_messages(channel="<PREFIX>-backlog", since_id=0)`
- "Purge it too" — call `purge_channel(channel="<PREFIX>-backlog")` with warning that this is irreversible

---

## Step 7 — Remove broker repo files

```bash
# Remove schema files
rm <BROKER_REPO>/schemas/<PREFIX>-*.json

# Remove schema registration script
rm <BROKER_REPO>/setup-schemas-<PREFIX>.js
```

For the WORKERS_CONFIG file — detect the correct path from the broker's `.env`:
- Read `<BROKER_REPO>/.env`
- Find the line `WORKERS_CONFIG=<path>`
- If present: use that path as the workers config file (e.g. `/Users/anis/myprojects/claude-broker-oss/workers-all.json`)
- If absent: fall back to `<BROKER_REPO>/workers-broker.json` and print:
  `[teardown-broker] WORKERS_CONFIG not set in .env — falling back to workers-broker.json`

Then update the detected WORKERS_CONFIG file:
- Read the JSON array
- Filter out all entries where `ns === "<PREFIX>"`
- Write the updated array back
- Print how many entries were removed

For `.env` PRUNE_EXEMPT:
- Read the line `PRUNE_EXEMPT=...`
- Remove `,<PREFIX>-backlog` or `<PREFIX>-backlog,` or `<PREFIX>-backlog` (handle all positions in the list)
- Write the file back
- Print `[teardown-broker] PRUNE_EXEMPT updated — removed <PREFIX>-backlog`

---

## Step 8 — Remove target project files

```bash
rm <TARGET_ROOT>/orchestrators/<PROJECT_NAME>/CLAUDE.md
rmdir <TARGET_ROOT>/orchestrators/<PROJECT_NAME> 2>/dev/null || true
rmdir <TARGET_ROOT>/orchestrators 2>/dev/null || true
```

For each worker directory found in Step 2:
```bash
rm <TARGET_ROOT>/workers/<worker>/CLAUDE.md
rmdir <TARGET_ROOT>/workers/<worker> 2>/dev/null || true
```
```bash
rmdir <TARGET_ROOT>/workers 2>/dev/null || true
```

For `.claude/settings.json`:
- Read the file
- If `mcpServers.broker` is the only key under `mcpServers`: remove `mcpServers` entirely
- If other `mcpServers` keys exist: remove only `mcpServers.broker`
- If the file becomes `{}` after removal: delete it
- Write back otherwise

---

## Step 9 — Git commits

Broker repo:
```bash
cd <BROKER_REPO>
git add schemas/<PREFIX>-*.json setup-schemas-<PREFIX>.js <WORKERS_CONFIG_FILE> .env
git commit -m "chore: remove <PREFIX> project schemas and worker config"
```
Skip silently if nothing changed (empty commit).

Target project (if `.git` exists):
```bash
cd <TARGET_ROOT>
git add orchestrators/ workers/ .claude/
git commit -m "chore: remove broker-worker arrangement (teardown via /teardown-broker)"
```
Skip silently if nothing changed. If no `.git` found: print:
```
⚠  No git repo found in <TARGET_ROOT>. Files removed but not committed.
   Run manually when ready:
   cd <TARGET_ROOT>
   git add orchestrators/ workers/ .claude/
   git commit -m "chore: remove broker-worker arrangement (teardown via /teardown-broker)"
```

---

## Verification checklist

Print aloud:
- [ ] All `<PREFIX>-*` workers stopped (or none were running)
- [ ] All `<PREFIX>-*` channel schemas cleared (or none were registered)
- [ ] Channels purged or skipped (per user choice in Step 6)
- [ ] `<PREFIX>-backlog` handled per user choice (Step 6b)
- [ ] `schemas/<PREFIX>-*.json` removed from broker repo
- [ ] `setup-schemas-<PREFIX>.js` removed from broker repo
- [ ] WORKERS_CONFIG file updated — `<PREFIX>` entries removed (filtered `ns === "<PREFIX>"`)
- [ ] `.env` PRUNE_EXEMPT updated — `<PREFIX>-backlog` removed
- [ ] Target project `orchestrators/<PROJECT_NAME>/CLAUDE.md` removed
- [ ] Target project `workers/<worker>/CLAUDE.md` files removed (× N)
- [ ] Target project `.claude/settings.json` patched or removed
- [ ] Broker repo committed (or skipped if no changes)
- [ ] Target project committed (or reminder printed if no git repo)
