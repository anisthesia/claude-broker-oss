// tests/runner — the usage ledger (runner/usage-ledger.mjs): one row per session, success or error,
// a failed write never changes the exit code, brand and task from the session's broker traffic.
// No API call: the SDK is fixtures/stub-sdk.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Attribution, buildRow, ledgerFile, resolveLedgerDir } from "../../runner/usage-ledger.mjs";
import { sampleMessages, BROKER_TASK } from "./fixtures/stub-sdk.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUNNER = join(ROOT, "runner", "run-worker.mjs");
const STUB = join(ROOT, "tests", "runner", "fixtures", "stub-sdk.mjs");
const FAKE_KEY = "fake-fleet-key-0002-not-a-real-key";
const SAMPLE = sampleMessages();
const SID = SAMPLE[0].session_id;
const RESULT = SAMPLE.find((m) => m.type === "result");

const TMP = mkdtempSync(join(tmpdir(), "runner-ledger-test-"));
process.on("exit", () => rmSync(TMP, { recursive: true, force: true }));
const KEY = join(TMP, "key.env");
writeFileSync(KEY, `ANTHROPIC_API_KEY=${FAKE_KEY}\n`); chmodSync(KEY, 0o600);
const MCP_CFG = join(TMP, "mcp.json");
writeFileSync(MCP_CFG, JSON.stringify({ mcpServers: { broker: { type: "http", url: "http://127.0.0.1:9/mcp?ns=tst&as=backend" } } }) + "\n");

let n = 0;
// A fresh repo per case: <repo>/workers/backend, with or without <repo>/ops/usage.
function repo({ usage = false } = {}) {
  const r = join(TMP, `repo${++n}`);
  mkdirSync(join(r, "workers", "backend"), { recursive: true });
  if (usage) mkdirSync(join(r, "ops", "usage"), { recursive: true });
  return r;
}
// The runner as the watchdog launches it: <worker> --work-dir <root>/<worker>, cwd = the worker dir.
function run(r, { mode = "fixture", extra = [], env = {} } = {}) {
  const wd = join(r, "workers", "backend");
  const p = spawnSync(process.execPath, [RUNNER, "workers/backend", "--work-dir", wd, "--inbox-channel", "tst-backend", "--model", "claude-test-model", "--mcp-config", MCP_CFG, ...extra], {
    cwd: wd, encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: TMP, RUNNER_SDK_MODULE: STUB, RUNNER_KEY_FILE: KEY, STUB_MODE: mode, ...env },
  });
  return { code: p.status, out: p.stdout, err: p.stderr };
}
const rows = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")).flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))) : []);

test("success: exactly one row with the result's usage and cost, in <repo>/ops/usage/<local date>.jsonl", () => {
  const r = repo({ usage: true });
  const p = run(r);
  assert.equal(p.code, 0, p.err);
  const dir = join(r, "ops", "usage");
  assert.deepEqual(readdirSync(dir), [ledgerFile(dir).split("/").pop()]);
  const got = rows(dir);
  assert.equal(got.length, 1);
  const { ts, ...row } = got[0];
  assert.ok(!Number.isNaN(Date.parse(ts)) && ts.endsWith("Z"));
  assert.deepEqual(row, {
    v: 1, source: "claude", ref: SID, ns: "tst", worker: "backend", brand: null, task_id: null, task_ids: [],
    model: "claude-test-model", session_id: SID,
    input_tokens: 18, cache_read: 34962, cache_create: 7514, output_tokens: 141, cost_usd: 0.0192472,
    model_usage: { "claude-haiku-4-5-20251001": { input_tokens: 18, output_tokens: 141, cache_read: 34962, cache_create: 7514, cost_usd: 0.0192472 } },
    is_error: false, exit_code: 0, num_turns: RESULT.num_turns, duration_ms: RESULT.duration_ms, launcher: "sdk",
  });
  const text = readFileSync(join(dir, readdirSync(dir)[0]), "utf8");
  assert.ok(!text.includes("sample-ok") && !text.includes(FAKE_KEY), "no tool output, no key in the ledger");
});

