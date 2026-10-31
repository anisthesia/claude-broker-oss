// MCP tools: send/read/wait/delete messages, consent-gated posts, batch send.
import { z } from "zod";
import { PRUNE_EXEMPT } from "../config.js";
import { nsOf } from "../util.js";
import { db, metrics, stmtCountForeignIn, stmtInsert, stmtDeleteOne, stmtMsgSender, stmtMsgGet, stmtCheckResult } from "../db.js";
import { validateContent, schemaHint } from "../validate.js";
import { isValidChannelName, messageBus, fetchFiltered, formatRows, compactTelemetry, contentSizeError, resolvePath, holdRefusal, holdDeleteRefusal } from "../messages.js";
import { resolveSince, deliverRows, resolveRead, handoffRewind } from "../cursors.js";
import { requestContext, reservedSenderRefusal } from "../auth.js";
import { getNamespace } from "../namespaces.js";
import { planApproval, allowedUnapproved } from "./sprint.js";
import { checksProblem } from "./typed.js";

// A raw type:result on a gated task whose plan is not approved still lands (v2 compatibility), but the reply
// says so: the ledger marks it failed with plan_unapproved, and the verifier fails it (post_result refuses it).
function planGateWarning(channel, content) {
  if (!channel.endsWith("-status")) return "";
  let p; try { p = JSON.parse(content); } catch { return ""; }
  if (p?.type !== "result" || typeof p.task_id !== "string" || allowedUnapproved(p.summary)) return "";
  const gate = planApproval(getNamespace(nsOf(channel)), channel, p.task_id);
  return gate.required && !gate.approved
    ? `  [WARN plan gate: '${p.task_id}' has no approved plan (${gate.state}) — the ledger counts this result as failed (plan_unapproved)]`
    : "";
}

// A raw type:task whose checks[].run is prose or does not parse still lands (v2 compatibility); dispatch_task
// refuses it (typed.js checkRunProblem). The verifier would FAIL that check, so the reply says so.
function checksWarning(content) {
  let p; try { p = JSON.parse(content); } catch { return ""; }
  if (p?.type !== "task" || !Array.isArray(p.checks)) return "";
  const bad = checksProblem(p.checks);
  return bad ? `  [WARN ${bad} — it will FAIL at verification]` : "";
}

const refusedText = (channel, refusal) => ({ content: [{ type: "text", text: `refused on '${channel}': ${refusal}` }], isError: true });

// Insert + side effects shared by send_message and the typed protocol tools (caller validates first).
export function writeMessage(channel, sender, content) {
  const now = Date.now();
  const r = stmtInsert.run(channel, sender, content, now);
  compactTelemetry(channel, sender, r.lastInsertRowid);
  handoffRewind(sender, content);
  messageBus.emit(`msg:${channel}`, { id: r.lastInsertRowid, sender, content });
  return { id: r.lastInsertRowid, now };
}

