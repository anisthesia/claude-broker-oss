// Watchdog launch contract — what a worker session actually receives.
//
// A fresh-install trial (2026-09-16) showed that a headless worker only had broker tools when the
// machine happened to carry a user-scope `claude mcp add broker …` — and then it attached to
// WHATEVER broker that registration pointed at. Worktrees never receive the project's .mcp.json.
// The watchdog now hands every session an explicit MCP config. This test pins that contract by
// running the real watchdog.sh against a fake `claude` binary that records how it was invoked:
//
//   - the session starts in the worker's directory (--work-dir)
//   - it is launched with -p go, --dangerously-skip-permissions, the model, --mcp-config <file>
//     and --strict-mcp-config (when the CLI advertises it)
//   - the config file names exactly one server, "broker", at BROKER_URL/mcp with the bearer token
//   - the config file is mode 600 and is gone once the watchdog exits
//   - a working beat and a session-end beat with activity.exit_code land on <ns>-telemetry
//   - the inbox cursor advances after a session that posted to <ns>-status
//   - WATCHDOG_MCP=0 launches with no MCP flags at all (explicit opt-out)
//   - an entry's mcp_servers (WATCHDOG_MCP_SERVERS) picks exactly those servers from user/local/project
//     scope next to the broker, overriding WATCHDOG_MCP_INHERIT; [] = broker only; absent = inherit rule.
//     The SDK runner (resolveSession) honours the same list.
//   - start_worker strips ADMIN_SECRET and ORCHESTRATOR_TOKEN* from the spawned watchdog's env
//     (scratch broker with a stub WATCHDOG_BIN), BROKER_SECRET stays
//   - rotation signal: every session's --settings carries the hooks/rotation.mjs PostToolUse hook, with or
//     without guardrails; once the context crosses ROTATE_AT_TOKENS the hook hands the session the
//     ROTATE NOW text (1st, 6th … call); a stale flag from an earlier session is cleared at launch;
//     ROTATE_AT_TOKENS=0 or a missing hook file = no hook. The SDK runner wires the same hook.
//
// Requires a running broker (run-tests.js starts a throwaway one).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync, statSync, rmSync, realpathSync } from "fs";
import { startScratchBroker } from "./test-lib-broker.js";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import "dotenv/config";
import { resolveSession, buildQueryOptions } from "./runner/run-worker.mjs";
import { rotationContext, check as rotationCheck, sdkRotationHook } from "./hooks/rotation.mjs";

const ROOT       = dirname(fileURLToPath(import.meta.url));
const BROKER_URL = process.env.BROKER_URL || "http://localhost:8080/mcp";
const BASE_URL   = BROKER_URL.replace(/\/mcp\/?$/, "");
const SECRET     = process.env.SHARED_SECRET || "";
const TAG        = Date.now().toString(36);
const NS         = `wdt${TAG}`;
const INBOX      = `${NS}-backend`;
const STATUS     = `${NS}-status`;
const TELEMETRY  = `${NS}-telemetry`;

let passed = 0, failed = 0;
function expect(cond, label, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); return true; }
  failed++; console.error(`  ✗ ${label}`); if (detail) console.error(`     detail: ${String(detail).slice(0, 600)}`);
  process.exitCode = 1; return false;
}

