// Context-economy tests: the MAX_CONTENT_BYTES write cap on all four write paths, get_message
// (id, path) with dot / [n] / ["k"] paths, summary-projection clipping, and full-read identity.
// Exercises a live (scratch) broker over MCP and REST.
// Safe to run multiple times — uses unique channel names per run.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import "dotenv/config";

const BROKER_URL = process.env.BROKER_URL || "http://localhost:8080/mcp";
const REST_URL   = BROKER_URL.replace(/\/mcp$/, "");
const SECRET     = process.env.SHARED_SECRET || "";
const RUN_TAG    = Date.now().toString(36);
const NS         = `tce${RUN_TAG}`;
const CAP        = Number(process.env.MAX_CONTENT_BYTES) || 32768;

async function connect(name) {
  const transport = new StreamableHTTPClientTransport(new URL(`${BROKER_URL}?role=admin`), {
    requestInit: SECRET ? { headers: { Authorization: `Bearer ${SECRET}` } } : {},
  });
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

let passed = 0;
let failed = 0;

function expect(cond, label, detail) {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed++;
    return true;
  }
  console.error(`  ✗ ${label}`);
  if (detail !== undefined) console.error(`     detail: ${JSON.stringify(detail)}`);
  failed++;
  process.exitCode = 1;
  return false;
}

async function call(client, name, args) {
  const r = await client.callTool({ name, arguments: args });
  return { text: r.content?.[0]?.text ?? "", isError: !!r.isError };
}

// A JSON envelope whose UTF-8 size is exactly `bytes`. `filler` is the padding char (default ASCII).
function sized(bytes, filler = "x") {
  const head = JSON.stringify({ type: "note", pad: "" }).length;
  const unit = Buffer.byteLength(filler, "utf8");
  const n = Math.floor((bytes - head) / unit);
  let s = JSON.stringify({ type: "note", pad: filler.repeat(n) });
  // ASCII top-up so the total is exact even when `filler` is multi-byte.
  const gap = bytes - Buffer.byteLength(s, "utf8");
  if (gap > 0) s = JSON.stringify({ type: "note", pad: filler.repeat(n) + "x".repeat(gap) });
  return s;
}

