/**
 * Aggregate test runner — spawns a scratch broker (temp DB, spare port) and
 * runs every suite against it, so the live broker.db is never touched.
 *
 * Usage:
 *   node run-tests.js              # isolated: scratch broker on TEST_PORT (default 8181)
 *
 * Individual suites still run against the live broker as before:
 *   node test-v2.js                # live mode, unchanged
 *
 * Env:
 *   TEST_PORT   port for the scratch broker (default 8181)
 *   TEST_KEEP   set to 1 to keep the temp dir for debugging
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.TEST_PORT || "8181", 10);
const SECRET = `test-secret-${process.pid}-${Date.now().toString(36)}`;
const BROKER_URL = `http://localhost:${PORT}/mcp`;
const HEALTH_URL = `http://localhost:${PORT}/health`;

const SUITES = [
  "test-v2.js",
  "test-coverage.js",
  "test-e2e.js",
  "test-fixes.js",
  "test-regression-fixes.js",
  "test-schema-validation.js",
  "test-heartbeat.js",
];

function log(msg) {
  console.log(`[run-tests] ${msg}`);
}

async function waitForHealth(url, tries = 50, delayMs = 200) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, delayMs));
  }
  return false;
}

async function main() {
  // Refuse to start if something is already listening on the test port —
  // killing it at teardown would take down a process we don't own.
  try {
    await fetch(HEALTH_URL, { signal: AbortSignal.timeout(1000) });
    console.error(`[run-tests] FATAL: something is already listening on port ${PORT} — set TEST_PORT to a free port`);
    process.exit(1);
  } catch {}

  const tmpDir = mkdtempSync(join(tmpdir(), "broker-test-"));
  const dbPath = join(tmpDir, "test-broker.db");
  log(`scratch broker: port=${PORT} db=${dbPath}`);

  // Worker-lifecycle tests (list_workers, register_worker) need a workers
  // config; give the scratch broker a COPY so register/deregister mutations
  // never touch the real file.
  const liveWorkersConfig = process.env.WORKERS_CONFIG || join(ROOT, "workers.example.json");
  let workersConfig = "";
  if (existsSync(liveWorkersConfig)) {
    workersConfig = join(tmpDir, "workers-config.json");
    copyFileSync(liveWorkersConfig, workersConfig);
  }

  const broker = spawn(process.execPath, [join(ROOT, "server.js")], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: dbPath,
      SHARED_SECRET: SECRET,
      // Neutralize live-ops env that server.js may act on
      WATCHDOG_BIN: "",
      WORKERS_CONFIG: workersConfig,
      WORKERS_LOG_DIR: join(tmpDir, "worker-logs"),
    },
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let brokerOut = "";
  broker.stdout.on("data", d => { brokerOut += d; });
  broker.stderr.on("data", d => { brokerOut += d; });

  let brokerExited = false;
  broker.on("exit", () => { brokerExited = true; });

  const teardown = () => {
    if (!brokerExited) {
      try { broker.kill("SIGTERM"); } catch {}
      // Escalate if SIGTERM is ignored
      setTimeout(() => { try { broker.kill("SIGKILL"); } catch {} }, 2000).unref();
    }
    if (process.env.TEST_KEEP === "1") {
      log(`TEST_KEEP=1 — temp dir preserved: ${tmpDir}`);
    } else {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  };
  process.on("SIGINT", () => { teardown(); process.exit(130); });
  process.on("SIGTERM", () => { teardown(); process.exit(143); });

  const results = [];
  let exitCode = 0;
  try {
    const up = await waitForHealth(HEALTH_URL);
    if (!up || brokerExited) {
      console.error(`[run-tests] FATAL: scratch broker failed to start\n${brokerOut}`);
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
        env: { ...process.env, BROKER_URL, SHARED_SECRET: SECRET },
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
  console.log(exitCode === 0 ? "[run-tests] ALL SUITES PASSED" : "[run-tests] SUITE FAILURES");
  process.exit(exitCode);
}

main().catch(e => {
  console.error("[run-tests] FATAL:", e);
  process.exit(1);
});
