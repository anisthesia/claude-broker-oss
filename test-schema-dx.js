// Schema validation tests for dx-namespace channels (Dollex ERP).
// Exercises all dx-* channel schemas against a live broker.
// Safe to run multiple times — uses unique channel names per run.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync } from "fs";
import "dotenv/config";

const BROKER_URL = process.env.BROKER_URL || "http://localhost:8080/mcp";
const SECRET     = process.env.SHARED_SECRET || "";
const RUN_TAG    = Date.now().toString(36);

async function connect(name) {
  const transport = new StreamableHTTPClientTransport(new URL(BROKER_URL), {
    requestInit: SECRET ? { headers: { Authorization: `Bearer ${SECRET}` } } : {},
  });
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

let passed = 0;
let failed = 0;

function expect(cond, label, detail) {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed++;
    return true;
  }
  console.error(`  ✗ ${label}`);
  if (detail !== undefined) console.error(`     detail: ${JSON.stringify(detail)}`);
  failed++;
  process.exitCode = 1;
  return false;
}

async function send(client, channel, content) {
  const r = await client.callTool({
    name: "send_message",
    arguments: { channel, sender: "test-dx-schema", content: JSON.stringify(content) },
  });
  return r.content?.[0]?.text ?? "";
}

async function registerSchema(client, channel, file, strict) {
  const schema = readFileSync(file, "utf-8");
  const r = await client.callTool({
    name: "register_channel_schema",
    arguments: { channel, schema, strict },
  });
  return r;
}

async function clearSchema(client, channel) {
  await client.callTool({ name: "clear_channel_schema", arguments: { channel } });
  await client.callTool({ name: "purge_channel", arguments: { channel } });
}

// ─── dx-backlog ───────────────────────────────────────────────────────────────

async function testBacklog(client) {
  console.log("\n── dx-backlog ──");
  const ch = `dx-bl-test-${RUN_TAG}`;
  const file = "schemas/dx-backlog.json";

  let r = await registerSchema(client, ch, file, false);
  expect(/Registered schema/.test(r.content?.[0]?.text), "backlog: schema registered warn-only");

  // 1. Valid type:deferred
  const validDeferred = {
    type: "deferred",
    task_id: "dx-2026-06-22-bl-001",
    subject: "add currency exchange rate sync",
    from: "api",
    to: "orchestrator",
    body: { priority: "medium" },
    deferred_reason: "scope too large for current sprint",
  };
  let t = await send(client, ch, validDeferred);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "backlog: valid type:deferred accepted, no warn", t);

  // 2. Valid type:deferred-resolved with body.resolved_in_sprint and body.outcome
  const validResolved = {
    type: "deferred-resolved",
    task_id: "dx-2026-06-22-bl-001",
    subject: "add currency exchange rate sync",
    from: "api",
    to: "orchestrator",
    body: { resolved_in_sprint: "dx-sprint-004", outcome: "promoted" },
  };
  t = await send(client, ch, validResolved);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "backlog: valid deferred-resolved with full body accepted", t);

  // 3. deferred-resolved missing body.outcome → warn (dx schema requires both fields)
  const resolvedNoOutcome = {
    type: "deferred-resolved",
    task_id: "dx-2026-06-22-bl-002",
    subject: "add invoice template editor",
    from: "web",
    to: "orchestrator",
    body: { resolved_in_sprint: "dx-sprint-004" },
  };
  t = await send(client, ch, resolvedNoOutcome);
  expect(/WARN/.test(t), "backlog: deferred-resolved missing body.outcome → warn", t);
  expect(/Sent #/.test(t), "backlog: deferred-resolved missing outcome still stored in warn-only", t);

  // 4. deferred-resolved missing body.resolved_in_sprint → warn
  const resolvedNoSprint = {
    type: "deferred-resolved",
    task_id: "dx-2026-06-22-bl-003",
    subject: "add PO approval workflow",
    body: { outcome: "cancelled" },
  };
  t = await send(client, ch, resolvedNoSprint);
  expect(/WARN/.test(t), "backlog: deferred-resolved missing body.resolved_in_sprint → warn", t);

  // 5. Unknown type (type:note not allowed in backlog) → warn
  const unknownType = {
    type: "note",
    task_id: "dx-2026-06-22-bl-unk",
    subject: "type:note not allowed in backlog",
  };
  t = await send(client, ch, unknownType);
  expect(/WARN/.test(t), "backlog: unknown type:note → warn in warn-only", t);

  // 6. Missing required task_id → warn
  const missingTaskId = { type: "deferred", subject: "no task_id here" };
  t = await send(client, ch, missingTaskId);
  expect(/WARN/.test(t), "backlog: missing task_id → warn in warn-only", t);

  // 7. Flip to strict; missing task_id → rejected
  r = await registerSchema(client, ch, file, true);
  expect(/Registered schema/.test(r.content?.[0]?.text), "backlog: schema re-registered strict");

  t = await send(client, ch, missingTaskId);
  expect(/schema validation failed/.test(t), "backlog strict: missing task_id rejected", t);

  // 8. Strict: valid deferred accepted
  t = await send(client, ch, validDeferred);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "backlog strict: valid deferred accepted", t);

  // 9. Strict: valid deferred-resolved with full body accepted
  t = await send(client, ch, validResolved);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "backlog strict: valid deferred-resolved with full body accepted", t);

  await clearSchema(client, ch);
}

