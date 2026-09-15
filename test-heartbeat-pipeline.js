// Heartbeat-pipeline regression test (backlog cb-2026-07-08-heartbeat-pipeline-test).
//
// The 2026-07-08 repair sprint found three ways the pipeline had silently died:
//   - the watchdog hardcoded 'dv-telemetry', so cb/dx/rp/sm heartbeats went to the wrong channel
//   - a multi-hyphen inbox name (cb-protocol-qa) was at risk of deriving 'cb-protocol-telemetry'
//   - session-end beats carried exit_code at the top level, which a strict envelope must reject
//
// This test pins the repaired behaviour:
//   (a) watchdog.sh derives namespace-ROOT sibling channels from multi-hyphen inbox names
//   (b) the v1.1 telemetry schema accepts a working beat and a session-end beat with exit_code
//       nested in activity, via both send_message and upsert_heartbeat — and REJECTS a top-level
//       exit_code (and an unknown activity key), so nobody "fixes" the schema back the other way
//   (c) every shipped *-telemetry.json keeps exit_code nested under activity
//
// Requires a running broker (run-tests.js starts a throwaway one).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync, readdirSync } from "fs";
import { spawnSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const ROOT       = dirname(fileURLToPath(import.meta.url));
const BROKER_URL = process.env.BROKER_URL || "http://localhost:8080/mcp";
const SECRET     = process.env.SHARED_SECRET || "";
const RUN_TAG    = Date.now().toString(36);
const CH         = `hb-pipeline-${RUN_TAG}`;

let passed = 0, failed = 0;
function expect(cond, label, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); return true; }
  failed++; console.error(`  ✗ ${label}`); if (detail) console.error(`     detail: ${String(detail).slice(0, 400)}`);
  process.exitCode = 1; return false;
}

