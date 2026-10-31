// MCP tools: worker lifecycle (list/start/stop) and WORKERS_CONFIG registration.
import { z } from "zod";
import { readFileSync } from "fs";
import { WORKERS_CONFIG, WORKERS_LOG_DIR, WORKERS_TMUX_SESSION } from "../config.js";
import { assertSafeWorkerName, loadWorkerDefs, saveWorkerDefs, workerRunningInfo, startWorker, stopWorker } from "../workers.js";

export function registerWorkerListTools(server) {
  // ── list_workers ────────────────────────────────────────────────────────────
  server.registerTool("list_workers", {
    title: "List workers",
    description: "List all workers defined in the worker config with their running state, PID, and uptime. Use this to check which watchdogs are active before starting or stopping one.",
    inputSchema: {},
  }, async () => {
    const defs = loadWorkerDefs();
    if (!defs.length) return { content: [{ type: "text", text: "(no workers configured — set WORKERS_CONFIG)" }] };
    const lines = defs.map(w => {
      const info = workerRunningInfo(w.name);
      let state = "stopped";
      if (info) {
        const uptime = info.startedAt ? `${Math.floor((Date.now() - info.startedAt) / 1000)}s` : "?";
        state = `running  pid=${info.pid ?? "?"}  uptime=${uptime}${info.tmux ? `  tmux=${WORKERS_TMUX_SESSION}:${w.name}` : ""}`;
      }
      return `${w.name}\t${state}${w.model ? `\tmodel=${w.model}` : ""}`;
    });
    return { content: [{ type: "text", text: lines.join("\n") }] };
  });

  // ── start_worker ─────────────────────────────────────────────────────────────
  server.registerTool("start_worker", {
    title: "Start a worker watchdog",
    description: "Start the watchdog process for a named worker. The worker must be defined in the worker config (WORKERS_CONFIG). Returns the PID on success. No-ops (returns current PID) if already running. Pass model to override the default CLAUDE_MODEL for this session (e.g. 'claude-opus-4-7' for demanding tasks).",
    inputSchema: {
      name:  z.string().min(1).describe("Worker name as defined in WORKERS_CONFIG, e.g. 'backend', 'platform-orch'."),
      model: z.string().min(1).optional().describe("Claude model ID to use for this session, e.g. 'claude-opus-4-7'. Overrides the worker's configured model and the CLAUDE_MODEL env var. Omit to use the worker's \"model\" field from WORKERS_CONFIG, falling back to CLAUDE_MODEL (default claude-haiku-4-5-20251001)."),
    },
  }, async ({ name, model }) => {
    let r;
    try { r = startWorker(name, { model }); }
    catch (e) { return { content: [{ type: "text", text: e.message }], isError: true }; }
    if (r.already) {
      const where = r.tmux ? ` in tmux ${WORKERS_TMUX_SESSION}:${name}` : "";
      return { content: [{ type: "text", text: `Worker "${name}" already running${where} (pid ${r.pid ?? "?"}).` }] };
    }
    const modelNote = model ? ` [model: ${model}]` : "";
    const text = r.tmux
      ? `Started "${name}" in tmux session "${WORKERS_TMUX_SESSION}" window "${name}" (pid ${r.pid ?? "?"})${modelNote}.`
      : `Started "${name}" (pid ${r.pid})${modelNote}. Logs: ${WORKERS_LOG_DIR}/${name}.{out,err}.log`;
    return { content: [{ type: "text", text }] };
  });
}

