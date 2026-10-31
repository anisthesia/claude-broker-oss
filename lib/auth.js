// Bearer-token checks and the Express auth middlewares built on them.
import { timingSafeEqual, createHash } from "crypto";
import { AsyncLocalStorage } from "async_hooks";
import { SHARED_SECRET, ADMIN_SECRET } from "./config.js";
import { setInsertGuard } from "./db.js";
import { getNamespace } from "./namespaces.js";

// Constant-time bearer-token check — avoids leaking the secret via response timing.
function secretMatches(header) {
  const expected = `Bearer ${SHARED_SECRET}`;
  const a = Buffer.from(String(header || ""));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
function tokenMatches(token) {
  if (!token) return false;
  const a = Buffer.from(String(token));
  const b = Buffer.from(SHARED_SECRET);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Constant-time check of an admin_token against ADMIN_SECRET (held by humans, not worker sessions).
// False when ADMIN_SECRET is unset — callers report that case separately (adminConfigured).
export const adminConfigured = () => !!ADMIN_SECRET;
export function adminTokenMatches(token) {
  if (!ADMIN_SECRET || !token) return false;
  const a = Buffer.from(String(token));
  const b = Buffer.from(ADMIN_SECRET);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Reusable auth middleware — pass as route-level middleware on protected endpoints.
export function auth(req, res, next) {
  if (!SHARED_SECRET) return next();
  if (!secretMatches(req.headers.authorization)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// Dashboard auth — browsers can't set an Authorization header on page loads,
// so the dashboard routes also accept ?token=<secret>. Rendered links must
// propagate the token (see tokenParam in the dashboard handlers).
export function dashboardAuth(req, res, next) {
  if (!SHARED_SECRET) return next();
  if (secretMatches(req.headers.authorization) || tokenMatches(req.query.token)) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

// ── Orchestrator credential (reserved senders) ────────────────────────────────
// Every session holds SHARED_SECRET and ?as=/?role= are self-asserted, so neither proves a write came
// from the orchestrator. In each namespace listed in ORCHESTRATOR_TRUST_NAMESPACES, a write onto a
// '<ns>-*' channel under a reserved orchestrator name (see orchestratorNames) needs an
// X-Orchestrator-Token header whose sha256 equals ORCHESTRATOR_TOKEN_SHA256. The broker keeps only
// the hash: lib/workers.js hands process.env to spawned watchdogs, so a plain token would reach every
// worker. With either variable unset nothing is reserved. Rows written before enforcement keep
// whatever trust their sender column gave them.
const ORCHESTRATOR_TOKEN_SHA256 = (process.env.ORCHESTRATOR_TOKEN_SHA256 || "").trim().toLowerCase();
const TRUST_NAMESPACES = (process.env.ORCHESTRATOR_TRUST_NAMESPACES || "").split(",").map(s => s.trim()).filter(Boolean);

// Per-request context, entered by the lib/rest.js middleware; MCP tool handlers run inside it.
export const requestContext = new AsyncLocalStorage();

export function orchestratorTokenOk(token) {
  if (!ORCHESTRATOR_TOKEN_SHA256 || typeof token !== "string" || !token) return false;
  const a = createHash("sha256").update(token.trim()).digest();
  const b = Buffer.from(ORCHESTRATOR_TOKEN_SHA256, "hex");
  return b.length === a.length && timingSafeEqual(a, b);
}

// Names that mean "the orchestrator" in a namespace: 'orchestrator' plus its manifest's orchestrator-role workers.
export function orchestratorNames(ns) {
  const names = new Set(["orchestrator"]);
  const m = ns ? getNamespace(ns) : null;
  if (m) for (const [name, w] of m.workers) if (w.role === "orchestrator") names.add(name);
  return names;
}

// Refusal text when this request may not write to `channel` as `sender`, else null.
export function reservedSenderRefusal(channel, sender) {
  if (!ORCHESTRATOR_TOKEN_SHA256 || !TRUST_NAMESPACES.length || typeof channel !== "string") return null;
  // Case-insensitive on purpose: a 'CB-core' write as orchestrator is refused like 'cb-core'. The trust readers
  // match the prefix exact-case (lib/db.js stmtTrustedDispatch), so rows from before this guard stay ignored.
  const lc = channel.toLowerCase();
  const ns = TRUST_NAMESPACES.find(n => lc.startsWith(`${n.toLowerCase()}-`));
  if (!ns || !orchestratorNames(ns).has(sender)) return null;
  if (requestContext.getStore()?.orchestrator) return null;
  return `sender '${sender}' is reserved for the orchestrator in namespace '${ns}' (ORCHESTRATOR_TRUST_NAMESPACES): ` +
    `the request needs an X-Orchestrator-Token header whose sha256 matches the broker's ORCHESTRATOR_TOKEN_SHA256. ` +
    `Add it to the broker MCP entry's headers (runner/orchestrate.mjs sends ORCHESTRATOR_TOKEN), or post under your own name.`;
}
setInsertGuard(reservedSenderRefusal);

// Orchestrator trust as configured: enforcement needs both the token hash and a namespace list.
export const orchestratorTrust = () => ({ enabled: !!ORCHESTRATOR_TOKEN_SHA256 && TRUST_NAMESPACES.length > 0, namespaces: [...TRUST_NAMESPACES] });
export const isTrustNamespace = (ns) => typeof ns === "string" && TRUST_NAMESPACES.some(n => n.toLowerCase() === ns.toLowerCase());

// ── Verifier credential (POST /verifications) ─────────────────────────────────
// Any SHARED_SECRET holder can stamp a verification, so a worker could overwrite its own FAIL with
// all-PASS checks. For a status channel in a namespace listed in VERIFIER_TRUST_NAMESPACES, POST
// /verifications needs an X-Verifier-Token header whose sha256 equals VERIFIER_TOKEN_SHA256. The token
// itself lives only with the standalone verifier (verify-result.mjs --watch under launchd), outside every
// worker's process tree; the broker keeps the hash. With either variable unset nothing changes.
const VERIFIER_TOKEN_SHA256 = (process.env.VERIFIER_TOKEN_SHA256 || "").trim().toLowerCase();
const VERIFIER_NAMESPACES = (process.env.VERIFIER_TRUST_NAMESPACES || "").split(",").map(s => s.trim()).filter(Boolean);

export function verifierTokenOk(token) {
  if (!VERIFIER_TOKEN_SHA256 || typeof token !== "string" || !token) return false;
  const a = createHash("sha256").update(token.trim()).digest();
  const b = Buffer.from(VERIFIER_TOKEN_SHA256, "hex");
  return b.length === a.length && timingSafeEqual(a, b);
}

// The namespace whose verifications need the token, for a status channel ('cb-status' → 'cb'), else null.
export function verifierRequired(statusChannel) {
  if (!VERIFIER_TOKEN_SHA256 || !VERIFIER_NAMESPACES.length || typeof statusChannel !== "string") return null;
  const lc = statusChannel.toLowerCase();
  return VERIFIER_NAMESPACES.find(n => lc.startsWith(`${n.toLowerCase()}-`)) || null;
}

// Verifier trust as configured (/health): watchdogs skip their own verification for these namespaces.
export const verifierTrust = () => ({ enabled: !!VERIFIER_TOKEN_SHA256 && VERIFIER_NAMESPACES.length > 0,
                                      namespaces: VERIFIER_TOKEN_SHA256 ? [...VERIFIER_NAMESPACES] : [] });
