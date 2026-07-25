/**
 * test-regression-fixes.js — behavioral regression tests for the 2026-06-09 fix batch.
 *
 * Focuses on observable behaviour changes (not just API surface):
 *   Fix A: sprint_summary.dispatched counts task messages from inbox channels (not status channel)
 *   Fix B: Channel names with control characters are rejected (MCP + REST)
 *   Fix C: POST /messages requires auth when SHARED_SECRET is set
 *   Fix D: ex-status schema warns when type:result is missing 'summary'
 *   Fix E: ex-status schema warns when type:result body is missing 'consent_basis'
 *   Fix F: ex-worker-inbox schema accepts 'ui_verified_instructions' under strict mode
 *   Fix G: ex-status schema warns when type:result has body.commits but omits affected_files
 *
 * Run:  node test-regression-fixes.js
 * Requires a running broker at BROKER_URL (default http://localhost:8080).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync } from "fs";
import "dotenv/config";

const BROKER_URL  = process.env.BROKER_URL    || "http://localhost:8080/mcp";
const BROKER_HTTP = BROKER_URL.replace("/mcp", "");
const SECRET      = process.env.SHARED_SECRET || "";
const RUN         = Date.now().toString(36);

let passed = 0;
let failed = 0;
const failures = [];

function ok(label)   { console.log(`  ✓ ${label}`); passed++; }
function fail(label, detail) {
  console.error(`  ✗ ${label}: ${detail}`);
  failures.push({ label, detail });
  failed++;
}
function assert(cond, label, detail = "assertion failed") {
  cond ? ok(label) : fail(label, String(detail));
}

function ch(name) { return `reg-${RUN}-${name}`; }

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

async function restNoAuth(method, path, body) {
  const headers = { "Content-Type": "application/json" };
  const opts = { method, headers };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return fetch(`${BROKER_HTTP}${path}`, opts);
}

async function run() {
  const { client: a, transport: ta } = await connect("reg-a");
  const { client: b, transport: tb } = await connect("reg-b");
  console.log(`\n[test-regression-fixes]  broker=${BROKER_URL}  run=${RUN}\n`);

  // ─────────────────────────────────────────────────────────────────────────────
  // Fix A: sprint_summary.dispatched counts task messages from inbox channels
  //
  // Before the fix: stmtSprintProgress counted type:task on the STATUS channel.
  // The ex-status schema enum has no 'task' type, so dispatched was always 0.
  //
  // After the fix: stmtSprintDispatched counts type:task on non-meta channels
  // matching the namespace prefix (derived by stripping the last '-' segment
  // from status_channel, e.g. "ns-status" → "ns").
  // ─────────────────────────────────────────────────────────────────────────────

  console.log("Fix A. sprint_summary.dispatched counts from inbox (non-meta) channels");
  {
    const ns      = ch("ss");
    const statusCh  = `${ns}-status`;
    const inboxCh   = `${ns}-backend`;   // inbox — counted by stmtSprintDispatched
    const metaCh    = `${ns}-control`;   // meta  — excluded by stmtSprintDispatched

    // Dispatch 2 tasks to the inbox channel
    for (let i = 1; i <= 2; i++) {
      await call(a, "send_message", {
        channel: inboxCh,
        sender:  "orchestrator",
        content: JSON.stringify({ type: "task", task_id: `task-${RUN}-${i}`, from: "orchestrator", to: "backend", subject: `task ${i}` }),
      });
    }

    // Post a type:task to the meta/control channel — must NOT be counted
    await call(a, "send_message", {
      channel: metaCh,
      sender:  "orchestrator",
      content: JSON.stringify({ type: "task", task_id: `meta-task-${RUN}`, from: "orchestrator", to: "backend", subject: "meta task" }),
    });

    // Post 1 result to the status channel
    await call(a, "send_message", {
      channel: statusCh,
      sender:  "backend",
      content: JSON.stringify({
        type: "result", task_id: `task-${RUN}-1`, from: "backend", to: "orchestrator",
        subject: "task 1 done",
        summary: "PASS — task completed",
        body: { consent_basis: "orchestrator-dispatch-only" },
      }),
    });

    const raw  = await call(a, "sprint_summary", { status_channel: statusCh });
    const info = JSON.parse(raw);

    assert(info.dispatched === 2,   "dispatched = 2 (tasks on inbox channel only)");
    assert(info.completed  === 1,   "completed  = 1 (result on status channel)");
    assert(info.failed     === 0,   "failed     = 0");
    assert(info.pending    === 1,   "pending    = dispatched - completed = 1");
  }

  // Verify that tasks posted directly to the status channel do NOT inflate dispatched
  console.log("\nFix A (guard). Tasks on status channel do not count as dispatched");
  {
    const ns      = ch("ss-guard");
    const statusCh  = `${ns}-status`;

    // Post a type:task directly to the status channel (wrong place — never valid per schema)
    await call(a, "send_message", {
      channel: statusCh,
      sender:  "orchestrator",
      content: JSON.stringify({ type: "task", task_id: `bad-task-${RUN}`, from: "orchestrator", to: "backend", subject: "should not count" }),
    });

    const raw  = await call(a, "sprint_summary", { status_channel: statusCh });
    const info = JSON.parse(raw);
    assert(info.dispatched === 0, "tasks on status channel excluded (dispatched = 0)");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Fix B: Channel names with control characters are rejected
  //
  // Before the fix: any string was accepted as a channel name.
  // After the fix:  isValidChannelName() rejects chars in U+0000–U+001F and U+007F.
  // Applies to both MCP send_message and REST POST /messages.
  // ─────────────────────────────────────────────────────────────────────────────

  console.log("\nFix B. Channel names with control characters are rejected");
  {
    const badNames = [
      "chan\x00null",
      "chan\x01soh",
      "chan\x1fus",
      "chan\x7fdel",
      "chan\nnewline",
      "chan\ttab",
    ];

    for (const bad of badNames) {
      // MCP path
      const res = await callRaw(a, "send_message", {
        channel: bad,
        sender:  "test",
        content: "hello",
      });
      assert(
        res.isError === true,
        `MCP rejects channel with control char ${JSON.stringify(bad)}`,
        `isError=${res.isError}, text=${res.content[0]?.text}`
      );

      // REST path
      const r = await rest("POST", "/messages", {
        channel: bad,
        sender:  "test",
        content: "hello",
      });
      assert(r.status === 400, `REST 400 for channel with control char ${JSON.stringify(bad)}`, `status=${r.status}`);
    }

    // Valid names must still pass — use test-scoped names to avoid writing to production channels
    const validNames = [ch("ex-status"), `my.channel.${RUN}`, `ns_backend-${RUN}`, `αβγ-${RUN}`];
    for (const good of validNames) {
      const res = await callRaw(a, "send_message", {
        channel: good,
        sender:  "test",
        content: "hello",
      });
      assert(
        res.isError !== true,
        `MCP accepts valid channel name ${JSON.stringify(good)}`,
        `isError=${res.isError}, text=${res.content[0]?.text}`
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Fix C: POST /messages requires auth when SHARED_SECRET is set
  //
  // Before the fix: POST /messages had no auth middleware.
  // After the fix:  app.post("/messages", auth, ...) — 401 without token when
  //                 SHARED_SECRET is set; pass-through when unset.
  // ─────────────────────────────────────────────────────────────────────────────

  console.log("\nFix C. POST /messages auth enforcement");
  {
    const payload = {
      channel: ch("auth-test"),
      sender:  "watchdog",
      content: JSON.stringify({ type: "heartbeat", state: "session-end" }),
    };

    if (SECRET) {
      const noAuth = await restNoAuth("POST", "/messages", payload);
      assert(noAuth.status === 401, "POST /messages → 401 without token (SHARED_SECRET set)");

      const withAuth = await rest("POST", "/messages", payload);
      assert(withAuth.status === 200, "POST /messages → 200 with valid Bearer token");

      const wrongToken = await fetch(`${BROKER_HTTP}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-token" },
        body: JSON.stringify(payload),
      });
      assert(wrongToken.status === 401, "POST /messages → 401 with wrong token");
    } else {
      const noAuth = await restNoAuth("POST", "/messages", payload);
      assert(noAuth.status === 200, "POST /messages → 200 without auth (SHARED_SECRET unset)");
      console.log("    (SHARED_SECRET not set — auth=off branch tested only)");
    }

    // GET /inbox requires auth when SHARED_SECRET is set (watchdog must carry the token)
    const inboxNoAuth = await restNoAuth("GET", `/inbox?channel=${ch("auth-test-inbox")}&since_id=0`);
    assert(inboxNoAuth.status === 401, "GET /inbox requires auth (401 without token)");
    const inboxR = await rest("GET", `/inbox?channel=${ch("auth-test-inbox")}&since_id=0`);
    assert(inboxR.status === 200, "GET /inbox returns 200 with valid token");

    // GET /health must remain public
    const healthR = await restNoAuth("GET", "/health");
    assert(healthR.status === 200, "GET /health remains public");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Fix D: ex-status schema warns when type:result is missing 'summary'
  //
  // Before the fix: the 'summary' field was not enforced by the allOf rule.
  // After the fix:  type:result must carry a 'summary' field; violations produce
  //                 a warning in warn mode and an error in strict mode.
  // ─────────────────────────────────────────────────────────────────────────────

  console.log("\nFix D. ex-status schema: type:result requires summary");
  {
    const warnCh   = ch("ex-status-warn");
    const strictCh = ch("ex-status-strict");
    const statusSchema = readFileSync("schemas/status.json", "utf-8");

    await call(a, "register_channel_schema", { channel: warnCh,   schema: statusSchema, strict: false });
    await call(a, "register_channel_schema", { channel: strictCh, schema: statusSchema, strict: true  });

    const resultNoSummary = JSON.stringify({
      type: "result",
      task_id: `t-${RUN}`,
      from: "backend",
      to:   "orchestrator",
      subject: "done",
      body: { consent_basis: "orchestrator-dispatch-only" },
      // summary intentionally absent
    });

    // Warn mode: message is accepted but response text contains WARN
    const warnRes = await callRaw(a, "send_message", { channel: warnCh, sender: "backend", content: resultNoSummary });
    assert(warnRes.isError !== true, "warn mode: message accepted despite missing summary");
    assert(
      warnRes.content[0]?.text?.includes("WARN"),
      "warn mode: response contains WARN notice for missing summary",
      warnRes.content[0]?.text
    );

    // Strict mode: message is rejected
    const strictRes = await callRaw(a, "send_message", { channel: strictCh, sender: "backend", content: resultNoSummary });
    assert(strictRes.isError === true, "strict mode: message rejected when summary absent");

    // Valid result with summary must pass strict mode
    const resultWithSummary = JSON.stringify({
      type: "result",
      task_id: `t-${RUN}-ok`,
      from: "backend",
      to:   "orchestrator",
      subject: "done",
      summary: "PASS — all checks green",
      body: { consent_basis: "orchestrator-dispatch-only" },
    });
    const okRes = await callRaw(a, "send_message", { channel: strictCh, sender: "backend", content: resultWithSummary });
    assert(okRes.isError !== true, "strict mode: valid result with summary is accepted");
    assert(!okRes.content[0]?.text?.includes("WARN"), "strict mode: no WARN for fully-valid result");

    // Non-result types must not require summary
    const nonResult = JSON.stringify({
      type: "status",
      task_id: `t-${RUN}-s`,
      from: "backend",
      to:   "orchestrator",
      subject: "in progress",
    });
    const nonResultRes = await callRaw(a, "send_message", { channel: strictCh, sender: "backend", content: nonResult });
    assert(nonResultRes.isError !== true, "strict mode: type:status without summary is accepted");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Fix E: ex-status schema warns when type:result body is missing 'consent_basis'
  //
  // Before the fix: consent_basis was only required when body.production_touching === true.
  // After the fix:  consent_basis is required in body on ALL type:result with a body object.
  // ─────────────────────────────────────────────────────────────────────────────

  console.log("\nFix E. ex-status schema: type:result body requires consent_basis");
  {
    const warnCh   = ch("consent-warn");
    const strictCh = ch("consent-strict");
    const statusSchema = readFileSync("schemas/status.json", "utf-8");

    await call(a, "register_channel_schema", { channel: warnCh,   schema: statusSchema, strict: false });
    await call(a, "register_channel_schema", { channel: strictCh, schema: statusSchema, strict: true  });

    const resultNoConsent = JSON.stringify({
      type: "result",
      task_id: `t-${RUN}-nc`,
      from: "backend",
      to:   "orchestrator",
      subject: "done",
      summary: "PASS — task complete",
      body: { some_other_field: true },  // consent_basis missing
    });

    // Warn mode: accepted with WARN
    const warnRes = await callRaw(a, "send_message", { channel: warnCh, sender: "backend", content: resultNoConsent });
    assert(warnRes.isError !== true, "warn mode: result without consent_basis is accepted");
    assert(
      warnRes.content[0]?.text?.includes("WARN"),
      "warn mode: WARN notice emitted for missing consent_basis",
      warnRes.content[0]?.text
    );

    // Strict mode: rejected
    const strictRes = await callRaw(a, "send_message", { channel: strictCh, sender: "backend", content: resultNoConsent });
    assert(strictRes.isError === true, "strict mode: result without consent_basis is rejected");

    // Valid: consent_basis present
    const resultOk = JSON.stringify({
      type: "result",
      task_id: `t-${RUN}-cb`,
      from: "backend",
      to:   "orchestrator",
      subject: "done",
      summary: "PASS — committed",
      body: { consent_basis: "orchestrator-dispatch-only" },
    });
    const okRes = await callRaw(a, "send_message", { channel: strictCh, sender: "backend", content: resultOk });
    assert(okRes.isError !== true, "strict mode: result with consent_basis is accepted");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Fix F: ex-worker-inbox schema accepts 'ui_verified_instructions' field
  //
  // Before the fix: ui_verified_instructions was not listed in properties, so
  //                 additionalProperties:false caused strict-mode rejection.
  // After the fix:  ui_verified_instructions is a declared property — passes strict.
  // ─────────────────────────────────────────────────────────────────────────────

  console.log("\nFix F. ex-worker-inbox schema: ui_verified_instructions accepted in strict mode");
  {
    const strictCh = ch("inbox-strict");
    const inboxSchema = readFileSync("schemas/worker-inbox.json", "utf-8");

    await call(a, "register_channel_schema", { channel: strictCh, schema: inboxSchema, strict: true });

    // Task with ui_verified in required_checks AND ui_verified_instructions present
    const taskWithUiInstructions = JSON.stringify({
      type: "task",
      task_id: `fix-2026-06-20-ui-task`,
      from:    "orchestrator",
      to:      "frontend",
      subject: "UI test task",
      body:    "verify the award badge flow",
      required_checks: ["lint", "build", "ui_verified"],
      ui_verified_instructions: "Open /dogs → click Award Badge → confirm dropdown shows badge names",
    });

    const res = await callRaw(a, "send_message", { channel: strictCh, sender: "orchestrator", content: taskWithUiInstructions });
    assert(res.isError !== true, "strict mode: task with ui_verified_instructions is accepted");
    assert(!res.content[0]?.text?.includes("WARN"), "strict mode: no WARN for valid task with ui_verified_instructions");

    // Task WITHOUT ui_verified_instructions must also be accepted (field is optional)
    const taskNoUi = JSON.stringify({
      type: "task",
      task_id: `fix-2026-06-20-no-ui-task`,
      from:    "orchestrator",
      to:      "backend",
      subject: "Non-UI task",
      body:    "run backend checks",
      required_checks: ["lint", "build", "test"],
    });
    const resNoUi = await callRaw(a, "send_message", { channel: strictCh, sender: "orchestrator", content: taskNoUi });
    assert(resNoUi.isError !== true, "strict mode: task without ui_verified_instructions is still accepted");

    // Unknown extra field must still be rejected by additionalProperties:false
    const taskBadField = JSON.stringify({
      type: "task",
      task_id: `bad-field-task-${RUN}`,
      from:    "orchestrator",
      to:      "backend",
      subject: "Task with unknown extra field",
      unknown_extra: "this should fail",
    });
    const resBad = await callRaw(a, "send_message", { channel: strictCh, sender: "orchestrator", content: taskBadField });
    assert(resBad.isError === true, "strict mode: task with unknown extra field is still rejected");
  }

  // Fix G: ex-status schema requires affected_files when body.commits is non-empty
  //
  // Before the fix: affected_files had no conditional requirement — a type:result
  //                 with commits could omit it without a schema violation.
  // After the fix:  an allOf if/then in ex-status.json makes affected_files required
  //                 (minItems:1) whenever body.commits is present and non-empty.
  //                 This ensures sprint_file_conflicts has data to detect conflicts.
  // ─────────────────────────────────────────────────────────────────────────────

  console.log("\nFix G. ex-status schema: affected_files required when body.commits is non-empty");
  {
    const statusCh = ch("status-affected-files");
    const statusSchema = readFileSync("schemas/status.json", "utf-8");

    // Register ex-status schema in WARN mode (not strict) — matches production default.
    await call(a, "register_channel_schema", { channel: statusCh, schema: statusSchema, strict: false });

    // Case 1: result WITH commits but WITHOUT affected_files → should WARN
    const resultNoFiles = JSON.stringify({
      type: "result",
      task_id: `g-no-files-${RUN}`,
      from:    "backend",
      to:      "orchestrator",
      subject: "task done",
      summary: "PASS — migration applied",
      body: {
        consent_basis: "orchestrator-dispatch-only",
        commits: [{ sha: "abc1234", branch: "feat/deposit" }],
      },
    });
    const resNoFiles = await callRaw(a, "send_message", { channel: statusCh, sender: "backend", content: resultNoFiles });
    assert(resNoFiles.isError !== true,                              "Fix G: result with commits but no affected_files is not rejected (warn mode)");
    assert(resNoFiles.content[0].text.includes("WARN"),             "Fix G: result with commits but no affected_files produces WARN");

    // Case 2: result WITH commits AND affected_files → no warn
    const resultWithFiles = JSON.stringify({
      type: "result",
      task_id: `g-with-files-${RUN}`,
      from:    "backend",
      to:      "orchestrator",
      subject: "task done",
      summary: "PASS — migration applied",
      affected_files: ["backend/src/jobs/deposit-reconciliation.service.ts"],
      body: {
        consent_basis: "orchestrator-dispatch-only",
        commits: [{ sha: "abc1234", branch: "feat/deposit" }],
      },
    });
    const resWithFiles = await callRaw(a, "send_message", { channel: statusCh, sender: "backend", content: resultWithFiles });
    assert(resWithFiles.isError !== true,                           "Fix G: result with commits and affected_files is accepted");
    assert(!resWithFiles.content[0].text.includes("WARN"),         "Fix G: result with commits and affected_files produces no WARN");

    // Case 3: result WITHOUT commits can omit affected_files (no warn)
    const resultNoCommits = JSON.stringify({
      type: "result",
      task_id: `g-no-commits-${RUN}`,
      from:    "backend",
      to:      "orchestrator",
      subject: "read-only task done",
      summary: "PASS — baseline captured",
      body: { consent_basis: "orchestrator-dispatch-only" },
    });
    const resNoCommits = await callRaw(a, "send_message", { channel: statusCh, sender: "backend", content: resultNoCommits });
    assert(resNoCommits.isError !== true,                          "Fix G: result without commits can omit affected_files");
    assert(!resNoCommits.content[0].text.includes("WARN"),         "Fix G: result without commits produces no WARN for missing affected_files");

    await call(a, "clear_channel_schema", { channel: statusCh });
    await call(a, "purge_channel",        { channel: statusCh });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Teardown
  // ─────────────────────────────────────────────────────────────────────────────

  // afterAll: prefix-based sweep covers all ch() channels; clean up Fix B valid-name test channels
  try { await call(a, "purge_channels_by_prefix", { prefix: "reg-" }); } catch (e) { /* best-effort */ }
  for (const c of [`my.channel.${RUN}`, `ns_backend-${RUN}`, `αβγ-${RUN}`]) {
    await call(a, "purge_channel", { channel: c }).catch(() => {});
  }
  await ta.close();
  await tb.close();

  console.log(`\n${"─".repeat(60)}`);
  console.log(`[test-regression-fixes]  passed=${passed}  failed=${failed}`);
  if (failures.length) {
    console.error("\nFAILED:");
    for (const f of failures) console.error(`  ✗ ${f.label}: ${f.detail}`);
  }
  console.log(`${"─".repeat(60)}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
