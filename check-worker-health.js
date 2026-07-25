/**
 * check-worker-health.js
 *
 * Detects stopped workers that have pending inbox tasks.
 * Usage:
 *   node check-worker-health.js          # dry run — report only
 *   node check-worker-health.js --fix    # auto-start blocked workers
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import "dotenv/config";

const BROKER_URL = process.env.BROKER_URL || "http://localhost:8080/mcp";
const SECRET     = process.env.SHARED_SECRET || "";
const FIX_MODE   = process.argv.includes("--fix");

const __dir = dirname(fileURLToPath(import.meta.url));

async function connect() {
  const headers = SECRET ? { Authorization: `Bearer ${SECRET}` } : {};
  const transport = new StreamableHTTPClientTransport(new URL(BROKER_URL), { requestInit: { headers } });
  const client = new Client({ name: "check-worker-health", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

async function call(client, tool, args) {
  const res = await client.callTool({ name: tool, arguments: args });
  return res.content[0].text;
}

function buildInboxMap() {
  const configFiles = ["workers.json", "workers.example.json"];
  const map = {};

  for (const file of configFiles) {
    const path = join(__dir, file);
    let entries;
    try {
      entries = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }

    for (const entry of entries) {
      const { name, ns, args = [] } = entry;
      const inboxIdx = args.indexOf("--inbox-channel");
      if (inboxIdx !== -1 && args[inboxIdx + 1]) {
        map[name] = args[inboxIdx + 1];
      } else if (ns) {
        map[name] = `${ns}-${name}`;
      }
    }
  }

  return map;
}

async function run() {
  const inboxMap = buildInboxMap();
  const { client, transport } = await connect();

  console.log(`\n[check-worker-health]  broker=${BROKER_URL}  fix=${FIX_MODE}\n`);

  // Get all workers and their running state
  const wlistRaw = await call(client, "list_workers", {});
  const lines = wlistRaw.split("\n").filter(Boolean);

  const workers = lines.map(line => {
    const [name, ...rest] = line.split("\t");
    const state = rest.join("\t");
    return { name: name.trim(), running: !state.includes("stopped") };
  });

  const stoppedWorkers = workers.filter(w => !w.running);
  const runningWorkers = workers.filter(w => w.running);

  if (stoppedWorkers.length === 0) {
    console.log(`HEALTHY: ${runningWorkers.length} workers running / BLOCKED: 0 workers stopped with pending tasks`);
    await transport.close();
    return;
  }

  // Check each stopped worker's inbox for pending messages
  const blocked = [];
  for (const worker of stoppedWorkers) {
    const inboxChannel = inboxMap[worker.name];
    if (!inboxChannel) {
      console.log(`  [skip] ${worker.name}: no inbox channel mapping found`);
      continue;
    }

    const check = JSON.parse(await call(client, "has_messages", { channel: inboxChannel, since_id: 0 }));
    if (check.pending) {
      blocked.push({ name: worker.name, channel: inboxChannel, max_id: check.max_id });
    }
  }

  const healthyCount = runningWorkers.length + (stoppedWorkers.length - blocked.length);
  console.log(`HEALTHY: ${healthyCount} workers ok / BLOCKED: ${blocked.length} workers stopped with pending tasks`);

  if (blocked.length > 0) {
    console.log("\nBlocked workers:");
    for (const w of blocked) {
      console.log(`  - ${w.name}  inbox=${w.channel}  pending_up_to_id=${w.max_id}`);
    }
  }

  if (FIX_MODE && blocked.length > 0) {
    console.log("\nFix mode: starting blocked workers...");
    for (const w of blocked) {
      try {
        const result = await call(client, "start_worker", { name: w.name });
        console.log(`  [start] ${w.name}: ${result.trim()}`);
      } catch (err) {
        console.error(`  [error] ${w.name}: ${err.message}`);
      }
    }
  } else if (blocked.length > 0) {
    console.log("\nRun with --fix to auto-start blocked workers.");
  }

  await transport.close();
}

run().catch(err => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
