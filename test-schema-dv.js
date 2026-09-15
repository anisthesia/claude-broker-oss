// Schema validation tests for dv-namespace channels (dogsvilla).
// Exercises all dv-* channel schemas against a live broker.
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
    arguments: { channel, sender: "test-dv-schema", content: JSON.stringify(content) },
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

// ─── dv-worker-inbox ─────────────────────────────────────────────────────────
// Shared by: dv-backend, dv-frontend, dv-customer-portal, dv-qa, etc.

async function testWorkerInbox(client) {
  console.log("\n── dv-worker-inbox (dv-backend / dv-frontend / dv-qa / …) ──");
  const ch = `dv-wi-test-${RUN_TAG}`;
  const file = "schemas/dv-worker-inbox.json";

  let r = await registerSchema(client, ch, file, false);
  expect(/Registered schema/.test(r.content?.[0]?.text), "worker-inbox: schema registered warn-only");

  // 1. Valid task envelope
  const validTask = {
    type: "task",
    task_id: `dv-2026-06-20-wi-001`,
    from: "orchestrator",
    to: "backend",
    subject: "add pet owner registration endpoint",
    body: "implement POST /api/registrations/pet-owner",
    depends_on: [],
    required_checks: ["lint", "test", "committed"],
  };
  let t = await send(client, ch, validTask);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "worker-inbox: valid task accepted, no warn", t);

  // 2. Valid rotate envelope
  const validRotate = {
    type: "rotate",
    task_id: `dv-2026-06-20-wi-rot`,
    from: "orchestrator",
    to: "backend",
    subject: "please rotate context",
  };
  t = await send(client, ch, validRotate);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "worker-inbox: valid rotate accepted, no warn", t);

  // 3. Valid reload envelope
  const validReload = {
    type: "reload",
    task_id: `dv-2026-06-20-wi-rel`,
    from: "orchestrator",
    to: "frontend",
    subject: "CLAUDE.md updated — reload",
  };
  t = await send(client, ch, validReload);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "worker-inbox: valid reload accepted, no warn", t);

  // 4. Valid consent-grant
  const validConsentGrant = {
    type: "consent-grant",
    task_id: `dv-2026-06-20-wi-cg1`,
    from: "orchestrator",
    to: "backend",
    subject: "consent granted: prod deploy",
    body: { authorized_actions: ["deploy:prod"], consent_basis: "terminal-human" },
  };
  t = await send(client, ch, validConsentGrant);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "worker-inbox: valid consent-grant accepted, no warn", t);

  // 5. Valid consent-deny
  const validConsentDeny = {
    type: "consent-deny",
    task_id: `dv-2026-06-20-wi-cd1`,
    from: "orchestrator",
    to: "backend",
    subject: "consent denied",
  };
  t = await send(client, ch, validConsentDeny);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "worker-inbox: valid consent-deny accepted, no warn", t);

  // 6. Missing task_id → warn
  const missingTaskId = { type: "task", from: "orchestrator", to: "backend", subject: "no task_id" };
  t = await send(client, ch, missingTaskId);
  expect(/WARN/.test(t), "worker-inbox: missing task_id → warn in warn-only", t);
  expect(/Sent #/.test(t), "worker-inbox: missing task_id still stored in warn-only", t);

  // 7. Missing subject → warn
  const missingSubject = { type: "task", task_id: `dv-2026-06-20-wi-ns`, from: "orchestrator", to: "backend" };
  t = await send(client, ch, missingSubject);
  expect(/WARN/.test(t), "worker-inbox: missing subject → warn in warn-only", t);

  // 8. Unknown type → warn
  const unknownType = {
    type: "broadcast",
    task_id: `dv-2026-06-20-wi-unk`,
    from: "orchestrator",
    to: "qa",
    subject: "unknown type",
  };
  t = await send(client, ch, unknownType);
  expect(/WARN/.test(t), "worker-inbox: unknown type → warn in warn-only", t);

  // 9. type:task missing body → warn
  const taskNoBody = {
    type: "task",
    task_id: `dv-2026-06-20-wi-nb`,
    from: "orchestrator",
    to: "backend",
    subject: "task without body",
  };
  t = await send(client, ch, taskNoBody);
  expect(/WARN/.test(t), "worker-inbox: type:task missing body → warn", t);

  // 10. contract-change without wire_compat → warn
  const contractNoCompat = {
    type: "contract-change",
    task_id: `dv-2026-06-20-wi-cc1`,
    from: "orchestrator",
    to: "frontend",
    subject: "pet schema changing",
    body: { before: {}, after: {} },
  };
  t = await send(client, ch, contractNoCompat);
  expect(/WARN/.test(t), "worker-inbox: contract-change without wire_compat → warn", t);

  // 11. Valid contract-change with wire_compat → no warn
  const validContract = { ...contractNoCompat, wire_compat: "breaking" };
  t = await send(client, ch, validContract);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "worker-inbox: valid contract-change with wire_compat accepted", t);

  // 12. approval-token missing required body fields → warn
  const tokenMissingBody = {
    type: "approval-token",
    task_id: `dv-2026-06-20-wi-tok`,
    from: "orchestrator",
    to: "backend",
    subject: "approve deploy",
    body: {},
  };
  t = await send(client, ch, tokenMissingBody);
  expect(/WARN/.test(t), "worker-inbox: approval-token missing body fields → warn", t);

  // 13. Valid approval-token → no warn
  const validToken = {
    type: "approval-token",
    task_id: `dv-2026-06-20-wi-tok-ok`,
    from: "orchestrator",
    to: "backend",
    subject: "approve deploy to prod",
    body: {
      authorized_actions: ["deploy:prod"],
      env: "prod",
      scope_workers: ["backend"],
      expires_at: "2026-06-20T23:59:59Z",
    },
  };
  t = await send(client, ch, validToken);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "worker-inbox: valid approval-token accepted", t);

  // approval-token with NO body at all → warn (v1.1: body now required)
  const bodylessTokendv_2026_07_07_wi_tok_nobody = { ...validToken, task_id: "dv-2026-07-07-wi-tok-nobody" };
  delete bodylessTokendv_2026_07_07_wi_tok_nobody.body;
  t = await send(client, ch, bodylessTokendv_2026_07_07_wi_tok_nobody);
  expect(/WARN/.test(t), "worker-inbox: bodyless approval-token → warn (body required)", t);

  // 14. task with ui_verified_instructions → no warn
  const taskWithUiInstructions = {
    type: "task",
    task_id: `dv-2026-06-20-wi-ui1`,
    from: "platform-orch",
    to: "frontend",
    subject: "update registration form",
    body: "update the form to include pet owner fields",
    required_checks: ["build", "ui_verified", "committed"],
    ui_verified_instructions: "Open /register → select 'Pet Owner' → confirm additional fields appear",
  };
  t = await send(client, ch, taskWithUiInstructions);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "worker-inbox: task with ui_verified_instructions accepted, no warn", t);

  // 15. task with affected_files → no warn
  const taskWithAffectedFiles = {
    type: "task",
    task_id: `dv-2026-06-20-wi-af1`,
    from: "orchestrator",
    to: "backend",
    subject: "add Razorpay webhook handler",
    body: "implement POST /api/webhooks/razorpay",
    affected_files: ["backend/routes/webhooks.js", "backend/services/razorpay.js"],
  };
  t = await send(client, ch, taskWithAffectedFiles);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "worker-inbox: task with affected_files accepted, no warn", t);

  // 16. task with acceptance_criteria → accepted, no warn (new field)
  const taskWithCriteria = {
    type: "task",
    task_id: `dv-2026-06-20-wi-ac1`,
    from: "consumer-orch",
    to: "backend",
    subject: "implement individual registration",
    body: "build POST /api/registrations/individual\n\nAcceptance criteria:\n- [ ] endpoint returns 201 on success\n- [ ] duplicate email returns 409\n- [ ] tests pass\n- [ ] committed",
    acceptance_criteria: [
      "endpoint returns 201 on success",
      "duplicate email returns 409",
      "tests pass",
      "committed",
    ],
    required_checks: ["lint", "test", "committed"],
    affected_files: ["backend/routes/registrations.js"],
  };
  t = await send(client, ch, taskWithCriteria);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "worker-inbox: task with acceptance_criteria accepted, no warn", t);

  // 17. task without acceptance_criteria still accepted (field is optional)
  const taskNoCriteria = {
    type: "task",
    task_id: `dv-2026-06-20-wi-ac2`,
    from: "orchestrator",
    to: "qa",
    subject: "run baseline tests",
    body: "run npm test and report pass/fail count",
  };
  t = await send(client, ch, taskNoCriteria);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "worker-inbox: task without acceptance_criteria still accepted (optional)", t);

  // 18. acceptance_criteria with non-string items → warn
  const taskBadCriteria = {
    type: "task",
    task_id: `dv-2026-06-20-wi-ac3`,
    from: "orchestrator",
    to: "backend",
    subject: "bad criteria type",
    body: "instructions",
    acceptance_criteria: [{ step: "not a string" }],
  };
  t = await send(client, ch, taskBadCriteria);
  expect(/WARN/.test(t), "worker-inbox: acceptance_criteria with non-string items → warn", t);

  // 19. Full envelope with all new fields together → no warn
  const fullEnvelope = {
    type: "task",
    task_id: `dv-2026-06-20-wi-full`,
    from: "consumer-orch",
    to: "backend",
    subject: "implement Razorpay checkout for pet owner registration",
    body: "wire Razorpay into the registration flow\n\nAcceptance criteria:\n- [ ] checkout opens with correct amount\n- [ ] success redirects to /registration/complete\n- [ ] webhook processes payment confirmation\n- [ ] e2e test passes\n- [ ] committed",
    acceptance_criteria: [
      "checkout opens with correct amount",
      "success redirects to /registration/complete",
      "webhook processes payment confirmation",
      "e2e test passes",
      "committed",
    ],
    required_checks: ["lint", "build", "test", "committed"],
    affected_files: ["backend/routes/registrations.js", "backend/services/razorpay.js"],
    depends_on: [`dv-2026-06-20-wi-ac1:backend`],
  };
  t = await send(client, ch, fullEnvelope);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "worker-inbox: full envelope with all new fields accepted, no warn", t);

  // new-a. Valid task WITH context + files (read+write) + checks (one item) → PASS
  const taskWithNewFields = {
    type: "task",
    task_id: `dv-2026-06-22-wi-new-a`,
    from: "orchestrator",
    to: "backend",
    subject: "task with context files and checks",
    body: "do the work",
    context: "Propagating new envelope fields from cb-worker-inbox to dv namespace.",
    files: { read: ["schemas/dv-worker-inbox.json"], write: ["test-schema-dv.js"] },
    checks: [{ name: "tests pass", run: "node test-schema-dv.js", pass_condition: "ALL TESTS PASSED" }],
  };
  t = await send(client, ch, taskWithNewFields);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "worker-inbox new-a: task with context+files+checks accepted, no warn", t);

  // new-b. Valid task WITHOUT new fields → backward compat, should still PASS
  const taskWithoutNewFields = {
    type: "task",
    task_id: `dv-2026-06-22-wi-new-b`,
    from: "orchestrator",
    to: "frontend",
    subject: "plain task no new fields",
    body: "run tests",
  };
  t = await send(client, ch, taskWithoutNewFields);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "worker-inbox new-b: task without new fields still accepted (backward compat)", t);

  // new-c. checks item missing pass_condition → WARN (schema violation)
  const taskChecksMissingPassCond = {
    type: "task",
    task_id: `dv-2026-06-22-wi-new-c`,
    from: "orchestrator",
    to: "backend",
    subject: "checks without pass_condition",
    body: "do thing",
    checks: [{ name: "run tests", run: "node test-schema-dv.js" }],
  };
  t = await send(client, ch, taskChecksMissingPassCond);
  expect(/WARN/.test(t), "worker-inbox new-c: checks item missing pass_condition → warn in warn-only", t);

  // new-d. files with extra property beyond read/write → WARN
  const taskFilesExtraProp = {
    type: "task",
    task_id: `dv-2026-06-22-wi-new-d`,
    from: "orchestrator",
    to: "backend",
    subject: "files with extra property",
    body: "do thing",
    files: { read: [], write: [], execute: ["script.sh"] },
  };
  t = await send(client, ch, taskFilesExtraProp);
  expect(/WARN/.test(t), "worker-inbox new-d: files with extra property → warn in warn-only", t);

  // new-e. context set to empty string → WARN (minLength:1)
  const taskEmptyContext = {
    type: "task",
    task_id: `dv-2026-06-22-wi-new-e`,
    from: "orchestrator",
    to: "backend",
    subject: "empty context string",
    body: "do thing",
    context: "",
  };
  t = await send(client, ch, taskEmptyContext);
  expect(/WARN/.test(t), "worker-inbox new-e: context set to empty string → warn (minLength:1)", t);

  // 20. Flip to strict; missing task_id rejected
  r = await registerSchema(client, ch, file, true);
  expect(/Registered schema/.test(r.content?.[0]?.text), "worker-inbox: schema re-registered strict");

  t = await send(client, ch, missingTaskId);
  expect(/schema validation failed/.test(t), "worker-inbox strict: missing task_id rejected", t);

  // 21. strict: task with acceptance_criteria still accepted
  t = await send(client, ch, taskWithCriteria);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "worker-inbox strict: task with acceptance_criteria accepted", t);

  // 22. strict: valid task accepted
  t = await send(client, ch, validTask);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "worker-inbox strict: valid task accepted", t);

  await clearSchema(client, ch);
}

