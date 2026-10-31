// Worker definitions (WORKERS_CONFIG) and watchdog lifecycle: spawn (subprocess or tmux), adopt, stop.
import { spawn, spawnSync } from "child_process";
import { readFileSync, writeFileSync, renameSync, mkdirSync, openSync, closeSync, accessSync, readdirSync, statSync, unlinkSync, constants as fsConstants } from "fs";
import { basename } from "path";
import { PORT, SHARED_SECRET, WATCHDOG_BIN, WORKERS_CONFIG, WORKERS_LOG_DIR, WORKERS_TMUX_SESSION, TMUX_BIN,
         MODEL_ID_RE, SCOPES, MODEL_BY_SCOPE, REVIEWER_MODEL } from "./config.js";
import { stmtAdoptGet } from "./db.js";
import { verifierTrust } from "./auth.js";

// Worker names become filesystem paths (log files) and tmux window names, so they must
// not contain path separators, "..", or shell/control characters. Reject anything unsafe.
const WORKER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export function assertSafeWorkerName(name) {
  if (typeof name !== "string" || !WORKER_NAME_RE.test(name) || name.includes("..")) {
    throw new Error(`invalid worker name "${name}" — allowed: letters, digits, dot, dash, underscore (max 64, no "..")`);
  }
  return name;
}

// Worker definitions loaded from WORKERS_CONFIG JSON file.
// Format: [{ "name": "backend", "ns": "dv", "args": ["backend"] }, ...]
// ns is optional — if set, worker appears only on that namespace tab.
// args are passed directly to WATCHDOG_BIN.
export function loadWorkerDefs() {
  if (!WORKERS_CONFIG) return [];
  try {
    const defs = JSON.parse(readFileSync(WORKERS_CONFIG, "utf8"));
    if (!Array.isArray(defs)) throw new Error("top-level value is not an array");
    return defs.filter(d => d && typeof d.name === "string" && d.name);
  } catch (e) {
    console.warn(`[claude-broker] WORKERS_CONFIG load failed: ${e.message}`);
    return [];
  }
}

