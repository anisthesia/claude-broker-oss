// Per-namespace v3 adoption (adopt_namespace / POST /namespaces/:ns/adopt). Adopting a namespace
// makes every watchdog start_worker launches for it afterwards send role= in its sessions' MCP URL
// and key heartbeats / cursors / ledger on WORKER_AS instead of the worker path basename. The state
// lives in SQLite and is read at spawn time (WATCHDOG_NS_ADOPTED, lib/workers.js) — no restart, and
// running watchdogs keep the identity they started with.
//
// For entries whose two keys differ (workers/code-reviewer → reviewer), the old key's cursor rows on
// the namespace's own channels are copied to the new key — never moved, and only ever raised
// (MAX upsert) — so adoption orphans no cursor; revert copies the other way, so it is lossless too.
//
// adopt and revert need admin_token == ADMIN_SECRET (like force-purge of a PRUNE_EXEMPT channel):
// role=admin is self-asserted in the MCP URL and the REST route's SHARED_SECRET is held by every
// worker. dry_run needs no token — it writes nothing.
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { db, stmtAdoptGet, stmtAdoptList, stmtAdoptUpsert, stmtNsGet, stmtCursorList, stmtCursorGet, stmtCursorAdvance } from "./db.js";
import { WATCHDOG_BIN } from "./config.js";
import { loadWorkerDefs, expandArgs } from "./workers.js";
import { adminConfigured, adminTokenMatches } from "./auth.js";

const BUNDLED_WATCHDOG = fileURLToPath(new URL("../watchdog.sh", import.meta.url));
// --print-channels is pure local derivation (~40 ms); a hung WATCHDOG_BIN is killed after this.
const DERIVE_TIMEOUT_MS = 3000;
const DERIVE_CONCURRENCY = 8;

export function adoptionState(ns) {
  const r = stmtAdoptGet.get(ns);
  return r ? { ns, adopted: !!r.adopted, adopted_at: r.adopted_at, reverted_at: r.reverted_at, updated_at: r.updated_at } : { ns, adopted: false };
}
export function listAdoptions() { return stmtAdoptList.all().map(r => ({ ...r, adopted: !!r.adopted })); }

// The watchdog's own identity derivation (--print-channels), run with and without adoption, so the
// keys here can never drift from the ones the watchdog will actually use. Async (never spawnSync):
// planning runs on the request path and must not stall the broker's event loop.
function deriveIdentity(def, adopted) {
  const bin = WATCHDOG_BIN || BUNDLED_WATCHDOG;
  return new Promise((resolve, reject) => {
    // Own process group (detached), so a timeout kills the whole tree — killing only the shell
    // would orphan whatever it is blocked on.
    const child = spawn(bin, [...expandArgs(def.args || []), "--print-channels"], {
      stdio: ["ignore", "pipe", "pipe"], detached: true,
      env: { ...process.env, WATCHDOG_NAMESPACE: def.ns, WATCHDOG_NS_ADOPTED: adopted ? "1" : "0" },
    });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.setEncoding("utf8").on("data", d => { stdout += d; });
    child.stderr.setEncoding("utf8").on("data", d => { stderr += d; });
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }, DERIVE_TIMEOUT_MS);
    child.on("error", e => { clearTimeout(timer); reject(e); });
    child.on("close", code => {
      clearTimeout(timer);
      const out = Object.fromEntries(stdout.split("\n").filter(l => l.includes("=")).map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
      if (timedOut) return reject(new Error(`--print-channels timed out after ${DERIVE_TIMEOUT_MS} ms`));
      if (code !== 0 || !out.key) return reject(new Error((stderr.trim() || `exit ${code}`).split("\n")[0]));
      resolve(out);
    });
  });
}

// Run fn over items with at most `limit` in flight; results keep input order.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const lane = async () => { while (next < items.length) { const i = next++; results[i] = await fn(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

