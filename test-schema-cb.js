// Schema validation tests for cb-namespace channels.
// Exercises all 6 cb-* channel schemas against a live broker.
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
    arguments: { channel, sender: "test-cb-schema", content: JSON.stringify(content) },
  });
  return r.content?.[0]?.text ?? "";
}

async function registerSchema(client, channel, file, strict, version) {
  const schema = readFileSync(file, "utf-8");
  const args = { channel, schema, strict };
  if (version !== undefined) args.version = version;
  const r = await client.callTool({
    name: "register_channel_schema",
    arguments: args,
  });
  return r;
}

async function clearSchema(client, channel) {
  await client.callTool({ name: "clear_channel_schema", arguments: { channel } });
  await client.callTool({ name: "purge_channel", arguments: { channel } });
}

// ─── cb-worker-inbox ────────────────────────────────────────────────────────

async function testWorkerInbox(client) {
  console.log("\n── cb-worker-inbox (used by cb-core and cb-protocol-qa) ──");
  const ch = `cb-wi-test-${RUN_TAG}`;
  const file = "schemas/cb-worker-inbox.json";

  let r = await registerSchema(client, ch, file, false);
  expect(/Registered schema/.test(r.content?.[0]?.text), "worker-inbox: schema registered warn-only");

  // 1. Valid task envelope
  const validTask = {
    type: "task",
    task_id: "cb-2026-06-19-test-wi-001",
    from: "orchestrator",
    to: "protocol-qa",
    subject: "run test suite",
    body: "run node test-v2.js",
    depends_on: [],
    required_checks: ["test"],
  };
  let t = await send(client, ch, validTask);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "worker-inbox: valid task accepted, no warn", t);

  // 2. Valid rotate envelope
  const validRotate = {
    type: "rotate",
    task_id: "cb-2026-06-19-test-wi-rot",
    from: "orchestrator",
    to: "protocol-qa",
    subject: "please rotate",
  };
  t = await send(client, ch, validRotate);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "worker-inbox: valid rotate accepted, no warn", t);

  // 3. Missing required field (task_id) → warn in warn-only
  const missingTaskId = { type: "task", from: "orchestrator", to: "core", subject: "no task_id here" };
  t = await send(client, ch, missingTaskId);
  expect(/WARN/.test(t), "worker-inbox: missing task_id → warn in warn-only mode", t);
  expect(/Sent #/.test(t), "worker-inbox: missing task_id still stored in warn-only", t);

  // 4. Missing subject → warn
  const missingSubject = { type: "task", task_id: "cb-2026-06-19-wi-nosub", from: "orchestrator", to: "core" };
  t = await send(client, ch, missingSubject);
  expect(/WARN/.test(t), "worker-inbox: missing subject → warn in warn-only mode", t);

  // 5. Unknown type → warn (enum violation)
  const unknownType = { type: "unknown-type", task_id: "cb-2026-06-19-wi-unk", from: "orchestrator", to: "core", subject: "bad type" };
  t = await send(client, ch, unknownType);
  expect(/WARN/.test(t), "worker-inbox: unknown type → warn in warn-only mode", t);

  // 6. approval-token requires body fields — missing body → warn
  const tokenMissingBody = { type: "approval-token", task_id: "cb-2026-06-19-wi-tok", from: "orchestrator", to: "core", subject: "approve this" };
  t = await send(client, ch, tokenMissingBody);
  expect(/WARN/.test(t), "worker-inbox: approval-token missing body → warn", t);

  // 7. approval-token (removed from enum) → warn even with full body
  const validToken = {
    type: "approval-token",
    task_id: "cb-2026-06-19-wi-tok-ok",
    from: "orchestrator",
    to: "core",
    subject: "approve deploy",
    body: {
      authorized_actions: ["deploy:staging"],
      env: "staging",
      scope_workers: ["core"],
      expires_at: "2026-06-19T23:59:59Z",
    },
  };
  t = await send(client, ch, validToken);
  expect(/WARN/.test(t), "worker-inbox: approval-token (removed from enum) → warn", t);

  // 8. task_id 'abc' (no date pattern) → warn
  const badTaskId = { type: "note", task_id: "abc", from: "orchestrator", to: "core", subject: "bad task_id pattern" };
  t = await send(client, ch, badTaskId);
  expect(/WARN/.test(t), "worker-inbox: task_id 'abc' (no date pattern) → warn", t);

  // 9. type:task missing body → warn
  const taskNoBody = { type: "task", task_id: "cb-2026-06-19-wi-nobody", from: "orchestrator", to: "core", subject: "task without body" };
  t = await send(client, ch, taskNoBody);
  expect(/WARN/.test(t), "worker-inbox: type:task missing body → warn", t);

  // 10. task with acceptance_criteria → accepted, no warn
  const taskWithCriteria = {
    type: "task",
    task_id: "cb-2026-06-20-wi-ac1",
    from: "orchestrator",
    to: "core",
    subject: "implement feature with criteria",
    body: "do the thing\n\nAcceptance criteria:\n- [ ] feature works\n- [ ] committed",
    acceptance_criteria: ["feature works", "committed"],
    required_checks: ["test", "committed"],
  };
  t = await send(client, ch, taskWithCriteria);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "worker-inbox: task with acceptance_criteria accepted, no warn", t);

  // 11. task without acceptance_criteria still accepted (field is optional)
  const taskNoCriteria = {
    type: "task",
    task_id: "cb-2026-06-20-wi-ac2",
    from: "orchestrator",
    to: "protocol-qa",
    subject: "baseline run",
    body: "run node test-v2.js",
  };
  t = await send(client, ch, taskNoCriteria);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "worker-inbox: task without acceptance_criteria still accepted (optional)", t);

  // 12. acceptance_criteria with non-string items → warn
  const taskBadCriteria = {
    type: "task",
    task_id: "cb-2026-06-20-wi-ac3",
    from: "orchestrator",
    to: "core",
    subject: "bad criteria type",
    body: "instructions",
    acceptance_criteria: [{ step: "not a string" }],
  };
  t = await send(client, ch, taskBadCriteria);
  expect(/WARN/.test(t), "worker-inbox: acceptance_criteria with non-string items → warn", t);

  // 13-new-a. Valid task WITH all three new fields (context, files, checks) → should PASS
  const taskWithNewFields = {
    type: "task",
    task_id: "cb-2026-06-22-wi-new-a",
    from: "orchestrator",
    to: "core",
    subject: "task with context files and checks",
    body: "do the work",
    context: "Adding new optional fields to support richer task dispatch.",
    files: { read: ["schemas/cb-worker-inbox.json"], write: ["test-schema-cb.js"] },
    checks: [{ name: "tests pass", run: "node test-v2.js", pass_condition: "ALL TESTS PASSED" }],
  };
  t = await send(client, ch, taskWithNewFields);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "worker-inbox new-a: task with context+files+checks accepted, no warn", t);

  // 13-new-b. Valid task WITHOUT new fields → backward compat, should still PASS
  const taskWithoutNewFields = {
    type: "task",
    task_id: "cb-2026-06-22-wi-new-b",
    from: "orchestrator",
    to: "protocol-qa",
    subject: "plain task no new fields",
    body: "run tests",
  };
  t = await send(client, ch, taskWithoutNewFields);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "worker-inbox new-b: task without new fields still accepted (backward compat)", t);

  // 13-new-c. checks item missing pass_condition → WARN (schema violation)
  const taskChecksMissingPassCond = {
    type: "task",
    task_id: "cb-2026-06-22-wi-new-c",
    from: "orchestrator",
    to: "core",
    subject: "checks without pass_condition",
    body: "do thing",
    checks: [{ name: "run tests", run: "node test-v2.js" }],
  };
  t = await send(client, ch, taskChecksMissingPassCond);
  expect(/WARN/.test(t), "worker-inbox new-c: checks item missing pass_condition → warn in warn-only", t);

  // 13-new-d. files with extra property beyond read/write → WARN
  const taskFilesExtraProp = {
    type: "task",
    task_id: "cb-2026-06-22-wi-new-d",
    from: "orchestrator",
    to: "core",
    subject: "files with extra property",
    body: "do thing",
    files: { read: [], write: [], delete: ["old-file.js"] },
  };
  t = await send(client, ch, taskFilesExtraProp);
  expect(/WARN/.test(t), "worker-inbox new-d: files with extra property → warn in warn-only", t);

  // 13-new-e. context set to empty string → WARN (minLength:1)
  const taskEmptyContext = {
    type: "task",
    task_id: "cb-2026-06-22-wi-new-e",
    from: "orchestrator",
    to: "core",
    subject: "empty context string",
    body: "do thing",
    context: "",
  };
  t = await send(client, ch, taskEmptyContext);
  expect(/WARN/.test(t), "worker-inbox new-e: context set to empty string → warn (minLength:1)", t);

  // 13. Flip to strict; missing task_id rejected
  r = await registerSchema(client, ch, file, true);
  expect(/Registered schema/.test(r.content?.[0]?.text), "worker-inbox: schema re-registered strict");

  t = await send(client, ch, missingTaskId);
  expect(/schema validation failed/.test(t), "worker-inbox strict: missing task_id rejected", t);

  // 14. strict: task with acceptance_criteria still accepted
  t = await send(client, ch, taskWithCriteria);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "worker-inbox strict: task with acceptance_criteria accepted", t);

  // 15. Valid task still accepted in strict
  t = await send(client, ch, validTask);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "worker-inbox strict: valid task accepted", t);

  await clearSchema(client, ch);
}

