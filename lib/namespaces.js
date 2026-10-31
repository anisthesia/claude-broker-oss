// v3 protocol: built-in base schemas (schemas/base/*.json) plus per-namespace manifests stored in
// SQLite. A channel with a v2 schema (channel_schemas) never reaches this module — validate.js
// checks that first — so manifests only govern channels with no v2 schema (or after clear_channel_schema).
//
// Validation of one message on a manifest channel runs independent validators and ANDs them, so
// every error can name its source:
//   base/<type>                    schemas/base/<type>.json (or the implied envelope for a local type)
//   manifest <ns> ...              namespace / channel extension fragments, local_types, closed allow-list
//   manifest <ns> role <role>      roles.<role>.extensions — applied when the envelope's `from` has that role
// roles.<role>.summary_prefixes is the one widening a manifest may make: it extends the base result
// summary prefix (PASS|FAIL|SKIP) for senders with that role (cb-notes decision #168904).
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { stmtNsStamp, stmtNsGet } from "./db.js";

// Own Ajv instance: base schemas carry $ids, and v2 channel schemas must never collide with them.
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const SCHEMAS_DIR = fileURLToPath(new URL("../schemas/", import.meta.url));
export const BASE_DIR = process.env.BASE_SCHEMAS_DIR || join(SCHEMAS_DIR, "base");

const stripId = (s) => { const { $id, $schema, ...rest } = s; return rest; };
const clone = (o) => JSON.parse(JSON.stringify(o));

// ── Base schemas ──────────────────────────────────────────────────────────────

// type → { file, schema, validate }. One file may cover several types (deferred + deferred-resolved).
export const baseTypes = new Map();

function loadBase() {
  if (!existsSync(BASE_DIR)) {
    console.error(`[claude-broker] base protocol: ${BASE_DIR} not found — manifests can only use local_types`);
    return;
  }
  for (const f of readdirSync(BASE_DIR).filter(f => f.endsWith(".json")).sort()) {
    let schema;
    try { schema = JSON.parse(readFileSync(join(BASE_DIR, f), "utf8")); }
    catch (e) { console.error(`[claude-broker] base protocol: ${f} is not valid JSON: ${e.message}`); continue; }
    const t = schema.properties?.type;
    const types = t?.const ? [t.const] : Array.isArray(t?.enum) ? t.enum : [];
    if (!types.length) { console.error(`[claude-broker] base protocol: ${f} has no properties.type const/enum — skipped`); continue; }
    let validate;
    try { validate = ajv.compile(stripId(schema)); }
    catch (e) { console.error(`[claude-broker] base protocol: ${f} does not compile: ${e.message}`); continue; }
    const file = `base/${f.replace(/\.json$/, "")}`;
    for (const type of types) baseTypes.set(type, { file, schema, validate });
  }
  console.log(`[claude-broker] base protocol: ${baseTypes.size} types from ${BASE_DIR} (${[...baseTypes.keys()].join(", ")})`);
}
loadBase();

// Base result with the summary prefix widened for a role. Cached by prefix list.
const widenedCache = new Map();
function widenedBase(type, prefixes) {
  const base = baseTypes.get(type);
  const key = `${type}|${prefixes.join("|")}`;
  if (widenedCache.has(key)) return widenedCache.get(key);
  const s = stripId(clone(base.schema));
  const esc = prefixes.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  s.properties.summary = { ...s.properties.summary, pattern: `^(PASS|FAIL|SKIP|${esc.join("|")})\\b` };
  const v = ajv.compile(s);
  widenedCache.set(key, v);
  return v;
}

// Envelope implied for local_types unless envelope:false.
const ENVELOPE_PROPS = {
  type:    { type: "string" },
  task_id: { type: "string", minLength: 1 },
  from:    { type: "string", minLength: 1 },
  to:      { type: "string", minLength: 1 },
  subject: { type: "string", minLength: 1 },
  body:    {},
  refs:    { type: "array" },
};
const ENVELOPE_REQUIRED = ["type", "task_id", "from", "to", "subject"];
const envelopeValidate = ajv.compile({ type: "object", required: ENVELOPE_REQUIRED, properties: ENVELOPE_PROPS });

