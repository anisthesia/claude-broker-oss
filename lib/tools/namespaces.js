// MCP tools: v3 namespace manifests (register_namespace / get_namespace) and adoption (adopt_namespace).
import { z } from "zod";
import { stmtNsGet, stmtNsList, stmtNsUpsert, stmtSchemaGet } from "../db.js";
import { compileManifest, invalidateNamespace, baseTypes, getNamespace } from "../namespaces.js";
import { adoptionState, listAdoptions, adoptNamespace } from "../adoption.js";
import { adminConfigured, adminTokenMatches, requestContext, orchestratorTrust, isTrustNamespace } from "../auth.js";

const iso = (t) => (t ? new Date(t).toISOString() : null);
function adoptionLine(st) {
  if (st.adopted) return `Adopted: yes, since ${iso(st.adopted_at)} — watchdogs started since then send role= and key on as`;
  return st.reverted_at ? `Adopted: no (reverted ${iso(st.reverted_at)})` : "Adopted: no (v2 identity: no role=, basename keys)";
}

// The trust model reads the manifest (plan_gate, orchestrator-role workers), and role=admin is self-asserted,
// so replacing a guarded namespace's manifest needs a credential: one in ORCHESTRATOR_TRUST_NAMESPACES, or
// whose registered manifest has plan_gate: true. Accepted: admin_token == ADMIN_SECRET, or the orchestrator
// credential (X-Orchestrator-Token) when enforcement is configured. Neither configured → refused (fail closed).
// → refusal text, or null when the write may proceed.
function manifestWriteRefusal(ns, admin_token) {
  const why = isTrustNamespace(ns) ? "it is in ORCHESTRATOR_TRUST_NAMESPACES"
    : getNamespace(ns)?.planGate ? "its registered manifest has plan_gate: true" : null;
  if (!why) return null;
  if (adminTokenMatches(admin_token)) return null;
  if (orchestratorTrust().enabled && requestContext.getStore()?.orchestrator) return null;
  const how = [adminConfigured() && "admin_token (the broker's ADMIN_SECRET)",
               orchestratorTrust().enabled && "the X-Orchestrator-Token header"].filter(Boolean);
  return `register_namespace: namespace '${ns}' is guarded because ${why}; ` +
    (how.length ? `pass ${how.join(" or ")}.` : "the broker has neither ADMIN_SECRET nor an orchestrator credential configured, so it cannot be replaced.");
}

