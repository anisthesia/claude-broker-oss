/**
 * test-teardown-broker.js — test suite for /teardown-broker slash command
 * 22 assertions: file existence, static content checks, and a live broker smoke-test.
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
  console.log(`\n[test-teardown-broker]  url=${BROKER_URL}\n`);

  const REPO_COPY = `.claude/commands/teardown-broker.md`;
  const USER_COPY = `${homedir()}/.claude/commands/teardown-broker.md`;

  // ── 1. File existence ──────────────────────────────────────────────────────
  console.log("1. File existence");

  const repoContent = existsSync(REPO_COPY) ? readFileSync(REPO_COPY, "utf-8") : null;

  // 1
  assert(
    repoContent !== null && repoContent.length > 2000,
    `repo copy exists and has length > 2000 chars (got ${repoContent?.length ?? 0})`,
  );

  const userContent = existsSync(USER_COPY) ? readFileSync(USER_COPY, "utf-8") : null;

  // 2
  assert(
    userContent !== null,
    "user-level copy exists at ~/.claude/commands/teardown-broker.md",
    "file missing",
  );

  // 3
  assert(
    userContent !== null && userContent === repoContent,
    "user copy content === repo copy content (files in sync)",
    userContent === null ? "user copy missing" : "content mismatch",
  );

  const content = repoContent ?? "";

  // ── 2. Config collection ───────────────────────────────────────────────────
  console.log("\n2. Config collection");

  // 4
  assert(
    content.includes("AskUserQuestion") &&
    /prefix|namespace prefix/i.test(content) &&
    /TARGET.*project|absolute path.*TARGET/i.test(content) &&
    /claude-broker repo/i.test(content),
    "AskUserQuestion present for prefix + target + broker repo collection",
  );

  // ── 3. Inventory step ─────────────────────────────────────────────────────
  console.log("\n3. Inventory step");

  // 5
  assert(
    /Inventory/i.test(content) &&
    content.includes("list_workers") &&
    content.includes("list_channel_schemas"),
    "Step 2 inventory: ls checks + list_workers + list_channel_schemas all present",
  );

  // ── 4. Confirm plan gate ──────────────────────────────────────────────────
  console.log("\n4. Confirm plan gate");

  // 6
  assert(
    /Confirm plan|Proceed with teardown/i.test(content) &&
    content.includes("AskUserQuestion"),
    "Step 3: confirm plan AskUserQuestion gate present",
  );

  // ── 5. Worker stop step ───────────────────────────────────────────────────
  console.log("\n5. Worker stop step");

  // 7
  assert(
    content.includes("stop_worker") &&
    /Stop running workers|stop.*workers/i.test(content),
    "Step 4: stop_worker call present",
  );

  // ── 6. Schema clear step ──────────────────────────────────────────────────
  console.log("\n6. Schema clear step");

  // 8
  assert(
    content.includes("clear_channel_schema") &&
    /Clear channel schemas|clear.*schema/i.test(content),
    "Step 5: clear_channel_schema call present",
  );

  // ── 7. Purge gate ────────────────────────────────────────────────────────
  console.log("\n7. Purge gate");

  // 9
  assert(
    /NEVER purge without an explicit|never.*purge.*AskUserQuestion/i.test(content) &&
    content.includes("AskUserQuestion"),
    "Step 6: purge is never automatic — always gated by AskUserQuestion",
  );

  // 10
  assert(
    /backlog.*separate gate|Step 6b|Backlog decision/i.test(content),
    "Step 6b: backlog has its own separate gate",
  );

  // 11
  assert(
    /Leave it.*Recommended|Leave it \(Recommended\)/i.test(content),
    "Step 6b: leaving backlog is the Recommended default option",
  );

  // ── 8. File removal step ─────────────────────────────────────────────────
  console.log("\n8. File removal step");

  // 12
  assert(
    content.includes("rm <BROKER_REPO>/schemas/<PREFIX>-*.json"),
    "Step 7: rm schemas/<PREFIX>-*.json command present",
  );

  // 13
  assert(
    content.includes("rm <BROKER_REPO>/setup-schemas-<PREFIX>.js"),
    "Step 7: rm setup-schemas-<PREFIX>.js command present",
  );

  // 14
  assert(
    content.includes("WORKERS_CONFIG") &&
    /detect.*WORKERS_CONFIG|WORKERS_CONFIG.*detect|read.*WORKERS_CONFIG/i.test(content),
    "Step 7: WORKERS_CONFIG detection from .env present",
  );

  // 15
  assert(
    /ns\s*===\s*["']<PREFIX>["']|filter.*ns.*PREFIX|ns === "<PREFIX>"/i.test(content),
    'Step 7: filter by ns === "<PREFIX>" for WORKERS_CONFIG removal present',
  );

  // 16
  assert(
    content.includes("PRUNE_EXEMPT") &&
    /remove.*<PREFIX>-backlog|<PREFIX>-backlog.*remov/i.test(content),
    "Step 7: PRUNE_EXEMPT update to remove <PREFIX>-backlog present",
  );

  // ── 9. Target project removal ────────────────────────────────────────────
  console.log("\n9. Target project removal");

  // 17
  assert(
    content.includes("rm <TARGET_ROOT>/orchestrators/<PROJECT_NAME>/CLAUDE.md"),
    "Step 8: rm orchestrators/<PROJECT_NAME>/CLAUDE.md present",
  );

  // 18
  assert(
    content.includes("rm <TARGET_ROOT>/workers/<worker>/CLAUDE.md"),
    "Step 8: rm workers/<worker>/CLAUDE.md present",
  );

  // 19
  assert(
    /settings\.json.*patch|mcpServers\.broker/i.test(content),
    "Step 8: settings.json patch / mcpServers.broker removal documented",
  );

  // ── 10. Git commits ──────────────────────────────────────────────────────
  console.log("\n10. Git commits");

  // 20
  assert(
    content.includes("remove <PREFIX> project schemas and worker config"),
    "Step 9: broker repo git commit message present",
  );

  // 21
  assert(
    content.includes("teardown via /teardown-broker"),
    "Step 9: target project git commit message present",
  );

  // ── 11. Verification checklist ───────────────────────────────────────────
  console.log("\n11. Verification checklist");

  // 22
  assert(
    /Verification checklist/i.test(content) &&
    content.includes("- [ ]"),
    "Verification checklist section present with checkbox items",
  );

  // ── 12. Live broker smoke-test ───────────────────────────────────────────
  console.log("\n12. Live broker smoke-test");

  let { client, transport } = { client: null, transport: null };
  try {
    ({ client, transport } = await connect("test-teardown-broker"));
    const workersRaw = await call(client, "list_workers", {});

    // Not a static assertion — just verifying broker is reachable
    assert(
      typeof workersRaw === "string",
      "live broker: list_workers returns a string response",
      workersRaw,
    );
  } catch (e) {
    fail("live broker: connection succeeded", e.message);
  } finally {
    if (transport) await transport.close().catch(() => {});
  }

  // ── Summary ────────────────────────────────────────────────────────────────
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
