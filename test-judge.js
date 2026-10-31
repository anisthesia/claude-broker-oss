// Judge-worker schema tests: the cb manifest's judge worker + cb-judge inbox + local `judgment` type,
// schemas/cb-notes.json (judgment on the notes channel), schemas/notes.json (the same type with
// namespace-generic patterns, for every other <ns>-notes channel) and the answer note on the strict
// schemas/cb-worker-inbox.json. Registers a renamed copy of schemas/manifests/cb.json under a unique
// namespace on the (scratch) broker, so it never touches the live cb namespace.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync } from "fs";
import "dotenv/config";

const BROKER_URL = process.env.BROKER_URL || "http://localhost:8080/mcp";
const SECRET     = process.env.SHARED_SECRET || "";
const NS         = `jg${Date.now().toString(36)}`;

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

const TID = "cb-2026-10-29-judge-case";

const task = (over = {}) => ({
  type: "task", task_id: TID, from: "orchestrator", to: "protocol-qa", subject: "do the thing",
  body: "what and why", scope: "small", acceptance_criteria: ["it works"],
  ...over,
});

const question = (over = {}) => ({
  type: "question", task_id: TID, from: "protocol-qa", to: "orchestrator", subject: "A or B?",
  body: { question: "Which of A or B?" },
  ...over,
});

const answer = (over = {}) => ({
  type: "note", task_id: TID, from: "judge", to: "protocol-qa", subject: "Answer: use A",
  body: { answer: "Use A", basis: "cb-notes#168904", verdict: "decided" },
  ...over,
});

const judgment = (over = {}) => ({
  type: "judgment", task_id: TID, from: "judge", to: "protocol-qa", subject: "A or B? decided: A",
  verdict: "decided", question_ref: "cb-status#185900", summary: "A, per the recorded decision.",
  basis: "cb-notes#168904",
  ...over,
});

