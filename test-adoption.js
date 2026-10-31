// adopt_namespace / POST /namespaces/:ns/adopt (lib/adoption.js) against its own throwaway broker:
//   - not adopted: --print-channels keeps the legacy key and no role= (parity with the unadopted watchdog)
//   - dry_run needs no token and writes nothing
//   - adopt: token required (none -> 403, wrong -> 403, right -> 200), 409 without a manifest, 503 with no ADMIN_SECRET
//   - adopted: start_worker hands the watchdog WATCHDOG_NS_ADOPTED=1 and the watchdog sends role= and keys on `as`
//   - WATCHDOG_ROLE_URL=0 vetoes adoption; WATCHDOG_ROLE and WATCHDOG_ROLE_URL=1 still win over it
//   - adopt is idempotent, never lowers a cursor, and never touches another namespace's rows
//   - revert copies cursors back and restores the legacy identity
// The broker gets a COPY of WORKERS_CONFIG (when set) plus this run's entries, a stub WATCHDOG_BIN that
// records its environment (and delegates --print-channels to the real watchdog.sh) and an ADMIN_SECRET;
// claude is never launched and the live broker.db and workers file are never touched.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn, spawnSync } from "child_process";
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync, mkdirSync, rmSync } from "fs";
import { startScratchBroker } from "./test-lib-broker.js";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const ROOT   = dirname(fileURLToPath(import.meta.url));
const TAG    = Date.now().toString(36);
const NS     = `ta${TAG}`;       // adopted in this run
const OTHER  = `tb${TAG}`;       // never adopted: must not change
const NOMAN  = `tc${TAG}`;       // no manifest: adopt must 409
const SECRET = `adopt-secret-${process.pid}-${TAG}`;
const ADMIN  = `adopt-admin-${process.pid}-${TAG}`;

let passed = 0, failed = 0;
function expect(cond, label, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); return true; }
  failed++; console.error(`  ✗ ${label}`);
  if (detail !== undefined) console.error(`     detail: ${String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 700)}`);
  process.exitCode = 1; return false;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── scratch broker ───────────────────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), "adopt-test-"));
const workDir = join(dir, "work");
const stubOut = join(dir, "stub-out");
const stub = join(dir, "stub-watchdog.sh");
// Asked for --print-channels it is the real watchdog (the identity derivation under test); asked to
// run it just records what start_worker gave it, so no claude, no polling, no network.
writeFileSync(stub, `#!/usr/bin/env bash
if [[ " $* " == *" --print-channels "* ]]; then exec bash "${join(ROOT, "watchdog.sh")}" "$@"; fi
mkdir -p "${stubOut}"
{ echo "args=$*"; echo "WATCHDOG_NS_ADOPTED=\${WATCHDOG_NS_ADOPTED-<unset>}"; echo "WATCHDOG_NAMESPACE=\${WATCHDOG_NAMESPACE-<unset>}"; } > "${stubOut}/$1.env"
exit 0
`);
chmodSync(stub, 0o755);
mkdirSync(workDir, { recursive: true });

// worker (inbox = path basename) and reviewer (path basename code-reviewer, inbox <ns>-reviewer, so
// legacy key code-reviewer != adopted key reviewer: the rename adoption has to carry cursors across).
const entry = (name, ns, path, inbox) => ({ name, ns, args: [path, "--work-dir", workDir, "--inbox-channel", inbox] });
const ENTRIES = [
  entry(`${NS}-backend`,  NS,    "backend",       `${NS}-backend`),
  entry(`${NS}-reviewer`, NS,    "code-reviewer", `${NS}-reviewer`),
  entry(`${OTHER}-reviewer`, OTHER, "code-reviewer", `${OTHER}-reviewer`),
  entry(`${NOMAN}-backend`,  NOMAN, "backend",       `${NOMAN}-backend`),
];
const live = process.env.WORKERS_CONFIG;
let base = [];
if (live && existsSync(live)) { try { base = JSON.parse(readFileSync(live, "utf8")); } catch {} }
const workersConfig = join(dir, "workers.json");
writeFileSync(workersConfig, JSON.stringify([...base, ...ENTRIES], null, 2));