// Write WORKERS_CONFIG atomically (temp file + rename) so a crash mid-write
// can never leave a truncated file that loadWorkerDefs would read as "no workers".
export function saveWorkerDefs(defs) {
  const tmp = `${WORKERS_CONFIG}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(defs, null, 2) + "\n", "utf8");
  renameSync(tmp, WORKERS_CONFIG);
}

// ── Model routing (precedence in config.js) ──────────────────────────────────
// The watchdog resolves the model per session (it alone knows the next task's scope); the broker
// tells it what only the config knows: whether the model is pinned, the entry's own scope map, and
// whether the entry is a reviewer (role "reviewer" or a name ending in -reviewer).
export const isReviewerDef = (def) => def.role === "reviewer" || /-reviewer$/.test(def.name || "");
// Entry "model_by_scope": { small, medium, large } -> "small=…,large=…" (invalid ids dropped).
export function entryModelByScope(def) {
  const m = def.model_by_scope;
  if (!m || typeof m !== "object") return "";
  return SCOPES.filter(k => typeof m[k] === "string" && MODEL_ID_RE.test(m[k])).map(k => `${k}=${m[k]}`).join(",");
}
// The model an entry runs a typical (medium) task on — what the same-model warning compares.
export function typicalModel(def, model) {
  const pinned = model || def.model;
  if (pinned) return { model: pinned, reason: "pinned" };
  if (isReviewerDef(def)) return { model: REVIEWER_MODEL, reason: "reviewer" };
  const own = def.model_by_scope?.medium;
  return { model: typeof own === "string" && MODEL_ID_RE.test(own) ? own : MODEL_BY_SCOPE.medium, reason: "scope:medium" };
}
// One warning per namespace whose reviewer runs on the same model as one of its writers
// (orchestrators excluded): the review is then the writer's own blind spots, re-run.
export function sameModelWarnings(defs = loadWorkerDefs()) {
  const byNs = new Map();
  for (const d of defs) {
    if (!d.ns) continue;
    if (!byNs.has(d.ns)) byNs.set(d.ns, []);
    byNs.get(d.ns).push(d);
  }
  const isOrch = (d) => /(^|-)orch(estrator)?$/.test(d.name) || (d.args || []).some(a => /^orchestrators\//.test(String(a)));
  const out = [];
  for (const [ns, list] of byNs) {
    for (const r of list.filter(isReviewerDef)) {
      const rm = typicalModel(r).model;
      const same = list.filter(w => !isReviewerDef(w) && !isOrch(w) && typicalModel(w).model === rm).map(w => w.name);
      if (same.length) out.push({ ns, reviewer: r.name, model: rm, writers: same,
        message: `namespace ${ns}: reviewer ${r.name} and writer(s) ${same.join(", ")} resolve to the same model ${rm}` });
    }
  }
  return out;
}
// Env every spawn path sets — always all four, so no inherited value leaks in.
function modelRoutingEnv(def, model) {
  const warn = sameModelWarnings().filter(w => w.reviewer === def.name || w.writers.includes(def.name));
  return {
    WATCHDOG_MODEL_PINNED: model ? "1" : "0",
    WATCHDOG_ENTRY_MODEL_BY_SCOPE: entryModelByScope(def),
    WATCHDOG_REVIEWER: isReviewerDef(def) ? "1" : "0",
    WATCHDOG_MODEL_WARNING: warn.map(w => w.message).join("; "),
  };
}

// ── Tool lists and guardrails ────────────────────────────────────────────────
// Entry "allowed_tools" / "disallowed_tools" (permission rules: "Read", "Bash(git *)", "mcp__tally") and
// "guardrails": { "extra_deny": [...] } reach the watchdog as JSON arrays; it passes them to both launch
// paths (docs/protocol-v3.md "Guardrails"). Whether the guardrail hook runs at all is the namespace
// opt-in (WATCHDOG_GUARDRAIL_NAMESPACES / WATCHDOG_GUARDRAILS), read from the broker env.
const isRuleList = (v) => Array.isArray(v) && v.length > 0 && v.every(x => typeof x === "string" && x.trim() && !/[\r\n]/.test(x));
const isDenyList = (v) => Array.isArray(v) && v.length > 0 && v.every(x => typeof x === "string" || (x && typeof x === "object" && typeof x.pattern === "string"));
// Entry "mcp_servers": ["name", ...] reaches the watchdog as WATCHDOG_MCP_SERVERS: the session gets the broker
// plus exactly those servers from user/local/project scope, overriding WATCHDOG_MCP_INHERIT; [] = broker only.
// "" (absent) keeps the inherit behaviour; always set so a broker-env value never applies to every entry.
const isServerList = (v) => Array.isArray(v) && v.every(x => typeof x === "string" && /^[A-Za-z0-9._-]+$/.test(x));
export function entryToolsEnv(def) {
  const out = { WATCHDOG_ALLOWED_TOOLS: "", WATCHDOG_DISALLOWED_TOOLS: "", WATCHDOG_GUARDRAILS_EXTRA_DENY: "", WATCHDOG_MCP_SERVERS: "" };
  if (def.mcp_servers !== undefined) {
    if (isServerList(def.mcp_servers)) out.WATCHDOG_MCP_SERVERS = JSON.stringify(def.mcp_servers);
    else console.warn(`[claude-broker] worker "${def.name}": mcp_servers must be an array of server names ([] = broker only) — ignored`);
  }
  for (const [field, key] of [["allowed_tools", "WATCHDOG_ALLOWED_TOOLS"], ["disallowed_tools", "WATCHDOG_DISALLOWED_TOOLS"]]) {
    if (def[field] === undefined) continue;
    if (isRuleList(def[field])) out[key] = JSON.stringify(def[field]);
    else console.warn(`[claude-broker] worker "${def.name}": ${field} must be a non-empty array of tool names — ignored`);
  }
  const extra = def.guardrails?.extra_deny;
  if (extra !== undefined) {
    if (isDenyList(extra)) out.WATCHDOG_GUARDRAILS_EXTRA_DENY = JSON.stringify(extra);
    else console.warn(`[claude-broker] worker "${def.name}": guardrails.extra_deny must be an array of regex strings or { pattern, tool?, reason? } — ignored`);
  }
  return out;
}
// Broker-only credentials a spawned watchdog (and the sessions it launches) must never hold: ADMIN_SECRET
// unlocks exempt-channel purges, ORCHESTRATOR_TOKEN* the reserved orchestrator senders, VERIFIER_TOKEN* the
// verification stamp (POST /verifications). BROKER_SECRET stays.
const isBrokerOnlySecret = (k) => k === "ADMIN_SECRET" || /^(ORCHESTRATOR|VERIFIER)_TOKEN(_|$)/.test(k);
// Not a secret: the namespaces whose results the standalone verifier stamps, so their watchdogs do not verify.
// The broker's effective list (empty unless VERIFIER_TOKEN_SHA256 is set too), never the raw variable: a list
// without a hash would switch watchdog verification off while nothing else verifies.
const verifierNamespaces = () => (verifierTrust().enabled ? verifierTrust().namespaces.join(",") : "");
export function spawnEnv(base = process.env) {
  return Object.fromEntries(Object.entries(base).filter(([k]) => !isBrokerOnlySecret(k)));
}

// Everything per entry a spawn sets — always every key, so no value from the broker env leaks in.
const entryEnv = (def, model) => ({ ...modelRoutingEnv(def, model), ...entryToolsEnv(def) });

if (WORKERS_CONFIG) {
  console.log(`[claude-broker] WORKERS_CONFIG=${WORKERS_CONFIG} (hot-reload enabled)`);
  for (const w of sameModelWarnings()) console.warn(`[claude-broker] WARN model routing: ${w.message}`);
}

// name → { pid, proc, startedAt }
// Spawned watchdog processes are detached (own process group) so killing -pid kills the full tree.
const watchdogProcs = new Map();

const pidFilePath = (name) => `${WORKERS_LOG_DIR}/${name}.pid`;
function isAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } }
// Detached watchdogs outlive a broker restart. Each subprocess spawn records its pid in
// WORKERS_LOG_DIR; at startup every pidfile whose process is still alive *and* still runs the
// watchdog binary is re-adopted, so list_workers/stop_worker keep working and start_worker
// cannot launch a duplicate next to the survivor. Stale pidfiles are removed.
export function adoptOrphanWatchdogs() {
  if (!WATCHDOG_BIN || WORKERS_TMUX_SESSION) return;
  let files = [];
  try { files = readdirSync(WORKERS_LOG_DIR).filter(f => f.endsWith(".pid")); } catch { return; }
  for (const f of files) {
    const name = f.slice(0, -4);
    const p = `${WORKERS_LOG_DIR}/${f}`;
    let pid = NaN; try { pid = parseInt(readFileSync(p, "utf8"), 10); } catch {}
    const cmd = Number.isInteger(pid) && pid > 1 && isAlive(pid)
      ? (spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout || "")
      : "";
    if (cmd.includes(basename(WATCHDOG_BIN))) {
      let startedAt = Date.now(); try { startedAt = statSync(p).mtimeMs; } catch {}
      watchdogProcs.set(name, { pid, startedAt, adopted: true });
      console.log(`[claude-broker] adopted running watchdog "${name}" (pid ${pid}) from ${p}`);
    } else {
      try { unlinkSync(p); } catch {}
    }
  }
}

// Expand ${VAR_NAME} placeholders in watchdog args using process.env, so the workers
// config can use ${REPO_ROOT}/backend instead of hardcoded absolute paths.
export function expandArgs(args) {
  return args.map(a => String(a).replace(/\$\{([^}]+)\}/g, (_, k) => process.env[k] ?? `\${${k}}`));
}

// "1" when adopt_namespace has adopted ns, else "0" (also for an entry with no ns) — read at every
// spawn, so adopt/revert needs no restart, and always set so no inherited value reaches the watchdog.
const nsAdopted = (ns) => (ns && stmtAdoptGet.get(ns)?.adopted ? "1" : "0");

// Shared watchdog spawn logic. Throws on failure; callers handle errors.
// model: optional model ID to pin for this watchdog's sessions.
// Precedence: explicit model arg > "model" field on the worker's config entry (both pinned) >
// the watchdog's per-session routing (see Model routing above).
function spawnWatchdogProc(def, { model } = {}) {
  model = model || def.model;
  assertSafeWorkerName(def.name);
  // spawn() reports a missing or non-executable binary asynchronously as an 'error' event;
  // check up front so the caller gets a clear tool error instead of a crash.
  try { accessSync(WATCHDOG_BIN, fsConstants.X_OK); }
  catch { throw new Error(`WATCHDOG_BIN is not an executable file: ${WATCHDOG_BIN}`); }
  mkdirSync(WORKERS_LOG_DIR, { recursive: true });
  const outFd = openSync(`${WORKERS_LOG_DIR}/${def.name}.out.log`, "a");
  const errFd = openSync(`${WORKERS_LOG_DIR}/${def.name}.err.log`, "a");
  // Give the watchdog the credentials it needs to reach an authenticated broker
  // (/inbox polling + heartbeat writes). Existing env values win if already set — except
  // WATCHDOG_NAMESPACE, which is always the config entry's ns (the watchdog derives the session's
  // MCP identity from it). WATCHDOG_ROLE_URL / WATCHDOG_ROLE_NAMESPACES (role= opt-in) ride along
  // in process.env. WATCHDOG_NS_ADOPTED is always set — the namespace's adoption state at this
  // moment (adopt_namespace), "0" with no ns — never an inherited value.
  const env = {
    ...spawnEnv(),
    BROKER_URL: process.env.BROKER_URL || `http://localhost:${PORT}`,
    BROKER_SECRET: process.env.BROKER_SECRET || SHARED_SECRET,
    ...(model ? { CLAUDE_MODEL: model } : {}),
    ...entryEnv(def, model),
    ...(def.ns ? { WATCHDOG_NAMESPACE: def.ns } : {}),
    WATCHDOG_NS_ADOPTED: nsAdopted(def.ns),
    VERIFIER_TRUST_NAMESPACES: verifierNamespaces(),
  };
  let proc;
  try {
    proc = spawn(WATCHDOG_BIN, expandArgs(def.args || []), { stdio: ["ignore", outFd, errFd], detached: true, env });
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
  proc.unref();
  // Belt and braces: an unhandled 'error' event on a ChildProcess is an uncaught exception.
  proc.on("error", (e) => {
    console.error(`[claude-broker] watchdog "${def.name}" spawn error: ${e.message}`);
    watchdogProcs.delete(def.name);
  });
  proc.on("exit", (code) => {
    console.log(`[claude-broker] watchdog "${def.name}" exited (code ${code ?? "?"})`);
    watchdogProcs.delete(def.name);
    try { unlinkSync(pidFilePath(def.name)); } catch {}
  });
  watchdogProcs.set(def.name, { pid: proc.pid, proc, startedAt: Date.now() });
  try { writeFileSync(pidFilePath(def.name), `${proc.pid}\n`, "utf8"); } catch (e) { console.warn(`[claude-broker] could not write pidfile for "${def.name}": ${e.message}`); }
  console.log(`[claude-broker] started watchdog "${def.name}" (pid ${proc.pid}) → logs: ${WORKERS_LOG_DIR}/${def.name}.{out,err}.log`);
  return proc;
}

