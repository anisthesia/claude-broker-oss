/**
 * test-e2e.js — end-to-end broker-worker protocol tests
 *
 * Scripted worker stubs simulate the full turn-start ritual without spawning
 * real Claude sessions. Each test runs a complete dispatch → work → result
 * cycle and asserts the outcome from the orchestrator's perspective.
 *
 * Tests:
 *  1. Basic dispatch → result (single worker, one task)
 *  2. Idempotency: same task dispatched twice → exactly one result posted
 *  3. depends_on: task B deferred until A result appears on status channel
 *  4. Multi-worker sprint: shared file caught by sprint_file_conflicts
 *  5. SKIP result: excluded from sprint_file_conflicts conflict detection
 *  6. FAIL result: counted by sprint_file_conflicts (unlike SKIP)
 *  7. Multi-dep depends_on: ALL deps must be met before task executes
 *  8. Concurrent stubs racing on same task: only one processes it
 *  9. Blind spot e2e: worker omitting affected_files surfaces in blind_spots
 * 10. Schema validation: warn-only logs but inserts; strict rejects with isError
 * 11. Question/answer roundtrip: worker asks, orchestrator answers, worker resumes
 * 12. Rotate message: turn_start.rotate_requested=true → worker posts exit status
 * 13. Idle drain + exit status: worker posts exit note after inbox is empty
 * 14. Approval-token: worker reads token via turn_start, uses id in consent_basis
 * 15. consent-grant/deny: two-hop escalation worker → cluster-orch → root → cluster-orch → worker
 * 16. contract-change + wire_compat: broadcast read and schema enforcement
 * 17. Stall detection: cluster-orch ledger detects stalled worker and escalates to root
 * 18. Multi-orchestrator topology: root → cluster-orch → worker → cluster-orch → root
 * 19. Approval-revoke: token revoked mid-flight; worker detects and stands down
 * 20. Heartbeat telemetry: worker upserts heartbeats, orchestrator detects threshold and dispatches rotate
 * 21. check_results_batch: bulk idempotency at turn-start (replaces N sequential check_result calls)
 * 22. Capability-based routing: workers declare ownership, orchestrator routes task to correct worker
 * 23. Broker-side gate: post_gated_message holds downstream task until upstream result exists
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import "dotenv/config";

const BROKER_URL = process.env.BROKER_URL || "http://localhost:8080/mcp";
const SECRET     = process.env.SHARED_SECRET || "";
const RUN        = Date.now().toString(36);

let passed = 0, failed = 0;
function ok(label)               { console.log(`  ✓ ${label}`); passed++; }
function fail(label, detail = "") { console.error(`  ✗ ${label}${detail ? ": " + detail : ""}`); failed++; }
function assert(cond, label, detail = "") { cond ? ok(label) : fail(label, detail); }

function ch(name)   { return `e2e-${RUN}-${name}`; }
function tid(slug)  { return `cb-e2e-${slug}-2026-06-18-${RUN}`; }

async function connect(name) {
  const headers   = SECRET ? { Authorization: `Bearer ${SECRET}` } : {};
  const transport = new StreamableHTTPClientTransport(new URL(BROKER_URL), { requestInit: { headers } });
  const client    = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

async function call(client, tool, args) {
  const res = await client.callTool({ name: tool, arguments: args });
  return res.content[0].text;
}

// Returns the full MCP response so callers can inspect isError and raw content
async function callRaw(client, tool, args) {
  return client.callTool({ name: tool, arguments: args });
}

// Parse read_messages text output. Format: [#id] ISO_timestamp <sender>: content
function parseMessages(raw) {
  if (!raw?.trim()) return [];
  return raw.trim().split("\n")
    .filter(l => /^\[#\d+\]/.test(l))
    .map(line => {
      const m = line.match(/^\[#(\d+)\] \S+ <([^>]+)>: (.*)/);
      if (!m) return null;
      const [, id, sender, content] = m;
      let parsed = null;
      try { parsed = JSON.parse(content); } catch {}
      return { id: parseInt(id), sender, content, parsed };
    })
    .filter(Boolean);
}

// Read all results from a status channel and filter by task_id
async function readResult(orch, statusCh, taskId) {
  const raw  = await call(orch, "read_messages", { channel: statusCh, since_id: 0 });
  const msgs = parseMessages(raw);
  return msgs
    .filter(m => m.parsed?.type === "result" && m.parsed?.task_id === taskId)
    .map(m => m.parsed);
}

// Send a task to a worker inbox from the orchestrator
async function dispatch(orch, inboxChannel, task) {
  await call(orch, "send_message", {
    channel: inboxChannel,
    sender:  "orchestrator",
    content: JSON.stringify(task),
  });
}

// ── WorkerStub ───────────────────────────────────────────────────────────────
// Simulates one Claude session turn without an LLM.
// Uses turn_start (structured JSON) instead of parsing read_messages text.
// handlers: { [task_id]: async (msg) => { summary, affected_files?, body? } }
// Use "*" as a wildcard handler.
class WorkerStub {
  constructor(name, inbox, ctrl, status, client) {
    this.name          = name;
    this.inbox         = inbox;
    this.ctrl          = ctrl;
    this.status        = status;
    this.client        = client;
    this.inboxNextId   = 0;
    this.controlNextId = 0;
  }

  async runTurn(handlers = {}) {
    const raw      = await call(this.client, "turn_start", {
      inbox_channel:    this.inbox,
      control_channel:  this.ctrl,
      inbox_since_id:   this.inboxNextId,
      control_since_id: this.controlNextId,
    });
    const turn = JSON.parse(raw);
    this.inboxNextId   = turn.inbox_next_id;
    this.controlNextId = turn.control_next_id;

    let processed = 0;
    for (const { id, content } of turn.inbox) {
      let msg;
      try { msg = JSON.parse(content); } catch { continue; }
      if (msg.type !== "task") continue;

      // Idempotency: skip if result already on status channel
      const checkRaw = await call(this.client, "check_result", {
        channel: this.status,
        task_id: msg.task_id,
      });
      if (JSON.parse(checkRaw).found) continue;

      // depends_on: skip if any prerequisite result is missing
      if (Array.isArray(msg.depends_on) && msg.depends_on.length > 0) {
        let allMet = true;
        for (const dep of msg.depends_on) {
          const depRaw = await call(this.client, "check_result", {
            channel: this.status,
            task_id: dep.split(":")[0],
          });
          if (!JSON.parse(depRaw).found) { allMet = false; break; }
        }
        if (!allMet) continue;
      }

      const handler = handlers[msg.task_id] ?? handlers["*"];
      if (!handler) continue;

      const result = await handler(msg);
      await call(this.client, "send_message", {
        channel: this.status,
        sender:  this.name,
        content: JSON.stringify({
          type:     "result",
          task_id:  msg.task_id,
          from:     this.name,
          to:       msg.from ?? "orchestrator",
          subject:  msg.subject ?? "(untitled)",
          summary:  result.summary ?? "PASS — done",
          ...(result.affected_files ? { affected_files: result.affected_files } : {}),
          body: { consent_basis: "orchestrator-dispatch-only", ...(result.body ?? {}) },
        }),
      });
      processed++;
    }
    return processed;
  }
}

async function run() {
  console.log(`\nBroker E2E  run=${RUN}\n`);

  const { client: orch, transport: tOrch } = await connect("e2e-orch");
  const { client: wA,   transport: twA   } = await connect("e2e-worker-a");
  const { client: wB,   transport: twB   } = await connect("e2e-worker-b");

  const ctrl = ch("ctrl"); // shared dummy control channel (empty throughout)

  // ── 1. Basic dispatch → result ─────────────────────────────────────────────

  console.log("1. Basic dispatch → result (single worker)");
  {
    const inbox  = ch("basic-inbox");
    const status = ch("basic-status");
    const taskId = tid("basic");
    const worker = new WorkerStub("alpha", inbox, ctrl, status, wA);

    await dispatch(orch, inbox, {
      type: "task", task_id: taskId,
      from: "orchestrator", to: "alpha",
      subject: "create greeting module",
      body: "Add src/greeting.ts with a hello() function.",
    });

    const n = await worker.runTurn({
      [taskId]: async () => ({
        summary:        "PASS — added greeting.ts with hello()",
        affected_files: ["src/greeting.ts"],
      }),
    });

    assert(n === 1, "basic: worker processed 1 task");

    const results = await readResult(orch, status, taskId);
    assert(results.length === 1,           `basic: exactly 1 result on status (got ${results.length})`);
    const r = results[0];
    assert(r.type === "result",                                 "basic: type=result");
    assert(r.task_id === taskId,                               "basic: task_id matches");
    assert(r.from === "alpha",                                 `basic: from=alpha (got ${r.from})`);
    assert(r.summary?.startsWith("PASS"),                      `basic: summary starts with PASS (got: ${r.summary})`);
    assert(Array.isArray(r.affected_files),                    "basic: affected_files is array");
    assert(r.affected_files.includes("src/greeting.ts"),       "basic: greeting.ts in affected_files");
    assert(r.body?.consent_basis === "orchestrator-dispatch-only", "basic: consent_basis set");

    await call(orch, "purge_channel", { channel: inbox  });
    await call(orch, "purge_channel", { channel: status });
  }

  // ── 2. Idempotency ─────────────────────────────────────────────────────────

  console.log("\n2. Idempotency: same task dispatched twice → exactly one result");
  {
    const inbox  = ch("idem-inbox");
    const status = ch("idem-status");
    const taskId = tid("idem");
    const worker = new WorkerStub("alpha", inbox, ctrl, status, wA);

    const task = {
      type: "task", task_id: taskId,
      from: "orchestrator", to: "alpha",
      subject: "idempotent task",
      body: "Do something once.",
    };
    await dispatch(orch, inbox, task);
    await dispatch(orch, inbox, task); // duplicate — simulates double-dispatch

    // One turn reads both inbox messages; check_result guards the second
    const n = await worker.runTurn({ "*": async () => ({ summary: "PASS — done once" }) });

    assert(n === 1, `idem: processed exactly 1 task in one turn (got ${n})`);

    const results = await readResult(orch, status, taskId);
    assert(results.length === 1, `idem: exactly 1 result on status channel (got ${results.length})`);

    await call(orch, "purge_channel", { channel: inbox  });
    await call(orch, "purge_channel", { channel: status });
  }

  // ── 3. depends_on ──────────────────────────────────────────────────────────
  // Turn 1: B is in the inbox but its dependency (A) has no result yet → deferred.
  // A's result is then posted directly to status (simulating parallel worker).
  // Turn 2: re-read the inbox; B's dep is now satisfied → B processed.

  console.log("\n3. depends_on: task B deferred until task A result exists");
  {
    const inbox  = ch("dep-inbox");
    const status = ch("dep-status");
    const tidA   = tid("dep-a");
    const tidB   = tid("dep-b");
    const worker = new WorkerStub("alpha", inbox, ctrl, status, wA);

    const handlersB = {
      [tidB]: async () => ({
        summary:        "PASS — tests written",
        affected_files: ["src/module.spec.ts"],
      }),
    };

    // Dispatch B only — A's result doesn't exist on status yet
    await dispatch(orch, inbox, {
      type: "task", task_id: tidB,
      from: "orchestrator", to: "alpha",
      subject: "write tests for module",
      depends_on: [`${tidA}:alpha`],
    });

    const n1 = await worker.runTurn(handlersB);
    assert(n1 === 0, `dep: turn 1 — B deferred (A result not yet on status) (got ${n1})`);

    const bAfterT1 = await readResult(orch, status, tidB);
    assert(bAfterT1.length === 0, "dep: no result for B after turn 1");

    // Post A's result directly — simulates A processed by a different worker/turn
    await call(orch, "send_message", {
      channel: status, sender: "alpha",
      content: JSON.stringify({
        type: "result", task_id: tidA,
        from: "alpha", to: "orchestrator",
        subject: "create module",
        summary: "PASS — module created",
        affected_files: ["src/module.ts"],
        body: { consent_basis: "orchestrator-dispatch-only" },
      }),
    });

    // Reset inbox cursor so deferred B is re-read in turn 2
    worker.inboxNextId = 0;
    const n2 = await worker.runTurn(handlersB);
    assert(n2 === 1, `dep: turn 2 — B processed after A result available (got ${n2})`);

    const bAfterT2 = await readResult(orch, status, tidB);
    assert(bAfterT2.length === 1,                                 `dep: exactly 1 result for B (got ${bAfterT2.length})`);
    assert(bAfterT2[0]?.summary?.startsWith("PASS"),              `dep: B result is PASS (got: ${bAfterT2[0]?.summary})`);
    assert(bAfterT2[0]?.affected_files?.includes("src/module.spec.ts"), "dep: B affected_files correct");

    // A's result must not be duplicated by the second turn (idempotency)
    const aResults = await readResult(orch, status, tidA);
    assert(aResults.length === 1, `dep: A result not duplicated (got ${aResults.length})`);

    await call(orch, "purge_channel", { channel: inbox  });
    await call(orch, "purge_channel", { channel: status });
  }

  // ── 4. Multi-worker sprint: conflict detection ─────────────────────────────

  console.log("\n4. Multi-worker sprint: sprint_file_conflicts catches shared file");
  {
    const inboxA  = ch("sprint-inbox-a");
    const inboxB  = ch("sprint-inbox-b");
    const status  = ch("sprint-status");
    const workerA = new WorkerStub("backend", inboxA, ctrl, status, wA);
    const workerB = new WorkerStub("bs",      inboxB, ctrl, status, wB);

    const shared  = "backend/src/jobs/reconciliation.service.ts";
    const uniqueA = "backend/src/jobs/reconciliation.module.ts";
    const uniqueB = "backend/src/jobs/reconciliation.service.spec.ts";
    const tidBE   = tid("sprint-backend");
    const tidBS   = tid("sprint-bs");

    await dispatch(orch, inboxA, {
      type: "task", task_id: tidBE,
      from: "orchestrator", to: "backend",
      subject: "implement reconciliation service",
    });
    await dispatch(orch, inboxB, {
      type: "task", task_id: tidBS,
      from: "orchestrator", to: "bs",
      subject: "add tests for reconciliation service",
    });

    await workerA.runTurn({
      [tidBE]: async () => ({
        summary:        "PASS — service and module added",
        affected_files: [shared, uniqueA],
      }),
    });
    await workerB.runTurn({
      [tidBS]: async () => ({
        summary:        "PASS — tests added",
        affected_files: [shared, uniqueB],
      }),
    });

    const sfcRaw = await call(orch, "sprint_file_conflicts", { status_channel: status });
    const sfc    = JSON.parse(sfcRaw);

    assert(sfc.conflicts.length === 1,                   `sprint: 1 conflict (got ${sfc.conflicts.length})`);
    assert(sfc.conflicts[0].file === shared,             `sprint: conflict on shared file (got ${sfc.conflicts[0]?.file})`);
    assert(sfc.conflicts[0].workers.includes("backend"), "sprint: backend in conflict workers");
    assert(sfc.conflicts[0].workers.includes("bs"),      "sprint: bs in conflict workers");
    assert(sfc.clean_count === 2,                        `sprint: 2 clean files (uniqueA + uniqueB) (got ${sfc.clean_count})`);
    assert(sfc.blind_spots.length === 0,                 "sprint: no blind spots");
    assert(/1 conflict/i.test(sfc.summary),              `sprint: summary mentions conflict (got: ${sfc.summary})`);

    await call(orch, "purge_channel", { channel: inboxA });
    await call(orch, "purge_channel", { channel: inboxB });
    await call(orch, "purge_channel", { channel: status });
  }

  // ── 5. SKIP result excluded from conflict detection ────────────────────────

  console.log("\n5. SKIP result: excluded from sprint_file_conflicts");
  {
    const inboxA  = ch("skip-inbox-a");
    const inboxB  = ch("skip-inbox-b");
    const status  = ch("skip-status");
    const workerA = new WorkerStub("backend",  inboxA, ctrl, status, wA);
    const workerB = new WorkerStub("frontend", inboxB, ctrl, status, wB);

    const shared = "backend/src/services/shared.service.ts";
    const tidBE  = tid("skip-backend");
    const tidFE  = tid("skip-frontend");

    await dispatch(orch, inboxA, {
      type: "task", task_id: tidBE,
      from: "orchestrator", to: "backend",
      subject: "update shared service",
    });
    await dispatch(orch, inboxB, {
      type: "task", task_id: tidFE,
      from: "orchestrator", to: "frontend",
      subject: "update shared service — frontend scope",
    });

    await workerA.runTurn({
      [tidBE]: async () => ({
        summary:        "PASS — service updated",
        affected_files: [shared],
      }),
    });
    // Frontend correctly determines the task is out of scope and skips it.
    // affected_files is still declared (even SKIP results should list touched files),
    // but sprint_file_conflicts must exclude SKIP results from conflict detection.
    await workerB.runTurn({
      [tidFE]: async () => ({
        summary:        "SKIP — not applicable to frontend scope",
        affected_files: [shared],
      }),
    });

    const sfcRaw = await call(orch, "sprint_file_conflicts", { status_channel: status });
    const sfc    = JSON.parse(sfcRaw);

    assert(sfc.conflicts.length === 0, "skip: no conflict (SKIP result excluded from detection)");
    assert(sfc.clean_count === 1,      `skip: clean_count=1 for backend file (got ${sfc.clean_count})`);
    assert(sfc.blind_spots.length === 0, "skip: no blind spots (both workers declared files)");

    await call(orch, "purge_channel", { channel: inboxA });
    await call(orch, "purge_channel", { channel: inboxB });
    await call(orch, "purge_channel", { channel: status });
  }

  // ── 6. FAIL result: counted by sprint_file_conflicts ──────────────────────
  // FAIL means "I tried and the files were touched, even though the task failed."
  // sprint_file_conflicts must count FAIL results (only SKIP is excluded).

  console.log("\n6. FAIL result: counted by sprint_file_conflicts (unlike SKIP)");
  {
    const inboxA  = ch("fail-inbox-a");
    const inboxB  = ch("fail-inbox-b");
    const status  = ch("fail-status");
    const workerA = new WorkerStub("backend",  inboxA, ctrl, status, wA);
    const workerB = new WorkerStub("bs",       inboxB, ctrl, status, wB);

    const shared = "backend/src/jobs/payments.service.ts";
    const tidBE  = tid("fail-backend");
    const tidBS  = tid("fail-bs");

    await dispatch(orch, inboxA, {
      type: "task", task_id: tidBE,
      from: "orchestrator", to: "backend",
      subject: "implement payments service",
    });
    await dispatch(orch, inboxB, {
      type: "task", task_id: tidBS,
      from: "orchestrator", to: "bs",
      subject: "add tests for payments service",
    });

    // Backend: PASS — committed the service
    await workerA.runTurn({
      [tidBE]: async () => ({
        summary:        "PASS — payments service implemented",
        affected_files: [shared],
      }),
    });
    // bs: FAIL — tests compiled but one assertion failed; still touched the file
    await workerB.runTurn({
      [tidBS]: async () => ({
        summary:        "FAIL — test suite: 1 assertion failed in payments.service.spec.ts",
        affected_files: [shared, "backend/src/jobs/payments.service.spec.ts"],
      }),
    });

    // Assert FAIL envelope shape
    const failResults = await readResult(orch, status, tidBS);
    assert(failResults.length === 1,                       `fail: exactly 1 FAIL result (got ${failResults.length})`);
    assert(failResults[0].summary?.startsWith("FAIL"),     `fail: summary starts with FAIL (got: ${failResults[0]?.summary})`);
    assert(failResults[0].task_id === tidBS,               "fail: task_id correct on FAIL result");
    assert(Array.isArray(failResults[0].affected_files),   "fail: affected_files present on FAIL result");

    // FAIL counts toward conflict detection (only SKIP is excluded)
    const sfcRaw = await call(orch, "sprint_file_conflicts", { status_channel: status });
    const sfc    = JSON.parse(sfcRaw);

    assert(sfc.conflicts.length === 1,                   `fail: 1 conflict detected (FAIL counts) (got ${sfc.conflicts.length})`);
    assert(sfc.conflicts[0].file === shared,             `fail: conflict on shared file (got ${sfc.conflicts[0]?.file})`);
    assert(sfc.conflicts[0].workers.includes("backend"), "fail: backend in conflict workers");
    assert(sfc.conflicts[0].workers.includes("bs"),      "fail: bs in conflict workers");

    await call(orch, "purge_channel", { channel: inboxA });
    await call(orch, "purge_channel", { channel: inboxB });
    await call(orch, "purge_channel", { channel: status });
  }

  // ── 7. Multi-dep depends_on: all deps must be met ─────────────────────────
  // Task C depends on both A and B. If only A is available, C is still deferred.
  // Only after both A and B results exist on status does C execute.

  console.log("\n7. Multi-dep depends_on: ALL deps must be met before task executes");
  {
    const inbox  = ch("mdep-inbox");
    const status = ch("mdep-status");
    const tidA   = tid("mdep-a");
    const tidB   = tid("mdep-b");
    const tidC   = tid("mdep-c");
    const worker = new WorkerStub("alpha", inbox, ctrl, status, wA);

    const handlersC = {
      [tidC]: async () => ({
        summary:        "PASS — C done (A and B both ready)",
        affected_files: ["src/c.ts"],
      }),
    };

    // Dispatch C now — neither A nor B has a result yet
    await dispatch(orch, inbox, {
      type: "task", task_id: tidC,
      from: "orchestrator", to: "alpha",
      subject: "task C (depends on A and B)",
      depends_on: [`${tidA}:alpha`, `${tidB}:alpha`],
    });

    // Turn 1: both deps missing → C deferred
    const n1 = await worker.runTurn(handlersC);
    assert(n1 === 0, `mdep: turn 1 — C deferred (neither A nor B ready) (got ${n1})`);

    // Post only A's result — B still missing
    await call(orch, "send_message", {
      channel: status, sender: "alpha",
      content: JSON.stringify({
        type: "result", task_id: tidA,
        from: "alpha", to: "orchestrator",
        subject: "task A",
        summary: "PASS — A done",
        affected_files: ["src/a.ts"],
        body: { consent_basis: "orchestrator-dispatch-only" },
      }),
    });

    // Turn 2: A met, B still missing → C still deferred
    worker.inboxNextId = 0;
    const n2 = await worker.runTurn(handlersC);
    assert(n2 === 0, `mdep: turn 2 — C still deferred (B not ready) (got ${n2})`);

    // Post B's result — now both deps satisfied
    await call(orch, "send_message", {
      channel: status, sender: "alpha",
      content: JSON.stringify({
        type: "result", task_id: tidB,
        from: "alpha", to: "orchestrator",
        subject: "task B",
        summary: "PASS — B done",
        affected_files: ["src/b.ts"],
        body: { consent_basis: "orchestrator-dispatch-only" },
      }),
    });

    // Turn 3: both deps met → C executes
    worker.inboxNextId = 0;
    const n3 = await worker.runTurn(handlersC);
    assert(n3 === 1, `mdep: turn 3 — C processed (both deps met) (got ${n3})`);

    const cResults = await readResult(orch, status, tidC);
    assert(cResults.length === 1,                    `mdep: exactly 1 result for C (got ${cResults.length})`);
    assert(cResults[0].summary?.startsWith("PASS"), `mdep: C result is PASS (got: ${cResults[0]?.summary})`);

    await call(orch, "purge_channel", { channel: inbox  });
    await call(orch, "purge_channel", { channel: status });
  }

  // ── 8. Concurrent stubs racing on same task ────────────────────────────────
  // Two stubs targeting the same inbox (simulating a worker restart where the
  // old instance already completed the task). The second stub must be blocked
  // by check_result — only one result may appear on the status channel.

  console.log("\n8. Concurrent stubs racing on same task: only one processes it");
  {
    const inbox  = ch("race-inbox");
    const status = ch("race-status");
    const taskId = tid("race");

    // Both stubs share the same inbox channel and worker name
    const stubA = new WorkerStub("alpha", inbox, ctrl, status, wA);
    const stubB = new WorkerStub("alpha", inbox, ctrl, status, wB);

    await dispatch(orch, inbox, {
      type: "task", task_id: taskId,
      from: "orchestrator", to: "alpha",
      subject: "create payment record",
    });

    const handler = { "*": async () => ({ summary: "PASS — done", affected_files: ["src/payment.ts"] }) };

    // Stub A runs first and wins
    const nA = await stubA.runTurn(handler);
    assert(nA === 1, `race: stub A processed 1 task (got ${nA})`);

    // Stub B resets its cursor and re-reads the same inbox message
    stubB.inboxNextId = 0;
    const nB = await stubB.runTurn(handler);
    assert(nB === 0, `race: stub B skipped (check_result blocked it) (got ${nB})`);

    // Exactly one result on status — no duplicate
    const results = await readResult(orch, status, taskId);
    assert(results.length === 1, `race: exactly 1 result on status (got ${results.length})`);

    await call(orch, "purge_channel", { channel: inbox  });
    await call(orch, "purge_channel", { channel: status });
  }

  // ── 9. Blind spot e2e: omitting affected_files surfaces in blind_spots ─────
  // Worker B's handler returns no affected_files, which causes the stub to
  // post a result without that field. sprint_file_conflicts must add worker B
  // to blind_spots (cannot check it for conflicts) and not count it as clean.

  console.log("\n9. Blind spot e2e: worker omitting affected_files surfaces in blind_spots");
  {
    const inboxA  = ch("blind-inbox-a");
    const inboxB  = ch("blind-inbox-b");
    const status  = ch("blind-status");
    const workerA = new WorkerStub("backend",  inboxA, ctrl, status, wA);
    const workerB = new WorkerStub("frontend", inboxB, ctrl, status, wB);

    const tidBE = tid("blind-backend");
    const tidFE = tid("blind-frontend");

    await dispatch(orch, inboxA, {
      type: "task", task_id: tidBE,
      from: "orchestrator", to: "backend",
      subject: "add payment endpoint",
    });
    await dispatch(orch, inboxB, {
      type: "task", task_id: tidFE,
      from: "orchestrator", to: "frontend",
      subject: "add payment button",
    });

    // Backend declares affected_files → clean and detectable
    await workerA.runTurn({
      [tidBE]: async () => ({
        summary:        "PASS — payment endpoint added",
        affected_files: ["backend/src/payments/payments.controller.ts"],
      }),
    });
    // Frontend omits affected_files → stub posts result without it → blind spot
    await workerB.runTurn({
      [tidFE]: async () => ({
        summary: "PASS — payment button added",
        // no affected_files
      }),
    });

    const sfcRaw = await call(orch, "sprint_file_conflicts", { status_channel: status });
    const sfc    = JSON.parse(sfcRaw);

    assert(sfc.conflicts.length === 0,            "blind: no false conflicts");
    assert(sfc.clean_count === 1,                 `blind: clean_count=1 for backend file (got ${sfc.clean_count})`);
    assert(sfc.blind_spots.includes("frontend"),  "blind: frontend in blind_spots (no affected_files posted)");
    assert(!sfc.blind_spots.includes("backend"),  "blind: backend NOT in blind_spots");

    await call(orch, "purge_channel", { channel: inboxA });
    await call(orch, "purge_channel", { channel: inboxB });
    await call(orch, "purge_channel", { channel: status });
  }

  // ── 10. Schema validation: warn-only vs strict ────────────────────────────
  // Spec 2 (protocol-v2.md): broker validates send_message against registered
  // schemas. Warn-only: message inserted, response carries [WARN …] suffix.
  // Strict: message rejected, response has isError=true.

  console.log("\n10. Schema validation: warn-only inserts+warns; strict rejects");
  {
    const schemaCh = ch("schema-ch");
    const schema   = JSON.stringify({
      type: "object",
      required: ["type", "payload"],
      properties: {
        type:    { type: "string" },
        payload: { type: "string" },
      },
      additionalProperties: false,
    });

    await call(orch, "register_channel_schema", { channel: schemaCh, schema, strict: false });

    // Valid message — no warn
    const validRaw = await call(orch, "send_message", {
      channel: schemaCh, sender: "test",
      content: JSON.stringify({ type: "ping", payload: "hello" }),
    });
    assert(validRaw.includes("Sent #"),  "schema: valid message accepted in warn-only mode");
    assert(!validRaw.includes("WARN"),   "schema: valid message has no WARN suffix");

    // Invalid message (missing required 'payload') — inserted but WARN in response
    const warnRaw = await call(orch, "send_message", {
      channel: schemaCh, sender: "test",
      content: JSON.stringify({ type: "ping" }),
    });
    assert(warnRaw.includes("Sent #"),   "schema: invalid message still inserted in warn-only mode");
    assert(warnRaw.includes("WARN"),     "schema: invalid message response contains WARN marker");

    // Flip to strict
    await call(orch, "register_channel_schema", { channel: schemaCh, schema, strict: true });

    // Invalid in strict — isError, NOT inserted
    const strictRes = await callRaw(orch, "send_message", {
      channel: schemaCh, sender: "test",
      content: JSON.stringify({ type: "ping" }), // missing payload
    });
    assert(strictRes.isError === true,                                 "schema: strict mode returns isError=true on invalid message");
    assert(strictRes.content[0].text.includes("schema validation failed"), "schema: error text names the failure");

    // Valid message still accepted in strict mode
    const strictOkRaw = await call(orch, "send_message", {
      channel: schemaCh, sender: "test",
      content: JSON.stringify({ type: "ping", payload: "world" }),
    });
    assert(strictOkRaw.includes("Sent #"), "schema: valid message accepted in strict mode");
    assert(!strictOkRaw.includes("WARN"),  "schema: valid message has no WARN in strict mode");

    await call(orch, "clear_channel_schema", { channel: schemaCh });
    await call(orch, "purge_channel",         { channel: schemaCh });
  }

  // ── 11. Question / answer roundtrip ───────────────────────────────────────
  // Worker encounters ambiguity, posts type:question to status, blocks.
  // Orchestrator reads question, dispatches answer to worker inbox.
  // Worker reads answer, then completes the task.

  console.log("\n11. Question/answer roundtrip: worker asks, orchestrator answers, worker resumes");
  {
    const inbox  = ch("qa-inbox");
    const status = ch("qa-status");
    const taskId = tid("qa-task");
    const worker = new WorkerStub("alpha", inbox, ctrl, status, wA);

    await dispatch(orch, inbox, {
      type: "task", task_id: taskId,
      from: "orchestrator", to: "alpha",
      subject: "implement timestamp service",
      body: "Add src/timestamps.ts.",
    });

    // Worker encounters ambiguity before completing — posts question to status
    await call(wA, "send_message", {
      channel: status, sender: "alpha",
      content: JSON.stringify({
        type: "question", task_id: taskId,
        from: "alpha", to: "orchestrator",
        subject: "clarification: timezone convention",
        body: { question: "Should timestamps be UTC or local time?" },
      }),
    });

    // Orchestrator reads status, finds the question
    const statusMsgs = parseMessages(await call(orch, "read_messages", { channel: status, since_id: 0 }));
    const question   = statusMsgs.find(m => m.parsed?.type === "question");
    assert(question !== undefined,                        "qa: orchestrator found question on status channel");
    assert(question.parsed?.task_id === taskId,           "qa: question references correct task_id");
    assert(typeof question.parsed?.body?.question === "string", "qa: question has body.question field");

    // Orchestrator dispatches answer to worker inbox
    await dispatch(orch, inbox, {
      type: "question", task_id: taskId,
      from: "orchestrator", to: "alpha",
      subject: "Re: clarification: timezone convention",
      body: { answer: "Use UTC everywhere." },
    });

    // Worker reads inbox — finds answer in new messages
    const turnRaw = await call(wA, "turn_start", {
      inbox_channel:    inbox,
      control_channel:  ctrl,
      inbox_since_id:   worker.inboxNextId,
      control_since_id: worker.controlNextId,
    });
    const turn      = JSON.parse(turnRaw);
    const answerMsg = turn.inbox.find(m => {
      try { return JSON.parse(m.content).type === "question"; } catch { return false; }
    });
    assert(answerMsg !== undefined, "qa: worker received answer in inbox");
    const answer = JSON.parse(answerMsg.content);
    assert(answer.body?.answer === "Use UTC everywhere.", `qa: answer content correct (got: ${answer.body?.answer})`);

    // Worker unblocked — completes the original task
    worker.inboxNextId = turn.inbox_next_id;
    await call(wA, "send_message", {
      channel: status, sender: "alpha",
      content: JSON.stringify({
        type: "result", task_id: taskId,
        from: "alpha", to: "orchestrator",
        subject: "implement timestamp service",
        summary: "PASS — timestamps in UTC as per orchestrator answer",
        affected_files: ["src/timestamps.ts"],
        body: { consent_basis: "orchestrator-dispatch-only" },
      }),
    });

    const results = await readResult(orch, status, taskId);
    assert(results.length === 1,                   "qa: result posted after question answered");
    assert(results[0].summary?.startsWith("PASS"), "qa: result is PASS");

    await call(orch, "purge_channel", { channel: inbox  });
    await call(orch, "purge_channel", { channel: status });
  }

  // ── 12. Rotate message handling ───────────────────────────────────────────
  // Orchestrator broadcasts type:rotate on control channel.
  // turn_start.rotate_requested → true.
  // Worker finishes in-progress work, posts protocol exit status, exits.

  console.log("\n12. Rotate message: turn_start.rotate_requested=true → worker posts exit status");
  {
    const inbox   = ch("rot-inbox");
    const rotCtrl = ch("rot-ctrl");   // isolated so rotate doesn't bleed into other tests
    const status  = ch("rot-status");
    const rotTid  = tid("rot-task");

    // Orchestrator broadcasts rotate on control channel
    await call(orch, "send_message", {
      channel: rotCtrl, sender: "orchestrator",
      content: JSON.stringify({
        type: "rotate", task_id: rotTid,
        from: "orchestrator", to: "*",
        subject: "rotate — context at 148k",
      }),
    });

    // Worker's turn_start detects rotate_requested
    const turnRaw = await call(wA, "turn_start", {
      inbox_channel:    inbox,
      control_channel:  rotCtrl,
      inbox_since_id:   0,
      control_since_id: 0,
    });
    const turn = JSON.parse(turnRaw);
    assert(turn.rotate_requested === true,  "rotate: turn_start.rotate_requested is true");
    assert(turn.control.length > 0,         "rotate: control channel has the rotate message");
    assert(turn.inbox.length === 0,         "rotate: inbox is empty (no pending tasks)");

    // Worker posts protocol-mandated exit status and exits
    await call(wA, "send_message", {
      channel: status, sender: "alpha",
      content: JSON.stringify({
        type: "status", task_id: rotTid,
        from: "alpha", to: "orchestrator",
        subject: "idle-loop exit — rotate requested",
        body: {
          reason: "orchestrator-rotate",
          last_task_id: null,
          open_since_ids: {
            inbox:   turn.inbox_next_id,
            control: turn.control_next_id,
            status:  0,
          },
        },
      }),
    });

    const statusMsgs   = parseMessages(await call(orch, "read_messages", { channel: status, since_id: 0 }));
    const rotateStatus = statusMsgs.find(m => m.parsed?.body?.reason === "orchestrator-rotate");
    assert(rotateStatus !== undefined,                                           "rotate: rotate exit status posted to status channel");
    assert(rotateStatus.parsed?.type === "status",                               "rotate: type is status");
    assert(rotateStatus.parsed?.subject === "idle-loop exit — rotate requested", "rotate: subject matches protocol");
    assert(rotateStatus.parsed?.body?.open_since_ids !== undefined,              "rotate: open_since_ids present in body");

    await call(orch, "purge_channel", { channel: inbox   });
    await call(orch, "purge_channel", { channel: rotCtrl });
    await call(orch, "purge_channel", { channel: status  });
  }

  // ── 13. Idle drain + exit status ──────────────────────────────────────────
  // After processing all tasks, worker drains the inbox (empty turn_start),
  // then posts the mandatory idle-loop exit note before exiting.

  console.log("\n13. Idle drain + exit status: worker posts exit note after inbox empty");
  {
    const inbox  = ch("idle-inbox");
    const status = ch("idle-status");
    const taskId = tid("idle-task");
    const worker = new WorkerStub("alpha", inbox, ctrl, status, wA);

    await dispatch(orch, inbox, {
      type: "task", task_id: taskId,
      from: "orchestrator", to: "alpha",
      subject: "idle drain test task",
    });

    const n = await worker.runTurn({
      [taskId]: async () => ({ summary: "PASS — task done", affected_files: ["src/idle.ts"] }),
    });
    assert(n === 1, `idle: task processed (got ${n})`);

    // Worker drains: reads inbox again — must be empty
    const drainRaw  = await call(wA, "turn_start", {
      inbox_channel:    inbox,
      control_channel:  ctrl,
      inbox_since_id:   worker.inboxNextId,
      control_since_id: worker.controlNextId,
    });
    const drainTurn = JSON.parse(drainRaw);
    assert(drainTurn.inbox.length === 0, "idle: inbox empty after processing all tasks");

    // Worker posts mandatory exit note (protocol: every session exit)
    await call(wA, "send_message", {
      channel: status, sender: "alpha",
      content: JSON.stringify({
        type: "status",
        task_id: `idle-loop-exit-2026-06-18`,
        from: "alpha", to: "orchestrator",
        subject: "idle-loop exit",
        body: { reason: "inbox-drained", last_task_id: taskId },
      }),
    });

    const statusMsgs = parseMessages(await call(orch, "read_messages", { channel: status, since_id: 0 }));
    const exitNote   = statusMsgs.find(m => m.parsed?.body?.reason === "inbox-drained");
    assert(exitNote !== undefined,                             "idle: exit note posted to status channel");
    assert(exitNote.parsed?.type === "status",                 "idle: exit note type is status");
    assert(exitNote.parsed?.subject === "idle-loop exit",      "idle: subject matches protocol");
    assert(exitNote.parsed?.from === "alpha",                  "idle: exit note from correct worker");
    assert(exitNote.parsed?.body?.last_task_id === taskId,     `idle: last_task_id correct (got: ${exitNote.parsed?.body?.last_task_id})`);

    await call(orch, "purge_channel", { channel: inbox  });
    await call(orch, "purge_channel", { channel: status });
  }

  // ── 14. Approval-token / consent_basis ────────────────────────────────────
  // For production-touching tasks, orchestrator broadcasts type:approval-token
  // on control. Worker reads it via turn_start, captures its message id, and
  // includes consent_basis: "approval-token:#<id>" in the result envelope.

  console.log("\n14. Approval-token: worker reads token via turn_start, uses id in consent_basis");
  {
    const inbox    = ch("appr-inbox");
    const apprCtrl = ch("appr-ctrl");   // isolated control channel
    const status   = ch("appr-status");
    const taskId   = tid("appr-task");

    // Orchestrator broadcasts approval-token on control
    await call(orch, "send_message", {
      channel: apprCtrl, sender: "orchestrator",
      content: JSON.stringify({
        type: "approval-token", task_id: taskId,
        from: "orchestrator", to: "*",
        subject: "approval-token",
        body: {
          authorized_actions: ["flip-schema-strict"],
          env: "prod",
          scope_workers: ["core", "protocol-qa"],
          expires_at: "2026-06-18T23:59:59Z",
          approved_by: "human",
          consent_basis: "terminal-human",
        },
      }),
    });

    // Capture token's message id via has_messages max_id
    const hmRaw   = await call(orch, "has_messages", { channel: apprCtrl, since_id: 0 });
    const tokenId = JSON.parse(hmRaw).max_id;

    // Dispatch production-touching task to worker
    await dispatch(orch, inbox, {
      type: "task", task_id: taskId,
      from: "orchestrator", to: "alpha",
      subject: "flip cb-status schema to strict mode",
    });

    // Worker's turn_start reads inbox + control in one round-trip
    const turnRaw = await call(wA, "turn_start", {
      inbox_channel:    inbox,
      control_channel:  apprCtrl,
      inbox_since_id:   0,
      control_since_id: 0,
    });
    const turn     = JSON.parse(turnRaw);

    // Worker finds approval-token in control messages
    const tokenMsg = turn.control.find(m => {
      try { return JSON.parse(m.content).type === "approval-token"; } catch { return false; }
    });
    assert(tokenMsg !== undefined,   "approval: worker sees approval-token via turn_start control");
    assert(tokenMsg.id === tokenId,  `approval: token id matches (got ${tokenMsg.id}, expected ${tokenId})`);

    // Worker posts result with approval-token consent_basis
    const consentBasis = `approval-token:#${tokenId}`;
    await call(wA, "send_message", {
      channel: status, sender: "alpha",
      content: JSON.stringify({
        type: "result", task_id: taskId,
        from: "alpha", to: "orchestrator",
        subject: "flip cb-status schema to strict mode",
        summary: "PASS — schema flipped to strict, verified with get_channel_schema",
        affected_files: ["schemas/cb-status.json"],
        body: { consent_basis: consentBasis },
      }),
    });

    const results = await readResult(orch, status, taskId);
    assert(results.length === 1,                              "approval: result posted");
    assert(results[0].summary?.startsWith("PASS"),            "approval: result is PASS");
    assert(results[0].body?.consent_basis === consentBasis,   `approval: consent_basis = '${consentBasis}' (got: ${results[0].body?.consent_basis})`);

    await call(orch, "purge_channel", { channel: inbox    });
    await call(orch, "purge_channel", { channel: apprCtrl });
    await call(orch, "purge_channel", { channel: status   });
  }

  // ── 15. consent-grant/deny two-hop escalation ─────────────────────────────
  // Real example (platform-orch CLAUDE.md §3 "Consent intercept"):
  //   worker needs prod consent → asks cluster-orch via clusterStatus
  //   → cluster-orch relays to root via crossStatus
  //   → root grants → cluster-orch receives grant → forwards to worker inbox
  //   → worker resumes with consent_basis: "terminal-human"

  console.log("\n15. consent-grant/deny: two-hop escalation (worker → cluster-orch → root → cluster-orch → worker)");
  {
    const workerInbox      = ch("ce-worker-inbox");
    const clusterOrchInbox = ch("ce-orch-inbox");
    const clusterStatus    = ch("ce-cluster-status");
    const crossStatus      = ch("ce-cross-status");
    const ceCtrl           = ch("ce-ctrl");
    const taskId           = tid("ce-deploy");

    // Hop 1 — root dispatches sprint goal to cluster-orch inbox
    await call(orch, "send_message", {
      channel: clusterOrchInbox, sender: "root-orchestrator",
      content: JSON.stringify({
        type: "task", task_id: taskId,
        from: "root-orchestrator", to: "platform-orch",
        subject: "deploy payment gateway to prod",
        body: "Deploy and verify payment gateway service on prod.",
      }),
    });

    // Hop 2 — cluster-orch (wB) reads goal, decomposes, dispatches to backend
    const orchT1 = JSON.parse(await call(wB, "turn_start", {
      inbox_channel: clusterOrchInbox, control_channel: ceCtrl,
      inbox_since_id: 0, control_since_id: 0,
    }));
    assert(orchT1.inbox.length === 1,                           "consent: cluster-orch received sprint goal");
    assert(JSON.parse(orchT1.inbox[0].content).from === "root-orchestrator", "consent: goal came from root");

    await call(wB, "send_message", {
      channel: workerInbox, sender: "platform-orch",
      content: JSON.stringify({
        type: "task", task_id: taskId,
        from: "platform-orch", to: "backend",
        subject: "deploy payment gateway to prod",
        body: "Run deploy script after obtaining consent.",
      }),
    });

    // Hop 3 — backend (wA) reads task, needs consent → posts question to clusterStatus
    const wT1 = JSON.parse(await call(wA, "turn_start", {
      inbox_channel: workerInbox, control_channel: ceCtrl,
      inbox_since_id: 0, control_since_id: 0,
    }));
    assert(wT1.inbox.length === 1, "consent: backend received task");

    await call(wA, "send_message", {
      channel: clusterStatus, sender: "backend",
      content: JSON.stringify({
        type: "question", task_id: taskId,
        from: "backend", to: "platform-orch",
        subject: "consent required: deploy payment gateway to prod",
        body: { question: "Need consent to run deploy script on prod." },
      }),
    });

    // Hop 4 — cluster-orch intercepts consent request, escalates to root
    const clusterMsgs = parseMessages(await call(wB, "read_messages", {
      channel: clusterStatus, since_id: 0,
    }));
    const consentReq = clusterMsgs.find(m => m.parsed?.type === "question");
    assert(consentReq !== undefined,                                    "consent: cluster-orch intercepted consent request");
    assert(consentReq.parsed?.subject?.includes("consent required"),    "consent: request subject flags consent required");

    await call(wB, "send_message", {
      channel: crossStatus, sender: "platform-orch",
      content: JSON.stringify({
        type: "question", task_id: taskId,
        from: "platform-orch", to: "root-orchestrator",
        subject: "consent required: deploy payment gateway to prod",
        body: { question: "Backend needs prod consent. Relaying.", original_task_id: taskId },
      }),
    });

    // Hop 5 — root reads crossStatus, grants consent to cluster-orch inbox
    const crossMsgs = parseMessages(await call(orch, "read_messages", { channel: crossStatus, since_id: 0 }));
    const escalation = crossMsgs.find(m => m.parsed?.type === "question" && m.parsed?.to === "root-orchestrator");
    assert(escalation !== undefined,                    "consent: root received escalation from cluster-orch");
    assert(escalation.parsed?.from === "platform-orch", "consent: escalation came from cluster-orch");

    await call(orch, "send_message", {
      channel: clusterOrchInbox, sender: "root-orchestrator",
      content: JSON.stringify({
        type: "consent-grant", task_id: taskId,
        from: "root-orchestrator", to: "platform-orch",
        subject: "consent granted: deploy payment gateway to prod",
        body: { consent_basis: "terminal-human", authorized_by: "human" },
      }),
    });

    // Hop 6 — cluster-orch reads grant, relays verbatim to backend inbox
    const orchT2 = JSON.parse(await call(wB, "turn_start", {
      inbox_channel: clusterOrchInbox, control_channel: ceCtrl,
      inbox_since_id: orchT1.inbox_next_id, control_since_id: orchT1.control_next_id,
    }));
    const grantMsg = orchT2.inbox.find(m => {
      try { return JSON.parse(m.content).type === "consent-grant"; } catch { return false; }
    });
    assert(grantMsg !== undefined, "consent: cluster-orch received consent-grant from root");

    await call(wB, "send_message", {
      channel: workerInbox, sender: "platform-orch",
      content: grantMsg.content,  // verbatim relay
    });

    // Hop 7 — backend reads grant, proceeds, posts result
    const wT2 = JSON.parse(await call(wA, "turn_start", {
      inbox_channel: workerInbox, control_channel: ceCtrl,
      inbox_since_id: wT1.inbox_next_id, control_since_id: wT1.control_next_id,
    }));
    const relayedGrant = wT2.inbox.find(m => {
      try { return JSON.parse(m.content).type === "consent-grant"; } catch { return false; }
    });
    assert(relayedGrant !== undefined, "consent: backend received relayed consent-grant");

    const grantBody = JSON.parse(relayedGrant.content).body;
    await call(wA, "send_message", {
      channel: clusterStatus, sender: "backend",
      content: JSON.stringify({
        type: "result", task_id: taskId,
        from: "backend", to: "platform-orch",
        subject: "deploy payment gateway to prod",
        summary: "PASS — payment gateway deployed to prod",
        affected_files: ["infra/payment-gateway/deploy.sh"],
        body: { consent_basis: grantBody.consent_basis },
      }),
    });

    const resultMsgs = parseMessages(await call(orch, "read_messages", { channel: clusterStatus, since_id: 0 }));
    const deployResult = resultMsgs.find(m => m.parsed?.type === "result" && m.parsed?.task_id === taskId);
    assert(deployResult !== undefined,                                    "consent: result posted to clusterStatus");
    assert(deployResult.parsed?.body?.consent_basis === "terminal-human", `consent: consent_basis=terminal-human (got: ${deployResult.parsed?.body?.consent_basis})`);

    for (const c of [workerInbox, clusterOrchInbox, clusterStatus, crossStatus, ceCtrl]) {
      await call(orch, "purge_channel", { channel: c });
    }
  }

  // ── 16. contract-change + wire_compat broadcast ────────────────────────────
  // Real example (consumer-orch CLAUDE.md §pet-graph): before dispatching a
  // schema change that affects multiple workers, orchestrator broadcasts a
  // type:contract-change on ex-control with wire_compat: "additive"|"breaking".
  // Schema enforces wire_compat is required on contract-change messages.

  console.log("\n16. contract-change + wire_compat: broadcast read and schema enforcement");
  {
    const ccCtrl   = ch("cc-ctrl");
    const ccStatus = ch("cc-status");
    const ccInbox  = ch("cc-inbox");
    const taskId   = tid("cc-schema");

    // Register a schema on the ctrl channel that enforces wire_compat on contract-change
    const controlSchema = JSON.stringify({
      type: "object",
      required: ["type", "task_id", "from", "to", "subject"],
      properties: {
        type: { enum: ["contract-change", "approval-token", "note", "rotate"] },
        task_id: { type: "string", minLength: 3 },
        from: { type: "string" }, to: { type: "string" }, subject: { type: "string" },
        wire_compat: { enum: ["additive", "breaking"] },
        body: {},
      },
      allOf: [{
        if: { properties: { type: { const: "contract-change" } }, required: ["type"] },
        then: { required: ["wire_compat"] },
      }],
    });
    await call(orch, "register_channel_schema", { channel: ccCtrl, schema: controlSchema, strict: true });

    // contract-change without wire_compat → strict reject
    const badRes = await callRaw(orch, "send_message", {
      channel: ccCtrl, sender: "orchestrator",
      content: JSON.stringify({
        type: "contract-change", task_id: taskId,
        from: "orchestrator", to: "*",
        subject: "pet-graph v2 schema — add collar_firmware_version",
        body: { before: "schema v1", after: "schema v2", affected_workers: ["mobile", "health", "marketplace"] },
        // wire_compat intentionally omitted
      }),
    });
    assert(badRes.isError === true, "cc: contract-change without wire_compat rejected by strict schema");

    // Valid contract-change with wire_compat: "additive"
    await call(orch, "send_message", {
      channel: ccCtrl, sender: "orchestrator",
      content: JSON.stringify({
        type: "contract-change", task_id: taskId,
        from: "orchestrator", to: "*",
        subject: "pet-graph v2 schema — add collar_firmware_version",
        wire_compat: "additive",
        body: { before: "schema v1", after: "schema v2", affected_workers: ["mobile", "health", "marketplace"] },
      }),
    });

    // Worker reads control via turn_start, finds contract-change
    const turn = JSON.parse(await call(wA, "turn_start", {
      inbox_channel: ccInbox, control_channel: ccCtrl,
      inbox_since_id: 0, control_since_id: 0,
    }));
    const ccMsg = turn.control.find(m => {
      try { return JSON.parse(m.content).type === "contract-change"; } catch { return false; }
    });
    assert(ccMsg !== undefined,                               "cc: worker sees contract-change via turn_start.control");
    const cc = JSON.parse(ccMsg.content);
    assert(cc.wire_compat === "additive",                     `cc: wire_compat=additive (got: ${cc.wire_compat})`);
    assert(Array.isArray(cc.body?.affected_workers),          "cc: affected_workers is array");
    assert(cc.body.affected_workers.includes("mobile"),       "cc: mobile in affected_workers");
    assert(cc.body.affected_workers.includes("health"),       "cc: health in affected_workers");
    assert(cc.body.affected_workers.includes("marketplace"),  "cc: marketplace in affected_workers");

    // Worker acknowledges by posting note to status
    await call(wA, "send_message", {
      channel: ccStatus, sender: "mobile",
      content: JSON.stringify({
        type: "note", task_id: taskId,
        from: "mobile", to: "orchestrator",
        subject: "contract-change ack: pet-graph v2",
        body: { ack: true, wire_compat: cc.wire_compat },
      }),
    });

    const statusMsgs = parseMessages(await call(orch, "read_messages", { channel: ccStatus, since_id: 0 }));
    const ack = statusMsgs.find(m => m.parsed?.type === "note" && m.parsed?.body?.ack === true);
    assert(ack !== undefined,                              "cc: worker posted acknowledgment note");
    assert(ack.parsed?.body?.wire_compat === "additive",   "cc: ack echoes wire_compat value");

    await call(orch, "clear_channel_schema", { channel: ccCtrl });
    for (const c of [ccCtrl, ccStatus, ccInbox]) {
      await call(orch, "purge_channel", { channel: c });
    }
  }

  // ── 17. Stall detection ────────────────────────────────────────────────────
  // Real example (platform-orch CLAUDE.md §idle loop): after wait_for_messages
  // timeout, cluster-orch checks ledger. Tasks where (now - dispatched_at) > 20min
  // AND (now - last_checkpoint_ts) > 10min → post stall note to root-orchestrator.
  // Uses manufactured timestamps to test the logic without waiting 20 minutes.

  console.log("\n17. Stall detection: cluster-orch ledger detects stalled worker and escalates to root");
  {
    const workerInbox = ch("stall-worker-inbox");
    const crossSt     = ch("stall-cross-status");
    const stallTid    = tid("stall-deploy");

    const STALL_DISPATCH_MS   = 20 * 60 * 1000;
    const STALL_CHECKPOINT_MS = 10 * 60 * 1000;

    // Ledger entry with stale timestamps (simulates task dispatched 25min ago,
    // last checkpoint 15min ago — both thresholds exceeded)
    const ledger = {
      [stallTid]: {
        worker:             "backend",
        status:             "dispatched",
        dispatched_at:      new Date(Date.now() - 25 * 60 * 1000).toISOString(),
        last_checkpoint_ts: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
      },
      "recent-task": {
        worker:             "devops",
        status:             "dispatched",
        dispatched_at:      new Date(Date.now() - 2 * 60 * 1000).toISOString(),  // only 2 min old
        last_checkpoint_ts: new Date(Date.now() - 1 * 60 * 1000).toISOString(),
      },
    };

    // Cluster-orch runs stall check after its wait_for_messages timeout
    const now = Date.now();
    let stallsPosted = 0;
    const stalled = [];
    for (const [taskId, entry] of Object.entries(ledger)) {
      if (entry.status === "result") continue;
      const dispatchAge   = now - new Date(entry.dispatched_at).getTime();
      const checkpointAge = now - new Date(entry.last_checkpoint_ts).getTime();
      if (dispatchAge > STALL_DISPATCH_MS && checkpointAge > STALL_CHECKPOINT_MS) {
        stalled.push({ taskId, entry, dispatchAge });
      }
    }
    for (const { taskId, entry, dispatchAge } of stalled) {
      const elapsedMin = Math.round(dispatchAge / 60000);
      await call(wB, "send_message", {
        channel: crossSt, sender: "platform-orch",
        content: JSON.stringify({
          type: "note", task_id: taskId,
          from: "platform-orch", to: "root-orchestrator",
          subject: `worker stall: ${entry.worker}, task ${taskId}`,
          body: {
            worker: entry.worker, task_id: taskId,
            dispatched_at: entry.dispatched_at,
            last_checkpoint_ts: entry.last_checkpoint_ts,
            elapsed_min: elapsedMin,
          },
        }),
      });
      stallsPosted++;
    }
    assert(stallsPosted === 1, `stall: exactly 1 stall posted (got ${stallsPosted}) — recent-task must NOT be flagged`);

    // Root reads crossStatus, finds stall escalation
    const crossMsgs = parseMessages(await call(orch, "read_messages", { channel: crossSt, since_id: 0 }));
    const stallNote  = crossMsgs.find(m => m.parsed?.type === "note" && m.parsed?.to === "root-orchestrator");
    assert(stallNote !== undefined,                                 "stall: root received stall escalation");
    assert(stallNote.parsed?.body?.worker === "backend",            "stall: stall note identifies the stalled worker");
    assert(stallNote.parsed?.subject?.includes("worker stall"),     "stall: subject indicates stall");
    assert(typeof stallNote.parsed?.body?.elapsed_min === "number", "stall: elapsed_min is a number");
    assert(stallNote.parsed?.body?.elapsed_min >= 20,               `stall: elapsed_min >= 20 (got ${stallNote.parsed?.body?.elapsed_min})`);
    assert(stallNote.parsed?.body?.dispatched_at !== undefined,     "stall: dispatched_at in body");
    assert(stallNote.parsed?.body?.last_checkpoint_ts !== undefined,"stall: last_checkpoint_ts in body");

    // Verify recent-task was NOT escalated
    const devopsStall = crossMsgs.find(m => m.parsed?.body?.worker === "devops");
    assert(devopsStall === undefined, "stall: recent devops task NOT flagged as stall");

    for (const c of [workerInbox, crossSt]) {
      await call(orch, "purge_channel", { channel: c });
    }
  }

  // ── 18. Multi-orchestrator flat topology ──────────────────────────────────
  // Tests the full 4-hop chain present in example:
  //   root → cluster-orch inbox
  //   → cluster-orch decomposes + dispatches → worker inbox
  //   → worker posts result → cluster-status
  //   → cluster-orch reads + rolls up → cross-cluster status
  //   → root reads sprint summary

  console.log("\n18. Multi-orchestrator topology: root → cluster-orch → worker → cluster-orch → root");
  {
    const clusterOrchInbox = ch("mo-orch-inbox");
    const workerInbox_     = ch("mo-worker-inbox");
    const clusterSt        = ch("mo-cluster-status");
    const crossSt          = ch("mo-cross-status");
    const moCtrl           = ch("mo-ctrl");
    const goalTaskId       = tid("mo-goal");
    const workerTaskId     = tid("mo-worker-task");

    // Hop 1 — root dispatches sprint goal to cluster-orch inbox
    await call(orch, "send_message", {
      channel: clusterOrchInbox, sender: "root-orchestrator",
      content: JSON.stringify({
        type: "task", task_id: goalTaskId,
        from: "root-orchestrator", to: "platform-orch",
        subject: "implement rate-limit monitoring",
        body: "Add rate-limit metrics to backend and report.",
        required_checks: ["test", "committed"],
      }),
    });

    // Hop 2 — cluster-orch (wB) reads goal, decomposes, dispatches concrete task to worker
    const orchT1 = JSON.parse(await call(wB, "turn_start", {
      inbox_channel: clusterOrchInbox, control_channel: moCtrl,
      inbox_since_id: 0, control_since_id: 0,
    }));
    assert(orchT1.inbox.length === 1, "mo: cluster-orch received goal from root");
    const parsedGoal = JSON.parse(orchT1.inbox[0].content);
    assert(parsedGoal.from === "root-orchestrator", "mo: goal came from root");
    assert(parsedGoal.required_checks?.includes("test"), "mo: goal carries required_checks");

    await call(wB, "send_message", {
      channel: workerInbox_, sender: "platform-orch",
      content: JSON.stringify({
        type: "task", task_id: workerTaskId,
        from: "platform-orch", to: "backend",
        subject: "add rate-limit metrics endpoint",
        required_checks: ["test", "committed"],
        body: "Add GET /metrics/rate-limits to server.js.",
      }),
    });

    // Hop 3 — worker (wA) reads task, processes, posts result to cluster-status
    const worker   = new WorkerStub("backend", workerInbox_, moCtrl, clusterSt, wA);
    const nWorker  = await worker.runTurn({
      [workerTaskId]: async () => ({
        summary:        "PASS — rate-limit metrics endpoint added",
        affected_files: ["backend/src/metrics/rate-limits.ts"],
        body:           { required_checks: { test: "PASS (12/12)", committed: "PASS" } },
      }),
    });
    assert(nWorker === 1, "mo: worker processed task");

    // Hop 4 — cluster-orch reads cluster-status, finds result, posts roll-up to cross-cluster status
    const clusterMsgs = parseMessages(await call(wB, "read_messages", {
      channel: clusterSt, since_id: 0,
    }));
    const workerResult = clusterMsgs.find(m =>
      m.parsed?.type === "result" && m.parsed?.task_id === workerTaskId);
    assert(workerResult !== undefined,              "mo: cluster-orch found worker result on clusterStatus");
    assert(workerResult.parsed?.from === "backend", "mo: result is from backend");

    await call(wB, "send_message", {
      channel: crossSt, sender: "platform-orch",
      content: JSON.stringify({
        type: "result", task_id: goalTaskId,
        from: "platform-orch", to: "root-orchestrator",
        subject: "implement rate-limit monitoring",
        summary: `PASS — platform cluster done: ${workerResult.parsed?.summary}`,
        affected_files: workerResult.parsed?.affected_files ?? [],
        body: {
          consent_basis: "orchestrator-dispatch-only",
          cluster_results: [{
            worker: "backend", task_id: workerTaskId,
            summary: workerResult.parsed?.summary,
          }],
        },
      }),
    });

    // Hop 5 — root reads cross-cluster status, finds cluster-orch roll-up
    const crossMsgs   = parseMessages(await call(orch, "read_messages", { channel: crossSt, since_id: 0 }));
    const orchSummary  = crossMsgs.find(m =>
      m.parsed?.type === "result" && m.parsed?.task_id === goalTaskId);
    assert(orchSummary !== undefined,                                    "mo: root received cluster-orch summary");
    assert(orchSummary.parsed?.from === "platform-orch",                 "mo: summary came from cluster-orch");
    assert(orchSummary.parsed?.to === "root-orchestrator",               "mo: summary addressed to root");
    assert(orchSummary.parsed?.summary?.startsWith("PASS"),              "mo: summary is PASS");
    assert(Array.isArray(orchSummary.parsed?.body?.cluster_results),     "mo: cluster_results in body");
    assert(orchSummary.parsed?.body?.cluster_results[0]?.worker === "backend", "mo: backend in cluster_results");

    for (const c of [clusterOrchInbox, workerInbox_, clusterSt, crossSt, moCtrl]) {
      await call(orch, "purge_channel", { channel: c });
    }
  }

  // ── 19. Approval-revoke racing with in-flight result ──────────────────────
  // Orchestrator posts approval-token, then revokes it before worker posts result.
  // Worker's second turn_start detects the revoke via body.revokes_msg_id,
  // cancels the pending result, and posts a stand-down note.

  console.log("\n19. Approval-revoke: token revoked mid-flight; worker detects and stands down");
  {
    const inbox   = ch("rev-inbox");
    const revCtrl = ch("rev-ctrl");
    const status  = ch("rev-status");
    const taskId  = tid("rev-task");

    // Orchestrator broadcasts approval-token
    await call(orch, "send_message", {
      channel: revCtrl, sender: "orchestrator",
      content: JSON.stringify({
        type: "approval-token", task_id: taskId,
        from: "orchestrator", to: "*",
        subject: "approval-token",
        body: {
          authorized_actions: ["db-migration"],
          env: "prod", scope_workers: ["backend"],
          expires_at: "2026-06-18T23:59:59Z",
          approved_by: "human", consent_basis: "terminal-human",
        },
      }),
    });
    const tokenId = JSON.parse(await call(orch, "has_messages", { channel: revCtrl, since_id: 0 })).max_id;

    // Dispatch task to worker
    await dispatch(orch, inbox, {
      type: "task", task_id: taskId,
      from: "orchestrator", to: "backend",
      subject: "run DB migration on prod",
    });

    // Worker turn 1: reads token from control, sees task in inbox
    const turn1 = JSON.parse(await call(wA, "turn_start", {
      inbox_channel: inbox, control_channel: revCtrl,
      inbox_since_id: 0, control_since_id: 0,
    }));
    const tokenInCtrl = turn1.control.find(m => {
      try { return JSON.parse(m.content).type === "approval-token"; } catch { return false; }
    });
    assert(tokenInCtrl !== undefined,  "revoke: worker sees token in turn 1 control");
    assert(tokenInCtrl.id === tokenId, "revoke: token id matches");

    // Orchestrator revokes the token mid-flight (before worker posts result)
    await call(orch, "send_message", {
      channel: revCtrl, sender: "orchestrator",
      content: JSON.stringify({
        type: "approval-revoke", task_id: taskId,
        from: "orchestrator", to: "*",
        subject: "approval-revoke: db-migration token cancelled",
        body: { revokes_msg_id: tokenId },
      }),
    });

    // Worker turn 2: re-checks control for new messages since turn 1
    const turn2 = JSON.parse(await call(wA, "turn_start", {
      inbox_channel: inbox, control_channel: revCtrl,
      inbox_since_id: turn1.inbox_next_id,
      control_since_id: turn1.control_next_id,
    }));
    const revokeMsg = turn2.control.find(m => {
      try { return JSON.parse(m.content).type === "approval-revoke"; } catch { return false; }
    });
    assert(revokeMsg !== undefined, "revoke: worker sees approval-revoke in turn 2 control");
    const revoke = JSON.parse(revokeMsg.content);
    assert(revoke.body?.revokes_msg_id === tokenId,
      `revoke: revokes_msg_id matches token (got ${revoke.body?.revokes_msg_id}, expected ${tokenId})`);

    // Worker detects its token was revoked → stands down (does NOT post result)
    const myTokenWasRevoked = revoke.body.revokes_msg_id === tokenId;
    assert(myTokenWasRevoked, "revoke: worker correctly identifies its token was revoked");

    await call(wA, "send_message", {
      channel: status, sender: "backend",
      content: JSON.stringify({
        type: "note", task_id: taskId,
        from: "backend", to: "orchestrator",
        subject: "standing down: approval-token revoked before result posted",
        body: {
          reason: "approval-revoke received",
          revoked_token_id: tokenId,
          action: "task not completed — awaiting fresh authorization",
        },
      }),
    });

    // Assert: no result, only the stand-down note
    const results   = await readResult(orch, status, taskId);
    const statusMsg = parseMessages(await call(orch, "read_messages", { channel: status, since_id: 0 }));
    const standDown = statusMsg.find(m =>
      m.parsed?.type === "note" && m.parsed?.body?.reason === "approval-revoke received");
    assert(results.length === 0,                                     "revoke: NO result posted (worker stood down)");
    assert(standDown !== undefined,                                  "revoke: stand-down note posted to status");
    assert(standDown.parsed?.body?.revoked_token_id === tokenId,     "revoke: note references revoked token id");
    assert(standDown.parsed?.body?.action?.includes("fresh authorization"), "revoke: note explains next step");

    for (const c of [inbox, revCtrl, status]) {
      await call(orch, "purge_channel", { channel: c });
    }
  }

  // ── 20. Heartbeat telemetry + rotation dispatch ───────────────────────────────
  // Worker posts heartbeats via upsert_heartbeat (keep-latest per sender).
  // Orchestrator reads get_latest_per_sender, detects context threshold crossed,
  // and broadcasts type:rotate on the control channel.
  // Worker's next turn_start sees rotate_requested=true.

  console.log("\n20. Heartbeat telemetry: worker upserts heartbeats, orchestrator detects threshold and dispatches rotate");
  {
    const telCh   = ch("hb-telemetry");
    const hbCtrl  = ch("hb-ctrl");
    const hbInbox = ch("hb-inbox");
    const ROTATION_THRESHOLD = 75.0;

    // Worker A sends 3 heartbeats — only the latest should survive per sender
    await call(wA, "upsert_heartbeat", { channel: telCh, sender: "backend",
      content: JSON.stringify({ type: "heartbeat", from: "backend",
        context: { tier_threshold_pct: 42.0 }, activity: { state: "working" } }) });
    await call(wA, "upsert_heartbeat", { channel: telCh, sender: "backend",
      content: JSON.stringify({ type: "heartbeat", from: "backend",
        context: { tier_threshold_pct: 61.5 }, activity: { state: "working" } }) });
    await call(wA, "upsert_heartbeat", { channel: telCh, sender: "backend",
      content: JSON.stringify({ type: "heartbeat", from: "backend",
        context: { tier_threshold_pct: 79.2 }, activity: { state: "working" } }) });

    // Worker B sends a heartbeat below threshold
    await call(wB, "upsert_heartbeat", { channel: telCh, sender: "frontend",
      content: JSON.stringify({ type: "heartbeat", from: "frontend",
        context: { tier_threshold_pct: 31.0 }, activity: { state: "idle-polling" } }) });

    // Channel must have exactly 2 messages (upsert keeps one per sender)
    const allRaw   = await call(orch, "read_messages", { channel: telCh, since_id: 0 });
    const allLines = allRaw.trim().split("\n").filter(l => /^\[#\d+\]/.test(l));
    assert(allLines.length === 2,
      `hb: telemetry has exactly 2 messages — one per sender (got ${allLines.length})`);

    // Orchestrator reads get_latest_per_sender (efficient telemetry snapshot)
    const latestRaw   = await call(orch, "get_latest_per_sender", { channel: telCh });
    const latestLines = latestRaw.trim().split("\n").filter(l => /^\[#\d+\]/.test(l));
    assert(latestLines.length === 2,
      `hb: get_latest_per_sender returns 2 rows (got ${latestLines.length})`);

    // Parse heartbeats
    let backendHb = null, frontendHb = null;
    for (const line of latestLines) {
      const m = line.match(/^\[#(\d+)\] \S+ <([^>]+)>: (.*)/);
      if (!m) continue;
      const hb = JSON.parse(m[3]);
      if (m[2] === "backend")  backendHb  = hb;
      if (m[2] === "frontend") frontendHb = hb;
    }
    assert(backendHb  !== null, "hb: backend heartbeat found");
    assert(frontendHb !== null, "hb: frontend heartbeat found");

    // Backend's latest heartbeat must be the 3rd (79.2), not a stale one
    assert(backendHb.context.tier_threshold_pct === 79.2,
      `hb: backend latest tier_threshold_pct=79.2 (stale ones deleted) (got ${backendHb?.context?.tier_threshold_pct})`);
    assert(frontendHb.context.tier_threshold_pct === 31.0,
      `hb: frontend tier_threshold_pct=31.0 (got ${frontendHb?.context?.tier_threshold_pct})`);

    // Orchestrator's rotation logic: flag workers above threshold
    const needsRotate = backendHb.context.tier_threshold_pct >= ROTATION_THRESHOLD;
    assert(needsRotate === true,  "hb: orchestrator correctly flags backend for rotation");
    assert(frontendHb.context.tier_threshold_pct < ROTATION_THRESHOLD,
      "hb: orchestrator correctly does NOT flag frontend for rotation");

    // Orchestrator broadcasts rotate on control channel
    await call(orch, "send_message", {
      channel: hbCtrl, sender: "orchestrator",
      content: JSON.stringify({
        type: "rotate", task_id: `hb-rotate-${RUN}`,
        from: "orchestrator", to: "backend",
        subject: `rotate — context at ${backendHb.context.tier_threshold_pct}%`,
      }),
    });

    // Worker's next turn_start detects rotate_requested=true
    const turn = JSON.parse(await call(wA, "turn_start", {
      inbox_channel:    hbInbox,
      control_channel:  hbCtrl,
      inbox_since_id:   0,
      control_since_id: 0,
    }));
    assert(turn.rotate_requested === true,
      "hb: turn_start.rotate_requested=true after orchestrator dispatches rotate");

    for (const c of [telCh, hbCtrl, hbInbox]) {
      await call(orch, "purge_channel", { channel: c });
    }
  }

  // ── 21. check_results_batch bulk idempotency ──────────────────────────────────
  // Orchestrator has dispatched 5 tasks; 2 already have results from a prior turn.
  // Worker calls check_results_batch at turn-start to bulk-check all 5 in one
  // round-trip, then processes only the 3 that aren't done.

  console.log("\n21. check_results_batch: bulk idempotency at turn-start");
  {
    const inbox  = ch("bidem-inbox");
    const status = ch("bidem-status");
    const tasks  = Array.from({ length: 5 }, (_, i) => tid(`bidem-t${i + 1}`));

    // Dispatch all 5 tasks to inbox
    for (let i = 0; i < 5; i++) {
      await dispatch(orch, inbox, {
        type: "task", task_id: tasks[i],
        from: "orchestrator", to: "alpha",
        subject: `batch idem task ${i + 1}`,
      });
    }

    // Pre-post results for tasks[0] and tasks[2] — simulates prior-turn work
    for (const idx of [0, 2]) {
      await call(orch, "send_message", {
        channel: status, sender: "alpha",
        content: JSON.stringify({
          type: "result", task_id: tasks[idx],
          from: "alpha", to: "orchestrator",
          subject: `batch idem task ${idx + 1}`,
          summary: "PASS — pre-done",
          affected_files: [`src/t${idx + 1}.ts`],
          body: { consent_basis: "orchestrator-dispatch-only" },
        }),
      });
    }

    // Worker bulk-checks all 5 at turn-start (one round-trip instead of 5)
    const batchRaw = await call(wA, "check_results_batch", { channel: status, task_ids: tasks });
    const batch    = JSON.parse(batchRaw);
    assert(batch.results[tasks[0]] === true,  "bidem: task 1 already done (pre-posted)");
    assert(batch.results[tasks[1]] === false, "bidem: task 2 not yet done");
    assert(batch.results[tasks[2]] === true,  "bidem: task 3 already done (pre-posted)");
    assert(batch.results[tasks[3]] === false, "bidem: task 4 not yet done");
    assert(batch.results[tasks[4]] === false, "bidem: task 5 not yet done");

    // Worker processes only the 3 not-done tasks (WorkerStub check_result guards the rest)
    const worker = new WorkerStub("alpha", inbox, ctrl, status, wA);
    worker.inboxNextId = 0;
    const processed = await worker.runTurn({
      [tasks[1]]: async () => ({ summary: "PASS — t2 done", affected_files: ["src/t2.ts"] }),
      [tasks[3]]: async () => ({ summary: "PASS — t4 done", affected_files: ["src/t4.ts"] }),
      [tasks[4]]: async () => ({ summary: "PASS — t5 done", affected_files: ["src/t5.ts"] }),
    });
    assert(processed === 3,
      `bidem: worker processed exactly 3 tasks (the 3 not pre-done) (got ${processed})`);

    // Final check: all 5 now have results
    const batchFinal = JSON.parse(await call(orch, "check_results_batch", { channel: status, task_ids: tasks }));
    const allDone    = tasks.every(t => batchFinal.results[t] === true);
    assert(allDone, "bidem: all 5 tasks have results after worker turn");

    await call(orch, "purge_channel", { channel: inbox  });
    await call(orch, "purge_channel", { channel: status });
  }

  // ── 22. Capability-based routing ──────────────────────────────────────────────
  // Workers register their owned capabilities at "startup". Orchestrator reads
  // list_capabilities to decide which worker to route a task to, dispatches to
  // the correct inbox, and deregisters workers at sprint end.

  console.log("\n22. Capability-based routing: workers declare ownership, orchestrator routes accordingly");
  {
    const inboxA   = ch("cap-inbox-a");
    const inboxB   = ch("cap-inbox-b");
    const status   = ch("cap-status");
    const workerBE = `cap-backend-${RUN}`;
    const workerFE = `cap-frontend-${RUN}`;

    // Workers register capabilities at startup
    await call(wA, "register_capability", {
      worker:   workerBE,
      owns:     ["payments", "DB migrations", "rate-limits"],
      channels: [inboxA, status],
    });
    await call(wB, "register_capability", {
      worker:   workerFE,
      owns:     ["dashboard", "UI components", "charts"],
      channels: [inboxB, status],
    });

    // Orchestrator reads registry to find who owns "DB migrations"
    const capsRaw = await call(orch, "list_capabilities", {});
    assert(capsRaw.includes(workerBE),        "cap: backend worker registered");
    assert(capsRaw.includes(workerFE),        "cap: frontend worker registered");
    assert(capsRaw.includes("DB migrations"), "cap: backend owns DB migrations");
    assert(capsRaw.includes("UI components"), "cap: frontend owns UI components");

    // Route "DB migration" to the worker that owns it
    const targetWorker = capsRaw.includes("DB migrations") && capsRaw.includes(workerBE)
      ? workerBE : null;
    assert(targetWorker === workerBE,
      "cap: orchestrator routes DB migration task to backend worker");

    const taskId = tid("cap-migration");
    await dispatch(orch, inboxA, {
      type: "task", task_id: taskId,
      from: "orchestrator", to: workerBE,
      subject: "run DB migration 0042_user_schema",
      body: "Apply migration using approved script.",
    });

    // Backend processes the task
    const backend = new WorkerStub(workerBE, inboxA, ctrl, status, wA);
    const nA = await backend.runTurn({
      [taskId]: async () => ({
        summary:        "PASS — migration applied",
        affected_files: ["db/migrations/0042_user_schema.sql"],
      }),
    });
    assert(nA === 1, `cap: backend processed the routed task (got ${nA})`);

    // Frontend inbox is empty — task was not routed there
    const frontend = new WorkerStub(workerFE, inboxB, ctrl, status, wB);
    const nB = await frontend.runTurn({ "*": async () => ({ summary: "PASS" }) });
    assert(nB === 0, "cap: frontend has nothing to process (task not routed there)");

    // Sprint end: deregister both workers
    await call(orch, "deregister_capability", { worker: workerBE });
    await call(orch, "deregister_capability", { worker: workerFE });

    const capsAfter = await call(orch, "list_capabilities", {});
    assert(!capsAfter.includes(workerBE), "cap: backend deregistered after sprint");
    assert(!capsAfter.includes(workerFE), "cap: frontend deregistered after sprint");

    await call(orch, "purge_channel", { channel: inboxA });
    await call(orch, "purge_channel", { channel: inboxB });
    await call(orch, "purge_channel", { channel: status });
  }

  // ── 23. Broker-side gate ──────────────────────────────────────────────────────
  // Orchestrator uses post_gated_message to hold a downstream task in the broker
  // until the upstream result appears on the status channel. Worker B's inbox is
  // empty until worker A finishes — then the gate fires and the downstream task
  // arrives.

  console.log("\n23. Broker-side gate: post_gated_message holds downstream task until upstream result exists");
  {
    const inboxA  = ch("gate-inbox-a");
    const inboxB  = ch("gate-inbox-b");
    const gStatus = ch("gate-status");
    const upTid   = tid("gate-upstream");
    const downTid = tid("gate-downstream");

    // Dispatch upstream task to worker A
    await dispatch(orch, inboxA, {
      type: "task", task_id: upTid,
      from: "orchestrator", to: "alpha",
      subject: "build payment library",
    });

    // Post gated downstream task: broker holds it until upstream result appears
    const gatePromise = call(orch, "post_gated_message", {
      channel:       inboxB,
      sender:        "orchestrator",
      content:       JSON.stringify({
        type: "task", task_id: downTid,
        from: "orchestrator", to: "beta",
        subject: "add payment UI (gated on payment library)",
        body: "Add checkout form using the payment library.",
      }),
      depends_on:    [upTid],
      watch_channel: gStatus,
      timeout_ms:    5000,
    });

    // Worker B inbox must be empty while gate is waiting
    await new Promise(r => setTimeout(r, 50));
    const earlyCheck = JSON.parse(await call(orch, "has_messages", { channel: inboxB, since_id: 0 }));
    assert(earlyCheck.pending === false,
      "broker-gate: worker B inbox empty before upstream result");

    // Worker A processes upstream task → posts result → gate fires
    const workerA = new WorkerStub("alpha", inboxA, ctrl, gStatus, wA);
    await workerA.runTurn({
      [upTid]: async () => ({
        summary:        "PASS — payment library built",
        affected_files: ["src/lib/payment.ts"],
      }),
    });

    // Gate must have resolved
    const gateResult = await gatePromise;
    assert(gateResult.includes("Sent #") || gateResult.includes("satisfied"),
      `broker-gate: gate resolved and downstream task posted (got: ${gateResult})`);
    assert(!gateResult.includes("Timed out"),
      "broker-gate: gate did not time out");

    // Worker B inbox now has the downstream task
    const lateCheck = JSON.parse(await call(orch, "has_messages", { channel: inboxB, since_id: 0 }));
    assert(lateCheck.pending === true,
      "broker-gate: worker B inbox has downstream task after upstream completes");

    // Worker B processes it
    const workerB = new WorkerStub("beta", inboxB, ctrl, gStatus, wB);
    const n = await workerB.runTurn({
      [downTid]: async () => ({
        summary:        "PASS — payment UI added",
        affected_files: ["src/components/checkout.tsx"],
      }),
    });
    assert(n === 1, `broker-gate: worker B processed the gated downstream task (got ${n})`);

    // Both results on status channel
    const upResult   = await readResult(orch, gStatus, upTid);
    const downResult = await readResult(orch, gStatus, downTid);
    assert(upResult.length   === 1, "broker-gate: upstream result on status");
    assert(downResult.length === 1, "broker-gate: downstream result on status");
    assert(downResult[0].summary?.startsWith("PASS"),
      "broker-gate: downstream result is PASS");

    for (const c of [inboxA, inboxB, gStatus]) {
      await call(orch, "purge_channel", { channel: c });
    }
  }

  // ── Cleanup test-created channels ──────────────────────────────────────────
  // List all channels and purge those created during this test run.
  console.log("\nCleaning up test-created channels...");
  try {
    const allChannelsRaw = await call(orch, "list_channels", {});
    // Parse the response to extract channel names
    const channelPattern = new RegExp(`^e2e-${RUN}-`);
    const createdChannels = allChannelsRaw
      .split("\n")
      .filter(line => line.trim())
      .map(line => {
        // Format: "channel-name (42 messages, latest #999)"
        const match = line.match(/^(\S+)\s+\(/);
        return match ? match[1] : null;
      })
      .filter(Boolean)
      .filter(ch => channelPattern.test(ch));

    if (createdChannels.length > 0) {
      console.log(`  Found ${createdChannels.length} test channels to purge`);
      for (const ch of createdChannels) {
        await call(orch, "purge_channel", { channel: ch });
      }
      console.log(`  Purged all test channels`);
    } else {
      console.log("  No orphan test channels found");
    }
  } catch (e) {
    console.error("  Error during channel cleanup:", e.message);
  }

  // ── Teardown ───────────────────────────────────────────────────────────────
  await tOrch.close();
  await twA.close();
  await twB.close();

  console.log(`\n${"─".repeat(54)}`);
  console.log(`  passed: ${passed}   failed: ${failed}`);
  console.log(failed === 0 ? "  ALL TESTS PASSED" : "  SOME TESTS FAILED");
  if (failed > 0) process.exit(1);
}

run().catch(e => { console.error(e); process.exit(1); });