export function registerWorkerAdminTools(server) {
  // ── stop_worker ──────────────────────────────────────────────────────────────
  server.registerTool("stop_worker", {
    title: "Stop a worker watchdog",
    description: "Stop the watchdog process for a named worker (SIGTERM to entire process group — kills watchdog + any in-flight Claude session). The worker will not restart until started again.",
    inputSchema: {
      name: z.string().min(1).describe("Worker name as defined in WORKERS_CONFIG, e.g. 'backend', 'platform-orch'."),
    },
  }, async ({ name }) => {
    let r;
    try { r = stopWorker(name); }
    catch (e) { return { content: [{ type: "text", text: e.message }], isError: true }; }
    const text = r.tmux
      ? `Stopped "${name}" (killed tmux window ${WORKERS_TMUX_SESSION}:${name}).`
      : `Stopped "${name}" (pid ${r.pid}).`;
    return { content: [{ type: "text", text }] };
  });

  // ── register_worker ──────────────────────────────────────────────────────────
  server.registerTool("register_worker", {
    title: "Register a new worker in WORKERS_CONFIG",
    description: "Add or update a worker definition in WORKERS_CONFIG. Constructs the args array from provided parameters and performs an atomic upsert: if a worker with the same name exists, it is replaced; otherwise a new entry is appended. No broker restart is required — the next worker start will use the updated definition.",
    inputSchema: {
      name: z.string().min(1).describe("Worker name, e.g. 'backend', 'qa-reviewer'. Letters, digits, dot, dash, underscore only (becomes a log filename and tmux window name)."),
      ns: z.string().min(1).describe("Namespace, e.g. 'team-a', 'infra' — used for tab organization in multi-session dashboards."),
      worker_dir: z.string().min(1).describe("Worker directory path relative to repo_root, e.g. 'workers/backend' or 'orchestrators/infra'."),
      repo_root: z.string().min(1).describe("Absolute path to the repository root, e.g. '/home/me/myrepo'."),
      inbox_channel: z.string().min(1).describe("Channel name for worker inbox, e.g. 'team-backend' or 'core'."),
    },
  }, async ({ name, ns, worker_dir, repo_root, inbox_channel }) => {
    if (!WORKERS_CONFIG)
      return { content: [{ type: "text", text: "Error: WORKERS_CONFIG env var not set" }], isError: true };

    try {
      assertSafeWorkerName(name);
      let defs = JSON.parse(readFileSync(WORKERS_CONFIG, "utf8"));
      const idx = defs.findIndex(w => w.name === name);
      // Keep fields the tool does not manage (model, notes, …) when replacing an existing entry.
      const prev  = idx >= 0 ? defs[idx] : {};
      const entry = { ...prev, name, ns, args: [worker_dir, "--repo-root", repo_root, "--inbox-channel", inbox_channel] };

      if (idx >= 0) {
        defs[idx] = entry;
      } else {
        defs.push(entry);
      }

      saveWorkerDefs(defs);
      console.log(`[claude-broker] registered worker "${name}" in WORKERS_CONFIG`);
      return { content: [{ type: "text", text: JSON.stringify({ registered: { name, ns, args: entry.args } }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  });

  // ── deregister_worker ────────────────────────────────────────────────────────
  server.registerTool("deregister_worker", {
    title: "Remove a worker from WORKERS_CONFIG",
    description: "Remove a worker definition from WORKERS_CONFIG. Errors if the worker is currently running (must stop it first). The file is updated atomically; no broker restart required.",
    inputSchema: {
      name: z.string().min(1).describe("Worker name to remove, e.g. 'backend', 'qa-reviewer'."),
    },
  }, async ({ name }) => {
    if (!WORKERS_CONFIG)
      return { content: [{ type: "text", text: "Error: WORKERS_CONFIG env var not set" }], isError: true };

    // Check if worker is running
    if (workerRunningInfo(name))
      return { content: [{ type: "text", text: `Error: worker "${name}" is currently running — stop it first` }], isError: true };

    try {
      let defs = JSON.parse(readFileSync(WORKERS_CONFIG, "utf8"));
      const idx = defs.findIndex(w => w.name === name);

      if (idx < 0)
        return { content: [{ type: "text", text: `Error: worker "${name}" not found in WORKERS_CONFIG` }], isError: true };

      defs.splice(idx, 1);
      saveWorkerDefs(defs);
      console.log(`[claude-broker] deregistered worker "${name}" from WORKERS_CONFIG`);
      return { content: [{ type: "text", text: `Deregistered worker "${name}" from WORKERS_CONFIG.` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  });
}
