#!/usr/bin/env bash
set -euo pipefail

fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

test "$#" -eq 2 || fail 'usage: start-change.sh current <task-id> | worktree <task-id>'
mode=$1
name=$2
task_id_pattern='^[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9]+(-[a-z0-9]+)*$'
slug_pattern='^[a-z0-9]+(-[a-z0-9]+)*$'
case "$mode" in
  current|worktree)
    [[ "$name" =~ $task_id_pattern ]] || fail "invalid task id: $name"
    task_id=$name
    ;;
  *) fail "invalid start mode: $mode" ;;
esac

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
repo_root=$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null) || fail 'skill is not inside a Git repository'
git_dir=$(git -C "$repo_root" rev-parse --absolute-git-dir)
git_common=$(git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir)
current_branch=$(git -C "$repo_root" branch --show-current)
test -n "$current_branch" || fail 'current workspace is detached'
if test "$mode" = current; then
  base_commit=$(git -C "$repo_root" rev-parse --verify --end-of-options HEAD^{commit}) \
    || fail 'current workspace HEAD is missing'
else
  test "$git_dir" = "$git_common" || fail 'start must run from the primary worktree'
  test "$current_branch" = main || fail 'primary worktree must be on main'
  base_commit=$(git -C "$repo_root" rev-parse --verify --end-of-options refs/heads/main^{commit}) \
    || fail 'local main is missing'
fi

task_dir_for() {
  local id=$1
  printf '%s\n' "$repo_root/docs/tasks/$id"
}

task_type_for() {
  local id=$1 status_path type
  status_path=$(task_dir_for "$id")/status.json
  test -f "$status_path" || fail "Task status is missing: $id"
  type=$(node -e 'const fs=require("node:fs"); const value=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(value.type ?? "");' "$status_path") \
    || fail "Task status is invalid: $id"
  case "$type" in
    feature|bug|docs|refactor|optimize|test|chore) printf '%s\n' "$type" ;;
    *) fail "Task status has an invalid type: $id" ;;
  esac
}

validate_task() {
  local id=$1
  test -d "$(task_dir_for "$id")" || fail "Task directory is missing: $id"
  (cd "$repo_root" && node scripts/task-status.mjs check "$id" >/dev/null) \
    || fail "Task validation failed: $id"
}

start_design() {
  local root=$1 id=$2
  (cd "$root" && node scripts/task-status.mjs start "$id" design >/dev/null) \
    || fail "Task design could not be started: $id"
}

ensure_design_started() {
  local root=$1 id=$2 stage
  stage=$(node -e 'const fs=require("node:fs"); const value=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(value.stages.design ?? "");' "$root/docs/tasks/$id/status.json") \
    || fail "Task status is invalid: $id"
  if test "$stage" = pending; then
    start_design "$root" "$id"
  fi
}

workspace_status=$(git -C "$repo_root" status --porcelain=v1 --untracked-files=all)
workspace_status_count=$(printf '%s\n' "$workspace_status" | awk 'NF { count += 1 } END { print count + 0 }')
workspace_dirty=0
test "$workspace_status_count" -eq 0 || workspace_dirty=1

if test "$mode" = current; then
  validate_task "$task_id"
  change_type=$(task_type_for "$task_id")
  ensure_design_started "$repo_root" "$task_id"
  task_dir=$(cd "$(task_dir_for "$task_id")" && pwd -P)
  printf 'MODE=current\nWORKTREE_PATH=%s\nBRANCH=%s\nCHANGE_TYPE=%s\nBASE_COMMIT=%s\nTASK_ID=%s\nTASK_DIR=%s\nWORKSPACE_DIRTY=%s\nWORKSPACE_STATUS_COUNT=%s\n' \
    "$repo_root" "$current_branch" "$change_type" "$base_commit" "$task_id" "$task_dir" "$workspace_dirty" "$workspace_status_count"
  exit 0
fi

validate_task "$task_id"
change_type=$(task_type_for "$task_id")
slug=${task_id:11}

branch="$change_type/$slug"
worktree_path="$repo_root/.worktrees/$change_type-$slug"

worktrees_root="$repo_root/.worktrees"
if test -e "$worktrees_root" || test -L "$worktrees_root"; then
  test ! -L "$worktrees_root" || fail '.worktrees must not be a symlink'
  test -d "$worktrees_root" || fail '.worktrees must be a directory inside the repository'
else
  mkdir "$worktrees_root"
fi
test "$(cd "$worktrees_root" && pwd -P)" = "$repo_root/.worktrees" \
  || fail '.worktrees must resolve inside the repository'

if git -C "$repo_root" show-ref --verify --quiet "refs/heads/$branch"; then fail "branch already exists: $branch"; fi
if git -C "$repo_root" show-ref --verify --quiet "refs/remotes/origin/$branch"; then fail "remote branch already exists: $branch"; fi
test ! -L "$worktree_path" || fail "worktree path must not be a symlink: $worktree_path"
test ! -e "$worktree_path" || fail "worktree path already exists: $worktree_path"
if git -C "$repo_root" worktree list --porcelain | grep -Fqx "worktree $worktree_path"; then
  fail "worktree already registered: $worktree_path"
fi

task_dir=$(task_dir_for "${task_id:-}")
move_task=0
if test "$mode" = worktree; then
  task_status=$(git -C "$repo_root" status --porcelain=v1 --untracked-files=all -- "docs/tasks/$task_id")
  if test -n "$task_status"; then
    while IFS= read -r status_line; do
      case "$status_line" in
        '?? '*) ;;
        *) fail "Task contains tracked or modified files; cannot safely transfer: $task_id" ;;
      esac
    done <<< "$task_status"
    move_task=1
  fi
  test -d "$task_dir" || fail "Task directory is missing: $task_id"
  test ! -L "$task_dir" || fail "Task directory must not be a symlink: $task_id"
  test ! -e "$worktree_path/docs/tasks/$task_id" || fail "Task path already exists in worktree: $task_id"
fi

git -C "$repo_root" worktree add -b "$branch" "$worktree_path" "$base_commit"
if test "$mode" = worktree && test "$move_task" -eq 1; then
  mv "$task_dir" "$worktree_path/docs/tasks/$task_id" \
    || fail "could not transfer untracked Task: $task_id"
fi
if test "$mode" = worktree; then
  ensure_design_started "$worktree_path" "$task_id"
fi
task_dir=$(cd "$worktree_path/docs/tasks/$task_id" && pwd -P)
workspace_status=$(git -C "$worktree_path" status --porcelain=v1 --untracked-files=all)
workspace_status_count=$(printf '%s\n' "$workspace_status" | awk 'NF { count += 1 } END { print count + 0 }')
workspace_dirty=0
test "$workspace_status_count" -eq 0 || workspace_dirty=1
printf 'MODE=worktree\nWORKTREE_PATH=%s\nBRANCH=%s\nCHANGE_TYPE=%s\nBASE_COMMIT=%s\nTASK_ID=%s\nTASK_DIR=%s\nWORKSPACE_DIRTY=%s\nWORKSPACE_STATUS_COUNT=%s\n' \
  "$worktree_path" "$branch" "$change_type" "$base_commit" "$task_id" "$task_dir" "$workspace_dirty" "$workspace_status_count"
