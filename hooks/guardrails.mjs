#!/usr/bin/env node
// Guardrail PreToolUse hook for headless worker sessions (docs/protocol-v3.md "Guardrails").
//
// Headless sessions run with --dangerously-skip-permissions (SDK: bypassPermissions), so nothing asks
// before a destructive command. This hook denies a short list of commands no worker task needs: force
// pushes, pushes to main/master, git reset --hard / git clean -f and rm -r/-f outside the worker's own
// worktree (or tmp), reads of credential files, --no-verify, and anything that takes the live broker down:
// kill/pkill/killall aimed at it (or at -1, every process), launchctl cycling com.claude.broker*, or starting
// server.js / npm start on its port from the claude-broker repo (2026-10-29: a session's
// `pkill -f node.*server.js` + `node server.js` replaced it for 18 min).
// A deny is a tool error with a reason
// the session reads and works around; the session is never stopped. Guardrails catch mistakes, not an
// adversary: a command built at runtime (variables, generated scripts) can get past a static check.
//
// Two entry points, one rule set (evaluate):
//   CLI   watchdog.sh writes a --settings file whose hooks.PreToolUse runs
//         `node hooks/guardrails.mjs <config.json>`; the hook input arrives on stdin, a deny is printed as
//         hookSpecificOutput.permissionDecision "deny" (exit 0).
//   SDK   runner/run-worker.mjs --guardrails <config.json> installs sdkHook(config) as options.hooks.
//
// Config (written by the watchdog, mode 600):
//   { "worker": "core", "root": "<worktree toplevel>", "log": "<deny log file>", "broker_port": 8080,
//     "extra_deny": ["<regex on the Bash command>", { "pattern": "<regex>", "tool": "<regex on tool name>", "reason": "..." }],
//     "allowed_tools": ["Read", "Bash(git *)", "mcp__tally"] }
// allowed_tools, when non-empty, is a strict allowlist (broker tools always pass): under bypass mode the
// CLI's --allowedTools only pre-approves, it restricts nothing, so the hook enforces it.
// broker_port: the live broker's port (watchdog: BROKER_URL's); default the port of $BROKER_URL, else 8080.
// Every deny appends one line to "log"; the watchdog copies those lines into its own log after the session.

import { readFileSync, appendFileSync, realpathSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { resolve, dirname, basename, sep } from "node:path";
import { fileURLToPath } from "node:url";

// ── Paths ─────────────────────────────────────────────────────────────────────

// realpath of the longest existing prefix, with the rest appended: /tmp/x/new -> /private/tmp/x/new.
export function realish(p) {
  let head = resolve(p), tail = "";
  for (;;) {
    try { return resolve(realpathSync(head), tail); } catch {}
    const up = dirname(head);
    if (up === head) return resolve(p);
    tail = tail ? `${basename(head)}${sep}${tail}` : basename(head);
    head = up;
  }
}
const within = (p, dir) => p.startsWith(dir.endsWith(sep) ? dir : dir + sep);
const atOrWithin = (p, dir) => p === dir || within(p, dir);

// tmp is scratch space, except the worktree itself and its ancestors: a worktree that sits under tmp
// (verify-result.mjs checks out under the OS tmpdir) keeps the protection it has anywhere else.
const tmpOk = (p, ctx) => ctx.tmp.some(t => within(p, t)) && !atOrWithin(ctx.root, p);

function tmpRoots(env) {
  const out = new Set();
  for (const d of ["/tmp", "/private/tmp", "/var/tmp", tmpdir(), env.TMPDIR]) if (d) out.add(realish(d));
  return [...out];
}

function context(cfg, input, env) {
  const home = env.HOME || homedir();
  const cwd = input.cwd || process.cwd();
  const root = realish(cfg.root || cwd);
  // ~/.config/claude-broker holds the orchestrator token, ~/.claude.json the MCP headers (broker bearer).
  const protectedDirs = [".ssh", ".aws", ".config/gh", ".netrc", ".config/claude-broker", ".claude.json"].map(p => realish(resolve(home, p)));
  return { home, cwd, root, tmp: tmpRoots(env), protectedDirs, env, brokerPort: brokerPort(cfg, env) };
}

function brokerPort(cfg, env) {
  const n = Number(cfg.broker_port);
  if (Number.isInteger(n) && n > 0) return n;
  try { const u = new URL(env.BROKER_URL); return Number(u.port) || (u.protocol === "https:" ? 443 : 80); } catch { return 8080; }
}

// ── Shell parsing (best effort) ──────────────────────────────────────────────

// Heredoc bodies are data, not commands: `cat > notes.md <<'EOF' … ~/.ssh … EOF` must not trip a rule.
// splitHeredocs also returns the bodies in order, so a body whose consumer is a shell or an interpreter
// (`bash <<EOF`, `cat <<EOF | python3`, `cat > x.sh <<EOF; bash x.sh`) is checked as code.
export function splitHeredocs(src) {
  const out = [], pending = [], bodies = [];
  for (const line of String(src).split("\n")) {
    if (pending.length) {
      const d = pending[0];
      if ((d.dash ? line.replace(/^\t+/, "") : line) === d.word) { pending.shift(); bodies.push({ word: d.word, body: d.lines.join("\n") }); }
      else d.lines.push(line);
      continue;
    }
    out.push(line);
    const re = /<<(-?)\s*(['"]?)([A-Za-z_][\w-]*)\2/g;
    let m;
    while ((m = re.exec(line))) if (line[m.index + 2] !== "<" && line[m.index - 1] !== "<") pending.push({ dash: m[1] === "-", word: m[3], lines: [] });
  }
  for (const d of pending) bodies.push({ word: d.word, body: d.lines.join("\n") });   // unterminated: runs to the end
  return { text: out.join("\n"), bodies };
}
export const stripHeredocs = (src) => splitHeredocs(src).text;

const OPS = ["&&", "||", ";;", ">>", "<<", "&>", ">&", "|&", ";", "|", "&", "\n", "(", ")", ">", "<"];
const SEPARATORS = new Set(["&&", "||", ";;", "|&", ";", "|", "&", "\n", "(", ")"]);

// Words and operators; quotes removed. $(…) and `…` bodies are collected in subs for a recursive check.
export function lex(src) {
  const toks = [], subs = [];
  let i = 0, cur = null;
  const push = () => { if (cur !== null) toks.push({ t: "w", v: cur }); cur = null; };
  const add = (s) => { cur = (cur ?? "") + s; };
  const subst = (start) => {   // src[start] === "(" after "$"; returns index after the matching ")"
    let depth = 1, j = start + 1, q = null;
    for (; j < src.length && depth; j++) {
      const c = src[j];
      if (q) { if (c === q) q = null; else if (c === "\\" && q === '"') j++; continue; }
      if (c === "'" || c === '"') q = c; else if (c === "\\") j++;
      else if (c === "(") depth++; else if (c === ")") depth--;
    }
    subs.push(src.slice(start + 1, j - 1));
    return j;
  };
  while (i < src.length) {
    const c = src[i];
    if (c === "\\" && src[i + 1] === "\n") { i += 2; continue; }
    if (c === " " || c === "\t") { push(); i++; continue; }
    if (c === "#" && cur === null) { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "'") { const j = src.indexOf("'", i + 1); const e = j < 0 ? src.length : j; add(src.slice(i + 1, e)); i = e + 1; continue; }
    if (c === '"') {
      let j = i + 1, s = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < src.length) { s += src[j + 1]; j += 2; continue; }
        if (src[j] === "$" && src[j + 1] === "(") { const k = subst(j + 1); s += "$(…)"; j = k; continue; }
        if (src[j] === "`") { const k = src.indexOf("`", j + 1); const e = k < 0 ? src.length : k; subs.push(src.slice(j + 1, e)); s += "$(…)"; j = e + 1; continue; }
        s += src[j++];
      }
      add(s); i = j + 1; continue;
    }
    if (c === "\\") { add(src[i + 1] ?? ""); i += 2; continue; }
    if (c === "$" && src[i + 1] === "(") { i = subst(i + 1); add("$(…)"); continue; }
    if (c === "`") { const j = src.indexOf("`", i + 1); const e = j < 0 ? src.length : j; subs.push(src.slice(i + 1, e)); add("$(…)"); i = e + 1; continue; }
    const op = OPS.find(o => src.startsWith(o, i));
    if (op) {
      // "2>" / "1>&2": the fd number belongs to the redirection, not the command.
      if ((op[0] === ">" || op[0] === "<") && cur !== null && /^\d+$/.test(cur)) cur = null;
      push(); toks.push({ t: "op", v: op }); i += op.length; continue;
    }
    add(c); i++;
  }
  push();
  return { toks, subs };
}

// Simple commands: { argv, redirs, outs, heredocs, herestrings, pipeIn } split at separators. A redirection's
// target word goes to redirs (and to outs for > >> &>, heredocs for <<WORD, herestrings for <<< word);
// pipeIn is the command whose output this one reads through | or |&.
export function simpleCommands(toks) {
  const cmds = [];
  const fresh = (pipeIn = null) => ({ argv: [], redirs: [], outs: [], heredocs: [], herestrings: [], pipeIn });
  let cur = fresh(), redirNext = null, last = null;
  const flush = (pipe) => {
    if (cur.argv.length || cur.redirs.length) { cmds.push(cur); last = cur; }
    cur = fresh(pipe ? last : null);
  };
  for (const tk of toks) {
    if (tk.t === "op") {
      if (SEPARATORS.has(tk.v)) { flush(tk.v === "|" || tk.v === "|&"); redirNext = null; }
      else redirNext = redirNext === "<<" && tk.v === "<" ? "<<<" : tk.v;
      continue;
    }
    if (redirNext) {
      cur.redirs.push(tk.v);
      if (redirNext === ">" || redirNext === ">>" || redirNext === "&>") cur.outs.push(tk.v);
      else if (redirNext === "<<") cur.heredocs.push(tk.v.replace(/^-/, ""));
      else if (redirNext === "<<<") cur.herestrings.push(tk.v);
      redirNext = null;
    } else cur.argv.push(tk.v);
  }
  flush(false);
  return cmds;
}

// Expand ~ and the variables a hook can know. Anything else leaves unresolved: true.
function expand(word, ctx, dir) {
  let unresolved = false;
  let v = word.replace(/^~(?=\/|$)/, ctx.home);
  v = v.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?|\$\(…\)/g, (m, name) => {
    if (name === "HOME") return ctx.home;
    if (name === "PWD") return dir ?? m;
    if (name === "TMPDIR" && ctx.env.TMPDIR) return ctx.env.TMPDIR;
    unresolved = true; return m;
  });
  return { v, unresolved };
}

