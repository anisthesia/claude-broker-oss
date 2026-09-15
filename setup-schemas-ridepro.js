// Register Ridepro channel schemas with a running broker.
// Usage:
//   node setup-schemas-ridepro.js              # defaults: localhost:8080, warn-only
//   STRICT=1 node setup-schemas-ridepro.js     # register as strict (reject invalid)
//   BROKER_URL=... SHARED_SECRET=... node setup-schemas-ridepro.js
//
// Idempotent: re-running replaces the schema for each channel.

import { readFileSync } from "fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import "dotenv/config";

const BROKER_URL = process.env.BROKER_URL || "http://localhost:8080/mcp";
const SECRET     = process.env.SHARED_SECRET || "";
const STRICT     = process.env.STRICT === "1";

// 6 worker inboxes share the worker-inbox schema; orchestrator, status, control, telemetry, backlog are distinct
//
// strict column: all 11 rp-* channels are strict as of pqa-022 (2026-06-20).
//   Schema defects fixed in pqa-022:
//     rp-worker-inbox — relaxed task_id + depends_on patterns to [a-zA-Z0-9][a-zA-Z0-9-]*; added baseline_task_id optional field
//     rp-backlog      — deferred-resolved body accepts promoted_sprint/promoted_at (in addition to resolved_in_sprint/outcome)
//     rp-status       — consent_basis + affected_files made optional on type:result
//     rp-telemetry    — added "idle-exit" to activity.state enum
const REGISTRATIONS = [
  { channel: "rp-api",          file: "schemas/rp-worker-inbox.json",       strict: false  },
  { channel: "rp-admin",        file: "schemas/rp-worker-inbox.json",       strict: false  },
  { channel: "rp-web",          file: "schemas/rp-worker-inbox.json",       strict: false  },
  { channel: "rp-android",      file: "schemas/rp-worker-inbox.json",       strict: false  },
  { channel: "rp-ios",          file: "schemas/rp-worker-inbox.json",       strict: false  },
  { channel: "rp-qa",           file: "schemas/rp-worker-inbox.json",       strict: false  },
  { channel: "rp-orchestrator", file: "schemas/rp-orchestrator-inbox.json", strict: true  },
  { channel: "rp-status",       file: "schemas/rp-status.json",             strict: false  },
  { channel: "rp-control",      file: "schemas/rp-control.json",            strict: false  },
  { channel: "rp-telemetry",    file: "schemas/rp-telemetry.json",          strict: true  },
  { channel: "rp-backlog",      file: "schemas/rp-backlog.json",            strict: true  },
  { channel: "rp-reviewer",     file: "schemas/reviewer-inbox.json",        strict: true  },
];

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL(BROKER_URL), {
    requestInit: SECRET ? { headers: { Authorization: `Bearer ${SECRET}` } } : {},
  });
  const client = new Client({ name: "setup-schemas-ridepro", version: "1.0.0" });
  await client.connect(transport);

  console.log(`[setup-ridepro] broker: ${BROKER_URL}`);
  console.log(`[setup-ridepro] mode:   ${STRICT ? "STRICT (reject invalid)" : "warn-only (log but allow)"}`);
  console.log();

  for (const { channel, file, strict: perChannelStrict } of REGISTRATIONS) {
    const schema = readFileSync(file, "utf-8");
    const strictMode = STRICT || perChannelStrict;
    const res = await client.callTool({
      name: "register_channel_schema",
      arguments: { channel, schema, strict: strictMode, version: JSON.parse(schema).version || "1.0" },
    });
    const text = res.content?.[0]?.text ?? "(no response)";
    console.log(`  ${channel.padEnd(18)} [${strictMode ? "strict" : "warn  "}] ← ${file}`);
    console.log(`    ${text}`);
  }

  console.log();
  const list = await client.callTool({ name: "list_channel_schemas", arguments: { prefix: "rp-" } });
  console.log("[setup-ridepro] registered rp-* schemas:");
  console.log(list.content[0].text);

  await transport.close();
  console.log("\n[setup-ridepro] done");
}

main().catch(e => { console.error("[setup-ridepro] FAIL:", e); process.exit(1); });