async function ledgerRow(client, status, taskId) {
  const r = await call(client, "get_task_ledger", { status_channel: status });
  try { return JSON.parse(r.text).tasks.find((t) => t.task_id === taskId) ?? null; } catch { return null; }
}

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL(`${BROKER_URL}?role=admin`), {
    requestInit: SECRET ? { headers: { Authorization: `Bearer ${SECRET}` } } : {},
  });
  const client = new Client({ name: "test-judge", version: "1.0.0" });
  await client.connect(transport);

  try {
    const raw = readFileSync("schemas/manifests/cb.json", "utf-8")
      .replaceAll('"cb-', `"${NS}-`).replaceAll("^cb-", `^${NS}-`).replace('"ns": "cb"', `"ns": "${NS}"`);
    const manifest = JSON.parse(raw);
    manifest.strict = true; // reject, so a bad envelope shows as an error rather than a warning
    const reg = await call(client, "register_namespace", { manifest: JSON.stringify(manifest) });
    expect(!reg.isError, "cb manifest (renamed copy) registers", reg.text);

    const status = `${NS}-status`;
    const qa = `${NS}-protocol-qa`;
    const judge = `${NS}-judge`;
    const notes = `${NS}-notes`;

    // The v2 schemas setup-schemas-cb.js registers win over the manifest, so register the same files.
    for (const [channel, file] of [[qa, "schemas/cb-worker-inbox.json"], [notes, "schemas/cb-notes.json"]]) {
      const r = await call(client, "register_channel_schema", { channel, schema: readFileSync(file, "utf-8"), strict: true, version: "1.0" });
      expect(!r.isError, `${file} registers strict on ${channel}`, r.text);
    }

    console.log("\n── manifest: judge worker and cb-judge ──");
    const m = JSON.parse(readFileSync("schemas/manifests/cb.json", "utf-8"));
    expect(m.workers.some((w) => w.name === "judge" && w.inbox === "cb-judge" && w.role === "worker"), "judge worker declared with inbox cb-judge, role worker");
    const ch = m.channels.find((c) => c.name === "cb-judge");
    expect(ch?.kind === "worker-inbox", "cb-judge is a worker-inbox");
    expect(JSON.stringify(ch?.types) === JSON.stringify(["task", "question", "note", "rotate"]), "cb-judge types are task|question|note|rotate", ch?.types);
    expect(m.channels.find((c) => c.name === "cb-notes")?.types.includes("judgment"), "cb-notes accepts judgment");
    expect(m.local_types.judgment, "judgment is a local type");
    expect(accepted(await send(client, judge, task({ to: "judge", task_id: `${NS}-2026-10-29-j` }), "orchestrator")), "task accepted on the judge inbox");
    expect(accepted(await send(client, judge, question({ to: "judge", from: "orchestrator", task_id: `${NS}-2026-10-29-j` }), "orchestrator")), "question accepted on the judge inbox");
    expect(accepted(await send(client, judge, answer({ from: "orchestrator", to: "judge", task_id: `${NS}-2026-10-29-j` }), "orchestrator")), "note accepted on the judge inbox");
    expect(!accepted(await send(client, judge, { type: "plan-decision", task_id: TID, from: "orchestrator", to: "judge", subject: "plan decision", body: { decision: "approve" } }, "orchestrator")),
      "plan-decision not accepted on the judge inbox");
    expect(!accepted(await send(client, judge, { type: "result", task_id: TID, from: "judge", to: "orchestrator", subject: "done", summary: "PASS — x", body: {} }, "judge")),
      "result not accepted on the judge inbox");

    console.log("\n── (1) a decided answer note unblocks the asker's ledger row ──");
    expect(accepted(await send(client, qa, task(), "orchestrator")), "task dispatched to the asker's inbox");
    expect(accepted(await send(client, status, question(), "protocol-qa")), "question posted on the status channel");
    let row = await ledgerRow(client, status, TID);
    expect(row?.state === "blocked", "ledger row is blocked while the question is open", row?.state);
    const ok = await send(client, qa, answer(), "judge");
    expect(accepted(ok), "decided answer note validates on the strict worker inbox", ok.text);
    row = await ledgerRow(client, status, TID);
    expect(row && ["pending", "in-progress"].includes(row.state), "ledger row flips from blocked to pending/in-progress", row?.state);
    expect(row?.open_question == null, "no open question left on the row", row?.open_question);

    console.log("\n── answer-note shape on the strict cb-worker-inbox ──");
    expect(accepted(await send(client, qa, answer({ body: { reason: "needs a human: touches production", verdict: "held" } }), "judge")), "reason + verdict held accepted");
    expect(accepted(await send(client, qa, answer({ body: { reason: "ask the orchestrator for the scope", verdict: "returned" } }), "judge")), "reason + verdict returned accepted");
    expect(accepted(await send(client, qa, answer({ body: { answer: "Use A", basis: "docs/knowledge/cb.md#schemas", verdict: "decided" } }), "judge")), "answer with a docs basis accepted");
    const noSubject = answer(); delete noSubject.subject;
    expect(!accepted(await send(client, qa, noSubject, "judge")), "answer note without subject rejected");
    expect(!accepted(await send(client, qa, answer({ task_id: "not-a-task" }), "judge")), "answer note with a malformed task_id rejected");
    expect(!accepted(await send(client, qa, answer({ verdict: "decided" }), "judge")), "unknown top-level field rejected (verdict lives in body)");

    console.log("\n── (2) judgment: basis is required when decided ──");
    expect(accepted(await send(client, notes, judgment(), "judge")), "decided judgment with a cb-notes basis accepted");
    expect(accepted(await send(client, notes, judgment({ basis: "docs/knowledge/cb.md#schemas" }), "judge")), "docs/knowledge basis accepted");
    expect(accepted(await send(client, notes, judgment({ basis: "CLAUDE.md:Result envelope" }), "judge")), "CLAUDE.md basis accepted");
    const noBasis = judgment(); delete noBasis.basis;
    expect(!accepted(await send(client, notes, noBasis, "judge")), "decided judgment without basis rejected");
    expect(!accepted(await send(client, notes, judgment({ basis: "I think so" }), "judge")), "decided judgment with a free-text basis rejected");
    expect(!accepted(await send(client, notes, judgment({ basis: "cb-status#185900" }), "judge")), "basis pointing at a status message rejected");

    console.log("\n── (3) returned and held need no basis ──");
    expect(accepted(await send(client, notes, judgment({ verdict: "returned", question_ref: "cb-status#185901", basis: undefined, summary: "Sent back: asker has the answer in its task." }), "judge")), "returned judgment accepted");
    expect(accepted(await send(client, notes, judgment({ verdict: "held", question_ref: "cb-status#185902", basis: undefined, summary: "No recorded decision covers this; left for the human." }), "judge")), "held judgment accepted");
    expect(accepted(await send(client, notes, judgment({ verdict: "held", question_ref: "cb-status#185903", basis: "cb-notes#168904" }), "judge")), "held judgment may still cite a basis");

    console.log("\n── (6) generic notes.json: judgment on a non-cb notes channel ──");
    const gnotes = `${NS}g-notes`;
    const greg = await call(client, "register_channel_schema", { channel: gnotes, schema: readFileSync("schemas/notes.json", "utf-8"), strict: true, version: "1.1" });
    expect(!greg.isError, "schemas/notes.json registers strict on a non-cb notes channel", greg.text);
    const gj = (over = {}) => judgment({ question_ref: `${NS}-status#185900`, basis: `${NS}-notes#168904`, ...over });
    expect(accepted(await send(client, gnotes, gj(), "judge")), "decided judgment with <ns>-notes basis and <ns>-status question_ref accepted");
    expect(accepted(await send(client, gnotes, gj({ basis: "docs/knowledge/mg-voice.md#schemas" }), "judge")), "docs/knowledge/<name>.md basis accepted");
    expect(accepted(await send(client, gnotes, gj({ basis: "CLAUDE.md:Result envelope" }), "judge")), "CLAUDE.md basis accepted");
    expect(accepted(await send(client, gnotes, gj({ question_ref: "mg-status#185900" }), "judge")), "hyphenated namespace prefix in question_ref accepted");
    expect(accepted(await send(client, gnotes, gj({ verdict: "held", basis: undefined, summary: "Left for the human." }), "judge")), "held judgment without basis accepted");
    const gNoBasis = gj(); delete gNoBasis.basis;
    expect(!accepted(await send(client, gnotes, gNoBasis, "judge")), "decided judgment without basis rejected");
    expect(!accepted(await send(client, gnotes, gj({ basis: "I think so" }), "judge")), "free-text basis rejected");
    expect(!accepted(await send(client, gnotes, gj({ basis: `${NS}-status#185900` }), "judge")), "basis pointing at a status message rejected");
    for (const bad of ["185900", `${NS}-notes#185900`, `${NS}-status`, `Mg-status#1`, `-status#1`, `${NS}-status#12x`]) {
      const r = await send(client, gnotes, gj({ question_ref: bad }), "judge");
      expect(!accepted(r), `bad question_ref rejected: ${bad}`, r.text);
    }
    expect(!accepted(await send(client, gnotes, gj({ from: "core" }), "core")), "judgment from a non-judge rejected");
    expect(!accepted(await send(client, gnotes, gj({ extra: 1 }), "judge")), "unknown field rejected");

    console.log("\n── existing note types on notes.json unaffected (real mg/dv rows, 2026-10-29) ──");
    const real = [
      { type: "finding", task_id: "patrol-2026-10-29", from: "analytics", to: "*", subject: "patrol-2026-10-29: nightly failure ongoing, tracking unchanged",
        summary: "2026-10-28 nightly analytics failed on DNS error (postiz fork unreachable). No new result messages from social/email/outbound. Tracking files unchanged from 2026-10-28 patrol. Next nightly run expected 2026-10-28 23:32 IST.",
        scope: ["analytics/tracking/", "ops/analytics/logs/"], evidence: "nightly-2026-10-28.log line 11/32: ENOTFOUND social.client-app.in; mg-status read: no result messages since #184415", confidence: "confirmed" },
      { type: "decision", from: "orchestrator", to: "*", subject: "SDK runner paused by the human: no SDK flip, side-by-side or per-brand-key tasks",
        summary: "Per human note mg-orchestrator #184658 (29 Oct): the SDK runner is not in use for now; mg-analytics is back on cli, R5 is cancelled. Dispatch no SDK flip, side-by-side or per-brand-key task until the human says so. Merged code stays; the C3 rate card remains the human's, no rush.",
        scope: ["sprint-7", "docs/plans/2026-10-29-sprint-7-sdk-runner.md"], refs: ["mg-orchestrator#184658"] },
      { type: "resolved", from: "orchestrator", subject: "#184452 wrong: the flip is the per-worker --launcher sdk arg; see #184434", ref_id: 184452, outcome: "superseded",
        summary: "Superseded by #184434. #184452 named WATCHDOG_LAUNCHER=sdk; the mg-analytics flip is the per-worker --launcher sdk arg. Duplicate decision, per human note mg-orchestrator #184475.", task_id: "mg-sprint-7-sdk-runner" },
    ];
    for (const row of real) expect(accepted(await send(client, gnotes, row, row.from)), `real ${row.type} row still accepted on notes.json`);
    expect(!accepted(await send(client, gnotes, { type: "finding", from: "x", to: "*", subject: "no scope", summary: "A finding without scope is still rejected." }, "x")), "finding without scope still rejected");

    console.log("\n── judgment shape ──");
    for (const [label, over] of [
      ["unknown verdict", { verdict: "maybe" }],
      ["question_ref without the cb-status# prefix", { question_ref: "185900" }],
      ["question_ref on another channel", { question_ref: "cb-notes#185900" }],
      ["subject over 120 chars", { subject: "x".repeat(121) }],
      ["summary over 400 chars", { summary: "x".repeat(401) }],
      ["empty summary", { summary: "" }],
      ["from not judge", { from: "core" }],
    ]) {
      const r = await send(client, notes, judgment(over), over.from ?? "judge");
      expect(!accepted(r), `judgment rejected: ${label}`, r.text);
    }
    for (const field of ["task_id", "to", "subject", "verdict", "question_ref", "summary"]) {
      const j = judgment(); delete j[field];
      expect(!accepted(await send(client, notes, j, "judge")), `judgment rejected: no ${field}`);
    }
    expect(!accepted(await send(client, notes, judgment({ extra: 1 }), "judge")), "judgment rejected: unknown field");
    expect(accepted(await send(client, notes, { type: "finding", from: "protocol-qa", to: "*", subject: "still valid", summary: "A finding keeps validating on the same channel.", scope: ["schemas/"] }, "protocol-qa")),
      "finding still accepted on the notes channel");

    // The two rules below need state the schema cannot see (the dispatch envelope, other messages), so
    // they are role rules in workers/judge/CLAUDE.md and docs/protocol-v3.md. These cases pin that
    // boundary: if the schema ever starts enforcing them, these flip and the doc should follow.
    console.log("\n── (4) production-touching task: role rule, not schema ──");
    expect(accepted(await send(client, qa, task({ task_id: "cb-2026-10-29-judge-prod", body: { production_touching: true } }), "orchestrator")),
      "a production_touching task dispatches");
    expect(accepted(await send(client, notes, judgment({ task_id: "cb-2026-10-29-judge-prod", question_ref: "cb-status#185910" }), "judge")),
      "schema cannot refuse a judgment on it (judge must verdict held: role rule)");

    console.log("\n── (5) duplicate question_ref: role rule, not schema ──");
    const first = await send(client, notes, judgment({ question_ref: "cb-status#185920" }), "judge");
    const second = await send(client, notes, judgment({ question_ref: "cb-status#185920", verdict: "held", basis: undefined }), "judge");
    expect(accepted(first) && accepted(second),
      "schema cannot see an earlier judgment for the same question_ref (judge reads cb-notes first: role rule)", { first: first.text, second: second.text });
    const read = await call(client, "read_messages", { channel: notes, filter_type: "judgment", limit: 100 });
    expect((read.text.match(/cb-status#185920/g) || []).length >= 2, "both are on the channel, so a reader can detect the duplicate by question_ref");
  } finally {
    await client.close().catch(() => {});
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
