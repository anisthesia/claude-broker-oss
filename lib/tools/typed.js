// MCP tools: typed protocol writes (dispatch_task, post_result, ask, post_note, post_plan, decide_plan).
// The server builds the envelope from named fields, resolves channels from the namespace manifest and validates
// through the same path as send_message — but rejects on any mismatch, warn-only or not, so the
// caller learns of a schema error before the message lands. Envelopes are the same shape workers
// hand-write today, so v2 readers, open_questions and get_task_ledger see no difference.
import { z } from "zod";
import { spawnSync } from "child_process";
import { nsOf } from "../util.js";
import { stmtNsList, stmtTaskInInbox, stmtTaskDispatches } from "../db.js";
import { validateContent, schemaHint } from "../validate.js";
import { getNamespace } from "../namespaces.js";
import { contentSizeError, holdRefusal } from "../messages.js";
import { writeMessage } from "./messaging.js";
import { stmtLatestPlan, planApproval, allowedUnapproved } from "./sprint.js";
import { reservedSenderRefusal, orchestratorNames } from "../auth.js";

const BASE_PREFIXES = ["PASS", "FAIL", "SKIP"];
const err = (text) => ({ content: [{ type: "text", text }], isError: true });
class FieldError extends Error {}
const fail = (field, problem, source) => { throw new FieldError(`${field}: ${problem} [${source}]`); };

// Namespace: explicit ns, else the task_id prefix if it names a registered namespace, else the
// one manifest that declares the sender as a worker.
function resolveNs(ns, { taskId, sender }) {
  if (ns) return getNamespace(ns) ?? fail("ns", `no manifest registered for '${ns}'`, "register_namespace");
  if (taskId?.includes("-")) {
    const m = getNamespace(nsOf(taskId));
    if (m) return m;
  }
  const owners = sender ? stmtNsList.all().map(r => getNamespace(r.ns)).filter(m => m?.workers.has(sender)) : [];
  if (owners.length === 1) return owners[0];
  if (owners.length > 1) fail("ns", `sender '${sender}' is a worker in ${owners.map(m => m.ns).join(", ")}; pass ns`, "manifest workers");
  return fail("ns", `cannot resolve — pass ns, a task_id '<ns>-…', or a sender declared in a manifest's workers`, "manifest lookup");
}

function channelOf(m, suffix) {
  const ch = `${m.ns}-${suffix}`;
  if (!m.channels.has(ch)) fail("channel", `manifest ${m.ns} declares no '${ch}' channel`, `manifest ${m.ns} channels`);
  return ch;
}

function orchestratorOf(m) {
  for (const [name, w] of m.workers) if (w.role === "orchestrator") return name;
  return fail("to", `manifest ${m.ns} has no orchestrator-role worker to default to; pass it`, `manifest ${m.ns} workers`);
}

// The plan gate is opt-in per namespace (manifest plan_gate: true); elsewhere its tools and field are refused.
function planGated(m, field) {
  if (!m.planGate) fail(field, `the plan gate is not enabled for namespace ${m.ns}`, `manifest ${m.ns} plan_gate`);
}

function workerOf(m, name, field) {
  return m.workers.get(name) ?? fail(field, `'${name}' is not a worker in manifest ${m.ns} (${[...m.workers.keys()].join(", ")})`, `manifest ${m.ns} workers`);
}

// Drop undefined keys so the envelope carries only what was given, in the order listed.
const envelope = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

function post(tool, channel, sender, msg, note = "") {
  // dispatch_task / decide_plan default to the orchestrator's name; in a trust namespace that needs the credential.
  const content = JSON.stringify(msg);
  const refusal = reservedSenderRefusal(channel, sender) ?? holdRefusal(channel, sender, content);
  if (refusal) return err(`${tool} refused on '${channel}': ${refusal}`);
  const tooBig = contentSizeError(content);
  if (tooBig) return err(`${tool} rejected on '${channel}': ${tooBig}`);
  const check = validateContent(channel, content);
  if (!check.ok) return err(`${tool} rejected on '${channel}': ${check.errors}${check.v2 ? ` [v2 schema ${channel}]${schemaHint(channel, check)}` : ""}`);
  const { id, now } = writeMessage(channel, sender, content);
  return { content: [{ type: "text", text: `Sent #${id} to '${channel}' as '${sender}' (type:${msg.type}${msg.task_id ? `, task_id:${msg.task_id}` : ""}) at ${new Date(now).toISOString()}.${note}` }] };
}

