#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
. "$script_dir/_kit-workflow-lib.sh"

test "$#" -eq 3 || kit_workflow_fail 'usage: finish-kit-change.sh <kit> <summary> <pr-body-file>'
kit=$1
summary=$2
body_file=$3
kit_workflow_validate_kit_name "$kit"
test -n "$summary" || kit_workflow_fail 'invalid PR summary: must not be empty'
[[ "$summary" != *$'\n'* && "$summary" != *$'\r'* ]] || kit_workflow_fail 'invalid PR summary: must be one line'
[[ ! "$summary" =~ ^\[ ]] || kit_workflow_fail 'invalid PR summary: omit the bracketed label'
[[ ! "$summary" =~ [。.]$ ]] || kit_workflow_fail 'invalid PR summary: omit the trailing period'
test -f "$body_file" || kit_workflow_fail "PR body file does not exist: $body_file"
grep -Eq '^## Summary$' "$body_file" || kit_workflow_fail 'PR body must contain ## Summary'
grep -Eq '^## Testing$' "$body_file" || kit_workflow_fail 'PR body must contain ## Testing'

repo_root=$(kit_workflow_repo_root)
git_dir=$(git -C "$repo_root" rev-parse --absolute-git-dir)
git_common=$(git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir)
test "$git_dir" != "$git_common" || kit_workflow_fail 'finish must run from a linked worktree'
branch=$(git -C "$repo_root" branch --show-current)
test -n "$branch" || kit_workflow_fail 'detached HEAD cannot be finished'
[[ "$branch" =~ ^kit-change/([a-z0-9]+(-[a-z0-9]+)*)/(feature|bug|docs|refactor|optimize|test|chore)/[a-z0-9]+(-[a-z0-9]+)*$ ]] \
  || kit_workflow_fail "unexpected Kit change branch: $branch"
branch_kit=${BASH_REMATCH[1]}
change_type=${BASH_REMATCH[3]}
test "$branch_kit" = "$kit" || kit_workflow_fail "Kit argument does not match branch: expected $branch_kit, got $kit"
label=$(kit_workflow_label_for_type "$change_type")

test -z "$(git -C "$repo_root" status --porcelain=v1 --untracked-files=all)" || kit_workflow_fail 'working tree is not clean'
git -C "$repo_root" remote get-url origin >/dev/null 2>&1 || kit_workflow_fail 'origin remote is missing'
git -C "$repo_root" fetch origin --prune
target_branch=main
target_ref="refs/remotes/origin/$target_branch"
git -C "$repo_root" show-ref --verify --quiet "$target_ref" || kit_workflow_fail "origin/$target_branch is missing"
git -C "$repo_root" merge-base --is-ancestor "$target_ref" HEAD \
  || kit_workflow_fail "change branch is not based on origin/$target_branch"
kit_workflow_validate_product "$repo_root" "$kit"
test "$(git -C "$repo_root" rev-list --count "$target_ref"..HEAD)" -gt 0 || kit_workflow_fail "change branch has no commits over origin/$target_branch"
while IFS= read -r subject; do
  case "$subject" in "[$label] "*) ;; *) kit_workflow_fail "commits must start with [$label]: $subject" ;; esac
done < <(git -C "$repo_root" log --format=%s "$target_ref"..HEAD)

pack_dir=$(mktemp -d "${TMPDIR:-/tmp}/kit-workflow-pack.XXXXXX")
trap 'rm -rf -- "$pack_dir"' EXIT
kit_workflow_run_product_checks "$repo_root" "$kit" "$pack_dir"
command -v gh >/dev/null 2>&1 || kit_workflow_fail 'gh is not installed; install GitHub CLI before finishing'
gh auth status >/dev/null 2>&1 || kit_workflow_fail 'gh is not authenticated; run gh auth login'
git -C "$repo_root" push --set-upstream origin "$branch"
pr_title="[$label] $summary"
pr_url=$(cd "$repo_root" && gh pr create --base "$target_branch" --head "$branch" --title "$pr_title" --body-file "$body_file")
test -n "$pr_url" || kit_workflow_fail 'gh pr create returned no PR URL'
verification=$(cd "$repo_root" && gh pr view "$pr_url" --json baseRefName,headRefName,state,url --jq '[.baseRefName,.headRefName,.state,.url] | @tsv')
IFS=$'\t' read -r actual_base actual_head actual_state actual_url <<< "$verification"
test "$actual_base" = "$target_branch" || kit_workflow_fail "created PR has unexpected base: $actual_base"
test "$actual_head" = "$branch" || kit_workflow_fail "created PR has unexpected head: $actual_head"
test "$actual_state" = OPEN || kit_workflow_fail "created PR is not open: $actual_state"
test "$actual_url" = "$pr_url" || kit_workflow_fail 'created PR URL verification failed'
printf 'PR_URL=%s\n' "$pr_url"
