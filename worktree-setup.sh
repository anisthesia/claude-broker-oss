#!/usr/bin/env bash
# Create an isolated git worktree per worker, each on its own branch (worker/<name>).
#
# Worktrees give every worker a private checkout, so concurrent workers can never
# clobber each other's uncommitted changes on a shared working tree. Run once when
# setting up a project (or again to add workers — it's idempotent).
#
# Usage:
#   ./worktree-setup.sh --project <repo> [--worktree-base <dir>] [--base-branch <branch>] <worker>...
#
#   --project <repo>          Path to the project git repo (required).
#   --worktree-base <dir>     Where worktrees live (default: <repo>/../<repo>-workers).
#   --base-branch <branch>    Branch to fork each worker from (default: repo's current branch).
#
# Example:
#   ./worktree-setup.sh --project ~/app --worktree-base ~/app-workers backend frontend

set -euo pipefail

PROJECT=""; WORKTREE_BASE=""; BASE_BRANCH=""; WORKERS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)        PROJECT="$2";        shift 2 ;;
    --worktree-base)  WORKTREE_BASE="$2";  shift 2 ;;
    --base-branch)    BASE_BRANCH="$2";    shift 2 ;;
    -*) echo "Unknown option: $1"; exit 1 ;;
    *)  WORKERS+=("$1"); shift ;;
  esac
done

[[ -z "$PROJECT" ]] && { echo "ERROR: --project <repo> is required"; exit 1; }
[[ ${#WORKERS[@]} -eq 0 ]] && { echo "ERROR: name at least one worker"; exit 1; }
PROJECT="$(cd "$PROJECT" && pwd)"
if ! git -C "$PROJECT" rev-parse --git-dir >/dev/null 2>&1; then
  echo "ERROR: $PROJECT is not a git repository. Run 'git init' there first."; exit 1
fi

[[ -z "$BASE_BRANCH" ]] && BASE_BRANCH="$(git -C "$PROJECT" branch --show-current 2>/dev/null || echo main)"
[[ -z "$WORKTREE_BASE" ]] && WORKTREE_BASE="$(dirname "$PROJECT")/$(basename "$PROJECT")-workers"
mkdir -p "$WORKTREE_BASE"

echo "[worktree-setup] project: $PROJECT"
echo "[worktree-setup] base branch: $BASE_BRANCH   worktree base: $WORKTREE_BASE"

for W in "${WORKERS[@]}"; do
  BRANCH="worker/$W"
  WT="$WORKTREE_BASE/$W"

  # Already a worktree at this path? (idempotent)
  if git -C "$PROJECT" worktree list --porcelain | grep -qxF "worktree $WT"; then
    echo "[worktree-setup] $W → exists ($WT) — skipping"
    continue
  fi
  if [[ -e "$WT" ]]; then
    echo "[worktree-setup] $W → $WT already exists but is not a registered worktree — skipping (remove it or pick another base)"
    continue
  fi

  if git -C "$PROJECT" show-ref --verify --quiet "refs/heads/$BRANCH"; then
    git -C "$PROJECT" worktree add "$WT" "$BRANCH"
    echo "[worktree-setup] $W → worktree at $WT on existing $BRANCH"
  else
    git -C "$PROJECT" worktree add -b "$BRANCH" "$WT" "$BASE_BRANCH"
    echo "[worktree-setup] $W → worktree at $WT on new $BRANCH (from $BASE_BRANCH)"
  fi
done

# Never let a worker commit its generated root CLAUDE.md role file. Excludes only affect
# UNtracked files, so a project that already tracks a CLAUDE.md is unaffected. This is added to
# the shared git exclude (applies to every worktree + the main checkout).
COMMON="$(cd "$PROJECT" && git rev-parse --git-common-dir)"
[[ "$COMMON" != /* ]] && COMMON="$PROJECT/$COMMON"
EXCLUDE="$COMMON/info/exclude"
mkdir -p "$(dirname "$EXCLUDE")"
touch "$EXCLUDE"
for f in /CLAUDE.md /CLAUDE.local.md; do
  if ! grep -qxF "$f" "$EXCLUDE"; then
    printf '\n# claude-broker: per-worker role file at worktree root — never commit\n%s\n' "$f" >> "$EXCLUDE"
    echo "[worktree-setup] excluded $f from commits (worker role files stay local)"
  fi
done

echo "[worktree-setup] done. Point each worker's --repo-root / --work-dir at its worktree."
