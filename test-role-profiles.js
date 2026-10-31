// Role-scoped tools/list: /mcp?role=<role>&ns=<ns>&as=<name>.
// Per-role tool sets and byte budgets, hidden-tool rejection (and that a rejected call has no
// effect), short descriptions and stripped SDK boilerplate on profiled connections, byte identity
// of the no-role list with the 5065c86 snapshot (v3 tools hidden without ?role=), identity validation errors, and
// identity-supplied defaults for the typed tools. Exercises a live (scratch) broker over MCP.
// Safe to run multiple times — unique namespace per run.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROFILES } from "./lib/profiles.js";
import "dotenv/config";

const ROOT = dirname(fileURLToPath(import.meta.url));
const BROKER_URL = process.env.BROKER_URL || "http://localhost:8080/mcp";
const SECRET     = process.env.SHARED_SECRET || "";
const RUN_TAG    = Date.now().toString(36);
const NS         = `rp${RUN_TAG}`;

async function connect(name, query = "") {
  const transport = new StreamableHTTPClientTransport(new URL(`${BROKER_URL}${query}`), {
    requestInit: SECRET ? { headers: { Authorization: `Bearer ${SECRET}` } } : {},
  });
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

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

// Raw JSON-RPC against a profile URL, for the cases the SDK client cannot reach (400 on connect).
async function rawList(query, { auth = true } = {}) {
  const res = await fetch(`${BROKER_URL}${query}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(auth && SECRET ? { authorization: `Bearer ${SECRET}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  return { status: res.status, text: await res.text() };
}

// The sets under test are lib/profiles.js data (rebuilt from measured usage), not a copy of them.
const WORKER = PROFILES.worker, REVIEWER = PROFILES.reviewer, ORCHESTRATOR = PROFILES.orchestrator;
// Budgets are ceilings with ~10% headroom over the sizes measured when the usage-based profiles shipped
// (worker 14.3 KB, reviewer 14.3 KB, orchestrator 20.4 KB, admin list 36.4 KB).
const BUDGET = { worker: 15_700, reviewer: 15_700, orchestrator: 23_500 };
const V2_TOOLS = ["send_message", "send_message_batch", "read_messages", "wait_for_messages", "has_messages", "read_last", "list_channels", "purge_channel",
  "purge_channels_by_prefix", "delete_message", "check_result", "check_results_batch", "get_latest_per_sender", "post_gated_message", "register_channel_schema",
  "get_channel_schema", "clear_channel_schema", "list_channel_schemas", "register_capability", "deregister_capability", "list_capabilities", "list_workers",
  "start_worker", "stop_worker", "upsert_heartbeat", "get_latest_heartbeats", "turn_start", "worker_cursor", "sprint_summary", "sprint_file_conflicts",
  "open_questions", "get_task_ledger", "register_worker", "deregister_worker"];

const V3_TOOLS = ["get_message", "dispatch_task", "post_result", "ask", "post_note", "register_namespace", "get_namespace", "adopt_namespace"];
// JSON.stringify(tools) of a 5065c86 broker's tools/list (34 tools); the no-role list must never drift from it.
const V2_LIST_BYTES = 28833;
const V2_LIST_SHA256 = "7b6a1d77a554b25cc451f426446ccde8bfc03615c5cb32d7f80a2b25133dad36";

const names = (tools) => tools.map(t => t.name);
const sameSet = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
const bytes = (tools) => JSON.stringify(tools).length;

// ─── tool sets & budgets ──────────────────────────────────────────────────────

async function testToolSets(lists) {
  console.log("\n── per-role tool sets ──");
  expect(sameSet(names(lists.worker), WORKER), `worker: exactly PROFILES.worker (${WORKER.length} tools)`, names(lists.worker));
  expect(sameSet(names(lists.reviewer), REVIEWER), `reviewer: exactly PROFILES.reviewer (${REVIEWER.length} tools)`, names(lists.reviewer));
  expect(sameSet(names(lists.orchestrator), ORCHESTRATOR), `orchestrator: exactly PROFILES.orchestrator (${ORCHESTRATOR.length} tools)`, names(lists.orchestrator));
  expect(WORKER.every(n => names(lists.reviewer).includes(n)) && WORKER.every(n => names(lists.orchestrator).includes(n)), "every role is a superset of the worker set");
  expect(PROFILES.admin === null && ORCHESTRATOR.every(n => names(lists.admin).includes(n)), "admin is unprofiled (every tool) and covers every profile");

  // Only admin may purge or manage registries/schemas/namespaces; no profile names a tool the server lacks.
  const adminOnly = ["purge_channels_by_prefix", "register_channel_schema", "clear_channel_schema", "register_namespace", "register_worker", "deregister_worker"];
  for (const role of ["worker", "reviewer"]) expect(!names(lists[role]).includes("purge_channel"), `${role}: no purge_channel`);
  expect(names(lists.orchestrator).includes("purge_channel"), "orchestrator keeps purge_channel (parity; server-side gates apply)");
  for (const role of ["worker", "reviewer", "orchestrator"]) {
    expect(adminOnly.every(n => !names(lists[role]).includes(n)), `${role}: no purge, schema-management or registry tools (admin-only)`, names(lists[role]).filter(n => adminOnly.includes(n)));
    expect(PROFILES[role].every(n => names(lists.admin).includes(n)), `${role}: every PROFILES entry is a real tool`, PROFILES[role].filter(n => !names(lists.admin).includes(n)));
  }
  expect(names(lists.admin).includes("purge_channel") && names(lists.admin).includes("purge_channels_by_prefix"), "purge_channel and purge_channels_by_prefix are in the admin list");
  expect(names(lists.none).includes("purge_channel"), "no-role connections keep purge_channel (v2 behaviour, server-side gates apply)");
  expect(!names(lists.worker).includes("dispatch_task") && !names(lists.reviewer).includes("dispatch_task") && names(lists.orchestrator).includes("dispatch_task"), "dispatch_task is orchestrator-only");
  expect([lists.worker, lists.reviewer, lists.orchestrator].every(l => names(l).includes("get_task_ledger")), "every role has the task ledger view (measured in worker use)");
  expect(!names(lists.reviewer).includes("start_worker") && !names(lists.reviewer).includes("stop_worker"), "reviewer cannot start or stop workers");

  expect(lists.admin.length === 44, `role=admin sees every tool (44: 34 v2 + 10 v3, ${lists.admin.length})`, lists.admin.length);
  for (const t of [...V2_TOOLS, ...V3_TOOLS]) {
    if (!names(lists.admin).includes(t)) { expect(false, `role=admin list contains ${t}`, names(lists.admin)); }
  }
  expect(names(lists.admin).slice(0, V2_TOOLS.length).join() === names(lists.admin).filter(n => V2_TOOLS.includes(n)).join(),
    "v3 tools are appended after the v2 tools (v2 tools/list order unchanged)");

  // No identity = the pre-v3 broker: v3 tools hidden, list byte-identical to 5065c86 (the last v2-only tree).
  expect(sameSet(names(lists.none), V2_TOOLS), "no-role list is exactly the 34 v2 tools", names(lists.none));
  expect(V3_TOOLS.every(t => !names(lists.none).includes(t)), "no-role list hides every v3 tool", V3_TOOLS.filter(t => names(lists.none).includes(t)));
  const noRole = JSON.stringify(lists.none);
  expect(noRole.length === V2_LIST_BYTES && createHash("sha256").update(noRole).digest("hex") === V2_LIST_SHA256,
    `no-role tools/list is byte-identical to the 5065c86 snapshot (${V2_LIST_BYTES} B)`, [noRole.length, createHash("sha256").update(noRole).digest("hex")]);
}

async function testBudgets(lists) {
  console.log("\n── byte budgets ──");
  const full = bytes(lists.admin);
  for (const role of ["worker", "reviewer", "orchestrator"]) {
    const b = bytes(lists[role]);
    expect(b <= BUDGET[role], `${role}: tools/list ${b} B ≤ ${BUDGET[role]} B`, b);
  }
  expect(bytes(lists.worker) <= bytes(lists.reviewer) && bytes(lists.reviewer) < bytes(lists.orchestrator) && bytes(lists.orchestrator) < full,
    "sizes order worker ≤ reviewer < orchestrator < full", [bytes(lists.worker), bytes(lists.reviewer), bytes(lists.orchestrator), full]);
  const noRole = bytes(lists.none);
  expect(bytes(lists.worker) < noRole, `worker list is smaller than the no-role (v2) list (${bytes(lists.worker)} vs ${noRole})`);
  expect(full > 30_000, `full list is still the full-size v2 list (${full} B) — profiles did not shrink the unprofiled path`, full);
}

// ─── descriptions, boilerplate ────────────────────────────────────────────────

async function testShape(lists) {
  console.log("\n── profiled list shape ──");
  const full = new Map(lists.admin.map(t => [t.name, t]));
  for (const role of ["worker", "reviewer", "orchestrator"]) {
    const dirty = lists[role].filter(t => "title" in t || "$schema" in t.inputSchema || "execution" in t);
    expect(dirty.length === 0, `${role}: no title / $schema / default execution boilerplate`, dirty.map(t => t.name));
  }
  const bare = lists.none.filter(t => !("title" in t) || !("$schema" in t.inputSchema));
  expect(bare.length === 0, "no-role list keeps title and $schema (byte-identical v2 shape)", bare.map(t => t.name));

  for (const n of ["send_message", "read_messages", "wait_for_messages", "check_result", "turn_start", "upsert_heartbeat"]) {
    const w = lists.worker.find(t => t.name === n), f = full.get(n);
    expect(w && f && w.description.length < f.description.length, `${n}: profiled description is shorter than the full one`, [w?.description.length, f?.description.length]);
  }
  // Descriptions of a profiled list must not name a tool the connection cannot call.
  const allNames = names(lists.admin);
  const leaks = [];
  for (const role of ["worker", "reviewer", "orchestrator"]) {
    const outside = allNames.filter(n => !PROFILES[role].includes(n));
    for (const t of lists[role]) {
      const text = JSON.stringify(t);
      for (const n of outside) if (new RegExp(`\\b${n}\\b`).test(text)) leaks.push(`${role}: ${t.name} → ${n}`);
    }
  }
  expect(leaks.length === 0, "profiled descriptions never point at a tool outside the role's profile", leaks);

  // Parameter schemas are untouched: same properties and required lists as the full list.
  const drift = [];
  for (const t of lists.worker) {
    const f = full.get(t.name);
    if (!f) continue;
    if (JSON.stringify(Object.keys(t.inputSchema.properties || {})) !== JSON.stringify(Object.keys(f.inputSchema.properties || {}))) drift.push(t.name);
  }
  expect(drift.length === 0, "profiled tools keep the same parameters as their full-list versions", drift);
}

// ─── hidden tools ─────────────────────────────────────────────────────────────

async function testHidden(admin, clients) {
  console.log("\n── hidden-tool rejection ──");
  const chan = `${NS}-victim`;
  await call(admin, "send_message", { channel: chan, sender: "t", content: JSON.stringify({ type: "note", task_id: "t", from: "t", to: "t", subject: "keep me" }) });

  let r = await call(clients.worker, "purge_channel", { channel: chan });
  expect(r.isError && r.text === "Tool 'purge_channel' is not available to role 'worker' — reconnect with a role whose profile includes it (role=admin has every tool).",
    "worker → purge_channel: error names the tool and the role, exact text", r.text);
  const after = await call(admin, "read_messages", { channel: chan, since_id: 0 });
  expect(/keep me/.test(after.text), "the rejected purge had no effect (message still there)", after.text);

  r = await call(clients.worker, "dispatch_task", { to: "x", task_id: "x-1", subject: "s", body: "b" });
  expect(r.isError && /Tool 'dispatch_task' is not available to role 'worker'/.test(r.text), "worker → dispatch_task rejected", r.text);
  r = await call(clients.reviewer, "dispatch_task", { to: "x", task_id: "x-1", subject: "s", body: "b" });
  expect(r.isError && /Tool 'dispatch_task' is not available to role 'reviewer'/.test(r.text), "reviewer → dispatch_task rejected, naming reviewer", r.text);
  r = await call(clients.orchestrator, "purge_channels_by_prefix", { prefix: NS });
  expect(r.isError && /Tool 'purge_channels_by_prefix' is not available to role 'orchestrator'/.test(r.text), "orchestrator → purge_channels_by_prefix rejected", r.text);
  r = await call(clients.worker, "start_worker", { worker: "x" });
  expect(r.isError && /Tool 'start_worker' is not available to role 'worker'/.test(r.text), "worker → start_worker rejected (before argument validation)", r.text);
  r = await call(clients.worker, "register_namespace", { manifest: "{}" });
  expect(r.isError && /not available to role 'worker'/.test(r.text), "worker → register_namespace rejected", r.text);

  r = await call(clients.worker, "no_such_tool_at_all", {}).catch(e => ({ isError: true, text: String(e.message) }));
  expect(r.isError && !/not available to role/.test(r.text), "a tool that does not exist at all gets the SDK's not-found error, not the role message", r.text);

  r = await call(clients.admin, "list_channels", {});
  expect(!r.isError, "role=admin can call every tool (list_channels)", r.text);
  r = await call(clients.none, "list_channels", {});
  expect(!r.isError, "no-role connection can call every v2 tool", r.text);
  r = await call(clients.none, "get_message", { channel: `${NS}-allowed`, id: 1 });
  expect(r.isError && /Tool 'get_message' is a v3 tool and needs an identity — reconnect with \/mcp\?role=/.test(r.text),
    "no-role call to a hidden v3 tool errors naming ?role=", r.text);
  r = await call(clients.worker, "send_message", { channel: `${NS}-allowed`, sender: "wk", content: "{}" });
  expect(!r.isError && /Sent #/.test(r.text), "worker can call an allowed tool (send_message)", r.text);
  r = await call(clients.worker, "check_result", { channel: `${NS}-status`, task_id: "none" });
  expect(!r.isError, "worker can call check_result", r.text);
}

// ─── identity defaults ────────────────────────────────────────────────────────

async function testIdentity(admin) {
  console.log("\n── identity defaults (ns, as) ──");
  const manifest = {
    ns: NS, version: "3.0", strict: false,
    roles: { reviewer: { summary_prefixes: ["APPROVE"] } },
    workers: [{ name: "boss", inbox: `${NS}-boss`, role: "orchestrator" }, { name: "wk", inbox: `${NS}-wk`, role: "worker" }, { name: "rev", inbox: `${NS}-rev`, role: "reviewer" }],
    channels: [
      { name: `${NS}-boss`, kind: "orchestrator-inbox", types: ["result", "question", "status"] },
      { name: `${NS}-wk`,  kind: "worker-inbox", types: ["task"] },
      { name: `${NS}-rev`, kind: "worker-inbox", types: ["task"] },
      { name: `${NS}-status`, kind: "status", types: ["result", "status", "question"] },
      { name: `${NS}-notes`,  kind: "notes", types: ["finding", "decision", "resolved"] },
    ],
  };
  await call(admin, "register_namespace", { manifest: JSON.stringify(manifest) });

  const { client: wk } = await connect("wk", `?role=worker&ns=${NS}&as=wk`);
  const { client: boss } = await connect("boss", `?role=orchestrator&ns=${NS}&as=boss`);
  const { client: bare } = await connect("bare", "?role=worker");
  try {
    const wtools = new Map((await wk.listTools()).tools.map(t => [t.name, t]));
    const req = (n) => wtools.get(n).inputSchema.required || [];
    expect(!req("post_result").includes("sender") && !req("post_note").includes("sender") && !req("ask").includes("sender"), "with as=, sender is optional on post_result / post_note / ask", [req("post_result"), req("post_note"), req("ask")]);
    expect(/Default: 'wk'/.test(wtools.get("post_note").inputSchema.properties.sender.description) && /Default: '[^']*'/.test(wtools.get("post_note").inputSchema.properties.ns.description),
      "the schema descriptions state the identity defaults", [wtools.get("post_note").inputSchema.properties.sender.description, wtools.get("post_note").inputSchema.properties.ns.description]);
    const btools = new Map((await bare.listTools()).tools.map(t => [t.name, t]));
    expect((btools.get("post_note").inputSchema.required || []).includes("sender"), "role without as=: sender stays required", btools.get("post_note").inputSchema.required);

    let r = await call(wk, "post_note", { kind: "finding", subject: "identity", summary: "ns and sender come from the URL", scope: ["x"] });
    expect(!r.isError && r.text.includes(`'${NS}-notes' as 'wk'`), "post_note with no ns and no sender uses the connection identity", r.text);
    r = await call(wk, "post_note", { sender: "rev", kind: "finding", subject: "override", summary: "an explicit sender wins over the URL", scope: ["x"] });
    expect(!r.isError && r.text.includes(`'${NS}-notes' as 'rev'`), "an explicit sender argument overrides as=", r.text);
    r = await call(bare, "post_note", { kind: "finding", subject: "x", summary: "no sender, no identity" , scope: ["x"] }).catch(e => ({ isError: true, text: String(e.message) }));
    expect(r.isError && /sender/.test(r.text), "without as= a missing sender is an input error", r.text);

    r = await call(boss, "dispatch_task", { to: "wk", task_id: `${NS}-i1`, subject: "identity dispatch", body: "b" });
    expect(!r.isError && r.text.includes(`'${NS}-wk' as 'boss'`), "orchestrator dispatch_task: from and ns default from the URL", r.text);
    r = await call(wk, "post_result", { task_id: `${NS}-i1`, summary: "PASS — via identity" });
    expect(!r.isError && r.text.includes(`'${NS}-status' as 'wk'`), "post_result: only task_id and summary needed", r.text);

    // The role in the URL is a tool filter, not authority over summary prefixes: that comes from the manifest.
    const { client: liar } = await connect("liar", `?role=reviewer&ns=${NS}&as=wk`);
    r = await call(liar, "post_result", { task_id: `${NS}-i1`, summary: "APPROVE — claiming to be a reviewer" });
    expect(r.isError && /prefix 'APPROVE' is not allowed for 'wk' \(role worker\)/.test(r.text), "role=reviewer in the URL does not unlock reviewer prefixes for a manifest worker", r.text);
    await liar.close();
    const { client: rev } = await connect("rev", `?role=reviewer&ns=${NS}&as=rev`);
    r = await call(rev, "post_result", { task_id: `${NS}-i1`, summary: "APPROVE — manifest reviewer", subject: "review" });
    expect(!r.isError, "a manifest reviewer on a reviewer connection may post APPROVE", r.text);
    await rev.close();

    const { client: adm } = await connect("adm", `?role=admin&ns=${NS}&as=wk`);
    const atools = new Map((await adm.listTools()).tools.map(t => [t.name, t]));
    expect(atools.size === 44 && !(atools.get("post_note").inputSchema.required || []).includes("sender"), "role=admin with as=: full tool list and identity defaults", atools.size);
    await adm.close();
  } finally {
    await wk.close(); await boss.close(); await bare.close();
  }
}

// ─── URL validation ───────────────────────────────────────────────────────────

async function testUrlValidation() {
  console.log("\n── identity URL validation ──");
  const bad = [
    ["?role=bogus", /unknown role 'bogus' — expected one of worker, reviewer, orchestrator, admin/],
    ["?role=worker&role=admin", /'role' given more than once/],
    ["?as=bad%20name", /invalid as 'bad name'/],
    ["?ns=a/b", /invalid ns 'a\/b'/],
    [`?as=${"x".repeat(65)}`, /invalid as/],
  ];
  for (const [q, re] of bad) {
    const r = await rawList(q);
    expect(r.status === 400 && re.test(r.text) && /Invalid MCP URL/.test(r.text) && /-32602/.test(r.text), `${q.slice(0, 40)} → 400 Invalid MCP URL, JSON-RPC -32602`, r);
  }
  let r = await rawList("?ns=foo");
  expect(r.status === 200 && r.text.includes("send_message"), "ns only (no role) is allowed and means role=admin", r.status);
  r = await rawList("?as=foo.bar-1_x");
  expect(r.status === 200, "as allows letters, digits, _ . -", r.status);
  r = await rawList("?role=");
  expect(r.status === 200, "empty role= is treated as absent", r.status);
  if (SECRET) {
    r = await rawList("?role=worker", { auth: false });
    expect(r.status === 401 || r.status === 403, "a role URL does not bypass the bearer token", r.status);
  }
}

// ─── no-role byte identity ────────────────────────────────────────────────────

async function testByteIdentity() {
  console.log("\n── no-role byte identity ──");
  const a = await rawList("");
  const b = await rawList("?role=admin");
  const body = (r) => r.text.slice(r.text.indexOf("{"));
  expect(body(a) !== body(b) && body(a).length < body(b).length, "tools/list with no params is the shorter pre-v3 list, not role=admin", [body(a).length, body(b).length]);
  // ns/as without a role are not an identity: same bytes as no query at all (watchdog sessions send ?ns=&as=).
  const c = await rawList("?ns=foo&as=bar");
  expect(body(c) === body(a), "?ns=&as= without a role is byte-identical to the bare no-role list", [body(c).length, body(a).length]);
  // The exact URL the watchdog generates by default (--print-channels mcp_query), not a hand-built one.
  const wd = spawnSync("bash", [join(ROOT, "watchdog.sh"), "backend", "--work-dir", tmpdir(), "--inbox-channel", `${NS}-backend`, "--print-channels"],
    { env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^WATCHDOG_/.test(k))), encoding: "utf8" });
  const q = /^mcp_query=(.*)$/m.exec(wd.stdout || "")?.[1];
  expect(wd.status === 0 && q === `ns=${NS}&as=backend`, "watchdog default MCP query is ns=&as= with no role", [wd.stdout, wd.stderr]);
  const w = await rawList(`?${q}`);
  expect(body(w) === body(a), "…and its raw tools/list response is byte-identical to the bare no-role response", [body(w).length, body(a).length]);
  const { client: wdc } = await connect("wd-default", `?${q}`);
  const wBody = JSON.stringify((await wdc.listTools()).tools);
  await wdc.close().catch(() => {});
  expect(wBody.length === V2_LIST_BYTES && createHash("sha256").update(wBody).digest("hex") === V2_LIST_SHA256,
    `watchdog-generated default URL -> tools/list byte-identical to the 5065c86 snapshot (${V2_LIST_BYTES} B)`, [wBody.length, createHash("sha256").update(wBody).digest("hex")]);
  // Opting in (role=) is what switches to the role list; identity defaults then show in the typed tools only.
  const TYPED = new Set(["dispatch_task", "post_result", "ask", "post_note", "post_plan", "decide_plan"]);
  const tools = (r) => JSON.parse(body(r).replace(/^data: /, "")).result.tools;
  const ta = tools(b), td = tools(await rawList("?role=admin&ns=foo&as=bar"));
  expect(JSON.stringify(ta.map(t => t.name)) === JSON.stringify(td.map(t => t.name)), "role=admin&ns=&as= lists the same tools in the same order as role=admin");
  const changed = ta.filter((t, i) => JSON.stringify(t) !== JSON.stringify(td[i])).map(t => t.name);
  expect(changed.every(n => TYPED.has(n)) && changed.length > 0, "…and only the typed tools differ (their schemas state the identity defaults)", changed);
  const a2 = await rawList("");
  expect(body(a) === body(a2), "…and stable across requests", [body(a).length, body(a2).length]);
}

async function main() {
  console.log(`[role-profiles] broker: ${BROKER_URL}  namespace: ${NS}`);
  const roles = { none: "", worker: "?role=worker", reviewer: "?role=reviewer", orchestrator: "?role=orchestrator", admin: "?role=admin" };
  const clients = {}, lists = {};
  for (const [k, q] of Object.entries(roles)) {
    clients[k] = (await connect(`profiles-${k}`, q)).client;
    lists[k] = (await clients[k].listTools()).tools;
  }
  try {
    await testToolSets(lists);
    await testBudgets(lists);
    await testShape(lists);
    await testHidden(clients.admin, clients);
    await testIdentity(clients.admin);
    await testUrlValidation();
    await testByteIdentity();
  } finally {
    await Promise.all(Object.values(clients).map(c => c.close().catch(() => {})));
  }
  console.log(`\n[role-profiles] ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error("[role-profiles] FATAL:", e); process.exit(1); });
