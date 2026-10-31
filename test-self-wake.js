// Self-wake guard: a worker's own posts never count as pending work on its wake checks.
//   - GET /inbox exclude_sender (comma list): the excluded senders' messages do not count toward
//     pending/count, max_id still advances past them; another sender's post still counts; no
//     exclude_sender = the old response, byte for byte; the long-poll variant is not woken by an
//     excluded sender and is woken by anyone else
//   - exclude_sender and JSON from: a message is excluded only when its sender is excluded AND (its
//     content is not a JSON object with a string 'from', or that 'from' is excluded too); a foreign
//     same-name sender whose from names another worker (dv-core) still wakes, also on the long-poll
//   - watchdog.sh identity: self_senders = as=, the worker path basename, WATCHDOG_SELF_SENDERS; the
//     judge (entry cb-judge, workers/judge, inbox cb-judge) comes out as 'judge'
//   - watchdog.sh wake checks: the real check_inbox / patrol function (extracted from the script) on a
//     channel the worker just posted to reports nothing pending; a post from someone else wakes it
//   - runner/run-worker.mjs deriveIdentity carries the same selfSenders
//   - MCP exclude_self (role connections only): has_messages (self = as=) and wait_for_messages (self = worker=, else
//     as=) use the same sender/from rule; own posts neither count nor wake, a foreign post does, sender=self with a
//     foreign from does; the wake returns own rows too; omitted = the old output, byte for byte; the no-role list has
//     no exclude_self; no self to name = an error

import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync, mkdtempSync, rmSync } from "fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startScratchBroker } from "./test-lib-broker.js";

// run-tests.js passes BROKER_URL + SHARED_SECRET. Standalone (no BROKER_URL) the suite starts its own scratch broker
// with a throwaway secret; .env is never read, so it cannot pick up the live secret, and port 8080 is refused.
const ROOT = dirname(fileURLToPath(import.meta.url));
let BROKER_URL = process.env.BROKER_URL || "";
let SECRET     = BROKER_URL ? process.env.SHARED_SECRET || "" : "";
let scratch = null, scratchDir = null;
if (BROKER_URL && new URL(BROKER_URL).port === "8080") {
  console.error(`[self-wake] refusing to run against port 8080 (the live broker): ${BROKER_URL}`);
  process.exit(1);
}
if (!BROKER_URL) {
  scratchDir = mkdtempSync(join(tmpdir(), "self-wake-"));
  SECRET = `sw-secret-${process.pid}-${Date.now().toString(36)}`;
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(WATCHDOG|BROKER|FOLLOWUP|VERIFY|VERIFIER)_/.test(k) || ["PORT", "DB_PATH", "ADMIN_SECRET", "PRUNE_EXEMPT", "WORKERS_CONFIG", "WORKERS_LOG_DIR"].includes(k)) delete env[k];
  scratch = await startScratchBroker({ root: ROOT, env: (port) => ({ ...env, DOTENV_CONFIG_PATH: "/dev/null", PORT: String(port),
    DB_PATH: join(scratchDir, "broker.db"), SHARED_SECRET: SECRET, WATCHDOG_BIN: "", WORKERS_TMUX_SESSION: "", TMUX_BIN: "",
    WORKERS_CONFIG: join(scratchDir, "workers.json"), WORKERS_LOG_DIR: join(scratchDir, "logs") }) });
  BROKER_URL = `${scratch.base}/mcp`;
  console.log(`[self-wake] standalone: scratch broker on port ${scratch.port}`);
}
function stopScratch() {
  if (scratch) { scratch.proc.kill("SIGKILL"); scratch = null; }
  if (scratchDir) { rmSync(scratchDir, { recursive: true, force: true }); scratchDir = null; }
}
const BASE_URL   = BROKER_URL.replace(/\/mcp\/?$/, "");
const AUTH       = SECRET ? { authorization: `Bearer ${SECRET}` } : {};

let passed = 0, failed = 0;
function expect(cond, label, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); return true; }
  failed++; console.error(`  ✗ ${label}`); if (detail !== undefined) console.error(`     detail: ${JSON.stringify(detail).slice(0, 700)}`);
  process.exitCode = 1; return false;
}

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const post = async (channel, sender, content) => {
  const r = await fetch(`${BASE_URL}/messages`, { method: "POST", headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ channel, sender, content }) });
  const j = await r.json(); return j.id ?? j.message_id;
};
const inbox = async (qs) => (await fetch(`${BASE_URL}/inbox?${qs}`, { headers: AUTH })).json();
const inboxRaw = async (qs) => (await fetch(`${BASE_URL}/inbox?${qs}`, { headers: AUTH })).text();

