/**
 * test-guards.js — durable-channel guards (2026-10-01).
 *   purge_channel on a PRUNE_EXEMPT channel: refused without force; refused with force but no/wrong
 *     admin_token; allowed with force + admin_token = ADMIN_SECRET
 *   purge_channels_by_prefix: still skips exempt channels; prefix is LIKE-escaped
 *   delete_message on an exempt channel: refused without sender / with another sender; own sender ok
 *   non-exempt channels: unchanged
 *
 * Expects the broker to list TEST_EXEMPT_CHANNEL (default "tst-exempt") in PRUNE_EXEMPT and to have
 * ADMIN_SECRET set to the value in env ADMIN_SECRET — run-tests.js arranges both.
 */
import "dotenv/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BROKER_URL = process.env.BROKER_URL || "http://localhost:8080/mcp";
const HTTP       = BROKER_URL.replace(/\/mcp$/, "");
const SECRET     = process.env.SHARED_SECRET || "";
const ADMIN      = process.env.ADMIN_SECRET || "";
const EXEMPT     = process.env.TEST_EXEMPT_CHANNEL || "tst-exempt";
const RUN        = Date.now().toString(36);
const P          = `tgrd${RUN}-`;
const hdr        = SECRET ? { Authorization: `Bearer ${SECRET}` } : {};

let passed = 0, failed = 0;
function assert(cond, label, extra = "") {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.log(`  ✗ ${label}${extra ? ": " + String(extra).slice(0, 300) : ""}`); }
}
const client = new Client({ name: "test-guards", version: "1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(BROKER_URL), { requestInit: { headers: hdr } }));
const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); return { text: r.content?.[0]?.text ?? "", isError: !!r.isError }; };
const send = async (channel, sender, obj) => {
  const r = await call("send_message", { channel, sender, content: JSON.stringify(obj) });
  return parseInt((r.text.match(/#(\d+)/) || [])[1], 10);
};
const count = async (channel) => { const r = await call("read_messages", { channel, limit: 500 }); return [...r.text.matchAll(/^\[#\d+\]/gm)].length; };

console.log(`\n[test-guards] url=${BROKER_URL} exempt=${EXEMPT} admin=${ADMIN ? "set" : "UNSET"}\n`);
if (!ADMIN) console.log("  (ADMIN_SECRET not in env — the force+admin_token success case will be skipped)");

// Precondition: EXEMPT must really be exempt on this broker, otherwise the suite proves nothing.
{
  const r = await call("purge_channel", { channel: EXEMPT });
  assert(r.isError && /PRUNE_EXEMPT/.test(r.text), `precondition: '${EXEMPT}' is in the broker's PRUNE_EXEMPT`, r.text);
}

console.log("\n1. purge_channel on an exempt channel");
{
  const before = await count(EXEMPT);
  const id = await send(EXEMPT, "worker-a", { type: "finding", subject: "keep me", summary: "durable" });
  const r1 = await call("purge_channel", { channel: EXEMPT, force: true });
  assert(r1.isError && /admin_token|ADMIN_SECRET/.test(r1.text), "force=true without admin_token → refused", r1.text);
  const r2 = await call("purge_channel", { channel: EXEMPT, force: true, admin_token: "wrong" });
  assert(r2.isError, "force=true with wrong admin_token → refused", r2.text);
  const r3 = await call("purge_channel", { channel: EXEMPT, admin_token: ADMIN || "x" });
  assert(r3.isError, "admin_token without force → refused", r3.text);
  assert((await count(EXEMPT)) === before + 1, "nothing was deleted by the refused calls");
  if (ADMIN) {
    const r4 = await call("purge_channel", { channel: EXEMPT, force: true, admin_token: ADMIN, older_than_ms: 1 });
    await new Promise(r => setTimeout(r, 5));
    assert(!r4.isError && /Pruned/.test(r4.text), "force=true + correct admin_token → allowed", r4.text);
  }
  await call("delete_message", { channel: EXEMPT, id, sender: "worker-a" }).catch(() => {});
}

console.log("\n2. delete_message on an exempt channel");
{
  const id = await send(EXEMPT, "worker-a", { type: "finding", subject: "mine", summary: "x" });
  const r1 = await call("delete_message", { channel: EXEMPT, id });
  assert(r1.isError && /Only its sender/.test(r1.text) && /resolved/.test(r1.text), "no sender → refused, points to type:resolved", r1.text);
  const r2 = await call("delete_message", { channel: EXEMPT, id, sender: "worker-b" });
  assert(r2.isError && /worker-a/.test(r2.text), "another sender → refused, names the real sender", r2.text);
  const r3 = await call("delete_message", { channel: EXEMPT, id, sender: "worker-a" });
  assert(!r3.isError && /Deleted/.test(r3.text), "own sender → deleted", r3.text);
  const r4 = await call("delete_message", { channel: EXEMPT, id: 999999999, sender: "worker-a" });
  assert(r4.isError && /not found/.test(r4.text), "unknown id → not found (not a guard refusal)", r4.text);
}

console.log("\n3. non-exempt channels unchanged");
{
  const ch = `${P}plain`;
  const id = await send(ch, "worker-a", { type: "note", subject: "x" });
  const r1 = await call("delete_message", { channel: ch, id });
  assert(!r1.isError, "delete without sender works on a normal channel", r1.text);
  await send(ch, "worker-a", { type: "note", subject: "y" });
  const r2 = await call("purge_channel", { channel: ch });
  assert(!r2.isError && /Purged 1/.test(r2.text), "purge without force works on a normal channel", r2.text);
}

console.log("\n4. purge_channels_by_prefix");
{
  const a = `${P}x_y`, b = `${P}xZy`;   // "_" in the prefix must not act as a wildcard
  await send(a, "s", { type: "note" }); await send(b, "s", { type: "note" });
  const r = JSON.parse((await call("purge_channels_by_prefix", { prefix: `${P}x_` })).text);
  assert(r.purged.some(p => p.channel === a) && !r.purged.some(p => p.channel === b), "underscore in prefix is literal (LIKE-escaped)", JSON.stringify(r));
  await call("purge_channel", { channel: b });
  const id = await send(EXEMPT, "worker-a", { type: "finding", subject: "survive prefix purge", summary: "x" });
  const r2 = JSON.parse((await call("purge_channels_by_prefix", { prefix: EXEMPT.slice(0, 4) })).text);
  assert(r2.skipped_exempt.includes(EXEMPT), "prefix purge still skips the exempt channel", JSON.stringify(r2));
  await call("delete_message", { channel: EXEMPT, id, sender: "worker-a" });
}

console.log("\n5. metrics");
{
  const m = await (await fetch(`${HTTP}/metrics`, { headers: hdr })).json();
  assert(typeof m.guard_refusals === "number" && m.guard_refusals >= 5, "metrics.guard_refusals counts the refusals", String(m.guard_refusals));
}

await call("purge_channels_by_prefix", { prefix: P }).catch(() => {});
console.log(`\n[test-guards] ${passed} passed, ${failed} failed\n`);
await client.close();
process.exit(failed ? 1 : 0);
