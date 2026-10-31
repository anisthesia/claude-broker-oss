// MCP tools: result lookups, channel probes, listing and purging.
import { z } from "zod";
import { ADMIN_SECRET, PRUNE_EXEMPT } from "../config.js";
import { metrics, stmtChans, stmtChansByPrefix, escapeLike, stmtPurge, stmtPruneOlder, stmtCheckResult, stmtHasMessages, stmtHasMessagesExcluding, getBatchResultsStmt, stmtReadLast } from "../db.js";
import { summarizeContent } from "../messages.js";

// identity: the connection's { role, ns, as }, or null. Only a role connection sees has_messages' exclude_self, so the
// no-role (v2) tools/list stays byte-identical.
export function registerChannelTools(server, identity = null) {
  // ── check_result ────────────────────────────────────────────────────────────
  server.registerTool("check_result", {
    title: "Check if a task result exists",
    description: "Returns whether a type:result message with the given task_id exists on a channel. Use this for idempotency checks — a single indexed SQL query vs. transferring the full channel history with read_messages(since_id=0).",
    inputSchema: {
      channel: z.string().min(1).describe("Channel to check (typically status)."),
      task_id: z.string().min(1).describe("The task_id to look for."),
    },
  }, async ({ channel, task_id }) => {
    const row = stmtCheckResult.get(channel, task_id);
    return { content: [{ type: "text", text: JSON.stringify({ found: row.n > 0, task_id, channel, summary: row.summary ?? null }) }] };
  });

  // ── check_results_batch ─────────────────────────────────────────────────────
  server.registerTool("check_results_batch", {
    title: "Batch-check task results",
    description: "Check multiple task_ids for type:result messages in one call. Returns results (task_id → found boolean) and summaries (task_id → latest result summary or null). Use at turn-start when multiple tasks may be queued — replaces N sequential check_result calls with one round-trip.",
    inputSchema: {
      channel:  z.string().min(1).describe("Channel to check (typically status)."),
      task_ids: z.array(z.string().min(1)).min(1).max(50).describe("Task IDs to check."),
    },
  }, async ({ channel, task_ids }) => {
    const foundRows = getBatchResultsStmt(task_ids.length).all(channel, ...task_ids);
    const foundSet  = new Set(foundRows.map(r => r.task_id));
    const result    = {};
    const summaries = {};
    for (const task_id of task_ids) {
      result[task_id] = foundSet.has(task_id);
      // Latest summary so batch callers can tell PASS from FAIL without a second round-trip.
      summaries[task_id] = result[task_id] ? (stmtCheckResult.get(channel, task_id).summary ?? null) : null;
    }
    return { content: [{ type: "text", text: JSON.stringify({ channel, results: result, summaries }) }] };
  });

  // ── has_messages ────────────────────────────────────────────────────────────
  server.registerTool("has_messages", {
    title: "Check if a channel has messages (no content transfer)",
    description: "Returns {pending, max_id, channel} — lightweight pre-check before read_messages. Use to gate control reads: skip entirely if pending=false. Zero content transferred.",
    inputSchema: {
      channel:  z.string().min(1).describe("Channel to check."),
      since_id: z.number().int().min(0).default(0).describe("Only count messages with id > since_id."),
      ...(identity && { exclude_self: z.boolean().optional().describe("Skip own posts (as=).") }),
    },
  }, async ({ channel, since_id, exclude_self }) => {
    if (exclude_self && !identity?.as)
      return { content: [{ type: "text", text: "exclude_self needs a connection identity with as= (/mcp?role=...&as=<you>) — has_messages has no worker= to name you." }], isError: true };
    const row = exclude_self
      ? stmtHasMessagesExcluding.get({ channel, since_id: since_id ?? 0, excluded: JSON.stringify([identity.as]) })
      : stmtHasMessages.get(channel, since_id ?? 0);
    return { content: [{ type: "text", text: JSON.stringify({ pending: row.n > 0, max_id: row.max_id, channel }) }] };
  });

  // ── read_last ────────────────────────────────────────────────────────────────
  server.registerTool("read_last", {
    title: "Read the last N messages from a channel",
    description: "Returns the N most recent messages in chronological order (oldest-first). Use for compaction recovery instead of read_messages(since_id=0) — transfers only the tail of history, not the full archive. Default n=20, max 100.",
    inputSchema: {
      channel: z.string().min(1).describe("Channel to read."),
      n:       z.number().int().min(1).max(100).default(20).describe("Number of most-recent messages to return."),
      projection: z.enum(["full", "summary"]).optional().describe("'summary' returns headline envelope fields only. Default 'full'."),
    },
  }, async ({ channel, n, projection }) => {
    const rows = stmtReadLast.all(channel, n ?? 20);
    rows.reverse();
    if (!rows.length) return { content: [{ type: "text", text: "No messages." }] };
    const text = rows.map(r => `[${r.id}] ${r.sender}: ${projection === "summary" ? JSON.stringify(summarizeContent(r.content)) : r.content}`).join("\n");
    return { content: [{ type: "text", text: text }] };
  });

  // ── list_channels ───────────────────────────────────────────────────────────
  server.registerTool("list_channels", {
    title: "List channels",
    description: "List all channels with message counts, latest id, and last activity.",
    inputSchema: {},
  }, async () => {
    const rows = stmtChans.all();
    if (rows.length === 0) return { content: [{ type: "text", text: "(no channels yet)" }] };
    const text = rows.map(r => `${r.channel}\t${r.n} msgs\tlast_id=${r.last_id}\tlast_activity=${new Date(r.last_ts).toISOString()}`).join("\n");
    return { content: [{ type: "text", text }] };
  });

  // ── purge_channel ───────────────────────────────────────────────────────────
  server.registerTool("purge_channel", {
    title: "Purge channel",
    description: "Delete messages from a channel. Without older_than_ms, deletes all messages. With older_than_ms, deletes only messages older than that many milliseconds. Channels in PRUNE_EXEMPT are refused unless force=true.",
    inputSchema: {
      channel:       z.string().min(1),
      older_than_ms: z.number().int().positive().optional().describe("If set, only delete messages older than this many ms. Omit to delete all."),
      force:         z.boolean().optional().describe("Required to purge a channel listed in PRUNE_EXEMPT (e.g. *-backlog). Default false. Also needs admin_token."),
      admin_token:   z.string().optional().describe("ADMIN_SECRET of the broker. Required together with force=true on a PRUNE_EXEMPT channel; a session that does not hold it cannot purge durable channels."),
    },
  }, async ({ channel, older_than_ms, force, admin_token }) => {
    if (PRUNE_EXEMPT.includes(channel)) {
      // Durable channels (backlogs, notes, retrospectives) hold the team's memory. The old
      // force=true bypass was a convention that headless sessions could not be asked about.
      if (!force) {
        metrics.guard_refusals++;
        return { content: [{ type: "text", text: `Refused: '${channel}' is in PRUNE_EXEMPT. Purging it needs force=true AND admin_token (the broker's ADMIN_SECRET), which is not given to worker sessions. Ask a human.` }], isError: true };
      }
      if (!ADMIN_SECRET || admin_token !== ADMIN_SECRET) {
        metrics.guard_refusals++;
        const why = ADMIN_SECRET ? "admin_token does not match ADMIN_SECRET" : "the broker has no ADMIN_SECRET configured, so force-purge of exempt channels is disabled";
        return { content: [{ type: "text", text: `Refused: '${channel}' is in PRUNE_EXEMPT and ${why}.` }], isError: true };
      }
    }
    let r;
    if (older_than_ms != null) {
      r = stmtPruneOlder.run(channel, Date.now() - older_than_ms);
      return { content: [{ type: "text", text: `Pruned ${r.changes} messages older than ${older_than_ms}ms from '${channel}'.` }] };
    }
    r = stmtPurge.run(channel);
    return { content: [{ type: "text", text: `Purged ${r.changes} messages from '${channel}'.` }] };
  });

  // ── purge_channels_by_prefix ─────────────────────────────────────────────────
  server.registerTool("purge_channels_by_prefix", {
    title: "Purge channels by prefix",
    description: "Delete messages from all channels matching a prefix. Without older_than_ms, deletes all messages. With older_than_ms, deletes only messages older than that many milliseconds. Skips channels in PRUNE_EXEMPT.",
    inputSchema: {
      prefix:        z.string().min(1).describe("Delete messages from all channels whose name starts with this prefix."),
      older_than_ms: z.number().int().positive().optional().describe("If set, only delete messages older than this many ms. Omit to delete all."),
    },
  }, async ({ prefix, older_than_ms }) => {
    const channels = stmtChansByPrefix.all(escapeLike(prefix) + "%");
    const purged = [];
    const skipped_exempt = [];
    let total_deleted = 0;

    for (const row of channels) {
      if (PRUNE_EXEMPT.includes(row.channel)) {
        skipped_exempt.push(row.channel);
        continue;
      }

      let r;
      if (older_than_ms != null) {
        r = stmtPruneOlder.run(row.channel, Date.now() - older_than_ms);
      } else {
        r = stmtPurge.run(row.channel);
      }
      purged.push({ channel: row.channel, deleted_count: r.changes });
      total_deleted += r.changes;
    }

    const result = {
      purged,
      skipped_exempt,
      total_deleted,
    };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });
}
