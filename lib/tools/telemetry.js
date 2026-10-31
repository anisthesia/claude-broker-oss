// MCP tools: latest-per-sender reads and heartbeats.
import { z } from "zod";
import { TELEMETRY_CHANNEL, WORKER_OFFLINE_THRESHOLD_S } from "../config.js";
import { metrics, stmtInsert, stmtLatestPerSender, stmtDeleteOtherHeartbeats } from "../db.js";
import { validateContent, schemaHint } from "../validate.js";
import { messageBus, holdIdentity } from "../messages.js";

export function registerLatestTools(server) {
  // ── get_latest_per_sender ───────────────────────────────────────────────────
  server.registerTool("get_latest_per_sender", {
    title: "Get latest message per distinct sender",
    description: "Return the most recent message per sender on a channel. Designed for heartbeat/telemetry channels — one snapshot per worker without paginating history.",
    inputSchema: {
      channel: z.string().min(1),
    },
  }, async ({ channel }) => {
    const rows = stmtLatestPerSender.all(channel);
    if (rows.length === 0) return { content: [{ type: "text", text: `No messages on '${channel}'.` }] };
    const lines = rows.map(r => `[#${r.id}] ${new Date(r.created_at).toISOString()} <${r.sender}>: ${r.content}`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  });

  // ── get_latest_heartbeats ────────────────────────────────────────────────────
  server.registerTool("get_latest_heartbeats", {
    title: "Get latest heartbeat per worker (structured)",
    description: "Convenience wrapper around get_latest_per_sender that parses heartbeat JSON and returns structured worker state. Also computes a summary of rotating and stale workers. Use instead of get_latest_per_sender when you need parsed fields rather than raw text.",
    inputSchema: {
      channel: z.string().min(1).optional().describe("Telemetry channel to query. Default: 'telemetry'."),
    },
  }, async ({ channel = TELEMETRY_CHANNEL }) => {
    const rows = stmtLatestPerSender.all(channel);
    const nowMs = Date.now();
    const STALE_MS = WORKER_OFFLINE_THRESHOLD_S * 1000; // same threshold the dashboard uses

    const workers = rows.map(row => {
      let hb = {};
      try { hb = JSON.parse(row.content); } catch {}
      return {
        sender:               row.sender,
        ts:                   hb.ts ?? new Date(row.created_at).toISOString(),
        state:                hb.activity?.state ?? hb.state ?? "unknown",
        tier_threshold_pct:   hb.context?.tier_threshold_pct ?? null,
        rotation_recommended: hb.context?.rotation_recommended ?? false,
        cost_usd:             hb.cost_since_start?.estimated_usd ?? null,
        session_id:           hb.session_id ?? null,
      };
    });

    const rotating   = workers.filter(w => w.rotation_recommended).map(w => w.sender);
    const stale_5min = rows
      .filter(r => nowMs - r.created_at > STALE_MS)
      .map(r => r.sender);

    const result = {
      channel,
      workers,
      summary: { total_workers: workers.length, rotating, stale_5min },
    };
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });
}

export function registerHeartbeatTools(server) {
  // ── upsert_heartbeat ─────────────────────────────────────────────────────────
  server.registerTool("upsert_heartbeat", {
    title: "Post a heartbeat (keep-latest-per-sender)",
    description: "Post a message and immediately delete all older messages from this sender on this channel. Keeps the channel at exactly one row per sender — prevents telemetry channel bloat. Use instead of send_message for telemetry heartbeats. Readable via get_latest_per_sender or read_messages as normal.",
    inputSchema: {
      channel: z.string().min(1).describe("Heartbeat channel, e.g. telemetry."),
      sender:  z.string().min(1).describe("Worker identifier."),
      content: z.string().min(1).describe("Heartbeat payload — plain text or JSON-as-string."),
    },
  }, async ({ channel, sender, content }) => {
    // Hold mode is enforced by the insert guard (lib/db.js stmtInsert). A held judgment or a status would pass
    // it on <ns>-notes / <ns>-status, but the delete below would then wipe the worker's earlier rows there.
    const hold = holdIdentity(channel, sender);
    if (hold && (channel === `${hold.ns}-notes` || channel === `${hold.ns}-status`)) {
      metrics.guard_refusals++;
      return { content: [{ type: "text", text: `refused on '${channel}': '${hold.who}' is hold-only in namespace '${hold.ns}' (manifest workers[].mode "hold"): upsert_heartbeat is allowed only on ${hold.ns}-telemetry / ${hold.ns}-rate-limits. Post status with send_message on ${hold.ns}-status.` }], isError: true };
    }
    // Enforce channel schemas exactly like send_message: strict → reject, warn-only → warn + accept.
    const check = validateContent(channel, content);
    if (!check.ok && check.strict) {
      return { content: [{ type: "text", text: `schema validation failed on '${channel}': ${check.errors}${schemaHint(channel, check)}` }], isError: true };
    }
    if (!check.ok && !check.strict) {
      console.warn(`[claude-broker] WARN schema mismatch on '${channel}' (upsert_heartbeat): ${check.errors}`);
    }
    const now = Date.now();
    const r   = stmtInsert.run(channel, sender, content, now);
    const id  = r.lastInsertRowid;
    stmtDeleteOtherHeartbeats.run(channel, sender, id);
    messageBus.emit(`msg:${channel}`, { id, sender, content });
    const warn = (!check.ok && !check.strict) ? `  [WARN schema mismatch: ${check.errors}]` : "";
    return { content: [{ type: "text", text: `Heartbeat #${id} posted for '${sender}' on '${channel}' at ${new Date(now).toISOString()}.${warn}` }] };
  });
}
