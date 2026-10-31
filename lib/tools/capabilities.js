// MCP tools: worker capability registry.
import { z } from "zod";
import { stmtCapUpsert, stmtCapList, stmtCapDel } from "../db.js";

export function registerCapabilityTools(server) {
  // ── register_capability ─────────────────────────────────────────────────────
  server.registerTool("register_capability", {
    title: "Register worker capability",
    description: "Declare what a worker owns and which channels it uses. Workers should call this at startup so the orchestrator can route by capability instead of hardcoded role names.",
    inputSchema: {
      worker:   z.string().min(1).describe("Worker identifier, e.g. 'backend', 'frontend'."),
      owns:     z.array(z.string()).describe("List of domains/responsibilities this worker owns."),
      channels: z.array(z.string()).describe("List of channels this worker reads/writes."),
    },
  }, async ({ worker, owns, channels }) => {
    const now = Date.now();
    stmtCapUpsert.run(worker, JSON.stringify(owns), JSON.stringify(channels), now);
    return { content: [{ type: "text", text: `Registered capabilities for '${worker}' at ${new Date(now).toISOString()}.` }] };
  });

  // ── list_capabilities ───────────────────────────────────────────────────────
  server.registerTool("list_capabilities", {
    title: "List worker capabilities",
    description: "Show the capability registry — what each worker owns and which channels it uses.",
    inputSchema: {},
  }, async () => {
    const rows = stmtCapList.all();
    if (rows.length === 0) return { content: [{ type: "text", text: "(no capabilities registered yet)" }] };
    const lines = rows.map(r =>
      `${r.worker}\towns=${r.owns}\tchannels=${r.channels}\tupdated=${new Date(r.updated_at).toISOString()}`
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  });

  // ── deregister_capability ───────────────────────────────────────────────────
  server.registerTool("deregister_capability", {
    title: "Deregister worker capability",
    description: "Remove a worker from the capability registry.",
    inputSchema: {
      worker: z.string().min(1),
    },
  }, async ({ worker }) => {
    const r = stmtCapDel.run(worker);
    return { content: [{ type: "text", text: r.changes ? `Deregistered '${worker}'.` : `No capability entry found for '${worker}'.` }] };
  });
}
