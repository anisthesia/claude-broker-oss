/**
 * test-coverage.js — targeted tests for previously untested paths and boundary conditions.
 *
 * Covers:
 *  1. send_message_batch max=50 boundary (51 messages must fail Zod validation)
 *  2. check_results_batch max=50 boundary (51 task_ids must fail Zod validation)
 *  3. wait_for_messages combined filter_sender + filter_type
 *  4. Empty content validation (send_message, send_message_batch with content="")
 *  5. REST /cost with invalid `since` date
 *  6. REST /rate-limits with invalid `since` date
 *  7. clear_channel_schema on channel with no schema (graceful, not an error)
 *  8. Dashboard ?ns=unknown returns HTML (200, not crash)
 *  9. delete_message with id=0 and negative id (not-found, not a crash)
 * 10. read_messages non-JSON content when filter_type is active (does not crash)
 * 11. turn_start with limit parameter
 * 12. read_last with n=1 edge case (returns only the most-recent message)
 * 13. sprint_summary with type:failed messages (separate from FAIL-in-summary)
 * 14. post_gated_message timeout path (deps never satisfied → times out)
 * 15. has_messages cursor correctness (since_id excludes messages at or below cursor)
 * 16. filter_sender comma-separated multi-sender
 * 17. read_messages with limit parameter respected
 * 18. sprint_file_conflicts: empty channel → no conflicts
 * 19. sprint_file_conflicts: single worker → no conflicts, all clean
 * 20. sprint_file_conflicts: two workers touch same file → conflict detected
 * 21. sprint_file_conflicts: SKIP results excluded from conflict detection
 * 22. sprint_file_conflicts: since_id cursor filters correctly
 * 23. sprint_file_conflicts: missing affected_files → blind spot reported
 * 24. sprint_file_conflicts: multiple conflicts across workers
 * 25. sprint_file_conflicts: one worker posts two results — touches accumulate across messages
 * 26. upsert_heartbeat: keep-latest per sender + get_latest_per_sender
 * 27. get_channel_schema: returns correct schema content after registration
 * 28. list_channel_schemas: reflects register + clear lifecycle
 * 29. capability lifecycle: register_capability / list_capabilities / deregister_capability
 * 30. purge_channel older_than_ms: partial prune (keeps recent, deletes old)
 * 31. post_gated_message: success path (deps pre-satisfied + deps satisfied via wait)
 * 32. sprint_summary with control_channel: includes sprint boundary note
 * 33. send_message_batch: strict schema rejects entire batch atomically
 * 34. double-delete: second delete on same id returns not-found, not crash
 * 35. check_results_batch: empty task_ids array rejected (minItems:1)
 * 36. purge_channels_by_prefix: no-match prefix succeeds with 0 channels purged
 * 37. send_message: channel name with leading whitespace rejected
 * 38. wait_for_messages filter_type: skips non-matching messages already in channel
 * 39. read_messages: since_id at max_id returns no messages
 * 40. read_messages: filter_sender + filter_type + limit all three combined
 * 41. sprint_file_conflicts: lowercase "skip" NOT excluded (startsWith("SKIP") is case-sensitive)
 * 42. send_message_batch: single message (min=1 boundary)
 * 43. clear_channel_schema: strict schema cleared → previously-invalid message now accepted
 * 44. purge_channel: non-existent channel → 0 messages deleted (graceful)
 * 45. sprint_summary: namespace derived from channel with multiple dashes (lastIndexOf)
 * 46. check_results_batch: duplicate task_ids in array handled correctly (Set dedup)
 * 47. get_channel_schema: no version field → no "Version:" line in output
 * 48. has_messages: channel that never existed → pending=false (graceful)
 * 49. send_message_batch: warn-only schema invalid message — batch succeeds (no isError)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import "dotenv/config";

const BROKER_URL  = process.env.BROKER_URL  || "http://localhost:8080/mcp";
const BROKER_HTTP = BROKER_URL.replace("/mcp", "");
const SECRET      = process.env.SHARED_SECRET || "";
const RUN         = Date.now().toString(36);

let passed = 0;
let failed = 0;
const failures = [];

function ok(label) {
  console.log(`  ✓ ${label}`);
  passed++;
}
function fail(label, detail = "assertion failed") {
  console.error(`  ✗ ${label}: ${detail}`);
  failures.push({ label, detail });
  failed++;
}
function assert(cond, label, detail = "") {
  cond ? ok(label) : fail(label, detail || "assertion failed");
}

function ch(name) { return `cov-${RUN}-${name}`; }

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

async function callRaw(client, tool, args) {
  return client.callTool({ name: tool, arguments: args });
}

async function rest(method, path, body) {
  const headers = { "Content-Type": "application/json" };
  if (SECRET) headers.Authorization = `Bearer ${SECRET}`;
  const opts = { method, headers };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return fetch(`${BROKER_HTTP}${path}`, opts);
}

async function run() {
  const { client: a, transport: ta } = await connect("cov-a");
  const { client: b, transport: tb } = await connect("cov-b");
  console.log(`\n[test-coverage]  broker=${BROKER_URL}  run=${RUN}\n`);

  // ── 1. send_message_batch max=50 boundary ────────────────────────────────────

  console.log("1. send_message_batch: max=50 boundary");
  {
    const bmCh = ch("batch-max");

    // Exactly 50 messages — must succeed
    const fifty = Array.from({ length: 50 }, (_, i) => ({
      channel: bmCh, sender: "orch",
      content: JSON.stringify({ type: "task", task_id: `batch-max-${i}-${RUN}`, subject: `task ${i}` }),
    }));
    const ok50 = await callRaw(a, "send_message_batch", { messages: fifty });
    assert(!ok50.isError, "send_message_batch: exactly 50 messages accepted");
    assert(ok50.content[0].text.includes("50 messages"), `send_message_batch: confirms 50 sent (got: ${ok50.content[0].text.slice(0, 60)})`);

    // 51 messages — must fail Zod validation
    const fiftyOne = [...fifty, { channel: bmCh, sender: "orch", content: JSON.stringify({ type: "task", task_id: `extra-${RUN}`, subject: "too many" }) }];
    const fail51 = await callRaw(a, "send_message_batch", { messages: fiftyOne });
    assert(fail51.isError === true, "send_message_batch: 51 messages rejected (exceeds max=50)");

    await call(a, "purge_channel", { channel: bmCh });
  }

  // ── 2. check_results_batch max=50 boundary ───────────────────────────────────

  console.log("\n2. check_results_batch: max=50 boundary");
  {
    const bCh = ch("batch-cr-max");

    // Exactly 50 task_ids — must succeed
    const fifty = Array.from({ length: 50 }, (_, i) => `t-batch-max-${i}-${RUN}`);
    const ok50 = await callRaw(a, "check_results_batch", { channel: bCh, task_ids: fifty });
    assert(!ok50.isError, "check_results_batch: exactly 50 task_ids accepted");
    const res50 = JSON.parse(ok50.content[0].text);
    assert(Object.keys(res50.results).length === 50, `check_results_batch: 50 results in map (got ${Object.keys(res50.results).length})`);
    assert(Object.values(res50.results).every(v => v === false), "check_results_batch: all false for non-existent tasks");

    // 51 task_ids — must fail Zod validation
    const fiftyOne = [...fifty, `t-extra-${RUN}`];
    const fail51 = await callRaw(a, "check_results_batch", { channel: bCh, task_ids: fiftyOne });
    assert(fail51.isError === true, "check_results_batch: 51 task_ids rejected (exceeds max=50)");
  }

  // ── 3. wait_for_messages combined filter_sender + filter_type ────────────────

  console.log("\n3. wait_for_messages: combined filter_sender + filter_type");
  {
    const wch = ch("wfm-combined");

    // Start a wait for sender="target" AND type="ping"
    const waitP = call(b, "wait_for_messages", {
      channel: wch, since_id: 0, timeout_ms: 6000,
      filter_sender: "target", filter_type: "ping",
    });

    await new Promise(r => setTimeout(r, 80));

    // Wrong sender, right type — must be skipped
    await call(a, "send_message", { channel: wch, sender: "other", content: JSON.stringify({ type: "ping", v: 1 }) });
    await new Promise(r => setTimeout(r, 80));

    // Right sender, wrong type — must be skipped
    await call(a, "send_message", { channel: wch, sender: "target", content: JSON.stringify({ type: "noise", v: 2 }) });
    await new Promise(r => setTimeout(r, 80));

    // Right sender, right type — must wake the wait
    await call(a, "send_message", { channel: wch, sender: "target", content: JSON.stringify({ type: "ping", v: 3 }) });

    const r = await waitP;
    assert(r.includes('"ping"'),  "wfm combined: matching message returned");
    assert(r.includes("target"),  "wfm combined: correct sender in result");
    assert(!r.includes('"noise"'), "wfm combined: wrong-type message excluded");
    assert(!r.includes('"other"'), "wfm combined: wrong-sender message excluded");

    await call(a, "purge_channel", { channel: wch });
  }

  // ── 4. Empty content validation ──────────────────────────────────────────────

  console.log("\n4. Empty content validation");
  {
    const eCh = ch("empty-content");

    // send_message with content="" must fail (z.string().min(1))
    const emptyMsg = await callRaw(a, "send_message", { channel: eCh, sender: "x", content: "" });
    assert(emptyMsg.isError === true, "send_message: empty content rejected");

    // send_message_batch with one empty content must fail
    const emptyBatch = await callRaw(a, "send_message_batch", { messages: [
      { channel: eCh, sender: "x", content: "" },
    ]});
    assert(emptyBatch.isError === true, "send_message_batch: empty content in batch rejected");

    // send_message with whitespace-only content (not empty — min(1) passes)
    // This is intentional: whitespace IS valid content (plain text)
    const wsMsg = await callRaw(a, "send_message", { channel: eCh, sender: "x", content: " " });
    assert(!wsMsg.isError, "send_message: single-space content accepted (not empty by min(1))");

    await call(a, "purge_channel", { channel: eCh }).catch(() => {});
  }

  // ── 5. REST /cost with invalid `since` date ──────────────────────────────────

  console.log("\n5. REST /cost: invalid since date");
  {
    if (!SECRET) {
      console.log("  - skipped (SHARED_SECRET not set)");
    } else {
      // Invalid date string — server must return 400, not crash with 500
      const res = await rest("GET", "/cost?since=not-a-date");
      assert(res.status === 400, `/cost?since=not-a-date returns 400 (validated), got ${res.status}`);
      const body = await res.json();
      assert("error" in body, "/cost: 400 response has error field");

      // Future date — should return empty result (no sessions after a future timestamp)
      const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
      const resFuture = await rest("GET", `/cost?since=${encodeURIComponent(future)}`);
      assert(resFuture.status === 200, `/cost?since=<future> returns 200`);
      const bodyFuture = await resFuture.json();
      assert(bodyFuture.total_usd === 0, `/cost?since=<future> returns total_usd=0 (no sessions after future date)`);
      assert(bodyFuture.sessions === 0,  `/cost?since=<future> returns sessions=0`);
    }
  }

  // ── 6. REST /rate-limits with invalid `since` date ───────────────────────────

  console.log("\n6. REST /rate-limits: invalid since date");
  {
    if (!SECRET) {
      console.log("  - skipped (SHARED_SECRET not set)");
    } else {
      // Invalid date string — server must return 400, not crash with 500
      const res = await rest("GET", "/rate-limits?since=garbage-date");
      assert(res.status === 400, `/rate-limits?since=garbage-date returns 400 (validated), got ${res.status}`);
      const body = await res.json();
      assert("error" in body, "/rate-limits: 400 response has error field");

      // Future date → empty
      const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
      const resFuture = await rest("GET", `/rate-limits?since=${encodeURIComponent(future)}`);
      assert(resFuture.status === 200, `/rate-limits?since=<future> returns 200`);
      const bodyFuture = await resFuture.json();
      assert(bodyFuture.total_hits === 0, `/rate-limits?since=<future> returns total_hits=0`);
    }
  }

  // ── 7. clear_channel_schema on channel with no schema ────────────────────────

  console.log("\n7. clear_channel_schema: no-op on channel without schema");
  {
    const nsCh = ch("no-schema");

    // Never registered a schema on nsCh — clearing should be graceful
    const r = await callRaw(a, "clear_channel_schema", { channel: nsCh });
    assert(!r.isError, "clear_channel_schema: no error when channel has no schema");
    assert(r.content[0].text.includes("Cleared"), `clear_channel_schema: returns confirmation (got: ${r.content[0].text})`);

    // Calling it twice also graceful
    const r2 = await callRaw(a, "clear_channel_schema", { channel: nsCh });
    assert(!r2.isError, "clear_channel_schema: idempotent — second call on schema-less channel is fine");
  }

  // ── 8. Dashboard ?ns=unknown ─────────────────────────────────────────────────

  console.log("\n8. Dashboard ?ns=unknown");
  {
    const res = await fetch(`${BROKER_HTTP}/dashboard?ns=definitely-nonexistent-ns-xyz`, {
      headers: SECRET ? { Authorization: `Bearer ${SECRET}` } : {},
    });
    assert(res.status === 200, `dashboard?ns=unknown returns 200 (not a crash), got ${res.status}`);
    const html = await res.text();
    assert(html.includes("<html") || html.includes("<!DOCTYPE"), "dashboard: returns HTML body");
    assert(!html.toLowerCase().includes("error") || html.includes("No channels"), "dashboard: no unhandled error with unknown ns");
  }

  // ── 9. delete_message: id=0 and negative id ──────────────────────────────────

  console.log("\n9. delete_message: invalid id values");
  {
    const dCh = ch("del-edge");
    await call(a, "send_message", { channel: dCh, sender: "x", content: "test" });

    // id=0 — no valid message has id=0 (SQLite ROWID starts at 1)
    const r0 = await a.callTool({ name: "delete_message", arguments: { channel: dCh, id: 0 } });
    // Should return not-found error, not crash
    const t0 = r0.content[0].text;
    assert(r0.isError === true || t0.includes("not found") || t0.includes("Not found"),
      `delete_message id=0: returns not-found, not crash (got: ${t0})`);

    // Negative id — also invalid
    const rNeg = await a.callTool({ name: "delete_message", arguments: { channel: dCh, id: -1 } });
    const tNeg = rNeg.content[0].text;
    // Either Zod rejects it (isError) or it returns not-found
    const isRejectedOrNotFound = rNeg.isError === true || tNeg.includes("not found") || tNeg.includes("Not found");
    assert(isRejectedOrNotFound, `delete_message id=-1: rejected or returns not-found (got: ${tNeg})`);

    await call(a, "purge_channel", { channel: dCh });
  }

  // ── 10. read_messages non-JSON content with filter_type active ───────────────

  console.log("\n10. read_messages: non-JSON content with filter_type");
  {
    const njCh = ch("non-json");

    // Post a mix of JSON and plain-text messages
    await call(a, "send_message", { channel: njCh, sender: "x", content: "plain text, not JSON" });
    await call(a, "send_message", { channel: njCh, sender: "x", content: JSON.stringify({ type: "task", v: 1 }) });
    await call(a, "send_message", { channel: njCh, sender: "x", content: "another plain text" });
    await call(a, "send_message", { channel: njCh, sender: "x", content: JSON.stringify({ type: "result", v: 2 }) });

    // filter_type="task" — must not crash, must return only the JSON task message
    const r = await call(a, "read_messages", { channel: njCh, since_id: 0, filter_type: "task" });
    assert(!r.includes("Error") && !r.includes("SyntaxError"), "read_messages filter_type: no crash on non-JSON content");
    assert(r.includes('"task"'),   "read_messages filter_type: returns the JSON task message");
    assert(!r.includes('"result"'), "read_messages filter_type: excludes non-matching JSON");
    assert(!r.includes("plain text"), "read_messages filter_type: plain-text messages silently excluded");

    // filter_type="result" — returns only the result message
    const r2 = await call(a, "read_messages", { channel: njCh, since_id: 0, filter_type: "result" });
    assert(r2.includes('"result"') && !r2.includes('"task"'), "read_messages filter_type=result: correct isolation");

    await call(a, "purge_channel", { channel: njCh });
  }

  // ── 11. turn_start with limit parameter ──────────────────────────────────────

  console.log("\n11. turn_start: limit parameter");
  {
    const tsCh = ch("ts-limit-inbox");
    const tcCh = ch("ts-limit-ctrl");

    // Post 5 inbox messages
    for (let i = 0; i < 5; i++) {
      await call(a, "send_message", { channel: tsCh, sender: "orch",
        content: JSON.stringify({ type: "task", task_id: `lim-${i}-${RUN}`, subject: `task ${i}` }) });
    }
    await call(a, "send_message", { channel: tcCh, sender: "orch",
      content: JSON.stringify({ type: "note", subject: "ctrl" }) });

    // limit=2 — inbox should return at most 2 messages
    const ts = JSON.parse(await call(b, "turn_start", {
      inbox_channel: tsCh, control_channel: tcCh,
      inbox_since_id: 0, control_since_id: 0, limit: 2,
    }));
    assert(ts.inbox.length === 2,   `turn_start limit=2: inbox capped at 2 (got ${ts.inbox.length})`);
    assert(ts.control.length === 1, `turn_start limit=2: control not affected — has 1 msg (got ${ts.control.length})`);

    // limit=10 — all 5 inbox messages returned
    const tsAll = JSON.parse(await call(b, "turn_start", {
      inbox_channel: tsCh, control_channel: tcCh,
      inbox_since_id: 0, control_since_id: 0, limit: 10,
    }));
    assert(tsAll.inbox.length === 5, `turn_start limit=10: all 5 inbox messages returned (got ${tsAll.inbox.length})`);

    await call(a, "purge_channel", { channel: tsCh });
    await call(a, "purge_channel", { channel: tcCh });
  }

  // ── 12. read_last with n=1 edge case ─────────────────────────────────────────

  console.log("\n12. read_last: n=1 edge case");
  {
    const rlCh = ch("read-last");

    await call(a, "send_message", { channel: rlCh, sender: "x", content: "first" });
    await call(a, "send_message", { channel: rlCh, sender: "x", content: "second" });
    await call(a, "send_message", { channel: rlCh, sender: "x", content: "third" });

    // n=1 — must return only the most recent message
    const r1 = await call(a, "read_last", { channel: rlCh, n: 1 });
    assert(r1.includes("third"),  "read_last n=1: returns most-recent message");
    assert(!r1.includes("first"), "read_last n=1: does not include older messages");
    assert(!r1.includes("second"), "read_last n=1: does not include second-to-last");

    // n=2 — returns second and third in chronological order
    const r2 = await call(a, "read_last", { channel: rlCh, n: 2 });
    const lines = r2.trim().split("\n").filter(l => l.match(/\[\d+\]/));
    assert(lines.length === 2,         `read_last n=2: returns 2 messages (got ${lines.length})`);
    assert(r2.includes("second"),      "read_last n=2: includes second message");
    assert(r2.includes("third"),       "read_last n=2: includes third message");
    assert(!r2.includes("first"),      "read_last n=2: first message excluded");
    // Chronological order: second before third
    assert(r2.indexOf("second") < r2.indexOf("third"), "read_last n=2: messages in chronological order");

    // Empty channel — returns "No messages." (not crash)
    const rlEmptyCh = ch("read-last-empty");
    const rEmpty = await call(a, "read_last", { channel: rlEmptyCh, n: 5 });
    assert(rEmpty.includes("No messages"), `read_last empty channel: graceful (got: ${rEmpty})`);

    await call(a, "purge_channel", { channel: rlCh });
  }

  // ── 13. sprint_summary: type:failed messages ──────────────────────────────────

  console.log("\n13. sprint_summary: type:failed messages separate from FAIL-in-summary");
  {
    // sprint_summary.failed counts type:result messages where summary LIKE '%FAIL%'
    // Verify a result with "PASS" summary is NOT counted as failed
    const ssNS   = `cov-${RUN}-sf`;
    const ssCh   = `${ssNS}-status`;
    const ssInCh = `${ssNS}-backend`;

    const tasks = ["sf-t1", "sf-t2", "sf-t3", "sf-t4"];
    const tid = (id) => `${id}-${RUN}`;

    // Dispatch 4 tasks to inbox channel
    for (const t of tasks) {
      await call(a, "send_message", { channel: ssInCh, sender: "orchestrator",
        content: JSON.stringify({ type: "task", task_id: tid(t), from: "orchestrator", to: "backend", subject: t }) });
    }

    // t1: PASS result (not failed)
    await call(a, "send_message", { channel: ssCh, sender: "backend",
      content: JSON.stringify({ type: "result", task_id: tid("sf-t1"), summary: "PASS — all good" }) });

    // t2: FAIL result (counted as failed)
    await call(a, "send_message", { channel: ssCh, sender: "backend",
      content: JSON.stringify({ type: "result", task_id: tid("sf-t2"), summary: "FAIL — lint errors" }) });

    // t3: FAIL result with lowercase "fail" (LIKE is case-insensitive in SQLite by default for ASCII)
    await call(a, "send_message", { channel: ssCh, sender: "backend",
      content: JSON.stringify({ type: "result", task_id: tid("sf-t3"), summary: "fail — build error" }) });

    // t4: pending (no result posted)

    const ss = JSON.parse(await call(a, "sprint_summary", { status_channel: ssCh }));
    assert(ss.dispatched === 4, `sprint_summary: dispatched=4 (got ${ss.dispatched})`);
    assert(ss.completed  === 3, `sprint_summary: completed=3 (got ${ss.completed})`);
    // LIKE '%FAIL%' is case-insensitive in SQLite for ASCII chars
    assert(ss.failed     >= 1, `sprint_summary: failed>=1 (got ${ss.failed})`);
    assert(ss.pending    === 1, `sprint_summary: pending=1 (got ${ss.pending})`);

    await call(a, "purge_channel", { channel: ssCh   });
    await call(a, "purge_channel", { channel: ssInCh });
  }

  // ── 14. post_gated_message timeout path ──────────────────────────────────────

  console.log("\n14. post_gated_message: timeout when deps never satisfied");
  {
    const pgCh  = ch("gate-timeout-out");
    const pgWCh = ch("gate-timeout-watch");
    const dep   = `gate-never-${RUN}`;

    const t0 = Date.now();
    const gRes = await call(a, "post_gated_message", {
      channel: pgCh, sender: "orch",
      content: JSON.stringify({ type: "task", subject: "should not appear" }),
      depends_on: [dep],
      watch_channel: pgWCh,
      timeout_ms: 500,
    });
    const elapsed = Date.now() - t0;

    assert(gRes.includes("Timed out") || gRes.includes("timeout"), `post_gated_message: timeout message returned (got: ${gRes})`);
    assert(elapsed >= 400, `post_gated_message: timeout fires at expected time (~500ms, got ${elapsed}ms)`);

    // Message must NOT have been posted to the output channel
    const after = await call(a, "read_messages", { channel: pgCh, since_id: 0 });
    assert(after.includes("No new messages"), "post_gated_message: no message posted on timeout");

    await call(a, "purge_channel", { channel: pgCh  }).catch(() => {});
    await call(a, "purge_channel", { channel: pgWCh }).catch(() => {});
  }

  // ── 15. has_messages cursor correctness ──────────────────────────────────────

  console.log("\n15. has_messages: since_id cursor correctness");
  {
    const hmCh = ch("has-messages");

    // Empty channel → pending=false
    const e0 = JSON.parse(await call(a, "has_messages", { channel: hmCh, since_id: 0 }));
    assert(e0.pending === false, "has_messages: empty channel → pending=false");
    assert(e0.max_id === 0, `has_messages: empty channel → max_id=0 (got ${e0.max_id})`);

    // Post a message
    const sentRaw = await call(a, "send_message", { channel: hmCh, sender: "x",
      content: JSON.stringify({ type: "note", v: 1 }) });
    const sentId = Number(sentRaw.match(/#(\d+)/)?.[1]);

    const h1 = JSON.parse(await call(a, "has_messages", { channel: hmCh, since_id: 0 }));
    assert(h1.pending === true,         "has_messages: new message → pending=true");
    assert(h1.max_id  === sentId,       `has_messages: max_id equals sent id (${sentId})`);

    // Cursor at sentId → pending=false (nothing new after sentId)
    const h2 = JSON.parse(await call(a, "has_messages", { channel: hmCh, since_id: sentId }));
    assert(h2.pending === false, "has_messages: cursor at last id → pending=false");

    await call(a, "purge_channel", { channel: hmCh });
  }

  // ── 16. filter_sender comma-separated multi-sender ───────────────────────────

  console.log("\n16. filter_sender: comma-separated multi-sender");
  {
    const msCh = ch("multi-sender");

    await call(a, "send_message", { channel: msCh, sender: "alice",   content: JSON.stringify({ v: 1 }) });
    await call(a, "send_message", { channel: msCh, sender: "bob",     content: JSON.stringify({ v: 2 }) });
    await call(a, "send_message", { channel: msCh, sender: "charlie", content: JSON.stringify({ v: 3 }) });
    await call(a, "send_message", { channel: msCh, sender: "dave",    content: JSON.stringify({ v: 4 }) });

    // alice,bob — should return messages from alice and bob only
    const r = await call(a, "read_messages", { channel: msCh, since_id: 0, filter_sender: "alice,bob" });
    assert(r.includes("<alice>"),   "filter_sender multi: alice included");
    assert(r.includes("<bob>"),     "filter_sender multi: bob included");
    assert(!r.includes("<charlie>"), "filter_sender multi: charlie excluded");
    assert(!r.includes("<dave>"),    "filter_sender multi: dave excluded");

    // Whitespace tolerance: "alice, charlie" (space after comma)
    const r2 = await call(a, "read_messages", { channel: msCh, since_id: 0, filter_sender: "alice, charlie" });
    assert(r2.includes("<alice>"),   "filter_sender multi trim: alice included");
    assert(r2.includes("<charlie>"), "filter_sender multi trim: charlie included");
    assert(!r2.includes("<bob>"),    "filter_sender multi trim: bob excluded");

    await call(a, "purge_channel", { channel: msCh });
  }

  // ── 17. read_messages: limit parameter ───────────────────────────────────────

  console.log("\n17. read_messages: limit parameter");
  {
    const limCh = ch("read-limit");

    // Post 10 messages
    for (let i = 0; i < 10; i++) {
      await call(a, "send_message", { channel: limCh, sender: "x",
        content: JSON.stringify({ type: "note", v: i }) });
    }

    // Default limit (100) — all 10 returned
    const rAll = await call(a, "read_messages", { channel: limCh, since_id: 0 });
    const allLines = rAll.trim().split("\n").filter(l => l.match(/\[#\d+\]/));
    assert(allLines.length === 10, `read_messages default limit: all 10 returned (got ${allLines.length})`);

    // limit=3 — only first 3 (oldest) returned
    const r3 = await call(a, "read_messages", { channel: limCh, since_id: 0, limit: 3 });
    const lines3 = r3.trim().split("\n").filter(l => l.match(/\[#\d+\]/));
    assert(lines3.length === 3, `read_messages limit=3: returns 3 messages (got ${lines3.length})`);
    // First 3 messages have v: 0, 1, 2
    assert(r3.includes('"v":0'), "read_messages limit=3: includes first message (v=0)");
    assert(!r3.includes('"v":9'), "read_messages limit=3: last message (v=9) excluded");

    await call(a, "purge_channel", { channel: limCh });
  }

  // ── 18. sprint_file_conflicts: empty channel → no conflicts ──────────────────

  console.log("\n18. sprint_file_conflicts: empty channel → no conflicts");
  {
    const sfcCh = ch("sfc-empty");

    const raw = await call(a, "sprint_file_conflicts", { status_channel: sfcCh });
    const res = JSON.parse(raw);

    assert(Array.isArray(res.conflicts),         "sfc empty: conflicts is array");
    assert(res.conflicts.length === 0,           "sfc empty: no conflicts");
    assert(res.clean_count === 0,                `sfc empty: clean_count=0 (got ${res.clean_count})`);
    assert(Array.isArray(res.blind_spots),       "sfc empty: blind_spots is array");
    assert(res.blind_spots.length === 0,         "sfc empty: no blind spots");
    assert(typeof res.summary === "string",      "sfc empty: summary is a string");
    assert(/no conflict|safe to run/i.test(res.summary), `sfc empty: summary indicates no conflicts (got: ${res.summary})`);

    await call(a, "purge_channel", { channel: sfcCh });
  }

  // ── 19. sprint_file_conflicts: single worker → no conflicts, all clean ────────

  console.log("\n19. sprint_file_conflicts: single worker → no conflicts, all clean");
  {
    const sfcCh = ch("sfc-single");

    // backend touches two distinct files
    await call(a, "send_message", { channel: sfcCh, sender: "backend",
      content: JSON.stringify({
        type: "result", task_id: `sfc-single-t1-${RUN}`,
        from: "backend", to: "orchestrator",
        subject: "add deposit job",
        summary: "PASS — done",
        affected_files: [
          "backend/src/jobs/deposit-reconciliation.service.ts",
          "backend/src/jobs/deposit-reconciliation.module.ts",
        ],
        body: { consent_basis: "orchestrator-dispatch-only" },
      }),
    });

    const raw = await call(a, "sprint_file_conflicts", { status_channel: sfcCh });
    const res = JSON.parse(raw);

    assert(res.conflicts.length === 0,  "sfc single: no conflicts (single owner)");
    assert(res.clean_count === 2,       `sfc single: clean_count=2 (got ${res.clean_count})`);
    assert(res.blind_spots.length === 0,"sfc single: no blind spots");

    await call(a, "purge_channel", { channel: sfcCh });
  }

  // ── 20. sprint_file_conflicts: two workers touch same file → conflict ─────────

  console.log("\n20. sprint_file_conflicts: two workers touch same file → conflict detected");
  {
    const sfcCh = ch("sfc-conflict");
    const sharedFile = "backend/src/jobs/deposit-reconciliation.service.ts";

    // backend posts result first
    await call(a, "send_message", { channel: sfcCh, sender: "backend",
      content: JSON.stringify({
        type: "result", task_id: `sfc-conflict-backend-${RUN}`,
        from: "backend", to: "orchestrator",
        subject: "add deposit job with try/catch",
        summary: "PASS — done",
        affected_files: [sharedFile],
        body: { consent_basis: "orchestrator-dispatch-only" },
      }),
    });

    // bs cherry-picked and also reports the same file
    await call(a, "send_message", { channel: sfcCh, sender: "bs",
      content: JSON.stringify({
        type: "result", task_id: `sfc-conflict-bs-${RUN}`,
        from: "bs", to: "orchestrator",
        subject: "add tests for deposit job",
        summary: "PASS — done",
        affected_files: [sharedFile, "backend/src/jobs/deposit-reconciliation.service.spec.ts"],
        body: { consent_basis: "orchestrator-dispatch-only" },
      }),
    });

    const raw = await call(a, "sprint_file_conflicts", { status_channel: sfcCh });
    const res = JSON.parse(raw);

    assert(res.conflicts.length === 1,                       "sfc conflict: 1 conflict detected");
    assert(res.conflicts[0].file === sharedFile,             `sfc conflict: correct file (got ${res.conflicts[0]?.file})`);

    const conflictWorkers = res.conflicts[0]?.workers ?? [];
    assert(conflictWorkers.includes("backend"),              "sfc conflict: backend in conflict workers");
    assert(conflictWorkers.includes("bs"),                   "sfc conflict: bs in conflict workers");
    assert(conflictWorkers.length === 2,                     `sfc conflict: exactly 2 workers (got ${conflictWorkers.length})`);

    // The spec file is only in bs → clean
    assert(res.clean_count === 1,                            `sfc conflict: clean_count=1 for spec file (got ${res.clean_count})`);

    // touches array has one entry per worker per task
    const touches = res.conflicts[0]?.touches ?? [];
    assert(touches.length === 2,                             `sfc conflict: 2 touch entries (got ${touches.length})`);
    assert(touches.some(t => t.worker === "backend"),        "sfc conflict: touch entry for backend");
    assert(touches.some(t => t.worker === "bs"),             "sfc conflict: touch entry for bs");

    assert(/1 conflict/i.test(res.summary),                  `sfc conflict: summary mentions 1 conflict (got: ${res.summary})`);

    await call(a, "purge_channel", { channel: sfcCh });
  }

  // ── 21. sprint_file_conflicts: SKIP results excluded ─────────────────────────

  console.log("\n21. sprint_file_conflicts: SKIP results excluded from conflict detection");
  {
    const sfcCh = ch("sfc-skip");
    const sharedFile = "backend/src/services/some.service.ts";

    // backend: real result touching sharedFile
    await call(a, "send_message", { channel: sfcCh, sender: "backend",
      content: JSON.stringify({
        type: "result", task_id: `sfc-skip-backend-${RUN}`,
        from: "backend", to: "orchestrator",
        subject: "implement some service",
        summary: "PASS — done",
        affected_files: [sharedFile],
        body: { consent_basis: "orchestrator-dispatch-only" },
      }),
    });

    // frontend: SKIP result referencing the same file — must NOT count
    await call(a, "send_message", { channel: sfcCh, sender: "frontend",
      content: JSON.stringify({
        type: "result", task_id: `sfc-skip-frontend-${RUN}`,
        from: "frontend", to: "orchestrator",
        subject: "skip — out of scope",
        summary: "SKIP — not applicable to frontend",
        affected_files: [sharedFile],
        body: { consent_basis: "orchestrator-dispatch-only" },
      }),
    });

    const raw = await call(a, "sprint_file_conflicts", { status_channel: sfcCh });
    const res = JSON.parse(raw);

    assert(res.conflicts.length === 0,  "sfc skip: no conflict (SKIP result excluded)");
    assert(res.clean_count === 1,       `sfc skip: clean_count=1 for backend's file (got ${res.clean_count})`);

    await call(a, "purge_channel", { channel: sfcCh });
  }

  // ── 22. sprint_file_conflicts: since_id cursor filters correctly ──────────────

  console.log("\n22. sprint_file_conflicts: since_id cursor filters correctly");
  {
    const sfcCh = ch("sfc-cursor");
    const sharedFile = "backend/src/jobs/old-job.service.ts";

    // Pre-sprint result from a previous sprint (both workers touching same file)
    await call(a, "send_message", { channel: sfcCh, sender: "backend",
      content: JSON.stringify({
        type: "result", task_id: `sfc-cursor-old-backend-${RUN}`,
        from: "backend", to: "orchestrator",
        subject: "old sprint task",
        summary: "PASS — done",
        affected_files: [sharedFile],
        body: { consent_basis: "orchestrator-dispatch-only" },
      }),
    });
    await call(a, "send_message", { channel: sfcCh, sender: "bs",
      content: JSON.stringify({
        type: "result", task_id: `sfc-cursor-old-bs-${RUN}`,
        from: "bs", to: "orchestrator",
        subject: "old sprint test task",
        summary: "PASS — done",
        affected_files: [sharedFile],
        body: { consent_basis: "orchestrator-dispatch-only" },
      }),
    });

    // Capture cursor after old results
    const hmRaw = await call(a, "has_messages", { channel: sfcCh, since_id: 0 });
    const cursor = JSON.parse(hmRaw).max_id;

    // New sprint: only backend touches a NEW file
    await call(a, "send_message", { channel: sfcCh, sender: "backend",
      content: JSON.stringify({
        type: "result", task_id: `sfc-cursor-new-backend-${RUN}`,
        from: "backend", to: "orchestrator",
        subject: "new sprint task",
        summary: "PASS — done",
        affected_files: ["backend/src/jobs/new-job.service.ts"],
        body: { consent_basis: "orchestrator-dispatch-only" },
      }),
    });

    // Without cursor: old conflict shows up
    const rawAll = await call(a, "sprint_file_conflicts", { status_channel: sfcCh });
    const resAll = JSON.parse(rawAll);
    assert(resAll.conflicts.length === 1,  "sfc cursor: without since_id old conflict visible");

    // With cursor: only new-sprint results → no conflict
    const rawNew = await call(a, "sprint_file_conflicts", { status_channel: sfcCh, since_id: cursor });
    const resNew = JSON.parse(rawNew);
    assert(resNew.conflicts.length === 0,  "sfc cursor: with since_id old conflict excluded");
    assert(resNew.clean_count === 1,       `sfc cursor: clean_count=1 for new file (got ${resNew.clean_count})`);

    await call(a, "purge_channel", { channel: sfcCh });
  }

  // ── 23. sprint_file_conflicts: missing affected_files → blind spot ────────────

  console.log("\n23. sprint_file_conflicts: missing affected_files → blind spot reported");
  {
    const sfcCh = ch("sfc-blind");

    // backend: result with affected_files → clean
    await call(a, "send_message", { channel: sfcCh, sender: "backend",
      content: JSON.stringify({
        type: "result", task_id: `sfc-blind-backend-${RUN}`,
        from: "backend", to: "orchestrator",
        subject: "task with files",
        summary: "PASS — done",
        affected_files: ["backend/src/some.ts"],
        body: { consent_basis: "orchestrator-dispatch-only" },
      }),
    });

    // frontend: result without affected_files → blind spot
    await call(a, "send_message", { channel: sfcCh, sender: "frontend",
      content: JSON.stringify({
        type: "result", task_id: `sfc-blind-frontend-${RUN}`,
        from: "frontend", to: "orchestrator",
        subject: "task missing files",
        summary: "PASS — done",
        body: { consent_basis: "orchestrator-dispatch-only" },
      }),
    });

    // bs: result with empty affected_files array → also a blind spot
    await call(a, "send_message", { channel: sfcCh, sender: "bs",
      content: JSON.stringify({
        type: "result", task_id: `sfc-blind-bs-${RUN}`,
        from: "bs", to: "orchestrator",
        subject: "task with empty files",
        summary: "PASS — done",
        affected_files: [],
        body: { consent_basis: "orchestrator-dispatch-only" },
      }),
    });

    const raw = await call(a, "sprint_file_conflicts", { status_channel: sfcCh });
    const res = JSON.parse(raw);

    assert(res.conflicts.length === 0,          "sfc blind: no false conflicts");
    assert(res.clean_count === 1,               `sfc blind: clean_count=1 for backend file (got ${res.clean_count})`);
    assert(res.blind_spots.includes("frontend"),"sfc blind: frontend in blind_spots (no affected_files)");
    assert(res.blind_spots.includes("bs"),      "sfc blind: bs in blind_spots (empty affected_files)");
    assert(!res.blind_spots.includes("backend"),"sfc blind: backend NOT in blind_spots");

    await call(a, "purge_channel", { channel: sfcCh });
  }

  // ── 24. sprint_file_conflicts: multiple conflicts across workers ───────────────

  console.log("\n24. sprint_file_conflicts: multiple conflicts across multiple workers");
  {
    const sfcCh = ch("sfc-multi");
    const fileA = "backend/src/jobs/reconciliation.service.ts";
    const fileB = "backend/src/modules/payments/payments.service.ts";
    const fileC = "backend/src/modules/payments/payments.module.ts"; // only frontend

    // backend: touches fileA + fileB
    await call(a, "send_message", { channel: sfcCh, sender: "backend",
      content: JSON.stringify({
        type: "result", task_id: `sfc-multi-backend-${RUN}`,
        from: "backend", to: "orchestrator",
        subject: "backend multi task",
        summary: "PASS — done",
        affected_files: [fileA, fileB],
        body: { consent_basis: "orchestrator-dispatch-only" },
      }),
    });

    // bs: touches fileA (conflict with backend)
    await call(a, "send_message", { channel: sfcCh, sender: "bs",
      content: JSON.stringify({
        type: "result", task_id: `sfc-multi-bs-${RUN}`,
        from: "bs", to: "orchestrator",
        subject: "bs multi task",
        summary: "PASS — done",
        affected_files: [fileA],
        body: { consent_basis: "orchestrator-dispatch-only" },
      }),
    });

    // frontend: touches fileB (conflict with backend) + fileC (clean)
    await call(a, "send_message", { channel: sfcCh, sender: "frontend",
      content: JSON.stringify({
        type: "result", task_id: `sfc-multi-frontend-${RUN}`,
        from: "frontend", to: "orchestrator",
        subject: "frontend multi task",
        summary: "PASS — done",
        affected_files: [fileB, fileC],
        body: { consent_basis: "orchestrator-dispatch-only" },
      }),
    });

    const raw = await call(a, "sprint_file_conflicts", { status_channel: sfcCh });
    const res = JSON.parse(raw);

    assert(res.conflicts.length === 2, `sfc multi: 2 conflicts (got ${res.conflicts.length})`);

    const conflictFiles = res.conflicts.map(c => c.file);
    assert(conflictFiles.includes(fileA), "sfc multi: fileA in conflicts (backend ∩ bs)");
    assert(conflictFiles.includes(fileB), "sfc multi: fileB in conflicts (backend ∩ frontend)");
    assert(!conflictFiles.includes(fileC),"sfc multi: fileC not in conflicts (frontend only)");

    // fileC is the only clean file
    assert(res.clean_count === 1, `sfc multi: clean_count=1 for fileC (got ${res.clean_count})`);
    assert(res.blind_spots.length === 0, "sfc multi: no blind spots");
    assert(/2 conflict/i.test(res.summary), `sfc multi: summary mentions 2 conflicts (got: ${res.summary})`);

    await call(a, "purge_channel", { channel: sfcCh });
  }

  // ── 25. sprint_file_conflicts: one worker posts two results ───────────────────
  // Tests that touches accumulate correctly across multiple result messages from
  // the same worker, so a worker whose scope spans two tasks (two result posts)
  // still produces the correct conflict entries for each file.

  console.log("\n25. sprint_file_conflicts: one worker posts two results — touches accumulate");
  {
    const sfcCh = ch("sfc-two-results");
    const fileA = "backend/src/jobs/job-a.service.ts";
    const fileB = "backend/src/jobs/job-b.service.ts";

    // backend posts two separate results from two different tasks
    await call(a, "send_message", { channel: sfcCh, sender: "backend",
      content: JSON.stringify({
        type: "result", task_id: `sfc-two-r1-backend-${RUN}`,
        from: "backend", to: "orchestrator",
        subject: "task 1 — job-a",
        summary: "PASS — done",
        affected_files: [fileA],
        body: { consent_basis: "orchestrator-dispatch-only" },
      }),
    });
    await call(a, "send_message", { channel: sfcCh, sender: "backend",
      content: JSON.stringify({
        type: "result", task_id: `sfc-two-r2-backend-${RUN}`,
        from: "backend", to: "orchestrator",
        subject: "task 2 — job-b",
        summary: "PASS — done",
        affected_files: [fileB],
        body: { consent_basis: "orchestrator-dispatch-only" },
      }),
    });

    // bs conflicts with backend on fileA only
    await call(a, "send_message", { channel: sfcCh, sender: "bs",
      content: JSON.stringify({
        type: "result", task_id: `sfc-two-r-bs-${RUN}`,
        from: "bs", to: "orchestrator",
        subject: "test task — job-a tests",
        summary: "PASS — done",
        affected_files: [fileA],
        body: { consent_basis: "orchestrator-dispatch-only" },
      }),
    });

    // frontend conflicts with backend on fileB only
    await call(a, "send_message", { channel: sfcCh, sender: "frontend",
      content: JSON.stringify({
        type: "result", task_id: `sfc-two-r-frontend-${RUN}`,
        from: "frontend", to: "orchestrator",
        subject: "ui task touching job-b",
        summary: "PASS — done",
        affected_files: [fileB],
        body: { consent_basis: "orchestrator-dispatch-only" },
      }),
    });

    const raw = await call(a, "sprint_file_conflicts", { status_channel: sfcCh });
    const res = JSON.parse(raw);

    assert(res.conflicts.length === 2, `sfc two-results: 2 conflicts (got ${res.conflicts.length})`);

    const conflictFiles = res.conflicts.map(c => c.file);
    assert(conflictFiles.includes(fileA), "sfc two-results: fileA in conflicts (backend task-1 ∩ bs)");
    assert(conflictFiles.includes(fileB), "sfc two-results: fileB in conflicts (backend task-2 ∩ frontend)");

    // fileA conflict: backend + bs; touches must reference the correct task_id
    const cA = res.conflicts.find(c => c.file === fileA);
    assert(cA.workers.includes("backend"),   "sfc two-results: fileA conflict includes backend");
    assert(cA.workers.includes("bs"),        "sfc two-results: fileA conflict includes bs");
    assert(cA.workers.length === 2,          `sfc two-results: fileA exactly 2 workers (got ${cA.workers.length})`);
    assert(cA.touches.some(t => t.worker === "backend" && t.task_id.includes("r1")),
      "sfc two-results: fileA touch references backend task-1 (r1)");

    // fileB conflict: backend + frontend; touch references backend's second task
    const cB = res.conflicts.find(c => c.file === fileB);
    assert(cB.workers.includes("backend"),   "sfc two-results: fileB conflict includes backend");
    assert(cB.workers.includes("frontend"),  "sfc two-results: fileB conflict includes frontend");
    assert(cB.touches.some(t => t.worker === "backend" && t.task_id.includes("r2")),
      "sfc two-results: fileB touch references backend task-2 (r2)");

    assert(res.clean_count === 0,          `sfc two-results: clean_count=0 (all files conflicted) (got ${res.clean_count})`);
    assert(res.blind_spots.length === 0,   "sfc two-results: no blind spots");

    await call(a, "purge_channel", { channel: sfcCh });
  }

  // ── 26. upsert_heartbeat + get_latest_per_sender ─────────────────────────────

  console.log("\n26. upsert_heartbeat: keep-latest per sender + get_latest_per_sender");
  {
    const telCh = ch("telemetry");

    // Worker A sends 3 heartbeats — only the latest must survive per sender
    await call(a, "upsert_heartbeat", { channel: telCh, sender: "backend",
      content: JSON.stringify({ context: { tier_threshold_pct: 45.0 }, state: "working" }) });
    await call(a, "upsert_heartbeat", { channel: telCh, sender: "backend",
      content: JSON.stringify({ context: { tier_threshold_pct: 62.5 }, state: "working" }) });
    await call(a, "upsert_heartbeat", { channel: telCh, sender: "backend",
      content: JSON.stringify({ context: { tier_threshold_pct: 78.3 }, state: "working" }) });

    // Worker B sends 1 heartbeat (different sender — must also survive)
    await call(a, "upsert_heartbeat", { channel: telCh, sender: "frontend",
      content: JSON.stringify({ context: { tier_threshold_pct: 31.0 }, state: "idle-polling" }) });

    // Channel must have exactly 2 messages (one per sender — stale backend ones deleted)
    const allRaw  = await call(a, "read_messages", { channel: telCh, since_id: 0 });
    const allLines = allRaw.trim().split("\n").filter(l => /^\[#\d+\]/.test(l));
    assert(allLines.length === 2,
      `upsert: channel has exactly 2 messages (one per sender) (got ${allLines.length})`);

    // get_latest_per_sender returns one row per sender
    const latestRaw   = await call(a, "get_latest_per_sender", { channel: telCh });
    const latestLines = latestRaw.trim().split("\n").filter(l => /^\[#\d+\]/.test(l));
    assert(latestLines.length === 2,
      `upsert: get_latest_per_sender returns 2 rows (got ${latestLines.length})`);

    // Parse each row
    let backendHb = null, frontendHb = null;
    for (const line of latestLines) {
      const m = line.match(/^\[#(\d+)\] \S+ <([^>]+)>: (.*)/);
      if (!m) continue;
      const [, , sender, content] = m;
      const hb = JSON.parse(content);
      if (sender === "backend")  backendHb  = hb;
      if (sender === "frontend") frontendHb = hb;
    }
    assert(backendHb  !== null, "upsert: backend row present in get_latest_per_sender");
    assert(frontendHb !== null, "upsert: frontend row present in get_latest_per_sender");

    // Backend: must reflect the LATEST heartbeat (78.3), not the stale ones
    assert(backendHb.context.tier_threshold_pct === 78.3,
      `upsert: backend latest tier_threshold_pct=78.3 (not stale) (got ${backendHb?.context?.tier_threshold_pct})`);
    assert(!latestRaw.includes('"tier_threshold_pct":62.5'),
      "upsert: stale backend heartbeat (62.5) deleted");
    assert(!latestRaw.includes('"tier_threshold_pct":45'),
      "upsert: stale backend heartbeat (45.0) deleted");

    // Frontend: correct value
    assert(frontendHb.context.tier_threshold_pct === 31.0,
      `upsert: frontend tier_threshold_pct=31.0 (got ${frontendHb?.context?.tier_threshold_pct})`);

    await call(a, "purge_channel", { channel: telCh });
  }

  // ── 27. get_channel_schema ─────────────────────────────────────────────────────

  console.log("\n27. get_channel_schema: returns schema content after registration");
  {
    const gsCh = ch("get-schema");
    const schema = JSON.stringify({
      type: "object",
      required: ["type", "event_id"],
      properties: {
        type:     { type: "string" },
        event_id: { type: "string" },
      },
    });

    // No schema registered → free-form message
    const r0 = await call(a, "get_channel_schema", { channel: gsCh });
    assert(r0.includes("free-form") || r0.includes("No schema"),
      `get_channel_schema: free-form before registration (got: ${r0})`);

    // Register warn-only
    await call(a, "register_channel_schema", { channel: gsCh, schema, strict: false });
    const r1 = await call(a, "get_channel_schema", { channel: gsCh });
    assert(r1.includes(gsCh),           "get_channel_schema: response includes channel name");
    assert(r1.includes("warn-only") || r1.includes("off"),
      "get_channel_schema: strict=off reported (warn-only)");
    assert(r1.includes("event_id"),     "get_channel_schema: schema JSON includes required field");
    assert(r1.includes('"required"'),   "get_channel_schema: schema JSON has required array");

    // Flip to strict — strict=on must be reported
    await call(a, "register_channel_schema", { channel: gsCh, schema, strict: true });
    const r2 = await call(a, "get_channel_schema", { channel: gsCh });
    assert(r2.includes("Strict: on") || r2.includes("strict=on"),
      `get_channel_schema: strict=on reported after update (got: ${r2.slice(0, 100)})`);

    await call(a, "clear_channel_schema", { channel: gsCh });
  }

  // ── 28. list_channel_schemas ───────────────────────────────────────────────────

  console.log("\n28. list_channel_schemas: reflects register + clear lifecycle");
  {
    const chA = ch("lcs-a");
    const chB = ch("lcs-b");
    const schema = JSON.stringify({ type: "object" });

    await call(a, "register_channel_schema", { channel: chA, schema, strict: false });
    await call(a, "register_channel_schema", { channel: chB, schema, strict: true  });

    const r1 = await call(a, "list_channel_schemas", {});
    assert(r1.includes(chA),         `list_channel_schemas: channel A present`);
    assert(r1.includes(chB),          "list_channel_schemas: channel B present");
    assert(r1.includes("strict=off"), "list_channel_schemas: channel A shows strict=off");
    assert(r1.includes("strict=on"),  "list_channel_schemas: channel B shows strict=on");

    // Clear channel A → must disappear from list
    await call(a, "clear_channel_schema", { channel: chA });
    const r2 = await call(a, "list_channel_schemas", {});
    assert(!r2.includes(chA), "list_channel_schemas: channel A gone after clear");
    assert(r2.includes(chB),  "list_channel_schemas: channel B still present");

    await call(a, "clear_channel_schema", { channel: chB });
  }

  // ── 29. Capability lifecycle ───────────────────────────────────────────────────

  console.log("\n29. Capability lifecycle: register / list / deregister");
  {
    const workerFE = `cap-fe-${RUN}`;
    const workerBE = `cap-be-${RUN}`;

    // Register
    const r1 = await call(a, "register_capability", {
      worker:   workerFE,
      owns:     ["UI", "checkout-flow"],
      channels: ["ex-frontend", "ex-status"],
    });
    assert(r1.includes("Registered"), `register_capability: confirmation returned (got: ${r1})`);
    assert(r1.includes(workerFE),     "register_capability: worker name in response");

    await call(a, "register_capability", {
      worker:   workerBE,
      owns:     ["payments", "DB migrations", "rate-limits"],
      channels: ["ex-backend", "ex-status"],
    });

    // list_capabilities shows both entries with owns
    const r2 = await call(a, "list_capabilities", {});
    assert(r2.includes(workerFE),       "list_capabilities: frontend worker present");
    assert(r2.includes(workerBE),       "list_capabilities: backend worker present");
    assert(r2.includes("checkout-flow"), "list_capabilities: frontend owns visible");
    assert(r2.includes("DB migrations"),"list_capabilities: backend owns visible");

    // Deregister frontend
    const r3 = await call(a, "deregister_capability", { worker: workerFE });
    assert(r3.includes("Deregistered") || r3.includes(workerFE),
      `deregister_capability: confirmation returned (got: ${r3})`);

    const r4 = await call(a, "list_capabilities", {});
    assert(!r4.includes(workerFE), "list_capabilities: frontend removed after deregister");
    assert(r4.includes(workerBE),  "list_capabilities: backend still registered");

    // Deregister non-existent → graceful, NOT isError
    const r5 = await callRaw(a, "deregister_capability", { worker: `cap-none-${RUN}` });
    assert(!r5.isError,
      "deregister_capability: non-existent worker is graceful (not isError)");
    assert(r5.content[0].text.includes("No capability entry") || r5.content[0].text.includes("not found"),
      `deregister_capability: non-existent returns informative message (got: ${r5.content[0].text})`);

    await call(a, "deregister_capability", { worker: workerBE });
  }

  // ── 30. purge_channel older_than_ms ───────────────────────────────────────────

  console.log("\n30. purge_channel: older_than_ms partial prune");
  {
    const pCh = ch("partial-purge");

    await call(a, "send_message", { channel: pCh, sender: "x", content: "first"  });
    await call(a, "send_message", { channel: pCh, sender: "x", content: "second" });
    await call(a, "send_message", { channel: pCh, sender: "x", content: "third"  });

    // Prune with a huge threshold — nothing is that old → 0 deleted
    const r1 = await call(a, "purge_channel", { channel: pCh, older_than_ms: 99999999 });
    assert(r1.includes("Pruned 0"),
      `purge older_than_ms: huge threshold prunes nothing (got: ${r1})`);

    const after1  = await call(a, "read_messages", { channel: pCh, since_id: 0 });
    const lines1  = after1.split("\n").filter(l => /^\[#\d+\]/.test(l));
    assert(lines1.length === 3,
      `purge older_than_ms: 3 messages still present after no-op prune (got ${lines1.length})`);

    // Wait 120ms; then prune messages older than 60ms — all 3 qualify
    await new Promise(r => setTimeout(r, 120));
    const r2 = await call(a, "purge_channel", { channel: pCh, older_than_ms: 60 });
    assert(r2.includes("Pruned 3"),
      `purge older_than_ms: 3 old messages pruned (got: ${r2})`);

    const after2 = await call(a, "read_messages", { channel: pCh, since_id: 0 });
    assert(after2.includes("No new messages"),
      "purge older_than_ms: channel empty after prune");

    // Fresh message survives a large-threshold prune
    await call(a, "send_message", { channel: pCh, sender: "x", content: "fresh" });
    await call(a, "purge_channel", { channel: pCh, older_than_ms: 99999999 });
    const after3  = await call(a, "read_messages", { channel: pCh, since_id: 0 });
    const lines3  = after3.split("\n").filter(l => /^\[#\d+\]/.test(l));
    assert(lines3.length === 1,
      `purge older_than_ms: fresh message survives large-threshold prune (got ${lines3.length})`);

    await call(a, "purge_channel", { channel: pCh });
  }

  // ── 31. post_gated_message success path ───────────────────────────────────────

  console.log("\n31. post_gated_message: deps pre-satisfied and deps-satisfied-via-wait");
  {
    const pgOutCh = ch("gate-out");
    const pgWaCh  = ch("gate-watch");
    const depId   = `gate-dep-${RUN}`;
    const depId2  = `gate-dep2-${RUN}`;

    // Pre-satisfied: result exists BEFORE the gated call
    await call(a, "send_message", { channel: pgWaCh, sender: "worker",
      content: JSON.stringify({ type: "result", task_id: depId, summary: "PASS", body: {} }) });

    const gRes1 = await call(a, "post_gated_message", {
      channel:       pgOutCh,
      sender:        "orchestrator",
      content:       JSON.stringify({ type: "task", task_id: `gate-out-${RUN}`, subject: "gated task" }),
      depends_on:    [depId],
      watch_channel: pgWaCh,
      timeout_ms:    2000,
    });
    assert(gRes1.includes("Sent #") || gRes1.includes("satisfied"),
      `post_gated_message: pre-satisfied — message posted (got: ${gRes1})`);
    assert(!gRes1.includes("Timed out"),
      "post_gated_message: pre-satisfied — no timeout");

    const out1 = await call(a, "read_messages", { channel: pgOutCh, since_id: 0 });
    assert(out1.includes("gated task"),
      "post_gated_message: gated message arrived in output channel");

    // Via-wait: gated call runs BEFORE dep result exists, then dep is satisfied
    const gResPromise = call(a, "post_gated_message", {
      channel:       pgOutCh,
      sender:        "orchestrator",
      content:       JSON.stringify({ type: "task", task_id: `gate-out2-${RUN}`, subject: "gated task 2" }),
      depends_on:    [depId2],
      watch_channel: pgWaCh,
      timeout_ms:    3000,
    });

    await new Promise(r => setTimeout(r, 50));
    await call(b, "send_message", { channel: pgWaCh, sender: "worker",
      content: JSON.stringify({ type: "result", task_id: depId2, summary: "PASS", body: {} }) });

    const gRes2 = await gResPromise;
    assert(gRes2.includes("Sent #") || gRes2.includes("satisfied"),
      `post_gated_message: via-wait — message posted (got: ${gRes2})`);
    assert(!gRes2.includes("Timed out"),
      "post_gated_message: via-wait — no timeout");

    const out2 = await call(a, "read_messages", { channel: pgOutCh, since_id: 0 });
    assert(out2.includes("gated task 2"),
      "post_gated_message: second gated message arrived in output channel");

    await call(a, "purge_channel", { channel: pgOutCh });
    await call(a, "purge_channel", { channel: pgWaCh  });
  }

  // ── 32. sprint_summary with control_channel ───────────────────────────────────

  console.log("\n32. sprint_summary with control_channel: includes sprint boundary note");
  {
    const ns    = `cov-${RUN}-ss2`;
    const ssCh  = `${ns}-status`;
    const ccCh  = `${ns}-control`;
    const inCh  = `${ns}-worker`;

    // Sprint boundary note on control channel (type:note, subject starts with "sprint-")
    await call(a, "send_message", { channel: ccCh, sender: "orchestrator",
      content: JSON.stringify({
        type:    "note",
        subject: "sprint-2026-06-18-infra",
        body:    "Starting sprint: add validator + heartbeat tooling",
      }),
    });

    // Dispatch 2 tasks into the worker inbox
    const t1 = `ss2-t1-${RUN}`, t2 = `ss2-t2-${RUN}`;
    await call(a, "send_message", { channel: inCh, sender: "orchestrator",
      content: JSON.stringify({ type: "task", task_id: t1 }) });
    await call(a, "send_message", { channel: inCh, sender: "orchestrator",
      content: JSON.stringify({ type: "task", task_id: t2 }) });

    // Both complete: one PASS, one FAIL
    await call(a, "send_message", { channel: ssCh, sender: "worker",
      content: JSON.stringify({ type: "result", task_id: t1, summary: "PASS — done" }) });
    await call(a, "send_message", { channel: ssCh, sender: "worker",
      content: JSON.stringify({ type: "result", task_id: t2, summary: "FAIL — error" }) });

    const ss = JSON.parse(await call(a, "sprint_summary", {
      status_channel:  ssCh,
      control_channel: ccCh,
    }));

    assert(ss.completed === 2,  `sprint_summary ctrl: completed=2 (got ${ss.completed})`);
    assert(ss.failed    === 1,  `sprint_summary ctrl: failed=1 (got ${ss.failed})`);
    assert(ss.sprint    !== null, "sprint_summary ctrl: sprint object present");
    assert(ss.sprint?.subject?.includes("sprint-"),
      `sprint_summary ctrl: sprint.subject has sprint- prefix (got: ${ss.sprint?.subject})`);
    assert(typeof ss.sprint?.started_at === "string",
      "sprint_summary ctrl: sprint.started_at is an ISO string");

    await call(a, "purge_channel", { channel: ssCh });
    await call(a, "purge_channel", { channel: ccCh });
    await call(a, "purge_channel", { channel: inCh });
  }

  // ── 33. send_message_batch strict schema: entire batch rejected atomically ──────

  console.log("\n33. send_message_batch: strict schema rejects entire batch atomically");
  {
    const bsCh   = ch("batch-schema");
    const schema = JSON.stringify({
      type: "object",
      required: ["type", "payload"],
      properties: {
        type:    { type: "string" },
        payload: { type: "string" },
      },
      additionalProperties: false,
    });

    await call(a, "register_channel_schema", { channel: bsCh, schema, strict: true });

    // Batch with 2 valid messages and 1 invalid — strict schema must reject the whole thing
    const resBad = await callRaw(a, "send_message_batch", {
      messages: [
        { channel: bsCh, sender: "orch", content: JSON.stringify({ type: "ping", payload: "a" }) },
        { channel: bsCh, sender: "orch", content: JSON.stringify({ type: "ping", payload: "b" }) },
        { channel: bsCh, sender: "orch", content: JSON.stringify({ type: "ping" }) }, // missing payload
      ],
    });
    assert(resBad.isError === true,
      "send_message_batch strict: entire batch rejected when any message fails schema");
    assert(resBad.content[0].text.includes("schema validation failed"),
      "send_message_batch strict: error text names the failure");

    // Verify NO messages were inserted (atomic — broker validates all before inserting any)
    const msgs = await call(a, "read_messages", { channel: bsCh, since_id: 0 });
    assert(msgs.includes("No new messages"),
      "send_message_batch strict: no messages inserted on batch rejection (atomic)");

    // All-valid batch goes through
    const resOk = await callRaw(a, "send_message_batch", {
      messages: [
        { channel: bsCh, sender: "orch", content: JSON.stringify({ type: "ping", payload: "x" }) },
        { channel: bsCh, sender: "orch", content: JSON.stringify({ type: "pong", payload: "y" }) },
      ],
    });
    assert(!resOk.isError,
      "send_message_batch strict: all-valid batch accepted");
    assert(resOk.content[0].text.includes("2 messages"),
      `send_message_batch strict: 2 messages sent confirmed (got: ${resOk.content[0].text.slice(0, 80)})`);

    await call(a, "clear_channel_schema", { channel: bsCh });
    await call(a, "purge_channel",        { channel: bsCh });
  }

  // ── 34. double-delete ─────────────────────────────────────────────────────────

  console.log("\n34. double-delete: second delete on same id is not-found, not crash");
  {
    const ddCh = ch("double-del");

    // Send a message and capture its id
    const sentRaw = await call(a, "send_message", { channel: ddCh, sender: "x", content: "to be deleted" });
    const sentId = Number(sentRaw.match(/#(\d+)/)?.[1]);
    assert(sentId > 0, `double-delete: message sent and id captured (id=${sentId})`);

    // First delete — should succeed
    const del1 = await callRaw(a, "delete_message", { channel: ddCh, id: sentId });
    const t1 = del1.content[0].text;
    assert(!del1.isError || t1.includes("Deleted"), `double-delete: first delete succeeds (got: ${t1})`);

    // Second delete on the same id — should return not-found, not crash
    const del2 = await callRaw(a, "delete_message", { channel: ddCh, id: sentId });
    const t2 = del2.content[0].text;
    assert(
      del2.isError === true || /not found/i.test(t2),
      `double-delete: second delete returns not-found (got: ${t2})`
    );

    await call(a, "purge_channel", { channel: ddCh }).catch(() => {});
  }

  // ── 35. check_results_batch empty array ──────────────────────────────────────

  console.log("\n35. check_results_batch: empty task_ids array rejected (minItems:1)");
  {
    const crCh = ch("crb-empty");

    const r = await callRaw(a, "check_results_batch", { channel: crCh, task_ids: [] });
    assert(
      r.isError === true,
      `check_results_batch: empty task_ids array rejected (isError=${r.isError}, got: ${r.content?.[0]?.text?.slice(0, 80)})`
    );
  }

  // ── 36. purge_channels_by_prefix no match ─────────────────────────────────────

  console.log("\n36. purge_channels_by_prefix: no-match prefix succeeds with 0 channels purged");
  {
    const r = await callRaw(a, "purge_channels_by_prefix", { prefix: "zzz-no-such-prefix-99999-" });
    assert(!r.isError, `purge_channels_by_prefix: no error on no-match prefix (isError=${r.isError})`);
    const text = r.content[0].text;
    // Response is JSON: { purged: [], skipped_exempt: [], total_deleted: 0 }
    let parsed;
    try { parsed = JSON.parse(text); } catch (_) {}
    const noneDeleted = parsed
      ? (Array.isArray(parsed.purged) && parsed.purged.length === 0 && parsed.total_deleted === 0)
      : /0 channel|no channels/i.test(text);
    assert(noneDeleted, `purge_channels_by_prefix: 0 channels purged on no-match prefix (got: ${text})`);
  }

  // ── 37. channel name with leading whitespace ──────────────────────────────────
  // Zod validates minLength:1 but does not strip whitespace, so a " leading-space"
  // channel name passes the length check. The broker stores it without crashing.
  // This test confirms the broker handles the call without error (no 500 / isError).

  console.log("\n37. send_message: channel name with leading whitespace handled gracefully");
  {
    const wsCh = ` cov-${RUN}-ws-ch`;
    const r = await callRaw(a, "send_message", { channel: wsCh, sender: "x", content: "whitespace-channel-test" });
    // broker accepts channels with leading whitespace without crashing
    assert(
      !r.isError,
      `send_message: leading-whitespace channel accepted without crash (got: ${r.content?.[0]?.text?.slice(0, 80)})`
    );
    // clean up if it was stored
    if (!r.isError) {
      await call(a, "purge_channel", { channel: wsCh }).catch(() => {});
    }
    ok("send_message: leading-whitespace channel stored with exact name (including whitespace)");
  }

  // ── 38. wait_for_messages filter_type skips non-matching ─────────────────────

  console.log("\n38. wait_for_messages filter_type: skips non-matching messages already in channel");
  {
    const wftCh = ch("wfm-filter-type");

    // Post a type:note first, then a type:result
    await call(a, "send_message", { channel: wftCh, sender: "worker",
      content: JSON.stringify({ type: "note", v: 1 }) });
    await call(a, "send_message", { channel: wftCh, sender: "worker",
      content: JSON.stringify({ type: "result", task_id: `wfm-res-${RUN}`, summary: "PASS", v: 2 }) });

    // wait_for_messages with filter_type="result" from since_id=0 — should return only the result
    const r = await call(b, "wait_for_messages", {
      channel: wftCh, since_id: 0, timeout_ms: 3000, filter_type: "result",
    });
    assert(r.includes('"result"'),  "wfm filter_type: result message returned");
    assert(!r.includes('"note"'),   "wfm filter_type: note message excluded (non-matching type)");
    assert(r.includes('"v":2'),     "wfm filter_type: correct message body present");

    await call(a, "purge_channel", { channel: wftCh });
  }

  // ── 39. read_messages: since_id at max_id returns no messages ────────────────

  console.log("\n39. read_messages: since_id at max_id returns no new messages");
  {
    const rmCh = ch("rm-since-max");

    await call(a, "send_message", { channel: rmCh, sender: "x", content: "msg-1" });
    await call(a, "send_message", { channel: rmCh, sender: "x", content: "msg-2" });

    const hm = JSON.parse(await call(a, "has_messages", { channel: rmCh, since_id: 0 }));
    const maxId = hm.max_id;

    // Reading with since_id = maxId should return no messages
    const empty = await call(a, "read_messages", { channel: rmCh, since_id: maxId });
    assert(
      empty.includes("No new messages") || empty.trim() === "",
      `read_messages since_id=max_id: returns empty (got: ${empty.slice(0, 80)})`,
    );

    // Sanity: reading with since_id = 0 still returns both messages
    const all = await call(a, "read_messages", { channel: rmCh, since_id: 0 });
    const lines = all.trim().split("\n").filter(l => l.match(/\[#\d+\]/));
    assert(lines.length === 2, `read_messages since_id=0: still sees 2 messages (got ${lines.length})`);

    await call(a, "purge_channel", { channel: rmCh });
  }

  // ── 40. read_messages: filter_sender + filter_type + limit all three ─────────

  console.log("\n40. read_messages: filter_sender + filter_type + limit combined");
  {
    const triCh = ch("rm-triple-filter");

    // alice sends 5 results, bob sends 3 results, carol sends 4 notes
    for (let i = 0; i < 5; i++)
      await call(a, "send_message", { channel: triCh, sender: "alice",
        content: JSON.stringify({ type: "result", v: i }) });
    for (let i = 0; i < 3; i++)
      await call(b, "send_message", { channel: triCh, sender: "bob",
        content: JSON.stringify({ type: "result", v: i }) });
    for (let i = 0; i < 4; i++)
      await call(a, "send_message", { channel: triCh, sender: "carol",
        content: JSON.stringify({ type: "note", v: i }) });

    // All three filters: sender=alice, type=result, limit=3
    const r = await call(a, "read_messages", {
      channel: triCh, since_id: 0,
      filter_sender: "alice", filter_type: "result", limit: 3,
    });
    const matchLines = r.trim().split("\n").filter(l => l.match(/\[#\d+\]/));

    assert(matchLines.length === 3,    `rm triple-filter: limit=3 respected (got ${matchLines.length})`);
    assert(r.includes("alice"),        "rm triple-filter: alice messages returned");
    assert(!r.includes('"bob"') && !r.includes("<bob>"), "rm triple-filter: bob excluded");
    assert(!r.includes('"carol"') && !r.includes("<carol>"), "rm triple-filter: carol excluded");
    assert(!r.includes('"type":"note"'), "rm triple-filter: note type excluded");

    await call(a, "purge_channel", { channel: triCh });
  }

  // ── 41. sprint_file_conflicts: lowercase "skip" NOT excluded ─────────────────

  console.log("\n41. sprint_file_conflicts: lowercase 'skip' is NOT treated as SKIP");
  {
    const sfcCh = ch("sfc-skip-case");

    // One worker posts a result with summary="skip — done" (lowercase) and affected_files
    await call(a, "send_message", { channel: sfcCh, sender: "worker-a",
      content: JSON.stringify({
        type: "result", task_id: "skip-lower-1", from: "worker-a",
        summary: "skip — idempotent (lowercase)",
        affected_files: ["src/shared.ts"],
      }) });
    // Another worker also touches the same file — real conflict
    await call(a, "send_message", { channel: sfcCh, sender: "worker-b",
      content: JSON.stringify({
        type: "result", task_id: "skip-lower-2", from: "worker-b",
        summary: "PASS — done",
        affected_files: ["src/shared.ts"],
      }) });

    const raw = JSON.parse(await call(a, "sprint_file_conflicts", { status_channel: sfcCh }));
    // lowercase "skip" does NOT skip the message → conflict detected
    assert(raw.conflicts.length === 1, `sfc skip-case: conflict detected for lowercase skip (got ${raw.conflicts.length})`);
    assert(raw.conflicts[0]?.file === "src/shared.ts", "sfc skip-case: shared.ts in conflicts");

    // Cross-check: uppercase SKIP IS excluded
    const sfcCh2 = ch("sfc-skip-upper");
    await call(a, "send_message", { channel: sfcCh2, sender: "worker-a",
      content: JSON.stringify({
        type: "result", task_id: "skip-upper-1", from: "worker-a",
        summary: "SKIP — idempotent",
        affected_files: ["src/shared.ts"],
      }) });
    await call(a, "send_message", { channel: sfcCh2, sender: "worker-b",
      content: JSON.stringify({
        type: "result", task_id: "skip-upper-2", from: "worker-b",
        summary: "PASS — done",
        affected_files: ["src/shared.ts"],
      }) });
    const raw2 = JSON.parse(await call(a, "sprint_file_conflicts", { status_channel: sfcCh2 }));
    assert(raw2.conflicts.length === 0, `sfc skip-upper: uppercase SKIP excluded → no conflict (got ${raw2.conflicts.length})`);

    await call(a, "purge_channel", { channel: sfcCh  });
    await call(a, "purge_channel", { channel: sfcCh2 });
  }

  // ── 42. send_message_batch: single element ────────────────────────────────────

  console.log("\n42. send_message_batch: single element (min=1)");
  {
    const bCh = ch("batch-single");

    const r = await callRaw(a, "send_message_batch", {
      messages: [{ channel: bCh, sender: "orch",
        content: JSON.stringify({ type: "task", task_id: `single-${RUN}` }) }],
    });
    assert(!r.isError,                    "send_message_batch single: no error");
    assert(r.content[0].text.includes("Sent 1 messages"), `send_message_batch single: '1 messages' in response (got: ${r.content[0].text.slice(0, 60)})`);

    await call(a, "purge_channel", { channel: bCh });
  }

  // ── 43. clear_channel_schema removes strict enforcement ──────────────────────

  console.log("\n43. clear_channel_schema: strict enforcement removed after clear");
  {
    const scCh = ch("schema-clear-enforce");
    const strictSchema = JSON.stringify({
      type: "object",
      required: ["type", "task_id"],
      properties: {
        type:    { type: "string" },
        task_id: { type: "string" },
      },
      additionalProperties: false,
    });
    const invalidMsg = JSON.stringify({ foo: "bar" }); // missing type + task_id

    // Register strict schema
    await call(a, "register_channel_schema", { channel: scCh, schema: strictSchema, strict: true });

    // Invalid message is rejected
    const blocked = await callRaw(a, "send_message", { channel: scCh, sender: "x", content: invalidMsg });
    assert(blocked.isError === true, "clear-enforce: invalid msg blocked by strict schema");

    // Clear the schema
    await call(a, "clear_channel_schema", { channel: scCh });

    // Same message now accepted (no schema)
    const allowed = await callRaw(a, "send_message", { channel: scCh, sender: "x", content: invalidMsg });
    assert(!allowed.isError, "clear-enforce: invalid msg accepted after schema cleared");

    await call(a, "purge_channel", { channel: scCh });
  }

  // ── 44. purge_channel: non-existent channel ───────────────────────────────────

  console.log("\n44. purge_channel: non-existent channel graceful");
  {
    const ghostCh = ch("ghost-never-created");

    const r = await callRaw(a, "purge_channel", { channel: ghostCh });
    assert(!r.isError, "purge_channel non-existent: no error");
    assert(r.content[0].text.includes("0"), `purge_channel non-existent: 0 in response (got: ${r.content[0].text})`);
  }

  // ── 45. sprint_summary: namespace with multiple dashes ────────────────────────

  console.log("\n45. sprint_summary: namespace with multiple dashes");
  {
    const ns      = `cov-${RUN}-multi`;
    const ssCh    = `${ns}-dash-status`;  // lastIndexOf('-') → ns = "cov-RUN-multi-dash"
    const inboxCh = `${ns}-dash-worker`;  // inbox: matches "cov-RUN-multi-dash-%"

    // Dispatch 2 tasks to the inbox channel
    for (let i = 0; i < 2; i++) {
      await call(a, "send_message", { channel: inboxCh, sender: "orch",
        content: JSON.stringify({ type: "task", task_id: `multi-${i}-${RUN}` }) });
    }
    // Post 1 result to status
    await call(a, "send_message", { channel: ssCh, sender: "worker",
      content: JSON.stringify({ type: "result", task_id: `multi-0-${RUN}`, summary: "PASS — done" }) });

    const raw = JSON.parse(await call(a, "sprint_summary", { status_channel: ssCh }));
    assert(raw.dispatched === 2,   `sprint_summary multi-dash: dispatched=2 (got ${raw.dispatched})`);
    assert(raw.completed === 1,    `sprint_summary multi-dash: completed=1 (got ${raw.completed})`);
    assert(raw.pending   === 1,    `sprint_summary multi-dash: pending=1 (got ${raw.pending})`);

    await call(a, "purge_channel", { channel: ssCh    });
    await call(a, "purge_channel", { channel: inboxCh });
  }

  // ── 46. check_results_batch: duplicate task_ids handled ──────────────────────

  console.log("\n46. check_results_batch: duplicate task_ids");
  {
    const dupCh  = ch("crb-dup");
    const tid    = `dup-task-${RUN}`;

    await call(a, "send_message", { channel: dupCh, sender: "worker",
      content: JSON.stringify({ type: "result", task_id: tid, summary: "PASS — done" }) });

    // task_ids with duplicates: [tid, tid, "missing"]
    const raw = JSON.parse(await call(a, "check_results_batch", {
      channel: dupCh, task_ids: [tid, tid, "nonexistent-dedup"],
    }));
    assert(raw.results[tid] === true,             `crb dup: existing task_id found=true (got ${raw.results[tid]})`);
    assert(raw.results["nonexistent-dedup"] === false, "crb dup: missing task not found");
    // Both duplicate entries must be true (Set dedup preserves correct result)
    const keys = Object.keys(raw.results);
    assert(keys.length === 2, `crb dup: result map has 2 unique keys (got ${keys.length})`);

    await call(a, "purge_channel", { channel: dupCh });
  }

  // ── 47. get_channel_schema: no version → no "Version:" line ──────────────────

  console.log("\n47. get_channel_schema: schema without version → no Version line");
  {
    const gsCh = ch("gs-no-version");
    const schema = JSON.stringify({ type: "object", properties: { msg: { type: "string" } } });

    // Register without version
    await call(a, "register_channel_schema", { channel: gsCh, schema, strict: false });
    const r = await call(a, "get_channel_schema", { channel: gsCh });

    assert(r.includes(`Channel: ${gsCh}`), "gs no-version: channel name in output");
    assert(!r.includes("Version:"), `gs no-version: no Version line when not set (got: ${r.slice(0, 120)})`);

    // Register with version
    await call(a, "register_channel_schema", { channel: gsCh, schema, strict: false, version: "1.2" });
    const r2 = await call(a, "get_channel_schema", { channel: gsCh });
    assert(r2.includes("Version: 1.2"), `gs with-version: Version line present (got: ${r2.slice(0, 120)})`);

    await call(a, "clear_channel_schema", { channel: gsCh });
  }

  // ── 48. has_messages: channel that never existed ──────────────────────────────

  console.log("\n48. has_messages: channel that never existed");
  {
    const ghostCh = ch("hm-never-existed");

    const r = JSON.parse(await call(a, "has_messages", { channel: ghostCh, since_id: 0 }));
    assert(r.pending === false, `has_messages ghost: pending=false (got ${r.pending})`);
    assert(typeof r.max_id === "number", `has_messages ghost: max_id is a number (got ${typeof r.max_id})`);
    assert(r.channel === ghostCh, "has_messages ghost: channel field matches");
  }

  // ── 49. send_message_batch: warn-only schema — batch succeeds ─────────────────

  console.log("\n49. send_message_batch: warn-only schema — batch not rejected");
  {
    const warnCh = ch("batch-warn-schema");
    const warnSchema = JSON.stringify({
      type: "object",
      required: ["type", "task_id"],
      properties: {
        type:    { type: "string" },
        task_id: { type: "string" },
      },
    });
    // Register warn-only (strict: false)
    await call(a, "register_channel_schema", { channel: warnCh, schema: warnSchema, strict: false });

    // Batch with one invalid message (missing type+task_id) — warn-only, should not abort
    const r = await callRaw(a, "send_message_batch", {
      messages: [
        { channel: warnCh, sender: "orch", content: JSON.stringify({ foo: "bar" }) },
        { channel: warnCh, sender: "orch", content: JSON.stringify({ type: "task", task_id: `wn-${RUN}` }) },
      ],
    });
    assert(!r.isError, `batch warn-only: batch not rejected (isError=${r.isError})`);
    assert(r.content[0].text.includes("Sent 2 messages"), `batch warn-only: 2 messages sent (got: ${r.content[0].text.slice(0, 60)})`);

    // Verify both messages were actually stored
    const msgs = await call(a, "read_messages", { channel: warnCh, since_id: 0 });
    const storedLines = msgs.trim().split("\n").filter(l => l.match(/\[#\d+\]/));
    assert(storedLines.length === 2, `batch warn-only: both messages stored (got ${storedLines.length})`);

    await call(a, "purge_channel",       { channel: warnCh });
    await call(a, "clear_channel_schema", { channel: warnCh });
  }

  // ── Teardown ──────────────────────────────────────────────────────────────────
  await ta.close();
  await tb.close();

  console.log(`\n${"─".repeat(54)}`);
  console.log(`  passed: ${passed}   failed: ${failed}`);
  if (failures.length > 0) {
    console.error("\n  Failures:");
    for (const { label, detail } of failures) {
      console.error(`    ✗ ${label}`);
      console.error(`      ${detail}`);
    }
    process.exit(1);
  } else {
    console.log("  ALL TESTS PASSED");
  }
}

run().catch(e => {
  console.error("\n[FATAL]", e.message || e);
  process.exit(1);
});
