// Schema validation tests for sm-namespace channels.
// Exercises all sm-* channel schemas against a live broker.
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
    arguments: { channel, sender: "test-sm-schema", content: JSON.stringify(content) },
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

// ─── sm-worker-inbox ─────────────────────────────────────────────────────────
// Shared by: sm-contracts, sm-backend, sm-web

async function testWorkerInbox(client) {
  console.log("\n── sm-worker-inbox (sm-contracts / sm-backend / sm-web) ──");
  const ch = `sm-wi-test-${RUN_TAG}`;
  const file = "schemas/sm-worker-inbox.json";

  let r = await registerSchema(client, ch, file, false);
  expect(/Registered schema/.test(r.content?.[0]?.text), "worker-inbox: schema registered warn-only");

  // 1. Valid task envelope
  const validTask = {
    type: "task",
    task_id: "sm-2026-06-22-test-wi-001",
    from: "orchestrator",
    to: "contracts",
    subject: "review partnership agreement",
    body: "review and approve the agreement",
    depends_on: [],
    required_checks: ["review"],
  };
  let t = await send(client, ch, validTask);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "worker-inbox: valid task accepted, no warn", t);

  // 2. Valid rotate envelope
  const validRotate = {
    type: "rotate",
    task_id: "sm-2026-06-22-test-wi-rot",
    from: "orchestrator",
    to: "backend",
    subject: "please rotate",
  };
  t = await send(client, ch, validRotate);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "worker-inbox: valid rotate accepted, no warn", t);

  // 3. Missing required field (task_id) → warn in warn-only
  const missingTaskId = { type: "task", from: "orchestrator", to: "web", subject: "no task_id" };
  t = await send(client, ch, missingTaskId);
  expect(/WARN/.test(t), "worker-inbox: missing task_id → warn in warn-only mode", t);
  expect(/Sent #/.test(t), "worker-inbox: missing task_id still stored in warn-only", t);

  // 4. Missing subject → warn
  const missingSubject = { type: "task", task_id: "sm-2026-06-22-wi-nosub", from: "orchestrator", to: "backend" };
  t = await send(client, ch, missingSubject);
  expect(/WARN/.test(t), "worker-inbox: missing subject → warn in warn-only mode", t);

  // 5. Unknown type → warn (enum violation)
  const unknownType = {
    type: "broadcast",
    task_id: "sm-2026-06-22-wi-unk",
    from: "orchestrator",
    to: "contracts",
    subject: "bad type",
  };
  t = await send(client, ch, unknownType);
  expect(/WARN/.test(t), "worker-inbox: unknown type → warn in warn-only mode", t);

  // 6. type:task missing body → warn
  const taskNoBody = {
    type: "task",
    task_id: "sm-2026-06-22-wi-nobody",
    from: "orchestrator",
    to: "backend",
    subject: "task without body",
  };
  t = await send(client, ch, taskNoBody);
  expect(/WARN/.test(t), "worker-inbox: type:task missing body → warn", t);

  // 7. Valid note envelope
  const validNote = {
    type: "note",
    task_id: "sm-2026-06-22-wi-note1",
    from: "orchestrator",
    to: "web",
    subject: "status update",
  };
  t = await send(client, ch, validNote);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "worker-inbox: valid note accepted, no warn", t);

  // 8. Valid question envelope
  const validQuestion = {
    type: "question",
    task_id: "sm-2026-06-22-wi-q1",
    from: "orchestrator",
    to: "contracts",
    subject: "should we accept this rate?",
  };
  t = await send(client, ch, validQuestion);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "worker-inbox: valid question accepted, no warn", t);

  // 9. task with acceptance_criteria → accepted, no warn
  const taskWithCriteria = {
    type: "task",
    task_id: "sm-2026-06-22-wi-ac1",
    from: "orchestrator",
    to: "contracts",
    subject: "audit compliance",
    body: "review contracts for compliance\n\nAcceptance criteria:\n- [ ] all contracts reviewed\n- [ ] report generated\n- [ ] committed",
    acceptance_criteria: ["all contracts reviewed", "report generated", "committed"],
    required_checks: ["review", "committed"],
  };
  t = await send(client, ch, taskWithCriteria);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "worker-inbox: task with acceptance_criteria accepted, no warn", t);

  // 10. task with context + files + checks (new fields) → accepted, no warn
  const taskWithNewFields = {
    type: "task",
    task_id: "sm-2026-06-22-wi-new-a",
    from: "orchestrator",
    to: "backend",
    subject: "implement payout processor",
    body: "add payout processing logic",
    context: "New envelope fields added in sprint-023: context, files, checks for enhanced task tracking.",
    files: { read: ["schemas/sm-worker-inbox.json"], write: ["test-schema-sm.js"] },
    checks: [{ name: "tests pass", run: "node test-schema-sm.js", pass_condition: "ALL TESTS PASSED" }],
  };
  t = await send(client, ch, taskWithNewFields);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "worker-inbox new-a: task with context+files+checks accepted, no warn", t);

  // 11. task without new fields → backward compat, should still PASS
  const taskWithoutNewFields = {
    type: "task",
    task_id: "sm-2026-06-22-wi-new-b",
    from: "orchestrator",
    to: "web",
    subject: "plain task no new fields",
    body: "run updates",
  };
  t = await send(client, ch, taskWithoutNewFields);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "worker-inbox new-b: task without new fields still accepted (backward compat)", t);

  // 12. checks item missing pass_condition → WARN (schema violation)
  const taskChecksMissingPassCond = {
    type: "task",
    task_id: "sm-2026-06-22-wi-new-c",
    from: "orchestrator",
    to: "contracts",
    subject: "checks without pass_condition",
    body: "do thing",
    checks: [{ name: "run tests", run: "node test-schema-sm.js" }],
  };
  t = await send(client, ch, taskChecksMissingPassCond);
  expect(/WARN/.test(t), "worker-inbox new-c: checks item missing pass_condition → warn in warn-only", t);

  // 13. files with extra property beyond read/write → WARN
  const taskFilesExtraProp = {
    type: "task",
    task_id: "sm-2026-06-22-wi-new-d",
    from: "orchestrator",
    to: "backend",
    subject: "files with extra property",
    body: "do thing",
    files: { read: [], write: [], execute: ["script.sh"] },
  };
  t = await send(client, ch, taskFilesExtraProp);
  expect(/WARN/.test(t), "worker-inbox new-d: files with extra property → warn in warn-only", t);

  // 14. context set to empty string → WARN (minLength:1)
  const taskEmptyContext = {
    type: "task",
    task_id: "sm-2026-06-22-wi-new-e",
    from: "orchestrator",
    to: "web",
    subject: "empty context string",
    body: "do thing",
    context: "",
  };
  t = await send(client, ch, taskEmptyContext);
  expect(/WARN/.test(t), "worker-inbox new-e: context set to empty string → warn (minLength:1)", t);

  // 15. Flip to strict; missing task_id → rejected
  r = await registerSchema(client, ch, file, true);
  expect(/Registered schema/.test(r.content?.[0]?.text), "worker-inbox: schema re-registered strict");

  t = await send(client, ch, missingTaskId);
  expect(/schema validation failed/.test(t), "worker-inbox strict: missing task_id rejected", t);

  // 16. strict: task with acceptance_criteria still accepted
  t = await send(client, ch, taskWithCriteria);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "worker-inbox strict: task with acceptance_criteria accepted", t);

  // 17. Valid task still accepted in strict
  t = await send(client, ch, validTask);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "worker-inbox strict: valid task accepted", t);

  // 18. strict: task with new fields still accepted
  t = await send(client, ch, taskWithNewFields);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "worker-inbox strict: task with new fields accepted", t);

  await clearSchema(client, ch);
}

