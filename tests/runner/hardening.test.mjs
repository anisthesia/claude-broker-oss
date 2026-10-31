// tests/runner — reviewer advisories on R1 (#183869): the session env carries no endpoint, model or
// auth override next to the fleet key; settings files cannot put one back; the key file must be ours.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadKey, settingsEnvOverrides, UsageError } from "../../runner/run-worker.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUNNER = join(ROOT, "runner", "run-worker.mjs");
const STUB = join(ROOT, "tests", "runner", "fixtures", "stub-sdk.mjs");
const FAKE_KEY = "fake-fleet-key-0003-not-a-real-key";

const TMP = mkdtempSync(join(tmpdir(), "runner-hardening-"));
process.on("exit", () => rmSync(TMP, { recursive: true, force: true }));
const KEY = join(TMP, "key.env");
writeFileSync(KEY, `ANTHROPIC_API_KEY=${FAKE_KEY}\n`); chmodSync(KEY, 0o600);
const WD = join(TMP, "repo", "workers", "backend");
mkdirSync(WD, { recursive: true });
const HOME = join(TMP, "home");
mkdirSync(join(HOME, ".claude"), { recursive: true });

function run(env = {}, home = HOME) {
  const dump = join(TMP, `dump-${Math.random().toString(36).slice(2)}.json`);
  const p = spawnSync(process.execPath, [RUNNER, "workers/backend", "--work-dir", WD, "--inbox-channel", "tst-backend", "--model", "m"], {
    cwd: WD, encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: home, RUNNER_SDK_MODULE: STUB, RUNNER_KEY_FILE: KEY, STUB_EXPECT_KEY: FAKE_KEY, STUB_DUMP: dump, ...env },
  });
  let d = null; try { d = JSON.parse(readFileSync(dump, "utf8")); } catch { /* SDK not started */ }
  return { code: p.status, err: p.stderr, out: p.stdout, dump: d };
}

test("ANTHROPIC_BASE_URL, ANTHROPIC_API_URL, model and header overrides never reach the session; the fleet key does", () => {
  const r = run({
    ANTHROPIC_BASE_URL: "https://elsewhere.invalid", ANTHROPIC_API_URL: "https://elsewhere.invalid", ANTHROPIC_MODEL: "x",
    ANTHROPIC_SMALL_FAST_MODEL: "x", ANTHROPIC_DEFAULT_OPUS_MODEL: "x", ANTHROPIC_CUSTOM_HEADERS: "X-A: b",
    ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_API_KEY: "some-other-key", CLAUDE_CODE_USE_VERTEX: "1",
  });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.dump.anthropic_vars, ["ANTHROPIC_API_KEY"]);
  assert.deepEqual(r.dump.claude_code_use_vars, []);
  assert.equal(r.dump.key_matches, true, "the key in the session is the fleet key, not the inherited one");
});

test("an ANTHROPIC_* or CLAUDE_CODE_USE_* entry in a settings file's env: exit 2 before the SDK starts, names the file and variable", () => {
  for (const [where, file] of [["user", join(HOME, ".claude", "settings.json")], ["project", join(WD, ".claude", "settings.json")], ["local", join(WD, ".claude", "settings.local.json")]]) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ env: { DISABLE_AUTOUPDATER: "1", ANTHROPIC_BASE_URL: "https://elsewhere.invalid" } }));
    const r = run();
    assert.equal(r.code, 2, where);
    assert.equal(r.dump, null, `${where}: SDK not started`);
    assert.match(r.err, new RegExp(`settings env would override .*${file.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}: ANTHROPIC_BASE_URL`));
    rmSync(file);
  }
  writeFileSync(join(HOME, ".claude", "settings.json"), JSON.stringify({ env: { DISABLE_AUTOUPDATER: "1" } }));
  assert.equal(run().code, 0, "an unrelated env entry is fine");
  writeFileSync(join(HOME, ".claude", "settings.json"), "{not json");
  assert.equal(run().code, 0, "an unreadable settings file is the session's business, not an override");
  rmSync(join(HOME, ".claude", "settings.json"));
  writeFileSync(join(WD, "x"), "");
  assert.deepEqual(settingsEnvOverrides(WD, join(TMP, "no-home")), []);
});

test("key file owned by another uid: UsageError, value never in the message", () => {
  const me = process.getuid();
  assert.equal(loadKey(KEY, me), FAKE_KEY);
  assert.throws(() => loadKey(KEY, me + 1), (e) => e instanceof UsageError && /owned by uid/.test(e.message) && !e.message.includes(FAKE_KEY));
});
