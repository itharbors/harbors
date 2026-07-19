#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

test "$#" -eq 1 || fail 'usage: start-feature.sh <slug>'
slug=$1
[[ "$slug" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || fail "invalid slug: $slug"

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
repo_root=$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null) || fail 'skill is not inside a Git repository'
git_dir=$(git -C "$repo_root" rev-parse --absolute-git-dir)
git_common=$(git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir)

test "$git_dir" = "$git_common" || fail 'start must run from the primary worktree'
test "$(git -C "$repo_root" branch --show-current)" = main || fail 'primary worktree must be on main'
git -C "$repo_root" remote get-url origin >/dev/null 2>&1 || fail 'origin remote is missing'

git -C "$repo_root" fetch origin --prune
git -C "$repo_root" show-ref --verify --quiet refs/heads/main || fail 'local main is missing'
git -C "$repo_root" show-ref --verify --quiet refs/remotes/origin/main || fail 'origin/main is missing'
test -z "$(git -C "$repo_root" status --porcelain=v1 --untracked-files=all)" || fail 'working tree is not clean'

local_main=$(git -C "$repo_root" rev-parse refs/heads/main)
remote_main=$(git -C "$repo_root" rev-parse refs/remotes/origin/main)
test "$local_main" = "$remote_main" || fail "main does not match origin/main (main=$local_main origin/main=$remote_main)"

branch="codex/$slug"
worktree_path="$repo_root/.worktrees/$slug"

if git -C "$repo_root" show-ref --verify --quiet "refs/heads/$branch"; then
  fail "branch already exists: $branch"
fi
test ! -e "$worktree_path" || fail "worktree path already exists: $worktree_path"
if git -C "$repo_root" worktree list --porcelain | grep -Fqx "worktree $worktree_path"; then
  fail "worktree already registered: $worktree_path"
fi

git -C "$repo_root" worktree add -b "$branch" "$worktree_path" origin/main
if ! command -v gh >/dev/null 2>&1; then
  printf 'warning: gh is not installed; it is required to finish and create a PR\n' >&2
fi

printf 'WORKTREE_PATH=%s\n' "$worktree_path"
printf 'BRANCH=%s\n' "$branch"
printf 'BASE_COMMIT=%s\n' "$remote_main"