// ─── dv-status ───────────────────────────────────────────────────────────────

async function testStatus(client) {
  console.log("\n── dv-status ──");
  const ch = `dv-st-test-${RUN_TAG}`;
  const file = "schemas/dv-status.json";

  let r = await registerSchema(client, ch, file, false);
  expect(/Registered schema/.test(r.content?.[0]?.text), "status: schema registered warn-only");

  // 1. Valid status update
  const validStatus = {
    type: "status",
    task_id: `dv-2026-06-20-st-001`,
    from: "backend",
    to: "root-orchestrator",
    subject: "running migrations",
    body: { state: "working" },
  };
  let t = await send(client, ch, validStatus);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "status: valid type:status accepted, no warn", t);

  // 2. Valid result with summary + consent_basis → no warn
  const validResult = {
    type: "result",
    task_id: `dv-2026-06-20-st-r01`,
    from: "backend",
    to: "root-orchestrator",
    subject: "registration endpoint done",
    summary: "PASS — POST /api/registrations/pet-owner returns 201, all tests pass",
    body: { consent_basis: "orchestrator-dispatch-only" },
  };
  t = await send(client, ch, validResult);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "status: valid type:result with summary + consent_basis accepted", t);

  // 3. type:result without summary → warn
  const resultNoSummary = {
    type: "result",
    task_id: `dv-2026-06-20-st-r02`,
    from: "frontend",
    to: "root-orchestrator",
    subject: "done",
    body: { consent_basis: "orchestrator-dispatch-only" },
  };
  t = await send(client, ch, resultNoSummary);
  expect(/WARN/.test(t), "status: type:result without summary → warn in warn-only", t);
  expect(/Sent #/.test(t), "status: type:result without summary still stored in warn-only", t);

  // 4. type:result without consent_basis → warn (required in dv-status)
  const resultNoConsent = {
    type: "result",
    task_id: `dv-2026-06-20-st-r03`,
    from: "backend",
    to: "root-orchestrator",
    subject: "deployed",
    summary: "PASS — deployed to staging",
    body: {},
  };
  t = await send(client, ch, resultNoConsent);
  expect(/WARN/.test(t), "status: type:result without consent_basis → warn (required in dv)", t);

  // 5. type:result with commits but no affected_files → warn
  const resultCommitsNoFiles = {
    type: "result",
    task_id: `dv-2026-06-20-st-r04`,
    from: "backend",
    to: "root-orchestrator",
    subject: "committed migration",
    summary: "PASS — migration applied",
    body: {
      consent_basis: "orchestrator-dispatch-only",
      commits: [{ sha: "abc1234", branch: "main", message: "add pet owner registration" }],
    },
  };
  t = await send(client, ch, resultCommitsNoFiles);
  expect(/WARN/.test(t), "status: type:result with commits but no affected_files → warn", t);

  // 6. type:result with commits + affected_files → no warn
  const resultWithFiles = {
    type: "result",
    task_id: `dv-2026-06-20-st-r05`,
    from: "backend",
    to: "root-orchestrator",
    subject: "committed registration endpoint",
    summary: "PASS — endpoint committed, all tests pass",
    affected_files: ["backend/routes/registrations.js"],
    body: {
      consent_basis: "orchestrator-dispatch-only",
      commits: [{ sha: "abc1234", branch: "main", message: "add pet owner registration" }],
    },
  };
  t = await send(client, ch, resultWithFiles);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "status: type:result with commits + affected_files accepted", t);

  // 7. Valid question
  const validQuestion = {
    type: "question",
    task_id: `dv-2026-06-20-st-q1`,
    from: "backend",
    to: "root-orchestrator",
    subject: "consent required: prod deploy",
    body: { question: "Deploy to production?" },
  };
  t = await send(client, ch, validQuestion);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "status: valid type:question accepted, no warn", t);

  // 8. Valid handoff
  const validHandoff = {
    type: "handoff",
    task_id: `dv-2026-06-20-st-h1`,
    from: "backend",
    to: "frontend",
    subject: "registration API ready for frontend",
    body: { api_channel: "dv-backend-tokens" },
  };
  t = await send(client, ch, validHandoff);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "status: valid type:handoff accepted, no warn", t);

  // 9. Missing task_id → warn
  const missingTaskId = { type: "status", from: "qa", to: "root-orchestrator", subject: "no id" };
  t = await send(client, ch, missingTaskId);
  expect(/WARN/.test(t), "status: missing task_id → warn in warn-only", t);

  // 10. Strict: result without summary → rejected
  r = await registerSchema(client, ch, file, true);
  expect(/Registered schema/.test(r.content?.[0]?.text), "status: schema re-registered strict");

  t = await send(client, ch, resultNoSummary);
  expect(/schema validation failed/.test(t), "status strict: type:result without summary → rejected", t);

  // 11. Strict: result without consent_basis → rejected
  t = await send(client, ch, resultNoConsent);
  expect(/schema validation failed/.test(t), "status strict: type:result without consent_basis → rejected", t);

  // 12. Strict: valid status accepted
  t = await send(client, ch, validStatus);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "status strict: type:status without summary accepted", t);

  // 13. Strict: valid result with all fields accepted
  t = await send(client, ch, validResult);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "status strict: valid type:result accepted", t);

  await clearSchema(client, ch);
}