// ─── dx-control ───────────────────────────────────────────────────────────────

async function testControl(client) {
  console.log("\n── dx-control ──");
  const ch = `dx-ctrl-test-${RUN_TAG}`;
  const file = "schemas/dx-control.json";

  let r = await registerSchema(client, ch, file, false);
  expect(/Registered schema/.test(r.content?.[0]?.text), "control: schema registered warn-only");

  // 1. Valid type:note
  const validNote = {
    type: "note",
    task_id: "dx-2026-06-22-ctrl-n1",
    from: "orchestrator",
    to: "*",
    subject: "all workers: freeze merges until sprint review",
  };
  let t = await send(client, ch, validNote);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "control: valid type:note accepted, no warn", t);

  // 2. Valid type:approval-token with required body fields
  const validToken = {
    type: "approval-token",
    task_id: "dx-2026-06-22-ctrl-tok",
    from: "orchestrator",
    to: "api",
    subject: "approve deploy to staging",
    body: {
      authorized_actions: ["deploy:staging"],
      env: "staging",
      scope_workers: ["api"],
      expires_at: "2026-06-22T23:59:59Z",
    },
  };
  t = await send(client, ch, validToken);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "control: valid approval-token with full body accepted", t);

  // approval-token with NO body at all → warn (v1.1: body now required)
  const bodylessTokendx_2026_07_07_ctrl_tok_nobody = { ...validToken, task_id: "dx-2026-07-07-ctrl-tok-nobody" };
  delete bodylessTokendx_2026_07_07_ctrl_tok_nobody.body;
  t = await send(client, ch, bodylessTokendx_2026_07_07_ctrl_tok_nobody);
  expect(/WARN/.test(t), "control: bodyless approval-token → warn (body required)", t);

  // 3. Valid type:contract-change with wire_compat
  const validContract = {
    type: "contract-change",
    task_id: "dx-2026-06-22-ctrl-cc1",
    from: "orchestrator",
    to: "*",
    subject: "invoice API shape changing",
    body: { before: { version: 1 }, after: { version: 2 }, affected_workers: ["web", "qa"] },
    wire_compat: "breaking",
  };
  t = await send(client, ch, validContract);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "control: valid contract-change with wire_compat accepted", t);

  // 4. contract-change missing wire_compat → warn
  const contractNoCompat = {
    type: "contract-change",
    task_id: "dx-2026-06-22-ctrl-cc2",
    from: "orchestrator",
    to: "*",
    subject: "payment schema changing",
    body: { before: { version: 1 }, after: { version: 2 }, affected_workers: ["api"] },
  };
  t = await send(client, ch, contractNoCompat);
  expect(/WARN/.test(t), "control: contract-change without wire_compat → warn", t);

  // 5. type:task (not allowed in dx-control enum) → warn
  const wrongType = {
    type: "task",
    task_id: "dx-2026-06-22-ctrl-unk",
    from: "orchestrator",
    to: "api",
    subject: "type:task not allowed in dx-control",
  };
  t = await send(client, ch, wrongType);
  expect(/WARN/.test(t), "control: type:task (not in enum) → warn", t);

  // 6. Missing required task_id → warn
  const missingTaskId = { type: "note", from: "orchestrator", to: "*", subject: "no task_id" };
  t = await send(client, ch, missingTaskId);
  expect(/WARN/.test(t), "control: missing task_id → warn in warn-only", t);

  // 7. Valid type:policy-update → no warn
  const validPolicy = {
    type: "policy-update",
    task_id: "dx-2026-06-22-ctrl-pol1",
    from: "orchestrator",
    to: "*",
    subject: "new data retention policy effective now",
  };
  t = await send(client, ch, validPolicy);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "control: valid type:policy-update accepted, no warn", t);

  // 8. Flip to strict; missing task_id → rejected
  r = await registerSchema(client, ch, file, true);
  expect(/Registered schema/.test(r.content?.[0]?.text), "control: schema re-registered strict");

  t = await send(client, ch, missingTaskId);
  expect(/schema validation failed/.test(t), "control strict: missing task_id rejected", t);

  // 9. Strict: valid note accepted
  t = await send(client, ch, validNote);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "control strict: valid note accepted", t);

  await clearSchema(client, ch);
}

