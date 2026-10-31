// Plan-gate schema tests: base `plan` and `plan-decision` types, optional task.plan_required, and the
// cb manifest wiring (plan -> status channel, plan-decision -> worker inboxes, orchestrator tasks must
// carry scope + acceptance_criteria). Registers a renamed copy of schemas/manifests/cb.json under a
// unique namespace on the (scratch) broker, so it never touches the live cb namespace.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync } from "fs";
import "dotenv/config";

const BROKER_URL = process.env.BROKER_URL || "http://localhost:8080/mcp";
const SECRET     = process.env.SHARED_SECRET || "";
const NS         = `pg${Date.now().toString(36)}`;

let passed = 0;
let failed = 0;

function expect(cond, label, detail) {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed++;
    return true;
  }
  console.error(`  ✗ ${label}`);
  if (detail !== undefined) console.error(`     detail: ${JSON.stringify(detail)}`);
  failed++;
  process.exitCode = 1;
  return false;
}

async function call(client, name, args) {
  const r = await client.callTool({ name, arguments: args });
  return { text: r.content?.[0]?.text ?? "", isError: !!r.isError };
}

const accepted = (r) => !r.isError && /Sent #/.test(r.text) && !/WARN/.test(r.text);
const send = (client, channel, content, sender) =>
  call(client, "send_message", { channel, sender, content: JSON.stringify(content) });

const tid = (slug) => `${NS}-2026-10-29-${slug}`;

const plan = (over = {}) => ({
  type: "plan", task_id: tid("a"), from: "protocol-qa", to: "orchestrator", subject: "plan for a",
  body: {
    approach: "add two base types",
    steps: ["write schemas", "wire manifest", "test"],
    files: { read: ["schemas/base/"], write: ["schemas/base/plan.json"] },
    risks: ["manifest closed:true rejects unknown fields"],
    open_questions: [],
  },
  ...over,
});

const decision = (over = {}) => ({
  type: "plan-decision", task_id: tid("a"), from: "orchestrator", to: "protocol-qa", subject: "plan decision for a",
  body: { decision: "approve", notes: "go" },
  ...over,
});

const task = (over = {}) => ({
  type: "task", task_id: tid("a"), from: "orchestrator", to: "protocol-qa", subject: "do the thing",
  body: "what and why", scope: "small", acceptance_criteria: ["it works"],
  ...over,
});

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL(`${BROKER_URL}?role=admin`), {
    requestInit: SECRET ? { headers: { Authorization: `Bearer ${SECRET}` } } : {},
  });
  const client = new Client({ name: "test-plan-gate-schemas", version: "1.0.0" });
  await client.connect(transport);

  try {
    const raw = readFileSync("schemas/manifests/cb.json", "utf-8")
      .replaceAll('"cb-', `"${NS}-`).replaceAll("^cb-", `^${NS}-`).replace('"ns": "cb"', `"ns": "${NS}"`);
    const manifest = JSON.parse(raw);
    manifest.strict = true; // reject, so a bad envelope shows as an error rather than a warning
    const reg = await call(client, "register_namespace", { manifest: JSON.stringify(manifest) });
    expect(!reg.isError, "cb manifest (renamed copy) registers", reg.text);

    const status = `${NS}-status`;
    const core = `${NS}-core`;
    const qa = `${NS}-protocol-qa`;

    console.log("\n── plan ──");
    expect(accepted(await send(client, status, plan(), "protocol-qa")), "valid plan accepted on status channel");
    expect(accepted(await send(client, status, plan({ body: { approach: "x", steps: ["s"], files: { read: [], write: [] } } }), "protocol-qa")),
      "plan without risks/open_questions accepted");
    for (const [label, body] of [
      ["no approach", { steps: ["s"], files: { read: [], write: [] } }],
      ["no steps", { approach: "x", files: { read: [], write: [] } }],
      ["no files", { approach: "x", steps: ["s"] }],
      ["files without write", { approach: "x", steps: ["s"], files: { read: [] } }],
      ["steps not strings", { approach: "x", steps: [1], files: { read: [], write: [] } }],
      ["empty approach", { approach: "", steps: ["s"], files: { read: [], write: [] } }],
    ]) {
      const r = await send(client, status, plan({ body }), "protocol-qa");
      expect(!accepted(r), `plan rejected: ${label}`, r.text);
    }
    const noBody = plan(); delete noBody.body;
    expect(!accepted(await send(client, status, noBody, "protocol-qa")), "plan rejected: no body");
    expect(!accepted(await send(client, core, plan(), "protocol-qa")), "plan not routed to a worker inbox");

    console.log("\n── plan-decision ──");
    expect(accepted(await send(client, core, decision(), "orchestrator")), "approve accepted on cb-core");
    expect(accepted(await send(client, qa, decision({ body: { decision: "amend", amendments: ["use fields"] } }), "orchestrator")),
      "amend with amendments accepted on cb-protocol-qa");
    expect(accepted(await send(client, qa, decision({ body: { decision: "reject", notes: "too broad" } }), "orchestrator")),
      "reject accepted");
    for (const [label, body] of [
      ["unknown decision", { decision: "maybe" }],
      ["no decision", { notes: "hm" }],
      ["amendments not array", { decision: "amend", amendments: "x" }],
    ]) {
      const r = await send(client, core, decision({ body }), "orchestrator");
      expect(!accepted(r), `plan-decision rejected: ${label}`, r.text);
    }
    expect(!accepted(await send(client, status, decision(), "orchestrator")), "plan-decision not routed to the status channel");

    console.log("\n── task.plan_required ──");
    expect(accepted(await send(client, core, task(), "orchestrator")), "old task without plan_required still valid");
    expect(accepted(await send(client, core, task({ plan_required: true }), "orchestrator")), "plan_required: true accepted");
    expect(accepted(await send(client, core, task({ plan_required: false }), "orchestrator")), "plan_required: false accepted");
    const bad = await send(client, core, task({ plan_required: "yes" }), "orchestrator");
    expect(!accepted(bad), "plan_required must be boolean", bad.text);
    for (const scope of ["small", "medium", "large"])
      expect(accepted(await send(client, core, task({ scope }), "orchestrator")), `scope ${scope} accepted`);
    expect(!accepted(await send(client, core, task({ scope: "huge" }), "orchestrator")), "scope stays small|medium|large");

    console.log("\n── orchestrator tasks require scope + acceptance_criteria ──");
    // the manifest only knows the orchestrator role for senders named in workers[]
    const noScope = task(); delete noScope.scope;
    const noAc = task(); delete noAc.acceptance_criteria;
    expect(!accepted(await send(client, core, noScope, "orchestrator")), "orchestrator task without scope flagged");
    expect(!accepted(await send(client, core, noAc, "orchestrator")), "orchestrator task without acceptance_criteria flagged");
  } finally {
    await client.close().catch(() => {});
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