async function httpInbox() {
  console.log("\n[1] GET /inbox exclude_sender");
  const ch = `sw${RUN}-status`;
  const patrol = JSON.stringify({ type: "status", task_id: "sw-judge-patrol", subject: "judge patrol" });
  const id1 = await post(ch, "judge", patrol);
  expect(Number.isInteger(id1), "judge posted its patrol status", id1);

  let r = await inbox(`channel=${ch}&since_id=0&exclude_sender=judge`);
  expect(r.pending === false && r.count === 0, "own patrol status on the watched channel: nothing pending", r);
  expect(r.max_id === id1, "max_id still advances past the excluded message", r);
  r = await inbox(`channel=${ch}&since_id=0`);
  expect(r.pending === true && r.count === 1 && r.max_id === id1, "no exclude_sender: the old behaviour (own post counts)", r);
  const before = await inboxRaw(`channel=${ch}&since_id=0`);
  expect(!before.includes("exclude"), "no exclude_sender: response has no new field", before);

  const id2 = await post(ch, "core", JSON.stringify({ type: "result", task_id: "sw-t1", summary: "PASS — x" }));
  r = await inbox(`channel=${ch}&since_id=0&exclude_sender=judge`);
  expect(r.pending === true && r.count === 1 && r.max_id === id2, "another sender's post still wakes it (count 1, max_id = its id)", r);
  r = await inbox(`channel=${ch}&since_id=0&exclude_sender=${encodeURIComponent("judge, core ,")}`);
  expect(r.pending === false && r.count === 0 && r.max_id === id2, "comma list (spaces, empty item) excludes every name", r);
  r = await inbox(`channel=${ch}&since_id=${id1}&exclude_sender=judge`);
  expect(r.count === 1 && r.since_id === id1, "since_id still applies with exclude_sender", r);
  r = await inbox(`channel=${ch}&since_id=${id2}&exclude_sender=judge`);
  expect(r.pending === false && r.count === 0 && r.max_id === 0, "nothing after since_id: max_id 0 as before", r);
}

async function httpInboxFrom() {
  console.log("\n[1b] GET /inbox exclude_sender matches JSON from too");
  const ch = `sw${RUN}-core`;
  const q = `channel=${ch}&since_id=0&exclude_sender=core`;
  const own = [
    await post(ch, "core", JSON.stringify({ type: "status", from: "core", subject: "own, from matches" })),
    await post(ch, "core", JSON.stringify({ type: "status", subject: "own, no from" })),
    await post(ch, "core", JSON.stringify({ type: "status", from: 7, subject: "own, from not a string" })),
    await post(ch, "core", JSON.stringify(["array", "content"])),
    await post(ch, "core", "plain text, not JSON"),
  ];
  let r = await inbox(q);
  expect(r.pending === false && r.count === 0 && r.max_id === own[4], "excluded sender with from = itself / no from / non-string from / non-object / text: nothing pending", r);
  const foreign = await post(ch, "core", JSON.stringify({ type: "task", from: "dv-core", to: "core", subject: "another fleet's core" }));
  r = await inbox(q);
  expect(r.pending === true && r.count === 1 && r.max_id === foreign, "excluded sender whose from names another worker (dv-core) still wakes", r);
  r = await inbox(`channel=${ch}&since_id=0&exclude_sender=core,dv-core`);
  expect(r.pending === false && r.count === 0, "…unless that from is in the list too", r);
  r = await inbox(`channel=${ch}&since_id=${foreign}&exclude_sender=core`);
  expect(r.pending === false && r.max_id === 0, "since_id past it: nothing pending", r);
  const t0 = Date.now();
  const p = inbox(`channel=${ch}&since_id=${foreign}&exclude_sender=core&wait_ms=5000`);
  await new Promise(r => setTimeout(r, 200));
  await post(ch, "core", JSON.stringify({ type: "status", from: "core" }));
  await new Promise(r => setTimeout(r, 200));
  const f2 = await post(ch, "core", JSON.stringify({ type: "note", from: "mg-core" }));
  r = await p;
  expect(r.pending === true && r.count === 1 && r.max_id === f2 && Date.now() - t0 < 4000, "long-poll: own post does not wake, a foreign from does", { r, ms: Date.now() - t0 });
  r = await inbox(`channel=${ch}&since_id=0`);
  expect(r.count === 8, "no exclude_sender: every message counts as before", r);
}

