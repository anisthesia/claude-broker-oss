// Register a client project channel schemas with a running broker.
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
  { channel: "ca-orchestrator",         file: "schemas/ca-orchestrator-inbox.json", strict: STRICT },
  { channel: "ca-control",              file: "schemas/ca-control.json",            strict: STRICT },
  { channel: "ca-status",               file: "schemas/ca-status.json",             strict: true },
  { channel: "ca-telemetry",            file: "schemas/ca-telemetry.json",          strict: STRICT },
  { channel: "ca-backlog",              file: "schemas/ca-backlog.json",            strict: STRICT },
  { channel: "ca-sprint-retrospective", file: "schemas/ca-backlog.json",            strict: STRICT },
  { channel: "ca-notes",                file: "schemas/notes.json",                 strict: STRICT },
  // Worker inboxes
  { channel: "ca-contracts",              file: "schemas/ca-worker-inbox.json",       strict: STRICT },
  { channel: "ca-money-core",             file: "schemas/ca-worker-inbox.json",       strict: STRICT },
  { channel: "ca-bank",                   file: "schemas/ca-worker-inbox.json",       strict: STRICT },
  { channel: "ca-inventory-risk",         file: "schemas/ca-worker-inbox.json",       strict: STRICT },
  { channel: "ca-identity-notify",        file: "schemas/ca-worker-inbox.json",       strict: STRICT },
  { channel: "ca-android",                file: "schemas/ca-worker-inbox.json",       strict: STRICT },
  { channel: "ca-console",                file: "schemas/ca-worker-inbox.json",       strict: STRICT },
  { channel: "ca-quality",                file: "schemas/ca-worker-inbox.json",       strict: STRICT },
  { channel: "ca-judge",                  file: "schemas/ca-worker-inbox.json",       strict: STRICT },
  { channel: "ca-reviewer",             file: "schemas/reviewer-inbox.json",        strict: true },
];

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL(BROKER_URL), {
    requestInit: SECRET ? { headers: { Authorization: `Bearer ${SECRET}` } } : {},
  });
  const client = new Client({ name: "setup-schemas-sm", version: "1.0.0" });
  await client.connect(transport);

  console.log(`[setup-ca] broker: ${BROKER_URL}`);
  console.log(`[setup-ca] mode:   ${STRICT ? "STRICT (reject invalid)" : "warn-only (log but allow)"}`);
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
  console.log(`[setup-ca] registered schemas:`);
  console.log(list.content[0].text);

  await transport.close();
  console.log(`\n[setup-ca] done`);
}

main().catch(e => { console.error("[setup-ca] FAIL:", e); process.exit(1); });
