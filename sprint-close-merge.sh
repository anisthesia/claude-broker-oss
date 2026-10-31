#!/usr/bin/env bash
# Sprint-close merge — merge each worker branch (worker/<name>) into the main branch,
# then reset every worker worktree to the new main HEAD so the next sprint starts clean.
#
# Run from the orchestrator after workers report their results and QA passes.
#
# Usage:
#   ./sprint-close-merge.sh --project <repo> [--worktree-base <dir>] [--main-branch <b>] <worker>...
#
#   --project <repo>          Path to the project git repo (required).
#   --worktree-base <dir>     Where worker worktrees live (default: <repo>/../<repo>-workers).
#   --main-branch <branch>    Integration branch (default: main).
#
# If the repo has an 'origin' remote, main is fetched/rebased before and pushed after.
# Without a remote it works fully locally.

set -euo pipefail

PROJECT=""; WORKTREE_BASE=""; MAIN_BRANCH="main"; WORKERS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)        PROJECT="$2";        shift 2 ;;
    --worktree-base)  WORKTREE_BASE="$2";  shift 2 ;;
    --main-branch)    MAIN_BRANCH="$2";    shift 2 ;;
    -*) echo "Unknown option: $1"; exit 1 ;;
    *)  WORKERS+=("$1"); shift ;;
  esac
done

[[ -z "$PROJECT" ]] && { echo "ERROR: --project <repo> is required"; exit 1; }
[[ ${#WORKERS[@]} -eq 0 ]] && { echo "ERROR: name at least one worker to merge"; exit 1; }
PROJECT="$(cd "$PROJECT" && pwd)"
git -C "$PROJECT" rev-parse --git-dir >/dev/null 2>&1 || { echo "ERROR: $PROJECT is not a git repo"; exit 1; }
[[ -z "$WORKTREE_BASE" ]] && WORKTREE_BASE="$(dirname "$PROJECT")/$(basename "$PROJECT")-workers"
HAS_ORIGIN=$(git -C "$PROJECT" remote | grep -qx origin && echo 1 || echo "")

echo "[sprint-close] merging ${#WORKERS[@]} worker(s) into $MAIN_BRANCH: ${WORKERS[*]}"

# ── Concurrency lock (atomic mkdir) ───────────────────────────────────────────
LOCK_DIR="/tmp/sprint-close-$(basename "$PROJECT").lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "[sprint-close] ERROR: another sprint-close is running (lock: $LOCK_DIR). If stale: rm -rf $LOCK_DIR"; exit 1
fi
trap 'rm -rf "$LOCK_DIR"' EXIT

# ── Phase-tracking recovery advice ────────────────────────────────────────────
_PHASE="startup"; _CW=""; _CWT=""
trap '
  case "$_PHASE" in
    merge)   echo "[sprint-close] ERROR: merge conflict in worker/$_CW — cd $PROJECT; git merge --abort; resolve; re-run" ;;
    reset)   GD=$(git -C "$_CWT" rev-parse --git-dir 2>/dev/null || echo unknown); echo "[sprint-close] ERROR: reset failed in $_CW worktree ($_CWT). Check for stale $GD/index.lock (rm it, re-run)" ;;
    *)       echo "[sprint-close] ERROR: failure during phase: $_PHASE" ;;
  esac
  exit 1
' ERR

# ── Must run with the repo on main ────────────────────────────────────────────
cd "$PROJECT"
CURRENT=$(git branch --show-current)
[[ "$CURRENT" != "$MAIN_BRANCH" ]] && { echo "[sprint-close] ERROR: $PROJECT must be on $MAIN_BRANCH (currently: $CURRENT)"; exit 1; }
if [[ -n "$HAS_ORIGIN" ]]; then
  git fetch origin "$MAIN_BRANCH"
  git rebase "origin/$MAIN_BRANCH"
fi

