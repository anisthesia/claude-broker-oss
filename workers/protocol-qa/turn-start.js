#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import "dotenv/config";
import { fileURLToPath } from "url";
import { dirname } from "path";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BROKER_URL = process.env.BROKER_URL || "http://localhost:8080/mcp";
const SECRET = process.env.SHARED_SECRET || "";

let lastQaId = 0;
let lastControlId = 0;

async function connect(name) {
  const headers = SECRET ? { Authorization: `Bearer ${SECRET}` } : {};
  const transport = new StreamableHTTPClientTransport(new URL(BROKER_URL), { requestInit: { headers } });
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

async function call(client, tool, args) {
  const res = await client.callTool({ name: tool, arguments: args });
  return res.content[0].text;
}

function parseReadMessagesResponse(text) {
  const lines = text.split("\n");
  const messages = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.startsWith("[#")) {
      i++;
      continue;
    }
    // Format: [#ID] timestamp <sender>: content
    // Content might span multiple lines if it's multiline JSON
    const match = line.match(/\[#(\d+)\]\s+([^\s]+)\s+<([^>]+)>:\s*(.*)/);
    if (!match) {
      i++;
      continue;
    }
    const [, idStr, timestamp, sender, firstPart] = match;

    // Collect content across lines until we have complete JSON
    let content = firstPart;
    i++;

    // If first part starts with { or [, accumulate lines until balanced
    if (firstPart.trim().startsWith("{") || firstPart.trim().startsWith("[")) {
      let braceCount = (firstPart.match(/{/g) || []).length - (firstPart.match(/}/g) || []).length;
      let bracketCount = (firstPart.match(/\[/g) || []).length - (firstPart.match(/]/g) || []).length;

      while (i < lines.length && (braceCount > 0 || bracketCount > 0)) {
        const nextLine = lines[i];
        if (nextLine.startsWith("[#") || nextLine.startsWith("(next")) {
          break; // Hit next message or footer
        }
        content += "\n" + nextLine;
        braceCount += (nextLine.match(/{/g) || []).length - (nextLine.match(/}/g) || []).length;
        bracketCount += (nextLine.match(/\[/g) || []).length - (nextLine.match(/]/g) || []).length;
        i++;
      }
    }

    messages.push({
      id: parseInt(idStr),
      sender,
      created_at: timestamp,
      content
    });
  }
  return messages;
}

async function run() {
  console.log("[protocol-qa] Turn-start ritual...\n");

  const { client, transport } = await connect("protocol-qa");

  try {
    // 1. Register capability
    console.log("1. Registering capability...");
    const regResult = await call(client, "register_capability", {
      worker: "protocol-qa",
      owns: ["schemas/", "test-*.js", "setup-schemas*.js"],
      channels: ["cb-protocol-qa", "cb-control", "cb-status", "cb-telemetry"]
    });
    console.log(`   ${regResult}\n`);

    // 1b. Emit working heartbeat (fail-soft)
    console.log("1b. Emitting working heartbeat...");
    try {
      const heartbeat = {
        type: "heartbeat",
        from: "protocol-qa",
        ts: new Date().toISOString(),
        context: {
          size_tokens: 0,
          tier_threshold_pct: 0,
          rotation_recommended: false
        },
        activity: {
          state: "working"
        }
      };
      const hbResult = await call(client, "upsert_heartbeat", {
        channel: "cb-telemetry",
        sender: "protocol-qa",
        content: JSON.stringify(heartbeat)
      });
      console.log(`   ${hbResult}\n`);
    } catch (e) {
      console.log(`   [SOFT FAIL] Heartbeat emission failed: ${e.message}\n`);
    }

    // 2. Read inbox (cb-protocol-qa)
    console.log("2. Reading cb-protocol-qa inbox...");
    const inboxResult = await call(client, "read_messages", {
      channel: "cb-protocol-qa",
      since_id: lastQaId,
      limit: 100
    });
    const inbox = parseReadMessagesResponse(inboxResult);
    console.log(`   Found ${inbox.length} message(s)`);
    if (inbox.length > 0) {
      lastQaId = Math.max(...inbox.map(m => m.id));
      inbox.forEach(m => {
        try {
          const content = JSON.parse(m.content);
          console.log(`   [${m.id}] from=${m.sender} type=${content.type} task_id=${content.task_id || '-'} subject=${content.subject || '-'}`);
          if (content.body) {
            console.log(`        body: ${JSON.stringify(content.body, null, 8).split("\n").slice(0, 5).join("\n")}`);
          }
        } catch (e) {
          console.log(`   [${m.id}] from=${m.sender} (unparseable: ${e.message})`);
        }
      });
    }
    console.log();

    // 3. Check for broadcasts (cb-control)
    console.log("3. Checking cb-control for broadcasts...");
    const hasCtrl = await call(client, "has_messages", {
      channel: "cb-control",
      since_id: lastControlId
    });
    // has_messages returns plain JSON (not formatted)
    const jsonMatch = hasCtrl.match(/\{[^}]*\}/);
    const ctrlData = jsonMatch ? JSON.parse(jsonMatch[0]) : { pending: false };
    console.log(`   has_messages: ${ctrlData.pending ? "YES" : "NO"}`);

    if (ctrlData.pending) {
      const controlResult = await call(client, "read_messages", {
        channel: "cb-control",
        since_id: lastControlId,
        limit: 100
      });
      const control = parseReadMessagesResponse(controlResult);
      if (control.length > 0) {
        lastControlId = Math.max(...control.map(m => m.id));
        console.log(`   Read ${control.length} control message(s)`);
        control.forEach(m => {
          try {
            const content = JSON.parse(m.content);
            console.log(`   [${m.id}] ${content.type}: ${content.subject || ''}`);
          } catch {
            console.log(`   [${m.id}] (unparseable)`);
          }
        });
      }
    }
    console.log();

    // Save state for next turn
    const stateFile = `${__dirname}/.protocol-qa-state.json`;
    fs.writeFileSync(stateFile, JSON.stringify({ lastQaId, lastControlId }, null, 2));

    console.log("[protocol-qa] ✓ Turn-start complete. Ready for work.");
    if (inbox.length === 0 && !ctrlData.pending) {
      console.log("[protocol-qa] No inbox or control messages. Exiting.");
    }
  } finally {
    await transport.close();
  }
}

run().catch(err => {
  console.error("[protocol-qa] ERROR:", err.message);
  process.exit(1);
});
