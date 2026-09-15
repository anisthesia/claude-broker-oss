// Register channel schemas with a running broker.
// Usage:
//   node setup-schemas.js              # defaults: localhost:8080, warn-only
//   STRICT=1 node setup-schemas.js     # register as strict (reject invalid)
//   BROKER_URL=... SHARED_SECRET=... node setup-schemas.js
//
// Idempotent: re-running replaces the schema for each channel.

import { readFileSync } from "fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import "dotenv/config";

const BROKER_URL = process.env.BROKER_URL || "http://localhost:8080/mcp";
const SECRET     = process.env.SHARED_SECRET || "";
const STRICT     = process.env.STRICT === "1";

const REGISTRATIONS = [
  { channel: "dv-backend",         file: "schemas/dv-worker-inbox.json",   strict: false },
  { channel: "dv-frontend",        file: "schemas/dv-worker-inbox.json", strict: false },
  { channel: "dv-customer-portal", file: "schemas/dv-worker-inbox.json" },
  { channel: "dv-qa",              file: "schemas/dv-worker-inbox.json", strict: false  },
  { channel: "dv-status",          file: "schemas/dv-status.json",         strict: true },
  { channel: "dv-control",         file: "schemas/dv-control.json",        strict: false },
  { channel: "dv-telemetry",       file: "schemas/dv-telemetry.json",      strict: true },
  { channel: "dv-backlog",         file: "schemas/dv-backlog.json",        strict: true },
  { channel: "dv-sprint-retrospective", file: "schemas/dv-backlog.json",   strict: true },
  { channel: "dv-intel-status",    file: "schemas/dv-cluster-status.json", strict: true },
  { channel: "dv-platform-status", file: "schemas/dv-cluster-status.json", strict: true },
  { channel: "dv-consumer-status", file: "schemas/dv-cluster-status.json", strict: true },
  { channel: "dv-reviewer",        file: "schemas/reviewer-inbox.json",    strict: true },
];

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL(BROKER_URL), {
    requestInit: SECRET ? { headers: { Authorization: `Bearer ${SECRET}` } } : {},
  });
  const client = new Client({ name: "setup-schemas", version: "1.0.0" });
  await client.connect(transport);

  console.log(`[setup] broker: ${BROKER_URL}`);
  console.log(`[setup] mode:   ${STRICT ? "STRICT (reject invalid)" : "warn-only (log but allow)"}`);
  console.log();

  for (const { channel, file, strict } of REGISTRATIONS) {
    const schema = readFileSync(file, "utf-8");
    const strictMode = strict !== undefined ? strict : STRICT;
    const res = await client.callTool({
      name: "register_channel_schema",
      arguments: { channel, schema, strict: strictMode, version: JSON.parse(schema).version || "1.0" },
    });
    const text = res.content?.[0]?.text ?? "(no response)";
    console.log(`  ${channel.padEnd(22)} ← ${file}`);
    console.log(`    ${text}`);
  }

  console.log();
  const list = await client.callTool({ name: "list_channel_schemas", arguments: {} });
  console.log("[setup] registered schemas:");
  console.log(list.content[0].text);

  await transport.close();
  console.log("\n[setup] done");
}

main().catch(e => { console.error("[setup] FAIL:", e); process.exit(1); });
