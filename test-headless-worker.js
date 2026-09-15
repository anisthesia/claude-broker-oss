/**
 * Validates that `claude -p "go"` works correctly in headless/always-on mode.
 *
 * Tests four things:
 *   1. MCP broker tools are accessible in headless mode (heartbeat arrives)
 *   2. wait_for_messages blocks and reacts to incoming messages (ping→pong works)
 *   3. Rotation causes clean process exit (type:rotate → process terminates)
 *   4. A watchdog restart loop works end-to-end (process exits → restarts → heartbeat again)
 *
 * Usage:
 *   node test-headless-worker.js
 *
 * Prerequisites:
 *   - claude-broker running on http://localhost:8080/mcp
 *   - dogsvilla/headless-test/CLAUDE.md present
 *   - SHARED_SECRET set in .env
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "child_process";
import { existsSync } from "fs";
import "dotenv/config";

const BROKER_URL    = process.env.BROKER_URL    || "http://localhost:8080/mcp";
const SECRET        = process.env.SHARED_SECRET || "";
const CLAUDE_BIN    = process.env.CLAUDE_BIN    || `${process.env.HOME}/.local/bin/claude`;
const WORKER_DIR    = process.env.WORKER_DIR    || `${process.env.HOME}/myprojects/dogsvilla/headless-test`;
const TEST_INBOX    = "dv-headless-test";
const TEST_STATUS   = "dv-headless-status";
const WORKER_ID     = "headless-test";

// Timeouts (ms)
const T_HEARTBEAT   = 60_000;   // max wait for first heartbeat after start
const T_PONG        = 90_000;   // max wait for pong after ping
const T_EXIT_NOTE   = 30_000;   // max wait for idle-loop-exit note after rotate
const T_PROC_EXIT   = 20_000;   // max wait for OS process to die after exit note
const T_RESTART_HB  = 60_000;   // max wait for heartbeat after watchdog restart

let passed = 0;
let failed = 0;

function ok(label, detail) {
  console.log(`  ✓ ${label}`);
  if (detail) console.log(`    ${detail}`);
  passed++;
}

function fail(label, detail) {
  console.error(`  ✗ ${label}`);
  if (detail) console.error(`    ${String(detail).slice(0, 300)}`);
  failed++;
}

async function connect() {
  const transport = new StreamableHTTPClientTransport(new URL(BROKER_URL), {
    requestInit: SECRET ? { headers: { Authorization: `Bearer ${SECRET}` } } : {},
  });
  const client = new Client({ name: "headless-test-harness", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

async function send(client, channel, sender, content) {
  const r = await client.callTool({
    name: "send_message",
    arguments: { channel, sender, content: typeof content === "string" ? content : JSON.stringify(content) },
  });
  return r.content[0].text;
}

async function pollUntil(client, channel, sinceId, predicate, timeoutMs, intervalMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  let cursor = sinceId;
  while (Date.now() < deadline) {
    const r = await client.callTool({ name: "read_messages", arguments: { channel, since_id: cursor, limit: 20 } });
    const text = r.content[0].text;
    if (text && !text.startsWith("No messages")) {
      const lines = text.trim().split("\n");
      for (const line of lines) {
        const m = line.match(/^\[#(\d+)\] .+ <(.+?)>: (.+)$/s);
        if (!m) continue;
        const id = parseInt(m[1], 10);
        let body;
        try { body = JSON.parse(m[3]); } catch { body = m[3]; }
        if (id > cursor) cursor = id;
        const result = predicate({ id, sender: m[2], body, raw: m[3] });
        if (result) return { matched: true, id, sender: m[2], body, cursor };
      }
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return { matched: false, cursor };
}

function startWorker(cwd) {
  const proc = spawn(CLAUDE_BIN, ["-p", "go", "--dangerously-skip-permissions"], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  proc.stdout.on("data", d => process.stdout.write(`[worker] ${d}`));
  proc.stderr.on("data", d => process.stderr.write(`[worker:err] ${d}`));
  return proc;
}

function waitForExit(proc, timeoutMs) {
  return new Promise(resolve => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(false); } }, timeoutMs);
    proc.on("exit", () => { if (!done) { done = true; clearTimeout(timer); resolve(true); } });
  });
}

async function main() {
  console.log("=== headless worker validation ===");
  console.log(`broker:     ${BROKER_URL}`);
  console.log(`claude:     ${CLAUDE_BIN}`);
  console.log(`worker dir: ${WORKER_DIR}`);
  console.log("");

  // Pre-flight checks
  if (!existsSync(CLAUDE_BIN)) {
    console.error(`FATAL: claude binary not found at ${CLAUDE_BIN}`);
    console.error("Set CLAUDE_BIN env var to the correct path.");
    process.exit(1);
  }
  if (!existsSync(`${WORKER_DIR}/CLAUDE.md`)) {
    console.error(`FATAL: ${WORKER_DIR}/CLAUDE.md not found`);
    process.exit(1);
  }

  const { client, transport } = await connect();
  console.log("Connected to broker.\n");

  // ── Setup: purge test channels and capture current telemetry cursor ────────
  console.log("── Setup ──────────────────────────────────────────────────────");
  await client.callTool({ name: "purge_channel", arguments: { channel: TEST_INBOX } });
  await client.callTool({ name: "purge_channel", arguments: { channel: TEST_STATUS } });
  console.log(`  Purged ${TEST_INBOX} + ${TEST_STATUS}`);

  // Capture dv-telemetry cursor BEFORE starting worker so we only see new heartbeats
  const tlmCursor = await (async () => {
    const r = await client.callTool({ name: "list_channels", arguments: {} });
    const line = r.content[0].text.split("\n").find(l => l.startsWith("dv-telemetry"));
    const m = line?.match(/last_id=(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  })();
  console.log(`  dv-telemetry cursor: ${tlmCursor}\n`);

  // ── TEST 1: MCP tools accessible in headless mode ─────────────────────────
  console.log("── Test 1: MCP + idle loop bootstrap ──────────────────────────");
  console.log("  Starting worker via: claude -p go --dangerously-skip-permissions");
  const proc1 = startWorker(WORKER_DIR);
  const startTs = Date.now();

  console.log(`  Waiting up to ${T_HEARTBEAT / 1000}s for heartbeat on dv-telemetry...`);
  const hb1 = await pollUntil(
    client, "dv-telemetry", tlmCursor,
    ({ sender }) => sender === WORKER_ID,
    T_HEARTBEAT,
  );

  if (hb1.matched) {
    ok(`heartbeat received from "${WORKER_ID}" in ${((Date.now() - startTs) / 1000).toFixed(1)}s`,
       `msg #${hb1.id} — ${JSON.stringify(hb1.body?.activity || {})}`);
  } else {
    fail("no heartbeat received within timeout", "MCP tools may not be available in headless mode");
  }

  // ── TEST 2: wait_for_messages reacts to incoming message ──────────────────
  console.log("\n── Test 2: ping → pong (wait_for_messages reacts) ─────────────");
  const pingTaskId = `headless-ping-${Date.now()}`;
  const pingTs = Date.now();
  await send(client, TEST_INBOX, "test-harness", {
    type: "ping", task_id: pingTaskId, from: "test-harness", to: WORKER_ID,
    subject: "ping", body: { sent_ts: new Date().toISOString() },
  });
  console.log(`  Ping sent (${pingTaskId}). Waiting up to ${T_PONG / 1000}s for pong...`);

  const statusCursor = 0;
  const pong = await pollUntil(
    client, TEST_STATUS, statusCursor,
    ({ sender, body }) => sender === WORKER_ID && body?.type === "pong" && body?.task_id === pingTaskId,
    T_PONG,
  );

  if (pong.matched) {
    const latency = ((Date.now() - pingTs) / 1000).toFixed(1);
    ok(`pong received in ${latency}s`, `msg #${pong.id}`);
  } else {
    fail("no pong received within timeout", "worker may not be processing messages in headless mode");
  }

  // ── TEST 3: rotate causes clean process exit ───────────────────────────────
  console.log("\n── Test 3: rotate → clean process exit ────────────────────────");
  const rotateTaskId = `headless-rotate-${Date.now()}`;
  await send(client, TEST_INBOX, "test-harness", {
    type: "rotate", task_id: rotateTaskId, from: "test-harness", to: WORKER_ID,
    subject: "rotate — validation test", body: { reason: "test" },
  });
  console.log("  Rotate sent. Waiting for idle-loop exit note...");

  const exitNote = await pollUntil(
    client, TEST_STATUS, pong.cursor || 0,
    ({ sender, body }) =>
      sender === WORKER_ID &&
      (body?.subject?.includes("idle-loop exit") || body?.type === "status"),
    T_EXIT_NOTE,
  );

  if (exitNote.matched) {
    ok("idle-loop exit note posted", `"${exitNote.body?.subject}"`);
  } else {
    fail("no idle-loop exit note received", "worker may not handle type:rotate in headless mode");
  }

  console.log(`  Waiting up to ${T_PROC_EXIT / 1000}s for process to exit...`);
  const exited = await waitForExit(proc1, T_PROC_EXIT);
  if (exited) {
    ok(`process exited cleanly (code ${proc1.exitCode})`);
  } else {
    fail("process did not exit within timeout — session may be hanging at user prompt");
    proc1.kill("SIGTERM");
    await new Promise(r => setTimeout(r, 1000));
  }

  // ── TEST 4: watchdog restart loop ─────────────────────────────────────────
  console.log("\n── Test 4: watchdog restart → fresh heartbeat ─────────────────");
  await client.callTool({ name: "purge_channel", arguments: { channel: TEST_INBOX } });
  await client.callTool({ name: "purge_channel", arguments: { channel: TEST_STATUS } });

  // Capture new telemetry cursor (after test 1–3 activity)
  const tlmCursor2 = await (async () => {
    const r = await client.callTool({ name: "list_channels", arguments: {} });
    const line = r.content[0].text.split("\n").find(l => l.startsWith("dv-telemetry"));
    const m = line?.match(/last_id=(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  })();

  console.log("  Simulating watchdog: starting fresh session after rotation...");
  const restartTs = Date.now();
  const proc2 = startWorker(WORKER_DIR);

  const hb2 = await pollUntil(
    client, "dv-telemetry", tlmCursor2,
    ({ sender }) => sender === WORKER_ID,
    T_RESTART_HB,
  );

  if (hb2.matched) {
    ok(`restarted worker heartbeat received in ${((Date.now() - restartTs) / 1000).toFixed(1)}s`,
       "watchdog restart loop would work end-to-end");
  } else {
    fail("no heartbeat after restart within timeout");
  }

  // Clean up proc2
  proc2.kill("SIGTERM");
  await waitForExit(proc2, 5000).catch(() => {});

  // ── Cleanup ────────────────────────────────────────────────────────────────
  console.log("\n── Cleanup ────────────────────────────────────────────────────");
  await client.callTool({ name: "purge_channel", arguments: { channel: TEST_INBOX } });
  await client.callTool({ name: "purge_channel", arguments: { channel: TEST_STATUS } });
  console.log(`  Purged ${TEST_INBOX} + ${TEST_STATUS}`);

  await transport.close();

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed === 0) {
    console.log("✓ headless mode is viable — safe to roll out watchdog.sh to all workers");
  } else {
    console.log("✗ one or more checks failed — review output above before rolling out");
    console.log("  Common causes:");
    console.log("  - CLAUDE.md not loading correctly (subdirectory guard issue)");
    console.log("  - Broker MCP not in allowed tools for headless session");
    console.log("  - wait_for_messages not supported in non-interactive mode");
    console.log("  - rotate handler not producing a final text response to end the session");
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error("[test-headless-worker] FATAL:", e);
  process.exit(1);
});