// identity: the connection's { role, ns, as }, or null. Only a role connection sees wait_for_messages' exclude_self, so
// the no-role (v2) tools/list stays byte-identical.
export function registerMessagingTools(server, identity = null) {
  // ── send_message ────────────────────────────────────────────────────────────
  server.registerTool("send_message", {
    title: "Send a message",
    description: "Post a message to a named channel. Other Claude Code sessions can read it via read_messages or wait_for_messages.",
    inputSchema: {
      channel: z.string().min(1).describe("Channel name."),
      sender:  z.string().min(1).describe("Sender identifier."),
      content: z.string().min(1).describe("Message body — plain text or JSON-as-string."),
    },
  }, async ({ channel, sender, content }) => {
    if (!isValidChannelName(channel))
      return { content: [{ type: "text", text: `invalid channel name '${channel}': control characters are not allowed.` }], isError: true };
    const refusal = reservedSenderRefusal(channel, sender) ?? holdRefusal(channel, sender, content);
    if (refusal) return refusedText(channel, refusal);
    const tooBig = contentSizeError(content);
    if (tooBig) return { content: [{ type: "text", text: `rejected on '${channel}': ${tooBig}` }], isError: true };
    const check = validateContent(channel, content);
    if (!check.ok && check.strict) {
      return { content: [{ type: "text", text: `schema validation failed on '${channel}': ${check.errors}${schemaHint(channel, check)}` }], isError: true };
    }
    const gateWarn = planGateWarning(channel, content) + checksWarning(content);
    const { id, now } = writeMessage(channel, sender, content);
    const warn = (!check.ok && !check.strict) ? `  [WARN schema mismatch: ${check.errors}]` : "";
    return { content: [{ type: "text", text: `Sent #${id} to '${channel}' as '${sender}' at ${new Date(now).toISOString()}.${warn}${gateWarn}` }] };
  });

  // ── read_messages ───────────────────────────────────────────────────────────
  server.registerTool("read_messages", {
    title: "Read messages",
    description: "Read messages from a channel. since_id > 0 pages from that id; omitted or 0 resumes from the worker's server-side cursor (pass worker=), or returns the newest `limit` messages when there is no cursor. Unfiltered reads advance the cursor. Supports optional sender and type filters.",
    inputSchema: {
      channel:       z.string().min(1),
      since_id:      z.number().int().nonnegative().optional().describe("Only return msgs with id > since_id. Omit (or 0) to resume from the server-side cursor for `worker`, else the newest `limit` messages."),
      worker:        z.string().min(1).optional().describe("Consumer name for the server-side cursor (your worker name). Reads without a since_id resume from it; unfiltered reads advance it."),
      limit:         z.number().int().positive().max(500).optional().describe("Max messages (default 100)."),
      filter_sender: z.string().optional().describe("Only return messages from this sender."),
      filter_type:   z.string().optional().describe("Only return messages where JSON content has type === this value."),
      projection:    z.enum(["full", "summary"]).optional().describe("'summary' returns only headline envelope fields (type, task_id, from, to, subject, summary, bytes) per message — scan first, then read_messages(full) or delete/act on the ids you need. Default 'full'."),
    },
  }, async ({ channel, since_id, worker, limit, filter_sender, filter_type, projection }) => {
    const r = resolveRead({ channel, sinceId: since_id, consumer: worker, lim: limit ?? 100, filterSender: filter_sender, filterType: filter_type });
    return formatRows(r.rows, channel, r.since, projection, r);
  });

  // ── wait_for_messages ───────────────────────────────────────────────────────
  server.registerTool("wait_for_messages", {
    title: "Wait for new messages",
    description: "Long-polls until a matching message arrives or timeout_ms elapses. Supports filter_sender and filter_type — waits until a message matching the filters arrives, skipping non-matching ones. since_id omitted or 0 resumes from the worker's server-side cursor (pass worker=), else from the newest `limit` messages. Default timeout 60s, max 300s.",
    inputSchema: {
      channel:       z.string().min(1),
      since_id:      z.number().int().nonnegative().optional().describe("Only return msgs with id > since_id. Omit (or 0) to resume from the server-side cursor for `worker`."),
      worker:        z.string().min(1).optional().describe("Consumer name for the server-side cursor. Unfiltered waits advance it."),
      projection:    z.enum(["full", "summary"]).optional().describe("'summary' returns headline envelope fields only. Default 'full'."),
      timeout_ms:    z.number().int().positive().max(300000).optional().describe("Max wait in ms. Default 60000. Max 300000."),
      limit:         z.number().int().positive().max(500).optional(),
      filter_sender: z.string().optional().describe("Only wake/return for messages from this sender."),
      filter_type:   z.string().optional().describe("Only wake/return for messages where JSON content.type === this value."),
      ...(identity && { exclude_self: z.boolean().optional().describe("Skip own posts (worker, else as=).") }),
    },
  }, async ({ channel, since_id, worker, projection, timeout_ms, limit, filter_sender, filter_type, exclude_self }, extra) => {
    // exclude_self: settle only once a matching row is not the caller's own (lib/db.js FOREIGN_POST, the GET /inbox
    // exclude_sender rule). The wake then delivers every matching row, own ones too, as read_messages would.
    const self = exclude_self ? [worker || identity?.as].filter(Boolean) : null;
    if (self && !self.length)
      return { content: [{ type: "text", text: "exclude_self needs worker= or a connection identity with as= to know who you are." }], isError: true };
    const lim     = limit ?? 100;
    const ctx     = resolveSince({ channel, sinceId: since_id, consumer: worker, lim, filterSender: filter_sender, filterType: filter_type });
    const sinceId = ctx.since;
    const timeout = Math.min(timeout_ms ?? 60000, 300000);
    const event   = `msg:${channel}`;
    // Aborted by the SDK when the client disconnects (transport.close() on res 'close'
    // in the /mcp handler) — without it, the listener + timer below would linger for
    // the full timeout (up to 300s) after the caller is gone.
    const signal  = extra?.signal;

    return new Promise((resolve) => {
      let timer = null;
      let resolved = false;

      let cleanup = function () {
        if (timer) { clearTimeout(timer); timer = null; }
        messageBus.off(event, onMessage);
        signal?.removeEventListener("abort", onAbort);
      };

      function settle(result) {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve(result);
      }

      // With exclude_self, peek (no cursor move) and wait on while every row so far is the caller's own. A full page
      // wakes regardless: a foreign row past the limit must not be slept through.
      const onlyOwn = () => {
        if (!self) return false;
        const ids = fetchFiltered(channel, ctx.since, lim, filter_sender, filter_type).map(r => r.id);
        return ids.length > 0 && ids.length < lim && stmtCountForeignIn.get({ ids: JSON.stringify(ids), excluded: JSON.stringify(self) }).n === 0;
      };

      function onMessage() {
        if (onlyOwn()) return;
        const d = deliverRows(ctx);
        if (d.rows.length > 0) { metrics.long_polls_woken++; settle(formatRows(d.rows, channel, sinceId, projection, { ...ctx, ...d })); }
        // Non-matching message — keep listener registered, timer keeps running
      }

      function onAbort() {
        // Client gone — response is never delivered; settle only to free listener + timer.
        settle({ content: [{ type: "text", text: `Wait on '${channel}' aborted — client disconnected.` }] });
      }

      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener("abort", onAbort);

      // Register listener BEFORE initial DB check to close the race window:
      // a send_message that arrives between check and registration would be missed.
      messageBus.on(event, onMessage);

      // Check for messages already present (including any that arrived before registration)
      const immediate = onlyOwn() ? { rows: [] } : deliverRows(ctx);
      if (immediate.rows.length > 0) { settle(formatRows(immediate.rows, channel, sinceId, projection, { ...ctx, ...immediate })); return; }

      metrics.long_polls_total++; metrics.long_polls_active++;
      const dec = () => { metrics.long_polls_active--; };
      const origCleanup = cleanup;
      cleanup = () => { origCleanup(); dec(); };

      timer = setTimeout(() => {
        settle({ content: [{ type: "text", text: `No new messages on '${channel}' within ${timeout}ms (since_id=${sinceId}).` }] });
      }, timeout);
    });
  });

  // ── delete_message ──────────────────────────────────────────────────────────
  server.registerTool("delete_message", {
    title: "Delete a single message",
    description: "Delete one message by id. Requires the channel for safety — prevents deleting a message from the wrong channel by accident. On PRUNE_EXEMPT channels (backlogs, notes, retrospectives) only the message's own sender may delete it, and only by passing sender=; to retract someone else's note post `type: resolved` instead.",
    inputSchema: {
      channel: z.string().min(1).describe("Channel the message belongs to."),
      id:      z.number().int().positive().describe("Message id (from the #N prefix in read_messages output)."),
      sender:  z.string().min(1).optional().describe("Your sender name. Required on PRUNE_EXEMPT channels and must match the message's sender."),
    },
  }, async ({ channel, id, sender }) => {
    const hold = holdDeleteRefusal(channel, sender);
    if (hold) return refusedText(channel, hold);
    if (PRUNE_EXEMPT.includes(channel)) {
      const row = stmtMsgSender.get(id, channel);
      if (!row) return { content: [{ type: "text", text: `Message #${id} not found on '${channel}'.` }], isError: true };
      const refusal = sender && reservedSenderRefusal(channel, sender);
      if (refusal) { metrics.guard_refusals++; return refusedText(channel, refusal); }
      if (!sender || row.sender !== sender) {
        metrics.guard_refusals++;
        return { content: [{ type: "text", text: `Refused: '${channel}' is durable (PRUNE_EXEMPT); #${id} was posted by '${row.sender}'${sender ? `, not '${sender}'` : " and no sender= was given"}. Only its sender may delete it. To retract or supersede it, post {type:"resolved", ref_id:${id}, outcome:"superseded"|"invalid"} instead.` }], isError: true };
      }
    }
    const r = stmtDeleteOne.run(id, channel);
    if (r.changes === 0) return { content: [{ type: "text", text: `Message #${id} not found on '${channel}'.` }], isError: true };
    return { content: [{ type: "text", text: `Deleted message #${id} from '${channel}'.` }] };
  });

  // ── post_gated_message ──────────────────────────────────────────────────────
  server.registerTool("post_gated_message", {
    title: "Post a message gated on task results",
    description: "Post a message only after all listed task_ids have a type:result message on the watch_channel. Blocks until all dependencies are satisfied or timeout_ms elapses. Use this to enforce depends_on at the broker level rather than relying on workers to self-block.",
    inputSchema: {
      channel:       z.string().min(1).describe("Channel to post to when all deps are satisfied."),
      sender:        z.string().min(1),
      content:       z.string().min(1).describe("Message body to post when unblocked."),
      depends_on:    z.array(z.string().min(1)).min(1).describe("Array of task_ids to wait for (the envelope's 'task_id:worker' form is accepted; the worker suffix is ignored). Each must have a type:result message on watch_channel."),
      watch_channel: z.string().optional().describe("Channel to watch for result messages. Default: <ns>-status derived from a namespaced channel (e.g. team-backend → team-status), else 'status'."),
      timeout_ms:    z.number().int().positive().max(300000).optional().describe("Max wait in ms. Default 60000. Max 300000."),
    },
  }, async ({ channel, sender, content, depends_on, watch_channel, timeout_ms }, extra) => {
    // Reject a reserved or hold-only sender and oversize content up front rather than after a long wait on the deps.
    const refusal = reservedSenderRefusal(channel, sender) ?? holdRefusal(channel, sender, content);
    if (refusal) return refusedText(channel, refusal);
    // The deferred post runs inside whichever request's write satisfied the deps; insert under this one's context.
    const ctx = requestContext.getStore();
    const tooBig = contentSizeError(content);
    if (tooBig) return { content: [{ type: "text", text: `rejected on '${channel}': ${tooBig}` }], isError: true };
    const watchChan = watch_channel ?? (channel.includes("-") ? `${nsOf(channel)}-status` : "status");
    // Envelope convention writes depends_on as "task_id:worker"; results are keyed by task_id alone.
    depends_on = depends_on.map(d => (d.includes(":") ? d.slice(0, d.indexOf(":")) : d));
    const timeout   = Math.min(timeout_ms ?? 60000, 300000);
    const event     = `msg:${watchChan}`;
    // Same disconnect-cleanup contract as wait_for_messages.
    const signal    = extra?.signal;

    function allSatisfied() {
      return depends_on.every(taskId => stmtCheckResult.get(watchChan, taskId).n > 0);
    }

    function pendingList() {
      return depends_on.filter(taskId => stmtCheckResult.get(watchChan, taskId).n === 0);
    }

    if (allSatisfied()) {
      const check = validateContent(channel, content);
      if (!check.ok && check.strict) {
        return { content: [{ type: "text", text: `schema validation failed on '${channel}': ${check.errors}` }], isError: true };
      }
      const now = Date.now();
      const r = stmtInsert.run(channel, sender, content, now);
      messageBus.emit(`msg:${channel}`, { id: r.lastInsertRowid, sender, content });
      return { content: [{ type: "text", text: `All deps satisfied immediately. Sent #${r.lastInsertRowid} to '${channel}'.` }] };
    }

    return new Promise((resolve) => {
      let timer = null;
      let settled = false;

      function cleanup() {
        if (timer) { clearTimeout(timer); timer = null; }
        messageBus.off(event, onResult);
        signal?.removeEventListener("abort", onAbort);
      }

      function settle(result) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      }

      function onAbort() {
        // Client gone — do NOT post the gated message on a dead request; just free resources.
        settle({ content: [{ type: "text", text: `Gated post to '${channel}' aborted — client disconnected.` }], isError: true });
      }

      function tryPost() {
        const check = validateContent(channel, content);
        if (!check.ok && check.strict) {
          settle({ content: [{ type: "text", text: `Deps satisfied but schema validation failed: ${check.errors}` }], isError: true });
          return;
        }
        const now = Date.now();
        let r;
        try { r = requestContext.run(ctx, () => stmtInsert.run(channel, sender, content, now)); }
        catch (e) { settle({ content: [{ type: "text", text: `Deps satisfied but the post was refused: ${e.message}` }], isError: true }); return; }
        messageBus.emit(`msg:${channel}`, { id: r.lastInsertRowid, sender, content });
        settle({ content: [{ type: "text", text: `Deps satisfied. Sent #${r.lastInsertRowid} to '${channel}'.` }] });
      }

      function onResult() {
        if (!allSatisfied()) return;
        tryPost();
      }

      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener("abort", onAbort);

      // Register listener BEFORE re-check so no result event is missed between
      // the initial allSatisfied() check above and this listener registration.
      messageBus.on(event, onResult);

      // Re-check now that listener is wired (mirrors wait_for_messages pattern).
      if (allSatisfied()) { tryPost(); return; }

      timer = setTimeout(() => {
        settle({ content: [{ type: "text", text: `Timed out after ${timeout}ms waiting for deps: ${pendingList().join(", ")}` }], isError: true });
      }, timeout);
    });
  });
}

