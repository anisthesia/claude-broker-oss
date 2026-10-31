// Builds one McpServer per request and registers every tool group in the original order.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VERSION } from "../config.js";
import { metricTool } from "../db.js";
import { registerMessagingTools, registerBatchTools, registerGetMessageTool } from "./messaging.js";
import { registerChannelTools } from "./channels.js";
import { registerCapabilityTools } from "./capabilities.js";
import { registerLatestTools, registerHeartbeatTools } from "./telemetry.js";
import { registerSchemaTools } from "./schemas.js";
import { registerWorkerListTools, registerWorkerAdminTools } from "./workers.js";
import { registerCursorTools } from "./cursors.js";
import { registerSprintTools } from "./sprint.js";
import { registerNamespaceTools } from "./namespaces.js";
import { registerTypedTools } from "./typed.js";
import { allowedTools, BRIEF, V3_TOOLS } from "../profiles.js";

// ── MCP server builder ────────────────────────────────────────────────────────

// identity: { role, ns, as } from the MCP URL query, or null for the v2 (pre-v3) tool list.
export function buildServer(identity = null) {
  const server = new McpServer({ name: "claude-broker", version: VERSION });
  const allowed = allowedTools(identity);
  const hidden = new Set();

  // Count calls / errors / latency per tool without touching each handler. Under a role profile,
  // tools outside it are never registered (so they stay out of tools/list) and the rest get the
  // short description. With no identity the v3 tools are left out and everything else is registered
  // untouched, so tools/list is byte-identical to the pre-v3 broker.
  const registerToolRaw = server.registerTool.bind(server);
  const registerToolTimed = (name, cfg, handler) => registerToolRaw(name, cfg, async (...args) => {
    const t0 = Date.now();
    let isError = false;
    try {
      const out = await handler(...args);
      isError = !!out?.isError;
      return out;
    } catch (e) { isError = true; throw e; }
    finally { metricTool(name, Date.now() - t0, isError); }
  });
  server.registerTool = (name, cfg, handler) => {
    if (!identity && V3_TOOLS.includes(name)) { hidden.add(name); return undefined; }
    if (!allowed) return registerToolTimed(name, cfg, handler);
    if (!allowed.has(name)) { hidden.add(name); return undefined; }
    return registerToolTimed(name, BRIEF[name] ? { ...cfg, description: BRIEF[name] } : cfg, handler);
  };

  registerMessagingTools(server, identity);
  registerChannelTools(server, identity);
  registerCapabilityTools(server);
  registerLatestTools(server);
  registerSchemaTools(server);
  registerWorkerListTools(server);
  registerCursorTools(server);
  registerBatchTools(server);
  registerHeartbeatTools(server);
  registerSprintTools(server);
  registerWorkerAdminTools(server);
  // v3 tools go last so the v2 tools/list order is unchanged.
  registerNamespaceTools(server);
  registerGetMessageTool(server);
  registerTypedTools(server, identity);

  if (allowed || !identity) applyProfile(server, identity, hidden);
  return server;
}

// Answer calls to hidden tools with an error naming the role, or for a connection with no identity
// the ?role= to reconnect with (the SDK alone says a bare "Tool X not found"). Under a role profile
// also drop SDK boilerplate a client never needs from tools/list — the $schema URI, the display
// title, and execution when it is the default taskSupport:forbidden; the no-identity list is left
// as is. The SDK has no public hook for either, so this wraps its registered request handlers.
function applyProfile(server, identity, hidden) {
  const handlers = server.server._requestHandlers;
  const call = handlers?.get("tools/call"), list = handlers?.get("tools/list");
  if (!call || !list) throw new Error("buildServer: MCP SDK tool handlers not found — cannot apply role profile");
  handlers.set("tools/call", (request, extra) => {
    const name = request?.params?.name;
    if (!hidden.has(name)) return call(request, extra);
    const text = identity
      ? `Tool '${name}' is not available to role '${identity.role}' — reconnect with a role whose profile includes it (role=admin has every tool).`
      : `Tool '${name}' is a v3 tool and needs an identity — reconnect with /mcp?role=<worker|reviewer|orchestrator|admin>&ns=<ns>&as=<name> (role=admin has every tool).`;
    return Promise.resolve({ content: [{ type: "text", text }], isError: true });
  });
  if (!identity) return;
  handlers.set("tools/list", async (request, extra) => {
    const out = await list(request, extra);
    return {
      ...out,
      tools: out.tools.map(({ title, execution, inputSchema: { $schema, ...inputSchema }, ...tool }) => ({
        ...tool, inputSchema,
        ...(execution && execution.taskSupport !== "forbidden" ? { execution } : {}),
      })),
    };
  });
}
