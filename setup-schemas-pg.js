// Register postgear (pg) channel schemas with a running broker.
// Usage:
//   node setup-schemas-pg.js                   # warn-only (safe default); pg-status + pg-reviewer always strict
//   STRICT=1 node setup-schemas-pg.js          # strict (reject invalid)
//   BROKER_URL=... BROKER_SECRET=... node setup-schemas-pg.js
//
// Idempotent: re-running replaces schemas without side effects.
// postgear (2026-10-24): personal Postiz fork; workers core, devops, reviewer; orchestrator is interactive.

import { readFileSync } from "fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import "dotenv/config";

const BROKER_URL = process.env.BROKER_URL || "http://localhost:8080/mcp";
const SECRET     = process.env.BROKER_SECRET || process.env.SHARED_SECRET || "";
const STRICT     = process.env.STRICT === "1";

const REGISTRATIONS = [
  { channel: "pg-orchestrator",         file: "schemas/pg-orchestrator-inbox.json", strict: STRICT },
  { channel: "pg-control",              file: "schemas/pg-control.json",            strict: STRICT },
  { channel: "pg-status",               file: "schemas/pg-status.json",             strict: true },
  { channel: "pg-telemetry",            file: "schemas/pg-telemetry.json",          strict: STRICT },
  { channel: "pg-backlog",              file: "schemas/pg-backlog.json",            strict: STRICT },
  { channel: "pg-sprint-retrospective", file: "schemas/pg-backlog.json",            strict: STRICT },
  { channel: "pg-notes",                file: "schemas/notes.json",                 strict: STRICT },
  { channel: "pg-reviewer",             file: "schemas/reviewer-inbox.json",        strict: true },
  // Worker inboxes
  { channel: "pg-core",                 file: "schemas/pg-worker-inbox.json",       strict: STRICT },
  { channel: "pg-devops",               file: "schemas/pg-worker-inbox.json",       strict: STRICT },
];

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL(BROKER_URL), {
    requestInit: SECRET ? { headers: { Authorization: `Bearer ${SECRET}` } } : {},
  });
  const client = new Client({ name: "setup-schemas-pg", version: "1.0.0" });
  await client.connect(transport);

  console.log(`[setup-pg] broker: ${BROKER_URL}`);
  console.log(`[setup-pg] mode:   ${STRICT ? "STRICT (reject invalid)" : "warn-only (log but allow)"}`);
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
  const lines = String(list.content?.[0]?.text ?? "").split("\n").filter(l => /\bpg-/.test(l));
  console.log(`[setup-pg] registered pg- schemas (${lines.length} lines):`);
  for (const l of lines) console.log(`  ${l.trim()}`);

  await transport.close();
  console.log(`\n[setup-pg] done`);
}

main().catch(e => { console.error("[setup-pg] FAIL:", e); process.exit(1); });
