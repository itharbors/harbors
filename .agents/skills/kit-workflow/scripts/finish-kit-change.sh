#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
. "$script_dir/_kit-workflow-lib.sh"

body_has_task_heading() {
  local file=$1 line marker info fence_character='' fence_length=0
  local opening_fence_regex='^ {0,3}(`{3,}|~{3,})'
  local closing_fence_regex='^ {0,3}(`+|~+)[[:space:]]*$'
  local task_heading_regex='^ {0,3}##[[:space:]]+Task([[:space:]]+#+)?[[:space:]]*$'

  while IFS= read -r line || test -n "$line"; do
    if test -n "$fence_character"; then
      if [[ "$line" =~ $closing_fence_regex ]]; then
        marker=${BASH_REMATCH[1]}
        if test "${marker:0:1}" = "$fence_character" && test "${#marker}" -ge "$fence_length"; then
          fence_character=''
          fence_length=0
        fi
      fi
      continue
    fi
    if [[ "$line" =~ $opening_fence_regex ]]; then
      marker=${BASH_REMATCH[1]}
      info=${line:${#BASH_REMATCH[0]}}
      if test "${marker:0:1}" = '~' || [[ "$info" != *'`'* ]]; then
        fence_character=${marker:0:1}
        fence_length=${#marker}
        continue
      fi
    fi
    [[ "$line" =~ $task_heading_regex ]] && return 0
  done < "$file"
  return 1
}

parse_pr_verification() {
  local verification=$1 separator=$'\034' parsed extra
  [[ "$verification" != *$'\n'* && "$verification" != *$'\r'* ]] || return 1
  parsed=${verification//$'\t'/$separator}
  IFS=$separator read -r actual_number actual_base actual_head actual_state actual_url actual_head_oid actual_cross_repository actual_head_owner actual_merged_at extra \
    <<< "${parsed}${separator}__END__"
  test "$extra" = '__END__'
}

validate_pr_shape() {
  [[ "$actual_number" =~ ^[1-9][0-9]*$ ]] || kit_workflow_fail "pull request has invalid number: $actual_number"
  test "$actual_base" = main || kit_workflow_fail "pull request has unexpected base: $actual_base"
  test "$actual_head" = "$branch" || kit_workflow_fail "pull request has unexpected head: $actual_head"
  test -n "$actual_url" || kit_workflow_fail 'pull request URL is empty'
  [[ "$actual_head_oid" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] || kit_workflow_fail 'pull request headRefOid is invalid'
  case "$actual_cross_repository" in true|false) ;; *) kit_workflow_fail 'pull request cross-repository flag is invalid' ;; esac
  test -n "$actual_head_owner" || kit_workflow_fail 'pull request head repository owner is empty'
}

validate_canonical_open_pr() {
  validate_pr_shape
  test "$actual_cross_repository" = false || kit_workflow_fail 'pull request head belongs to a fork'
  test "$actual_head_owner" = "$repo_owner" || kit_workflow_fail "pull request has unexpected head repository owner: $actual_head_owner"
  test "$actual_state" = OPEN || kit_workflow_fail "pull request is not open: $actual_state"
  test -z "$actual_merged_at" || kit_workflow_fail 'open pull request unexpectedly has mergedAt'
}

read_task_pr_number() {
  node -e 'const status = require(process.argv[1]); process.stdout.write(status.pullRequest === null ? "" : String(status.pullRequest.number));' "$1"
}

read_committed_task_pr_number() {
  git -C "$repo_root" show "HEAD:$1" \
    | node -e 'const { readFileSync } = require("node:fs"); const status = JSON.parse(readFileSync(0, "utf8")); process.stdout.write(status.pullRequest === null ? "" : String(status.pullRequest.number));'
}

is_staged_automatic_status_writeback() {
  node -e '
    const { execFileSync } = require("node:child_process");
    const { readFileSync } = require("node:fs");
    const [root, path, expected] = process.argv.slice(1);
    const before = JSON.parse(execFileSync("git", ["-C", root, "show", `HEAD:${path}`], { encoding: "utf8" }));
    const after = JSON.parse(readFileSync(`${root}/${path}`, "utf8"));
    if (before.pullRequest?.number === Number(expected) || after.pullRequest?.number !== Number(expected)) process.exit(1);
    before.updatedAt = after.updatedAt;
    before.pullRequest = after.pullRequest;
    if (JSON.stringify(before) !== JSON.stringify(after)) process.exit(1);
  ' "$repo_root" "$status_path" "$recorded_pr"
}

summary_head_for_pr() {
  local current_head=$1 expected_pr=$2 parent_head changed
  if test "$worktree_mode" != clean \
    || test "$(git -C "$repo_root" show -s --format=%s "$current_head")" != "[$label] 记录 Task PR 编号"; then
    printf '%s\n' "$current_head"
    return
  fi
  changed=$(git -C "$repo_root" diff-tree --no-commit-id --name-status -r "$current_head" --)
  if test "$changed" != $'M\t'"$status_path" \
    || ! parent_head=$(git -C "$repo_root" rev-parse "$current_head^"); then
    printf '%s\n' "$current_head"
    return
  fi
  if node -e '
    const { execFileSync } = require("node:child_process");
    const [root, beforeRef, afterRef, path, expected] = process.argv.slice(1);
    const read = (ref) => JSON.parse(execFileSync("git", ["-C", root, "show", `${ref}:${path}`], { encoding: "utf8" }));
    const before = read(beforeRef);
    const after = read(afterRef);
    if (before.pullRequest?.number === Number(expected) || after.pullRequest?.number !== Number(expected)) process.exit(1);
    before.updatedAt = after.updatedAt;
    before.pullRequest = after.pullRequest;
    if (JSON.stringify(before) !== JSON.stringify(after)) process.exit(1);
  ' "$repo_root" "$parent_head" "$current_head" "$status_path" "$expected_pr"; then
    printf '%s\n' "$parent_head"
  else
    printf '%s\n' "$current_head"
  fi
}

cleanup_temporary_files() {
  test -z "${generated_body_file:-}" || rm -f -- "$generated_body_file"
  test -z "${pack_dir:-}" || rm -rf -- "$pack_dir"
}

load_open_pr_candidates() {
  local pr_candidates candidate
  pr_candidates=$(cd "$repo_root" && gh pr list --state open --head "$branch" --json url --jq '.[].url')
  pr_urls=()
  while IFS= read -r candidate; do
    test -z "$candidate" && continue
    load_pr_verification "$candidate"
    validate_pr_shape
    test "$actual_url" = "$candidate" || kit_workflow_fail 'pull request URL verification failed'
    test "$actual_state" = OPEN && test -z "$actual_merged_at" || kit_workflow_fail 'listed pull request is not open'
    if test "$actual_cross_repository" = true; then continue; fi
    test "$actual_head_owner" = "$repo_owner" || kit_workflow_fail "pull request has unexpected head repository owner: $actual_head_owner"
    pr_urls+=("$actual_url")
  done <<< "$pr_candidates"
}

load_pr_verification() {
  local requested_url=$1 verification
  verification=$(cd "$repo_root" && gh pr view "$requested_url" --json number,baseRefName,headRefName,state,url,headRefOid,isCrossRepository,headRepositoryOwner,mergedAt --jq '[.number,.baseRefName,.headRefName,.state,.url,.headRefOid,.isCrossRepository,(.headRepositoryOwner.login // ""),(.mergedAt // "")] | @tsv')
  parse_pr_verification "$verification" || kit_workflow_fail 'could not parse pull request verification'
}

verify_open_pr() {
  local requested_url=$1
  load_pr_verification "$requested_url"
  validate_canonical_open_pr
  test "$actual_url" = "$requested_url" || kit_workflow_fail 'pull request URL verification failed'
}

verify_recorded_pr_is_closed_unmerged() {
  local expected=$1
  load_pr_verification "$expected"
  validate_pr_shape
  test "$actual_cross_repository" = false || kit_workflow_fail 'recorded Task PR belongs to a fork'
  test "$actual_head_owner" = "$repo_owner" || kit_workflow_fail "recorded Task PR has unexpected head repository owner: $actual_head_owner"
  test "$actual_number" = "$expected" || kit_workflow_fail 'recorded Task PR number verification failed'
  test "$actual_state" = CLOSED && test -z "$actual_merged_at" \
    || kit_workflow_fail 'recorded Task PR is not closed and unmerged'
}

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
if body_has_task_heading "$body_file"; then kit_workflow_fail 'PR body must not contain ## Task'; fi

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

git -C "$repo_root" remote get-url origin >/dev/null 2>&1 || kit_workflow_fail 'origin remote is missing'
target_branch=main
target_ref="refs/remotes/origin/$target_branch"
git -C "$repo_root" show-ref --verify --quiet "$target_ref" || kit_workflow_fail "origin/$target_branch is missing"

task_id=$(cd "$repo_root" && node scripts/task-status.mjs resolve "$branch" "$target_ref" --ready-for-pr)
[[ "$task_id" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9]+(-[a-z0-9]+)*$ ]] || kit_workflow_fail 'Task resolve returned an invalid Task ID'
status_path="docs/tasks/$task_id/status.json"
recorded_pr=$(read_task_pr_number "$repo_root/$status_path")
test -z "$recorded_pr" || [[ "$recorded_pr" =~ ^[1-9][0-9]*$ ]] || kit_workflow_fail 'Task status contains an invalid PR number'
worktree_status=$(git -C "$repo_root" status --porcelain=v1 --untracked-files=all)
if test -z "$worktree_status"; then
  worktree_mode=clean
elif test "$worktree_status" = "M  $status_path" \
  && test -n "$recorded_pr" \
  && test "$(git -C "$repo_root" diff --cached --name-status --)" = $'M\t'"$status_path" \
  && is_staged_automatic_status_writeback; then
  worktree_mode=staged-status-recovery
else
  kit_workflow_fail 'working tree is not clean'
fi
test "$(git -C "$repo_root" rev-list --count "$target_ref"..HEAD)" -gt 0 || kit_workflow_fail "change branch has no commits over origin/$target_branch"
while IFS= read -r subject; do
  case "$subject" in "[$label] "*) ;; *) kit_workflow_fail "commits must start with [$label]: $subject" ;; esac
