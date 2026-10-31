#!/usr/bin/env node
import "dotenv/config";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { VERSION, PORT, SHARED_SECRET, PRUNE_MAX_AGE_MS, PRUNE_EXEMPT } from "./lib/config.js";
import { auth } from "./lib/auth.js";
import { adoptOrphanWatchdogs } from "./lib/workers.js";
import { db } from "./lib/db.js";
import { app } from "./lib/app.js";
import { buildServer } from "./lib/tools/index.js";
import { identityFromQuery } from "./lib/profiles.js";
// Route modules register on the shared app at import time — keep this order (it is the route order).
import "./lib/rest.js";
import "./lib/dashboard/index.js";
import "./lib/dashboard/channel.js";

// Auth middleware
if (SHARED_SECRET) {
  app.use("/mcp", auth);
} else {
  console.warn("[claude-broker] WARNING: SHARED_SECRET is not set — broker is UNAUTHENTICATED (BROKER_ALLOW_NO_AUTH=1). Do not expose to any untrusted network.");
}

// Stateless transport: there is no SSE stream to open (GET) or session to close (DELETE).
// Answer with a JSON-RPC-shaped 405 instead of Express's HTML 404 so probing clients see why.
const mcpMethodNotAllowed = (_req, res) => res.status(405).set("Allow", "POST")
  .json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this broker runs the stateless Streamable HTTP transport — use POST /mcp" }, id: null });
app.get("/mcp", mcpMethodNotAllowed);
app.delete("/mcp", mcpMethodNotAllowed);

app.post("/mcp", async (req, res) => {
  // Disable socket inactivity timeout so long-polling tools (wait_for_messages up to 300s)
  // don't get dropped mid-call by Node.js's default socket timeout.
  req.socket.setTimeout(0);
  // Connection identity (/mcp?role=&ns=&as=) scopes tools/list to a role profile; none = all tools.
  const { identity, error } = identityFromQuery(req.query);
  if (error) return res.status(400).json({ jsonrpc: "2.0", error: { code: -32602, message: `Invalid MCP URL: ${error}` }, id: null });
  try {
    const server    = buildServer(identity);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[claude-broker] handler error:", err);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
});

const httpServer = app.listen(PORT, () => {
  console.log(`[claude-broker] v${VERSION} listening on :${PORT}  auth:${SHARED_SECRET ? "on" : "OFF"}  prune:${PRUNE_MAX_AGE_MS / 3600000}h  exempt:[${PRUNE_EXEMPT.join(",")}]`);
  console.log(`[claude-broker] dashboard: http://localhost:${PORT}/dashboard`);
});
// Disable server-level request timeout: long-poll tools can legitimately take up to 300s.
httpServer.requestTimeout = 0;

adoptOrphanWatchdogs();

// ── Graceful shutdown ────────────────────────────────────────────────────────
// Close the listener, checkpoint the WAL, and close the DB so no data is lost and
// the -wal file doesn't grow unbounded across restarts.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[claude-broker] ${signal} received — shutting down`);
  httpServer.close(() => {
    try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* best effort */ }
    try { db.close(); } catch { /* already closed */ }
    console.log("[claude-broker] shutdown complete");
    process.exit(0);
  });
  // Force-exit if connections don't drain in time.
  setTimeout(() => {
    console.warn("[claude-broker] forced exit after timeout");
    try { db.pragma("wal_checkpoint(TRUNCATE)"); db.close(); } catch { /* best effort */ }
    process.exit(1);
  }, 10000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
