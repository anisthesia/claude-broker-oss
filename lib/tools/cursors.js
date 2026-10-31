// MCP tools: turn_start and worker_cursor.
import { z } from "zod";
import { metrics, stmtCursorGet, stmtCursorList, stmtCursorSet } from "../db.js";
import { summarizeContent } from "../messages.js";
import { resolveRead } from "../cursors.js";

export function registerCursorTools(server) {
  // ── turn_start ───────────────────────────────────────────────────────────────
  server.registerTool("turn_start", {
    title: "Turn-start ritual in one call",
    description: "Read inbox + control channels in a single round-trip. Returns JSON: {inbox, control, rotate_requested, inbox_next_id, control_next_id, inbox_source, control_source, inbox_skipped, control_skipped, consumer}. With inbox_since_id/control_since_id omitted or 0 the broker resumes from the server-side cursor it keeps per (worker, channel) — so a fresh session never re-reads history — or, with no cursor yet, returns the newest `limit` messages. Each call advances the cursor. rotate_requested is true if any unread control message has type='rotate'.",
    inputSchema: {
      inbox_channel:    z.string().min(1).describe("Worker inbox channel, e.g. backend."),
      control_channel:  z.string().min(1).describe("Broadcast control channel, e.g. control."),
      worker:           z.string().min(1).optional().describe("Consumer name for the server-side cursors (your worker name). Defaults to inbox_channel."),
      inbox_since_id:   z.number().int().nonnegative().default(0).describe("Return inbox messages with id > this. Omit or 0 → server-side cursor."),
      control_since_id: z.number().int().nonnegative().default(0).describe("Return control messages with id > this. Omit or 0 → server-side cursor."),
      limit:            z.number().int().positive().max(500).optional().describe("Max messages per channel. Default 100."),
      projection:       z.enum(["full", "summary"]).optional().describe("'summary' replaces each message's content with headline envelope fields (type, task_id, subject, summary, bytes). Default 'full'."),
    },
  }, async ({ inbox_channel, control_channel, worker, inbox_since_id, control_since_id, limit, projection }) => {
    const lim         = limit ?? 100;
    const consumer    = worker ?? inbox_channel;
    const inbox       = resolveRead({ channel: inbox_channel,   sinceId: inbox_since_id,   consumer, lim });
    const control     = resolveRead({ channel: control_channel, sinceId: control_since_id, consumer, lim });
    const inboxRows   = inbox.rows;
    const controlRows = control.rows;

    const rotateRequested = controlRows.some(r => {
      try { return JSON.parse(r.content).type === "rotate"; } catch { return false; }
    });

    const toMsgObj = r => ({ id: r.id, sender: r.sender, ts: new Date(r.created_at).toISOString(),
      ...(projection === "summary" ? { summary: summarizeContent(r.content) } : { content: r.content }) });

    return { content: [{ type: "text", text: JSON.stringify({
      inbox:            inboxRows.map(toMsgObj),
      control:          controlRows.map(toMsgObj),
      rotate_requested: rotateRequested,
      inbox_next_id:    inbox.next_id,
      control_next_id:  control.next_id,
      inbox_source:     inbox.source,   control_source:  control.source,
      inbox_skipped:    inbox.skipped,  control_skipped: control.skipped,
      ...(inbox.remaining   ? { inbox_pending_beyond_limit:   inbox.remaining }   : {}),
      ...(control.remaining ? { control_pending_beyond_limit: control.remaining } : {}),
      consumer,
    }) }] };
  });

  // ── worker_cursor ────────────────────────────────────────────────────────────
  server.registerTool("worker_cursor", {
    title: "Inspect or set a worker's server-side read cursors",
    description: "The broker remembers per (worker, channel) the highest message id delivered through turn_start / read_messages / wait_for_messages when since_id was omitted or 0. With only `worker`, lists its cursors. With `channel` and `set_to`, sets that cursor — a lower value rewinds, so the next turn_start re-delivers everything after it. Use it when you exit mid-task WITHOUT posting a handoff status (the broker rewinds automatically for a `type: status` with body.handoff_notes), or to skip a backlog deliberately.",
    inputSchema: {
      worker:  z.string().min(1).describe("Consumer name (worker name, or the inbox channel if turn_start was called without worker=)."),
      channel: z.string().min(1).optional().describe("Channel whose cursor to show or set."),
      set_to:  z.number().int().nonnegative().optional().describe("New last_id for (worker, channel). Messages with id > set_to are delivered on the next read."),
    },
  }, async ({ worker, channel, set_to }) => {
    if (set_to != null) {
      if (!channel) return { content: [{ type: "text", text: "channel is required with set_to." }], isError: true };
      const before = stmtCursorGet.get(worker, channel)?.last_id ?? null;
      stmtCursorSet.run(worker, channel, set_to, Date.now());
      if (before != null && set_to < before) metrics.cursor_rewinds++;
      return { content: [{ type: "text", text: JSON.stringify({ worker, channel, before, after: set_to }) }] };
    }
    let rows = stmtCursorList.all(worker);
    if (channel) rows = rows.filter(r => r.channel === channel);
    return { content: [{ type: "text", text: JSON.stringify({ worker, cursors: rows.map(r => ({ channel: r.channel, last_id: r.last_id, updated_at: new Date(r.updated_at).toISOString() })) }) }] };
  });
}