export function registerNamespaceTools(server) {
  // ── register_namespace ──────────────────────────────────────────────────────
  server.registerTool("register_namespace", {
    title: "Register or replace a namespace manifest",
    description: "Bind a v3 namespace manifest (schemas/manifest.schema.json) to its '<ns>-' channels. Messages on a declared channel are validated against the built-in base protocol plus the manifest. A channel that still has a v2 schema (register_channel_schema) keeps v2 validation until clear_channel_schema. Warn-only unless the manifest or channel sets strict=true. Hot-reloads; no restart needed.",
    inputSchema: {
      manifest: z.string().min(2).describe("Manifest as a JSON-encoded string, e.g. the contents of schemas/manifests/<ns>.json."),
      admin_token: z.string().optional().describe("The broker's ADMIN_SECRET. Required for a namespace in ORCHESTRATOR_TRUST_NAMESPACES or with plan_gate on, unless the request carries the orchestrator credential."),
    },
  }, async ({ manifest, admin_token }) => {
    let parsed;
    try { parsed = JSON.parse(manifest); }
    catch (e) { return { content: [{ type: "text", text: `manifest is not valid JSON: ${e.message}` }], isError: true }; }
    let compiled;
    try { compiled = compileManifest(parsed); }
    catch (e) { return { content: [{ type: "text", text: `manifest rejected: ${e.message}` }], isError: true }; }
    const refusal = manifestWriteRefusal(compiled.ns, admin_token);
    if (refusal) return { content: [{ type: "text", text: refusal }], isError: true };
    const now = Date.now();
    stmtNsUpsert.run(compiled.ns, manifest, compiled.version, now);
    invalidateNamespace(compiled.ns);
    const names = [...compiled.channels.keys()];
    const shadowed = names.filter(c => stmtSchemaGet.get(c));
    const strictOn = names.filter(c => compiled.channels.get(c).strict);
    const lines = [
      `Registered namespace '${compiled.ns}' (version=${compiled.version ?? "null"}, strict=${compiled.strict ? "on" : "off"}) at ${new Date(now).toISOString()}.`,
      `Channels (${names.length}): ${names.join(", ")}`,
      strictOn.length ? `Strict channels: ${strictOn.join(", ")}` : "All channels warn-only.",
      shadowed.length
        ? `v2 schema still registered — manifest inactive until clear_channel_schema: ${shadowed.join(", ")}`
        : "No v2 channel schemas shadow this manifest.",
    ];
    return { content: [{ type: "text", text: lines.join("\n") }] };
  });

  // ── get_namespace ───────────────────────────────────────────────────────────
  server.registerTool("get_namespace", {
    title: "Get a namespace manifest",
    description: "Return the v3 manifest registered for a namespace (e.g. 'cb'), with which of its channels are active vs shadowed by a v2 schema. Omit ns to list registered namespaces and the built-in base types.",
    inputSchema: {
      ns: z.string().optional().describe("Namespace prefix without the dash, e.g. 'cb'. Omit to list."),
    },
  }, async ({ ns } = {}) => {
    if (!ns) {
      const rows = stmtNsList.all();
      const adopted = new Map(listAdoptions().filter(a => a.adopted).map(a => [a.ns, a.adopted_at]));
      const list = rows.length
        ? rows.map(r => `${r.ns}\tversion=${r.version ?? "null"}\tbytes=${r.bytes}\tupdated=${new Date(r.updated_at).toISOString()}\tadopted=${adopted.has(r.ns) ? iso(adopted.get(r.ns)) : "no"}`).join("\n")
        : "(no namespaces registered)";
      return { content: [{ type: "text", text: `${list}\n\nBase types: ${[...baseTypes.keys()].join(", ") || "(none loaded)"}` }] };
    }
    const row = stmtNsGet.get(ns);
    if (!row) return { content: [{ type: "text", text: `No manifest registered for namespace '${ns}'.` }] };
    const channels = (JSON.parse(row.manifest).channels || []).map(c => c.name);
    const shadowed = channels.filter(c => stmtSchemaGet.get(c));
    const active = channels.filter(c => !shadowed.includes(c));
    return { content: [{ type: "text", text:
      `Namespace: ${row.ns}\nVersion: ${row.version ?? "null"}\nUpdated: ${new Date(row.updated_at).toISOString()}\n${adoptionLine(adoptionState(ns))}\n` +
      `Active channels: ${active.join(", ") || "(none)"}\nShadowed by v2 schema: ${shadowed.join(", ") || "(none)"}\n\n${row.manifest}` }] };
  });

  // ── adopt_namespace ─────────────────────────────────────────────────────────
  // Admin-only: in no role profile, and a v3 tool, so neither v2 nor profiled sessions see it. That
  // only hides it (role=admin is self-asserted), so adopt/revert also need admin_token == ADMIN_SECRET.
  server.registerTool("adopt_namespace", {
    title: "Adopt (or revert) full v3 for a namespace",
    description: "Opt a namespace in to v3 identity: watchdogs start_worker launches for it from now on send role= in their MCP URL and key heartbeats/cursors/ledger on `as` (inbox minus '<ns>-') instead of the worker path basename. Stored in the broker DB — no restart; running watchdogs are untouched until restarted. Cursor rows of every renamed entry are copied (never moved, only raised) to the new key; revert=true copies them back and restores v2 identity. Requires a registered manifest. Adopt and revert require admin_token (the broker's ADMIN_SECRET, not held by worker sessions); dry_run=true needs no token, reports the renamed entries and cursor copies and changes nothing.",
    inputSchema: {
      ns: z.string().min(1).describe("Namespace prefix without the dash, e.g. 'cb'."),
      dry_run: z.boolean().optional().describe("Report what would change; write nothing. Default false."),
      revert: z.boolean().optional().describe("Undo a previous adoption (back to v2 identity). Default false."),
      admin_token: z.string().optional().describe("The broker's ADMIN_SECRET. Required unless dry_run=true."),
    },
  }, async ({ ns, dry_run, revert, admin_token }) => {
    try {
      const report = await adoptNamespace(ns, { dry_run: !!dry_run, revert: !!revert, admin_token });
      return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `adopt_namespace: ${e.message}` }], isError: true };
    }
  });
}