const bytesOf = (s) => Buffer.byteLength(s, "utf8");
const stored = async (client, channel) => {
  const r = await call(client, "read_messages", { channel, since_id: 0, limit: 500 });
  return r.text;
};
const idOf = (text) => Number(/Sent #(\d+)/.exec(text)?.[1] ?? /Sent \d+ messages: #(\d+)/.exec(text)?.[1] ?? NaN);

async function restPost(channel, content) {
  const res = await fetch(`${REST_URL}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(SECRET ? { authorization: `Bearer ${SECRET}` } : {}) },
    body: JSON.stringify({ channel, sender: "test-context-economy", content }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// ─── write cap ────────────────────────────────────────────────────────────────

async function testWriteCap(client) {
  console.log(`\n── write cap (MAX_CONTENT_BYTES=${CAP}) on every write path ──`);
  const ok   = sized(CAP);
  const over = sized(CAP + 1);
  expect(bytesOf(ok) === CAP && bytesOf(over) === CAP + 1, "fixtures are exactly cap and cap+1 bytes", [bytesOf(ok), bytesOf(over)]);

  // 1. send_message
  const c1 = `${NS}-send`;
  let r = await call(client, "send_message", { channel: c1, sender: "t", content: ok });
  expect(!r.isError && /Sent #/.test(r.text), `send_message: ${CAP} bytes accepted`, r.text);
  r = await call(client, "send_message", { channel: c1, sender: "t", content: over });
  expect(r.isError && /MAX_CONTENT_BYTES/.test(r.text) && r.text.includes(String(CAP + 1)) && /get_message/.test(r.text),
    `send_message: ${CAP + 1} bytes rejected, error names cap, size and get_message`, r.text);
  expect((await stored(client, c1)).split("\n").filter(l => l.startsWith("[#")).length === 1,
    "send_message: the oversize message was not stored", null);

  // Bytes, not characters: 'é' is 2 bytes, so CAP/2+1 of them (plus envelope) is over the cap
  // even though the string is far fewer than CAP characters.
  const wide = sized(CAP + 1, "é");
  r = await call(client, "send_message", { channel: c1, sender: "t", content: wide });
  expect(wide.length < CAP && r.isError && /MAX_CONTENT_BYTES/.test(r.text), "cap counts UTF-8 bytes, not characters", [wide.length, bytesOf(wide), r.text]);

  // 2. send_message_batch — atomic: one oversize message rejects the whole batch.
  const c2 = `${NS}-batch`;
  r = await call(client, "send_message_batch", { messages: [
    { channel: c2, sender: "t", content: ok },
    { channel: c2, sender: "t", content: ok },
  ] });
  expect(!r.isError && /Sent 2 messages/.test(r.text), `send_message_batch: two ${CAP}-byte messages accepted`, r.text);
  r = await call(client, "send_message_batch", { messages: [
    { channel: c2, sender: "t", content: JSON.stringify({ type: "note", n: "small-first" }) },
    { channel: c2, sender: "t", content: over },
  ] });
  expect(r.isError && /MAX_CONTENT_BYTES/.test(r.text) && /message 2\/2/.test(r.text),
    `send_message_batch: ${CAP + 1} bytes rejected, error names the message index`, r.text);
  const after = await stored(client, c2);
  expect(!after.includes("small-first") && after.split("\n").filter(l => l.startsWith("[#")).length === 2,
    "send_message_batch: atomic — the valid first message was not stored either", null);

  // 3. post_gated_message — dependency already satisfied so a cap pass really posts.
  const c3 = `${NS}-gated`;
  await call(client, "send_message", { channel: `${NS}-status`, sender: "t", content: JSON.stringify({ type: "result", task_id: `${NS}-dep`, from: "t", to: "o", subject: "dep", summary: "PASS — dep" }) });
  r = await call(client, "post_gated_message", { channel: c3, sender: "t", content: ok, depends_on: [`${NS}-dep`], timeout_ms: 5000 });
  expect(!r.isError && /Sent #/.test(r.text), `post_gated_message: ${CAP} bytes accepted`, r.text);
  const t0 = Date.now();
  r = await call(client, "post_gated_message", { channel: c3, sender: "t", content: over, depends_on: [`${NS}-never`], timeout_ms: 30000 });
  expect(r.isError && /MAX_CONTENT_BYTES/.test(r.text), `post_gated_message: ${CAP + 1} bytes rejected`, r.text);
  expect(Date.now() - t0 < 5000, "post_gated_message: oversize is rejected up front, not after waiting on deps", Date.now() - t0);
  expect((await stored(client, c3)).split("\n").filter(l => l.startsWith("[#")).length === 1, "post_gated_message: only the in-cap message stored", null);

  // 4. REST POST /messages
  const c4 = `${NS}-rest`;
  let p = await restPost(c4, ok);
  expect(p.status === 200 && p.body.id > 0, `POST /messages: ${CAP} bytes accepted (200)`, p);
  p = await restPost(c4, over);
  expect(p.status === 413 && /MAX_CONTENT_BYTES/.test(p.body.error ?? ""), `POST /messages: ${CAP + 1} bytes → 413`, p);
  // A JSON-object `content` is stringified before the cap is applied.
  p = await restPost(c4, { type: "note", pad: "x".repeat(CAP) });
  expect(p.status === 413, "POST /messages: object content is measured after stringification", p);
  expect((await stored(client, c4)).split("\n").filter(l => l.startsWith("[#")).length === 1, "POST /messages: only the in-cap message stored", null);
}

// ─── get_message ──────────────────────────────────────────────────────────────

async function testGetMessage(client) {
  console.log("\n── get_message(channel, id, path) ──");
  const ch = `${NS}-get`;
  const msg = {
    type: "result", task_id: "t-0001", from: "w", to: "o", subject: "paths", summary: "PASS — paths",
    body: {
      required_checks: { test: "PASS (5/5)" },
      commits: [{ sha: "abc1234", branch: "b" }, { sha: "def5678", branch: "c" }],
      "a.b": "dotted", 'q"uote': "quoted", nothing: null, zero: 0, flag: false, nested: { deep: { er: [10, [20, 30]] } },
    },
  };
  const sent = await call(client, "send_message", { channel: ch, sender: "t", content: JSON.stringify(msg) });
  const id = idOf(sent.text);
  expect(id > 0, "fixture message stored", sent.text);

  const get = (path, over = {}) => call(client, "get_message", { channel: ch, id, ...(path === undefined ? {} : { path }), ...over });

  let r = await get();
  expect(!r.isError && r.text.startsWith(`[#${id}]`) && r.text.endsWith(JSON.stringify(msg)), "no path: whole message, byte-identical content", r.text.slice(0, 120));

  r = await get("body.required_checks");
  expect(!r.isError && r.text === JSON.stringify(msg.body.required_checks), "dot path → object", r.text);
  r = await get("body.required_checks.test");
  expect(r.text === '"PASS (5/5)"', "dot path → string (JSON-encoded)", r.text);
  r = await get("body.commits[0].sha");
  expect(r.text === '"abc1234"', "[n] index path", r.text);
  r = await get("body.commits[1]");
  expect(r.text === JSON.stringify(msg.body.commits[1]), "[n] → whole element", r.text);
  r = await get('body["a.b"]');
  expect(r.text === '"dotted"', 'bracket-quoted key with a dot: body["a.b"]', r.text);
  r = await get("body['a.b']");
  expect(r.text === '"dotted"', "single-quoted bracket key", r.text);
  r = await get('body["q\\"uote"]');
  expect(r.text === '"quoted"', "escaped quote inside a bracket key", r.text);
  r = await get("$.body.commits[0].branch");
  expect(r.text === '"b"', "leading $. accepted", r.text);
  r = await get("body.nested.deep.er[1][0]");
  expect(r.text === "20", "chained indexes through nested arrays", r.text);
  r = await get("body.zero");
  expect(r.text === "0", "falsy value 0 returned, not treated as missing", r.text);
  r = await get("body.flag");
  expect(r.text === "false", "falsy value false returned", r.text);
  r = await get("body.nothing");
  expect(!r.isError && r.text === "null", "explicit null returned as null", r.text);
  r = await get("subject");
  expect(r.text === '"paths"', "top-level field", r.text);

  // Errors name the first missing segment and offer a hint.
  r = await get("body.nope");
  expect(r.isError && /'nope' missing at \$\.body/.test(r.text) && /keys: .*required_checks/.test(r.text),
    "missing key: error names the segment, where, and the available keys", r.text);
  r = await get("body.commits[5]");
  expect(r.isError && /'5' missing at \$\.body\.commits/.test(r.text) && /array of length 2/.test(r.text),
    "index out of range: error names the index and the array length", r.text);
  r = await get("body.commits.sha");
  expect(r.isError && /missing/.test(r.text), "dot key into an array is not found", r.text);
  r = await get("subject.length");
  expect(r.isError && /has no fields/.test(r.text), "descending into a string is an error, not a property read", r.text);
  r = await get("body.nothing.x");
  expect(r.isError && /null has no fields/.test(r.text), "descending into null is an error", r.text);
  r = await get("body.__proto__");
  expect(r.isError, "prototype keys are not reachable (own properties only)", r.text);
  r = await get("body.commits[abc]");
  expect(r.isError, "non-numeric index rejected", r.text);
  r = await get('body["unterminated');
  expect(r.isError && /invalid path/.test(r.text), "malformed bracket → invalid path with offset", r.text);
  r = await get("body..sha");
  expect(r.isError, "empty segment rejected", r.text);

  // Lookup errors.
  r = await get(undefined, { id: id + 99999 });
  expect(r.isError && /not found/.test(r.text), "unknown id: not found", r.text);
  r = await get(undefined, { channel: `${NS}-other` });
  expect(r.isError && /not found/.test(r.text), "right id on the wrong channel: not found", r.text);
  const plain = await call(client, "send_message", { channel: ch, sender: "t", content: "just text, not json" });
  const pid = idOf(plain.text);
  r = await call(client, "get_message", { channel: ch, id: pid });
  expect(!r.isError && r.text.endsWith("just text, not json"), "non-JSON message readable without a path", r.text);
  r = await call(client, "get_message", { channel: ch, id: pid, path: "body" });
  expect(r.isError && /not JSON/.test(r.text), "non-JSON message with a path: clear error", r.text);

  // get_message must not move read cursors.
  const cur = `${NS}-cursor`;
  const w = `w-${RUN_TAG}`;
  const a = idOf((await call(client, "send_message", { channel: cur, sender: "t", content: JSON.stringify({ type: "note", n: "first" }) })).text);
  await call(client, "get_message", { channel: cur, id: a });
  r = await call(client, "read_messages", { channel: cur, worker: w });
  expect(r.text.includes(`[#${a}]`), "get_message does not advance the reader's server-side cursor", r.text);
}

// ─── summary projection ───────────────────────────────────────────────────────

async function testSummaryProjection(client) {
  console.log("\n── summary projection clipping ──");
  const ch = `${NS}-proj`;
  const long = (c) => c.repeat(500);

  const big = { type: "result", task_id: "t-0002", from: "w", to: "o", subject: long("S"), summary: `PASS — ${long("M")}`, body: { keep: "me" } };
  const small = { type: "result", task_id: "t-0003", from: "w", to: "o", subject: "short subject", summary: "PASS — short" };
  const exact = { type: "note", task_id: "t-0004", from: "w", to: "o", subject: "E".repeat(300), summary: "F".repeat(300) };
  const over1 = { type: "note", task_id: "t-0005", from: "w", to: "o", subject: "G".repeat(301), summary: "ok" };
  const sentBig = JSON.stringify(big), sentSmall = JSON.stringify(small);
  for (const m of [big, small, exact, over1])
    await call(client, "send_message", { channel: ch, sender: "t", content: JSON.stringify(m) });

  const r = await call(client, "read_messages", { channel: ch, since_id: 0, projection: "summary" });
  const rows = r.text.split("\n").filter(l => l.startsWith("[#")).map(l => JSON.parse(l.slice(l.indexOf(": ") + 2)));
  expect(rows.length === 4, "four summary rows", rows.length);
  const [b, s, e, o] = rows;

  expect(b.subject.length === 300 && b.subject.endsWith("…") && b.subject.startsWith("SSS"), "oversize subject clipped to 300 chars ending in …", b.subject.length);
  expect(b.summary.length === 300 && b.summary.endsWith("…") && b.summary.startsWith("PASS — MMM"), "oversize summary clipped to 300 chars, prefix kept", b.summary.length);
  expect(b.truncated === true, "clipped row carries truncated:true", b);
  expect(!("body" in b), "summary projection still omits body", Object.keys(b));
  expect(b.bytes === Buffer.byteLength(sentBig, "utf8"), "bytes reports the ORIGINAL size, not the clipped one", b.bytes);

  expect(s.subject === small.subject && s.summary === small.summary && !("truncated" in s), "short fields untouched, no truncated key", s);
  expect(e.subject.length === 300 && e.summary.length === 300 && !("truncated" in e), "exactly 300 chars is not clipped", e);
  expect(o.subject.length === 300 && o.subject.endsWith("…") && o.truncated === true && o.summary === "ok", "301 chars is clipped; the short field beside it is not", o);

  // Full reads are unchanged: byte-identical to what was sent.
  const full = await call(client, "read_messages", { channel: ch, since_id: 0 });
  expect(full.text.includes(sentBig) && full.text.includes(sentSmall), "full read returns the exact content sent (no clipping)", null);
  expect(full.text.includes("S".repeat(500)) && !full.text.includes("truncated"), "full read keeps all 500 chars and adds no truncated marker", null);

  const last = await call(client, "read_last", { channel: ch, n: 4 });
  expect(last.text.includes(sentBig), "read_last (full) is byte-identical", null);
  const lastSum = await call(client, "read_last", { channel: ch, n: 4, projection: "summary" });
  expect(lastSum.text.includes('"truncated":true') && !lastSum.text.includes("S".repeat(301)), "read_last projection=summary clips too", null);

  const id = idOf((await call(client, "send_message", { channel: ch, sender: "t", content: sentBig })).text);
  const gm = await call(client, "get_message", { channel: ch, id, path: "subject" });
  expect(gm.text === JSON.stringify(big.subject), "get_message(path=subject) returns the full unclipped field", gm.text.length);
}

async function cleanup(client) {
  for (const k of ["send", "batch", "gated", "rest", "get", "cursor", "proj", "status", "other"])
    await call(client, "purge_channel", { channel: `${NS}-${k}` });
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[test-context-economy]  broker=${BROKER_URL}  ns=${NS}  cap=${CAP}`);
  const { client, transport } = await connect("test-context-economy");
  try {
    await testWriteCap(client);
    await testGetMessage(client);
    await testSummaryProjection(client);
  } finally {
    await cleanup(client);
    await transport.close();
  }

  console.log(`\n──────────────────────────────────────────────────────`);
  console.log(`[test-context-economy]  passed=${passed}  failed=${failed}`);
  if (failed === 0) console.log("  ALL TESTS PASSED");
  else { console.error("  SOME TESTS FAILED"); process.exitCode = 1; }
}

main().catch(e => { console.error("[test-context-economy] FATAL:", e); process.exit(1); });