// ─── cb-orchestrator-inbox ──────────────────────────────────────────────────

async function testOrchestratorInbox(client) {
  console.log("\n── cb-orchestrator-inbox ──");
  const ch = `cb-oi-test-${RUN_TAG}`;
  const file = "schemas/cb-orchestrator-inbox.json";

  let r = await registerSchema(client, ch, file, false);
  expect(/Registered schema/.test(r.content?.[0]?.text), "orch-inbox: schema registered warn-only");

  // 1. Valid question
  const validQuestion = {
    type: "question",
    task_id: "cb-2026-06-19-oi-q1",
    from: "core",
    to: "orchestrator",
    subject: "should I wipe the channel?",
    body: { question: "Confirm before purge?" },
  };
  let t = await send(client, ch, validQuestion);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "orch-inbox: valid question accepted, no warn", t);

  // 2. Valid note
  const validNote = {
    type: "note",
    task_id: "cb-2026-06-19-oi-n1",
    from: "protocol-qa",
    to: "orchestrator",
    subject: "baseline complete",
  };
  t = await send(client, ch, validNote);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "orch-inbox: valid note accepted, no warn", t);

  // 3. Missing task_id → warn
  const missingTaskId = { type: "note", from: "core", to: "orchestrator", subject: "no id" };
  t = await send(client, ch, missingTaskId);
  expect(/WARN/.test(t), "orch-inbox: missing task_id → warn in warn-only", t);

  // 4. Unknown type → warn
  const unknownType = { type: "task", task_id: "cb-2026-06-19-oi-unk", from: "core", to: "orchestrator", subject: "workers don't send tasks here" };
  t = await send(client, ch, unknownType);
  expect(/WARN/.test(t), "orch-inbox: type:task (not allowed) → warn", t);

  // 5. type:result (removed from enum) → warn
  const typeResult = { type: "result", task_id: "cb-2026-06-19-oi-res", from: "core", to: "orchestrator", subject: "result not allowed in orchestrator-inbox" };
  t = await send(client, ch, typeResult);
  expect(/WARN/.test(t), "orch-inbox: type:result (removed from enum) → warn", t);

  // 6. Strict: missing task_id rejected
  r = await registerSchema(client, ch, file, true);
  expect(/Registered schema/.test(r.content?.[0]?.text), "orch-inbox: schema re-registered strict");

  t = await send(client, ch, missingTaskId);
  expect(/schema validation failed/.test(t), "orch-inbox strict: missing task_id rejected", t);

  // 6. Valid under strict
  t = await send(client, ch, validQuestion);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "orch-inbox strict: valid question accepted", t);

  await clearSchema(client, ch);
}

