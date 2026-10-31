// GET /dashboard/channel — per-channel message viewer.
import { dashboardAuth } from "../auth.js";
import { safeNs, escHtml } from "../util.js";
import { stmtSchemaGet, stmtChanViewRows, stmtChanCount } from "../db.js";
import { app } from "../app.js";

// Channel message viewer
app.get("/dashboard/channel", dashboardAuth, (req, res) => {
  const channel = typeof req.query.name === "string" ? req.query.name : "";
  const backNs  = safeNs(req.query.ns);
  const limitRaw = parseInt(req.query.limit, 10);
  const limit   = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;
  const sinceRaw = parseInt(req.query.since_id, 10);
  const since   = Number.isFinite(sinceRaw) && sinceRaw >= 0 ? sinceRaw : 0;

  if (!channel) return res.status(400).send("channel required");

  const tokenParam = req.query.token ? `token=${encodeURIComponent(req.query.token)}` : "";
  const backHref = backNs === "all"
    ? `/dashboard${tokenParam ? "?" + tokenParam : ""}`
    : `/dashboard?ns=${backNs}${tokenParam ? "&" + tokenParam : ""}`;

  const rows      = stmtChanViewRows.all(channel, since, limit);
  const schemaRow = stmtSchemaGet.get(channel);
  const totalRow  = stmtChanCount.get(channel);

  const msgRows = rows.map(r => {
    let parsed = null;
    let contentHtml = "";
    try {
      parsed = JSON.parse(r.content);
      contentHtml = `<pre class="msg-json">${escHtml(JSON.stringify(parsed, null, 2))}</pre>`;
    } catch {
      contentHtml = `<pre class="msg-raw">${escHtml(r.content)}</pre>`;
    }
    const type = parsed?.type || null;
    let badgeClass = "feed-other";
    if      (type === "result")   badgeClass = "feed-result";
    else if (type === "question") badgeClass = "feed-question";
    else if (type === "error")    badgeClass = "feed-error";
    else if (type === "task")     badgeClass = "feed-task";
    else if (type === "heartbeat") badgeClass = "feed-other";
    const taskId = parsed?.task_id ? `<span class="msg-taskid">${escHtml(parsed.task_id)}</span>` : "";
    const typeBadge = type ? `<span class="feed-badge ${badgeClass}">${escHtml(type)}</span>` : "";
    return `<div class="msg-card${type === "question" ? " msg-card-q" : ""}">
  <div class="msg-card-hdr">
    <span class="msg-id">#${r.id}</span>
    ${typeBadge}
    <span class="msg-sender">${escHtml(r.sender)}</span>
    ${taskId}
    <span class="msg-time">${new Date(r.created_at).toISOString().replace("T"," ").slice(0,19)}</span>
  </div>
  ${contentHtml}
</div>`;
  }).join("\n");

  const schemaBadge = schemaRow
    ? (schemaRow.strict
        ? `<span class="badge badge-blue">strict</span>${schemaRow.version ? ` <span class="badge" style="background:#21262d;color:#8b949e">v${escHtml(schemaRow.version)}</span>` : ""}`
        : `<span class="badge badge-orange">warn</span>${schemaRow.version ? ` <span class="badge" style="background:#21262d;color:#8b949e">v${escHtml(schemaRow.version)}</span>` : ""}`)
    : '<span style="color:#484f58">no schema</span>';

  const olderHref = rows.length === limit
    ? `/dashboard/channel?name=${encodeURIComponent(channel)}&ns=${backNs}&limit=${limit}&since_id=${rows[rows.length-1].id - 1}${tokenParam ? `&${tokenParam}` : ""}`
    : null;

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(channel)} — claude-broker</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:ui-monospace,monospace;background:#0d1117;color:#c9d1d9;padding:24px;font-size:13px}
  .back{color:#58a6ff;text-decoration:none;font-size:12px}
  .back:hover{text-decoration:underline}
  h1{color:#c9d1d9;font-size:16px;margin:8px 0 4px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .chan-meta{color:#8b949e;font-size:12px;margin-bottom:20px}
  .msg-card{background:#161b22;border:1px solid #21262d;border-radius:6px;margin-bottom:10px;overflow:hidden}
  .msg-card-q{border-color:#6e4c00}
  .msg-card-hdr{display:flex;align-items:center;gap:10px;padding:8px 14px;border-bottom:1px solid #21262d;flex-wrap:wrap}
  .msg-id{color:#484f58;font-size:11px;min-width:50px}
  .msg-sender{color:#79c0ff;font-weight:bold}
  .msg-taskid{color:#484f58;font-size:11px;font-style:italic}
  .msg-time{color:#484f58;font-size:11px;margin-left:auto}
  .msg-json{padding:12px 14px;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-all;color:#c9d1d9;max-height:600px;overflow-y:auto}
  .msg-raw{padding:12px 14px;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-all;color:#8b949e}
  .badge{display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;margin-left:6px;vertical-align:middle}
  .badge-yellow{background:#6e4c00;color:#e3b341}
  .badge-blue{background:#0d419d;color:#79c0ff}
  .badge-orange{background:#5a3500;color:#f0883e}
  .feed-badge{display:inline-block;padding:1px 7px;border-radius:10px;font-size:10px;font-weight:bold;text-transform:uppercase;letter-spacing:.04em}
  .feed-result{background:#0d2b0d;color:#3fb950}
  .feed-question{background:#3b2800;color:#e3b341}
  .feed-error{background:#2b0d0d;color:#f85149}
  .feed-task{background:#0d1b3e;color:#79c0ff}
  .feed-other{background:#21262d;color:#8b949e}
  .empty{color:#484f58;font-style:italic;padding:20px 0}
  .pager{margin-top:16px;display:flex;gap:12px;align-items:center}
  .pager a{color:#58a6ff;font-size:12px;text-decoration:none}
  .pager a:hover{text-decoration:underline}
  .pager-info{color:#484f58;font-size:11px}
</style>
</head>
<body>
<a href="${backHref}" class="back">← back to dashboard</a>
<h1>${escHtml(channel)} ${schemaBadge}</h1>
<div class="chan-meta">${totalRow.n} total messages &nbsp;·&nbsp; showing last ${Math.min(rows.length, limit)}</div>
${rows.length === 0
  ? `<div class="empty">No messages on this channel yet.</div>`
  : msgRows}
${olderHref ? `<div class="pager"><a href="${escHtml(olderHref)}">← older messages</a><span class="pager-info">showing ${limit} of ${totalRow.n}</span></div>` : ""}
</body></html>`);
});