// ─── dx-status ────────────────────────────────────────────────────────────────

async function testStatus(client) {
  console.log("\n── dx-status ──");
  const ch = `dx-st-test-${RUN_TAG}`;
  const file = "schemas/dx-status.json";

  let r = await registerSchema(client, ch, file, false);
  expect(/Registered schema/.test(r.content?.[0]?.text), "status: schema registered warn-only");

  // 1. Valid type:result with summary (required on results since v1.1)
  const validResult = {
    type: "result",
    task_id: "dx-2026-06-22-st-r01",
    from: "api",
    to: "orchestrator",
    subject: "invoice API complete",
    summary: "PASS — invoice API endpoints implemented, 12/12 tests pass",
    body: { consent_basis: "orchestrator-dispatch-only" },
  };
  let t = await send(client, ch, validResult);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "status: valid type:result with summary accepted, no warn", t);

  // 1b. type:result missing summary → warn
  const resultNoSummary = {
    type: "result",
    task_id: "dx-2026-06-22-st-r04",
    from: "api",
    to: "orchestrator",
    subject: "result without summary",
    body: {},
  };
  t = await send(client, ch, resultNoSummary);
  expect(/WARN/.test(t), "status: result missing summary → warn", t);

  // 1c. type:result with summary + affected_files → no warn
  const resultWithFiles = {
    type: "result",
    task_id: "dx-2026-06-22-st-r05",
    from: "web",
    to: "orchestrator",
    subject: "invoice UI complete",
    summary: "PASS — invoice list page shipped",
    affected_files: ["src/pages/invoices.tsx", "src/api/invoices.ts"],
    body: { commits: [{ sha: "abc1234", branch: "worker/web" }] },
  };
  t = await send(client, ch, resultWithFiles);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "status: result with summary + affected_files accepted, no warn", t);

  // 1d. type:status without summary → no warn (summary only required on results)
  const statusNoSummary = {
    type: "status",
    task_id: "dx-2026-06-22-st-s01",
    from: "api",
    to: "orchestrator",
    subject: "making progress on invoice API",
    body: {},
  };
  t = await send(client, ch, statusNoSummary);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "status: type:status without summary accepted, no warn", t);

  // 2. Valid type:question
  const validQuestion = {
    type: "question",
    task_id: "dx-2026-06-22-st-q01",
    from: "web",
    to: "orchestrator",
    subject: "should I skip the DB migration?",
    body: { context: "migration 0042 looks risky" },
  };
  t = await send(client, ch, validQuestion);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "status: valid type:question accepted, no warn", t);

  // 3. type:result with production_touching=true but no consent_basis → warn
  const resultNoBasis = {
    type: "result",
    task_id: "dx-2026-06-22-st-r02",
    from: "db",
    to: "orchestrator",
    subject: "migration applied",
    body: { production_touching: true },
  };
  t = await send(client, ch, resultNoBasis);
  expect(/WARN/.test(t), "status: result with production_touching=true, no consent_basis → warn", t);

  // 4. type:result with production_touching=true AND consent_basis → no warn
  const resultWithBasis = {
    type: "result",
    task_id: "dx-2026-06-22-st-r03",
    from: "db",
    to: "orchestrator",
    subject: "migration applied with consent",
    summary: "PASS — migration applied with consent",
    body: { production_touching: true, consent_basis: "orchestrator-dispatch-only" },
  };
  t = await send(client, ch, resultWithBasis);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "status: result with production_touching + consent_basis accepted", t);

  // 5. Missing required task_id → warn
  const missingTaskId = { type: "status", from: "api", to: "orchestrator", subject: "no task_id" };
  t = await send(client, ch, missingTaskId);
  expect(/WARN/.test(t), "status: missing task_id → warn in warn-only", t);

  // 6. Valid type:handoff → no warn
  const validHandoff = {
    type: "handoff",
    task_id: "dx-2026-06-22-st-h01",
    from: "api",
    to: "web",
    subject: "auth token ready for web to consume",
    body: { token_channel: "dx-api-tokens" },
  };
  t = await send(client, ch, validHandoff);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "status: valid type:handoff accepted, no warn", t);

  // 7. Flip to strict; missing task_id → rejected
  r = await registerSchema(client, ch, file, true);
  expect(/Registered schema/.test(r.content?.[0]?.text), "status: schema re-registered strict");

  t = await send(client, ch, missingTaskId);
  expect(/schema validation failed/.test(t), "status strict: missing task_id rejected", t);

  // 8. Strict: valid result accepted
  t = await send(client, ch, validResult);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "status strict: valid type:result accepted", t);

  await clearSchema(client, ch);
}

