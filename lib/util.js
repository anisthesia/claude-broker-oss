// Small shared helpers: namespace of a channel, relative time, HTML escaping.

export function nsOf(channel) {
  const idx = channel.indexOf("-");
  return idx > 0 ? channel.slice(0, idx) : channel;
}
export function agoStr(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s/60)}m ago` : `${Math.floor(s/3600)}h ago`;
}
// Namespace query params are interpolated into HTML and hrefs — allow only [A-Za-z0-9_.-].
export function safeNs(v) {
  return typeof v === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(v) ? v : "all";
}
export function escHtml(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
