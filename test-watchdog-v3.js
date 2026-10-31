// Watchdog v3 behaviour, driven through its environment against a stub `claude`:
//   - context size is read from the session's stream-json output and reported on heartbeats;
//     rotation_recommended flips at ROTATE_AT_TOKENS
//   - ROTATE_KILL_AFTER_S terminates a session that stays over the threshold and relaunches fresh
//   - a clean exit with open tasks in the ledger (handoff) triggers follow-up launches, capped by
//     FOLLOWUP_MAX, and a completed task ends them
//   - an API-unreachable session (ENOTFOUND …) backs off exponentially (NET_BACKOFF_BASE/MAX),
//     the backoff is annotated on the heartbeat, and a successful session resets it
//   - ENOTFOUND inside tool output is not mistaken for an unreachable API
//   - a session killed for rotation or timeout (or crashed with a dirty worktree) without handoff_notes
//     gets a watchdog fallback handoff (git state, task back in the ledger as handoff); none when the
//     session posted its own, and none for a crash that left the worktree clean; a crash loop on the same
//     dirty worktree posts exactly one, and a rate-limited exit posts none (a rotation kill still does)
//   - a rate limit is read from stderr / error events only: '429' in an id or a result is not one
// Asserts on the watchdog's observable behaviour (log lines, broker messages), not on its internals:
// watchdog.sh is still being reconciled with the live copy. Requires a running broker
// (run-tests.js starts a throwaway one); never touches claude or the network.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn, spawnSync } from "child_process";
import { mkdtempSync, writeFileSync, chmodSync, readdirSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const ROOT       = dirname(fileURLToPath(import.meta.url));
const BROKER_URL = process.env.BROKER_URL || "http://localhost:8080/mcp";
const BASE_URL   = BROKER_URL.replace(/\/mcp\/?$/, "");
const SECRET     = process.env.SHARED_SECRET || "";
const TAG        = Date.now().toString(36);

let passed = 0, failed = 0;
function expect(cond, label, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); return true; }
  failed++; console.error(`  ✗ ${label}`); if (detail !== undefined) console.error(`     detail: ${String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 700)}`);
  process.exitCode = 1; return false;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function connect(name) {
  const transport = new StreamableHTTPClientTransport(new URL(BROKER_URL), {
    requestInit: SECRET ? { headers: { Authorization: `Bearer ${SECRET}` } } : {},
  });
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  return client;
}

