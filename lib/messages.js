// Message bus, read formatting, filtered fetches, open-question scan and background pruning.
import { EventEmitter } from "events";
import { MAX_CONTENT_BYTES, PRUNE_INTERVAL_MS, PRUNE_MAX_AGE_MS, PRUNE_EXEMPT, PRUNE_SIGNAL_TYPES, PRUNE_SIGNAL_MAX_AGE_MS, HEARTBEAT_TRANSIENT_STATES } from "./config.js";
import { metrics, setInsertGuard, stmtSelect, stmtSelectFilter, getMultiSenderStmt, stmtPruneAllOld, stmtPruneSignalOld, stmtDeleteTransientHeartbeats, stmtQuestions, stmtQuestionReply, stmtQuestionAnswerAnywhere, stmtQuestionSelfResult, getFeedStmt } from "./db.js";
import { nsOf } from "./util.js";
import { getNamespace } from "./namespaces.js";
import { requestContext } from "./auth.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

// Reject channel names containing control characters or newlines (prevents log injection).
export function isValidChannelName(ch) {
  return /^[^\x00-\x1f\x7f]+$/.test(ch);
}

// ── Message bus ───────────────────────────────────────────────────────────────

export const messageBus = new EventEmitter();
messageBus.setMaxListeners(0);

// Write-size cap shared by every write path. Returns an error string, or null when content fits.
export function contentSizeError(content) {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes <= MAX_CONTENT_BYTES) return null;
  return `content is ${bytes} bytes, over the broker cap MAX_CONTENT_BYTES=${MAX_CONTENT_BYTES}. Put large output in a file (body.output_ref) or the repo and reference it (refs), and keep the envelope to headline fields — readers fetch single fields with get_message(channel, id, path).`;
}