// ─── dx-telemetry ─────────────────────────────────────────────────────────────

async function testTelemetry(client) {
  console.log("\n── dx-telemetry ──");
  const ch = `dx-tel-test-${RUN_TAG}`;
  const file = "schemas/dx-telemetry.json";

  let r = await registerSchema(client, ch, file, false);
  expect(/Registered schema/.test(r.content?.[0]?.text), "telemetry: schema registered warn-only");

  // 1. Valid heartbeat with all required fields
  const validHB = {
    type: "heartbeat",
    from: "api",
    ts: "2026-06-22T10:00:00Z",
    session_id: "sess-dx-api-001",
    model: "claude-sonnet-4-6",
    context: { size_tokens: 50000, tier_threshold_pct: 35.0, rotation_recommended: false },
    activity: { state: "working", current_task_id: "dx-2026-06-22-api-001" },
  };
  let t = await send(client, ch, validHB);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "telemetry: valid heartbeat accepted, no warn", t);

  // 2. All valid activity states
  for (const state of ["idle-polling", "idle-exit", "blocked-on-question", "rotating", "session-end", "reviewing", "coverage-patrol"]) {
    const hb = { ...validHB, activity: { state } };
    t = await send(client, ch, hb);
    expect(/Sent #/.test(t) && !/WARN/.test(t), `telemetry: state="${state}" accepted`, t);
  }

  // exit_code allowed top-level on session-end heartbeats (v1.1)
  const withExitCode = { ...validHB, activity: { state: "session-end" }, exit_code: 0 };
  t = await send(client, ch, withExitCode);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "telemetry: session-end heartbeat with exit_code accepted", t);

  // 3. Heartbeat missing context.rotation_recommended → warn
  const missingRotation = {
    type: "heartbeat",
    from: "web",
    ts: "2026-06-22T10:01:00Z",
    session_id: "sess-dx-web-001",
    model: "claude-opus-4-7",
    context: { size_tokens: 30000, tier_threshold_pct: 20.0 },
    activity: { state: "working" },
  };
  t = await send(client, ch, missingRotation);
  expect(/WARN/.test(t), "telemetry: heartbeat missing context.rotation_recommended → warn", t);

  // 4. Heartbeat with unknown activity.state → warn
  const badState = { ...validHB, activity: { state: "undefined-state" } };
  t = await send(client, ch, badState);
  expect(/WARN/.test(t), "telemetry: unknown activity.state → warn in warn-only", t);

  // 5. Missing from field → warn
  const missingFrom = {
    type: "heartbeat",
    ts: "2026-06-22T10:02:00Z",
    context: { size_tokens: 10000, tier_threshold_pct: 10.0, rotation_recommended: false },
    activity: { state: "idle-polling" },
  };
  t = await send(client, ch, missingFrom);
  expect(/WARN/.test(t), "telemetry: missing from field → warn", t);

  // 6. Flip to strict; unknown activity.state → rejected
  r = await registerSchema(client, ch, file, true);
  expect(/Registered schema/.test(r.content?.[0]?.text), "telemetry: schema re-registered strict");

  t = await send(client, ch, badState);
  expect(/schema validation failed/.test(t), "telemetry strict: unknown state → rejected", t);

  // 7. Strict: valid heartbeat accepted
  t = await send(client, ch, validHB);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "telemetry strict: valid heartbeat accepted", t);

  await clearSchema(client, ch);
}

