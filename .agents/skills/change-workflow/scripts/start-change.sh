#!/usr/bin/env bash
set -euo pipefail

fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

test "$#" -eq 2 || fail 'usage: start-change.sh <type> <slug>'
change_type=$1
slug=$2
case "$change_type" in
  feature|bug|docs|refactor|optimize|test|chore) ;;
  *) fail "invalid change type: $change_type" ;;
esac
[[ "$slug" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || fail "invalid slug: $slug"

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
repo_root=$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null) || fail 'skill is not inside a Git repository'
git_dir=$(git -C "$repo_root" rev-parse --absolute-git-dir)
git_common=$(git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir)
test "$git_dir" = "$git_common" || fail 'start must run from the primary worktree'
git -C "$repo_root" remote get-url origin >/dev/null 2>&1 || fail 'origin remote is missing'

git -C "$repo_root" fetch origin --prune
git -C "$repo_root" show-ref --verify --quiet refs/remotes/origin/main || fail 'origin/main is missing'
base_commit=$(git -C "$repo_root" rev-parse refs/remotes/origin/main)
branch="$change_type/$slug"
worktree_path="$repo_root/.worktrees/$change_type-$slug"

if git -C "$repo_root" show-ref --verify --quiet "refs/heads/$branch"; then fail "branch already exists: $branch"; fi
if git -C "$repo_root" show-ref --verify --quiet "refs/remotes/origin/$branch"; then fail "remote branch already exists: $branch"; fi
test ! -e "$worktree_path" || fail "worktree path already exists: $worktree_path"
if git -C "$repo_root" worktree list --porcelain | grep -Fqx "worktree $worktree_path"; then
  fail "worktree already registered: $worktree_path"
fi

git -C "$repo_root" worktree add -b "$branch" "$worktree_path" "$base_commit"
command -v gh >/dev/null 2>&1 || printf 'warning: gh is not installed; it is required to finish and create a PR\n' >&2
printf 'WORKTREE_PATH=%s\nBRANCH=%s\nCHANGE_TYPE=%s\nBASE_COMMIT=%s\n' \
  "$worktree_path" "$branch" "$change_type" "$base_commit"
