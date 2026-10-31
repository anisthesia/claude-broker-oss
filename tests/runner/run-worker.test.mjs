// tests/runner — the Agent SDK launcher (runner/run-worker.mjs) and watchdog.sh WATCHDOG_LAUNCHER.
// No API call and no live broker: the SDK is the stub in fixtures/stub-sdk.mjs (replays a recorded
// CLI stream-json session) and the watchdog end-to-end test talks to a fake broker on 127.0.0.1.
//
//   node --test tests/runner/
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main, loadKey, deriveIdentity, UsageError } from "../../runner/run-worker.mjs";
import { sampleMessages, apiKeyMessages } from "./fixtures/stub-sdk.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUNNER = join(ROOT, "runner", "run-worker.mjs");
const STUB = join(ROOT, "tests", "runner", "fixtures", "stub-sdk.mjs");
const SAMPLE = join(ROOT, "tests", "runner", "fixtures", "cli-stream-sample.jsonl");
const WATCHDOG = join(ROOT, "watchdog.sh");
const FAKE_KEY = "fake-fleet-key-0001-not-a-real-key";
const SAMPLE_SID = sampleMessages()[0].session_id;

const TMP = mkdtempSync(join(tmpdir(), "runner-test-"));
process.on("exit", () => rmSync(TMP, { recursive: true, force: true }));

function keyFile(name, mode = 0o600, body = `# fleet key\nANTHROPIC_API_KEY=${FAKE_KEY}\n`) {
  const p = join(TMP, name);
  writeFileSync(p, body); chmodSync(p, mode);
  return p;
}
const GOOD_KEY = keyFile("good.env");

// <TMP>/repo/workers/backend with a role file; the worker path the watchdog would be given.
const REPO = join(TMP, "repo");
mkdirSync(join(REPO, "workers", "backend"), { recursive: true });
writeFileSync(join(REPO, "workers", "backend", "CLAUDE.md"), "# backend\n");
const MCP_CFG = join(TMP, "mcp.json");
writeFileSync(MCP_CFG, JSON.stringify({ mcpServers: { broker: { type: "http", url: "http://127.0.0.1:9/mcp?ns=tst&as=backend", headers: { Authorization: "Bearer fake-broker-secret" } } } }) + "\n");

const BASE_ARGS = ["workers/backend", "--repo-root", REPO, "--inbox-channel", "tst-backend", "--model", "claude-test-model", "--mcp-config", MCP_CFG];

function sink() { const chunks = []; return { write: (d) => { chunks.push(String(d)); return true; }, text: () => chunks.join("") }; }
const noSignals = { on() {}, off() {} };