async function connect(name) {
  const transport = new StreamableHTTPClientTransport(new URL(BROKER_URL), {
    requestInit: SECRET ? { headers: { Authorization: `Bearer ${SECRET}` } } : {},
  });
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

// ── (a) watchdog channel derivation ──────────────────────────────────────────

function derived(worker, inbox, extra = []) {
  const r = spawnSync("bash", [join(ROOT, "watchdog.sh"), worker, "--inbox-channel", inbox, ...extra, "--print-channels"], { encoding: "utf8" });
  const out = {};
  for (const line of (r.stdout || "").trim().split("\n")) { const i = line.indexOf("="); if (i > 0) out[line.slice(0, i)] = line.slice(i + 1); }
  return { status: r.status, out, stderr: r.stderr };
}

console.log("\n[a] watchdog.sh derives namespace-root channels from the inbox name");
{
  const cases = [
    ["protocol-qa",      "cb-protocol-qa",      "cb"],
    ["backend-services", "dv-backend-services", "dv"],
    ["core",             "cb-core",             "cb"],
    ["rp-api",           "rp-api",              "rp"],
  ];
  for (const [worker, inbox, ns] of cases) {
    const { status, out, stderr } = derived(worker, inbox);
    expect(status === 0, `${inbox}: --print-channels exits 0`, stderr);
    expect(out.namespace === ns, `${inbox}: namespace=${ns}`, JSON.stringify(out));
    const wrong = inbox.split("-").length > 2 ? ` (not ${inbox.replace(/-[^-]+$/, "")}-telemetry)` : "";
    expect(out.telemetry === `${ns}-telemetry`, `${inbox}: telemetry=${ns}-telemetry${wrong}`, JSON.stringify(out));
    expect(out.status === `${ns}-status`, `${inbox}: status=${ns}-status`, JSON.stringify(out));
    expect(out.rate_limits === `${ns}-rate-limits`, `${inbox}: rate_limits=${ns}-rate-limits`, JSON.stringify(out));
    expect(out.patrol_watch === `${ns}-status`, `${inbox}: patrol_watch defaults to ${ns}-status`, JSON.stringify(out));
  }
  const custom = derived("qa", "dv-qa", ["--patrol-watch-channel", "dv-platform-status"]);
  expect(custom.out.patrol_watch === "dv-platform-status", "explicit --patrol-watch-channel wins over the derived default", JSON.stringify(custom.out));
  expect(custom.out.telemetry === "dv-telemetry", "explicit patrol channel does not disturb telemetry derivation", JSON.stringify(custom.out));
}

// ── (c) shipped schema files keep exit_code nested ───────────────────────────

console.log("\n[c] every *-telemetry.json nests exit_code under activity");
{
  const files = readdirSync(join(ROOT, "schemas")).filter(f => f.endsWith("telemetry.json"));
  expect(files.includes("telemetry.json"), "generic schemas/telemetry.json present", files.join(","));
  for (const f of files) {
    const s = JSON.parse(readFileSync(join(ROOT, "schemas", f), "utf8"));
    expect(!("exit_code" in (s.properties || {})), `${f}: no top-level exit_code property`);
    expect(s.additionalProperties === false, `${f}: top-level additionalProperties=false (so a stray exit_code is rejected)`);
    expect(s.properties?.activity?.properties?.exit_code?.type === "integer", `${f}: activity.exit_code is an integer`);
    expect(s.properties?.activity?.properties?.state?.enum?.includes("session-end"), `${f}: activity.state enum includes session-end`);
  }
}

// ── (b) live broker validation ───────────────────────────────────────────────

function beat(state, extra = {}, activityExtra = {}) {
  return JSON.stringify({
    type: "heartbeat",
    from: "protocol-qa",
    ts: new Date().toISOString(),
    model: "claude-haiku-4-5-20251001",
    context: { size_tokens: 0, tier_threshold_pct: 0, rotation_recommended: false },
    activity: { state, ...activityExtra },
    ...extra,
  });
}

async function main() {
  console.log(`\n[b] broker: ${BROKER_URL}  channel: ${CH}`);
  const { client, transport } = await connect("hb-pipeline-test");
  const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); return { text: r.content?.[0]?.text || "", isError: !!r.isError }; };

  try {
    const schema = readFileSync(join(ROOT, "schemas", "telemetry.json"), "utf8");
    let r = await call("register_channel_schema", { channel: CH, schema, strict: true, version: "1.1" });
    expect(/Registered schema/.test(r.text), "telemetry schema registered strict on the test channel", r.text);

    // Exactly what watchdog.sh emits every HEARTBEAT_INTERVAL seconds (posted via POST /messages → send path).
    r = await call("send_message", { channel: CH, sender: "protocol-qa", content: beat("working") });
    expect(!r.isError && /Sent #/.test(r.text) && !/WARN/i.test(r.text), "working beat (watchdog shape) accepted via send_message", r.text);

    // Exactly what watchdog.sh emits after the session exits: exit_code nested in activity.
    r = await call("send_message", { channel: CH, sender: "protocol-qa", content: beat("session-end", {}, { exit_code: 0 }) });
    expect(!r.isError && /Sent #/.test(r.text) && !/WARN/i.test(r.text), "session-end beat with activity.exit_code accepted via send_message", r.text);

    r = await call("send_message", { channel: CH, sender: "protocol-qa", content: beat("session-end", {}, { exit_code: 124 }) });
    expect(!r.isError && /Sent #/.test(r.text), "session-end beat with non-zero activity.exit_code (timeout=124) accepted", r.text);

    // Worker self-heartbeat path (turn-start.js) goes through upsert_heartbeat, which also validates.
    r = await call("upsert_heartbeat", { channel: CH, sender: "protocol-qa", content: beat("working", {}, { current_task_id: null }) });
    expect(!r.isError && !/validation failed/i.test(r.text), "working beat accepted via upsert_heartbeat", r.text);
    r = await call("upsert_heartbeat", { channel: CH, sender: "protocol-qa", content: beat("session-end", {}, { exit_code: 0 }) });
    expect(!r.isError && !/validation failed/i.test(r.text), "session-end beat with activity.exit_code accepted via upsert_heartbeat", r.text);

    // Regression guard: the pre-repair shape (top-level exit_code) must be rejected under strict.
    r = await call("send_message", { channel: CH, sender: "protocol-qa", content: beat("session-end", { exit_code: 0 }) });
    expect(r.isError && /validation failed/i.test(r.text) && /additional properties/i.test(r.text), "top-level exit_code REJECTED via send_message", r.text);
    r = await call("upsert_heartbeat", { channel: CH, sender: "protocol-qa", content: beat("session-end", { exit_code: 0 }) });
    expect(r.isError && /validation failed/i.test(r.text), "top-level exit_code REJECTED via upsert_heartbeat", r.text);

    // exit_code must be an integer, and activity accepts no unknown keys.
    r = await call("send_message", { channel: CH, sender: "protocol-qa", content: beat("session-end", {}, { exit_code: "0" }) });
    expect(r.isError && /validation failed/i.test(r.text), "string activity.exit_code rejected", r.text);
    r = await call("send_message", { channel: CH, sender: "protocol-qa", content: beat("working", {}, { exitCode: 0 }) });
    expect(r.isError && /validation failed/i.test(r.text), "unknown activity key (exitCode) rejected", r.text);

    // The latest-per-sender view sees the nested exit code, so liveness logic can read it.
    r = await call("get_latest_per_sender", { channel: CH });
    expect(/<protocol-qa>/.test(r.text) && /"exit_code":0/.test(r.text) && /"session-end"/.test(r.text), "get_latest_per_sender returns the nested session-end beat", r.text);
    expect(!/"exit_code":124/.test(r.text), "older session-end beat is superseded by the latest", r.text);
  } finally {
    await call("purge_channel", { channel: CH }).catch(() => {});
    await call("clear_channel_schema", { channel: CH }).catch(() => {});
    await transport.close();
  }
}

main().then(() => {
  console.log(`\n[heartbeat-pipeline] ${passed} passed, ${failed} failed — ${failed ? "FAIL" : "OK"}`);
}).catch(e => { console.error("[heartbeat-pipeline] FAIL:", e); process.exit(1); });
