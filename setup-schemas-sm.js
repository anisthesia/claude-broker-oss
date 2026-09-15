// Register SattaMatka channel schemas with a running broker.
// Usage:
//   node setup-schemas-sm.js                   # warn-only (safe default)
//   STRICT=1 node setup-schemas-sm.js          # strict (reject invalid)
//   BROKER_URL=... BROKER_SECRET=... node setup-schemas-sm.js
//
// Idempotent: re-running replaces schemas without side effects.

import { readFileSync } from "fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import "dotenv/config";

const BROKER_URL = process.env.BROKER_URL || "http://localhost:8080/mcp";
const SECRET     = process.env.BROKER_SECRET || process.env.SHARED_SECRET || "";
const STRICT     = process.env.STRICT === "1";

const REGISTRATIONS = [
  { channel: "sm-orchestrator", file: "schemas/sm-orchestrator-inbox.json", strict: STRICT },
  { channel: "sm-control",      file: "schemas/sm-control.json",            strict: STRICT },
  { channel: "sm-status",       file: "schemas/sm-status.json",             strict: false },
  { channel: "sm-telemetry",    file: "schemas/sm-telemetry.json",          strict: STRICT },
  { channel: "sm-backlog",      file: "schemas/sm-backlog.json",            strict: STRICT },
  // Worker inboxes
  { channel: "sm-contracts",    file: "schemas/sm-worker-inbox.json",       strict: STRICT },
  { channel: "sm-backend",      file: "schemas/sm-worker-inbox.json",       strict: STRICT },
  { channel: "sm-web",          file: "schemas/sm-worker-inbox.json",       strict: STRICT },
  { channel: "sm-reviewer",     file: "schemas/reviewer-inbox.json",        strict: true },
];

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL(BROKER_URL), {
    requestInit: SECRET ? { headers: { Authorization: `Bearer ${SECRET}` } } : {},
  });
  const client = new Client({ name: "setup-schemas-sm", version: "1.0.0" });
  await client.connect(transport);

  console.log(`[setup-sm] broker: ${BROKER_URL}`);
  console.log(`[setup-sm] mode:   ${STRICT ? "STRICT (reject invalid)" : "warn-only (log but allow)"}`);
  console.log();

  for (const { channel, file, strict } of REGISTRATIONS) {
    const schema = readFileSync(file, "utf-8");
    const strictMode = strict !== undefined ? strict : STRICT;
    const res = await client.callTool({
      name: "register_channel_schema",
      arguments: { channel, schema, strict: strictMode, version: JSON.parse(schema).version || "1.0" },
    });
    const text = res.content?.[0]?.text ?? "(no response)";
    console.log(`  ${channel.padEnd(28)} ← ${file}`);
    console.log(`    ${text}`);
  }

  console.log();
  const list = await client.callTool({ name: "list_channel_schemas", arguments: {} });
  console.log(`[setup-sm] registered schemas:`);
  console.log(list.content[0].text);

  await transport.close();
  console.log(`\n[setup-sm] done`);
}

main().catch(e => { console.error("[setup-sm] FAIL:", e); process.exit(1); });