done < <(git -C "$repo_root" log --format=%s "$target_ref"..HEAD)

current_head=$(git -C "$repo_root" rev-parse HEAD)
[[ "$current_head" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] || kit_workflow_fail 'could not resolve a valid pre-PR HEAD SHA'
generated_body_file=''
pack_dir=''
trap cleanup_temporary_files EXIT

# A failed automatic status commit is the only dirty recovery state. Verify its
# already-created PR before committing the exact staged status, so boundary can
# continue to require an index identical to HEAD.
if test "$worktree_mode" = staged-status-recovery; then
  kit_workflow_validate_identity "$repo_root"
  command -v gh >/dev/null 2>&1 || kit_workflow_fail 'gh is not installed; install GitHub CLI before finishing'
  gh auth status >/dev/null 2>&1 || kit_workflow_fail 'gh is not authenticated; run gh auth login'
  owner=$(cd "$repo_root" && gh repo view --json nameWithOwner --jq .nameWithOwner)
  [[ "$owner" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || kit_workflow_fail 'gh repo view returned an invalid nameWithOwner'
  repo_owner=${owner%%/*}
  previous_pr=$(read_committed_task_pr_number "$status_path")
  test -z "$previous_pr" || [[ "$previous_pr" =~ ^[1-9][0-9]*$ ]] \
    || kit_workflow_fail 'committed Task status contains an invalid PR number'
  if test -n "$previous_pr" && test "$previous_pr" != "$recorded_pr"; then
    verify_recorded_pr_is_closed_unmerged "$previous_pr"
  fi
  load_open_pr_candidates
  test "${#pr_urls[@]}" -eq 1 || kit_workflow_fail 'recorded Task PR has no unique open pull request'
  existing_pr=1
  pr_url=${pr_urls[0]}
  verify_open_pr "$pr_url"
  test "$recorded_pr" = "$actual_number" \
    || kit_workflow_fail "recorded Task PR number does not match the open pull request: $recorded_pr != $actual_number"
  expected_pr_number=$actual_number
  head_sha=$current_head
  git -C "$repo_root" commit -m "[$label] 记录 Task PR 编号" -- "$status_path"
fi

npm --prefix "$repo_root" run kit:boundary -- "$kit" --task "$task_id" --base "$target_ref" --head HEAD
git -C "$repo_root" fetch origin --prune
git -C "$repo_root" show-ref --verify --quiet "$target_ref" || kit_workflow_fail "origin/$target_branch is missing"
git -C "$repo_root" merge-base --is-ancestor "$target_ref" HEAD \
  || kit_workflow_fail "change branch is not based on origin/$target_branch"
kit_workflow_validate_product "$repo_root" "$kit"
test "$(git -C "$repo_root" rev-list --count "$target_ref"..HEAD)" -gt 0 || kit_workflow_fail "change branch has no commits over origin/$target_branch"
while IFS= read -r subject; do
  case "$subject" in "[$label] "*) ;; *) kit_workflow_fail "commits must start with [$label]: $subject" ;; esac
done < <(git -C "$repo_root" log --format=%s "$target_ref"..HEAD)
npm --prefix "$repo_root" run kit:boundary -- "$kit" --task "$task_id" --base "$target_ref" --head HEAD
(cd "$repo_root" && node scripts/plan-kit-releases.mjs \
  "$(git rev-parse "$target_ref")" \
  "$(git rev-parse HEAD)")

pack_dir=$(mktemp -d "${TMPDIR:-/tmp}/kit-workflow-pack.XXXXXX")
kit_workflow_run_product_checks "$repo_root" "$kit" "$pack_dir"

if test "$worktree_mode" = clean; then
  command -v gh >/dev/null 2>&1 || kit_workflow_fail 'gh is not installed; install GitHub CLI before finishing'
  gh auth status >/dev/null 2>&1 || kit_workflow_fail 'gh is not authenticated; run gh auth login'
  owner=$(cd "$repo_root" && gh repo view --json nameWithOwner --jq .nameWithOwner)
  [[ "$owner" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || kit_workflow_fail 'gh repo view returned an invalid nameWithOwner'
  repo_owner=${owner%%/*}
  load_open_pr_candidates
  case "${#pr_urls[@]}" in
    0)
      if test -n "$recorded_pr"; then verify_recorded_pr_is_closed_unmerged "$recorded_pr"; fi
      existing_pr=0
      head_sha=$current_head
      ;;
    1)
      existing_pr=1
      pr_url=${pr_urls[0]}
      verify_open_pr "$pr_url"
      if test -n "$recorded_pr" && test "$recorded_pr" != "$actual_number"; then
        verify_recorded_pr_is_closed_unmerged "$recorded_pr"
        verify_open_pr "$pr_url"
      fi
      expected_pr_number=$actual_number
      head_sha=$(summary_head_for_pr "$current_head" "$actual_number")
      ;;
    *) kit_workflow_fail "multiple open pull requests found for branch: $branch" ;;
  esac
fi

[[ "$head_sha" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] || kit_workflow_fail 'could not select a valid summary HEAD SHA'
summary_url="https://github.com/$owner/blob/$head_sha/docs/tasks/$task_id/summary.md"
generated_body_file=$(mktemp "${TMPDIR:-/tmp}/kit-workflow-pr-body.XXXXXX")
test -n "$generated_body_file" && [[ "$generated_body_file" != *$'\n'* && "$generated_body_file" != *$'\r'* ]] \
  && test -f "$generated_body_file" || kit_workflow_fail 'could not create PR body temporary file'
cp -- "$body_file" "$generated_body_file"
printf '\n## Task\n\n[Task summary](%s)\n' "$summary_url" >> "$generated_body_file"

git -C "$repo_root" push --set-upstream origin "$branch"
pr_title="[$label] $summary"
if test "$existing_pr" -eq 0; then
  pr_url=$(cd "$repo_root" && gh pr create --base "$target_branch" --head "$branch" --title "$pr_title" --body-file "$generated_body_file")
  test -n "$pr_url" && [[ "$pr_url" != *$'\n'* && "$pr_url" != *$'\r'* ]] || kit_workflow_fail 'gh pr create returned an invalid PR URL'
  verify_open_pr "$pr_url"
  expected_pr_number=$actual_number
else
  verify_open_pr "$pr_url"
  test "$actual_number" = "$expected_pr_number" || kit_workflow_fail 'pull request number changed before edit'
  (cd "$repo_root" && gh pr edit "$pr_url" --body-file "$generated_body_file" >/dev/null)
fi

if test "$recorded_pr" != "$actual_number"; then
  (cd "$repo_root" && node scripts/task-status.mjs set-pr "$task_id" "$actual_number" >/dev/null)
  recorded_pr=$actual_number
fi
git -C "$repo_root" add -- "$status_path"
if ! git -C "$repo_root" diff --cached --quiet -- "$status_path"; then
  git -C "$repo_root" commit -m "[$label] 记录 Task PR 编号" -- "$status_path"
  git -C "$repo_root" push origin "$branch"
fi

local_head=$(git -C "$repo_root" rev-parse HEAD)
head_verified=0
for attempt in 1 2 3; do
  verification=$(cd "$repo_root" && gh pr view "$pr_url" --json number,baseRefName,headRefName,state,url,headRefOid,isCrossRepository,headRepositoryOwner,mergedAt --jq '[.number,.baseRefName,.headRefName,.state,.url,.headRefOid,.isCrossRepository,(.headRepositoryOwner.login // ""),(.mergedAt // "")] | @tsv')
  if parse_pr_verification "$verification"; then
    if test "$actual_number" = "$expected_pr_number" && test "$actual_base" = "$target_branch" \
      && test "$actual_head" = "$branch" && test "$actual_state" = OPEN \
      && test -n "$actual_url" && test "$actual_url" = "$pr_url" && test "$actual_head_oid" = "$local_head" \
      && test "$actual_cross_repository" = false && test "$actual_head_owner" = "$repo_owner" \
      && test -z "$actual_merged_at"; then
      head_verified=1
      break
    fi
  fi
  test "$attempt" -eq 3 || sleep 1
done
test "$head_verified" -eq 1 || kit_workflow_fail 'pull request headRefOid did not match local HEAD after push'
printf 'PR_URL=%s\n' "$pr_url"