// A stand-in for the claude CLI. Each launch takes the next action from FAKE_PLAN (comma-separated;
// the last one repeats):
//   ok                 exit 0 at once, posting nothing
//   result             post a PASS result for FAKE_TASK to FAKE_STATUS, exit 0
//   handoff            post a status with handoff_notes for FAKE_TASK, exit 0 (the task stays open)
//   progress           post an in-progress status for FAKE_TASK, exit 0 (the task stays open)
//   big:<tokens>:<s>   report <tokens> of context in stream-json (input+cache), then run for <s> seconds
//   readbig:<t>:<s>    read the inbox through the broker as worker 'backend' (advances its cursor), then big
//   bighandoff:<t>:<s> big, but post a handoff status once the watchdog's rotation flag (FAKE_FLAG) exists
//   fail               exit 3 at once
//   ratelimit          fail like a rate-limited API: stderr "429 rate limit", exit 1
//   rlevent            fail like a rate-limited API in stream-json: is_error result, api_error_status 429, exit 1
//   rlnoise            exit 1 after a message id and a successful result that merely mention 429 / rate limits
//   rlbig:<t>:<s>      stderr "429 rate limit", then big:<t>:<s>
//   enotfound          fail like an unreachable API: stderr getaddrinfo ENOTFOUND, exit 1
//   toolnoise          exit 1 after a stream-json tool result that merely mentions ENOTFOUND
function writeFakeClaude(dir) {
  const bin = join(dir, "fake-claude");
  writeFileSync(bin, `#!/usr/bin/env bash
if [[ "\${1:-}" == "--help" ]]; then echo "  --strict-mcp-config   Only use MCP servers from --mcp-config"; exit 0; fi
n=$(( $(cat "$FAKE_DIR/count" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$FAKE_DIR/count"
IFS=, read -ra plan <<< "$FAKE_PLAN"
idx=$(( n - 1 )); [[ $idx -ge \${#plan[@]} ]] && idx=$(( \${#plan[@]} - 1 ))
act="\${plan[$idx]}"
echo "launch $n $act" >> "$FAKE_DIR/launches"
post() { node -e 'fetch(process.env.BROKER_URL+"/messages",{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+process.env.BROKER_SECRET},body:JSON.stringify({channel:process.argv[1],sender:"backend",content:process.argv[2]})})' "$1" "$2"; }
case "$act" in
  ok) exit 0 ;;
  result)   post "$FAKE_STATUS" "{\\"type\\":\\"result\\",\\"task_id\\":\\"$FAKE_TASK\\",\\"from\\":\\"backend\\",\\"to\\":\\"orchestrator\\",\\"subject\\":\\"fake\\",\\"summary\\":\\"PASS — fake\\"}"; exit 0 ;;
  handoff)  post "$FAKE_STATUS" "{\\"type\\":\\"status\\",\\"task_id\\":\\"$FAKE_TASK\\",\\"from\\":\\"backend\\",\\"to\\":\\"orchestrator\\",\\"subject\\":\\"rotating\\",\\"body\\":{\\"handoff_notes\\":{\\"done\\":\\"half\\",\\"pending\\":\\"half\\",\\"next_step\\":\\"finish\\"}}}"; exit 0 ;;
  progress) post "$FAKE_STATUS" "{\\"type\\":\\"status\\",\\"task_id\\":\\"$FAKE_TASK\\",\\"from\\":\\"backend\\",\\"to\\":\\"orchestrator\\",\\"subject\\":\\"working\\",\\"body\\":\\"still going\\"}"; exit 0 ;;
  big:*|readbig:*|bighandoff:*|rlbig:*)
    IFS=: read -r kind tok secs <<< "$act"
    [[ "$kind" == rlbig ]] && echo "API Error: 429 rate limit exceeded" >&2
    [[ "$kind" == readbig ]] && node -e 'fetch(process.env.BROKER_URL+"/mcp",{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream",authorization:"Bearer "+process.env.BROKER_SECRET},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"read_messages",arguments:{channel:process.argv[1],worker:"backend"}}})}).then(r=>r.text())' "$FAKE_INBOX"
    a=$(( tok / 10 )); b=$(( tok / 2 )); c=$(( tok - a - b ))
    echo "{\\"type\\":\\"assistant\\",\\"session_id\\":\\"sess-$n\\",\\"message\\":{\\"usage\\":{\\"input_tokens\\":$a,\\"cache_read_input_tokens\\":$b,\\"cache_creation_input_tokens\\":$c,\\"output_tokens\\":5}}}"
    if [[ "$kind" == bighandoff ]]; then
      for _ in $(seq 1 60); do [[ -f "$FAKE_FLAG" ]] && break; sleep 0.25; done
      post "$FAKE_STATUS" "{\\"type\\":\\"status\\",\\"task_id\\":\\"$FAKE_TASK\\",\\"from\\":\\"backend\\",\\"to\\":\\"orchestrator\\",\\"subject\\":\\"rotating\\",\\"body\\":{\\"handoff_notes\\":{\\"done\\":\\"half\\",\\"pending\\":\\"half\\",\\"next_step\\":\\"finish\\"}}}"
    fi
    exec sleep "$secs" ;;
  fail) exit 3 ;;
  ratelimit) echo "API Error: 429 rate limit exceeded" >&2; exit 1 ;;
  rlevent)
    echo '{"type":"result","subtype":"error_during_execution","is_error":true,"api_error_status":429,"result":"API Error: request rejected"}'
    exit 1 ;;
  rlnoise)
    echo '{"type":"assistant","session_id":"sess-rl","message":{"id":"msg_01429ab","content":[{"type":"text","text":"handled the 429 rate limit retry"}],"usage":{"input_tokens":10,"output_tokens":5}}}'
    echo '{"type":"user","message":{"content":[{"type":"tool_result","content":"HTTP 429 Too Many Requests in fixture"}]}}'
    echo '{"type":"result","subtype":"success","is_error":false,"result":"Fixed the rate-limit heuristic: 429 now anchored (see cb-status#18429)"}'
    exit 1 ;;
  enotfound) echo "Error: getaddrinfo ENOTFOUND api.anthropic.com" >&2; exit 1 ;;
  toolnoise)
    echo '{"type":"user","message":{"content":[{"type":"tool_result","content":"curl: getaddrinfo ENOTFOUND example.invalid"}]}}'
    exit 1 ;;
esac
exit 0
`);
  chmodSync(bin, 0o755);
  return bin;
}

// Run the real watchdog (not --once) and watch its log. stop() ends it and waits for the exit.
function startWatchdog({ ns, dir, plan, env = {}, task = "" }) {
  const status = `${ns}-status`;
  const p = spawn("bash", [join(ROOT, "watchdog.sh"), "backend", "--work-dir", dir, "--inbox-channel", `${ns}-backend`], {
    env: {
      ...process.env, BROKER_URL: BASE_URL, BROKER_SECRET: SECRET, CLAUDE_BIN: join(dir, "fake-claude"),
      FAKE_DIR: dir, FAKE_PLAN: plan, FAKE_STATUS: status, FAKE_TASK: task, FAKE_INBOX: `${ns}-backend`, FAKE_FLAG: `/tmp/watchdog-backend-${ns}-backend-rotate-flag`,
      WATCHDOG_JITTER_MAX: "0", WATCHDOG_HEARTBEAT_INTERVAL: "1", WATCHDOG_MCP: "0", ...env,
    },
  });
  let out = "";
  p.stdout.on("data", d => { out += d; }); p.stderr.on("data", d => { out += d; });
  let exited = false; p.on("exit", () => { exited = true; });
  const log = () => out;
  const waitFor = async (re, ms = 40_000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (re.test(out)) return true; if (exited) return re.test(out); await sleep(150); }
    return re.test(out);
  };
  const stop = async () => {
    if (!exited) { p.kill("SIGTERM"); const until = Date.now() + 8000; while (!exited && Date.now() < until) await sleep(100); if (!exited) p.kill("SIGKILL"); }
  };
  return { log, waitFor, stop };
}

const launches = (dir) => existsSync(join(dir, "launches")) ? readFileSync(join(dir, "launches"), "utf8").trim().split("\n").filter(Boolean) : [];