// ─── cb-control ─────────────────────────────────────────────────────────────

async function testControl(client) {
  console.log("\n── cb-control ──");
  const ch = `cb-ctrl-test-${RUN_TAG}`;
  const file = "schemas/cb-control.json";

  let r = await registerSchema(client, ch, file, false);
  expect(/Registered schema/.test(r.content?.[0]?.text), "control: schema registered warn-only");

  // 1. Valid sprint-start
  const validSprint = {
    type: "sprint-start",
    task_id: "cb-2026-06-19-ctrl-sp1",
    sprint_id: "cb-sprint-test-001",
    from: "orchestrator",
    to: "*",
    subject: "Sprint 1 — test run",
    body: { goal: "validate schemas" },
  };
  let t = await send(client, ch, validSprint);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "control: valid sprint-start accepted, no warn", t);

  // 2. Valid rotate
  const validRotate = { type: "rotate", task_id: "cb-2026-06-19-ctrl-rot", from: "orchestrator", to: "protocol-qa", subject: "rotate now" };
  t = await send(client, ch, validRotate);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "control: valid rotate accepted, no warn", t);

  // 3. Missing 'from' → warn
  const missingFrom = { type: "note", to: "*", subject: "no from field" };
  t = await send(client, ch, missingFrom);
  expect(/WARN/.test(t), "control: missing from → warn in warn-only", t);

  // 4. Missing subject → warn
  const missingSubject = { type: "note", from: "orchestrator", to: "*" };
  t = await send(client, ch, missingSubject);
  expect(/WARN/.test(t), "control: missing subject → warn in warn-only", t);

  // 5. Unknown type → warn
  const unknownType = { type: "task", from: "orchestrator", to: "*", subject: "dispatching via control (wrong)" };
  t = await send(client, ch, unknownType);
  expect(/WARN/.test(t), "control: unknown type:task → warn (not in control enum)", t);

  // 6. Valid approval-revoke with revokes_msg_id
  const validRevoke = {
    type: "approval-revoke",
    task_id: "cb-2026-06-19-ctrl-rev",
    from: "orchestrator",
    to: "*",
    subject: "token revoked",
    body: { revokes_msg_id: 12345 },
  };
  t = await send(client, ch, validRevoke);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "control: valid approval-revoke accepted", t);

  // 7. Missing task_id → warn (task_id now required)
  const missingTaskId = { type: "note", from: "orchestrator", to: "*", subject: "no task_id here" };
  t = await send(client, ch, missingTaskId);
  expect(/WARN/.test(t), "control: missing task_id → warn in warn-only", t);

  // 8. sprint-start without sprint_id → warn
  const sprintNoId = { type: "sprint-start", task_id: "cb-2026-06-19-ctrl-sp2", from: "orchestrator", to: "*", subject: "sprint without sprint_id" };
  t = await send(client, ch, sprintNoId);
  expect(/WARN/.test(t), "control: sprint-start without sprint_id → warn", t);

  // 9. Strict: missing subject rejected
  r = await registerSchema(client, ch, file, true);
  expect(/Registered schema/.test(r.content?.[0]?.text), "control: schema re-registered strict");

  t = await send(client, ch, missingSubject);
  expect(/schema validation failed/.test(t), "control strict: missing subject rejected", t);

  // 8. Valid under strict
  t = await send(client, ch, validSprint);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "control strict: valid sprint-start accepted", t);

  await clearSchema(client, ch);
}

