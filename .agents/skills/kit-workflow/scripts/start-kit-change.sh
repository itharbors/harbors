#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
. "$script_dir/_kit-workflow-lib.sh"

test "$#" -eq 3 || kit_workflow_fail 'usage: start-kit-change.sh <kit> <type> <slug>'
kit=$1
change_type=$2
slug=$3
kit_workflow_validate_kit_name "$kit"
kit_workflow_validate_change_type "$change_type"
[[ "$slug" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || kit_workflow_fail "invalid slug: $slug"

repo_root=$(kit_workflow_repo_root)
git_dir=$(git -C "$repo_root" rev-parse --absolute-git-dir)
git_common=$(git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir)
test "$git_dir" = "$git_common" || kit_workflow_fail 'start must run from the primary worktree'
git -C "$repo_root" remote get-url origin >/dev/null 2>&1 || kit_workflow_fail 'origin remote is missing'
kit_workflow_validate_identity "$repo_root"

git -C "$repo_root" fetch origin --prune
target_branch=main
target_ref="refs/remotes/origin/$target_branch"
git -C "$repo_root" show-ref --verify --quiet "$target_ref" || kit_workflow_fail "origin/$target_branch is missing"
base_commit=$(git -C "$repo_root" rev-parse "$target_ref")
branch="kit-change/$kit/$change_type/$slug"
worktree_path="$repo_root/.worktrees/kit-$kit-$change_type-$slug"

git -C "$repo_root" show-ref --verify --quiet "refs/heads/$branch" && kit_workflow_fail "branch already exists: $branch"
git -C "$repo_root" show-ref --verify --quiet "refs/remotes/origin/$branch" && kit_workflow_fail "remote branch already exists: $branch"
test ! -e "$worktree_path" || kit_workflow_fail "worktree path already exists: $worktree_path"
if git -C "$repo_root" worktree list --porcelain | grep -Fqx "worktree $worktree_path"; then
  kit_workflow_fail "worktree already registered: $worktree_path"
fi

git -C "$repo_root" worktree add -b "$branch" "$worktree_path" "$base_commit"
kit_workflow_validate_product "$worktree_path" "$kit"
(cd "$worktree_path" && npm ci)
command -v gh >/dev/null 2>&1 || printf 'warning: gh is not installed; it is required to finish and create a PR\n' >&2
printf 'KIT=%s\nTARGET_BRANCH=%s\nBRANCH=%s\nWORKTREE_PATH=%s\nBASE_COMMIT=%s\n' \
  "$kit" "$target_branch" "$branch" "$worktree_path" "$base_commit"