async function connect(name) {
  const transport = new StreamableHTTPClientTransport(new URL(BROKER_URL), {
    requestInit: SECRET ? { headers: { Authorization: `Bearer ${SECRET}` } } : {},
  });
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

// A stand-in for the claude CLI: records cwd + argv + the MCP config it was handed, then behaves
// like a worker that finished a task (posts a result to the status channel) and exits 0.
function writeFakeClaude(dir) {
  const bin = join(dir, "fake-claude");
  writeFileSync(bin, `#!/usr/bin/env bash
if [[ "\${1:-}" == "--help" ]]; then echo "  --strict-mcp-config   Only use MCP servers from --mcp-config"; exit 0; fi
{
  echo "cwd=$(pwd)"
  echo "argv=$*"
  i=1; while [[ $i -le $# ]]; do
    if [[ "\${!i}" == "--mcp-config" ]]; then j=$((i+1)); echo "mcpcfg=\${!j}"; echo "mcpmode=$(stat -f %Lp "\${!j}" 2>/dev/null || stat -c %a "\${!j}")"; echo "mcpjson=$(cat "\${!j}")"; fi
    i=$((i+1))
  done
} > "$FAKE_DUMP"
[[ -n "\${FAKE_SLEEP:-}" ]] && sleep "$FAKE_SLEEP"
# FAKE_HOLD: stay alive until that file exists (the test creates it), at most 60s.
if [[ -n "\${FAKE_HOLD:-}" ]]; then for _ in $(seq 1 240); do [[ -f "$FAKE_HOLD" ]] && break; sleep 0.25; done; fi
if [[ -n "\${FAKE_POST_STATUS:-}" ]]; then
  curl -s -X POST "$BROKER_URL/messages" -H "Authorization: Bearer $BROKER_SECRET" -H 'content-type: application/json' \\
    -d "{\\"channel\\":\\"$FAKE_POST_STATUS\\",\\"sender\\":\\"backend\\",\\"content\\":\\"{\\\\\\"type\\\\\\":\\\\\\"result\\\\\\",\\\\\\"summary\\\\\\":\\\\\\"PASS — fake session\\\\\\"}\\"}" >/dev/null
fi
exit 0
`);
  chmodSync(bin, 0o755);
  return bin;
}

// A claude stand-in for the rotation hook: dumps argv and its --settings file, runs the PostToolUse hook
// command once before reporting any context ("before"), then reports FAKE_TOKENS of context in
// stream-json and runs the hook as a tool call would until it answers ("after"), then 5 more calls
// (call2..call6). Posts a result and exits 0. FAKE_QUICK=1: dump and exit at once.
function writeRotationClaude(dir) {
  const bin = join(dir, "fake-rot-claude");
  writeFileSync(bin, `#!/usr/bin/env bash
if [[ "\${1:-}" == "--help" ]]; then echo "  --strict-mcp-config   Only use MCP servers from --mcp-config"; exit 0; fi
sf=""; i=1; while [[ $i -le $# ]]; do [[ "\${!i}" == "--settings" ]] && { j=$((i+1)); sf="\${!j}"; }; i=$((i+1)); done
{ echo "argv=$*"; echo "settings=$([[ -n "$sf" ]] && cat "$sf")"; } > "$FAKE_DUMP"
post() { curl -s -X POST "$BROKER_URL/messages" -H "Authorization: Bearer $BROKER_SECRET" -H 'content-type: application/json' \\
  -d "{\\"channel\\":\\"$FAKE_POST_STATUS\\",\\"sender\\":\\"backend\\",\\"content\\":\\"{\\\\\\"type\\\\\\":\\\\\\"result\\\\\\",\\\\\\"summary\\\\\\":\\\\\\"PASS — fake\\\\\\"}\\"}" >/dev/null; }
[[ -n "\${FAKE_QUICK:-}" ]] && { post; exit 0; }
hook=""; [[ -n "$sf" ]] && hook=$(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const h=s.hooks&&s.hooks.PostToolUse; process.stdout.write(h ? h[0].hooks[0].command : "")' "$sf")
run_hook() { [[ -n "$hook" ]] && echo '{"hook_event_name":"PostToolUse","tool_name":"Bash"}' | bash -c "$hook"; }
echo "before=$(run_hook)" >> "$FAKE_DUMP"
t=\${FAKE_TOKENS:-5000}; a=$(( t / 10 )); b=$(( t - a ))
echo "{\\"type\\":\\"assistant\\",\\"session_id\\":\\"rot\\",\\"message\\":{\\"usage\\":{\\"input_tokens\\":$a,\\"cache_read_input_tokens\\":$b,\\"cache_creation_input_tokens\\":0,\\"output_tokens\\":5}}}"
out=""; for _ in $(seq 1 60); do out=$(run_hook); [[ -n "$out" ]] && break; sleep 0.25; done
echo "after=$out" >> "$FAKE_DUMP"
for k in 2 3 4 5 6; do echo "call$k=$(run_hook)" >> "$FAKE_DUMP"; done
post; exit 0
`);
  chmodSync(bin, 0o755);
  return bin;
}

function parseDump(p) {
  const out = {};
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, "utf8").split("\n")) { const i = line.indexOf("="); if (i > 0) out[line.slice(0, i)] = line.slice(i + 1); }
  return out;
}

function runWatchdog({ workDir, inbox, env, extraArgs = [], onSpawn }) {
  return new Promise((resolve) => {
    const p = spawn("bash", [join(ROOT, "watchdog.sh"), "backend", "--work-dir", workDir, "--inbox-channel", inbox, "--once", ...extraArgs], {
      env: { ...process.env, BROKER_URL: BASE_URL, BROKER_SECRET: SECRET, WATCHDOG_JITTER_MAX: "0", ...env },
    });
    let out = "";
    if (onSpawn) onSpawn(p);
    p.stdout.on("data", d => { out += d; }); p.stderr.on("data", d => { out += d; });
    const t = setTimeout(() => { p.kill("SIGTERM"); }, 90_000);
    p.on("exit", (code) => { clearTimeout(t); resolve({ code, out }); });
  });
}