// ── Manifest meta-schema ──────────────────────────────────────────────────────

// schemas/manifest.schema.json plus `roles`, which the loader understands but the file may not
// declare yet (role-level extensions, decision #168904).
function loadMetaSchema() {
  const meta = stripId(JSON.parse(readFileSync(join(SCHEMAS_DIR, "manifest.schema.json"), "utf8")));
  meta.properties.roles ??= {
    type: "object",
    description: "Role-level extensions, applied when the envelope's `from` is a worker with that role.",
    propertyNames: { enum: ["orchestrator", "worker", "reviewer"] },
    additionalProperties: {
      type: "object",
      properties: {
        summary_prefixes: {
          type: "array", uniqueItems: true,
          items: { type: "string", pattern: "^[A-Z][A-Z_-]*$" },
          description: "Extra result summary prefixes accepted besides PASS/FAIL/SKIP, e.g. APPROVE/ADVISE/BLOCK.",
        },
        extensions: meta.properties.extensions,
      },
      additionalProperties: false,
    },
  };
  // Plan gate opt-in (docs/protocol-v3.md "Plan gate"): off unless the manifest says plan_gate: true.
  meta.properties.plan_gate ??= {
    type: "boolean", default: false,
    description: "Enable the plan gate: post_plan / decide_plan, and medium|large tasks default to plan_required in the ledger.",
  };
  return ajv.compile(meta);
}
let metaValidate = null;
try { metaValidate = loadMetaSchema(); }
catch (e) { console.error(`[claude-broker] manifest.schema.json unavailable: ${e.message}`); }

// ── Manifest compilation ──────────────────────────────────────────────────────

const and = (a, b) => (a === undefined ? b : { allOf: [a, b] });

// Extension entry → one JSON Schema fragment (ANDed with the base by the caller).
function fragmentOf(ext) {
  const props = { ...(ext.properties || {}) };
  for (const [k, vals] of Object.entries(ext.enums || {}))    props[k] = and(props[k], { enum: vals });
  for (const [k, src]  of Object.entries(ext.patterns || {})) props[k] = and(props[k], { type: "string", pattern: src });
  const s = {};
  if (Object.keys(props).length) s.properties = props;
  if (ext.required?.length) s.required = ext.required;
  if (ext.allOf?.length) s.allOf = ext.allOf;
  return s;
}

function declaredFields(ext) {
  if (!ext) return [];
  return [...Object.keys(ext.properties || {}), ...Object.keys(ext.enums || {}),
          ...Object.keys(ext.patterns || {}), ...(ext.required || [])];
}

// Extensions for `type` from one extensions map; key 'deferred' also covers 'deferred-resolved'.
function extFor(map, type) {
  if (!map) return [];
  const out = [];
  if (type === "deferred-resolved" && map.deferred) out.push(map.deferred);
  if (map[type]) out.push(map[type]);
  return out;
}