export function registerBatchTools(server) {
  // ── send_message_batch ───────────────────────────────────────────────────────
  server.registerTool("send_message_batch", {
    title: "Send multiple messages in one call",
    description: "Post an array of messages in a single SQLite transaction. Returns [{id, channel, sender}] for each message. Use when dispatching tasks to multiple workers simultaneously — replaces N send_message calls with one round-trip. Max 50 messages per call.",
    inputSchema: {
      messages: z.array(z.object({
        channel: z.string().min(1),
        sender:  z.string().min(1),
        content: z.string().min(1),
      })).min(1).max(50).describe("Array of messages to post."),
    },
  }, async ({ messages }) => {
    const now     = Date.now();
    const results = [];

    // Validate all first; abort before any inserts if a strict schema fails
    const warns = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const refusal = reservedSenderRefusal(msg.channel, msg.sender) ?? holdRefusal(msg.channel, msg.sender, msg.content);
      if (refusal) return { content: [{ type: "text", text: `refused on '${msg.channel}' (message ${i + 1}/${messages.length}): ${refusal}` }], isError: true };
      const tooBig = contentSizeError(msg.content);
      if (tooBig) return { content: [{ type: "text", text: `rejected on '${msg.channel}' (message ${i + 1}/${messages.length}): ${tooBig}` }], isError: true };
      const check = validateContent(msg.channel, msg.content);
      if (!check.ok && check.strict) {
        return { content: [{ type: "text", text: `schema validation failed on '${msg.channel}' (message ${i + 1}/${messages.length}): ${check.errors}` }], isError: true };
      }
      if (!check.ok) warns.push(`message ${i + 1} → '${msg.channel}': ${check.errors}`);
    }

    db.transaction((msgs) => {
      for (let i = 0; i < msgs.length; i++) {
        const r = stmtInsert.run(msgs[i].channel, msgs[i].sender, msgs[i].content, now);
        results.push({ id: r.lastInsertRowid, channel: msgs[i].channel, sender: msgs[i].sender, content: msgs[i].content });
      }
    })(messages);

    for (const r of results) {
      handoffRewind(r.sender, r.content);
      messageBus.emit(`msg:${r.channel}`, { id: r.id, sender: r.sender, content: r.content });
    }

    const summary = results.map(r => `#${r.id} → ${r.channel}`).join(", ");
    const warnText = warns.length ? `  [WARN schema mismatch: ${warns.join("; ")}]` : "";
    return { content: [{ type: "text", text: `Sent ${results.length} messages: ${summary}${warnText}` }] };
  });
}

