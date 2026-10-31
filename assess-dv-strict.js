/**
 * Assess channels for strict schema enforcement readiness.
 * Validates the most recent messages on each channel against its registered schema.
 *
 *   node assess-dv-strict.js                      # every dv-* channel (historical default)
 *   node assess-dv-strict.js cb-status rp- dx-    # exact names and/or prefixes (trailing '-')
 *   ASSESS_LIMIT=100 node assess-dv-strict.js …   # rows per channel (default 50, max 100)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import "dotenv/config";

const BROKER_URL = process.env.BROKER_URL || "http://localhost:8080/mcp";
const SECRET = process.env.SHARED_SECRET || "";

// Mirror server.js Ajv config so schemas that compile there compile here
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

async function connect(name) {
  const headers = SECRET ? { Authorization: `Bearer ${SECRET}` } : {};
  const transport = new StreamableHTTPClientTransport(new URL(BROKER_URL), { requestInit: { headers } });
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

// read_messages emits lines like: [#42] 2026-07-06T08:00:00.000Z <sender>: {"type":...}
// plus a trailing "(next since_id: N)" line; read_last emits [42] sender: {"type":...}.
// Content may span multiple lines.
const MSG_LINE = /^\[#?(\d+)\] (?:(\S+) <([^>]*)>|([^:\s]+)):\s?(.*)$/;

function parseMessages(text) {
  if (!text || text.startsWith("No new messages")) return [];
  const raw = [];
  for (const line of text.split("\n")) {
    if (/^\(next since_id: \d+\)$/.test(line.trim())) continue;
    const m = line.match(MSG_LINE);
    if (m) {
      raw.push({ id: parseInt(m[1], 10), timestamp: m[2] || null, sender: m[3] ?? m[4], text: m[5] });
    } else if (raw.length > 0) {
      raw[raw.length - 1].text += "\n" + line;
    }
  }
  return raw.map(r => {
    let content = null; // null = non-JSON; server skips validation for these
    try { content = JSON.parse(r.text); } catch {}
    return { id: r.id, timestamp: r.timestamp, sender: r.sender, content };
  });
}

function extractJsonFromSchemaResponse(text) {
  // Schema response format: header lines, then blank line, then JSON
  const parts = text.split('\n\n');
  if (parts.length >= 2) {
    try {
      return JSON.parse(parts.slice(1).join('\n\n'));
    } catch {}
  }
  try {
    return JSON.parse(text);
  } catch {}
  return null;
}

async function main() {
  const { client, transport } = await connect("assess-dv-strict");

  console.log(`[assess-dv-strict] broker: ${BROKER_URL}\n`);

  // Get list of channels
  const res = await client.callTool({ name: "list_channels", arguments: {} });
  const channelText = res.content[0].text;
  const channels = channelText.split('\n').map(line => line.split('\t')[0]).filter(ch => ch);
  const targets = process.argv.slice(2);
  const wanted = ch => targets.length === 0
    ? ch.startsWith("dv-")
    : targets.some(t => t.endsWith("-") ? ch.startsWith(t) : ch === t);
  const dvChannels = [...new Set([...channels.filter(wanted), ...targets.filter(t => !t.endsWith("-"))])];
  const LIMIT = Math.min(100, Math.max(1, parseInt(process.env.ASSESS_LIMIT || "50", 10) || 50));

  console.log(`Found ${dvChannels.length} channel(s) matching ${targets.length ? targets.join(" ") : "dv-*"} (checking last ${LIMIT} rows each)\n`);

  const results = [];

  for (const channel of dvChannels.sort()) {
    // Get schema
    let schema = null;
    try {
      const res = await client.callTool({ name: "get_channel_schema", arguments: { channel } });
      const text = res.content[0]?.text;
      if (text) {
        schema = extractJsonFromSchemaResponse(text);
      }
    } catch {
      // No schema
    }

    if (!schema) {
      results.push({
        channel,
        schema_exists: false,
        message_count_checked: 0,
        violations: []
      });
      console.log(`⊘ ${channel}: no schema registered`);
      continue;
    }

    // Read messages
    let messages = [];
    try {
      const res = await client.callTool({ name: "read_last", arguments: { channel, n: LIMIT } });
      const text = res.content[0]?.text;
      if (text) {
        messages = parseMessages(text);
      }
    } catch {
      // No messages
    }

    // Validate messages (compile once per channel, like server.js)
    const violations = [];
    let validate = null;
    let compileError = null;
    try {
      validate = ajv.compile(schema);
    } catch (err) {
      compileError = err.message;
    }
    if (compileError) {
      violations.push({ msg_id: null, errors: [{ message: `Schema failed to compile: ${compileError}` }] });
    } else {
      for (const msg of messages) {
        if (msg.content === null) { // non-JSON content — strict channels reject it (validateContent)
          violations.push({ msg_id: msg.id, errors: [{ message: "content is not valid JSON" }] });
          continue;
        }
        const valid = validate(msg.content);
        if (!valid) {
          violations.push({
            msg_id: msg.id,
            errors: validate.errors.map(e => ({
              instancePath: e.instancePath,
              keyword: e.keyword,
              message: e.message
            }))
          });
        }
      }
    }

    results.push({
      channel,
      schema_exists: true,
      message_count_checked: messages.length,
      violations: violations.length > 0 ? violations : []
    });

    const status = violations.length === 0 && messages.length > 0 ? "✓ PASS" : violations.length === 0 ? "⊘ NO_MSGS" : `✗ FAIL (${violations.length}/${messages.length} invalid)`;
    console.log(`${status.padEnd(30)} ${channel}`);
  }

  console.log("\n[Summary]\n");
  const safe = results.filter(r => r.schema_exists && r.violations.length === 0 && r.message_count_checked > 0);
  const unsafe = results.filter(r => r.schema_exists && r.violations.length > 0);
  const noMessages = results.filter(r => r.schema_exists && r.message_count_checked === 0);
  const noSchema = results.filter(r => !r.schema_exists);

  if (safe.length > 0) {
    console.log(`Safe to flip to strict (0 violations, messages exist): ${safe.length}`);
    safe.forEach(r => console.log(`  ✓ ${r.channel}`));
  } else {
    console.log(`Safe to flip to strict (0 violations, messages exist): 0`);
  }

  if (unsafe.length > 0) {
    console.log(`\nUnsafe to flip to strict (has violations): ${unsafe.length}`);
    unsafe.forEach(r => {
      console.log(`  ✗ ${r.channel} (${r.violations.length}/${r.message_count_checked} messages invalid)`);
      r.violations.slice(0, 2).forEach(v => {
        console.log(`     - msg_id ${v.msg_id}: ${v.errors[0]?.message}`);
      });
      if (r.violations.length > 2) console.log(`     - ... and ${r.violations.length - 2} more`);
    });
  }

  if (noMessages.length > 0) {
    console.log(`\nSchema exists but no recent messages: ${noMessages.length}`);
    noMessages.forEach(r => console.log(`  ⊘ ${r.channel}`));
  }

  if (noSchema.length > 0) {
    console.log(`\nNo schema registered: ${noSchema.length}`);
    noSchema.forEach(r => console.log(`  ⊘ ${r.channel}`));
  }

  console.log("\nConclusion:");
  if (safe.length > 0) {
    console.log(`${safe.length} channel(s) are ready for strict-flip: ${safe.map(r => r.channel).join(', ')}`);
  } else if (noMessages.length > 0) {
    console.log("All matched channels have schemas but no recent messages. Safe to flip once messages are validated.");
  } else {
    console.log("Cannot flip any matched channels to strict until violations are resolved.");
  }

  await transport.close();
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