// Throws Error with a readable message on any semantic problem or compile failure.
export function compileManifest(manifest) {
  if (!metaValidate) throw new Error("manifest meta-schema (schemas/manifest.schema.json) is not loaded");
  if (!metaValidate(manifest)) {
    throw new Error(`manifest does not match manifest.schema.json: ${formatErrors(metaValidate.errors, "manifest.schema")}`);
  }
  const { ns } = manifest;
  const tag = `manifest ${ns}`;
  const local = manifest.local_types || {};
  const known = (t) => baseTypes.has(t) || Object.hasOwn(local, t);
  const problems = [];

  for (const t of Object.keys(local)) if (baseTypes.has(t)) problems.push(`local_types.${t} shadows a base type`);
  for (const t of Object.keys(manifest.extensions || {})) if (!known(t)) problems.push(`extensions.${t}: unknown type`);
  for (const [role, r] of Object.entries(manifest.roles || {}))
    for (const t of Object.keys(r.extensions || {})) if (!known(t)) problems.push(`roles.${role}.extensions.${t}: unknown type`);

  const seen = new Set();
  for (const ch of manifest.channels) {
    if (!ch.name.startsWith(`${ns}-`)) problems.push(`channel '${ch.name}' is outside namespace '${ns}-'`);
    if (seen.has(ch.name)) problems.push(`channel '${ch.name}' declared twice`);
    seen.add(ch.name);
    for (const t of ch.types) if (!known(t)) problems.push(`channel '${ch.name}': unknown type '${t}' (not a base type or local_types entry)`);
    for (const t of Object.keys(ch.extensions || {})) if (!ch.types.includes(t)) problems.push(`channel '${ch.name}': extension for '${t}' which the channel does not accept`);
  }
  if (problems.length) throw new Error(problems.join("; "));

  const roleOf = new Map(manifest.workers.map(w => [w.name, w.role]));
  const channels = new Map();
  try {
    for (const ch of manifest.channels) {
      const types = new Map();
      for (const type of ch.types) {
        const def = local[type];
        const nsExts = extFor(manifest.extensions, type);
        const chExts = extFor(ch.extensions, type);
        const exts = [...nsExts, ...chExts];
        const v = { checks: [], roleChecks: new Map(), basePrefixes: new Map() };

        // Base (or implied envelope for a local type).
        if (def) {
          if (def.envelope !== false) v.checks.push({ source: "base envelope", validate: envelopeValidate });
          v.checks.push({ source: `${tag} local_types.${type}`, validate: ajv.compile(fragmentOf(def)) });
        } else {
          v.base = baseTypes.get(type);
        }

        // Extension fragments, ANDed: namespace-level then channel-level.
        for (const e of nsExts) v.checks.push({ source: `${tag} extensions.${type}`, validate: ajv.compile(fragmentOf(e)) });
        for (const e of chExts) v.checks.push({ source: `${tag} channel ${ch.name} extensions.${type}`, validate: ajv.compile(fragmentOf(e)) });

        // Closed allow-list. `fields` (channel first) is exact; otherwise base ∪ extensions ∪ envelope.
        const fields = [...chExts].reverse().find(e => e.fields)?.fields ?? [...nsExts].reverse().find(e => e.fields)?.fields;
        const closedFlag = [...chExts].reverse().find(e => e.closed !== undefined)?.closed
          ?? [...nsExts].reverse().find(e => e.closed !== undefined)?.closed
          ?? def?.closed ?? ch.closed ?? manifest.closed ?? false;
        if (fields || closedFlag) {
          const allowed = new Set(fields || [
            ...(def ? (def.envelope !== false ? Object.keys(ENVELOPE_PROPS) : ["type"]) : Object.keys(v.base.schema.properties || {})),
            ...declaredFields(def),
            ...exts.flatMap(declaredFields),
          ]);
          allowed.add("type");
          v.checks.push({
            source: `${tag} ${fields ? "fields" : "closed"} (${type})`,
            validate: ajv.compile({ properties: Object.fromEntries([...allowed].map(f => [f, true])), additionalProperties: false }),
          });
        }

        // Role-level: widened result prefixes and per-role fragments.
        for (const [role, r] of Object.entries(manifest.roles || {})) {
          if (v.base && r.summary_prefixes?.length && v.base.schema.properties?.summary?.pattern) {
            v.basePrefixes.set(role, { validate: widenedBase(type, r.summary_prefixes), prefixes: r.summary_prefixes });
          }
          const re = extFor(r.extensions, type);
          if (re.length) v.roleChecks.set(role, re.map(e => ({ source: `${tag} roles.${role}.extensions.${type}`, validate: ajv.compile(fragmentOf(e)) })));
        }
        types.set(type, v);
      }
      channels.set(ch.name, { strict: ch.strict ?? manifest.strict ?? false, types });
    }
  } catch (e) {
    throw new Error(`manifest fragment does not compile: ${e.message}`);
  }
  const workers = new Map(manifest.workers.map(w => [w.name, w]));
  const rolePrefixes = new Map(Object.entries(manifest.roles || {}).map(([role, r]) => [role, r.summary_prefixes || []]));
  // Plan gate: task fields the manifest requires of a dispatch from `role` to `inbox` — the `required`
  // lists of extensions.task at namespace, roles.<role> and channel level. null = none (warn only).
  const taskRequired = (role, inbox) => {
    const ch = manifest.channels.find(c => c.name === inbox);
    const req = [...extFor(manifest.extensions, "task"), ...extFor(manifest.roles?.[role]?.extensions, "task"),
                 ...extFor(ch?.extensions, "task")].flatMap(e => e.required || []);
    return req.length ? [...new Set(req)] : null;
  };
  return { ns, version: manifest.version ?? null, strict: !!manifest.strict, planGate: manifest.plan_gate === true, roleOf, workers, rolePrefixes, taskRequired, channels };
}

