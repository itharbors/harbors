#!/usr/bin/env bash
set -euo pipefail

fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

test "$#" -eq 2 || fail 'usage: finish-change.sh <summary> <pr-body-file>'
summary=$1
body_file=$2
test -n "$summary" || fail 'invalid PR summary: must not be empty'
[[ "$summary" != *$'\n'* && "$summary" != *$'\r'* ]] || fail 'invalid PR summary: must be one line'
[[ ! "$summary" =~ ^\[ ]] || fail 'invalid PR summary: omit the bracketed label'
[[ ! "$summary" =~ [。.]$ ]] || fail 'invalid PR summary: omit the trailing period'
test -f "$body_file" || fail "PR body file does not exist: $body_file"
grep -Eq '^## Summary$' "$body_file" || fail 'PR body must contain ## Summary'
grep -Eq '^## Testing$' "$body_file" || fail 'PR body must contain ## Testing'

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
repo_root=$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null) || fail 'skill is not inside a Git repository'
git_dir=$(git -C "$repo_root" rev-parse --absolute-git-dir)
git_common=$(git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir)
test "$git_dir" != "$git_common" || fail 'finish must run from a linked worktree'
branch=$(git -C "$repo_root" branch --show-current)
test -n "$branch" || fail 'detached HEAD cannot be finished'
[[ "$branch" =~ ^(feature|bug|docs|refactor|optimize|test|chore)/[a-z0-9]+(-[a-z0-9]+)*$ ]] || fail "unexpected change branch: $branch"
change_type=${BASH_REMATCH[1]}
case "$change_type" in
  feature) label=Feature ;; bug) label=Bug ;; docs) label=Docs ;;
  refactor) label=Refactor ;; optimize) label=Optimize ;; test) label=Test ;; chore) label=Chore ;;
esac

test -z "$(git -C "$repo_root" status --porcelain=v1 --untracked-files=all)" || fail 'working tree is not clean'
git -C "$repo_root" remote get-url origin >/dev/null 2>&1 || fail 'origin remote is missing'
git -C "$repo_root" fetch origin --prune
git -C "$repo_root" show-ref --verify --quiet refs/remotes/origin/main || fail 'origin/main is missing'
test "$(git -C "$repo_root" rev-list --count origin/main..HEAD)" -gt 0 || fail 'change branch has no commits over origin/main'
while IFS= read -r subject; do
  case "$subject" in "[$label] "*) ;; *) fail "commits must start with [$label]: $subject" ;; esac
done < <(git -C "$repo_root" log --format=%s origin/main..HEAD)

(cd "$repo_root" && npm run check)
command -v gh >/dev/null 2>&1 || fail 'gh is not installed; install GitHub CLI before finishing'
gh auth status >/dev/null 2>&1 || fail 'gh is not authenticated; run gh auth login'
pr_title="[$label] $summary"
git -C "$repo_root" push --set-upstream origin "$branch"
pr_url=$(cd "$repo_root" && gh pr create --base main --head "$branch" --title "$pr_title" --body-file "$body_file")
test -n "$pr_url" || fail 'gh pr create returned no PR URL'
verification=$(cd "$repo_root" && gh pr view "$pr_url" --json baseRefName,headRefName,state,url --jq '[.baseRefName,.headRefName,.state,.url] | @tsv')
IFS=$'\t' read -r actual_base actual_head actual_state actual_url <<< "$verification"
test "$actual_base" = main || fail "created PR has unexpected base: $actual_base"
test "$actual_head" = "$branch" || fail "created PR has unexpected head: $actual_head"
test "$actual_state" = OPEN || fail "created PR is not open: $actual_state"
test "$actual_url" = "$pr_url" || fail 'created PR URL verification failed'
printf 'PR_URL=%s\n' "$pr_url"
