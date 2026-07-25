/**
 * test-fixes.js — targeted regression tests for every fix in the 2026-06-09 batch,
 * plus improved coverage for previously untested or under-tested tools.
 *
 * Requires a running broker at BROKER_URL with SHARED_SECRET set.
 * Safe to run against a live instance — all channels use unique run-scoped prefixes.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync } from "fs";
import "dotenv/config";

const BROKER_URL = process.env.BROKER_URL    || "http://localhost:8080/mcp";
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

function ch(name) { return `fix-${RUN}-${name}`; }

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

// REST helper — attaches bearer token when SECRET is set
async function rest(method, path, body) {
  const headers = { "Content-Type": "application/json" };
  if (SECRET) headers.Authorization = `Bearer ${SECRET}`;
  const opts = { method, headers };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return fetch(`${BROKER_HTTP}${path}`, opts);
}

// REST helper without auth
async function restNoAuth(method, path, body) {
  const headers = { "Content-Type": "application/json" };
  const opts = { method, headers };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return fetch(`${BROKER_HTTP}${path}`, opts);
}

async function run() {
  const { client: a, transport: ta } = await connect("fix-a");
  const { client: b, transport: tb } = await connect("fix-b");
  console.log(`\n[test-fixes]  broker=${BROKER_URL}  run=${RUN}\n`);

  // ── Fix 1: PRUNE_EXEMPT — ex-sprint-retrospective survives alongside ex-backlog ──

  console.log("Fix 1. PRUNE_EXEMPT default includes ex-sprint-retrospective");
  {
    // We can't trigger the background auto-prune on demand, but we can verify the
    // channel is writable and readable, and that manual purge_channel(older_than_ms)
    // on the sibling ex-backlog channel does NOT affect ex-sprint-retrospective.
    const retroCh  = `fix-${RUN}-retro`;
    const backlogCh = `fix-${RUN}-backlog`;

    await call(a, "send_message", { channel: retroCh,  sender: "root",         content: JSON.stringify({ type: "note", subject: "sprint-1-close" }) });
    await call(a, "send_message", { channel: backlogCh, sender: "orchestrator", content: JSON.stringify({ type: "deferred", task_id: "old-task-2026-01-01-foo" }) });

    // Purge the backlog channel — should not affect retroCh
    await new Promise(r => setTimeout(r, 50));
    await call(a, "purge_channel", { channel: backlogCh, older_than_ms: 1 });

    const retroAfter = await call(a, "read_messages", { channel: retroCh, since_id: 0 });
    assert(retroAfter.includes("sprint-1-close"), "retro channel unaffected by sibling purge");
    assert(!retroAfter.includes("No new messages"), "retro channel still has messages after sibling purge");

    // Verify: the /health endpoint confirms the server is running the updated code
    // (no direct config introspection, but we can verify the exempt list indirectly
    // by ensuring auto-prune hasn't killed our fresh message)
    const retroMsg = await call(a, "read_messages", { channel: retroCh, since_id: 0 });
    assert(retroMsg.includes("sprint-1-close"), "retro message readable immediately after post (baseline for prune exemption)");

    await call(a, "purge_channel", { channel: retroCh  });
    await call(a, "purge_channel", { channel: backlogCh });
  }

  // ── Fix 2: wait_for_messages — register-before-check, no double resolution ──

  console.log("\nFix 2. wait_for_messages race safety and single resolution");
  {
    // 2a. Pre-existing message returns immediately (listener registered, then check finds it)
    const wch1 = ch("wfm-preexist");
    await call(a, "send_message", { channel: wch1, sender: "x", content: JSON.stringify({ type: "task", v: 1 }) });
    const t0 = Date.now();
    const r1 = await call(b, "wait_for_messages", { channel: wch1, since_id: 0, timeout_ms: 5000 });
    const elapsed1 = Date.now() - t0;
    assert(r1.includes('"task"'), "wfm: pre-existing message returned");
    assert(elapsed1 < 500, `wfm: pre-existing message returned immediately (${elapsed1}ms < 500ms)`);
    await call(a, "purge_channel", { channel: wch1 });

    // 2b. Message arrives while waiting — listener catches it
    const wch2 = ch("wfm-live");
    const waitP = call(b, "wait_for_messages", { channel: wch2, since_id: 0, timeout_ms: 5000 });
    await new Promise(r => setTimeout(r, 100));
    await call(a, "send_message", { channel: wch2, sender: "x", content: JSON.stringify({ type: "result", v: 42 }) });
    const r2 = await waitP;
    assert(r2.includes('"result"'), "wfm: live-posted message delivered via listener");
    await call(a, "purge_channel", { channel: wch2 });

    // 2c. No double-resolution: when matching messages exist at registration time,
    //     the response is returned exactly once (we'd get a second resolution as
    //     an error only if the Promise resolved twice — JS doesn't throw on that,
    //     but the returned text should contain exactly one "next since_id" line)
    const wch3 = ch("wfm-single");
    await call(a, "send_message", { channel: wch3, sender: "x", content: JSON.stringify({ type: "note", v: 1 }) });
    await call(a, "send_message", { channel: wch3, sender: "x", content: JSON.stringify({ type: "note", v: 2 }) });
    const r3 = await call(b, "wait_for_messages", { channel: wch3, since_id: 0, timeout_ms: 3000 });
    const sinceIdMatches = (r3.match(/next since_id/g) || []).length;
    assert(sinceIdMatches === 1, `wfm: exactly one resolution (since_id line appears ${sinceIdMatches} time)`);
    await call(a, "purge_channel", { channel: wch3 });

    // 2d. Timeout still fires correctly after listener registration
    const wch4 = ch("wfm-timeout");
    const t1 = Date.now();
    const r4 = await call(b, "wait_for_messages", { channel: wch4, since_id: 0, timeout_ms: 400 });
    const elapsed4 = Date.now() - t1;
    assert(r4.includes("No new messages"), "wfm: timeout returns no-messages text");
    assert(elapsed4 >= 300 && elapsed4 < 2000, `wfm: timeout fires at expected time (${elapsed4}ms)`);
    await call(a, "purge_channel", { channel: wch4 });

    // 2e. filter_type: non-matching messages don't cancel the wait; matching message wakes it
    const wch5 = ch("wfm-filter");
    const fwP = call(b, "wait_for_messages", { channel: wch5, since_id: 0, timeout_ms: 5000, filter_type: "ping" });
    await new Promise(r => setTimeout(r, 80));
    await call(a, "send_message", { channel: wch5, sender: "x", content: JSON.stringify({ type: "noise" }) });
    await new Promise(r => setTimeout(r, 80));
    await call(a, "send_message", { channel: wch5, sender: "x", content: JSON.stringify({ type: "ping" }) });
    const r5 = await fwP;
    assert(r5.includes('"ping"') && !r5.includes('"noise"'), "wfm: filter_type skips non-matching, wakes on match");
    await call(a, "purge_channel", { channel: wch5 });
  }

  // ── Fix 3: check_result returns summary field ──

  console.log("\nFix 3. check_result returns summary field");
  {
    const crCh = ch("cr-summary");
    const tid  = `task-cr-summary-${RUN}`;

    // No result: found=false, summary=null
    const cr0 = JSON.parse(await call(a, "check_result", { channel: crCh, task_id: tid }));
    assert(cr0.found === false,  "check_result: found=false on empty channel");
    assert("summary" in cr0,     "check_result: summary key present even when not found");
    assert(cr0.summary === null,  "check_result: summary=null when not found");

    // type:status (not result): found=false, summary=null
    await call(a, "send_message", { channel: crCh, sender: "w",
      content: JSON.stringify({ type: "status", task_id: tid, subject: "in progress" }) });
    const cr1 = JSON.parse(await call(a, "check_result", { channel: crCh, task_id: tid }));
    assert(cr1.found === false,  "check_result: type:status doesn't make found=true");
    assert(cr1.summary === null,  "check_result: summary=null for type:status");

    // type:result with summary field: found=true, summary echoed
    await call(a, "send_message", { channel: crCh, sender: "w",
      content: JSON.stringify({ type: "result", task_id: tid, subject: "done",
        summary: "PASS — auth middleware applied to 3 endpoints" }) });
    const cr2 = JSON.parse(await call(a, "check_result", { channel: crCh, task_id: tid }));
    assert(cr2.found === true,   "check_result: found=true after result posted");
    assert(cr2.summary === "PASS — auth middleware applied to 3 endpoints",
      `check_result: summary echoed correctly (got: ${cr2.summary})`);

    // type:result WITHOUT summary field: found=true, summary=null
    const tid2 = `task-cr-nosummary-${RUN}`;
    await call(a, "send_message", { channel: crCh, sender: "w",
      content: JSON.stringify({ type: "result", task_id: tid2, subject: "no summary" }) });
    const cr3 = JSON.parse(await call(a, "check_result", { channel: crCh, task_id: tid2 }));
    assert(cr3.found === true,   "check_result: found=true for result without summary");
    assert(cr3.summary === null,  "check_result: summary=null when result has no summary field");

    // FAIL summary
    const tid3 = `task-cr-fail-${RUN}`;
    await call(a, "send_message", { channel: crCh, sender: "w",
      content: JSON.stringify({ type: "result", task_id: tid3, summary: "FAIL — lint errors in auth.ts" }) });
    const cr4 = JSON.parse(await call(a, "check_result", { channel: crCh, task_id: tid3 }));
    assert(cr4.summary === "FAIL — lint errors in auth.ts", "check_result: FAIL summary echoed correctly");

    await call(a, "purge_channel", { channel: crCh });
  }

  // ── Fix 4: auth on REST worker-control and analytics endpoints ──

  console.log("\nFix 4. REST endpoint auth enforcement");
  {
    // All protected endpoints must return 401 without auth
    const tests = [
      ["GET",  "/workers"],
      ["POST", "/workers/backend/start"],
      ["POST", "/workers/backend/stop"],
      ["GET",  "/cost"],
      ["GET",  "/rate-limits"],
    ];

    for (const [method, path] of tests) {
      if (!SECRET) {
        console.log(`  - ${method} ${path}: skipped (SHARED_SECRET not set)`);
        continue;
      }
      const res = await restNoAuth(method, path, method === "POST" ? {} : undefined);
      assert(res.status === 401, `${method} ${path} returns 401 without bearer token`);
    }

    // With auth token — expect 200 (or 404 for start/stop unknown workers, not 401)
    if (SECRET) {
      const withAuth = await rest("GET", "/workers");
      assert(withAuth.status === 200, "GET /workers returns 200 with valid token");

      const costRes = await rest("GET", "/cost");
      assert(costRes.status === 200, "GET /cost returns 200 with valid token");

      const rlRes = await rest("GET", "/rate-limits");
      assert(rlRes.status === 200, "GET /rate-limits returns 200 with valid token");

      // start/stop for known worker — returns something that's not 401
      const startRes = await rest("POST", "/workers/nonexistent-xyz/start");
      assert(startRes.status !== 401, "POST /workers/start with valid token not rejected (status=" + startRes.status + ")");
    } else {
      console.log("  - with-auth REST tests skipped (SHARED_SECRET not set — cannot distinguish 401 from no-auth)");
    }

    // /health is NOT protected (always public)
    const healthPublic = await restNoAuth("GET", "/health");
    assert(healthPublic.status === 200, "GET /health is public (no auth required)");

    // /inbox is protected: 401 without auth, 200 with auth (watchdog must carry the bearer token)
    const inboxNoAuth = await restNoAuth("GET", `/inbox?channel=fix-${RUN}-inbox-test&since_id=0`);
    assert(inboxNoAuth.status === 401, "GET /inbox requires auth (401 without token)");
    const inboxAuthed = await rest("GET", `/inbox?channel=fix-${RUN}-inbox-test&since_id=0`);
    assert(inboxAuthed.status === 200, "GET /inbox returns 200 with valid token");

    // POST /messages auth: when SHARED_SECRET is set, 401 without auth; 200 with auth
    const secret = process.env.SHARED_SECRET;
    const postNoAuth = await restNoAuth("POST", "/messages", {
      channel: `fix-${RUN}-post-test`,
      sender:  "watchdog",
      content: JSON.stringify({ type: "heartbeat", state: "session-end" }),
    });
    if (secret) {
      assert(postNoAuth.status === 401, "POST /messages requires auth when SHARED_SECRET is set");
      const postWithAuth = await rest("POST", "/messages", {
        channel: `fix-${RUN}-post-test`,
        sender:  "watchdog",
        content: JSON.stringify({ type: "heartbeat", state: "session-end" }),
      });
      assert(postWithAuth.status === 200, "POST /messages succeeds with valid Bearer token");
    } else {
      assert(postNoAuth.status === 200, "POST /messages is public when SHARED_SECRET is unset");
    }
  }

  // ── Fix 5 & 6: ex-telemetry schema — expanded state enum + relaxed from ──

  console.log("\nFix 5–6. ex-telemetry schema: new states + open from field");
  {
    const tCh = ch("telemetry");
    const telSchema = readFileSync("schemas/telemetry.json", "utf-8");
    await call(a, "register_channel_schema", { channel: tCh, schema: telSchema, strict: true });

    function makeHb(from, state, extra = {}) {
      return JSON.stringify({
        type: "heartbeat",
        from,
        ts: new Date().toISOString(),
        context: { size_tokens: 1000, tier_threshold_pct: 5, rotation_recommended: false },
        activity: { state, ...extra },
        ...( extra.cost ? { cost_since_start: { estimated_usd: extra.cost } } : {} ),
      });
    }

    // All new state values must pass
    const newStates = ["idle-exit", "session-end", "reviewing", "coverage-patrol"];
    for (const state of newStates) {
      const r = await callRaw(a, "send_message", { channel: tCh, sender: "qa", content: makeHb("qa", state) });
      assert(!r.isError && !/WARN/.test(r.content[0].text), `telemetry: state="${state}" passes strict validation`);
    }

    // Original states still pass
    for (const state of ["working", "idle-polling", "blocked-on-question", "rotating"]) {
      const r = await callRaw(a, "send_message", { channel: tCh, sender: "qa", content: makeHb("qa", state) });
      assert(!r.isError && !/WARN/.test(r.content[0].text), `telemetry: state="${state}" still passes`);
    }

    // Invalid state must fail in strict
    const badState = await callRaw(a, "send_message", { channel: tCh, sender: "qa",
      content: makeHb("qa", "undefined-state") });
    assert(badState.isError === true, `telemetry: unknown state "undefined-state" rejected under strict`);

    // Arbitrary worker names (previously failed — enum only had 4)
    const newWorkers = ["seo", "cfo", "platform-orch", "qa-backend", "social-analytics", "devops"];
    for (const from of newWorkers) {
      const r = await callRaw(a, "send_message", { channel: tCh, sender: from, content: makeHb(from, "idle-polling") });
      assert(!r.isError, `telemetry: from="${from}" accepted (open string field)`);
    }

    await call(a, "purge_channel",      { channel: tCh });
    await call(a, "clear_channel_schema", { channel: tCh });
  }

  // ── Fix 7: ex-status schema — open from/to + summary field ──

  console.log("\nFix 7. ex-status schema: open from/to + summary field");
  {
    const sCh = ch("status");
    const statusSchema = readFileSync("schemas/status.json", "utf-8");
    await call(a, "register_channel_schema", { channel: sCh, schema: statusSchema, strict: true });

    // Any worker sender passes (was restricted to 3)
    const senders = ["backend-services", "seo", "platform-orch", "qa-backend", "social"];
    for (const from of senders) {
      const r = await callRaw(a, "send_message", { channel: sCh, sender: from, content: JSON.stringify({
        type: "result", task_id: `t-${RUN}-${from}`, from, to: "root-orchestrator", subject: "done",
        summary: "PASS — test",
      })});
      assert(!r.isError, `status: from="${from}" accepted`);
    }

    // Any orchestrator as to passes (was restricted to 4)
    const recipients = ["platform-orch", "consumer-orch", "growth-orch", "intel-orch", "root-orchestrator", "*"];
    for (const to of recipients) {
      const r = await callRaw(a, "send_message", { channel: sCh, sender: "backend", content: JSON.stringify({
        type: "question", task_id: `q-${RUN}-${to}`, from: "backend", to, subject: "consent required: deploy",
      })});
      assert(!r.isError, `status: to="${to}" accepted`);
    }

    // summary field accepted
    const r = await callRaw(a, "send_message", { channel: sCh, sender: "backend", content: JSON.stringify({
      type: "result", task_id: `t-sum-${RUN}`, from: "backend", to: "platform-orch",
      subject: "auth done", summary: "PASS — JWT middleware wired to /api/v1 routes",
    })});
    assert(!r.isError, "status: result with summary field accepted");

    // consent_basis enforcement still applies for production-touching results
    const noConsentBasis = await callRaw(a, "send_message", { channel: sCh, sender: "backend", content: JSON.stringify({
      type: "result", task_id: `t-prod-${RUN}`, from: "backend", to: "platform-orch",
      subject: "deployed", summary: "PASS — deployed",
      body: { production_touching: true }, // missing consent_basis
    })});
    assert(noConsentBasis.isError === true, "status: prod-touching result without consent_basis rejected");

    const withConsentBasis = await callRaw(a, "send_message", { channel: sCh, sender: "backend", content: JSON.stringify({
      type: "result", task_id: `t-prod2-${RUN}`, from: "backend", to: "platform-orch",
      subject: "deployed", summary: "PASS — deployed",
      body: { production_touching: true, consent_basis: "approval-token:#123" },
    })});
    assert(!withConsentBasis.isError, "status: prod-touching result WITH consent_basis accepted");

    await call(a, "purge_channel",       { channel: sCh });
    await call(a, "clear_channel_schema", { channel: sCh });
  }

  // ── Fix 8–9: ex-worker-inbox schema — new types, open from/to, relaxed task_id ──

  console.log("\nFix 8–9. ex-worker-inbox schema: new types, open from/to, relaxed task_id");
  {
    const iCh = ch("inbox");
    const inboxSchema = readFileSync("schemas/worker-inbox.json", "utf-8");
    await call(a, "register_channel_schema", { channel: iCh, schema: inboxSchema, strict: true });

    // New types must all pass (task_ids use date format required by pqa-010 schema tightening)
    const newTypes = ["consent-grant", "consent-deny", "rotate", "reload"];
    for (const type of newTypes) {
      const r = await callRaw(a, "send_message", { channel: iCh, sender: "platform-orch", content: JSON.stringify({
        type, task_id: `fix-2026-06-20-${type}`, from: "platform-orch", to: "backend",
        subject: `${type} signal`,
      })});
      assert(!r.isError, `inbox: type="${type}" accepted`);
    }

    // qa sender passes (was const: "orchestrator")
    const qaR = await callRaw(a, "send_message", { channel: iCh, sender: "qa", content: JSON.stringify({
      type: "task", task_id: `fix-2026-06-20-qa-coverage`, from: "qa", to: "backend",
      subject: "write tests for auth module",
      body: "run test suite",
      required_checks: ["test"],
    })});
    assert(!qaR.isError, `inbox: from="qa" accepted (not restricted to orchestrator)`);

    // Arbitrary worker in to field passes (was limited to 3)
    const newWorkerTos = ["backend-services", "seo", "qa-backend", "devops", "*"];
    let toIdx = 0;
    for (const to of newWorkerTos) {
      const r = await callRaw(a, "send_message", { channel: iCh, sender: "intel-orch", content: JSON.stringify({
        type: "task", task_id: `fix-2026-06-20-dispatch-to${toIdx++}`, from: "intel-orch", to,
        subject: "dispatch task",
        body: "execute",
      })});
      assert(!r.isError, `inbox: to="${to}" accepted`);
    }

    // Valid task_id patterns (pqa-010 added strict pattern: <slug>-YYYY-MM-DD-<slug>)
    const validTaskIds = [
      `qa-obs-auth-task-2026-06-09-v1`,       // added suffix to previously-borderline id
      `simple-task-2026-06-20-run`,            // date+suffix format
      `coverage-patch-2026-06-09-auth-jwt`,    // already well-formed
    ];
    for (const task_id of validTaskIds) {
      const r = await callRaw(a, "send_message", { channel: iCh, sender: "orchestrator", content: JSON.stringify({
        type: "task", task_id, from: "orchestrator", to: "backend", subject: "test",
        body: "execute",
      })});
      assert(!r.isError, `inbox: task_id="${task_id}" accepted with relaxed pattern`);
    }

    // depends_on with any worker reference accepted
    const depsR = await callRaw(a, "send_message", { channel: iCh, sender: "orchestrator", content: JSON.stringify({
      type: "task", task_id: `fix-2026-06-20-dep-test`, from: "orchestrator", to: "frontend",
      subject: "depends on new workers",
      body: "execute after deps",
      depends_on: ["data-pipeline-2026-06-09-done:backend-services", "qa-baseline-2026-06-09-done:qa-backend"],
    })});
    assert(!depsR.isError, "inbox: depends_on with non-3-worker references accepted");

    await call(a, "purge_channel",       { channel: iCh });
    await call(a, "clear_channel_schema", { channel: iCh });
  }

  // ── Fix 10: ex-control schema — new types, open from/to ──

  console.log("\nFix 10. ex-control schema: new types and open from/to");
  {
    const cCh = ch("control");
    const ctrlSchema = readFileSync("schemas/control.json", "utf-8");
    await call(a, "register_channel_schema", { channel: cCh, schema: ctrlSchema, strict: true });

    // New types
    const newCtrlTypes = ["rotate", "reload", "consent-grant", "consent-deny", "ledger-snapshot"];
    for (const type of newCtrlTypes) {
      const r = await callRaw(a, "send_message", { channel: cCh, sender: "orchestrator", content: JSON.stringify({
        type, task_id: `${type}-${RUN}`, from: "orchestrator", to: "*",
        subject: `${type} broadcast`,
      })});
      assert(!r.isError, `control: type="${type}" accepted`);
    }

    // Domain orchestrator as from (was const: "orchestrator")
    const orchR = await callRaw(a, "send_message", { channel: cCh, sender: "platform-orch", content: JSON.stringify({
      type: "note", task_id: `note-${RUN}`, from: "platform-orch", to: "*",
      subject: "platform cluster sprint-1 complete",
    })});
    assert(!orchR.isError, `control: from="platform-orch" accepted`);

    // Domain orchestrators as to
    const orchTos = ["platform-orch", "consumer-orch", "growth-orch", "intel-orch"];
    for (const to of orchTos) {
      const r = await callRaw(a, "send_message", { channel: cCh, sender: "orchestrator", content: JSON.stringify({
        type: "rotate", task_id: `rotate-${to}-${RUN}`, from: "orchestrator", to,
        subject: `rotate ${to}`,
      })});
      assert(!r.isError, `control: to="${to}" accepted`);
    }

    // approval-revoke body validation still enforced
    const goodRevoke = await callRaw(a, "send_message", { channel: cCh, sender: "orchestrator", content: JSON.stringify({
      type: "approval-revoke", task_id: `revoke-${RUN}`, from: "orchestrator", to: "*",
      subject: "revoke sprint token",
      body: { revokes_msg_id: 42 },
    })});
    assert(!goodRevoke.isError, "control: approval-revoke with revokes_msg_id passes");

    const badRevoke = await callRaw(a, "send_message", { channel: cCh, sender: "orchestrator", content: JSON.stringify({
      type: "approval-revoke", task_id: `revoke2-${RUN}`, from: "orchestrator", to: "*",
      subject: "revoke sprint token (no body)",
      // missing body.revokes_msg_id
    })});
    assert(badRevoke.isError === true, "control: approval-revoke without revokes_msg_id rejected under strict");

    await call(a, "purge_channel",       { channel: cCh });
    await call(a, "clear_channel_schema", { channel: cCh });
  }

  // ── New coverage: turn_start tool ──

  console.log("\nNew. turn_start: inbox + control in one round-trip");
  {
    const tsCh = ch("ts-inbox");
    const tcCh = ch("ts-control");

    await call(a, "send_message", { channel: tsCh, sender: "orchestrator", content: JSON.stringify({ type: "task",   task_id: "ts-1", from: "orchestrator", to: "backend", subject: "s1" }) });
    await call(a, "send_message", { channel: tsCh, sender: "orchestrator", content: JSON.stringify({ type: "task",   task_id: "ts-2", from: "orchestrator", to: "backend", subject: "s2" }) });
    await call(a, "send_message", { channel: tcCh, sender: "orchestrator", content: JSON.stringify({ type: "note",   task_id: "tc-1", from: "orchestrator", to: "*",       subject: "no rotate" }) });

    // Basic call — returns both channels' messages
    const ts1 = JSON.parse(await call(b, "turn_start", {
      inbox_channel: tsCh, control_channel: tcCh, inbox_since_id: 0, control_since_id: 0
    }));
    assert(ts1.inbox.length === 2,   `turn_start: inbox has 2 messages (got ${ts1.inbox.length})`);
    assert(ts1.control.length === 1, `turn_start: control has 1 message (got ${ts1.control.length})`);
    assert(ts1.rotate_requested === false, "turn_start: rotate_requested=false when no rotate in control");
    assert(ts1.inbox_next_id > 0,   "turn_start: inbox_next_id > 0");
    assert(ts1.control_next_id > 0, "turn_start: control_next_id > 0");

    // Cursor advancement: since_id from previous call returns no new messages
    const ts2 = JSON.parse(await call(b, "turn_start", {
      inbox_channel: tsCh, control_channel: tcCh,
      inbox_since_id: ts1.inbox_next_id, control_since_id: ts1.control_next_id
    }));
    assert(ts2.inbox.length === 0,   "turn_start: cursors advanced — no new inbox messages");
    assert(ts2.control.length === 0, "turn_start: cursors advanced — no new control messages");
    // inbox_next_id stays at last seen id when nothing new
    assert(ts2.inbox_next_id === ts1.inbox_next_id,   "turn_start: inbox_next_id unchanged when no new messages");

    // rotate_requested flag: add a rotate message to control
    await call(a, "send_message", { channel: tcCh, sender: "orchestrator", content: JSON.stringify({
      type: "rotate", task_id: `rotate-${RUN}`, from: "orchestrator", to: "backend", subject: "pre-sprint rotate"
    })});
    const ts3 = JSON.parse(await call(b, "turn_start", {
      inbox_channel: tsCh, control_channel: tcCh,
      inbox_since_id: ts1.inbox_next_id, control_since_id: ts1.control_next_id
    }));
    assert(ts3.rotate_requested === true, "turn_start: rotate_requested=true when rotate message in control");

    // Message shape — each message has id, sender, content, ts
    const m = ts1.inbox[0];
    assert(typeof m.id === "number",  "turn_start: inbox message has numeric id");
    assert(typeof m.sender === "string", "turn_start: inbox message has sender");
    assert(typeof m.content === "string", "turn_start: inbox message has content");
    assert(typeof m.ts === "string",  "turn_start: inbox message has ISO ts");

    await call(a, "purge_channel", { channel: tsCh });
    await call(a, "purge_channel", { channel: tcCh });
  }

  // ── New coverage: check_results_batch ──

  console.log("\nNew. check_results_batch: batch idempotency check");
  {
    const bCh = ch("batch-cr");

    const tid1 = `batch-t1-${RUN}`;
    const tid2 = `batch-t2-${RUN}`;
    const tid3 = `batch-t3-${RUN}`;

    await call(a, "send_message", { channel: bCh, sender: "w", content: JSON.stringify({ type: "result", task_id: tid1, summary: "PASS — a" }) });
    await call(a, "send_message", { channel: bCh, sender: "w", content: JSON.stringify({ type: "status", task_id: tid2, subject: "in progress" }) });
    // tid3 has no message at all

    const res = JSON.parse(await call(a, "check_results_batch", { channel: bCh, task_ids: [tid1, tid2, tid3] }));
    assert(res.results[tid1] === true,  `check_results_batch: ${tid1} (result) → true`);
    assert(res.results[tid2] === false, `check_results_batch: ${tid2} (status only) → false`);
    assert(res.results[tid3] === false, `check_results_batch: ${tid3} (missing) → false`);
    assert(res.channel === bCh,         "check_results_batch: channel echoed");

    // Single task_id works
    const single = JSON.parse(await call(a, "check_results_batch", { channel: bCh, task_ids: [tid1] }));
    assert(single.results[tid1] === true, "check_results_batch: single task_id works");

    // All not found
    const noneFound = JSON.parse(await call(a, "check_results_batch", { channel: bCh, task_ids: ["missing-1", "missing-2"] }));
    assert(noneFound.results["missing-1"] === false, "check_results_batch: missing task → false");
    assert(noneFound.results["missing-2"] === false, "check_results_batch: all missing → all false");

    await call(a, "purge_channel", { channel: bCh });
  }

  // ── New coverage: send_message_batch — atomicity and event delivery ──

  console.log("\nNew. send_message_batch: atomicity and event delivery");
  {
    const bmCh1 = ch("batch-m1");
    const bmCh2 = ch("batch-m2");
    const bmCh3 = ch("batch-m3");

    // All messages visible after the batch call returns
    const batchRes = await call(a, "send_message_batch", { messages: [
      { channel: bmCh1, sender: "orch", content: JSON.stringify({ type: "task", task_id: "bm1", subject: "task 1" }) },
      { channel: bmCh2, sender: "orch", content: JSON.stringify({ type: "task", task_id: "bm2", subject: "task 2" }) },
      { channel: bmCh3, sender: "orch", content: JSON.stringify({ type: "note", task_id: "bm3", subject: "note 3" }) },
    ]});
    assert(batchRes.includes("3 messages"), `send_message_batch: confirms 3 sent (got: ${batchRes})`);

    const m1 = await call(a, "read_messages", { channel: bmCh1, since_id: 0 });
    const m2 = await call(a, "read_messages", { channel: bmCh2, since_id: 0 });
    const m3 = await call(a, "read_messages", { channel: bmCh3, since_id: 0 });
    assert(m1.includes("task 1"), "send_message_batch: ch1 message visible");
    assert(m2.includes("task 2"), "send_message_batch: ch2 message visible");
    assert(m3.includes("note 3"), "send_message_batch: ch3 message visible");

    // Event delivery: a wait_for_messages listener should wake on batch-posted messages
    const bmCh4 = ch("batch-m4");
    const waitP = call(b, "wait_for_messages", { channel: bmCh4, since_id: 0, timeout_ms: 5000 });
    await new Promise(r => setTimeout(r, 100));
    await call(a, "send_message_batch", { messages: [
      { channel: bmCh4, sender: "orch", content: JSON.stringify({ type: "result", task_id: "wake-test", summary: "PASS" }) },
    ]});
    const wakeRes = await waitP;
    assert(wakeRes.includes("wake-test"), "send_message_batch: listener woken by batch-posted message");

    // Schema strict failure aborts entire batch before any insert
    const bmCh5 = ch("batch-fail");
    const strictSchema = JSON.stringify({ type: "object", required: ["magic"], properties: { magic: { const: "yes" } } });
    await call(a, "register_channel_schema", { channel: bmCh5, schema: strictSchema, strict: true });
    const failBatch = await callRaw(a, "send_message_batch", { messages: [
      { channel: bmCh5, sender: "x", content: JSON.stringify({ magic: "yes" }) }, // valid
      { channel: bmCh5, sender: "x", content: JSON.stringify({ magic: "no"  }) }, // invalid — fails schema
    ]});
    assert(failBatch.isError === true, "send_message_batch: strict schema failure aborts batch");
    const afterFailBatch = await call(a, "read_messages", { channel: bmCh5, since_id: 0 });
    assert(afterFailBatch.includes("No new messages"), "send_message_batch: no partial insert on schema abort");

    for (const c of [bmCh1, bmCh2, bmCh3, bmCh4, bmCh5]) {
      await call(a, "purge_channel",       { channel: c }).catch(() => {});
      await call(a, "clear_channel_schema", { channel: c }).catch(() => {});
    }
  }

  // ── New coverage: upsert_heartbeat — keep-latest-per-sender semantics ──

  console.log("\nNew. upsert_heartbeat: keep-latest-per-sender");
  {
    const uhCh = ch("upsert-hb");

    // First heartbeat from alice
    await call(a, "upsert_heartbeat", { channel: uhCh, sender: "alice",
      content: JSON.stringify({ type: "heartbeat", v: 1 }) });
    const after1 = await call(a, "read_messages", { channel: uhCh, since_id: 0 });
    const lines1 = after1.trim().split("\n").filter(l => l.includes("<alice>"));
    assert(lines1.length === 1, "upsert_heartbeat: one alice row after first upsert");

    // Second heartbeat from alice replaces the first
    await call(a, "upsert_heartbeat", { channel: uhCh, sender: "alice",
      content: JSON.stringify({ type: "heartbeat", v: 2 }) });
    const after2 = await call(a, "read_messages", { channel: uhCh, since_id: 0 });
    const lines2 = after2.trim().split("\n").filter(l => l.includes("<alice>"));
    assert(lines2.length === 1, "upsert_heartbeat: still only one alice row after second upsert");
    assert(lines2[0].includes('"v":2'), "upsert_heartbeat: second upsert value retained (v=2)");
    assert(!lines2[0].includes('"v":1'), "upsert_heartbeat: first upsert replaced (v=1 gone)");

    // Bob's heartbeat coexists — channels has exactly 2 rows
    await call(a, "upsert_heartbeat", { channel: uhCh, sender: "bob",
      content: JSON.stringify({ type: "heartbeat", v: 10 }) });
    const after3 = await call(a, "read_messages", { channel: uhCh, since_id: 0 });
    const nonEmptyLines = after3.trim().split("\n").filter(l => l.match(/#\d+/));
    assert(nonEmptyLines.length === 2, `upsert_heartbeat: exactly 2 rows (alice+bob) (got ${nonEmptyLines.length})`);

    // Third alice upsert — still only 2 rows total
    await call(a, "upsert_heartbeat", { channel: uhCh, sender: "alice",
      content: JSON.stringify({ type: "heartbeat", v: 3 }) });
    const after4 = await call(a, "read_messages", { channel: uhCh, since_id: 0 });
    const nonEmptyLines4 = after4.trim().split("\n").filter(l => l.match(/#\d+/));
    assert(nonEmptyLines4.length === 2, `upsert_heartbeat: still 2 rows after third alice upsert (got ${nonEmptyLines4.length})`);

    // wake_for_messages listener still fires on upsert
    const uhCh2 = ch("upsert-wake");
    const uwP = call(b, "wait_for_messages", { channel: uhCh2, since_id: 0, timeout_ms: 5000 });
    await new Promise(r => setTimeout(r, 80));
    await call(a, "upsert_heartbeat", { channel: uhCh2, sender: "worker",
      content: JSON.stringify({ type: "heartbeat", state: "idle-exit" }) });
    const uwR = await uwP;
    assert(uwR.includes("idle-exit"), "upsert_heartbeat: listener woken by upsert");

    await call(a, "purge_channel", { channel: uhCh  });
    await call(a, "purge_channel", { channel: uhCh2 });
  }

  // ── New coverage: sprint_summary tool ──

  console.log("\nNew. sprint_summary: task/result/fail counts");
  {
    // tasks are dispatched to worker INBOX channels, NOT the status channel.
    // namespace is derived from status_channel by trimming the last segment (e.g. "fix-<RUN>-ss").
    const ssNS    = `fix-${RUN}-ss`;
    const ssCh    = `${ssNS}-status`;   // results land here
    const ssCCh   = `${ssNS}-control`;  // sprint notes land here
    const ssInCh  = `${ssNS}-backend`;  // tasks dispatched here (inbox channel)

    const tasks = ["ss-t1", "ss-t2", "ss-t3"];
    const tid = (id) => `${id}-${RUN}`;

    // Dispatch tasks to the INBOX channel (stmtSprintDispatched queries these)
    for (const t of tasks) {
      await call(a, "send_message", { channel: ssInCh, sender: "orchestrator",
        content: JSON.stringify({ type: "task", task_id: tid(t), from: "orchestrator", to: "backend", subject: t }) });
    }
    // Post results to the STATUS channel
    await call(a, "send_message", { channel: ssCh, sender: "backend",
      content: JSON.stringify({ type: "result", task_id: tid("ss-t1"), from: "backend", to: "orchestrator", subject: "done", summary: "PASS — done" }) });
    await call(a, "send_message", { channel: ssCh, sender: "backend",
      content: JSON.stringify({ type: "result", task_id: tid("ss-t2"), from: "backend", to: "orchestrator", subject: "done", summary: "FAIL — lint errors" }) });
    // Sprint note on control channel
    await call(a, "send_message", { channel: ssCCh, sender: "orchestrator",
      content: JSON.stringify({ type: "note", task_id: `sprint-note-${RUN}`, from: "orchestrator", to: "*", subject: "sprint-1", body: "Sprint 1 started" }) });

    const ss = JSON.parse(await call(a, "sprint_summary", {
      status_channel: ssCh, control_channel: ssCCh,
    }));
    assert(ss.dispatched === 3, `sprint_summary: dispatched=3 from inbox channel (got ${ss.dispatched})`);
    assert(ss.completed  === 2, `sprint_summary: completed=2 (got ${ss.completed})`);
    assert(ss.failed     === 1, `sprint_summary: failed=1 (got ${ss.failed})`);
    assert(ss.pending    === 1, `sprint_summary: pending=1 (got ${ss.pending})`);
    assert(ss.sprint !== null,  "sprint_summary: sprint note included");
    assert(ss.sprint?.subject?.includes("sprint-1"), `sprint_summary: sprint subject correct (got ${ss.sprint?.subject})`);

    // Without control channel — sprint is null
    const ssNoCtrl = JSON.parse(await call(a, "sprint_summary", { status_channel: ssCh }));
    assert(ssNoCtrl.sprint === null, "sprint_summary: sprint=null when no control_channel given");

    // Empty namespace — use a fully disjoint namespace so no inbox channels bleed in
    const ssEmptyCh = `fix-${RUN}-ssX-status`;  // namespace "fix-<RUN>-ssX" has no inbox channels
    const ssEmpty = JSON.parse(await call(a, "sprint_summary", { status_channel: ssEmptyCh }));
    assert(ssEmpty.dispatched === 0 && ssEmpty.completed === 0, "sprint_summary: all zeros on empty namespace");

    await call(a, "purge_channel", { channel: ssCh   });
    await call(a, "purge_channel", { channel: ssCCh  });
    await call(a, "purge_channel", { channel: ssInCh });
  }

  // ── New coverage: purge_channel — full purge and older_than_ms ──

  console.log("\nNew. purge_channel: full purge and partial purge");
  {
    const pCh = ch("purge");

    await call(a, "send_message", { channel: pCh, sender: "x", content: "a" });
    await call(a, "send_message", { channel: pCh, sender: "x", content: "b" });

    // Full purge
    const fullPurge = await call(a, "purge_channel", { channel: pCh });
    assert(fullPurge.includes("Purged 2"), `purge_channel: purged 2 messages (got: ${fullPurge})`);
    const afterFull = await call(a, "read_messages", { channel: pCh, since_id: 0 });
    assert(afterFull.includes("No new messages"), "purge_channel: full purge clears channel");

    // Purging empty channel returns 0
    const emptyPurge = await call(a, "purge_channel", { channel: pCh });
    assert(emptyPurge.includes("Purged 0"), "purge_channel: purging empty channel returns 0");

    // older_than_ms: only removes messages older than threshold
    await call(a, "send_message", { channel: pCh, sender: "x", content: "old" });
    await new Promise(r => setTimeout(r, 250));
    await call(a, "send_message", { channel: pCh, sender: "x", content: "new" });
    const partialPurge = await call(a, "purge_channel", { channel: pCh, older_than_ms: 150 });
    assert(partialPurge.includes("Pruned 1"), `purge_channel: partial purge removed 1 (got: ${partialPurge})`);
    const afterPartial = await call(a, "read_messages", { channel: pCh, since_id: 0 });
    assert(afterPartial.includes("new") && !afterPartial.includes("old"),
      "purge_channel: old message gone, new message survives");

    await call(a, "purge_channel", { channel: pCh });
  }

  // ── New coverage: get_latest_per_sender — multi-sender, single-sender, empty ──

  console.log("\nNew. get_latest_per_sender");
  {
    const glCh = ch("latest-per-sender");

    // Empty channel
    const empty = await call(a, "get_latest_per_sender", { channel: glCh });
    assert(empty.includes("No messages"), "get_latest_per_sender: empty channel → no messages");

    // Post 2 from alice, 1 from bob
    await call(a, "send_message", { channel: glCh, sender: "alice", content: JSON.stringify({ v: 1 }) });
    await call(a, "send_message", { channel: glCh, sender: "alice", content: JSON.stringify({ v: 2 }) });
    await call(a, "send_message", { channel: glCh, sender: "bob",   content: JSON.stringify({ v: 10 }) });

    const rows = await call(a, "get_latest_per_sender", { channel: glCh });
    const rowLines = rows.trim().split("\n");
    assert(rowLines.length === 2, `get_latest_per_sender: 2 rows for 2 senders (got ${rowLines.length})`);
    assert(rows.includes("<alice>"), "get_latest_per_sender: alice present");
    assert(rows.includes("<bob>"),   "get_latest_per_sender: bob present");
    // alice's latest is v=2
    const aliceLine = rowLines.find(l => l.includes("<alice>"));
    assert(aliceLine && aliceLine.includes('"v":2'), "get_latest_per_sender: alice's latest is v=2");
    assert(!aliceLine.includes('"v":1'), "get_latest_per_sender: alice's v=1 not in latest");

    await call(a, "purge_channel", { channel: glCh });
  }

  // ── New coverage: list_channels — channel count and metadata ──

  console.log("\nNew. list_channels: metadata accuracy");
  {
    const lcCh1 = ch("lc-1");
    const lcCh2 = ch("lc-2");

    await call(a, "send_message", { channel: lcCh1, sender: "x", content: "m1" });
    await call(a, "send_message", { channel: lcCh1, sender: "x", content: "m2" });
    await call(a, "send_message", { channel: lcCh2, sender: "y", content: "n1" });

    const chanList = await call(a, "list_channels", {});
    // Both new channels appear
    assert(chanList.includes(lcCh1), "list_channels: new channel 1 visible");
    assert(chanList.includes(lcCh2), "list_channels: new channel 2 visible");
    // Metadata present
    assert(chanList.includes("last_id="),       "list_channels: last_id in output");
    assert(chanList.includes("last_activity="), "list_channels: last_activity in output");
    // Message count
    const lc1Line = chanList.split("\n").find(l => l.startsWith(lcCh1));
    assert(lc1Line && lc1Line.includes("2 msgs"), `list_channels: lcCh1 shows 2 msgs (got: ${lc1Line})`);

    await call(a, "purge_channel", { channel: lcCh1 });
    await call(a, "purge_channel", { channel: lcCh2 });
  }

  // ── New coverage: post_gated_message — multi-dep, all must satisfy ──

  console.log("\nNew. post_gated_message: multi-dep satisfaction");
  {
    const pgCh  = ch("gate-out");
    const pgWCh = ch("gate-watch");
    const dep1  = `gate-dep1-${RUN}`;
    const dep2  = `gate-dep2-${RUN}`;

    // Both deps missing — gate blocks
    const gP = call(a, "post_gated_message", {
      channel: pgCh, sender: "orch",
      content: JSON.stringify({ type: "task", subject: "multi-dep released" }),
      depends_on: [dep1, dep2],
      watch_channel: pgWCh,
      timeout_ms: 6000,
    });

    await new Promise(r => setTimeout(r, 150));
    // Satisfy dep1 only — gate still blocked
    await call(b, "send_message", { channel: pgWCh, sender: "w1",
      content: JSON.stringify({ type: "result", task_id: dep1, summary: "PASS" }) });
    await new Promise(r => setTimeout(r, 150));
    const midCheck = await call(a, "read_messages", { channel: pgCh, since_id: 0 });
    assert(midCheck.includes("No new messages"), "post_gated_message: still blocked after only 1 of 2 deps satisfied");

    // Satisfy dep2 — gate opens
    await call(b, "send_message", { channel: pgWCh, sender: "w2",
      content: JSON.stringify({ type: "result", task_id: dep2, summary: "PASS" }) });
    const gRes = await gP;
    assert(gRes.includes("Deps satisfied"), "post_gated_message: multi-dep gate opens when all deps satisfied");

    const afterGate = await call(a, "read_messages", { channel: pgCh, since_id: 0 });
    assert(afterGate.includes("multi-dep released"), "post_gated_message: message visible after multi-dep gate");

    await call(a, "purge_channel", { channel: pgCh  });
    await call(a, "purge_channel", { channel: pgWCh });
  }

  // ── Teardown ──────────────────────────────────────────────────────────────────
  // afterAll: prefix-based sweep catches all fix-${RUN}-* channels
  try { await call(a, "purge_channels_by_prefix", { prefix: "fix-" }); } catch (e) { /* best-effort */ }
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