// ── Runtime cache (hot reload by updated_at, like channel schemas) ────────────

const nsCache = new Map(); // ns → { updated_at, compiled }

export function invalidateNamespace(ns) { nsCache.delete(ns); }

// Compiled manifest for ns (null when none is registered or it no longer compiles).
export function getNamespace(ns) { return getCompiled(ns); }

function getCompiled(ns) {
  const stamp = stmtNsStamp.get(ns);
  if (!stamp) { nsCache.delete(ns); return null; }
  const cached = nsCache.get(ns);
  if (cached && cached.updated_at === stamp.updated_at) return cached.compiled;
  const row = stmtNsGet.get(ns);
  let compiled = null;
  try { compiled = compileManifest(JSON.parse(row.manifest)); }
  catch (e) { console.error(`[claude-broker] namespace '${ns}' manifest no longer compiles: ${e.message}`); }
  nsCache.set(ns, { updated_at: row.updated_at, compiled });
  return compiled;
}

// ── Validation ────────────────────────────────────────────────────────────────

function formatErrors(errors, source) {
  return (errors || [])
    .filter(e => e.keyword !== "if")
    .map(e => {
      const extra = e.params?.missingProperty ?? e.params?.additionalProperty;
      const field = `${e.instancePath || ""}${extra !== undefined ? `/${extra}` : ""}` || "/";
      const msg = e.keyword === "additionalProperties" || e.keyword === "false schema" ? "is not allowed" : e.message;
      return `${field} ${msg} [${source}]`;
    })
    .join("; ");
}

// The channel's manifest entry, or null when the channel is not governed by a manifest.
export function manifestChannel(channel) {
  const dash = channel.indexOf("-");
  if (dash <= 0) return null;
  const compiled = getCompiled(channel.slice(0, dash));
  const ch = compiled?.channels.get(channel);
  return ch ? { compiled, ch } : null;
}

// Same contract as validateContent: { ok } or { ok:false, strict, errors }.
export function validateManifestContent(channel, content) {
  const m = manifestChannel(channel);
  if (!m) return { ok: true };
  const { compiled, ch } = m;
  const tag = `manifest ${compiled.ns}`;
  const fail = (errors) => ({ ok: false, strict: !!ch.strict, errors: `${errors} (see get_namespace('${compiled.ns}'))` });

  let msg;
  try { msg = JSON.parse(content); }
  catch (e) { return fail(`content is not valid JSON (${e.message}) [${tag}]`); }
  if (msg === null || typeof msg !== "object" || Array.isArray(msg)) return fail(`/ must be a JSON object envelope [${tag}]`);
  const accepted = [...ch.types.keys()].join("|");
  if (typeof msg.type !== "string") return fail(`/type is required; ${channel} accepts ${accepted} [${tag}]`);
  const v = ch.types.get(msg.type);
  if (!v) return fail(`/type '${msg.type}' is not accepted on ${channel}; accepts ${accepted} [${tag} channel ${channel}]`);

  const role = typeof msg.from === "string" ? compiled.roleOf.get(msg.from) : undefined;
  const errs = [];
  if (v.base) {
    const widened = role && v.basePrefixes.get(role);
    const validate = widened ? widened.validate : v.base.validate;
    const source = widened ? `${v.base.file} + ${tag} roles.${role}.summary_prefixes` : v.base.file;
    if (!validate(msg)) errs.push(formatErrors(validate.errors, source));
  }
  const checks = role && v.roleChecks.has(role) ? [...v.checks, ...v.roleChecks.get(role)] : v.checks;
  for (const c of checks) if (!c.validate(msg)) errs.push(formatErrors(c.validate.errors, c.source));
  const errors = errs.filter(Boolean).join("; ");
  return errors ? fail(errors) : { ok: true };
}
