#!/usr/bin/env node
/**
 * claude-broker setup wizard.
 *
 *   npm run setup                         # interactive
 *   node setup.js --project /path/to/repo # point at the customer's project
 *   node setup.js --yes --project ...      # non-interactive (CI / scripted)
 *
 * What it does:
 *   1. Scans the target project for its components (backend, frontend, ...).
 *   2. Derives a namespace prefix and a channel layout.
 *   3. Generates a strong SHARED_SECRET and writes .env (preserving an existing secret).
 *   4. Writes workers.json describing the components.
 *   5. If the broker is already running, registers starter schemas on the channels.
 *   6. Prints the exact `claude mcp add` command to connect each session.
 *
 * Flags: --project <path>  --ns <prefix>  --port <n>  --no-schemas  --yes/-y
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = process.cwd(); // where .env / workers.json are written

// ── arg parsing ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const has = (...names) => names.some((n) => argv.includes(n));
const opts = {
  project: flag("--project"),
  ns: flag("--ns"),
  port: flag("--port"),
  schemas: !has("--no-schemas"),
  yes: has("--yes", "-y"),
};
const interactive = !opts.yes && process.stdin.isTTY;

const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
const ask = async (q, def) => {
  if (!interactive) return def ?? "";
  const a = (await rl.question(`  ${q}${def !== undefined && def !== "" ? ` [${def}]` : ""}: `)).trim();
  return a || def || "";
};
const askYesNo = async (q, def = true) => {
  if (!interactive) return def;
  const a = (await rl.question(`  ${q} (${def ? "Y/n" : "y/N"}): `)).trim().toLowerCase();
  return a === "" ? def : a.startsWith("y");
};

const c = { dim: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m` };
const line = (s = "") => console.log(s);

// ── component detection ──────────────────────────────────────────────────────
const IGNORE = new Set([
  "node_modules", ".git", ".venv", "venv", "dist", "build", "__pycache__", ".next",
  "target", "vendor", ".github", "docs", "doc", "scripts", "script", "tests", "test",
  ".idea", ".vscode", "coverage", "tmp", "temp", ".pytest_cache", ".ruff_cache",
  "migrations", "alembic", "public", "static", "assets", ".turbo", "bin",
]);
const MARKERS = [
  "package.json", "requirements.txt", "pyproject.toml", "go.mod", "Cargo.toml",
  "pom.xml", "build.gradle", "Gemfile", "composer.json", "Dockerfile", "tsconfig.json",
];
const KNOWN = new Set(["backend", "frontend", "api", "web", "server", "client", "worker", "mobile", "app", "services", "service", "gateway", "admin", "dashboard"]);

function detectComponents(projectPath) {
  let entries;
  try { entries = readdirSync(projectPath); } catch { return []; }
  const comps = [];
  for (const name of entries) {
    if (name.startsWith(".") || IGNORE.has(name)) continue;
    let s; try { s = statSync(join(projectPath, name)); } catch { continue; }
    if (!s.isDirectory()) continue;
    let files = [];
    try { files = readdirSync(join(projectPath, name)); } catch { /* unreadable */ }
    const looksLikeComponent = KNOWN.has(name.toLowerCase()) || MARKERS.some((m) => files.includes(m));
    if (looksLikeComponent) comps.push(name);
  }
  return comps;
}

const sanitizeName = (n) => n.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 64) || "app";
function deriveNs(projectPath) {
  const base = basename(projectPath).toLowerCase();
  const parts = base.split(/[-_ ]+/).filter(Boolean);
  const initials = parts.length > 1 ? parts.map((p) => p[0]).join("").slice(0, 4) : base.replace(/[^a-z0-9]/g, "").slice(0, 3);
  return (initials || "app").replace(/[^a-z0-9]/g, "");
}

// ── existing .env secret preservation ────────────────────────────────────────
function existingSecret() {
  const p = join(OUT_DIR, ".env");
  if (!existsSync(p)) return null;
  const m = readFileSync(p, "utf8").match(/^SHARED_SECRET=(.+)$/m);
  return m && m[1].trim() && m[1].trim() !== "change-me-to-a-long-random-string" ? m[1].trim() : null;
}

