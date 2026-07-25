// Register voice-platform channel schemas with a running broker.
// Usage:
//   node setup-schemas-vp.js                   # warn-only (safe default)
//   STRICT=1 node setup-schemas-vp.js          # strict (reject invalid)
//   BROKER_URL=... BROKER_SECRET=... node setup-schemas-vp.js
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
  { channel: "vp-orchestrator",         file: "schemas/vp-orchestrator-inbox.json", strict: STRICT },
  { channel: "vp-control",              file: "schemas/vp-control.json",            strict: STRICT },
  { channel: "vp-status",               file: "schemas/vp-status.json",             strict: STRICT },
  { channel: "vp-telemetry",            file: "schemas/vp-telemetry.json",          strict: STRICT },
  { channel: "vp-backlog",              file: "schemas/vp-backlog.json",            strict: STRICT },
  { channel: "vp-sprint-retrospective", file: "schemas/vp-backlog.json",            strict: STRICT },
  { channel: "vp-reviewer",             file: "schemas/vp-worker-inbox.json",       strict: STRICT },
  // Worker inboxes
  { channel: "vp-backend",              file: "schemas/vp-worker-inbox.json",       strict: STRICT },
  { channel: "vp-frontend",             file: "schemas/vp-worker-inbox.json",       strict: STRICT },
  { channel: "vp-voice",                file: "schemas/vp-worker-inbox.json",       strict: STRICT },
];

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL(BROKER_URL), {
    requestInit: SECRET ? { headers: { Authorization: `Bearer ${SECRET}` } } : {},
  });
  const client = new Client({ name: "setup-schemas-vp", version: "1.0.0" });
  await client.connect(transport);

  console.log(`[setup-vp] broker: ${BROKER_URL}`);
  console.log(`[setup-vp] mode:   ${STRICT ? "STRICT (reject invalid)" : "warn-only (log but allow)"}`);
  console.log();

  for (const { channel, file, strict } of REGISTRATIONS) {
    const schema = readFileSync(file, "utf-8");
    const strictMode = strict !== undefined ? strict : STRICT;
    const res = await client.callTool({
      name: "register_channel_schema",
      arguments: { channel, schema, strict: strictMode, version: "1.0" },
    });
    const text = res.content?.[0]?.text ?? "(no response)";
    console.log(`  ${channel.padEnd(28)} ← ${file}`);
    console.log(`    ${text}`);
  }

  console.log();
  const list = await client.callTool({ name: "list_channel_schemas", arguments: {} });
  console.log(`[setup-vp] registered schemas:`);
  console.log(list.content[0].text);

  await transport.close();
  console.log(`\n[setup-vp] done`);
}

main().catch(e => { console.error("[setup-vp] FAIL:", e); process.exit(1); });
