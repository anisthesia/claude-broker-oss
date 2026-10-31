// Plan gate (docs/protocol-v3.md "Plan gate"), against its own throwaway broker (free port, temp DB) and
// fixture base schemas (temp BASE_SCHEMAS_DIR = schemas/base/* + local plan / plan-decision fixtures), so it
// never depends on the live broker on 8080 or on schemas/base/plan*.json being present:
//   1. tools/list: post_plan for worker, decide_plan for orchestrator, both for admin; the no-role
//      list hides them (34 v2 tools); a worker calling decide_plan gets "not available to role"
//   2. dispatch_task (namespace with plan_gate: true): plan_required written only when passed (explicit false
//      kept); the ledger derives true for medium/large;
//      a field the manifest requires (roles.orchestrator.extensions.task.required) rejects when missing
//      (names field + source); another role's requirement or none at all is a warning only
//   3. ledger: planning → plan-review → (amend) planning → plan-review → (approve) in-progress → done; reject
//      → failed; a worker approving its own plan is ignored; get_task_ledger.plans_awaiting_decision lists exactly the undecided plans
//   4. opt-in: an ungated namespace whose inbox has a v2 schema forbidding extra keys takes medium/large
//      dispatches; no plan_required written, no planning/plan-review states or plan fields, plan tools and
//      an explicit plan_required refused; a gated namespace with the same v2 schema takes them too
//   5. watchdog --once: a session that posts a plan exits with no follow-up (plan-review is not open), a
//      planning task is open, and the plan-decision on the inbox launches the next session
//   6. orchestrator credential (ORCHESTRATOR_TRUST_NAMESPACES lists only NT): without X-Orchestrator-Token
//      a dispatch / plan decision / held release as the orchestrator is refused (MCP + REST, the refusal names
//      the header and env var); a peer worker's decision under its own name is ignored and cannot hide the real
//      one; the credentialed orchestrator dispatches and decides
//   7. enforcement: post_result refuses PASS on an unapproved planned task (no plan / plan-review / amend /
//      reject) and takes it after approve; FAIL and SKIP stay allowed; a reject is terminal (a re-posted plan
//      does not reopen it) until a re-dispatch, which can also switch plan_required; decide_plan to≠author
//      refused; a raw send_message PASS on an unapproved task lands with a warning and the ledger fails it
//      (plan_unapproved) — the live repro shape; an orchestrator waiver (approve + body.waiver) turns it done;
//      a reviewer's medium task is not gated unless plan_required: true; tasks dispatched before the
//      gate-live marker (first type:plan on the status channel) are not gated
import { spawn, spawnSync } from "child_process";
import { mkdtempSync, writeFileSync, readdirSync, copyFileSync, chmodSync, rmSync, mkdirSync } from "fs";
import { createHash } from "crypto";
import { startScratchBroker } from "./test-lib-broker.js";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const TAG = Date.now().toString(36);
const NS = `tp${TAG}`, NSR = `tq${TAG}`;
const STATUS = `${NS}-status`, INBOX = `${NS}-core`, INBOX2 = `${NS}-wk2`;
const SECRET = `plan-gate-${process.pid}-${TAG}`;
// Orchestrator credential: the broker holds only its sha256, and enforces it in NT alone.
const NT = `tt${TAG}`;
const ORCH_TOKEN = `orch-token-${process.pid}-${TAG}`;
const ORCH_H = { "X-Orchestrator-Token": ORCH_TOKEN };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
function expect(cond, label, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); return true; }
  failed++; console.error(`  ✗ ${label}`);
  if (detail !== undefined) console.error(`     detail: ${String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 1200)}`);
  process.exitCode = 1; return false;
}
// Nothing from the session running this suite may leak into the broker or watchdog under test.
function cleanEnv(extra = {}) {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (/^(WATCHDOG|BROKER|FOLLOWUP)_/.test(k) || ["PORT", "DB_PATH", "TEST_PORT", "CLAUDE_MODEL", "WORKERS_CONFIG"].includes(k)) delete e[k];
  return { ...e, ...extra };
}

// ── fixtures: base schemas + plan / plan-decision ─────────────────────────────

const dir = mkdtempSync(join(tmpdir(), "plan-gate-"));
const baseDir = join(dir, "base"), work = join(dir, "work");
mkdirSync(baseDir); mkdirSync(work);
writeFileSync(join(work, "CLAUDE.md"), "# fake role\n");
for (const f of readdirSync(join(ROOT, "schemas", "base")).filter(f => f.endsWith(".json"))) copyFileSync(join(ROOT, "schemas", "base", f), join(baseDir, f));
const envelopeProps = {
  task_id: { type: "string", minLength: 3 }, from: { type: "string", minLength: 1 }, to: { type: "string", minLength: 1 },
  subject: { type: "string", minLength: 3 }, refs: { type: "array", items: { type: "string" } },
};
const strArr = { type: "array", items: { type: "string" } };
writeFileSync(join(baseDir, "plan.json"), JSON.stringify({
  $id: "claude-broker/base/plan", type: "object", required: ["type", "task_id", "from", "to", "subject", "body"],
  properties: { type: { const: "plan" }, ...envelopeProps,
    body: { type: "object", required: ["approach", "steps", "files", "risks", "open_questions"],
      properties: { approach: { type: "string", minLength: 1 }, steps: { ...strArr, minItems: 1 },
        files: { type: "object", properties: { read: strArr, write: strArr } }, risks: strArr, open_questions: strArr } } },
}));
writeFileSync(join(baseDir, "plan-decision.json"), JSON.stringify({
  $id: "claude-broker/base/plan-decision", type: "object", required: ["type", "task_id", "from", "to", "subject", "body"],
  properties: { type: { const: "plan-decision" }, ...envelopeProps,
    body: { type: "object", required: ["decision"],
      properties: { decision: { enum: ["approve", "amend", "reject"] }, notes: { type: "string" }, amendments: strArr } } },
}));

