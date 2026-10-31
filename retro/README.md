# Retro run

Deterministic and read-only: clusters recurring FAIL/BLOCK results, compacts open `<ns>-notes`
findings into `docs/knowledge/<ns>.md` (≤ 6 KB), and drafts role-file edits as a `type: note` envelope for `<ns>-orchestrator` (one proposal per sender's own role file).
It never posts to the broker, never edits `CLAUDE.md` files and never touches `*-notes`.

```bash
sqlite3 -readonly /path/to/broker.db ".backup /tmp/retro-<ns>.db"
node retro/retro.mjs --ns cb --db /tmp/retro-cb.db --out docs/knowledge --envelope retro/out/cb-edits.json
```

- Failure clusters cover `<ns>-status` messages after the `last_id` in the knowledge file header (`--full` ignores it).
- Staleness: every failure/repeated-finding cluster shows `last_seen` and is tagged `stale` (and yields no proposal) when
  `fixed` (a later `PASS` result has the same `task_id`, shares at least two files with the cluster, or has a near-identical
  subject; one shared file never counts), `resolved` (a `type: resolved` on `<ns>-notes` has `ref_id` = one of the cluster's message ids)
  or `old` (newest member older than `--stale-days`, default 7; messages without a timestamp are never old). The log lists each cluster as `live` or `STALE(why)`.
- A finding drops out when a `type: resolved` has `ref_id` = its message id; subject/task_id matching applies only to resolved messages without `ref_id`. Expired `expires_at` also drops it.
- Folding: near-identical subjects fold into the newest entry; findings also fold (and cluster) when they share at least two
  `scope`/`affected_files` paths, key terms and enough text overlap, shown as `(xN repeats)`. One shared path never merges.
  Failure clusters join the same way. Three or more repeated findings feed the proposed role edits.
- Trim policy, in order: decisions from the last 14 days in full; older decisions as one-line **Standing rules**; open findings.
  Removed outright: resolved, expired, folded, and decisions superseded by a later decision with the same scope (the header names
  the superseding id). Over 6 KB: (1) entry text is shortened, never below 70 chars, then the oldest findings are dropped;
  (2) decision and rule subjects are shortened through the same steps (floor 70); (3) a decision followed by a later one with the
  same subject (case and punctuation ignored) or a shared exact file path is merged into the later (a hub never counts as shared: a `scope` entry on more than 8 open decisions, `--hub-max N`, or named in `--hub-path a,b`; mg puts topic tags such as `brand-a` and `voice` in `scope`), whose line reads `(merges #a, #b)` and the header lists `#a by #b`;
  (4) if it still exceeds the cap the file is written anyway, with `<!-- over cap: N B > 6144 B, decisions kept -->` as its second line.
  A decision is never silently dropped. The header states resolved / folded / superseded / merged / dropped-for-size counts. The run's log line and `--json` output carry `merged` (decisions folded into a later one) and `over_cap` (true when the file was written above the cap) beside `kept`/`total`.
- `--dry-run` prints sizes and writes nothing. `--json` prints the knowledge counts (no text) as one JSON line on stdout instead of the log lines.

## Weekly dispatch

`retro/worker-entry.json` is the worker definition (named `retro`, the path basename the watchdog keys its inbox cursor on; haiku, not started; role dir `workers/retro`, repo root
the main claude-broker-oss checkout, inbox `cb-retro`). The role file is `workers/retro/CLAUDE.md`; the `cb` manifest
(`schemas/manifests/cb.json`) lists the worker `retro` once, with inbox `cb-retro`, and declares `cb-retro` as a channel. The retro
never commits: it leaves `docs/knowledge/cb.md` modified and the orchestrator commits it. Task envelope from the orchestrator or
orchestration loop (the `cb-*` inboxes are strict, so `scope` and `acceptance_criteria` are required):

```json
{ "type": "task", "task_id": "cb-2026-10-30-retro-weekly", "from": "orchestrator", "to": "retro",
  "subject": "Weekly retro cb", "scope": "small",
  "body": "Back up broker.db read-only, run node retro/retro.mjs --ns cb against the copy, leave docs/knowledge/cb.md modified (the orchestrator commits it) and post the edits envelope path as body.output_ref.",
  "files": { "write": ["docs/knowledge/"] },
  "acceptance_criteria": ["docs/knowledge/cb.md is at most 6144 B or carries the over-cap header", "The proposed role-file edits envelope is written and cited in the result", "No file other than docs/knowledge/cb.md is modified"] }
```
