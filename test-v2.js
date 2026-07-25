/**
 * claude-broker v2 test suite
 * Tests all new features: filtering, delete, gated post, capabilities, dashboard, prune
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import "dotenv/config";

const BROKER_URL = process.env.BROKER_URL || "http://localhost:8080/mcp";
const SECRET     = process.env.SHARED_SECRET || "";

let passed = 0;
let failed = 0;

function ok(label) {
  console.log(`  ✓ ${label}`);
  passed++;
}

function fail(label, detail) {
  console.error(`  ✗ ${label}: ${detail}`);
  failed++;
}

function assert(condition, label, detail = "") {
  condition ? ok(label) : fail(label, detail || "assertion failed");
}

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

async function run() {
  const ch = `test-v2-${Date.now()}`;
  console.log(`\n[broker v2 test suite]  channel=${ch}  url=${BROKER_URL}\n`);

  const { client: a, transport: ta } = await connect("test-a");
  const { client: b, transport: tb } = await connect("test-b");

  // ── 1. Tool list ─────────────────────────────────────────────────────────
  console.log("1. Tool list");
  const tools = await a.listTools();
  const names = tools.tools.map(t => t.name);
  for (const expected of ["delete_message", "post_gated_message", "register_capability", "list_capabilities", "deregister_capability", "check_result", "has_messages", "read_last", "list_workers", "start_worker", "stop_worker"]) {
    assert(names.includes(expected), `tool '${expected}' registered`, `missing — got: ${names.join(", ")}`);
  }
  assert(names.includes("purge_channel"), "tool 'purge_channel' registered");
  assert(names.includes("purge_channels_by_prefix"), "tool 'purge_channels_by_prefix' registered");

  // ── 2. filter_sender on read_messages ─────────────────────────────────────
  console.log("\n2. filter_sender on read_messages");
  await call(a, "send_message", { channel: ch, sender: "alice", content: JSON.stringify({ type: "task", msg: "from alice" }) });
  await call(a, "send_message", { channel: ch, sender: "bob",   content: JSON.stringify({ type: "note", msg: "from bob"   }) });
  await call(a, "send_message", { channel: ch, sender: "alice", content: JSON.stringify({ type: "result", msg: "alice result" }) });

  const aliceOnly = await call(a, "read_messages", { channel: ch, since_id: 0, filter_sender: "alice" });
  assert(aliceOnly.includes("alice") && !aliceOnly.includes("bob"), "filter_sender=alice returns only alice msgs");

  const bobOnly = await call(a, "read_messages", { channel: ch, since_id: 0, filter_sender: "bob" });
  assert(bobOnly.includes("bob") && !bobOnly.includes("alice"), "filter_sender=bob returns only bob msgs");

  // ── 3. filter_type on read_messages ──────────────────────────────────────
  console.log("\n3. filter_type on read_messages");
  const taskOnly = await call(a, "read_messages", { channel: ch, since_id: 0, filter_type: "task" });
  assert(taskOnly.includes('"task"') && !taskOnly.includes('"note"') && !taskOnly.includes('"result"'), "filter_type=task returns only task msgs");

  const resultOnly = await call(a, "read_messages", { channel: ch, since_id: 0, filter_type: "result" });
  assert(resultOnly.includes('"result"') && !resultOnly.includes('"task"'), "filter_type=result returns only result msgs");

  // ── 4. filter_type on wait_for_messages ──────────────────────────────────
  console.log("\n4. filter_type on wait_for_messages");
  const wch = `test-wait-${Date.now()}`;

  // Start a wait for type:"special" in the background
  const waitPromise = call(b, "wait_for_messages", { channel: wch, since_id: 0, timeout_ms: 5000, filter_type: "special" });

  // Post a non-matching message (should be skipped)
  await new Promise(r => setTimeout(r, 100));
  await call(a, "send_message", { channel: wch, sender: "a", content: JSON.stringify({ type: "irrelevant", v: 1 }) });

  // Post the matching message
  await new Promise(r => setTimeout(r, 100));
  await call(a, "send_message", { channel: wch, sender: "a", content: JSON.stringify({ type: "special", v: 99 }) });

  const waitResult = await waitPromise;
  assert(waitResult.includes('"special"') && !waitResult.includes('"irrelevant"'), "wait_for_messages filter_type skips non-matching, wakes on match");

  // Basic wait — pre-existing messages returned immediately (no filter)
  const wch2 = `test-wait-basic-${Date.now()}`;
  await call(a, "send_message", { channel: wch2, sender: "x", content: JSON.stringify({ type: "note", v: 1 }) });
  const basicWait = await call(b, "wait_for_messages", { channel: wch2, since_id: 0 });
  assert(basicWait.includes('"note"'), "wait_for_messages basic: pre-existing message returned immediately");

  // Timeout path — empty channel, short timeout
  const wch3 = `test-wait-timeout-${Date.now()}`;
  const t0 = Date.now();
  const timedOut = await call(b, "wait_for_messages", { channel: wch3, since_id: 0, timeout_ms: 500 });
  const elapsed = Date.now() - t0;
  assert(timedOut.includes("No new messages"), "wait_for_messages timeout: returns no-messages text");
  assert(elapsed >= 400, `wait_for_messages timeout: respected (~500ms, got ${elapsed}ms)`);

  // filter_sender in wait context — non-matching sender skipped, matching sender wakes it
  const wch4 = `test-wait-fs-${Date.now()}`;
  const fswPromise = call(b, "wait_for_messages", { channel: wch4, since_id: 0, timeout_ms: 5000, filter_sender: "target" });
  await new Promise(r => setTimeout(r, 100));
  await call(a, "send_message", { channel: wch4, sender: "other",  content: JSON.stringify({ type: "note", v: 1 }) });
  await new Promise(r => setTimeout(r, 100));
  await call(a, "send_message", { channel: wch4, sender: "target", content: JSON.stringify({ type: "note", v: 2 }) });
  const fswResult = await fswPromise;
  assert(fswResult.includes("target") && !fswResult.includes("other"), "wait_for_messages filter_sender: skips non-matching sender, wakes on match");

  // ── 5. delete_message ────────────────────────────────────────────────────
  console.log("\n5. delete_message");
  const dch = `test-del-${Date.now()}`;
  await call(a, "send_message", { channel: dch, sender: "x", content: "keep me" });
  const sendRes = await call(a, "send_message", { channel: dch, sender: "x", content: "delete me" });
  // Extract id from "Sent #N to ..."
  const msgId = Number(sendRes.match(/#(\d+)/)?.[1]);
  assert(msgId > 0, `extracted message id ${msgId}`);

  const delRes = await call(a, "delete_message", { channel: dch, id: msgId });
  assert(delRes.includes("Deleted"), "delete_message returns confirmation");

  const afterDel = await call(a, "read_messages", { channel: dch, since_id: 0 });
  assert(afterDel.includes("keep me") && !afterDel.includes("delete me"), "deleted message absent, other message intact");

  // Wrong channel should fail
  const wrongChan = await a.callTool({ name: "delete_message", arguments: { channel: "wrong-channel", id: msgId } });
  assert(wrongChan.isError === true || wrongChan.content[0].text.includes("not found"), "delete_message on wrong channel returns not-found error");

  // ── 6. purge_channel older_than_ms ───────────────────────────────────────
  console.log("\n6. purge_channel with older_than_ms");
  const pch = `test-prune-${Date.now()}`;
  await call(a, "send_message", { channel: pch, sender: "x", content: "old msg" });
  await new Promise(r => setTimeout(r, 200));
  await call(a, "send_message", { channel: pch, sender: "x", content: "new msg" });

  // Prune messages older than 100ms (should remove first, keep second)
  const pruneRes = await call(a, "purge_channel", { channel: pch, older_than_ms: 100 });
  assert(pruneRes.includes("Pruned 1"), "purge_channel(older_than_ms) removes only old messages");

  const afterPrune = await call(a, "read_messages", { channel: pch, since_id: 0 });
  assert(afterPrune.includes("new msg") && !afterPrune.includes("old msg"), "recent message survives older_than_ms prune");

  // ── 6b. purge_channels_by_prefix ──────────────────────────────────────────
  console.log("\n6b. purge_channels_by_prefix");
  const prefix = `test-pfx-${Date.now()}`;
  const ch1 = `${prefix}-a`;
  const ch2 = `${prefix}-b`;
  const ch3 = `${prefix}-c`;

  await call(a, "send_message", { channel: ch1, sender: "x", content: "msg1" });
  await call(a, "send_message", { channel: ch2, sender: "x", content: "msg2" });
  await call(a, "send_message", { channel: ch3, sender: "x", content: "msg3" });

  const prefixRes = await call(a, "purge_channels_by_prefix", { prefix });
  const prefixObj = JSON.parse(prefixRes.match(/\{[\s\S]*\}/)[0]);
  assert(prefixObj.total_deleted === 3, `purge_channels_by_prefix purges all matching channels (got ${prefixObj.total_deleted})`);
  assert(prefixObj.purged.length === 3, "three channels purged");

  const afterPrefixPurge = await call(a, "read_messages", { channel: ch1, since_id: 0 });
  assert(afterPrefixPurge.includes("No new messages"), "channel after prefix purge is empty");

  // Test PRUNE_EXEMPT: create channels with different prefixes, one matching PRUNE_EXEMPT
  const exempt_prefix = "ex-backlog"; // This is in PRUNE_EXEMPT by default
  const normal_prefix = `test-noex-${Date.now()}`;
  const normal_ch = `${normal_prefix}-test`;
  await call(a, "send_message", { channel: normal_ch, sender: "x", content: "normal" });
  await call(a, "send_message", { channel: exempt_prefix, sender: "x", content: "exempt" });

  const exemptRes = await call(a, "purge_channels_by_prefix", { prefix: normal_prefix });
  const exemptObj = JSON.parse(exemptRes.match(/\{[\s\S]*\}/)[0]);
  assert(exemptObj.total_deleted >= 1, "prefix purge deletes from non-exempt channels");

  // ── 7. register_capability / list_capabilities / deregister_capability ───
  console.log("\n7. Capability registry");
  await call(a, "register_capability", { worker: "test-worker-alpha", owns: ["module-a", "module-b"], channels: ["ex-alpha", "ex-status"] });
  await call(a, "register_capability", { worker: "test-worker-beta",  owns: ["module-c"],            channels: ["ex-beta",  "ex-status"] });

  const caps = await call(a, "list_capabilities", {});
  assert(caps.includes("test-worker-alpha") && caps.includes("module-a"), "registered worker alpha visible in list");
  assert(caps.includes("test-worker-beta")  && caps.includes("module-c"), "registered worker beta visible in list");

  // Idempotent re-registration
  await call(a, "register_capability", { worker: "test-worker-alpha", owns: ["module-a", "module-b", "module-x"], channels: ["ex-alpha"] });
  const capsAfterUpdate = await call(a, "list_capabilities", {});
  assert(capsAfterUpdate.includes("module-x"), "re-registration updates existing entry");

  // Deregister
  await call(a, "deregister_capability", { worker: "test-worker-alpha" });
  await call(a, "deregister_capability", { worker: "test-worker-beta"  });
  const capsAfterDel = await call(a, "list_capabilities", {});
  assert(!capsAfterDel.includes("test-worker-alpha"), "deregistered worker alpha removed");

  // ── 8. post_gated_message ────────────────────────────────────────────────
  console.log("\n8. post_gated_message");
  const gch  = `test-gate-${Date.now()}`;
  const wsch = `test-gate-watch-${Date.now()}`;
  const taskId = `task-gate-${Date.now()}`;

  // Post gated message — should block until result lands on wsch
  const gatePromise = call(a, "post_gated_message", {
    channel:       gch,
    sender:        "orchestrator",
    content:       JSON.stringify({ type: "task", msg: "gated task released" }),
    depends_on:    [taskId],
    watch_channel: wsch,
    timeout_ms:    6000,
  });

  // Verify it hasn't posted yet (give it 200ms to register)
  await new Promise(r => setTimeout(r, 200));
  const beforeResult = await call(a, "read_messages", { channel: gch, since_id: 0 });
  assert(beforeResult.includes("No new messages"), "gated message not posted before dep satisfied");

  // Post the result that unblocks it
  await call(b, "send_message", { channel: wsch, sender: "worker", content: JSON.stringify({ type: "result", task_id: taskId, summary: "done" }) });

  const gateRes = await gatePromise;
  assert(gateRes.includes("Deps satisfied"), "post_gated_message unblocked after result posted");

  const afterGate = await call(a, "read_messages", { channel: gch, since_id: 0 });
  assert(afterGate.includes("gated task released"), "gated message now visible in channel");

  // Timeout path
  const toch = `test-gate-timeout-${Date.now()}`;
  const timeoutRes = await call(a, "post_gated_message", {
    channel:       toch,
    sender:        "orchestrator",
    content:       JSON.stringify({ type: "task", msg: "should not post" }),
    depends_on:    ["nonexistent-task-id"],
    watch_channel: `nonexistent-watch-${Date.now()}`,
    timeout_ms:    500,
  });
  assert(timeoutRes.includes("Timed out"), "post_gated_message times out when dep never arrives");

  // Immediately satisfied — result already on watch_channel before the call
  const igch  = `test-gate-imm-${Date.now()}`;
  const iwsch = `test-gate-imm-watch-${Date.now()}`;
  const iTaskId = `task-imm-${Date.now()}`;
  await call(a, "send_message", { channel: iwsch, sender: "worker", content: JSON.stringify({ type: "result", task_id: iTaskId, summary: "pre-done" }) });
  const immRes = await call(a, "post_gated_message", {
    channel:       igch,
    sender:        "orchestrator",
    content:       JSON.stringify({ type: "task", msg: "immediate gate" }),
    depends_on:    [iTaskId],
    watch_channel: iwsch,
    timeout_ms:    5000,
  });
  assert(immRes.includes("All deps satisfied immediately"), "post_gated_message: immediately satisfied path fires without waiting");
  const afterImm = await call(a, "read_messages", { channel: igch, since_id: 0 });
  assert(afterImm.includes("immediate gate"), "post_gated_message: immediately satisfied message visible in channel");

  // ── 8b. post_gated_message race condition regression (core-014) ────────────
  // core-014 fixed a race where the event listener was registered AFTER
  // re-checking allSatisfied(), missing results that arrived in that window.
  // This test ensures that register-before-check pattern stays correct.
  console.log("\n8b. post_gated_message race condition (core-014)");
  const rch   = `test-race-${Date.now()}`;
  const rwsch = `test-race-watch-${Date.now()}`;
  const rTaskId = `task-race-${Date.now()}`;
  // Satisfy dependency BEFORE calling post_gated_message
  await call(a, "send_message", { channel: rwsch, sender: "worker", content: JSON.stringify({ type: "result", task_id: rTaskId, summary: "pre-satisfied" }) });
  const raceRes = await call(a, "post_gated_message", {
    channel:       rch,
    sender:        "test-worker",
    content:       JSON.stringify({ type: "task", task_id: rTaskId, msg: "race-fix-verification" }),
    depends_on:    [rTaskId],
    watch_channel: rwsch,
    timeout_ms:    5000,
  });
  assert(raceRes.includes("All deps satisfied immediately"), "post_gated_message: dependency satisfied before call triggers immediate path");
  const afterRace = await call(a, "read_messages", { channel: rch, since_id: 0 });
  assert(afterRace.includes("race-fix-verification"), "post_gated_message: message posted immediately after dependency pre-satisfied");

  // ── 9. list_channels includes last_activity ───────────────────────────────
  console.log("\n9. list_channels last_activity");
  const chanList = await call(a, "list_channels", {});
  assert(chanList.includes("last_activity="), "list_channels output includes last_activity timestamp");

  // ── 10. Dashboard HTTP ────────────────────────────────────────────────────
  console.log("\n10. Dashboard");
  const httpBase = new URL(BROKER_URL).origin;

  // Unauthenticated requests must be rejected on both dashboard routes
  const dashNoAuth = await fetch(`${httpBase}/dashboard`);
  assert(dashNoAuth.status === 401, `dashboard unauthenticated HTTP ${dashNoAuth.status} = 401`);
  const chanNoAuth = await fetch(`${httpBase}/dashboard/channel?name=${ch}`);
  assert(chanNoAuth.status === 401, `dashboard/channel unauthenticated HTTP ${chanNoAuth.status} = 401`);

  // ?token= auth
  const dashRes = await fetch(`${httpBase}/dashboard?token=${encodeURIComponent(SECRET)}`);
  assert(dashRes.ok, `dashboard ?token= HTTP ${dashRes.status} OK`);
  const dashHtml = await dashRes.text();
  assert(dashHtml.includes("claude-broker"), "dashboard HTML contains title");
  assert(/v\d+\.\d+\.\d+/.test(dashHtml), "dashboard HTML shows a version string");
  assert(dashHtml.includes("Channels"), "dashboard HTML has Channels section");
  assert(dashHtml.includes("Worker Capabilities"), "dashboard HTML has Capabilities section");

  // Bearer-header auth
  const dashBearer = await fetch(`${httpBase}/dashboard`, { headers: { Authorization: `Bearer ${SECRET}` } });
  assert(dashBearer.ok, `dashboard Bearer HTTP ${dashBearer.status} OK`);
  const chanBearer = await fetch(`${httpBase}/dashboard/channel?name=${ch}`, { headers: { Authorization: `Bearer ${SECRET}` } });
  assert(chanBearer.ok, `dashboard/channel Bearer HTTP ${chanBearer.status} OK`);

  // /mcp auth: missing and wrong Bearer must both be rejected
  const mcpBody = JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 });
  const mcpHeaders = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const mcpNoAuth = await fetch(`${httpBase}/mcp`, { method: "POST", headers: mcpHeaders, body: mcpBody });
  assert(mcpNoAuth.status === 401, `/mcp missing Bearer HTTP ${mcpNoAuth.status} = 401`);
  const mcpWrong = await fetch(`${httpBase}/mcp`, { method: "POST", headers: { ...mcpHeaders, Authorization: "Bearer wrong-token" }, body: mcpBody });
  assert(mcpWrong.status === 401, `/mcp wrong Bearer HTTP ${mcpWrong.status} = 401`);

  // ── 11. Health endpoint includes uptime_s ────────────────────────────────
  console.log("\n11. Health endpoint");
  const healthRes = await fetch(`${httpBase}/health`);
  const health = await healthRes.json();
  assert(typeof health.uptime_s === "number" && health.uptime_s >= 0, `health includes uptime_s=${health.uptime_s}`);

  // ── 12. check_result ─────────────────────────────────────────────────────
  console.log("\n12. check_result");
  const crch  = `test-cr-${Date.now()}`;
  const crch2 = `test-cr2-${Date.now()}`;
  const crId  = `task-cr-${Date.now()}`;

  // No result posted yet → found: false
  const cr1 = JSON.parse(await call(a, "check_result", { channel: crch, task_id: crId }));
  assert(cr1.found === false, "check_result: found=false on empty channel");
  assert(cr1.task_id === crId, `check_result: task_id echoed back`);
  assert(cr1.channel === crch, `check_result: channel echoed back`);

  // type:status posted (not a result) → still found: false
  await call(a, "send_message", { channel: crch, sender: "w", content: JSON.stringify({ type: "status", task_id: crId, body: "in progress" }) });
  const cr2 = JSON.parse(await call(a, "check_result", { channel: crch, task_id: crId }));
  assert(cr2.found === false, "check_result: found=false for type:status (not a result)");

  // type:result posted → found: true
  await call(a, "send_message", { channel: crch, sender: "w", content: JSON.stringify({ type: "result", task_id: crId, body: "done" }) });
  const cr3 = JSON.parse(await call(a, "check_result", { channel: crch, task_id: crId }));
  assert(cr3.found === true, "check_result: found=true after result posted");

  // Different task_id on same channel → no cross-contamination
  const otherId = `other-${Date.now()}`;
  const cr4 = JSON.parse(await call(a, "check_result", { channel: crch, task_id: otherId }));
  assert(cr4.found === false, "check_result: different task_id on same channel → found=false");

  // Same task_id on a different channel is tracked independently
  await call(a, "send_message", { channel: crch2, sender: "w", content: JSON.stringify({ type: "result", task_id: crId, body: "done ch2" }) });
  const cr5 = JSON.parse(await call(a, "check_result", { channel: crch2, task_id: crId }));
  assert(cr5.found === true, "check_result: result on separate channel visible independently");

  // Idempotency: multiple results for same task_id → still found: true
  await call(a, "send_message", { channel: crch, sender: "w", content: JSON.stringify({ type: "result", task_id: crId, body: "duplicate" }) });
  const cr6 = JSON.parse(await call(a, "check_result", { channel: crch, task_id: crId }));
  assert(cr6.found === true, "check_result: multiple results for same task_id → found=true (stable)");

  // check_result listed in tool list
  const toolNames = tools.tools.map(t => t.name);
  assert(toolNames.includes("check_result"), "check_result registered in tool list");

  // ── 13. has_messages ─────────────────────────────────────────────────────────
  console.log("\n13. has_messages");
  const hmch = `test-hm-${Date.now()}`;

  // Empty channel → pending: false
  const hm1 = JSON.parse(await call(a, "has_messages", { channel: hmch, since_id: 0 }));
  assert(hm1.pending === false, "has_messages: empty channel → pending=false");
  assert(hm1.max_id === 0, "has_messages: empty channel → max_id=0");
  assert(hm1.channel === hmch, "has_messages: channel echoed back");

  // After posting → pending: true
  await call(a, "send_message", { channel: hmch, sender: "x", content: "hello" });
  const hm2 = JSON.parse(await call(a, "has_messages", { channel: hmch, since_id: 0 }));
  assert(hm2.pending === true, "has_messages: after post → pending=true");
  assert(hm2.max_id > 0, "has_messages: after post → max_id > 0");

  // Since current max_id → pending: false again
  const hm3 = JSON.parse(await call(a, "has_messages", { channel: hmch, since_id: hm2.max_id }));
  assert(hm3.pending === false, "has_messages: since current max_id → pending=false");

  // Post another → pending: true again
  await call(a, "send_message", { channel: hmch, sender: "x", content: "world" });
  const hm4 = JSON.parse(await call(a, "has_messages", { channel: hmch, since_id: hm2.max_id }));
  assert(hm4.pending === true, "has_messages: new message past cursor → pending=true");

  // ── 14. read_last ─────────────────────────────────────────────────────────────
  console.log("\n14. read_last");
  const rlch = `test-rl-${Date.now()}`;

  // Empty channel
  const rl0 = await call(a, "read_last", { channel: rlch, n: 5 });
  assert(rl0.includes("No messages"), "read_last: empty channel → 'No messages'");

  // Post 5 messages
  for (let i = 1; i <= 5; i++) {
    await call(a, "send_message", { channel: rlch, sender: "seq", content: JSON.stringify({ seq: i }) });
  }

  // read_last(n=3) returns last 3 in chronological order
  const rl3 = await call(a, "read_last", { channel: rlch, n: 3 });
  const lines = rl3.trim().split("\n");
  assert(lines.length === 3, `read_last n=3 returns 3 messages (got ${lines.length})`);
  assert(rl3.includes('"seq":3') && rl3.includes('"seq":4') && rl3.includes('"seq":5'), "read_last n=3 returns the 3 newest in order");
  assert(!rl3.includes('"seq":1') && !rl3.includes('"seq":2'), "read_last n=3 does not include older messages");

  // read_last(n=10) returns all 5 when fewer exist
  const rl10 = await call(a, "read_last", { channel: rlch, n: 10 });
  const lines10 = rl10.trim().split("\n");
  assert(lines10.length === 5, `read_last n=10 returns all 5 when fewer exist (got ${lines10.length})`);

  // Messages are in chronological order (oldest-first)
  const firstSeq = JSON.parse(lines10[0].replace(/^\[\d+\] \w+: /, ''));
  const lastSeq  = JSON.parse(lines10[4].replace(/^\[\d+\] \w+: /, ''));
  assert(firstSeq.seq < lastSeq.seq, "read_last returns chronological order (oldest-first)");

  // ── 15. filter_sender multi-sender ───────────────────────────────────────────
  console.log("\n15. filter_sender multi-sender");
  const msch = `test-ms-${Date.now()}`;

  await call(a, "send_message", { channel: msch, sender: "alice", content: JSON.stringify({ type: "status", v: 1 }) });
  await call(a, "send_message", { channel: msch, sender: "bob",   content: JSON.stringify({ type: "result", v: 2 }) });
  await call(a, "send_message", { channel: msch, sender: "carol", content: JSON.stringify({ type: "note",   v: 3 }) });
  await call(a, "send_message", { channel: msch, sender: "dave",  content: JSON.stringify({ type: "task",   v: 4 }) });

  // Single sender still works
  const ms1 = await call(a, "read_messages", { channel: msch, since_id: 0, filter_sender: "alice" });
  assert(ms1.includes("alice") && !ms1.includes("bob") && !ms1.includes("carol"), "filter_sender single sender still works");

  // Comma-separated multi-sender
  const ms2 = await call(a, "read_messages", { channel: msch, since_id: 0, filter_sender: "alice,bob" });
  assert(ms2.includes("alice") && ms2.includes("bob") && !ms2.includes("carol") && !ms2.includes("dave"), "filter_sender=alice,bob returns exactly those two senders");

  // Multi-sender with spaces around commas
  const ms3 = await call(a, "read_messages", { channel: msch, since_id: 0, filter_sender: "bob, carol, dave" });
  assert(ms3.includes("bob") && ms3.includes("carol") && ms3.includes("dave") && !ms3.includes("alice"), "filter_sender trims spaces around commas");

  // Multi-sender + filter_type combined
  const ms4 = await call(a, "read_messages", { channel: msch, since_id: 0, filter_sender: "alice,bob", filter_type: "result" });
  assert(ms4.includes("bob") && !ms4.includes("alice") && !ms4.includes("carol"), "filter_sender multi + filter_type combined");

  // ── 16. list_workers / start_worker / stop_worker ────────────────────────────
  console.log("\n16. Worker lifecycle tools");

  const wlist = await call(a, "list_workers", {});
  assert(wlist.includes("backend"), "list_workers: includes configured worker 'backend'");
  assert(wlist.includes("stopped") || wlist.includes("running"), "list_workers: shows running state");

  // start_worker on an unknown name returns isError
  const startBad = await a.callTool({ name: "start_worker", arguments: { name: "nonexistent-worker-xyz" } });
  assert(startBad.isError === true || startBad.content[0].text.includes("not found"), "start_worker: unknown worker returns error");

  // stop_worker on a not-running worker returns isError (use a name that is never in watchdogProcs)
  const stopIdle = await a.callTool({ name: "stop_worker", arguments: { name: "nonexistent-worker-xyz" } });
  assert(stopIdle.isError === true || stopIdle.content[0].text.includes("not running"), "stop_worker: not-running worker returns error");

  // list_workers + start + stop round-trip (only if WATCHDOG_BIN is configured)
  const wlistParsed = wlist.split("\n");
  const backendLine = wlistParsed.find(l => l.startsWith("backend\t"));
  const backendStopped = backendLine && backendLine.includes("stopped");
  if (backendStopped) {
    const startRes = await call(a, "start_worker", { name: "backend" });
    if (startRes.includes("WATCHDOG_BIN not configured")) {
      console.log("  - start_worker round-trip skipped (WATCHDOG_BIN not set)");
    } else {
      assert(startRes.includes("pid"), "start_worker: returns pid on success");
      const wlist2 = await call(a, "list_workers", {});
      assert(wlist2.includes("running"), "list_workers: backend shows running after start");
      // Idempotent start returns current pid, not error
      const startAgain = await call(a, "start_worker", { name: "backend" });
      assert(startAgain.includes("already running"), "start_worker: idempotent — already running returns info not error");
      // Stop it
      const stopRes = await call(a, "stop_worker", { name: "backend" });
      assert(stopRes.includes("Stopped"), "stop_worker: confirms stop");
      await new Promise(r => setTimeout(r, 200));
      const wlist3 = await call(a, "list_workers", {});
      const line3 = wlist3.split("\n").find(l => l.startsWith("backend\t"));
      assert(line3 && line3.includes("stopped"), "list_workers: backend shows stopped after stop");
    }
  } else {
    console.log("  - start/stop round-trip skipped (backend already running in this environment)");
  }

  // ── 16b. list_workers / start_worker / stop_worker — tmux mode ───────────
  // Guards: only runs when WORKERS_TMUX_SESSION is set in the environment.
  // Covers: core-006 (tmux-aware start/stop/list), core-007 (TMUX_BIN constant),
  //         core-009 (env var injection in spawnWatchdogTmux).
  if (process.env.WORKERS_TMUX_SESSION) {
    console.log(`\n16b. Worker lifecycle — tmux mode (session=${process.env.WORKERS_TMUX_SESSION})`);

    // list_workers output must reference tmux session when WORKERS_TMUX_SESSION is set
    const tmuxList = await call(a, "list_workers", {});
    assert(tmuxList.includes("tmux="), "list_workers (tmux): running state includes tmux= reference");
    assert(tmuxList.includes(process.env.WORKERS_TMUX_SESSION), "list_workers (tmux): state includes session name");

    const tmuxBackendLine = tmuxList.split("\n").find(l => l.startsWith("backend\t"));
    if (tmuxBackendLine && tmuxBackendLine.includes("stopped")) {
      // start_worker in tmux mode must return a tmux-specific message, not a bare pid
      const tmuxStartRes = await call(a, "start_worker", { name: "backend" });
      assert(
        tmuxStartRes.includes("tmux session") || tmuxStartRes.includes("tmux"),
        "start_worker (tmux): response mentions tmux", tmuxStartRes
      );
      assert(!tmuxStartRes.includes("WATCHDOG_BIN not configured"), "start_worker (tmux): not falling back to non-tmux path");

      // list_workers after start must show pane pid and session reference
      const tmuxList2 = await call(a, "list_workers", {});
      const tline2 = tmuxList2.split("\n").find(l => l.startsWith("backend\t"));
      assert(tline2 && tline2.includes("pid="), "list_workers (tmux): backend shows pane pid after start");
      assert(tline2 && tline2.includes("tmux="), "list_workers (tmux): backend shows tmux= reference after start");

      // stop_worker in tmux mode must confirm window was killed, not just process killed
      const tmuxStopRes = await call(a, "stop_worker", { name: "backend" });
      assert(
        tmuxStopRes.includes("killed tmux window") || tmuxStopRes.includes("Stopped"),
        "stop_worker (tmux): confirms tmux window killed", tmuxStopRes
      );

      await new Promise(r => setTimeout(r, 200));
      const tmuxList3 = await call(a, "list_workers", {});
      const tline3 = tmuxList3.split("\n").find(l => l.startsWith("backend\t"));
      assert(tline3 && tline3.includes("stopped"), "list_workers (tmux): backend shows stopped after tmux kill");
    } else if (tmuxBackendLine) {
      // Backend already running in tmux — validate list format only
      assert(tmuxBackendLine.includes("pid="),   "list_workers (tmux): running backend shows pane pid");
      assert(tmuxBackendLine.includes("tmux="),  "list_workers (tmux): running backend shows tmux= reference");
      console.log("  - tmux start/stop round-trip skipped (backend already running in tmux session)");
    }
  } else {
    console.log("\n16b. Worker lifecycle — tmux mode SKIPPED (WORKERS_TMUX_SESSION not set)");
  }

  // Tool list includes all three + sprint_file_conflicts
  assert(toolNames.includes("list_workers"),         "list_workers registered in tool list");
  assert(toolNames.includes("start_worker"),         "start_worker registered in tool list");
  assert(toolNames.includes("stop_worker"),          "stop_worker registered in tool list");
  assert(toolNames.includes("sprint_file_conflicts"),"sprint_file_conflicts registered in tool list");

  // ── 17. get_channel_schema / list_channel_schemas / clear_channel_schema ─────
  console.log("\n17. Channel schema tools (get / list / clear)");
  const ssch  = `test-schema-${Date.now()}`;
  const ssch2 = `test-schema2-${Date.now()}`;

  await call(a, "register_channel_schema", { channel: ssch,  schema: JSON.stringify({ type: "object" }), strict: false });
  await call(a, "register_channel_schema", { channel: ssch2, schema: JSON.stringify({ type: "object" }), strict: true  });

  // get_channel_schema — channel with schema
  const gcs1 = await call(a, "get_channel_schema", { channel: ssch });
  assert(gcs1.includes(ssch),    "get_channel_schema: channel name in response");
  assert(gcs1.includes("off"),   "get_channel_schema: strict=off echoed");
  assert(gcs1.includes('"type"'), "get_channel_schema: schema body returned");

  // get_channel_schema — no schema registered
  const gcs2 = await call(a, "get_channel_schema", { channel: `test-free-form-${Date.now()}` });
  assert(/No schema|free-form/.test(gcs2), "get_channel_schema: unregistered channel returns free-form text");

  // list_channel_schemas — both channels appear
  const lcs1 = await call(a, "list_channel_schemas", {});
  assert(lcs1.includes(ssch),       "list_channel_schemas: first channel listed");
  assert(lcs1.includes(ssch2),      "list_channel_schemas: second channel listed");
  assert(lcs1.includes("strict=on"), "list_channel_schemas: strict=on channel present");

  // clear_channel_schema — reverts channel to free-form
  await call(a, "clear_channel_schema", { channel: ssch });
  const gcs3 = await call(a, "get_channel_schema", { channel: ssch });
  assert(/No schema|free-form/.test(gcs3), "clear_channel_schema: channel reverts to free-form after clear");

  // cleared channel no longer appears in list
  const lcs2 = await call(a, "list_channel_schemas", {});
  assert(!lcs2.split("\n").some(l => l.startsWith(ssch + "\t")), "list_channel_schemas: cleared channel no longer listed");

  // register_channel_schema — non-JSON input → isError
  const badJsonRes = await a.callTool({ name: "register_channel_schema", arguments: { channel: ssch, schema: "not { valid json", strict: false } });
  assert(badJsonRes.isError === true,                          "register_channel_schema: non-JSON input → isError");
  assert(/not valid JSON/.test(badJsonRes.content[0].text),   "register_channel_schema: non-JSON error message");

  // register_channel_schema — valid JSON but non-compiling schema → isError
  const badSchemaRes = await a.callTool({ name: "register_channel_schema", arguments: { channel: ssch, schema: JSON.stringify({ properties: { x: { multipleOf: -1 } } }), strict: false } });
  assert(badSchemaRes.isError === true,                          "register_channel_schema: non-compiling schema → isError");
  assert(/does not compile/.test(badSchemaRes.content[0].text), "register_channel_schema: non-compiling error message");

  // cleanup second schema channel
  await call(a, "clear_channel_schema", { channel: ssch2 });

  // ── 18. get_latest_heartbeats ────────────────────────────────────────────────
  console.log("\n18. get_latest_heartbeats");
  const hbch = `test-hb-${Date.now()}`;

  // Upsert 2 heartbeats: one normal, one rotation-recommended (tier_threshold_pct >= 80)
  await call(a, "upsert_heartbeat", {
    channel: hbch,
    sender:  "worker-normal",
    content: JSON.stringify({
      activity: { state: "active" },
      context:  { tier_threshold_pct: 40, rotation_recommended: false },
    }),
  });
  await call(a, "upsert_heartbeat", {
    channel: hbch,
    sender:  "worker-rotating",
    content: JSON.stringify({
      activity: { state: "active" },
      context:  { tier_threshold_pct: 85, rotation_recommended: true },
    }),
  });

  const hbRaw = await call(a, "get_latest_heartbeats", { channel: hbch });
  let hbResult;
  try {
    hbResult = JSON.parse(hbRaw);
    assert(true, "get_latest_heartbeats: response is valid JSON");
  } catch (e) {
    assert(false, "get_latest_heartbeats: response is valid JSON", e.message);
  }

  assert(Array.isArray(hbResult?.workers), "get_latest_heartbeats: workers is an array");
  assert(hbResult?.workers?.length === 2, `get_latest_heartbeats: 2 workers returned (got ${hbResult?.workers?.length})`);

  // Each worker entry must contain the required fields
  for (const w of (hbResult?.workers ?? [])) {
    for (const f of ["sender", "state", "tier_threshold_pct", "rotation_recommended"]) {
      assert(f in w, `get_latest_heartbeats: worker '${w.sender}' has field '${f}'`);
    }
  }

  const normalW   = hbResult?.workers?.find(w => w.sender === "worker-normal");
  const rotatingW = hbResult?.workers?.find(w => w.sender === "worker-rotating");
  assert(normalW?.rotation_recommended === false,  "get_latest_heartbeats: normal worker rotation_recommended=false");
  assert(rotatingW?.rotation_recommended === true, "get_latest_heartbeats: rotating worker rotation_recommended=true");
  assert(rotatingW?.tier_threshold_pct >= 80,      `get_latest_heartbeats: rotating worker tier_threshold_pct>=80 (got ${rotatingW?.tier_threshold_pct})`);

  assert(hbResult?.summary?.total_workers === 2,
    `get_latest_heartbeats: summary.total_workers=2 (got ${hbResult?.summary?.total_workers})`);
  assert(
    Array.isArray(hbResult?.summary?.rotating) && hbResult.summary.rotating.includes("worker-rotating"),
    "get_latest_heartbeats: summary.rotating includes 'worker-rotating'",
  );
  assert(
    Array.isArray(hbResult?.summary?.stale_5min) && hbResult.summary.stale_5min.length === 0,
    "get_latest_heartbeats: summary.stale_5min is empty (just posted)",
  );

  assert(toolNames.includes("get_latest_heartbeats"), "get_latest_heartbeats: registered in tool list");
  assert(toolNames.includes("upsert_heartbeat"),       "upsert_heartbeat: registered in tool list");

  // ── 19. Uncovered tool coverage ──────────────────────────────────────────────
  console.log("\n19. Uncovered tool coverage");

  // 19a. send_message_batch
  const bch1 = `test-batch-${Date.now()}`;
  const bch2 = `test-batch2-${Date.now()}`;
  const batchRes = await call(a, "send_message_batch", {
    messages: [
      { channel: bch1, sender: "alice", content: JSON.stringify({ type: "task", v: 1 }) },
      { channel: bch1, sender: "bob",   content: JSON.stringify({ type: "task", v: 2 }) },
      { channel: bch2, sender: "carol", content: JSON.stringify({ type: "task", v: 3 }) },
    ],
  });
  assert(batchRes.includes("Sent 3 messages"), `send_message_batch: reports 3 sent (got: ${batchRes.slice(0, 60)})`);
  const afterBatch1 = await call(a, "read_messages", { channel: bch1, since_id: 0 });
  assert(afterBatch1.includes('"v":1') && afterBatch1.includes('"v":2'), "send_message_batch: both messages arrived on bch1");
  const afterBatch2 = await call(a, "read_messages", { channel: bch2, since_id: 0 });
  assert(afterBatch2.includes('"v":3'), "send_message_batch: message arrived on bch2");
  assert(toolNames.includes("send_message_batch"), "send_message_batch: registered in tool list");

  // 19b. check_results_batch
  const crbch  = `test-crb-${Date.now()}`;
  const crbId1 = `task-crb1-${Date.now()}`;
  const crbId2 = `task-crb2-${Date.now()}`;
  const crbId3 = `task-crb3-${Date.now()}`;
  await call(a, "send_message", { channel: crbch, sender: "w", content: JSON.stringify({ type: "result", task_id: crbId1, summary: "PASS" }) });
  await call(a, "send_message", { channel: crbch, sender: "w", content: JSON.stringify({ type: "result", task_id: crbId2, summary: "PASS" }) });
  const crbRaw    = await call(a, "check_results_batch", { channel: crbch, task_ids: [crbId1, crbId2, crbId3] });
  const crbResult = JSON.parse(crbRaw);
  assert(crbResult.channel === crbch,              "check_results_batch: channel echoed back");
  assert(crbResult.results[crbId1] === true,        "check_results_batch: found=true for task with result");
  assert(crbResult.results[crbId2] === true,        "check_results_batch: found=true for second task with result");
  assert(crbResult.results[crbId3] === false,       "check_results_batch: found=false for task without result");
  assert(toolNames.includes("check_results_batch"), "check_results_batch: registered in tool list");

  // 19c. get_latest_per_sender
  const gpsInbox = `test-gps-${Date.now()}`;
  await call(a, "send_message", { channel: gpsInbox, sender: "worker-a", content: JSON.stringify({ v: 1 }) });
  await call(a, "send_message", { channel: gpsInbox, sender: "worker-b", content: JSON.stringify({ v: 2 }) });
  await call(a, "send_message", { channel: gpsInbox, sender: "worker-a", content: JSON.stringify({ v: 3 }) });
  const gpsRaw   = await call(a, "get_latest_per_sender", { channel: gpsInbox });
  const gpsLines = gpsRaw.trim().split("\n").filter(l => l.trim());
  assert(gpsLines.length === 2,                                       `get_latest_per_sender: 2 entries (one per sender, got ${gpsLines.length})`);
  assert(gpsRaw.includes("worker-a") && gpsRaw.includes("worker-b"), "get_latest_per_sender: both senders present");
  assert(gpsRaw.includes('"v":3') && !gpsRaw.includes('"v":1'),      "get_latest_per_sender: returns only latest per sender (v:3 not v:1)");
  const gpsEmpty = await call(a, "get_latest_per_sender", { channel: `test-gps-empty-${Date.now()}` });
  assert(gpsEmpty.includes("No messages"),                            "get_latest_per_sender: empty channel → 'No messages'");
  assert(toolNames.includes("get_latest_per_sender"),                 "get_latest_per_sender: registered in tool list");

  // 19d. turn_start
  const tsInbox = `test-ts-inbox-${Date.now()}`;
  const tsCtrl  = `test-ts-ctrl-${Date.now()}`;
  const tsCtrl2 = `test-ts-ctrl2-${Date.now()}`;
  await call(a, "send_message", { channel: tsInbox, sender: "orch", content: JSON.stringify({ type: "task", task_id: "t1" }) });
  await call(a, "send_message", { channel: tsCtrl,  sender: "orch", content: JSON.stringify({ type: "note", subject: "broadcast" }) });
  const tsRaw    = await call(a, "turn_start", { inbox_channel: tsInbox, control_channel: tsCtrl, inbox_since_id: 0, control_since_id: 0 });
  const tsResult = JSON.parse(tsRaw);
  assert(Array.isArray(tsResult.inbox),                          "turn_start: inbox is an array");
  assert(Array.isArray(tsResult.control),                        "turn_start: control is an array");
  assert(typeof tsResult.rotate_requested === "boolean",         "turn_start: rotate_requested is boolean");
  assert(typeof tsResult.inbox_next_id    === "number",          "turn_start: inbox_next_id is a number");
  assert(typeof tsResult.control_next_id  === "number",          "turn_start: control_next_id is a number");
  assert(tsResult.inbox.length   === 1,                          "turn_start: one inbox message returned");
  assert(tsResult.control.length === 1,                          "turn_start: one control message returned");
  assert(tsResult.rotate_requested === false,                    "turn_start: rotate_requested=false (no rotate msg)");
  await call(a, "send_message", { channel: tsCtrl2, sender: "orch", content: JSON.stringify({ type: "rotate", reason: "context" }) });
  const tsRaw2    = await call(a, "turn_start", { inbox_channel: tsInbox, control_channel: tsCtrl2 });
  const tsResult2 = JSON.parse(tsRaw2);
  assert(tsResult2.rotate_requested === true,                    "turn_start: rotate_requested=true when control has rotate message");
  assert(toolNames.includes("turn_start"),                       "turn_start: registered in tool list");

  // 19e. sprint_summary
  const ssStatus = `test-ss-status-${Date.now()}`;
  await call(a, "send_message", { channel: ssStatus, sender: "w", content: JSON.stringify({ type: "result", task_id: "t1", summary: "PASS — done" }) });
  await call(a, "send_message", { channel: ssStatus, sender: "w", content: JSON.stringify({ type: "result", task_id: "t2", summary: "FAIL — broken" }) });
  const ssRaw    = await call(a, "sprint_summary", { status_channel: ssStatus });
  const ssResult = JSON.parse(ssRaw);
  assert(ssResult.status_channel === ssStatus,    "sprint_summary: status_channel echoed back");
  assert(typeof ssResult.dispatched === "number", "sprint_summary: dispatched is a number");
  assert(typeof ssResult.completed  === "number", "sprint_summary: completed is a number");
  assert(typeof ssResult.failed     === "number", "sprint_summary: failed is a number");
  assert(typeof ssResult.pending    === "number", "sprint_summary: pending is a number");
  assert(ssResult.completed === 2,                `sprint_summary: completed=2 (got ${ssResult.completed})`);
  assert(ssResult.failed    === 1,                `sprint_summary: failed=1 (got ${ssResult.failed})`);
  assert(ssResult.sprint    === null,             "sprint_summary: sprint=null when control_channel omitted");
  assert(toolNames.includes("sprint_summary"),    "sprint_summary: registered in tool list");

  // 19f. sprint_file_conflicts
  const sfcStatus = `test-sfc-status-${Date.now()}`;
  // worker-a and worker-b both touch file-x.ts → conflict; file-a.ts and file-y.ts are single-owner → clean
  await call(a, "send_message", { channel: sfcStatus, sender: "worker-a", content: JSON.stringify({ type: "result", from: "worker-a", task_id: "ta1", summary: "PASS", affected_files: ["file-x.ts", "file-a.ts"] }) });
  await call(a, "send_message", { channel: sfcStatus, sender: "worker-b", content: JSON.stringify({ type: "result", from: "worker-b", task_id: "tb1", summary: "PASS", affected_files: ["file-x.ts"] }) });
  await call(a, "send_message", { channel: sfcStatus, sender: "worker-c", content: JSON.stringify({ type: "result", from: "worker-c", task_id: "tc1", summary: "PASS", affected_files: ["file-y.ts"] }) });
  await call(a, "send_message", { channel: sfcStatus, sender: "worker-d", content: JSON.stringify({ type: "result", from: "worker-d", task_id: "td1", summary: "PASS" }) });
  const sfcRaw    = await call(a, "sprint_file_conflicts", { status_channel: sfcStatus });
  const sfcResult = JSON.parse(sfcRaw);
  assert(sfcResult.status_channel === sfcStatus,                  "sprint_file_conflicts: status_channel echoed back");
  assert(typeof sfcResult.since_id    === "number",               "sprint_file_conflicts: since_id is a number");
  assert(Array.isArray(sfcResult.conflicts),                      "sprint_file_conflicts: conflicts is an array");
  assert(typeof sfcResult.clean_count === "number",               "sprint_file_conflicts: clean_count is a number");
  assert(Array.isArray(sfcResult.blind_spots),                    "sprint_file_conflicts: blind_spots is an array");
  assert(typeof sfcResult.summary     === "string",               "sprint_file_conflicts: summary is a string");
  assert(sfcResult.conflicts.length   === 1,                      `sprint_file_conflicts: 1 conflict detected (got ${sfcResult.conflicts.length})`);
  assert(sfcResult.conflicts[0].file  === "file-x.ts",            "sprint_file_conflicts: conflicting file is file-x.ts");
  assert(
    sfcResult.conflicts[0].workers.includes("worker-a") &&
    sfcResult.conflicts[0].workers.includes("worker-b"),
    "sprint_file_conflicts: conflict involves worker-a and worker-b",
  );
  assert(sfcResult.clean_count === 2,                             `sprint_file_conflicts: clean_count=2 (file-a.ts + file-y.ts, got ${sfcResult.clean_count})`);
  assert(sfcResult.blind_spots.includes("worker-d"),              "sprint_file_conflicts: worker-d in blind_spots");
  assert(sfcResult.summary.includes("conflict"),                  "sprint_file_conflicts: summary mentions conflict");
  assert(toolNames.includes("sprint_file_conflicts"),             "sprint_file_conflicts: registered in tool list");

  // ── 20. register_worker / deregister_worker ──────────────────────────────
  console.log("\n20. Worker registration (register_worker / deregister_worker)");

  const testWorkerName = "test-hotplug-worker";

  // 20a. register_worker happy path
  const regRes = await call(a, "register_worker", {
    name: testWorkerName,
    ns: "test",
    worker_dir: "workers/test",
    repo_root: "/tmp/test-repo",
    inbox_channel: "test-hotplug",
  });
  assert(!regRes.includes("isError") && !regRes.includes("error"), `register_worker: success (got: ${regRes.slice(0, 60)})`);
  assert(regRes.includes(testWorkerName) || regRes.includes("registered"), "register_worker: response confirms registration");
  assert(toolNames.includes("register_worker"), "register_worker: registered in tool list");

  // 20b. list_workers shows newly registered worker
  const listAfterReg = await call(a, "list_workers", {});
  assert(listAfterReg.includes(testWorkerName), "list_workers: newly registered worker appears in list");

  // 20c. deregister_worker happy path
  const deregRes = await call(a, "deregister_worker", { name: testWorkerName });
  assert(!deregRes.includes("isError") && !deregRes.includes("error"), `deregister_worker: success (got: ${deregRes.slice(0, 60)})`);
  assert(deregRes.includes(testWorkerName) || deregRes.includes("deregistered"), "deregister_worker: response confirms deregistration");
  assert(toolNames.includes("deregister_worker"), "deregister_worker: registered in tool list");

  // 20d. list_workers confirms worker gone after deregister
  const listAfterDereg = await call(a, "list_workers", {});
  assert(!listAfterDereg.includes(testWorkerName), "list_workers: deregistered worker no longer appears in list");

  // 20e. deregister_worker on nonexistent name returns error
  const deregNonexistent = await a.callTool({ name: "deregister_worker", arguments: { name: "nonexistent-worker-xyz" } });
  assert(deregNonexistent.isError === true || deregNonexistent.content[0].text.includes("not found") || deregNonexistent.content[0].text.includes("error"),
    "deregister_worker: nonexistent worker returns error");

  // 20f. register_worker with missing required field returns error
  const regMissing = await a.callTool({ name: "register_worker", arguments: { name: testWorkerName } });
  assert(regMissing.isError === true || regMissing.content[0].text.includes("required") || regMissing.content[0].text.includes("error"),
    "register_worker: missing required field returns error");

  // 20g. register_worker with same name is upsert (succeeds, not error)
  const regUpsert1 = await call(a, "register_worker", {
    name: testWorkerName,
    ns: "test",
    worker_dir: "workers/test",
    repo_root: "/tmp/test-repo",
    inbox_channel: "test-hotplug",
  });
  assert(!regUpsert1.includes("isError") && !regUpsert1.includes("error"),
    "register_worker: duplicate registration (upsert) succeeds, not error");
  const regUpsert2 = await call(a, "register_worker", {
    name: testWorkerName,
    ns: "test",
    worker_dir: "workers/test-updated",
    repo_root: "/tmp/test-repo2",
    inbox_channel: "test-hotplug-updated",
  });
  assert(!regUpsert2.includes("isError") && !regUpsert2.includes("error"),
    "register_worker: second upsert with different config succeeds");

  // 20h. Cleanup: deregister test worker if still registered (defensive afterAll)
  try {
    const finalDereg = await call(a, "deregister_worker", { name: testWorkerName });
    ok("register_worker/deregister_worker: cleanup deregistration succeeded");
  } catch (e) {
    // Already deregistered or error is OK here (cleanup phase)
  }

  // ── 21. Extended coverage ────────────────────────────────────────────────────
  console.log("\n21. Extended coverage");

  // Gap 1: upsert_heartbeat deduplication
  const ext_hb_dedup = `test-ext-hb-dedup-${Date.now()}`;
  await call(a, "upsert_heartbeat", {
    channel: ext_hb_dedup,
    sender: "sender-1",
    content: JSON.stringify({ v: 1 }),
  });
  await call(a, "upsert_heartbeat", {
    channel: ext_hb_dedup,
    sender: "sender-1",
    content: JSON.stringify({ v: 2 }),
  });
  await call(a, "upsert_heartbeat", {
    channel: ext_hb_dedup,
    sender: "sender-1",
    content: JSON.stringify({ v: 3 }),
  });
  const hb_dedup_raw = await call(a, "get_latest_per_sender", { channel: ext_hb_dedup });
  const hb_dedup_lines = hb_dedup_raw.trim().split("\n").filter(l => l.trim());
  assert(hb_dedup_lines.length === 1, `upsert_heartbeat dedup: exactly 1 entry (got ${hb_dedup_lines.length})`);
  assert(hb_dedup_raw.includes('"v":3') && !hb_dedup_raw.includes('"v":1') && !hb_dedup_raw.includes('"v":2'),
    "upsert_heartbeat dedup: only latest heartbeat returned (v:3)");

  // Gap 2: sprint_summary with control_channel
  const ext_ss_ctrl = `test-ext-ss-ctrl-${Date.now()}`;
  const ext_ss_status = `test-ext-ss-status-${Date.now()}`;
  await call(a, "send_message", { channel: ext_ss_status, sender: "w", content: JSON.stringify({ type: "result", task_id: "t1" }) });
  await call(a, "send_message", { channel: ext_ss_ctrl, sender: "orch", content: JSON.stringify({ type: "note", subject: "sprint-001", body: "sprint boundary" }) });
  const ss_ctrl_raw = await call(a, "sprint_summary", { status_channel: ext_ss_status, control_channel: ext_ss_ctrl });
  const ss_ctrl_result = JSON.parse(ss_ctrl_raw);
  assert(ss_ctrl_result.sprint !== null && ss_ctrl_result.sprint !== undefined, "sprint_summary with control_channel: sprint is not null");
  assert(ss_ctrl_result.sprint.subject === "sprint-001", `sprint_summary: subject matches ('sprint-001', got '${ss_ctrl_result.sprint.subject}')`);

  // Gap 3: purge_channels_by_prefix with older_than_ms
  const ext_pfx_ch1 = `test-ext-pfx-prune1-${Date.now()}`;
  const ext_pfx_ch2 = `test-ext-pfx-prune2-${Date.now()}`;
  const ext_purge_prefix = "test-ext-pfx-prune";
  await call(a, "send_message", { channel: ext_pfx_ch1, sender: "x", content: "old1" });
  await call(a, "send_message", { channel: ext_pfx_ch2, sender: "x", content: "old2" });
  await new Promise(r => setTimeout(r, 200));
  await call(a, "send_message", { channel: ext_pfx_ch1, sender: "x", content: "new1" });
  await call(a, "send_message", { channel: ext_pfx_ch2, sender: "x", content: "new2" });
  await call(a, "purge_channels_by_prefix", { prefix: ext_purge_prefix, older_than_ms: 100 });
  const after_pfx_prune1 = await call(a, "read_messages", { channel: ext_pfx_ch1, since_id: 0 });
  const after_pfx_prune2 = await call(a, "read_messages", { channel: ext_pfx_ch2, since_id: 0 });
  assert(!after_pfx_prune1.includes("old1") && after_pfx_prune1.includes("new1"),
    "purge_channels_by_prefix older_than_ms: old msg removed, new msg kept (ch1)");
  assert(!after_pfx_prune2.includes("old2") && after_pfx_prune2.includes("new2"),
    "purge_channels_by_prefix older_than_ms: old msg removed, new msg kept (ch2)");

  // Gap 4: purge_channel full purge
  const ext_purge_full = `test-ext-purge-full-${Date.now()}`;
  await call(a, "send_message", { channel: ext_purge_full, sender: "x", content: "msg1" });
  await call(a, "send_message", { channel: ext_purge_full, sender: "x", content: "msg2" });
  await call(a, "purge_channel", { channel: ext_purge_full });
  const after_full_purge = await call(a, "read_messages", { channel: ext_purge_full, since_id: 0 });
  assert(after_full_purge.includes("No new messages"), "purge_channel full purge: returns 'No new messages' after purge");

  // Gap 5: sprint_file_conflicts with since_id filtering
  const ext_sfc_since = `test-ext-sfc-since-${Date.now()}`;
  const msg1 = await call(a, "send_message", { channel: ext_sfc_since, sender: "worker-1", content: JSON.stringify({ type: "result", task_id: "t1", summary: "PASS", affected_files: ["file-x.ts"] }) });
  const id1 = Number(msg1.match(/#(\d+)/)?.[1]);
  await call(a, "send_message", { channel: ext_sfc_since, sender: "worker-1", content: JSON.stringify({ type: "result", task_id: "t2", summary: "PASS", affected_files: ["file-x.ts"] }) });
  const sfc_since_raw = await call(a, "sprint_file_conflicts", { status_channel: ext_sfc_since, since_id: id1 });
  const sfc_since_result = JSON.parse(sfc_since_raw);
  assert(sfc_since_result.conflicts.length === 0, `sprint_file_conflicts with since_id: no conflicts (first result excluded, got ${sfc_since_result.conflicts.length})`);

  // Gap 6: sprint_file_conflicts no-conflict clean case
  const ext_sfc_clean = `test-ext-sfc-clean-${Date.now()}`;
  await call(a, "send_message", { channel: ext_sfc_clean, sender: "worker-a", content: JSON.stringify({ type: "result", task_id: "ta", summary: "PASS — done", affected_files: ["file-a.ts"] }) });
  await call(a, "send_message", { channel: ext_sfc_clean, sender: "worker-b", content: JSON.stringify({ type: "result", task_id: "tb", summary: "PASS — done", affected_files: ["file-b.ts"] }) });
  const sfc_clean_raw = await call(a, "sprint_file_conflicts", { status_channel: ext_sfc_clean });
  const sfc_clean_result = JSON.parse(sfc_clean_raw);
  assert(sfc_clean_result.conflicts.length === 0, `sprint_file_conflicts no-conflict: conflicts.length===0 (got ${sfc_clean_result.conflicts.length})`);
  assert(sfc_clean_result.clean_count === 2, `sprint_file_conflicts no-conflict: clean_count===2 (got ${sfc_clean_result.clean_count})`);
  assert(sfc_clean_result.summary.includes("safe"), "sprint_file_conflicts no-conflict: summary includes 'safe'");

  // Gap 7: sprint_file_conflicts SKIP filtering
  const ext_sfc_skip = `test-ext-sfc-skip-${Date.now()}`;
  await call(a, "send_message", { channel: ext_sfc_skip, sender: "worker-1", content: JSON.stringify({ type: "result", task_id: "t-skip", summary: "SKIP — idempotent", affected_files: ["skip-file.ts"] }) });
  await call(a, "send_message", { channel: ext_sfc_skip, sender: "worker-2", content: JSON.stringify({ type: "result", task_id: "t-norm", summary: "PASS — done", affected_files: ["skip-file.ts"] }) });
  const sfc_skip_raw = await call(a, "sprint_file_conflicts", { status_channel: ext_sfc_skip });
  const sfc_skip_result = JSON.parse(sfc_skip_raw);
  assert(sfc_skip_result.conflicts.length === 0, `sprint_file_conflicts SKIP filter: conflicts empty after filtering (got ${sfc_skip_result.conflicts.length})`);

  // Gap 8: check_result summary field
  const ext_cr_summary = `test-ext-cr-summary-${Date.now()}`;
  await call(a, "send_message", { channel: ext_cr_summary, sender: "w", content: JSON.stringify({ type: "result", task_id: "summary-test", summary: "PASS — all good" }) });
  const cr_summary_raw = await call(a, "check_result", { channel: ext_cr_summary, task_id: "summary-test" });
  const cr_summary_result = JSON.parse(cr_summary_raw);
  assert(cr_summary_result.summary === "PASS — all good", `check_result summary: summary field matches (got '${cr_summary_result.summary}')`);

  // Gap 9: get_latest_heartbeats empty channel
  const ext_hb_empty = `test-ext-hb-empty-${Date.now()}`;
  const hb_empty_raw = await call(a, "get_latest_heartbeats", { channel: ext_hb_empty });
  const hb_empty_result = JSON.parse(hb_empty_raw);
  assert(Array.isArray(hb_empty_result.workers), "get_latest_heartbeats empty: workers is an array");
  assert(hb_empty_result.workers.length === 0, `get_latest_heartbeats empty: workers array empty (got ${hb_empty_result.workers.length})`);
  assert(hb_empty_result.summary.total_workers === 0, `get_latest_heartbeats empty: total_workers===0 (got ${hb_empty_result.summary.total_workers})`);

  // Gap 10: list_channel_schemas with prefix
  const ext_schema_pfx1 = `test-ext-pfx1-ch-${Date.now()}`;
  const ext_schema_pfx2 = `test-ext-pfx2-ch-${Date.now()}`;
  await call(a, "register_channel_schema", { channel: ext_schema_pfx1, schema: JSON.stringify({ type: "object" }), strict: false });
  await call(a, "register_channel_schema", { channel: ext_schema_pfx2, schema: JSON.stringify({ type: "object" }), strict: false });
  const list_schemas_raw = await call(a, "list_channel_schemas", { prefix: "test-ext-pfx1-" });
  assert(list_schemas_raw.includes(ext_schema_pfx1), "list_channel_schemas prefix: first channel listed");
  assert(!list_schemas_raw.includes(ext_schema_pfx2), "list_channel_schemas prefix: second channel not listed (different prefix)");

  // Gap 11: register_channel_schema with version
  const ext_schema_ver = `test-ext-schema-ver-${Date.now()}`;
  await call(a, "register_channel_schema", { channel: ext_schema_ver, schema: JSON.stringify({ type: "object" }), strict: false, version: "2.0" });
  const get_schema_ver_raw = await call(a, "get_channel_schema", { channel: ext_schema_ver });
  assert(get_schema_ver_raw.includes("Version: 2.0") || get_schema_ver_raw.includes("2.0"), `register_channel_schema version: response includes version (got ${get_schema_ver_raw.substring(0, 100)})`);

  // Gap 12: read_messages with limit
  const ext_read_limit = `test-ext-read-limit-${Date.now()}`;
  await call(a, "send_message", { channel: ext_read_limit, sender: "x", content: "msg1" });
  await call(a, "send_message", { channel: ext_read_limit, sender: "x", content: "msg2" });
  await call(a, "send_message", { channel: ext_read_limit, sender: "x", content: "msg3" });
  await call(a, "send_message", { channel: ext_read_limit, sender: "x", content: "msg4" });
  await call(a, "send_message", { channel: ext_read_limit, sender: "x", content: "msg5" });
  const read_limit_raw = await call(a, "read_messages", { channel: ext_read_limit, since_id: 0, limit: 3 });
  const read_limit_count = (read_limit_raw.match(/\[#\d+\]/g) || []).length;
  assert(read_limit_count === 3, `read_messages with limit: exactly 3 messages returned (got ${read_limit_count})`);

  // ── Cleanup ───────────────────────────────────────────────────────────────
  for (const c of [ch, wch, wch2, wch3, wch4, dch, pch, gch, wsch, toch, igch, iwsch, crch, crch2, hmch, rlch, msch, ssch, ssch2, hbch, bch1, bch2, crbch, gpsInbox, tsInbox, tsCtrl, tsCtrl2, ssStatus, sfcStatus, ext_hb_dedup, ext_ss_ctrl, ext_ss_status, ext_pfx_ch1, ext_pfx_ch2, ext_purge_full, ext_sfc_since, ext_sfc_clean, ext_sfc_skip, ext_cr_summary, ext_hb_empty, ext_schema_pfx1, ext_schema_pfx2, ext_schema_ver, ext_read_limit]) {
    await call(a, "purge_channel", { channel: c }).catch(() => {});
  }
  // clear any schemas registered on test channels (safety net if test fails mid-run)
  for (const c of [ssch, ssch2, ext_schema_pfx1, ext_schema_pfx2, ext_schema_ver]) {
    await call(a, "clear_channel_schema", { channel: c }).catch(() => {});
  }
  // afterAll: prefix-based sweep catches any channels missed above
  try { await call(a, "purge_channels_by_prefix", { prefix: "test-" }); } catch (e) { /* best-effort */ }
  await ta.close();
  await tb.close();

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(50)}`);
  console.log(`  passed: ${passed}   failed: ${failed}`);
  if (failed > 0) {
    console.error("  SOME TESTS FAILED");
    process.exit(1);
  } else {
    console.log("  ALL TESTS PASSED");
  }
}

run().catch(e => {
  console.error("\n[FATAL]", e.message || e);
  process.exit(1);
});
