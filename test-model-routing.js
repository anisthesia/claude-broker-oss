// Model routing — which model each watchdog session launches with, and why (docs/protocol-v3.md
// "Model routing"). Self-contained: a throwaway broker (free port, temp DB, temp WORKERS_CONFIG and a
// stub WATCHDOG_BIN), never the live broker on 8080.
//
//   1. --print-channels: model_route for pinned / reviewer / scope maps, model_warning
//   2. start_worker spawn env: WATCHDOG_MODEL_PINNED, WATCHDOG_REVIEWER, WATCHDOG_ENTRY_MODEL_BY_SCOPE,
//      WATCHDOG_MODEL_WARNING always set per entry (no inherited value leaks); broker startup warning
//   3. real --once sessions: the next open task's scope picks the model (entry map > env map > built-in),
//      no task -> no-task model, unscoped task -> default, pinned and reviewer win; heartbeats carry
//      model + context.model_reason
//   4. a worker whose only task is blocked (open question) or in plan-review routes by that task's scope
import { spawn, spawnSync } from "child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync, mkdirSync } from "fs";
import { startScratchBroker } from "./test-lib-broker.js";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SECRET = `mr-${process.pid}-${Date.now().toString(36)}`;
const TAG = Date.now().toString(36);
const NS = `mr${TAG}`;
const INBOX = `${NS}-core`, STATUS = `${NS}-status`, TELEMETRY = `${NS}-telemetry`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
function expect(cond, label, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); return true; }
  failed++; console.error(`  ✗ ${label}`); if (detail !== undefined) console.error(`     detail: ${String(detail).slice(0, 1200)}`);
  process.exitCode = 1; return false;
}
// Nothing from the session running this suite may leak into the broker or watchdog under test.
function cleanEnv(extra = {}) {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (/^(WATCHDOG|BROKER|FOLLOWUP)_/.test(k) || ["PORT", "DB_PATH", "TEST_PORT", "CLAUDE_MODEL", "WORKERS_CONFIG"].includes(k)) delete e[k];
  return { ...e, ...extra };
}

const dir = mkdtempSync(join(tmpdir(), "model-routing-"));
const work = join(dir, "work"), dumps = join(dir, "dumps");
mkdirSync(work); mkdirSync(dumps);
writeFileSync(join(work, "CLAUDE.md"), "# fake role\n");

// Stub WATCHDOG_BIN: records the routing env start_worker handed it, then exits.
const stubBin = join(dir, "stub-watchdog");
writeFileSync(stubBin, `#!/usr/bin/env bash
env | grep -E '^(CLAUDE_MODEL|WATCHDOG_MODEL_PINNED|WATCHDOG_REVIEWER|WATCHDOG_ENTRY_MODEL_BY_SCOPE|WATCHDOG_MODEL_WARNING)=' > "$MR_DUMPS/$1.env.tmp"
mv "$MR_DUMPS/$1.env.tmp" "$MR_DUMPS/$1.env"
`);
chmodSync(stubBin, 0o755);

const config = [
  { name: "w-pinned", ns: "mrx", args: ["w-pinned"], model: "claude-opus-5" },
  { name: "w-free", ns: "mrx", args: ["w-free"], model_by_scope: { large: "claude-entry-large", small: "bad id!" } },
  { name: "w-same", ns: "mrx", args: ["w-same"], model: "claude-opus-5-5" },
  { name: "mrx-reviewer", ns: "mrx", args: ["mrx-reviewer"] },
  { name: "mrx-orch", ns: "mrx", args: ["orchestrators/x"], model: "claude-opus-5-5" },
  { name: "rv", ns: "mry", role: "reviewer", args: ["rv"], model: "claude-sonnet-5-5" },
  { name: "w-y", ns: "mry", args: ["w-y"], model: "claude-haiku-4-5-20251001" },
];
const configPath = join(dir, "workers.json");
writeFileSync(configPath, JSON.stringify(config, null, 2));

let broker, BASE, brokerLog = "";
async function startBroker() {
  const h = await startScratchBroker({ root: ROOT, onData: d => { brokerLog += d; },
    env: (port) => cleanEnv({ PORT: String(port), DB_PATH: join(dir, "broker.db"), SHARED_SECRET: SECRET, ADMIN_SECRET: `${SECRET}-a`,
      WATCHDOG_BIN: stubBin, WORKERS_CONFIG: configPath, WORKERS_LOG_DIR: join(dir, "logs"), WORKERS_TMUX_SESSION: "", PRUNE_EXEMPT: "",
      MR_DUMPS: dumps, WATCHDOG_ENTRY_MODEL_BY_SCOPE: "small=leaked", WATCHDOG_REVIEWER: "1" }) });
  broker = h.proc;
  BASE = h.base;
}

