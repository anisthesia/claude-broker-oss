// Plan gate against REGISTERED v2 channel schemas (the review-sprint-close BLOCK: the plan-gate suites ran on
// brokers with no v2 schemas, so plan / plan-decision / plan_required were never checked against them).
// Runs setup-schemas-cb.js (strict v2 schemas on cb-*) and registers schemas/manifests/cb.json on the scratch
// broker, then through the typed tools:
//   cb (plan_gate: true):   dispatch_task small / medium / large OK, post_plan OK, decide_plan OK
//   ungated namespace with a strict v2 inbox schema: a medium dispatch OK, no plan_required written
// Needs a scratch broker (BROKER_URL / SHARED_SECRET, set by run-tests.js); never run it against the live one.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import "dotenv/config";

const BROKER_URL = process.env.BROKER_URL || "http://localhost:8080/mcp";
const SECRET     = process.env.SHARED_SECRET || "";
const UG         = `ug${Date.now().toString(36)}`;

let passed = 0;
let failed = 0;

function expect(cond, label, detail) {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed++;
    return true;
  }
  console.error(`  ✗ ${label}`);
  if (detail !== undefined) console.error(`     detail: ${String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 1000)}`);
  failed++;
  process.exitCode = 1;
  return false;
}

async function call(client, name, args) {
  const r = await client.callTool({ name, arguments: args });
  return { text: r.content?.[0]?.text ?? "", isError: !!r.isError };
}

async function connect(query) {
  const transport = new StreamableHTTPClientTransport(new URL(`${BROKER_URL}${query}`), {
    requestInit: SECRET ? { headers: { Authorization: `Bearer ${SECRET}` } } : {},
  });
  const client = new Client({ name: "test-plan-gate-v2-schemas", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

const idOf = (text) => Number(/Sent #(\d+)/.exec(text)?.[1] ?? NaN);
const clean = (r) => !r.isError && !/WARN/.test(r.text);
async function stored(client, channel, id) {
  const r = await call(client, "get_message", { channel, id });
  try { return JSON.parse(r.text.slice(r.text.indexOf("{"))); } catch { return null; }
}

async function main() {
  const clients = [];
  try {
    console.log("\n── register strict cb v2 schemas + cb manifest ──");
    const setup = spawnSync(process.execPath, ["setup-schemas-cb.js"], { env: { ...process.env, BROKER_URL, SHARED_SECRET: SECRET }, encoding: "utf-8" });
    expect(setup.status === 0, "setup-schemas-cb.js registers the cb v2 schemas", (setup.stdout + setup.stderr).slice(-600));

    const admin = await connect("?role=admin&ns=cb");
    clients.push(admin);
    const cbManifest = JSON.parse(readFileSync("schemas/manifests/cb.json", "utf-8"));
    expect(cbManifest.plan_gate === true, "cb.json sets plan_gate: true");
    let r = await call(admin, "register_namespace", { manifest: JSON.stringify(cbManifest) });
    expect(!r.isError, "register_namespace(cb.json)", r.text);
    const schema = await call(admin, "get_channel_schema", { channel: "cb-core" });
    expect(/"plan-decision"/.test(schema.text) && /plan_required/.test(schema.text), "cb-core v2 schema is the registered one (carries plan-decision, plan_required)", schema.text.slice(0, 300));

    const orch = await connect("?role=orchestrator&ns=cb");
    const worker = await connect("?role=worker&ns=cb&as=core");
    clients.push(orch, worker);

    console.log("\n── cb (gated, strict v2 schemas) ──");
    const T = (s) => `cb-2026-10-29-pgv2-${Date.now().toString(36)}-${s}`;
    const ids = {};
    for (const scope of ["small", "medium", "large"]) {
      ids[scope] = T(scope);
      r = await call(orch, "dispatch_task", {
        sender: "orchestrator", to: "core", task_id: ids[scope], subject: `${scope} task`, body: "b", context: "c",
        scope, acceptance_criteria: ["works"],
      });
      expect(clean(r), `dispatch_task ${scope} accepted by the strict v2 inbox schema`, r.text);
    }
    const led = JSON.parse((await call(orch, "get_task_ledger", { status_channel: "cb-status" })).text);
    const row = (id) => led.tasks.find((t) => t.task_id === id);
    expect(row(ids.large)?.state === "planning" && row(ids.small)?.state === "pending", "gated ledger: large is planning (derived), small pending", [row(ids.large), row(ids.small)]);
    r = await call(orch, "dispatch_task", {
      sender: "orchestrator", to: "core", task_id: T("explicit"), subject: "explicit plan_required", body: "b", context: "c",
      scope: "small", acceptance_criteria: ["works"], plan_required: true,
    });
    expect(clean(r), "dispatch_task with plan_required: true passes the strict v2 inbox schema", r.text);

    r = await call(worker, "post_plan", { sender: "core", task_id: ids.medium, approach: "two steps", steps: ["one", "two"], files: { write: ["a.js"] } });
    expect(clean(r) && /Sent #/.test(r.text), "post_plan accepted on cb-status (type plan in the v2 enum)", r.text);
    const plan = await stored(admin, "cb-status", idOf(r.text));
    expect(plan?.type === "plan", "stored envelope is type plan", plan);

    r = await call(orch, "decide_plan", { sender: "orchestrator", task_id: ids.medium, decision: "approve", notes: "go" });
    expect(clean(r) && /Sent #/.test(r.text), "decide_plan accepted on cb-core (type plan-decision in the v2 enum)", r.text);
    const dec = await stored(admin, "cb-core", idOf(r.text));
    expect(dec?.type === "plan-decision", "stored envelope is type plan-decision", dec);

    console.log("\n── ungated namespace with a strict v2 inbox schema ──");
    const raw = readFileSync("schemas/manifests/cb.json", "utf-8")
      .replaceAll('"cb-', `"${UG}-`).replaceAll("^cb-", `^${UG}-`).replace('"ns": "cb"', `"ns": "${UG}"`);
    const ug = JSON.parse(raw);
    delete ug.plan_gate;
    r = await call(admin, "register_namespace", { manifest: JSON.stringify(ug) });
    expect(!r.isError, "ungated copy of the cb manifest registers", r.text);
    r = await call(admin, "register_channel_schema", {
      channel: `${UG}-core`, schema: readFileSync("schemas/cb-worker-inbox.json", "utf-8"), strict: true,
    });
    expect(!r.isError, "strict v2 inbox schema registered on the ungated inbox", r.text);

    const uorch = await connect(`?role=orchestrator&ns=${UG}`);
    clients.push(uorch);
    const uid = `cb-2026-10-29-pgv2-${UG}-medium`; // the v2 inbox schema pins task_id to ^cb-
    r = await call(uorch, "dispatch_task", {
      sender: "orchestrator", to: "core", task_id: uid, subject: "medium task", body: "b", context: "c",
      scope: "medium", acceptance_criteria: ["works"],
    });
    expect(clean(r), "medium dispatch accepted in the ungated namespace", r.text);
    const usent = await stored(admin, `${UG}-core`, idOf(r.text));
    expect(usent && !("plan_required" in usent), "no plan_required written in the ungated namespace", usent);
    r = await call(uorch, "decide_plan", { sender: "orchestrator", task_id: uid, decision: "approve" });
    expect(r.isError && /plan gate is not enabled/.test(r.text), "decide_plan refused in the ungated namespace", r.text);
  } finally {
    for (const c of clients) await c.close().catch(() => {});
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
