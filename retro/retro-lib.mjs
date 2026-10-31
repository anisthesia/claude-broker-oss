// Pure functions for the retro run: cluster FAIL/BLOCK results, find open findings, compact them
// into a short knowledge file, and draft (never apply) role-file edits. No I/O except openDb().
import Database from "better-sqlite3";

export const KNOWLEDGE_CAP_BYTES = 6144;
const BAD_PREFIX = /^\s*(FAIL|BLOCK)\b/i;
const STOP = new Set("the a an and or of to in on for is are was be by with at as it this that from not no do does did has have had its into than then".split(" "));

export function openDb(path) {
  return new Database(path, { readonly: true, fileMustExist: true });
}

// scope / affected_files arrive as an array or a single string (ca, mg notes); always hand back an array.
const asList = (x) => Array.isArray(x) ? x : x ? [x] : [];

function parse(row) {
  try {
    const m = { id: row.id, sender: row.sender, ts: row.created_at, ...JSON.parse(row.content) };
    m.scope = asList(m.scope);
    m.affected_files = asList(m.affected_files);
    return m;
  } catch { return null; }
}

export function loadChannel(db, channel, sinceId = 0) {
  return db.prepare("SELECT id, sender, content, created_at FROM messages WHERE channel = ? AND id > ? ORDER BY id").all(channel, sinceId)
    .map(parse).filter(Boolean);
}