# ── Pre-flight: reject dirty worktrees / stale index locks ────────────────────
_PHASE="preflight"; DIRTY=()
for W in "${WORKERS[@]}"; do
  WT="$WORKTREE_BASE/$W"; [[ -d "$WT" ]] || continue
  if ! git -C "$WT" diff --quiet HEAD 2>/dev/null; then DIRTY+=("$W (modified tracked files)"); continue; fi
  if [[ -n "$(git -C "$WT" ls-files --others --exclude-standard 2>/dev/null)" ]]; then DIRTY+=("$W (untracked files)"); continue; fi
  GD=$(git -C "$WT" rev-parse --git-dir 2>/dev/null || echo "")
  [[ -n "$GD" && -f "$GD/index.lock" ]] && DIRTY+=("$W (stale index lock: $GD/index.lock)")
done
if [[ ${#DIRTY[@]} -gt 0 ]]; then
  echo "[sprint-close] ERROR: resolve these before sprint-close:"; printf '  %s\n' "${DIRTY[@]}"; exit 1
fi

# ── Merge each worker branch ──────────────────────────────────────────────────
_PHASE="merge"; MERGED=(); SKIPPED=()
for W in "${WORKERS[@]}"; do
  _CW="$W"; BRANCH="worker/$W"
  if ! git rev-parse --verify "$BRANCH" >/dev/null 2>&1; then echo "[sprint-close] SKIP $BRANCH — not found"; SKIPPED+=("$W"); continue; fi
  AHEAD=$(git rev-list "$MAIN_BRANCH..$BRANCH" --count 2>/dev/null || echo 0)
  if [[ "$AHEAD" -eq 0 ]]; then echo "[sprint-close] SKIP $BRANCH — no commits ahead"; SKIPPED+=("$W"); continue; fi
  echo "[sprint-close] merging $BRANCH ($AHEAD commit(s) ahead)"
  git merge --no-ff "$BRANCH" -m "sprint-close: merge $BRANCH into $MAIN_BRANCH"
  MERGED+=("$W")
done

if [[ ${#MERGED[@]} -gt 0 ]]; then
  echo "[sprint-close] merged: ${MERGED[*]}"; [[ ${#SKIPPED[@]} -gt 0 ]] && echo "[sprint-close] skipped: ${SKIPPED[*]}"
  [[ -n "$HAS_ORIGIN" ]] && { echo "[sprint-close] pushing $MAIN_BRANCH"; git push origin "$MAIN_BRANCH"; }
else
  echo "[sprint-close] nothing to merge — worker branches are at $MAIN_BRANCH HEAD"
fi
NEW_HEAD=$(git rev-parse --short HEAD)
echo "[sprint-close] $MAIN_BRANCH is now at $NEW_HEAD"

# ── Reset each worker worktree to the new main ────────────────────────────────
_PHASE="reset"
for W in "${WORKERS[@]}"; do
  _CW="$W"; BRANCH="worker/$W"; WT="$WORKTREE_BASE/$W"; _CWT="$WT"
  if [[ -d "$WT" ]]; then
    ACTUAL=$(git -C "$WT" branch --show-current 2>/dev/null || echo "")
    if [[ "$ACTUAL" != "$BRANCH" ]]; then
      echo "[sprint-close] WARN: $W worktree on '$ACTUAL' (expected $BRANCH) — checking out"
      git -C "$WT" checkout "$BRANCH" 2>/dev/null || { echo "[sprint-close] ERROR: cannot checkout $BRANCH in $WT"; continue; }
    fi
    echo "[sprint-close] resetting $WT → $NEW_HEAD"
    if [[ -n "$HAS_ORIGIN" ]]; then git -C "$WT" fetch origin "$MAIN_BRANCH"; git -C "$WT" reset --hard "origin/$MAIN_BRANCH"
    else git -C "$WT" reset --hard "$MAIN_BRANCH"; fi
  elif git rev-parse --verify "$BRANCH" >/dev/null 2>&1; then
    git branch -f "$BRANCH" "$MAIN_BRANCH" 2>/dev/null || true
    echo "[sprint-close] reset $BRANCH → $NEW_HEAD (no worktree)"
  fi
done

echo "[sprint-close] done — worker worktrees reset to $NEW_HEAD"
