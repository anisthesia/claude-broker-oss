/**
 * test-setup-broker.js — test suite for /setup-broker slash command
 * 76 assertions across 8 sections.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
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
  const RUN    = Date.now();
  const PREFIX = `sb${RUN}`;
  console.log(`\n[test-setup-broker]  prefix=${PREFIX}  url=${BROKER_URL}\n`);

  const { client: a, transport: ta } = await connect("test-setup-broker");

  const REPO_COPY = `.claude/commands/setup-broker.md`;
  const USER_COPY = `${homedir()}/.claude/commands/setup-broker.md`;

  // ── 1. Command file existence ─────────────────────────────────────────────
  console.log("1. Command file existence");

  const repoContent = existsSync(REPO_COPY) ? readFileSync(REPO_COPY, "utf-8") : null;
  assert(
    repoContent !== null && repoContent.length > 5000,
    `repo copy exists and has length > 5000 chars (got ${repoContent?.length ?? 0})`,
  );

  const userContent = existsSync(USER_COPY) ? readFileSync(USER_COPY, "utf-8") : null;
  assert(
    userContent !== null && userContent === repoContent,
    "user copy content === repo copy content (files in sync)",
    userContent === null ? "user copy missing" : "content mismatch",
  );

  const content = repoContent ?? "";

  // ── 2. Bug-fix regressions ────────────────────────────────────────────────
  console.log("\n2. Bug-fix regressions");

  // 3
  assert(
    content.includes("process.env.BROKER_URL"),
    "schema script uses process.env.BROKER_URL (not hardcoded URL)",
  );

  // 4
  assert(
    content.includes("process.env.BROKER_SECRET || process.env.SHARED_SECRET"),
    "schema script has BROKER_SECRET || SHARED_SECRET fallback chain",
  );

  // 5
  assert(
    content.includes("BROKER_URL=<BROKER_URL> BROKER_SECRET=<BROKER_SECRET>"),
    "remote broker watchdog commands include BROKER_URL=<BROKER_URL>",
  );

  // 6
  assert(
    content.includes("If BROKER_URL is localhost or 127.0.0.1"),
    "Step 7 has local vs remote branch for watchdog commands",
  );

  // 7
  assert(
    /Merge logic|Merge, do not overwrite/.test(content),
    "settings.json merge behaviour documented",
  );

  // 8
  assert(
    !/"env"\s*:\s*\{/.test(content),
    'workers-broker.json template has no env block (no "env": { ... })',
  );

  // 9
  assert(
    content.includes("entries do not support an `env` block"),
    "note about missing env block support present",
  );

  // 10
  assert(
    content.includes("settings.local.json"),
    "remote broker routes to settings.local.json",
  );

  // 41 — PRUNE_EXEMPT update step present
  assert(
    content.includes("PRUNE_EXEMPT"),
    "command documents PRUNE_EXEMPT .env update (Step 5d)",
  );

  // 42 — backlog channel named in PRUNE_EXEMPT context
  assert(
    content.includes("<PREFIX>-backlog") && content.includes("PRUNE_EXEMPT"),
    "command names <PREFIX>-backlog in PRUNE_EXEMPT context",
  );

  // ── 3. Protocol completeness ──────────────────────────────────────────────
  console.log("\n3. Protocol completeness");

  // Orchestrator template coverage

  // 11
  assert(
    /[Tt]urn-start ritual/.test(content),
    "orchestrator: turn-start ritual documented",
  );

  // 12
  assert(
    /Sprint lifecycle|Sprint close/.test(content),
    "orchestrator: sprint lifecycle documented",
  );

  // 13
  assert(
    content.includes("approval-token"),
    "orchestrator: approval-token protocol present",
  );

  // 14
  assert(
    /Worker stop conditions|stop conditions/.test(content),
    "orchestrator: worker stop conditions table present",
  );

  // 15
  assert(
    /Liveness enforcement|liveness/.test(content),
    "orchestrator: liveness enforcement documented",
  );

  // 16
  assert(
    content.includes("purge_channel"),
    "orchestrator: purge_channel gate present",
  );

  // Worker template coverage

  // 17
  assert(
    /every 5 min|5-min|every ~5 min/.test(content),
    "worker: heartbeat cadence (every 5 min) specified",
  );

  // 18
  assert(
    content.includes("consent_basis"),
    "worker: consent_basis required field present",
  );

  // 19
  assert(
    content.includes("idle-loop exit"),
    "worker: idle-loop exit documented",
  );

  // 20
  assert(
    /context-rotation-before-idle-pickup|context rotation/.test(content),
    "worker: context rotation before idle pickup documented",
  );

  // 21
  assert(
    content.includes("depends_on"),
    "worker: depends_on dependency handling present",
  );

  // 22
  assert(
    content.includes("check_result"),
    "worker: check_result idempotency check present",
  );

  // ── 4. Schema template functional tests ──────────────────────────────────
  console.log("\n4. Schema template functional tests");

  function adaptSchema(filename, updates) {
    const schema = JSON.parse(readFileSync(`schemas/${filename}`, "utf-8"));
    if (updates.title)           schema.title = updates.title;
    if (updates.description)     schema.description = updates.description;
    if (updates.taskIdPattern && schema.properties?.task_id?.pattern) {
      schema.properties.task_id.pattern = updates.taskIdPattern;
    }
    if (updates.fromDescription && schema.properties?.from) {
      schema.properties.from.description = updates.fromDescription;
    }
    if (updates.toDescription && schema.properties?.to) {
      schema.properties.to.description = updates.toDescription;
    }
    return JSON.stringify(schema);
  }

  const workerInboxSchema = adaptSchema("cb-worker-inbox.json", {
    title: `${PREFIX} worker-inbox envelope`,
    description: `Worker inbox messages for test project ${PREFIX}.`,
    taskIdPattern: `^${PREFIX}-[0-9]{4}-[0-9]{2}-[0-9]{2}-.+`,
    fromDescription: "Dispatcher identity: 'orchestrator'.",
    toDescription: `Target worker: one of the ${PREFIX} project workers, or '*' for broadcast.`,
  });
  const orchInboxSchema = adaptSchema("cb-orchestrator-inbox.json", {
    title: `${PREFIX} orchestrator-inbox envelope`,
    description: `Orchestrator inbox messages for test project ${PREFIX}.`,
  });
  const statusSchema = adaptSchema("cb-status.json", {
    title: `${PREFIX} status envelope`,
    description: `Status firehose for test project ${PREFIX}.`,
  });
  const controlSchema = adaptSchema("cb-control.json", {
    title: `${PREFIX} control broadcast envelope`,
    description: `Control broadcasts for test project ${PREFIX}.`,
  });
  const telemetrySchema = adaptSchema("cb-telemetry.json", {
    title: `${PREFIX} telemetry heartbeat envelope`,
    description: `Worker heartbeats for test project ${PREFIX}.`,
  });
  const backlogSchema = adaptSchema("cb-backlog.json", {
    title: `${PREFIX} backlog envelope`,
    description: `Persistent deferred task register for ${PREFIX} namespace.`,
  });

  const channels = [
    { channel: `${PREFIX}-orchestrator`, schema: orchInboxSchema  },
    { channel: `${PREFIX}-control`,      schema: controlSchema    },
    { channel: `${PREFIX}-status`,       schema: statusSchema     },
    { channel: `${PREFIX}-telemetry`,    schema: telemetrySchema  },
    { channel: `${PREFIX}-backlog`,      schema: backlogSchema    },
    { channel: `${PREFIX}-api`,          schema: workerInboxSchema },
  ];

  // 23 — all 6 register calls succeed
  let regSucceeded = 0;
  for (const { channel, schema } of channels) {
    const r = await a.callTool({ name: "register_channel_schema", arguments: { channel, schema, strict: false, version: "1.0" } });
    if (!r.isError && /Registered schema/.test(r.content[0].text)) regSucceeded++;
  }
  assert(regSucceeded === 6, `all 6 register_channel_schema calls return without error (got ${regSucceeded}/6)`);

  // 24 — list_channel_schemas includes all 6 channels
  const listSchemas = await call(a, "list_channel_schemas", {});
  const allPresent = channels.every(({ channel }) => listSchemas.includes(channel));
  assert(allPresent, `list_channel_schemas includes all 6 ${PREFIX}-* channels`);

  // Send valid worker-inbox message to sb${RUN}-api
  const validTaskId  = `${PREFIX}-2026-06-21-test`;
  const validTaskMsg = JSON.stringify({
    type: "task",
    task_id: validTaskId,
    from: "orchestrator",
    to: "api",
    subject: "test task",
    body: "test",
  });
  const sendRes25 = await call(a, "send_message", {
    channel: `${PREFIX}-api`,
    sender: "orchestrator",
    content: validTaskMsg,
  });

  // 25 — returns message id, no WARN
  assert(
    /Sent #\d+/.test(sendRes25) && !/WARN/.test(sendRes25),
    "send valid task to worker inbox: returns message id, no WARN",
    sendRes25,
  );

  // 26 — read_messages returns the message
  const readRes26 = await call(a, "read_messages", { channel: `${PREFIX}-api`, since_id: 0 });
  assert(readRes26.includes(validTaskId), "read_messages returns the posted task");

  // 27 — message content parses correctly
  // read_messages format: "[#ID] TIMESTAMP <SENDER>: JSON_CONTENT"
  let parsed27 = null;
  try {
    const firstLine = readRes26.trim().split("\n")[0];
    const jsonStart = firstLine.indexOf("{");
    if (jsonStart >= 0) parsed27 = JSON.parse(firstLine.slice(jsonStart));
  } catch (e) {}
  assert(parsed27?.type === "task", "message content parses correctly (type === 'task')", `parsed: ${JSON.stringify(parsed27)}`);

  // Send valid status result to sb${RUN}-status
  const validStatusMsg = JSON.stringify({
    type: "result",
    task_id: validTaskId,
    from: "api",
    to: "orchestrator",
    subject: "test result",
    summary: "PASS — test",
  });
  const sendRes28 = await call(a, "send_message", {
    channel: `${PREFIX}-status`,
    sender: "api",
    content: validStatusMsg,
  });

  // 28 — send_message succeeds without WARN
  assert(/Sent #\d+/.test(sendRes28) && !/WARN/.test(sendRes28), "send valid result to status channel: succeeds without WARN", sendRes28);

  // 29 — read_messages returns it
  const readRes29 = await call(a, "read_messages", { channel: `${PREFIX}-status`, since_id: 0 });
  assert(readRes29.includes("PASS — test"), "read_messages from status channel returns posted result");

  // Send invalid message (missing required task_id) to sb${RUN}-api
  const invalidMsg = JSON.stringify({
    type: "task",
    from: "orchestrator",
    to: "api",
    subject: "bad",
  });
  const sendRes30 = await call(a, "send_message", {
    channel: `${PREFIX}-api`,
    sender: "orchestrator",
    content: invalidMsg,
  });

  // 30 — accepted in warn-only mode
  assert(/Sent #\d+/.test(sendRes30), "invalid message (missing task_id) accepted in warn-only mode", sendRes30);

  // 31 — response includes WARN
  assert(/WARN/.test(sendRes30), "invalid message response includes WARN schema mismatch text", sendRes30);

  // Send wrong-prefix task_id to sb${RUN}-api
  const wrongPrefixMsg = JSON.stringify({
    type: "task",
    task_id: "cb-2026-06-21-wrong-prefix",
    from: "orchestrator",
    to: "api",
    subject: "wrong prefix test",
    body: "test",
  });
  const sendRes32 = await call(a, "send_message", {
    channel: `${PREFIX}-api`,
    sender: "orchestrator",
    content: wrongPrefixMsg,
  });

  // 32 — accepted (warn-only)
  assert(/Sent #\d+/.test(sendRes32), "wrong-prefix task_id accepted in warn-only mode", sendRes32);

  // 33 — response includes WARN (pattern mismatch)
  assert(/WARN/.test(sendRes32), "wrong-prefix task_id response includes WARN schema mismatch", sendRes32);

  // Send correct-prefix task_id to sb${RUN}-api
  const correctPrefixMsg = JSON.stringify({
    type: "task",
    task_id: `${PREFIX}-2026-06-21-correct`,
    from: "orchestrator",
    to: "api",
    subject: "correct prefix",
    body: "test",
  });
  const sendRes34 = await call(a, "send_message", {
    channel: `${PREFIX}-api`,
    sender: "orchestrator",
    content: correctPrefixMsg,
  });

  // 34 — accepted
  assert(/Sent #\d+/.test(sendRes34), "correct-prefix task_id accepted", sendRes34);

  // 35 — response does NOT include WARN
  assert(!/WARN/.test(sendRes34), "correct-prefix task_id response does NOT include WARN", sendRes34);

  // Send wrong type ("result" not in worker-inbox enum) to sb${RUN}-api
  const wrongTypeMsg = JSON.stringify({
    type: "result",
    task_id: `${PREFIX}-2026-06-21-wrong-type`,
    from: "api",
    to: "orchestrator",
    subject: "wrong type test",
    summary: "PASS — test",
  });
  const sendRes39 = await call(a, "send_message", {
    channel: `${PREFIX}-api`,
    sender: "api",
    content: wrongTypeMsg,
  });

  // 39 — accepted (warn-only)
  assert(/Sent #\d+/.test(sendRes39), "wrong type ('result') to worker inbox accepted in warn-only mode", sendRes39);

  // 40 — response includes WARN (type not in allowed enum)
  assert(/WARN/.test(sendRes39), "wrong type response includes WARN schema mismatch (enum violation)", sendRes39);

  // Clear all 6 channel schemas
  let clearSucceeded = 0;
  for (const { channel } of channels) {
    const r = await a.callTool({ name: "clear_channel_schema", arguments: { channel } });
    if (!r.isError) clearSucceeded++;
  }

  // 36 — all 6 clear calls succeed
  assert(clearSucceeded === 6, `all 6 clear_channel_schema calls succeed (got ${clearSucceeded}/6)`);

  // 37 — list_channel_schemas no longer shows any sb${RUN}-* entries
  const listAfterClear = await call(a, "list_channel_schemas", {});
  const nonePresent = channels.every(
    ({ channel }) => !listAfterClear.split("\n").some(l => l.startsWith(channel + "\t")),
  );
  assert(nonePresent, `list_channel_schemas no longer includes any ${PREFIX}-* entries`);

  // ── Cleanup ───────────────────────────────────────────────────────────────
  const purgeRaw = await call(a, "purge_channels_by_prefix", { prefix: PREFIX });
  let purgeResult;
  try { purgeResult = JSON.parse(purgeRaw.match(/\{[\s\S]*\}/)?.[0] ?? "{}"); } catch (e) { purgeResult = {}; }

  // 38 — purge sb${RUN}-* channels in afterAll
  assert(
    typeof purgeResult.total_deleted === "number",
    `afterAll: purge_channels_by_prefix(${PREFIX}) returns valid result`,
    purgeRaw,
  );

  // 43 — purge actually emptied the channels (has_messages returns pending:false)
  const hasAfterPurge = await call(a, "has_messages", { channel: `${PREFIX}-api`, since_id: 0 });
  let hasParsed = {};
  try { hasParsed = JSON.parse(hasAfterPurge); } catch (e) {}
  assert(
    hasParsed.pending === false,
    `afterAll: ${PREFIX}-api is empty after purge`,
    hasAfterPurge,
  );

  await ta.close();

  // ── 5. Git management ────────────────────────────────────────────────────────
  console.log("\n5. Git management");

  // 44 — git repo check present
  assert(
    content.includes(".git") && (content.includes("git repo exists") || content.includes("no git repo")),
    "Step 2.5: .git existence check present",
  );

  // 45 — git init instruction present
  assert(
    content.includes("git init"),
    "Step 2.5: git init instruction present",
  );

  // 46 — .gitignore check present
  assert(
    content.includes(".gitignore"),
    "Step 2.5: .gitignore check present",
  );

  // 47 — settings.local.json added to .gitignore
  assert(
    content.includes(".claude/settings.local.json") && content.includes(".gitignore"),
    "Step 2.5: .claude/settings.local.json added to .gitignore",
  );

  // 48 — target project git commit step present
  assert(
    content.includes("git add orchestrators/ workers/") &&
    content.includes("scaffold broker-worker arrangement via /setup-broker"),
    "Step 4d: git commit of generated target project files present",
  );

  // 49 — broker repo git commit step present
  assert(
    content.includes("git add schemas/<PREFIX>-*.json") &&
    content.includes("add <PREFIX> project schemas and worker config"),
    "Step 5e: git commit of broker repo changes present",
  );

  // 50 — verification checklist updated with git items
  assert(
    content.includes("Target project files committed to git") ||
    content.includes("committed to git"),
    "Verification checklist includes git commit items",
  );

  // 51 — Step 5c has name-collision guard for workers-broker.json
  assert(
    content.includes("all entries already present, skipped"),
    "Step 5c: workers-broker.json name-collision guard present",
  );

  // 52 — Step 5d has duplicate guard for PRUNE_EXEMPT
  assert(
    content.includes("already contains <PREFIX>-backlog, skipped"),
    "Step 5d: PRUNE_EXEMPT duplicate guard present",
  );

  // 53 — Step 5c detects WORKERS_CONFIG from broker .env
  assert(
    content.includes("WORKERS_CONFIG"),
    "Step 5c: detects WORKERS_CONFIG path from broker .env",
  );

  // 54 — orchestrator template liveness enforcement section includes filter_type
  assert(
    content.includes("filter_type") && /[Ll]iveness enforcement/.test(content),
    "Liveness enforcement section: filter_type=result documented",
  );

  // ── 6. Code-reviewer worker ───────────────────────────────────────────────
  console.log("\n6. Code-reviewer worker");

  // 55 — Step 4c.1: code-reviewer CLAUDE.md generation step present
  assert(
    content.includes("code-reviewer"),
    "Step 4c.1: code-reviewer generation step present",
  );

  // 56 — reviewer template includes all three verdict values
  assert(
    content.includes('"approve"') && content.includes('"block"') && content.includes('"advise"'),
    "Reviewer template: all three verdict values present (approve/block/advise)",
  );

  // 57 — reviewer template includes default checklist items
  assert(
    content.includes("Secrets") && content.includes("File ownership"),
    "Reviewer template: default checklist includes Secrets and File ownership",
  );

  // 58 — reviewer is read-only
  assert(
    content.includes("read-only") || content.includes("do NOT write code"),
    "Reviewer template: read-only constraint documented",
  );

  // 59 — <PREFIX>-reviewer channel in setup-schemas REGISTRATIONS
  assert(
    content.includes("<PREFIX>-reviewer") && content.includes("schemas/<PREFIX>-worker-inbox.json"),
    "Step 5b: <PREFIX>-reviewer channel in setup-schemas REGISTRATIONS",
  );

  // 60 — reviewer entry in WORKERS_CONFIG template
  assert(
    content.includes('"name": "<PREFIX>-reviewer"'),
    "Step 5c: reviewer entry present in WORKERS_CONFIG template",
  );

  // 61 — orchestrator sprint-close section has review gate
  assert(
    content.includes("Sprint close review"),
    "Orchestrator sprint-close: review gate present (Sprint close review task)",
  );

  // 62 — orchestrator waits for reviewer result using filter_type=result
  assert(
    content.includes('filter_type="result"') && content.includes("reviewer"),
    "Orchestrator sprint-close: filter_type=result used when waiting for reviewer result",
  );

  // 63 — verification checklist includes reviewer CLAUDE.md item
  assert(
    content.includes("code-reviewer/CLAUDE.md"),
    "Verification checklist: code-reviewer/CLAUDE.md item present",
  );

  // ── 7. Multi-repo support ─────────────────────────────────────────────────
  console.log("\n7. Multi-repo support");

  // 64 — monorepo/multi-repo question present
  assert(
    /[Mm]onorepo.*[Mm]ulti-repo|[Mm]ulti-repo.*[Mm]onorepo|monorepo or.*separate/i.test(content),
    "Step 1: monorepo vs multi-repo question present",
  );

  // 65 — WORKER_REPOS or per-worker repo collection documented
  assert(
    /WORKER_REPOS|per-worker repo|each.*repo path/i.test(content),
    "Multi-repo: per-worker repo path collection documented (WORKER_REPOS)",
  );

  // 66 — ORCH_REPO / orchestrator placement question documented
  assert(
    /ORCH_REPO|orchestrator.*repo|hosts.*orchestrator/i.test(content),
    "Multi-repo: orchestrator repo placement documented (ORCH_REPO)",
  );

  // 67 — multi-repo git preflight loops over per-worker repos
  assert(
    /multi-repo.*\.git|WORKER_REPOS.*git|each.*repo.*\.git|loop.*repo/i.test(content),
    "Step 2.5: multi-repo git preflight loops over per-worker repos",
  );

  // 68 — multi-repo: settings.json placed in each component repo
  assert(
    /each.*repo.*settings\.json|settings\.json.*each.*repo|per.*repo.*settings/i.test(content),
    "Multi-repo: settings.json placed in each component repo",
  );

  // 69 — multi-repo: worker CLAUDE.md in per-worker repo
  assert(
    /WORKER_REPOS\[|WORKER_REPOS\[worker\].*CLAUDE|per-worker.*CLAUDE\.md/i.test(content),
    "Multi-repo: worker CLAUDE.md created in WORKER_REPOS[worker] path",
  );

  // 70 — multi-repo: --repo-root per-worker in workers config
  assert(
    /WORKER_REPOS.*repo-root|repo-root.*WORKER_REPOS|per-worker.*--repo-root/i.test(content),
    "Step 5c: multi-repo uses per-worker --repo-root in workers config entries",
  );

  // 71 — multi-repo: Step 4d commit loops over component repos
  assert(
    /cd.*ORCH_REPO|ORCH_REPO.*commit|each.*repo.*commit.*multi-repo/i.test(content),
    "Step 4d: multi-repo commits in each component repo separately",
  );

  // 72 — verification checklist has multi-repo items
  assert(
    /Multi-repo.*applicable|Multi-repo.*settings\.json|Multi-repo.*repo-root/i.test(content),
    "Verification checklist: multi-repo items present",
  );

  // ── 8. Branch safety guards ───────────────────────────────────────────────────
  console.log("\n8. Branch safety guards");

  // 73 — branch checkout step present in turn-start ritual
  assert(
    /git.*checkout.*worker.*WORKER|checkout.*worker.*{{WORKER}}/i.test(content),
    "Worker turn-start: git checkout worker/{{WORKER}} step present",
  );

  // 74 — branch verification after checkout
  assert(
    /branch --show-current.*worker.*WORKER|branch.*show-current.*WORKER/i.test(content),
    "Worker turn-start: git branch --show-current verification present",
  );

  // 75 — branch assertion before commit
  assert(
    /branch.*show-current.*commit|Verify branch before.*commit|before.*commit.*branch/i.test(content),
    "Worker commit protocol: branch verification before staging present",
  );

  // 76 — verification checklist includes branch safety item
  assert(
    /branch safety guard|branch.*safety.*check/i.test(content),
    "Verification checklist: branch safety guards item present",
  );

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
