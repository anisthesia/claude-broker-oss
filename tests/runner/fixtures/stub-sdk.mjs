// Stand-in for @anthropic-ai/claude-agent-sdk: query() replays cli-stream-sample.jsonl (a recorded
// `claude -p --output-format stream-json --verbose` session) instead of calling the API.
// The runner loads it when RUNNER_SDK_MODULE points here.
//
// STUB_MODE   fixture (default) | error-result | throw | no-result | oauth | hang | broker-task
//             broker-task: the session reads a task from its inbox (brand brand-a) and posts its result
// STUB_DUMP   if set, the options query() received are written there as JSON. The API key is never
//             written: only key_present and key_matches (against STUB_EXPECT_KEY).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SAMPLE = join(dirname(fileURLToPath(import.meta.url)), "cli-stream-sample.jsonl");

export function sampleMessages() {
  return readFileSync(SAMPLE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// The sample was recorded on a claude.ai login (apiKeySource "none"); a runner session is on the
// fleet key, so the replay reports what that session reports.
export function apiKeyMessages() {
  return sampleMessages().map((m) => (m.type === "system" && m.subtype === "init" ? { ...m, apiKeySource: "ANTHROPIC_API_KEY" } : m));
}

function dump(prompt, options) {
  const env = process.env;
  if (!env.STUB_DUMP) return;
  const { env: childEnv = {}, abortController, stderr, ...rest } = options;
  writeFileSync(env.STUB_DUMP, JSON.stringify({
    prompt, ...rest,
    has_abort_controller: Boolean(abortController), has_stderr: typeof stderr === "function",
    key_present: Boolean(childEnv.ANTHROPIC_API_KEY),
    key_matches: Boolean(env.STUB_EXPECT_KEY) && childEnv.ANTHROPIC_API_KEY === env.STUB_EXPECT_KEY,
    stripped: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"].filter((k) => !(k in childEnv)),
    runner_vars_in_child: ["RUNNER_KEY_FILE", "RUNNER_SDK_MODULE"].filter((k) => k in childEnv),
    anthropic_vars: Object.keys(childEnv).filter((k) => k.startsWith("ANTHROPIC_")).sort(),
    claude_code_use_vars: Object.keys(childEnv).filter((k) => k.startsWith("CLAUDE_CODE_USE_")).sort(),
  }));
}

// Broker traffic of a session that takes one task and finishes it, spliced in after init.
export const BROKER_TASK = { task_id: "tst-2026-10-29-ledger", brand: "brand-a" };
export function brokerTaskMessages(sid) {
  const task = { type: "task", task_id: BROKER_TASK.task_id, from: "orchestrator", to: "backend", brand: BROKER_TASK.brand, subject: "s", body: "b" };
  const tu = (id, name, input) => ({ type: "assistant", parent_tool_use_id: null, session_id: sid, message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
  const tr = (id, text) => ({ type: "user", parent_tool_use_id: null, session_id: sid, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }] } });
  return [
    tu("toolu_stub_b1", "mcp__broker__turn_start", { inbox_channel: "tst-backend", control_channel: "tst-control" }),
    tr("toolu_stub_b1", JSON.stringify({ inbox: [{ id: 41, sender: "orchestrator", content: JSON.stringify(task) }], control: [] })),
    tu("toolu_stub_b2", "mcp__broker__post_result", { task_id: BROKER_TASK.task_id, summary: "PASS — stub", body: {} }),
    tr("toolu_stub_b2", "Posted #42 on tst-status"),
  ];
}

export async function* query({ prompt, options }) {
  dump(prompt, options);
  const mode = process.env.STUB_MODE || "fixture";
  let msgs = mode === "oauth" ? sampleMessages() : apiKeyMessages();
  if (mode === "broker-task") msgs = [msgs[0], ...brokerTaskMessages(msgs[0].session_id), ...msgs.slice(1)];
  if (mode === "hang") {
    yield msgs[0];
    // A real session keeps the event loop busy (the Claude Code child process); so does this timer.
    const busy = setInterval(() => {}, 1000);
    await new Promise((res, rej) => {
      options.abortController.signal.addEventListener("abort", () => { clearInterval(busy); rej(Object.assign(new Error("aborted"), { name: "AbortError" })); });
    });
    return;
  }
  for (const m of msgs) {
    if (m.type === "result") {
      if (mode === "throw") throw new Error("Connection error: fetch failed");
      if (mode === "no-result") return;
      if (mode === "error-result") { yield { ...m, subtype: "error_during_execution", is_error: true }; return; }
    }
    if (options.abortController && options.abortController.signal.aborted) return;
    yield m;
  }
}
