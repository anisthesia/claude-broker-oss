// Usage ledger: one JSON line per runner session, appended to <dir>/<YYYY-MM-DD>.jsonl (local date).
//
// Row (v 1): the token counts and cost come from the session's final result event. Without a result
// (the SDK threw, the session was stopped) they are null and the row still lands, so a failed
// session stays visible.
//
//   {"v":1,"ts":"<ISO UTC>","source":"claude","ref":"<session id>","ns":"mg","worker":"analytics",
//    "brand":"brand-a"|null,"task_id":"…"|null,"task_ids":[…],"model":"<configured model>","session_id":"<uuid>",
//    "input_tokens":18,"cache_read":34962,"cache_create":7514,"output_tokens":141,"cost_usd":0.0192472,
//    "model_usage":{"<model>":{"input_tokens":…,"output_tokens":…,"cache_read":…,"cache_create":…,"cost_usd":…}},
//    "is_error":false,"exit_code":0,"num_turns":2,"duration_ms":8986,"launcher":"sdk"}
//
// source and ref make a row idempotent on (source, ref); a later row kind (voice minutes, TTS
// characters) adds its own source and ref and a `units` object without changing this shape.
// No message content and no tool output goes into a row: only ids, counts and the brand slug.
//
// Attribution, from the session's own broker traffic:
//   task_ids  every task_id the session wrote a result or an ask for (mcp__broker__post_result /
//             ask, or send_message of a type result), in order
//   task_id   the first of those; else the one task envelope the session read, when it read exactly one
//   brand     the `brand` of that task's envelope as read from the broker; else a top-level `brand`
//             on a broker write of the session (post_result body, note, send_message content); else null
//
// Directory: --usage-dir, else RUNNER_USAGE_DIR, else <repo root>/ops/usage when that directory
// exists; else no ledger. A failed write never changes the exit code: one stderr line.

import { appendFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const BROKER_TOOL = /^mcp__broker__(.+)$/;
const RESULT_TOOLS = new Set(["post_result", "ask"]);
const MAX_DEPTH = 8;

export function resolveLedgerDir({ usageDir = "", repoRoot = "" } = {}, env = process.env) {
  if (usageDir) return { dir: resolve(usageDir), create: true };
  if (env.RUNNER_USAGE_DIR) return { dir: resolve(env.RUNNER_USAGE_DIR), create: true };
  if (repoRoot) {
    const d = join(repoRoot, "ops", "usage");
    if (existsSync(d) && statSync(d).isDirectory()) return { dir: d, create: false };
  }
  return null;
}

function tryJson(s) {
  if (typeof s !== "string") return undefined;
  const t = s.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return undefined;
  try { return JSON.parse(t); } catch { return undefined; }
}

// Every object reachable from v, following strings that are themselves JSON (broker message content).
function* objects(v, depth = 0) {
  if (depth > MAX_DEPTH || v === null || v === undefined) return;
  if (typeof v === "string") { const j = tryJson(v); if (j !== undefined) yield* objects(j, depth + 1); return; }
  if (Array.isArray(v)) { for (const x of v) yield* objects(x, depth + 1); return; }
  if (typeof v !== "object") return;
  yield v;
  for (const x of Object.values(v)) yield* objects(x, depth + 1);
}

// Text of a tool result: a string, or the text blocks of a content array. Broker tools answer with
// JSON, or with "[#id] ts <sender>: {json}" lines; both are reduced to parsed values.
function resultValues(content) {
  const texts = typeof content === "string" ? [content]
    : Array.isArray(content) ? content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text) : [];
  const out = [];
  for (const t of texts) {
    const whole = tryJson(t);
    if (whole !== undefined) { out.push(whole); continue; }
    for (const line of t.split("\n")) {
      const i = line.indexOf("{");
      if (i < 0) continue;
      const j = tryJson(line.slice(i));
      if (j !== undefined) out.push(j);
    }
  }
  return out;
}

const slug = (s) => (typeof s === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(s) ? s : null);