// ─── dv-control ──────────────────────────────────────────────────────────────

async function testControl(client) {
  console.log("\n── dv-control ──");
  const ch = `dv-ctrl-test-${RUN_TAG}`;
  const file = "schemas/dv-control.json";

  let r = await registerSchema(client, ch, file, false);
  expect(/Registered schema/.test(r.content?.[0]?.text), "control: schema registered warn-only");

  // 1. Valid contract-change → no warn
  const validContract = {
    type: "contract-change",
    task_id: `dv-2026-06-20-ctrl-cc1`,
    from: "orchestrator",
    to: "*",
    subject: "pet schema v2 — adding owner_type field",
    wire_compat: "additive",
    body: { before: { version: 1 }, after: { version: 2 }, affected_workers: ["backend", "frontend", "mobile"] },
  };
  let t = await send(client, ch, validContract);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "control: valid contract-change accepted, no warn", t);

  // 2. contract-change without wire_compat → warn
  const contractNoCompat = { ...validContract, task_id: `dv-2026-06-20-ctrl-cc2` };
  delete contractNoCompat.wire_compat;
  t = await send(client, ch, contractNoCompat);
  expect(/WARN/.test(t), "control: contract-change without wire_compat → warn", t);

  // 3. Valid approval-token → no warn
  const validToken = {
    type: "approval-token",
    task_id: `dv-2026-06-20-ctrl-tok`,
    from: "orchestrator",
    to: "backend",
    subject: "approve prod deploy",
    body: {
      authorized_actions: ["deploy:prod"],
      env: "prod",
      scope_workers: ["backend"],
      expires_at: "2026-06-20T23:59:59Z",
    },
  };
  t = await send(client, ch, validToken);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "control: valid approval-token accepted", t);

  // approval-token with NO body at all → warn (v1.1: body now required)
  const bodylessTokendv_2026_07_07_ctrl_tok_nobody = { ...validToken, task_id: "dv-2026-07-07-ctrl-tok-nobody" };
  delete bodylessTokendv_2026_07_07_ctrl_tok_nobody.body;
  t = await send(client, ch, bodylessTokendv_2026_07_07_ctrl_tok_nobody);
  expect(/WARN/.test(t), "control: bodyless approval-token → warn (body required)", t);

  // 4. Valid approval-revoke → no warn
  const validRevoke = {
    type: "approval-revoke",
    task_id: `dv-2026-06-20-ctrl-rev`,
    from: "orchestrator",
    to: "*",
    subject: "token revoked",
    body: { revokes_msg_id: 9999 },
  };
  t = await send(client, ch, validRevoke);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "control: valid approval-revoke accepted", t);

  // 5. approval-revoke without body.revokes_msg_id → warn
  const revokeNoMsgId = {
    type: "approval-revoke",
    task_id: `dv-2026-06-20-ctrl-rev2`,
    from: "orchestrator",
    to: "*",
    subject: "token revoked",
    body: {},
  };
  t = await send(client, ch, revokeNoMsgId);
  expect(/WARN/.test(t), "control: approval-revoke without revokes_msg_id → warn", t);

  // 6. Valid note → no warn
  const validNote = {
    type: "note",
    task_id: `dv-2026-06-20-ctrl-n1`,
    from: "orchestrator",
    to: "*",
    subject: "reminder: staging env only this sprint",
  };
  t = await send(client, ch, validNote);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "control: valid note accepted, no warn", t);

  // 7. Valid rotate → no warn
  const validRotate = {
    type: "rotate",
    task_id: `dv-2026-06-20-ctrl-rot`,
    from: "orchestrator",
    to: "backend",
    subject: "rotate context",
  };
  t = await send(client, ch, validRotate);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "control: valid rotate accepted, no warn", t);

  // 8. Valid reload → no warn
  const validReload = {
    type: "reload",
    task_id: `dv-2026-06-20-ctrl-rel`,
    from: "orchestrator",
    to: "*",
    subject: "CLAUDE.md updated",
    body: { reason: "added acceptance_criteria discipline", workers: ["backend", "frontend"] },
  };
  t = await send(client, ch, validReload);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "control: valid reload accepted, no warn", t);

  // 9. Valid ledger-snapshot → no warn
  const validSnapshot = {
    type: "ledger-snapshot",
    task_id: `dv-2026-06-20-ctrl-ls1`,
    from: "platform-orch",
    to: "*",
    subject: "ledger snapshot",
    body: { open_tasks: [], since_ids: { "dv-platform-status": 42 } },
  };
  t = await send(client, ch, validSnapshot);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "control: valid ledger-snapshot accepted, no warn", t);

  // 10. Unknown type (task) → warn (not allowed on control)
  const unknownType = {
    type: "task",
    task_id: `dv-2026-06-20-ctrl-unk`,
    from: "orchestrator",
    to: "backend",
    subject: "dispatching via control (wrong)",
  };
  t = await send(client, ch, unknownType);
  expect(/WARN/.test(t), "control: type:task not in enum → warn", t);

  // 11. Missing task_id → warn
  const missingTaskId = { type: "note", from: "orchestrator", to: "*", subject: "no task_id" };
  t = await send(client, ch, missingTaskId);
  expect(/WARN/.test(t), "control: missing task_id → warn in warn-only", t);

  // 12. Missing subject → warn
  const missingSubject = { type: "note", task_id: `dv-2026-06-20-ctrl-ns`, from: "orchestrator", to: "*" };
  t = await send(client, ch, missingSubject);
  expect(/WARN/.test(t), "control: missing subject → warn in warn-only", t);

  // 13. Strict: missing subject → rejected
  r = await registerSchema(client, ch, file, true);
  expect(/Registered schema/.test(r.content?.[0]?.text), "control: schema re-registered strict");

  t = await send(client, ch, missingSubject);
  expect(/schema validation failed/.test(t), "control strict: missing subject → rejected", t);

  // 14. Strict: valid contract-change accepted
  t = await send(client, ch, validContract);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "control strict: valid contract-change accepted", t);

  await clearSchema(client, ch);
}