const WRAPPERS = new Set(["sudo", "command", "builtin", "nohup", "time", "exec", "nice", "timeout", "env", "stdbuf", "xargs"]);
const VALUE_FLAGS = { sudo: /^-[ugpCDhrt]$/, nice: /^-n$/, timeout: /^-[sk]$/, xargs: /^-[IiLlnPsdE]$/, env: /^-[uSC]$/, stdbuf: /^-[ioe]$/ };
// Drop VAR=val prefixes and wrapper commands; returns { argv, viaXargs, assigns } (assigns: the dropped VAR=val).
function unwrap(argv) {
  let a = [...argv], viaXargs = false;
  const assigns = {};
  for (;;) {
    // `for p in …; do kill $p; done`: the command starts after the reserved word.
    // `function f { kill …; }`: the body's first command follows the name.
    while (a.length && /^(do|then|else|elif|if|while|until|!|\{|\(|function)$/.test(a[0])) { if (a.shift() === "function") a.shift(); }
    while (a.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a[0])) { const w = a.shift(), k = w.indexOf("="); assigns[w.slice(0, k)] = w.slice(k + 1); }
    const w = a.length ? basename(a[0]) : "";
    if (!WRAPPERS.has(w)) break;
    if (w === "xargs") viaXargs = true;
    a.shift();
    while (a.length && a[0].startsWith("-")) { const f = a.shift(); if (VALUE_FLAGS[w]?.test(f)) a.shift(); }
    if (w === "timeout" && a.length) a.shift();   // the duration
  }
  return { argv: a, viaXargs, assigns };
}

// ── Rules ─────────────────────────────────────────────────────────────────────

const deny = (rule, reason) => ({ rule, reason });

// A path the session may not read or pass around: credential stores, or a .env* outside the worktree.
function secretPath(p, ctx) {
  const r = realish(p);
  const hit = ctx.protectedDirs.find(d => atOrWithin(r, d));
  if (hit) return `${hit.replace(ctx.home, "~")} holds credentials`;
  if (/^\.env/.test(basename(r)) && !atOrWithin(r, ctx.root)) return `${basename(r)} outside the worktree (${ctx.root})`;
  return null;
}

// Every word of a command line that names a credential path, as itself, after ~/$HOME, or as the
// value of --opt=<path>. Words with whitespace are prose (commit messages), not paths.
function secretWord(word, ctx, dir) {
  if (/\s/.test(word) || !word) return null;
  const cands = [word];
  const eq = word.indexOf("=");
  if (eq > 0) cands.push(word.slice(eq + 1));
  for (const c of cands) {
    const { v } = expand(c, ctx, dir);
    if (!v || v.includes("$(")) continue;
    const why = secretPath(resolve(dir ?? ctx.cwd, v), ctx);
    if (why) return why;
  }
  return null;
}

function gitToplevel(dir) {
  try { return execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).trim() || null; }
  catch { return null; }
}
function gitBranch(dir) {
  try { return execFileSync("git", ["-C", dir, "symbolic-ref", "--short", "-q", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).trim() || null; }
  catch { return null; }
}

// Where a destructive git command lands: the repo's toplevel (or --work-tree), else the directory.
function gitTargetOk(dir, workTree, ctx) {
  if (!dir) return "cannot tell which directory it runs in (cd to a variable?)";
  // A repo's toplevel must be the worktree itself (a nested repo is another worktree); with no repo to
  // resolve (a directory that does not exist yet), the path alone decides.
  const top = workTree || gitToplevel(dir);
  const target = realish(top || dir);
  if ((top ? target === ctx.root : atOrWithin(target, ctx.root)) || tmpOk(target, ctx)) return null;
  return `it targets ${target}, outside this worker's worktree (${ctx.root})`;
}

const PROTECTED_BRANCHES = new Set(["main", "master"]);
const shortCluster = (a) => /^-[A-Za-z]+$/.test(a);

function checkGit(argv, dir, ctx) {
  let i = 1, workTree = null;
  // Global options before the subcommand.
  while (i < argv.length && argv[i].startsWith("-")) {
    const a = argv[i];
    if (a === "-C") { const { v } = expand(argv[i + 1] ?? "", ctx, dir); dir = dir && v && !v.includes("$") ? resolve(dir, v) : null; i += 2; continue; }
    // git -c alias.p='push --force' p: an alias hides the real subcommand from every rule below.
    if (a === "-c" && /^alias\./i.test(argv[i + 1] ?? "")) return deny("git-alias", `git -c ${argv[i + 1]}: an alias hides the git command from the guardrails; run the command itself`);
    if (a === "--config-env" && /^alias\./i.test(argv[i + 1] ?? "")) return deny("git-alias", `git --config-env ${argv[i + 1]}: an alias hides the git command from the guardrails; run the command itself`);
    if (a === "-c" || a === "--git-dir" || a === "--namespace" || a === "--exec-path" || a === "--config-env") { i += 2; continue; }
    if (a === "--work-tree") { workTree = argv[i + 1]; i += 2; continue; }
    if (a.startsWith("--work-tree=")) workTree = a.slice(12);
    i++;
  }
  if (workTree && dir) workTree = resolve(dir, expand(workTree, ctx, dir).v);
  const sub = argv[i], args = argv.slice(i + 1);
  if (!sub) return null;

  if (sub === "push") {
    if (args.includes("--no-verify")) return deny("git-no-verify", "git push --no-verify skips the repository's hooks");
    const force = args.find(a => a === "--force" || a === "-f" || a.startsWith("--force-with-lease") || a === "--force-if-includes"
                              || (shortCluster(a) && a.includes("f")));
    if (force) return deny("git-force-push", `git push ${force} rewrites remote history; push a new branch or commit instead`);
    if (args.includes("--mirror") || args.includes("--all")) return deny("git-push-protected", "git push --all/--mirror also pushes main/master");
    const pos = [];
    for (let j = 0; j < args.length; j++) {
      const a = args[j];
      if (/^(-o|--push-option|--repo|--receive-pack|--exec)$/.test(a)) { j++; continue; }
      if (!a.startsWith("-")) pos.push(a);
    }
    const refspecs = pos.slice(1);
    for (const r of refspecs) {
      if (r.startsWith("+")) return deny("git-force-push", `refspec ${r} force-pushes (leading +); push a new branch or commit instead`);
      let dst = r.includes(":") ? r.slice(r.indexOf(":") + 1) : r;
      if (dst === "HEAD" && dir) dst = gitBranch(dir) || dst;
      dst = dst.replace(/^refs\/heads\//, "");
      if (PROTECTED_BRANCHES.has(dst)) return deny("git-push-protected", `pushes to ${dst}; workers push their own branch and the orchestrator merges`);
    }
    if (!refspecs.length && dir) {
      const b = gitBranch(dir);
      if (b && PROTECTED_BRANCHES.has(b)) return deny("git-push-protected", `the current branch is ${b}; workers push their own branch and the orchestrator merges`);
    }
    return null;
  }
  if (sub === "commit") {
    for (const a of args) {
      if (a === "--no-verify") return deny("git-no-verify", "git commit --no-verify skips the repository's hooks");
      if (a === "--") break;
      if (shortCluster(a)) {
        for (const ch of a.slice(1)) { if (ch === "n") return deny("git-no-verify", `git commit ${a} (-n = --no-verify) skips the repository's hooks`); if ("mFCct".includes(ch)) break; }
      }
    }
    return null;
  }
  if (sub === "config") {
    const readOnly = args.some(a => /^(--get|--get-all|--get-regexp|--list|-l|--unset|--unset-all|--show-origin)$/.test(a));
    const key = args.find(a => !a.startsWith("-"));
    if (!readOnly && key && /^alias\./i.test(key)) return deny("git-alias", `git config ${key}: an alias hides the git command from the guardrails; run the command itself`);
    return null;
  }
  if (sub === "branch") {
    // Deleting, force-moving or renaming main/master: workers own their branch; the orchestrator owns main.
    // -f <name> <start> and -C <old> <new> overwrite <name>/<new> only, so `git branch -f x main` passes.
    const flags = args.filter(a => a.startsWith("-")).join(" ");
    const pos = args.filter(a => !a.startsWith("-")).map(a => a.replace(/^refs\/heads\//, ""));
    const prot = (a) => a !== undefined && PROTECTED_BRANCHES.has(a);
    const has = (long, short) => new RegExp(`(^|\\s)(${long}|-[A-Za-z]*[${short}][A-Za-z]*)(\\s|$)`).test(flags);
    const hit = has("--delete", "Dd") ? pos.find(prot)
              : has("--move", "Mm") ? pos.find(prot)
              : has("--copy", "C") && /(^|\s)(--force|-[A-Za-z]*[fC])/.test(flags) ? (pos.length > 1 ? (prot(pos[1]) ? pos[1] : undefined) : pos.find(prot))
              : has("--force", "f") ? (prot(pos[0]) ? pos[0] : undefined) : undefined;
    if (hit) return deny("git-branch-protected", `git branch ${args.join(" ")}: workers never delete, overwrite, move or rename ${hit}`);
    return null;
  }
  if (sub === "reset" && args.includes("--hard")) {
    const why = gitTargetOk(dir, workTree, ctx);
    return why ? deny("git-reset-hard", `git reset --hard: ${why}`) : null;
  }
  if (sub === "clean" && args.some(a => a === "--force" || (shortCluster(a) && a.includes("f")))) {
    const why = gitTargetOk(dir, workTree, ctx);
    return why ? deny("git-clean-force", `git clean -f: ${why}`) : null;
  }
  return null;
}

// atRootOk: find / rsync delete inside a directory, so the worktree root itself is a fine target for them.
function checkRm(argv, dir, ctx, viaXargs, atRootOk = false) {
  let recursive = false, force = false, targets = [], opts = true;
  for (const a of argv.slice(1)) {
    if (opts && a === "--") { opts = false; continue; }
    if (opts && a.startsWith("--")) { if (a === "--recursive") recursive = true; if (a === "--force") force = true; continue; }
    if (opts && /^-[A-Za-z]+$/.test(a)) { if (/[rR]/.test(a)) recursive = true; if (a.includes("f")) force = true; continue; }
    targets.push(a);
  }
  if (!recursive && !force) return null;
  if (!targets.length) return viaXargs ? deny("rm-outside-worktree", "rm -r/-f fed by xargs: the targets cannot be checked; list them explicitly") : null;
  if (!dir) return deny("rm-outside-worktree", "rm -r/-f after a cd the hook cannot resolve; use absolute paths");
  for (const t of targets) {
    const { v, unresolved } = expand(t, ctx, dir);
    if (unresolved) return deny("rm-outside-worktree", `rm target ${t} uses a variable the hook cannot resolve; spell the path out`);
    const p = resolve(dir, v);
    const g = p.search(/[*?[]/);
    if (g >= 0) {
      const prefix = realish(p.slice(0, g).replace(/[^/]*$/, "") || "/");
      if (atOrWithin(prefix, ctx.root) || tmpOk(prefix, ctx)) continue;
    } else {
      const r = realish(p);
      if ((atRootOk ? atOrWithin(r, ctx.root) : within(r, ctx.root)) || tmpOk(r, ctx)) continue;
    }
    return deny("rm-outside-worktree", `rm ${t} resolves to ${p}, outside this worker's worktree (${ctx.root}) and tmp`);
  }
  return null;
}

// ── The live broker ──────────────────────────────────────────────────────────
// Nothing a worker task needs touches the broker process: tests start their own on a free port.

// What the broker's process looks like to pkill: its name, and its command line under -f.
const BROKER_NAMES = ["node", "npm"];
const brokerCmdlines = (ctx) => ["node server.js", `node ${ctx.root}/server.js`, "/usr/local/bin/node /Users/x/claude-broker/server.js",
                                 "node --watch server.js", "npm start", "npm run dev"];
function listenerPids(port) {
  try {
    return execFileSync("lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 })
      .split("\n").map(s => s.trim()).filter(Boolean);
  } catch { return []; }
}
// The command lines of whatever listens on the broker port now, plus the usual broker forms.
function liveCmdlines(ctx) {
  if (!ctx.liveCmdlines) {
    ctx.liveCmdlines = listenerPids(ctx.brokerPort).map(pid => {
      try { return execFileSync("ps", ["-o", "command=", "-p", pid], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).trim(); }
      catch { return ""; }
    }).filter(Boolean);
  }
  return [...brokerCmdlines(ctx), ...ctx.liveCmdlines];
}

// Does a process-match pattern select the broker? regex: pgrep/pkill/grep semantics; full: matched against
// command lines (pgrep -f, grep over ps output), else against process names.
function patternHitsBroker(p, ctx, { regex = true, full = true } = {}) {
  if (/claude-broker/.test(p)) return true;
  const targets = full ? liveCmdlines(ctx) : BROKER_NAMES;
  if (!regex) return targets.includes(p);
  try { const re = new RegExp(p); return targets.some(t => re.test(t)); } catch { return targets.some(t => t.includes(p)); }
}

// The process-lookup patterns on a line (pgrep / pidof / grep / egrep, inside $(…) too), for kill lines whose
// pids the hook cannot see. App repos kill their own dev servers this way: only a pattern that would select
// the broker's process counts (2026-10-29 review: `kill $(pgrep -f 'node dist/server.js')` was denied).
function lookupHitsBroker(src, ctx, depth = 0) {
  if (depth > 4) return false;
  const { toks, subs } = lex(stripHeredocs(src));
  for (const s of subs) if (lookupHitsBroker(s, ctx, depth + 1)) return true;
  for (const cmd of simpleCommands(toks)) {
    const { argv } = unwrap(cmd.argv);
    const name = basename(argv[0] ?? ""), args = argv.slice(1);
    if (name === "pgrep") {
      const pats = [];
      for (let j = 0; j < args.length; j++) { if (/^-[FGgPstUuJc]$/.test(args[j])) { j++; continue; } if (!args[j].startsWith("-")) pats.push(args[j]); }
      const full = args.some(a => /^-[A-Za-z]*f/.test(a));
      if (pats.some(p => patternHitsBroker(p, ctx, { full }))) return true;
    } else if (name === "pidof") {
      if (args.some(a => !a.startsWith("-") && patternHitsBroker(a, ctx, { regex: false, full: false }))) return true;
    } else if (/^[ef]?grep$/.test(name)) {
      if (args.some(a => /^-[A-Za-z]*v/.test(a))) continue;
      const pats = [];
      for (let j = 0; j < args.length; j++) { if (args[j] === "-e") { pats.push(args[++j] ?? ""); continue; } if (/^-[mABCf]$/.test(args[j])) { j++; continue; } if (!args[j].startsWith("-")) { pats.push(args[j]); break; } }
      if (pats.some(p => p && patternHitsBroker(p, ctx, { regex: name !== "fgrep" }))) return true;
    }
  }
  return false;
}
// A kill line points at the broker when it names claude-broker / com.claude.broker or the broker port as a
// word, or looks pids up with a pattern that selects the broker's process.
const brokerHint = (s, ctx) => new RegExp(`claude-broker|com\\.claude\\.broker|(^|[^0-9])${ctx.brokerPort}([^0-9]|$)`).test(s) || lookupHitsBroker(s, ctx);

const KILL_REASON = "the live broker serves every fleet on this machine; tests start their own on a free port, and a broker restart is the operator's call";

const KILL_ALL_REASON = "-1 signals every process this user owns, the live broker included";

// kill <pid…> / pkill <pattern> / killall <name> / fuser -k <port>/tcp. src: the whole line, for targets the
// hook cannot see ($(lsof -ti:8080), $PID, | xargs kill). bgVars: variables assigned from $! earlier on the
// line (`PORT=5555 node server.js & BP=$!; …; kill $BP`): the job this line started, never the broker.
function checkKill(name, argv, ctx, src, viaXargs, bgVars = new Set()) {
  const args = argv.slice(1);
  if (name === "fuser") {
    if (!args.some(a => /^-[A-Za-z]*k/.test(a))) return null;
    return args.some(a => new RegExp(`^${ctx.brokerPort}(/tcp)?$`).test(a)) ? deny("broker-kill", `fuser -k on port ${ctx.brokerPort}: ${KILL_REASON}`) : null;
  }
  if (name === "pkill" || name === "killall") {
    // Only the first word may be a -SIGNAL; a later -1 is a kill-everything target.
    if (args.some((a, j) => a === "-1" && j > 0)) return deny("broker-kill", `${name} … -1: ${KILL_ALL_REASON}`);
    const full = name === "pkill" && args.some(a => /^-[A-Za-z]*f/.test(a));
    const regex = name === "pkill" || args.some(a => /^-[A-Za-z]*m$/.test(a));
    const valued = name === "pkill" ? /^-[FGgPstUuJc]$/ : /^-[ust]$/;
    const pats = [];
    for (let j = 0; j < args.length; j++) {
      if (valued.test(args[j])) { j++; continue; }
      if (!args[j].startsWith("-")) pats.push(args[j]);
    }
    if (!pats.length) return viaXargs && brokerHint(src, ctx) ? deny("broker-kill", `${name} fed by xargs from a line that names the broker: ${KILL_REASON}`) : null;
    for (const p of pats) {
      if (patternHitsBroker(p, ctx, { regex, full })) return deny("broker-kill", `${name} ${p} would match the broker process: ${KILL_REASON}`);
    }
    return null;
  }
  // kill [-s SIG | -SIG | -n N] [--] <pid|%job|$(…)>…
  if (args.includes("-l") || args.includes("-L")) return null;
  // The first -X is the signal (-9, -KILL, -SIGTERM, or -s/-n with a value); a -<digits> after it is a
  // negative pid / process group target, so `kill -9 -1` targets -1.
  const targets = [];
  let opts = true, signal = false;
  for (let j = 0; j < args.length; j++) {
    const a = args[j];
    if (opts && a === "--") { opts = false; continue; }
    if (opts && (a === "-s" || a === "-n")) { signal = true; j++; continue; }
    if (opts && a.startsWith("-") && !(signal && /^-\d+$/.test(a))) { signal = true; continue; }
    targets.push(a);
  }
  if (targets.includes("-1")) return deny("broker-kill", `kill ${args.join(" ")}: ${KILL_ALL_REASON}`);
  if (!targets.length) return viaXargs && brokerHint(src, ctx) ? deny("broker-kill", `kill fed by xargs from a line that names the broker: ${KILL_REASON}`) : null;
  let listeners = null;
  for (const t of targets) {
    if (/^-?\d+$/.test(t)) {
      listeners ??= listenerPids(ctx.brokerPort);
      if (listeners.includes(t.replace(/^-/, ""))) return deny("broker-kill", `pid ${t} is the broker listening on port ${ctx.brokerPort}: ${KILL_REASON}`);
    } else if (bgVars.has(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(t)?.[1])) {
      continue;
    } else if (!t.startsWith("%") && brokerHint(src, ctx)) {
      return deny("broker-kill", `kill ${t}: the pid is computed on a line that names the broker (server.js / claude-broker / port ${ctx.brokerPort}): ${KILL_REASON}`);
    }
  }
  return null;
}

const LAUNCHCTL_CYCLE = new Set(["kickstart", "bootout", "stop", "unload", "remove", "kill", "disable"]);
function checkLaunchctl(argv) {
  if (!LAUNCHCTL_CYCLE.has(argv[1])) return null;
  const label = argv.slice(2).find(a => /com\.claude\.broker/.test(a));
  return label ? deny("broker-launchctl", `launchctl ${argv[1]} ${label}: ${KILL_REASON}`) : null;
}

// node [flags] server.js, npm start, npm run start|dev: the broker itself, when run in the claude-broker repo
// (the worktree root, the directory the line runs in or the script's directory has claude-broker's server.js).
// There it is allowed only with an explicit PORT (inline, env wrapper or an earlier export) that is not the
// live broker's; in any other repo it is that project's own dev server and passes.
// Returns null (not a start), or the directories whose repo decides.
function startsBroker(name, argv, dir) {
  const rest = argv.slice(1);
  if (name === "npx" || name === "bunx") {
    const k = rest.findIndex(a => !a.startsWith("-"));
    return k < 0 ? null : startsBroker(basename(rest[k]), rest.slice(k), dir);
  }
  if (name === "node" || name === "nodejs" || name === "nodemon") {
    for (let j = 0; j < rest.length; j++) {
      const a = rest[j];
      if (a === "-e" || a === "--eval" || a === "-p" || a === "--print") return false;
      if (/^(-r|--require|--import|--loader|--experimental-loader|--env-file|--inspect-port)$/.test(a)) { j++; continue; }
      if (a.startsWith("-")) continue;
      return basename(a) === "server.js" ? [dir && dirname(resolve(dir, a))] : null;
    }
    return null;
  }
  if (name === "npm" || name === "pnpm" || name === "yarn") {
    const pos = [];
    let prefix = null;
    for (let j = 0; j < rest.length; j++) {
      const a = rest[j];
      if (/^(--prefix|--cwd|-C|--dir)$/.test(a)) { prefix = rest[j + 1]; j++; continue; }
      const eq = /^(--prefix|--cwd|--dir)=(.+)$/.exec(a);
      if (eq) { prefix = eq[2]; continue; }
      if (/^(--workspace|-w)$/.test(a)) { j++; continue; }
      if (!a.startsWith("-")) pos.push(a);
    }
    const start = pos[0] === "start" || ((pos[0] === "run" || pos[0] === "run-script") && /^(start|dev)$/.test(pos[1] || "")) || (name !== "npm" && pos[0] === "dev");
    return start ? [prefix && dir ? resolve(dir, prefix) : null] : null;
  }
  return null;
}

// claude-broker's server.js: the repo's package.json names claude-broker, or server.js is the broker's.
const brokerRepoCache = new Map();
export function isBrokerRepo(d) {
  if (!d) return false;
  if (brokerRepoCache.has(d)) return brokerRepoCache.get(d);
  let yes = false;
  if (existsSync(resolve(d, "server.js"))) {
    try { yes = /(^|\/)claude-broker$/.test(JSON.parse(readFileSync(resolve(d, "package.json"), "utf8")).name || ""); } catch {}
    if (!yes) { try { yes = /claude-broker/.test(readFileSync(resolve(d, "server.js"), "utf8").slice(0, 65536)); } catch {} }
  }
  brokerRepoCache.set(d, yes);
  return yes;
}

function checkBrokerStart(name, argv, port, ctx, dir) {
  const dirs = startsBroker(name, argv, dir);
  if (!dirs) return null;
  const repos = [ctx.root, dir, dir && gitToplevel(dir), ...dirs].filter(Boolean).map(d => realish(d));
  if (!repos.some(isBrokerRepo)) return null;
  const cmd = `${name} ${argv.slice(1).join(" ")}`.trim();
  if (port === undefined || port === "") return deny("broker-start", `${cmd} with PORT unset starts a broker on ${ctx.brokerPort}, the live broker's port: ${KILL_REASON}; set PORT to a free port`);
  if (/\$/.test(port)) return deny("broker-start", `${cmd} with PORT=${port}: the hook cannot tell it from the live broker's port ${ctx.brokerPort}; spell the port out`);
  if (Number(port) === ctx.brokerPort) return deny("broker-start", `${cmd} with PORT=${port} is the live broker's port: ${KILL_REASON}`);
  return null;
}

// ── Code the static check cannot see at a glance ─────────────────────────────
// Interpreter one-liners, scripts fed to a shell (pipe, heredoc, here-string, source, `bash FILE`) and the
// delete forms of find / rsync / tar. Shell code the hook can read is checked like any line. Interpreter
// code has its string literals checked as shell lines (execSync("git push -f"), os.system("rm -rf ~")),
// then a keyword heuristic: a delete/kill verb or a credential path in code the hook cannot parse is denied.
const DANGER = /\b(rm|rmdir|unlink|unlinkSync|rmSync|rmdirSync|rmtree|kill|pkill|killall|launchctl)\b|\bremove\w*\s*\(|\bos\.remove|\bfs\.remove\w*|\bshutil\.rmtree/;
const SECRET_TEXT = /(^|[^\w-])\.(ssh|aws|netrc)\b|\.config\/(gh|claude-broker)\b|\.claude\.json\b/;
const dangerIn = (code) => { const m = DANGER.exec(code) ?? SECRET_TEXT.exec(code); return m ? m[0].replace(/^[^\w.~]+/, "") : null; };
const OPAQUE_REASON = "the hook cannot follow that code; use plain shell commands (which it checks), or post an ask if the task needs this";
// Producers whose output the hook cannot read: decoders, decompressors, downloads.
const DECODERS = /^(base64|xxd|openssl|uudecode|gunzip|gzip|zcat|bzcat|bzip2|xz|unxz|curl|wget|nc)$/;
const SCRIPT_MAX = 256 * 1024;

const wrap = (d, label) => d && deny(d.rule, `${label}: ${d.reason}`);

function readScript(file, dir, ctx) {
  if (!dir) return null;
  const { v, unresolved } = expand(file, ctx, dir);
  if (unresolved) return null;
  const p = resolve(dir, v);
  try { const s = statSync(p); return s.isFile() && s.size <= SCRIPT_MAX ? readFileSync(p, "utf8") : null; } catch { return null; }
}

// A script committed and unchanged is reviewed code; anything else (untracked, modified, outside a repo) is read.
function trackedClean(p) {
  try {
    execFileSync("git", ["-C", dirname(p), "ls-files", "--error-unmatch", "--", basename(p)], { stdio: "ignore", timeout: 3000 });
    execFileSync("git", ["-C", dirname(p), "diff", "--quiet", "HEAD", "--", basename(p)], { stdio: "ignore", timeout: 3000 });
    return true;
  } catch { return false; }
}

// The text a command writes, when the hook can read it: echo / printf arguments, a heredoc into cat / tee.
function producedText(cmd, argv, bodyOf, dir, ctx) {
  const name = basename(argv[0] ?? "");
  if (name === "echo") return argv.slice(1).filter(a => !/^-[neE]+$/.test(a)).join(" ");
  if (name === "printf") return argv.slice(1).join(" ").replace(/\\n/g, "\n").replace(/\\t/g, "\t");
  if ((name === "cat" || name === "tee") && bodyOf.has(cmd)) return bodyOf.get(cmd);
  if (name === "cat") {
    const parts = argv.slice(1).filter(a => !a.startsWith("-")).map(f => readScript(f, dir, ctx));
    return parts.length && parts.every(x => x !== null) ? parts.join("\n") : null;
  }
  return null;
}

// What a shell / interpreter reads on stdin: { text } when the hook can read it, { opaque: producer } when
// it cannot, null for no redirected stdin.
function stdinOf(cmd, bodyOf, dir, ctx) {
  if (bodyOf.has(cmd)) return { text: bodyOf.get(cmd) };
  if (cmd.herestrings.length) return { text: cmd.herestrings.join("\n") };
  if (!cmd.pipeIn) return null;
  const { argv } = unwrap(cmd.pipeIn.argv);
  const text = producedText(cmd.pipeIn, argv, bodyOf, dir, ctx);
  return text !== null ? { text } : { opaque: basename(argv[0] ?? "") || "?" };
}

// Interpreter code: string literals as shell lines, then the keyword heuristic.
function checkCode(code, label, ctx, dir, depth) {
  for (const m of code.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) {
    const lit = (m[1] ?? m[2] ?? m[3]).replace(/\\(.)/g, "$1");
    const d = checkShell(lit, ctx, dir, depth + 1);
    if (d) return wrap(d, label);
  }
  const hit = dangerIn(code);
  return hit ? deny("opaque-code", `${label} mentions '${hit}': ${OPAQUE_REASON}`) : null;
}

// node -e / python -c / perl -e / ruby -e / php -r / osascript -e / deno eval: the code arguments, and the
// script (first positional) when there is no code argument. null: not an interpreter.
function interpreterArgs(name, argv) {
  let flag, valued;
  if (/^(node|nodejs|bun)$/.test(name)) { flag = /^(-e|--eval|-p|--print|-pe)$/; valued = /^(-r|--require|--import|--loader|--experimental-loader|--input-type|--env-file)$/; }
  else if (/^python(\d+(\.\d+)?)?$/.test(name)) { flag = /^-[A-Za-z]*c$/; valued = /^-[WXQ]$/; }
  else if (name === "perl") { flag = /^-[A-Za-z]*[eE]$/; valued = /^-[IMm]$/; }
  else if (name === "ruby") { flag = /^-[A-Za-z]*e$/; valued = /^-[Ir]$/; }
  else if (name === "php") { flag = /^-r$/; valued = /^-[dc]$/; }
  else if (name === "osascript") { flag = /^-e$/; valued = /^-l$/; }
  else if (name === "deno") return argv[1] === "eval" ? { codes: argv.slice(2).filter(a => !a.startsWith("-")).slice(0, 1), script: null } : { codes: [], script: argv[1] ?? null };
  else return null;
  const codes = [];
  for (let j = 1; j < argv.length; j++) {
    const a = argv[j];
    if (flag.test(a)) { if (argv[j + 1] !== undefined) codes.push(argv[++j]); continue; }
    if (/^python/.test(name) && a === "-m") return { codes, script: argv[j + 1] ?? null };
    if (valued.test(a)) { j++; continue; }
    if (a.startsWith("-") && a !== "-") continue;
    return { codes, script: codes.length ? null : a };
  }
  return { codes, script: null };
}

// bash/sh: the -c code (also in a cluster: bash -lc), else the script file, else stdin.
// { noexec: true }: -n / -o noexec (bash -n watchdog.sh) reads the code and executes none of it, so there is
// nothing to check; -i cancels it (an interactive shell ignores -n), as does a later +n / +o noexec.
// Each o (and in bash/sh, O: shopt) in a short-flag cluster takes the next argv in order, so
// `bash -eO extglob x.sh` runs x.sh. In zsh -O is a plain flag (`zsh -O x.sh` runs x.sh). With -c the
// code is the first operand, not the next argv: `bash -c -e 'code'` runs code.
function shellArgs(argv) {
  const takesO = /^(ba)?sh$/.test(basename(argv[0] ?? ""));
  let n = false, i = false, c = false;
  const done = (r) => (n && !i ? { noexec: true } : r);
  const operand = (a) => done(c ? { code: a ?? null } : { script: a ?? null });
  for (let j = 1; j < argv.length; j++) {
    const a = argv[j];
    if (a === "-s" && !c) return done({});
    if (a === "--") return operand(argv[j + 1]);
    if (/^[-+][A-Za-z]+$/.test(a)) {
      const on = a[0] === "-";
      for (const f of a.slice(1)) {
        if (f === "o" || (f === "O" && takesO)) { const v = argv[++j]; if (f === "o" && v === "noexec") n = on; }
        else if (f === "n") n = on;
        else if (f === "i") i = on;
        else if (f === "c" && on) c = true;
      }
      continue;
    }
    if (/^[-+]/.test(a)) continue;
    return operand(a);
  }
  return done(c ? { code: null } : {});
}

function checkFind(argv, dir, ctx, depth) {
  const args = argv.slice(1);
  let k = 0;
  while (k < args.length && /^-[HLP]$/.test(args[k])) k++;
  const paths = [];
  for (; k < args.length && !/^[-(!]/.test(args[k]); k++) paths.push(args[k]);
  const expr = args.slice(k);
  let how = expr.includes("-delete") ? "-delete" : null;
  for (let j = 0; j < expr.length; j++) {
    if (!/^-(exec|execdir|ok|okdir)$/.test(expr[j])) continue;
    const prog = basename(expr[j + 1] ?? "");
    if (/^(rm|unlink|rmdir)$/.test(prog)) how ??= `${expr[j]} ${prog}`;
    const c = /^(ba|z|da|k)?sh$/.test(prog) ? shellArgs(expr.slice(j + 1)).code : null;
    if (c) { const d = checkShell(c, ctx, dir, depth + 1); if (d) return wrap(d, `find ${expr[j]} ${prog} -c`); }
  }
  if (!how) return null;
  return wrap(checkRm(["rm", "-rf", ...(paths.length ? paths : ["."])], dir, ctx, false, true), `find ${how}`);
}

const RSYNC_VALUED = /^(-e|--rsh|--exclude|--include|--filter|-f|--files-from|--exclude-from|--include-from|--rsync-path|--log-file|--partial-dir|--temp-dir|-T|--backup-dir|--compare-dest|--link-dest|--copy-dest|--chmod|--chown|--port|--password-file|--suffix)$/;
function checkRsync(argv, dir, ctx) {
  const args = argv.slice(1);
  const del = args.find(a => /^--(delete|del|delete-[a-z-]+)$/.test(a));
  const rsf = args.includes("--remove-source-files");
  if (!del && !rsf) return null;
  const pos = [];
  for (let j = 0; j < args.length; j++) { if (RSYNC_VALUED.test(args[j])) { j++; continue; } if (!args[j].startsWith("-")) pos.push(args[j]); }
  if (pos.length < 2) return null;
  const local = (p) => !/^[^/]*:/.test(p);   // host:path and rsync:// are the remote side's business
  const targets = [...(del ? [pos[pos.length - 1]] : []), ...(rsf ? pos.slice(0, -1) : [])].filter(local);
  return targets.length ? wrap(checkRm(["rm", "-rf", ...targets], dir, ctx, false, true), `rsync ${del ?? "--remove-source-files"}`) : null;
}

// tar: members resolve against -C/--directory (tar -C ~ -cf x.tar .ssh reads ~/.ssh), and an extract
// writes into -C (or the cwd), which must be the worktree or tmp.
function checkTar(argv, dir, ctx) {
  const args = argv.slice(1);
  let cdir = dir, extract = false;
  const setDir = (w) => { const { v, unresolved } = expand(w ?? "", ctx, cdir); cdir = unresolved || !cdir || !v ? null : resolve(cdir, v); };
  for (let j = 0; j < args.length; j++) {
    const a = args[j];
    if (a === "-C" || a === "--directory") { setDir(args[++j]); continue; }
    if (a.startsWith("--directory=")) { setDir(a.slice(12)); continue; }
    if (a === "--extract" || a === "--get" || (/^-?[A-Za-z]+$/.test(a) && (j === 0 || a.startsWith("-")) && !a.startsWith("--") && a.includes("x"))) extract = true;
    if (!a.startsWith("-") && cdir) {
      const why = secretWord(a, ctx, cdir);
      if (why) return deny("secret-read", `tar ${a} (in ${cdir}): ${why}; credentials stay out of worker sessions`);
    }
  }
  if (!extract) return null;
  const t = cdir && realish(cdir);
  return t && (atOrWithin(t, ctx.root) || tmpOk(t, ctx)) ? null
    : deny("tar-extract-outside", `tar extracts into ${t ?? "a directory the hook cannot resolve"}, outside this worker's worktree (${ctx.root}) and tmp`);
}

// alias g=git / alias p='git push -f': an alias hides the command from every rule.
const ALIASED = /^(git|rm|kill|pkill|killall|fuser|launchctl|find|rsync|tar|sh|bash|zsh|dash|ksh|eval|source|\.|node|nodejs|python\d*(\.\d+)?|perl|ruby|npm|npx)$/;
function checkAlias(argv, ctx, dir, depth) {
  for (const a of argv.slice(1)) {
    const k = a.indexOf("=");
    if (k <= 0) continue;
    const value = a.slice(k + 1), first = basename(value.trim().split(/\s+/)[0] ?? "");
    if (ALIASED.test(first)) return deny("shell-alias", `alias ${a.slice(0, k)}=${value}: an alias hides ${first} from the guardrails; run the command itself`);
    const d = checkShell(value, ctx, dir, depth + 1); if (d) return wrap(d, `alias ${a.slice(0, k)}`);
  }
  return null;
}

// One shell line; dir is the directory it runs in (followed through cd), null once unknowable.
function checkShell(src, ctx, dir, depth = 0, exported = {}) {
  if (depth > 4) return null;
  const { text: body, bodies } = splitHeredocs(src);
  const { toks, subs } = lex(body);
  const cmds = simpleCommands(toks);
  // Heredoc bodies to the command that reads them, by delimiter in order of appearance.
  const bodyOf = new Map();
  let bi = 0;
  for (const c of cmds) for (const w of c.heredocs) {
    const k = bodies.findIndex((b, j) => j >= bi && b.word === w);
    if (k < 0) continue;
    bi = k + 1;
    bodyOf.set(c, bodyOf.has(c) ? `${bodyOf.get(c)}\n${bodies[k].body}` : bodies[k].body);
  }
  exported = { ...exported };
  const bgVars = new Set();   // VAR=$! on this line, until reassigned
  const track = (k, v) => { if (v === "$!") bgVars.add(k); else bgVars.delete(k); };
  const written = new Map();  // file written earlier on this line → its text (null: unknown)
  // A file to run as shell code: written on this line (its text, else the keyword heuristic on the whole
  // line), or on disk and not committed-and-unchanged (its content).
  const script = (file, label, scope) => {
    if (!dir || !file) return null;
    const { v, unresolved } = expand(file, ctx, dir);
    if (unresolved) return null;
    const p = resolve(dir, v);
    if (written.has(p)) {
      const t = written.get(p);
      if (t !== null) return wrap(checkShell(t, ctx, dir, depth + 1, scope), `${label} (written on this line)`);
      const hit = dangerIn(src);
      return hit ? deny("opaque-code", `${label}, written on this line, mentions '${hit}': ${OPAQUE_REASON}`) : null;
    }
    if (!existsSync(p) || trackedClean(p)) return null;
    const content = readScript(file, dir, ctx);
    return content === null ? null : wrap(checkShell(content, ctx, dir, depth + 1, scope), label);
  };
  // stdin of a shell (kind "shell") or an interpreter (kind "code").
  const feed = (cmd, name, kind, scope) => {
    const f = stdinOf(cmd, bodyOf, dir, ctx);
    if (!f) return null;
    if (f.opaque) {
      if (DECODERS.test(f.opaque)) return deny("piped-code", `${f.opaque} | ${name}: decoded or downloaded code runs unseen; ${OPAQUE_REASON}`);
      const hit = dangerIn(src);
      return hit ? deny("piped-code", `${f.opaque} | ${name} on a line that mentions '${hit}': ${OPAQUE_REASON}`) : null;
    }
    return kind === "shell" ? wrap(checkShell(f.text, ctx, dir, depth + 1, scope), `code fed to ${name}`) : checkCode(f.text, `code fed to ${name}`, ctx, dir, depth);
  };
  for (const s of subs) { const d = checkShell(s, ctx, dir, depth + 1, exported); if (d) return d; }
  for (const cmd of cmds) {
    for (const w of [...cmd.argv, ...cmd.redirs]) {
      const why = secretWord(w, ctx, dir);
      if (why) return deny("secret-read", `${w}: ${why}; credentials stay out of worker sessions`);
    }
    const { argv, viaXargs, assigns } = unwrap(cmd.argv);
    if (dir) {
      const text = argv.length ? producedText(cmd, argv, bodyOf, dir, ctx) : null;
      const outs = [...cmd.outs, ...(basename(argv[0] ?? "") === "tee" ? argv.slice(1).filter(a => !a.startsWith("-")) : [])];
      for (const o of outs) { const { v, unresolved } = expand(o, ctx, dir); if (!unresolved) written.set(resolve(dir, v), text); }
    }
    if (!argv.length) { for (const [k, v] of Object.entries(assigns)) track(k, v); continue; }
    const name = basename(argv[0]);
    if (name === "export" || name === "local" || name === "declare" || name === "readonly") {
      for (const a of argv.slice(1)) { const k = a.indexOf("="); if (k > 0) { if (name === "export") exported[a.slice(0, k)] = a.slice(k + 1); track(a.slice(0, k), a.slice(k + 1)); } }
      continue;
    }
    if (name === "read") for (const a of argv.slice(1)) if (!a.startsWith("-")) bgVars.delete(a);
    if (name === "unset") { for (const a of argv.slice(1)) delete exported[a]; continue; }
    if (name === "cd" || name === "pushd") {
      const t = argv.find((a, k) => k > 0 && !a.startsWith("-"));
      if (t === undefined) dir = ctx.home;
      else { const { v, unresolved } = expand(t, ctx, dir); dir = unresolved || t === "-" || !dir ? null : resolve(dir, v); }
      continue;
    }
    const scope = { ...exported, ...assigns };
    if (/^(ba|z|da|k)?sh$/.test(name)) {
      const sh = shellArgs(argv);
      if (sh.noexec) continue;
      if (sh.code) {
        const d = checkShell(sh.code, ctx, dir, depth + 1, scope); if (d) return d;
        // xargs sh -c 'kill "$0"': the pids come from the line's producer, which the inner script cannot show.
        if (viaXargs && /\b(kill|pkill|killall)\b/.test(sh.code) && brokerHint(body, ctx)) return deny("broker-kill", `xargs ${name} -c kill from a line that names the broker: ${KILL_REASON}`);
      } else {
        const d = sh.script ? script(sh.script, `${name} ${sh.script}`, scope) : feed(cmd, name, "shell", scope);
        if (d) return d;
      }
      continue;
    }
    if (name === "source" || name === ".") { const d = script(argv[1], `${name} ${argv[1]}`, scope); if (d) return d; continue; }
    if (name === "eval") { const d = checkShell(argv.slice(1).join(" "), ctx, dir, depth + 1, exported); if (d) return d; continue; }
    if (name === "alias") { const d = checkAlias(argv, ctx, dir, depth); if (d) return d; continue; }
    const interp = interpreterArgs(name, argv);
    if (interp) {
      for (const code of interp.codes) { const d = checkCode(code, `${name} one-liner`, ctx, dir, depth); if (d) return d; }
      if (!interp.codes.length && (interp.script === null || interp.script === "-")) { const d = feed(cmd, name, "code", scope); if (d) return d; }
    }
    const port = "PORT" in assigns ? assigns.PORT : "PORT" in exported ? exported.PORT : ctx.env.PORT;
    const d = name === "git" ? checkGit(argv, dir, ctx) : name === "rm" ? checkRm(argv, dir, ctx, viaXargs)
            : /^(kill|pkill|killall|fuser)$/.test(name) ? checkKill(name, argv, ctx, body, viaXargs, bgVars)
            : name === "launchctl" ? checkLaunchctl(argv)
            : name === "find" ? checkFind(argv, dir, ctx, depth)
            : name === "rsync" ? checkRsync(argv, dir, ctx)
            : /^(g|bsd)?tar$/.test(name) ? checkTar(argv, dir, ctx)
            : checkBrokerStart(name, argv, port, ctx, dir);
    if (d) return d;
  }
  return null;
}

// ── Tool allowlist / extra_deny ──────────────────────────────────────────────

function globRe(g) { return new RegExp("^" + g.split("*").map(s => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "s"); }
// Claude Code permission-rule syntax: "Read", "Bash(git *)", "Bash(npm:*)", "mcp__server", "mcp__server__tool".
export function toolAllowed(name, toolInput, list) {
  if (!Array.isArray(list) || !list.length || name.startsWith("mcp__broker__")) return true;
  for (const spec of list) {
    const m = /^([^()]+?)\s*(?:\((.*)\))?$/.exec(String(spec).trim());
    if (!m) continue;
    const [, n, arg] = m;
    const nameOk = n === name || (n.endsWith("*") && name.startsWith(n.slice(0, -1))) || (n.startsWith("mcp__") && name.startsWith(n + "__"));
    if (!nameOk) continue;
    if (arg === undefined || name !== "Bash") return true;
    const cmd = String(toolInput?.command ?? "").trim();
    if (arg.endsWith(":*") ? cmd === arg.slice(0, -2) || cmd.startsWith(arg.slice(0, -2) + " ") : globRe(arg).test(cmd)) return true;
  }
  return false;
}

function toRe(p) { try { return new RegExp(p); } catch { return new RegExp(String(p).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")); } }
function checkExtra(name, toolInput, extra) {
  for (const e of Array.isArray(extra) ? extra : []) {
    const rule = typeof e === "string" ? { pattern: e } : e;
    if (!rule || typeof rule.pattern !== "string") continue;
    const toolRe = toRe(rule.tool ? `^(?:${rule.tool})$` : "^Bash$");
    if (!toolRe.test(name)) continue;
    const subject = name === "Bash" ? String(toolInput?.command ?? "") : JSON.stringify(toolInput ?? {});
    if (toRe(rule.pattern).test(subject)) return deny("extra-deny", rule.reason || `matches this worker's extra_deny pattern /${rule.pattern}/`);
  }
  return null;
}

// ── Entry ────────────────────────────────────────────────────────────────────

const FILE_TOOLS = { Read: ["file_path"], Edit: ["file_path"], MultiEdit: ["file_path"], Write: ["file_path"], NotebookEdit: ["notebook_path"],
                     NotebookRead: ["notebook_path"], Grep: ["path"], Glob: ["path", "pattern"], LS: ["path"] };

// input: the PreToolUse hook input ({ tool_name, tool_input, cwd }). Returns null (allow) or { rule, reason }.
export function evaluate(input, cfg = {}, env = process.env) {
  const name = String(input?.tool_name || ""), ti = input?.tool_input || {};
  const ctx = context(cfg, input || {}, env);
  if (!toolAllowed(name, ti, cfg.allowed_tools)) return deny("tool-not-allowed", `${name} is not in this worker's allowed_tools`);
  const extra = checkExtra(name, ti, cfg.extra_deny);
  if (extra) return extra;
  if (name === "Bash" && typeof ti.command === "string") return checkShell(ti.command, ctx, realish(ctx.cwd));
  for (const k of FILE_TOOLS[name] || []) {
    if (typeof ti[k] !== "string" || !ti[k]) continue;
    const { v } = expand(ti[k], ctx, ctx.cwd);
    const why = secretPath(resolve(ctx.cwd, v), ctx);
    if (why) return deny("secret-read", `${ti[k]}: ${why}; credentials stay out of worker sessions`);
  }
  return null;
}

export const denyReason = (d) => `Guardrail ${d.rule}: ${d.reason}. The command was not run; this session continues. Take another approach, or post an ask if the task really needs it.`;

export function hookOutput(d) {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: denyReason(d) } };
}

// One line per deny: "<ts> DENY worker=<w> rule=<r> tool=<t> cmd=<command or input, 400 chars>".
export function logDeny(cfg, input, d) {
  if (!cfg.log) return;
  const ti = input?.tool_input || {};
  const what = typeof ti.command === "string" ? ti.command : JSON.stringify(ti);
  const line = `${new Date().toISOString()} DENY worker=${cfg.worker || "?"} rule=${d.rule} tool=${input?.tool_name || "?"} cmd=${what.replace(/\s+/g, " ").slice(0, 400)}\n`;
  try { appendFileSync(cfg.log, line); } catch {}
}

export function loadConfig(path) {
  if (!path) return {};
  try { const c = JSON.parse(readFileSync(path, "utf8")); return c && typeof c === "object" ? c : {}; }
  catch { return {}; }   // the built-in rules still apply, rooted at the session's cwd
}

// Agent SDK form (options.hooks.PreToolUse[].hooks[]).
export function sdkHook(cfg) {
  return async (input) => {
    let d = null;
    try { d = evaluate(input, cfg); } catch { d = null; }
    if (!d) return {};
    logDeny(cfg, input, d);
    return hookOutput(d);
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cfg = loadConfig(process.argv[2]);
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", c => (data += c)).on("end", () => {
    let input = null, d = null;
    try { input = JSON.parse(data); } catch {}
    // A hook that crashes must not block every tool call: errors allow, never kill the session.
    try { d = input ? evaluate(input, cfg) : null; } catch { d = null; }
    if (d) { logDeny(cfg, input, d); process.stdout.write(JSON.stringify(hookOutput(d)) + "\n"); }
    process.exitCode = 0;
  });
}

export const HOOK_PATH = fileURLToPath(import.meta.url);