// The dispatched task's row on a worker inbox, and its subject (null when absent).
function dispatchedTask(inbox, taskId) {
  const row = inbox && stmtTaskInInbox.get(inbox, taskId);
  if (!row) return { row: null, subject: undefined };
  try { const s = JSON.parse(row.content).subject; return { row, subject: typeof s === "string" && s ? s : undefined }; }
  catch { return { row, subject: undefined }; }
}

// A task field the manifest requires (extensions.task.required) is given = present and non-empty.
const given = (v) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length)
  && !(typeof v === "object" && !Array.isArray(v) && !Object.values(v).some(given));
// Warned about (never required) when the manifest requires no task fields.
const RECOMMENDED_TASK_FIELDS = ["context", "scope", "files", "checks", "acceptance_criteria"];

// Why a dispatch check's run cannot work as a shell command, or null. The verifier runs it with bash -c, so:
// it must parse (bash -n, nothing executed), and it must not be prose — four or more words whose first is not
// a command (no '/', unknown to bash's type) and that start capitalised or end in '.'. send_message reuses it
// to warn on a raw-sent task.
export function checkRunProblem(run) {
  if (typeof run !== "string" || !run.trim()) return "empty";
  const n = spawnSync("bash", ["-n", "-c", run], { encoding: "utf8", timeout: 2000 });
  if (n.status !== 0) return `does not parse as a shell command (bash -n: ${(n.stderr || n.error?.message || "").trim().split("\n")[0].slice(0, 200)})`;
  const words = run.trim().split(/\s+/), first = words[0];
  if (words.length >= 4 && !first.includes("/") && (/^[A-Z][a-z]/.test(first) || /\.$/.test(run.trim()))
      && spawnSync("bash", ["-c", 'type -t -- "$1"', "_", first], { encoding: "utf8", timeout: 2000 }).status !== 0)
    return `reads as prose, not a command ('${first}' is not a command)`;
  return null;
}
export const checksProblem = (checks) => {
  for (const [i, c] of (Array.isArray(checks) ? checks : []).entries()) {
    const why = checkRunProblem(c?.run);
    if (why) return `checks[${i}]${typeof c?.name === "string" && c.name ? ` '${c.name}'` : ""}.run ${why}`;
  }
  return null;
};

const typed = (tool, fn) => async (args) => {
  try { return fn(args); }
  catch (e) { if (e instanceof FieldError) return err(`${tool}: ${e.message}`); throw e; }
};

const strs = z.array(z.string());

