#!/usr/bin/env node
// Agent SDK launcher for one worker session — the WATCHDOG_LAUNCHER=sdk twin of
// `claude -p "go" --output-format stream-json --verbose --mcp-config <file> --strict-mcp-config`.
//
// It runs one session with query() from @anthropic-ai/claude-agent-sdk and writes every SDK message
// to stdout as one JSON line. Those are the objects the CLI emits in stream-json mode, so the
// watchdog's session_scan reads context size, session id and the result event unchanged.
//
//   node runner/run-worker.mjs <worker> [--repo-root <path>] [--inbox-channel <ch>] [--work-dir <dir>]
//                              [--model <id>] [--mcp-config <file>] [--config <workers.json>]
//                              [--prompt <text>] [--usage-dir <dir>] [--print-config]
//                              [--allowed-tools <json>] [--disallowed-tools <json>] [--guardrails <config.json>]
//                              [--rotation-flag <file>]
//
// <worker> is a worker path as the watchdog takes it (workers/research), or the "name" of an entry
// in the workers config (--config, else WORKERS_CONFIG), whose args, ns and model are then used.
// --mcp-config: the file the watchdog already wrote (same server, same URL, same bearer); without
// it the broker server is built here the way watchdog.sh builds it (BROKER_URL, BROKER_SECRET,
// WATCHDOG_* identity variables), plus the servers named by the entry's mcp_servers (else
// WATCHDOG_MCP_SERVERS), picked from user/local/project scope the way watchdog.sh picks them.
//
// Key: ANTHROPIC_API_KEY from ~/.brand-c/_fleet/anthropic.env (RUNNER_KEY_FILE overrides the
// path). The file must be a regular file with mode 600. The value goes into the session's env only;
// it is never printed. The session must report apiKeySource ANTHROPIC_API_KEY, else it is stopped:
// no fallback to a claude.ai login.
//
// Tools: --allowed-tools / --disallowed-tools take a JSON array of permission rules (the config entry's
// allowed_tools / disallowed_tools; an entry found with --config supplies them when the flags are absent)
// and become the SDK's allowedTools / disallowedTools. --guardrails <config.json>: the watchdog's guardrail
// config; hooks/guardrails.mjs then runs as an in-process PreToolUse hook (the CLI path runs the same
// rules as a command hook). A --guardrails file that cannot be read is a usage error: never run unguarded.
// --rotation-flag <file>: the watchdog's rotation flag; hooks/rotation.mjs then runs as an in-process
// PostToolUse hook that tells the session to hand off once the flag exists (the file need not exist yet).
//
// Usage ledger: one row per session to <dir>/<YYYY-MM-DD>.jsonl (runner/usage-ledger.mjs). <dir> is
// --usage-dir, else RUNNER_USAGE_DIR, else <repo root>/ops/usage if it exists; else no ledger.
// A failed ledger write is one stderr line; the exit code stays the session's.
//
// Exit: 0 session finished without error; 1 session error (result is_error, no result, SDK threw);
//       2 usage or environment error (bad args, unknown worker, key file missing / not 600 / empty,
//       session not on the API key). SIGTERM / SIGINT abort the session: 143 / 130.

import { readFileSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Attribution, buildRow, appendRow, resolveLedgerDir } from "./usage-ledger.mjs";
import { sdkHook } from "../hooks/guardrails.mjs";
import { sdkRotationHook } from "../hooks/rotation.mjs";

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const SDK_MODULE = "@anthropic-ai/claude-agent-sdk";
// Credentials that could let the session authenticate some other way than the fleet key.
const STRIPPED_AUTH_ENV = ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];
// Every ANTHROPIC_* variable is dropped from the session's env before the key is set: auth tokens,
// and host or model overrides (ANTHROPIC_BASE_URL, ANTHROPIC_API_URL, ANTHROPIC_MODEL,
// ANTHROPIC_CUSTOM_HEADERS, …) that could send the fleet key to another host or change what it buys.
const STRIPPED_ENV_PREFIX = /^ANTHROPIC_/;

export class UsageError extends Error {}

export function defaultKeyFile(env = process.env) {
  return env.RUNNER_KEY_FILE || join(env.HOME || homedir(), ".config", "claude-broker", "anthropic.env");
}