// ─── sm-orchestrator-inbox ───────────────────────────────────────────────────

async function testOrchestratorInbox(client) {
  console.log("\n── sm-orchestrator-inbox ──");
  const ch = `sm-oi-test-${RUN_TAG}`;
  const file = "schemas/sm-orchestrator-inbox.json";

  let r = await registerSchema(client, ch, file, false);
  expect(/Registered schema/.test(r.content?.[0]?.text), "orch-inbox: schema registered warn-only");

  // 1. Valid type:question with task_id/from/to/subject
  const validQuestion = {
    type: "question",
    task_id: "sm-2026-06-22-oi-q1",
    from: "contracts",
    to: "orchestrator",
    subject: "should I accept this clause?",
    body: { context: "clause 7.3 looks unusual" },
  };
  let t = await send(client, ch, validQuestion);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "orch-inbox: valid type:question accepted, no warn", t);

  // 2. Valid type:note
  const validNote = {
    type: "note",
    task_id: "sm-2026-06-22-oi-n1",
    from: "backend",
    to: "orchestrator",
    subject: "baseline run complete, all clear",
  };
  t = await send(client, ch, validNote);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "orch-inbox: valid type:note accepted, no warn", t);

  // 3. Valid type:status
  const validStatus = {
    type: "status",
    task_id: "sm-2026-06-22-oi-s1",
    from: "web",
    to: "orchestrator",
    subject: "deployment started",
    body: { state: "in-progress" },
  };
  t = await send(client, ch, validStatus);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "orch-inbox: valid type:status accepted, no warn", t);

  // 4. Missing subject → warn
  const missingSubject = {
    type: "note",
    task_id: "sm-2026-06-22-oi-ns",
    from: "contracts",
    to: "orchestrator",
  };
  t = await send(client, ch, missingSubject);
  expect(/WARN/.test(t), "orch-inbox: missing subject → warn in warn-only", t);

  // 5. Unknown type (type:task not allowed) → warn
  const wrongType = {
    type: "task",
    task_id: "sm-2026-06-22-oi-unk",
    from: "backend",
    to: "orchestrator",
    subject: "workers cannot dispatch tasks to orchestrator-inbox",
  };
  t = await send(client, ch, wrongType);
  expect(/WARN/.test(t), "orch-inbox: unknown type:task → warn in warn-only", t);

  // 6. Flip to strict; missing subject → rejected
  r = await registerSchema(client, ch, file, true);
  expect(/Registered schema/.test(r.content?.[0]?.text), "orch-inbox: schema re-registered strict");

  t = await send(client, ch, missingSubject);
  expect(/schema validation failed/.test(t), "orch-inbox strict: missing subject rejected", t);

  // 7. Strict: valid question accepted
  t = await send(client, ch, validQuestion);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "orch-inbox strict: valid question accepted", t);

  await clearSchema(client, ch);
}

