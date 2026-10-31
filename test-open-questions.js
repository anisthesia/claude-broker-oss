/**
 * test-open-questions.js — when is a type:question answered (open_questions and get_task_ledger)?
 *   - unchanged: a later message on the asker's inbox (<prefix><from>) naming the task_id, or the
 *     asker's own result for it
 *   - a later message anywhere under the prefix with ref_id = the question's id (number or string)
 *   - a later type:answer anywhere under the prefix with the same task_id
 *   - body.expected_reply_channel / body.reply_channel name the reply channel
 *   - not answered: a text mention of the id, a ref_id/answer outside the prefix, an earlier answer,
 *     a non-answer note on a side channel
 *   - get_task_ledger's open_question / blocked state follow the same rule
 *
 * Runs against BROKER_URL (default http://localhost:8080/mcp) with SHARED_SECRET.
 * Uses throwaway channels prefixed "toq<run>-" and purges them at the end.
 */
import "dotenv/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BROKER_URL = process.env.BROKER_URL || "http://localhost:8080/mcp";
const SECRET     = process.env.SHARED_SECRET || "";
const RUN        = Date.now().toString(36);
const P          = `toq${RUN}-`;
const OTHER      = `toqx${RUN}-`;              // a different namespace
const hdr        = SECRET ? { Authorization: `Bearer ${SECRET}` } : {};

let passed = 0, failed = 0;
function assert(cond, label, extra = "") {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.log(`  ✗ ${label}${extra ? ": " + extra : ""}`); }
}

const client = new Client({ name: "test-open-questions", version: "1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(BROKER_URL), { requestInit: { headers: hdr } }));
const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); return { text: r.content?.[0]?.text ?? "", isError: !!r.isError }; };
const send = async (channel, sender, obj) => {
  const r = await call("send_message", { channel, sender, content: JSON.stringify(obj) });
  if (r.isError) throw new Error(`send to ${channel} failed: ${r.text}`);
  return Number(/#(\d+)/.exec(r.text)?.[1]);
};
const q = (task_id, from, extra = {}) => ({ type: "question", task_id, from, to: "orchestrator", subject: `question ${task_id}`, ...extra });

console.log(`\n[test-open-questions] url=${BROKER_URL} prefix=${P}\n`);
const status = `${P}status`;
const side   = `${P}assessment-reply`;

console.log("1. answered on another channel");
// An answer that predates the question does not close it.
await send(side, "orchestrator", { type: "answer", task_id: "t-early", from: "orchestrator", subject: "too early" });
const ids = {};
for (const t of ["t-ref", "t-refstr", "t-answer", "t-inbox", "t-self", "t-early", "t-mention", "t-note", "t-foreign", "t-named", "t-reply-ch", "t-named-miss"]) {
  const extra = t === "t-named" ? { body: { question: "?", expected_reply_channel: side } }
              : t === "t-reply-ch" ? { body: { question: "?", reply_channel: side } }
              : t === "t-named-miss" ? { body: { question: "?", reply_channel: side } } : {};
  ids[t] = await send(t === "t-ref" || t === "t-refstr" ? `${P}orchestrator` : status, "assessor", q(t, "assessor", extra));
}
// ref_id = question id, on a side channel, with a different task_id (closes by id alone)
await send(side, "orchestrator", { type: "note", task_id: "unrelated", from: "orchestrator", ref_id: ids["t-ref"], subject: "re" });
await send(side, "orchestrator", { type: "note", from: "orchestrator", ref_id: String(ids["t-refstr"]), subject: "re (string ref)" });
// type:answer with the same task_id, no ref_id
await send(`${P}elsewhere`, "orchestrator", { type: "answer", task_id: "t-answer", from: "orchestrator", subject: "yes" });
// unchanged: a reply on the asker's inbox naming the task_id; the asker's own result
await send(`${P}assessor`, "orchestrator", { type: "note", task_id: "t-inbox", from: "orchestrator", subject: "re" });
await send(status, "assessor", { type: "result", task_id: "t-self", from: "assessor", summary: "PASS — went ahead" });
// not answers: a text mention of the id; a non-answer note naming the task_id on a side channel; a
// ref_id / answer in another namespace
await send(`${P}notes`, "orchestrator", { type: "decision", from: "orchestrator", subject: `approved #${ids["t-mention"]}`, summary: `see #${ids["t-mention"]} (t-mention)` });
await send(side, "orchestrator", { type: "note", task_id: "t-note", from: "orchestrator", subject: "noted" });
await send(`${OTHER}assessment-reply`, "orchestrator", { type: "answer", task_id: "t-foreign", from: "orchestrator", ref_id: ids["t-foreign"], subject: "yes" });
// named reply channel: any message there naming the task_id closes it
await send(side, "orchestrator", { type: "note", task_id: "t-named", from: "orchestrator", subject: "re" });
await send(side, "orchestrator", { type: "note", task_id: "t-reply-ch", from: "orchestrator", subject: "re" });
// t-named-miss names side as reply channel but the reply went to the asker's default inbox: still open
await send(`${P}assessor`, "orchestrator", { type: "note", task_id: "t-named-miss", from: "orchestrator", subject: "re" });

const r = JSON.parse((await call("open_questions", { prefix: P })).text);
const open = new Set(r.open.map(o => o.task_id));
for (const t of ["t-ref", "t-refstr", "t-answer", "t-inbox", "t-self", "t-named", "t-reply-ch"])
  assert(!open.has(t), `${t} is answered`, JSON.stringify(r.open.find(o => o.task_id === t)));
for (const t of ["t-early", "t-mention", "t-note", "t-foreign", "t-named-miss"])
  assert(open.has(t), `${t} is still open`);
assert(r.open_count === 5 && r.answered_count === 7, `counts open=5 answered=7 (got ${r.open_count}/${r.answered_count})`);
assert(r.open.find(o => o.task_id === "t-named-miss")?.expected_reply_channel === side, "body.reply_channel is reported as expected_reply_channel");
assert(r.open.find(o => o.task_id === "t-early")?.expected_reply_channel === `${P}assessor`, "default reply channel is still the asker's inbox");

console.log("\n2. get_task_ledger uses the same rule");
{
  await send(`${P}core`, "orchestrator", { type: "task", task_id: "l-answered", from: "orchestrator", to: "core", subject: "a" });
  await send(`${P}core`, "orchestrator", { type: "task", task_id: "l-open", from: "orchestrator", to: "core", subject: "b" });
  const qa = await send(status, "core", q("l-answered", "core"));
  await send(status, "core", q("l-open", "core"));
  await send(side, "orchestrator", { type: "answer", from: "orchestrator", ref_id: qa, subject: "go ahead" });
  const led = JSON.parse((await call("get_task_ledger", { status_channel: status, prefix: P })).text);
  const rows = new Map((led.tasks ?? led.rows ?? []).map(t => [t.task_id, t]));
  const a = rows.get("l-answered"), o = rows.get("l-open");
  assert(a && a.open_question === null && a.state !== "blocked", "answered elsewhere: no open_question, not blocked", JSON.stringify(a));
  assert(o && o.open_question?.id && o.state === "blocked", "unanswered: open_question set, blocked", JSON.stringify(o));
}

await call("purge_channels_by_prefix", { prefix: P });
await call("purge_channels_by_prefix", { prefix: OTHER });
await client.close();
console.log(`\n  passed: ${passed}   failed: ${failed}\n`);
process.exit(failed ? 1 : 0);