// ─── dv-telemetry ────────────────────────────────────────────────────────────

async function testTelemetry(client) {
  console.log("\n── dv-telemetry ──");
  const ch = `dv-tel-test-${RUN_TAG}`;
  const file = "schemas/dv-telemetry.json";

  let r = await registerSchema(client, ch, file, false);
  expect(/Registered schema/.test(r.content?.[0]?.text), "telemetry: schema registered warn-only");

  // 1. Valid heartbeat — working state
  const validHB = {
    type: "heartbeat",
    from: "backend",
    ts: "2026-06-20T10:00:00Z",
    session_id: "sess-dv-abc123",
    model: "claude-sonnet-4-6",
    context: { size_tokens: 45000, tier_threshold_pct: 30.0, rotation_recommended: false },
    activity: { state: "working", current_task_id: `dv-2026-06-20-wi-001` },
  };
  let t = await send(client, ch, validHB);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "telemetry: valid heartbeat (working) accepted, no warn", t);

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

  // 3. Heartbeat with cost_since_start → no warn
  const hbWithCost = {
    ...validHB,
    cost_since_start: {
      input_tokens: 50000,
      output_tokens: 12000,
      cache_read_tokens: 30000,
      cache_create_tokens: 5000,
      estimated_usd: 0.42,
    },
  };
  t = await send(client, ch, hbWithCost);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "telemetry: heartbeat with cost_since_start accepted", t);

  // 4. Heartbeat with context cache fields → no warn
  const hbWithCache = {
    ...validHB,
    context: { size_tokens: 50000, cache_read: 20000, cache_create: 5000, tier_threshold_pct: 33.0, rotation_recommended: false },
  };
  t = await send(client, ch, hbWithCache);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "telemetry: heartbeat with cache fields in context accepted", t);

  // 5. Invalid state → warn
  const badState = { ...validHB, activity: { state: "undefined-state" } };
  t = await send(client, ch, badState);
  expect(/WARN/.test(t), "telemetry: unknown state → warn in warn-only", t);

  // 6. Missing context → warn
  const missingContext = {
    type: "heartbeat",
    from: "qa",
    ts: "2026-06-20T10:01:00Z",
    activity: { state: "working" },
  };
  t = await send(client, ch, missingContext);
  expect(/WARN/.test(t), "telemetry: missing context → warn in warn-only", t);

  // 7. Missing activity → warn
  const missingActivity = {
    type: "heartbeat",
    from: "frontend",
    ts: "2026-06-20T10:02:00Z",
    context: { size_tokens: 1000, tier_threshold_pct: 10.0, rotation_recommended: false },
  };
  t = await send(client, ch, missingActivity);
  expect(/WARN/.test(t), "telemetry: missing activity → warn in warn-only", t);

  // 8. Wrong type → warn
  const wrongType = { ...validHB, type: "status" };
  t = await send(client, ch, wrongType);
  expect(/WARN/.test(t), "telemetry: type:status (not heartbeat) → warn", t);

  // 9. Strict: invalid state → rejected
  r = await registerSchema(client, ch, file, true);
  expect(/Registered schema/.test(r.content?.[0]?.text), "telemetry: schema re-registered strict");

  t = await send(client, ch, badState);
  expect(/schema validation failed/.test(t), "telemetry strict: unknown state → rejected", t);

  // 10. Strict: valid heartbeat accepted
  t = await send(client, ch, validHB);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "telemetry strict: valid heartbeat accepted", t);

  await clearSchema(client, ch);
}

