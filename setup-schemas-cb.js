// Register cb-namespace channel schemas with a running broker.
// Usage:
//   node setup-schemas-cb.js              # defaults: localhost:8080, warn-only
//   STRICT=1 node setup-schemas-cb.js     # register as strict (reject invalid)
//   BROKER_URL=... SHARED_SECRET=... node setup-schemas-cb.js
//
// Idempotent: re-running replaces the schema for each channel.

import { readFileSync } from "fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import "dotenv/config";

const BROKER_URL = process.env.BROKER_URL || "http://localhost:8080/mcp";
const SECRET     = process.env.SHARED_SECRET || "";
const STRICT     = process.env.STRICT === "1";

// Worker inboxes (core + protocol-qa) share the worker-inbox schema
// strict: true  — flip confirmed clean (zero violations in sprint-008 assessment)
// strict: false — held: schema mismatches or recent violations detected
const REGISTRATIONS = [
  { channel: "cb-core",         file: "schemas/cb-worker-inbox.json",      strict: true },
  { channel: "cb-protocol-qa",  file: "schemas/cb-worker-inbox.json",      strict: true },
  { channel: "cb-orchestrator", file: "schemas/cb-orchestrator-inbox.json", strict: true },
  { channel: "cb-control",      file: "schemas/cb-control.json",           strict: true },
  { channel: "cb-telemetry",    file: "schemas/cb-telemetry.json",         strict: true },
  { channel: "cb-status",       file: "schemas/cb-status.json",            strict: false },
  { channel: "cb-backlog",      file: "schemas/cb-backlog.json",           strict: true },
  { channel: "cb-reviewer",     file: "schemas/reviewer-inbox.json",       strict: true },
];

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL(BROKER_URL), {
    requestInit: SECRET ? { headers: { Authorization: `Bearer ${SECRET}` } } : {},
  });
  const client = new Client({ name: "setup-schemas-cb", version: "1.0.0" });
  await client.connect(transport);

  console.log(`[setup-cb] broker: ${BROKER_URL}`);
  console.log(`[setup-cb] mode:   ${STRICT ? "STRICT (reject invalid)" : "warn-only (log but allow)"}`);
  console.log();

  for (const { channel, file, strict } of REGISTRATIONS) {
    const schema = readFileSync(file, "utf-8");
    const strictMode = strict !== undefined ? strict : STRICT;
    const res = await client.callTool({
      name: "register_channel_schema",
      arguments: { channel, schema, strict: strictMode, version: JSON.parse(schema).version || "1.0" },
    });
    const text = res.content?.[0]?.text ?? "(no response)";
    console.log(`  ${channel.padEnd(18)} ← ${file}`);
    console.log(`    ${text}`);
  }

  console.log();
  const list = await client.callTool({ name: "list_channel_schemas", arguments: { prefix: "cb-" } });
  console.log("[setup-cb] registered cb-* schemas:");
  console.log(list.content[0].text);

  await transport.close();
  console.log("\n[setup-cb] done");
}

main().catch(e => { console.error("[setup-cb] FAIL:", e); process.exit(1); });
