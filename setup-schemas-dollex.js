// Register Dollex ERP channel schemas with a running broker.
// Usage:
//   node setup-schemas-dollex.js              # defaults: localhost:8080, warn-only
//   STRICT=1 node setup-schemas-dollex.js     # register as strict (reject invalid)
//   BROKER_URL=... SHARED_SECRET=... node setup-schemas-dollex.js
//
// Idempotent: re-running replaces the schema for each channel.

import { readFileSync } from "fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import "dotenv/config";

const BROKER_URL = process.env.BROKER_URL || "http://localhost:8080/mcp";
const SECRET     = process.env.SHARED_SECRET || "";
const STRICT     = process.env.STRICT === "1";

// 4 worker inboxes share the same schema; status, control, telemetry, backlog are distinct
const REGISTRATIONS = [
  { channel: "dx-api",       file: "schemas/dx-worker-inbox.json", strict: false },
  { channel: "dx-web",       file: "schemas/dx-worker-inbox.json", strict: false },
  { channel: "dx-db",        file: "schemas/dx-worker-inbox.json", strict: false },
  { channel: "dx-qa",        file: "schemas/dx-worker-inbox.json", strict: false },
  { channel: "dx-status",    file: "schemas/dx-status.json", strict: true },
  { channel: "dx-control",   file: "schemas/dx-control.json", strict: false },
  { channel: "dx-telemetry", file: "schemas/dx-telemetry.json", strict: true },
  { channel: "dx-backlog",   file: "schemas/dx-backlog.json", strict: true },
];

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL(BROKER_URL), {
    requestInit: SECRET ? { headers: { Authorization: `Bearer ${SECRET}` } } : {},
  });
  const client = new Client({ name: "setup-schemas-dollex", version: "1.0.0" });
  await client.connect(transport);

  console.log(`[setup-dollex] broker: ${BROKER_URL}`);
  console.log(`[setup-dollex] mode:   ${STRICT ? "STRICT (reject invalid)" : "warn-only (log but allow)"}`);
  console.log();

  for (const { channel, file, strict } of REGISTRATIONS) {
    const schema = readFileSync(file, "utf-8");
    const strictMode = strict !== undefined ? strict : STRICT;
    const res = await client.callTool({
      name: "register_channel_schema",
      arguments: { channel, schema, strict: strictMode, version: JSON.parse(schema).version || "1.0" },
    });
    const text = res.content?.[0]?.text ?? "(no response)";
    console.log(`  ${channel.padEnd(16)} ← ${file}`);
    console.log(`    ${text}`);
  }

  console.log();
  const list = await client.callTool({ name: "list_channel_schemas", arguments: {} });
  console.log("[setup-dollex] registered schemas:");
  console.log(list.content[0].text);

  await transport.close();
  console.log("\n[setup-dollex] done");
}

main().catch(e => { console.error("[setup-dollex] FAIL:", e); process.exit(1); });