// ─── cb-status ──────────────────────────────────────────────────────────────

async function testStatus(client) {
  console.log("\n── cb-status ──");
  const ch = `cb-st-test-${RUN_TAG}`;
  const file = "schemas/cb-status.json";

  let r = await registerSchema(client, ch, file, false);
  expect(/Registered schema/.test(r.content?.[0]?.text), "status: schema registered warn-only");

  // 1. Valid status update
  const validStatus = {
    type: "status",
    task_id: "cb-2026-06-19-st-001",
    from: "protocol-qa",
    to: "orchestrator",
    subject: "running tests",
    body: { state: "working" },
  };
  let t = await send(client, ch, validStatus);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "status: valid type:status accepted, no warn", t);

  // 2. Valid result with summary + consent_basis
  const validResult = {
    type: "result",
    task_id: "cb-2026-06-19-st-r01",
    from: "protocol-qa",
    to: "orchestrator",
    subject: "schema tests done",
    summary: "PASS — all cb-* schema validation tests pass",
    body: { consent_basis: "orchestrator-dispatch-only" },
  };
  t = await send(client, ch, validResult);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "status: valid type:result accepted, no warn", t);

  // 3. type:result without summary → warn
  const resultNoSummary = {
    type: "result",
    task_id: "cb-2026-06-19-st-r02",
    from: "core",
    to: "orchestrator",
    subject: "done",
    body: { consent_basis: "orchestrator-dispatch-only" },
  };
  t = await send(client, ch, resultNoSummary);
  expect(/WARN/.test(t), "status: type:result without summary → warn in warn-only", t);
  expect(/Sent #/.test(t), "status: type:result without summary still stored in warn-only", t);

  // 4. type:result without consent_basis → accepted (consent_basis is optional)
  const resultNoConsent = {
    type: "result",
    task_id: "cb-2026-06-19-st-r03",
    from: "core",
    to: "orchestrator",
    subject: "done",
    summary: "PASS — something",
    body: {},
  };
  t = await send(client, ch, resultNoConsent);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "status: type:result without consent_basis → accepted (optional)", t);

  // 5. type:result with commits but no affected_files → warn (v1.1 conditional)
  const resultNoAffected = {
    type: "result",
    task_id: "cb-2026-06-19-st-r04",
    from: "protocol-qa",
    to: "orchestrator",
    subject: "committed",
    summary: "PASS — committed changes",
    body: {
      consent_basis: "orchestrator-dispatch-only",
      commits: [{ sha: "abc1234", branch: "main", message: "add schemas" }],
    },
  };
  t = await send(client, ch, resultNoAffected);
  expect(/WARN/.test(t), "status: type:result with commits but no affected_files → warn", t);

  // 5a. type:result production_touching=true without consent_basis → warn (v1.1 conditional)
  const resultProdNoConsent = {
    type: "result",
    task_id: "cb-2026-06-19-st-r04a",
    from: "core",
    to: "orchestrator",
    subject: "restarted broker",
    summary: "PASS — broker restarted",
    body: { production_touching: true },
  };
  t = await send(client, ch, resultProdNoConsent);
  expect(/WARN/.test(t), "status: type:result production_touching=true without consent_basis → warn", t);

  // 5b. type:result production_touching=true with consent_basis → no warn
  const resultProdWithConsent = {
    ...resultProdNoConsent,
    task_id: "cb-2026-06-19-st-r04b",
    body: { production_touching: true, consent_basis: "approval-token:#41925" },
  };
  t = await send(client, ch, resultProdWithConsent);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "status: type:result production_touching=true with consent_basis accepted", t);

  // 6. type:result with commits AND affected_files → no warn
  const resultWithAffected = {
    type: "result",
    task_id: "cb-2026-06-19-st-r05",
    from: "protocol-qa",
    to: "orchestrator",
    subject: "committed",
    summary: "PASS — committed changes",
    affected_files: ["schemas/cb-status.json"],
    body: {
      consent_basis: "orchestrator-dispatch-only",
      commits: [{ sha: "abc1234", branch: "main", message: "add schemas" }],
    },
  };
  t = await send(client, ch, resultWithAffected);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "status: type:result with commits + affected_files accepted, no warn", t);

  // 7. Missing task_id → warn
  const missingTaskId = { type: "status", from: "core", to: "orchestrator", subject: "no id" };
  t = await send(client, ch, missingTaskId);
  expect(/WARN/.test(t), "status: missing task_id → warn in warn-only", t);

  // 8. Strict: type:result without summary → rejected
  r = await registerSchema(client, ch, file, true);
  expect(/Registered schema/.test(r.content?.[0]?.text), "status: schema re-registered strict");

  t = await send(client, ch, resultNoSummary);
  expect(/schema validation failed/.test(t), "status strict: type:result without summary → rejected", t);

  // 9. Strict: type:result without consent_basis → accepted (consent_basis is optional)
  t = await send(client, ch, resultNoConsent);
  expect(/Sent #/.test(t) && !/schema validation failed/.test(t), "status strict: type:result without consent_basis → accepted (optional)", t);

  // 10. Strict: type:status without summary passes (summary only required on result)
  t = await send(client, ch, validStatus);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "status strict: type:status without summary accepted", t);

  // 11. Strict: valid result accepted
  t = await send(client, ch, validResult);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "status strict: valid type:result accepted", t);

  await clearSchema(client, ch);
}

