// GET /dashboard — the main HTML view.
import { VERSION, SHARED_SECRET, DB_PATH, PRUNE_INTERVAL_MS, PRUNE_MAX_AGE_MS, PRUNE_EXEMPT, TELEMETRY_CHANNEL, RATE_LIMIT_CHANNEL, WATCHDOG_BIN, WORKER_OFFLINE_THRESHOLD_S, startedAt } from "../config.js";
import { dashboardAuth } from "../auth.js";
import { loadWorkerDefs, workerRunningInfo } from "../workers.js";
import { nsOf, agoStr, safeNs, escHtml } from "../util.js";
import { stmtChans, stmtSchemaList, stmtLatestPerSender, stmtLatestCostPerSender, stmtLatestMsgPerChannel, stmtSprintInfo, stmtSprintProgress, stmtSprintDispatched, escLike, stmtDashCostRows, stmtDashRlRows, stmtDashChanRows, stmtWorkerTiming, getFeedStmt, stmtCapList } from "../db.js";
import { app } from "../app.js";
import { DASHBOARD_CSS } from "./styles.js";

// Dashboard
app.get("/dashboard", dashboardAuth, (req, res) => {
  const now         = Date.now();
  const allChannels = stmtChans.all();
  const allCaps     = stmtCapList.all();
  const allSchemas  = stmtSchemaList.all();
  const latestMsgs  = stmtLatestMsgPerChannel.all();  // last msg per channel

  // Build preview map: channel -> {sender, content, created_at}
  const previewMap = new Map(latestMsgs.map(r => [r.channel, r]));

  // Auto-detect namespaces
  const nsSet = new Set(allChannels.map(r => nsOf(r.channel)).filter(Boolean));
  allCaps.forEach(r => { try { JSON.parse(r.channels).forEach(c => nsSet.add(nsOf(c))); } catch {} });
  const namespaces = [...nsSet].sort();

  // ns is reflected into the page; restrict to the charset namespaces actually use.
  const selectedNs = safeNs(req.query.ns);
  const isAll      = selectedNs === "all";
  const live       = req.query.live === "1";
  const tokenParam = req.query.token ? `token=${encodeURIComponent(req.query.token)}` : "";

  function matchesNs(ch) { return isAll || nsOf(ch) === selectedNs; }

  const channels  = allChannels.filter(r => matchesNs(r.channel));
  const caps      = allCaps.filter(r => {
    if (isAll) return true;
    try { return JSON.parse(r.channels).some(c => nsOf(c) === selectedNs); } catch { return false; }
  });
  const schemas   = allSchemas.filter(r => matchesNs(r.channel));
  const schemaMap = new Map(schemas.map(s => [s.channel, s]));

  // ── Sprint info ───────────────────────────────────────────────────────────────
  // Collect sprint info per namespace (or just for the selected one)
  function getSprintInfo(ns) {
    const controlChan = `${ns}-control`;
    const statusChan  = `${ns}-status`;
    const row = stmtSprintInfo.get(controlChan);
    if (!row) return null;
    let subject = "", body = "";
    try { const p = JSON.parse(row.content); subject = p.subject || ""; body = typeof p.body === "string" ? p.body : ""; } catch {}
    const slug       = subject.split(/\s+/)[0] || subject;
    const progress   = stmtSprintProgress.get(statusChan) || { completed: 0, failed: 0 };
    const dispatched = stmtSprintDispatched.get(`${escLike(ns)}-%`).n;
    return { ns, slug, startedAt: row.created_at, body, dispatched, ...progress };
  }

  const sprintInfos = isAll
    ? namespaces.map(getSprintInfo).filter(Boolean)
    : [getSprintInfo(selectedNs)].filter(Boolean);

  // ── Today's cost summary from telemetry (session-end heartbeats) ─────────────
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const costRows = isAll
    ? stmtDashCostRows.all(TELEMETRY_CHANNEL, todayStart.getTime())
    : stmtDashChanRows.all(`${selectedNs}-telemetry`, todayStart.getTime());
  const costByWorker = {};
  for (const r of costRows) {
    let hb = {}; try { hb = JSON.parse(r.content); } catch { continue; }
    const usd = parseFloat(hb.cost_since_start?.estimated_usd ?? 0);
    if (!usd || isNaN(usd)) continue;
    if (!costByWorker[r.sender]) costByWorker[r.sender] = 0;
    costByWorker[r.sender] = Math.round((costByWorker[r.sender] + usd) * 10000) / 10000;
  }
  const totalCostToday = Math.round(Object.values(costByWorker).reduce((s, v) => s + v, 0) * 10000) / 10000;

  // ── Rate limit hits today ─────────────────────────────────────────────────────
  const rlChan = isAll ? RATE_LIMIT_CHANNEL : `${selectedNs}-rate-limits`;
  const rlRows = isAll
    ? stmtDashRlRows.all(RATE_LIMIT_CHANNEL, todayStart.getTime())
    : stmtDashChanRows.all(rlChan, todayStart.getTime());
  const rlByWorker = {};
  for (const r of rlRows) {
    let rec = {}; try { rec = JSON.parse(r.content); } catch { continue; }
    rlByWorker[r.sender] = (rlByWorker[r.sender] || 0) + 1;
  }
  const totalRlToday = Object.values(rlByWorker).reduce((s, v) => s + v, 0);

  // ── Worker liveness from telemetry ──────────────────────────────────────────
  // For selected ns, read <ns>-telemetry (or all *-telemetry channels if "all")
  const telemetryChan = isAll ? null : `${selectedNs}-telemetry`;
  const telemetryRows = telemetryChan
    ? stmtLatestPerSender.all(telemetryChan).map(r => ({...r, _ns: selectedNs}))
    : (() => {
        const tChans = allChannels.filter(r => r.channel.endsWith("-telemetry")).map(r => r.channel);
        return tChans.flatMap(c => {
          const ns = nsOf(c);
          return stmtLatestPerSender.all(c).map(r => ({...r, _ns: ns}));
        });
      })();
  const costByKey = new Map();
  for (const c of new Set(telemetryRows.map(r => `${r._ns}-telemetry`))) {
    for (const r of stmtLatestCostPerSender.all(c)) {
      try { costByKey.set(`${nsOf(c)}:${r.sender}`, JSON.parse(r.content)); } catch {}
    }
  }

  // channel → message count, used for inbox-pending lookups
  const channelCountMap = new Map(allChannels.map(r => [r.channel, r.n]));
  const SPECIAL_SUFFIXES = new Set(["status", "control", "telemetry", "backlog"]);

  const workers = telemetryRows.map(row => {
    let hb = {};
    try { hb = JSON.parse(row.content); } catch {}
    const ageSec     = Math.floor((now - row.created_at) / 1000);
    const state      = hb.activity?.state || hb.state || "unknown";
    const task       = hb.activity?.current_task_id || null;
    const fb         = costByKey.get(`${row._ns}:${row.sender}`) || {};
    const cost       = hb.cost_since_start?.estimated_usd ?? fb.cost_since_start?.estimated_usd ?? null;
    const rotating   = hb.context?.rotation_recommended === true;
    const tierPct    = hb.context?.tier_threshold_pct ?? fb.context?.tier_threshold_pct ?? null;
    const model      = hb.model || fb.model || null;
    const inboxChan  = `${row._ns}-${row.sender}`;
    const inboxCount = channelCountMap.get(inboxChan) || 0;

    // on-demand model: offline between tasks is normal — use WORKER_OFFLINE_THRESHOLD_S (default 300s)
    let status;
    if (state === "blocked-on-question") {
      status = "blocked";
    } else if (state === "rotating") {
      status = "rotating";
    } else if (state === "working" && ageSec <= 600) {
      status = "running";
    } else if (state === "working" && ageSec > 600) {
      status = "crashed";
    } else if (ageSec <= WORKER_OFFLINE_THRESHOLD_S) {
      status = inboxCount > 0 ? "queued" : "idle";
    } else {
      status = inboxCount > 0 ? "queued" : "offline";
    }

    return { sender: row.sender, _ns: row._ns, state, task, cost, ageSec, status, rotating, tierPct, model, inboxCount };
  });

  // Also surface workers with pending inbox but no telemetry (never ran or pre-first-heartbeat crash)
  if (!isAll) {
    const coveredChans = new Set(workers.map(w => `${w._ns}-${w.sender}`));
    allChannels
      .filter(r => {
        if (nsOf(r.channel) !== selectedNs || r.n === 0) return false;
        const suffix = r.channel.slice(selectedNs.length + 1);
        if (SPECIAL_SUFFIXES.has(suffix) || suffix.endsWith("-orch")) return false;
        return !coveredChans.has(r.channel);
      })
      .forEach(r => workers.push({
        sender: r.channel.slice(selectedNs.length + 1),
        _ns: selectedNs,
        state: "unknown",
        task: null,
        cost: null,
        ageSec: null,
        status: "queued",
        rotating: false,
        inboxCount: r.n,
      }));
  }

  workers.sort((a,b) => a.sender.localeCompare(b.sender));

  // ── Merge configured workers not yet in telemetry or inbox lists ──────────────
  if (!isAll && WATCHDOG_BIN) {
    const coveredNames = new Set(workers.map(w => w.sender));
    loadWorkerDefs()
      .filter(d => (!d.ns || d.ns === selectedNs) && !coveredNames.has(d.name))
      .forEach(d => workers.push({
        sender:    d.name,
        _ns:       selectedNs,
        state:     "never-started",
        task:      null, cost: null, ageSec: null,
        status:    "offline",
        rotating:  false,
        inboxCount: channelCountMap.get(`${selectedNs}-${d.name}`) || 0,
      }));
    workers.sort((a,b) => a.sender.localeCompare(b.sender));
  }

  // ── Per-worker task timing ────────────────────────────────────────────────────
  const timingMap = new Map();
  try { stmtWorkerTiming.all().forEach(r => timingMap.set(r.worker, r)); } catch {}

  // ── Activity feed ─────────────────────────────────────────────────────────────
  const feedSignalOnly = req.query.feed !== "all";
  const FEED_META = new Set(["telemetry", "control", "backlog", "sprint-retrospective"]);
  const feedChannels = allChannels.filter(r => {
    if (r.channel.startsWith("test")) return false;
    const ns     = nsOf(r.channel);
    const suffix = r.channel.slice(ns.length + 1);
    if (FEED_META.has(suffix)) return false;
    if (!isAll && ns !== selectedNs) return false;
    return true;
  }).map(r => r.channel);
  const feedRows = feedChannels.length ? getFeedStmt(feedChannels.length, feedSignalOnly).all(...feedChannels, 100) : [];
  const questionRows = feedRows.filter(r => {
    try { return JSON.parse(r.content).type === "question"; } catch { return false; }
  });

  const feedHref = (showAll) => {
    const p = [];
    if (selectedNs !== "all") p.push(`ns=${selectedNs}`);
    if (live) p.push("live=1");
    if (showAll) p.push("feed=all");
    if (tokenParam) p.push(tokenParam);
    return `/dashboard${p.length ? "?" + p.join("&") : ""}`;
  };

  const renderFeedRow = (r) => {
    let parsed = {};
    try { parsed = JSON.parse(r.content); } catch {}
    const type    = parsed.type || "?";
    const rawText = parsed.summary || parsed.subject || (typeof parsed.body === "string" ? parsed.body : null) || r.content;
    const summary = String(rawText).slice(0, 100);
    const taskId  = parsed.task_id ? String(parsed.task_id) : "";
    const from    = escHtml(parsed.from || r.sender);
    const to      = parsed.to ? escHtml(String(parsed.to)) : "";
    const chanTag = isAll ? `<span class="feed-chan">${escHtml(r.channel)}</span>` : "";
    const dirCell = to
      ? `${from} <span class="feed-arrow">→</span> <span class="feed-to">${to}</span>${chanTag}`
      : `${from}${chanTag}`;
    let badgeClass;
    if      (type === "result")   badgeClass = "feed-result";
    else if (type === "question") badgeClass = "feed-question";
    else if (type === "error")    badgeClass = "feed-error";
    else if (type === "task")     badgeClass = "feed-task";
    else                          badgeClass = "feed-other";
    return `<tr class="${type === "question" ? "feed-row-q" : ""}">
      <td class="feed-time">${agoStr(r.created_at)}</td>
      <td><span class="feed-badge ${badgeClass}">${escHtml(type)}</span></td>
      <td class="feed-sender">${dirCell}</td>
      <td class="feed-taskid-col" title="${escHtml(taskId)}">${taskId ? escHtml(taskId.slice(-22)) : '<span class="dim">—</span>'}</td>
      <td class="feed-content">${escHtml(summary)}${summary.length >= 100 ? "…" : ""}</td>
    </tr>`;
  };

  const questionsAlertHtml = questionRows.length > 0 ? (() => {
    const items = questionRows.slice(0, 5).map(r => {
      let p = {};
      try { p = JSON.parse(r.content); } catch {}
      const from = escHtml(p.from || r.sender);
      const bodyText = p.subject || (typeof p.body === 'string' ? p.body : null) || r.content;
      const body = escHtml(String(bodyText).slice(0, 200));
      const tid  = p.task_id ? ` <span class="feed-taskid">[${escHtml(p.task_id)}]</span>` : "";
      return `<div class="questions-alert-item"><strong>${from}</strong>: ${body}${tid}</div>`;
    }).join("");
    return `<div class="questions-alert">
  <div class="questions-alert-title">⚠ ${questionRows.length} pending question${questionRows.length > 1 ? "s" : ""} — need your attention</div>
  ${items}
</div>`;
  })() : "";

  const feedTableHtml = feedRows.length === 0
    ? `<div class="empty">No ${feedSignalOnly ? "signal " : ""}messages yet${feedChannels.length > 0 ? ` on ${escHtml(feedChannels.slice(0,5).join(", "))}${feedChannels.length > 5 ? ` +${feedChannels.length - 5} more` : ""}` : " (no channels found)"}.</div>`
    : `<table><thead><tr><th>Time</th><th>Type</th><th>From${isAll ? " / Channel" : ""} → To</th><th>Task ID</th><th>Summary</th></tr></thead><tbody>${feedRows.map(renderFeedRow).join("\n")}</tbody></table>`;

  // Annotate each worker with managed/running flags for Start/Stop buttons
  const defs = loadWorkerDefs();
  workers.forEach(w => {
    w.isManaged = WATCHDOG_BIN.length > 0 &&
                  defs.some(d => d.name === w.sender && (!d.ns || d.ns === w._ns));
    w.isRunning  = !!workerRunningInfo(w.sender);
  });

  const hasActions = WATCHDOG_BIN.length > 0;

  // ── HTML helpers ─────────────────────────────────────────────────────────────
  const uptime = (() => {
    const s = Math.floor((now - startedAt) / 1000);
    return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m ${s%60}s`;
  })();

  const tabHref = (ns, lv) => {
    const params = [];
    if (ns !== "all") params.push(`ns=${ns}`);
    if (lv) params.push("live=1");
    if (tokenParam) params.push(tokenParam);
    return `/dashboard${params.length ? "?" + params.join("&") : ""}`;
  };

  const tabs = ["all", ...namespaces].map(ns => {
    const active = ns === selectedNs;
    const count  = ns === "all" ? allChannels.length : allChannels.filter(r => nsOf(r.channel) === ns).length;
    return `<a href="${escHtml(tabHref(ns, live))}" class="tab${active ? " tab-active" : ""}">${ns === "all" ? "All" : escHtml(ns)} <span class="tab-count">${count}</span></a>`;
  }).join("\n");

  // ── Channel rows (with preview) ───────────────────────────────────────────────
  const chanRows = channels.map(r => {
    const exempt      = PRUNE_EXEMPT.includes(r.channel) ? '<span class="badge badge-yellow">exempt</span>' : '';
    const schemaInfo  = schemaMap.get(r.channel);
    const schema      = schemaInfo
      ? (schemaInfo.strict
          ? '<span class="badge badge-blue">strict</span>'
          : '<span class="badge badge-orange">warn</span>')
      : '';
    const prev    = previewMap.get(r.channel);
    let preview   = "";
    if (prev) {
      let text = prev.content;
      try { const p = JSON.parse(text); text = p.subject || p.type || text; } catch {}
      preview = `<span class="preview">${escHtml(String(text).slice(0,80))}${text.length > 80 ? "…" : ""}</span>`;
    }
    const chanHref = `/dashboard/channel?name=${encodeURIComponent(r.channel)}${selectedNs !== "all" ? `&ns=${selectedNs}` : ""}${tokenParam ? `&${tokenParam}` : ""}`;
    return `<tr>
      <td><a href="${chanHref}" class="chan-link">${escHtml(r.channel)}</a>${exempt}${schema}</td>
      <td>${r.n}</td>
      <td>#${r.last_id}</td>
      <td>${agoStr(r.last_ts)}</td>
      <td class="preview-cell">${preview}</td>
    </tr>`;
  }).join("\n");

  // ── Worker liveness rows ──────────────────────────────────────────────────────
  const workerRows = workers.map(w => {
    let dotClass;
    if      (w.status === "running" || w.status === "idle")    dotClass = "dot-green";
    else if (w.status === "queued" || w.status === "rotating") dotClass = "dot-yellow";
    else if (w.status === "offline")                           dotClass = "dot-grey";
    else                                                       dotClass = "dot-red";

    const tierLabel = (w.tierPct !== null && w.status === "running")
      ? ` <span class="ctx-fill${w.tierPct >= 80 ? " ctx-fill-warn" : ""}" title="context fill">${Math.round(w.tierPct)}%</span>`
      : "";
    const stateLabel = w.ageSec === null
      ? '<span class="dim">—</span>'
      : w.status === "offline" || w.status === "crashed"
        ? w.status
        : (w.state === "idle-polling" || w.state === "idle-exit" || w.state === "session-end")
          ? "idle"
          : w.state === "blocked-on-question"
            ? '<span style="color:#f85149;font-weight:bold">blocked</span>'
            : w.status === "running"
              ? `working${tierLabel}`
              : w.state;
    const taskCell   = w.task ? `<span class="task-label">${escHtml(String(w.task).slice(0,40))}</span>` : '<span class="dim">—</span>';
    const costCell   = w.cost != null ? `$${Number(w.cost).toFixed(3)}` : '<span class="dim">—</span>';
    const rotBadge   = w.rotating ? '<span class="badge badge-orange">rotate</span>' : '';
    const inboxCell  = w.inboxCount > 0 ? `<span class="inbox-count">${w.inboxCount}</span>` : '<span class="dim">—</span>';
    const lastSeen   = w.ageSec !== null ? agoStr(now - w.ageSec * 1000) : '<span class="dim">—</span>';
    const actionCell = w.isManaged
      ? w.isRunning
        ? `<button class="btn-stop"  onclick="workerAction('${escHtml(w.sender)}','stop')">Stop</button>`
        : `<button class="btn-start" onclick="workerAction('${escHtml(w.sender)}','start')">Start</button>`
      : (hasActions ? '<span class="dim">—</span>' : "");
    const t = timingMap.get(w.sender);
    const timingCell = t
      ? `<span class="timing-avg" title="min ${t.min_min}m · max ${t.max_min}m · ${t.tasks_done} task${t.tasks_done !== 1 ? 's' : ''}">${t.avg_min}m avg</span>`
      : '<span class="dim">—</span>';

    let idleCell = '<span class="dim">—</span>';
    if (w.status === "running") {
      idleCell = '<span class="dim">active</span>';
    } else if (t && t.last_result_at) {
      idleCell = `<span class="idle-time">${agoStr(t.last_result_at)}</span>`;
    }

    const modelTag = w.model
      ? `<span class="worker-model" title="${escHtml(w.model)}">${escHtml(w.model.replace(/^claude-/,"").replace(/-\d{8}$/,"").slice(0,14))}</span>`
      : "";

    return `<tr>
      <td><span class="dot ${dotClass}"></span> ${escHtml(w.sender)}${rotBadge}${modelTag}</td>
      <td>${stateLabel}</td>
      <td>${taskCell}</td>
      <td>${costCell}</td>
      <td>${timingCell}</td>
      <td>${idleCell}</td>
      <td>${inboxCell}</td>
      <td>${lastSeen}</td>
      ${hasActions ? `<td>${actionCell}</td>` : ""}
    </tr>`;
  }).join("\n");

  // ── Cap rows ──────────────────────────────────────────────────────────────────
  const capRows = caps.map(r => {
    const owns  = JSON.parse(r.owns).join(", ");
    const chans = JSON.parse(r.channels).join(", ");
    return `<tr><td>${escHtml(r.worker)}</td><td>${escHtml(owns)}</td><td>${escHtml(chans)}</td><td>${agoStr(r.updated_at)}</td></tr>`;
  }).join("\n");

  const schemaRows = schemas.map(r =>
    `<tr><td>${escHtml(r.channel)}</td><td>${r.strict ? '<span class="badge badge-blue">strict</span>' : '<span class="badge badge-orange">warn</span>'}</td><td>${r.version ? escHtml(r.version) : '<span class="dim">—</span>'}</td><td>${new Date(r.updated_at).toISOString()}</td></tr>`
  ).join("\n");

  const totalMsgs = channels.reduce((a, r) => a + r.n, 0);
  const nsLabel   = !isAll ? `<span class="ns-label">${selectedNs}</span>` : "";

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>claude-broker${selectedNs !== "all" ? ` · ${selectedNs}` : ""}</title>
${live ? `<meta http-equiv="refresh" content="30">` : ""}
<style>
${DASHBOARD_CSS}</style>
</head>
<body>
<h1>claude-broker <span style="font-size:13px;color:#8b949e;font-weight:normal">v${VERSION}</span></h1>
<div class="meta">uptime: ${uptime} &nbsp;·&nbsp; db: ${DB_PATH} &nbsp;·&nbsp; auth: <span class="${SHARED_SECRET ? "auth-on" : "auth-off"}">${SHARED_SECRET ? "on" : "OFF"}</span>${hasActions ? ` &nbsp;·&nbsp; workers: ${loadWorkerDefs().length} configured` : ""}${live ? ' &nbsp;·&nbsp; <span style="color:#3fb950">● live (30s)</span>' : ""}</div>

<div class="config">
  <div class="config-item"><span class="config-label">Auto-prune</span><span class="config-value">every ${PRUNE_INTERVAL_MS/60000}m · max age ${PRUNE_MAX_AGE_MS/3600000}h</span></div>
  <div class="config-item"><span class="config-label">Exempt</span><span class="config-value">${PRUNE_EXEMPT.join(", ") || "(none)"}</span></div>
  <div class="config-item"><span class="config-label">Channels${isAll ? "" : ` (${selectedNs})`}</span><span class="config-value">${channels.length} / ${allChannels.length}</span></div>
  <div class="config-item"><span class="config-label">Messages${isAll ? "" : ` (${selectedNs})`}</span><span class="config-value">${totalMsgs}</span></div>
  <div class="config-item"><span class="config-label">Schemas${isAll ? "" : ` (${selectedNs})`}</span><span class="config-value">${schemas.length} / ${allSchemas.length}</span></div>
  <div class="config-item"><span class="config-label">Projects</span><span class="config-value">${namespaces.join(", ") || "(none yet)"}</span></div>
</div>

${sprintInfos.length > 0 ? `
<div class="sprint-bar">
${sprintInfos.map(s => {
  const open   = Math.max(0, s.dispatched - s.completed);
  const pct    = s.dispatched > 0 ? Math.round((s.completed / s.dispatched) * 100) : 0;
  const nsTag  = isAll ? `<span style="font-size:10px;color:#8b949e;font-weight:normal;margin-left:6px">${escHtml(s.ns)}</span>` : "";
  return `<div class="sprint-card">
  <div class="sprint-name">${escHtml(s.slug)}${nsTag}</div>
  <div class="sprint-meta">started ${agoStr(s.startedAt)}</div>
  <div class="sprint-progress">
    <div class="sprint-stat"><span class="sprint-stat-val">${s.dispatched}</span><span class="sprint-stat-lbl">dispatched</span></div>
    <div class="sprint-stat"><span class="sprint-stat-val done">${s.completed}</span><span class="sprint-stat-lbl">completed</span></div>
    <div class="sprint-stat"><span class="sprint-stat-val open">${open}</span><span class="sprint-stat-lbl">open</span></div>
    ${s.failed > 0 ? `<div class="sprint-stat"><span class="sprint-stat-val fail">${s.failed}</span><span class="sprint-stat-lbl">failed</span></div>` : ""}
  </div>
  <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
</div>`;
}).join("\n")}
</div>` : ""}

<div class="tabs">
${tabs}
<a href="${tabHref(selectedNs, !live)}" class="live-btn ${live ? "live-on" : "live-off"}">${live ? "● Live" : "Live"}</a>
</div>

${questionsAlertHtml}
${totalCostToday > 0 ? `<div class="cost-bar">
  <span class="cost-bar-label">Today's spend</span>
  <span class="cost-bar-total">$${totalCostToday.toFixed(4)}</span>
  ${Object.entries(costByWorker).sort((a,b)=>b[1]-a[1]).map(([w,c])=>`<span class="cost-bar-worker"><span class="cost-bar-wname">${escHtml(w)}</span> $${c.toFixed(4)}</span>`).join("")}
  <a href="/cost${tokenParam ? "?" + tokenParam : ""}" class="cost-bar-link" target="_blank">JSON</a>
</div>` : ""}
${totalRlToday > 0 ? `<div class="cost-bar" style="border-color:#6e4c00">
  <span class="cost-bar-label" style="color:#e3b341">Rate limits today</span>
  <span class="cost-bar-total" style="color:#e3b341">${totalRlToday} hit${totalRlToday !== 1 ? "s" : ""}</span>
  ${Object.entries(rlByWorker).sort((a,b)=>b[1]-a[1]).map(([w,n])=>`<span class="cost-bar-worker"><span class="cost-bar-wname">${escHtml(w)}</span> ${n}×</span>`).join("")}
  <a href="/rate-limits${tokenParam ? "?" + tokenParam : ""}" class="cost-bar-link" target="_blank">JSON</a>
</div>` : ""}

<div class="section-hdr">
  Activity Feed ${nsLabel}
  <span class="section-hdr-controls">
    <a href="${feedHref(false)}" class="feed-toggle${feedSignalOnly ? " feed-toggle-active" : ""}">Signal</a>
    <a href="${feedHref(true)}" class="feed-toggle${!feedSignalOnly ? " feed-toggle-active" : ""}">All</a>
  </span>
</div>
${feedTableHtml}

<h2>Worker Liveness ${nsLabel}</h2>
${workers.length === 0
  ? `<div class="empty">No telemetry yet${isAll ? "" : ` for "${selectedNs}"`}. Workers emit heartbeats to <code>${isAll ? "*-telemetry" : telemetryChan}</code>.</div>`
  : `<table><thead><tr><th>Worker</th><th>State</th><th>Current Task</th><th>Cost</th><th>Avg Task Time</th><th>Idle Since</th><th>Inbox</th><th>Last Seen</th>${hasActions ? "<th>Actions</th>" : ""}</tr></thead><tbody>${workerRows}</tbody></table>`}

<h2>Channels ${nsLabel}</h2>
${channels.length === 0
  ? `<div class="empty">No channels${isAll ? " yet." : ` for "${selectedNs}".`}</div>`
  : `<table><thead><tr><th>Channel</th><th>Messages</th><th>Last ID</th><th>Last Activity</th><th>Last Message</th></tr></thead><tbody>${chanRows}</tbody></table>`}

<h2>Worker Capabilities ${nsLabel}</h2>
${caps.length === 0
  ? `<div class="empty">No capabilities registered${isAll ? ". Workers should call register_capability at startup." : ` for "${selectedNs}".`}</div>`
  : `<table><thead><tr><th>Worker</th><th>Owns</th><th>Channels</th><th>Registered</th></tr></thead><tbody>${capRows}</tbody></table>`}

<h2>Channel Schemas ${nsLabel}</h2>
${schemas.length === 0
  ? `<div class="empty">No schemas${isAll ? " registered." : ` for "${selectedNs}".`}</div>`
  : `<table><thead><tr><th>Channel</th><th>Mode</th><th>Version</th><th>Updated</th></tr></thead><tbody>${schemaRows}</tbody></table>`}

<p style="margin-top:24px;color:#484f58;font-size:11px">Refreshed at ${new Date().toISOString()} &nbsp;·&nbsp; <a href="${tabHref(selectedNs, live)}" style="color:#58a6ff">reload</a></p>
<script>
function workerAction(name, action) {
  const btn = event.target;
  btn.disabled = true;
  btn.textContent = action === 'start' ? 'Starting…' : 'Stopping…';
  const token = new URLSearchParams(location.search).get('token');
  fetch('/workers/' + encodeURIComponent(name) + '/' + action, { method: 'POST', headers: token ? { 'Authorization': 'Bearer ' + token } : {} })
    .then(r => r.json())
    .then(d => { if (d.ok) location.reload(); else { alert(d.error || 'Error'); btn.disabled = false; btn.textContent = action === 'start' ? 'Start' : 'Stop'; } })
    .catch(() => { alert('Request failed'); btn.disabled = false; });
}
</script>
</body></html>`);
});