async function httpLongPoll() {
  console.log("\n[2] GET /inbox long-poll with exclude_sender");
  const ch = `sw${RUN}-lp`;
  let t0 = Date.now();
  let p = inbox(`channel=${ch}&since_id=0&exclude_sender=judge&wait_ms=1500`);
  await new Promise(r => setTimeout(r, 200));
  const own = await post(ch, "judge", "{}");
  let r = await p;
  expect(r.pending === false && r.count === 0 && Date.now() - t0 >= 1400, "own post during the wait does not wake the long-poll", { r, ms: Date.now() - t0 });
  expect(r.max_id === own, "…and the timed-out reply carries max_id past it", r);

  t0 = Date.now();
  p = inbox(`channel=${ch}&since_id=${own}&exclude_sender=judge&wait_ms=5000`);
  await new Promise(r => setTimeout(r, 200));
  await post(ch, "judge", "{}");
  await new Promise(r => setTimeout(r, 200));
  const other = await post(ch, "orchestrator", JSON.stringify({ type: "task", task_id: "sw-t2" }));
  r = await p;
  expect(r.pending === true && r.count === 1 && r.max_id === other && Date.now() - t0 < 4000, "another sender's post wakes it early", { r, ms: Date.now() - t0 });
}

function printChannels(worker, inboxCh, env = {}) {
  const clean = { ...process.env };
  for (const k of ["WATCHDOG_ROLE", "WATCHDOG_ROLE_URL", "WATCHDOG_ROLE_NAMESPACES", "WATCHDOG_AS", "WATCHDOG_SELF_SENDERS", "WATCHDOG_NAMESPACE", "WATCHDOG_NS_ADOPTED"]) delete clean[k];
  const r = spawnSync("bash", [join(ROOT, "watchdog.sh"), worker, "--work-dir", tmpdir(), "--inbox-channel", inboxCh, "--print-channels"], { env: { ...clean, ...env }, encoding: "utf8" });
  return { code: r.status, self: /^self_senders=(.*)$/m.exec(r.stdout || "")?.[1], out: (r.stdout || "") + (r.stderr || "") };
}

async function watchdogIdentity() {
  console.log("\n[3] watchdog.sh self_senders");
  let r = printChannels("workers/judge", "cb-judge");
  expect(r.code === 0 && r.self === "judge", "judge (workers/judge, inbox cb-judge): self_senders=judge", r.out);
  r = printChannels("workers/judge", "cb-judge", { WATCHDOG_SELF_SENDERS: "cb-judge, judge,bad name" });
  expect(r.self === "judge,cb-judge", "WATCHDOG_SELF_SENDERS adds names, deduped; invalid names dropped", r.out);
  r = printChannels("workers/protocol-qa", "cb-protocol-qa", { WATCHDOG_AS: "qa" });
  expect(r.self === "qa,protocol-qa", "WATCHDOG_AS plus the path basename (heartbeat sender when not opted in)", r.out);
  r = printChannels("workers/backend", "dv-backend-services", { WATCHDOG_ROLE_URL: "1" });
  expect(r.self === "backend-services,backend", "opted in: as= (also the key) and the basename", r.out);

  const { deriveIdentity } = await import("./runner/run-worker.mjs");
  const id = deriveIdentity({ worker: "workers/judge", inboxChannel: "cb-judge" }, { WATCHDOG_SELF_SENDERS: "cb-judge" });
  expect(JSON.stringify(id.selfSenders) === JSON.stringify(["judge", "cb-judge"]), "run-worker.mjs deriveIdentity: same selfSenders", id);
}

