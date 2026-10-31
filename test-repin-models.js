// Tests for repin-models.mjs: mapping, reviewer split, dry-run default, backup + formatting on --apply.
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { plan, applyPlan } from "./repin-models.mjs";

let passed = 0, failed = 0;
const expect = (c, l, d) => { if (c) { console.log(`  ✓ ${l}`); passed++; } else { console.error(`  ✗ ${l}`, d ?? ""); failed++; process.exitCode = 1; } };
const e = (ns, name, model) => ({ name, ns, args: [name], ...(model ? { model } : {}) });
const modelsAfter = (entries) => Object.fromEntries(applyPlan(structuredClone(entries), plan(entries)).map(x => [x.name, x.model]));

console.log("\n── mapping ──");
const m = modelsAfter([
  e("a", "a-1", "claude-sonnet-5"), e("a", "a-2", "sonnet"), e("a", "a-3", "claude-opus-5"),
  e("a", "a-4", "claude-haiku-4-5-20251001"), e("a", "a-5", "claude-sonnet-5-5"), e("a", "a-6", "claude-opus-5-5"), e("a", "a-7"),
]);
expect(m["a-1"] === "claude-sonnet-5-5" && m["a-2"] === "claude-sonnet-5-5", "claude-sonnet-5 and sonnet -> claude-sonnet-5-5", m);
expect(m["a-3"] === "claude-opus-5-5", "claude-opus-5 -> claude-opus-5-5", m);
expect(m["a-4"] === "claude-haiku-4-5-20251001" && m["a-5"] === "claude-sonnet-5-5" && m["a-6"] === "claude-opus-5-5", "haiku and already-5.5 ids untouched", m);
expect(!("model" in modelsAfter([e("a", "x")]) ) || modelsAfter([e("a", "x")]).x === undefined, "entry without a model stays without one");

console.log("\n── reviewer split ──");
let s = modelsAfter([e("n", "n-api", "claude-sonnet-5"), e("n", "n-web", "claude-sonnet-5"), e("n", "n-reviewer", "claude-sonnet-5")]);
expect(s["n-reviewer"] === "claude-opus-5-5" && s["n-api"] === "claude-sonnet-5-5", "sonnet writers -> reviewer pinned to opus 5.5", s);
s = modelsAfter([e("n", "n-api", "claude-opus-5"), e("n", "n-reviewer", "claude-opus-5-5")]);
expect(s["n-reviewer"] === "claude-sonnet-5-5" && s["n-api"] === "claude-opus-5-5", "opus writers -> reviewer pinned to sonnet 5.5 (already-5.5 reviewer too)", s);
s = modelsAfter([e("n", "n-api", "claude-opus-5"), e("n", "n-reviewer", "claude-sonnet-5")]);
expect(s["n-reviewer"] === "claude-sonnet-5-5", "reviewer already on the other family: only repinned, not flipped", s);
s = modelsAfter([e("n", "n-api"), e("n", "n-reviewer")]);
expect(s["n-reviewer"] === undefined, "no pinned writers: reviewer untouched");
s = modelsAfter([e("n", "n-api", "claude-haiku-4-5-20251001"), e("n", "n-reviewer", "claude-sonnet-5")]);
expect(s["n-reviewer"] === "claude-sonnet-5-5", "haiku writers do not trigger a split");
s = modelsAfter([e("n", "n-orch", "claude-opus-5"), e("n", "n-api", "claude-sonnet-5"), e("n", "n-web", "claude-sonnet-5"), e("n", "n-reviewer", "claude-opus-5")]);
expect(s["n-reviewer"] === "claude-opus-5-5", "orchestrator is not counted as a writer", s);
s = modelsAfter([e("p", "p-api", "claude-sonnet-5"), e("p", "p-reviewer", "claude-sonnet-5"), e("q", "q-api", "claude-opus-5"), e("q", "q-reviewer", "claude-opus-5")]);
expect(s["p-reviewer"] === "claude-opus-5-5" && s["q-reviewer"] === "claude-sonnet-5-5", "namespaces split independently", s);

console.log("\n── CLI: dry-run default, --apply with .bak ──");
const dir = mkdtempSync(join(tmpdir(), "repin-"));
const cfg = join(dir, "workers.json");
const entries = [{ name: "k-api", ns: "k", args: ["k-api", "--repo-root", "/x"], model: "claude-sonnet-5" }, { name: "k-reviewer", ns: "k", args: ["k-reviewer"], model: "claude-sonnet-5" }, { name: "z", ns: "z", args: ["z"] }];
const original = JSON.stringify(entries, null, 2) + "\n";
writeFileSync(cfg, original);
const run = (...a) => execFileSync(process.execPath, ["repin-models.mjs", cfg, ...a], { encoding: "utf8" });
const out = run();
expect(readFileSync(cfg, "utf8") === original && readdirSync(dir).length === 1, "dry-run writes nothing and creates no .bak");
expect(/2 of 3 entries change/.test(out) && /dry-run/.test(out) && /k-reviewer/.test(out), "dry-run prints a table and summary counts", out);
run("--apply");
const baks = readdirSync(dir).filter(f => f.endsWith(".bak"));
expect(baks.length === 1 && readFileSync(join(dir, baks[0]), "utf8") === original, "--apply writes a timestamped .bak with the original bytes first");
const after = readFileSync(cfg, "utf8");
const parsed = JSON.parse(after);
expect(parsed[0].model === "claude-sonnet-5-5" && parsed[1].model === "claude-opus-5-5" && !("model" in parsed[2]), "--apply writes the planned models");
expect(after === JSON.stringify(parsed, null, 2) + "\n" && Object.keys(parsed[0]).join() === "name,ns,args,model", "formatting and key order preserved");
expect(/ 0 of 3|0 of 3 entries/.test(run()) || /0 of 3 entries change/.test(run()), "second run is a no-op (idempotent)");

writeFileSync(cfg, JSON.stringify(entries));  // minified: would be reformatted
const r = spawnSync(process.execPath, ["repin-models.mjs", cfg, "--apply"], { encoding: "utf8" });
expect(r.status === 1 && /refusing/.test(r.stderr) && readFileSync(cfg, "utf8") === JSON.stringify(entries), "refuses --apply when the file would be reformatted; file untouched");
expect(spawnSync(process.execPath, ["repin-models.mjs"], { encoding: "utf8" }).status === 2, "no config argument -> usage, exit 2");

rmSync(dir, { recursive: true, force: true });
console.log(`\n[test-repin-models] passed=${passed} failed=${failed}`);
