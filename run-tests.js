/**
 * Aggregate test runner — spawns a scratch broker (temp DB, spare port) and
 * runs every suite against it, so the live broker.db is never touched.
 *
 * Usage:
 *   node run-tests.js              # isolated: scratch broker on TEST_PORT (default: a free port)
 *
 * Individual suites still run against the live broker as before:
 *   node test-v2.js                # live mode, unchanged
 *
 * Env:
 *   TEST_PORT   port for the scratch broker (default: a free port chosen by the OS)
 *   TEST_KEEP   set to 1 to keep the temp dir for debugging
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

// Hermetic: never read the repo's live .env. Children (broker + suites) import dotenv/config, which
// honours DOTENV_CONFIG_PATH, so point it at /dev/null for every child and strip leaked live vars.
process.env.DOTENV_CONFIG_PATH = "/dev/null";

const ROOT = dirname(fileURLToPath(import.meta.url));
// TEST_PORT pins the port; otherwise ask the OS for a free one so concurrent runs never collide.
// The OS can hand the same port to another process between close() and the broker's listen(), so
// an unpinned run retries on a fresh port (up to START_ATTEMPTS) when the broker dies on EADDRINUSE.
const PINNED_PORT = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : null;
const START_ATTEMPTS = PINNED_PORT ? 1 : 5;
const freePort = () => new Promise((res, rej) => {
  const s = createServer().once("error", rej).listen(0, () => { const p = s.address().port; s.close(() => res(p)); });
});
const SECRET = `test-secret-${process.pid}-${Date.now().toString(36)}`;
let PORT, BROKER_URL, HEALTH_URL;

const SUITES = [
  "test-v2.js",
  "test-coverage.js",
  "test-e2e.js",
  "test-fixes.js",
  "test-regression-fixes.js",
  "test-schema-validation.js",
  "test-heartbeat.js",
  "test-heartbeat-pipeline.js",
  "test-watchdog-launch.js",
  "test-protocol-ops.js",
  "test-git-protocol.js",
  "test-cursors.js",
  "test-guards.js",
  "test-schema-cb.js",
  "test-schema-reviewer.js",
  "test-namespaces.js",
  "test-context-economy.js",
  "test-typed-tools.js",
  "test-role-profiles.js",
  "test-watchdog-v3.js",
  "test-adoption.js",
  "test-agent-guide.js",
  "test-inbox.js",
  "test-retro.js",
  "test-orchestration-loop.js",
  "test-plan-gate-schemas.js",
  "test-plan-gate-v2-schemas.js",
  "test-verified-checks.js",
  "test-model-routing.js",
  "test-guardrail-hooks.js",
  "test-setup-broker.js",
  "test-teardown-broker.js",
  "test-watchdog-reconcile.js",
  "test-mcp-v3-migration.js",
  "test-repin-models.js",
  "test-judge.js",
  "test-metrics-per-task.js",
  "test-self-wake.js",
  "test-open-questions.js",
  "test-spend-patrol.js",
];

function log(msg) {
  console.log(`[run-tests] ${msg}`);
}

async function waitForHealth(url, tries = 50, delayMs = 200, aborted = () => false) {
  for (let i = 0; i < tries; i++) {
    if (aborted()) return false;
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, delayMs));
  }
  return false;
}

// Watchdog-launched sessions export WATCHDOG_*/FOLLOWUP_*/BROKER_*/PORT/DB_PATH; the watchdog suites
// spread process.env into the watchdogs they spawn, so those leak in and break them (and a
// concurrent run). The verifier's VERIFY_*/VERIFIER_* settings would steer the verifier that
// test-verified-checks runs (VERIFY_NODE_BIN overrides its probe); only its VERIFY_RUN marker stays.
// Suites get only what run-tests.js sets below.
function cleanEnv() {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (/^(WATCHDOG_|FOLLOWUP_|BROKER_)/.test(k) || (/^(VERIFY|VERIFIER)_/.test(k) && k !== "VERIFY_RUN") || ["PORT", "DB_PATH", "ADMIN_SECRET", "PRUNE_EXEMPT", "WORKERS_CONFIG", "WORKERS_LOG_DIR"].includes(k)) delete e[k];
  e.DOTENV_CONFIG_PATH = "/dev/null";
  return e;
}

