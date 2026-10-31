// MCP tools: channel schema registry.
import { z } from "zod";
import { stmtSchemaGet, stmtSchemaUpsert, stmtSchemaDel, stmtSchemaList, stmtSchemaListPrefix } from "../db.js";
import { ajv, validatorCache } from "../validate.js";

export function registerSchemaTools(server) {
  // ── register_channel_schema ─────────────────────────────────────────────────
  server.registerTool("register_channel_schema", {
    title: "Register or replace a channel schema",
    description: "Bind a JSON Schema (draft-07) to a channel. Messages are validated on send_message.",
    inputSchema: {
      channel: z.string().min(1),
      schema:  z.string().min(2).describe("JSON Schema as a JSON-encoded string."),
      strict:  z.boolean().optional().describe("If true, invalid messages are rejected. Omit to keep the channel's current mode (warn-only for a new channel) — re-registering a schema never silently downgrades a strict channel."),
      version: z.string().optional().describe("Optional schema version string, e.g. '1.0'. Omit to keep the current version."),
    },
  }, async ({ channel, schema, strict, version }) => {
    let parsed;
    try { parsed = JSON.parse(schema); }
    catch (e) { return { content: [{ type: "text", text: `schema is not valid JSON: ${e.message}` }], isError: true }; }
    try { ajv.compile(parsed); }
    catch (e) { return { content: [{ type: "text", text: `schema does not compile as JSON Schema: ${e.message}` }], isError: true }; }
    const now = Date.now();
    const existing  = stmtSchemaGet.get(channel);
    const strictVal = strict === undefined ? (existing ? existing.strict : 0) : (strict ? 1 : 0);
    const versionVal = version ?? existing?.version ?? null;
    stmtSchemaUpsert.run(channel, schema, strictVal, now, versionVal);
    validatorCache.delete(channel);
    const kept = strict === undefined && existing ? " (strict mode preserved)" : "";
    return { content: [{ type: "text", text: `Registered schema for '${channel}' (strict=${strictVal ? "on" : "off"}${versionVal ? `, version=${versionVal}` : ""})${kept} at ${new Date(now).toISOString()}.` }] };
  });

  // ── get_channel_schema ──────────────────────────────────────────────────────
  server.registerTool("get_channel_schema", {
    title: "Get a channel's schema",
    description: "Return the JSON Schema bound to a channel, or indicate it is free-form.",
    inputSchema: {
      channel: z.string().min(1),
    },
  }, async ({ channel }) => {
    const row = stmtSchemaGet.get(channel);
    if (!row) return { content: [{ type: "text", text: `No schema registered for '${channel}' (free-form).` }] };
    const versionLine = row.version != null ? `\nVersion: ${row.version}` : "";
    return { content: [{ type: "text", text: `Channel: ${row.channel}\nStrict: ${row.strict ? "on" : "off (warn-only)"}${versionLine}\nUpdated: ${new Date(row.updated_at).toISOString()}\n\n${row.schema}` }] };
  });

  // ── clear_channel_schema ────────────────────────────────────────────────────
  server.registerTool("clear_channel_schema", {
    title: "Clear a channel's schema",
    description: "Remove the schema binding from a channel. The channel reverts to free-form.",
    inputSchema: {
      channel: z.string().min(1),
    },
  }, async ({ channel }) => {
    stmtSchemaDel.run(channel);
    validatorCache.delete(channel);
    return { content: [{ type: "text", text: `Cleared schema for '${channel}'.` }] };
  });

  // ── list_channel_schemas ────────────────────────────────────────────────────
  server.registerTool("list_channel_schemas", {
    title: "List channel schemas",
    description: "Show all channels with a schema bound, including strict-mode status. Pass prefix to filter by channel name prefix (e.g. 'cb-' returns only cb-* entries). Omit prefix to return all.",
    inputSchema: {
      prefix: z.string().optional().describe("Only return schemas for channels starting with this prefix, e.g. 'cb-'. Omit for all."),
    },
  }, async ({ prefix } = {}) => {
    const rows = prefix ? stmtSchemaListPrefix.all(`${prefix}%`) : stmtSchemaList.all();
    if (rows.length === 0) return { content: [{ type: "text", text: "(no channel schemas registered)" }] };
    const text = rows.map(r => `${r.channel}\tstrict=${r.strict ? "on" : "off"}\tversion=${r.version ?? "null"}\tupdated=${new Date(r.updated_at).toISOString()}`).join("\n");
    return { content: [{ type: "text", text }] };
  });
}
