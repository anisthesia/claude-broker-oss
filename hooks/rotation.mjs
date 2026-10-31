#!/usr/bin/env node
// Rotation PostToolUse hook for headless worker sessions (docs/protocol-v3.md "Rotation").
//
// A session cannot see its own token count, and rotation_recommended on heartbeats only reaches
// <ns>-telemetry, which a mid-task session never reads. The watchdog measures the context size from
// the session's stream-json; when it first crosses ROTATE_AT_TOKENS it writes a flag file
// {size, threshold, crossed_at, status_base}. This hook reads that flag after every tool call and
// hands the session a ROTATE NOW instruction as hookSpecificOutput.additionalContext (claude 2.1.288:
// confirmed reaching a `claude -p` session by a live probe; the Agent SDK's
// PostToolUseHookSpecificOutput has the same field).
//
// Throttle: the instruction goes out on the 1st, 6th, 11th … tool call after the flag appears (at
// most once every 5 calls); the count lives in <flag>.count, which the watchdog deletes with the flag
// before every launch. The hook never blocks a tool: no flag, a bad flag or any error = no output, exit 0.
//
// Two entry points:
//   CLI   watchdog.sh's --settings file has hooks.PostToolUse run `node hooks/rotation.mjs <flag>`
//   SDK   runner/run-worker.mjs --rotation-flag <flag> puts sdkRotationHook(flag) in options.hooks.PostToolUse
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { fileURLToPath } from "url";

export const EVERY = 5;

export function rotationText(flag) {
  return `ROTATE NOW: context ${flag.size} >= ${flag.threshold} tokens. Finish the current edit, commit or stash on your branch, ` +
    `post type:status with body.handoff_notes {done,pending,files_touched,next_step}, then exit.`;
}

// The hook output for tool call number `count` (1-based) since the flag appeared, or null.
export function rotationContext(flag, count) {
  if (!flag || !(Number(flag.size) > 0) || !(Number(flag.threshold) > 0)) return null;
  if (!Number.isInteger(count) || count < 1 || (count - 1) % EVERY !== 0) return null;
  return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: rotationText(flag) } };
}

// Reads the flag, bumps <flag>.count and returns the hook output (or null). Never throws.
export function check(flagPath) {
  try {
    if (!flagPath) return null;
    let flag;
    try { flag = JSON.parse(readFileSync(flagPath, "utf8")); } catch { return null; }
    let n = 0;
    try { n = parseInt(readFileSync(`${flagPath}.count`, "utf8"), 10) || 0; } catch {}
    n += 1;
    try { writeFileSync(`${flagPath}.count`, `${n}\n`); } catch {}
    return rotationContext(flag, n);
  } catch { return null; }
}

// Agent SDK form (options.hooks.PostToolUse[].hooks[]).
export function sdkRotationHook(flagPath) {
  return async () => check(flagPath) || {};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flagPath = process.argv[2];
  // Drain stdin (the hook input) so the CLI never sees a broken pipe; the input itself is not needed.
  process.stdin.on("data", () => {}).on("end", () => {
    const out = check(flagPath);
    if (out) process.stdout.write(JSON.stringify(out) + "\n");
    process.exitCode = 0;
  }).on("error", () => { process.exitCode = 0; });
}

export const ROTATION_HOOK_PATH = fileURLToPath(import.meta.url);