// The real wake-check functions, cut out of watchdog.sh and run against the scratch broker.
async function watchdogChecks() {
  console.log("\n[4] watchdog.sh check_inbox / patrol check");
  const src = readFileSync(join(ROOT, "watchdog.sh"), "utf8");
  const fn = (name) => { const m = new RegExp(`^${name}\\(\\) \\{.*\\}$|^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}$`, "m").exec(src); return m ? m[0] : ""; };
  const defs = [fn("_curl"), fn("check_channel_for_work"), fn("check_inbox")];
  expect(defs.every(Boolean), "check functions found in watchdog.sh", defs);
  expect(/PATROL_JSON=\$\(check_channel_for_work "\$PATROL_WATCH_CHANNEL"/.test(src), "the patrol check uses the excluding check", null);
  expect(/INBOX_JSON=\$\(check_inbox "\$CURSOR"\)/.test(src), "the inbox check uses check_inbox", null);
  const cfg = join(tmpdir(), `sw-curl-${RUN}`);
  const run = (fnCall, env) => spawnSync("bash", ["-c", `${defs.join("\n")}\n${fnCall}`], {
    encoding: "utf8", env: { ...process.env, BROKER_URL: BASE_URL, _CURL_CFG: "", SECRET, ...env } });
  const call = (f, ch, since) => {
    const hdr = SECRET ? `_curl() { curl -H "Authorization: Bearer $SECRET" "$@"; }; ` : "";
    const r = run(`${hdr}${f} ${ch ? `"${ch}" ` : ""}"${since}"`, { SELF_SENDERS: "judge", INBOX_CHANNEL: `sw${RUN}-judge` });
    try { return JSON.parse(r.stdout); } catch { return { raw: r.stdout + r.stderr }; }
  };
  void cfg;

  const watch = `sw${RUN}-patrol-status`;
  const own = await post(watch, "judge", JSON.stringify({ type: "status", task_id: "cb-judge-patrol", subject: "judge patrol" }));
  let r = call("check_channel_for_work", watch, 0);
  expect(r.pending === false && r.max_id === own, "patrol check right after the judge's own patrol status: nothing pending", r);
  const other = await post(watch, "core", JSON.stringify({ type: "result", task_id: "sw-t3", summary: "PASS — y" }));
  r = call("check_channel_for_work", watch, own);
  expect(r.pending === true && r.count === 1 && r.max_id === other, "a result from core still triggers the patrol", r);

  await post(`sw${RUN}-judge`, "judge", "{}");
  r = call("check_inbox", "", 0);
  expect(r.pending === false && r.count === 0, "check_inbox: own post on own inbox does not wake", r);
  await post(`sw${RUN}-judge`, "orchestrator", JSON.stringify({ type: "task", task_id: "sw-t4" }));
  r = call("check_inbox", "", 0);
  expect(r.pending === true && r.count === 1, "check_inbox: a task from the orchestrator wakes", r);
}

async function mcp(query) {
  const client = new Client({ name: "self-wake", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BROKER_URL}${query}`), { requestInit: { headers: AUTH } }));
  const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); return { text: r.content?.[0]?.text ?? "", isError: !!r.isError }; };
  return { client, call };
}

async function mcpExcludeSelf() {
  console.log("\n[5] MCP exclude_self on has_messages / wait_for_messages");
  const ns = `sw${RUN}`, ch = `${ns}-mcp`;
  const role = await mcp(`?role=worker&ns=${ns}&as=core`);
  const noAs = await mcp(`?role=worker&ns=${ns}`);
  const v2   = await mcp("");
  const props = async (c, tool) => (await c.client.listTools()).tools.find(t => t.name === tool)?.inputSchema?.properties ?? {};
  for (const tool of ["has_messages", "wait_for_messages"]) {
    expect("exclude_self" in await props(role, tool), `${tool}: a role connection's schema has exclude_self`);
    expect(!("exclude_self" in await props(v2, tool)), `${tool}: the no-role (v2) schema does not`);
  }
  const has = (c, args) => c.call("has_messages", { channel: ch, ...args }).then(r => r.isError ? r : JSON.parse(r.text));

  const own = [
    await post(ch, "core", JSON.stringify({ type: "status", from: "core", subject: "own" })),
    await post(ch, "core", "plain text, not JSON"),
  ];
  let r = await has(role, { exclude_self: true });
  expect(r.pending === false && r.max_id === own[1], "has_messages exclude_self: own posts do not count, max_id still covers them", r);
  const omitted = await role.call("has_messages", { channel: ch });
  expect(omitted.text === (await v2.call("has_messages", { channel: ch })).text && JSON.parse(omitted.text).pending === true,
    "has_messages without exclude_self: identical to the v2 output (own posts count)", omitted);
  r = await v2.call("has_messages", { channel: ch, exclude_self: true });
  expect(r.text === omitted.text, "no-role connection: exclude_self is ignored (old behaviour)", r);
  r = await has(noAs, { exclude_self: true });
  expect(r.isError && /as=/.test(r.text), "has_messages exclude_self with no as=: an error, not a silent ignore", r);
  const sameName = await post(ch, "core", JSON.stringify({ type: "task", from: "dv-core", subject: "another fleet's core" }));
  r = await has(role, { since_id: own[1], exclude_self: true });
  expect(r.pending === true && r.max_id === sameName, "sender=core with a foreign from (dv-core) counts", r);
  r = await has(role, { since_id: sameName, exclude_self: true });
  expect(r.pending === false && r.max_id === 0, "nothing after since_id: as before", r);

  // wait_for_messages
  const wait = (c, args) => c.call("wait_for_messages", { channel: ch, timeout_ms: 1200, ...args });
  const same = await wait(role, { since_id: own[0] });
  expect(same.text === (await wait(v2, { since_id: own[0] })).text && same.text.includes(`#${own[1]}`),
    "wait_for_messages without exclude_self: identical to the v2 output (own post returns at once)", same);
  let t0 = Date.now();
  r = await wait(role, { since_id: 0, worker: "core", exclude_self: true, filter_type: "status" });
  expect(/^No new messages/.test(r.text) && Date.now() - t0 >= 1100, "only own rows pending (worker=core): no wake, times out", { r, ms: Date.now() - t0 });
  r = await wait(noAs, { since_id: 0, exclude_self: true });
  expect(r.isError && /worker=/.test(r.text), "wait_for_messages exclude_self with no worker= and no as=: an error", r);

  const ch2 = `${ns}-mcp2`;
  const base = await post(ch2, "orchestrator", "{}");
  t0 = Date.now();
  let p = role.call("wait_for_messages", { channel: ch2, since_id: base, exclude_self: true, timeout_ms: 5000 });
  await new Promise(r => setTimeout(r, 200));
  const o1 = await post(ch2, "core", JSON.stringify({ type: "status", from: "core" }));
  await new Promise(r => setTimeout(r, 300));
  const f1 = await post(ch2, "orchestrator", JSON.stringify({ type: "task", task_id: "sw-t5" }));
  r = await p;
  expect(r.text.includes(`#${f1}`) && r.text.includes(`#${o1}`) && Date.now() - t0 < 4000,
    "own post during the wait (as=core) does not wake; a foreign one does, and the wake returns both", { r, ms: Date.now() - t0 });
  p = role.call("wait_for_messages", { channel: ch2, since_id: f1, exclude_self: true, timeout_ms: 5000 });
  await new Promise(r => setTimeout(r, 200));
  const f2 = await post(ch2, "core", JSON.stringify({ type: "note", from: "mg-core" }));
  r = await p;
  expect(r.text.includes(`#${f2}`), "sender=core with a foreign from (mg-core) wakes", r);
  r = await role.call("wait_for_messages", { channel: ch2, since_id: o1 - 1, worker: "judge", exclude_self: true, timeout_ms: 1000 });
  expect(r.text.includes(`#${o1}`), "worker= names self (judge), so core's post is foreign and returns at once", r);

  // The peek must not move the cursor: after an own-only wait times out, a cursor read still sees the own row.
  const ch3 = `${ns}-mcp3`;
  await post(ch3, "x", "{}");
  await role.call("read_messages", { channel: ch3, worker: "core" });
  const o3 = await post(ch3, "core", "{}");
  r = await role.call("wait_for_messages", { channel: ch3, worker: "core", exclude_self: true, timeout_ms: 800 });
  expect(/^No new messages/.test(r.text), "own-only rows after the cursor: no wake", r);
  r = await role.call("read_messages", { channel: ch3, worker: "core" });
  expect(r.text.includes(`#${o3}`), "…and the cursor did not move past them", r);
  for (const c of [role, noAs, v2]) await c.client.close();
}

async function main() {
  await httpInbox();
  await httpInboxFrom();
  await httpLongPoll();
  await watchdogIdentity();
  await watchdogChecks();
  await mcpExcludeSelf();
  console.log(`\n[self-wake] ${passed} passed, ${failed} failed`);
}
main().then(stopScratch, e => { console.error(e); stopScratch(); process.exit(1); });