// Resolve a dot/bracket path ("body.commits[0].sha", 'body["a.b"]', optional leading "$.") against a
// parsed value. Returns { ok:true, value } or { ok:false, error } naming the first missing segment.
export function resolvePath(root, path) {
  const segs = [];
  const re = /\.?([^.[\]]+)|\[(\d+)\]|\[\s*(["'])((?:\\.|(?!\3).)*)\3\s*\]/gy;
  let src = path.trim().replace(/^\$\.?/, ""), m;
  re.lastIndex = 0;
  while (re.lastIndex < src.length) {
    const at = re.lastIndex;
    if (!(m = re.exec(src)) || m.index !== at) return { ok: false, error: `invalid path '${path}' at offset ${at}: use dot keys and [index] or ["key"] brackets` };
    segs.push(m[1] ?? (m[2] != null ? Number(m[2]) : m[4].replace(/\\(.)/g, "$1")));
  }
  let cur = root, walked = "$";
  for (const seg of segs) {
    const has = cur !== null && typeof cur === "object" && Object.prototype.hasOwnProperty.call(cur, seg);
    if (!has) {
      const keys = cur !== null && typeof cur === "object" ? Object.keys(cur) : [];
      const hint = Array.isArray(cur) ? ` (array of length ${cur.length})`
        : keys.length ? ` (keys: ${keys.slice(0, 20).join(", ")}${keys.length > 20 ? ", …" : ""})`
        : ` (${cur === null ? "null" : typeof cur} has no fields)`;
      return { ok: false, error: `path '${path}' not found: '${seg}' missing at ${walked}${hint}` };
    }
    cur = cur[seg];
    walked += typeof seg === "number" ? `[${seg}]` : `.${seg}`;
  }
  return { ok: true, value: cur };
}

// Hold mode: a manifest worker with mode "hold" (a hold-only judge) may write only held judgments on
// <ns>-notes, type:status on <ns>-status and its telemetry (<ns>-telemetry, <ns>-rate-limits), and may not
// delete. The sender counts as hold-only when its own manifest entry says so, or when the request's URL
// identity (?ns=&as=) does: that catches a write under another sender name or into another namespace.
// Names match case-insensitively and with a leading '<ns>-' ignored ('Judge', 'ca-judge' are the judge).
function holdWorker(ns, name) {
  if (!ns || !name) return null;
  ns = ns.toLowerCase();
  const m = getNamespace(ns);
  if (!m) return null;
  let lc = name.toLowerCase();
  if (lc.startsWith(`${ns}-`)) lc = lc.slice(ns.length + 1);
  for (const [n, w] of m.workers) if (w.mode === "hold" && n.toLowerCase() === lc) return n;
  return null;
}

// { ns, who } when this write/delete on `channel` as `sender` comes from a hold-only worker, else null.
export function holdIdentity(channel, sender) {
  if (typeof channel !== "string") return null;
  const ctx = requestContext.getStore();
  const own = nsOf(channel), mine = holdWorker(own, sender);
  if (mine) return { ns: own.toLowerCase(), who: mine };
  const viaUrl = holdWorker(ctx?.ns, ctx?.as);
  return viaUrl ? { ns: ctx.ns.toLowerCase(), who: viaUrl } : null;
}

const holdText = ({ ns, who }) => `'${who}' is hold-only in namespace '${ns}' (manifest workers[].mode "hold"): ` +
  `it may write only type:judgment with verdict "held" on ${ns}-notes, type:status on ${ns}-status, and ${ns}-telemetry / ${ns}-rate-limits, and may not delete. ` +
  `Hold the question in a judgment row instead; the orchestrator or the human answers it.`;

// Telemetry channels a hold-only worker may write anything to (heartbeats + watchdog backoff events).
export const isHoldTelemetry = (h, channel) => channel === `${h.ns}-telemetry` || channel === `${h.ns}-rate-limits`;

// Refusal text or null; uncounted. The insert guard (lib/db.js stmtInsert) counts its own refusals.
function holdCheck(channel, sender, content) {
  const h = holdIdentity(channel, sender);
  if (!h || isHoldTelemetry(h, channel)) return null;
  let p = null;
  try { p = JSON.parse(content); } catch {}
  if (channel === `${h.ns}-notes` && p?.type === "judgment" && p.verdict === "held") return null;
  if (channel === `${h.ns}-status` && p?.type === "status") return null;
  return holdText(h);
}
setInsertGuard(holdCheck);

// Per-tool up-front check (clearer errors, batch refused whole): refusal text (counted in guard_refusals) or null.
export function holdRefusal(channel, sender, content) {
  const refusal = holdCheck(channel, sender, content);
  if (refusal) metrics.guard_refusals++;
  return refusal;
}

// A hold-only worker may not delete (a deleted question drops out of open_questions): refusal text (counted) or null.
export function holdDeleteRefusal(channel, sender) {
  const h = holdIdentity(channel, sender);
  if (!h) return null;
  metrics.guard_refusals++;
  return holdText(h);
}

const SUMMARY_FIELD_MAX = 300;

// Compact view of a message for projection="summary": envelope headline fields only.
// Lets an orchestrator scan 30 results in ~3 KB instead of ~150 KB, then open the ones it needs.
export function summarizeContent(content) {
  const bytes = Buffer.byteLength(content, "utf8");
  try {
    const p = JSON.parse(content);
    if (!p || typeof p !== "object") throw 0;
    const out = { bytes };
    for (const k of ["type", "task_id", "from", "to", "subject", "summary"]) if (p[k] != null) out[k] = p[k];
    if (typeof p.verdict === "string") out.verdict = p.verdict.slice(0, 40); // judgment rows: held / decided / returned
    // A summary line is a headline, not a body: clip runaway subject/summary so a scan stays cheap.
    for (const k of ["subject", "summary"]) {
      if (typeof out[k] === "string" && out[k].length > SUMMARY_FIELD_MAX) {
        out[k] = out[k].slice(0, SUMMARY_FIELD_MAX - 1) + "…";
        out.truncated = true;
      }
    }
    if (Array.isArray(p.depends_on) && p.depends_on.length) out.depends_on = p.depends_on;
    if (Array.isArray(p.affected_files)) out.affected_files_count = p.affected_files.length;
    return out;
  } catch {
    return { bytes, text: content.length > 120 ? content.slice(0, 120) + "…" : content };
  }
}

export function formatRows(rows, channel, sinceId, projection, meta) {
  const via = meta?.source === "cursor" ? ", resumed from server cursor" : "";
  if (rows.length === 0) return { content: [{ type: "text", text: `No new messages on '${channel}' (since_id=${sinceId}${via}).` }] };
  const lines = rows.map(r => `[#${r.id}] ${new Date(r.created_at).toISOString()} <${r.sender}>: ${projection === "summary" ? JSON.stringify(summarizeContent(r.content)) : r.content}`);
  if (meta?.source === "tail" && meta.skipped > 0)
    lines.unshift(`(newest ${rows.length} of ${rows.length + meta.skipped} on '${channel}'; ${meta.skipped} older not shown — pass since_id to page back)`);
  lines.push(`\n(next since_id: ${rows[rows.length - 1].id})${meta?.remaining ? ` (${meta.remaining} more pending beyond limit)` : ""}${via ? " (resumed from server cursor)" : ""}`);
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

export function fetchFiltered(channel, sinceId, lim, filterSender, filterType) {
  if (filterSender && filterSender.includes(",")) {
    const senders = filterSender.split(",").map(s => s.trim()).filter(Boolean);
    const stmt = getMultiSenderStmt(senders.length, !!filterType);
    const params = [channel, sinceId, ...senders, ...(filterType ? [filterType] : []), lim];
    return stmt.all(...params);
  }
  if (filterSender || filterType) {
    return stmtSelectFilter.all(
      channel, sinceId,
      filterSender ?? null, filterSender ?? null,
      filterType   ?? null, filterType   ?? null,
      lim
    );
  }
  return stmtSelect.all(channel, sinceId, lim);
}

function fetchFeedRows(channels, signalOnly, limit) {
  if (channels.length === 0) return [];
  return getFeedStmt(channels.length, signalOnly).all(...channels, limit);
}

// A question is open when nothing later on its reply channel names its task_id, nothing later
// anywhere under the prefix answers it (ref_id = its id, or type:answer with its task_id), and
// the asker has not posted a result for it. Shared by open_questions and get_task_ledger.
export function scanOpenQuestions(prefix, max_age_ms) {
  const now  = Date.now();
  const rows = stmtQuestions.all(`${prefix}%`);
  const open = [];
  let answered = 0;
  for (const r of rows) {
    if (max_age_ms && now - r.created_at > max_age_ms) continue;
    let q = {};
    try { q = JSON.parse(r.content); } catch { continue; }
    const asker  = typeof q.from === "string" && q.from ? q.from : r.sender;
    const taskId = typeof q.task_id === "string" && q.task_id ? q.task_id : null;
    // ask() may name another reply channel (body.expected_reply_channel, or reply_channel); default is the asker's inbox.
    const b      = q.body && typeof q.body === "object" ? q.body : {};
    const named  = [b.expected_reply_channel, b.reply_channel, q.expected_reply_channel, q.reply_channel].find(c => typeof c === "string" && c) || "";
    const inbox  = named || `${prefix}${asker}`;
    const reply  = stmtQuestionReply.get(inbox, r.id, taskId, taskId, taskId)
                || stmtQuestionAnswerAnywhere.get(`${prefix}%`, r.id, String(r.id), taskId, taskId);
    const self   = taskId ? stmtQuestionSelfResult.get(`${prefix}%`, r.id, r.sender, taskId) : null;
    if (reply || self) { answered++; continue; }
    open.push({
      id: r.id, channel: r.channel, from: asker, to: q.to ?? null, task_id: taskId,
      subject: typeof q.subject === "string" ? q.subject : null,
      asked_at: new Date(r.created_at).toISOString(),
      age_min: Math.round((now - r.created_at) / 60000),
      expected_reply_channel: inbox,
    });
  }
  return { open, answered };
}

// ── Background auto-pruning ───────────────────────────────────────────────────

function runAutoPrune() {
  const now = Date.now();
  const exemptJson = JSON.stringify(PRUNE_EXEMPT);
  const signalJson = JSON.stringify(PRUNE_SIGNAL_TYPES);
  const r1 = stmtPruneAllOld.run(exemptJson, now - PRUNE_MAX_AGE_MS, signalJson);
  const r2 = stmtPruneSignalOld.run(exemptJson, now - PRUNE_SIGNAL_MAX_AGE_MS, signalJson);
  if (r1.changes > 0 || r2.changes > 0) {
    console.log(`[claude-broker] auto-pruned ${r1.changes} chatter msgs older than ${PRUNE_MAX_AGE_MS / 3600000}h and ${r2.changes} signal msgs older than ${Math.round(PRUNE_SIGNAL_MAX_AGE_MS / 86400000)}d (exempt: ${PRUNE_EXEMPT.join(", ") || "none"})`);
  }
}

// Evict a telemetry sender's older transient-state rows after a new row lands.
export function compactTelemetry(channel, sender, newId) {
  if (!channel.endsWith("-telemetry") || HEARTBEAT_TRANSIENT_STATES.length === 0) return 0;
  return stmtDeleteTransientHeartbeats.run(channel, sender, newId, JSON.stringify(HEARTBEAT_TRANSIENT_STATES)).changes;
}
setInterval(runAutoPrune, PRUNE_INTERVAL_MS).unref();