// ─── sm-status ────────────────────────────────────────────────────────────────

async function testStatus(client) {
  console.log("\n── sm-status ──");
  const ch = `sm-st-test-${RUN_TAG}`;
  const file = "schemas/sm-status.json";

  let r = await registerSchema(client, ch, file, false);
  expect(/Registered schema/.test(r.content?.[0]?.text), "status: schema registered warn-only");

  // 1. Valid type:result with summary
  const validResult = {
    type: "result",
    task_id: "sm-2026-06-22-st-r01",
    from: "contracts",
    to: "orchestrator",
    subject: "partnership agreement reviewed",
    summary: "PASS — all clauses reviewed and approved",
    body: { consent_basis: "orchestrator-dispatch-only" },
  };
  let t = await send(client, ch, validResult);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "status: valid type:result with summary accepted, no warn", t);

  // 2. type:result missing summary → warn (allOf conditional requires it)
  const resultNoSummary = {
    type: "result",
    task_id: "sm-2026-06-22-st-r02",
    from: "backend",
    to: "orchestrator",
    subject: "payout processor implemented",
    body: {},
  };
  t = await send(client, ch, resultNoSummary);
  expect(/WARN/.test(t), "status: type:result missing summary → warn in warn-only", t);
  expect(/Sent #/.test(t), "status: type:result missing summary still stored in warn-only", t);

  // 3. Valid type:question
  const validQuestion = {
    type: "question",
    task_id: "sm-2026-06-22-st-q01",
    from: "web",
    to: "orchestrator",
    subject: "should I skip the ledger migration?",
    body: { context: "migration looks risky" },
  };
  t = await send(client, ch, validQuestion);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "status: valid type:question accepted, no warn", t);

  // 4. Valid type:note
  const validNote = {
    type: "note",
    task_id: "sm-2026-06-22-st-n01",
    from: "contracts",
    to: "orchestrator",
    subject: "audit log updated",
  };
  t = await send(client, ch, validNote);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "status: valid type:note accepted, no warn", t);

  // 5. Valid type:handoff
  const validHandoff = {
    type: "handoff",
    task_id: "sm-2026-06-22-st-h01",
    from: "backend",
    to: "web",
    subject: "payout API ready for frontend integration",
    body: { api_endpoint: "/api/v1/payouts" },
  };
  t = await send(client, ch, validHandoff);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "status: valid type:handoff accepted, no warn", t);

  // 6. Missing task_id → warn
  const missingTaskId = { type: "status", from: "backend", to: "orchestrator", subject: "no id" };
  t = await send(client, ch, missingTaskId);
  expect(/WARN/.test(t), "status: missing task_id → warn in warn-only", t);

  // 6a. type:result with commits but no affected_files → warn (v1.1 conditional)
  const resultCommitsNoAffected = {
    type: "result",
    task_id: "sm-2026-07-07-st-inv1",
    from: "backend",
    to: "orchestrator",
    subject: "committed payout fix",
    summary: "PASS — payout fix committed",
    body: { commits: [{ sha: "abc1234", branch: "main", message: "fix payouts" }] },
  };
  t = await send(client, ch, resultCommitsNoAffected);
  expect(/WARN/.test(t), "status: type:result with commits but no affected_files → warn", t);

  // 6b. type:result with commits AND affected_files → no warn
  const resultCommitsWithAffected = { ...resultCommitsNoAffected, task_id: "sm-2026-07-07-st-inv2", affected_files: ["src/payouts.js"] };
  t = await send(client, ch, resultCommitsWithAffected);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "status: type:result with commits and affected_files accepted", t);

  // 6c. type:result production_touching=true without consent_basis → warn (v1.1 conditional)
  const resultProdNoConsent = {
    type: "result",
    task_id: "sm-2026-07-07-st-inv3",
    from: "backend",
    to: "orchestrator",
    subject: "deployed payout fix",
    summary: "PASS — deployed",
    body: { production_touching: true },
  };
  t = await send(client, ch, resultProdNoConsent);
  expect(/WARN/.test(t), "status: type:result production_touching=true without consent_basis → warn", t);

  // 6d. type:result production_touching=true with consent_basis → no warn
  const resultProdWithConsent = { ...resultProdNoConsent, task_id: "sm-2026-07-07-st-inv4", body: { production_touching: true, consent_basis: "terminal-human" } };
  t = await send(client, ch, resultProdWithConsent);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "status: type:result production_touching=true with consent_basis accepted", t);

  // 7. Flip to strict; type:result without summary → rejected
  r = await registerSchema(client, ch, file, true);
  expect(/Registered schema/.test(r.content?.[0]?.text), "status: schema re-registered strict");

  t = await send(client, ch, resultNoSummary);
  expect(/schema validation failed/.test(t), "status strict: type:result without summary → rejected", t);

  // 8. Strict: valid result accepted
  t = await send(client, ch, validResult);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "status strict: valid type:result with summary accepted", t);

  await clearSchema(client, ch);
}