// ─── dv-backlog ───────────────────────────────────────────────────────────────

async function testBacklog(client) {
  console.log("\n── dv-backlog ──");
  const ch = `dv-bl-test-${RUN_TAG}`;
  const file = "schemas/dv-backlog.json";

  let r = await registerSchema(client, ch, file, false);
  expect(/Registered schema/.test(r.content?.[0]?.text), "backlog: schema registered warn-only");

  // 1. Valid deferred with reason → no warn
  const validDeferred = {
    type: "deferred",
    task_id: `dv-2026-06-20-bl-001`,
    subject: "add Razorpay webhook retry logic",
    from: "orchestrator",
    deferred_reason: "scope too large for this sprint — payment integration not yet unblocked",
  };
  let t = await send(client, ch, validDeferred);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "backlog: valid deferred with reason accepted, no warn", t);

  // 2. Valid deferred without reason → accepted (optional in dv-backlog)
  const deferredNoReason = {
    type: "deferred",
    task_id: `dv-2026-06-20-bl-002`,
    subject: "add partner API integration",
    from: "orchestrator",
  };
  t = await send(client, ch, deferredNoReason);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "backlog: deferred without reason accepted (optional in dv)", t);

  // 3. Valid deferred-resolved with full body → no warn
  const validResolved = {
    type: "deferred-resolved",
    task_id: `dv-2026-06-20-bl-001`,
    subject: "add Razorpay webhook retry logic",
    from: "orchestrator",
    to: "orchestrator",
    body: { resolved_in_sprint: "dv-sprint-007", outcome: "promoted" },
  };
  t = await send(client, ch, validResolved);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "backlog: valid deferred-resolved accepted, no warn", t);

  // 4. deferred-resolved outcome enum — all valid values
  for (const outcome of ["promoted", "cancelled", "superseded"]) {
    const r = {
      type: "deferred-resolved",
      task_id: `dv-2026-06-20-bl-oc-${outcome}`,
      subject: `resolved as ${outcome}`,
      body: { resolved_in_sprint: "dv-sprint-007", outcome },
    };
    t = await send(client, ch, r);
    expect(/Sent #/.test(t) && !/WARN/.test(t), `backlog: deferred-resolved outcome="${outcome}" accepted`, t);
  }

  // 5. deferred-resolved with invalid outcome → warn
  const resolvedBadOutcome = {
    type: "deferred-resolved",
    task_id: `dv-2026-06-20-bl-bad`,
    subject: "bad outcome",
    body: { resolved_in_sprint: "dv-sprint-007", outcome: "deleted" },
  };
  t = await send(client, ch, resolvedBadOutcome);
  expect(/WARN/.test(t), "backlog: deferred-resolved with invalid outcome → warn", t);

  // 6. Valid retrospective → no warn
  const validRetro = {
    type: "retrospective",
    task_id: `dv-2026-06-20-bl-retro`,
    subject: "Sprint 007 retrospective",
    from: "orchestrator",
    body: { sprint: "dv-sprint-007", dates: "2026-06-14 to 2026-06-20", workers: { backend: "COMPLETE" } },
  };
  t = await send(client, ch, validRetro);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "backlog: valid retrospective accepted, no warn", t);

  // 7. Unknown type → warn
  const unknownType = { type: "note", task_id: `dv-2026-06-20-bl-unk`, subject: "type:note not allowed in backlog" };
  t = await send(client, ch, unknownType);
  expect(/WARN/.test(t), "backlog: unknown type:note → warn", t);

  // 8. Missing task_id → warn
  const missingTaskId = { type: "deferred", subject: "no task_id" };
  t = await send(client, ch, missingTaskId);
  expect(/WARN/.test(t), "backlog: missing task_id → warn in warn-only", t);

  // 9. Missing subject → warn
  const missingSubject = { type: "deferred", task_id: `dv-2026-06-20-bl-ns` };
  t = await send(client, ch, missingSubject);
  expect(/WARN/.test(t), "backlog: missing subject → warn in warn-only", t);

  // 10. Strict: invalid outcome → rejected
  r = await registerSchema(client, ch, file, true);
  expect(/Registered schema/.test(r.content?.[0]?.text), "backlog: schema re-registered strict");

  t = await send(client, ch, resolvedBadOutcome);
  expect(/schema validation failed/.test(t), "backlog strict: deferred-resolved with invalid outcome → rejected", t);

  // 11. Strict: valid deferred accepted
  t = await send(client, ch, validDeferred);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "backlog strict: valid deferred accepted", t);

  await clearSchema(client, ch);
}

