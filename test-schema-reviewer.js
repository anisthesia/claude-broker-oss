// Schema validation tests for the reviewer-inbox schema.
// Exercises the reviewer-inbox.json schema against a live broker.
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
    arguments: { channel, sender: "test-reviewer-schema", content: JSON.stringify(content) },
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

// ─── reviewer-inbox ───────────────────────────────────────────────────────────

async function testReviewerInbox(client) {
  console.log("\n── reviewer-inbox (cb-reviewer / dv-reviewer / rp-reviewer / sm-reviewer) ──");
  const ch = `cb-reviewer-test-${RUN_TAG}`;
  const file = "schemas/reviewer-inbox.json";

  let r = await registerSchema(client, ch, file, false);
  expect(/Registered schema/.test(r.content?.[0]?.text), "reviewer-inbox: schema registered warn-only");

  // 1. Valid task with body.base, body.head, body.checklist (non-empty)
  const validTask = {
    type: "task",
    task_id: "cb-2026-06-22-rev-001",
    from: "orchestrator",
    to: "reviewer",
    subject: "sprint-close review for sprint-007",
    body: {
      base: "main",
      head: "HEAD",
      checklist: [
        "All tests pass",
        "No schema warn lines in logs",
        "Commits follow naming convention",
      ],
    },
  };
  let t = await send(client, ch, validTask);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "reviewer-inbox: valid task with non-empty checklist accepted", t);

  // 2. Valid task with body.checklist=[] (empty array is allowed by schema)
  const validTaskEmptyChecklist = {
    type: "task",
    task_id: "cb-2026-06-22-rev-002",
    from: "orchestrator",
    to: "reviewer",
    subject: "sprint-close review — no checklist",
    body: {
      base: "main",
      head: "HEAD",
      checklist: [],
    },
  };
  t = await send(client, ch, validTaskEmptyChecklist);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "reviewer-inbox: valid task with empty checklist accepted", t);

  // 3. Missing body entirely → warn
  const missingBody = {
    type: "task",
    task_id: "cb-2026-06-22-rev-003",
    from: "orchestrator",
    to: "reviewer",
    subject: "task without body",
  };
  t = await send(client, ch, missingBody);
  expect(/WARN/.test(t), "reviewer-inbox: missing body → warn in warn-only", t);
  expect(/Sent #/.test(t), "reviewer-inbox: missing body still stored in warn-only", t);

  // 4. Body present but missing body.checklist → warn
  const missingChecklist = {
    type: "task",
    task_id: "cb-2026-06-22-rev-004",
    from: "orchestrator",
    to: "reviewer",
    subject: "review without checklist",
    body: { base: "main", head: "HEAD" },
  };
  t = await send(client, ch, missingChecklist);
  expect(/WARN/.test(t), "reviewer-inbox: body missing body.checklist → warn", t);

  // 5. Wrong type (type:note instead of type:task) → warn
  const wrongType = {
    type: "note",
    task_id: "cb-2026-06-22-rev-005",
    from: "orchestrator",
    to: "reviewer",
    subject: "reviewers only accept tasks",
    body: { base: "main", head: "HEAD", checklist: [] },
  };
  t = await send(client, ch, wrongType);
  expect(/WARN/.test(t), "reviewer-inbox: type:note (not allowed) → warn in warn-only", t);

  // 6. Extra property in body (body.extra_field) → warn (additionalProperties:false on body)
  const extraBodyProp = {
    type: "task",
    task_id: "cb-2026-06-22-rev-006",
    from: "orchestrator",
    to: "reviewer",
    subject: "review with extra body prop",
    body: {
      base: "main",
      head: "HEAD",
      checklist: ["All tests pass"],
      extra_field: "not allowed",
    },
  };
  t = await send(client, ch, extraBodyProp);
  expect(/WARN/.test(t), "reviewer-inbox: extra property in body → warn (additionalProperties:false)", t);

  // 7. Missing subject field → warn
  const missingSubject = {
    type: "task",
    task_id: "cb-2026-06-22-rev-007",
    from: "orchestrator",
    to: "reviewer",
    body: { base: "main", head: "HEAD", checklist: [] },
  };
  t = await send(client, ch, missingSubject);
  expect(/WARN/.test(t), "reviewer-inbox: missing subject → warn in warn-only", t);

  // 8. Valid task with optional context field → accepted
  const taskWithContext = {
    type: "task",
    task_id: "cb-2026-06-22-rev-008",
    from: "orchestrator",
    to: "reviewer",
    subject: "sprint-close review with context",
    context: "Sprint 007 focused on schema coverage. Verify all new test files pass.",
    body: {
      base: "main",
      head: "HEAD",
      checklist: ["test-schema-dx.js passes", "test-schema-sm.js passes"],
    },
  };
  t = await send(client, ch, taskWithContext);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "reviewer-inbox: valid task with optional context accepted", t);

  // 9. Flip to strict; missing body → rejected
  r = await registerSchema(client, ch, file, true);
  expect(/Registered schema/.test(r.content?.[0]?.text), "reviewer-inbox: schema re-registered strict");

  t = await send(client, ch, missingBody);
  expect(/schema validation failed/.test(t), "reviewer-inbox strict: missing body → rejected", t);

  // 10. Strict: extra property in body → rejected
  t = await send(client, ch, extraBodyProp);
  expect(/schema validation failed/.test(t), "reviewer-inbox strict: extra body property → rejected", t);

  // 11. Strict: valid task accepted
  t = await send(client, ch, validTask);
  expect(/Sent #/.test(t) && !/WARN/.test(t), "reviewer-inbox strict: valid task accepted", t);

  await clearSchema(client, ch);
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[test-schema-reviewer]  broker=${BROKER_URL}  run=${RUN_TAG}`);
  const { client, transport } = await connect("test-schema-reviewer");

  await testReviewerInbox(client);

  await transport.close();

  console.log(`\n──────────────────────────────────────────────────────`);
  console.log(`[test-schema-reviewer]  passed=${passed}  failed=${failed}`);
  if (failed === 0) console.log("  ALL TESTS PASSED");
  else { console.error("  SOME TESTS FAILED"); process.exitCode = 1; }
}

main().catch(e => { console.error("[test-schema-reviewer] FATAL:", e); process.exit(1); });
