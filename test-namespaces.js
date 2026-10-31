// v3 namespace loader tests: base schemas, register_namespace / get_namespace, hot-reload,
// roles.<role>.summary_prefixes, v2 channel-schema precedence, warn-only vs strict, that every
// error names its field and its [source], and that replacing a plan-gated manifest needs admin_token. Exercises a live (scratch) broker over MCP.
// Safe to run multiple times — uses a unique namespace per run.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import "dotenv/config";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import Database from "better-sqlite3";
import Ajv from "ajv";

const BROKER_URL = process.env.BROKER_URL || "http://localhost:8080/mcp";
const SECRET     = process.env.SHARED_SECRET || "";
const RUN_TAG    = Date.now().toString(36);
const NS         = `tn${RUN_TAG}`;

async function connect(name) {
  const transport = new StreamableHTTPClientTransport(new URL(`${BROKER_URL}?role=admin`), {
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

const send = (client, channel, content, sender = "test-namespaces") =>
  call(client, "send_message", { channel, sender, content: JSON.stringify(content) });
const register = (client, manifest) => call(client, "register_namespace", { manifest: JSON.stringify(manifest) });
const accepted = (r) => !r.isError && /Sent #/.test(r.text) && !/WARN/.test(r.text);

const ch = (kind) => `${NS}-${kind}`;

function manifest(over = {}) {
  return {
    ns: NS,
    version: "3.0",
    strict: false,
    roles: { reviewer: { summary_prefixes: ["APPROVE", "ADVISE", "BLOCK"] } },
    workers: [
      { name: "boss", inbox: ch("boss"), role: "orchestrator" },
      { name: "wk",   inbox: ch("wk"),   role: "worker" },
      { name: "rev",  inbox: ch("rev"),  role: "reviewer" },
    ],
    channels: [
      { name: ch("status"), kind: "status", types: ["result", "status"] },
      { name: ch("wk"),     kind: "worker-inbox", types: ["task"] },
    ],
    ...over,
  };
}

const result = (over = {}) => ({
  type: "result", task_id: "t-0001", from: "wk", to: "boss", subject: "did the thing",
  summary: "PASS — did the thing", ...over,
});

// ─── base schemas ─────────────────────────────────────────────────────────────

async function testBase(client) {
  console.log("\n── base schemas loaded at boot ──");
  const r = await call(client, "get_namespace", {});
  expect(!r.isError, "get_namespace() with no ns lists namespaces", r.text);
  const m = /Base types: (.*)/.exec(r.text);
  const types = m ? m[1].split(", ") : [];
  for (const t of ["task", "result", "status", "question", "finding", "decision", "heartbeat", "approval-token", "deferred", "resolved"])
    expect(types.includes(t), `base type '${t}' is loaded`, types);
}

// ─── register_namespace rejects bad manifests ────────────────────────────────

async function testRegisterRejects(client) {
  console.log("\n── register_namespace rejections ──");
  let r = await call(client, "register_namespace", { manifest: "{not json" });
  expect(r.isError && /not valid JSON/.test(r.text), "malformed JSON rejected", r.text);

  r = await register(client, { ns: NS, workers: [] });
  expect(r.isError && /does not match manifest\.schema\.json/.test(r.text) && /channels/.test(r.text),
    "missing required 'channels' rejected, names the field and manifest.schema", r.text);

  r = await register(client, manifest({ channels: [{ name: "other-status", kind: "status", types: ["result"] }] }));
  expect(r.isError && /outside namespace/.test(r.text), "channel outside '<ns>-' rejected", r.text);

  r = await register(client, manifest({ channels: [{ name: ch("status"), kind: "status", types: ["nonesuch"] }] }));
  expect(r.isError && /unknown type 'nonesuch'/.test(r.text), "unknown channel type rejected", r.text);

  r = await register(client, manifest({ channels: [
    { name: ch("status"), kind: "status", types: ["result"] },
    { name: ch("status"), kind: "status", types: ["status"] },
  ] }));
  expect(r.isError && /declared twice/.test(r.text), "duplicate channel rejected", r.text);

  r = await register(client, manifest({ extensions: { nonesuch: { required: ["x"] } } }));
  expect(r.isError && /extensions\.nonesuch: unknown type/.test(r.text), "extension for unknown type rejected", r.text);

  r = await register(client, manifest({ local_types: { result: { required: ["x"] } } }));
  expect(r.isError && /shadows a base type/.test(r.text), "local type shadowing a base type rejected", r.text);

  r = await register(client, manifest({ roles: { janitor: { summary_prefixes: ["X"] } } }));
  expect(r.isError, "unknown role name rejected", r.text);

  r = await register(client, manifest({ roles: { reviewer: { summary_prefixes: ["lowercase"] } } }));
  expect(r.isError, "summary_prefixes must be upper-case tokens", r.text);

  r = await register(client, manifest({ extensions: { result: { patterns: { task_id: "([" } } } }));
  expect(r.isError && /does not compile/.test(r.text), "uncompilable fragment rejected", r.text);

  r = await call(client, "get_namespace", { ns: NS });
  expect(/No manifest registered/.test(r.text), "rejected manifests leave nothing registered", r.text);
}

// ─── base validation, error shape, hot-reload ────────────────────────────────

async function testValidationAndReload(client) {
  console.log("\n── validation against base + manifest ──");
  let r = await register(client, manifest());
  expect(!r.isError && /Registered namespace/.test(r.text), "valid manifest registered", r.text);
  expect(/All channels warn-only/.test(r.text) && /No v2 channel schemas shadow/.test(r.text),
    "registration reports warn-only and no v2 shadowing", r.text);

  r = await call(client, "get_namespace", { ns: NS });
  expect(new RegExp(`Active channels: ${ch("status")}, ${ch("wk")}`).test(r.text) && /Shadowed by v2 schema: \(none\)/.test(r.text),
    "get_namespace shows both channels active", r.text);
  expect(r.text.includes(`"ns":"${NS}"`) || r.text.includes(`"ns": "${NS}"`), "get_namespace returns the manifest JSON", r.text);

  r = await call(client, "get_namespace", {});
  expect(r.text.includes(NS), "get_namespace() lists the new namespace", r.text);

  r = await send(client, ch("status"), result());
  expect(accepted(r), "valid result accepted with no warn", r.text);

  // Error names the field and the source.
  r = await send(client, ch("status"), result({ summary: "done" }));
  expect(/WARN/.test(r.text) && /\/summary/.test(r.text) && /\[base\/result\]/.test(r.text),
    "bad summary: warn names /summary and [base/result]", r.text);
  expect(/Sent #/.test(r.text), "warn-only: mismatching message is still stored", r.text);
  expect(r.text.includes(`get_namespace('${NS}')`), "error points at get_namespace", r.text);

  const { summary, ...noSummary } = result();
  r = await send(client, ch("status"), noSummary);
  expect(/WARN/.test(r.text) && /\/summary/.test(r.text) && /\[base\/result\]/.test(r.text),
    "missing summary: warn names /summary and [base/result]", r.text);

  r = await send(client, ch("status"), result({ task_id: "x" }));
  expect(/\/task_id/.test(r.text) && /\[base\/result\]/.test(r.text), "task_id minLength: names /task_id and source", r.text);

  r = await send(client, ch("status"), { type: "task", task_id: "t-0002", from: "wk", to: "boss", subject: "no such type here" });
  expect(/WARN/.test(r.text) && /not accepted on/.test(r.text) && /result\|status/.test(r.text),
    "type not accepted on the channel: warn lists accepted types", r.text);

  r = await send(client, ch("status"), { task_id: "t-0003" });
  expect(/WARN/.test(r.text) && /\/type is required/.test(r.text), "missing type: warn says /type is required", r.text);

  let raw = await call(client, "send_message", { channel: ch("status"), sender: "test-namespaces", content: "plain text" });
  expect(/WARN/.test(raw.text) && /not valid JSON/.test(raw.text), "non-JSON content: warn says not valid JSON", raw.text);

  raw = await call(client, "send_message", { channel: ch("status"), sender: "test-namespaces", content: JSON.stringify([1, 2]) });
  expect(/WARN/.test(raw.text) && /JSON object envelope/.test(raw.text), "JSON array content: warn says object envelope required", raw.text);

  // A channel the manifest does not declare is not governed.
  r = await send(client, ch("undeclared"), { anything: true });
  expect(accepted(r), "undeclared channel in the namespace is not validated", r.text);

  console.log("\n── hot-reload: re-register changes behaviour with no restart ──");
  const idMsg = result({ task_id: "other-7" });
  r = await send(client, ch("status"), idMsg);
  expect(accepted(r), "before: task_id 'other-7' accepted", r.text);

  r = await register(client, manifest({ extensions: { result: { patterns: { task_id: `^${NS}-\\d+$` } } } }));
  expect(!r.isError, "manifest with a task_id pattern re-registered", r.text);
  r = await send(client, ch("status"), idMsg);
  expect(/WARN/.test(r.text) && /\/task_id/.test(r.text) && r.text.includes(`[manifest ${NS} extensions.result]`),
    "after: same message warns, naming /task_id and [manifest <ns> extensions.result]", r.text);
  r = await send(client, ch("status"), result({ task_id: `${NS}-12` }));
  expect(accepted(r), "after: conforming task_id accepted", r.text);

  r = await register(client, manifest());
  r = await send(client, ch("status"), idMsg);
  expect(accepted(r), "re-registering the loose manifest relaxes it again", r.text);

  // Extension fragments are ANDed with base: they cannot loosen it.
  r = await register(client, manifest({ extensions: { result: { properties: { summary: { type: "string" } } } } }));
  r = await send(client, ch("status"), result({ summary: "done" }));
  expect(/WARN/.test(r.text) && /\[base\/result\]/.test(r.text), "an extension cannot widen the base summary pattern", r.text);

  console.log("\n── channel-level, required, closed ──");
  r = await register(client, manifest({
    channels: [
      { name: ch("status"), kind: "status", types: ["result"], extensions: { result: { required: ["body"] } } },
      { name: ch("wk"), kind: "worker-inbox", types: ["task"] },
    ],
  }));
  r = await send(client, ch("status"), result());
  expect(/WARN/.test(r.text) && /\/body/.test(r.text) && r.text.includes(`[manifest ${NS} channel ${ch("status")} extensions.result]`),
    "channel extension 'required': names /body and the channel source", r.text);

  r = await register(client, manifest({ closed: true }));
  r = await send(client, ch("status"), result({ surprise: 1 }));
  expect(/WARN/.test(r.text) && /\/surprise is not allowed/.test(r.text) && r.text.includes(`[manifest ${NS} closed (result)]`),
    "closed: unknown field is 'not allowed' with the closed source", r.text);
  r = await send(client, ch("status"), result());
  expect(accepted(r), "closed: declared fields still pass", r.text);

  r = await register(client, manifest({ extensions: { result: { fields: ["task_id", "from", "to", "subject", "summary"] } } }));
  r = await send(client, ch("status"), result({ body: { x: 1 } }));
  expect(/\/body is not allowed/.test(r.text) && r.text.includes(`[manifest ${NS} fields (result)]`),
    "'fields' is an exact allow-list", r.text);
}

// ─── local types ──────────────────────────────────────────────────────────────

async function testLocalTypes(client) {
  console.log("\n── local_types ──");
  let r = await register(client, manifest({
    local_types: {
      ping:  { required: ["nonce"], properties: { nonce: { type: "string" } } },
      blob:  { envelope: false, required: ["blob"] },
    },
    channels: [{ name: ch("status"), kind: "status", types: ["ping", "blob"] }],
  }));
  expect(!r.isError, "manifest with local types registered", r.text);

  r = await send(client, ch("status"), { type: "ping", task_id: "t-0001", from: "wk", to: "boss", subject: "ping it", nonce: "n1" });
  expect(accepted(r), "local type with the implied envelope accepted", r.text);

  r = await send(client, ch("status"), { type: "ping", task_id: "t-0001", from: "wk", to: "boss", subject: "ping it" });
  expect(/WARN/.test(r.text) && /\/nonce/.test(r.text) && r.text.includes(`[manifest ${NS} local_types.ping]`),
    "local type: missing declared field names /nonce and the local_types source", r.text);

  r = await send(client, ch("status"), { type: "ping", nonce: "n1" });
  expect(/WARN/.test(r.text) && /\[base envelope\]/.test(r.text), "local type: missing envelope fields cite [base envelope]", r.text);

  r = await send(client, ch("status"), { type: "blob", blob: 1 });
  expect(accepted(r), "envelope:false local type needs no envelope fields", r.text);
}

// ─── role summary prefixes ────────────────────────────────────────────────────

async function testSummaryPrefixes(client) {
  console.log("\n── roles.<role>.summary_prefixes ──");
  let r = await register(client, manifest());
  expect(!r.isError, "manifest with reviewer prefixes registered", r.text);

  for (const p of ["APPROVE", "ADVISE", "BLOCK"]) {
    r = await send(client, ch("status"), result({ from: "rev", summary: `${p} — looks fine` }));
    expect(accepted(r), `reviewer may use ${p}`, r.text);
  }
  r = await send(client, ch("status"), result({ from: "rev", summary: "PASS — also fine" }));
  expect(accepted(r), "reviewer still may use PASS", r.text);

  r = await send(client, ch("status"), result({ from: "wk", summary: "APPROVE — looks fine" }));
  expect(/WARN/.test(r.text) && /\/summary/.test(r.text) && /\[base\/result\]/.test(r.text),
    "worker may NOT use APPROVE (prefix is role-scoped)", r.text);

  r = await send(client, ch("status"), result({ from: "boss", summary: "BLOCK — no" }));
  expect(/WARN/.test(r.text), "orchestrator may NOT use BLOCK", r.text);

  r = await send(client, ch("status"), result({ from: "stranger", summary: "APPROVE — hi" }));
  expect(/WARN/.test(r.text), "a sender with no declared role gets the base prefixes only", r.text);

  r = await send(client, ch("status"), result({ from: "rev", summary: "PARTIAL — half" }));
  expect(/WARN/.test(r.text), "a prefix the role does not list is rejected (PARTIAL)", r.text);

  r = await send(client, ch("status"), result({ from: "rev", summary: "APPROVED — typo" }));
  expect(/WARN/.test(r.text), "prefix match is word-bounded (APPROVED != APPROVE)", r.text);

  r = await send(client, ch("status"), result({ from: "rev", summary: "BLOCK — no", task_id: "x" }));
  expect(/\/task_id/.test(r.text) && r.text.includes("summary_prefixes"),
    "widened-validator errors cite '<base file> + manifest roles.<role>.summary_prefixes'", r.text);

  r = await register(client, manifest({ roles: { reviewer: { summary_prefixes: ["APPROVE"] } } }));
  r = await send(client, ch("status"), result({ from: "rev", summary: "BLOCK — no" }));
  expect(/WARN/.test(r.text), "hot-reload: dropping BLOCK from the manifest rejects it", r.text);
  r = await send(client, ch("status"), result({ from: "rev", summary: "APPROVE — ok" }));
  expect(accepted(r), "hot-reload: APPROVE still accepted", r.text);
}

// ─── strict ───────────────────────────────────────────────────────────────────

async function testStrict(client) {
  console.log("\n── warn-only vs strict ──");
  let r = await register(client, manifest({ strict: true }));
  expect(/strict=on/.test(r.text) && /Strict channels:/.test(r.text), "namespace strict=true reports strict channels", r.text);
  r = await send(client, ch("status"), result({ summary: "done" }));
  expect(r.isError && /schema validation failed/.test(r.text) && /\/summary/.test(r.text) && /\[base\/result\]/.test(r.text),
    "strict: mismatching message rejected, names field and source", r.text);
  r = await send(client, ch("status"), result());
  expect(accepted(r), "strict: valid message accepted", r.text);

  // Strict messages are not stored.
  const before = await call(client, "read_last", { channel: ch("status"), n: 1 });
  await send(client, ch("status"), result({ summary: "nope", subject: "should-not-store" }));
  const after = await call(client, "read_last", { channel: ch("status"), n: 1 });
  expect(before.text === after.text && !after.text.includes("should-not-store"), "strict: rejected message is not stored", after.text);

  r = await register(client, manifest({
    strict: false,
    channels: [
      { name: ch("status"), kind: "status", types: ["result"], strict: true },
      { name: ch("wk"), kind: "worker-inbox", types: ["task"] },
    ],
  }));
  expect(new RegExp(`Strict channels: ${ch("status")}$`, "m").test(r.text), "channel-level strict only flags that channel", r.text);
  r = await send(client, ch("status"), result({ summary: "done" }));
  expect(r.isError, "channel strict: rejects on the strict channel", r.text);
  r = await send(client, ch("wk"), { type: "task", from: "boss" });
  expect(!r.isError && /WARN/.test(r.text), "channel strict: sibling channel stays warn-only", r.text);

  r = await register(client, manifest({
    strict: true,
    channels: [{ name: ch("status"), kind: "status", types: ["result"], strict: false }],
  }));
  r = await send(client, ch("status"), result({ summary: "done" }));
  expect(!r.isError && /WARN/.test(r.text), "channel strict:false overrides namespace strict:true", r.text);

  // send_message_batch and REST honour manifests too.
  r = await register(client, manifest({ strict: true }));
  const b = await call(client, "send_message_batch", { messages: [
    { channel: ch("status"), sender: "test-namespaces", content: JSON.stringify(result()) },
    { channel: ch("status"), sender: "test-namespaces", content: JSON.stringify(result({ summary: "done" })) },
  ] });
  expect(b.isError && /schema validation failed/.test(b.text) && /message 2\/2/.test(b.text), "batch: strict failure on message 2 rejects the batch", b.text);

  const res = await fetch(BROKER_URL.replace(/\/mcp$/, "/messages"), {
    method: "POST",
    headers: { "content-type": "application/json", ...(SECRET ? { authorization: `Bearer ${SECRET}` } : {}) },
    body: JSON.stringify({ channel: ch("status"), sender: "test-namespaces", content: result({ summary: "done" }) }),
  });
  expect(res.status === 400, "REST POST /messages: strict manifest mismatch → 400", res.status);
}

// ─── v2 precedence ────────────────────────────────────────────────────────────

async function testV2Precedence(client) {
  console.log("\n── v2 channel schema takes precedence ──");
  let r = await register(client, manifest({ strict: true }));
  r = await send(client, ch("status"), result({ summary: "done" }));
  expect(r.isError, "baseline: manifest rejects the bad summary", r.text);

  // A deliberately permissive v2 schema on the same channel.
  const permissive = { type: "object", required: ["type"], properties: { type: { type: "string" } } };
  r = await call(client, "register_channel_schema", { channel: ch("status"), schema: JSON.stringify(permissive), strict: true });
  expect(!r.isError && /Registered schema/.test(r.text), "v2 schema registered on a manifest channel", r.text);

  r = await send(client, ch("status"), result({ summary: "done" }));
  expect(accepted(r), "v2 schema wins: message the manifest would reject is accepted", r.text);

  // And a strict v2 schema's own errors are v2-shaped, not manifest-shaped.
  r = await send(client, ch("status"), { no_type: true });
  expect(r.isError && /schema validation failed/.test(r.text) && !/\[base\//.test(r.text) && !/\[manifest/.test(r.text),
    "v2 errors carry no manifest/base source tags", r.text);

  r = await register(client, manifest({ strict: true }));
  expect(new RegExp(`v2 schema still registered.*${ch("status")}`).test(r.text), "register_namespace reports the shadowed channel", r.text);
  r = await call(client, "get_namespace", { ns: NS });
  expect(new RegExp(`Shadowed by v2 schema: ${ch("status")}`).test(r.text) && new RegExp(`Active channels: ${ch("wk")}`).test(r.text),
    "get_namespace splits active vs shadowed", r.text);

  // The sibling channel without a v2 schema is still governed by the manifest.
  r = await send(client, ch("wk"), { type: "task", from: "boss" });
  expect(r.isError && /\[base\/task\]/.test(r.text), "unshadowed sibling still validated by the manifest", r.text);

  r = await call(client, "clear_channel_schema", { channel: ch("status") });
  expect(!r.isError, "clear_channel_schema removes the v2 schema", r.text);
  r = await send(client, ch("status"), result({ summary: "done" }));
  expect(r.isError && /\[base\/result\]/.test(r.text), "after clear: manifest governs the channel again (hot, no restart)", r.text);
  r = await call(client, "get_namespace", { ns: NS });
  expect(/Shadowed by v2 schema: \(none\)/.test(r.text), "after clear: nothing shadowed", r.text);
}

async function cleanup(client) {
  for (const k of ["status", "wk", "undeclared"]) {
    await call(client, "clear_channel_schema", { channel: ch(k) });
    await call(client, "purge_channel", { channel: ch(k) });
  }
}

// ─── a plan-gated manifest is only replaced with a credential (review-6 #2) ─────
// role=admin is self-asserted and the plan gate reads the manifest, so a worker could turn plan_gate off.
// The run-tests broker has ADMIN_SECRET and no orchestrator trust (enforcement off).
async function testManifestCredential(client) {
  console.log("\n── register_namespace: plan-gated manifest needs admin_token ──");
  const G = `${NS}g`, gch = (k) => `${G}-${k}`;
  const gated = (plan_gate) => ({ ns: G, version: "3.0", strict: false, plan_gate,
    workers: [{ name: "boss", inbox: gch("boss"), role: "orchestrator" }, { name: "wk", inbox: gch("wk"), role: "worker" }],
    channels: [{ name: gch("status"), kind: "status", types: ["result", "status", "plan"] }, { name: gch("wk"), kind: "worker-inbox", types: ["task", "plan-decision"] }] });
  let r = await register(client, gated(true));
  expect(!r.isError, "first registration of a plan-gated namespace: no token needed", r.text);
  r = await register(client, gated(false));
  expect(r.isError && /guarded because its registered manifest has plan_gate: true/.test(r.text) && /admin_token/.test(r.text),
    "replacing it with plan_gate off, no token: refused, naming admin_token", r.text);
  r = await call(client, "get_namespace", { ns: G });
  expect(/"plan_gate":\s*true/.test(r.text), "... and the registered manifest still has plan_gate: true", r.text.slice(-300));
  r = await call(client, "register_namespace", { manifest: JSON.stringify(gated(false)), admin_token: "not-the-admin-secret" });
  expect(r.isError && /guarded/.test(r.text), "wrong admin_token: refused", r.text);
  if (process.env.ADMIN_SECRET) {
    r = await call(client, "register_namespace", { manifest: JSON.stringify(gated(false)), admin_token: process.env.ADMIN_SECRET });
    expect(!r.isError, "with admin_token: accepted", r.text);
    r = await register(client, gated(false));
    expect(!r.isError, "once plan_gate is off, re-registering needs no token (non-guarded namespaces unchanged)", r.text);
  } else console.log("  - ADMIN_SECRET not set: admin_token acceptance cases skipped");
}

// ─── pg manifest (schemas/manifests/pg.json) ──────────────────────────────────

// One message per channel/type that pg's v2 schemas accept; none may warn under the manifest.
const PG_V2_VALID = [
  ["pg-orchestrator", { type: "question", task_id: "pg-2026-10-29-x", from: "core", to: "orchestrator", subject: "which option", body: "A or B?" }],
  ["pg-orchestrator", { type: "status", task_id: "pg-2026-10-29-x", from: "devops", to: "orchestrator", subject: "progress", body: { done: 1 } }],
  ["pg-control", { type: "sprint-start", task_id: "pg-2026-10-29-s", sprint_id: "s1", from: "orchestrator", to: "*", subject: "sprint one" }],
  ["pg-control", { type: "rotate", task_id: "pg-2026-10-29-r", from: "orchestrator", to: "core", subject: "rotate now" }],
  ["pg-status", { type: "result", task_id: "pg-2026-10-29-x", from: "core", to: "orchestrator", subject: "did it", summary: "PASS — did it",
    body: { commits: [{ sha: "abc1234", branch: "worker/core", message: "m" }], consent_basis: "orchestrator-dispatch-only" }, affected_files: ["a.js"] }],
  ["pg-status", { type: "result", task_id: "pg-2026-10-29-y", from: "reviewer", to: "orchestrator", subject: "reviewed", summary: "APPROVE — 0 blocking" }],
  ["pg-status", { type: "handoff", task_id: "pg-2026-10-29-x", from: "core", to: "orchestrator", subject: "rotating", body: { done: "a", pending: "b" } }],
  ["pg-telemetry", { type: "heartbeat", from: "core", ts: new Date().toISOString(),
    context: { size_tokens: 1000, tier_threshold_pct: 50, rotation_recommended: false }, activity: { state: "working" } }],
  ["pg-core", { type: "task", task_id: "pg-2026-10-29-t", from: "orchestrator", to: "core", subject: "do the thing", body: "what and why",
    context: "why", background: "more", scope: "small", files: { read: ["a"], write: ["b"] },
    constraints: ["no x"], required_checks: ["test"], acceptance_criteria: ["works"],
    checks: [{ name: "test", run: "npm test", pass_condition: "passes" }] }],
  ["pg-devops", { type: "note", task_id: "pg-2026-10-29-n", from: "orchestrator", to: "devops", subject: "fyi" }],
  ["pg-reviewer", { type: "task", task_id: "pg-2026-10-29-rv", from: "orchestrator", to: "reviewer", subject: "review it",
    body: { base: "main", head: "worker/core", checklist: ["tests"] } }],
];

async function testPgManifest(client) {
  console.log("\n── pg manifest: shape, v2-valid traffic, real-message replay ──");
  if (/:8080\b/.test(BROKER_URL)) { console.log("  (skipped: refusing to register the real pg namespace on port 8080)"); return; }
  const manifestPath = "schemas/manifests/pg.json";
  const pg = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const asNames = pg.workers.map(w => `${w.name}:${w.inbox}:${w.role}`).sort();
  expect(JSON.stringify(asNames) === JSON.stringify(["core:pg-core:worker", "devops:pg-devops:worker", "orchestrator:pg-orchestrator:orchestrator", "reviewer:pg-reviewer:reviewer"]),
    "pg workers: as= name is the inbox minus 'pg-', reviewer has role reviewer", asNames);
  expect(pg.strict === false, "pg manifest is warn-only (strict false)");

  const setup = readFileSync("setup-schemas-pg.js", "utf-8");
  const v2Channels = [...setup.matchAll(/channel:\s*"(pg-[a-z-]+)"/g)].map(m => m[1]).sort();
  expect(JSON.stringify(v2Channels) === JSON.stringify(pg.channels.map(c => c.name).sort()),
    "pg manifest declares exactly the channels setup-schemas-pg.js registers", v2Channels);

  let r = await register(client, pg);
  expect(!r.isError, "pg.json registers", r.text);

  for (const [channel, msg] of PG_V2_VALID) {
    r = await send(client, channel, msg, msg.from);
    expect(accepted(r), `v2-valid ${msg.type} on ${channel} accepted with no warning`, r.text);
  }

  const src = process.env.PG_REPLAY_DB || join(process.env.HOME || "", "myprojects/claude-broker-oss/broker.db");
  if (!existsSync(src)) { console.log(`  (real-message replay skipped: no DB at ${src}; set PG_REPLAY_DB)`); return; }
  const dir = mkdtempSync(join(tmpdir(), "pg-replay-"));
  try {
    const ro = new Database(src, { readonly: true, fileMustExist: true });
    await ro.backup(join(dir, "copy.db"));
    ro.close();
    const copy = new Database(join(dir, "copy.db"), { readonly: true });
    const rows = copy.prepare("SELECT channel, sender, content FROM messages WHERE channel LIKE 'pg-%' ORDER BY id DESC LIMIT 50").all().reverse();
    copy.close();
    // channel -> the v2 schema setup-schemas-pg.js registers for it
    const v2File = Object.fromEntries([...setup.matchAll(/channel:\s*"(pg-[a-z-]+)",\s*file:\s*"([^"]+)"/g)].map(m => [m[1], m[2]]));
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
    const v2 = {};
    const v2Valid = (channel, content) => {
      v2[channel] ??= ajv.compile(JSON.parse(readFileSync(v2File[channel], "utf-8")));
      return v2[channel](JSON.parse(content));
    };
    let rejected = 0, warned = 0, regressions = 0;
    for (const row of rows) {
      const rr = await call(client, "send_message", { channel: row.channel, sender: row.sender, content: row.content });
      if (rr.isError) { rejected++; console.error(`     rejected ${row.channel}: ${rr.text.slice(0, 200)}`); }
      else if (/WARN/.test(rr.text)) {
        warned++;
        const parity = !v2Valid(row.channel, row.content);   // v2 flags it too: not a manifest regression
        if (!parity) regressions++;
        console.log(`     warn ${row.channel} (${parity ? "v2 warns too" : "v2 ACCEPTS"}): ${rr.text.replace(/^.*\[WARN/, "[WARN").slice(0, 160)}`);
      }
    }
    console.log(`  replayed ${rows.length} real pg messages: rejected=${rejected} warned=${warned} (manifest-only warnings=${regressions})`);
    expect(rejected === 0, `real pg replay (${rows.length} messages): zero rejections`);
    expect(regressions === 0, `real pg replay: every warning is one the v2 schema raises too (no manifest-only warnings)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[test-namespaces]  broker=${BROKER_URL}  ns=${NS}`);
  const { client, transport } = await connect("test-namespaces");
  try {
    await testBase(client);
    await testRegisterRejects(client);
    await testValidationAndReload(client);
    await testLocalTypes(client);
    await testSummaryPrefixes(client);
    await testStrict(client);
    await testV2Precedence(client);
    await testManifestCredential(client);
    await testPgManifest(client);
  } finally {
    await cleanup(client);
    await transport.close();
  }

  console.log(`\n──────────────────────────────────────────────────────`);
  console.log(`[test-namespaces]  passed=${passed}  failed=${failed}`);
  if (failed === 0) console.log("  ALL TESTS PASSED");
  else { console.error("  SOME TESTS FAILED"); process.exitCode = 1; }
}

main().catch(e => { console.error("[test-namespaces] FATAL:", e); process.exit(1); });
