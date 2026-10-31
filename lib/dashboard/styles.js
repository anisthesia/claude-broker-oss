// Stylesheet for the main /dashboard view.

export const DASHBOARD_CSS = `\
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:ui-monospace,monospace;background:#0d1117;color:#c9d1d9;padding:24px;font-size:13px}
  h1{color:#58a6ff;font-size:18px;margin-bottom:4px}
  .meta{color:#8b949e;margin-bottom:16px;font-size:12px}
  h2{color:#8b949e;font-size:12px;text-transform:uppercase;letter-spacing:.08em;border-bottom:1px solid #21262d;padding-bottom:6px;margin:20px 0 10px}
  table{width:100%;border-collapse:collapse;margin-bottom:4px}
  th{background:#161b22;color:#8b949e;text-align:left;padding:6px 12px;font-weight:normal;font-size:11px;text-transform:uppercase;letter-spacing:.06em}
  td{padding:6px 12px;border-bottom:1px solid #161b22;vertical-align:middle;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:#161b22}
  .badge{display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;margin-left:6px;vertical-align:middle}
  .badge-yellow{background:#6e4c00;color:#e3b341}
  .badge-blue{background:#0d419d;color:#79c0ff}
  .badge-orange{background:#5a3500;color:#f0883e}
  .empty{color:#484f58;font-style:italic;padding:10px 0}
  .config{background:#161b22;border:1px solid #21262d;border-radius:6px;padding:12px 16px;margin-bottom:16px;display:flex;gap:24px;flex-wrap:wrap}
  .config-item{display:flex;flex-direction:column;gap:2px}
  .config-label{color:#8b949e;font-size:10px;text-transform:uppercase;letter-spacing:.06em}
  .config-value{color:#c9d1d9}
  .auth-on{color:#3fb950}.auth-off{color:#f85149}
  .sprint-bar{display:flex;gap:0;flex-wrap:wrap;margin-bottom:16px}
  .sprint-card{background:#161b22;border:1px solid #21262d;border-radius:6px;padding:10px 16px;margin-right:10px;margin-bottom:8px;min-width:260px;flex:1}
  .sprint-name{color:#e3b341;font-size:13px;font-weight:bold;margin-bottom:6px}
  .sprint-meta{color:#8b949e;font-size:11px;margin-bottom:8px}
  .sprint-progress{display:flex;gap:16px}
  .sprint-stat{display:flex;flex-direction:column;gap:1px}
  .sprint-stat-val{font-size:18px;font-weight:bold;color:#c9d1d9}
  .sprint-stat-val.done{color:#3fb950}
  .sprint-stat-val.fail{color:#f85149}
  .sprint-stat-val.open{color:#79c0ff}
  .sprint-stat-lbl{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#8b949e}
  .progress-bar{height:4px;background:#21262d;border-radius:2px;margin-top:8px;overflow:hidden}
  .progress-fill{height:100%;background:#3fb950;border-radius:2px;transition:width .3s}
  .tabs{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:20px;border-bottom:1px solid #21262d;padding-bottom:0;align-items:flex-end}
  .tab{display:inline-block;padding:6px 14px;border-radius:6px 6px 0 0;font-size:12px;color:#8b949e;text-decoration:none;border:1px solid transparent;border-bottom:none;margin-bottom:-1px}
  .tab:hover{color:#c9d1d9;background:#161b22}
  .tab-active{color:#c9d1d9;background:#161b22;border-color:#21262d;border-bottom-color:#161b22}
  .tab-count{display:inline-block;background:#21262d;color:#8b949e;border-radius:10px;padding:0 6px;font-size:10px;margin-left:4px}
  .tab-active .tab-count{background:#30363d;color:#c9d1d9}
  .ns-label{display:inline-block;background:#1f3a5f;color:#79c0ff;border-radius:4px;padding:2px 8px;font-size:11px;margin-left:8px;vertical-align:middle}
  .preview{color:#484f58;font-size:11px}
  .preview-cell{max-width:280px}
  .dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;vertical-align:middle;flex-shrink:0}
  .dot-green{background:#3fb950}
  .dot-yellow{background:#e3b341}
  .dot-red{background:#f85149;box-shadow:0 0 4px #f85149}
  .dot-grey{background:#484f58}
  .task-label{color:#79c0ff;font-size:11px}
  .inbox-count{color:#e3b341;font-weight:bold}
  .dim{color:#484f58}
  .live-btn{margin-left:auto;padding:4px 12px;border-radius:6px 6px 0 0;font-size:11px;font-family:inherit;cursor:pointer;border:1px solid #21262d;border-bottom:none;margin-bottom:-1px;text-decoration:none}
  .live-on{background:#0d2b0d;color:#3fb950;border-color:#1f5c1f}
  .live-off{background:#161b22;color:#8b949e}
  .btn-start,.btn-stop{padding:2px 10px;border-radius:4px;font-size:11px;font-family:inherit;cursor:pointer;border:1px solid}
  .btn-start{background:#0d2b0d;color:#3fb950;border-color:#1f5c1f}
  .btn-start:hover{background:#163d16}
  .btn-stop{background:#2b0d0d;color:#f85149;border-color:#5c1f1f}
  .btn-stop:hover{background:#3d1616}
  .btn-start:disabled,.btn-stop:disabled{opacity:.4;cursor:default}
  .cost-bar{display:flex;align-items:center;gap:10px;background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:8px 14px;margin-bottom:12px;font-size:12px;flex-wrap:wrap}
  .cost-bar-label{color:#8b949e;text-transform:uppercase;letter-spacing:.06em;font-size:11px}
  .cost-bar-total{color:#58a6ff;font-weight:bold;font-size:14px;min-width:60px}
  .cost-bar-worker{color:#e6edf3;background:#161b22;border-radius:4px;padding:2px 7px}
  .cost-bar-wname{color:#8b949e;margin-right:4px}
  .cost-bar-link{margin-left:auto;color:#8b949e;font-size:11px;text-decoration:none}
  .cost-bar-link:hover{color:#58a6ff}
  .questions-alert{background:#2b1d00;border:1px solid #6e4c00;border-radius:6px;padding:10px 16px;margin-bottom:16px}
  .questions-alert-title{color:#e3b341;font-weight:bold;margin-bottom:6px;font-size:12px}
  .questions-alert-item{padding:3px 0;border-bottom:1px solid #3b2800;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .questions-alert-item:last-child{border-bottom:none}
  .section-hdr{display:flex;align-items:center;color:#8b949e;font-size:12px;text-transform:uppercase;letter-spacing:.08em;border-bottom:1px solid #21262d;padding-bottom:6px;margin:20px 0 10px}
  .section-hdr-controls{margin-left:auto;text-transform:none;letter-spacing:normal;display:flex;gap:4px}
  .feed-toggle{padding:1px 8px;border-radius:3px;font-size:10px;text-decoration:none;color:#8b949e;border:1px solid #21262d}
  .feed-toggle-active{color:#c9d1d9;background:#21262d;border-color:#30363d}
  .feed-badge{display:inline-block;padding:1px 7px;border-radius:10px;font-size:10px;font-weight:bold;text-transform:uppercase;letter-spacing:.04em}
  .feed-result{background:#0d2b0d;color:#3fb950}
  .feed-question{background:#3b2800;color:#e3b341}
  .feed-error{background:#2b0d0d;color:#f85149}
  .feed-task{background:#0d1b3e;color:#79c0ff}
  .feed-other{background:#21262d;color:#8b949e}
  .feed-time{color:#8b949e;font-size:11px;white-space:nowrap;width:80px}
  .feed-sender{color:#79c0ff;white-space:nowrap;max-width:140px;overflow:hidden;text-overflow:ellipsis}
  .feed-content{max-width:480px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .feed-chan{font-size:10px;color:#484f58;margin-left:6px}
  .feed-taskid{font-size:10px;color:#484f58;margin-left:8px}
  .feed-row-q td{background:#1a1400}
  .feed-row-q:hover td{background:#241c00 !important}
  .feed-taskid-col{font-size:10px;color:#484f58;white-space:nowrap;max-width:180px;overflow:hidden;text-overflow:ellipsis}
  .feed-arrow{color:#484f58;margin:0 2px}
  .feed-to{color:#e3b341}
  .timing-avg{color:#79c0ff;cursor:default}
  .idle-time{color:#8b949e}
  .ctx-fill{color:#79c0ff;font-size:10px;margin-left:4px}
  .ctx-fill-warn{color:#f0883e}
  .worker-model{color:#484f58;font-size:10px;margin-left:6px;vertical-align:middle}
  .chan-link{color:#c9d1d9;text-decoration:none}
  .chan-link:hover{color:#58a6ff;text-decoration:underline}
`;