// ─── dx-worker-inbox ──────────────────────────────────────────────────────────
// Shared by: dx-api, dx-web, dx-db, dx-qa

async function testWorkerInbox(client) {
  console.log("\n── dx-worker-inbox (dx-api / dx-web / dx-db / dx-qa) ──");
  const ch = `dx-wi-test-${RUN_TAG}`;
  const file = "schemas/dx-worker-inbox.json";

  let r = await registerSchema(client, ch, file, false);
  expect(/Registered schema/.test(r.content?.[0]?.text), "worker-inbox: schema registered warn-only");

  // 1. Valid task with correctly formatted task_id pattern
  const validTask = {
    type: "task",
    task_id: "dx-2026-06-22-api-001",
    from: "orchestrator",
    to: "api",
    subject: "implement invoice line item API",
    body: "add CRUD endpoints for invoice line items",
    depends_on: [],
    required_checks: ["test", "committed"],
  };
  let t = await send(client, ch, validTask);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "worker-inbox: valid task accepted, no warn", t);

  // 1b. Full v2.1 envelope — dispatch fields accepted since v1.1
  const v21Task = {
    type: "task",
    task_id: "dx-2026-06-22-api-002",
    from: "orchestrator",
    to: "api",
    subject: "v2.1 envelope task",
    context: "why this task exists",
    background: "prior decisions and related tasks.",
    scope: "medium",
    files: { read: ["docs/api.md"], write: ["src/api/invoices.ts"] },
    checks: [{ name: "test", run: "npm test", pass_condition: "all pass" }],
    constraints: ["Do NOT touch files outside files.write"],
    acceptance_criteria: ["endpoints implemented", "tests green"],
    result_template: { required_checks: { test: "PASS|FAIL" }, commits: [] },
    baseline_task_id: "dx-2026-06-22-baseline",
    body: "implement per the checks",
  };
  t = await send(client, ch, v21Task);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "worker-inbox: v2.1 envelope fields accepted, no warn", t);

  // 1c. Unknown top-level field still rejected (additionalProperties:false intact)
  const unknownField = { ...validTask, task_id: "dx-2026-06-22-api-003", made_up_field: true };
  t = await send(client, ch, unknownField);
  expect(/WARN/.test(t), "worker-inbox: unknown top-level field → warn (additionalProperties still enforced)", t);

  // 2. task_id failing pattern → warn
  const badTaskId = {
    type: "task",
    task_id: "INVALID_TASK_ID",
    from: "orchestrator",
    to: "api",
    subject: "task with bad task_id pattern",
    body: "do something",
  };
  t = await send(client, ch, badTaskId);
  expect(/WARN/.test(t), "worker-inbox: task_id failing pattern → warn in warn-only", t);

  // 3. Valid type:rotate
  const validRotate = {
    type: "rotate",
    task_id: "dx-2026-06-22-api-rot",
    from: "orchestrator",
    to: "api",
    subject: "please rotate now",
  };
  t = await send(client, ch, validRotate);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "worker-inbox: valid rotate accepted, no warn", t);

  // 4. Valid type:note
  const validNote = {
    type: "note",
    task_id: "dx-2026-06-22-api-note1",
    from: "orchestrator",
    to: "web",
    subject: "reminder: check staging env before deploy",
  };
  t = await send(client, ch, validNote);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "worker-inbox: valid note accepted, no warn", t);

  // 5. Valid type:approval-token with required body fields
  const validToken = {
    type: "approval-token",
    task_id: "dx-2026-06-22-db-tok",
    from: "orchestrator",
    to: "db",
    subject: "approve staging migration",
    body: {
      authorized_actions: ["migrate:staging"],
      env: "staging",
      scope_workers: ["db"],
      expires_at: "2026-06-22T23:59:59Z",
    },
  };
  t = await send(client, ch, validToken);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "worker-inbox: valid approval-token accepted, no warn", t);

  // approval-token with NO body at all → warn (v1.1: body now required)
  const bodylessTokendx_2026_07_07_wi_tok_nobody = { ...validToken, task_id: "dx-2026-07-07-wi-tok-nobody" };
  delete bodylessTokendx_2026_07_07_wi_tok_nobody.body;
  t = await send(client, ch, bodylessTokendx_2026_07_07_wi_tok_nobody);
  expect(/WARN/.test(t), "worker-inbox: bodyless approval-token → warn (body required)", t);

  // 6. type:contract-change without wire_compat → warn
  const contractNoCompat = {
    type: "contract-change",
    task_id: "dx-2026-06-22-qa-cc1",
    from: "orchestrator",
    to: "qa",
    subject: "payment response shape changing",
    body: { before: {}, after: {} },
  };
  t = await send(client, ch, contractNoCompat);
  expect(/WARN/.test(t), "worker-inbox: contract-change without wire_compat → warn", t);

  // 7. Valid contract-change with wire_compat → no warn
  const validContract = { ...contractNoCompat, wire_compat: "additive" };
  t = await send(client, ch, validContract);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "worker-inbox: valid contract-change with wire_compat accepted", t);

  // 8. Missing required subject → warn
  const missingSubject = {
    type: "task",
    task_id: "dx-2026-06-22-api-ns",
    from: "orchestrator",
    to: "api",
    body: "do something",
  };
  t = await send(client, ch, missingSubject);
  expect(/WARN/.test(t), "worker-inbox: missing subject → warn in warn-only", t);

  // 9. Flip to strict; task_id failing pattern → rejected
  r = await registerSchema(client, ch, file, true);
  expect(/Registered schema/.test(r.content?.[0]?.text), "worker-inbox: schema re-registered strict");

  t = await send(client, ch, badTaskId);
  expect(/schema validation failed/.test(t), "worker-inbox strict: task_id failing pattern → rejected", t);

  // 10. Strict: valid task accepted
  t = await send(client, ch, validTask);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "worker-inbox strict: valid task accepted", t);

  await clearSchema(client, ch);
}