// ── schema registration (only if broker is reachable) ────────────────────────
async function registerSchemas({ port, secret, ns, components }) {
  const url = `http://localhost:${port}`;
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) throw new Error("health not ok");
  } catch {
    return { ran: false, reason: `broker not reachable at ${url}` };
  }
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "setup-wizard", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${secret}` } } }));
  const read = (f) => readFileSync(join(SCRIPT_DIR, "schemas", f), "utf8");
  const plan = [
    [`${ns}-status`, "status.json"],
    [`${ns}-telemetry`, "telemetry.json"],
    [`${ns}-control`, "control.json"],
    ...components.map((comp) => [`${ns}-${comp}`, "worker-inbox.json"]),
  ];
  const done = [];
  for (const [channel, file] of plan) {
    const res = await client.callTool({ name: "register_channel_schema", arguments: { channel, schema: read(file), strict: false, version: "1.0" } });
    done.push({ channel, file, ok: !res.isError });
  }
  await client.close();
  return { ran: true, done };
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  line();
  line(c.b("claude-broker setup"));
  line(c.dim("Configures this broker for one project. Re-runnable and non-destructive."));
  line();

  // 1. Project path
  let project = opts.project || (await ask("Path to the project repo to coordinate", ""));
  if (!project) { line(c.y("A project path is required (pass --project or answer the prompt).")); process.exit(1); }
  project = resolve(project);
  if (!existsSync(project) || !statSync(project).isDirectory()) {
    line(c.y(`Not a directory: ${project}`)); process.exit(1);
  }

  // 2. Components
  let components = detectComponents(project).map(sanitizeName);
  if (components.length) {
    line(`  Detected components: ${c.b(components.join(", "))}`);
    if (interactive && !(await askYesNo("Use these?", true))) {
      const custom = await ask("Enter components (comma-separated)", components.join(","));
      components = custom.split(",").map((s) => sanitizeName(s.trim())).filter(Boolean);
    }
  } else {
    const custom = await ask("No components auto-detected — enter them (comma-separated)", "app");
    components = custom.split(",").map((s) => sanitizeName(s.trim())).filter(Boolean);
  }
  components = [...new Set(components)];

  // 3. Namespace + port
  const ns = (opts.ns || (await ask("Namespace prefix (short, lowercase)", deriveNs(project)))).toLowerCase().replace(/[^a-z0-9]/g, "");
  const port = Number(opts.port || (await ask("Broker port", "8080"))) || 8080;

  // 4. Secret (preserve existing)
  const preserved = existingSecret();
  const secret = preserved || randomBytes(32).toString("hex");

  // 5. Write .env
  const envPath = join(OUT_DIR, ".env");
  let writeEnv = true;
  if (existsSync(envPath) && interactive) {
    writeEnv = await askYesNo(`.env exists${preserved ? " (secret will be kept)" : ""} — overwrite it?`, true);
  }
  if (writeEnv) {
    const env = [
      `# Generated by \`npm run setup\` for ${basename(project)}`,
      `PORT=${port}`,
      `SHARED_SECRET=${secret}`,
      `DB_PATH=./broker.db`,
      ``,
      `# Channel layout for this project`,
      `TELEMETRY_CHANNEL=${ns}-telemetry`,
      `RATE_LIMIT_CHANNEL=${ns}-rate-limits`,
      `PRUNE_EXEMPT=${ns}-backlog`,
      ``,
      `# Worker roster (list_workers reads this). Set WATCHDOG_BIN too if you want`,
      `# the broker to actually start/stop worker processes — see docs/DEPLOYMENT.md.`,
      `WORKERS_CONFIG=./workers.json`,
      ``,
    ].join("\n");
    writeFileSync(envPath, env, "utf8");
  }

  // 6. Write workers.json
  const workers = components.map((comp) => ({
    name: comp, ns,
    args: [comp, "--repo-root", project, "--inbox-channel", `${ns}-${comp}`],
  }));
  const workersPath = join(OUT_DIR, "workers.json");
  let writeWorkers = true;
  if (existsSync(workersPath) && interactive) writeWorkers = await askYesNo("workers.json exists — overwrite it?", true);
  if (writeWorkers) writeFileSync(workersPath, JSON.stringify(workers, null, 2) + "\n", "utf8");

  // 7. Register starter schemas (best-effort, only if broker is up)
  let schemaResult = { ran: false, reason: "skipped (--no-schemas)" };
  if (opts.schemas) schemaResult = await registerSchemas({ port, secret, ns, components });

  if (rl) rl.close();

  // 8. Summary
  const channels = [`${ns}-status`, `${ns}-control`, `${ns}-telemetry`, ...components.map((x) => `${ns}-${x}`)];
  line();
  line(c.g("✓ Setup complete"));
  line();
  line(`  ${c.b("Project")}     ${project}`);
  line(`  ${c.b("Namespace")}   ${ns}`);
  line(`  ${c.b("Components")}  ${components.join(", ")}`);
  line(`  ${c.b("Wrote")}       ${writeEnv ? ".env" : "(kept .env)"}, ${writeWorkers ? "workers.json" : "(kept workers.json)"}`);
  line(`  ${c.b("Channels")}    ${channels.join(", ")}`);
  line();
  if (schemaResult.ran) {
    const ok = schemaResult.done.filter((d) => d.ok).length;
    line(`  ${c.g("✓")} Registered ${ok}/${schemaResult.done.length} starter schemas (warn mode) on the running broker.`);
  } else {
    line(`  ${c.y("•")} Schemas not registered — ${schemaResult.reason}.`);
    line(`    Start the broker (${c.b("npm start")}), then re-run ${c.b("npm run setup")} to register them.`);
  }
  line();
  line(c.b("  Next steps:"));
  line(`    1. Start the broker:   ${c.b("npm start")}`);
  line(`    2. Connect each Claude Code session (run inside each project):`);
  line();
  line(c.dim(`       claude mcp add --transport http broker http://localhost:${port}/mcp \\`));
  line(c.dim(`         --header "Authorization: Bearer ${secret}"`));
  line();
  line(`    3. Verify:             ${c.b(`curl -s localhost:${port}/health`)}`);
  line(`    4. Dashboard:          ${c.b(`http://localhost:${port}/dashboard`)}  (token: the secret above)`);
  line();
  line(c.dim("  Full runbook: CUSTOMER-SETUP.md"));
  line();
}

main().catch((e) => { console.error("setup failed:", e.message); process.exit(1); });
