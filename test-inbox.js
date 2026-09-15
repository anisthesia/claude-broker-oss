/**
 * Tests for GET /inbox endpoint — the on-demand watchdog pre-check.
 *
 * Sends messages via the MCP send_message tool, then verifies the REST
 * /inbox endpoint returns the correct pending/count/max_id response.
 *
 * Usage:
 *   node test-inbox.js
 *   BROKER_URL=http://localhost:8080 node test-inbox.js
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from broker directory so SECRET is available without manual export
function loadDotEnv(file) {
  try {
    return Object.fromEntries(
      readFileSync(file, "utf8").split("\n")
        .filter(l => l.includes("=") && !l.startsWith("#"))
        .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
    );
  } catch { return {}; }
}
const env = loadDotEnv(resolve(__dirname, ".env"));

const BROKER_BASE = process.env.BROKER_URL  || env.BROKER_URL  || "http://localhost:8080";
const MCP_URL     = `${BROKER_BASE}/mcp`;
const SECRET      = process.env.SHARED_SECRET || env.SHARED_SECRET || "";
const AUTH_HDR = SECRET ? { Authorization: `Bearer ${SECRET}` } : {};

let passed = 0, failed = 0;

function ok(label) {
  console.log(`  ✓ ${label}`);
  passed++;
}
function fail(label, detail) {
  console.error(`  ✗ ${label}: ${detail}`);
  failed++;
}
function assert(cond, label, detail = "") {
  cond ? ok(label) : fail(label, detail || "assertion failed");
}

async function connect() {
  const headers = SECRET ? { Authorization: `Bearer ${SECRET}` } : {};
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { requestInit: { headers } });
  const client = new Client({ name: "inbox-tester", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

async function mcpCall(client, tool, args) {
  const res = await client.callTool({ name: tool, arguments: args });
  return res.content[0].text;
}

async function inbox(channel, since_id = 0) {
  const url = `${BROKER_BASE}/inbox?channel=${encodeURIComponent(channel)}&since_id=${since_id}`;
  const r = await fetch(url);
  return { status: r.status, body: await r.json() };
}

async function send(client, channel, payload) {
  return mcpCall(client, "send_message", {
    channel,
    sender: "inbox-test",
    content: JSON.stringify(payload),
  });
}

async function run() {
  const ts   = Date.now();
  const ch   = `test-inbox-${ts}`;
  const ch2  = `test-inbox-other-${ts}`;

  console.log(`\n[broker /inbox tests]  url=${BROKER_BASE}  channel=${ch}\n`);

  const { client, transport } = await connect();

  // ── 1. Empty channel ──────────────────────────────────────────────────────
  console.log("1. Empty channel");
  {
    const { status, body } = await inbox(ch);
    assert(status === 200, "HTTP 200");
    assert(body.pending === false, "pending=false on empty channel");
    assert(body.count === 0, `count=0 (got ${body.count})`);
    assert(body.max_id === 0, `max_id=0 (got ${body.max_id})`);
    assert(body.channel === ch, "channel echoed back");
    assert(body.since_id === 0, "since_id echoed back");
  }

  // ── 2. One message → pending ──────────────────────────────────────────────
  console.log("\n2. Single message");
  {
    await send(client, ch, { type: "task", task_id: "T-1", body: "first task" });
    const { body } = await inbox(ch);
    assert(body.pending === true, "pending=true after 1 message");
    assert(body.count === 1, `count=1 (got ${body.count})`);
    assert(body.max_id > 0, `max_id=${body.max_id} > 0`);
  }

  // ── 3. Cursor at max_id → no more pending ─────────────────────────────────
  console.log("\n3. Cursor at max_id");
  {
    const first = (await inbox(ch)).body;
    const { body } = await inbox(ch, first.max_id);
    assert(body.pending === false, `since_id=${first.max_id}: pending=false (cursor caught up)`);
    assert(body.count === 0, "count=0 at cursor");
    assert(body.max_id === 0, "max_id=0 when no messages after cursor");
  }

  // ── 4. New message after cursor → pending again ───────────────────────────
  console.log("\n4. New message after cursor");
  {
    const before = (await inbox(ch)).body;
    await send(client, ch, { type: "result", task_id: "T-1", body: "done" });
    const after = await inbox(ch, before.max_id);
    assert(after.body.pending === true, "pending=true after new message past cursor");
    assert(after.body.count === 1, "count=1 (only new message counted past cursor)");
    assert(after.body.max_id > before.max_id, `max_id advanced: ${after.body.max_id} > ${before.max_id}`);
  }

  // ── 5. Multiple messages accumulate ──────────────────────────────────────
  console.log("\n5. Multiple messages");
  {
    const cursor = (await inbox(ch)).body.max_id;
    for (let i = 0; i < 5; i++) {
      await send(client, ch, { type: "note", i });
    }
    const { body } = await inbox(ch, cursor);
    assert(body.pending === true, "pending=true for 5 messages");
    assert(body.count === 5, `count=5 (got ${body.count})`);
  }

  // ── 6. since_id=0 always counts everything ────────────────────────────────
  console.log("\n6. since_id=0 counts all messages");
  {
    const all = (await inbox(ch, 0)).body;
    assert(all.pending === true, "pending=true from beginning");
    assert(all.count >= 7, `all messages visible (got ${all.count}, expected >=7)`);
  }

  // ── 7. Channel isolation ──────────────────────────────────────────────────
  console.log("\n7. Channel isolation");
  {
    const before = (await inbox(ch2)).body;
    assert(before.pending === false, "ch2 starts empty");
    await send(client, ch2, { type: "task", body: "ch2 task" });
    const ch2after = (await inbox(ch2)).body;
    const ch1after = (await inbox(ch)).body;
    assert(ch2after.pending === true, "ch2 has its own pending message");
    assert(ch2after.max_id !== ch1after.max_id || ch2after.count !== ch1after.count,
      "ch1 and ch2 have independent state");
  }

  // ── 8. Error cases ────────────────────────────────────────────────────────
  console.log("\n8. Error cases");
  {
    // Missing channel
    const r1 = await fetch(`${BROKER_BASE}/inbox`, { headers: AUTH_HDR });
    assert(r1.status === 400, "missing channel → HTTP 400");
    const b1 = await r1.json();
    assert(typeof b1.error === "string", "missing channel → {error} in body");

    // Non-numeric since_id
    const r2 = await fetch(`${BROKER_BASE}/inbox?channel=${ch}&since_id=notanumber`, { headers: AUTH_HDR });
    assert(r2.status === 400, "non-numeric since_id → HTTP 400");
    const b2 = await r2.json();
    assert(typeof b2.error === "string", "non-numeric since_id → {error} in body");

    // since_id default omitted → same as 0
    const r3 = await fetch(`${BROKER_BASE}/inbox?channel=${ch}`, { headers: AUTH_HDR });
    assert(r3.status === 200, "omitting since_id → HTTP 200 (defaults to 0)");
    const b3 = await r3.json();
    assert(b3.since_id === 0, "omitted since_id echoed as 0");
  }

  // ── 9. Large since_id (beyond any message) ────────────────────────────────
  console.log("\n9. since_id beyond all messages");
  {
    const { body } = await inbox(ch, 999_999_999);
    assert(body.pending === false, "since_id beyond all messages → pending=false");
    assert(body.count === 0, "count=0 for future cursor");
  }

  // ── 10. POST /inbox/batch ─────────────────────────────────────────────────
  console.log("\n10. POST /inbox/batch");
  {
    const bch1 = `test-batch-1-${ts}`;
    const bch2 = `test-batch-2-${ts}`;
    await send(client, bch1, { type: "task", v: 1 });
    await send(client, bch1, { type: "task", v: 2 });
    await send(client, bch2, { type: "note", v: 1 });

    const r = await fetch(`${BROKER_BASE}/inbox/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HDR },
      body: JSON.stringify({ [bch1]: 0, [bch2]: 0, "nonexistent-batch-ch": 0 }),
    });
    assert(r.status === 200, "POST /inbox/batch → HTTP 200");
    const body = await r.json();
    assert(body[bch1]?.pending === true,  "batch: bch1 pending=true");
    assert(body[bch1]?.count === 2,       `batch: bch1 count=2 (got ${body[bch1]?.count})`);
    assert(body[bch2]?.pending === true,  "batch: bch2 pending=true");
    assert(body["nonexistent-batch-ch"]?.pending === false, "batch: empty channel → pending=false");

    // Cursor catches up
    const maxId1 = body[bch1].max_id;
    const r2 = await fetch(`${BROKER_BASE}/inbox/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HDR },
      body: JSON.stringify({ [bch1]: maxId1 }),
    });
    const b2 = await r2.json();
    assert(b2[bch1]?.pending === false, "batch: caught-up cursor → pending=false");

    // Array body → 400
    const r3 = await fetch(`${BROKER_BASE}/inbox/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HDR },
      body: JSON.stringify([1, 2, 3]),
    });
    assert(r3.status === 400, "batch: array body → HTTP 400");

    await mcpCall(client, "purge_channel", { channel: bch1 });
    await mcpCall(client, "purge_channel", { channel: bch2 });
  }

  // ── 11. POST /messages ────────────────────────────────────────────────────
  console.log("\n11. POST /messages");
  {
    const rch = `test-rest-msg-${ts}`;
    const authHdr = SECRET ? { Authorization: `Bearer ${SECRET}` } : {};

    const r = await fetch(`${BROKER_BASE}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHdr },
      body: JSON.stringify({ channel: rch, sender: "rest-client", content: "hello via REST" }),
    });
    assert(r.status === 200, "POST /messages → HTTP 200");
    const body = await r.json();
    assert(typeof body.id === "number" && body.id > 0, `POST /messages: id=${body.id} in response`);
    assert(body.channel === rch,          "POST /messages: channel echoed");
    assert(body.sender === "rest-client", "POST /messages: sender echoed");

    // Message visible via /inbox
    const { body: ib } = await inbox(rch, 0);
    assert(ib.pending === true, "POST /messages: message visible via /inbox");
    assert(ib.count === 1,      "POST /messages: count=1");

    // Object content is accepted (auto-stringified)
    const r2 = await fetch(`${BROKER_BASE}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHdr },
      body: JSON.stringify({ channel: rch, sender: "rest-client", content: { type: "task", v: 99 } }),
    });
    const b2 = await r2.json();
    assert(typeof b2.id === "number", "POST /messages: object content accepted");

    // Missing fields → 400
    const r3 = await fetch(`${BROKER_BASE}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHdr },
      body: JSON.stringify({ channel: rch }),
    });
    assert(r3.status === 400, "POST /messages: missing sender/content → HTTP 400");

    await mcpCall(client, "purge_channel", { channel: rch });
  }

  // ── 12. GET /workers + REST worker error paths ────────────────────────────
  console.log("\n12. GET /workers + REST worker error paths");
  {
    const authHdr = SECRET ? { Authorization: `Bearer ${SECRET}` } : {};

    const r = await fetch(`${BROKER_BASE}/workers`, { headers: authHdr });
    assert(r.status === 200, "GET /workers → HTTP 200");
    const workers = await r.json();
    assert(Array.isArray(workers),             "GET /workers: response is an array");
    assert(workers.length > 0,                 `GET /workers: at least one worker defined (got ${workers.length})`);
    assert(typeof workers[0].name === "string", "GET /workers: each entry has a name");
    assert(typeof workers[0].running === "boolean", "GET /workers: each entry has running boolean");
    assert("pid" in workers[0],                "GET /workers: each entry has pid field");

    // Unknown worker → 404
    const r2 = await fetch(`${BROKER_BASE}/workers/nonexistent-xyz/start`, { method: "POST", headers: authHdr });
    assert(r2.status === 404, "POST /workers/:name/start — unknown name → 404");

    // Stop a worker that is not running → 404
    const notRunning = workers.find(w => !w.running);
    if (notRunning) {
      const r3 = await fetch(`${BROKER_BASE}/workers/${notRunning.name}/stop`, { method: "POST", headers: authHdr });
      assert(r3.status === 404, `POST /workers/:name/stop — not running → 404`);

      // Start it, then start again → 409 conflict
      const rStart = await fetch(`${BROKER_BASE}/workers/${notRunning.name}/start`, { method: "POST", headers: authHdr });
      if (rStart.status === 503) {
        console.log("  - 409 conflict test skipped (WATCHDOG_BIN not configured)");
      } else {
        assert(rStart.status === 200, `POST /workers/${notRunning.name}/start → 200`);
        const bStart = await rStart.json();
        assert(typeof bStart.pid === "number", "POST /workers/:name/start: pid in response");

        const r409 = await fetch(`${BROKER_BASE}/workers/${notRunning.name}/start`, { method: "POST", headers: authHdr });
        assert(r409.status === 409, "POST /workers/:name/start — already running → 409");

        // Clean up
        await fetch(`${BROKER_BASE}/workers/${notRunning.name}/stop`, { method: "POST", headers: authHdr });
      }
    }
  }

  // ── 13. GET /cost ─────────────────────────────────────────────────────────
  console.log("\n13. GET /cost");
  {
    const authHdr = SECRET ? { Authorization: `Bearer ${SECRET}` } : {};

    const r = await fetch(`${BROKER_BASE}/cost`, { headers: authHdr });
    assert(r.status === 200, "GET /cost → HTTP 200");
    const body = await r.json();
    assert(typeof body.total_usd === "number",  "GET /cost: total_usd is a number");
    assert(typeof body.sessions  === "number",  "GET /cost: sessions is a number");
    assert(typeof body.since     === "string",  "GET /cost: since is an ISO string");
    assert(Array.isArray(body.by_worker),       "GET /cost: by_worker is an array");

    // since= far future → empty result
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const r2 = await fetch(`${BROKER_BASE}/cost?since=${encodeURIComponent(future)}`, { headers: authHdr });
    const b2 = await r2.json();
    assert(b2.total_usd === 0,       "GET /cost?since=future: total_usd=0");
    assert(b2.sessions  === 0,       "GET /cost?since=future: sessions=0");
    assert(b2.by_worker.length === 0, "GET /cost?since=future: by_worker empty");
  }

  await transport.close();

  console.log(`\n── ${passed} passed, ${failed} failed ──\n`);
  if (failed > 0) process.exit(1);
}

run().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