// ─── sm-telemetry ─────────────────────────────────────────────────────────────

async function testTelemetry(client) {
  console.log("\n── sm-telemetry ──");
  const ch = `sm-tel-test-${RUN_TAG}`;
  const file = "schemas/sm-telemetry.json";

  let r = await registerSchema(client, ch, file, false);
  expect(/Registered schema/.test(r.content?.[0]?.text), "telemetry: schema registered warn-only");

  // 1. Valid heartbeat with all required fields
  const validHB = {
    type: "heartbeat",
    from: "backend",
    ts: "2026-06-22T10:00:00Z",
    session_id: "sess-sm-backend-001",
    model: "claude-sonnet-4-6",
    context: { size_tokens: 45000, tier_threshold_pct: 30.0, rotation_recommended: false },
    activity: { state: "working", current_task_id: "sm-2026-06-22-be-001" },
  };
  let t = await send(client, ch, validHB);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "telemetry: valid heartbeat accepted, no warn", t);

  // 2. All valid sm-telemetry activity states (includes idle-exit and session-end)
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
    from: "contracts",
    ts: "2026-06-22T10:01:00Z",
    context: { size_tokens: 20000, tier_threshold_pct: 15.0 },
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
    activity: { state: "idle-exit" },
  };
  t = await send(client, ch, missingFrom);
  expect(/WARN/.test(t), "telemetry: missing from field → warn", t);

  // 6. Flip to strict; unknown state → rejected
  r = await registerSchema(client, ch, file, true);
  expect(/Registered schema/.test(r.content?.[0]?.text), "telemetry: schema re-registered strict");

  t = await send(client, ch, badState);
  expect(/schema validation failed/.test(t), "telemetry strict: unknown state → rejected", t);

  // 7. Strict: valid heartbeat accepted
  t = await send(client, ch, validHB);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "telemetry strict: valid heartbeat accepted", t);

  await clearSchema(client, ch);
}