// What adopting (or reverting) ns would change. Pure read — nothing is written.
export async function planAdoption(ns, { revert = false } = {}) {
  const entries = [], underivable = [], copies = [];
  const derived = await mapLimit(loadWorkerDefs().filter(d => d.ns === ns), DERIVE_CONCURRENCY, async def => {
    try { return { def, before: await deriveIdentity(def, false), after: await deriveIdentity(def, true) }; }
    catch (e) { return { def, error: e.message }; }
  });
  for (const { def, before, after, error } of derived) {
    if (error) { underivable.push({ name: def.name, error }); continue; }
    entries.push({
      name: def.name, inbox: after.inbox, role: after.role, as: after.as,
      legacy_key: before.key, adopted_key: after.key, renamed: before.key !== after.key,
      mcp_query: { not_adopted: before.mcp_query, adopted: after.mcp_query },
    });
  }
  // Several entries can share a source key (one worker dir in many namespaces is why rows are
  // limited to this namespace's channels); plan each (from, to, channel) once.
  const seen = new Set();
  for (const e of entries.filter(e => e.renamed)) {
    const [from, to] = revert ? [e.adopted_key, e.legacy_key] : [e.legacy_key, e.adopted_key];
    for (const c of stmtCursorList.all(from)) {
      if (!c.channel.startsWith(`${ns}-`)) continue;
      const k = `${from}\0${to}\0${c.channel}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const existing = stmtCursorGet.get(to, c.channel)?.last_id ?? null;
      copies.push({ entry: e.name, from, to, channel: c.channel, last_id: c.last_id, existing,
                    changes: existing === null || existing < c.last_id });
    }
  }
  return { entries, renamed: entries.filter(e => e.renamed).map(e => e.name), underivable, cursor_copies: copies };
}

const copyAndStore = db.transaction((ns, copies, row) => {
  const now = Date.now();
  for (const c of copies) if (c.changes) stmtCursorAdvance.run(c.to, c.channel, c.last_id, now);
  stmtAdoptUpsert.run(ns, row.adopted, row.adopted_at, row.reverted_at, now, row.report);
});

class AdoptionError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// adopt (default) or revert ns. dry_run: the same report, nothing written. Rejects with AdoptionError.
export async function adoptNamespace(ns, { dry_run = false, revert = false, admin_token } = {}) {
  if (typeof ns !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(ns)) throw new AdoptionError(400, `invalid ns '${ns}'`);
  const action = revert ? "revert" : "adopt";
  if (!dry_run) {
    if (!adminConfigured()) throw new AdoptionError(503, `${action} refused: the broker has no ADMIN_SECRET configured, so adopt/revert is disabled (dry_run still works)`);
    if (!adminTokenMatches(admin_token)) {
      throw new AdoptionError(403, `${action} refused: ${admin_token ? "admin_token does not match ADMIN_SECRET" : "admin_token (the broker's ADMIN_SECRET) is required"} — worker sessions do not hold it; ask a human (dry_run needs no token)`);
    }
  }
  if (!revert && !stmtNsGet.get(ns)) {
    throw new AdoptionError(409, `namespace '${ns}' has no registered manifest — register_namespace it first (schemas/manifests/${ns}.json)`);
  }
  let state = adoptionState(ns);
  const noop = revert && !state.adopted;
  const plan = noop ? { entries: [], renamed: [], underivable: [], cursor_copies: [] } : await planAdoption(ns, { revert });
  // Planning awaited child processes; re-read so the stored row reflects any adopt/revert since.
  state = adoptionState(ns);
  const report = {
    ns, action, dry_run: !!dry_run,
    state_before: state.adopted ? "adopted" : "not adopted",
    state_after: noop ? "not adopted" : (revert ? "not adopted" : "adopted"),
    note: noop ? `'${ns}' is not adopted — nothing to revert` : "applies to watchdogs started after this; running ones keep their identity until stop_worker + start_worker",
    entries: plan.entries.length, renamed: plan.renamed, underivable: plan.underivable,
    cursor_copies: plan.cursor_copies,
    cursor_rows_written: dry_run ? 0 : plan.cursor_copies.filter(c => c.changes).length,
    watchdog_bin: WATCHDOG_BIN || `${BUNDLED_WATCHDOG} (WATCHDOG_BIN unset)`,
  };
  if (dry_run || noop) return report;
  const now = Date.now();
  copyAndStore(ns, plan.cursor_copies, revert
    ? { adopted: 0, adopted_at: state.adopted_at ?? null, reverted_at: now, report: JSON.stringify(report) }
    : { adopted: 1, adopted_at: state.adopted ? state.adopted_at : now, reverted_at: state.reverted_at ?? null, report: JSON.stringify(report) });
  return { ...report, at: new Date(now).toISOString() };
}