// ─── cb-telemetry ───────────────────────────────────────────────────────────

async function testTelemetry(client) {
  console.log("\n── cb-telemetry ──");
  const ch = `cb-tel-test-${RUN_TAG}`;
  const file = "schemas/cb-telemetry.json";

  let r = await registerSchema(client, ch, file, false);
  expect(/Registered schema/.test(r.content?.[0]?.text), "telemetry: schema registered warn-only");

  // 1. Valid heartbeat
  const validHB = {
    type: "heartbeat",
    from: "protocol-qa",
    ts: "2026-06-19T15:30:00Z",
    session_id: "sess-abc123",
    model: "claude-sonnet-4-6",
    context: { size_tokens: 45000, tier_threshold_pct: 30.0, rotation_recommended: false },
    activity: { state: "working", current_task_id: "cb-2026-06-19-st-001" },
  };
  let t = await send(client, ch, validHB);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "telemetry: valid heartbeat accepted, no warn", t);

  // 2. All activity states accepted
  for (const state of ["idle-polling", "idle-exit", "blocked-on-question", "rotating", "session-end", "reviewing", "coverage-patrol"]) {
    const hb = { ...validHB, activity: { state } };
    t = await send(client, ch, hb);
    expect(/Sent #/.test(t) && !/WARN/.test(t), `telemetry: state="${state}" accepted`, t);
  }

  // exit_code allowed top-level on session-end heartbeats (v1.1)
  const withExitCode = { ...validHB, activity: { state: "session-end" }, exit_code: 0 };
  t = await send(client, ch, withExitCode);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "telemetry: session-end heartbeat with exit_code accepted", t);

  // 3. Invalid state → warn
  const badState = { ...validHB, activity: { state: "undefined-state" } };
  t = await send(client, ch, badState);
  expect(/WARN/.test(t), "telemetry: unknown state → warn in warn-only", t);

  // 4. Missing context → warn
  const missingContext = { type: "heartbeat", from: "core", ts: "2026-06-19T15:31:00Z", activity: { state: "working" } };
  t = await send(client, ch, missingContext);
  expect(/WARN/.test(t), "telemetry: missing context → warn in warn-only", t);

  // 5. Missing activity → warn
  const missingActivity = {
    type: "heartbeat", from: "core", ts: "2026-06-19T15:32:00Z",
    context: { size_tokens: 1000, tier_threshold_pct: 10.0, rotation_recommended: false },
  };
  t = await send(client, ch, missingActivity);
  expect(/WARN/.test(t), "telemetry: missing activity → warn in warn-only", t);

  // 6. Wrong type (not 'heartbeat') → warn
  const wrongType = { ...validHB, type: "status" };
  t = await send(client, ch, wrongType);
  expect(/WARN/.test(t), "telemetry: type:status (not heartbeat) → warn", t);

  // 7. Strict: invalid state → rejected
  r = await registerSchema(client, ch, file, true);
  expect(/Registered schema/.test(r.content?.[0]?.text), "telemetry: schema re-registered strict");

  t = await send(client, ch, badState);
  expect(/schema validation failed/.test(t), "telemetry strict: unknown state → rejected", t);

  // 8. Strict: valid heartbeat accepted
  t = await send(client, ch, validHB);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "telemetry strict: valid heartbeat accepted", t);

  await clearSchema(client, ch);
}