// ─── dv-cluster-status ───────────────────────────────────────────────────────
// Shared by: dv-intel-status, dv-platform-status, dv-consumer-status

async function testClusterStatus(client) {
  console.log("\n── dv-cluster-status (dv-intel-status / dv-platform-status / dv-consumer-status) ──");
  const ch = `dv-cs-test-${RUN_TAG}`;
  const file = "schemas/dv-cluster-status.json";

  let r = await registerSchema(client, ch, file, false);
  expect(/Registered schema/.test(r.content?.[0]?.text), "cluster-status: schema registered warn-only");

  // 1. Valid status checkpoint
  const validStatus = {
    type: "status",
    task_id: `dv-2026-06-20-cs-001`,
    from: "backend",
    to: "platform-orch",
    subject: "checkpoint: migrations complete, starting routes",
    body: { state: "working", progress: "3/5 steps done" },
  };
  let t = await send(client, ch, validStatus);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "cluster-status: valid type:status accepted, no warn", t);

  // 2. Valid result with all required fields → no warn
  const validResult = {
    type: "result",
    task_id: `dv-2026-06-20-cs-r01`,
    from: "backend",
    to: "platform-orch",
    subject: "registration endpoint complete",
    summary: "PASS — POST /api/registrations/{type} returns 201, unit + integration tests pass",
    affected_files: ["backend/routes/registrations.js", "backend/models/Registration.js"],
    body: {
      consent_basis: "orchestrator-dispatch-only",
      commits: [{ sha: "def5678", branch: "main", message: "add registration endpoint" }],
    },
  };
  t = await send(client, ch, validResult);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "cluster-status: valid type:result with all fields accepted", t);

  // 3. type:result without summary → warn
  const resultNoSummary = {
    type: "result",
    task_id: `dv-2026-06-20-cs-r02`,
    from: "frontend",
    to: "consumer-orch",
    subject: "done",
    body: { consent_basis: "orchestrator-dispatch-only" },
  };
  t = await send(client, ch, resultNoSummary);
  expect(/WARN/.test(t), "cluster-status: type:result without summary → warn", t);

  // 4. type:result without consent_basis → warn
  const resultNoConsent = {
    type: "result",
    task_id: `dv-2026-06-20-cs-r03`,
    from: "backend",
    to: "platform-orch",
    subject: "done",
    summary: "PASS — feature done",
    body: {},
  };
  t = await send(client, ch, resultNoConsent);
  expect(/WARN/.test(t), "cluster-status: type:result without consent_basis → warn", t);

  // 5. type:result with commits but no affected_files → warn
  const resultCommitsNoFiles = {
    type: "result",
    task_id: `dv-2026-06-20-cs-r04`,
    from: "backend",
    to: "platform-orch",
    subject: "committed changes",
    summary: "PASS — changes committed",
    body: {
      consent_basis: "orchestrator-dispatch-only",
      commits: [{ sha: "abc1234", branch: "main", message: "add webhook" }],
    },
  };
  t = await send(client, ch, resultCommitsNoFiles);
  expect(/WARN/.test(t), "cluster-status: type:result with commits but no affected_files → warn", t);

  // 6. Valid question from worker to cluster-orch
  const validQuestion = {
    type: "question",
    task_id: `dv-2026-06-20-cs-q1`,
    from: "backend",
    to: "platform-orch",
    subject: "consent required: Razorpay live keys",
    body: { question: "Use live Razorpay keys for this deploy?" },
  };
  t = await send(client, ch, validQuestion);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "cluster-status: valid type:question accepted, no warn", t);

  // 7. Missing task_id → warn
  const missingTaskId = { type: "status", from: "backend", to: "platform-orch", subject: "no id" };
  t = await send(client, ch, missingTaskId);
  expect(/WARN/.test(t), "cluster-status: missing task_id → warn in warn-only", t);

  // 8. Strict: result without summary → rejected
  r = await registerSchema(client, ch, file, true);
  expect(/Registered schema/.test(r.content?.[0]?.text), "cluster-status: schema re-registered strict");

  t = await send(client, ch, resultNoSummary);
  expect(/schema validation failed/.test(t), "cluster-status strict: type:result without summary → rejected", t);

  // 9. Strict: valid result accepted
  t = await send(client, ch, validResult);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "cluster-status strict: valid type:result accepted", t);

  await clearSchema(client, ch);
}