function manifest(ns, extra = {}) {
  const workers = [["boss", "orchestrator"], ["core", "worker"], ["wk2", "worker"], ["rv", "reviewer"]];
  return {
    ns, version: "3.0", strict: false, ...extra,
    workers: workers.map(([name, role]) => ({ name, inbox: `${ns}-${name}`, role })),
    channels: [
      ...workers.map(([name, role]) => ({ name: `${ns}-${name}`, kind: role === "orchestrator" ? "orchestrator-inbox" : "worker-inbox",
        types: role === "orchestrator" ? ["question", "status"] : ["task", "plan-decision"] })),
      { name: `${ns}-status`, kind: "status", types: ["result", "status", "question", "plan"] },
      { name: `${ns}-telemetry`, kind: "telemetry", types: ["heartbeat"] },
    ],
  };
}

// ── scratch broker ────────────────────────────────────────────────────────────

let broker, BASE, brokerLog = "";
async function startBroker() {
  const h = await startScratchBroker({ root: ROOT, onData: d => { brokerLog += d; },
    env: (port) => cleanEnv({ PORT: String(port), DB_PATH: join(dir, "broker.db"), SHARED_SECRET: SECRET, ADMIN_SECRET: `${SECRET}-a`, BASE_SCHEMAS_DIR: baseDir,
      ORCHESTRATOR_TOKEN_SHA256: createHash("sha256").update(ORCH_TOKEN).digest("hex"), ORCHESTRATOR_TRUST_NAMESPACES: NT,
      WATCHDOG_BIN: "", WORKERS_CONFIG: "", WORKERS_LOG_DIR: join(dir, "logs"), WORKERS_TMUX_SESSION: "", TMUX_BIN: "", PRUNE_EXEMPT: "" }) });
  broker = h.proc;
  BASE = h.base;
}

const H = { "content-type": "application/json", authorization: `Bearer ${SECRET}` };
const sendRaw = async (channel, sender, obj, headers = {}) => {
  const r = await fetch(`${BASE}/messages`, { method: "POST", headers: { ...H, ...headers }, body: JSON.stringify({ channel, sender, content: obj }) });
  return { status: r.status, body: await r.json() };
};
const send = async (channel, sender, obj) => (await sendRaw(channel, sender, obj)).body?.id;

