// Server-side read cursors: where a read starts, cursor advance, and handoff rewinds.
import { metrics, stmtCursorGet, stmtCursorAdvance, stmtCursorRewindConsumer, stmtTaskDispatchForConsumer, tailStmts } from "./db.js";
import { fetchFiltered } from "./messages.js";

// Where does a read start? Precedence:
//   1. an explicit since_id > 0                      → exactly that (paging, in-session cursors);
//   2. the consumer's stored cursor on this channel  → resume where the previous session stopped;
//   3. otherwise the newest `lim` messages (tail)     → a cold start never pages through history.
// since_id=0 is treated like "omitted" because every role file told fresh sessions to pass 0.
export function resolveSince({ channel, sinceId, consumer, lim, filterSender, filterType }) {
  const senders = filterSender ? filterSender.split(",").map(s => s.trim()).filter(Boolean) : [];
  const params  = [channel, ...senders, ...(filterType ? [filterType] : [])];
  const t       = tailStmts(senders.length, !!filterType);
  const ctx     = { channel, consumer, lim, filterSender, filterType, params, t, skipped: 0 };
  if (Number.isInteger(sinceId) && sinceId > 0) { ctx.since = sinceId; ctx.source = "explicit"; return ctx; }
  const cur = consumer ? stmtCursorGet.get(consumer, channel) : undefined;
  if (cur) { ctx.since = cur.last_id; ctx.source = "cursor"; metrics.cursor_reads++; return ctx; }
  const start = t.start.get(...params, lim).id;
  ctx.since = start ? start - 1 : 0; ctx.source = "tail"; metrics.tail_reads++;
  if (start) ctx.skipped = t.before.get(...params, start).n;
  return ctx;
}

// Fetch rows for a resolved context, report how many remain beyond the limit, and advance the
// consumer's cursor. Filtered reads never advance it: skipping non-matching messages would hide
// them from the next unfiltered read.
export function deliverRows(ctx) {
  const rows   = fetchFiltered(ctx.channel, ctx.since, ctx.lim, ctx.filterSender, ctx.filterType);
  const lastId = rows.length ? rows[rows.length - 1].id : ctx.since;
  const remaining = rows.length >= ctx.lim ? ctx.t.after.get(...ctx.params, lastId).n : 0;
  if (ctx.consumer && rows.length && !ctx.filterSender && !ctx.filterType)
    stmtCursorAdvance.run(ctx.consumer, ctx.channel, lastId, Date.now());
  return { rows, remaining, next_id: lastId };
}

export function resolveRead(args) {
  const ctx = resolveSince(args);
  return { ...ctx, ...deliverRows(ctx) };
}

// A worker that rotates mid-task posts `type: status` with body.handoff_notes and exits. Its
// replacement session must see the task again, so pull the worker's inbox cursor back to just
// before the task's dispatch message. Only status messages carrying handoff_notes pay for this.
export function handoffRewind(sender, content) {
  let p; try { p = JSON.parse(content); } catch { return; }
  if (!p || p.type !== "status" || p.task_id == null || !(p.body && p.body.handoff_notes)) return;
  const d = stmtTaskDispatchForConsumer.get(sender, String(p.task_id));
  if (!d) return;
  const r = stmtCursorRewindConsumer.run(d.id - 1, Date.now(), sender, d.channel, d.id - 1);
  if (r.changes) metrics.cursor_rewinds++;
}
