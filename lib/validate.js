// Per-channel JSON Schema validation (Ajv), cached by schema updated_at.
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { stmtSchemaGet } from "./db.js";
import { validateManifestContent } from "./namespaces.js";

// ── AJV schema validation ─────────────────────────────────────────────────────

export const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
export const validatorCache = new Map();

function getValidator(channel) {
  const row = stmtSchemaGet.get(channel);
  if (!row) { validatorCache.delete(channel); return null; }
  const cached = validatorCache.get(channel);
  if (cached && cached.updated_at === row.updated_at) return { validate: cached.validate, strict: row.strict, broken: cached.broken ?? null };
  let validate;
  try { validate = ajv.compile(JSON.parse(row.schema)); }
  catch (e) {
    // A registered but uncompilable schema still wins over the manifest (v2 precedence), never validating
    // against something else: a strict channel rejects every message (fails closed), a warn one accepts.
    console.error(`[claude-broker] schema compile error '${channel}': ${e.message} — ${row.strict ? "rejecting (strict)" : "accepting messages unvalidated"}`);
    validatorCache.set(channel, { validate: () => true, updated_at: row.updated_at, broken: e.message || "compile error" });
    return { validate: () => true, strict: row.strict, broken: e.message || "compile error" };
  }
  validatorCache.set(channel, { validate, updated_at: row.updated_at });
  return { validate, strict: row.strict };
}

export function validateContent(channel, content) {
  const v = getValidator(channel);
  // v2 precedence: a channel with a registered schema keeps v2 behaviour exactly; only channels
  // without one fall through to their namespace manifest (v3), if any.
  if (!v) return validateManifestContent(channel, content);
  if (v.broken) return v.strict ? { ok: false, strict: true, v2: true, errors: `schema does not compile: ${v.broken}` } : { ok: true };
  let parsed;
  try { parsed = JSON.parse(content); }
  catch (e) {
    // A channel with a schema expects JSON envelopes — plain text can never satisfy it.
    // strict → reject, warn-only → warn + accept (same contract as a schema mismatch).
    return { ok: false, strict: !!v.strict, v2: true, errors: `content is not valid JSON (${e.message})` };
  }
  if (v.validate(parsed)) return { ok: true };
  const errors = (v.validate.errors || []).map(e => `${e.instancePath || "/"} ${e.message}`).join("; ");
  return { ok: false, strict: !!v.strict, v2: true, errors };
}

// The get_channel_schema pointer only helps on a v2-schema channel; manifest errors already name
// their source and end with get_namespace(...).
export function schemaHint(channel, check) {
  return check.v2 ? `. Call get_channel_schema('${channel}') to see required fields.` : "";
}