function freshDir() {
  const dir = mkdtempSync(join(tmpdir(), "wdv3-"));
  writeFileSync(join(dir, "CLAUDE.md"), "# fake role\n");
  writeFakeClaude(dir);
  return dir;
}

async function post(client, channel, sender, obj) {
  const r = await client.callTool({ name: "send_message", arguments: { channel, sender, content: JSON.stringify(obj) } });
  return parseInt((r.content?.[0]?.text.match(/Sent #(\d+)/) || [])[1] || "0", 10);
}
const dispatch = (client, ns, taskId) => post(client, `${ns}-backend`, "orchestrator", { type: "task", task_id: taskId, from: "orchestrator", to: "backend", subject: "fake task" });

async function telemetry(client, ns) {
  const r = await client.callTool({ name: "read_messages", arguments: { channel: `${ns}-telemetry`, since_id: 0, limit: 200 } });
  return (r.content?.[0]?.text || "").split("\n").filter(l => l.startsWith("[#")).map(l => { try { return JSON.parse(l.slice(l.indexOf("{"))); } catch { return null; } }).filter(Boolean);
}

// ─── 1. context measurement and the rotation recommendation ──────────────────

async function testContextAndRecommend(client) {
  console.log("\n[1] context size on heartbeats; rotation_recommended at ROTATE_AT_TOKENS");
  const ns = `wa${TAG}`, dir = freshDir();
  await dispatch(client, ns, `${ns}-t1`);
  // 5000 tokens over a 4000 threshold; kill disabled, so this only recommends. The session lives 6 s.
  const w = startWatchdog({ ns, dir, plan: "big:5000:6", env: { ROTATE_AT_TOKENS: "4000", ROTATE_KILL_AFTER_S: "0" } });
  try {
    const seen = await w.waitFor(/rotation recommended/, 20_000);
    expect(seen, "log reports 'context 5000 >= 4000 tokens — rotation recommended'", w.log());
    expect(/context 5000 >= 4000 tokens/.test(w.log()), "the log carries the measured size (10% input + 50% cache_read + 40% cache_create = 5000)", w.log());
    await sleep(1500);
    const hbs = (await telemetry(client, ns)).filter(m => m.type === "heartbeat");
    const live = hbs.filter(m => m.context?.size_tokens === 5000);
    expect(live.length > 0, "a heartbeat on <ns>-telemetry carries context.size_tokens = 5000", hbs.map(h => h.context));
    const h = live[live.length - 1] || {};
    expect(h.context?.rotation_recommended === true && h.context?.tier_threshold_pct === 125, "rotation_recommended:true and tier_threshold_pct = 125 (5000/4000)", h.context);
    expect(h.context?.cache_read === 2500 && h.context?.cache_create === 2000, "cache_read / cache_create reported separately", h.context);
    expect(h.session_id === "sess-1" && h.activity?.state === "working", "session_id from the stream; activity.state working", h);
    expect(await w.waitFor(/--- restart #0 \[reason: inbox/, 1000), "launched for the inbox task");
    await sleep(6500);
    expect(!/terminating for rotation/.test(w.log()), "ROTATE_KILL_AFTER_S=0: recommend only, the session is never killed", w.log());
  } finally { await w.stop(); rmSync(dir, { recursive: true, force: true }); }

  // Below the threshold: no recommendation.
  const ns2 = `wb${TAG}`, dir2 = freshDir();
  await dispatch(client, ns2, `${ns2}-t1`);
  const w2 = startWatchdog({ ns: ns2, dir: dir2, plan: "big:3000:4", env: { ROTATE_AT_TOKENS: "4000", ROTATE_KILL_AFTER_S: "0" } });
  try {
    await sleep(3000);
    const hbs = (await telemetry(client, ns2)).filter(m => m.type === "heartbeat" && m.context?.size_tokens === 3000);
    expect(hbs.length > 0 && hbs.every(h => h.context.rotation_recommended === false && h.context.tier_threshold_pct === 75), "3000 of 4000 tokens: rotation_recommended:false, tier_threshold_pct 75", hbs.map(h => h.context));
    expect(!/rotation recommended/.test(w2.log()), "no recommendation logged below the threshold", w2.log());
  } finally { await w2.stop(); rmSync(dir2, { recursive: true, force: true }); }

  // ROTATE_AT_TOKENS=0 disables the feature.
  const ns3 = `wc${TAG}`, dir3 = freshDir();
  await dispatch(client, ns3, `${ns3}-t1`);
  const w3 = startWatchdog({ ns: ns3, dir: dir3, plan: "big:900000:4", env: { ROTATE_AT_TOKENS: "0" } });
  try {
    await sleep(3000);
    expect(!/rotation recommended|terminating for rotation/.test(w3.log()), "ROTATE_AT_TOKENS=0 disables rotation entirely", w3.log());
  } finally { await w3.stop(); rmSync(dir3, { recursive: true, force: true }); }

  // WATCHDOG_STREAM_JSON=0: no stream-json flags, so the size is not measured.
  const ns4 = `wd${TAG}`, dir4 = freshDir();
  await dispatch(client, ns4, `${ns4}-t1`);
  const w4 = startWatchdog({ ns: ns4, dir: dir4, plan: "big:5000:4", env: { ROTATE_AT_TOKENS: "4000", WATCHDOG_STREAM_JSON: "0" } });
  try {
    await sleep(3000);
    const hbs = (await telemetry(client, ns4)).filter(m => m.type === "heartbeat");
    expect(hbs.length > 0, "heartbeats still flow with WATCHDOG_STREAM_JSON=0", hbs.length);
  } finally { await w4.stop(); rmSync(dir4, { recursive: true, force: true }); }
}

// ─── 2. forced rotation ───────────────────────────────────────────────────────

async function testForcedRotation(client) {
  console.log("\n[2] session over the threshold for ROTATE_KILL_AFTER_S is killed and relaunched fresh");
  const ns = `we${TAG}`, dir = freshDir();
  await dispatch(client, ns, `${ns}-t1`);
  // Launch 1 reports 6000 tokens and would run 60 s; launch 2 is a small session that finishes the task.
  const w = startWatchdog({ ns, dir, task: `${ns}-t1`, plan: "big:6000:60,result", env: { ROTATE_AT_TOKENS: "4000", ROTATE_KILL_AFTER_S: "2" } });
  try {
    expect(await w.waitFor(/terminating for rotation/, 30_000), "log: 'still 6000 tokens 2s after crossing the threshold — terminating for rotation'", w.log());
    expect(await w.waitFor(/rotated at 6000 tokens — relaunching a fresh session/, 15_000), "log: 'rotated at 6000 tokens — relaunching a fresh session'", w.log());
    // The killed session never advanced the cursor, so the inbox task is still pending and the
    // relaunch is an ordinary inbox launch ('rotate' is the reason only when the inbox is empty).
    expect(await w.waitFor(/--- restart #1 \[reason: (inbox|rotate), inbox_max_id: \d+\]/, 15_000), "the fresh session is launched at once (restart #1) and re-reads the unhandled inbox", w.log());
    expect(await w.waitFor(/clean exit/, 20_000), "the fresh session ran to a clean exit", w.log());
    const l = launches(dir);
    expect(l.length >= 2 && /big:6000:60/.test(l[0]) && /result/.test(l[1]), "exactly the planned launches happened, in order", l);
    expect(!/API unreachable/.test(w.log()), "a rotation kill is not counted as a network failure", w.log());
    const ends = (await telemetry(client, ns)).filter(m => m.type === "heartbeat" && m.activity?.state === "session-end");
    expect(ends.length > 0, "a session-end heartbeat was posted", ends.length);
    const r = await client.callTool({ name: "check_result", arguments: { channel: `${ns}-status`, task_id: `${ns}-t1` } });
    expect(/"found":\s*true/.test(r.content?.[0]?.text || ""), "the fresh session's result is on <ns>-status", r.content?.[0]?.text);
  } finally { await w.stop(); rmSync(dir, { recursive: true, force: true }); }
}

// ─── 3. follow-up relaunch ────────────────────────────────────────────────────

async function testFollowup(client) {
  console.log("\n[3] clean exit with an open task → follow-up launch; capped; ends when the task is done");
  const ns = `wf${TAG}`, dir = freshDir(), task = `${ns}-t1`;
  await dispatch(client, ns, task);
  const w = startWatchdog({ ns, dir, task, plan: "handoff,result" });
  try {
    expect(await w.waitFor(/1 open task\(s\) in the ledger — follow-up launch 1\/3/, 30_000), "after a handoff exit the log reports 1 open task and follow-up launch 1/3", w.log());
    expect(await w.waitFor(/reason: followup/, 15_000), "the next launch's reason is 'followup' (the inbox was empty)", w.log());
    expect(await w.waitFor(/clean exit — cursor=\d+, restarting in 2s/, 20_000), "once the task has a result: no open tasks, plain clean exit", w.log());
    const l = launches(dir);
    expect(l.length === 2 && /handoff/.test(l[0]) && /result/.test(l[1]), "exactly two launches: handoff session, then the follow-up", l);
    await sleep(3000);
    expect(launches(dir).length === 2, "no further launches once the ledger is clear", launches(dir));
    const led = JSON.parse((await client.callTool({ name: "get_task_ledger", arguments: { status_channel: `${ns}-status`, prefix: `${ns}-` } })).content[0].text);
    expect(led.tasks.find(t => t.task_id === task)?.state === "done", "ledger shows the task done", led.tasks);
  } finally { await w.stop(); rmSync(dir, { recursive: true, force: true }); }

  // A task that never completes: follow-ups stop at FOLLOWUP_MAX.
  const ns2 = `wg${TAG}`, dir2 = freshDir(), task2 = `${ns2}-t1`;
  await dispatch(client, ns2, task2);
  const w2 = startWatchdog({ ns: ns2, dir: dir2, task: task2, plan: "progress", env: { FOLLOWUP_MAX: "2" } });
  try {
    expect(await w2.waitFor(/WARN: 1 open task\(s\) after 2 follow-up launches without progress — idling until new inbox work/, 60_000),
      "FOLLOWUP_MAX=2: after 2 follow-ups the log warns and idles", w2.log());
    const n = launches(dir2).length;
    expect(n === 3, "1 inbox launch + 2 follow-ups = 3 launches", launches(dir2));
    await sleep(3500);
    expect(launches(dir2).length === n, "no launch after the cap while the inbox stays empty", launches(dir2));
    // New inbox work resets the follow-up budget.
    await dispatch(client, ns2, `${ns2}-t2`);
    const until = Date.now() + 20_000;
    while (Date.now() < until && launches(dir2).length === n) await sleep(200);
    expect(launches(dir2).length > n, "a new inbox message starts a session again", launches(dir2));
  } finally { await w2.stop(); rmSync(dir2, { recursive: true, force: true }); }

  // FOLLOWUP_MAX=0: never follow up.
  const ns3 = `wh${TAG}`, dir3 = freshDir(), task3 = `${ns3}-t1`;
  await dispatch(client, ns3, task3);
  const w3 = startWatchdog({ ns: ns3, dir: dir3, task: task3, plan: "handoff", env: { FOLLOWUP_MAX: "0" } });
  try {
    expect(await w3.waitFor(/WARN: 1 open task\(s\) after 0 follow-up launches/, 25_000), "FOLLOWUP_MAX=0 never relaunches", w3.log());
    await sleep(3000);
    expect(launches(dir3).length === 1, "single launch", launches(dir3));
  } finally { await w3.stop(); rmSync(dir3, { recursive: true, force: true }); }
}

// ─── 4. API unreachable ───────────────────────────────────────────────────────

async function testBackoff(client) {
  console.log("\n[4] ENOTFOUND: exponential backoff, annotated, reset by a successful session");
  const ns = `wi${TAG}`, dir = freshDir(), task = `${ns}-t1`;
  await dispatch(client, ns, task);
  const w = startWatchdog({ ns, dir, task, plan: "enotfound,enotfound,enotfound,enotfound,result,enotfound", env: { NET_BACKOFF_BASE: "1", NET_BACKOFF_MAX: "4" } });
  try {
    const waits = [];
    for (const [n, want] of [[1, 1], [2, 2], [3, 4], [4, 4]]) {
      const ok = await w.waitFor(new RegExp(`API unreachable \\(exit 1, failure #${n}\\) — backing off ${want}s \\(cursor unchanged\\)`), 30_000);
      waits.push(ok);
      expect(ok, `failure #${n}: backing off ${want}s${n === 4 ? " (capped at NET_BACKOFF_MAX)" : ""}`, w.log().split("\n").filter(l => /API unreachable/.test(l)));
      if (n === 2) {
        // The latest session-end heartbeat carries the backoff annotation.
        const hbs = (await telemetry(client, ns)).filter(m => m.context?.backoff);
        const b = hbs[hbs.length - 1]?.context.backoff;
        expect(b && b.reason === "api-unreachable" && b.attempt === 2 && b.delay_s === 2 && /^\d{4}-\d\d-\d\dT[\d:]+Z$/.test(b.resume_at),
          "session-end heartbeat has context.backoff {reason:'api-unreachable', attempt:2, delay_s:2, resume_at}", hbs.map(h => h.context.backoff));
        expect(hbs[hbs.length - 1]?.activity?.state === "session-end" && hbs[hbs.length - 1]?.activity?.exit_code === 1, "…on a session-end beat with exit_code 1", hbs[hbs.length - 1]);
      }
    }
    expect(waits.every(Boolean), "four consecutive failures produced 1s, 2s, 4s, 4s");
    expect(await w.waitFor(/clean exit — cursor=\d+/, 30_000), "the fifth launch succeeded (the inbox task was retried each time: cursor unchanged)", w.log());
    const l = launches(dir);
    expect(l.length >= 5 && l.slice(0, 4).every(x => /enotfound/.test(x)) && /result/.test(l[4]), "launches 1-4 failed, launch 5 completed the task", l);
    // A new failure after a success starts again from the base delay.
    await dispatch(client, ns, `${ns}-t2`);
    const until = Date.now() + 25_000; let again = false;
    while (Date.now() < until) { const m = w.log().match(/failure #(\d+)\) — backing off (\d+)s/g) || []; if (m.length >= 5) { again = m[4]; break; } await sleep(200); }
    expect(again && /failure #1\) — backing off 1s/.test(again), "after a successful session the counter is reset: next failure is #1 with the base delay", w.log().split("\n").filter(x => /API unreachable/.test(x)));
  } finally { await w.stop(); rmSync(dir, { recursive: true, force: true }); }

  // ENOTFOUND in tool output of a failed session is not an unreachable API.
  const ns2 = `wj${TAG}`, dir2 = freshDir();
  await dispatch(client, ns2, `${ns2}-t1`);
  const w2 = startWatchdog({ ns: ns2, dir: dir2, plan: "toolnoise" });
  try {
    expect(await w2.waitFor(/non-zero exit \(1\) — restarting in 15s \(cursor unchanged\)/, 25_000), "tool output mentioning ENOTFOUND: treated as an ordinary non-zero exit", w2.log());
    expect(!/API unreachable/.test(w2.log()), "…not as an unreachable API", w2.log());
    const hb = (await telemetry(client, ns2)).filter(m => m.context?.backoff);
    expect(hb.length === 0, "no backoff annotation on any heartbeat", hb.length);
  } finally { await w2.stop(); rmSync(dir2, { recursive: true, force: true }); }
}

// ─── 5. fallback handoff ──────────────────────────────────────────────────────

// The work dir as a git repo: fake-claude's own files ignored, CLAUDE.md committed. dirty = an
// untracked file plus a modified CLAUDE.md, like a session killed mid-edit.
function gitDir(dirty) {
  const dir = freshDir();
  writeFileSync(join(dir, ".gitignore"), "count\nlaunches\nfake-claude\n");
  const g = (...a) => spawnSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" });
  g("init", "-q", "-b", "wip-branch"); g("add", "-A"); g("commit", "-q", "-m", "base");
  if (dirty) { writeFileSync(join(dir, "half-done.js"), "// wip\n"); writeFileSync(join(dir, "CLAUDE.md"), "# fake role\nedited\n"); }
  return dir;
}
const statuses = async (client, ns) => (await client.callTool({ name: "read_messages", arguments: { channel: `${ns}-status`, since_id: 0, limit: 100 } })).content?.[0]?.text || "";
const fallbacks = (text) => text.split("\n").filter(l => l.startsWith("[#")).map(l => { try { return JSON.parse(l.slice(l.indexOf("{"))); } catch { return null; } })
  .filter(m => m && m.body?.source === "watchdog");
const taskState = async (client, ns, task) => JSON.parse((await client.callTool({ name: "get_task_ledger", arguments: { status_channel: `${ns}-status`, prefix: `${ns}-` } })).content[0].text).tasks.find(t => t.task_id === task)?.state;

async function testFallbackHandoff(client) {
  console.log("\n[5] kill-rotation / timeout / dirty crash without handoff_notes → watchdog fallback handoff");
  // Kill-rotation, the session never posted handoff_notes: the watchdog posts one with the git state.
  const ns = `wm${TAG}`, dir = gitDir(true), task = `${ns}-t1`;
  const tid = await dispatch(client, ns, task);
  const w = startWatchdog({ ns, dir, task, plan: "readbig:6000:60,result", env: { ROTATE_AT_TOKENS: "4000", ROTATE_KILL_AFTER_S: "2" } });
  try {
    expect(await w.waitFor(/fallback handoff posted for \S+ \(kill-rotation/, 40_000), "log: fallback handoff posted (kill-rotation)", w.log());
    const fb = fallbacks(await statuses(client, ns));
    const m = fb[0] || {};
    expect(fb.length === 1 && m.type === "status" && m.task_id === task && m.from === "backend", "one status from the worker for the in-flight task", fb);
    expect(/watchdog fallback handoff — kill-rotation at 6000 tokens/.test(m.subject || ""), "subject names the cause and the size", m.subject);
    const hn = m.body?.handoff_notes || {};
    expect(Array.isArray(hn.pending) && hn.next_step && hn.files_touched?.includes("half-done.js") && hn.files_touched?.includes("CLAUDE.md"), "handoff_notes {done,pending,files_touched,next_step}; files_touched from git status", hn);
    expect(/\?\? half-done\.js/.test(m.body?.git?.status_short || "") && /CLAUDE\.md/.test(m.body?.git?.diff_stat || "") && m.body?.git?.branch === "wip-branch" && /^[0-9a-f]{7,}$/.test(m.body?.git?.head || ""),
      "body.git carries status --short, diff --stat, branch and HEAD", m.body?.git);
    const cur = await (await fetch(`${BASE_URL}/cursors?worker=backend`, { headers: { authorization: `Bearer ${SECRET}` } })).json().catch(() => ({}));
    const c = JSON.stringify(cur).match(new RegExp(`"channel":"${ns}-backend","last_id":(\\d+)`));
    expect(c && Number(c[1]) <= tid - 1, `the worker's inbox cursor is back before the dispatch (#${tid - 1}) so the next session re-reads it`, cur);
    expect(await w.waitFor(/clean exit/, 25_000), "the relaunched session finished the task", w.log());
  } finally { await w.stop(); rmSync(dir, { recursive: true, force: true }); }

  // The session posted its own handoff_notes after crossing: no fallback.
  const ns2 = `wn${TAG}`, dir2 = gitDir(true), task2 = `${ns2}-t1`;
  await dispatch(client, ns2, task2);
  const w2 = startWatchdog({ ns: ns2, dir: dir2, task: task2, plan: "bighandoff:6000:60,result", env: { ROTATE_AT_TOKENS: "4000", ROTATE_KILL_AFTER_S: "3" } });
  try {
    expect(await w2.waitFor(/session posted its own handoff_notes — no fallback handoff/, 40_000), "log: the session's own handoff_notes found — no fallback", w2.log());
    expect(fallbacks(await statuses(client, ns2)).length === 0, "no watchdog status on <ns>-status", await statuses(client, ns2));
  } finally { await w2.stop(); rmSync(dir2, { recursive: true, force: true }); }

  // Session timeout below the threshold: fallback from session start.
  const ns3 = `wo${TAG}`, dir3 = gitDir(true), task3 = `${ns3}-t1`;
  await dispatch(client, ns3, task3);
  const w3 = startWatchdog({ ns: ns3, dir: dir3, task: task3, plan: "big:100:60", env: { ROTATE_AT_TOKENS: "4000", MAX_SESSION_SECONDS: "3" } });
  try {
    expect(await w3.waitFor(/fallback handoff posted for \S+ \(timeout/, 30_000), "timeout: fallback handoff posted", w3.log());
    const fb = fallbacks(await statuses(client, ns3));
    expect(fb.length === 1 && /— timeout at 100 tokens/.test(fb[0].subject), "the fallback names the timeout", fb);
    expect(await taskState(client, ns3, task3) === "handoff", "ledger: the task is in state handoff", await taskState(client, ns3, task3));
  } finally { await w3.stop(); rmSync(dir3, { recursive: true, force: true }); }

  // A crash that left the worktree dirty: fallback. A clean crash: today's behaviour, nothing posted.
  for (const dirty of [true, false]) {
    const ns4 = `w${dirty ? "p" : "q"}${TAG}`, dir4 = gitDir(dirty), task4 = `${ns4}-t1`;
    await dispatch(client, ns4, task4);
    const w4 = startWatchdog({ ns: ns4, dir: dir4, task: task4, plan: "fail" });
    try {
      expect(await w4.waitFor(/non-zero exit \(3\)/, 25_000), `crash (${dirty ? "dirty" : "clean"} worktree): non-zero exit`, w4.log());
      const fb = fallbacks(await statuses(client, ns4));
      if (dirty) expect(fb.length === 1 && /— crash at/.test(fb[0].subject) && /half-done\.js/.test(fb[0].body.git.status_short), "dirty crash: fallback handoff with the git state", fb);
      else expect(fb.length === 0 && !/fallback handoff/.test(w4.log()), "clean crash: no fallback handoff", w4.log());
    } finally { await w4.stop(); rmSync(dir4, { recursive: true, force: true }); }
  }

  // Crash loop on a dirty worktree: one fallback per (task, git HEAD, git status), across sessions.
  const ns5 = `wr${TAG}`, dir5 = gitDir(true), task5 = `${ns5}-t1`;
  await dispatch(client, ns5, task5);
  const w5 = startWatchdog({ ns: ns5, dir: dir5, task: task5, plan: "fail", env: { WATCHDOG_DELAY_CRASH: "1" } });
  try {
    const until = Date.now() + 40_000;
    while (Date.now() < until && (w5.log().match(/non-zero exit \(3\)/g) || []).length < 3) await sleep(200);
    const crashes = (w5.log().match(/non-zero exit \(3\)/g) || []).length;
    expect(crashes >= 3, "three dirty crashes in a row", w5.log());
    const fb = fallbacks(await statuses(client, ns5));
    expect(fb.length === 1, "crash loop: exactly one fallback status", fb.map(m => m.subject));
    expect((w5.log().match(/already a watchdog fallback at the same git HEAD and status — not posting another/g) || []).length >= crashes - 1,
      "log: each later crash names the dedupe", w5.log().split("\n").filter(l => /fallback/.test(l)));
  } finally { await w5.stop(); rmSync(dir5, { recursive: true, force: true }); }

  // A rate-limited exit on a dirty worktree: the API ended the session, not the task — no fallback.
  const ns6 = `ws${TAG}`, dir6 = gitDir(true), task6 = `${ns6}-t1`;
  await dispatch(client, ns6, task6);
  const w6 = startWatchdog({ ns: ns6, dir: dir6, task: task6, plan: "ratelimit" });
  try {
    expect(await w6.waitFor(/RATE LIMITED — backing off/, 25_000), "rate-limited exit detected", w6.log());
    expect(/rate-limited exit — no fallback handoff/.test(w6.log()), "log: no fallback handoff for a rate-limited exit", w6.log());
    expect(fallbacks(await statuses(client, ns6)).length === 0, "rate-limited dirty exit: no fallback status", await statuses(client, ns6));
  } finally { await w6.stop(); rmSync(dir6, { recursive: true, force: true }); }

  // A stream-json rate-limit error event (is_error result, api_error_status 429) is a rate limit too.
  const ns7 = `wt${TAG}`, dir7 = gitDir(true), task7 = `${ns7}-t1`;
  await dispatch(client, ns7, task7);
  const w7 = startWatchdog({ ns: ns7, dir: dir7, task: task7, plan: "rlevent" });
  try {
    expect(await w7.waitFor(/RATE LIMITED — backing off/, 25_000), "is_error result with api_error_status 429: rate-limited", w7.log());
    expect(fallbacks(await statuses(client, ns7)).length === 0, "…and no fallback status", await statuses(client, ns7));
  } finally { await w7.stop(); rmSync(dir7, { recursive: true, force: true }); }

  // '429' in a message id, assistant text, tool output or a successful result is not a rate limit:
  // an ordinary crash (dirty worktree → fallback), no backoff.
  const ns8 = `wu${TAG}`, dir8 = gitDir(true), task8 = `${ns8}-t1`;
  await dispatch(client, ns8, task8);
  const w8 = startWatchdog({ ns: ns8, dir: dir8, task: task8, plan: "rlnoise" });
  try {
    expect(await w8.waitFor(/non-zero exit \(1\)/, 25_000), "429 in ids / result text: an ordinary non-zero exit", w8.log());
    expect(!/RATE LIMITED|rate-limited exit/.test(w8.log()), "…not a rate limit", w8.log());
    expect(fallbacks(await statuses(client, ns8)).length === 1, "…so the dirty crash gets its fallback handoff", await statuses(client, ns8));
  } finally { await w8.stop(); rmSync(dir8, { recursive: true, force: true }); }

  // Killed for rotation after a rate-limit error: the kill is ours, the fallback handoff still fires.
  const ns9 = `wv${TAG}`, dir9 = gitDir(true), task9 = `${ns9}-t1`;
  await dispatch(client, ns9, task9);
  const w9 = startWatchdog({ ns: ns9, dir: dir9, task: task9, plan: "rlbig:6000:60,result", env: { ROTATE_AT_TOKENS: "4000", ROTATE_KILL_AFTER_S: "2" } });
  try {
    expect(await w9.waitFor(/fallback handoff posted for \S+ \(kill-rotation/, 40_000), "rotation kill + rate-limit error: fallback handoff posted (kill-rotation)", w9.log());
    expect(!/rate-limited exit — no fallback handoff/.test(w9.log()), "…not suppressed as a rate-limited exit", w9.log());
  } finally { await w9.stop(); rmSync(dir9, { recursive: true, force: true }); }
}

// The MCP URL's identity: ns= and as= always, role= only when opted in (WATCHDOG_ROLE_URL=1,
// WATCHDOG_ROLE_NAMESPACES listing the ns, or an explicit WATCHDOG_ROLE). --print-channels exposes the derivation.
function mcpQuery(env = {}, inbox = "wl-backend", worker = "backend") {
  const clean = { ...process.env }; for (const k of ["WATCHDOG_ROLE", "WATCHDOG_ROLE_URL", "WATCHDOG_ROLE_NAMESPACES", "WATCHDOG_AS"]) delete clean[k];
  const r = spawnSync("bash", [join(ROOT, "watchdog.sh"), worker, "--work-dir", tmpdir(), "--inbox-channel", inbox, "--print-channels"], { env: { ...clean, ...env }, encoding: "utf8" });
  return { code: r.status, key: /^key=(.*)$/m.exec(r.stdout || "")?.[1], as: /^as=(.*)$/m.exec(r.stdout || "")?.[1], query: /^mcp_query=(.*)$/m.exec(r.stdout || "")?.[1], out: (r.stdout || "") + (r.stderr || "") };
}

function testRoleUrlOptIn() {
  console.log("\n── MCP URL: ns/as always, role= opt-in ──");
  let r = mcpQuery();
  expect(r.code === 0 && r.query === "ns=wl&as=backend", "default: ns=&as= only, no role=", r.out);
  r = mcpQuery({ WATCHDOG_ROLE_URL: "1" });
  expect(r.query === "role=worker&ns=wl&as=backend", "WATCHDOG_ROLE_URL=1 adds the derived role", r.out);
  r = mcpQuery({ WATCHDOG_ROLE_NAMESPACES: "foo, wl" });
  expect(r.query === "role=worker&ns=wl&as=backend", "WATCHDOG_ROLE_NAMESPACES listing the ns adds role=", r.out);
  r = mcpQuery({ WATCHDOG_ROLE_NAMESPACES: "foo,other" });
  expect(r.query === "ns=wl&as=backend", "WATCHDOG_ROLE_NAMESPACES without the ns leaves role= off", r.out);
  r = mcpQuery({ WATCHDOG_ROLE: "reviewer" });
  expect(r.query === "role=reviewer&ns=wl&as=backend", "an explicit WATCHDOG_ROLE adds role= with that role", r.out);
  r = mcpQuery({ WATCHDOG_ROLE_URL: "0" });
  expect(r.query === "ns=wl&as=backend", "WATCHDOG_ROLE_URL=0 keeps role= off", r.out);

  // Heartbeat sender / cursor / ledger key: the worker path basename until opted in, then the session's WORKER_AS.
  // cb-reviewer: code-reviewer derives as=reviewer, so the two keys differ and the switch is observable.
  const REV = ["cb-reviewer", "code-reviewer"];
  r = mcpQuery({}, ...REV);
  expect(r.as === "reviewer" && r.key === "code-reviewer", "not opted in: key == path basename (code-reviewer), not as=reviewer", r.out);
  r = mcpQuery({ WATCHDOG_ROLE_URL: "1" }, ...REV);
  expect(r.as === "reviewer" && r.key === "reviewer", "opted in (WATCHDOG_ROLE_URL=1): key == as (reviewer)", r.out);
  r = mcpQuery({ WATCHDOG_ROLE_NAMESPACES: "cb-reviewer" }, ...REV);
  expect(r.key === "code-reviewer", "WATCHDOG_ROLE_NAMESPACES not listing the ns: key stays the basename", r.out);
  r = mcpQuery({ WATCHDOG_ROLE: "reviewer" }, ...REV);
  expect(r.key === "reviewer", "an explicit WATCHDOG_ROLE opts in: key == as", r.out);
  r = mcpQuery({}, "wl-backend", "workers/backend");
  expect(r.key === "backend", "path worker 'workers/backend': key is the basename", r.out);
}

async function main() {
  console.log(`[watchdog-v3] broker: ${BROKER_URL}  tag: ${TAG}`);
  const client = await connect("watchdog-v3-test");
  try {
    testRoleUrlOptIn();
    await testContextAndRecommend(client);
    await testForcedRotation(client);
    await testFollowup(client);
    await testBackoff(client);
    await testFallbackHandoff(client);
  } finally {
    await client.close().catch(() => {});
    // Cursor/lock/patrol files the watchdog leaves in /tmp for these namespaces.
    try { for (const f of readdirSync("/tmp")) if (f.startsWith("watchdog-backend-") && f.includes(TAG)) rmSync(join("/tmp", f), { force: true }); } catch {}
  }
  console.log(`\n[watchdog-v3] ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error("[watchdog-v3] FATAL:", e); process.exit(1); });