// ─── setup-schemas.js idempotent re-run ──────────────────────────────────────

async function testSetupIdempotency() {
  console.log("\n── setup-schemas.js idempotency ──");
  const { execSync } = await import("child_process");
  let output, exitCode;
  try {
    output = execSync(`"${process.execPath}" setup-schemas.js`, { encoding: "utf-8", env: process.env });
    exitCode = 0;
  } catch (e) {
    output = e.stdout + e.stderr;
    exitCode = e.status ?? 1;
  }
  expect(exitCode === 0, "setup-schemas.js: first run exits 0", output);
  expect(/dv-backend/.test(output),          "setup-schemas.js: dv-backend registered", output);
  expect(/dv-frontend/.test(output),         "setup-schemas.js: dv-frontend registered", output);
  expect(/dv-customer-portal/.test(output),  "setup-schemas.js: dv-customer-portal registered", output);
  expect(/dv-qa/.test(output),               "setup-schemas.js: dv-qa registered", output);
  expect(/dv-status/.test(output),           "setup-schemas.js: dv-status registered", output);
  expect(/dv-control/.test(output),          "setup-schemas.js: dv-control registered", output);
  expect(/dv-telemetry/.test(output),        "setup-schemas.js: dv-telemetry registered", output);
  expect(/dv-backlog/.test(output),          "setup-schemas.js: dv-backlog registered", output);
  expect(/dv-intel-status/.test(output),     "setup-schemas.js: dv-intel-status registered", output);
  expect(/dv-platform-status/.test(output),  "setup-schemas.js: dv-platform-status registered", output);
  expect(/dv-consumer-status/.test(output),  "setup-schemas.js: dv-consumer-status registered", output);

  // Second run — must also exit 0 (idempotent)
  try {
    output = execSync(`"${process.execPath}" setup-schemas.js`, { encoding: "utf-8", env: process.env });
    exitCode = 0;
  } catch (e) {
    output = e.stdout + e.stderr;
    exitCode = e.status ?? 1;
  }
  expect(exitCode === 0, "setup-schemas.js: second run (idempotent re-run) exits 0", output);
  expect(!/ERROR/.test(output), "setup-schemas.js: no ERROR on second run", output);
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[test-schema-dv]  broker=${BROKER_URL}  run=${RUN_TAG}`);
  const { client, transport } = await connect("test-schema-dv");

  await testWorkerInbox(client);
  await testStatus(client);
  await testControl(client);
  await testTelemetry(client);
  await testBacklog(client);
  await testClusterStatus(client);

  await transport.close();

  await testSetupIdempotency();

  console.log(`\n──────────────────────────────────────────────────────`);
  console.log(`[test-schema-dv]  passed=${passed}  failed=${failed}`);
  if (failed === 0) console.log("  ALL TESTS PASSED");
  else { console.error("  SOME TESTS FAILED"); process.exitCode = 1; }
}

main().catch(e => { console.error("[test-schema-dv] FATAL:", e); process.exit(1); });