const clients = [];
async function connect(query, headers = {}) {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp${query}`), { requestInit: { headers: { Authorization: `Bearer ${SECRET}`, ...headers } } });
  const client = new Client({ name: `plan-gate${query}`, version: "1.0.0" });
  await client.connect(transport);
  clients.push(client);
  return client;
}
async function call(client, name, args) {
  const r = await client.callTool({ name, arguments: args });
  return { text: r.content?.[0]?.text ?? "", isError: !!r.isError };
}
const idOf = (text) => Number(/Sent #(\d+)/.exec(text)?.[1] ?? NaN);
async function stored(client, channel, id) {
  const r = await call(client, "get_message", { channel, id });
  try { return JSON.parse(r.text.slice(r.text.indexOf("{"))); } catch { return null; }
}
async function ledger(client, extra = {}) {
  const r = await call(client, "get_task_ledger", { status_channel: STATUS, ...extra });
  return JSON.parse(r.text);
}
const row = (led, id) => led.tasks.find(t => t.task_id === id);

async function main() {
  await startBroker();
  console.log(`scratch broker ${BASE}`);
  const admin = await connect(`?role=admin&ns=${NS}`);
  let r = await call(admin, "register_namespace", { manifest: JSON.stringify(manifest(NS, { plan_gate: true })) });
  expect(!r.isError, "namespace registered (plan / plan-decision from fixture base schemas)", r.text);
  const requiring = (role) => ({ roles: { [role]: { extensions: { task: { required: ["context", "checks"] } } } } });
  r = await call(admin, "register_namespace", { manifest: JSON.stringify(manifest(NSR, requiring("orchestrator"))) });
  expect(!r.isError, "namespace with roles.orchestrator.extensions.task.required registered", r.text);
  r = await call(admin, "register_namespace", { manifest: JSON.stringify(manifest(`tr${TAG}`, requiring("worker"))) });
  expect(!r.isError, "namespace requiring task fields of the worker role registered", r.text);

  const orch = await connect(`?role=orchestrator&ns=${NS}`);
  const worker = await connect(`?role=worker&ns=${NS}&as=core`);
  const none = await connect("");

  // ── 1. tools/list ───────────────────────────────────────────────────────────
  console.log("\n[1] tools/list per role");
  const names = async (c) => (await c.listTools()).tools.map(t => t.name);
  const [wl, ol, al, nl] = await Promise.all([worker, orch, admin, none].map(names));
  expect(wl.includes("post_plan") && !wl.includes("decide_plan"), "worker: post_plan, not decide_plan", wl);
  expect(ol.includes("decide_plan") && ol.includes("post_plan"), "orchestrator: decide_plan (and the worker set)", ol);
  expect(["post_plan", "decide_plan"].every(t => al.includes(t)) && !al.includes("open_plans"), "admin: both; no open_plans tool", al);
  expect(nl.length === 34 && !["post_plan", "decide_plan"].some(t => nl.includes(t)), `no role: the 34 v2 tools, none of the plan tools (${nl.length})`, nl);
  r = await call(worker, "decide_plan", { task_id: `${NS}-x`, decision: "approve" });
  expect(r.isError && /not available to role 'worker'/.test(r.text), "worker calling decide_plan: not available to role", r.text);

  // ── 2. dispatch_task ────────────────────────────────────────────────────────
  console.log("\n[2] dispatch_task: plan_required default, manifest-required task fields");
  const T = (s) => `${NS}-${s}`;
  const full = { context: "why", checks: [{ name: "t", run: "true", pass_condition: "exit 0" }], files: { write: ["a.js"] }, acceptance_criteria: ["ok"] };
  r = await call(orch, "dispatch_task", { to: "core", task_id: T("med"), subject: "medium task", body: "b", scope: "medium", ...full });
  let msg = await stored(admin, INBOX, idOf(r.text));
  expect(!r.isError && msg && !("plan_required" in msg), "scope medium, plan_required not passed: no key in the stored task", msg ?? r.text);
  expect(!/Warning/.test(r.text), "all recommended fields given: no warning", r.text);
  r = await call(orch, "dispatch_task", { to: "core", task_id: T("small"), subject: "small task", body: "b", scope: "small" });
  msg = await stored(admin, INBOX, idOf(r.text));
  expect(!r.isError && msg && !("plan_required" in msg), "scope small: no plan_required", msg);
  expect(/Warning: no context, files, checks, acceptance_criteria/.test(r.text) && /not enforced/.test(r.text), "namespace requiring no task fields: missing fields only warn", r.text);
  r = await call(orch, "dispatch_task", { to: "core", task_id: T("optout"), subject: "large, no plan", body: "b", scope: "large", plan_required: false, ...full });
  msg = await stored(admin, INBOX, idOf(r.text));
  expect(!r.isError && msg?.plan_required === false, "explicit plan_required:false is kept on a large task", msg);
  r = await call(orch, "dispatch_task", { to: "core", task_id: T("optin"), subject: "small, plan anyway", body: "b", scope: "small", plan_required: true, ...full });
  msg = await stored(admin, INBOX, idOf(r.text));
  expect(!r.isError && msg?.plan_required === true, "explicit plan_required:true is kept on a small task", msg ?? r.text);
  r = await call(orch, "dispatch_task", { ns: NSR, to: "core", task_id: `${NSR}-a`, subject: "needs fields", body: "b", context: "c" });
  expect(r.isError && /^dispatch_task: checks: required by namespace/.test(r.text) && /\[manifest .* extensions\.task\.required\]/.test(r.text), "required task field missing: rejected, naming field and source", r.text);
  r = await call(orch, "dispatch_task", { ns: NSR, to: "core", task_id: `${NSR}-b`, subject: "has fields", body: "b", context: "c", checks: [] });
  expect(r.isError && /checks/.test(r.text), "an empty array does not count as given", r.text);
  r = await call(orch, "dispatch_task", { ns: NSR, to: "core", task_id: `${NSR}-c`, subject: "has fields", body: "b", ...full });
  expect(!r.isError && !/Warning/.test(r.text), "required task fields given: sent, no warning", r.text);
  r = await call(orch, "dispatch_task", { ns: `tr${TAG}`, to: "core", task_id: `tr${TAG}-a`, subject: "other role", body: "b" });
  expect(!r.isError && /Warning/.test(r.text), "a requirement on another role (worker) does not bind the orchestrator: warning only", r.text);

  // ── 3. ledger + post_plan / decide_plan ──────────────────────────────────
  console.log("\n[3] ledger states");
  let led = await ledger(orch);
  expect(row(led, T("med"))?.state === "planning" && row(led, T("med")).plan_required === true, "plan_required task with no plan: planning", row(led, T("med")));
  expect(row(led, T("small"))?.state === "pending" && row(led, T("small")).plan_required === false
    && row(led, T("optout"))?.state === "pending" && row(led, T("optout")).plan_required === false, "small / explicit-false tasks stay pending", [row(led, T("small")), row(led, T("optout"))]);
  expect(row(led, T("optin"))?.state === "planning" && row(led, T("optin")).plan_required === true, "explicit plan_required:true on a small task: planning", row(led, T("optin")));
  expect(led.counts.planning >= 1 && "plan-review" in led.counts, "counts carry planning and plan-review", led.counts);

  r = await call(worker, "post_plan", { task_id: T("med"), approach: "a", steps: [], files: {} });
  expect(r.isError, "post_plan with no steps rejected at the tool boundary", r.text);
  r = await call(worker, "post_plan", { task_id: T("ghost"), approach: "a", steps: ["s"], files: {} });
  expect(r.isError && /subject: required/.test(r.text), "post_plan for an undispatched task needs a subject", r.text);
  const plan = { task_id: T("med"), approach: "do it in two steps", steps: ["one", "two"], files: { write: ["a.js"] }, risks: ["r"] };
  r = await call(worker, "post_plan", plan);
  const plan1 = idOf(r.text);
  msg = await stored(admin, STATUS, plan1);
  expect(!r.isError && /plan-review: exit/.test(r.text), "post_plan lands on status and tells the worker to exit", r.text);
  expect(msg?.type === "plan" && msg.from === "core" && msg.to === "boss" && msg.subject === "medium task"
    && msg.body?.files?.read?.length === 0 && msg.body.open_questions?.length === 0 && msg.body.steps.length === 2,
    "plan envelope: from/to/subject filled, files.read / open_questions default []", msg);
  r = await call(worker, "post_plan", { task_id: T("qs"), subject: "questions only", approach: "a", steps: ["s"], files: {}, questions: ["A or B?"] });
  msg = await stored(admin, STATUS, idOf(r.text));
  expect(msg?.body?.open_questions?.[0] === "A or B?", "questions → body.open_questions; subject given for an undispatched task", msg);
  r = await call(orch, "decide_plan", { task_id: T("qs"), decision: "reject", notes: "fixture" });
  expect(!r.isError && r.text.includes(`'${INBOX}'`), "decide_plan on an undispatched task: inbox from the plan author", r.text);
  led = await ledger(orch);
  expect(row(led, T("med"))?.state === "plan-review" && row(led, T("med")).plan?.id === plan1, "plan posted: plan-review", row(led, T("med")));
  let op = led.plans_awaiting_decision;
  expect(op?.length === 1 && op[0].task_id === T("med") && op[0].steps === 2 && op[0].files_write[0] === "a.js",
    "plans_awaiting_decision lists the undecided plan", op);
  expect((await ledger(orch, { workers: ["wk2"] })).plans_awaiting_decision.length === 0, "plans_awaiting_decision honours workers=", null);

  // self-approval through raw send_message is ignored
  await send(INBOX, "core", { type: "plan-decision", task_id: T("med"), from: "boss", to: "core", subject: "medium task", body: { decision: "approve" } });
  led = await ledger(orch);
  expect(row(led, T("med"))?.state === "plan-review", "a decision whose sender wrote the plan is ignored", row(led, T("med")));
  r = await call(admin, "decide_plan", { task_id: T("med"), decision: "approve", sender: "core" });
  expect(r.isError && /cannot decide it/.test(r.text), "decide_plan refuses the plan's author as sender", r.text);

  r = await call(orch, "decide_plan", { task_id: T("med"), decision: "amend" });
  expect(r.isError && /^decide_plan: notes: amend needs notes or amendments/.test(r.text), "amend without notes or amendments rejected", r.text);
  r = await call(orch, "decide_plan", { task_id: T("small"), decision: "approve" });
  expect(r.isError && /no type:plan/.test(r.text), "decide_plan with no plan: nothing to decide", r.text);
  r = await call(orch, "decide_plan", { task_id: T("med"), decision: "amend", amendments: ["add tests"] });
  const dec1 = idOf(r.text);
  msg = await stored(admin, INBOX, dec1);
  expect(!r.isError && r.text.includes(`'${INBOX}'`), "decision lands on the plan author's inbox", r.text);
  expect(msg?.type === "plan-decision" && msg.from === "boss" && msg.to === "core" && msg.body?.decision === "amend"
    && msg.refs?.[0] === `${STATUS}#${plan1}` && /^tp.*-core#\d+$/.test(msg.refs?.[1] ?? ""), "decision envelope: from/to, body, refs to the plan and the task", msg);
  led = await ledger(orch);
  expect(row(led, T("med"))?.state === "planning" && row(led, T("med")).plan?.decision?.decision === "amend", "amend: planning again", row(led, T("med")));
  op = led.plans_awaiting_decision;
  expect(op.length === 0, "plans_awaiting_decision: an amended (and a rejected) plan is no longer listed", op);

  r = await call(worker, "post_plan", { ...plan, steps: ["one", "two", "tests"] });
  const plan2 = idOf(r.text);
  led = await ledger(orch);
  expect(row(led, T("med"))?.state === "plan-review" && row(led, T("med")).plan?.id === plan2 && row(led, T("med")).plan.decision === null, "re-posted plan: plan-review, the old decision does not apply", row(led, T("med")));
  op = led.plans_awaiting_decision;
  expect(op.length === 1 && op[0].id === plan2 && op[0].previous_decision?.decision === "amend", "plans_awaiting_decision: the revised plan, with the amend it answers", op);

  r = await call(orch, "decide_plan", { task_id: T("med"), decision: "approve", notes: "go" });
  led = await ledger(orch);
  expect(!r.isError && row(led, T("med"))?.state === "in-progress", "approve: in-progress", row(led, T("med")));
  await call(worker, "send_message", { channel: STATUS, sender: "core", content: JSON.stringify({ type: "status", task_id: T("med"), from: "core", to: "boss", subject: "medium task", body: "halfway" }) });
  led = await ledger(orch);
  expect(row(led, T("med"))?.state === "in-progress", "status after approval: still in-progress", row(led, T("med")));
  await call(worker, "post_result", { task_id: T("med"), summary: "PASS — done" });
  led = await ledger(orch);
  expect(row(led, T("med"))?.state === "done", "result: done", row(led, T("med")));

  // reject
  r = await call(orch, "dispatch_task", { to: "wk2", task_id: T("rej"), subject: "to be rejected", body: "b", scope: "large", ...full });
  const wk2 = await connect(`?role=worker&ns=${NS}&as=wk2`);
  await call(wk2, "post_plan", { task_id: T("rej"), approach: "bad idea", steps: ["x"], files: {} });
  r = await call(orch, "decide_plan", { task_id: T("rej"), decision: "reject", notes: "out of scope" });
  expect(!r.isError && r.text.includes(`'${INBOX2}'`), "reject lands on wk2's inbox", r.text);
  led = await ledger(orch);
  expect(row(led, T("rej"))?.state === "failed" && row(led, T("rej")).plan?.decision?.decision === "reject", "reject: failed", row(led, T("rej")));
  led = await ledger(orch, { only_open: true });
  expect(!row(led, T("rej")) && !row(led, T("med")), "only_open omits rejected and done tasks", led.tasks.map(t => t.task_id));

  // handoff during planning keeps its notes visible
  r = await call(orch, "dispatch_task", { to: "wk2", task_id: T("hand"), subject: "handoff while planning", body: "b", scope: "medium", ...full });
  await call(wk2, "send_message", { channel: STATUS, sender: "wk2", content: JSON.stringify({ type: "status", task_id: T("hand"), from: "wk2", to: "boss", subject: "rotating", body: { handoff_notes: { done: [], pending: ["plan"] } } }) });
  led = await ledger(orch);
  expect(row(led, T("hand"))?.state === "handoff", "handoff before any plan: handoff (open, notes visible)", row(led, T("hand")));

  // ── 4. watchdog ─────────────────────────────────────────────────────────────
  // ── 4. opt-in per namespace ─────────────────────────────────────────────────
  console.log("\n[4] plan gate is opt-in: ungated namespace with a closed v2 inbox schema");
  const NU = `tu${TAG}`, NG = `tg${TAG}`;
  const closedInbox = { type: "object", required: ["type", "task_id"], additionalProperties: false,
    properties: Object.fromEntries(["type", "task_id", "from", "to", "subject", "context", "background", "scope", "depends_on", "files",
      "constraints", "checks", "acceptance_criteria", "result_template", "body", "refs"].map(k => [k, {}])) };
  for (const ns of [NU, NG]) {
    r = await call(admin, "register_namespace", { manifest: JSON.stringify(manifest(ns, ns === NG ? { plan_gate: true } : {})) });
    expect(!r.isError, `namespace ${ns === NG ? "gated" : "ungated"} registered`, r.text);
    r = await call(admin, "register_channel_schema", { channel: `${ns}-core`, schema: JSON.stringify(closedInbox), strict: true });
    expect(!r.isError, `v2 schema forbidding extra keys on ${ns}-core`, r.text);
  }
  const orchU = await connect(`?role=orchestrator&ns=${NU}`);
  const workerU = await connect(`?role=worker&ns=${NU}&as=core`);
  for (const [ns, o] of [[NU, orchU], [NG, orch]]) for (const scope of ["medium", "large"]) {
    r = await call(o, "dispatch_task", { ns, to: "core", task_id: `${ns}-${scope}`, subject: `${scope} task`, body: "b", scope, ...full });
    msg = await stored(admin, `${ns}-core`, idOf(r.text));
    expect(!r.isError && msg && !("plan_required" in msg), `${ns === NG ? "gated" : "ungated"} ns, closed v2 inbox: scope ${scope} dispatched, no plan_required`, msg ?? r.text);
  }
  r = await call(orchU, "dispatch_task", { to: "core", task_id: `${NU}-explicit`, subject: "explicit", body: "b", plan_required: true });
  expect(r.isError && /plan_required: the plan gate is not enabled for namespace/.test(r.text) && /plan_gate\]/.test(r.text), "ungated: explicit plan_required refused, naming the manifest flag", r.text);
  r = await call(workerU, "post_plan", { task_id: `${NU}-medium`, approach: "a", steps: ["s"], files: {} });
  expect(r.isError && /plan gate is not enabled/.test(r.text), "ungated: post_plan refused", r.text);
  r = await call(orchU, "decide_plan", { task_id: `${NU}-medium`, decision: "approve" });
  expect(r.isError && /plan gate is not enabled/.test(r.text), "ungated: decide_plan refused", r.text);
  // a raw plan on the status channel does not move an ungated task either
  await send(`${NU}-status`, "core", { type: "plan", task_id: `${NU}-large`, from: "core", to: "boss", subject: "large task",
    body: { approach: "a", steps: ["s"], files: { read: [], write: [] }, risks: [], open_questions: [] } });
  let ledU = JSON.parse((await call(orchU, "get_task_ledger", { status_channel: `${NU}-status` })).text);
  const ur = ledU.tasks.filter(t => t.task_id.startsWith(`${NU}-`));
  expect(ur.length === 2 && ur.every(t => t.state === "pending" && !("plan_required" in t) && !("plan" in t)), "ungated ledger: pending, no plan_required / plan fields", ur);
  expect(!("planning" in ledU.counts) && !("plan-review" in ledU.counts) && !("plans_awaiting_decision" in ledU), "ungated ledger: no planning / plan-review counts, no plans_awaiting_decision", ledU);
  const ledG = JSON.parse((await call(orch, "get_task_ledger", { status_channel: `${NG}-status` })).text);
  expect(ledG.tasks.filter(t => t.task_id.startsWith(`${NG}-`)).every(t => t.state === "planning" && t.plan_required === true), "gated ledger: medium/large derive plan_required → planning", ledG.tasks);

  console.log("\n[5] watchdog: plan-review is not open, the decision relaunches");
  // Settle every earlier task for 'core' so only the watchdog's own tasks are open.
  for (const id of ["small", "optout", "optin"]) await call(worker, "post_result", { task_id: T(id), summary: "SKIP — test fixture" });
  const fake = join(dir, "fake-claude");
  writeFileSync(fake, `#!/usr/bin/env bash
if [[ "\${1:-}" == "--help" ]]; then exit 0; fi
node -e 'fetch(process.env.BROKER_URL+"/messages",{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+process.env.BROKER_SECRET},body:JSON.stringify({channel:process.argv[1],sender:"core",content:process.argv[2]})})' "$FAKE_STATUS" "$FAKE_POST"
exit 0
`);
  chmodSync(fake, 0o755);
  const wd = (post) => {
    const res = spawnSync("bash", [join(ROOT, "watchdog.sh"), "core", "--work-dir", work, "--inbox-channel", INBOX, "--once"], {
      env: cleanEnv({ BROKER_URL: BASE, BROKER_SECRET: SECRET, CLAUDE_BIN: fake, WATCHDOG_JITTER_MAX: "0", WATCHDOG_MCP: "0", WATCHDOG_STREAM_JSON: "0",
        WATCHDOG_HEARTBEAT_INTERVAL: "1", FOLLOWUP_MAX: "0", FAKE_STATUS: STATUS, FAKE_POST: JSON.stringify(post) }),
      encoding: "utf8", timeout: 90_000 });
    return (res.stdout || "") + (res.stderr || "");
  };
  const W = T("wd");
  await call(orch, "dispatch_task", { to: "core", task_id: W, subject: "watchdog plan", body: "b", scope: "large", ...full });
  let log = wd({ type: "plan", task_id: W, from: "core", to: "boss", subject: "watchdog plan",
    body: { approach: "a", steps: ["s"], files: { read: [], write: [] }, risks: [], open_questions: [] } });
  led = await ledger(orch);
  expect(row(led, W)?.state === "plan-review", "session posted a plan: plan-review", row(led, W));
  expect(/reason: inbox/.test(log) && /clean exit — cursor=\d+, restarting/.test(log) && !/open task/.test(log),
    "plan-review is not an open task: no follow-up launch", log.slice(-1500));

  await call(orch, "decide_plan", { task_id: W, decision: "approve" });
  log = wd({ type: "result", task_id: W, from: "core", to: "boss", subject: "watchdog plan", summary: "PASS — done" });
  led = await ledger(orch);
  expect(/reason: inbox/.test(log) && row(led, W)?.state === "done", "the plan-decision on the inbox launches the next session", log.slice(-1500));

  const P = T("wd2");
  await call(orch, "dispatch_task", { to: "core", task_id: P, subject: "watchdog planning", body: "b", scope: "medium", ...full });
  log = wd({ type: "status", task_id: P, from: "core", to: "boss", subject: "looking", body: "reading code" });
  led = await ledger(orch);
  expect(row(led, P)?.state === "planning" && /1 open task\(s\)/.test(log), "planning (no plan yet) is an open task for the watchdog", `${row(led, P)?.state}\n${log.slice(-1500)}`);

  // ── 6. orchestrator credential ──────────────────────────────────────────────
  console.log("\n[6] orchestrator credential: reserved senders in a trust namespace");
  r = await call(admin, "register_namespace", { manifest: JSON.stringify(manifest(NT, { plan_gate: true })) });
  expect(!r.isError, "trust namespace registered (orchestrator-role worker 'boss')", r.text);
  const TT = (s) => `${NT}-${s}`, ST = TT("status");
  const ledT = async () => JSON.parse((await call(admin, "get_task_ledger", { status_channel: ST })).text);
  const orchTok  = await connect(`?role=orchestrator&ns=${NT}`, ORCH_H);
  const orchNo   = await connect(`?role=orchestrator&ns=${NT}`);
  const adminWk  = await connect(`?role=admin&ns=${NT}&as=core`);
  const wk2T     = await connect(`?role=worker&ns=${NT}&as=wk2`);
  const coreT    = await connect(`?role=worker&ns=${NT}&as=core`);

  r = await call(orchNo, "dispatch_task", { to: "core", task_id: TT("spoof"), subject: "spoofed dispatch", body: "b", scope: "large", ...full });
  expect(r.isError && /X-Orchestrator-Token/.test(r.text) && /ORCHESTRATOR_TOKEN_SHA256/.test(r.text) && /'boss' is reserved/.test(r.text),
    "dispatch_task as the orchestrator without the header: refused, naming the header and env var", r.text);
  r = await call(adminWk, "dispatch_task", { to: "core", task_id: TT("spoof"), subject: "spoofed dispatch", body: "b", from: "boss", scope: "large", ...full });
  expect(r.isError && /reserved/.test(r.text), "role=admin&as=core claiming from=boss: refused (?role / ?as= are not credentials)", r.text);
  r = await call(none, "send_message", { channel: TT("core"), sender: "orchestrator", content: JSON.stringify({ type: "task", task_id: TT("spoof"), from: "orchestrator", to: "core", subject: "s" }) });
  expect(r.isError && /'orchestrator' is reserved/.test(r.text), "v2 send_message as 'orchestrator' (always reserved): refused", r.text);
  let raw = await sendRaw(TT("core"), "boss", { type: "task", task_id: TT("spoof"), from: "boss", to: "core", subject: "s" });
  expect(raw.status === 403 && /X-Orchestrator-Token/.test(raw.body?.error), "POST /messages as the orchestrator without the header: 403", raw);
  raw = await sendRaw(TT("core"), "boss", { type: "task", task_id: TT("spoof"), from: "boss", to: "core", subject: "s" }, { "X-Orchestrator-Token": "wrong" });
  expect(raw.status === 403, "a wrong token: 403", raw);
  expect(!(await ledT()).tasks.some(t => t.task_id === TT("spoof")), "no spoofed dispatch reached the ledger");

  r = await call(orchTok, "dispatch_task", { to: "core", task_id: TT("real"), subject: "real dispatch", body: "b", scope: "large", ...full });
  expect(!r.isError && /as 'boss'/.test(r.text), "with the header: dispatch_task as the orchestrator is sent", r.text);
  r = await call(coreT, "post_plan", { task_id: TT("real"), approach: "a", steps: ["s"], files: {} });
  expect(!r.isError, "worker posts its plan", r.text);

  r = await call(orchNo, "decide_plan", { task_id: TT("real"), decision: "approve" });
  expect(r.isError && /reserved/.test(r.text), "decide_plan without the header: refused", r.text);
  raw = await sendRaw(TT("core"), "boss", { type: "plan-decision", task_id: TT("real"), from: "boss", to: "core", subject: "s", body: { decision: "approve" } });
  expect(raw.status === 403, "raw plan-decision as the orchestrator without the header: 403", raw);
  r = await call(wk2T, "send_message", { channel: TT("core"), sender: "wk2", content: JSON.stringify({ type: "plan-decision", task_id: TT("real"), from: "boss", to: "core", subject: "s", body: { decision: "approve" } }) });
  expect(!r.isError, "a peer worker can still post under its own name", r.text);
  expect(row(await ledT(), TT("real"))?.state === "plan-review", "a peer worker's approval under its own name is ignored: plan-review", row(await ledT(), TT("real")));

  r = await call(orchTok, "decide_plan", { task_id: TT("real"), decision: "approve" });
  expect(!r.isError && row(await ledT(), TT("real"))?.state === "in-progress", "credentialed decide_plan approves: in-progress", r.text);
  await call(wk2T, "send_message", { channel: TT("core"), sender: "wk2", content: JSON.stringify({ type: "plan-decision", task_id: TT("real"), from: "boss", to: "core", subject: "s", body: { decision: "reject", notes: "x" } }) });
  expect(row(await ledT(), TT("real"))?.state === "in-progress", "a later peer reject does not hide the real approval", row(await ledT(), TT("real")));

  // Held release (runner/orchestrate.mjs trusts <ns>-held rows whose DB sender is its --sender)
  const held = { type: "held", task_id: TT("real"), from: "boss", subject: "release" };
  raw = await sendRaw(TT("held"), "boss", held);
  expect(raw.status === 403, "held-release record as the orchestrator without the header: 403", raw);
  raw = await sendRaw(TT("held"), "boss", held, ORCH_H);
  expect(raw.status === 200 && raw.body?.id > 0, "with the header: the held-release record is written", raw);
  raw = await sendRaw(`${NS}-core`, "boss", { type: "note", task_id: T("x"), from: "boss", to: "core", subject: "ungated ns" });
  expect(raw.status === 200, "a namespace not in ORCHESTRATOR_TRUST_NAMESPACES is unchanged: posts as the orchestrator without the header", raw);

  // ── 7. enforcement ──────────────────────────────────────────────────────────
  console.log("\n[7] plan gate enforced on results");
  const disp = (to, id, scope, extra = {}) => call(orch, "dispatch_task", { to, task_id: T(id), subject: `gate ${id}`, body: "b", scope, ...full, ...extra });
  const res = (client, id, summary) => call(client, "post_result", { task_id: T(id), summary });
  // gate-live: T("med") was dispatched before the namespace's first plan, so it was never gated
  expect(row(await ledger(orch), T("med"))?.state === "done", "a task dispatched before the gate-live marker keeps its result (history not rewritten)", row(await ledger(orch), T("med")));

  await disp("wk2", "g1", "medium");
  r = await res(wk2, "g1", "PASS — no plan");
  expect(r.isError && /^post_result: task_id: plan not approved \(planning, no plan posted\)/.test(r.text) && /\[plan gate\]/.test(r.text), "post_result PASS with no plan: refused", r.text);
  await call(wk2, "post_plan", { task_id: T("g1"), approach: "a", steps: ["s"], files: {} });
  r = await res(wk2, "g1", "PASS — plan pending");
  expect(r.isError && /plan not approved \(plan-review, latest plan #\d+\)/.test(r.text), "post_result PASS while the plan is in review: refused", r.text);
  r = await call(orch, "decide_plan", { task_id: T("g1"), decision: "approve", to: "core" });
  expect(r.isError && /^decide_plan: to: 'core' is not the plan's author 'wk2'/.test(r.text), "decide_plan to ≠ plan author: refused", r.text);
  await call(orch, "decide_plan", { task_id: T("g1"), decision: "amend", notes: "more" });
  r = await res(wk2, "g1", "PASS — after amend");
  expect(r.isError && /plan not approved \(planning, latest plan #\d+, decision #\d+ amend\)/.test(r.text), "post_result PASS after amend: refused", r.text);
  await call(wk2, "post_plan", { task_id: T("g1"), approach: "b", steps: ["s", "t"], files: {} });
  r = await call(orch, "decide_plan", { task_id: T("g1"), decision: "approve", to: "wk2" });
  expect(!r.isError, "decide_plan with to = the plan author: accepted", r.text);
  r = await res(wk2, "g1", "PASS — approved");
  expect(!r.isError && row(await ledger(orch), T("g1"))?.state === "done", "post_result PASS after approve: accepted, done", r.text);

  await disp("wk2", "g2", "large");
  r = await res(wk2, "g2", "FAIL — cannot do this");
  expect(!r.isError && row(await ledger(orch), T("g2"))?.state === "failed", "FAIL on an unapproved planned task: allowed", r.text);
  await disp("wk2", "g3", "medium");
  r = await res(wk2, "g3", "SKIP — not needed");
  expect(!r.isError && row(await ledger(orch), T("g3"))?.state === "skipped", "SKIP on an unapproved planned task: allowed", r.text);

  // reject is terminal until re-dispatched
  r = await res(wk2, "rej", "PASS — ignored the reject");
  expect(r.isError && /plan not approved \(rejected/.test(r.text), "post_result PASS after reject: refused", r.text);
  await call(wk2, "post_plan", { task_id: T("rej"), approach: "try again", steps: ["x"], files: {} });
  let led7 = await ledger(orch);
  expect(row(led7, T("rej"))?.state === "failed", "a plan re-posted after reject does not reopen the task", row(led7, T("rej")));
  await disp("wk2", "rej", "large");
  led7 = await ledger(orch);
  expect(row(led7, T("rej"))?.state === "planning" && row(led7, T("rej")).plan_required === true, "re-dispatch after reject: planning again (the old plan is void)", row(led7, T("rej")));
  await disp("wk2", "rej", "large", { plan_required: false });
  led7 = await ledger(orch);
  expect(row(led7, T("rej"))?.plan_required === false && row(led7, T("rej")).state !== "planning", "a later re-dispatch with plan_required:false clears the gate", row(led7, T("rej")));
  r = await res(wk2, "rej", "PASS — no plan needed now");
  expect(!r.isError && row(await ledger(orch), T("rej"))?.state === "done", "... and its PASS is accepted", r.text);

  // raw send_message PASS on a planned task with no plan: the live repro shape (#185712)
  await disp("wk2", "raw", "medium");
  r = await call(wk2, "send_message", { channel: STATUS, sender: "wk2", content: JSON.stringify({ type: "result", task_id: T("raw"), from: "wk2", to: "boss", subject: "gate raw", summary: "PASS — no plan ever" }) });
  expect(!r.isError && /WARN plan gate: .* has no approved plan \(planning\)/.test(r.text), "raw send_message PASS lands, with a plan-gate warning", r.text);
  led7 = await ledger(orch);
  expect(row(led7, T("raw"))?.state === "failed" && row(led7, T("raw")).plan_unapproved === true, "ledger: unapproved PASS → failed, plan_unapproved", row(led7, T("raw")));
  r = await call(orch, "decide_plan", { task_id: T("raw"), decision: "amend", notes: "x", waiver: true });
  expect(r.isError && /only an approve can waive/.test(r.text), "waiver needs approve", r.text);
  r = await call(orch, "decide_plan", { task_id: T("g1"), decision: "approve", waiver: true });
  expect(r.isError && /has a plan/.test(r.text), "waiver refused for a task that has a plan", r.text);
  r = await call(orch, "decide_plan", { task_id: T("raw"), decision: "approve", waiver: true, notes: "accepted without a plan" });
  msg = await stored(admin, INBOX2, idOf(r.text));
  expect(!r.isError && msg?.body?.waiver === true && msg.to === "wk2", "orchestrator waiver: approve + body.waiver to the task's worker", msg ?? r.text);
  led7 = await ledger(orch);
  expect(row(led7, T("raw"))?.state === "done" && !row(led7, T("raw")).plan_unapproved && row(led7, T("raw")).plan === null, "after the waiver: done", row(led7, T("raw")));
  await send(INBOX2, "wk2", { type: "plan-decision", task_id: T("g3"), from: "boss", to: "wk2", subject: "s", body: { decision: "approve", waiver: true } });
  await disp("wk2", "g5", "medium");
  await send(INBOX2, "core", { type: "plan-decision", task_id: T("g5"), from: "boss", to: "wk2", subject: "s", body: { decision: "approve", waiver: true } });
  r = await res(wk2, "g5", "PASS — peer waiver");
  expect(r.isError && /plan not approved/.test(r.text), "a waiver from a non-orchestrator sender does not count", r.text);

  // reviewer tasks
  const rv = await connect(`?role=reviewer&ns=${NS}&as=rv`);
  await disp("rv", "rv1", "medium");
  r = await res(rv, "rv1", "PASS — reviewed");
  led7 = await ledger(orch);
  expect(!r.isError && row(led7, T("rv1"))?.plan_required === false && row(led7, T("rv1")).state === "done", "a reviewer's medium task is not gated", r.text);
  await disp("rv", "rv2", "small", { plan_required: true });
  r = await res(rv, "rv2", "PASS — reviewed");
  expect(r.isError && /plan not approved/.test(r.text), "... unless its dispatch sets plan_required: true", r.text);
}

main()
  .catch(e => { failed++; console.error("FATAL:", e); process.exitCode = 1; })
  .finally(async () => {
    for (const c of clients) { try { await c.close(); } catch {} }
    try { broker?.kill("SIGTERM"); } catch {}
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    const safe = INBOX.replace(/[^a-zA-Z0-9]/g, "-");
    for (const f of [`-${safe}-cursor`, `-${safe}-patrol`, `-${safe}.lock`]) { try { rmSync(`/tmp/watchdog-core${f}`, { force: true }); } catch {} }
    console.log(`\n${"─".repeat(50)}\n  passed: ${passed}   failed: ${failed}\n  ${failed ? "SOME TESTS FAILED" : "ALL TESTS PASSED"}`);
  });
