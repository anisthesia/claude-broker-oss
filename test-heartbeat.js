// Smoke test for heartbeat envelope + get_latest_per_sender tool.
// Sends sample heartbeats from 3 simulated workers to a test channel,
// then exercises get_latest_per_sender. Cleans up after.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync } from "fs";
import "dotenv/config";

const BROKER_URL = process.env.BROKER_URL || "http://localhost:8080/mcp";
const SECRET     = process.env.SHARED_SECRET || "";

const RUN_TAG = Date.now().toString(36);
const CH = `heartbeat-smoke-${RUN_TAG}`;

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
  console.error(`  ✗ ${label}`); if (detail) console.error(`     detail: ${detail}`);
  process.exitCode = 1; return false;
}

function makeHeartbeat({ from, size = 50000, state = "working", taskId = null, usd = 0 }) {
  const cache_read = Math.floor(size * 0.95);
  const cache_create = size - cache_read;
  const pct = (size / 200000) * 100;
  return JSON.stringify({
    type: "heartbeat",
    from,
    ts: new Date().toISOString(),
    session_id: `smoke-${from}-${RUN_TAG}`,
    model: "claude-opus-4-7",
    context: {
      size_tokens: size,
      cache_read,
      cache_create,
      tier_threshold_pct: Number(pct.toFixed(1)),
      rotation_recommended: pct >= 75,
    },
    activity: {
      last_tool_call_ts: new Date().toISOString(),
      current_task_id: taskId,
      state,
    },
    cost_since_start: {
      input_tokens: 100,
      output_tokens: 2000,
      cache_read_tokens: 5_000_000,
      cache_create_tokens: 50_000,
      estimated_usd: usd,
    },
  });
}

async function main() {
  console.log(`[heartbeat-smoke] broker: ${BROKER_URL}`);
  console.log(`[heartbeat-smoke] channel: ${CH}\n`);

  const { client, transport } = await connect("hb-smoke");

  // Register the telemetry schema on the test channel
  const telemetrySchema = readFileSync("schemas/telemetry.json", "utf-8");
  let r = await client.callTool({
    name: "register_channel_schema",
    arguments: { channel: CH, schema: telemetrySchema, strict: true },
  });
  expect(/Registered schema/.test(r.content[0].text), "schema registered (strict)", r.content[0].text);

  console.log("\n[step 1] backend heartbeat — working, low context");
  r = await client.callTool({
    name: "send_message",
    arguments: { channel: CH, sender: "backend", content: makeHeartbeat({ from: "backend", size: 45000, taskId: "feat-2026-05-28-foo-01", usd: 12.3 }) },
  });
  expect(/Sent #/.test(r.content[0].text) && !/WARN/.test(r.content[0].text), "valid heartbeat passes strict", r.content[0].text);

  console.log("\n[step 2] frontend heartbeat — rotation recommended");
  r = await client.callTool({
    name: "send_message",
    arguments: { channel: CH, sender: "frontend", content: makeHeartbeat({ from: "frontend", size: 165000, taskId: "feat-2026-05-28-foo-02", usd: 8.7 }) },
  });
  expect(/Sent #/.test(r.content[0].text) && !/WARN/.test(r.content[0].text), "rotation-flag heartbeat passes", r.content[0].text);

  console.log("\n[step 3] customer-portal heartbeat — idle-polling");
  r = await client.callTool({
    name: "send_message",
    arguments: { channel: CH, sender: "customer-portal", content: makeHeartbeat({ from: "customer-portal", size: 30000, state: "idle-polling", usd: 3.4 }) },
  });
  expect(/Sent #/.test(r.content[0].text), "idle-polling heartbeat passes", r.content[0].text);

  console.log("\n[step 4] backend heartbeat — second one, higher context (latest should win)");
  r = await client.callTool({
    name: "send_message",
    arguments: { channel: CH, sender: "backend", content: makeHeartbeat({ from: "backend", size: 90000, taskId: "feat-2026-05-28-foo-01", usd: 18.9 }) },
  });
  expect(/Sent #/.test(r.content[0].text), "second backend heartbeat passes", r.content[0].text);

  console.log("\n[step 5] malformed heartbeat (missing required 'context.rotation_recommended') — should reject under strict");
  const broken = JSON.stringify({
    type: "heartbeat",
    from: "backend",
    ts: new Date().toISOString(),
    context: { size_tokens: 1, tier_threshold_pct: 0.1 }, // missing rotation_recommended
    activity: { state: "working" },
  });
  r = await client.callTool({
    name: "send_message",
    arguments: { channel: CH, sender: "backend", content: broken },
  });
  expect(/schema validation failed/.test(r.content[0].text), "malformed heartbeat rejected under strict", r.content[0].text);

  console.log("\n[step 6] get_latest_per_sender returns one row per sender");
  r = await client.callTool({
    name: "get_latest_per_sender",
    arguments: { channel: CH },
  });
  const lines = r.content[0].text.split("\n");
  expect(lines.length === 3, `exactly 3 rows returned (got ${lines.length})`, r.content[0].text);
  expect(/<backend>/.test(r.content[0].text), "backend present", null);
  expect(/<frontend>/.test(r.content[0].text), "frontend present", null);
  expect(/<customer-portal>/.test(r.content[0].text), "customer-portal present", null);
  // Confirm latest backend row is the size=90000 one
  expect(/<backend>.*"size_tokens":90000/.test(r.content[0].text), "backend's latest is the high-context heartbeat", r.content[0].text);

  console.log("\n[step 7] empty-channel case for get_latest_per_sender");
  const emptyCh = `${CH}-empty`;
  r = await client.callTool({ name: "get_latest_per_sender", arguments: { channel: emptyCh } });
  expect(/No messages/.test(r.content[0].text), "empty channel returns no-messages text", r.content[0].text);

  console.log("\n[cleanup] purge channel + clear schema");
  await client.callTool({ name: "purge_channel", arguments: { channel: CH } });
  await client.callTool({ name: "clear_channel_schema", arguments: { channel: CH } });

  await transport.close();
  console.log(`\n[heartbeat-smoke] ${process.exitCode ? "FAIL" : "OK"}`);
}

main().catch(e => { console.error("[heartbeat-smoke] FAIL:", e); process.exit(1); });
