/**
 * test-setup-broker.js — test suite for /setup-broker slash command
 * 76 assertions across 8 sections, plus section 9: setup.js v3 templates, the knowledge-file cold start and the
 * --judge / --retro roles (run in a temp dir; the schema mapping needs the scratch broker from run-tests.js).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, realpathSync } from "fs";
import { homedir, tmpdir } from "os";
import { join, resolve } from "path";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { allTools, toolsOutsideProfile } from "./migrate-mcp-v3.mjs";
import Ajv from "ajv";
import { notesJudgmentGuard } from "./test-notes-judgment.js";
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
  // Environment-dependent: ~/.claude/commands is per-machine, so a stale or absent
  // user copy is logged as a skip rather than failing the gate.
  if (userContent !== null && userContent === repoContent) {
    assert(true, "user copy content === repo copy content (files in sync)");
  } else {
    console.log(`  - SKIP user copy content === repo copy content: ${userContent === null ? "user copy missing" : "user copy differs from repo copy (environment-dependent)"}`);
  }

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
    scope: "small",
    acceptance_criteria: ["done"],
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
    scope: "small",
    acceptance_criteria: ["done"],
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

  // ── 9. setup.js v3 templates + .mcp.json identity ─────────────────────────
  console.log("\n9. setup.js v3 role templates and .mcp.json identity");
  setupV3Templates();
  await judgeRetroSchemas(RUN);
  await notesJudgmentGuard({ RUN, BROKER_URL, SECRET, assert });

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

// Runs setup.js non-interactively against fixture projects in a temp dir (its .env, workers.json
// and roles/ land in the temp cwd, never in this repo) and checks the generated role files and
// .mcp.json. No broker needed: --no-schemas.
function setupV3Templates() {
  const T = mkdtempSync(join(tmpdir(), "setup-v3-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(WATCHDOG_|BROKER_|WORKERS_CONFIG)/.test(k)));
  const setup = (cwd, args) => {
    mkdirSync(cwd, { recursive: true });
    return spawnSync(process.execPath, [resolve("setup.js"), "--yes", "--no-schemas", "--no-tmux", "--port", "18999", ...args], { cwd, env, encoding: "utf8" });
  };
  const tools = allTools();
  try {
    // Plain project: two components, reviewer, a patrol worker.
    const proj = join(T, "proj");
    for (const c of ["backend", "frontend"]) { mkdirSync(join(proj, c), { recursive: true }); writeFileSync(join(proj, c, "package.json"), "{}"); }
    spawnSync("git", ["-C", proj, "init", "-q"]);
    const r = setup(join(T, "out"), ["--project", proj, "--ns", "ab", "--scaffold-roles", "--mcp-settings", "--patrol", "qa:600"]);
    assert(r.status === 0, "setup.js --yes --scaffold-roles --mcp-settings exits 0", (r.stderr || r.stdout).slice(-300));
    const role = (f) => readFileSync(join(T, "out", "roles", f), "utf8");
    const url = JSON.parse(readFileSync(join(proj, ".mcp.json"), "utf8")).mcpServers.broker.url;
    assert(url === "http://localhost:18999/mcp?role=orchestrator&ns=ab", `project .mcp.json: role=orchestrator&ns=, no as= (${url})`);

    const orch = role("orchestrator.md"), be = role("backend.md"), rev = role("reviewer.md"), qa = role("qa.md");
    for (const [name, text] of [["orchestrator", orch], ["backend", be], ["reviewer", rev], ["qa", qa]]) {
      assert(text.includes("## Broker v3 — typed tools first") && /\*\*Fallback:\*\*.*`send_message`/s.test(text), `${name}.md: v3 section with the send_message fallback`);
    }
    assert(/dispatch_task\(sender="orchestrator"/.test(orch) && /get_task_ledger\(/.test(orch) && /open_questions\(prefix="ab-"\)/.test(orch), "orchestrator.md teaches dispatch_task / get_task_ledger / open_questions");
    assert(/mcp\?role=orchestrator&ns=ab`/.test(orch) && /pass `sender="orchestrator"` on every write/.test(orch), "orchestrator.md: interactive URL without as=, sender= on every write");
    assert(/post_result\(task_id, summary="PASS — …", affected_files/.test(be) && /ask\(task_id, question\)/.test(be) && /post_note\(kind="finding"/.test(be), "backend.md teaches post_result / ask / post_note");
    assert(/role=worker&ns=ab&as=backend/.test(be), "backend.md: headless URL role=worker&ns=&as=backend");
    assert(/summary="APPROVE — /.test(rev) && /BLOCK — /.test(rev) && /role=reviewer&ns=ab&as=reviewer/.test(rev), "reviewer.md teaches APPROVE|ADVISE|BLOCK verdicts, role=reviewer URL");
    assert(/post_result\(task_id="qa-patrol-<YYYY-MM-DD-HHmm>", subject="qa patrol"/.test(qa), "patrol: post_result with an explicit subject (no dispatched task)");

    // Every tool a template names must be in its role's profile — except the orchestrator's
    // explicit "not in the orchestrator profile" line.
    const NOT_IN_ORCH = ["register_channel_schema", "register_namespace", "purge_channels_by_prefix"];
    const outside = (text, r) => toolsOutsideProfile(text, r, tools);
    assert(outside(orch, "orchestrator").every((t) => NOT_IN_ORCH.includes(t)), `orchestrator.md names only orchestrator-profile tools (+ the not-available line): ${outside(orch, "orchestrator").join(", ") || "none"}`);
    for (const [name, text, r] of [["backend", be, "worker"], ["reviewer", rev, "reviewer"], ["qa", qa, "worker"]]) {
      assert(outside(text, r).length === 0, `${name}.md names only ${r}-profile tools`, outside(text, r).join(", "));
    }

    // Clustered: workers report on the cluster feed, so post_result/ask (which go to <ns>-status) are not taught.
    const proj2 = join(T, "proj2");
    for (const c of ["backend", "frontend"]) { mkdirSync(join(proj2, c), { recursive: true }); writeFileSync(join(proj2, c, "package.json"), "{}"); }
    const r2 = setup(join(T, "out2"), ["--project", proj2, "--ns", "cd", "--scaffold-roles", "--no-mcp-settings", "--clusters", "core:backend+frontend"]);
    assert(r2.status === 0, "setup.js --clusters exits 0", (r2.stderr || r2.stdout).slice(-300));
    const cbe = readFileSync(join(T, "out2", "roles", "backend.md"), "utf8");
    const corch = readFileSync(join(T, "out2", "roles", "core-orch.md"), "utf8");
    assert(/keep `send_message` for both/.test(cbe) && !/ask\(task_id, question\)/.test(cbe), "clustered worker: results/questions stay on send_message to the cluster feed");
    assert(/role=orchestrator&ns=cd&as=core-orch/.test(corch) && /dispatch_task\(to,/.test(corch) && outside(corch, "orchestrator").length === 0, "cluster orchestrator: headless orchestrator URL, dispatch_task, in-profile tools only");
    assert(/claude mcp add -s local --transport http broker "http:\/\/localhost:18999\/mcp\?role=orchestrator&ns=cd"/.test(r2.stdout), "no .mcp.json: printed connect command carries role=orchestrator&ns=");

    // Cold start reads the retro knowledge file first when the namespace has one (docs/knowledge/<ns>.md).
    const oldStep = `2. \`read_messages(channel="ab-notes", since_id=0, projection="summary")\` — team knowledge. Open in
   full only the notes whose \`to\` is you or \`*\` and whose \`scope\` overlaps the files you are about
   to touch; ignore ones closed by a later \`type: resolved\` or past their \`expires_at\`.`;
    assert(be.includes(oldStep) && !/docs\/knowledge/.test(be), "no knowledge file for ab: cold-start notes scan unchanged (since_id=0)");
    const kdir = join(T, "knowledge");
    mkdirSync(kdir, { recursive: true });
    const emptyEnv = { ...env, BROKER_KNOWLEDGE_DIR: kdir };
    const rE = spawnSync(process.execPath, [resolve("setup.js"), "--yes", "--no-schemas", "--no-tmux", "--port", "18999", "--project", proj, "--ns", "ab", "--scaffold-roles", "--no-mcp-settings", "--patrol", "qa:600"],
      { cwd: (mkdirSync(join(T, "outE"), { recursive: true }), join(T, "outE")), env: emptyEnv, encoding: "utf8" });
    const beE = readFileSync(join(T, "outE", "roles", "backend.md"), "utf8");
    assert(rE.status === 0 && beE === be, "knowledge dir without ab.md: backend.md byte-identical to the default output");
    writeFileSync(join(kdir, "ab.md"), "<!-- retro ns=ab last_id=4242 generated=2026-10-29T00:00:00.000Z -->\n# ab knowledge\n");
    const rK = spawnSync(process.execPath, [resolve("setup.js"), "--yes", "--no-schemas", "--no-tmux", "--port", "18999", "--project", proj, "--ns", "ab", "--scaffold-roles", "--no-mcp-settings", "--patrol", "qa:600"],
      { cwd: (mkdirSync(join(T, "outK"), { recursive: true }), join(T, "outK")), env: emptyEnv, encoding: "utf8" });
    const beK = readFileSync(join(T, "outK", "roles", "backend.md"), "utf8");
    const kStep = beK.slice(beK.indexOf("2. Read `"), beK.indexOf("## Turn-start ritual"));
    assert(rK.status === 0 && kStep.startsWith(`2. Read \`${join(kdir, "ab.md")}\``) && kStep.indexOf("ab.md") < kStep.indexOf('read_messages(channel="ab-notes", since_id=<N>, projection="summary")'),
      "with docs/knowledge/ab.md: cold start reads the file first, then tails ab-notes from its last_id", kStep);
    assert(/If the file is missing or has no `last_id`, use `since_id=0`/.test(kStep), "knowledge step keeps the since_id=0 fallback");
    assert(be.replace(oldStep, kStep.trimEnd()).replace(/\n+## Turn-start/, "\n\n## Turn-start") === beK.replace(/\n+## Turn-start/, "\n\n## Turn-start"), "only the cold-start notes step differs between the two outputs");

    // An existing .mcp.json: other servers and extra query params survive a re-run.
    writeFileSync(join(proj, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" }, broker: { type: "http", url: "http://localhost:1/mcp?trace=1" } } }));
    const r3 = setup(join(T, "out"), ["--project", proj, "--ns", "ab", "--mcp-settings"]);
    const cfg = JSON.parse(readFileSync(join(proj, ".mcp.json"), "utf8"));
    assert(r3.status === 0 && cfg.mcpServers.other?.command === "x" && cfg.mcpServers.broker.url === "http://localhost:18999/mcp?role=orchestrator&ns=ab&trace=1", `re-run keeps other servers and extra query params (${cfg.mcpServers.broker.url})`);

    judgeRetroTemplates({ T, env, tools, outside, NOT_IN_ORCH });
  } finally {
    rmSync(T, { recursive: true, force: true });
  }
}

// --judge full|hold and --retro: role files, the orchestrator's extra lines, workers.json entries, and a
// default run that has none of them. The cb render is held against workers/{judge,retro}/CLAUDE.md so
// an edit to either cb role file fails here until the setup.js template follows.
const DEFAULT_ROLES_SHA = "9da5b6ca8e480da9"; // roles/ of the default ab render, normalized as in judgeRetroTemplates
function judgeRetroTemplates({ T, env, tools, outside, NOT_IN_ORCH }) {
  const kdir = join(T, "jr-knowledge");
  mkdirSync(kdir, { recursive: true });
  const jenv = { ...env, BROKER_KNOWLEDGE_DIR: kdir };
  // Every run names the broker DB explicitly (BROKER_DB_PATH) so the retro template never depends on this checkout's .env.
  const DB = join(T, "the-broker", "broker.db");
  const run = (out, proj, args, extraEnv = { BROKER_DB_PATH: DB }) => {
    mkdirSync(join(T, out), { recursive: true });
    const r = spawnSync(process.execPath, [resolve("setup.js"), "--yes", "--no-schemas", "--no-tmux", "--port", "18999", "--project", proj, "--scaffold-roles", "--no-mcp-settings", ...args],
      { cwd: join(T, out), env: { ...jenv, ...extraEnv }, encoding: "utf8" });
    return { ...r, dir: realpathSync(join(T, out)) };
  };
  const read = (r, f) => readFileSync(join(r.dir, f), "utf8");
  const proj = join(T, "jr-proj");
  for (const c of ["backend", "frontend"]) { mkdirSync(join(proj, c), { recursive: true }); writeFileSync(join(proj, c, "package.json"), "{}"); }

  const base = run("jr-default", proj, ["--ns", "ab", "--patrol", "qa:600"]);
  const full = run("jr-full", proj, ["--ns", "ab", "--patrol", "qa:600", "--judge", "full", "--retro"]);
  const hold = run("jr-hold", proj, ["--ns", "ab", "--patrol", "qa:600", "--judge", "hold"]);
  assert(base.status === 0 && full.status === 0 && hold.status === 0, "setup.js default / --judge full --retro / --judge hold exit 0", [base, full, hold].map((r) => (r.stderr || "").slice(-200)).join(" | "));

  // Default output carries nothing of either; with the flags only judge.md / retro.md are new, every
  // other worker role is byte-identical and orchestrator.md differs only by the added step and section.
  const baseRoles = readdirSync(join(base.dir, "roles")).sort();
  const fullRoles = readdirSync(join(full.dir, "roles")).sort();
  const baseText = baseRoles.map((f) => read(base, join("roles", f))).join("\n") + read(base, "workers.json") + base.stdout;
  assert(!baseRoles.includes("judge.md") && !baseRoles.includes("retro.md") && !/\bjudge\b|-retro\b/.test(baseText), "default run: no judge.md / retro.md and no judge / -retro anywhere in its output");
  // Byte-identical to the render before the judge/retro fixes (cb-2026-10-30-judge-retro-template-fixes): the roles/
  // files with this run's temp dirs, checkout and Node path put back to placeholders. An intended change to a default
  // template changes this hash: re-derive it from the new render and say so in the commit.
  const norm = (t) => t.replaceAll(base.dir, "<OUT>").replaceAll(realpathSync(T), "<T>").replaceAll(T, "<T>").replaceAll(resolve("."), "<SCRIPT_DIR>")
    .replaceAll(process.execPath, "<NODE>").replaceAll(homedir(), "<HOME>");
  const baseHash = createHash("sha256").update(baseRoles.map((f) => `${f}\n${norm(read(base, join("roles", f)))}`).join("\0")).digest("hex").slice(0, 16);
  assert(baseHash === DEFAULT_ROLES_SHA, `default run: roles/ byte-identical to the pre-change render (sha ${baseHash}, want ${DEFAULT_ROLES_SHA})`);
  assert(JSON.stringify(fullRoles) === JSON.stringify([...baseRoles, "judge.md", "retro.md"].sort()), `--judge --retro adds exactly judge.md and retro.md (${fullRoles.join(", ")})`);
  const sameRoles = baseRoles.filter((f) => f !== "orchestrator.md" && read(base, join("roles", f)) !== read(full, join("roles", f)));
  assert(sameRoles.length === 0, "every worker role common to both runs is byte-identical", sameRoles.join(", "));
  const orchBase = read(base, "roles/orchestrator.md"), orchFull = read(full, "roles/orchestrator.md"), orchHold = read(hold, "roles/orchestrator.md");
  const stripAdded = (t) => t.replace(/8\. Held judgments:[\s\S]*?\n(?=\n## Dispatching a task)/, "").replace(/\n## Weekly retro\n[\s\S]*?(?=\n## Collecting results)/, "");
  assert(stripAdded(orchFull) === orchBase && stripAdded(orchHold) === orchBase && orchFull !== orchBase, "orchestrator.md: only the judge step and retro section are added");
  assert(/read_messages\(channel="ab-notes", filter_type="judgment", projection="summary"\)/.test(orchFull) && /Answer\s+each `held` row/.test(orchFull), "orchestrator.md (--judge full): turn-start step reads held judgments and answers them");
  assert(/runs hold-only in this namespace: it never answers, so every blocked question still\s+needs you or the human/.test(orchHold), "orchestrator.md (--judge hold): says the judge never answers");
  const retroDispatch = orchFull.slice(orchFull.indexOf("## Weekly retro"), orchFull.indexOf("## Collecting results"));
  assert(/dispatch_task\(sender="orchestrator", to="retro"/.test(retroDispatch) && /scope="small"/.test(retroDispatch) && /acceptance_criteria=\[/.test(retroDispatch) && !/checks=/.test(retroDispatch), "orchestrator.md (--retro): weekly dispatch has scope + acceptance_criteria and no checks", retroDispatch);
  assert(retroDispatch.includes(`commit \`${join(kdir, "ab.md")}\` yourself`) && /review the proposed\s+role-file edits/.test(retroDispatch), "orchestrator.md (--retro): orchestrator commits the knowledge file and reviews the proposals");
  assert(outside(orchFull, "orchestrator").every((t) => NOT_IN_ORCH.includes(t)), `orchestrator.md with --judge --retro names only orchestrator-profile tools: ${outside(orchFull, "orchestrator").join(", ") || "none"}`);

  // judge.md (full + hold) and retro.md for ns "ab": substituted, worker-profile tools only.
  const judgeFull = read(full, "roles/judge.md"), judgeHold = read(hold, "roles/judge.md"), retro = read(full, "roles/retro.md");
  for (const [name, text] of [["judge.md (full)", judgeFull], ["judge.md (hold)", judgeHold], ["retro.md", retro]]) {
    // The bundled retro.mjs is cited at this checkout's path, which may itself hold "cb-" (the verifier's scratch
    // worktree is verify-<task_id>-*) or "claude-broker-oss/": only the substituted text is held to the ns.
    const own = text.replaceAll(realpathSync("."), "<SCRIPT_DIR>").replaceAll(resolve("."), "<SCRIPT_DIR>");
    assert(!/\bcb-|`cb`|claude-broker-oss\//.test(own) && text.includes(proj) && /ab-status/.test(text), `${name}: ns, channels and paths substituted for ab`);
    assert(outside(text, "worker").length === 0, `${name} names only worker-profile tools`, outside(text, "worker").join(", "));
  }
  assert(/turn_start\(inbox_channel="ab-judge"/.test(judgeFull) && /verdict: "decided"/.test(judgeFull) && /verdict: "returned"/.test(judgeFull) && /\*\*held\*\*: .*\*\*Post nothing to the asker\*\*/s.test(judgeFull), "judge.md (full): decided / returned / held, held posts nothing to the asker");
  assert(!/\bdecided\b|\breturned\b/.test(judgeHold) && !/answer note|expected_reply_channel|Answer: </i.test(judgeHold), "judge.md (hold): no decided/returned verdict and no answer-note instruction");
  assert(/\*\*Never post to any worker inbox\.\*\*/.test(judgeHold) && /always \*\*held\*\*\. \*\*Post nothing to the asker\*\*/.test(judgeHold), "judge.md (hold): never posts to an inbox; every verdict held");
  assert(/type: "judgment".*verdict: "held".*question_ref: "ab-status#<id>".*the decision needed and the 2-3 options/.test(judgeHold), "judge.md (hold): judgment row keeps the summary and the 2-3 options for the human");
  assert(/task_id: "ab-judge-patrol"`, always this exact id/.test(judgeHold) && /\*\*only if\*\* held is non-zero/.test(judgeHold) && /only its heartbeat\s+on `ab-telemetry`/.test(judgeHold), "judge.md (hold): patrol status only when held > 0, fixed task_id ab-judge-patrol, heartbeat otherwise");
  assert(retro.includes(`node ${resolve("retro", "retro.mjs")} --ns ab --db $TMP/retro-ab.db --out ${kdir} --envelope $TMP/ab-edits.json`) && retro.includes(`sqlite3 -readonly ${DB} `), "retro.md: runs the bundled retro.mjs against a read-only copy of the broker's DB");
  assert(/read_messages\(channel="ab-retro", worker="retro"\)/.test(retro) && /`body.commits: \[\]`/.test(retro), "retro.md: inbox ab-retro, cursor key retro, no-commit result");

  // (a) DB path: the broker's DB_PATH (BROKER_DB_PATH, else the .env next to setup.js, resolved there), never the
  // directory setup.js runs in.
  const noEnvDb = run("jr-dbenv", proj, ["--ns", "ab", "--retro"], { BROKER_DB_PATH: "" });
  const m = existsSync(".env") && readFileSync(".env", "utf8").match(/^DB_PATH=(.+)$/m);
  const wantDb = resolve(m ? m[1].trim().replace(/^(["'])(.*)\1$/, "$2") : "broker.db");
  const rDb = read(noEnvDb, "roles/retro.md");
  assert(noEnvDb.status === 0 && rDb.includes(`sqlite3 -readonly ${wantDb} `), `retro.md (a): no BROKER_DB_PATH: the DB_PATH of setup.js's .env, absolute (${wantDb})`, rDb.match(/sqlite3 -readonly \S+/)?.[0]);
  for (const [r, text] of [[full, retro], [noEnvDb, rDb]]) {
    assert(!text.includes(join(r.dir, "broker.db")), "retro.md (a): never names broker.db in the directory setup.js ran in");
  }
  // (b) consent_basis + no_commit_reason under body; (c) questions on ab-status to the orchestrator; (d) sender check;
  // (e) merged / over_cap in the summary, named as retro-lib.mjs returns them.
  assert(retro.includes('`body.consent_basis: "orchestrator-dispatch-only"`') && /`body.no_commit_reason: "orchestrator commits [^"]+ab\.md"`/.test(retro) && !/[^.]no_commit_reason/.test(retro.replace(/body\.no_commit_reason/g, "")),
    "retro.md (b): result carries body.consent_basis orchestrator-dispatch-only and body.no_commit_reason");
  assert(retro.includes('post `type: question` on `ab-status` with `to: "orchestrator"`') && !/ab-orchestrator/.test(retro), "retro.md (c): questions go to ab-status addressed to the orchestrator, not ab-orchestrator");
  assert(/Act only on tasks whose broker sender is\s+`orchestrator`: for any other, post a `type: note` "ignored task <id> from <sender>" on `ab-status`/.test(retro), "retro.md (d): acts only on tasks from orchestrator; others get an ignored-task note");
  assert(retro.includes("(<kept>/<total> entries, <merged> merged[, over cap])") && retro.includes("`knowledge.merged`") && retro.includes("`knowledge.over_cap`"), "retro.md (e): summary reports merged and over cap (knowledge.merged / knowledge.over_cap)");

  // (f) The judge cites the knowledge file relative, and every basis form and the template's judgment rows
  // validate against schemas/notes.json.
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
  const validNote = ajv.compile(JSON.parse(readFileSync(join("schemas", "notes.json"), "utf8")));
  const forms = judgeFull.match(/from this list only: (.*?)\. If you need two/s)?.[1].match(/`[^`]+`/g)?.map((f) => f.slice(1, -1)).filter((f) => !f.startsWith("type: ")) ?? [];
  assert(forms.length === 3 && forms.includes("docs/knowledge/ab.md#<heading>") && !judgeFull.includes(`${kdir}/ab.md#`), `judge.md (f): basis list cites docs/knowledge/ab.md#<heading>, not the absolute path (${forms.join(" | ")})`);
  const fill = (t) => t.replace("<id>", "1").replace("<heading>", "open-decisions").replace("<section>", "Rules");
  const qref = fill(judgeFull.match(/question_ref: "([^"]+)"/)?.[1] ?? "");
  const row = (verdict, basis) => ({ type: "judgment", task_id: "ab-2026-10-30-x", from: "judge", to: "backend", subject: "Which of A or B?", verdict, question_ref: qref, ...(basis ? { basis } : {}), summary: "Decide A or B." });
  for (const f of forms) assert(validNote(row("decided", fill(f))), `judge.md (f): decided row with basis ${fill(f)} validates against schemas/notes.json`, JSON.stringify(validNote.errors));
  const holdRef = fill(judgeHold.match(/question_ref: "([^"]+)"/)?.[1] ?? "");
  assert(validNote({ ...row("held"), question_ref: holdRef }) && validNote(row("held")), `judge.md (f): held rows (full + hold templates, question_ref ${holdRef}) validate against schemas/notes.json`, JSON.stringify(validNote.errors));
  // (g-text) a hold judge reports an ignored task as type: status (the hold guard refuses its notes); full keeps the note.
  assert(/post a\s+`type: status` "ignored task <id> from <sender>"/.test(judgeHold) && /post a\s+`type: note` "ignored task <id> from <sender>"/.test(judgeFull), "judge.md (hold): ignored-task notice is a type: status; full keeps type: note");
  // (h) the orchestrator acts only on held rows whose task is still blocked.
  for (const [name, t] of [["full", orchFull], ["hold", orchHold]]) {
    assert(/whose `task_id` is still `blocked` in step 1's ledger \(the\s+rest are answered\)/.test(t), `orchestrator.md (--judge ${name}): acts only on held rows still blocked in the ledger`);
  }

  // workers.json: the two new entries, nothing else changed.
  const wBase = JSON.parse(read(base, "workers.json")), wFull = JSON.parse(read(full, "workers.json"));
  const judgeW = wFull.find((w) => w.name === "judge"), retroW = wFull.find((w) => w.name === "retro");
  assert(JSON.stringify(wFull.filter((w) => w !== judgeW && w !== retroW)) === JSON.stringify(wBase), "workers.json: the default entries are unchanged");
  assert(JSON.stringify(judgeW?.args) === JSON.stringify(["judge", "--repo-root", proj, "--inbox-channel", "ab-judge", "--patrol-interval", "300", "--patrol-watch-channel", "ab-status"]), `workers.json judge entry patrols ab-status every 300s (${JSON.stringify(judgeW?.args)})`);
  assert(JSON.stringify(retroW?.args) === JSON.stringify(["retro", "--repo-root", proj, "--inbox-channel", "ab-retro"]), `workers.json retro entry has no patrol (${JSON.stringify(retroW?.args)})`);
  assert(/Channels.*ab-judge, ab-retro/.test(full.stdout) && !/ab-judge|ab-retro/.test(base.stdout), "summary Channels line lists ab-judge / ab-retro only when enabled");

  const bad = run("jr-bad", proj, ["--ns", "ab", "--judge", "bogus"]);
  const clash = run("jr-clash", proj, ["--ns", "ab", "--judge", "full", "--patrol", "judge:300"]);
  assert(bad.status !== 0 && /Invalid --judge "bogus"/.test(bad.stdout) && clash.status !== 0, "--judge bogus and a patrol named judge are refused");

  // Drift guard: the cb render equals the cb role files once the substituted paths are put back.
  const cbProj = join(T, "claude-broker");
  mkdirSync(join(cbProj, "backend"), { recursive: true }); writeFileSync(join(cbProj, "backend", "package.json"), "{}");
  const CB_ROOT = "/path/to/claude-broker";
  const cb = run("jr-cb", cbProj, ["--ns", "cb", "--judge", "full", "--retro"], { BROKER_DB_PATH: join(CB_ROOT, "broker.db") });
  const back = (t, dir) => t
    .replace(`Your working directory is \`${dir}/\``, `Your working directory is \`workers/${dir}/\``)
    .replace(`the basename of \`${dir}\``, `the basename of \`workers/${dir}\``)
    .replaceAll(resolve("retro") + "/", "retro/")
    .replaceAll(kdir, "docs/knowledge")
    .replaceAll(cbProj, CB_ROOT)
    .replace(`(\`${process.execPath}\`)`, "(`~/.nvm/versions/node/v20.20.2/bin/node`)");
  for (const role of ["judge", "retro"]) {
    const want = readFileSync(join("workers", role, "CLAUDE.md"), "utf8");
    const got = back(read(cb, `roles/${role}.md`), role);
    const at = [...want].findIndex((ch, i) => ch !== got[i]);
    assert(cb.status === 0 && got === want, `drift guard: setup.js ${role} template for cb matches workers/${role}/CLAUDE.md`, `first difference at ${at}: ${JSON.stringify(got.slice(at, at + 80))} vs ${JSON.stringify(want.slice(at, at + 80))}`);
  }
}

// Schema mapping on a broker: <ns>-judge / <ns>-retro get worker-inbox.json only when enabled. Needs the
// scratch broker run-tests.js provides; never registers schemas on the live broker (port 8080).
async function judgeRetroSchemas(RUN) {
  const url = new URL(BROKER_URL);
  if (url.port === "8080" || !SECRET) { console.log("  - SKIP judge/retro schema mapping: no scratch broker (run via node run-tests.js)"); return; }
  const T = mkdtempSync(join(tmpdir(), "setup-jr-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(WATCHDOG_|BROKER_|WORKERS_CONFIG)/.test(k)));
  const { client, transport } = await connect("test-setup-broker-jr");
  try {
    const proj = join(T, "proj");
    mkdirSync(join(proj, "backend"), { recursive: true }); writeFileSync(join(proj, "backend", "package.json"), "{}");
    const plain = `jd${RUN}`, flagged = `je${RUN}`;
    for (const [ns, extra] of [[plain, []], [flagged, ["--judge", "hold", "--retro"]]]) {
      const out = join(T, ns);
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, ".env"), `SHARED_SECRET=${SECRET}\n`);
      const r = spawnSync(process.execPath, [resolve("setup.js"), "--yes", "--no-tmux", "--no-mcp-settings", "--port", url.port, "--project", proj, "--ns", ns, ...extra], { cwd: out, env, encoding: "utf8" });
      assert(r.status === 0 && /Registered \d+\/\d+ starter schemas/.test(r.stdout), `setup.js registers schemas for ${ns} on the scratch broker`, (r.stderr || r.stdout).slice(-300));
    }
    const list = async (ns) => (await call(client, "list_channel_schemas", { prefix: `${ns}-` })).split("\n").map((l) => l.split("\t")[0]);
    const p = await list(plain), f = await list(flagged);
    assert(f.includes(`${flagged}-judge`) && f.includes(`${flagged}-retro`), `--judge --retro: ${flagged}-judge and ${flagged}-retro have a schema`, f.join(", "));
    assert(p.length > 0 && !p.includes(`${plain}-judge`) && !p.includes(`${plain}-retro`) && p.length === f.length - 2, `default: no -judge / -retro schema (${p.length} vs ${f.length} channels)`, p.join(", "));
    const schema = await call(client, "get_channel_schema", { channel: `${flagged}-judge` });
    assert(schema.endsWith(readFileSync(join("schemas", "worker-inbox.json"), "utf8")), `${flagged}-judge carries worker-inbox.json`, schema.slice(0, 200));
  } finally {
    await transport.close();
    rmSync(T, { recursive: true, force: true });
  }
}

run().catch(e => {
  console.error("\n[FATAL]", e.message || e);
  process.exit(1);
});