// ─── setup-schemas-sm.js idempotent re-run ──────────────────────────────

async function testSetupIdempotency() {
  console.log("\n── setup-schemas-sm.js idempotency ──");
  const { execSync } = await import("child_process");
  let output, exitCode;
  try {
    output = execSync(`"${process.execPath}" setup-schemas-sm.js`, { encoding: "utf-8", env: process.env });
    exitCode = 0;
  } catch (e) {
    output = e.stdout + e.stderr;
    exitCode = e.status ?? 1;
  }
  expect(exitCode === 0, "setup-schemas-sm.js: first run exits 0", output);
  expect(/sm-contracts/.test(output), "setup-schemas-sm.js: sm-contracts registered", output);
  expect(/sm-backend/.test(output), "setup-schemas-sm.js: sm-backend registered", output);
  expect(/sm-web/.test(output), "setup-schemas-sm.js: sm-web registered", output);

  // Second run — must also exit 0 (idempotent)
  try {
    output = execSync(`"${process.execPath}" setup-schemas-sm.js`, { encoding: "utf-8", env: process.env });
    exitCode = 0;
  } catch (e) {
    output = e.stdout + e.stderr;
    exitCode = e.status ?? 1;
  }
  expect(exitCode === 0, "setup-schemas-sm.js: second run (idempotent re-run) exits 0", output);
  expect(!/ERROR/.test(output), "setup-schemas-sm.js: no ERROR on second run", output);
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[test-schema-sm]  broker=${BROKER_URL}  run=${RUN_TAG}`);
  const { client, transport } = await connect("test-schema-sm");

  await testWorkerInbox(client);
  await testOrchestratorInbox(client);
  await testStatus(client);
  await testTelemetry(client);

  await transport.close();

  await testSetupIdempotency();

  console.log(`\n──────────────────────────────────────────────────────`);
  console.log(`[test-schema-sm]  passed=${passed}  failed=${failed}`);
  if (failed === 0) console.log("  ALL TESTS PASSED");
  else { console.error("  SOME TESTS FAILED"); process.exitCode = 1; }
}

main().catch(e => { console.error("[test-schema-sm] FATAL:", e); process.exit(1); });