// ─── setup-schemas-dollex.js idempotent re-run ───────────────────────────────

async function testSetupIdempotency() {
  console.log("\n── setup-schemas-dollex.js idempotency ──");
  const { execSync } = await import("child_process");
  let output, exitCode;
  try {
    output = execSync(`"${process.execPath}" setup-schemas-dollex.js`, { encoding: "utf-8", env: process.env });
    exitCode = 0;
  } catch (e) {
    output = e.stdout + e.stderr;
    exitCode = e.status ?? 1;
  }
  expect(exitCode === 0, "setup-schemas-dollex.js: first run exits 0", output);
  expect(/dx-api/.test(output), "setup-schemas-dollex.js: dx-api registered", output);
  expect(/dx-web/.test(output), "setup-schemas-dollex.js: dx-web registered", output);
  expect(/dx-db/.test(output), "setup-schemas-dollex.js: dx-db registered", output);
  expect(/dx-qa/.test(output), "setup-schemas-dollex.js: dx-qa registered", output);
  expect(/dx-status/.test(output), "setup-schemas-dollex.js: dx-status registered", output);
  expect(/dx-control/.test(output), "setup-schemas-dollex.js: dx-control registered", output);
  expect(/dx-telemetry/.test(output), "setup-schemas-dollex.js: dx-telemetry registered", output);
  expect(/dx-backlog/.test(output), "setup-schemas-dollex.js: dx-backlog registered", output);

  // Second run — must also exit 0 (idempotent)
  try {
    output = execSync(`"${process.execPath}" setup-schemas-dollex.js`, { encoding: "utf-8", env: process.env });
    exitCode = 0;
  } catch (e) {
    output = e.stdout + e.stderr;
    exitCode = e.status ?? 1;
  }
  expect(exitCode === 0, "setup-schemas-dollex.js: second run (idempotent re-run) exits 0", output);
  expect(!/ERROR/.test(output), "setup-schemas-dollex.js: no ERROR on second run", output);
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[test-schema-dx]  broker=${BROKER_URL}  run=${RUN_TAG}`);
  const { client, transport } = await connect("test-schema-dx");

  await testBacklog(client);
  await testControl(client);
  await testStatus(client);
  await testTelemetry(client);
  await testWorkerInbox(client);

  await transport.close();

  await testSetupIdempotency();

  console.log(`\n──────────────────────────────────────────────────────`);
  console.log(`[test-schema-dx]  passed=${passed}  failed=${failed}`);
  if (failed === 0) console.log("  ALL TESTS PASSED");
  else { console.error("  SOME TESTS FAILED"); process.exitCode = 1; }
}

main().catch(e => { console.error("[test-schema-dx] FATAL:", e); process.exit(1); });