let broker, brokerOut = "", PORT, BASE, MCP;
async function startBroker(env = {}) {
  brokerOut = "";
  const h = await startScratchBroker({ root: ROOT, onData: d => { brokerOut += d; }, env: (port) => {
    const e = { ...process.env, PORT: String(port), DB_PATH: join(dir, "broker.db"), SHARED_SECRET: SECRET, ADMIN_SECRET: ADMIN,
      WATCHDOG_BIN: stub, WORKERS_CONFIG: workersConfig, WORKERS_LOG_DIR: join(dir, "logs"), WORKERS_TMUX_SESSION: "", TMUX_BIN: "",
      PRUNE_EXEMPT: "", ...env };
    // Nothing from the session that runs this suite may steer the identity under test.
    for (const k of Object.keys(e)) if (/^WATCHDOG_(?!BIN$)/.test(k) || /^BROKER_(URL|SECRET)$/.test(k)) delete e[k];
    if (env.ADMIN_SECRET === "") delete e.ADMIN_SECRET;
    return e;
  } });
  broker = h.proc; PORT = h.port; BASE = h.base; MCP = `${BASE}/mcp`;
}
async function stopBroker() {
  if (!broker) return;
  const b = broker; broker = null;
  await new Promise(r => { b.once("exit", r); b.kill("SIGTERM"); setTimeout(() => b.kill("SIGKILL"), 2000).unref(); });
}

// ── helpers ──────────────────────────────────────────────────────────────────