test("error result: one row, is_error, exit 1, usage still recorded", () => {
  const r = repo({ usage: true });
  const p = run(r, { mode: "error-result" });
  assert.equal(p.code, 1);
  const got = rows(join(r, "ops", "usage"));
  assert.equal(got.length, 1);
  assert.equal(got[0].is_error, true);
  assert.equal(got[0].exit_code, 1);
  assert.equal(got[0].cost_usd, 0.0192472);
});

test("SDK throws after init: one row with null counts, exit 1", () => {
  const r = repo({ usage: true });
  const p = run(r, { mode: "throw" });
  assert.equal(p.code, 1);
  const got = rows(join(r, "ops", "usage"));
  assert.equal(got.length, 1);
  assert.equal(got[0].session_id, SID);
  assert.equal(got[0].cost_usd, null);
  assert.equal(got[0].input_tokens, null);
  assert.equal(got[0].is_error, true);
});

test("a session stopped for not being on the API key still gets its row (exit 2)", () => {
  const r = repo({ usage: true });
  const p = run(r, { mode: "oauth" });
  assert.equal(p.code, 2);
  assert.equal(rows(join(r, "ops", "usage")).length, 1);
});

test("no session (key file missing): no row", () => {
  const r = repo({ usage: true });
  const p = run(r, { env: { RUNNER_KEY_FILE: join(TMP, "nope.env") } });
  assert.equal(p.code, 2);
  assert.deepEqual(rows(join(r, "ops", "usage")), []);
});

test("two sessions append two rows to the same day's file", () => {
  const r = repo({ usage: true });
  assert.equal(run(r).code, 0);
  assert.equal(run(r, { mode: "error-result" }).code, 1);
  const dir = join(r, "ops", "usage");
  assert.equal(readdirSync(dir).length, 1);
  assert.deepEqual(rows(dir).map((x) => x.exit_code), [0, 1]);
});

test("no ops/usage in the repo and nothing configured: no ledger, nothing created", () => {
  const r = repo();
  const p = run(r);
  assert.equal(p.code, 0, p.err);
  assert.ok(!existsSync(join(r, "ops")));
  assert.ok(!p.err.includes("usage ledger"));
});

test("--usage-dir and RUNNER_USAGE_DIR choose the directory (created if missing); the flag wins", () => {
  const r = repo({ usage: true });
  const viaEnv = join(TMP, "env-ledger", "nested");
  const viaFlag = join(TMP, "flag-ledger");
  assert.equal(run(r, { env: { RUNNER_USAGE_DIR: viaEnv } }).code, 0);
  assert.equal(rows(viaEnv).length, 1);
  assert.equal(run(r, { env: { RUNNER_USAGE_DIR: viaEnv }, extra: ["--usage-dir", viaFlag] }).code, 0);
  assert.equal(rows(viaFlag).length, 1);
  assert.equal(rows(viaEnv).length, 1);
  assert.deepEqual(rows(join(r, "ops", "usage")), []);
});

test("a failed ledger write is one stderr line and never changes the exit code", () => {
  const r = repo();
  const blocker = join(TMP, "a-file");
  writeFileSync(blocker, "x");
  for (const [mode, want] of [["fixture", 0], ["error-result", 1]]) {
    const p = run(r, { mode, extra: ["--usage-dir", join(blocker, "sub")] });
    assert.equal(p.code, want);
    const warn = p.err.split("\n").filter((l) => l.includes("usage ledger"));
    assert.equal(warn.length, 1);
    assert.match(warn[0], /^\[runner\] WARN: usage ledger write failed/);
    assert.ok(!p.err.includes(FAKE_KEY));
  }
});

test("brand and task_id come from the task the session read and finished", () => {
  const r = repo({ usage: true });
  const p = run(r, { mode: "broker-task" });
  assert.equal(p.code, 0, p.err);
  const [row] = rows(join(r, "ops", "usage"));
  assert.equal(row.brand, BROKER_TASK.brand);
  assert.equal(row.task_id, BROKER_TASK.task_id);
  assert.deepEqual(row.task_ids, [BROKER_TASK.task_id]);
  assert.ok(!JSON.stringify(row).includes("PASS — stub"), "no message content in the row");
});