// identity (from the MCP URL, may be null): ns and as become the defaults for ns and sender/from,
// and the schemas say so. Without identity the schemas are exactly the v2-era ones.
export function registerTypedTools(server, identity = null) {
  const idNs = identity?.ns, idAs = identity?.as;
  const NS = z.string().min(1).optional().describe(idNs
    ? `Namespace, e.g. 'cb'. Default: '${idNs}' (connection identity).`
    : "Namespace, e.g. 'cb'. Default: from task_id prefix or the sender's manifest.");
  const SENDER = idAs
    ? z.string().min(1).optional().describe(`Your worker name. Default: '${idAs}' (connection identity).`)
    : z.string().min(1).describe("Your worker name.");
  // Fill ns/sender from identity before the handler sees the args.
  const withId = (a) => ({ ...a, ns: a.ns ?? idNs, sender: a.sender ?? idAs });

  // ── dispatch_task ───────────────────────────────────────────────────────────
  server.registerTool("dispatch_task", {
    title: "Dispatch a task",
    description: "Post a type:task to a worker's inbox (from the namespace manifest). Builds and validates the envelope; rejects on any schema error.",
    inputSchema: {
      ns: NS,
      to: z.string().min(1).describe("Worker name in the manifest."),
      task_id: z.string().min(1),
      subject: z.string().min(1),
      body: z.any().describe("String or object."),
      from: z.string().min(1).optional().describe(idAs ? `Default: '${idAs}' (connection identity).` : "Default: the manifest's orchestrator."),
      context: z.string().optional(),
      background: z.string().optional(),
      scope: z.enum(["small", "medium", "large"]).optional(),
      depends_on: strs.optional(),
      files: z.object({ read: strs.optional(), write: strs.optional() }).optional(),
      constraints: strs.optional(),
      checks: z.array(z.object({ name: z.string(), run: z.string(), pass_condition: z.string() })).optional(),
      acceptance_criteria: strs.optional(),
      result_template: z.any().optional(),
      refs: strs.optional(),
      plan_required: z.boolean().optional().describe("Plan before code (plan-gated namespaces only). Default: true for medium|large."),
    },
  }, typed("dispatch_task", (a) => {
    a = { ...a, ns: a.ns ?? idNs, from: a.from ?? idAs };
    const m = resolveNs(a.ns, { taskId: a.task_id, sender: a.from });
    const w = workerOf(m, a.to, "to");
    if (!w.inbox) fail("to", `worker '${a.to}' has no inbox`, `manifest ${m.ns} workers`);
    const from = a.from ?? orchestratorOf(m);
    const bad = checksProblem(a.checks);
    if (bad) fail("checks", `${bad} — the verifier runs it with bash -c and it would FAIL`, "dispatch checks");
    // plan_required is written only when passed: the medium|large default is derived by get_task_ledger,
    // so a task envelope carries no key a v2 inbox schema (additionalProperties:false) would reject.
    if (a.plan_required !== undefined) planGated(m, "plan_required");
    const required = m.taskRequired(m.roleOf.get(from), w.inbox);
    const missing = (required ?? RECOMMENDED_TASK_FIELDS).filter(f => !given(a[f]));
    if (missing.length && required) fail(missing[0], `required by namespace ${m.ns} (missing: ${missing.join(", ")})`, `manifest ${m.ns} extensions.task.required`);
    const warning = missing.length ? ` Warning: no ${missing.join(", ")} — the worker gets less to go on (manifest ${m.ns} requires no task fields, so not enforced).` : "";
    return post("dispatch_task", w.inbox, from, envelope({
      type: "task", task_id: a.task_id, from, to: a.to, subject: a.subject,
      context: a.context, background: a.background, scope: a.scope, depends_on: a.depends_on, files: a.files,
      constraints: a.constraints, checks: a.checks, acceptance_criteria: a.acceptance_criteria,
      result_template: a.result_template, plan_required: a.plan_required, body: a.body, refs: a.refs,
    }), warning);
  }));

  // ── post_result ─────────────────────────────────────────────────────────────
  server.registerTool("post_result", {
    title: "Post a task result",
    description: "Post a type:result to <ns>-status. Fills type/from/to and copies subject from the dispatched task. summary must start with a prefix allowed for the sender's role (PASS|FAIL|SKIP, plus manifest roles.<role>.summary_prefixes).",
    inputSchema: {
      ns: NS,
      sender: SENDER,
      task_id: z.string().min(1),
      summary: z.string().min(1).describe("'PASS — …' / 'FAIL — …' / 'SKIP — …'."),
      body: z.any().optional().describe("Checks, commits, output_ref, consent_basis …"),
      affected_files: strs.optional(),
      subject: z.string().min(1).optional().describe("Default: the task's subject."),
      to: z.string().min(1).optional().describe("Default: the manifest's orchestrator."),
      refs: strs.optional(),
    },
  }, typed("post_result", (a) => {
    a = withId(a);
    const m = resolveNs(a.ns, { taskId: a.task_id, sender: a.sender });
    const w = workerOf(m, a.sender, "sender");
    const extra = m.rolePrefixes.get(w.role) ?? [];
    const allowed = [...BASE_PREFIXES, ...extra];
    if (!allowed.some(p => new RegExp(`^${p}\\b`).test(a.summary))) {
      const got = /^\S+/.exec(a.summary)?.[0] ?? "";
      fail("summary", `prefix '${got}' is not allowed for '${a.sender}' (role ${w.role}); allowed: ${allowed.join("|")}`,
        extra.length ? `base/result + manifest ${m.ns} roles.${w.role}.summary_prefixes` : "base/result");
    }
    const channel = channelOf(m, "status");
    // Plan gate: a task that needs a plan cannot report PASS (or APPROVE / ADVISE) before its plan is approved;
    // FAIL, SKIP and BLOCK stay allowed so a worker can always say it cannot proceed.
    const gate = allowedUnapproved(a.summary) ? null : planApproval(m, channel, a.task_id);
    if (gate?.required && !gate.approved) {
      fail("task_id", `plan not approved (${gate.state}${gate.plan_id ? `, latest plan #${gate.plan_id}` : ", no plan posted"}${gate.decision ? `, decision #${gate.decision.id} ${gate.decision.decision}` : ""}) — post_plan and wait for approve; FAIL/SKIP/BLOCK may still be posted`, "plan gate");
    }
    const subject = a.subject ?? dispatchedTask(w.inbox, a.task_id).subject
      ?? fail("subject", `required — no type:task '${a.task_id}' with a subject on ${w.inbox ?? "(no inbox)"} to copy it from`, "base/result");
    return post("post_result", channel, a.sender, envelope({
      type: "result", task_id: a.task_id, from: a.sender, to: a.to ?? orchestratorOf(m), subject,
      summary: a.summary, affected_files: a.affected_files, body: a.body, refs: a.refs,
    }));
  }));

  // ── ask ─────────────────────────────────────────────────────────────────────
  server.registerTool("ask", {
    title: "Ask a blocking question",
    description: "Post a type:question to <ns>-status that open_questions and get_task_ledger track (task shows 'blocked') until a reply naming the task_id lands on the reply channel or you post its result.",
    inputSchema: {
      ns: NS,
      sender: SENDER,
      task_id: z.string().min(1),
      question: z.string().min(1),
      expected_reply_channel: z.string().min(1).optional().describe("Default: your inbox."),
      to: z.string().min(1).optional().describe("Default: the manifest's orchestrator."),
      subject: z.string().min(1).optional().describe("Default: the question, clipped to 120 chars."),
      body: z.record(z.any()).optional().describe("Extra body fields (options, context …)."),
    },
  }, typed("ask", (a) => {
    a = withId(a);
    const m = resolveNs(a.ns, { taskId: a.task_id, sender: a.sender });
    const channel = channelOf(m, "status");
    // open_questions watches <ns>-<asker> unless body names another channel; name the manifest
    // inbox only when it differs from that default.
    const inbox = m.workers.get(a.sender)?.inbox;
    const reply = a.expected_reply_channel ?? (inbox && inbox !== `${m.ns}-${a.sender}` ? inbox : undefined);
    const subject = a.subject ?? (a.question.length > 120 ? `${a.question.slice(0, 119)}…` : a.question);
    return post("ask", channel, a.sender, envelope({
      type: "question", task_id: a.task_id, from: a.sender, to: a.to ?? orchestratorOf(m), subject,
      body: envelope({ question: a.question, expected_reply_channel: reply, ...(a.body || {}) }),
    }));
  }));

  // ── post_note ───────────────────────────────────────────────────────────────
  server.registerTool("post_note", {
    title: "Post a finding, decision or resolution",
    description: "Post team knowledge to <ns>-notes: kind finding|decision (subject, summary, scope, evidence, confidence) or resolved (ref_id, outcome) to close an earlier note.",
    inputSchema: {
      ns: NS,
      sender: SENDER,
      kind: z.enum(["finding", "decision", "resolved"]),
      subject: z.string().min(1),
      summary: z.string().optional().describe("The claim or choice, 1-2 sentences."),
      scope: strs.optional().describe("Files/dirs it applies to."),
      evidence: z.string().optional(),
      confidence: z.enum(["confirmed", "suspected"]).optional(),
      to: z.string().min(1).optional().describe("Default '*' for finding/decision."),
      task_id: z.string().optional(),
      ref_id: z.number().int().positive().optional().describe("resolved: the note id it closes."),
      outcome: z.enum(["fixed", "superseded", "invalid", "expired"]).optional(),
      expires_at: z.string().optional(),
      refs: strs.optional(),
    },
  }, typed("post_note", (a) => {
    a = withId(a);
    const m = resolveNs(a.ns, { taskId: a.task_id, sender: a.sender });
    const channel = channelOf(m, "notes");
    return post("post_note", channel, a.sender, envelope({
      type: a.kind, task_id: a.task_id, from: a.sender, to: a.to ?? (a.kind === "resolved" ? undefined : "*"),
      subject: a.subject, summary: a.summary, scope: a.scope, evidence: a.evidence, confidence: a.confidence,
      ref_id: a.ref_id, outcome: a.outcome, expires_at: a.expires_at, refs: a.refs,
    }));
  }));
  // ── post_plan ───────────────────────────────────────────────────────────────
  server.registerTool("post_plan", {
    title: "Post a plan for review",
    description: "Post a type:plan to <ns>-status before writing code on a plan_required task. The ledger shows the task 'plan-review' until the orchestrator decides; exit after posting — the watchdog relaunches you when the plan-decision lands on your inbox.",
    inputSchema: {
      ns: NS,
      sender: SENDER,
      task_id: z.string().min(1),
      approach: z.string().min(1),
      steps: strs.min(1),
      files: z.object({ read: strs.optional(), write: strs.optional() }),
      risks: strs.optional(),
      questions: strs.optional(),
      subject: z.string().min(1).optional().describe("Default: the task's subject."),
      to: z.string().min(1).optional().describe("Default: the manifest's orchestrator."),
    },
  }, typed("post_plan", (a) => {
    a = withId(a);
    const m = resolveNs(a.ns, { taskId: a.task_id, sender: a.sender });
    planGated(m, "ns");
    const w = workerOf(m, a.sender, "sender");
    const channel = channelOf(m, "status");
    const subject = a.subject ?? dispatchedTask(w.inbox, a.task_id).subject
      ?? fail("subject", `required — no type:task '${a.task_id}' with a subject on ${w.inbox ?? "(no inbox)"} to copy it from`, "base/plan");
    return post("post_plan", channel, a.sender, envelope({
      type: "plan", task_id: a.task_id, from: a.sender, to: a.to ?? orchestratorOf(m), subject,
      body: { approach: a.approach, steps: a.steps, files: { read: a.files.read ?? [], write: a.files.write ?? [] },
              risks: a.risks ?? [], open_questions: a.questions ?? [] },
    }), ` Task is now plan-review: exit; you are relaunched when the plan-decision lands on ${w.inbox ?? "your inbox"}.`);
  }));

  // ── decide_plan ─────────────────────────────────────────────────────────────
  server.registerTool("decide_plan", {
    title: "Approve, amend or reject a plan",
    description: "Post a type:plan-decision for the latest type:plan of task_id to the planning worker's inbox, which relaunches it. approve → task in-progress; amend → planning again (worker revises and re-posts); reject → failed until re-dispatched. amend and reject need notes or amendments. waiver: true approves a task that has no plan.",
    inputSchema: {
      ns: NS,
      sender: z.string().min(1).optional().describe(idAs ? `Default: '${idAs}' (connection identity).` : "Default: the manifest's orchestrator."),
      task_id: z.string().min(1),
      decision: z.enum(["approve", "amend", "reject"]),
      notes: z.string().optional(),
      amendments: strs.optional(),
      to: z.string().min(1).optional().describe("Default: the plan's author (must be it)."),
      subject: z.string().min(1).optional(),
      waiver: z.boolean().optional().describe("approve only: accept a task that has no plan."),
    },
  }, typed("decide_plan", (a) => {
    a = { ...a, ns: a.ns ?? idNs, sender: a.sender ?? idAs };
    const m = resolveNs(a.ns, { taskId: a.task_id, sender: a.sender });
    planGated(m, "ns");
    const sender = a.sender ?? orchestratorOf(m);
    const status = channelOf(m, "status");
    const planRow = stmtLatestPlan.get(status, a.task_id);
    let plan = {}, author;
    if (a.waiver) {
      // Waiver: the orchestrator accepts a task that has no plan; it goes to the task's dispatched worker.
      if (a.decision !== "approve") fail("waiver", "only an approve can waive the plan", "plan gate");
      if (planRow) fail("waiver", `'${a.task_id}' has a plan (#${planRow.id}) — decide it instead`, "plan gate");
      const d = stmtTaskDispatches.all(`${m.ns}-`, JSON.stringify([...orchestratorNames(m.ns)]), a.task_id)[0]
        ?? fail("task_id", `no dispatch of '${a.task_id}' from the orchestrator — nothing to waive`, "plan gate");
      let t = {}; try { t = JSON.parse(d.content); } catch { /* use the channel */ }
      author = typeof t.to === "string" && t.to && t.to !== "*" ? t.to : d.channel.slice(m.ns.length + 1);
    } else {
      if (!planRow) fail("task_id", `no type:plan for '${a.task_id}' on ${status} — nothing to decide`, "post_plan");
      try { plan = JSON.parse(planRow.content); } catch { /* use the row */ }
      author = typeof plan.from === "string" && plan.from ? plan.from : planRow.sender;
    }
    if (a.to !== undefined && a.to !== author) fail("to", `'${a.to}' is not the ${a.waiver ? "task's worker" : "plan's author"} '${author}' — a decision goes to them`, "plan gate");
    const w = workerOf(m, author, "to");
    if (!w.inbox) fail("to", `worker '${author}' has no inbox`, `manifest ${m.ns} workers`);
    if (author === sender) fail("sender", `'${sender}' wrote the plan and cannot decide it`, "plan gate");
    if (a.decision !== "approve" && !a.notes && !a.amendments?.length) fail("notes", `${a.decision} needs notes or amendments`, "base/plan-decision");
    const task = dispatchedTask(w.inbox, a.task_id);
    const subject = a.subject ?? task.subject ?? (typeof plan.subject === "string" && plan.subject ? plan.subject : a.task_id);
    return post("decide_plan", w.inbox, sender, envelope({
      type: "plan-decision", task_id: a.task_id, from: sender, to: author, subject,
      body: envelope({ decision: a.decision, notes: a.notes, amendments: a.amendments, ...(a.waiver && { waiver: true }) }),
      refs: [...(planRow ? [`${status}#${planRow.id}`] : []), ...(task.row ? [`${w.inbox}#${task.row.id}`] : [])],
    }));
  }));
}
