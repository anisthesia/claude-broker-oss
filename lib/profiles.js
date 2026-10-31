// Role profiles: which MCP tools a connection sees. Identity comes from the MCP URL query —
// /mcp?role=<role>&ns=<ns>&as=<name>. No role = no identity = the pre-v3 tool list (v2 behaviour,
// byte-identical tools/list, whatever ns/as say); the v3 tools are hidden there and need a ?role=. A profiled connection gets only its tools in tools/list, and a call to any other tool is
// rejected with an error naming the role. Kept as plain data so docs can be generated from it.

// Built from measured use (30-day transcripts, 64k broker calls): every tool with >=0.5% of a
// role's calls is in its profile. purge_channels_by_prefix stays admin-only.
const WORKER = [
  "turn_start", "read_messages", "wait_for_messages", "get_message",
  "post_result", "ask", "post_note", "upsert_heartbeat", "check_result", "send_message",
  // measured: register_capability 9.8%, read_last 6.0%, has_messages 3.4%, check_results_batch
  // 3.4%, get_channel_schema 3.2%, delete_message 2.2%, worker_cursor 1.9%, get_task_ledger 0.8%,
  // send_message_batch 0.5% of worker calls
  "register_capability", "read_last", "has_messages", "check_results_batch", "get_channel_schema",
  "delete_message", "worker_cursor", "get_task_ledger", "send_message_batch",
  // plan gate (docs/protocol-v3.md "Plan gate"): unmeasured, added with the feature
  "post_plan",
];

export const PROFILES = {
  worker: WORKER,
  // A reviewer's measured calls are all inside the worker set (residue 0.3%).
  reviewer: WORKER,
  // Includes the repo-root cluster orchestrators that start/stop workers. Measured beyond the
  // worker set: get_latest_heartbeats 2.8%, purge_channel 2.1% (sprint close; PRUNE_EXEMPT channels
  // still need force + ADMIN_SECRET), list_channels 0.5%.
  orchestrator: [
    ...WORKER,
    "dispatch_task", "open_questions", "decide_plan",
    "list_workers", "start_worker", "stop_worker", "get_latest_heartbeats",
    "sprint_summary", "sprint_file_conflicts", "get_latest_per_sender", "list_channels",
    "purge_channel",
  ],
  admin: null, // every tool
};

// Shorter tool descriptions served to profiled connections (role != admin), so a worker's
// tools/list stays small and never points at tools outside its profile. Parameter descriptions
// are unchanged. Unprofiled and admin connections get the full descriptions.
export const BRIEF = {
  send_message: "Post a message to a channel.",
  read_messages: "Read a channel. since_id > 0 pages from it; omitted or 0 resumes from (and advances) your server-side cursor (pass worker=). Optional sender/type filters.",
  wait_for_messages: "Long-poll until a matching message arrives or timeout_ms.",
  check_result: "Whether task_id has a type:result on a channel — the idempotency check.",
  turn_start: "Read inbox + control in one call, resuming from (and advancing) your server-side cursors when since_ids are omitted. rotate_requested = an unread control message has type 'rotate'.",
  upsert_heartbeat: "Post a heartbeat, deleting this sender's older rows on the channel (one row per sender).",
  get_message: "Fetch one message by id, or just the JSON value at `path` (e.g. 'body.commits[0].sha'). Does not move cursors.",
  post_result: "Post a type:result to <ns>-status; fills type/from/to and the task's subject. summary must start PASS|FAIL|SKIP (or a manifest role prefix).",
  ask: "Post a type:question to <ns>-status; the task shows 'blocked' until a reply naming task_id reaches the reply channel or you post its result.",
  post_note: "Post to <ns>-notes: finding|decision (subject, summary, scope, evidence, confidence), or resolved (ref_id, outcome) to close a note.",
  register_capability: "Declare what this worker owns and which channels it uses (once per session).",
  read_last: "The N most recent messages of a channel, oldest-first (default 20, max 100). Does not move cursors.",
  has_messages: "{pending, max_id} after since_id, no content.",
  check_results_batch: "check_result for several task_ids in one call: found flag and latest result summary per task_id.",
  get_channel_schema: "The JSON Schema bound to a channel, or that it is free-form.",
  delete_message: "Delete one message by id on a channel. On exempt channels (backlog, notes) only its own sender may, via sender=; otherwise post type: resolved.",
  worker_cursor: "List a worker's server-side read cursors, or set one (set_to; lower = rewind and re-deliver).",
  get_task_ledger: "One row per task dispatched in a namespace with its derived state (pending, planning, plan-review, in-progress, handoff, blocked, done, failed, skipped), plus plans awaiting a decision. only_open=true skips finished tasks.",
  send_message_batch: "Post up to 50 messages in one call.",
  post_plan: "Post a type:plan to <ns>-status for a plan_required task, then exit; the plan-decision on your inbox relaunches you.",
  decide_plan: "Answer task_id's latest plan: approve, amend (needs notes or amendments) or reject. Lands on the worker's inbox.",
};

// Tools added in v3. A connection with no identity (every v2 session) gets the pre-v3 tools/list
// byte for byte, so these are hidden from it; every role profile that lists them, and admin, sees them.
export const V3_TOOLS = [
  "register_namespace", "get_namespace", "get_message",
  "dispatch_task", "post_result", "ask", "post_note",
  "post_plan", "decide_plan",
  "adopt_namespace", // admin-only: in no profile
];

const NAME = /^[A-Za-z0-9_.-]{1,64}$/;

// Parse identity from the request query. Returns { identity } or { error }; identity is null
// when no role is given (the v2 path): watchdog sessions send ?ns=&as= before their namespace opts
// in to roles, and must keep the pre-v3 list until then. Without a role ns/as are validated only.
export function identityFromQuery(query = {}) {
  const repeated = ["role", "ns", "as"].find(k => Array.isArray(query[k]));
  if (repeated) return { error: `'${repeated}' given more than once` };
  const pick = (k) => (typeof query[k] === "string" && query[k] !== "" ? query[k] : undefined);
  const role = pick("role"), ns = pick("ns"), as = pick("as");
  if (role !== undefined && !Object.hasOwn(PROFILES, role)) {
    return { error: `unknown role '${role}' — expected one of ${Object.keys(PROFILES).join(", ")}` };
  }
  for (const [k, v] of [["ns", ns], ["as", as]]) {
    if (v !== undefined && !NAME.test(v)) return { error: `invalid ${k} '${v}' — letters, digits, _ . - (max 64)` };
  }
  if (role === undefined) return { identity: null };
  return { identity: { role, ns, as } };
}

// The tool-name allowlist for an identity, or null for "all tools". No identity also returns null:
// the caller hides V3_TOOLS from that connection itself.
export function allowedTools(identity) {
  if (!identity) return null;
  const list = PROFILES[identity.role];
  return list ? new Set(list) : null;
}