// ── Attribution, in-process ──────────────────────────────────────────────────

const tu = (id, name, input, parent = null) => ({ type: "assistant", parent_tool_use_id: parent, message: { content: [{ type: "tool_use", id, name, input }] } });
const tr = (id, content) => ({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: id, content }] } });
const task = (id, brand) => JSON.stringify({ type: "task", task_id: id, brand, to: "backend" });

test("attribution: get_message's '[#id] ts <sender>: {json}' text and string tool results", () => {
  const a = new Attribution();
  a.observe(tu("t1", "mcp__broker__get_message", { channel: "tst-backend", id: 7 }));
  a.observe(tr("t1", `[#7] 2026-10-29T00:00:00Z <orchestrator>: ${task("tst-a", "client-project")}`));
  assert.deepEqual(a.resolve(), { task_id: "tst-a", task_ids: [], brand: "client-project" });
});

test("attribution: the first task with a result wins; a task it never read has no brand unless a write names one", () => {
  const a = new Attribution();
  a.observe(tu("t1", "mcp__broker__read_messages", { channel: "tst-backend" }));
  a.observe(tr("t1", [{ type: "text", text: JSON.stringify([{ id: 1, content: task("tst-a", "brand-a") }, { id: 2, content: task("tst-b", "brand-b") }]) }]));
  assert.deepEqual(a.resolve(), { task_id: null, task_ids: [], brand: null }, "two tasks read, none finished: unattributed");
  a.observe(tu("t2", "mcp__broker__send_message", { channel: "tst-status", content: JSON.stringify({ type: "result", task_id: "tst-b", summary: "PASS" }) }));
  a.observe(tu("t3", "mcp__broker__post_result", { task_id: "tst-a", summary: "PASS" }));
  assert.deepEqual(a.resolve(), { task_id: "tst-b", task_ids: ["tst-b", "tst-a"], brand: "brand-b" });

  const b = new Attribution();
  b.observe(tu("t1", "mcp__broker__post_note", { kind: "finding", subject: "patrol", body: { brand: "brand-a" } }));
  b.observe(tu("t2", "mcp__broker__post_result", { task_id: "tst-c", summary: "PASS" }));
  assert.deepEqual(b.resolve(), { task_id: "tst-c", task_ids: ["tst-c"], brand: "brand-a" });
});

test("attribution: non-broker tools, subagent events and tasks inside non-broker output are ignored", () => {
  const a = new Attribution();
  a.observe(tu("t1", "Bash", { command: "cat x" }));
  a.observe(tr("t1", task("tst-x", "brand-a")));
  a.observe(tu("t2", "mcp__broker__post_result", { task_id: "tst-y", summary: "PASS" }, "toolu_parent"));
  a.observe({ type: "assistant", message: { content: "not an array" } });
  a.observe(null);
  assert.deepEqual(a.resolve(), { task_id: null, task_ids: [], brand: null });
});

test("buildRow without a result: null counts, is_error true; resolveLedgerDir precedence", () => {
  const row = buildRow({ session: { model: "m" }, identity: { ns: "tst", as: "w" }, result: null, sessionId: "sid-1", attribution: new Attribution(), exitCode: 143, now: new Date("2026-10-29T10:00:00Z") });
  assert.equal(row.ref, "sid-1");
  assert.equal(row.cost_usd, null);
  assert.equal(row.model_usage, null);
  assert.equal(row.is_error, true);
  assert.equal(row.exit_code, 143);
  assert.equal(row.ts, "2026-10-29T10:00:00.000Z");
  assert.equal(resolveLedgerDir({}, {}), null);
  assert.deepEqual(resolveLedgerDir({ repoRoot: "/nonexistent-root" }, {}), null);
  assert.deepEqual(resolveLedgerDir({ repoRoot: "/x" }, { RUNNER_USAGE_DIR: "/env" }), { dir: "/env", create: true });
  assert.deepEqual(resolveLedgerDir({ usageDir: "/flag" }, { RUNNER_USAGE_DIR: "/env" }), { dir: "/flag", create: true });
});
