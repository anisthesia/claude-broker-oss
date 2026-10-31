// Watchdog reconcile contract — the pieces the bundled watchdog.sh must keep from the client project's copy.
//   - NODE_BIN: honoured when set; found past a bare PATH; a bad NODE_BIN fails loudly
//   - inbox derivation: missing --inbox-channel derives <ns>-<worker> from WATCHDOG_NAMESPACE
//     (orchestrators/<x> -> <ns>-<x>-orch); with no namespace it exits with an error, never guesses dv-
//   - repo root: --repo-root > WATCHDOG_REPO_ROOT > cwd; the session dir is <repo-root>/<worker>
//   - WATCHDOG_MCP_INHERIT=1 carries user-scope MCP servers into the session config, unset does not
//   - the "resets N" rate-limit regex: "resets 3pm" is a rate limit, "resets soon" is not
// Drives the real watchdog.sh against a fake `claude`. Requires a running broker
// (run-tests.js starts a throwaway one); never touches claude or the network.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn, spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync, rmSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const ROOT       = dirname(fileURLToPath(import.meta.url));
const WATCHDOG   = join(ROOT, "watchdog.sh");
const BROKER_URL = process.env.BROKER_URL || "http://localhost:8080/mcp";
const BASE_URL   = BROKER_URL.replace(/\/mcp\/?$/, "");
const SECRET     = process.env.SHARED_SECRET || "";
const TAG        = Date.now().toString(36);
const NS         = `wdr${TAG}`;

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

