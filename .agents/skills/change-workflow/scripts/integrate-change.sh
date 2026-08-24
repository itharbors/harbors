#!/usr/bin/env bash
set -euo pipefail

fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

test "$#" -ge 3 || fail 'usage: integrate-change.sh <source-worktree> ff --confirm | <source-worktree> <merge|squash> --confirm <commit-title>'
source_worktree=$(cd "$1" 2>/dev/null && pwd -P) || fail "source worktree does not exist: $1"
strategy=$2
confirmation=$3
test "$confirmation" = --confirm || fail 'integration requires explicit --confirm'
case "$strategy" in ff|merge|squash) ;; *) fail "invalid integration strategy: $strategy" ;; esac

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
repo_root=$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null) || fail 'skill is not inside a Git repository'
git_dir=$(git -C "$repo_root" rev-parse --absolute-git-dir)
git_common=$(git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir)
test "$git_dir" = "$git_common" || fail 'integration must run from the primary worktree'
test "$(git -C "$repo_root" branch --show-current)" = main || fail 'primary worktree must be on main'

# origin/main is useful reporting context only. Local integration is based on
# the checked-out main and must remain usable without a remote or a fresh fetch.
if git -C "$repo_root" show-ref --verify --quiet refs/remotes/origin/main; then
  main_ahead_origin=$(git -C "$repo_root" rev-list --count origin/main..main)
  main_behind_origin=$(git -C "$repo_root" rev-list --count main..origin/main)
else
  main_ahead_origin=unavailable
  main_behind_origin=unavailable
fi

test -z "$(git -C "$repo_root" status --porcelain=v1 --untracked-files=all)" \
  || fail 'primary main worktree is not clean'
main_head=$(git -C "$repo_root" rev-parse HEAD)
source_git_dir=$(git -C "$source_worktree" rev-parse --absolute-git-dir 2>/dev/null) \
  || fail 'source path is not a Git worktree'
test "$source_git_dir" != "$git_common" || fail 'source must be a linked worktree'
source_common=$(git -C "$source_worktree" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) \
  || fail 'could not resolve source Git common directory'
test "$source_common" = "$git_common" || fail 'source worktree belongs to a different repository'
test -z "$(git -C "$source_worktree" status --porcelain=v1 --untracked-files=all)" \
  || fail 'source worktree is not clean'
source_branch=$(git -C "$source_worktree" branch --show-current)
[[ "$source_branch" =~ ^(feature|bug|docs|refactor|optimize|test|chore)/[a-z0-9]+(-[a-z0-9]+)*$ ]] \
  || fail "unexpected source branch: $source_branch"
test "$source_worktree" != "$repo_root" || fail 'source worktree must differ from primary main'

task_id=$(cd "$source_worktree" && node scripts/task-status.mjs resolve "$source_branch" main --ready-for-pr) \
  || fail 'source Task is not ready for integration'
[[ "$task_id" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9]+(-[a-z0-9]+)*$ ]] \
  || fail 'Task resolve returned an invalid Task ID'

if test "$strategy" != ff; then
  test "$#" -eq 4 || fail "$strategy requires a commit title"
  commit_title=$4
  [[ "$commit_title" =~ ^\[(Feature|Bug|Docs|Refactor|Optimize|Test|Chore)\][[:space:]]+.+$ ]] \
    && [[ "$commit_title" != *$'\r'* && "$commit_title" != *$'\n'* ]] \
    || fail 'commit title must use a supported label and be one line'
  [[ "$commit_title" != *[.。] ]] || fail 'commit title must omit a trailing period'
  [[ "$commit_title" =~ [一-龥] ]] || fail 'commit title must contain Chinese characters'
else
  test "$#" -eq 3 || fail 'commit title is only valid for merge or squash'
fi

source_head=$(git -C "$source_worktree" rev-parse HEAD)
source_added_paths=()
while IFS= read -r -d '' added_path; do
  source_added_paths+=("$added_path")
done < <(git -C "$repo_root" diff --name-only --diff-filter=A -z "$main_head" "$source_head")
git -C "$repo_root" merge-tree --write-tree main "$source_branch" >/dev/null \
  || fail 'integration has conflicts; no conflict resolution was attempted'

rollback_squash() {
  git -C "$repo_root" merge --abort >/dev/null 2>&1 || true
  git -C "$repo_root" restore --source="$main_head" --staged --worktree -- . \
    || return 1
  for added_path in "${source_added_paths[@]}"; do
    git -C "$repo_root" clean -fd -- "$added_path" >/dev/null \
      || return 1
  done
  test "$(git -C "$repo_root" rev-parse HEAD)" = "$main_head" \
    && test -z "$(git -C "$repo_root" status --porcelain=v1 --untracked-files=all)"
}

case "$strategy" in
  ff)
    git -C "$repo_root" merge --ff-only "$source_branch" \
      || fail 'fast-forward integration failed; no conflict resolution was attempted'
    ;;
  merge)
    if ! git -C "$repo_root" merge --no-ff -m "$commit_title" "$source_branch"; then
      git -C "$repo_root" merge --abort >/dev/null 2>&1 || true
      fail 'merge integration conflicted; no conflict resolution was attempted'
    fi
    ;;
  squash)
    if ! git -C "$repo_root" merge --squash "$source_branch"; then
      rollback_squash || fail 'squash integration failed and could not restore clean main'
      fail 'squash integration conflicted; no conflict resolution was attempted'
    fi
    if ! git -C "$repo_root" commit -m "$commit_title"; then
      rollback_squash || fail 'squash commit failed and could not restore clean main'
      fail 'squash commit failed; main was restored to its clean pre-integration state'
    fi
    ;;
esac

test -z "$(git -C "$repo_root" status --porcelain=v1 --untracked-files=all)" \
  || fail 'main is not clean after integration'
(cd "$repo_root" && node scripts/task-status.mjs check "$task_id" >/dev/null) \
  || fail 'Task verification failed after integration'
test "$(git -C "$source_worktree" rev-parse HEAD)" = "$source_head" \
  || fail 'source worktree changed during integration'
if git -C "$repo_root" show-ref --verify --quiet refs/remotes/origin/main; then
  main_ahead_origin=$(git -C "$repo_root" rev-list --count origin/main..main)
  main_behind_origin=$(git -C "$repo_root" rev-list --count main..origin/main)
else
  main_ahead_origin=unavailable
  main_behind_origin=unavailable
fi
printf 'INTEGRATED=1\nSTRATEGY=%s\nTASK_ID=%s\nSOURCE_BRANCH=%s\nMAIN_AHEAD_ORIGIN=%s\nMAIN_BEHIND_ORIGIN=%s\n' \
  "$strategy" "$task_id" "$source_branch" "$main_ahead_origin" "$main_behind_origin"
