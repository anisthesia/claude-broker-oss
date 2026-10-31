/**
 * Hold mode (manifest workers[].mode = "hold") on a scratch broker: a hold-only judge may write only
 * held judgments on <ns>-notes, type:status on <ns>-status and <ns>-telemetry / <ns>-rate-limits; every other
 * write is refused on every path (send_message, send_message_batch, post_gated_message, typed tools,
 * REST POST /messages), also when the URL identity (?ns=&as=) is the hold judge but the sender or namespace
 * differs, and under a case or '<ns>-' variant of the name. upsert_heartbeat is covered by the insert guard
 * (lib/db.js) and delete_message is refused. The same writes in a namespace without hold land. Also: verdict
 * in projection=summary, and setup.js envFileValue (the retro's DB_PATH) reads .env as dotenv does.
 *
 * Run by test-setup-broker.js (node run-tests.js provides the scratch broker), or alone:
 *   BROKER_URL=http://localhost:<port>/mcp SHARED_SECRET=<s> node test-notes-judgment.js
 * Never runs against the live broker on port 8080 (it registers manifests).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import "dotenv/config";
import { envFileValue } from "./setup.js";

function manifest(ns, judgeMode) {
  const workers = [["orchestrator", "orchestrator"], ["backend", "worker"], ["judge", "worker"]];
  return {
    ns, version: "3.0", strict: false,
    workers: workers.map(([name, role]) => ({ name, inbox: `${ns}-${name}`, role, ...(name === "judge" && judgeMode ? { mode: judgeMode } : {}) })),
    channels: [
      ...workers.map(([name, role]) => ({ name: `${ns}-${name}`, kind: role === "orchestrator" ? "orchestrator-inbox" : "worker-inbox", types: role === "orchestrator" ? ["result", "question", "status"] : ["task"] })),
      { name: `${ns}-status`, kind: "status", types: ["result", "status", "question"] },
      { name: `${ns}-notes`, kind: "notes", types: ["finding", "decision", "resolved"] }, // strict:false: judgment/note rows land warn-only
    ],
  };
}

export async function notesJudgmentGuard({ RUN, BROKER_URL, SECRET, assert }) {
  const base = new URL(BROKER_URL);
  console.log("\n── hold mode: manifest workers[].mode=\"hold\" guard on every write path ──");
  for (const [text, want] of [["DB_PATH=./broker.db  # main", "./broker.db"], ["DB_PATH=./b.db#x", "./b.db"], ['DB_PATH="./a #b.db" # c', "./a #b.db"],
    ["X=1\nDB_PATH='q.db'", "q.db"], ["DB_PATH=a\nDB_PATH=b", "b"], ["FOO=1", null]])
    assert(envFileValue(text, "DB_PATH") === want, `setup.js envFileValue(${JSON.stringify(text)}) → ${JSON.stringify(want)} (dotenv rules)`, JSON.stringify(envFileValue(text, "DB_PATH")));
  if (base.port === "8080" || !SECRET) { console.log("  - SKIP hold-mode guard: no scratch broker (run via node run-tests.js)"); return; }
  const headers = { Authorization: `Bearer ${SECRET}` };
  const open = [];
  const connect = async (query = "") => {
    const url = new URL(base); url.search = query;
    const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers } });
    const client = new Client({ name: "test-notes-judgment", version: "1.0.0" });
    await client.connect(transport);
    open.push(transport);
    return client;
  };
  const call = async (client, tool, args) => {
    const r = await client.callTool({ name: tool, arguments: args });
    return { isError: !!r.isError, text: r.content?.[0]?.text ?? "" };
  };
  const rest = async (query, body) => {
    const url = new URL("/messages", base); url.search = query;
    const r = await fetch(url, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };

  const H = `hj${RUN}`, N = `hk${RUN}`; // H: judge is hold-only; N: same manifest without mode
  try {
    const admin = await connect("role=admin");
    for (const [ns, mode] of [[H, "hold"], [N, undefined]]) {
      const r = await call(admin, "register_namespace", { manifest: JSON.stringify(manifest(ns, mode)) });
      assert(!r.isError, `register_namespace ${ns}${mode ? " with workers[].mode=\"hold\" (manifest.schema.json accepts it)" : ""}`, r.text);
    }
    const bad = await call(admin, "register_namespace", { manifest: JSON.stringify({ ...manifest(`hx${RUN}`), workers: manifest(`hx${RUN}`).workers.map((w) => ({ ...w, mode: "full" })) }) });
    assert(bad.isError, "manifest.schema.json: workers[].mode accepts only \"hold\"", bad.text);

    const plain = await connect("");
    const judgment = (ns, verdict, extra = {}) => JSON.stringify({ type: "judgment", task_id: `${ns}-2026-10-30-x`, from: "judge", to: "backend", subject: "A or B?", verdict, question_ref: `${ns}-status#1`, summary: "Decide A or B.", ...extra });
    const status = (ns) => JSON.stringify({ type: "status", task_id: "judge-patrol", from: "judge", to: "orchestrator", subject: "judge patrol", body: { held: 1 } });
    const answer = (ns) => JSON.stringify({ type: "note", task_id: `${ns}-2026-10-30-x`, from: "judge", to: "backend", subject: "Answer: A", body: { answer: "A", basis: `${ns}-notes#1`, verdict: "decided" } });
    const result = (ns) => JSON.stringify({ type: "result", task_id: `${ns}-2026-10-30-x`, from: "judge", to: "orchestrator", subject: "x", summary: "PASS — x" });
    const send = (client, channel, content, sender = "judge") => call(client, "send_message", { channel, sender, content });
    const refused = (r) => r.isError && /hold-only in namespace/.test(r.text);

    // Allowed in a hold namespace.
    for (const [label, ch, c] of [["held judgment on notes", `${H}-notes`, judgment(H, "held")], ["type:status on status", `${H}-status`, status(H)],
      ["telemetry", `${H}-telemetry`, JSON.stringify({ type: "heartbeat", from: "judge" })], ["rate-limits", `${H}-rate-limits`, JSON.stringify({ type: "rate-limit", from: "judge" })]]) {
      const r = await send(plain, ch, c);
      assert(!r.isError, `hold judge: ${label} lands`, r.text);
    }
    const hb = await call(plain, "upsert_heartbeat", { channel: `${H}-telemetry`, sender: "judge", content: JSON.stringify({ type: "heartbeat", from: "judge" }) });
    assert(!hb.isError, "hold judge: upsert_heartbeat lands", hb.text);

    // Refused in a hold namespace.
    const before = (await (await fetch(new URL("/metrics", base), { headers })).json().catch(() => ({}))).guard_refusals;
    for (const [label, ch, c] of [["decided judgment", `${H}-notes`, judgment(H, "decided", { basis: `${H}-notes#1` })], ["returned judgment", `${H}-notes`, judgment(H, "returned")],
      ["answer note on a worker inbox", `${H}-backend`, answer(H)], ["type:result on status", `${H}-status`, result(H)], ["type:note on status", `${H}-status`, answer(H)],
      ["a finding on notes", `${H}-notes`, JSON.stringify({ type: "finding", from: "judge", to: "*", subject: "x", summary: "x" })], ["plain text on status", `${H}-status`, "hello"],
      ["held judgment on a case-variant notes channel", `${H.toUpperCase()}-notes`, judgment(H, "held")]]) {
      const r = await send(plain, ch, c);
      assert(refused(r), `hold judge: ${label} refused`, r.text);
    }
    const after = (await (await fetch(new URL("/metrics", base), { headers })).json().catch(() => ({}))).guard_refusals;
    assert(typeof before !== "number" || after - before >= 8, `refusals counted in /metrics guard_refusals (+${after - before})`);

    const mark = `${H}-batch-${RUN}`;
    const batch = await call(plain, "send_message_batch", { messages: [
      { channel: `${H}-notes`, sender: "judge", content: judgment(H, "held", { subject: mark }) },
      { channel: `${H}-backend`, sender: "judge", content: answer(H) },
    ] });
    const notes = await call(plain, "read_messages", { channel: `${H}-notes`, since_id: 1, projection: "summary" });
    assert(refused(batch) && /message 2\/2/.test(batch.text) && !notes.text.includes(mark), "send_message_batch: one bad message refuses the batch and inserts none", batch.text);
    const gated = await call(plain, "post_gated_message", { channel: `${H}-backend`, sender: "judge", content: answer(H), depends_on: ["nope"], timeout_ms: 1000 });
    assert(refused(gated), "post_gated_message: refused up front", gated.text);

    // upsert_heartbeat: the insert guard (lib/db.js stmtInsert) is the backstop for every insert path.
    const idOf = (r) => Number(r.text.match(/#(\d+)/)?.[1] ?? 0);
    const q = idOf(await send(plain, `${H}-status`, JSON.stringify({ type: "question", task_id: `${H}-2026-10-30-q`, from: "backend", to: "orchestrator", subject: "A or B?" }), "backend"));
    const hbInbox = await call(plain, "upsert_heartbeat", { channel: `${H}-backend`, sender: "judge", content: JSON.stringify({ type: "answer", task_id: `${H}-2026-10-30-q`, from: "judge", to: "backend", subject: "A" }) });
    assert(refused(hbInbox) && /may write only type:judgment/.test(hbInbox.text), "upsert_heartbeat to the asker's inbox as the hold judge refused by the insert guard", hbInbox.text);
    const oq = await call(admin, "open_questions", { prefix: `${H}-` });
    assert(q > 0 && oq.text.includes(`${H}-2026-10-30-q`), "the question stays open after the refused upsert_heartbeat answer", oq.text.slice(0, 300));
    const hbNotes = await call(plain, "upsert_heartbeat", { channel: `${H}-notes`, sender: "judge", content: judgment(H, "held") });
    assert(refused(hbNotes) && /upsert_heartbeat is allowed only/.test(hbNotes.text), "upsert_heartbeat to notes as the hold judge refused (would wipe earlier held judgments)", hbNotes.text);
    const kept = await call(plain, "read_messages", { channel: `${H}-notes`, since_id: 1, projection: "summary", filter_sender: "judge" });
    assert(/"verdict":"held"/.test(kept.text), "the judge's earlier held judgments survive", kept.text.slice(0, 300));

    // Name variants: case-insensitive and '<ns>-'-prefixed names are the hold judge too.
    for (const name of ["Judge", "JUDGE", `${H}-judge`, `${H.toUpperCase()}-Judge`]) {
      const r = await send(plain, `${H}-backend`, answer(H), name);
      assert(refused(r), `hold judge under the name '${name}': answer note refused`, r.text);
    }
    const rv = await rest("", { channel: `${H}-backend`, sender: `${H}-judge`, content: answer(H) });
    assert(rv.status === 403, `REST POST /messages as '${H}-judge': refused 403 (${rv.status})`, JSON.stringify(rv.json));
    const variantUrl = await connect(`ns=${H.toUpperCase()}&as=Judge`);
    const rvu = await send(variantUrl, `${N}-backend`, answer(N), "backend");
    assert(refused(rvu), `URL identity ${H.toUpperCase()}/Judge: write into ${N} as backend refused`, rvu.text);
    const okVariant = await send(plain, `${H}-notes`, judgment(H, "held"), "Judge");
    assert(!okVariant.isError, "'Judge' may still post a held judgment on notes", okVariant.text);
    const judgeX = await send(plain, `${H}-backend`, answer(H), "judgex");
    assert(!judgeX.isError, "a different name ('judgex') is not the hold judge", judgeX.text);

    // delete_message: a hold-only worker may not delete (a deleted question drops out of open_questions).
    const identDel = await connect(`ns=${H}&as=judge`);
    for (const [label, sender, client] of [["sender=judge", "judge", plain], ["sender='Judge'", "Judge", plain], ["URL identity, no sender=", undefined, identDel]]) {
      const d = await call(client, "delete_message", { channel: `${H}-status`, id: q, ...(sender ? { sender } : {}) });
      assert(refused(d), `delete_message by the hold judge (${label}) refused`, d.text);
    }
    const oq2 = await call(admin, "open_questions", { prefix: `${H}-` });
    assert(oq2.text.includes(`${H}-2026-10-30-q`), "the question survives the refused deletes", oq2.text.slice(0, 300));
    const dOther = await call(plain, "delete_message", { channel: `${H}-backend`, id: idOf(judgeX), sender: "judgex" });
    assert(!dOther.isError, "delete_message by another sender in the hold namespace still works", dOther.text);

    // Typed tools: a role=worker connection as the hold judge.
    const typed = await connect(`role=worker&ns=${H}&as=judge`);
    const pr = await call(typed, "post_result", { task_id: `${H}-2026-10-30-x`, subject: "x", summary: "PASS — x" });
    assert(refused(pr), "typed post_result as the hold judge refused", pr.text);
    const pn = await call(typed, "post_note", { kind: "finding", subject: "x", summary: "x", scope: ["a.js"], evidence: "x", confidence: "confirmed" });
    assert(refused(pn), "typed post_note as the hold judge refused", pn.text);

    // URL identity: ?ns=<hold>&as=judge (no role, as the watchdog sends) cannot write as someone else or elsewhere.
    const ident = await connect(`ns=${H}&as=judge`);
    for (const [label, ch, c, sender] of [["as another sender on a worker inbox", `${H}-backend`, answer(H), "orchestrator"],
      ["into another namespace", `${N}-backend`, answer(N), "backend"], ["a decided judgment in another namespace", `${N}-notes`, judgment(N, "decided", { basis: `${N}-notes#1` }), "judge"]]) {
      const r = await send(ident, ch, c, sender);
      assert(refused(r), `URL identity ${H}/judge: ${label} refused`, r.text);
    }
    const okIdent = await send(ident, `${H}-notes`, judgment(H, "held"));
    assert(!okIdent.isError, `URL identity ${H}/judge: held judgment on ${H}-notes lands`, okIdent.text);

    // REST POST /messages.
    const r1 = await rest("", { channel: `${H}-backend`, sender: "judge", content: answer(H) });
    assert(r1.status === 403 && /hold-only/.test(r1.json.error || ""), `REST POST /messages: answer note refused 403 (${r1.status})`, JSON.stringify(r1.json));
    const r2 = await rest(`ns=${H}&as=judge`, { channel: `${N}-backend`, sender: "backend", content: answer(N) });
    assert(r2.status === 403, `REST POST /messages with ?ns=${H}&as=judge into ${N}: refused 403 (${r2.status})`, JSON.stringify(r2.json));
    const r3 = await rest("", { channel: `${H}-status`, sender: "judge", content: status(H) });
    assert(r3.status === 200, `REST POST /messages: hold judge's status lands (${r3.status}; the watchdog fallback handoff is a status)`, JSON.stringify(r3.json));

    // Without mode the same writes land.
    for (const [label, ch, c] of [["decided judgment", `${N}-notes`, judgment(N, "decided", { basis: `${N}-notes#1` })], ["answer note on a worker inbox", `${N}-backend`, answer(N)], ["type:result on status", `${N}-status`, result(N)]]) {
      const r = await send(plain, ch, c);
      assert(!r.isError, `no mode in ${N}: ${label} lands`, r.text);
    }
    const rn = await rest("", { channel: `${N}-backend`, sender: "judge", content: answer(N) });
    assert(rn.status === 200, `no mode in ${N}: REST answer note lands (${rn.status})`, JSON.stringify(rn.json));
    const other = await send(plain, `${H}-backend`, answer(H), "orchestrator");
    assert(!other.isError, `hold ${H}: other senders are unaffected (orchestrator note on ${H}-backend lands)`, other.text);

    // (h) verdict in projection=summary.
    const sum = await call(plain, "read_messages", { channel: `${N}-notes`, since_id: 1, projection: "summary" });
    const last = await call(plain, "read_last", { channel: `${H}-notes`, n: 5, projection: "summary" });
    assert(/"verdict":"decided"/.test(sum.text) && /"verdict":"held"/.test(last.text), "projection=summary carries verdict (read_messages and read_last)", sum.text.slice(0, 300));
  } finally {
    for (const t of open) await t.close().catch(() => {});
  }
  await caJudgeManifest({ BROKER_URL, SECRET, assert });
}

/** The real schemas/manifests/ca.json (hold-only judge) with ca's v2 schemas, on the scratch broker. */
export async function caJudgeManifest({ BROKER_URL, SECRET, assert }) {
  const base = new URL(BROKER_URL);
  console.log("\n── ca manifest: hold-only judge (schemas/manifests/ca.json + ca v2 schemas) ──");
  if (base.port === "8080" || !SECRET) { console.log("  - SKIP ca judge: no scratch broker (run via node run-tests.js)"); return; }
  const headers = { Authorization: `Bearer ${SECRET}` };
  const open = [];
  const connect = async (query = "") => {
    const url = new URL(base); url.search = query;
    const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers } });
    const client = new Client({ name: "test-ca-judge", version: "1.0.0" });
    await client.connect(transport);
    open.push(transport);
    return client;
  };
  const call = async (client, tool, args) => {
    const r = await client.callTool({ name: tool, arguments: args });
    return { isError: !!r.isError, text: r.content?.[0]?.text ?? "" };
  };
  try {
    const admin = await connect("role=admin");
    const manifest = JSON.parse(readFileSync("schemas/manifests/ca.json", "utf-8"));
    const judge = manifest.workers.find((w) => w.name === "judge");
    assert(judge?.mode === "hold" && judge.inbox === "ca-judge" && judge.role === "worker", "ca.json: worker judge (inbox ca-judge, mode hold)", JSON.stringify(judge));
    const reg = await call(admin, "register_namespace", { manifest: JSON.stringify(manifest) });
    assert(!reg.isError, "register_namespace ca.json (manifest.schema.json valid)", reg.text);
    // ca's v2 schemas win over the manifest: register the ones setup-schemas-ca.js does, strict, so a violation is a rejection.
    for (const [channel, file] of [["ca-notes", "notes.json"], ["ca-status", "ca-status.json"], ["ca-telemetry", "ca-telemetry.json"], ["ca-judge", "ca-worker-inbox.json"], ["ca-quality", "ca-worker-inbox.json"]]) {
      const schema = readFileSync(`schemas/${file}`, "utf-8");
      const r = await call(admin, "register_channel_schema", { channel, schema_json: schema, schema, strict: true });
      assert(!r.isError, `v2 schema ${file} on ${channel} (strict)`, r.text);
    }
    const plain = await connect("");
    const send = (channel, content, sender = "judge") => call(plain, "send_message", { channel, sender, content });
    const refused = (r) => r.isError && /hold-only in namespace/.test(r.text);
    const held = JSON.stringify({ type: "judgment", task_id: "ca-2026-10-30-x", from: "judge", to: "quality", subject: "Rounding: banker's or half-up?", verdict: "held", question_ref: "ca-status#12", summary: "Decide the rounding mode for GST: A) half-up (current), B) banker's. Answer A or B." });
    const r1 = await send("ca-notes", held);
    assert(!r1.isError && !/warn/i.test(r1.text), "ca: held judgment on ca-notes accepted (v2 strict + manifest)", r1.text);
    const patrol = JSON.stringify({ type: "status", task_id: "ca-judge-patrol", from: "judge", to: "orchestrator", subject: "judge patrol", body: { held: 1 } });
    const r2 = await send("ca-status", patrol);
    assert(!r2.isError, "ca: judge patrol status (task_id ca-judge-patrol) on ca-status accepted by the strict v2 schema", r2.text);
    const r3 = await call(plain, "upsert_heartbeat", { channel: "ca-telemetry", sender: "judge", content: JSON.stringify({ type: "heartbeat", from: "judge", ts: new Date().toISOString(), context: { size_tokens: 1000, tier_threshold_pct: 50, rotation_recommended: false }, activity: { state: "idle-exit" } }) });
    assert(!r3.isError, "ca: judge heartbeat on ca-telemetry accepted", r3.text);
    const answer = JSON.stringify({ type: "note", task_id: "ca-2026-10-30-x", from: "judge", to: "quality", subject: "Answer: A", body: { answer: "A" } });
    for (const [label, ch, c] of [["answer note to ca-quality", "ca-quality", answer], ["answer note to ca-orchestrator", "ca-orchestrator", answer],
      ["decided judgment", "ca-notes", held.replace('"held"', '"decided"')], ["note to its own inbox ca-judge", "ca-judge", answer]]) {
      const r = await send(ch, c);
      assert(refused(r), `ca hold judge: ${label} refused by the hold guard`, r.text);
    }
    const orch = await call(plain, "send_message", { channel: "ca-judge", sender: "orchestrator", content: JSON.stringify({ type: "task", task_id: "ca-2026-10-30-y", from: "orchestrator", to: "judge", subject: "judge x", body: "look at it" }) });
    assert(!orch.isError, "ca: orchestrator task to ca-judge lands (inbox registered, only the judge's writes are held)", orch.text);
  } finally {
    for (const t of open) await t.close().catch(() => {});
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let failed = 0, passed = 0;
  const assert = (c, label, detail = "") => { if (c) { passed++; console.log(`  ✓ ${label}`); } else { failed++; console.error(`  ✗ ${label}: ${detail || "assertion failed"}`); } };
  notesJudgmentGuard({ RUN: Date.now(), BROKER_URL: process.env.BROKER_URL || "http://localhost:8080/mcp", SECRET: process.env.SHARED_SECRET || "", assert })
    .then(() => { console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0); })
    .catch((e) => { console.error("[FATAL]", e); process.exit(1); });
}
