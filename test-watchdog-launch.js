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
//
// Requires a running broker (run-tests.js starts a throwaway one).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "child_process";
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync, statSync, rmSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

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
if [[ -n "\${FAKE_POST_STATUS:-}" ]]; then
  curl -s -X POST "$BROKER_URL/messages" -H "Authorization: Bearer $BROKER_SECRET" -H 'content-type: application/json' \\
    -d "{\\"channel\\":\\"$FAKE_POST_STATUS\\",\\"sender\\":\\"backend\\",\\"content\\":\\"{\\\\\\"type\\\\\\":\\\\\\"result\\\\\\",\\\\\\"summary\\\\\\":\\\\\\"PASS — fake session\\\\\\"}\\"}" >/dev/null
fi
exit 0
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

    // The fake session lives 4s so the watchdog's periodic "working" beat can be observed mid-run;
    // <ns>-telemetry compacts a sender's transient rows when its session-end beat lands, so the
    // working beat must be read while the session is still alive.
    let sawWorking = false;
    const pollWorking = async () => {
      const until = Date.now() + 3500;
      while (Date.now() < until && !sawWorking) {
        const t = await call("get_latest_per_sender", { channel: TELEMETRY }).catch(() => ({ text: "" }));
        if (/<backend>.*"state":"working"/.test(t.text)) sawWorking = true; else await new Promise(r => setTimeout(r, 250));
      }
    };
    let pollDone;
    let res = await runWatchdog({ workDir: tmp, inbox: INBOX, env: { CLAUDE_BIN: fake, FAKE_DUMP: dump, FAKE_POST_STATUS: STATUS, FAKE_SLEEP: "4", CLAUDE_MODEL: "claude-haiku-4-5-20251001" }, onSpawn: () => { pollDone = pollWorking(); } });
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
    expect(cfg?.mcpServers?.broker?.url === `${BASE_URL}/mcp`, `broker url is ${BASE_URL}/mcp (the broker that spawned it, not a user-scope one)`, d.mcpjson);
    expect(cfg?.mcpServers?.broker?.headers?.Authorization === `Bearer ${SECRET}`, "Authorization header carries the injected BROKER_SECRET", (d.mcpjson || "").replace(SECRET, "<secret>"));
    expect(d.mcpcfg && !existsSync(d.mcpcfg), "MCP config temp file removed after the watchdog exits", d.mcpcfg);

    r = await call("get_latest_per_sender", { channel: TELEMETRY });
    expect(/<backend>/.test(r.text) && /"session-end"/.test(r.text) && /"exit_code":0/.test(r.text), "session-end heartbeat with activity.exit_code=0 on <ns>-telemetry", r.text);
    expect(sawWorking, "a working heartbeat was visible on <ns>-telemetry while the session ran", "no state:working row observed during the 4s session");
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
  } finally {
    for (const ch of [INBOX, STATUS, TELEMETRY, `${NS}-rate-limits`]) await call("purge_channel", { channel: ch }).catch(() => {});
    rmSync(cursorFile, { force: true });
    rmSync(`/tmp/watchdog-backend-${safeChannel}-patrol`, { force: true });
    rmSync(`/tmp/watchdog-backend-${safeChannel}.lock`, { force: true });
    rmSync(tmp, { recursive: true, force: true });
    await transport.close();
  }
}

main().then(() => {
  console.log(`\n[watchdog-launch] ${passed} passed, ${failed} failed — ${failed ? "FAIL" : "OK"}`);
}).catch(e => { console.error("[watchdog-launch] FAIL:", e); process.exit(1); });