export function tokens(text) {
  return new Set(String(text || "").toLowerCase().replace(/\b[0-9a-f]{7,40}\b/g, " ").replace(/[0-9]+/g, " ")
    .split(/[^a-z_]+/).filter(w => w.length > 2 && !STOP.has(w)));
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

const pathsOf = (m) => new Set([...asList(m.affected_files), ...asList(m.scope)]
  .filter(p => typeof p === "string" && p).map(p => p.replace(/\/+$/, "")));
const sharedCount = (a, b) => { let n = 0; for (const p of a) if (b.has(p)) n++; return n; };

// Items join a cluster when their text is similar, or when they touch at least two common files and
// their text still shares key terms. One common file never merges: run-tests.js appears in unrelated
// findings (measured on cb: a single shared path pulled in "node not on PATH" and "server.js split").
function greedyCluster(items, textOf, threshold, { pathThreshold = 0.14, minShared = 3, minPaths = 2 } = {}) {
  const clusters = [];
  for (const it of items) {
    const tk = tokens(textOf(it)), ps = pathsOf(it);
    // Single link: compare with each member, not the union, so a long cluster does not dilute the score.
    const similar = (m) => {
      const j = jaccard(m.tk, tk);
      if (j >= threshold) return true;
      if (j < pathThreshold || sharedCount(m.ps, ps) < minPaths) return false;
      let shared = 0; for (const w of tk) if (m.tk.has(w)) shared++;
      return shared >= minShared;
    };
    const hit = clusters.find(c => c.members.some(similar));
    if (hit) { hit.items.push(it); hit.members.push({ tk, ps }); for (const w of tk) hit.tk.add(w); for (const p of ps) hit.ps.add(p); }
    else clusters.push({ tk: new Set(tk), ps: new Set(ps), members: [{ tk, ps }], items: [it] });
  }
  return clusters;
}

const isoOf = (ms) => ms > 0 ? new Date(ms).toISOString() : null;
const toCluster = (c, textOf) => {
  const lastTs = Math.max(0, ...c.items.map(m => Number(m.ts) || 0));
  const out = {
  count: c.items.length,
  ids: c.items.map(m => m.id),
  last_id: Math.max(...c.items.map(m => m.id)),
  last_seen: isoOf(lastTs),
  workers: [...new Set(c.items.map(m => m.from || m.sender))],
  task_ids: [...new Set(c.items.map(m => m.task_id).filter(Boolean))],
  sample: String(textOf(c.items[0])).slice(0, 200),
  keywords: [...c.tk].slice(0, 6),
  paths: [...c.ps].slice(0, 6),
  };
  // Full path set and subjects for the staleness match; not part of the printed cluster.
  Object.defineProperty(out, "_ps", { value: c.ps });
  Object.defineProperty(out, "_subjects", { value: c.items.map(m => tokens(m.subject)) });
  return out;
};
const byCount = (a, b) => b.count - a.count || a.ids[0] - b.ids[0];

// FAIL/BLOCK results (and BLOCK reviews) grouped by similar summary text or shared affected_files.
export function clusterFailures(statusMsgs, threshold = 0.5) {
  const bad = statusMsgs.filter(m => (m.type === "result" || m.type === "question") && BAD_PREFIX.test(m.summary || ""));
  return greedyCluster(bad, m => `${m.subject || ""} ${m.summary || ""}`, threshold)
    .map(c => toCluster(c, m => m.summary)).sort(byCount);
}

// Findings that say the same thing in different words (same files, shared key terms): the repeats.
export function clusterFindings(notes, threshold = 0.5) {
  const f = notes.filter(n => n.type === "finding");
  return greedyCluster(f, n => `${n.subject || ""} ${n.summary || ""}`, threshold)
    .filter(c => c.items.length > 1).map(c => toCluster(c, n => n.subject)).sort(byCount);
}

// Notes that are still live: no matching type:resolved. Match by ref_id first; only fall back to
// subject/task_id when the resolved message carries no ref_id.
export function openNotes(notes, now = Date.now()) {
  const byId = new Map(notes.map(n => [n.id, n]));
  const closed = new Set();
  for (const r of notes.filter(n => n.type === "resolved")) {
    if (r.ref_id != null) { if (byId.has(r.ref_id)) closed.add(r.ref_id); continue; }
    for (const n of notes) {
      if (n.id < r.id && (n.type === "finding" || n.type === "decision")
        && ((r.subject && n.subject === r.subject) || (r.task_id && n.task_id === r.task_id && n.from === r.from))) closed.add(n.id);
    }
  }
  return notes.filter(n => (n.type === "finding" || n.type === "decision") && !closed.has(n.id)
    && !(n.expires_at && Date.parse(n.expires_at) < now));
}

// Fold repeats into their newest entry. Decisions fold on near-identical subjects; findings also fold
// when they touch the same files and share key terms, so one problem reported six ways is one entry.
export function dedupe(notes, threshold = 0.7) {
  const newest = [...notes].sort((a, b) => b.id - a.id);
  const out = [];
  for (const n of newest.filter(n => n.type !== "finding")) {
    const tk = tokens(n.subject);
    const dup = out.find(o => o.note.type === n.type && jaccard(o.tk, tk) >= threshold);
    if (dup) { dup.absorbed.push(n.id); dup.senders.add(n.from || n.sender); } else out.push({ note: n, tk, absorbed: [], senders: new Set([n.from || n.sender]) });
  }
  for (const c of greedyCluster(newest.filter(n => n.type === "finding"), n => `${n.subject || ""} ${n.summary || ""}`, 0.5)) {
    const [head, ...rest] = c.items;
    out.push({ note: head, tk: tokens(head.subject), absorbed: rest.map(n => n.id), senders: new Set(c.items.map(n => n.from || n.sender)) });
  }
  return out.sort((a, b) => b.note.id - a.note.id);
}

const DAY = 86400000;
export const DECISION_FULL_DAYS = 14;
// Never shorten an entry below 70 chars: past that, drop the oldest findings instead.
const SHORTEN_STEPS = [220, 160, 110, 70];
const scopeKey = (n) => [...pathsOf(n)].sort().join("|");

const clip = (t, n) => { t = String(t); return t.length > n ? `${t.slice(0, Math.max(1, n - 1))}…` : t; };
const cite = (e) => e.merged?.length ? ` (merges ${e.merged.map(i => `#${i}`).join(", ")})` : "";

// subMax caps a decision's/rule's subject; it stays Infinity until findings are gone and size still forces it.
const line = (e, max, rule = false, subMax = Infinity) => {
  const n = e.note;
  if (rule) return `- #${n.id} ${clip(String(n.subject).slice(0, 90), subMax)}${cite(e)}\n`;
  const sc = max > 0 ? asList(n.scope).slice(0, 3).join(", ") : "";
  const rep = e.absorbed.length ? ` (x${e.absorbed.length + 1} repeats)` : "";
  const sum = max > 0 ? `: ${String(n.summary || "").slice(0, max)}` : "";
  const subj = n.type === "decision" ? clip(n.subject, subMax) : n.subject;
  return `- #${n.id} [${n.to || "*"}] ${subj}${rep}${cite(e)}${sc ? ` — ${sc}` : ""}${sum}\n`;
};

// Short, current knowledge file for a namespace. Priority, highest first: decisions from the last
// 14 days (full), older decisions as one-line standing rules, open findings. Only resolved, expired,
// folded or superseded entries are removed. Over the cap, in order: (1) entry text is shortened, then
// the oldest findings are dropped; (2) decision and rule subjects are shortened through the same steps
// (floor 70 chars); (3) a decision followed by a later one with the same subject (normalised) or a shared exact file path
// (directory, trailing-slash and glob scopes never count; neither does a hub: see HUB_DECISIONS) is merged into the later, which cites both ids; (4) if it still exceeds the cap the file is written
// anyway with an "over cap" header line. A decision is never silently dropped.
export const OVER_CAP = (n, cap) => `<!-- over cap: ${n} B > ${cap} B, decisions kept -->\n`;
// Merge rule: equal normalised subjects, or a shared exact file path. An entry is a file path only with no
// trailing '/' and no glob characters, so 'lib/' or 'retro/*' never pulls unrelated decisions together.
// A hub never counts as shared: some namespaces put topic tags in scope ('brand-a', 'voice' on mg), and a tag on
// more than HUB_DECISIONS open decisions (or named in opts.hubPaths) groups a whole topic, not one file.
export const HUB_DECISIONS = 8;
const filesOf = (m) => new Set([...asList(m.affected_files), ...asList(m.scope)]
  .filter(p => typeof p === "string" && p && !p.endsWith("/") && !/[*?[\]{}]/.test(p)));
const subjKey = (m) => String(m.subject || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
// Paths on more than hubMax of the given decisions, plus the explicit hubPaths list.
export function hubPathsOf(decisionNotes, { hubMax = HUB_DECISIONS, hubPaths = [] } = {}) {
  const count = new Map();
  for (const n of decisionNotes) for (const p of filesOf(n)) count.set(p, (count.get(p) || 0) + 1);
  const hubs = new Set(hubPaths);
  for (const [p, c] of count) if (c > hubMax) hubs.add(p);
  return hubs;
}
const overlaps = (a, b, hubs = new Set()) => {
  const ka = subjKey(a);
  if (ka && ka === subjKey(b)) return true;
  const fa = filesOf(a);
  for (const p of filesOf(b)) if (fa.has(p) && !hubs.has(p)) return true;
  return false;
};

export function compact(ns, notes, { lastId, now = new Date(), cap = KNOWLEDGE_CAP_BYTES, hubMax = HUB_DECISIONS, hubPaths = [] } = {}) {
  const open = openNotes(notes);
  const entries = dedupe(open);
  const total = notes.filter(n => n.type === "finding" || n.type === "decision").length;
  const nowMs = now.getTime();
  const isRecent = (n) => !(n.ts > 0) || nowMs - n.ts <= DECISION_FULL_DAYS * DAY;

  let decisions = entries.filter(e => e.note.type === "decision");
  const superseded = [];
  decisions = decisions.filter(e => {
    const key = scopeKey(e.note);
    const by = key && decisions.find(o => o.note.id > e.note.id && scopeKey(o.note) === key);
    if (by) superseded.push({ id: e.note.id, by: by.note.id });
    return !by;
  });
  const findings = entries.filter(e => e.note.type === "finding");
  // Counted over every open decision, before superseded ones are dropped: a tag is a hub whether or not its older rows survive.
  const hubs = hubPathsOf(entries.filter(e => e.note.type === "decision").map(e => e.note), { hubMax, hubPaths });

  let max = 0, keepF = findings.length, subMax = Infinity;
  const merged = []; // { id, by }: decisions folded into a later one under size pressure
  const live = () => decisions.filter(e => !merged.some(m => m.id === e.note.id));
  const render = (warn = "") => {
    const recent = live().filter(e => isRecent(e.note)), standing = live().filter(e => !isRecent(e.note));
    const folded = open.length - entries.length;
    const dropped = findings.length - keepF;
    const list = (xs) => xs.slice(0, 4).map(x => `#${x.id} by #${x.by}`).join("; ") + (xs.length > 4 ? `; +${xs.length - 4} more` : "");
    const sup = superseded.length ? `, ${superseded.length} superseded (${list(superseded)})` : "";
    const mrg = merged.length ? `, ${merged.length} decisions merged into a later one (${list(merged)})` : "";
    const short = [max < SHORTEN_STEPS[0] ? `entry text shortened to ${max} chars` : "", subMax < Infinity ? `decision subjects to ${subMax} chars` : ""].filter(Boolean).join(", ");
    const head = `<!-- retro ns=${ns} last_id=${lastId} generated=${now.toISOString()} -->\n${warn}# ${ns} knowledge (open notes, generated — do not edit)\n\n`
      + `Compacted from ${total} findings/decisions: ${total - open.length} resolved or expired, ${folded} folded into repeats${sup}${mrg}, `
      + `${dropped} dropped for size; kept ${recent.length} decisions, ${standing.length} standing rules, ${keepF} findings`
      + `${short ? `; ${short} to fit ${cap} B` : ""}.\n\n`;
    return head
      + (recent.length ? `## Decisions (last ${DECISION_FULL_DAYS} days)\n${recent.map(e => line(e, max, false, subMax)).join("")}\n` : "")
      + (standing.length ? `## Standing rules\n${standing.map(e => line(e, 0, true, subMax)).join("")}\n` : "")
      + (keepF ? `## Open findings\n${findings.slice(0, keepF).map(e => line(e, max)).join("")}\n` : "")
      + (dropped ? `_Older findings dropped to fit ${cap} B; read ${ns}-notes with projection=summary for the rest._\n` : "");
  };
  const over = (t) => Buffer.byteLength(t) > cap;
  const shortenSubjects = () => {
    subMax = Infinity;
    let t = render();
    for (const step of SHORTEN_STEPS) { if (!over(t)) break; subMax = step; t = render(); }
    return t;
  };

  let si = 0;
  max = SHORTEN_STEPS[0];
  let text = render();
  while (over(text) && si < SHORTEN_STEPS.length - 1) { max = SHORTEN_STEPS[++si]; text = render(); }
  while (over(text) && keepF > 0) { keepF--; text = render(); }
  if (over(text)) text = shortenSubjects();
  if (over(text)) {
    // Oldest first, so a chain of three folds into the newest and the header cites each hop.
    for (const e of [...decisions].sort((a, b) => a.note.id - b.note.id)) {
      const later = live().filter(o => o.note.id > e.note.id && overlaps(o.note, e.note, hubs))
        .sort((a, b) => a.note.id - b.note.id)[0];
      if (!later) continue;
      merged.push({ id: e.note.id, by: later.note.id });
      later.merged = [...(later.merged || []), e.note.id, ...(e.merged || [])];
      text = shortenSubjects();
      if (!over(text)) break; // merge only as many as the cap requires
    }
  }
  let overCap = false;
  if (over(text)) {
    overCap = true;
    let warn = OVER_CAP(Buffer.byteLength(text), cap);
    text = render(warn);
    // The warning line itself adds bytes; state the size of the file as written.
    for (let i = 0; i < 3; i++) { const w = OVER_CAP(Buffer.byteLength(text), cap); if (w === warn) break; warn = w; text = render(warn); }
  }
  const folded = open.length - entries.length;
  const kept = live();
  const nStanding = kept.filter(e => !isRecent(e.note)).length;
  return {
    text, bytes: Buffer.byteLength(text), total, open: open.length, over_cap: overCap,
    kept: kept.length + keepF, folded, superseded: superseded.length, merged: merged.length,
    resolved: total - open.length, standing: nStanding, dropped: findings.length - keepF, shortened_to: max,
    subject_max: subMax,
    replaced: total - (kept.length + keepF),
  };
}

const roleFileOf = (sender) => sender === "orchestrator" ? "orchestrators/infra/CLAUDE.md" : `workers/${sender}/CLAUDE.md`;

// type:note envelope (valid on <ns>-orchestrator) that PROPOSES role-file edits. Nothing is applied by the
// retro run. A cluster that spans several senders yields one proposal per sender's own role file.
export function proposeEdits(ns, clusters, { date, minCount = 2 } = {}) {
  const proposals = clusters.filter(c => c.count >= minCount).flatMap(c => c.workers.map(w => ({
    target: roleFileOf(w),
    suggestion: `Add a guard or checklist item addressing a recurring ${c.kind === "finding" ? "problem" : "failure"} (${c.count}x): ${c.sample}`,
    evidence_ids: c.ids,
    task_ids: c.task_ids,
  })));
  return {
    type: "note",
    task_id: `${ns}-${date}-retro-role-edits`,
    from: "retro",
    to: "orchestrator",
    subject: `Retro ${ns}: ${proposals.length} proposed role-file edits`,
    body: {
      context: "Weekly retro clustered recurring FAIL/BLOCK results. These are suggestions with evidence; the retro run applied nothing.",
      files_write: [...new Set(proposals.map(p => p.target))],
      proposals,
    },
  };
}

export const STALE_DAYS = 7;
const PASS_PREFIX = /^\s*PASS\b/i;

// Tag clusters that no longer describe a live problem. A stale cluster stays in the output with
// stale = "fixed" | "resolved" | "old" and produces no proposal.
//  - fixed:    a later PASS result is in the same area: same task_id, at least two shared files
//              (one shared file never counts: run-tests.js is in everything), or a near-identical subject.
//  - resolved: a type:resolved on the notes channel has ref_id pointing at one of the cluster's messages.
//  - old:      newest member older than staleDays (members without a timestamp are never old).
export function markStale(clusters, { results = [], notes = [], now = new Date(), staleDays = STALE_DAYS } = {}) {
  const refs = new Set(notes.filter(n => n.type === "resolved" && n.ref_id != null).map(n => Number(n.ref_id)));
  const passes = results.filter(m => m.type === "result" && PASS_PREFIX.test(m.summary || ""))
    .map(m => ({ id: m.id, task_id: m.task_id, ps: pathsOf(m), tk: tokens(m.subject) }));
  for (const c of clusters) {
    const later = passes.filter(p => p.id > c.last_id);
    let why = null;
    if (c.ids.some(i => refs.has(i))) why = "resolved";
    else if (later.some(p => (p.task_id && c.task_ids.includes(p.task_id)) || sharedCount(c._ps, p.ps) >= 2
      || c._subjects.some(t => jaccard(t, p.tk) >= 0.5))) why = "fixed";
    else if (c.last_seen && now.getTime() - Date.parse(c.last_seen) > staleDays * DAY) why = "old";
    if (why) c.stale = why;
  }
  return clusters;
}

export function runRetro(db, ns, { lastId = 0, date = new Date().toISOString().slice(0, 10), now = new Date(), staleDays = STALE_DAYS, hubMax = HUB_DECISIONS, hubPaths = [] } = {}) {
  const notes = loadChannel(db, `${ns}-notes`);
  const status = loadChannel(db, `${ns}-status`, lastId);
  const maxId = Math.max(lastId, ...notes.map(n => n.id), ...status.map(s => s.id));
  // Staleness looks at the whole status history: a PASS from before lastId still fixes an older cluster.
  const opts = { results: lastId ? loadChannel(db, `${ns}-status`) : status, notes, now, staleDays };
  const clusters = markStale(clusterFailures(status), opts);
  // Repeated open findings (3+ reports) also feed proposals; two similar notes are just a fold.
  const repeats = markStale(clusterFindings(openNotes(notes)).filter(c => c.count >= 3), opts).map(c => { c.kind = "finding"; return c; });
  return {
    clusters,
    finding_clusters: repeats,
    knowledge: compact(ns, notes, { lastId: maxId, now, hubMax, hubPaths }),
    envelope: proposeEdits(ns, [...clusters, ...repeats].filter(c => !c.stale), { date }),
    scanned: { notes: notes.length, status: status.length, since_id: lastId },
  };
}