// Returns the key. Throws UsageError with a one-line reason that never contains the value.
export function loadKey(path, uid = process.getuid ? process.getuid() : null) {
  let st;
  try { st = statSync(path); } catch { throw new UsageError(`key file not found: ${path}`); }
  if (!st.isFile()) throw new UsageError(`key file is not a regular file: ${path}`);
  const mode = st.mode & 0o777;
  if (mode !== 0o600) throw new UsageError(`key file ${path} has mode ${mode.toString(8)}, expected 600 (chmod 600 ${path})`);
  if (uid !== null && st.uid !== uid) throw new UsageError(`key file ${path} is owned by uid ${st.uid}, not this user (uid ${uid})`);
  let text;
  try { text = readFileSync(path, "utf8"); } catch { throw new UsageError(`key file not readable: ${path}`); }
  const line = text.split(/\r?\n/).find(l => /^\s*(export\s+)?ANTHROPIC_API_KEY\s*=/.test(l));
  const key = line ? line.slice(line.indexOf("=") + 1).trim().replace(/^(["'])(.*)\1$/, "$2") : "";
  if (!key) throw new UsageError(`key file ${path} has no ANTHROPIC_API_KEY= line with a value`);
  return key;
}

// A JSON array of non-empty strings (Claude Code permission rules: "Read", "Bash(git *)", "mcp__x").
export function toolList(v, label = "tool list") {
  let a = v;
  if (typeof v === "string") { try { a = JSON.parse(v); } catch { throw new UsageError(`${label}: not valid JSON`); } }
  if (!Array.isArray(a) || a.some(x => typeof x !== "string" || !x.trim())) throw new UsageError(`${label}: expected a JSON array of tool names`);
  return a.map(x => x.trim());
}

export function parseArgs(argv) {
  const o = { worker: "", repoRoot: "", inboxChannel: "", workDir: "", model: "", mcpConfig: "", config: "", prompt: "go", usageDir: "", printConfig: false, passthrough: [], allowedTools: null, disallowedTools: null, guardrails: "", rotationFlag: "" };
  const val = (i, flag) => { if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) throw new UsageError(`${flag} needs a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--repo-root":     o.repoRoot = val(i, a); i++; break;
      case "--inbox-channel": o.inboxChannel = val(i, a); i++; break;
      case "--work-dir":      o.workDir = val(i, a); i++; break;
      case "--model":         o.model = val(i, a); i++; break;
      case "--mcp-config":    o.mcpConfig = val(i, a); i++; break;
      case "--config":        o.config = val(i, a); i++; break;
      case "--prompt":        o.prompt = val(i, a); i++; break;
      case "--usage-dir":     o.usageDir = val(i, a); i++; break;
      case "--print-config":  o.printConfig = true; break;
      case "--allowed-tools":    o.allowedTools = toolList(val(i, a), a); i++; break;
      case "--disallowed-tools": o.disallowedTools = toolList(val(i, a), a); i++; break;
      case "--guardrails":       o.guardrails = val(i, a); i++; break;
      case "--rotation-flag":    o.rotationFlag = val(i, a); i++; break;
      // Watchdog options that only steer the watchdog loop; accepted so a workers-config entry's
      // args can be handed over as they are.
      case "--patrol-interval": case "--patrol-watch-channel": case "--max-session-minutes": case "--launcher":
        val(i, a); i++; break;
      case "--once": case "--strict-mcp-config": break;
      default:
        if (a.startsWith("--")) throw new UsageError(`unknown option: ${a}`);
        if (o.worker) throw new UsageError(`unexpected argument: ${a}`);
        o.worker = a;
    }
  }
  if (!o.worker) throw new UsageError("usage: run-worker.mjs <worker> [--repo-root <path>] [--inbox-channel <ch>] [--work-dir <dir>] [--model <id>] [--mcp-config <file>] [--config <workers.json>] [--usage-dir <dir>]");
  return o;
}

// The identity rules of watchdog.sh ("Identity" block), so a runner started on its own talks to the
// broker as the watchdog's session would.
export function deriveIdentity({ worker, inboxChannel }, env = process.env) {
  let ns = env.WATCHDOG_NAMESPACE || "";
  let inbox = inboxChannel;
  if (!inbox) {
    if (!ns) throw new UsageError(`no --inbox-channel and no WATCHDOG_NAMESPACE (or config entry ns) for '${worker}'`);
    inbox = worker.startsWith("orchestrators/") ? `${ns}-${worker.slice("orchestrators/".length)}-orch` : `${ns}-${worker}`;
    inbox = inbox.replace(/\//g, "-");
  }
  if (!ns) ns = inbox.split("-")[0];
  if (!inbox.startsWith(`${ns}-`) || inbox.length <= ns.length + 1) throw new UsageError(`inbox '${inbox}' is not in namespace '${ns}'`);
  const as = env.WATCHDOG_AS || inbox.slice(ns.length + 1);
  let role = env.WATCHDOG_ROLE || "";
  if (!role) {
    if (worker.startsWith("orchestrators/") || /-orch$|-orchestrator$/.test(inbox)) role = "orchestrator";
    else if (`${worker}|${inbox}`.includes("reviewer")) role = "reviewer";
    else role = "worker";
  }
  if (!["worker", "reviewer", "orchestrator", "admin"].includes(role)) throw new UsageError(`role '${role}': expected worker, reviewer, orchestrator or admin`);
  for (const id of [ns, as]) if (!/^[A-Za-z0-9_.-]{1,64}$/.test(id)) throw new UsageError(`identity '${id}': letters, digits, _ . - only (max 64)`);
  const roleNs = `,${(env.WATCHDOG_ROLE_NAMESPACES || "").replace(/ /g, "")},`;
  const roleUrl = Boolean(env.WATCHDOG_ROLE) || env.WATCHDOG_ROLE_URL === "1" || roleNs.includes(`,${ns},`)
    || (env.WATCHDOG_NS_ADOPTED === "1" && env.WATCHDOG_ROLE_URL !== "0");
  const query = (roleUrl ? `role=${role}&` : "") + `ns=${ns}&as=${as}`;
  // Every name the worker posts as (watchdog.sh SELF_SENDERS): as=, the worker path basename, WATCHDOG_SELF_SENDERS.
  // The watchdog passes them as exclude_sender on its wake checks; this launcher runs one session and makes no wake decision.
  const selfSenders = [...new Set([as, worker.split("/").pop(), ...(env.WATCHDOG_SELF_SENDERS || "").split(",").map((n) => n.trim())])]
    .filter((n) => /^[A-Za-z0-9_.-]{1,64}$/.test(n));
  return { ns, inbox, as, role, query, selfSenders };
}

export function buildBrokerServer(query, env = process.env) {
  const url = `${env.BROKER_URL || "http://localhost:8080"}/mcp?${query}`;
  const server = { type: "http", url };
  if (env.BROKER_SECRET) server.headers = { Authorization: `Bearer ${env.BROKER_SECRET}` };
  return { broker: server };
}

// An MCP server name list ([] allowed: broker only).
function serverNames(v, label) {
  if (!Array.isArray(v) || v.some(x => typeof x !== "string" || !x.trim())) throw new UsageError(`${label}: expected a JSON array of MCP server names`);
  return v.map(x => x.trim());
}

// The broker plus exactly the named servers from user scope and local scope (<config dir>/.claude.json)
// and project scope (<workDir>/.mcp.json, wins) — watchdog.sh's WATCHDOG_MCP_SERVERS step. A name found in
// no scope is reported in missing, not fatal; "broker" is always ours.
export function selectMcpServers(names, { claudeJson, workDir, broker }) {
  const rd = (p) => { try { return JSON.parse(readFileSync(p, "utf8")) || {}; } catch { return {}; } };
  const user = rd(claudeJson);
  const all = { ...(user.mcpServers || {}), ...(((user.projects || {})[workDir] || {}).mcpServers || {}),
                ...(rd(join(workDir, ".mcp.json")).mcpServers || {}) };
  const servers = {}, missing = [];
  for (const n of names) if (n !== "broker") { if (all[n]) servers[n] = all[n]; else missing.push(n); }
  return { servers: { ...servers, ...broker }, missing };
}

function findConfigEntry(name, configPath) {
  if (!configPath) return null;
  let defs;
  try { defs = JSON.parse(readFileSync(configPath, "utf8")); } catch (e) { throw new UsageError(`workers config ${configPath}: ${e.code === "ENOENT" ? "not found" : "not valid JSON"}`); }
  if (!Array.isArray(defs)) throw new UsageError(`workers config ${configPath}: top-level value is not an array`);
  return defs.find(d => d && d.name === name) || null;
}

// Everything the session needs, resolved the way watchdog.sh + start_worker resolve it.
export function resolveSession(opts, env = process.env) {
  let o = { ...opts };
  const sessionEnv = { ...env };
  // <worker> names a config entry only with --config, or with WORKERS_CONFIG when no --work-dir or
  // --repo-root pins the directory (the watchdog always passes --work-dir, so its path is never
  // mistaken for an entry name).
  const configPath = o.config || (!o.workDir && !o.repoRoot ? env.WORKERS_CONFIG || "" : "");
  const entry = findConfigEntry(o.worker, configPath);
  if (o.config && !entry) throw new UsageError(`no entry named '${o.worker}' in ${o.config}`);
  if (entry) {
    // The entry's args are the watchdog's args; flags given here still win.
    o = parseArgs((entry.args || []).map(String));
    for (const k of ["repoRoot", "inboxChannel", "workDir", "model", "mcpConfig", "usageDir", "guardrails", "rotationFlag", "allowedTools", "disallowedTools"]) if (opts[k]) o[k] = opts[k];
    o.prompt = opts.prompt;
    if (!o.allowedTools && entry.allowed_tools) o.allowedTools = toolList(entry.allowed_tools, `${o.worker}: allowed_tools`);
    if (!o.disallowedTools && entry.disallowed_tools) o.disallowedTools = toolList(entry.disallowed_tools, `${o.worker}: disallowed_tools`);
    if (entry.ns) sessionEnv.WATCHDOG_NAMESPACE = entry.ns;
    if (!o.model && entry.model) o.model = entry.model;
    if (entry.mcp_servers !== undefined) o.mcpServerNames = serverNames(entry.mcp_servers, `${o.worker}: mcp_servers`);
  }
  const repoRoot = o.repoRoot || env.WATCHDOG_REPO_ROOT || process.cwd();
  const cwd = resolve(o.workDir || join(repoRoot, o.worker));
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new UsageError(`worker directory not found: ${cwd}`);
  const model = o.model || env.CLAUDE_MODEL || DEFAULT_MODEL;
  const identity = deriveIdentity(o, sessionEnv);

  let mcpServers, mcpMissing = [];
  if (o.mcpConfig) {
    let cfg;
    try { cfg = JSON.parse(readFileSync(o.mcpConfig, "utf8")); } catch { throw new UsageError(`MCP config not readable as JSON: ${o.mcpConfig}`); }
    if (!cfg || typeof cfg.mcpServers !== "object" || !cfg.mcpServers.broker) throw new UsageError(`MCP config ${o.mcpConfig} has no mcpServers.broker`);
    mcpServers = cfg.mcpServers;
  } else if ((env.WATCHDOG_MCP || "1") === "1") {
    mcpServers = buildBrokerServer(identity.query, env);
    let names = o.mcpServerNames;
    if (!names && env.WATCHDOG_MCP_SERVERS) {
      try { names = JSON.parse(env.WATCHDOG_MCP_SERVERS); } catch { names = null; }
      names = serverNames(names, "WATCHDOG_MCP_SERVERS");
    }
    if (names) ({ servers: mcpServers, missing: mcpMissing } = selectMcpServers(names,
      { claudeJson: join(env.CLAUDE_CONFIG_DIR || env.HOME || homedir(), ".claude.json"), workDir: cwd, broker: mcpServers }));
  }
  // The ledger's repo root: the watchdog passes --work-dir <root>/<worker> and runs us inside it, so
  // cwd is not the root; strip the worker path from the work dir instead.
  const tail = "/" + o.worker.replace(/^\/+|\/+$/g, "");
  const ledgerRoot = o.repoRoot || (cwd.endsWith(tail) ? cwd.slice(0, -tail.length) : "") || env.WATCHDOG_REPO_ROOT || "";
  const usage = resolveLedgerDir({ usageDir: o.usageDir, repoRoot: ledgerRoot }, env);
  let guardrails = null;
  if (o.guardrails) {
    try { guardrails = JSON.parse(readFileSync(o.guardrails, "utf8")); } catch { throw new UsageError(`guardrails config not readable as JSON: ${o.guardrails}`); }
    if (!guardrails || typeof guardrails !== "object" || Array.isArray(guardrails)) throw new UsageError(`guardrails config ${o.guardrails} is not an object`);
  }
  return { worker: o.worker, cwd, model, identity, mcpServers, mcpMissing, strictMcpConfig: Boolean(mcpServers), prompt: o.prompt, usage,
           allowedTools: o.allowedTools || [], disallowedTools: o.disallowedTools || [], guardrails, rotationFlag: o.rotationFlag || "" };
}

// The settings files the session loads (settingSources user, project, local) may carry an "env"
// block that the session applies after ours; an ANTHROPIC_* or CLAUDE_CODE_USE_* entry there would
// undo the stripping above. Returns "<file>: <VAR>" for each one; the runner refuses to start.
export function settingsEnvOverrides(cwd, home) {
  const out = [];
  for (const file of [join(home, ".claude", "settings.json"), join(cwd, ".claude", "settings.json"), join(cwd, ".claude", "settings.local.json")]) {
    let cfg;
    try { cfg = JSON.parse(readFileSync(file, "utf8")); } catch { continue; }
    const env = cfg && typeof cfg.env === "object" && cfg.env ? cfg.env : {};
    for (const k of Object.keys(env)) if (STRIPPED_ENV_PREFIX.test(k) || STRIPPED_AUTH_ENV.includes(k)) out.push(`${file}: ${k}`);
  }
  return out;
}

export function buildQueryOptions(session, key, env, abortController, stderr) {
  const childEnv = { ...env, ANTHROPIC_API_KEY: key, CLAUDE_AGENT_SDK_CLIENT_APP: "claude-broker-runner/1" };
  for (const k of Object.keys(childEnv)) if (STRIPPED_ENV_PREFIX.test(k) || STRIPPED_AUTH_ENV.includes(k)) delete childEnv[k];
  childEnv.ANTHROPIC_API_KEY = key;
  delete childEnv.RUNNER_KEY_FILE; delete childEnv.RUNNER_SDK_MODULE;
  const options = {
    cwd: session.cwd,
    model: session.model,
    // claude -p --dangerously-skip-permissions
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    // What `claude -p` loads by default: the Claude Code system prompt, user + project + local
    // settings, CLAUDE.md files and .claude/ from cwd.
    systemPrompt: { type: "preset", preset: "claude_code" },
    settingSources: ["user", "project", "local"],
    env: childEnv,
    abortController,
    stderr: (d) => stderr.write(d),
  };
  if (session.mcpServers) { options.mcpServers = session.mcpServers; options.strictMcpConfig = session.strictMcpConfig; }
  if (session.allowedTools?.length) options.allowedTools = session.allowedTools;
  if (session.disallowedTools?.length) options.disallowedTools = session.disallowedTools;
  // No matcher: every tool call, MCP tools included (the CLI settings use matcher "*").
  if (session.guardrails) options.hooks = { PreToolUse: [{ hooks: [sdkHook(session.guardrails)], timeout: 30 }] };
  if (session.rotationFlag) options.hooks = { ...options.hooks, PostToolUse: [{ hooks: [sdkRotationHook(session.rotationFlag)], timeout: 10 }] };
  return options;
}

function redact(session) {
  const servers = session.mcpServers && Object.fromEntries(Object.entries(session.mcpServers).map(([n, s]) =>
    [n, s && s.headers ? { ...s, headers: Object.fromEntries(Object.keys(s.headers).map(h => [h, "<redacted>"])) } : s]));
  return { ...session, mcpServers: servers };
}

// Runs one session. Returns the exit code; never calls process.exit (tests drive it directly).
export async function main(argv, { env = process.env, query, stdout = process.stdout, stderr = process.stderr, signals = process } = {}) {
  const say = (m) => stderr.write(`[runner] ${m}\n`);
  let session, key;
  try {
    const opts = parseArgs(argv);
    session = resolveSession(opts, env);
    if (session.mcpMissing.length) say(`WARN: mcp_servers name(s) found in no MCP scope: ${session.mcpMissing.join(",")} — session starts without them`);
    if (opts.printConfig) { stdout.write(JSON.stringify(redact(session)) + "\n"); return 0; }
    key = loadKey(defaultKeyFile(env));
    const overrides = settingsEnvOverrides(session.cwd, env.HOME || homedir());
    if (overrides.length) throw new UsageError(`settings env would override the session's API endpoint or auth: ${overrides.join(", ")}`);
  } catch (e) {
    if (e instanceof UsageError) { say(`ERROR: ${e.message}`); return 2; }
    throw e;
  }

  if (!query) {
    try { ({ query } = await import(env.RUNNER_SDK_MODULE ? pathToFileURL(resolve(env.RUNNER_SDK_MODULE)).href : SDK_MODULE)); }
    catch (e) { say(`ERROR: cannot load ${env.RUNNER_SDK_MODULE || SDK_MODULE}: ${e.message}`); return 2; }
  }

  const abortController = new AbortController();
  let stopCode = 0, authFail = "", thrown = false;
  const onSignal = (sig) => { stopCode = sig === "SIGINT" ? 130 : 143; say(`${sig}: aborting session`); abortController.abort(); };
  const handlers = { SIGTERM: () => onSignal("SIGTERM"), SIGINT: () => onSignal("SIGINT") };
  for (const [s, h] of Object.entries(handlers)) signals.on(s, h);

  let result = null, sessionId = null;
  const attribution = new Attribution();
  try {
    const q = query({ prompt: session.prompt, options: buildQueryOptions(session, key, env, abortController, stderr) });
    for await (const msg of q) {
      stdout.write(JSON.stringify(msg) + "\n");
      if (msg && msg.type === "system" && msg.subtype === "init" && msg.session_id) sessionId = msg.session_id;
      try { attribution.observe(msg); } catch { /* attribution is best effort */ }
      if (msg && msg.type === "system" && msg.subtype === "init" && msg.apiKeySource !== "ANTHROPIC_API_KEY") {
        authFail = `session authenticated via '${msg.apiKeySource}', not ANTHROPIC_API_KEY: stopped`;
        abortController.abort();
        break;
      }
      if (msg && msg.type === "result") result = msg;
    }
  } catch (e) {
    if (!authFail && !stopCode) { say(`ERROR: session failed: ${e && e.message ? e.message : e}`); thrown = true; }
  } finally {
    for (const [s, h] of Object.entries(handlers)) signals.off(s, h);
  }
  let code;
  if (thrown) code = 1;
  else if (authFail) { say(`ERROR: ${authFail}`); code = 2; }
  else if (stopCode) code = stopCode;
  else if (!result) { say("ERROR: session ended without a result event"); code = 1; }
  else code = result.is_error ? 1 : 0;
  writeLedger(session, { result, sessionId, attribution, exitCode: code }, say);
  return code;
}

// One row per session that reached the API (an init event or a result was seen). Never throws.
function writeLedger(session, { result, sessionId, attribution, exitCode }, say) {
  if (!session.usage || (!result && !sessionId)) return;
  try {
    const row = buildRow({ session, identity: session.identity, result, sessionId, attribution, exitCode });
    appendRow(session.usage, row);
  } catch (e) {
    say(`WARN: usage ledger write failed (${session.usage.dir}): ${e && e.code ? e.code : e && e.message ? e.message : e}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let settled = false;
  // An SDK iterator that stalls with nothing left on the event loop would let node exit 0 silently.
  process.on("exit", () => {
    if (!settled) { process.stderr.write("[runner] ERROR: session stalled: the event loop drained before the session ended\n"); process.exitCode = 1; }
  });
  main(process.argv.slice(2)).then(
    (code) => { settled = true; process.exitCode = code; },
    (e) => { settled = true; process.stderr.write(`[runner] ERROR: ${e && e.stack ? e.stack : e}\n`); process.exitCode = 1; },
  );
}

export const RUNNER_DIR = dirname(fileURLToPath(import.meta.url));
