// Shared helper for suites that start their own scratch broker (not a suite itself: not in run-tests.js SUITES).
//
// Picking a free port and binding it are two steps, so another process (a second run-tests.js, a
// sibling suite) can take the port in between and the broker dies with EADDRINUSE. Same remedy as
// run-tests.js: pick again and retry, a bounded number of times, only for that failure.
import { spawn } from "child_process";
import { createServer } from "net";
import { join } from "path";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/**
 * Start `node server.js` from `root` on a free port and wait until /health answers.
 * env(port) returns the child's environment; onData(chunk) sees its stdout+stderr.
 * Retries on a fresh port (up to `attempts`) when the broker exits on EADDRINUSE.
 * Resolves { proc, port, base }; rejects "scratch broker did not start: <output>".
 */
export async function startScratchBroker({ root, env, onData, attempts = 5, tries = 60, intervalMs = 150, settleMs = 300 }) {
  for (let attempt = 1; ; attempt++) {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    let out = "", closed = false;
    const proc = spawn(process.execPath, [join(root, "server.js")], { env: env(port), cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    const add = (d) => { out += d; onData?.(d); };
    proc.stdout.on("data", add);
    proc.stderr.on("data", add);
    proc.on("close", () => { closed = true; });
    let up = false;
    for (let i = 0; i < tries && !up && !closed; i++) {
      try { up = (await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) })).ok; } catch {}
      if (!up && !closed) await sleep(intervalMs);
    }
    // A foreign process that grabbed the port can answer /health before our broker's EADDRINUSE exit lands.
    if (up) await sleep(settleMs);
    if (up && !closed) return { proc, port, base };
    if (!closed) { proc.kill("SIGKILL"); await new Promise(r => proc.once("close", r)); }
    if (attempt >= attempts || !/EADDRINUSE|already listening/.test(out)) throw new Error(`scratch broker did not start:\n${out}`);
    console.error(`[test-lib-broker] port ${port} was taken before the broker bound it; retrying on a fresh port (${attempt}/${attempts})`);
  }
}
