// Register voice-platform channel schemas with a running broker.
// Usage:
//   node setup-schemas-voice.js                   # warn-only (safe default)
//   STRICT=1 node setup-schemas-voice.js          # strict (reject invalid)
//   BROKER_URL=... BROKER_SECRET=... node setup-schemas-voice.js
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
  { channel: "voice-orchestrator",        file: "schemas/voice-orchestrator-inbox.json",  strict: STRICT },
  { channel: "voice-control",             file: "schemas/voice-control.json",             strict: STRICT },
  { channel: "voice-status",              file: "schemas/voice-status.json",              strict: STRICT },
  { channel: "voice-telemetry",           file: "schemas/voice-telemetry.json",           strict: STRICT },
  { channel: "voice-backlog",             file: "schemas/voice-backlog.json",             strict: STRICT },
  { channel: "voice-sprint-retrospective",file: "schemas/voice-backlog.json",             strict: STRICT },
  { channel: "voice-notes", file: "schemas/notes.json", strict: STRICT },
  { channel: "voice-reviewer",            file: "schemas/voice-worker-inbox.json",        strict: STRICT },
  // Worker inboxes
  { channel: "voice-backend",             file: "schemas/voice-worker-inbox.json",        strict: STRICT },
  { channel: "voice-frontend",            file: "schemas/voice-worker-inbox.json",        strict: STRICT },
  { channel: "voice-voice",               file: "schemas/voice-worker-inbox.json",        strict: STRICT },
  { channel: "voice-site",                file: "schemas/voice-worker-inbox.json",        strict: STRICT },
  { channel: "voice-ops",                 file: "schemas/voice-worker-inbox.json",        strict: STRICT },
];

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL(BROKER_URL), {
    requestInit: SECRET ? { headers: { Authorization: `Bearer ${SECRET}` } } : {},
  });
  const client = new Client({ name: "setup-schemas-voice", version: "1.0.0" });
  await client.connect(transport);

  console.log(`[setup-voice] broker: ${BROKER_URL}`);
  console.log(`[setup-voice] mode:   ${STRICT ? "STRICT (reject invalid)" : "warn-only (log but allow)"}`);
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
  console.log(`[setup-voice] registered schemas:`);
  console.log(list.content[0].text);

  await transport.close();
  console.log(`\n[setup-voice] done`);
}

main().catch(e => { console.error("[setup-voice] FAIL:", e); process.exit(1); });