export class Attribution {
  constructor() {
    this.tasksRead = new Map();  // task_id -> brand | null, as read from task envelopes
    this.written = [];           // task ids the session posted a result or ask for
    this.writeBrand = null;      // first top-level brand on a broker write
    this.brokerTools = new Map(); // tool_use id -> broker tool name
  }

  observe(msg) {
    if (!msg || typeof msg !== "object" || msg.parent_tool_use_id) return;
    const content = msg.message && Array.isArray(msg.message.content) ? msg.message.content : [];
    if (msg.type === "assistant") {
      for (const b of content) {
        if (!b || b.type !== "tool_use" || typeof b.name !== "string") continue;
        const m = b.name.match(BROKER_TOOL);
        if (!m) continue;
        this.brokerTools.set(b.id, m[1]);
        this.observeWrite(m[1], b.input || {});
      }
    } else if (msg.type === "user") {
      for (const b of content) {
        if (!b || b.type !== "tool_result" || !this.brokerTools.has(b.tool_use_id)) continue;
        for (const v of resultValues(b.content)) {
          for (const o of objects(v)) {
            if (o.type === "task" && slug(o.task_id) && !this.tasksRead.has(o.task_id)) this.tasksRead.set(o.task_id, slug(o.brand));
          }
        }
      }
    }
  }

  observeWrite(tool, input) {
    let env = input;
    if (tool === "send_message") env = tryJson(input.content) || {};
    else if (!["post_result", "ask", "post_note"].includes(tool)) return;
    const taskId = slug(env.task_id);
    if (taskId && (RESULT_TOOLS.has(tool) || (tool === "send_message" && env.type === "result")) && !this.written.includes(taskId)) this.written.push(taskId);
    if (!this.writeBrand) {
      const body = env.body && typeof env.body === "object" ? env.body : {};
      this.writeBrand = slug(env.brand) || slug(body.brand);
    }
  }

  resolve() {
    let taskId = this.written[0] || null;
    if (!taskId && this.tasksRead.size === 1) taskId = [...this.tasksRead.keys()][0];
    const brand = (taskId && this.tasksRead.get(taskId)) || this.writeBrand || null;
    return { task_id: taskId, task_ids: [...this.written], brand };
  }
}

const n = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);

export function buildRow({ session, identity, result, sessionId, attribution, exitCode, now = new Date() }) {
  const u = (result && result.usage) || {};
  const modelUsage = result && result.modelUsage && typeof result.modelUsage === "object"
    ? Object.fromEntries(Object.entries(result.modelUsage).map(([m, x]) => [m, {
        input_tokens: n(x && x.inputTokens), output_tokens: n(x && x.outputTokens),
        cache_read: n(x && x.cacheReadInputTokens), cache_create: n(x && x.cacheCreationInputTokens), cost_usd: n(x && x.costUSD),
      }]))
    : null;
  const sid = (result && result.session_id) || sessionId || null;
  const a = attribution.resolve();
  return {
    v: 1, ts: now.toISOString(), source: "claude", ref: sid,
    ns: identity.ns, worker: identity.as, brand: a.brand, task_id: a.task_id, task_ids: a.task_ids,
    model: session.model, session_id: sid,
    input_tokens: n(u.input_tokens), cache_read: n(u.cache_read_input_tokens), cache_create: n(u.cache_creation_input_tokens),
    output_tokens: n(u.output_tokens), cost_usd: result ? n(result.total_cost_usd) : null, model_usage: modelUsage,
    is_error: result ? Boolean(result.is_error) : true, exit_code: exitCode,
    num_turns: result ? n(result.num_turns) : null, duration_ms: result ? n(result.duration_ms) : null, launcher: "sdk",
  };
}

// Local calendar date, so the file name matches the machine's day (the fleet runs on IST).
export function ledgerFile(dir, now = new Date()) {
  const p = (x) => String(x).padStart(2, "0");
  return join(dir, `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}.jsonl`);
}

// Appends the row. Returns the file written, or throws (the caller logs and carries on).
export function appendRow(target, row, now = new Date()) {
  if (target.create) mkdirSync(target.dir, { recursive: true });
  const file = ledgerFile(target.dir, now);
  appendFileSync(file, JSON.stringify(row) + "\n");
  return file;
}