// ─── cb-backlog ──────────────────────────────────────────────────────────────

async function testBacklog(client) {
  console.log("\n── cb-backlog ──");
  const ch = `cb-bl-test-${RUN_TAG}`;
  const file = "schemas/cb-backlog.json";

  let r = await registerSchema(client, ch, file, false);
  expect(/Registered schema/.test(r.content?.[0]?.text), "backlog: schema registered warn-only");

  // 1. Valid deferred with deferred_reason → no warn
  const validDeferred = {
    type: "deferred",
    task_id: "cb-2026-06-19-bl-001",
    subject: "add cb-backlog schema coverage",
    from: "protocol-qa",
    deferred_reason: "too many open tasks in current sprint",
  };
  let t = await send(client, ch, validDeferred);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "backlog: valid deferred accepted, no warn", t);

  // 2. type:deferred without deferred_reason → warn
  const deferredNoReason = {
    type: "deferred",
    task_id: "cb-2026-06-19-bl-002",
    subject: "no deferred_reason",
    from: "core",
  };
  t = await send(client, ch, deferredNoReason);
  expect(/WARN/.test(t), "backlog: type:deferred without deferred_reason → warn", t);
  expect(/Sent #/.test(t), "backlog: type:deferred without deferred_reason still stored in warn-only", t);

  // 3. Strict: deferred without deferred_reason → rejected
  r = await registerSchema(client, ch, file, true);
  expect(/Registered schema/.test(r.content?.[0]?.text), "backlog: schema re-registered strict");

  t = await send(client, ch, deferredNoReason);
  expect(/schema validation failed/.test(t), "backlog strict: deferred without deferred_reason → rejected", t);

  // 4. Strict: valid deferred accepted
  t = await send(client, ch, validDeferred);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "backlog strict: valid deferred accepted", t);

  await clearSchema(client, ch);
}