export function registerGetMessageTool(server) {
  // ── get_message ─────────────────────────────────────────────────────────────
  server.registerTool("get_message", {
    title: "Get one message or one field of it",
    description: "Fetch a single message by id, or just the JSON value at `path` inside it (e.g. 'body.required_checks', 'body.commits[0].sha', 'body[\"a.b\"]'). Use after a projection='summary' scan to open only the field you need instead of the whole envelope. Does not move read cursors.",
    inputSchema: {
      channel: z.string().min(1).describe("Channel the message belongs to."),
      id:      z.number().int().positive().describe("Message id (the #N in read output)."),
      path:    z.string().min(1).optional().describe("Dot/bracket path into the JSON content. Omit for the whole message."),
    },
  }, async ({ channel, id, path }) => {
    const row = stmtMsgGet.get(id, channel);
    if (!row) return { content: [{ type: "text", text: `Message #${id} not found on '${channel}'.` }], isError: true };
    if (path === undefined)
      return { content: [{ type: "text", text: `[#${row.id}] ${new Date(row.created_at).toISOString()} <${row.sender}>: ${row.content}` }] };
    let parsed;
    try { parsed = JSON.parse(row.content); }
    catch { return { content: [{ type: "text", text: `Message #${id} on '${channel}' is not JSON; path '${path}' cannot be resolved. Omit path to read it whole.` }], isError: true }; }
    const r = resolvePath(parsed, path);
    if (!r.ok) return { content: [{ type: "text", text: `Message #${id} on '${channel}': ${r.error}` }], isError: true };
    return { content: [{ type: "text", text: r.value === undefined ? "null" : JSON.stringify(r.value) }] };
  });
}
