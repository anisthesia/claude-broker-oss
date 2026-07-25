// Smoke test for channel schema validation.
// Assumes setup-schemas.js has already registered the example schemas.
// Uses unique channel names per run; safe to run against a live broker.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync } from "fs";
import "dotenv/config";

const BROKER_URL = process.env.BROKER_URL || "http://localhost:8080/mcp";
const SECRET     = process.env.SHARED_SECRET || "";

const RUN_TAG = Date.now().toString(36);
const TEST_CHANNEL = `validator-smoke-${RUN_TAG}`;

async function connect(name) {
  const transport = new StreamableHTTPClientTransport(new URL(BROKER_URL), {
    requestInit: SECRET ? { headers: { Authorization: `Bearer ${SECRET}` } } : {},
  });
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

function expect(cond, label, detail) {
  if (cond) { console.log(`  ✓ ${label}`); return true; }
  console.error(`  ✗ ${label}`);
  if (detail) console.error(`     detail: ${detail}`);
  process.exitCode = 1;
  return false;
}

async function main() {
  console.log(`[smoke] broker: ${BROKER_URL}`);
  console.log(`[smoke] channel: ${TEST_CHANNEL}\n`);

  const { client, transport } = await connect("smoke");

  // Use the worker-inbox schema for the test channel
  const workerInbox = readFileSync("schemas/worker-inbox.json", "utf-8");

  console.log("[step 1] register schema in warn-only mode");
  let r = await client.callTool({
    name: "register_channel_schema",
    arguments: { channel: TEST_CHANNEL, schema: workerInbox, strict: false },
  });
  expect(/Registered schema/.test(r.content[0].text), "schema registered (warn-only)", r.content[0].text);

  console.log("\n[step 2] send VALID message — should succeed, no warn");
  const validEnvelope = JSON.stringify({
    type: "task",
    task_id: "smoke-2026-05-27-validator-01",
    from: "orchestrator",
    to: "backend",
    subject: "smoke test valid envelope",
    body: "hello",
  });
  r = await client.callTool({
    name: "send_message",
    arguments: { channel: TEST_CHANNEL, sender: "orchestrator", content: validEnvelope },
  });
  expect(!/WARN/.test(r.content[0].text), "valid envelope: no warning emitted", r.content[0].text);

  console.log("\n[step 3] send MALFORMED message (missing 'task_id') — warn-only, should still send but warn");
  const malformedEnvelope = JSON.stringify({
    type: "task",
    from: "orchestrator",
    to: "backend",
    subject: "smoke test missing task_id",
  });
  r = await client.callTool({
    name: "send_message",
    arguments: { channel: TEST_CHANNEL, sender: "orchestrator", content: malformedEnvelope },
  });
  expect(/WARN/.test(r.content[0].text), "malformed envelope: warning emitted in warn-only", r.content[0].text);
  expect(/Sent #/.test(r.content[0].text), "malformed envelope: still stored (warn-only)", r.content[0].text);

  console.log("\n[step 4] flip channel to STRICT mode, send same malformed envelope — should reject");
  r = await client.callTool({
    name: "register_channel_schema",
    arguments: { channel: TEST_CHANNEL, schema: workerInbox, strict: true },
  });
  expect(/Registered schema/.test(r.content[0].text), "schema re-registered (strict)", r.content[0].text);

  r = await client.callTool({
    name: "send_message",
    arguments: { channel: TEST_CHANNEL, sender: "orchestrator", content: malformedEnvelope },
  });
  expect(/schema validation failed/.test(r.content[0].text), "malformed envelope rejected under strict", r.content[0].text);

  console.log("\n[step 5] valid envelope under STRICT — should still pass");
  r = await client.callTool({
    name: "send_message",
    arguments: { channel: TEST_CHANNEL, sender: "orchestrator", content: validEnvelope },
  });
  expect(/Sent #/.test(r.content[0].text) && !/WARN/.test(r.content[0].text),
    "valid envelope passes under strict", r.content[0].text);

  console.log("\n[step 6] non-JSON content under STRICT — should skip validation and send");
  r = await client.callTool({
    name: "send_message",
    arguments: { channel: TEST_CHANNEL, sender: "orchestrator", content: "just a plain string" },
  });
  expect(/Sent #/.test(r.content[0].text), "non-JSON content sent (validation skipped)", r.content[0].text);

  console.log("\n[step 7] enum violation (type: 'invalid-type') — should reject");
  const wrongCase = JSON.stringify({
    type: "invalid-type",
    task_id: "smoke-2026-05-27-validator-02",
    from: "orchestrator",
    to: "backend",
    subject: "bad type enum value",
  });
  r = await client.callTool({
    name: "send_message",
    arguments: { channel: TEST_CHANNEL, sender: "orchestrator", content: wrongCase },
  });
  expect(/schema validation failed/.test(r.content[0].text), "enum violation rejected (invalid type value)", r.content[0].text);

  console.log("\n[cleanup] purge test channel + clear its schema");
  await client.callTool({ name: "purge_channel", arguments: { channel: TEST_CHANNEL } });
  await client.callTool({ name: "clear_channel_schema", arguments: { channel: TEST_CHANNEL } });

  await transport.close();
  console.log(`\n[smoke] ${process.exitCode ? "FAIL" : "OK"}`);
}

main().catch(e => { console.error("[smoke] FAIL:", e); process.exit(1); });