async function main() {
  const tmpDir = mkdtempSync(join(tmpdir(), "broker-test-"));
  const dbPath = join(tmpDir, "test-broker.db");

  // Worker-lifecycle tests (list_workers, register_worker) need a workers
  // config; give the scratch broker a COPY so register/deregister mutations
  // never touch the real file.
  const liveWorkersConfig = process.env.WORKERS_CONFIG || join(ROOT, "workers.example.json");
  let workersConfig = "";
  if (existsSync(liveWorkersConfig)) {
    workersConfig = join(tmpDir, "workers-config.json");
    copyFileSync(liveWorkersConfig, workersConfig);
  }

  let broker = null;
  let brokerExited = false;
  let brokerOut = "";

  const stopBroker = () => {
    if (broker && !brokerExited) {
      const b = broker;
      try { b.kill("SIGTERM"); } catch {}
      // Escalate if SIGTERM is ignored
      setTimeout(() => { try { b.kill("SIGKILL"); } catch {} }, 2000).unref();
    }
  };
  const teardown = () => {
    stopBroker();
    if (process.env.TEST_KEEP === "1") {
      log(`TEST_KEEP=1 — temp dir preserved: ${tmpDir}`);
    } else {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  };
  process.on("SIGINT", () => { teardown(); process.exit(130); });
  process.on("SIGTERM", () => { teardown(); process.exit(143); });

  // Start the scratch broker; true once it is healthy and still alive on its port.
  const tryStart = async () => {
    PORT = PINNED_PORT ?? await freePort();
    BROKER_URL = `http://localhost:${PORT}/mcp`;
    HEALTH_URL = `http://localhost:${PORT}/health`;

    // Refuse to start if something is already listening on the test port —
    // killing it at teardown would take down a process we don't own.
    try {
      await fetch(HEALTH_URL, { signal: AbortSignal.timeout(1000) });
      brokerOut = `something is already listening on port ${PORT}`;
      return false;
    } catch {}

    log(`scratch broker: port=${PORT} db=${dbPath}`);
    brokerExited = false;
    brokerOut = "";
    const b = broker = spawn(process.execPath, [join(ROOT, "server.js")], {
      env: {
        ...cleanEnv(),
        PORT: String(PORT),
        DB_PATH: dbPath,
        SHARED_SECRET: SECRET,
        ADMIN_SECRET: `${SECRET}-admin`,
        // A known exempt channel for the guard tests, on top of whatever the live .env lists
        PRUNE_EXEMPT: [process.env.PRUNE_EXEMPT, "tst-exempt"].filter(Boolean).join(","),
        // Neutralize live-ops env that server.js may act on
        WATCHDOG_BIN: "",
        WORKERS_TMUX_SESSION: "",
        TMUX_BIN: "",
        WORKERS_CONFIG: workersConfig,
        WORKERS_LOG_DIR: join(tmpDir, "worker-logs"),
      },
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    b.stdout.on("data", d => { brokerOut += d; });
    b.stderr.on("data", d => { brokerOut += d; });
    b.on("exit", () => { if (broker === b) brokerExited = true; });

    const up = await waitForHealth(HEALTH_URL, 50, 200, () => brokerExited);
    // A foreign process that grabbed the port can answer /health before our broker's EADDRINUSE exit lands.
    if (up) await new Promise(r => setTimeout(r, 300));
    return up && !brokerExited;
  };

  const results = [];
  let exitCode = 0;
  try {
    let up = false;
    for (let attempt = 1; attempt <= START_ATTEMPTS && !up; attempt++) {
      up = await tryStart();
      if (up) break;
      stopBroker();
      const retryable = /EADDRINUSE|already listening/.test(brokerOut);
      if (!retryable || attempt === START_ATTEMPTS) break;
      log(`port ${PORT} was taken before the broker bound it; retrying on a fresh port (${attempt}/${START_ATTEMPTS})`);
    }
    if (!up) {
      console.error(`[run-tests] FATAL: scratch broker failed to start\n${brokerOut}`);
      teardown();
      process.exit(1);
    }
    log(`scratch broker healthy at ${HEALTH_URL}`);

    for (const suite of SUITES) {
      if (!existsSync(join(ROOT, suite))) {
        results.push({ suite, status: "MISSING" });
        exitCode = 1;
        continue;
      }
      log(`running ${suite} ...`);
      const started = Date.now();
      const r = spawnSync(process.execPath, [join(ROOT, suite)], {
        // Suites read WORKERS_TMUX_SESSION to decide whether to run tmux cases — keep the
        // live .env from leaking into them, same as for the scratch broker above.
        env: { ...cleanEnv(), BROKER_URL, SHARED_SECRET: SECRET, ADMIN_SECRET: `${SECRET}-admin`, TEST_EXEMPT_CHANNEL: "tst-exempt", WORKERS_TMUX_SESSION: "", TMUX_BIN: "" },
        cwd: ROOT,
        stdio: "inherit",
        timeout: 10 * 60 * 1000,
      });
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      const status = r.status === 0 ? "PASS" : `FAIL (exit ${r.status ?? "signal " + r.signal})`;
      if (r.status !== 0) exitCode = 1;
      results.push({ suite, status, secs });
    }
  } finally {
    teardown();
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log("[run-tests] summary");
  for (const r of results) {
    console.log(`  ${r.status.padEnd(12)} ${r.suite}${r.secs ? `  (${r.secs}s)` : ""}`);
  }
  console.log(`${"═".repeat(60)}`);
  const counts = {};
  for (const r of results) { const k = r.status.split(" ")[0]; counts[k] = (counts[k] || 0) + 1; }
  console.log(`[run-tests] ${results.length} suites: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")}`);
  console.log(exitCode === 0 ? "[run-tests] ALL SUITES PASSED" : "[run-tests] SUITE FAILURES");
  process.exit(exitCode);
}

main().catch(e => {
  console.error("[run-tests] FATAL:", e);
  process.exit(1);
});
