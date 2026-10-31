// Typed protocol tools: dispatch_task, post_result, ask, post_note.
// Happy path per tool (envelope shape and routing from the manifest), role summary-prefix
// rejection, namespace resolution errors, field/source error format, rejection of schema errors on
// a warn-only manifest, size cap, and ledger parity with hand-written send_message envelopes.
// Exercises a live (scratch) broker over MCP. Safe to run multiple times — unique namespaces per run.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import "dotenv/config";

const BROKER_URL = process.env.BROKER_URL || "http://localhost:8080/mcp";
const SECRET     = process.env.SHARED_SECRET || "";
const RUN_TAG    = Date.now().toString(36);
const NS         = `tt${RUN_TAG}`;
const NS2        = `tu${RUN_TAG}`; // second namespace sharing a worker name, for ambiguity
const UNIQ      = `only${RUN_TAG}`; // a worker name declared by exactly one manifest

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

const ch = (kind, ns = NS) => `${ns}-${kind}`;
const idOf = (text) => Number(/Sent #(\d+)/.exec(text)?.[1] ?? NaN);

function manifest(ns, workers) {
  return {
    ns,
    version: "3.0",
    strict: false,
    roles: { reviewer: { summary_prefixes: ["APPROVE", "ADVISE", "BLOCK"] } },
    workers: workers.map(([name, role]) => ({ name, inbox: `${ns}-${name}`, role })),
    channels: [
      ...workers.map(([name, role]) => ({ name: `${ns}-${name}`, kind: role === "orchestrator" ? "orchestrator-inbox" : "worker-inbox", types: role === "orchestrator" ? ["result", "question", "status"] : ["task"] })),
      { name: `${ns}-status`, kind: "status", types: ["result", "status", "question"] },
      { name: `${ns}-notes`,  kind: "notes",  types: ["finding", "decision", "resolved"] },
    ],
  };
}

// The stored JSON of message #id on a channel.
async function stored(client, channel, id) {
  const r = await call(client, "read_messages", { channel, since_id: id - 1, limit: 1 });
  const line = r.text.split("\n").find(l => l.startsWith(`[#${id}]`));
  const json = line?.slice(line.indexOf("{"));
  try { return JSON.parse(json); } catch { return null; }
}

// ─── setup ────────────────────────────────────────────────────────────────────

async function setup(admin) {
  console.log("\n── setup: two manifests ──");
  let r = await call(admin, "register_namespace", { manifest: JSON.stringify(manifest(NS, [["boss", "orchestrator"], ["wk", "worker"], ["rev", "reviewer"], [UNIQ, "worker"]])) });
  expect(!r.isError && /Registered namespace/.test(r.text), "namespace registered", r.text);
  // NS2 declares 'wk' as a worker too, so a bare sender 'wk' resolves to two namespaces.
  r = await call(admin, "register_namespace", { manifest: JSON.stringify(manifest(NS2, [["boss2", "orchestrator"], ["wk", "worker"]])) });
  expect(!r.isError && /Registered namespace/.test(r.text), "second namespace registered", r.text);
}

// ─── dispatch_task ────────────────────────────────────────────────────────────

async function testDispatch(admin) {
  console.log("\n── dispatch_task ──");
  const r = await call(admin, "dispatch_task", {
    ns: NS, to: "wk", task_id: `${NS}-t1`, subject: "build the thing", body: "do it",
    context: "why", scope: "small", files: { write: ["a.js"] }, constraints: ["no x"],
    checks: [{ name: "test", run: "node t.js", pass_condition: "exit 0" }], acceptance_criteria: ["works"],
  });
  expect(!r.isError && /Sent #\d+ to '[^']*-wk' as 'boss' \(type:task/.test(r.text), "happy path: lands on the worker inbox, sender defaults to the manifest orchestrator", r.text);
  expect(r.text.includes(`'${ch("wk")}'`), "channel comes from the manifest worker inbox", r.text);
  const msg = await stored(admin, ch("wk"), idOf(r.text));
  expect(msg?.type === "task" && msg.from === "boss" && msg.to === "wk" && msg.subject === "build the thing" && msg.task_id === `${NS}-t1`,
    "stored envelope: type/from/to/subject/task_id filled", msg);
  expect(msg?.scope === "small" && msg.files?.write?.[0] === "a.js" && msg.checks?.[0]?.name === "test" && msg.body === "do it",
    "optional fields carried through verbatim", msg);
  expect(msg && !("background" in msg) && !("depends_on" in msg), "unset optionals are omitted, not null", Object.keys(msg || {}));

  let e = await call(admin, "dispatch_task", { ns: NS, to: "ghost", task_id: `${NS}-t2`, subject: "s", body: "b" });
  expect(e.isError && /^dispatch_task: to: 'ghost' is not a worker in manifest /.test(e.text) && /\[manifest .* workers\]/.test(e.text) && e.text.includes("boss, wk, rev"),
    "unknown worker: names the field, lists the manifest's workers, cites its source", e.text);

  e = await call(admin, "dispatch_task", { ns: NS, to: "wk", from: "boss", task_id: `${NS}-t3`, subject: "s", body: "b", scope: "huge" });
  expect(e.isError, "scope outside small|medium|large rejected at the tool boundary", e.text);

}

// ─── post_result ──────────────────────────────────────────────────────────────

async function testResult(admin) {
  console.log("\n── post_result ──");
  const r = await call(admin, "post_result", {
    ns: NS, sender: "wk", task_id: `${NS}-t1`, summary: "PASS — built it", affected_files: ["a.js"],
    body: { required_checks: { test: "PASS" } },
  });
  expect(!r.isError && r.text.includes(`'${ch("status")}' as 'wk'`) && /type:result/.test(r.text), "happy path: result lands on <ns>-status", r.text);
  const msg = await stored(admin, ch("status"), idOf(r.text));
  expect(msg?.type === "result" && msg.from === "wk" && msg.to === "boss" && msg.subject === "build the thing",
    "type/from set; to defaults to the orchestrator; subject copied from the dispatched task", msg);
  expect(msg?.summary === "PASS — built it" && msg.affected_files?.[0] === "a.js", "summary and affected_files carried", msg);

  let e = await call(admin, "post_result", { ns: NS, sender: "wk", task_id: `${NS}-nodispatch`, summary: "PASS — x" });
  expect(e.isError && /^post_result: subject: required — no type:task '[^']*-nodispatch' with a subject on /.test(e.text) && /\[base\/result\]/.test(e.text),
    "no dispatched task and no subject: error names subject and its source", e.text);
  e = await call(admin, "post_result", { ns: NS, sender: "wk", task_id: `${NS}-nodispatch`, summary: "PASS — x", subject: "explicit" });
  expect(!e.isError, "explicit subject covers a task that was never dispatched", e.text);

  e = await call(admin, "post_result", { ns: NS, sender: "wk", task_id: `${NS}-t1`, summary: "PASS — c", body: { commits: [{ sha: "abc", branch: "b", message: "m" }] } });
  expect(e.isError && /rejected on '[^']*-status'/.test(e.text) && /affected_files/.test(e.text),
    "schema error rejected even though the manifest is warn-only (commits without affected_files)", e.text);
  expect(!/\[v2 schema/.test(e.text), "no v2-schema hint on a manifest channel", e.text);

  e = await call(admin, "post_result", { ns: NS, sender: "wk", task_id: `${NS}-t1`, summary: "PASS — p", body: { production_touching: true }, affected_files: [] });
  expect(e.isError && /consent_basis/.test(e.text), "production_touching without consent_basis rejected", e.text);

  e = await call(admin, "post_result", { ns: NS, sender: "nobody", task_id: `${NS}-t1`, summary: "PASS — x" });
  expect(e.isError && /^post_result: sender: 'nobody' is not a worker in manifest /.test(e.text), "unknown sender rejected naming the field", e.text);
}

// ─── role prefixes ────────────────────────────────────────────────────────────

async function testPrefixes(admin) {
  console.log("\n── role summary prefixes ──");
  let e = await call(admin, "post_result", { ns: NS, sender: "wk", task_id: `${NS}-t1`, summary: "APPROVE — looks fine" });
  expect(e.isError && /summary: prefix 'APPROVE' is not allowed for 'wk' \(role worker\); allowed: PASS\|FAIL\|SKIP \[base\/result\]/.test(e.text),
    "worker may not post APPROVE; error lists the allowed prefixes and base/result as source", e.text);

  for (const p of ["APPROVE", "ADVISE", "BLOCK", "PASS", "FAIL", "SKIP"]) {
    const r = await call(admin, "post_result", { ns: NS, sender: "rev", task_id: `${NS}-t1`, summary: `${p} — verdict`, subject: "review" });
    expect(!r.isError, `reviewer may post ${p}`, r.text);
  }
  e = await call(admin, "post_result", { ns: NS, sender: "rev", task_id: `${NS}-t1`, summary: "PARTIAL — half", subject: "review" });
  expect(e.isError && /allowed: PASS\|FAIL\|SKIP\|APPROVE\|ADVISE\|BLOCK/.test(e.text) && /roles\.reviewer\.summary_prefixes/.test(e.text),
    "reviewer prefix not in the manifest list rejected; source names roles.reviewer.summary_prefixes", e.text);

  e = await call(admin, "post_result", { ns: NS, sender: "wk", task_id: `${NS}-t1`, summary: "PASSED — close but no" });
  expect(e.isError && /prefix 'PASSED'/.test(e.text), "prefix match is on a word boundary (PASSED is not PASS)", e.text);
  e = await call(admin, "post_result", { ns: NS, sender: "wk", task_id: `${NS}-t1`, summary: "all good" });
  expect(e.isError && /prefix 'all'/.test(e.text), "free-text summary rejected", e.text);
}

// ─── ask ──────────────────────────────────────────────────────────────────────

async function testAsk(admin) {
  console.log("\n── ask ──");
  const tid = `${NS}-q1`;
  const r = await call(admin, "ask", { ns: NS, sender: "wk", task_id: tid, question: "Which branch should I use?", body: { options: ["a", "b"] } });
  expect(!r.isError && r.text.includes(`'${ch("status")}' as 'wk'`) && /type:question/.test(r.text), "happy path: question lands on <ns>-status", r.text);
  const msg = await stored(admin, ch("status"), idOf(r.text));
  expect(msg?.type === "question" && msg.from === "wk" && msg.to === "boss" && msg.subject === "Which branch should I use?",
    "type/from/to filled; subject defaults to the question", msg);
  expect(msg?.body?.question === "Which branch should I use?" && msg.body.options?.length === 2, "body carries the question and extra fields", msg);
  expect(msg && !("expected_reply_channel" in msg.body), "reply channel omitted when the inbox is the default <ns>-<sender>", msg?.body);

  const oq = await call(admin, "open_questions", { prefix: `${NS}-` });
  expect(oq.text.includes(tid), "open_questions lists it", oq.text);

  await call(admin, "send_message", { channel: ch("wk"), sender: "boss", content: JSON.stringify({ type: "note", task_id: tid, from: "boss", to: "wk", subject: "answer", body: "use main" }) });
  const oq2 = await call(admin, "open_questions", { prefix: `${NS}-` });
  expect(!oq2.text.includes(tid), "a reply naming the task_id on the asker's inbox closes it", oq2.text);

  const long = "q".repeat(200);
  const r2 = await call(admin, "ask", { ns: NS, sender: "wk", task_id: `${NS}-q2`, question: long });
  const m2 = await stored(admin, ch("status"), idOf(r2.text));
  expect(m2?.subject?.length === 120 && m2.subject.endsWith("…"), "long question clipped to 120 chars in the subject", m2?.subject?.length);

  const r3 = await call(admin, "ask", { ns: NS, sender: "wk", task_id: `${NS}-q3`, question: "where?", expected_reply_channel: ch("boss") });
  const m3 = await stored(admin, ch("status"), idOf(r3.text));
  expect(m3?.body?.expected_reply_channel === ch("boss"), "explicit expected_reply_channel recorded", m3);
}

// ─── post_note ────────────────────────────────────────────────────────────────

async function testNote(admin) {
  console.log("\n── post_note ──");
  const r = await call(admin, "post_note", { ns: NS, sender: "wk", kind: "finding", subject: "a finding", summary: "the claim is a longer sentence", scope: ["lib/x.js"], evidence: "cmd", confidence: "confirmed" });
  expect(!r.isError && r.text.includes(`'${ch("notes")}' as 'wk'`) && /type:finding/.test(r.text), "finding lands on <ns>-notes", r.text);
  const fid = idOf(r.text);
  const msg = await stored(admin, ch("notes"), fid);
  expect(msg?.type === "finding" && msg.from === "wk" && msg.to === "*" && msg.scope?.[0] === "lib/x.js" && msg.confidence === "confirmed",
    "finding: to defaults to '*', fields carried", msg);

  const d = await call(admin, "post_note", { ns: NS, sender: "boss", kind: "decision", subject: "a decision", summary: "we will do X from now on", scope: ["lib"] });
  expect(!d.isError && /type:decision/.test(d.text), "decision posted", d.text);

  const res = await call(admin, "post_note", { ns: NS, sender: "wk", kind: "resolved", subject: "closing", ref_id: fid, outcome: "fixed" });
  expect(!res.isError && /type:resolved/.test(res.text), "resolved posted", res.text);
  const rm = await stored(admin, ch("notes"), idOf(res.text));
  expect(rm && !("to" in rm) && rm.ref_id === fid && rm.outcome === "fixed", "resolved: no implied 'to'; ref_id/outcome carried", rm);

  let e = await call(admin, "post_note", { ns: NS, sender: "wk", kind: "finding", subject: "no summary" });
  expect(e.isError && /rejected on '[^']*-notes'/.test(e.text), "finding without summary/scope rejected by base", e.text);
  e = await call(admin, "post_note", { ns: NS, sender: "wk", kind: "resolved", subject: "no ref" });
  expect(e.isError && /rejected on '[^']*-notes'/.test(e.text), "resolved without ref_id/outcome rejected by base", e.text);
  e = await call(admin, "post_note", { ns: NS, sender: "wk", kind: "finding", subject: "s", summary: "a summary long enough", scope: ["x"], confidence: "maybe" });
  expect(e.isError, "confidence outside confirmed|suspected rejected", e.text);
  e = await call(admin, "post_note", { ns: NS, sender: "wk", kind: "rumour", subject: "s" });
  expect(e.isError, "unknown kind rejected", e.text);
}

// ─── namespace resolution ─────────────────────────────────────────────────────

async function testNsResolution(admin) {
  console.log("\n── namespace resolution ──");
  let e = await call(admin, "post_note", { ns: "nosuchns", sender: "wk", kind: "finding", subject: "s", summary: "a summary long enough", scope: ["x"] });
  expect(e.isError && /^post_note: ns: no manifest registered for 'nosuchns' \[register_namespace\]$/.test(e.text), "explicit unknown ns: exact error text", e.text);

  e = await call(admin, "post_note", { sender: "stranger", kind: "finding", subject: "s", summary: "a summary long enough", scope: ["x"] });
  expect(e.isError && /^post_note: ns: cannot resolve — pass ns, a task_id '<ns>-…', or a sender declared in a manifest's workers \[manifest lookup\]$/.test(e.text),
    "no ns, no task_id prefix, sender in no manifest: cannot resolve", e.text);

  e = await call(admin, "post_note", { sender: "wk", kind: "finding", subject: "s", summary: "a summary long enough", scope: ["x"] });
  expect(e.isError && /ns: sender 'wk' is a worker in .*, .*; pass ns \[manifest workers\]/.test(e.text) && e.text.includes(NS) && e.text.includes(NS2),
    "sender declared in two manifests: ambiguity error names both", e.text);

  let r = await call(admin, "post_note", { sender: "wk", task_id: `${NS2}-t9`, kind: "finding", subject: "via task_id", summary: "a summary long enough", scope: ["x"] });
  expect(!r.isError && r.text.includes(`'${ch("notes", NS2)}'`), "ns resolved from the task_id prefix", r.text);

  r = await call(admin, "post_note", { sender: UNIQ, kind: "finding", subject: "via sender", summary: "a summary long enough", scope: ["x"] });
  expect(!r.isError && r.text.includes(`'${ch("notes")}'`), "ns resolved from the one manifest that declares the sender", r.text);

  e = await call(admin, "post_note", { sender: "wk", task_id: "unregistered-t1", ns: undefined, kind: "finding", subject: "s", summary: "a summary long enough", scope: ["x"] });
  expect(e.isError && /ns: sender 'wk' is a worker in/.test(e.text), "task_id prefix naming no manifest falls through to the sender lookup", e.text);

  // A manifest with no orchestrator: defaults for 'to' have nothing to point at.
  const NS3 = `tv${RUN_TAG}`;
  await call(admin, "register_namespace", { manifest: JSON.stringify(manifest(NS3, [["solo", "worker"]])) });
  e = await call(admin, "ask", { ns: NS, sender: "wk", task_id: `${NS}-q0`, question: "q?" });
  expect(e.isError && /rejected on .*subject must NOT have fewer than 3 characters/.test(e.text), "short question: base subject minimum surfaces as a rejection", e.text);
  e = await call(admin, "ask", { ns: NS3, sender: "solo", task_id: `${NS3}-q`, question: "anyone?" });
  expect(e.isError && /^ask: to: manifest [^ ]+ has no orchestrator-role worker to default to; pass it \[manifest [^ ]+ workers\]$/.test(e.text), "no orchestrator in the manifest: 'to' error", e.text);
  r = await call(admin, "ask", { ns: NS3, sender: "solo", task_id: `${NS3}-q`, question: "anyone?", to: "solo" });
  expect(!r.isError, "passing 'to' explicitly covers it", r.text);

  // A channel the manifest does not declare.
  const NS4 = `tw${RUN_TAG}`;
  const m4 = manifest(NS4, [["boss", "orchestrator"], ["wk", "worker"]]);
  m4.channels = m4.channels.filter(c => c.kind !== "notes");
  await call(admin, "register_namespace", { manifest: JSON.stringify(m4) });
  e = await call(admin, "post_note", { ns: NS4, sender: "wk", kind: "finding", subject: "s", summary: "a summary long enough", scope: ["x"] });
  expect(e.isError && new RegExp(`^post_note: channel: manifest ${NS4} declares no '${NS4}-notes' channel \\[manifest ${NS4} channels\\]$`).test(e.text),
    "channel not declared by the manifest: exact error text", e.text);
}

// ─── ledger parity ────────────────────────────────────────────────────────────

async function testParity(admin) {
  console.log("\n── ledger parity with raw send_message ──");
  const NSP = `tp${RUN_TAG}`;
  await call(admin, "register_namespace", { manifest: JSON.stringify(manifest(NSP, [["boss", "orchestrator"], ["wk", "worker"]])) });
  const typedId = `${NSP}-typed`, rawId = `${NSP}-raw`;

  await call(admin, "dispatch_task", { ns: NSP, to: "wk", task_id: typedId, subject: "same subject", body: "b" });
  await call(admin, "send_message", { channel: `${NSP}-wk`, sender: "boss", content: JSON.stringify({ type: "task", task_id: rawId, from: "boss", to: "wk", subject: "same subject", body: "b" }) });
  const stat = async (id, sum) => call(admin, "post_result", { ns: NSP, sender: "wk", task_id: id, summary: sum });
  await call(admin, "ask", { ns: NSP, sender: "wk", task_id: typedId, question: "which way is up?" });
  await call(admin, "send_message", { channel: `${NSP}-status`, sender: "wk", content: JSON.stringify({ type: "question", task_id: rawId, from: "wk", to: "boss", subject: "which way is up?", body: { question: "which way is up?" } }) });

  const ledger = async () => JSON.parse((await call(admin, "get_task_ledger", { status_channel: `${NSP}-status`, prefix: `${NSP}-` })).text);
  const strip = (t) => ({ worker: t.worker, subject: t.subject, state: t.state, scope: t.scope, open: !!t.open_question, q: t.open_question?.question ?? t.open_question?.subject ?? null });
  let led = await ledger();
  const a = led.tasks.find(t => t.task_id === typedId), b = led.tasks.find(t => t.task_id === rawId);
  expect(a && b && JSON.stringify(strip(a)) === JSON.stringify(strip(b)), "dispatch + ask vs raw: identical ledger rows (blocked, same worker/subject)", [strip(a || {}), strip(b || {})]);
  expect(a?.state === "blocked", "typed ask shows the task as blocked", a);

  await stat(typedId, "PASS — done");
  await call(admin, "send_message", { channel: `${NSP}-status`, sender: "wk", content: JSON.stringify({ type: "result", task_id: rawId, from: "wk", to: "boss", subject: "same subject", summary: "PASS — done" }) });
  led = await ledger();
  const a2 = led.tasks.find(t => t.task_id === typedId), b2 = led.tasks.find(t => t.task_id === rawId);
  expect(a2?.state === "done" && b2?.state === "done" && a2.summary === b2.summary, "post_result vs raw result: both done with the same summary", [a2?.state, b2?.state]);

  const oq = await call(admin, "open_questions", { prefix: `${NSP}-` });
  expect(!oq.text.includes(typedId) && !oq.text.includes(rawId), "a posted result closes both questions", oq.text);

  const typedMsg = (await call(admin, "read_messages", { channel: `${NSP}-status`, since_id: 0, filter_type: "result" })).text.split("\n").filter(l => l.startsWith("[#")).map(l => JSON.parse(l.slice(l.indexOf("{"))));
  const keys = (m) => Object.keys(m).sort().join(",");
  expect(typedMsg.length === 2 && keys(typedMsg[0]) === keys(typedMsg[1]), "typed and raw result envelopes carry the same keys", typedMsg.map(keys));
}

// ─── size cap & identity ──────────────────────────────────────────────────────

async function testCapAndIdentity(admin) {
  console.log("\n── write cap, identity defaults ──");
  const big = await call(admin, "dispatch_task", { ns: NS, to: "wk", task_id: `${NS}-big`, subject: "big", body: "x".repeat(40000) });
  expect(big.isError && /^dispatch_task rejected on '[^']*-wk': /.test(big.text) && /MAX_CONTENT_BYTES/.test(big.text), "oversize envelope rejected by the write cap, tool named", big.text);

  const { client: id } = await connect("typed-id", `?role=worker&ns=${NS}&as=wk`);
  const tools = (await id.listTools()).tools;
  const note = tools.find(t => t.name === "post_note");
  expect(note && !(note.inputSchema.required || []).includes("sender"), "with ?as=, sender is optional in the post_note schema", note?.inputSchema?.required);
  const r = await call(id, "post_note", { kind: "finding", subject: "from identity", summary: "a summary long enough", scope: ["x"] });
  expect(!r.isError && r.text.includes(`'${ch("notes")}' as 'wk'`), "identity supplies ns and sender", r.text);
  const { client: bare } = await connect("typed-bare", "?role=worker");
  const bareNote = (await bare.listTools()).tools.find(t => t.name === "post_note");
  expect((bareNote.inputSchema.required || []).includes("sender"), "with a role but no ?as=, sender stays required", bareNote.inputSchema.required);
  await id.close(); await bare.close();
}

async function main() {
  console.log(`[typed-tools] broker: ${BROKER_URL}  namespaces: ${NS}, ${NS2}`);
  const { client: admin } = await connect("test-typed-tools", "?role=admin");
  try {
    await setup(admin);
    await testDispatch(admin);
    await testResult(admin);
    await testPrefixes(admin);
    await testAsk(admin);
    await testNote(admin);
    await testNsResolution(admin);
    await testParity(admin);
    await testCapAndIdentity(admin);
  } finally {
    await admin.close().catch(() => {});
  }
  console.log(`\n[typed-tools] ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error("[typed-tools] FATAL:", e); process.exit(1); });