const H = { authorization: `Bearer ${SECRET}`, "content-type": "application/json" };
async function api(method, path, body) {
  const r = await fetch(`${BASE}${path}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json };
}
const adopt = (ns, body = {}) => api("POST", `/namespaces/${ns}/adopt`, body);
const setCursor = (worker, channel, last_id) => api("PUT", "/cursors", { worker, channel, last_id, force: true });
async function cursors(worker) {
  const r = await api("GET", `/cursors?worker=${encodeURIComponent(worker)}`);
  return Object.fromEntries((r.json?.cursors || []).map(c => [c.channel, c.last_id]));
}
const snapshot = async () => JSON.stringify([await cursors("code-reviewer"), await cursors("reviewer"), await cursors("backend")]);

async function connectAdmin() {
  const transport = new StreamableHTTPClientTransport(new URL(`${MCP}?role=admin`), { requestInit: { headers: { Authorization: `Bearer ${SECRET}` } } });
  const client = new Client({ name: "test-adoption", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

function manifest(ns) {
  const ch = (k) => `${ns}-${k}`;
  return {
    ns, version: "3.0", strict: false,
    workers: [
      { name: "boss", inbox: ch("boss"), role: "orchestrator" },
      { name: "backend", inbox: ch("backend"), role: "worker" },
      { name: "reviewer", inbox: ch("reviewer"), role: "reviewer" },
    ],
    channels: [
      { name: ch("status"), kind: "status", types: ["result", "status"] },
      { name: ch("backend"), kind: "worker-inbox", types: ["task"] },
    ],
  };
}

// watchdog.sh --print-channels exactly as the stub (and so start_worker) runs it, with extra env.
function printChannels(ns, entryName, env = {}) {
  const e = ENTRIES.find(x => x.name === entryName);
  const clean = { ...process.env };
  for (const k of Object.keys(clean)) if (/^WATCHDOG_/.test(k) || /^BROKER_(URL|SECRET)$/.test(k)) delete clean[k];
  const r = spawnSync("bash", [join(ROOT, "watchdog.sh"), ...e.args, "--print-channels"], { env: { ...clean, WATCHDOG_NAMESPACE: ns, ...env }, encoding: "utf8" });
  const pick = (k) => new RegExp(`^${k}=(.*)$`, "m").exec(r.stdout || "")?.[1];
  return { code: r.status, key: pick("key"), as: pick("as"), role: pick("role"), query: pick("mcp_query"), reason: pick("role_url"), out: (r.stdout || "") + (r.stderr || "") };
}

async function startAndRead(name) {
  const file = join(stubOut, `${ENTRIES.find(e => e.name === name).args[0]}.env`);
  rmSync(file, { force: true });
  const r = await api("POST", `/workers/${name}/start`, {});
  for (let i = 0; i < 50 && !existsSync(file); i++) await sleep(100);
  const env = existsSync(file) ? Object.fromEntries(readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])) : null;
  await sleep(200); // let the stub exit so a second start is not "already running"
  return { status: r.status, env };
}

// ── cases ────────────────────────────────────────────────────────────────────

async function testUnadopted() {
  console.log("\n── not adopted: legacy identity ──");
  const rev = printChannels(NS, `${NS}-reviewer`);
  expect(rev.code === 0 && rev.query === `ns=${NS}&as=reviewer` && rev.key === "code-reviewer",
    "reviewer: no role=, key = path basename (code-reviewer), as = reviewer", rev.out);
  const be = printChannels(NS, `${NS}-backend`);
  expect(be.query === `ns=${NS}&as=backend` && be.key === "backend", "backend: no role=, key = basename", be.out);

  const s = await startAndRead(`${NS}-backend`);
  expect(s.status === 200 && s.env?.WATCHDOG_NS_ADOPTED === "0" && s.env?.WATCHDOG_NAMESPACE === NS,
    "start_worker passes WATCHDOG_NS_ADOPTED=0 and the entry's ns", s);

  const st = await api("GET", "/health");
  expect(st.status === 200, "broker healthy with the adoption table", st);
}

async function testTokenAndManifestGates(client) {
  console.log("\n── gates: 409 without manifest, 403 token, dry_run free ──");
  let r = await adopt(NS, { dry_run: true });
  expect(r.status === 409 && /no registered manifest/.test(r.json?.error), "409 without a registered manifest (even for dry_run)", r);
  r = await adopt(NOMAN, { admin_token: ADMIN });
  expect(r.status === 409, "409 for a namespace with workers but no manifest, right token", r);

  for (const n of [NS, OTHER]) {
    const reg = await client.callTool({ name: "register_namespace", arguments: { manifest: JSON.stringify(manifest(n)) } });
    expect(!reg.isError, `register_namespace ${n}`, reg.content?.[0]?.text);
  }

  const before = await snapshot();
  r = await adopt(NS, {});
  expect(r.status === 403 && /admin_token .* is required/.test(r.json?.error), "adopt with no token -> 403, names the requirement", r);
  r = await adopt(NS, { admin_token: "wrong" });
  expect(r.status === 403 && /does not match/.test(r.json?.error), "adopt with a wrong token -> 403", r);
  r = await adopt(NS, { revert: true });
  expect(r.status === 403, "revert with no token -> 403", r);
  r = await api("POST", `/namespaces/${NS}/adopt`, { admin_token: undefined });
  expect(r.status === 403, "an empty body is not a token", r);
  expect((await api("GET", "/health")).status === 200 && (await snapshot()) === before, "refused calls wrote no cursors", before);

  // The header form carries the token too.
  const h = await fetch(`${BASE}/namespaces/${NS}/adopt`, { method: "POST", headers: { ...H, "x-admin-token": ADMIN }, body: JSON.stringify({ dry_run: true }) });
  expect(h.status === 200, "dry_run with X-Admin-Token still fine", h.status);

  const g = await client.callTool({ name: "get_namespace", arguments: { ns: NS } });
  expect(/Adopted: no/.test(g.content?.[0]?.text), "get_namespace reports Adopted: no before adoption", g.content?.[0]?.text.slice(0, 200));
}

async function testDryRun() {
  console.log("\n── dry_run: report only ──");
  await setCursor("code-reviewer", `${NS}-reviewer`, 120);
  await setCursor("code-reviewer", `${OTHER}-reviewer`, 77);   // another namespace's row on the same old key
  await setCursor("backend", `${NS}-backend`, 40);
  const before = await snapshot();
  const r = await adopt(NS, { dry_run: true });                 // no token
  expect(r.status === 200 && r.json?.dry_run === true && r.json?.state_after === "adopted", "dry_run without a token succeeds", r);
  expect(r.json?.entries === 2 && r.json?.renamed?.join() === `${NS}-reviewer`, "reports 2 entries, only the reviewer renamed", [r.json?.entries, r.json?.renamed]);
  const copies = r.json?.cursor_copies || [];
  expect(copies.length === 1 && copies[0].from === "code-reviewer" && copies[0].to === "reviewer" && copies[0].channel === `${NS}-reviewer` && copies[0].last_id === 120 && copies[0].changes === true,
    "plans exactly one copy: code-reviewer -> reviewer on the ns channel", copies);
  expect(r.json?.cursor_rows_written === 0 && (await snapshot()) === before, "dry_run writes no cursor rows", await snapshot());
  const g = (await api("POST", `/namespaces/${NS}/adopt`, { dry_run: true, revert: true })).json;
  expect(g?.note?.includes("not adopted") && g?.cursor_copies?.length === 0, "dry_run revert of an unadopted ns is a no-op report", g);
}

async function testAdopt(client) {
  console.log("\n── adopt: token, cursors, identity ──");
  await setCursor("reviewer", `${NS}-reviewer`, 150);           // already ahead: a copy must not lower it
  await setCursor("code-reviewer", `${NS}-reviewer`, 120);
  const otherBefore = JSON.stringify({ cr: (await cursors("code-reviewer"))[`${OTHER}-reviewer`], rv: (await cursors("reviewer"))[`${OTHER}-reviewer`] });

  let r = await adopt(NS, { admin_token: ADMIN });
  expect(r.status === 200 && r.json?.state_after === "adopted" && r.json?.state_before === "not adopted", "right token -> adopted", r);
  expect((await cursors("reviewer"))[`${NS}-reviewer`] === 150, "an existing higher cursor is kept (copy only raises)", await cursors("reviewer"));
  expect(r.json?.cursor_rows_written === 0 && r.json?.cursor_copies?.[0]?.changes === false, "report says nothing needed copying", r.json?.cursor_copies);

  // A real raise: the old key is ahead.
  await setCursor("code-reviewer", `${NS}-reviewer`, 200);
  const r2 = await adopt(NS, { admin_token: ADMIN });
  expect(r2.status === 200 && (await cursors("reviewer"))[`${NS}-reviewer`] === 200 && r2.json?.cursor_rows_written === 1,
    "idempotent re-adopt raises the new key to the old key's value (1 row)", [r2.json?.cursor_rows_written, await cursors("reviewer")]);
  const r3 = await adopt(NS, { admin_token: ADMIN });
  expect(r3.status === 200 && r3.json?.cursor_rows_written === 0 && r3.json?.state_before === "adopted", "a third adopt changes nothing", r3.json);
  expect((await cursors("code-reviewer"))[`${NS}-reviewer`] === 200, "the old key's row is copied, never moved", await cursors("code-reviewer"));

  const after = JSON.stringify({ cr: (await cursors("code-reviewer"))[`${OTHER}-reviewer`], rv: (await cursors("reviewer"))[`${OTHER}-reviewer`] });
  expect(after === otherBefore && (await cursors("code-reviewer"))[`${OTHER}-reviewer`] === 77 && (await cursors("reviewer"))[`${OTHER}-reviewer`] === undefined,
    "no rows outside the namespace: another ns's code-reviewer cursor was not copied", after);
  expect((await cursors("backend"))[`${NS}-backend`] === 40 && Object.keys(await cursors("backend")).length === 1, "unrenamed backend cursor untouched, no stray backend rows", await cursors("backend"));

  const g = await client.callTool({ name: "get_namespace", arguments: { ns: NS } });
  expect(/Adopted: yes/.test(g.content?.[0]?.text), "get_namespace reports Adopted: yes", g.content?.[0]?.text.slice(0, 200));
  const list = await client.callTool({ name: "get_namespace", arguments: {} });
  expect(new RegExp(`${NS}\\tversion=\\S+\\tbytes=\\d+\\tupdated=\\S+\\tadopted=\\d{4}-`).test(list.content?.[0]?.text) && new RegExp(`${OTHER}\\t.*adopted=no`).test(list.content?.[0]?.text),
    "the namespace list shows adopted=<date> for ns and adopted=no for the other", list.content?.[0]?.text);

  const tool = await client.callTool({ name: "adopt_namespace", arguments: { ns: NS, dry_run: true } });
  expect(!tool.isError && JSON.parse(tool.content[0].text).state_before === "adopted", "the adopt_namespace MCP tool agrees with REST (dry_run)", tool.content?.[0]?.text.slice(0, 200));
  const bad = await client.callTool({ name: "adopt_namespace", arguments: { ns: NS } });
  expect(bad.isError && /admin_token .* is required/.test(bad.content?.[0]?.text), "adopt_namespace tool without a token is refused", bad.content?.[0]?.text);
}

async function testAdoptedIdentity() {
  console.log("\n── adopted: role= and the `as` key ──");
  const rev = printChannels(NS, `${NS}-reviewer`, { WATCHDOG_NS_ADOPTED: "1" });
  expect(rev.query === `role=reviewer&ns=${NS}&as=reviewer` && rev.key === "reviewer" && /adopted/.test(rev.reason || ""),
    "reviewer: role=reviewer in the URL, key = as (reviewer), reason names adoption", rev.out);
  const be = printChannels(NS, `${NS}-backend`, { WATCHDOG_NS_ADOPTED: "1" });
  expect(be.query === `role=worker&ns=${NS}&as=backend` && be.key === "backend", "backend: role=worker", be.out);

  const s = await startAndRead(`${NS}-reviewer`);
  expect(s.status === 200 && s.env?.WATCHDOG_NS_ADOPTED === "1", "start_worker now hands the watchdog WATCHDOG_NS_ADOPTED=1", s);
  const o = await startAndRead(`${OTHER}-reviewer`);
  expect(o.status === 200 && o.env?.WATCHDOG_NS_ADOPTED === "0" && o.env?.WATCHDOG_NAMESPACE === OTHER, "another namespace still gets 0", o);
  const n = await startAndRead(`${NOMAN}-backend`);
  expect(n.env?.WATCHDOG_NS_ADOPTED === "0", "a namespace never adopted gets 0", n);
}

function testPrecedence() {
  console.log("\n── precedence: WATCHDOG_ROLE > ROLE_URL=1 > ROLE_NAMESPACES > adoption; ROLE_URL=0 vetoes ──");
  const A = { WATCHDOG_NS_ADOPTED: "1" };
  let r = printChannels(NS, `${NS}-backend`, { ...A, WATCHDOG_ROLE_URL: "0" });
  expect(r.query === `ns=${NS}&as=backend`, "WATCHDOG_ROLE_URL=0 vetoes adoption (no role=)", r.out);
  r = printChannels(NS, `${NS}-reviewer`, { ...A, WATCHDOG_ROLE_URL: "0" });
  expect(r.query === `ns=${NS}&as=reviewer` && r.key === "code-reviewer", "...and the key stays the path basename", r.out);
  r = printChannels(NS, `${NS}-backend`, { ...A, WATCHDOG_ROLE: "orchestrator", WATCHDOG_ROLE_URL: "0" });
  expect(r.query === `role=orchestrator&ns=${NS}&as=backend` && /WATCHDOG_ROLE set/.test(r.reason), "an explicit WATCHDOG_ROLE beats the veto", r.out);
  r = printChannels(NS, `${NS}-backend`, { ...A, WATCHDOG_ROLE_URL: "1" });
  expect(/WATCHDOG_ROLE_URL=1/.test(r.reason), "WATCHDOG_ROLE_URL=1 is reported ahead of adoption", r.out);
  r = printChannels(NS, `${NS}-backend`, { ...A, WATCHDOG_ROLE_NAMESPACES: NS });
  expect(/WATCHDOG_ROLE_NAMESPACES/.test(r.reason), "WATCHDOG_ROLE_NAMESPACES is reported ahead of adoption", r.out);
  r = printChannels(NS, `${NS}-backend`, { WATCHDOG_NS_ADOPTED: "0" });
  expect(r.query === `ns=${NS}&as=backend`, "WATCHDOG_NS_ADOPTED=0 means off", r.out);
}

async function testRevert(client) {
  console.log("\n── revert: copy back, legacy identity ──");
  await setCursor("reviewer", `${NS}-reviewer`, 260);          // advanced while adopted
  await setCursor("backend", `${NS}-backend`, 55);
  let r = await adopt(NS, { revert: true, admin_token: "nope" });
  expect(r.status === 403, "revert with a wrong token -> 403", r);
  r = await adopt(NS, { revert: true, dry_run: true });
  expect(r.status === 200 && r.json?.cursor_copies?.[0]?.from === "reviewer" && r.json?.cursor_copies?.[0]?.to === "code-reviewer" && r.json?.cursor_rows_written === 0,
    "revert dry_run plans reviewer -> code-reviewer and writes nothing", r.json?.cursor_copies);
  expect((await cursors("code-reviewer"))[`${NS}-reviewer`] === 200, "...old key unchanged after the dry run", await cursors("code-reviewer"));

  r = await adopt(NS, { revert: true, admin_token: ADMIN });
  expect(r.status === 200 && r.json?.state_after === "not adopted" && r.json?.state_before === "adopted", "revert with the token", r);
  expect((await cursors("code-reviewer"))[`${NS}-reviewer`] === 260, "the legacy key got the cursor the adopted key had advanced to", await cursors("code-reviewer"));
  expect((await cursors("reviewer"))[`${NS}-reviewer`] === 260, "the adopted key's row is copied, not removed", await cursors("reviewer"));
  expect((await cursors("code-reviewer"))[`${OTHER}-reviewer`] === 77, "another ns's legacy cursor is untouched by revert", await cursors("code-reviewer"));

  const s = await startAndRead(`${NS}-reviewer`);
  expect(s.env?.WATCHDOG_NS_ADOPTED === "0", "start_worker is back to WATCHDOG_NS_ADOPTED=0", s);
  const again = await adopt(NS, { revert: true, admin_token: ADMIN });
  expect(again.status === 200 && /nothing to revert/.test(again.json?.note) && again.json?.cursor_rows_written === 0, "reverting twice is a no-op", again.json);
  const g = await client.callTool({ name: "get_namespace", arguments: { ns: NS } });
  expect(/Adopted: no/.test(g.content?.[0]?.text), "get_namespace reports Adopted: no again", g.content?.[0]?.text.slice(0, 200));
  r = await adopt(NS, { admin_token: ADMIN });
  expect(r.status === 200 && r.json?.state_after === "adopted", "a reverted namespace can be adopted again", r);
}

async function testPersistsAndNoAdminSecret() {
  console.log("\n── adoption survives a restart; no ADMIN_SECRET -> 503 ──");
  await stopBroker();
  await startBroker();
  const g = await (await connectAdmin()).callTool({ name: "get_namespace", arguments: { ns: NS } });
  expect(/Adopted: yes/.test(g.content?.[0]?.text), "adopted state is read from the DB after a broker restart", g.content?.[0]?.text.slice(0, 200));
  await stopBroker();
  await startBroker({ ADMIN_SECRET: "" });
  const dry = await adopt(NS, { dry_run: true });
  expect(dry.status === 200, "dry_run still works with no ADMIN_SECRET", dry);
  const r = await adopt(NS, { admin_token: ADMIN });
  expect(r.status === 503 && /no ADMIN_SECRET/.test(r.json?.error), "adopt with no ADMIN_SECRET configured -> 503", r);
}

(async () => {
  try {
    await startBroker();
    const client = await connectAdmin();
    await testUnadopted();
    await testTokenAndManifestGates(client);
    await testDryRun();
    await testAdopt(client);
    await testAdoptedIdentity();
    testPrecedence();
    await testRevert(client);
    await client.close().catch(() => {});
    await testPersistsAndNoAdminSecret();
  } catch (e) {
    failed++; process.exitCode = 1;
    console.error("FATAL:", e?.stack || e, "\n" + brokerOut.slice(-1500));
  } finally {
    await stopBroker();
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