async function main() {
  console.log(`[watchdog-launch] broker: ${BROKER_URL}  namespace: ${NS}`);
  const { client, transport } = await connect("watchdog-launch-test");
  const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); return { text: r.content?.[0]?.text || "", isError: !!r.isError }; };

  const tmp = mkdtempSync(join(tmpdir(), "wdt-"));
  const workDir = join(tmp, "backend"); rmSync(workDir, { recursive: true, force: true });
  writeFileSync(join(tmp, "CLAUDE.md"), "# fake role\n"); // work dir is tmp itself
  const fake = writeFakeClaude(tmp);
  const dump = join(tmp, "dump.txt");
  const safeChannel = INBOX.replace(/[^a-zA-Z0-9]/g, "-");
  const cursorFile = `/tmp/watchdog-backend-${safeChannel}-cursor`;

  try {
    // ── 1. default mode: explicit MCP config ────────────────────────────────
    console.log("\n[1] session launched with its own MCP config");
    let r = await call("send_message", { channel: INBOX, sender: "orchestrator", content: JSON.stringify({ type: "task", task_id: `t-${TAG}`, from: "orchestrator", to: "backend", subject: "fake" }) });
    const taskId = parseInt((r.text.match(/Sent #(\d+)/) || [])[1] || "0", 10);
    expect(taskId > 0, "task posted to the worker inbox", r.text);

    // The fake session stays alive (FAKE_HOLD) until the watchdog's periodic "working" beat is seen, or a
    // 45s deadline: <ns>-telemetry compacts a sender's transient rows when its session-end beat lands, so
    // the working beat must be read while the session is still alive. Polling to a deadline instead of a
    // fixed window keeps a slow watchdog start from failing the test.
    let sawWorking = false;
    const hold = join(tmp, "release-session");
    const pollWorking = async () => {
      const until = Date.now() + 45_000;
      try {
        while (Date.now() < until && !sawWorking) {
          const t = await call("get_latest_per_sender", { channel: TELEMETRY }).catch(() => ({ text: "" }));
          if (/<backend>.*"state":"working"/.test(t.text)) sawWorking = true; else await new Promise(r => setTimeout(r, 250));
        }
      } finally { writeFileSync(hold, ""); }
    };
    let pollDone;
    let res = await runWatchdog({ workDir: tmp, inbox: INBOX, env: { CLAUDE_BIN: fake, FAKE_DUMP: dump, FAKE_POST_STATUS: STATUS, FAKE_HOLD: hold, WATCHDOG_HEARTBEAT_INTERVAL: "1", CLAUDE_MODEL: "claude-haiku-4-5-20251001" }, onSpawn: () => { pollDone = pollWorking(); } });
    await pollDone;
    expect(res.code === 0, "watchdog --once exits 0 after one session", res.out);
    expect(/--once: session complete/.test(res.out), "watchdog reports the --once exit", res.out);
    expect(/clean exit — cursor=/.test(res.out), "session counted as a clean exit with output", res.out);

    const d = parseDump(dump);
    expect(realpathSync(d.cwd || "/") === realpathSync(tmp), "session cwd is the --work-dir", `cwd=${d.cwd}`);
    expect(/(^|\s)-p go(\s|$)/.test(d.argv || ""), "launched with -p go", d.argv);
    expect(/--dangerously-skip-permissions/.test(d.argv || ""), "launched with --dangerously-skip-permissions", d.argv);
    expect(/--model claude-haiku-4-5-20251001/.test(d.argv || ""), "launched with the configured model", d.argv);
    expect(/--mcp-config \S+/.test(d.argv || ""), "launched with --mcp-config <file>", d.argv);
    expect(/--strict-mcp-config/.test(d.argv || ""), "launched with --strict-mcp-config (CLI advertises it)", d.argv);
    expect(d.mcpmode === "600", "MCP config file is mode 600 (carries the bearer token)", `mode=${d.mcpmode}`);
    let cfg = null; try { cfg = JSON.parse(d.mcpjson || ""); } catch {}
    expect(!!cfg?.mcpServers?.broker, "config declares an MCP server named 'broker'", d.mcpjson);
    expect(Object.keys(cfg?.mcpServers || {}).length === 1, "config declares exactly one server", d.mcpjson);
    expect(cfg?.mcpServers?.broker?.type === "http", "broker server is type http", d.mcpjson);
    expect(cfg?.mcpServers?.broker?.url === `${BASE_URL}/mcp?ns=${NS}&as=backend`, `broker url is ${BASE_URL}/mcp?ns=${NS}&as=backend (the broker that spawned it, not a user-scope one; ns/as always, no role= by default)`, d.mcpjson);
    expect(cfg?.mcpServers?.broker?.headers?.Authorization === `Bearer ${SECRET}`, "Authorization header carries the injected BROKER_SECRET", (d.mcpjson || "").replace(SECRET, "<secret>"));
    expect(d.mcpcfg && !existsSync(d.mcpcfg), "MCP config temp file removed after the watchdog exits", d.mcpcfg);

    r = await call("get_latest_per_sender", { channel: TELEMETRY });
    expect(/<backend>/.test(r.text) && /"session-end"/.test(r.text) && /"exit_code":0/.test(r.text), "session-end heartbeat with activity.exit_code=0 on <ns>-telemetry", r.text);
    expect(sawWorking, "a working heartbeat was visible on <ns>-telemetry while the session ran", "no state:working row observed within the 45s deadline");
    r = await call("read_messages", { channel: TELEMETRY, since_id: 0, limit: 50 });
    expect(/"from":"backend"/.test(r.text), "heartbeats are keyed by the registry name (backend)", r.text);
    expect(!/"state":"working"/.test(r.text), "the working beat was compacted away once session-end landed (telemetry compaction)", r.text);

    expect(existsSync(cursorFile) && parseInt(readFileSync(cursorFile, "utf8"), 10) === taskId, `inbox cursor advanced to #${taskId} after the session posted to ${STATUS}`, existsSync(cursorFile) ? readFileSync(cursorFile, "utf8") : "no cursor file");

    // ── 2. opt-out: WATCHDOG_MCP=0 ──────────────────────────────────────────
    console.log("\n[2] WATCHDOG_MCP=0 launches with no MCP flags");
    rmSync(dump, { force: true });
    r = await call("send_message", { channel: INBOX, sender: "orchestrator", content: JSON.stringify({ type: "task", task_id: `t2-${TAG}`, from: "orchestrator", to: "backend", subject: "fake 2" }) });
    expect(/Sent #/.test(r.text), "second task posted", r.text);
    res = await runWatchdog({ workDir: tmp, inbox: INBOX, env: { CLAUDE_BIN: fake, FAKE_DUMP: dump, FAKE_POST_STATUS: STATUS, WATCHDOG_MCP: "0" } });
    expect(res.code === 0, "watchdog exits 0", res.out);
    const d2 = parseDump(dump);
    expect(d2.argv && !/--mcp-config|--strict-mcp-config/.test(d2.argv), "no --mcp-config / --strict-mcp-config when WATCHDOG_MCP=0", d2.argv);
    expect(/(^|\s)-p go(\s|$)/.test(d2.argv || ""), "still launched with -p go", d2.argv);

    // ── 3. per-entry MCP server list ───────────────────────────────────────
    console.log("\n[3] mcp_servers: broker + exactly the named servers");
    const claudeHome = join(tmp, "claude-home");
    mkdirSync(claudeHome);
    writeFileSync(join(claudeHome, ".claude.json"), JSON.stringify({ mcpServers: { "user-chrome": { type: "stdio", command: "chrome-mcp" }, x: { type: "stdio", command: "x-user" } } }));
    writeFileSync(join(tmp, ".mcp.json"), JSON.stringify({ mcpServers: { x: { type: "stdio", command: "x-project" }, y: { type: "stdio", command: "y" } } }));
    let n3 = 0;
    const listSession = async (env) => {
      rmSync(dump, { force: true });
      await call("send_message", { channel: INBOX, sender: "orchestrator", content: JSON.stringify({ type: "task", task_id: `t3-${++n3}-${TAG}`, from: "orchestrator", to: "backend", subject: "fake 3" }) });
      const res = await runWatchdog({ workDir: tmp, inbox: INBOX, env: { CLAUDE_BIN: fake, FAKE_DUMP: dump, FAKE_POST_STATUS: STATUS, CLAUDE_CONFIG_DIR: claudeHome,
        WATCHDOG_MCP_INHERIT: "", WATCHDOG_MCP_SERVERS: "", ...env } });
      let servers = {}; try { servers = JSON.parse(parseDump(dump).mcpjson).mcpServers; } catch {}
      return { res, servers, names: Object.keys(servers).sort().join(",") };
    };
    let ls = await listSession({});
    expect(ls.res.code === 0 && ls.names === "broker", "no list, inherit off: broker only (unchanged)", ls.names + "\n" + ls.res.out.slice(-400));
    ls = await listSession({ WATCHDOG_MCP_INHERIT: "1" });
    expect(ls.names === "broker,user-chrome,x,y" && ls.servers.x.command === "x-project", "no list, WATCHDOG_MCP_INHERIT=1: every scope carried (unchanged)", ls.names);
    ls = await listSession({ WATCHDOG_MCP_INHERIT: "1", WATCHDOG_MCP_SERVERS: "[]" });
    expect(ls.names === "broker" && /MCP inherit: list \[\] \(entry mcp_servers/.test(ls.res.out), "mcp_servers [] = broker only, even with WATCHDOG_MCP_INHERIT=1", ls.names + "\n" + ls.res.out.slice(-400));
    ls = await listSession({ WATCHDOG_MCP_SERVERS: '["x"]' });
    expect(ls.names === "broker,x" && ls.servers.x.command === "x-project", "mcp_servers [\"x\"]: broker + x (project scope wins over user)", JSON.stringify(ls.servers));
    expect(ls.servers.broker.url === `${BASE_URL}/mcp?ns=${NS}&as=backend`, "the broker entry stays the watchdog's own", JSON.stringify(ls.servers.broker));
    ls = await listSession({ WATCHDOG_MCP_SERVERS: '["user-chrome","nope"]' });
    expect(ls.res.code === 0 && ls.names === "broker,user-chrome", "a name in no scope: session still launches without it", ls.names + "\n" + ls.res.out.slice(-400));
    expect(/MCP inherit: list \[user-chrome,nope\] missing \[nope\]/.test(ls.res.out) && /WARN: mcp_servers name\(s\) found in no MCP scope: nope/.test(ls.res.out),
      "missing name listed in the startup line and warned", ls.res.out.slice(-600));
    const pc = await runWatchdog({ workDir: tmp, inbox: INBOX, extraArgs: ["--print-channels"], env: { WATCHDOG_MCP_SERVERS: '["a","b"]', WATCHDOG_MCP_INHERIT: "1" } });
    expect(/^mcp_inherit=list \[a,b\] \(entry mcp_servers; overrides WATCHDOG_MCP_INHERIT\)$/m.test(pc.out), "--print-channels reports the list", pc.out);

    // ── 4. SDK runner: the same list ────────────────────────────────────────
    console.log("\n[4] run-worker.mjs honours mcp_servers");
    const cfgPath = join(tmp, "workers.json");
    const rEntry = (name, extra) => ({ name, ns: NS, args: ["backend", "--work-dir", tmp, "--inbox-channel", INBOX], ...extra });
    writeFileSync(cfgPath, JSON.stringify([rEntry("r-none"), rEntry("r-empty", { mcp_servers: [] }), rEntry("r-list", { mcp_servers: ["x", "nope"] }), rEntry("r-bad", { mcp_servers: "x" })]));
    const renv = { BROKER_URL: BASE_URL, BROKER_SECRET: SECRET, CLAUDE_CONFIG_DIR: claudeHome, HOME: claudeHome, WATCHDOG_MCP_INHERIT: "1" };
    const rs = (worker, env = {}, opts = {}) => resolveSession({ worker, config: cfgPath, prompt: "go", ...opts }, { ...renv, ...env });
    expect(Object.keys(rs("r-none").mcpServers).join(",") === "broker", "runner, no list: broker only (current behaviour)");
    expect(Object.keys(rs("r-empty", { WATCHDOG_MCP_SERVERS: '["y"]' }).mcpServers).join(",") === "broker", "runner, entry []: broker only (the entry beats the env)");
    let sess = rs("r-list");
    expect(Object.keys(sess.mcpServers).sort().join(",") === "broker,x" && sess.mcpServers.x.command === "x-project" && sess.mcpMissing.join() === "nope",
      "runner, entry [x, nope]: broker + x from project scope, nope reported missing", JSON.stringify(sess.mcpServers) + " " + sess.mcpMissing);
    let threw = ""; try { rs("r-bad"); } catch (e) { threw = e.message; }
    expect(/mcp_servers: expected a JSON array/.test(threw), "runner, mcp_servers not an array: usage error", threw);
    sess = resolveSession({ worker: "backend", workDir: tmp, inboxChannel: INBOX, prompt: "go" }, { ...renv, WATCHDOG_MCP_SERVERS: '["y"]' });
    expect(Object.keys(sess.mcpServers).sort().join(",") === "broker,y", "runner without an entry: WATCHDOG_MCP_SERVERS applies", JSON.stringify(sess.mcpServers));
    const given = join(tmp, "given-mcp.json");
    writeFileSync(given, JSON.stringify({ mcpServers: { broker: { type: "http", url: "http://h/mcp" }, z: { type: "stdio", command: "z" } } }));
    sess = rs("r-list", {}, { mcpConfig: given });
    expect(Object.keys(sess.mcpServers).sort().join(",") === "broker,z", "runner with --mcp-config: the watchdog's file is used as is", JSON.stringify(sess.mcpServers));

    // ── 5. start_worker: broker-only secrets never reach the watchdog ──────
    console.log("\n[5] spawned watchdog env: ADMIN_SECRET / ORCHESTRATOR_TOKEN* stripped");
    await spawnEnvCheck(tmp);

    // ── 6. rotation signal ──────────────────────────────────────────────────
    console.log("\n[6] rotation hook: ROTATE NOW delivered into the session after the threshold");
    await rotationChecks(tmp, call, dump, safeChannel);
  } finally {
    for (const ch of [INBOX, STATUS, TELEMETRY, `${NS}-rate-limits`]) await call("purge_channel", { channel: ch }).catch(() => {});
    rmSync(cursorFile, { force: true });
    rmSync(`/tmp/watchdog-backend-${safeChannel}-patrol`, { force: true });
    rmSync(`/tmp/watchdog-backend-${safeChannel}.lock`, { force: true });
    rmSync(tmp, { recursive: true, force: true });
    await transport.close();
  }
}

async function rotationChecks(tmp, call, dump, safeChannel) {
  // Pure throttle: 1st, 6th, 11th call after the flag appears; nothing for a bad flag.
  const flag = { size: 5000, threshold: 4000 };
  const hits = [1, 2, 3, 4, 5, 6, 7, 11].filter(n => rotationContext(flag, n));
  expect(hits.join() === "1,6,11", "rotationContext: emits on calls 1, 6, 11 only (at most every 5 calls)", hits.join());
  expect(rotationContext({}, 1) === null && rotationContext(null, 1) === null, "rotationContext: no size/threshold → nothing");
  const fp = join(tmp, "unit-flag");
  expect(rotationCheck(fp) === null && !existsSync(`${fp}.count`), "check(): no flag file → no output, no counter");
  writeFileSync(fp, JSON.stringify({ ...flag, crossed_at: "x", status_base: 1 }));
  const seq = [1, 2, 3, 4, 5, 6].map(() => rotationCheck(fp));
  expect(seq.map(o => o ? 1 : 0).join("") === "100001", "check(): flag present → calls 1 and 6 emit, 2-5 silent", seq.map(o => o ? 1 : 0).join(""));
  const txt = seq[0]?.hookSpecificOutput?.additionalContext || "";
  expect(seq[0]?.hookSpecificOutput?.hookEventName === "PostToolUse" && /^ROTATE NOW: context 5000 >= 4000 tokens\. Finish the current edit, commit or stash on your branch, post type:status with body\.handoff_notes \{done,pending,files_touched,next_step\}, then exit\.$/.test(txt),
    "hookSpecificOutput.additionalContext carries the ROTATE NOW text with N and T", txt);
  rmSync(`${fp}.count`);
  expect(rotationCheck(fp) !== null, "check(): deleting <flag>.count restarts the cadence at call 1");
  writeFileSync(fp, "not json"); expect(rotationCheck(fp) === null, "check(): unreadable flag → no output (never blocks a tool)");

  // SDK runner: --rotation-flag → in-process PostToolUse hook next to the guardrail PreToolUse.
  const gcfg = join(tmp, "g.json"); writeFileSync(gcfg, "{}");
  const sfp = join(tmp, "sdk-flag");
  const sess = resolveSession({ worker: "backend", workDir: tmp, inboxChannel: INBOX, prompt: "go", rotationFlag: sfp, guardrails: gcfg }, { BROKER_URL: BASE_URL, BROKER_SECRET: SECRET, WATCHDOG_MCP: "0" });
  const opts = buildQueryOptions(sess, "k", {}, new AbortController(), process.stderr);
  expect(sess.rotationFlag === sfp && opts.hooks?.PostToolUse?.length === 1 && opts.hooks?.PreToolUse?.length === 1, "runner: rotationFlag → options.hooks.PostToolUse, guardrail PreToolUse kept", JSON.stringify(Object.keys(opts.hooks || {})));
  const sdkHookFn = opts.hooks.PostToolUse[0].hooks[0];
  expect(JSON.stringify(await sdkHookFn({})) === "{}", "runner hook: no flag yet → {}");
  writeFileSync(sfp, JSON.stringify(flag));
  expect(/ROTATE NOW: context 5000 >= 4000/.test((await sdkHookFn({})).hookSpecificOutput?.additionalContext || ""), "runner hook: flag present → ROTATE NOW");
  expect(typeof sdkRotationHook(sfp) === "function", "sdkRotationHook is exported for the runner");
  const noRot = buildQueryOptions(resolveSession({ worker: "backend", workDir: tmp, inboxChannel: INBOX, prompt: "go" }, { WATCHDOG_MCP: "0" }), "k", {}, new AbortController(), process.stderr);
  expect(!noRot.hooks, "runner without --rotation-flag/--guardrails: no hooks (unchanged)");

  // CLI end to end through watchdog.sh: guardrails off for this namespace (not in WATCHDOG_GUARDRAIL_NAMESPACES).
  const fake = writeRotationClaude(tmp);
  const flagPath = `/tmp/watchdog-backend-${safeChannel}-rotate-flag`;
  let k = 0;
  const session = async (env) => {
    rmSync(dump, { force: true });
    await call("send_message", { channel: INBOX, sender: "orchestrator", content: JSON.stringify({ type: "task", task_id: `t6-${++k}-${TAG}`, from: "orchestrator", to: "backend", subject: "fake 6" }) });
    const res = await runWatchdog({ workDir: tmp, inbox: INBOX, env: { CLAUDE_BIN: fake, FAKE_DUMP: dump, FAKE_POST_STATUS: STATUS, WATCHDOG_HEARTBEAT_INTERVAL: "1",
      ROTATE_AT_TOKENS: "4000", ROTATE_KILL_AFTER_S: "0", WATCHDOG_GUARDRAILS: "", WATCHDOG_GUARDRAIL_NAMESPACES: "someother", ...env } });
    const d = parseDump(dump); let set = null; try { set = JSON.parse(d.settings || ""); } catch {}
    return { res, d, set };
  };
  // A stale flag + count left by an earlier session must not leak into this one.
  writeFileSync(flagPath, JSON.stringify({ size: 1, threshold: 1 })); writeFileSync(`${flagPath}.count`, "3\n");
  let r = await session({});
  expect(r.res.code === 0 && /guardrails: off/.test(r.res.out), "guardrails off for this namespace; session ran", r.res.out.slice(-500));
  expect(!!r.set?.hooks?.PostToolUse && !r.set?.hooks?.PreToolUse && /rotation\.mjs/.test(r.set.hooks.PostToolUse[0].hooks[0].command),
    "--settings carries the rotation PostToolUse hook even though guardrails are off", r.d.settings);
  expect(r.d.before === "", "before the threshold (and with the stale flag cleared at launch): hook is silent", r.d.before);
  expect(/"additionalContext":"ROTATE NOW: context 5000 >= 4000 tokens\. Finish the current edit/.test(r.d.after || "") && /"hookEventName":"PostToolUse"/.test(r.d.after || ""),
    "after crossing: the session's hook returns ROTATE NOW with the measured size (cadence restarted at 1)", r.d.after);
  expect([2, 3, 4, 5].every(n => r.d[`call${n}`] === "") && /ROTATE NOW/.test(r.d.call6 || ""), "throttle in the session: calls 2-5 silent, call 6 repeats", JSON.stringify(r.d));
  expect(/context 5000 >= 4000 tokens — rotation recommended/.test(r.res.out), "watchdog logged the crossing", r.res.out.slice(-500));
  expect(!existsSync(flagPath) && !existsSync(`${flagPath}.count`), "flag and counter removed after the session");

  r = await session({ WATCHDOG_GUARDRAILS: "1", FAKE_QUICK: "1" });
  expect(r.set?.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command?.includes("guardrails.mjs") && r.set?.hooks?.PostToolUse?.[0]?.hooks?.[0]?.command?.includes("rotation.mjs"),
    "guardrails on: one --settings file holds both PreToolUse (guardrails) and PostToolUse (rotation)", r.d.settings);
  r = await session({ ROTATE_AT_TOKENS: "0", FAKE_QUICK: "1" });
  expect(r.res.code === 0 && !/--settings/.test(r.d.argv || ""), "ROTATE_AT_TOKENS=0 and guardrails off: no --settings at all", r.d.argv);
  r = await session({ WATCHDOG_ROTATION_HOOK: join(tmp, "nope.mjs"), FAKE_QUICK: "1" });
  expect(r.res.code === 0 && /WARN: rotation hook missing/.test(r.res.out) && !/--settings/.test(r.d.argv || ""), "missing hook file: WARN, session still launches without it", r.res.out.slice(-500));
}

// A scratch broker (own port, DB, workers config) whose WATCHDOG_BIN is a stub that dumps its env.
async function spawnEnvCheck(tmp) {
  const dir = join(tmp, "spawn-env"); mkdirSync(dir);
  const stub = join(dir, "stub-watchdog");
  writeFileSync(stub, `#!/usr/bin/env bash\nenv > "${dir}/$1.env.tmp" && mv "${dir}/$1.env.tmp" "${dir}/$1.env"\n`);
  chmodSync(stub, 0o755);
  const cfg = join(dir, "workers.json");
  writeFileSync(cfg, JSON.stringify([{ name: "se-list", ns: "sex", args: ["se-list"], mcp_servers: ["tally"] }, { name: "se-plain", ns: "sex", args: ["se-plain"] }]));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(WATCHDOG|BROKER|ORCHESTRATOR_TOKEN)_?/.test(k) && !["PORT", "DB_PATH", "ADMIN_SECRET"].includes(k)));
  const bsecret = `${SECRET || "s"}-scratch`;
  let log = "";
  const h = await startScratchBroker({ root: ROOT, onData: d => { log += d; }, env: (port) => ({ ...env, DOTENV_CONFIG_PATH: "/dev/null", PORT: String(port), DB_PATH: join(dir, "b.db"), SHARED_SECRET: bsecret, BROKER_SECRET: bsecret,
      ADMIN_SECRET: "admin-secret-value", ORCHESTRATOR_TOKEN: "orch-token-value", ORCHESTRATOR_TOKEN_CB: "orch-token-cb-value",
      WATCHDOG_BIN: stub, WORKERS_CONFIG: cfg, WORKERS_LOG_DIR: join(dir, "logs"), WORKERS_TMUX_SESSION: "", PRUNE_EXEMPT: "",
      WATCHDOG_MCP_SERVERS: '["leaked"]' }) });
  const { proc: broker, base } = h;
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) { try { up = (await fetch(`${base}/health`)).ok; } catch {} if (!up) await new Promise(r => setTimeout(r, 150)); }
    if (!expect(up, "scratch broker started", log.slice(-600))) return;
    const dumpOf = async (name) => {
      const r = await fetch(`${base}/workers/${name}/start`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${bsecret}` }, body: "{}" });
      const p = join(dir, `${name}.env`);
      for (let i = 0; i < 50 && !existsSync(p); i++) await new Promise(r => setTimeout(r, 100));
      const e = {};
      if (existsSync(p)) for (const l of readFileSync(p, "utf8").split("\n")) { const i = l.indexOf("="); if (i > 0) e[l.slice(0, i)] = l.slice(i + 1); }
      return { status: r.status, e };
    };
    const a = await dumpOf("se-list");
    expect(a.status === 200 && Object.keys(a.e).length > 0, "start_worker spawned the stub watchdog", `${a.status} ${log.slice(-400)}`);
    expect(!("ADMIN_SECRET" in a.e) && !("ORCHESTRATOR_TOKEN" in a.e) && !("ORCHESTRATOR_TOKEN_CB" in a.e),
      "ADMIN_SECRET, ORCHESTRATOR_TOKEN and ORCHESTRATOR_TOKEN_CB absent from the spawned env", Object.keys(a.e).filter(k => /ADMIN|ORCH/.test(k)).join(","));
    expect(!Object.values(a.e).some(v => /admin-secret-value|orch-token/.test(v)), "no other variable carries their values");
    expect(a.e.BROKER_SECRET === bsecret, "BROKER_SECRET still reaches the watchdog");
    expect(a.e.WATCHDOG_MCP_SERVERS === '["tally"]', "entry mcp_servers → WATCHDOG_MCP_SERVERS", a.e.WATCHDOG_MCP_SERVERS);
    const b = await dumpOf("se-plain");
    expect(b.e.WATCHDOG_MCP_SERVERS === "", "entry without mcp_servers: WATCHDOG_MCP_SERVERS empty, the broker env's value does not leak", JSON.stringify(b.e.WATCHDOG_MCP_SERVERS));
  } finally {
    broker.kill("SIGTERM");
  }
}

main().then(() => {
  console.log(`\n[watchdog-launch] ${passed} passed, ${failed} failed — ${failed ? "FAIL" : "OK"}`);
}).catch(e => { console.error("[watchdog-launch] FAIL:", e); process.exit(1); });