// The runner as a process, with the stub SDK.
function runProc(args, env = {}) {
  const r = spawnSync(process.execPath, [RUNNER, ...args], {
    env: { PATH: process.env.PATH, HOME: TMP, RUNNER_SDK_MODULE: STUB, RUNNER_KEY_FILE: GOOD_KEY, STUB_EXPECT_KEY: FAKE_KEY, ...env },
    encoding: "utf8",
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// session_scan copied out of watchdog.sh at test time (the function text, verbatim) and run in bash
// with the watchdog's node() wrapper — not a re-implementation.
function sessionScan(file) {
  const lines = readFileSync(WATCHDOG, "utf8").split("\n");
  const start = lines.findIndex((l) => l.startsWith("session_scan() {"));
  const end = lines.findIndex((l, i) => i > start && l === "}");
  assert.ok(start >= 0 && end > start, "session_scan() found in watchdog.sh");
  const fn = lines.slice(start, end + 1).join("\n");
  const script = `NODE_BIN=${JSON.stringify(process.execPath)}\nnode() { "$NODE_BIN" "$@"; }\n${fn}\nsession_scan "$1"\n`;
  return execFileSync("bash", ["-c", script, "scan", file], { encoding: "utf8" }).trim();
}

// ── args and key file ────────────────────────────────────────────────────────

test("usage errors exit 2", () => {
  assert.equal(runProc([]).code, 2);
  assert.equal(runProc(["workers/backend", "--bogus"]).code, 2);
  assert.equal(runProc(["workers/nope", "--repo-root", REPO, "--inbox-channel", "tst-nope"]).code, 2);
  const noNs = runProc(["workers/backend", "--repo-root", REPO]);
  assert.equal(noNs.code, 2);
  assert.match(noNs.err, /no --inbox-channel and no WATCHDOG_NAMESPACE/);
});

test("key file missing: exit 2, one-line reason, SDK never started", () => {
  const dumpFile = join(TMP, "dump-missing.json");
  const r = runProc(BASE_ARGS, { RUNNER_KEY_FILE: join(TMP, "absent.env"), STUB_DUMP: dumpFile });
  assert.equal(r.code, 2);
  assert.match(r.err, /^\[runner\] ERROR: key file not found: .*absent\.env\n$/);
  assert.equal(existsSync(dumpFile), false, "query() was not called");
  assert.equal(r.out, "");
});

test("key file mode 644 (and 640, 400): exit 2 without reading or printing the key", () => {
  for (const mode of [0o644, 0o640, 0o400]) {
    const p = keyFile(`mode-${mode.toString(8)}.env`, mode);
    const r = runProc(BASE_ARGS, { RUNNER_KEY_FILE: p });
    assert.equal(r.code, 2, `mode ${mode.toString(8)}`);
    assert.match(r.err, new RegExp(`has mode ${mode.toString(8)}, expected 600`));
    assert.ok(!r.err.includes(FAKE_KEY) && !r.out.includes(FAKE_KEY));
  }
});

test("key file without a value, or a directory: exit 2", () => {
  assert.equal(runProc(BASE_ARGS, { RUNNER_KEY_FILE: keyFile("empty.env", 0o600, "ANTHROPIC_API_KEY=\n") }).code, 2);
  assert.equal(runProc(BASE_ARGS, { RUNNER_KEY_FILE: keyFile("other.env", 0o600, "OTHER=1\n") }).code, 2);
  const d = join(TMP, "dir.env"); mkdirSync(d, { mode: 0o700 }); chmodSync(d, 0o600);
  assert.equal(runProc(BASE_ARGS, { RUNNER_KEY_FILE: d }).code, 2);
});

test("loadKey accepts quotes and export, and its errors never carry the value", () => {
  assert.equal(loadKey(keyFile("q.env", 0o600, `export ANTHROPIC_API_KEY="${FAKE_KEY}"\n`)), FAKE_KEY);
  try { loadKey(keyFile("bad.env", 0o644)); assert.fail("should throw"); }
  catch (e) { assert.ok(e instanceof UsageError); assert.ok(!e.message.includes(FAKE_KEY)); }
});

test("default key path is ~/.config/claude-broker/anthropic.env", () => {
  const r = runProc(BASE_ARGS, { RUNNER_KEY_FILE: "" });
  assert.equal(r.code, 2);
  assert.ok(r.err.includes(join(TMP, ".config", "claude-broker", "anthropic.env")), r.err);
});

// ── the session ──────────────────────────────────────────────────────────────

test("one session: stdout is the SDK messages, one JSON line each, exit 0", () => {
  const r = runProc(BASE_ARGS);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.trimEnd().split("\n");
  assert.deepEqual(lines.map((l) => JSON.parse(l)), apiKeyMessages());
  assert.ok(!r.out.includes(FAKE_KEY) && !r.err.includes(FAKE_KEY), "key never printed");
});

test("query() options: cwd, model, unattended permissions, CLAUDE.md sources, broker only (strict), key in the child env", () => {
  const dumpFile = join(TMP, "dump-opts.json");
  const r = runProc(BASE_ARGS, { STUB_DUMP: dumpFile, CLAUDE_CODE_OAUTH_TOKEN: "x", ANTHROPIC_AUTH_TOKEN: "y" });
  assert.equal(r.code, 0, r.err);
  const d = JSON.parse(readFileSync(dumpFile, "utf8"));
  assert.equal(d.prompt, "go");
  assert.equal(d.cwd, join(REPO, "workers", "backend"));
  assert.equal(d.model, "claude-test-model");
  assert.equal(d.permissionMode, "bypassPermissions");
  assert.equal(d.allowDangerouslySkipPermissions, true);
  assert.ok(d.settingSources.includes("project"), "project settings + CLAUDE.md load");
  assert.deepEqual(d.systemPrompt, { type: "preset", preset: "claude_code" });
  assert.deepEqual(d.mcpServers, JSON.parse(readFileSync(MCP_CFG, "utf8")).mcpServers, "the watchdog's MCP file, as is");
  assert.equal(d.strictMcpConfig, true);
  assert.equal(d.key_present, true); assert.equal(d.key_matches, true);
  assert.deepEqual(d.stripped, ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"], "no other credential reaches the session");
  assert.deepEqual(d.runner_vars_in_child, []);
  assert.equal(d.has_abort_controller, true); assert.equal(d.has_stderr, true);
  assert.ok(!readFileSync(dumpFile, "utf8").includes(FAKE_KEY));
});

test("session error result: exit 1", () => {
  const r = runProc(BASE_ARGS, { STUB_MODE: "error-result" });
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.out.trimEnd().split("\n").pop()).is_error, true, "the error result is still on stdout");
});

test("SDK throws mid-session: exit 1, reason on stderr for the watchdog's diag scan", () => {
  const r = runProc(BASE_ARGS, { STUB_MODE: "throw" });
  assert.equal(r.code, 1);
  assert.match(r.err, /session failed: Connection error: fetch failed/);
});

test("no result event: exit 1", () => {
  assert.equal(runProc(BASE_ARGS, { STUB_MODE: "no-result" }).code, 1);
});

test("a session not on ANTHROPIC_API_KEY (claude.ai login) is stopped: exit 2", () => {
  const r = runProc(BASE_ARGS, { STUB_MODE: "oauth" });
  assert.equal(r.code, 2);
  assert.match(r.err, /authenticated via 'none', not ANTHROPIC_API_KEY/);
  assert.equal(r.out.trimEnd().split("\n").length, 1, "nothing after the init event");
});

test("SIGTERM aborts the session: exit 143", async () => {
  const child = spawn(process.execPath, [RUNNER, ...BASE_ARGS], {
    env: { PATH: process.env.PATH, HOME: TMP, RUNNER_SDK_MODULE: STUB, RUNNER_KEY_FILE: GOOD_KEY, STUB_MODE: "hang" },
  });
  let out = "";
  child.stdout.on("data", (d) => { out += d; if (out.includes("\n")) child.kill("SIGTERM"); });
  const code = await new Promise((res) => child.on("close", (c) => res(c)));
  assert.equal(code, 143);
});

test("an SDK iterator that stalls with an idle event loop: exit 1, not a silent 0", () => {
  const stall = join(TMP, "stall-sdk.mjs");
  writeFileSync(stall, "export async function* query() { yield { type: 'system', subtype: 'init', apiKeySource: 'ANTHROPIC_API_KEY', session_id: 's' }; await new Promise(() => {}); }\n");
  const r = runProc(BASE_ARGS, { RUNNER_SDK_MODULE: stall });
  assert.equal(r.code, 1);
  assert.match(r.err, /session stalled/);
});

test("main() with an injected query(): same contract in-process", async () => {
  const stdout = sink(), stderr = sink();
  async function* query() { for (const m of apiKeyMessages()) yield m; }
  const code = await main(BASE_ARGS, { env: { HOME: TMP, RUNNER_KEY_FILE: GOOD_KEY }, query, stdout, stderr, signals: noSignals });
  assert.equal(code, 0, stderr.text());
  assert.equal(stdout.text(), readFileSync(SAMPLE, "utf8").split("\n").filter(Boolean)
    .map((l) => { const m = JSON.parse(l); return JSON.stringify(m.type === "system" ? { ...m, apiKeySource: "ANTHROPIC_API_KEY" } : m); }).join("\n") + "\n");
});

test("final result event carries usage and total_cost_usd (for the usage ledger)", () => {
  const r = runProc(BASE_ARGS);
  const result = r.out.trimEnd().split("\n").map((l) => JSON.parse(l)).find((m) => m.type === "result");
  assert.equal(typeof result.total_cost_usd, "number");
  for (const k of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) assert.equal(typeof result.usage[k], "number", k);
  assert.equal(result.session_id, SAMPLE_SID);
});

// ── session_scan parity ──────────────────────────────────────────────────────

test("session_scan parity: runner stdout and the recorded CLI stream give the same CTX_SIZE and session id", () => {
  const r = runProc(BASE_ARGS);
  const runnerOut = join(TMP, "runner-out.jsonl");
  writeFileSync(runnerOut, r.out + r.err); // the watchdog captures 2>&1
  const fromCli = sessionScan(SAMPLE), fromRunner = sessionScan(runnerOut);
  assert.equal(fromRunner, fromCli);
  // last top-level assistant usage in the sample: 8 input + 21159 cache read + 158 cache create
  assert.equal(fromCli, `21325 21159 158 ${SAMPLE_SID} 0`);
});

test("session_scan parity on an error result: RESULT_ERR is 1 for both", () => {
  const r = runProc(BASE_ARGS, { STUB_MODE: "error-result" });
  const f = join(TMP, "runner-err.jsonl"); writeFileSync(f, r.out + r.err);
  assert.equal(sessionScan(f), `21325 21159 158 ${SAMPLE_SID} 1`);
});

// ── standalone: the MCP server built the way watchdog.sh builds it ───────────

test("standalone from a workers-config entry: ns, model, cwd and the broker URL match watchdog.sh --print-channels", () => {
  const cfg = join(TMP, "workers.json");
  writeFileSync(cfg, JSON.stringify([{ name: "tst-backend", ns: "tst", model: "claude-entry-model",
    args: ["workers/backend", "--repo-root", REPO, "--inbox-channel", "tst-backend", "--max-session-minutes", "60"] }]));
  for (const extra of [{}, { WATCHDOG_NS_ADOPTED: "1" }, { WATCHDOG_ROLE_NAMESPACES: "x, tst" }]) {
    const env = { BROKER_URL: "http://127.0.0.1:8999", BROKER_SECRET: "fake-broker-secret", ...extra };
    const r = runProc(["tst-backend", "--config", cfg, "--print-config"], env);
    assert.equal(r.code, 0, r.err);
    const s = JSON.parse(r.out);
    assert.equal(s.cwd, join(REPO, "workers", "backend"));
    assert.equal(s.model, "claude-entry-model");
    assert.ok(!r.out.includes("fake-broker-secret"), "--print-config redacts the bearer");
    const wd = spawnSync("bash", [WATCHDOG, "workers/backend", "--inbox-channel", "tst-backend", "--print-channels"],
      { env: { PATH: process.env.PATH, WATCHDOG_NAMESPACE: "tst", ...extra }, encoding: "utf8" });
    const mcpQuery = /mcp_query=(.*)/.exec(wd.stdout)[1];
    assert.equal(s.mcpServers.broker.url, `http://127.0.0.1:8999/mcp?${mcpQuery}`, JSON.stringify(extra));
    assert.deepEqual(s.mcpServers.broker.headers, { Authorization: "<redacted>" });
    assert.equal(s.strictMcpConfig, true);
  }
});

test("deriveIdentity follows the watchdog's role rules", () => {
  assert.equal(deriveIdentity({ worker: "orchestrators/brand-c", inboxChannel: "mg-orchestrator" }, {}).role, "orchestrator");
  assert.equal(deriveIdentity({ worker: "workers/reviewer", inboxChannel: "mg-reviewer" }, {}).role, "reviewer");
  assert.equal(deriveIdentity({ worker: "workers/platform", inboxChannel: "mg-platform" }, {}).query, "ns=mg&as=platform");
  assert.equal(deriveIdentity({ worker: "workers/platform", inboxChannel: "mg-platform" }, { WATCHDOG_NS_ADOPTED: "1" }).query, "role=worker&ns=mg&as=platform");
  assert.equal(deriveIdentity({ worker: "workers/platform", inboxChannel: "mg-platform" }, { WATCHDOG_NS_ADOPTED: "1", WATCHDOG_ROLE_URL: "0" }).query, "ns=mg&as=platform");
  assert.throws(() => deriveIdentity({ worker: "w", inboxChannel: "ab-w" }, { WATCHDOG_NAMESPACE: "mg" }), UsageError);
});

// ── watchdog.sh ──────────────────────────────────────────────────────────────

test("watchdog: a wrong WATCHDOG_LAUNCHER is exit 2", () => {
  const r = spawnSync("bash", [WATCHDOG, "workers/backend", "--repo-root", REPO, "--inbox-channel", "tst-backend", "--once"],
    { env: { PATH: process.env.PATH, WATCHDOG_LAUNCHER: "claude", WATCHDOG_JITTER_MAX: "0" }, encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /WATCHDOG_LAUNCHER='claude' — expected cli or sdk/);
  const viaArg = spawnSync("bash", [WATCHDOG, "workers/backend", "--repo-root", REPO, "--inbox-channel", "tst-backend", "--launcher", "bogus", "--once"],
    { env: { PATH: process.env.PATH, WATCHDOG_JITTER_MAX: "0" }, encoding: "utf8" });
  assert.equal(viaArg.status, 2);
});

test("watchdog: the diff against main only adds lines, and the cli launch line is byte-for-byte main's", () => {
  const diff = execFileSync("git", ["-C", ROOT, "diff", "main", "--", "watchdog.sh"], { encoding: "utf8" });
  const removed = diff.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"));
  assert.deepEqual(removed, [], "no line of main's watchdog.sh was changed or removed");
  const mainLine = execFileSync("git", ["-C", ROOT, "show", "main:watchdog.sh"], { encoding: "utf8" }).split("\n").find((l) => l.includes('exec "$CLAUDE" -p "go"'));
  assert.ok(mainLine && readFileSync(WATCHDOG, "utf8").split("\n").includes(mainLine));
});

// A fake broker on 127.0.0.1: one pending inbox message, records heartbeats. The real watchdog runs
// one session (--once) with WATCHDOG_LAUNCHER=sdk; the runner uses the stub SDK.
async function watchdogOnce(env, extraArgs = []) {
  const posts = [];
  const server = createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c)).on("end", () => {
      if (req.method === "GET" && req.url.startsWith("/inbox")) {
        const status = req.url.includes("channel=tst-status");
        res.end(JSON.stringify({ pending: true, max_id: status ? 5 : 1 }));
      } else if (req.method === "POST" && req.url === "/messages") { posts.push(JSON.parse(body)); res.end("{}"); }
      else { res.end("{}"); }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const fakeClaude = join(TMP, "fake-claude");
  writeFileSync(fakeClaude, '#!/usr/bin/env bash\n[[ "${1:-}" == "--help" ]] && echo "  --strict-mcp-config"\nexit 0\n'); chmodSync(fakeClaude, 0o755);
  const worker = `wdt-${process.pid}-${Date.now().toString(36)}`;
  mkdirSync(join(REPO, worker)); writeFileSync(join(REPO, worker, "CLAUDE.md"), "# t\n");
  const child = spawn("bash", [WATCHDOG, worker, "--repo-root", REPO, "--inbox-channel", "tst-backend", "--once", ...extraArgs], {
    env: { PATH: process.env.PATH, HOME: TMP, BROKER_URL: `http://127.0.0.1:${port}`, BROKER_SECRET: "fake-broker-secret",
      CLAUDE_BIN: fakeClaude, NODE_BIN: process.execPath, WATCHDOG_JITTER_MAX: "0", MAX_CONCURRENT: "64",
      WATCHDOG_LAUNCHER: "sdk", RUNNER_SDK_MODULE: STUB, RUNNER_KEY_FILE: GOOD_KEY, STUB_EXPECT_KEY: FAKE_KEY,
      CLAUDE_MODEL: "claude-test-model", ...env },
  });
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  const code = await new Promise((r) => child.on("close", r));
  server.close();
  for (const f of ["cursor", "patrol"]) rmSync(`/tmp/watchdog-${worker}-tst-backend-${f}`, { force: true });
  const beats = posts.filter((p) => p.channel === "tst-telemetry").map((p) => JSON.parse(p.content));
  return { code, log, beats, port, worker };
}

test("watchdog end to end, WATCHDOG_LAUNCHER=sdk: runner launched with the watchdog's MCP file; heartbeat carries the scanned context size and session id", async () => {
  const dumpFile = join(TMP, "dump-watchdog.json");
  const { code, log, beats, port, worker } = await watchdogOnce({ STUB_DUMP: dumpFile });
  assert.equal(code, 0, log);
  const end = beats.find((b) => b.activity.state === "session-end");
  assert.ok(end, log);
  assert.equal(end.activity.exit_code, 0);
  assert.equal(end.context.size_tokens, 21325);
  assert.equal(end.context.cache_read, 21159);
  assert.equal(end.session_id, SAMPLE_SID);
  const d = JSON.parse(readFileSync(dumpFile, "utf8"));
  assert.equal(d.cwd, join(REPO, worker));
  assert.equal(d.model, "claude-test-model");
  assert.deepEqual(d.mcpServers, { broker: { type: "http", url: `http://127.0.0.1:${port}/mcp?ns=tst&as=backend`, headers: { Authorization: "Bearer fake-broker-secret" } } });
  assert.equal(d.key_matches, true);
  assert.ok(!log.includes(FAKE_KEY));
});

test("watchdog end to end, --launcher sdk in the entry args, no key file: session-end exit_code 2", async () => {
  const { code, log, beats } = await watchdogOnce({ WATCHDOG_LAUNCHER: undefined, RUNNER_KEY_FILE: join(TMP, "absent.env") }, ["--launcher", "sdk"]);
  assert.equal(code, 0, log);
  const end = beats.find((b) => b.activity.state === "session-end");
  assert.equal(end.activity.exit_code, 2, log);
  assert.match(log, /non-zero exit \(2\)/);
});