// ── tmux helpers (used only when WORKERS_TMUX_SESSION is set) ────────────────

let _tmuxEnvFlag = null;
function tmuxSupportsEnvFlag() {
  if (_tmuxEnvFlag !== null) return _tmuxEnvFlag;
  const out = (spawnSync(TMUX_BIN, ["-V"], { encoding: "utf8" }).stdout || "").trim(); // "tmux 3.6b"
  const m = out.match(/(\d+)\.(\d+)/);
  _tmuxEnvFlag = !!m && (Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 2));
  return _tmuxEnvFlag;
}

function tmuxWindowExists(winName) {
  try {
    const r = spawnSync(TMUX_BIN, ["list-windows", "-t", WORKERS_TMUX_SESSION, "-F", "#{window_name}"], { encoding: "utf8" });
    return (r.stdout || "").split("\n").some(l => l.trim() === winName);
  } catch { return false; }
}

function tmuxPanePid(winName) {
  try {
    const r = spawnSync(TMUX_BIN, ["display-message", "-t", `${WORKERS_TMUX_SESSION}:${winName}`, "-p", "#{pane_pid}"], { encoding: "utf8" });
    const pid = parseInt((r.stdout || "").trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch { return null; }
}

function spawnWatchdogTmux(def, { model } = {}) {
  model = model || def.model;
  assertSafeWorkerName(def.name);
  // Ensure target session exists
  const hasSession = spawnSync(TMUX_BIN, ["has-session", "-t", WORKERS_TMUX_SESSION], { encoding: "utf8" });
  if (hasSession.status !== 0) {
    spawnSync(TMUX_BIN, ["new-session", "-d", "-s", WORKERS_TMUX_SESSION], { encoding: "utf8" });
  }
  const routing = entryEnv(def, model);
  const explicit = [
    ["BROKER_SECRET", SHARED_SECRET],
    ["BROKER_URL",    process.env.BROKER_URL || `http://localhost:${PORT}`],
    ["CLAUDE_BIN",    process.env.CLAUDE_BIN],
    ["CLAUDE_MODEL",  model || process.env.CLAUDE_MODEL],
    ["WATCHDOG_NAMESPACE", def.ns],
    ["WATCHDOG_NS_ADOPTED", nsAdopted(def.ns)],
    ["VERIFIER_TRUST_NAMESPACES", verifierNamespaces()],
    ...Object.entries(routing),
  ].filter(([, v]) => v);
  // Routing and tool keys are per entry: an empty one must not be refilled from the broker env below.
  const routingKeys = new Set(Object.keys(routing));
  // A tmux window does not inherit the broker's env (it gets the tmux server's), so every
  // WATCHDOG_* knob (WATCHDOG_REPO_ROOT, WATCHDOG_MCP_INHERIT, WATCHDOG_ROLE_URL, …) is passed
  // explicitly — parity with the subprocess path's ...process.env. Explicit entries win, so
  // WATCHDOG_NAMESPACE is always the config entry's ns and WATCHDOG_NS_ADOPTED its adoption state.
  const explicitKeys = new Set(explicit.map(([k]) => k));
  const envParts = [
    ...explicit,
    ...Object.entries(process.env)
      .filter(([k, v]) => /^WATCHDOG_/.test(k) && v && !explicitKeys.has(k) && !routingKeys.has(k) && !isBrokerOnlySecret(k))
      .sort(([a], [b]) => a.localeCompare(b)),
  ];
  const shellQ = v => "'" + String(v).replace(/'/g, "'\\''") + "'";
  const args = expandArgs(def.args || []);
  // Single-quote every arg (and the binary path) so shell metacharacters in worker
  // config / register_worker input can never break out of the tmux new-window command.
  const shellCmd = `${shellQ(WATCHDOG_BIN)} ${args.map(shellQ).join(" ")}`;
  // Credentials go through tmux's per-window environment (-e, tmux >= 3.2) rather than a
  // KEY=VALUE prefix on the shell command, which would leave the secret in the pane's start
  // command (`tmux list-windows -F '#{pane_start_command}'`). Older tmux falls back to the
  // prefix with a warning.
  let tmuxArgs;
  if (tmuxSupportsEnvFlag()) {
    tmuxArgs = ["new-window", "-t", WORKERS_TMUX_SESSION, "-n", def.name, ...envParts.flatMap(([k, v]) => ["-e", `${k}=${v}`]), shellCmd];
  } else {
    console.warn(`[claude-broker] tmux < 3.2: passing worker credentials on the command line (visible in the pane start command). Upgrade tmux to avoid this.`);
    const envPrefix = envParts.map(([k, v]) => `${k}=${shellQ(v)}`).join(" ") + (envParts.length ? " " : "");
    tmuxArgs = ["new-window", "-t", WORKERS_TMUX_SESSION, "-n", def.name, `${envPrefix}${shellCmd}`];
  }
  const r = spawnSync(TMUX_BIN, tmuxArgs, { encoding: "utf8" });
  if (r.status !== 0) throw new Error((r.stderr || "").trim() || "tmux new-window failed");
  const pid = tmuxPanePid(def.name);
  watchdogProcs.set(def.name, { pid, startedAt: Date.now(), tmux: true });
  console.log(`[claude-broker] started watchdog "${def.name}" in tmux ${WORKERS_TMUX_SESSION}:${def.name} (pid ${pid})`);
  return { pid };
}

// ── Worker lifecycle (shared by MCP tools and REST routes) ───────────────────
// Both surfaces must agree on tmux vs subprocess mode — the dashboard buttons call
// the REST routes, so a REST-only subprocess spawn in tmux mode would duplicate a
// worker already running in a tmux window and never be stoppable.

class WorkerError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Returns { pid, startedAt, tmux } if running, else null. Reconciles the in-memory map in tmux mode.
export function workerRunningInfo(name) {
  if (WORKERS_TMUX_SESSION) {
    if (!tmuxWindowExists(name)) { watchdogProcs.delete(name); return null; }
    const entry = watchdogProcs.get(name);
    return { pid: tmuxPanePid(name), startedAt: entry?.startedAt ?? null, tmux: true };
  }
  const entry = watchdogProcs.get(name);
  if (!entry) return null;
  // Adopted entries have no ChildProcess handle, so there is no 'exit' event — poll instead.
  if (entry.adopted && !isAlive(entry.pid)) {
    watchdogProcs.delete(name);
    try { unlinkSync(pidFilePath(name)); } catch {}
    return null;
  }
  return { pid: entry.pid, startedAt: entry.startedAt, tmux: false };
}

// Returns { pid, tmux, already } — already=true means it was running and nothing was spawned.
export function startWorker(name, { model } = {}) {
  if (!WATCHDOG_BIN) throw new WorkerError(503, "WATCHDOG_BIN not configured on broker — cannot start workers.");
  const def = loadWorkerDefs().find(w => w.name === name);
  if (!def) throw new WorkerError(404, `Worker "${name}" not found in config. Use list_workers to see available workers.`);
  const running = workerRunningInfo(name);
  if (running) return { pid: running.pid, tmux: running.tmux, already: true };
  try {
    if (WORKERS_TMUX_SESSION) {
      const { pid } = spawnWatchdogTmux(def, { model });
      return { pid, tmux: true, already: false };
    }
    const proc = spawnWatchdogProc(def, { model });
    return { pid: proc.pid, tmux: false, already: false };
  } catch (e) {
    throw new WorkerError(500, `Failed to start "${name}": ${e.message}`);
  }
}

// Returns { pid, tmux }. Throws WorkerError(404) if not running, (500) if the kill failed.
export function stopWorker(name) {
  if (WORKERS_TMUX_SESSION) {
    if (!tmuxWindowExists(name)) {
      watchdogProcs.delete(name);
      throw new WorkerError(404, `Worker "${name}" is not running (no tmux window found in ${WORKERS_TMUX_SESSION}).`);
    }
    const pid = tmuxPanePid(name);
    const r = spawnSync(TMUX_BIN, ["kill-window", "-t", `${WORKERS_TMUX_SESSION}:${name}`], { encoding: "utf8" });
    watchdogProcs.delete(name);
    if (r.status !== 0) throw new WorkerError(500, `tmux kill-window failed: ${(r.stderr || "").trim() || "unknown error"}`);
    console.log(`[claude-broker] stopped watchdog "${name}" via tmux kill-window`);
    return { pid, tmux: true };
  }
  const entry = watchdogProcs.get(name);
  if (!entry) throw new WorkerError(404, `Worker "${name}" is not running.`);
  watchdogProcs.delete(name);
  try {
    process.kill(-entry.pid, "SIGTERM"); // kill entire process group (watchdog + in-flight claude)
  } catch (e) {
    throw new WorkerError(500, `kill failed: ${e.message}`);
  }
  try { unlinkSync(pidFilePath(name)); } catch {}
  console.log(`[claude-broker] stopped watchdog "${name}" (pid ${entry.pid})`);
  return { pid: entry.pid, tmux: false };
}