const H = { "content-type": "application/json", authorization: `Bearer ${SECRET}` };
async function rest(method, path, body) {
  const r = await fetch(`${BASE}${path}`, { method, headers: H, ...(body && { body: JSON.stringify(body) }) });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}
const send = async (channel, sender, obj) => (await rest("POST", "/messages", { channel, sender, content: obj })).body?.id;
async function mcp(name, args) {
  const r = await fetch(`${BASE}/mcp`, { method: "POST", headers: { ...H, accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  const t = await r.text();
  const line = t.split("\n").find(l => l.startsWith("data:"));
  return JSON.parse(line ? line.slice(5) : t).result.content[0].text;
}

const wd = (args, env) => spawnSync("bash", [join(ROOT, "watchdog.sh"), ...args], { env: cleanEnv(env), encoding: "utf8", timeout: 90_000 });
const kv = (out, k) => (out.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1];

async function readDump(name) {
  const p = join(dumps, `${name}.env`);
  for (let i = 0; i < 50 && !existsSync(p); i++) await sleep(100);
  const env = {};
  if (existsSync(p)) for (const l of readFileSync(p, "utf8").split("\n")) { const i = l.indexOf("="); if (i > 0) env[l.slice(0, i)] = l.slice(i + 1); }
  rmSync(p, { force: true });
  return env;
}
async function start(name, model) {
  for (let i = 0; i < 50; i++) {   // the stub exits at once; wait until the broker has seen it go
    const r = await rest("POST", `/workers/${name}/start`, model ? { model } : {});
    if (r.status !== 409) return r;
    await sleep(100);
  }
}

async function main() {
  // ── 1. --print-channels ─────────────────────────────────────────────────────
  console.log("\n[1] --print-channels: model_route / model_warning");
  const pc = (env, inbox = INBOX, worker = "core") => {
    const r = wd([worker, "--work-dir", work, "--inbox-channel", inbox, "--print-channels"], { BROKER_URL: "http://127.0.0.1:9", ...env });
    return r.stdout + r.stderr;
  };
  let o = pc({});
  expect(kv(o, "model_route") === "scope(small=claude-sonnet-5-5,medium=claude-sonnet-5-5,large=claude-opus-5-5,no-task=claude-haiku-4-5-20251001,default=claude-sonnet-5-5)",
    "unpinned default route: sonnet small/medium, opus large, haiku no-task, sonnet default", o);
  expect(kv(o, "model_warning") === "none", "no warning by default", o);
  o = pc({ CLAUDE_MODEL: "claude-pin" });
  expect(kv(o, "model_route") === "pinned:claude-pin", "hand-run with CLAUDE_MODEL (no WATCHDOG_MODEL_PINNED) pins", o);
  o = pc({ CLAUDE_MODEL: "claude-pin", WATCHDOG_MODEL_PINNED: "1", WATCHDOG_REVIEWER: "1" });
  expect(kv(o, "model_route") === "pinned:claude-pin", "pinned wins over reviewer", o);
  o = pc({ CLAUDE_MODEL: "claude-dflt", WATCHDOG_MODEL_PINNED: "0" });
  expect(/default=claude-dflt\)$/m.test(kv(o, "model_route") || ""), "WATCHDOG_MODEL_PINNED=0: CLAUDE_MODEL is only the default", o);
  o = pc({}, `${NS}-reviewer`, "reviewer");
  expect(kv(o, "model_route") === "reviewer:claude-opus-5-5", "derived reviewer role → WATCHDOG_REVIEWER_MODEL default opus", o);
  o = pc({ WATCHDOG_REVIEWER: "0" }, `${NS}-reviewer`, "reviewer");
  expect(/^scope\(/.test(kv(o, "model_route") || ""), "WATCHDOG_REVIEWER=0 (start_worker's verdict) overrides the derived role", o);
  o = pc({ WATCHDOG_REVIEWER: "1", WATCHDOG_REVIEWER_MODEL: "claude-rev" });
  expect(kv(o, "model_route") === "reviewer:claude-rev", "WATCHDOG_REVIEWER=1 + WATCHDOG_REVIEWER_MODEL", o);
  o = pc({ WATCHDOG_MODEL_BY_SCOPE: "small=claude-env-s, large=claude-env-l,bogus=x", WATCHDOG_ENTRY_MODEL_BY_SCOPE: "large=claude-entry-l", WATCHDOG_NO_TASK_MODEL: "claude-nt" });
  expect(kv(o, "model_route") === "scope(small=claude-env-s,medium=claude-sonnet-5-5,large=claude-entry-l,no-task=claude-nt,default=claude-sonnet-5-5)",
    "entry map > env map > built-in, per scope; WATCHDOG_NO_TASK_MODEL", o);
  o = pc({ WATCHDOG_MODEL_WARNING: "namespace x: reviewer r and writer(s) w resolve to the same model m" });
  expect(/^model_warning=namespace x: reviewer r/m.test(o), "model_warning prints WATCHDOG_MODEL_WARNING", o);

  // ── 2. start_worker spawn env ────────────────────────────────────────────────
  console.log("\n[2] start_worker hands the watchdog the routing env");
  await startBroker();
  expect(/WARN model routing: namespace mrx: reviewer mrx-reviewer and writer\(s\) w-same resolve to the same model claude-opus-5-5/.test(brokerLog),
    "broker startup warns: mrx reviewer (opus by default) = pinned writer w-same; orchestrator excluded", brokerLog.slice(-1500));
  expect(/WARN model routing: namespace mry: reviewer rv and writer\(s\)/.test(brokerLog) === false,
    "no warning when the reviewer (role: reviewer) differs from every writer", brokerLog.slice(-1500));

  let r = await start("w-pinned");
  let e = await readDump("w-pinned");
  expect(r?.status === 200 && e.CLAUDE_MODEL === "claude-opus-5" && e.WATCHDOG_MODEL_PINNED === "1", "entry model → CLAUDE_MODEL + PINNED=1", JSON.stringify({ r, e }));
  expect(e.WATCHDOG_ENTRY_MODEL_BY_SCOPE === "" && e.WATCHDOG_REVIEWER === "0", "per-entry keys always set: the broker env's values do not leak", JSON.stringify(e));
  expect(e.WATCHDOG_MODEL_WARNING === "", "no warning for a writer outside the clash", JSON.stringify(e));

  r = await start("w-free");
  e = await readDump("w-free");
  expect(e.WATCHDOG_MODEL_PINNED === "0" && !("CLAUDE_MODEL" in e), "unpinned entry: PINNED=0, no CLAUDE_MODEL", JSON.stringify(e));
  expect(e.WATCHDOG_ENTRY_MODEL_BY_SCOPE === "large=claude-entry-large", "entry model_by_scope serialized, invalid ids dropped", JSON.stringify(e));

  r = await start("w-free", "claude-override");
  e = await readDump("w-free");
  expect(e.CLAUDE_MODEL === "claude-override" && e.WATCHDOG_MODEL_PINNED === "1", "start_worker model= pins over everything", JSON.stringify(e));

  r = await start("mrx-reviewer");
  e = await readDump("mrx-reviewer");
  expect(e.WATCHDOG_REVIEWER === "1" && e.WATCHDOG_MODEL_PINNED === "0", "name *-reviewer → WATCHDOG_REVIEWER=1", JSON.stringify(e));
  expect(/reviewer mrx-reviewer and writer\(s\) w-same/.test(e.WATCHDOG_MODEL_WARNING || ""), "reviewer's watchdog gets the same-model warning", JSON.stringify(e));
  r = await start("w-same");
  e = await readDump("w-same");
  expect(/same model claude-opus-5-5/.test(e.WATCHDOG_MODEL_WARNING || ""), "the clashing writer's watchdog gets it too", JSON.stringify(e));
  r = await start("rv");
  e = await readDump("rv");
  expect(e.WATCHDOG_REVIEWER === "1" && e.CLAUDE_MODEL === "claude-sonnet-5-5", "role: reviewer → WATCHDOG_REVIEWER=1; its pinned model kept", JSON.stringify(e));

  // ── 3. real sessions ─────────────────────────────────────────────────────────
  console.log("\n[3] --once sessions: model chosen from the next open task");
  const fake = join(dir, "fake-claude");
  writeFileSync(fake, `#!/usr/bin/env bash
if [[ "\${1:-}" == "--help" ]]; then exit 0; fi
echo "$*" > "$FAKE_ARGV"
node -e 'fetch(process.env.BROKER_URL+"/messages",{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+process.env.BROKER_SECRET},body:JSON.stringify({channel:process.argv[1],sender:"core",content:process.argv[2]})})' "$FAKE_STATUS" "$FAKE_RESULT"
exit 0
`);
  chmodSync(fake, 0o755);
  const argvFile = join(dir, "argv");
  let n = 0;
  // Post a task (or a note when scope === null and noTask), run one session, return the --model and last beat.
  const session = async (label, { scope, noTask = false, env = {} } = {}) => {
    const id = `${NS}-${++n}-${label}`;
    if (noTask) await send(INBOX, "orchestrator", { type: "note", from: "orchestrator", to: "core", subject: "fyi", body: "no task" });
    else await send(INBOX, "orchestrator", { type: "task", task_id: id, from: "orchestrator", to: "core", subject: `s ${id}`, body: "b", ...(scope && { scope }) });
    rmSync(argvFile, { force: true });
    const res = wd(["core", "--work-dir", work, "--inbox-channel", INBOX, "--once"], {
      BROKER_URL: BASE, BROKER_SECRET: SECRET, CLAUDE_BIN: fake, WATCHDOG_JITTER_MAX: "0", WATCHDOG_MCP: "0", WATCHDOG_STREAM_JSON: "0",
      WATCHDOG_HEARTBEAT_INTERVAL: "1", FOLLOWUP_MAX: "0", FAKE_ARGV: argvFile, FAKE_STATUS: STATUS,
      FAKE_RESULT: JSON.stringify({ type: "result", task_id: noTask ? `${id}-note` : id, from: "core", to: "orchestrator", subject: `s ${id}`, summary: "PASS — done" }),
      ...env });
    const log = (res.stdout || "") + (res.stderr || "");
    const argv = existsSync(argvFile) ? readFileSync(argvFile, "utf8") : "";
    const model = (argv.match(/--model (\S+)/) || [])[1];
    const last = await mcp("read_last", { channel: TELEMETRY, n: 1 });
    let beat = null; try { beat = JSON.parse(last.slice(last.indexOf("{"))); } catch {}
    return { model, beat, log };
  };
  const check = (s, model, reason, label) => {
    expect(s.model === model, `${label}: launched with --model ${model}`, `${s.model}\n${s.log.slice(-800)}`);
    expect(s.beat?.model === model && s.beat?.context?.model_reason === reason, `${label}: heartbeat model=${model}, context.model_reason=${reason}`, JSON.stringify(s.beat));
    expect(s.log.includes(`model: ${model} (${reason})`), `${label}: launch log names model and reason`, s.log.slice(-800));
  };

  check(await session("large", { scope: "large" }), "claude-opus-5-5", "scope:large", "scope large, built-in map");
  check(await session("small", { scope: "small" }), "claude-sonnet-5-5", "scope:small", "scope small, built-in map");
  check(await session("envmap", { scope: "medium", env: { WATCHDOG_MODEL_BY_SCOPE: "medium=claude-env-m" } }), "claude-env-m", "scope:medium", "WATCHDOG_MODEL_BY_SCOPE");
  check(await session("entrymap", { scope: "large", env: { WATCHDOG_MODEL_BY_SCOPE: "large=claude-env-l", WATCHDOG_ENTRY_MODEL_BY_SCOPE: "large=claude-entry-l" } }),
    "claude-entry-l", "scope:large", "entry model_by_scope beats the env map");
  check(await session("unscoped", {}), "claude-sonnet-5-5", "default", "task without scope → new default");
  check(await session("dflt", { env: { CLAUDE_MODEL: "claude-dflt", WATCHDOG_MODEL_PINNED: "0" } }), "claude-dflt", "default", "unpinned CLAUDE_MODEL is the default");
  check(await session("note", { noTask: true }), "claude-haiku-4-5-20251001", "no-task", "no open task → no-task model");
  check(await session("pinned", { scope: "large", env: { CLAUDE_MODEL: "claude-pin", WATCHDOG_MODEL_PINNED: "1" } }), "claude-pin", "pinned", "pinned beats scope");
  check(await session("review", { scope: "small", env: { WATCHDOG_REVIEWER: "1" } }), "claude-opus-5-5", "reviewer", "reviewer beats scope");
  check(await session("badid", { scope: "large", env: { WATCHDOG_MODEL_BY_SCOPE: "large=bad$id" } }), "claude-opus-5-5", "scope:large", "invalid env id dropped → built-in map");

  // A task waiting on an answer (blocked) or a plan decision (plan-review) is not open for the follow-up
  // count, but the session the answer / decision launches works on it: it routes by that task's scope.
  // (The 2026-10-29 incident: a blocked medium task's session ran on the no-task model.)
  console.log("\n[4] blocked / plan-review task: routed by its scope, never no-task");
  const blockedId = `${NS}-blocked`;
  await send(INBOX, "orchestrator", { type: "task", task_id: blockedId, from: "orchestrator", to: "core", subject: "blocked one", body: "b", scope: "large" });
  await send(STATUS, "core", { type: "question", task_id: blockedId, from: "core", to: "orchestrator", subject: "A or B?", body: "which" });
  let led = JSON.parse(await mcp("get_task_ledger", { status_channel: STATUS, only_open: true, workers: ["core"] }));
  expect(led.tasks.find(t => t.task_id === blockedId)?.state === "blocked", "setup: the task is blocked in the ledger", JSON.stringify(led.tasks));
  check(await session("q-blocked", { noTask: true }), "claude-opus-5-5", "scope:large", "only open task blocked → its scope (large), not no-task");
  await send(STATUS, "core", { type: "result", task_id: blockedId, from: "core", to: "orchestrator", subject: "blocked one", summary: "PASS — answered" });

  const adm = await fetch(`${BASE}/mcp?role=admin&ns=${NS}`, { method: "POST", headers: { ...H, accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "register_namespace", arguments: { manifest: JSON.stringify({
      ns: NS, version: "3.0", strict: false, plan_gate: true,
      workers: [{ name: "orchestrator", inbox: `${NS}-orchestrator`, role: "orchestrator" }, { name: "core", inbox: INBOX, role: "worker" }],
      channels: [{ name: `${NS}-orchestrator`, kind: "orchestrator-inbox", types: ["question", "status"] },
                 { name: INBOX, kind: "worker-inbox", types: ["task", "plan-decision"] },
                 { name: STATUS, kind: "status", types: ["result", "status", "question", "plan"] },
                 { name: TELEMETRY, kind: "telemetry", types: ["heartbeat"] }] }) } } }) });
  const admText = await adm.text();
  expect(adm.ok && !/"isError":true/.test(admText), "setup: plan_gate manifest registered", admText);
  const planId = `${NS}-plan`;
  await send(INBOX, "orchestrator", { type: "task", task_id: planId, from: "orchestrator", to: "core", subject: "planned one", body: "b", scope: "small", plan_required: true });
  await send(STATUS, "core", { type: "plan", task_id: planId, from: "core", to: "orchestrator", subject: "planned one", body: { steps: ["x"] } });
  led = JSON.parse(await mcp("get_task_ledger", { status_channel: STATUS, only_open: true, workers: ["core"] }));
  expect(led.tasks.find(t => t.task_id === planId)?.state === "plan-review", "setup: the task is in plan-review", JSON.stringify(led.tasks));
  check(await session("q-plan", { noTask: true, env: { WATCHDOG_MODEL_BY_SCOPE: "small=claude-env-s" } }), "claude-env-s", "scope:small",
    "only open task in plan-review → its scope (small), not no-task");
  await send(STATUS, "core", { type: "result", task_id: planId, from: "core", to: "orchestrator", subject: "planned one", summary: "SKIP — test done" });
  check(await session("q-none", { noTask: true }), "claude-haiku-4-5-20251001", "no-task", "nothing open, blocked or in review → no-task");
}

main()
  .catch(e => { failed++; console.error("FATAL:", e); process.exitCode = 1; })
  .finally(() => {
    try { broker?.kill("SIGTERM"); } catch {}
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    const safe = INBOX.replace(/[^a-zA-Z0-9]/g, "-");
    for (const f of [`-${safe}-cursor`, `-${safe}-patrol`, `-${safe}.lock`]) { try { rmSync(`/tmp/watchdog-core${f}`, { force: true }); } catch {} }
    console.log(`\n${"─".repeat(50)}\n  passed: ${passed}   failed: ${failed}\n  ${failed ? "SOME TESTS FAILED" : "ALL TESTS PASSED"}`);
  });