// Records cwd + the MCP config it was handed; FAKE_SAY is printed and FAKE_EXIT is the exit code.
function writeFakeClaude(dir) {
  const bin = join(dir, "fake-claude");
  writeFileSync(bin, `#!/usr/bin/env bash
if [[ "\${1:-}" == "--help" ]]; then echo "  --strict-mcp-config   Only use MCP servers from --mcp-config"; exit 0; fi
{
  echo "cwd=$(pwd)"
  i=1; while [[ $i -le $# ]]; do
    if [[ "\${!i}" == "--mcp-config" ]]; then j=$((i+1)); echo "mcpjson=$(cat "\${!j}")"; fi
    i=$((i+1))
  done
} > "$FAKE_DUMP"
[[ -n "\${FAKE_SAY:-}" ]] && echo "$FAKE_SAY"
exit "\${FAKE_EXIT:-0}"
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

// Runs watchdog.sh; resolves on exit, or kills it once `until` matches the output (a rate-limited
// watchdog would otherwise sleep out its backoff).
function runWatchdog(args, { env = {}, cwd, until } = {}) {
  return new Promise((resolve) => {
    const p = spawn("/bin/bash", [WATCHDOG, ...args], { cwd, env: { ...process.env, BROKER_URL: BASE_URL, BROKER_SECRET: SECRET, WATCHDOG_JITTER_MAX: "0", ...env } });
    let out = "", killed = false;
    const feed = (d) => { out += d; if (until && !killed && until.test(out)) { killed = true; p.kill("SIGTERM"); } };
    p.stdout.on("data", feed); p.stderr.on("data", feed);
    const t = setTimeout(() => p.kill("SIGTERM"), 60_000);
    p.on("exit", (code) => { clearTimeout(t); resolve({ code, out, killed }); });
  });
}

const printChannels = (args, env, cwd) => {
  const r = spawnSync("/bin/bash", [WATCHDOG, ...args, "--print-channels"], { cwd, encoding: "utf8", env: { ...cleanEnv(), BROKER_URL: "http://127.0.0.1:9", ...env } });
  const kv = {}; for (const l of (r.stdout || "").split("\n")) { const i = l.indexOf("="); if (i > 0) kv[l.slice(0, i)] = l.slice(i + 1); }
  return { kv, code: r.status, out: (r.stdout || "") + (r.stderr || "") };
};
// The suite may itself run inside a watchdog session: drop its identity so derivation starts clean.
function cleanEnv() { const e = { ...process.env }; for (const k of Object.keys(e)) if (/^(WATCHDOG_|FOLLOWUP_|BROKER_)/.test(k)) delete e[k]; return e; }

async function main() {
  console.log(`[watchdog-reconcile] broker: ${BROKER_URL}  namespace: ${NS}`);
  const { client, transport } = await connect("watchdog-reconcile-test");
  const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); return { text: r.content?.[0]?.text || "" }; };
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "wdr-")));
  const fake = writeFakeClaude(tmp);
  const task = (inbox, to) => call("send_message", { channel: inbox, sender: "orchestrator", content: JSON.stringify({ type: "task", task_id: `t-${TAG}-${Math.random().toString(36).slice(2, 6)}`, from: "orchestrator", to, subject: "fake" }) });
  const cursors = [];
  const runOnce = async (inbox, worker, args, opts = {}) => {
    cursors.push(`/tmp/watchdog-${worker.split("/").pop()}-${inbox.replace(/[^a-zA-Z0-9]/g, "-")}-cursor`);
    await task(inbox, worker);
    const dump = join(tmp, `dump-${Math.random().toString(36).slice(2, 6)}.txt`);
    const res = await runWatchdog([worker, ...args, "--inbox-channel", inbox, "--once"], { ...opts, env: { CLAUDE_BIN: fake, FAKE_DUMP: dump, ...(opts.env || {}) } });
    return { ...res, dump: parseDump(dump) };
  };

  try {
    // ── 1. inbox derivation ──────────────────────────────────────────────────
    console.log("\n[1] missing --inbox-channel derives <ns>-<worker>, never dv-<worker>");
    let r = printChannels(["backend"], { WATCHDOG_NAMESPACE: "cb" });
    expect(r.kv.inbox === "cb-backend" && r.kv.namespace === "cb", "WATCHDOG_NAMESPACE=cb -> inbox cb-backend", r.out);
    r = printChannels(["orchestrators/infra"], { WATCHDOG_NAMESPACE: "cb" });
    expect(r.kv.inbox === "cb-infra-orch", "orchestrators/infra -> cb-infra-orch", r.out);
    r = printChannels(["code-reviewer"], { WATCHDOG_NAMESPACE: "cb" });
    expect(r.kv.inbox === "cb-code-reviewer", "code-reviewer dir -> cb-code-reviewer", r.out);
    r = printChannels(["backend"], {});
    expect(r.code !== 0 && /no --inbox-channel and no WATCHDOG_NAMESPACE/.test(r.out) && !/dv-backend/.test(r.out), "no namespace -> loud error, no dv- guess", r.out);
    r = printChannels(["backend", "--inbox-channel", "zz-backend"], { WATCHDOG_NAMESPACE: "cb" });
    expect(r.code !== 0 && /not in namespace 'cb'/.test(r.out), "inbox outside the exported namespace is rejected", r.out);

    // ── 2. repo root ─────────────────────────────────────────────────────────
    console.log("\n[2] repo root resolution");
    const rootA = join(tmp, "rootA"), rootB = join(tmp, "rootB"), rootC = join(tmp, "rootC");
    for (const d of [rootA, rootB, rootC]) { mkdirSync(join(d, "svc"), { recursive: true }); writeFileSync(join(d, "svc", "CLAUDE.md"), "# role\n"); }
    const inbox = `${NS}-svc`;
    let w = await runOnce(inbox, "svc", ["--repo-root", rootA], { env: { WATCHDOG_REPO_ROOT: rootB }, cwd: rootC });
    expect(realpathSync(w.dump.cwd || "/") === join(rootA, "svc"), "--repo-root wins over WATCHDOG_REPO_ROOT and cwd", `cwd=${w.dump.cwd}\n${w.out}`);
    w = await runOnce(inbox, "svc", [], { env: { WATCHDOG_REPO_ROOT: rootB }, cwd: rootC });
    expect(realpathSync(w.dump.cwd || "/") === join(rootB, "svc"), "WATCHDOG_REPO_ROOT wins over cwd", `cwd=${w.dump.cwd}\n${w.out}`);
    w = await runOnce(inbox, "svc", [], { cwd: rootC });
    expect(realpathSync(w.dump.cwd || "/") === join(rootC, "svc"), "no override: cwd holding <worker> is the root", `cwd=${w.dump.cwd}\n${w.out}`);

    // ── 3. MCP inherit ───────────────────────────────────────────────────────
    console.log("\n[3] WATCHDOG_MCP_INHERIT");
    const cfgDir = join(tmp, "claude-config"); mkdirSync(cfgDir);
    writeFileSync(join(cfgDir, ".claude.json"), JSON.stringify({ mcpServers: { usertool: { type: "http", url: "http://127.0.0.1:1/x" }, broker: { type: "http", url: "http://evil.invalid/mcp" } } }));
    const servers = (d) => { try { return Object.keys(JSON.parse(d.mcpjson).mcpServers).sort(); } catch { return null; } };
    w = await runOnce(inbox, "svc", ["--repo-root", rootA], { env: { CLAUDE_CONFIG_DIR: cfgDir } });
    expect(JSON.stringify(servers(w.dump)) === '["broker"]', "default: broker only", w.dump.mcpjson);
    w = await runOnce(inbox, "svc", ["--repo-root", rootA], { env: { CLAUDE_CONFIG_DIR: cfgDir, WATCHDOG_MCP_INHERIT: "1" } });
    expect(JSON.stringify(servers(w.dump)) === '["broker","usertool"]', "MCP_INHERIT=1: user-scope server joins", w.dump.mcpjson);
    expect(JSON.parse(w.dump.mcpjson || "{}").mcpServers?.broker?.url?.startsWith(BASE_URL), "inherit never replaces the watchdog's own broker entry", w.dump.mcpjson);

    // ── 4. NODE_BIN discovery ────────────────────────────────────────────────
    console.log("\n[4] NODE_BIN discovery");
    const bare = { PATH: "/usr/bin:/bin" };
    let n = await runWatchdog(["svc", "--repo-root", rootA, "--inbox-channel", inbox, "--once"], { env: { ...bare, CLAUDE_BIN: fake, FAKE_DUMP: join(tmp, "n1.txt"), NODE_BIN: "/nonexistent/node" } });
    expect(n.code !== 0 && /node is required/.test(n.out), "a NODE_BIN that does not exist fails loudly", n.out);
    cursors.push(`/tmp/watchdog-svc-${inbox.replace(/[^a-zA-Z0-9]/g, "-")}-cursor`);
    await task(inbox, "svc");
    n = await runWatchdog(["svc", "--repo-root", rootA, "--inbox-channel", inbox, "--once"], { env: { ...bare, CLAUDE_BIN: fake, FAKE_DUMP: join(tmp, "n2.txt"), NODE_BIN: process.execPath } });
    expect(n.code === 0 && /--once: session complete/.test(n.out), "NODE_BIN set -> works on a bare PATH", n.out);
    const found = ["/usr/local/bin/node", "/opt/homebrew/bin/node"].some(p => existsSync(p)) || existsSync(join(process.env.HOME || "", ".nvm"));
    if (found) {
      await task(inbox, "svc");
      n = await runWatchdog(["svc", "--repo-root", rootA, "--inbox-channel", inbox, "--once"], { env: { ...bare, CLAUDE_BIN: fake, FAKE_DUMP: join(tmp, "n3.txt"), NODE_BIN: "" } });
      expect(!/node is required/.test(n.out), "no NODE_BIN, bare PATH -> found past PATH", n.out);
    } else console.log("  - skipped: no node in the usual install locations on this machine");

    // ── 5. resets-N rate-limit regex ─────────────────────────────────────────
    console.log("\n[5] rate-limit detection: 'resets <digit>'");
    w = await runOnce(inbox, "svc", ["--repo-root", rootA], { env: { FAKE_SAY: "You've hit your limit · resets 3pm", FAKE_EXIT: "1" }, until: /RATE LIMITED/ });
    expect(/RATE LIMITED/.test(w.out), "'resets 3pm' on a failed session is a rate limit", w.out);
    w = await runOnce(inbox, "svc", ["--repo-root", rootA], { env: { FAKE_SAY: "the schema resets soon", FAKE_EXIT: "1" }, until: /RATE LIMITED|--once: session complete|exit/i });
    expect(!/RATE LIMITED/.test(w.out), "'resets soon' (no digit) is not a rate limit", w.out);
  } finally {
    await transport.close().catch(() => {});
    for (const c of cursors) rmSync(c, { force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n[watchdog-reconcile] ${passed} passed, ${failed} failed`);
}

main().catch(e => { console.error("[watchdog-reconcile] FAIL:", e); process.exit(1); });
