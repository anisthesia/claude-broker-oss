# Protocol v3

Status: **live on main** (go-live, 2026-10-21). Authority: protocol-qa. v2 (`protocol-v2.md`) stays
in force: every v2 tool and per-namespace schema keeps working unchanged until a namespace is adopted
(cb-notes #168657). A session that does not send `?role=` gets the pre-v3 tool list; role profiles,
the watchdog's `role=` URL and per-session cursor keys switch on per namespace with `adopt_namespace`
(see [Adopting a namespace](#adopting-a-namespace)).

| Part | What it gives you | Tests |
|---|---|---|
| [Base protocol & manifests](#base-protocol--manifests) | One server-owned envelope per message type; a namespace is a small manifest that narrows it | `test-namespaces.js` |
| [Typed tools](#typed-tools) | `dispatch_task`, `post_result`, `ask`, `post_note` build and validate the envelope for you | `test-typed-tools.js` |
| [Role profiles](#role-profiles) | `/mcp?role=&ns=&as=` shows a session only its tools: worker 14.3 KB instead of 37.7 KB (adopt per namespace) | `test-role-profiles.js` |
| [Context economy](#context-economy) | Write cap, `get_message`, summary projection, server-side cursors | `test-context-economy.js` |
| [Watchdog v3](#watchdog-v3) | Measured context, rotation that fires, follow-up launches, API-down backoff | `test-watchdog-v3.js` |
| [Plan gate](#plan-gate) | `post_plan` / `decide_plan`: a medium or large task gets an approved plan before code | `test-plan-gate.js` |
| [v2 → v3 migration](#v2--v3-migration) | What changes for a namespace, a session and a role file; what stays | all of the above |

## Base protocol & manifests

### Why

Each namespace carries its own copy of the envelope schemas (`schemas/<ns>-*.json`, 70+ files) and
the copies drift. The clearest symptom: ~900 recent broker warns are `upsert_heartbeat` failing
per-namespace telemetry schemas (`/activity must NOT have additional properties` — tally adds
`activity.last_action`; missing `ts`/`context`; the pre-v2 `{type,from,at,state}` shape). In v3 the
server owns one **base protocol**, and a namespace is a small **manifest** that narrows it.

### Base schemas — `schemas/base/*.json`

JSON Schema draft-07, `$id: claude-broker/base/<type>`, `additionalProperties: true`. They hold
only fields common to every namespace, derived from the union of the existing `schemas/*.json`
and checked against the live corpus.

| File | Type(s) | Required | Notes |
|---|---|---|---|
| `task` | task | type, task_id, from, to, subject | context, background, depends_on, files, checks, acceptance_criteria, constraints, scope, result_template typed; `body` not required (cb requires it) |
| `result` | result | + `summary` | `summary` matches `^(PASS\|FAIL\|SKIP)\b`; `affected_files` required when `body.commits` is non-empty; `body.consent_basis` required when `body.production_touching` |
| `status` | status | envelope | `body.handoff_notes` (object, or free text from older sessions) triggers the cursor rewind |
| `question` | question | envelope | |
| `finding`, `decision` | finding, decision | type, from, subject, summary, scope | `scope` array (preferred) or string; lengths/enums are cb extensions |
| `resolved` | resolved | type, from, subject, ref_id, outcome | |
| `heartbeat` | heartbeat | type, from, and `ts` or `at` | accepts exactly what `watchdog.sh emit_heartbeat` and `upsert_heartbeat` emit; `activity`/`context` open objects; `activity.state` includes `patrol` |
| `deferred` | deferred, deferred-resolved | type, task_id, subject | `deferred_reason` and the resolved-body shape are extensions |
| `approval-token` | approval-token | envelope; `body.{authorized_actions,env,scope_workers,expires_at}` | |

`retrospective` is deliberately not a base type (free-form per namespace); manifests declare it as a
local type.

### Manifest — `schemas/manifest.schema.json`

A manifest (`schemas/manifests/<ns>.json`) declares:

- `ns`, `version` (`3.x`), `strict` (default false = warn-only; per-channel override),
  `closed` (default false).
- `workers[{name, inbox, role}]`, role ∈ orchestrator | worker | reviewer.
- `channels[{name, kind, types, strict?, closed?, extensions?}]`; `kind` ∈ worker-inbox,
  orchestrator-inbox, control, status, telemetry, backlog, notes (backlog and notes are prune-exempt).
- `roles.<role>.{summary_prefixes, extensions}` — role-level rules, applied when `from` is a worker
  with that role (cb-notes #168904). `summary_prefixes` widens the base result prefix
  (`{"reviewer": {"summary_prefixes": ["APPROVE","ADVISE","BLOCK"]}}`): base `summary` is a
  `pattern` and an ANDed fragment cannot widen it, so the loader rebuilds the pattern from base +
  the sender role's list. Added to `manifest.schema.json` in the idle-namespace migration to match
  what core's loader already accepts (302c39a); optional, `cb.json` is unchanged and still valid.
- `local_types` — namespace-only types with no base schema (`rotate`, `sprint-start`, `retrospective`…).
  The common envelope is implied unless `envelope: false`, and the loader **requires** it
  (`type, task_id, from, to, subject`) on every channel the type appears in. A type that must be
  looser (dv `retrospective`: no `from`/`to` needed) sets `envelope: false` and lists `required`
  and `properties` itself; that cannot be done per channel.
- `extensions` — per-type narrowing: `required`, `properties` (schema fragments), `enums`, `patterns`,
  `fields` (exact allow-list), `closed`, `allOf` (if/then rules).

**Compilation rule (for the loader):** the schema for a (channel, type) is
`allOf[ base/<type>.json, extension fragment ]`; the channel schema is a `oneOf` over its types, each
branch pinning `type`. Because fragments are ANDed with the base they can only narrow. Precedence:
channel extension ∧ namespace extension ∧ base. `closed` computes the allow-list as base ∪ extension
properties (∪ envelope for local types); a field the base declares but the namespace forbids is
`properties: { field: false }`, or use `fields`. `deferred` covers `deferred-resolved` too.
Pitfall: `additionalProperties:false` inside a nested fragment must list every allowed nested
property (`{read:true, write:true}`), because fragments are ANDed.

### `schemas/manifests/cb.json`

Expresses the cb namespace. Verified against the existing `cb-*` schemas with a throwaway reference
compiler (not committed; core owns the real loader): every corpus message plus single-field mutations
(drop each field, add an unknown field), 75.8k verdicts. Agreement is 100% on cb-core, cb-protocol-qa,
cb-orchestrator, cb-control, cb-telemetry and cb-notes. Two **intentional** divergences, both from the
base `result` invariant (`summary` required, PASS/FAIL/SKIP prefix — CLAUDE.md):

1. `cb-status`: results whose summary starts `APPROVE` / `BLOCK` / `PARTIAL` / free text were accepted
   by `cb-status.json` and are rejected by base. `roles.reviewer.summary_prefixes`
   (APPROVE/ADVISE/BLOCK) now accepts the reviewer verdicts; `PARTIAL` and free text stay rejected.
   `cb-reviewer` (registered by `setup-schemas-cb.js`) was added to the manifest with the reviewer
   inbox rules of the other namespaces.
2. `cb-backlog`: the old `result` shape forbade `summary` outright; the manifest permits and (via base)
   requires it.

### Corpus acceptance (last 500 per type, `broker.db`, read-only)

| Type | Accepted | Rejection classes |
|---|---|---|
| task | 500/500 | — |
| question | 119/119 | — |
| status | 100% | — |
| heartbeat | 100% | — (includes tally `last_action`, legacy `{at,state}`) |
| deferred (+resolved) | 100% | — |
| approval-token | 14/14 | — |
| result | 91.8% | 40: summary not PASS/FAIL/SKIP (reviewer verdicts `APPROVE`/`BLOCK`/`PARTIAL`, `Self-dispatched`, prose) — real drift; 1: `body.commits` items are strings |
| finding | 99.2% | 4: legacy notes carrying detail in `body` instead of `summary`/`scope` (tally-notes #149730–#161056) |
| decision | ~89% | ~13 no `scope`, ~15 no `summary` (legacy tally/ca/mg notes, `body` used instead), 1 no `from` |
| resolved | 91.1% | 7: close a note via `summary` only (no `ref_id`/`outcome`); 1: no `subject` |

Notes-length caps (subject 120, summary 400), the `confidence`/`outcome` enums and `scope` array-ness
are **not** in base (35+ findings exceed 400 chars; 8 use free-text confidence; 41 use string scope).
They are cb extensions, enforced only in `cb-notes`.

### Migrating a namespace: `setup-schemas-<ns>.js` → `schemas/manifests/<ns>.json`

1. **Workers.** One entry per session that has a registered inbox: `name` is the id used in
   `from`/`to` (the channel without `<ns>-`), `inbox` is `<ns>-<name>`, role is `orchestrator`,
   `worker` or `reviewer`. Worker ids in `workers-*.json` (`rp-api`, `dv-reviewer`) are launcher
   names, not message ids.
2. **Channels.** One entry per `{ channel, file }` row of `REGISTRATIONS`, with `kind` from the
   channel's role (`<ns>-sprint-retrospective` → `backlog`, `<ns>-reviewer` → `worker-inbox`). The
   `types` list is the old file's `type.enum`; types with no base file go in `local_types`.
3. **Per type.** Read the old file's `allOf` rules and property constraints and keep only what base
   does not already say: `task_id` pattern → `patterns`, `from`/`to` enums → `enums`,
   `task => required body` → `required`, extra fields (`wire_compat`, `baseline_task_id`…) →
   `properties`, `additionalProperties:false` → `closed` (namespace-wide) or `fields`
   (exact allow-list, used for orchestrator inboxes and backlog shapes). `result.summary` required,
   `affected_files` with commits and `consent_basis` with `production_touching` come from base — do
   not repeat them. Add `body.consent_basis` as an extension only where the old schema required it
   unconditionally (dv, voice).
4. **Telemetry / notes / backlog** use the shared extensions (`heartbeat`, `finding`, `decision`,
   `resolved`, `deferred`); only worker-id enums (dx, rp) and backlog field lists differ.
5. **strict.** Every manifest is `strict:false`, whatever the old `strict:true` flags were. Flipping is
   a separate authorized step (see Schema work in the protocol-qa CLAUDE.md).
6. **Prove it.** Compile the manifest with a reference compiler, run every old channel schema and the
   compiled one over the same messages plus single-field mutations (drop each field, drop each
   nested field, add an unknown field), and classify each disagreement. The old setup script and
   schema files stay in place (v2 keeps working) until the namespace is adopted.

#### Parity (`broker.db` read-only, no live-broker registration)

Verdicts come from core's real loader (`compileManifest` / `validateManifestContent`, worker/core
302c39a, scratch DB) against the old `schemas/<ns>-*.json`; my throwaway reference compiler agrees
within 3 verdicts per namespace. The pruned broker.db holds almost no own traffic for these namespaces, so most channels were
checked on **same-kind traffic borrowed from ca-/dx- channels** (shapes are shared across the
family; ids are not retargeted) and heartbeats on 5 synthetic fixtures. Treat the numbers as "the
manifest reproduces the old schema on realistic envelopes", not as validation against each
namespace's own history; lz and sm have no own traffic at all.

| ns | channels | own-traffic / borrowed channels | verdicts | agreement |
|---|---|---|---|---|
| dv | 14 | 3 / 10 (+1 synthetic) | 39,681 | 99.85% |
| dx | 19 | 2 / 16 (+1) | 68,611 | 99.97% |
| ca | 16 | 9 / 6 (+1) | 44,597 | 99.74% |
| lz | 22 | 0 / 21 (+1) | 89,669 | 99.95% |
| voice | 13 | 1 / 11 (+1) | 37,498 | 99.91% |
| sm | 10 | 0 / 9 (+1) | 25,885 | 99.83% |
| rp | 13 | 1 / 11 (+1) | 42,351 | 100.00% |

Every disagreement falls in one of four classes; two are **intentional** (base is stricter than the old
schema), one is a **format limitation** (voice `note`) and one is policy (strictness); none is a manifest bug:

1. **Result summary prefix** (dv 60, ca 115, lz 43, sm 43, voice 15 verdicts): old schemas accepted any
   `summary`; base requires PASS/FAIL/SKIP plus `roles.<role>.summary_prefixes`. Rejected summaries are
   reviewer free text (`MY…`, `EVERY…`, `TRIAGED…`, `Self-dispatched`) — real drift.
2. **`affected_files` with commits** (dx 20): dx never required it; base does.
3. **Voice `note` needs `to`** (voice, 19 verdicts): `voice-backlog.json` made `to` optional on `note`,
   but the same `note` type is a local type shared with the worker inboxes and the implied envelope
   requires `to`. Limitation of the format (see gaps), not worth a bespoke type name.
4. **Strictness is not compared**: old `strict:true` channels (dv 9, rp 13, ca/lz/sm/dx 2 each, cb 9)
   become warn-only.

#### Replay through a broker (manifest-align)

With `worker/core` merged, a throwaway broker (own PORT and DB, no v2 schemas, so the manifests are
the active validators) took `register_namespace` for all 8 manifests, and a sample of the parity
corpus (up to 40 messages per channel plus all their mutations, 73,079 messages) was posted with
`POST /messages`; a `warn` in the response means the manifest rejected it. The broker's verdict
equals the reference compiler's on **100.00%** of the messages (cb, dv, dx, ca, lz, voice, sm, rp
all 100.00%) and the old v2 schemas' on 99.46–100.00%, the differences being the classes above.
Role check on `ca-status`: a `reviewer` result `APPROVE — …` is accepted, the same from a worker is
rejected, a worker `PASS — …` is accepted.

#### Fresh manifests: trippy and crm (no v2 schemas)

`schemas/manifests/trippy.json` (13 workers, 18 channels) and `crm.json` (5 workers, 10 channels) are
the first validation either namespace has had: no `schemas/<ns>-*.json` or setup script exists. Both are
`strict:false`. Built from `workers-all.json` (one inbox per `--inbox-channel`; `reviewer` gets the
reviewer role) plus the shared channel set (`orchestrator`, `control`, `status`, `telemetry`,
`backlog`, `notes`) and the sm worker-inbox rules. An `orchestrator` entry is added to both although
`workers-all.json` does not launch one: `crm-notes` decisions are sent by `orchestrator`. No `task_id`
pattern and no extension fields were added, since no traffic shows a stable convention.

Corpus (`broker.db` read-only, throwaway broker, `register_namespace` + `POST`-equivalent `send_message`):

| ns | own messages | accepted |
|---|---|---|
| trippy | 0 (no trippy-* channel exists in any broker.db) | n/a: untested against real traffic |
| crm | 22, all on `crm-notes` (21 decision, 1 finding) | 22/22 (100%), no rejection classes |

Before strict, the teams must: (1) send some real traffic under the manifest in warn-only mode and
review the `[claude-broker] schema warn` lines, since trippy has none and crm has only notes; (2) use
`PASS|FAIL|SKIP` result summaries (reviewers may use `APPROVE|ADVISE|BLOCK`); (3) give every
`type:task` a `body`, and keep `files`/`checks` to the documented keys; (4) decide a `task_id`
convention if they want one enforced; (5) add `trippy-orchestrator` / `crm-orchestrator` to their launch
config if those sessions are meant to be watchdog-managed.

#### mg, tally and os (warn-only; translated from the working-tree v2 schemas)

`schemas/manifests/{mg,tally,os}.json` translate the schemas as the teams currently have them in the
broker checkout (`schemas/<ns>-*.json` and `setup-schemas-<ns>.js`: mg and tally modified, os untracked;
read only, never edited here). All `strict:false`, whatever the setup scripts say (mg-status,
mg-reviewer and tally-status were `strict:true`). Same recipe as sm (workers from the live
`workers-all.json`: mg 12, tally 11, os 11 inboxes, every one a manifest worker and channel, plus
`<ns>-sprint-retrospective`, which v2 registers). Parity method: core's real loader
(`compileManifest` / `validateManifestContent`, scratch DB) against Ajv on each channel's v2 file, over
broker.db read-only plus single-field mutations (drop each field, drop each body/context/activity/files
field, add an unknown field) plus synthetic fixtures for what no traffic reaches. A throwaway broker
(own PORT and DB, no v2 schemas) then took `register_namespace` for all three and a sample of the corpus
by `POST /messages`: the broker's verdict equals the in-process one on 100.00% (mg 3,714, tally 4,020,
os 4,373 messages), and nothing touched the launchd broker.

| ns | workers | channels | size | channels with own traffic | verdicts | agreement |
|---|---|---|---|---|---|---|
| mg | 12 | 18 | 70 KB | 18 (4 topped up with ca/dx same-kind traffic) | 16,969 | 98.68% |
| tally | 11 | 17 | 92 KB | 3 (`backlog` 30, `sprint-retrospective` 13, `notes` 177) | 20,197 | 99.92% |
| os | 11 | 17 | 52 KB | 1 (`os-notes`, 1 message) | 22,311 | 99.93% |

tally and os have almost no history in broker.db (tally-status/control/telemetry and every worker
inbox were pruned), so those channels were checked on same-kind traffic borrowed from ca/dx/mg (task_id
prefix retargeted) and on synthetic fixtures. Treat their numbers as "reproduces the v2 schema on
realistic envelopes", not as proof against the team's own traffic. There is no tally or os heartbeat
anywhere, so their telemetry channels are unproven on real traffic.

##### mg

Customised v2 rules, all kept: `task_id` pattern `^mg-YYYY-MM-DD-`, `task` requires `body` and `brand`
(`brand-a|client-project|brand-b|portfolio`, allowed on every worker-inbox type as in v2), control
`approval-token` (`authorized_actions` ⊂ social-publish, email-send, outbound-send, voice-call,
rules-merge; `env: production`; `scope_workers` ⊂ social, email, outbound, voice, rules; `from` human or
orchestrator; an orchestrator token must carry `body.standing_consent: "mg-notes#167091"` and only
`voice-call` / `voice`), `sprint-start` requires `sprint_id`, `consent-grant|deny`, `reload`; status
`consent_basis` must match `approval-token:#<id>|terminal-human` once `production_touching` is true, a
result whose subject starts Publish/Send/Schedule/Push needs `production_touching`, and a result from
`reviewer` needs `body.verdict`. Roles: reviewer `APPROVE|ADVISE|BLOCK`, **worker `PARTIAL`** (voice
posted 3 `PARTIAL` results; the first use of `roles.worker.summary_prefixes`). `heartbeat.activity.state`
keeps v2's states (base already has `patrol`).

224 of 16,969 verdicts diverge; all four classes are accounted for:

1. **`summary` required on result** (166, the `drop:summary` mutation, 159 own + 7 synthetic):
   `mg-status.json` never required it; base does. Intentional.
2. **Publish gate without a body** (45): v2 only checks `production_touching` when a `body` exists, so a
   `Publish…` result with no body passed. The manifest requires `body.production_touching`. Intentional
   tightening of the gate the schema exists for.
3. **Summary prefix drift** (9): one own voice result starting `NOT…`. Real drift; stays rejected.
4. **`body.commits` items that are strings** (4): one own result. Real drift; base requires objects.

Own traffic that **both** v2 and the manifest reject (not divergences, but they block strict): on
`mg-orchestrator` 8 `answer`, 1 `reply`, 1 `result` and 3 `note`s; on `mg-backlog` types `backlog` and
`resolved` plus a `note` and a `deferred`; on `mg-notes` 20 decisions, 10 findings and 6 resolved
from before the notes caps; 1 `mg-analytics` note. `mg-ops` (1 message) is in neither
`workers-all.json` nor the registry and has no manifest channel.

##### tally

Customised v2 rules, kept: `task_id` `^tally-YYYY-MM-DD-`, `task` requires `body`; worker inboxes
(connector, ask, finance, remote, ui, platform, quality, marketing and `tally-server`, which v2
registers) also accept `reload`, `contract-change` and the five `peer-*` types; the orchestrator inbox
accepts `task`, `consent-grant`, `consent-deny` and `answer` besides question/note/status; control adds
`reload`. Of the 20,197 verdicts 16 diverge (99.92%), all one class: **result summary prefix** on
borrowed ca-status results (reviewer free text), where v2 accepts any `summary` and base does not.
Intentional, as in the other namespaces.

Own traffic that both reject: `tally-backlog` 15 `backlog`, 5 `task`, 2 `note`, 3 `deferred`;
`tally-sprint-retrospective` 5 `retrospective`, 2 `note`; `tally-notes` 30 findings, 26 decisions,
1 resolved (pre-cap notes) and 13 `contract-change` messages, a type `notes.json` does not accept.
`tally-telemetry` mirrors v2 (no `activity.last_action`, no top-level `at`/`state`), which base would
allow; no tally heartbeat exists to say whether the sessions send them.

##### os

`os-worker-inbox` is the tally one without the peer types (`task`, `question`, `note`, `rotate`);
`os-control` has no `reload`; the orchestrator inbox takes question/note/status. 22,311 verdicts,
16 diverge (99.93%): the same borrowed ca-status summary-prefix class. The channels have no own
traffic (one `os-notes` message), so the whole manifest is proven on borrowed and synthetic envelopes only.

##### What the three have in common

- **Worker-inbox value constraints.** v2's shared inbox schema checks the optional task fields
  (`scope`, `context`, `background`, `depends_on`, `files`, `checks`, …) on every type. Repeating those
  constraints on every type of every inbox made tally.json 246 KB, so they stay on `task` and the other
  types only get an exact `fields` allow-list (mg adds `brand`). Measured with synthetic bad values on
  note/question/rotate (`scope: "huge"`, `context: ""`, extra key in `files`, `checks` without
  `run`, `depends_on: ["a"]`), reported apart from the table: mg 1,590 verdicts / 510 diverge,
  tally and os 1,431 / 459 — the manifest accepts values v2 rejected. Needs kind-level extensions (below).
- **`from` is a message id, not a launcher name.** Senders such as `tally-orch`, `os-orch`, `sentinel`
  (mg's watch job), `brand-c` (an mg-telemetry sender) and `voice-orchestrator` (on `mg-orchestrator`)
  are not manifest workers, so `roles.*` rules never apply to them. mg's reviewer verdict gate works only
  because the reviewer posts as `reviewer`.
- **Strict is not safe yet** for any of the three; before a flip: mg and tally fix the types in their
  own traffic that both validators reject (above), decide the divergences (mg-status was strict and
  has a publish gate: the tightened gate in class 2 needs the mg team's agreement), and tally and os
  send traffic under the manifest in warn-only mode first.

#### Format gaps the loader/manifest could not express (or expresses clumsily)

- **No per-kind or grouped channel extensions.** Worker-inbox rules are copied into every inbox
  (dx 11×, lz 14×); dx.json is 38 KB for that reason. A `kind_extensions` map or `channels[].names`
  group would remove it.
- **Local-type envelope is all-or-nothing** (see `local_types` above): requiring `to` on every channel
  that accepts the type; a type shared between a strict and a loose channel (voice `note`) cannot
  be loosened for one.
- **No wildcard role in `roles`**: `PARTIAL` (used by ca's reviewer once, and by mg workers) is put on
  `roles.reviewer` in ca; other roles cannot receive it without a per-role list.
- **`from`/`to` enums are literals** (dx, rp) and duplicate `workers[]`; a `"$workers"` token would
  keep them in sync.
- **`const` constraints** (`to: orchestrator` on dx/rp backlog) are expressed through `properties`
  fragments, not sugar.
- **dv coverage**: only the 4 worker inboxes registered by `setup-schemas.js` plus 3 cluster
  statuses are modelled. 30 dv workers (the four domain orchestrators included) have no v2 schema; whether the
  loader should create inboxes for every `workers-*.json` entry is a policy decision.
- **Shared schema on two channels** (`<ns>-backlog` + `<ns>-sprint-retrospective`) is duplicated.
- **Shape sharing across families**: ca, lz and sm manifests are near-identical generated output;
  there is no `extends`. mg, tally and os are the same again (53-94 KB each).
- **Shared-envelope value constraints per kind** (mg/tally/os): a worker-inbox rule that applies to
  every type of every inbox costs one copy per type per inbox; `kind_extensions` would hold it once.
- **No sender aliases**: `roles` key off `workers[].name`; launcher-style `from` ids (`tally-orch`,
  `os-orch`, `sentinel`) cannot be mapped to a role without a fake worker entry.

## Typed tools

Hand-writing envelopes is where the drift came from (a worker invents a `summary` prefix, forgets
`affected_files`, picks the wrong channel). These tools (plus `post_plan` and `decide_plan`, see
[Plan gate](#plan-gate)) build the envelope from named fields, resolve
channels and defaults from the namespace manifest, validate through the same path as `send_message`
and **reject on any mismatch, warn-only manifest or not**: the caller learns of a schema error before
the message lands. What lands is the same JSON a worker would have written by hand, so v2 readers,
`open_questions` and `get_task_ledger` see no difference (`test-typed-tools.js` pins ledger parity).

| Tool | Posts | To | Defaults filled | Key arguments |
|---|---|---|---|---|
| `dispatch_task` | `type: task` | the target worker's manifest inbox | `type`, `from` (connection identity, else the manifest's orchestrator), `to` = `to` | `to`, `task_id`, `subject`, `body`; optional `context`, `background`, `scope`, `depends_on`, `files`, `constraints`, `checks`, `acceptance_criteria`, `result_template`, `refs`, `plan_required` (plan-gated namespaces only; written only when passed); fields in the manifest's `extensions.task.required` (namespace, sender's role or inbox channel) are mandatory |
| `post_result` | `type: result` | `<ns>-status` | `type`, `from`, `to` = orchestrator, **`subject` copied from the dispatched task** | `task_id`, `summary`; optional `body`, `affected_files`, `subject`, `to`, `refs` |
| `ask` | `type: question` | `<ns>-status` | `type`, `from`, `to` = orchestrator, `subject` = the question clipped to 120 chars (`…`), `body.question`; `body.expected_reply_channel` only when the sender's inbox is not `<ns>-<sender>` | `task_id`, `question`; optional `expected_reply_channel`, `body` (extra fields), `subject`, `to` |
| `post_note` | `type: finding` \| `decision` \| `resolved` | `<ns>-notes` | `type` = `kind`, `from`, `to` = `*` (not for `resolved`) | `kind`, `subject`; `summary`, `scope`, `evidence`, `confidence` for finding/decision; `ref_id`, `outcome` for resolved |

`ask` leaves the task `blocked` in `get_task_ledger` and listed by `open_questions` until a message
naming the `task_id` lands on the asker's inbox (or the reply channel) or the asker posts a result.

### How the namespace is found

In order: the `ns` argument (or the connection's `?ns=`), the `task_id` prefix if it names a
registered namespace, then the one manifest that declares the sender as a worker. The sender
is the `sender` argument (`from` for `dispatch_task`) or the connection's `?as=`.

### Errors

Every error is one line, `<tool>: <field>: <problem> [<source>]`, so the caller can fix the field
without reading the manifest. Exact strings the suite pins:

| Situation | Error |
|---|---|
| unknown `ns` | `post_note: ns: no manifest registered for 'x' [register_namespace]` |
| nothing to resolve from | `ns: cannot resolve — pass ns, a task_id '<ns>-…', or a sender declared in a manifest's workers [manifest lookup]` |
| sender in two manifests | `ns: sender 'wk' is a worker in a, b; pass ns [manifest workers]` |
| channel not in the manifest | `channel: manifest x declares no 'x-notes' channel [manifest x channels]` |
| unknown worker | `to: 'ghost' is not a worker in manifest x (boss, wk, rev) [manifest x workers]` (same for `sender`) |
| no orchestrator to default `to` | `to: manifest x has no orchestrator-role worker to default to; pass it [manifest x workers]` |
| result without a subject | `subject: required — no type:task '<id>' with a subject on <inbox> to copy it from [base/result]` |
| task missing a required field | `dispatch_task: checks: required by namespace x (missing: checks) [manifest x extensions.task.required]` |
| deciding with no plan | `decide_plan: task_id: no type:plan for '<id>' on x-status — nothing to decide [post_plan]` |
| amend / reject with nothing to say | `decide_plan: notes: amend needs notes or amendments [base/plan-decision]` |
| wrong summary prefix | `summary: prefix 'APPROVE' is not allowed for 'wk' (role worker); allowed: PASS\|FAIL\|SKIP [base/result]` — with a role list: `allowed: PASS\|FAIL\|SKIP\|APPROVE\|ADVISE\|BLOCK [base/result + manifest x roles.reviewer.summary_prefixes]` |
| schema violation | `<tool> rejected on '<channel>': <ajv path and message> [base/result] (see get_namespace('x'))` — no `[v2 schema …]` hint on a manifest channel |
| over the write cap | `<tool> rejected on '<channel>': content is N bytes, over the broker cap MAX_CONTENT_BYTES=32768 …` |

The summary prefix is checked against the **manifest's** role for the sender, not the role in the
connection URL: `?role=reviewer&as=wk` does not let a manifest worker post `APPROVE`. Prefixes match on
a word boundary (`PASSED` is not `PASS`).

`send_message` stays the escape hatch for shapes the typed tools do not build (patrol notes, `rotate`,
`approval-token`, heartbeats via `upsert_heartbeat`).

## Role profiles

A session's `tools/list` is part of every prompt it ever sends. A connection can declare who it is in
the MCP URL:

```
http://localhost:8080/mcp?role=<worker|reviewer|orchestrator|admin>&ns=<ns>&as=<name>
```

**No `role` means no identity.** `?ns=&as=` alone, or no query at all, gets the pre-v3 list: 34 tools,
byte-identical to the 5065c86 broker's `tools/list`; the eleven v3 tools are hidden
(`lib/profiles.js:1-4`, `V3_TOOLS` at `lib/profiles.js:60`; pinned by `test-role-profiles.js`). That is
why the watchdog sends no `role=` until a namespace is adopted. `ns` and `as` become the defaults for
`ns` and `sender`/`from` on the typed tools once a role is given (without `as` the `sender` argument
stays required). A bad value is a `400` with JSON-RPC `-32602`: `Invalid MCP URL: unknown role 'x' —
expected one of worker, reviewer, orchestrator, admin`, `'role' given more than once`, `invalid as
'bad name' — letters, digits, _ . - (max 64)` (`lib/profiles.js:identityFromQuery`). The bearer token
is still required.

**Interactive orchestrators: local-scope entry, no `as=`.** Claude Code keys a local-scope MCP entry
by repo root, so one entry serves every interactive session in that repo (client-project runs four cluster
orchestrators in one). Ten repos carry `?role=orchestrator&ns=<ns>` with no `as=`, deliberately: an `as=`
would make every session in the repo borrow one identity, inbox cursor and heartbeat key. Consequence:
`ns` defaults but `sender` does not, so typed writes (`dispatch_task`, `post_note`, ...) are rejected
with a validation error naming `sender` (nothing is written) until the caller passes `sender=`, and
reads pass `worker=` for a cursor. Headless sessions are unaffected: the watchdog's
`--strict-mcp-config` URL always carries `role`, `ns` and `as`.

Profiles are usage-based: every tool with >= 0.5% of a role's calls in 30 days of transcripts (64k
broker calls) is in its profile (`lib/profiles.js:6-7`, per-tool shares in the comment at
`lib/profiles.js:11-13`).

Sizes measured on a throwaway broker (scratch DB, `tools/list` over `POST /mcp`,
`JSON.stringify(result.tools).length`, 2026-10-29, after the plan gate):

| Connection | Tools | `tools/list` size | Source of the tool set |
|---|---|---|---|
| no `role` (any `ns`/`as`) | 34 | 28,833 B | pre-v3 list, `lib/profiles.js:1-4` |
| `role=worker` | 20 | 15,434 B | `WORKER` in `lib/profiles.js` |
| `role=reviewer` | 20 | 15,434 B | same set as worker |
| `role=orchestrator` | 32 | 23,349 B | `WORKER` + 12 more |
| `role=admin` | 44 | 40,270 B | every tool |

| Role | Tools |
|---|---|
| `worker` / `reviewer` (20) | `turn_start`, `read_messages`, `wait_for_messages`, `get_message`, `post_result`, `ask`, `post_note`, `upsert_heartbeat`, `check_result`, `send_message`, `register_capability`, `read_last`, `has_messages`, `check_results_batch`, `get_channel_schema`, `delete_message`, `worker_cursor`, `get_task_ledger`, `send_message_batch`, `post_plan` |
| `orchestrator` (32) | the worker set + `dispatch_task`, `open_questions`, `decide_plan`, `list_workers`, `start_worker`, `stop_worker`, `get_latest_heartbeats`, `sprint_summary`, `sprint_file_conflicts`, `get_latest_per_sender`, `list_channels`, `purge_channel` |
| `admin` (44) | everything, full descriptions; `adopt_namespace` is in no other profile |

The profile is data in `lib/profiles.js`. Rules the suite pins (`test-role-profiles.js`):

- **Hidden means gone and refused.** A tool outside the profile is absent from `tools/list`, and a
  call to it returns `Tool 'purge_channel' is not available to role 'worker' — reconnect with a role
  whose profile includes it (role=admin has every tool).` without running anything. A tool that does
  not exist at all gets the SDK's own not-found error.
- **`purge_channel` is in the `orchestrator` profile only** (plus `admin` and the no-role list, as in v2); workers and
  reviewers have none. It still needs `AskUserQuestion`, and a PRUNE_EXEMPT channel needs `force` +
  `admin_token` = `ADMIN_SECRET`. `purge_channels_by_prefix` is admin-only; schema and
  namespace registration (`register_channel_schema`, `register_namespace`) and `register_worker` are in
  no profile but `admin`. `delete_message` (on exempt channels only for the message's own sender),
  `get_channel_schema` and `register_capability` **are** in the worker profile, because workers
  measurably call them (`lib/profiles.js:11-15`). `dispatch_task` is orchestrator-only; only the
  orchestrator can start or stop workers.
- **Short descriptions** for profiled tools (`BRIEF`, `lib/profiles.js:35`), no `title`/`$schema`/default
  `execution` boilerplate, and no description that names a tool outside the profile. Parameters are
  unchanged, except `exclude_self` below.
- **`exclude_self` (role connections only).** `has_messages(..., exclude_self=true)` does not count the
  caller's own posts; `wait_for_messages(..., exclude_self=true)` is not woken by them. The rule is
  `GET /inbox exclude_sender`'s: a post is the caller's own when its sender is self and its JSON `from` is
  absent, not a string, or self too, so `sender=core` with `from: "dv-core"` still counts. Self is the
  connection's `as=` for `has_messages` (it has no `worker=`), and `worker=`, else `as=`, for
  `wait_for_messages`; with neither the call errors rather than ignoring the flag. `max_id` still covers
  own posts. A wake returns every matching row, own ones included, as `read_messages` would, and moves
  the cursor only then (a full `limit` page always wakes). Omitted = the old behaviour, byte for byte.
  The no-role (v2) list does not show the parameter and ignores it (`test-self-wake.js` [5]). Measured
  2026-10-31 with it: worker/reviewer 15,443 B, orchestrator 23,490 B (`BRIEF` for both tools shortened
  to pay for it).
- **No role = v2.** The list is the pre-v3 one, whatever `ns`/`as` say. `role=admin` is the v2 tools plus
  the eleven v3 tools, full descriptions.
- A role is a **tool filter, not authority**: result prefixes, worker membership and channels still
  come from the manifest.
- Budgets in the suite are ceilings with headroom over the sizes above.

## Context economy

What the server does so a session reads headlines and opens detail only when it needs it
(`test-context-economy.js`):

- **Write cap.** `MAX_CONTENT_BYTES` (default 32768) on every write path: `send_message`,
  `send_message_batch`, `POST /messages` and the typed tools. Exactly the cap is accepted, cap + 1
  is rejected, and the error names the cap, the size and `get_message`. Large output goes in a
  file (`body.output_ref`) or the repo, referenced from `refs`.
- **Summary projection.** `read_messages(..., projection="summary")` returns `type`, `task_id`,
  `from`, `to`, `subject`, `summary`, `bytes` (plus `depends_on`, `affected_files_count`). `subject` and
  `summary` are clipped to 300 characters and flagged `truncated`. Unparseable content comes back as
  `{bytes, text}` (first 120 characters). Scan the summary, then open only the ids you need.
- **`get_message(channel, id, path?)`.** One message, or the JSON value at `path`
  (`body.required_checks`, `body.commits[0].sha`, `body["a.b"]`). Does not move cursors.
- **Server-side cursors.** Reads without `since_id` resume from a cursor kept per (worker, channel);
  with none they return the newest N, never the oldest. `turn_start` reads inbox and control in one
  call and reports `rotate_requested`. A `type: status` with `body.handoff_notes` rewinds the
  sender's inbox cursor so the replacement session sees the task again; the watchdog rewinds with
  `PUT /cursors` after a silent exit, timeout, rotation or backoff.
- **Full reads are unchanged.** Without `projection` a read returns exactly what was stored.

## Watchdog v3

`watchdog.sh` launches sessions with `--output-format stream-json --verbose` and reads the
context size from the session's own stdout: the `usage` of the latest top-level assistant event
(`input_tokens + cache_read_input_tokens + cache_creation_input_tokens`; subagent turns are skipped).
Behaviour is driven by environment variables:

| Variable | Default | Effect |
|---|---|---|
| `ROTATE_AT_TOKENS` | 150000 | Context size at which heartbeats carry `context.rotation_recommended: true`. `0` disables rotation. |
| `ROTATE_KILL_AFTER_S` | 300 | A session still over the threshold this many seconds after crossing it is terminated and relaunched fresh. `0` = recommend only, never kill. (Was 600 until cb-2026-10-29-rotation-signal: sessions now get the signal in-band, so 5 minutes is enough to hand off.) |
| `WATCHDOG_ROTATION_HOOK` | `hooks/rotation.mjs` next to `watchdog.sh` | The rotation PostToolUse hook (below). A missing file logs `WARN: rotation hook missing` and sessions run without it. |
| `WATCHDOG_STREAM_JSON` | 1 | `0` launches with plain-text output; the context size is then reported as 0. |
| `WATCHDOG_HEARTBEAT_INTERVAL` | 30 | Seconds between in-session heartbeats. |
| `FOLLOWUP_MAX` | 3 | Cap on consecutive follow-up launches (see below). `0` = never follow up. |
| `NET_BACKOFF_BASE` / `NET_BACKOFF_MAX` | 15 / 600 | Seconds: relaunch delay after an API-unreachable session doubles from BASE up to MAX. |
| `WATCHDOG_MCP` | 1 | Hand every session its own MCP config pointing at `BROKER_URL/mcp?ns=&as=` (`--strict-mcp-config` when supported). `0` = no MCP flags. |
| `WATCHDOG_NAMESPACE` | from the inbox prefix | Namespace; `start_worker` exports the workers-config entry's `ns`. With neither it and no `--inbox-channel` the watchdog exits with an error. |
| `WATCHDOG_ROLE` / `WATCHDOG_AS` | derived | Override the derived role (`worker`\|`reviewer`\|`orchestrator`\|`admin`) and sender name. An explicit `WATCHDOG_ROLE` also puts `role=` in the URL. Derived `as` = inbox minus `<ns>-`; derived role = orchestrator for `orchestrators/*` or an `*-orch`/`*-orchestrator` inbox, reviewer when the inbox or path names one, else worker. |
| `WATCHDOG_ROLE_URL` | 0 | `1` puts `role=` in every session's URL. Default: only `ns=&as=` (the pre-v3 tool list). |
| `WATCHDOG_ROLE_NAMESPACES` | empty | Comma list of namespaces whose sessions get `role=` — an `.env` opt-in that needs a broker restart; prefer `adopt_namespace`. |
| `WATCHDOG_NS_ADOPTED` | 0 | Set by `start_worker` on every spawn from the namespace's stored adoption (`1` adopted, `0` otherwise, `lib/workers.js:85`); not meant to be set by hand. `1` puts `role=` in the URL and keys on `as`, unless `WATCHDOG_ROLE_URL=0` (`watchdog.sh:166`). |
| `WATCHDOG_MCP_INHERIT` | off | Only the exact value `1` keeps the user/local/project-scope MCP servers in the session's MCP config next to the broker; unset or any other value drops them (strict mode). An entry's `mcp_servers` overrides it. See [Guardrails](#guardrails) for the live-flip impact. |
| `WATCHDOG_MCP_SERVERS` | set by `start_worker` | The entry's `mcp_servers` as a JSON array (`""` when the entry has none, so the broker env never applies one list to every entry); not meant to be set by hand. See [MCP servers per entry](#mcp-servers-per-entry). |
| `WATCHDOG_GUARDRAIL_NAMESPACES` | empty | Comma list of namespaces whose sessions run with the guardrail hook (see [Guardrails](#guardrails)). `WATCHDOG_GUARDRAILS=1` turns it on for every namespace, `WATCHDOG_GUARDRAILS=0` off for all. Default: off. |
| `WATCHDOG_GUARDRAILS_HOOK` | `hooks/guardrails.mjs` next to the script | Hook path. |
| `WATCHDOG_ALLOWED_TOOLS` / `WATCHDOG_DISALLOWED_TOOLS` / `WATCHDOG_GUARDRAILS_EXTRA_DENY` | set by `start_worker` | The entry's `allowed_tools`, `disallowed_tools` and `guardrails.extra_deny` as JSON arrays; not meant to be set by hand. |
| `WATCHDOG_REPO_ROOT` | cwd, script dir, or its parent holding `<worker>` | Project root when the entry has no `--repo-root`. |
| `NODE_BIN` | `node` on PATH, then `/usr/local/bin`, `/opt/homebrew/bin`, newest `~/.nvm` | Node used for JSON parsing; a launchd-started broker passes a PATH without node. |
| `WATCHDOG_JITTER_MAX` | 20 | Start-up jitter ceiling in seconds. |
| `WATCHDOG_MODEL_BY_SCOPE` / `WATCHDOG_REVIEWER_MODEL` / `WATCHDOG_NO_TASK_MODEL` | see [Model routing](#model-routing) | Per-launch model for unpinned sessions. |
| `WATCHDOG_VERIFY_NAMESPACES` | empty | Comma list of namespaces whose results are harness-verified after each session (see [Harness-verified checks](#harness-verified-checks)). `WATCHDOG_VERIFY=1` turns it on for every namespace, `WATCHDOG_VERIFY=0` off for all. Default: off. |
| `WATCHDOG_VERIFIER` / `VERIFY_CHECK_TIMEOUT_S` | `verify-result.mjs` next to the script / 900 | Verifier path; per-check timeout in seconds when the dispatch check has no `timeout_s`. |

Source for the defaults above: the header comment and assignments in `watchdog.sh` (`:35-60` for the
`WATCHDOG_*`/`NODE_BIN` rows, `:156-171` role opt-in and `WATCHDOG_NS_ADOPTED`, `:190-196` repo root, `:252-263` node discovery,
`:293-294` rotation, `:479-484` backoff and follow-up).

**Session identity and keys.** The default URL is `/mcp?ns=<ns>&as=<as>`. Opted in (any of
`WATCHDOG_ROLE`, `WATCHDOG_ROLE_URL=1`, the namespace in `WATCHDOG_ROLE_NAMESPACES`, or an adopted namespace) it is
`/mcp?role=<role>&ns=<ns>&as=<as>`. Until opted in, the cursor, heartbeat-sender and ledger key is the
worker path basename, exactly as the client project's watchdog keyed them, so existing cursors and dashboards
carry over; once opted in it is `as` (`watchdog.sh:166-171`; `--print-channels` prints `role_url`,
`mcp_query` and `key`; pinned by `test-watchdog-v3.js` and `test-role-profiles.js`).

**Env reaches the watchdog.** `start_worker` passes the broker's environment to a subprocess watchdog,
and `spawnWatchdogTmux` forwards every `WATCHDOG_*` variable of the broker env into the tmux window
(`lib/workers.js:97-109`, `:170-184`; an explicit `WATCHDOG_NAMESPACE` from the config entry wins).

**Heartbeat.** Each working beat has `context: {size_tokens, cache_read, cache_create,
tier_threshold_pct, rotation_recommended}` and top-level `session_id`. `tier_threshold_pct` =
`size_tokens * 100 / ROTATE_AT_TOKENS`. The session-end beat has `activity: {state: "session-end",
exit_code}`.

**Rotation.** At the first beat over the threshold the log says `context N >= T tokens — rotation
recommended`; the session is expected to write a `handoff_notes` status and exit. A session cannot see
its own token count and never reads `<ns>-telemetry` mid-task, so the watchdog tells it in-band:

- **Flag.** At that first beat the watchdog writes `/tmp/watchdog-<worker>-<inbox>-rotate-flag`
  (`{size, threshold, crossed_at, status_base}`, atomically). The flag and its `.count` are deleted
  before every launch and after every session.
- **Hook.** `hooks/rotation.mjs` runs as a PostToolUse hook for **every** namespace while
  `ROTATE_AT_TOKENS > 0`, independent of `WATCHDOG_GUARDRAIL_NAMESPACES`. cli: the session's
  `--settings` file has `hooks.PostToolUse` (matcher `*`), next to the guardrail `PreToolUse` when
  guardrails are on. sdk: the runner gets `--rotation-flag <file>` and installs it in-process. With no
  flag the hook prints nothing. With one it returns
  `hookSpecificOutput.additionalContext`: `ROTATE NOW: context N >= T tokens. Finish the current edit,
  commit or stash on your branch, post type:status with body.handoff_notes
  {done,pending,files_touched,next_step}, then exit.`, on the 1st, 6th, 11th … tool call after the flag
  appears (at most every 5 calls). It always exits 0 and never blocks a tool. Verified on claude 2.1.288:
  a live `claude -p` probe with a PostToolUse `additionalContext` hook got the injected text back from
  the model; the Agent SDK's `PostToolUseHookSpecificOutput.additionalContext` is the same field.
- **Fallback handoff.** After a kill-rotation or a session timeout (or a non-zero crash that left the
  worker's worktree dirty), if the session posted no status with `body.handoff_notes` as the worker
  since crossing (since session start when it never crossed), the watchdog posts one for it on
  `<ns>-status`: sender = the worker key, `task_id` = the ledger's in-flight task (first by state
  `in-progress`, `handoff`, `plan-review`, `planning`, `pending`, then oldest dispatch),
  `subject: "watchdog fallback handoff — <kill-rotation|timeout|crash> at N tokens"`,
  `body.handoff_notes` (files_touched from `git status --short`), `body.git {branch, head,
  status_short, diff_stat}` (capped) and `body.source: "watchdog"`. Like any handoff status it rewinds
  the worker's inbox cursor to before the dispatch and puts the task in ledger state `handoff`, so the
  next session re-reads it and knows uncommitted work exists. A clean crash posts nothing.

If it is still over
`ROTATE_KILL_AFTER_S` later: `terminating for rotation`, then `rotated at N tokens — relaunching a
fresh session`. The relaunch happens even with an empty inbox (`reason: rotate`); if the killed session
had not consumed its inbox task, the relaunch is an ordinary `reason: inbox` launch and re-reads it
(the cursor is unchanged). A rotation kill is not counted as a network failure.

**Follow-up launches.** A session that exits cleanly while `get_task_ledger` still shows open tasks
for this worker (`pending`, `in-progress`, `handoff`; not `blocked`) is relaunched after 2 s with
`reason: followup` and the worker's cursor rewound to the oldest open dispatch, instead of idling until
the next inbox message (the failure mode in cb-notes #169270). The budget is `FOLLOWUP_MAX` and resets
when the open count drops or a new inbox message arrives; past it the log says `WARN: N open task(s)
after M follow-up launches without progress — idling until new inbox work`.

**API unreachable.** A session that fails (non-zero exit, or a clean exit with an error result) and
whose stderr or result text matches `ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|getaddrinfo|Connection
error|fetch failed|…` is a network failure: `API unreachable (exit E, failure #N) — backing off Ws
(cursor unchanged)` with W = BASE, 2·BASE, 4·BASE … capped at MAX. The session-end heartbeat carries
`context.backoff: {reason: "api-unreachable", attempt, delay_s, resume_at}`; the inbox task is retried
because the cursor is not advanced. The first successful session resets the counter. Only stderr,
plain output and result/error events are matched: tool output that merely mentions `ENOTFOUND` is an
ordinary `non-zero exit`. Rate limits (`429`, `overloaded`) are handled separately and win over this.

These behaviours reach a worker only when the broker's `WATCHDOG_BIN` points at this script; before the
go-live switch the fleet ran the client project's copy (cb-notes #169344). Check the broker `.env` for the value
in force.

## Harness-verified checks

A result's `body.required_checks` is the worker's own claim. With verification on, the harness re-runs
the task's dispatch `checks[]` itself and stores the outcome beside the result; `get_task_ledger` then
reports what the harness saw, not what the worker said.

**Opt-in, per namespace, default off.** Set `WATCHDOG_VERIFY_NAMESPACES=cb,dv` in the broker `.env`
(every `WATCHDOG_*` variable reaches the watchdog; it takes effect at the next `start_worker`), or
`WATCHDOG_VERIFY=1` for all namespaces. `WATCHDOG_VERIFY=0` vetoes. `--print-channels` prints the
decision as `verify=on (…)` / `verify=off (…)`. With it off nothing runs and every ledger row keeps
`verified: null`, so running fleets are unchanged.

**When it runs.** After every session (before the relaunch decision) the watchdog calls
`node verify-result.mjs --status-channel <ns>-status --worker <as> --repo <work dir> --since-id <status max id before the session>`.
A verifier failure is logged as a `WARN` and leaves the results unverified; it never stops the worker.
The verifier can also be run by hand (`--dry-run` prints the plan and runs nothing).

**What runs — dispatch checks only.** The broker picks the candidates (`GET /verifications/pending`):
the latest `type: result` per task after `since_id` that has a non-empty `body.commits`, not yet
verified, whose **first** `type: task` dispatch **at or before the result** sits in a namespace inbox
**and was stored with DB sender = the namespace orchestrator** (the manifest's `orchestrator`-role
worker, else `orchestrator`). The JSON `from` field is not trusted, here or for `worker=` (matched
against the result's DB sender only). A later copy of the dispatch, or one posted after the result,
does not replace the first one's checks. Only that dispatch's `checks[].run` commands execute; nothing in a result
body (`checks`, `required_checks`, anything else) is ever run. A dispatch from another sender, or with
no `checks[]`, is reported under `skipped`. A dispatch check may set `timeout_s`.

**How it runs.** For each candidate, at the **last** `body.commits[].sha`:

1. The sha must be a commit in the verifier's `--repo`. If it is not, but the candidate's branch resolves there
   (so the repo demonstrably has the worker's objects), the citation is bogus: a single `commit` FAIL. If the
   branch does not resolve either, it is the verifier's checkout: a single `commit` ENV `commit-missing`
   (verified null; re-verify with `--result-id` once it is fetched).
   **Branch rule.** The sha must then be an ancestor of the candidate's `branch` (`origin/<branch>` or
   `<branch>`) or of main (`origin/main`, `main`: commits already merged or carried there). The broker sets
   `branch`, never the result body: the dispatch's own top-level `branch` string if it names one, else
   `worker/<result DB sender>`. A sha on neither is a single `branch` FAIL ("not on worker/core … nor on main"),
   so a worker cannot cite somebody else's passing commit. A sha off main whose branch does not resolve in
   `--repo` is ENV `commit-missing`. A candidate without `branch` (a broker older than this rule) is verified
   as before, with a `WARN`.
   A commit that tracks `node_modules` at any depth (directory, file or symlink) is refused with a single
   `node_modules` FAIL naming the path: nothing in it is checked out, loaded or run.
2. `git worktree add --detach <tmp>/verify-<task>-XXXX <sha>` — a scratch worktree, never the worker's
   live checkout. The repo's `node_modules` is symlinked in (it is untracked).
3. Each check runs as `bash -c <run>` in its own process group, with a timeout (`timeout_s`, else
   `VERIFY_CHECK_TIMEOUT_S`=900); on timeout the group gets SIGTERM, then SIGKILL after 5 s.
   Environment: fresh free `PORT` and `TEST_PORT`, `DB_PATH` inside the scratch worktree, `VERIFY_RUN=1`,
   and with `BROKER_*`, `WATCHDOG_*`, `FOLLOWUP_*`, `ANTHROPIC_*`, `CLAUDE_CODE_*`, every `*_API_KEY`,
   `*_SECRET` and `*_TOKEN` (so `SHARED_SECRET`, `ADMIN_SECRET`, `GH_TOKEN`, `GITHUB_TOKEN`) and
   `WORKERS_CONFIG` removed, so a check can neither reach the live broker or another service with the
   watchdog's credentials nor bind 8080 by default.
   **Node.** Checks run with one node first on `PATH`: `--node <path>`, else `VERIFY_NODE_BIN`, else the first
   candidate that loads the scratch worktree's `better-sqlite3` (its native addon is built for one ABI, so a
   check under another node fails before testing anything): the verifier's own node,
   `$NVM_DIR`/`~/.nvm/versions/node/*/bin/node` newest version first, `/opt/homebrew/bin/node`,
   `/usr/local/bin/node`. A worktree without `better-sqlite3` uses the verifier's own node; if no candidate
   loads it, so does the verifier, and the checks fail on their own. The probe runs with the checks'
   stripped environment (above, without the per-check `PORT`/`DB_PATH`), since it loads worktree code. Every check's `tail` starts with
   `[verify] node: <path> <version> (<why>)`, the probe naming each candidate it rejected and its ABI.
4. A check is `PASS` iff it exits 0 within its timeout. `pass_condition` is prose: it is passed along
   for humans, not evaluated.
5. The scratch worktree is removed (`git worktree remove --force`, then `git worktree prune`).

**Where it is stored.** `POST /verifications` writes one row per result message in the `verifications`
table; the worker's message is never edited. Each check is stored as
`{name, status: PASS|FAIL, exit_code, timed_out?, duration_ms, tail}` (`tail` = last 20 lines, ≤ 2000
chars). `verified` = every check PASS.

| Endpoint | Purpose |
|---|---|
| `GET /verifications/pending?status_channel=&worker=&since_id=&result_id=` | `{orchestrator, candidates: [{task_id, result_id, dispatch_id, dispatch_channel, sender, sha, branch, plan_approved, checks}], skipped: [{task_id, result_id, reason}]}` |
| `POST /verifications` `{status_channel, result_id, dispatch_id?, sha?, checks}` | Store (or replace) the verification of one result; a replaced outcome moves into the row's `history`. 404 if `result_id` is not a `type: result` on that channel. |
| `GET /verifications?status_channel=&task_id=` | Every stored verification of the task, newest result first, each with its `history` (the outcomes a re-verify replaced, oldest first; names, statuses and exit codes only). |

**Re-verify one result.** `node verify-result.mjs --status-channel <ns>-status --repo <dir> --result-id <id>`
re-runs that result (a false harness FAIL, a fixed environment) even though it already has a verification;
`result_id` on `/verifications/pending` selects it the same way, and a `result_id` that is not a result with
`body.commits` is a 404 (exit 1). The new outcome replaces the row and the old one is appended to `history`
(last 10). Without `--result-id` a verified result is never picked again. Trust is unchanged: the checks still
come only from the trusted dispatch.

**Ledger.** Every `get_task_ledger` row has `verified: true | false | null` for its latest result
(`null` = not verified: verification off, no commits, no trusted dispatch with checks, or not run yet).
A `false` row carries `verification_failed: [<check names>]`, and a self-reported `PASS` (state `done`)
with a failed verification is reported as `failed` and counted as failed. A newer result is a new
verification: the ledger reads the row of the latest result only.

**Limits.** The DB sender is not an identity: `send_message` takes `sender=` from the caller, and
workers have it, so a worker can store a `type: task` as the orchestrator. Taking the first dispatch
at or before the result stops a later forged copy from replacing real checks, but a task the
orchestrator never dispatched can still be forged before its result. Binding `sender` to the
connection's `?as=` is the real fix. The endpoints use the shared bearer token, which worker sessions
also hold, so a session could also post a forged verification, unless the verifier credential is on for its
namespace (below). The scratch worktree shares the repo's
`node_modules` (symlink), which a check could write into. The verifier is a check on honest mistakes and stale
self-reports, not a sandbox against a hostile worker. Checks run with the watchdog user's
privileges in a temp directory: they are the orchestrator's commands, so treat `checks[]` like any
other script the orchestrator dispatches. For a namespace that needs more than that, enable the orchestrator
credential (below).

### Orchestrator credential (enablement)

With the credential on for a namespace, the orchestrator's sender names (the manifest's `orchestrator`-role
workers, else `orchestrator`) are reserved on its `<ns>-` channels. A write under one of those names
(`send_message`, `send_message_batch`, `POST /messages`, typed tools) needs the `X-Orchestrator-Token` header,
so a worker can no longer store a dispatch or a plan-decision as the orchestrator. The guard matches the prefix
in any letter case (`CB-core` is refused like `cb-core`). The trust readers (verifier dispatch, plan gate,
decisions) match it exact-case only. `register_namespace` on such a namespace, or on any namespace whose
registered manifest has `plan_gate: true`, needs `admin_token` (`ADMIN_SECRET`) or the orchestrator header.
With neither configured it is refused.

1. Generate the token: `openssl rand -hex 32`. Its sha256 is `printf %s "$TOKEN" | shasum -a 256 | cut -d' ' -f1`.
2. Broker env (`.env`, broker restart): `ORCHESTRATOR_TOKEN_SHA256=<sha256>` and
   `ORCHESTRATOR_TRUST_NAMESPACES=cb,dv` (comma-separated). Enforcement needs both. The broker stores only the
   hash, so leaking `.env` does not leak the token.
3. Give the token to the orchestrator only. Use the user-scope MCP entry's headers
   (`"headers": {"X-Orchestrator-Token": "<token>"}` in `~/.claude.json`), or `ORCHESTRATOR_TOKEN` in the env
   of `runner/orchestrate.mjs`. **Never put it in a repo `.mcp.json`:** worker sessions read the repo, and
   `start_worker` strips `ORCHESTRATOR_TOKEN*` from watchdogs for the same reason.
4. Check: `curl -s localhost:8080/health` reports `"orchestrator_trust": {"enabled": true, "namespaces": ["cb", "dv"]}`.
   A worker's `send_message(channel="cb-core", sender="orchestrator", …)` is refused, naming the header.

Turning it off (unset either variable, then restart the broker) restores v2 behaviour. `/health` then
reports `enabled: false`.

### Verifier credential

Without it, any `SHARED_SECRET` holder can `POST /verifications`, so a worker can overwrite its own FAIL with
all-PASS checks; and the watchdog's verifier runs inside the worker's own process tree, so a token handed to it
would reach the worker too. With the credential on for a namespace, verification moves to a standalone verifier
outside every worker's tree, and only that verifier can stamp:

- **Broker** (`lib/auth.js`): `VERIFIER_TOKEN_SHA256=<sha256>` and `VERIFIER_TRUST_NAMESPACES=cb` (comma list,
  independent of `ORCHESTRATOR_TRUST_NAMESPACES`). Enforcement needs both. `POST /verifications` for a status
  channel `<ns>-…` of a listed namespace (any letter case) without an `X-Verifier-Token` whose sha256 matches is
  refused with **403**. `GET /verifications*` are unchanged. `/health` reports
  `"verifier_trust": {"enabled": true, "namespaces": ["cb"]}`. The broker stores only the hash.
- **Verifier**: `node verify-result.mjs --watch <ms> --status-channel <ns>-status --repo <checkout>` under its
  own launchd job (`runner/com.claude.broker.verifier.plist.example`), with `VERIFIER_TOKEN` (sent as
  `X-Verifier-Token`), `BROKER_SECRET` and `VERIFY_NODE_BIN` in the plist's `EnvironmentVariables`. Each cycle it
  reads `/health`. While `verifier_trust` does not list its namespace it only logs `state: idle`. Once listed, it
  `git fetch origin`s when there are candidates, verifies every pending result after its cursor
  (`~/.claude-broker/verifier/<status>.since`, first start = the channel's current max id, `--since-id` seeds it)
  and logs one JSON line per cycle (`candidates`, `skipped`, `outcomes`). A lock file next to the cursor
  (`<status>.lock`, pid) keeps a second verifier off the same namespace. A live holder counts as a verifier only if
  its command line has `verify-result.mjs`, `--watch` and `--status-channel <this channel>` as arguments; then the
  new start exits 1 and posts a `type: note` alert on the status channel, at most once a day per namespace
  (`<status>.alerted`), since launchd restarts it every cycle. A stale lock (dead pid) is replaced; one held by any
  other live pid (a reused pid, a decoy) is taken over with an `ERROR` and a `type: note`, posted once the lock is
  this process's. A lock is broken only under an exclusive `<status>.lock.takeover` file and only if it still holds
  the pid judged, so two concurrent starts never both hold it. The token
  never reaches a check (`*_TOKEN` is stripped from the checks' env).
- **Watchdogs** stop verifying a listed namespace: a watchdog whose env has the namespace in
  `VERIFIER_TRUST_NAMESPACES` (start_worker sets it on both the subprocess and tmux paths to the broker's
  effective list, empty unless the hash is set too, so a list without a hash never switches verification off) prints
  `verify=external (…)`; one started before the broker enforced asks `/health` before each verification and
  logs `verification: external` instead of collecting 403s.
- **Token isolation**: `start_worker` strips `VERIFIER_TOKEN*` (with `ADMIN_SECRET` and `ORCHESTRATOR_TOKEN*`) from
  every spawned watchdog (`lib/workers.js spawnEnv`, tmux `-e` list), and `watchdog.sh` unsets all three on
  start, so a watchdog launched by hand from a shell that holds them does not pass them to its sessions.
- **Same-uid limit**: this isolation is per process tree, not per user. While the verifier runs as the same macOS
  user as the worker sessions (the LaunchAgent in `runner/com.claude.broker.verifier.plist.example`), a session
  with Bash can still read the token: `ps eww -ax` shows a same-uid process's environment, and the installed plist
  is readable by its owner (`chmod 600` does not stop the same uid). Check code the verifier runs can read its
  parent's environment the same way, even though `STRIP_ENV` keeps the token out of the check's own env. The same
  uid can also write the verifier's state dir (`~/.claude-broker/verifier`): push its `.since` cursor forward, or
  plant a pid in its `.lock`. The verifier takes over a lock held by a live pid that is not a `--watch` verifier for its channel, and
  posts a `type: note` alert on the status channel; a real verifier holding it is reported the same way, once a day. None of this forges a PASS without the token, but results can
  quietly go unverified. So today the credential stops accidental and casual stamping (a `SHARED_SECRET` holder can
  no longer stamp with one curl), not a worker that deliberately reads the token. The fix is to run the verifier
  as its own macOS user: a LaunchDaemon with `UserName`, its plist owned by root or that user, its state dir owned by
  that user, the repo readable by it. `ps` then hides its environment from non-root users and the plist is unreadable.

**Go-live order.**

1. Generate the token (`openssl rand -hex 32`) and its hash (`printf %s "$TOKEN" | shasum -a 256 | cut -d' ' -f1`).
   Install and start the launchd verifier with the token. It idles: the broker does not list the namespace yet.
2. Broker `.env`: `VERIFIER_TOKEN_SHA256=<hash>`, `VERIFIER_TRUST_NAMESPACES=cb`.
3. Restart the broker. From here `/health` lists `cb`: the verifier starts stamping on its next cycle, and
   running watchdogs see `/health` and skip their own verification.
4. Restart the namespace's watchdogs (`stop_worker` + `start_worker`) so they print `verify=external` from env too.

There is no double-verify and no 403 window. Before step 3 only the watchdogs verify (the verifier idles). After
it only the verifier does, including for watchdogs not yet restarted. A result posted in the seconds around the
restart is picked by whichever side runs next: the other one sees it as already verified. The only overlap is
a watchdog whose `/health` read failed (broker mid-restart) and that falls back to verifying. Its POST is then
refused with 403 and logged as a `WARN`, and the verifier stamps the result itself.

Turning it off: unset either broker variable and restart the broker. The verifier goes back to idle and watchdogs
with `WATCHDOG_VERIFY_NAMESPACES` verify again once restarted (`start_worker` then passes an empty list).

## Model routing

Each session's model is chosen by the watchdog **before every launch**. A pinned model never changes;
an unpinned worker gets a model that matches the next task.

**Precedence, highest first.** The first rule that applies wins:

| # | Rule | Model | `model_reason` |
|---|---|---|---|
| 1 | `start_worker(model=…)` | that model | `pinned` |
| 2 | the workers-config entry's `model` | that model | `pinned` |
| 3 | reviewer entry: `role: "reviewer"` or a name ending in `-reviewer` | `WATCHDOG_REVIEWER_MODEL` (default `claude-opus-5-5`) | `reviewer` |
| 4 | patrol launch, or no task for this worker in `get_task_ledger` that is open, `blocked` or `plan-review` | `WATCHDOG_NO_TASK_MODEL` (default `claude-haiku-4-5-20251001`) | `no-task` |
| 5 | the oldest open task's `scope` (`small`\|`medium`\|`large`), else the oldest `blocked` / `plan-review` task's: the entry's `model_by_scope` first, then `WATCHDOG_MODEL_BY_SCOPE` | per scope; default `small=claude-sonnet-5-5,medium=claude-sonnet-5-5,large=claude-opus-5-5` | `scope:<s>` |
| 6 | that task has no scope | the default: `claude-sonnet-5-5` (the broker's `CLAUDE_MODEL`, if set, replaces it) | `default` |

Rules 1–2 are what `start_worker` already did. They reach the watchdog as `CLAUDE_MODEL` plus
`WATCHDOG_MODEL_PINNED=1`. An unpinned spawn sets `WATCHDOG_MODEL_PINNED=0`, so a `CLAUDE_MODEL` from the
broker env only replaces the default and pins nothing. A watchdog run by hand with no `WATCHDOG_MODEL_PINNED`
treats `CLAUDE_MODEL` as a pin. The unpinned default changed from `claude-haiku-4-5-20251001` to `claude-sonnet-5-5`.

**Inputs.** The watchdog finds the scope by asking `get_task_ledger` (`only_open`, `workers=[<key>]`) for the
oldest open dispatch, which is the one the session picks up first. With nothing open it takes the oldest
`blocked` (open question) or `plan-review` task: the session launched by the answer or the plan decision
works on that task, so it must not run on the no-task model (on 2026-10-29 a blocked medium task's session
ran on Haiku and took the live broker down). Blocked and plan-review tasks still do not count as open for
follow-up launches. `dispatch_task` sets `scope`. Pinned and
reviewer sessions skip that lookup. `start_worker` sends what only the config knows on every spawn, on both
the subprocess and tmux paths: `WATCHDOG_MODEL_PINNED`, `WATCHDOG_REVIEWER` (`1`/`0`),
`WATCHDOG_ENTRY_MODEL_BY_SCOPE` (the entry's `model_by_scope` object as `small=…,large=…`) and
`WATCHDOG_MODEL_WARNING`. The env maps use `scope=model` pairs, comma-separated. Invalid ids are dropped, and a
scope missing from both maps falls back to the built-in map.

```json
{ "name": "core", "ns": "cb", "args": ["workers/core"], "model_by_scope": { "large": "claude-opus-5-5", "small": "claude-haiku-4-5-20251001" } }
```

**Telemetry.** Every heartbeat (the session-start `working` beat, the periodic beats and `session-end`)
carries the resolved model as `model` and the reason as `context.model_reason`. Rate-limit events carry
the same `model`. The launch log line `--- restart #N [reason: …, inbox_max_id: …] ---` is followed by `model: <id> (<reason>)`. At startup the watchdog logs
`model routing: pinned:<id>` | `reviewer:<id>` | `scope(small=…,medium=…,large=…,no-task=…,default=…)`, and
`--print-channels` prints that line as `model_route=`.

**Same-model warning.** A reviewer that runs on the same model as the writers it reviews tends to repeat
their blind spots. For each namespace, the broker compares every reviewer's model on a typical task with
each writer's (orchestrators excluded). "Typical" means the pinned model, else the reviewer model for a
reviewer, else the `medium` scope model. Each match is logged as `WARN model routing: namespace <ns>:
reviewer <r> and writer(s) <w…> resolve to the same model <m>`:

- at broker startup;
- in the startup log of the watchdog of each worker involved;
- as `model_warning=` in `--print-channels` (`none` when there is no match).

`list_workers` does not show it yet (`lib/tools/workers.js`). `sameModelWarnings()` in `lib/workers.js` is
the function to call from there.

## Guardrails

Headless sessions run with `--dangerously-skip-permissions` (the SDK runner: `bypassPermissions`), so nothing
asks before a destructive command. The guardrail hook, `hooks/guardrails.mjs`, is a `PreToolUse` hook that
denies a short list of commands no worker task needs. A deny becomes the tool result: the session reads the
reason and takes another approach. The command does not run, and the session is not stopped. The hook catches
mistakes. It does not stop an adversary: a command assembled at runtime (in variables or generated scripts)
can get past a static check.

**Opt-in, per namespace.** The guardrails follow the verified-checks pattern, so fleets already running are
unchanged at merge:

| Setting | Effect |
|---|---|
| `WATCHDOG_GUARDRAIL_NAMESPACES=cb,mg` | on for the listed namespaces |
| `WATCHDOG_GUARDRAILS=1` | on for every namespace |
| `WATCHDOG_GUARDRAILS=0` | off for all; overrides the list |
| (nothing) | off |

`start_worker` passes the broker env to the watchdog on both the subprocess and tmux paths, so a change to
the broker's `.env` takes effect on the next `stop_worker` + `start_worker`. The startup log line
`guardrails: on (…) — MCP inherit: …` and the `guardrails=` / `mcp_inherit=` lines of `--print-channels` show
the result. If guardrails are on and the hook file is missing, the watchdog exits 1 instead of running
unguarded.

**Rules.** "The worktree" is `git rev-parse --show-toplevel` of the worker's directory. A nested repo counts
as a different worktree. "tmp" is `/tmp`, `/private/tmp`, `/var/tmp`, `$TMPDIR` and `os.tmpdir()`.

| Rule | Denies |
|---|---|
| `git-force-push` | `git push` with `--force`, `-f` (also inside a cluster such as `-uf`), `--force-with-lease[=…]`, `--force-if-includes`, or a `+refspec` |
| `git-push-protected` | a push whose destination is `main` or `master` (`origin main`, `HEAD:main`, `x:refs/heads/master`), `--all` or `--mirror`, and a bare `git push` / `git push origin HEAD` while `main` or `master` is checked out |
| `git-reset-hard` | `git reset --hard` whose repo (`-C`, `--work-tree`, any `cd` earlier on the line) is outside the worktree and outside tmp |
| `git-clean-force` | `git clean -f` / `--force` with the same target check |
| `rm-outside-worktree` | `rm` with `-r` / `-R` / `-f` on a target that is not strictly inside the worktree or tmp. Also denied: the worktree root itself, a target with a variable the hook cannot resolve (`$HOME`, `$PWD`, `$TMPDIR` are resolved), and `xargs rm -rf` (its targets cannot be seen) |
| `secret-read` | any path under `~/.ssh`, `~/.aws`, `~/.config/gh`, or `~/.netrc`, and any `.env*` outside the worktree. Checked in every word of a Bash line (including redirections and `--opt=<path>`) and in the path of Read, Edit, MultiEdit, Write, NotebookEdit, Grep, Glob and LS |
| `git-no-verify` | `git commit --no-verify` / `-n` (also in a cluster such as `-nm`) and `git push --no-verify` |
| `broker-kill` | `kill` of the pid listening on the broker port, or of a pid computed on a line that names the broker (`kill $(lsof -ti:8080)`, `lsof -ti:8080 \| xargs kill`, `pgrep -f server.js \| xargs kill`), except a `$VAR` assigned from `$!` earlier on the line (`PORT=5555 node server.js & BP=$!; …; kill $BP`); `kill` with target `-1` in any signal form (`kill -9 -1`, `kill -TERM -1`, `kill -s KILL -1`, `kill -- -1`) and `pkill`/`killall` with a `-1` after the first word; `pkill` whose pattern names `server.js`, `claude-broker` or `node…server`, or would match the broker (`pkill node`, `pkill -f node`); `killall node`/`npm`; `fuser -k <port>/tcp` |
| `broker-launchctl` | `launchctl kickstart`/`bootout`/`stop`/`unload`/`remove`/`kill`/`disable` naming `com.claude.broker*` |
| `broker-start` | in the claude-broker repo only (the worktree root, the directory the line runs in, its git toplevel, the script's directory or `npm --prefix` has a `server.js` and a `package.json` named `claude-broker`, or a `server.js` that names it): `node … server.js`, `nodemon`/`npx nodemon server.js`, `npm start`, `npm run start\|dev`, `yarn\|pnpm dev` with `PORT` unset, unresolvable (`$P`), or equal to the broker port; `PORT` comes from a `PORT=` prefix, `env PORT=`, an earlier `export PORT=` on the line, else the session env. Another project's dev server passes |
| `extra-deny` | the entry's own patterns (below) |
| `tool-not-allowed` | a tool missing from the entry's `allowed_tools` (below) |

The hook follows `cd`, `bash -c`, `sh -c`, `eval`, `$(…)` and backticks, and it strips wrappers (`sudo`,
`env`, `timeout`, `nohup`, `xargs`, `VAR=val` prefixes). It does not check heredoc bodies or words that
contain whitespace (commit messages and other prose), so `git commit -m "deny ~/.ssh reads"` and a heredoc
that mentions `rm -rf /` both pass. Normal worker work passes: an in-worktree commit, `rm -rf build`,
`git reset --hard` in the worktree, test runs, and a push of the worker's own branch. `test-guardrail-hooks.js`
pins every rule and these non-matches. The broker port is the config's `broker_port` (the watchdog writes
`BROKER_URL`'s), else `$BROKER_URL`'s, else 8080. A test that starts its own broker on a free port
(`PORT=5555 node server.js`, or a `node test-*.js` that spawns one) passes.

**Per entry (workers config).** Every key is optional:

```json
{ "name": "core", "ns": "cb", "args": ["workers/core"],
  "allowed_tools": ["Read", "Edit", "Write", "Grep", "Glob", "Bash(git *)", "Bash(node:*)", "mcp__tally"],
  "disallowed_tools": ["WebFetch", "Bash(curl *)"],
  "guardrails": { "extra_deny": ["\\bnpm publish\\b", { "pattern": "prod", "tool": "mcp__tally__.*", "reason": "no prod writes from workers" }] } }
```

- `allowed_tools` and `disallowed_tools` use Claude Code permission-rule syntax and reach both launch paths,
  whether or not guardrails are on. cli: `--allowedTools` / `--disallowedTools`, one argv per rule. sdk: the
  runner's `--allowed-tools` / `--disallowed-tools` (JSON), which become the SDK's `allowedTools` /
  `disallowedTools`. A runner started with `--config` reads them from the entry. `disallowedTools` removes the
  tools even in bypass mode. In bypass mode `allowedTools` only pre-approves and restricts nothing. With
  guardrails on, the hook therefore enforces `allowed_tools` as a strict allowlist: `Name`, `Name(glob)` (for
  Bash, matched on the command), `Bash(prefix:*)`, `mcp__server` (every tool of that server). `mcp__broker__*`
  is always allowed.
- `guardrails.extra_deny` takes items of two forms. A string is a regex on the Bash command. An object
  `{ pattern, tool?, reason? }` is a regex on the Bash command or, for other tools, on the JSON of the tool
  input; `tool` is a regex on the tool name (default `Bash`). An invalid regex is matched as a literal.
- `start_worker` always sets `WATCHDOG_ALLOWED_TOOLS`, `WATCHDOG_DISALLOWED_TOOLS` and
  `WATCHDOG_GUARDRAILS_EXTRA_DENY` per entry (`""` when the entry has none), so a value in the broker env
  never leaks into another worker. A malformed list is dropped with a broker warning.

**How it is installed.** With guardrails on, the watchdog writes a mode-600 config:
`{ worker, root, log, broker_port, extra_deny, allowed_tools }`. The cli path then gets
`--settings <file>`, whose `hooks.PreToolUse` (matcher `*`, timeout 30 s) runs
`node hooks/guardrails.mjs <config>`; this adds to the user's own settings and replaces none of them. The sdk
path gets `--guardrails <config>`, and the runner installs the same rules as an in-process `PreToolUse`
callback. If the runner cannot read that file it exits 2. A hook that crashes, or that gets input it cannot
parse, allows the call, so a broken hook never blocks every tool. A missing or unreadable config falls back to
the built-in rules, rooted at the session's cwd.

**Logging.** The hook appends one line per deny to the config's log:
`<ts> DENY worker=<as> rule=<rule> tool=<tool> cmd=<command or input, 400 chars>`. After each session the
watchdog copies the lines into its own log as `[watchdog:<worker>] guardrail <line>`. With guardrails on, the
`session-end` heartbeat carries `context.guardrail_denies`.

**MCP inherit is off by default.** The code default has always been off (`watchdog.sh` merges other MCP
servers only on `WATCHDOG_MCP_INHERIT=1`; the SDK runner uses the watchdog's MCP file with
`strictMcpConfig`). The live `.env` sets `WATCHDOG_MCP_INHERIT=1`, which is honoured, so today every
`start_worker`-launched session also gets the user-scope and project-scope servers (Chrome, computer-use,
Tally). Removing that line from `.env`, or setting it to `0`, is the live flip, and the human decides it. Its
effect, once each worker is restarted:

- Sessions see only the `broker` server. A worker whose task uses Chrome, computer-use or Tally tools fails
  those calls with "no such tool". Check the dv workers first: they may rely on inherited Chrome or Tally.
- With inherit off, strict mode also drops the worker directory's `.mcp.json`. A worker that needs another
  server names it in its entry's `mcp_servers` (below) before the flip; that entry then ignores
  `WATCHDOG_MCP_INHERIT` either way.
- The flip is safe to stage. `--print-channels` shows `mcp_inherit=` for each worker before restart, and
  `WATCHDOG_MCP_INHERIT=1` brings inheritance back on the next restart.

### MCP servers per entry

A workers-config entry may carry `"mcp_servers": ["tally", ...]`. Its sessions then get the broker plus
exactly those servers, looked up by name in user scope and local scope (`~/.claude.json`, or
`$CLAUDE_CONFIG_DIR/.claude.json`) and project scope (`<work-dir>/.mcp.json`, which wins on a name clash).
`"mcp_servers": []` means the broker only. Precedence: the entry's list > `WATCHDOG_MCP_INHERIT=1` (every
server in every scope) > the broker only. The `broker` entry is always the watchdog's own; a `broker` in the
list is ignored.

- `start_worker` passes the list as `WATCHDOG_MCP_SERVERS` on both spawn paths (subprocess and tmux). An
  entry whose `mcp_servers` is not an array of names is ignored with a warning in the broker log, and the
  entry falls back to the inherit rule.
- Both launchers honour it. The watchdog writes the selected servers into the session's `--mcp-config`
  file, and the SDK runner uses that file as is. Started directly without `--mcp-config`, the runner
  applies the same selection from the entry (`--config`) or `WATCHDOG_MCP_SERVERS`.
- A name found in no scope does not stop the launch. The session starts without that server, the watchdog
  logs `WARN: mcp_servers name(s) found in no MCP scope: <names>`, and the startup line reads
  `MCP inherit: list [a,b] missing [b] (entry mcp_servers; …)`, so one grep of the worker log finds a typo.
- Like every per-entry setting, it applies from the next `stop_worker` + `start_worker`.

**Broker-only secrets.** `start_worker` strips `ADMIN_SECRET` and every `ORCHESTRATOR_TOKEN*` variable from
the env it hands a watchdog, on both spawn paths. A worker session therefore never holds the purge
credential or the orchestrator-sender credential. `BROKER_SECRET` is passed through.

## Plan gate

A non-trivial task gets an approved plan before any code is written. The plan and the decision are
ordinary messages, so the ledger derives the state and the watchdog needs no new channel.

**Opt-in per namespace.** The gate is on only for a namespace whose manifest sets top-level
`"plan_gate": true` (cb does). Elsewhere nothing changes: `dispatch_task` writes no new key,
`post_plan` / `decide_plan` and an explicit `plan_required` are refused (`the plan gate is not enabled
for namespace <ns> [manifest <ns> plan_gate]`), and `get_task_ledger` has no `planning` / `plan-review`
states or counts, no `plan_required` / `plan` row fields and no `plans_awaiting_decision`, so the
watchdog sees the same open tasks as before.

**Which tasks** (gated namespaces). `plan_required` as dispatched; when the task does not say,
`get_task_ledger` derives `true` for scope `medium` and `large`. `dispatch_task` writes
`plan_required` only when you pass it, so a task envelope never carries a key a v2 inbox schema with
`additionalProperties: false` would reject; pass `plan_required: false` to opt a medium/large task out.
A v2 channel schema still wins over the manifest: a gated namespace's v2 inbox and status schemas must
accept `plan_required`, `plan-decision` and `plan` before those messages can land.

**Envelopes** (base types `plan`, `plan-decision`; a namespace's status channel must accept `plan` and
its worker inboxes `plan-decision`):

| Type | Channel | Built by | `body` |
|---|---|---|---|
| `plan` | `<ns>-status` | `post_plan` (worker) | `approach`, `steps[]` (at least one), `files{read[], write[]}`, `risks[]`, `open_questions[]` (argument `questions`: a parameter named like the `open_questions` tool would point profiled lists at it); omitted lists become `[]`; `subject` is copied from the task |
| `plan-decision` | the plan author's inbox | `decide_plan` (orchestrator) | `decision`: `approve` \| `amend` \| `reject`, `notes`, `amendments[]`; `refs` = `["<ns>-status#<plan id>", "<inbox>#<task id>"]` |

**Ledger states** (`get_task_ledger`; a result always wins, an open question still shows `blocked`):

| State | When | Watchdog |
|---|---|---|
| `planning` | plan required, no plan yet; or the latest decision is `amend` | open: a session is launched (follow-up) |
| `plan-review` | a plan is posted with no decision after it | not open, like `blocked`: the worker exits and waits |
| `in-progress` | the latest decision is `approve` | open |
| `failed` | the latest decision is `reject` | done; dropped by `only_open` |

A `handoff` status newer than the last decision stays `handoff`, so the relaunched session finds its
notes. Each gated row carries `plan_required` and `plan: {id, at, decision: {id, decision, at} | null}`.
Only a decision posted after the latest plan counts, and one whose DB sender wrote the plan (a worker
approving itself with `send_message`) is ignored; `decide_plan` refuses the author as `sender`.

**Worker flow.**

1. Task arrives with `plan_required: true`, or scope `medium` / `large` without it (ledger: `planning`). Read the code you need, nothing else.
2. `post_plan(task_id, approach, steps, files, risks, questions)` → `plan-review`. Post your
   exit note and exit: no follow-up launch fires while the plan waits.
3. The `plan-decision` lands on your inbox and the watchdog launches you. `turn_start` delivers the
   decision; the task itself is `refs[1]` (`get_message(<inbox>, <id>)`) if the inbox cursor is past it.
   - `approve`: do the task as planned, post the result.
   - `amend`: apply `amendments` / `notes`, `post_plan` again, exit.
   - `reject`: stop. The task is `failed`; post nothing more for it.

**Orchestrator flow.**

1. Dispatch with `scope` (and `plan_required` if you want to override the default).
2. At turn-start: `get_task_ledger(status_channel="<ns>-status", only_open=true)` returns
   `plans_awaiting_decision`, the plans with no decision and no result: id, task, author, approach,
   step count, files to write, open questions, and the earlier decision a revised plan answers.
3. `decide_plan(task_id, decision, notes, amendments)`. `amend` and `reject` need `notes` or
   `amendments`.

**Required task fields.** These use the ordinary extension mechanism, not a separate key: the `required`
lists of `extensions.task` at namespace level, under `roles.<role>` for the sender's role, and on the
target inbox channel. For example, cb requires `scope` and `acceptance_criteria` of the orchestrator:
`"roles": {"orchestrator": {"extensions": {"task": {"required": ["scope", "acceptance_criteria"]}}}}`.
`dispatch_task` rejects a task missing one of these fields, naming the field. An empty string, list or `files` object
counts as missing. A requirement on another role does not apply. A namespace that requires nothing keeps
today's behaviour: the task is sent, and the reply warns about missing `context`, `scope`, `files`,
`checks` or `acceptance_criteria`.

## Orchestration loop

`runner/orchestrate.mjs` runs the deterministic part of the orchestrator's loop as code. The
orchestrator's model then only takes decisions. The loop is opt-in per namespace:
`ORCHESTRATION_LOOP_NAMESPACES` (comma list, empty = off), else it exits 2. It uses the v2 tools
(`get_task_ledger`, `open_questions`, `read_messages`, `send_message`, `has_messages`) plus `GET /workers` and
`POST /workers/:name/start`, so the broker needs no change. It makes no LLM call. Flags and state:
`runner/README.md`.

Each tick reads a snapshot (ledger since the sprint marker, open questions, new `held-task` messages, the
namespace's worker entries). It computes the actions from that snapshot and the state file only, then applies them:

| The loop does | When |
|---|---|
| **Release** a parked task: post `body.task` verbatim to `<ns>-<task.to>` as `--sender` | the `held-task` was stored by `--sender` (DB sender), its `from` and `task.from` are `--sender`, and `<ns>-<task.to>` is a configured worker inbox of this namespace (`body.inbox`, if set, must equal it); then every `depends_on` task has a `done` or `skipped` result. A failed prerequisite keeps it parked (the FAIL wakes). Once per task_id; skipped if the task_id was dispatched by hand. Any other `held-task` is never released and wakes once (`held-refused`) |
| **Start** a worker (`--model`, else the entry's `model`) | the worker has a row in `pending`, `in-progress`, `handoff` or `planning` and is not running. Not `blocked` or `plan-review`. At most `--max-starts-per-hour`, with a `--start-cooldown-ms` gap. One more stop in that hour wakes instead |
| **Dispatch** one review task `<ns>-<date>-review-sprint-close[-n]` to `<ns>-<reviewer>` (`body: {base: <--review-base, main>, head: <--review-head>, checklist}`, no `scope`, so no plan is required) | `--review-head` (or `ORCHESTRATION_LOOP_REVIEW_HEAD`) is set, every task dispatched after the sprint marker is `done`/`skipped` (none `failed`), nothing is parked, and the previous review has a result. The marker moves to the review's id. Without a review head the loop dispatches nothing and wakes once with `ready-for-review`: worker commits sit on `worker/*` branches until the orchestrator names the branch to review. A review the orchestrator dispatches by hand moves the marker too |
| **Wake** the orchestrator | an open question; a plan in `plans_awaiting_decision`; a result after the baseline whose summary starts `FAIL` or `BLOCK`, or whose harness verification failed; `APPROVE`/`ADVISE` on a sprint-close review (merge approval); a start backoff; a release or review the broker rejected; a refused `held-task`; a sprint ready for review with no review head |

A wake is a JSON line on stdout plus a `type: note` on `<ns>-orchestrator` (`from: orchestration-loop`,
`task_id` = the decision's task, `body` = the line), so it survives a lost shell. The note is recorded in the
state file and is never surfaced twice. Loop mode exits 0 on the first tick with a wake.

**Parking a task.** To have the loop release a task whose `depends_on` is unmet, post it to `<ns>-held`
instead of the inbox:
`{"type": "held-task", "task_id": "<id>", "from": "orchestrator", "to": "<worker>", "subject": "...", "body": {"task": <the full task envelope>, "inbox": "<optional, must be <ns>-<task.to>>"}}`.
The release is posted as the orchestrator, so the loop only releases what the orchestrator itself parked
(DB sender and `from`, the same sender column the verifier trusts) into a worker inbox of its own namespace;
otherwise a worker could park a task with its own `checks[]` and have it come back as a trusted dispatch.
The type is not `task`, so `get_task_ledger` and the watchdogs ignore it until it is released. The
namespace's `<ns>-held` channel needs a schema that accepts `held-task`. A task sent straight to an inbox keeps
the v2 behaviour: the worker waits on `depends_on` itself.

**Trust.** A released held task is exactly as trusted as a dispatch the orchestrator posted by hand: both rest
on the same DB sender column, which is not proof of identity (`send_message` takes `sender=` from the caller).
Parking in `<ns>-held` neither adds nor removes trust, so the verifier's `checks[]` from a released task carry
the same weight (and the same forgery limits, see "Limits" under Harness-verified checks) as a trusted dispatch.

**Stays with the orchestrator (judgment):** `decide_plan`, answering questions, triage of FAIL/BLOCK
results, merging to `main` and purging (both after `AskUserQuestion`), stopping workers, restarting the
broker. The loop does none of these.

## v2 → v3 migration

Nothing is removed. A namespace and a session move independently.

| Layer | v2 | v3 | Do this |
|---|---|---|---|
| Schemas | `schemas/<ns>-*.json` registered per channel by `setup-schemas-<ns>.js` | `schemas/manifests/<ns>.json` registered with `register_namespace` | Write the manifest (steps under *Migrating a namespace* above), prove parity, register warn-only, then `clear_channel_schema` per channel: a channel with a v2 schema keeps v2 validation until cleared |
| Writes | `send_message(channel, sender, content=JSON)` | `dispatch_task` / `post_result` / `ask` / `post_note` | Use the typed tool; keep `send_message` for shapes it does not build |
| Session URL | `http://…/mcp` or `…/mcp?ns=<ns>&as=<name>` (34 tools, ~28.8 KB) | `…/mcp?role=worker&ns=<ns>&as=<name>` (20 tools, ~15.4 KB; orchestrator 32) | Adopt the namespace (below); v3 tools exist only with a `role=` |
| Reads | `read_messages(since_id=…)` | omit `since_id`; `projection="summary"` then `get_message` | Server cursors replace hand-tracked ids |
| Watchdog | rotation by transcript heuristics; URL `/mcp?ns=&as=`, keys = path basename | stream-json measured, env-driven; `role=` and `as` keys on opt-in | Defaults are legacy-identical; set `ROTATE_AT_TOKENS` etc. or adopt the namespace (below) |
| Strictness | per-channel `strict` in the v2 schema | `strict` in the manifest, per channel override | Warn-only first; flipping needs explicit authorization |

### Adopting a namespace

Nothing changes for a namespace until it is adopted. Enforcing `role=` fleet-wide would break workers
whose real calls fall outside a profile, so adoption is per namespace (cb-notes #169708). The switch
is `adopt_namespace` (admin tool) or `POST /namespaces/<ns>/adopt`: it is stored in the broker DB
(`namespace_adoption`, `lib/db.js:175`), read by `start_worker` at each spawn (`lib/workers.js:85`),
and needs **no broker restart**. Suite: `test-adoption.js`.

1. **Register the manifest** (`register_namespace`). Adoption of a namespace with no manifest is `409`,
   dry run included (`lib/adoption.js:125`).
2. **Dry run.** `adopt_namespace(ns, dry_run=true)` needs no token and writes nothing. The report lists
   each workers-config entry of the namespace with its `mcp_query` before and after, the `renamed`
   entries (those whose legacy key, the worker path basename, differs from `as`, e.g.
   `workers/code-reviewer` on `cb-reviewer` -> `reviewer`), `underivable` entries and the
   `cursor_copies` it would make. Read the identities from `watchdog.sh --print-channels`, so they
   cannot drift from what the watchdog does (`lib/adoption.js:35`).
3. **Adopt.** `adopt_namespace(ns, admin_token=<ADMIN_SECRET>)`. The token is the broker's
   `ADMIN_SECRET`, which worker sessions do not hold: no token or a wrong one is `403`, a broker with
   no `ADMIN_SECRET` is `503` (dry run still works). Over REST the token is `admin_token` in the body or
   an `X-Admin-Token` header. Calling it again is harmless: nothing is rewritten that is already
   current. The cursor of every renamed entry on the namespace's own channels (`<ns>-*`) is **copied**
   from the legacy key to `as`, never moved, and only raised, so a newer cursor is not lowered and
   no row outside the namespace is touched (one worker directory can serve several namespaces).
4. **Restart the namespace's workers** (`stop_worker`, `start_worker`). Running watchdogs keep the
   identity they started with. A watchdog started after adoption gets `WATCHDOG_NS_ADOPTED=1`, so its
   sessions connect with `role=<role>&ns=&as=` and heartbeat, cursor and ledger keys are `as`.
   Precedence (`watchdog.sh:159-167`): `WATCHDOG_ROLE` > `WATCHDOG_ROLE_URL=1` >
   `WATCHDOG_ROLE_NAMESPACES` > adoption; `WATCHDOG_ROLE_URL=0` vetoes adoption.
5. **Check.** `get_namespace(ns)` prints `Adopted: yes, since <time>` (with no `ns` the list has an
   `adopted=` column), and `watchdog.sh <worker> --print-channels` with `WATCHDOG_NS_ADOPTED=1` prints
   `role_url=on (namespace '<ns>' adopted …)` and `mcp_query=role=…&ns=…&as=…`.
6. Make sure the namespace's role files only instruct tools in its profile (the worker set above), and
   keep the v2 `send_message` fallback.

**Revert.** `adopt_namespace(ns, revert=true, admin_token=…)` (also dry-runnable) copies the cursors
back from `as` to the legacy key, so progress made while adopted is not lost, and restores the v2
identity for watchdogs started afterwards. Reverting a namespace that is not adopted is a no-op.
Restart its workers again to go back to the `ns=&as=` URL.

The older `.env` route (`WATCHDOG_ROLE_NAMESPACES`, restart the broker, restart the workers) still
works and is not recorded in the adoption table.

**Role files.** A role file should present the v3 call first and the v2 call as the fallback, and never
drop the v2 guidance (live `mg-` and `tally-` sessions are not migrated). The paragraphs below are the
pattern; the generated `roles/*.md` (written by `setup.js --scaffold-roles`, not tracked in this repo)
and the per-worker `CLAUDE.md` files take them verbatim with names filled in.

*Worker — reporting:*

> Report with `post_result(task_id, summary="PASS — …", affected_files=[…], body={…})` — it fills
> `type`, `from`, `to` and the task's subject and rejects a bad envelope before it lands. Ask a
> blocking question with `ask(task_id, question)`; share a finding with `post_note(kind="finding", …)`.
> Fallback (no typed tools, or a shape they do not build): `send_message(channel="<ns>-status",
> sender="<you>", content=<the full JSON envelope>)` exactly as in v2. Connect with
> `…/mcp?role=worker&ns=<ns>&as=<you>` so `ns` and `sender` default.

*Reviewer — verdicts:*

> Post verdicts with `post_result(task_id, summary="APPROVE|ADVISE|BLOCK — …")` (allowed because the
> manifest gives the reviewer role those prefixes; a worker cannot post them). Read the ledger with
> `get_task_ledger` and the tail with `read_last(projection="summary")`. Fallback: `send_message` as in v2.

*Orchestrator — dispatch:*

> Dispatch with `dispatch_task(to, task_id, subject, body, context, background, scope, files,
> constraints, checks, acceptance_criteria)`: the inbox comes from the manifest and the envelope is
> validated first. Read state with `get_task_ledger(status_channel, only_open=true)` and
> `open_questions`, not by re-reading `<ns>-status`. Fallback: `send_message(channel="<ns>-<worker>",
> …)` with the full task JSON, as in v2.

### New projects: `setup.js`

`setup.js --scaffold-roles` writes every role file (orchestrator, worker, reviewer, patrol, cluster
orchestrator) with a **Broker v3** section that follows the patterns above: the role's typed tools
first, `send_message` as the fallback, and only tools in the role's profile (`test-setup-broker.js`
section 9 checks each generated file against `lib/profiles.js`). Two exceptions are deliberate: a
worker in a cluster keeps `send_message` for results and questions, because `post_result` and `ask`
post to `<ns>-status` and its feed is `<ns>-<cluster>-status`; a patrol's `post_result` passes
`subject`, because a patrol pass has no dispatched task to copy it from.

The `.mcp.json` it writes carries the identity in the URL: the project root gets
`/mcp?role=orchestrator&ns=<ns>` (interactive, no `as=`), and in `--multi-repo` each component repo gets
`/mcp?role=worker&ns=<ns>&as=<component>`. An existing broker URL keeps its other query parameters;
other MCP servers in the file are untouched. Typed tools still need the namespace manifest
(`register_namespace`), which `setup.js` does not write; until it is registered the role files' fallback applies.

### Existing projects: `migrate-mcp-v3.mjs`

Headless sessions never read a project's `.mcp.json`: the watchdog passes its own `--mcp-config`, so they
move to `role=` when their namespace is adopted (above). What remains is the **interactive** session's
broker entry. Claude Code resolves it local scope (`~/.claude.json` `projects[<dir>]`) > project
(`.mcp.json`) > user scope, so the script reports all three and which one wins.

```
node migrate-mcp-v3.mjs --all --workers <workers-all.json> --db <broker.db>   # dry run, every project
node migrate-mcp-v3.mjs --project <path> [--ns <ns>]                          # dry run, one project
node migrate-mcp-v3.mjs --project <path> --apply [--with-guide]              # write (human-approved)
```

- Dry run is the default and writes nothing. It prints, per project: each `.mcp.json` (project root and any
  worker or worktree dir of the namespace that has one) with a unified diff of the broker URL change,
  the effective scope, the project-root `CLAUDE.md` guide-block diff (`sync-agent-guide.js` markers), role
  files that mention tools outside their role's profile, and whether the namespace's headless sessions
  already get `role=`. `--all` adds a rollout order: idle namespaces first (last broker activity, read
  from `--db` read-only), mg and tally last.
- `--apply` edits only the broker entry's URL in `.mcp.json` (backup `<file>.pre-v3`), never a URL that
  already has `role=`, and never creates a missing `.mcp.json`. `--with-guide` also writes the
  `CLAUDE.md` block. Running it twice changes nothing. `~/.claude.json` is never written: where a
  local- or user-scope entry decides, the report prints the `claude mcp add -s local …` command.
- All output masks secrets (`Bearer ***`, token-like query values). A `${BROKER_SECRET}` placeholder in
  a tracked `.mcp.json` is kept as is.
- Identities come from `watchdog.sh --print-channels` (the same derivation as `adopt_namespace`), with
  `WATCHDOG_*`/`BROKER_*` scrubbed from the child env. Suite: `test-mcp-v3-migration.js`.

The 2026-10-29 dry run over `workers-all.json` (15 namespaces) found 14 namespaces adopted and 11 interactive
orchestrators already on `role=orchestrator` (10 through a local-scope entry, `rt` through its `.mcp.json`). Left to do: `trippy` (`.mcp.json` edit
is the only change), `voice` (its `.mcp.json` edit changes nothing because a local-scope entry
shadows it), `crm`, `pg` and `cb` (user scope, so a `claude mcp add -s local` each), and `pg` headless (no
manifest registered, not adopted). Interactive orchestrator `CLAUDE.md` files that name
`register_channel_schema` / `register_namespace` need a session without `role=` for those calls.

## Judge worker

Questions are the fleet bottleneck. A `judge` worker answers a worker's `type: question` from decisions already
on record, or leaves it for the human. This section is the schema surface; the worker's own instructions
are `workers/judge/CLAUDE.md`. Suite: `test-judge.js`.

**Manifest (cb).** `workers[]` gains `{name: judge, inbox: cb-judge, role: worker}`; `cb-judge` is a
`worker-inbox` accepting `task | question | note | rotate` (no `plan-decision`, no `result`); `cb-notes`
accepts the local type `judgment`. `setup-schemas-cb.js` registers `cb-judge` with
`schemas/cb-worker-inbox.json` and `cb-notes` with `schemas/cb-notes.json` (the notes schema plus
`judgment`). Nothing is live until the orchestrator applies the script and `register_namespace`.

**`judgment`** (on `cb-notes`, never purged). The record of one verdict:

| Field | Rule |
|---|---|
| `type`, `task_id`, `from`, `to`, `subject`, `verdict`, `question_ref`, `summary` | required |
| `from` | `judge` |
| `to` | the asker |
| `subject` | ≤ 120 chars |
| `verdict` | `decided` (answered from a recorded decision) · `returned` (sent back to the asker) · `held` (left for the human) |
| `question_ref` | `^cb-status#[0-9]+$`, the question message judged |
| `summary` | ≤ 400 chars |
| `basis` | required when `verdict` is `decided`; `^(cb-notes#[0-9]+\|docs/knowledge/cb\.md#.+\|CLAUDE\.md:.+)$`; optional otherwise |
| `refs` | optional string array |

**Other namespaces.** `schemas/notes.json`, the generic schema every non-cb `<ns>-notes` channel registers, also
accepts `judgment` (v1.1), so a templated judge works anywhere. Same fields and the same `basis`-when-`decided`
rule; two patterns are generalised: `question_ref` is `^[a-z0-9]+(-[a-z0-9]+)*-status#[0-9]+$` (any
`<ns>-status`) and `basis` is `^([a-z0-9-]+-notes#[0-9]+\|docs/knowledge/[a-z0-9-]+\.md#.+\|CLAUDE\.md:.+)$`.
`schemas/cb-notes.json` is unchanged and keeps its stricter `cb-` patterns for cb. The other note types
validate exactly as before (1,757 real ca/dv/dx/mg/tally rows replayed, none changed verdict). Registering
`notes.json` live on a channel is the orchestrator's step, as for every schema. Pinned in `test-judge.js` (6).

**Answer note** (on the asker's inbox, e.g. `cb-protocol-qa`). An ordinary `type: note`, so the strict
`cb-worker-inbox.json` already accepts it and no inbox schema changed:

```json
{ "type": "note", "task_id": "cb-2026-10-29-x", "from": "judge", "to": "protocol-qa",
  "subject": "Answer: use A",
  "body": { "answer": "Use A", "basis": "cb-notes#168904", "verdict": "decided" } }
```

`body` carries `answer` (decided) or `reason` (returned, held), plus `basis` when decided and `verdict`.
Because it names the asker's `task_id` and lands after the question on the asker's inbox, `get_task_ledger`
and `open_questions` treat the question as answered: a `blocked` row returns to `pending` / `in-progress`.
A `held` or `returned` note unblocks the ledger the same way; the `verdict` is what tells the asker to
wait for the human or go back to the orchestrator.

**Rules the schema cannot enforce** (they need the dispatch or other messages; pinned in `test-judge.js`
so a change shows up):

- A question about a `production_touching` task is never `decided`: the judge posts `verdict: held`. The
  schema sees one message and not the task's dispatch envelope.
- One judgment per `question_ref`: the judge reads `cb-notes` (`filter_type: judgment`) for the ref before
  it judges. A second judgment for the same ref is accepted by the schema and is a judge error.

## Out of scope

Loader, registration and strict flips (core / orchestrator); mg-, tally- and os- manifests; strict flips
need explicit authorization; applying `migrate-mcp-v3.mjs` to a project (a human-approved step).