// ─── schema versioning ───────────────────────────────────────────────────────

async function testSchemaVersioning(client) {
  console.log("\n── schema versioning ──");
  const file = "schemas/cb-worker-inbox.json";
  const ch1 = `cb-ver1-test-${RUN_TAG}`;
  const ch2 = `cb-ver2-test-${RUN_TAG}`;
  let r;

  // register with version: '1.0' → response and get_channel_schema both show version
  r = await registerSchema(client, ch1, file, false, "1.0");
  expect(/version=1\.0/.test(r.content?.[0]?.text ?? ""), "versioning: register with version='1.0' confirmed in response", r.content?.[0]?.text);

  r = await client.callTool({ name: "get_channel_schema", arguments: { channel: ch1 } });
  expect(/Version: 1\.0/.test(r.content?.[0]?.text ?? ""), "versioning: get_channel_schema returns Version: 1.0", r.content?.[0]?.text?.split("\n")?.[2]);

  // register without version → no Version line in get_channel_schema
  r = await registerSchema(client, ch2, file, false);
  r = await client.callTool({ name: "get_channel_schema", arguments: { channel: ch2 } });
  expect(!/Version:/.test(r.content?.[0]?.text ?? ""), "versioning: register without version → no Version line in output", r.content?.[0]?.text?.split("\n")?.[2]);

  await clearSchema(client, ch1);
  await clearSchema(client, ch2);
}

// ─── setup-schemas-broker.js idempotent re-run ──────────────────────────────

async function testSetupIdempotency() {
  console.log("\n── setup-schemas-broker.js idempotency ──");
  const { execSync } = await import("child_process");
  let output, exitCode;
  try {
    output = execSync(`"${process.execPath}" setup-schemas-broker.js`, { encoding: "utf-8", env: process.env });
    exitCode = 0;
  } catch (e) {
    output = e.stdout + e.stderr;
    exitCode = e.status ?? 1;
  }
  expect(exitCode === 0, "setup-schemas-broker.js: first run exits 0", output);
  expect(/✓ cb-core/.test(output), "setup-schemas-broker.js: cb-core registered", output);
  expect(/✓ cb-protocol-qa/.test(output), "setup-schemas-broker.js: cb-protocol-qa registered", output);
  expect(/✓ cb-orchestrator/.test(output), "setup-schemas-broker.js: cb-orchestrator registered", output);
  expect(/✓ cb-control/.test(output), "setup-schemas-broker.js: cb-control registered", output);
  expect(/✓ cb-status/.test(output), "setup-schemas-broker.js: cb-status registered", output);
  expect(/✓ cb-telemetry/.test(output), "setup-schemas-broker.js: cb-telemetry registered", output);

  // Second run — must also exit 0 (idempotent)
  try {
    output = execSync(`"${process.execPath}" setup-schemas-broker.js`, { encoding: "utf-8", env: process.env });
    exitCode = 0;
  } catch (e) {
    output = e.stdout + e.stderr;
    exitCode = e.status ?? 1;
  }
  expect(exitCode === 0, "setup-schemas-broker.js: second run (idempotent re-run) exits 0", output);
  expect(!/ERROR/.test(output), "setup-schemas-broker.js: no ERROR on second run", output);
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[test-schema-cb]  broker=${BROKER_URL}  run=${RUN_TAG}`);
  const { client, transport } = await connect("test-schema-cb");

  await testWorkerInbox(client);
  await testOrchestratorInbox(client);
  await testControl(client);
  await testStatus(client);
  await testTelemetry(client);
  await testBacklog(client);
  await testSchemaVersioning(client);

  await transport.close();

  await testSetupIdempotency();

  console.log(`\n──────────────────────────────────────────────────────`);
  console.log(`[test-schema-cb]  passed=${passed}  failed=${failed}`);
  if (failed === 0) console.log("  ALL TESTS PASSED");
  else { console.error("  SOME TESTS FAILED"); process.exitCode = 1; }
}

main().catch(e => { console.error("[test-schema-cb] FATAL:", e); process.exit(1); });
