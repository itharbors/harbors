#!/usr/bin/env bash
set -euo pipefail

TEST_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
SKILL_DIR=$(cd "$TEST_DIR/.." && pwd -P)
SOURCE_START="$SKILL_DIR/scripts/start-feature.sh"
SOURCE_FINISH="$SKILL_DIR/scripts/finish-feature.sh"
ORIGINAL_PATH=$PATH
PASS_COUNT=0
FAIL_COUNT=0

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  return 1
}

assert_contains() {
  case "$1" in
    *"$2"*) ;;
    *) fail "expected [$1] to contain [$2]" ;;
  esac
}

assert_eq() {
  test "$1" = "$2" || fail "expected [$2], got [$1]"
}

assert_ref_missing() {
  if git -C "$1" show-ref --verify --quiet "$2"; then
    fail "expected ref to be missing: $2"
  fi
}

new_fixture() {
  FIXTURE_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/feature-workflow.XXXXXX")
  FIXTURE_ROOT=$(cd "$FIXTURE_ROOT" && pwd -P)
  ORIGIN="$FIXTURE_ROOT/origin.git"
  REPO="$FIXTURE_ROOT/repo"

  git init --bare "$ORIGIN" >/dev/null
  git clone "$ORIGIN" "$REPO" >/dev/null 2>&1
  REPO=$(cd "$REPO" && pwd -P)
  git -C "$REPO" config user.name 'Feature Workflow Test'
  git -C "$REPO" config user.email 'feature-workflow@example.com'
  git -C "$REPO" checkout -b main >/dev/null 2>&1

  mkdir -p "$REPO/.agents/skills/feature-workflow/scripts"
  cp "$SOURCE_START" "$REPO/.agents/skills/feature-workflow/scripts/start-feature.sh"
  if test -f "$SOURCE_FINISH"; then
    cp "$SOURCE_FINISH" "$REPO/.agents/skills/feature-workflow/scripts/finish-feature.sh"
  fi
  printf '.worktrees/\n' > "$REPO/.gitignore"
  printf '{"scripts":{"check":"true"}}\n' > "$REPO/package.json"

  git -C "$REPO" add .
  git -C "$REPO" commit -m initial >/dev/null
  git -C "$REPO" push -u origin main >/dev/null 2>&1
  git -C "$ORIGIN" symbolic-ref HEAD refs/heads/main

  START="$REPO/.agents/skills/feature-workflow/scripts/start-feature.sh"
}

run_case() {
  local name=$1
  shift
  local status
  set +e
  (set -e; "$@")
  status=$?
  set -e
  if test "$status" -eq 0; then
    PASS_COUNT=$((PASS_COUNT + 1))
    printf 'PASS: %s\n' "$name"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    printf 'FAIL: %s\n' "$name" >&2
  fi
}

test_start_success() {
  new_fixture
  output=$("$START" sample-feature)
  assert_contains "$output" "WORKTREE_PATH=$REPO/.worktrees/sample-feature"
  assert_contains "$output" 'BRANCH=codex/sample-feature'
  assert_contains "$output" "BASE_COMMIT=$(git -C "$REPO" rev-parse origin/main)"
  assert_eq "$(git -C "$REPO/.worktrees/sample-feature" branch --show-current)" 'codex/sample-feature'
  assert_eq "$(git -C "$REPO/.worktrees/sample-feature" rev-parse HEAD)" "$(git -C "$REPO" rev-parse origin/main)"
}

test_start_rejects_invalid_slug() {
  new_fixture
  if output=$("$START" '../bad' 2>&1); then
    fail 'invalid slug succeeded'
  fi
  assert_contains "$output" 'invalid slug'
  assert_ref_missing "$REPO" refs/heads/codex/bad
}

test_start_rejects_dirty_tree() {
  new_fixture
  printf 'dirty\n' > "$REPO/untracked.txt"
  if output=$("$START" dirty-tree 2>&1); then
    fail 'dirty tree succeeded'
  fi
  assert_contains "$output" 'working tree is not clean'
  assert_ref_missing "$REPO" refs/heads/codex/dirty-tree
}

test_start_rejects_ahead_main() {
  new_fixture
  printf 'ahead\n' > "$REPO/ahead.txt"
  git -C "$REPO" add ahead.txt
  git -C "$REPO" commit -m ahead >/dev/null
  if output=$("$START" ahead-main 2>&1); then
    fail 'ahead main succeeded'
  fi
  assert_contains "$output" 'main does not match origin/main'
  assert_ref_missing "$REPO" refs/heads/codex/ahead-main
}

test_start_rejects_behind_main() {
  new_fixture
  other="$FIXTURE_ROOT/other"
  git clone "$ORIGIN" "$other" >/dev/null 2>&1
  git -C "$other" config user.name test
  git -C "$other" config user.email test@example.com
  printf 'remote\n' > "$other/remote.txt"
  git -C "$other" add remote.txt
  git -C "$other" commit -m remote >/dev/null
  git -C "$other" push origin main >/dev/null 2>&1
  if output=$("$START" behind-main 2>&1); then
    fail 'behind main succeeded'
  fi
  assert_contains "$output" 'main does not match origin/main'
  assert_ref_missing "$REPO" refs/heads/codex/behind-main
}

test_start_rejects_diverged_main() {
  new_fixture
  printf 'local\n' > "$REPO/local.txt"
  git -C "$REPO" add local.txt
  git -C "$REPO" commit -m local >/dev/null

  other="$FIXTURE_ROOT/other"
  git clone "$ORIGIN" "$other" >/dev/null 2>&1
  git -C "$other" config user.name test
  git -C "$other" config user.email test@example.com
  printf 'remote\n' > "$other/remote.txt"
  git -C "$other" add remote.txt
  git -C "$other" commit -m remote >/dev/null
  git -C "$other" push origin main >/dev/null 2>&1

  if output=$("$START" diverged-main 2>&1); then
    fail 'diverged main succeeded'
  fi
  assert_contains "$output" 'main does not match origin/main'
  assert_ref_missing "$REPO" refs/heads/codex/diverged-main
}

test_start_rejects_existing_branch() {
  new_fixture
  git -C "$REPO" branch codex/existing origin/main >/dev/null
  if output=$("$START" existing 2>&1); then
    fail 'existing branch succeeded'
  fi
  assert_contains "$output" 'branch already exists'
}

test_start_rejects_path_conflict() {
  new_fixture
  mkdir -p "$REPO/.worktrees/path-conflict"
  if output=$("$START" path-conflict 2>&1); then
    fail 'path conflict succeeded'
  fi
  assert_contains "$output" 'worktree path already exists'
  assert_ref_missing "$REPO" refs/heads/codex/path-conflict
}

test_start_rejects_registered_missing_worktree() {
  new_fixture
  registered="$REPO/.worktrees/registered"
  moved="$FIXTURE_ROOT/moved-worktree"
  git -C "$REPO" worktree add --detach "$registered" origin/main >/dev/null 2>&1
  mv "$registered" "$moved"
  if output=$("$START" registered 2>&1); then
    fail 'registered missing worktree succeeded'
  fi
  assert_contains "$output" 'worktree already registered'
  assert_ref_missing "$REPO" refs/heads/codex/registered
}

test_start_rejects_linked_worktree_context() {
  new_fixture
  linked="$REPO/.worktrees/existing-linked"
  git -C "$REPO" worktree add -b codex/existing-linked "$linked" origin/main >/dev/null 2>&1
  linked_start="$linked/.agents/skills/feature-workflow/scripts/start-feature.sh"
  if output=$("$linked_start" nested 2>&1); then
    fail 'linked worktree start succeeded'
  fi
  assert_contains "$output" 'primary worktree'
  assert_ref_missing "$REPO" refs/heads/codex/nested
}

install_mocks() {
  MOCK_BIN="$FIXTURE_ROOT/mock-bin"
  GH_LOG="$FIXTURE_ROOT/gh.log"
  NPM_LOG="$FIXTURE_ROOT/npm.log"
  mkdir -p "$MOCK_BIN"
  : > "$GH_LOG"
  : > "$NPM_LOG"
  export GH_LOG NPM_LOG

  cat > "$MOCK_BIN/npm" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$NPM_LOG"
test "${NPM_FAIL:-0}" != 1
MOCK

  cat > "$MOCK_BIN/gh" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GH_LOG"
case "$1 $2" in
  'auth status')
    test "${GH_AUTH_FAIL:-0}" != 1
    ;;
  'pr create')
    printf '%s\n' 'https://github.com/example/repo/pull/1'
    ;;
  'pr view')
    printf '%s\t%s\t%s\t%s\n' \
      "${GH_VIEW_BASE:-main}" \
      "${GH_VIEW_HEAD:-$(git branch --show-current)}" \
      "${GH_VIEW_STATE:-OPEN}" \
      "${GH_VIEW_URL:-https://github.com/example/repo/pull/1}"
    ;;
  *)
    exit 2
    ;;
esac
MOCK

  chmod +x "$MOCK_BIN/npm" "$MOCK_BIN/gh"
  export PATH="$MOCK_BIN:$ORIGINAL_PATH"
}

write_pr_body() {
  BODY="$FIXTURE_ROOT/pr-body.md"
  printf '## Summary\n\nFeature.\n\n## Testing\n\n- npm run check\n' > "$BODY"
}

prepare_feature() {
  new_fixture
  "$START" finish-case >/dev/null
  WORKTREE="$REPO/.worktrees/finish-case"
  FINISH="$WORKTREE/.agents/skills/feature-workflow/scripts/finish-feature.sh"
  printf 'feature\n' > "$WORKTREE/feature.txt"
  git -C "$WORKTREE" add feature.txt
  git -C "$WORKTREE" commit -m feature >/dev/null
  write_pr_body
  install_mocks
}

test_finish_rejects_primary_worktree() {
  new_fixture
  write_pr_body
  FINISH="$REPO/.agents/skills/feature-workflow/scripts/finish-feature.sh"
  if output=$("$FINISH" 'Feature title' "$BODY" 2>&1); then
    fail 'primary worktree succeeded'
  fi
  assert_contains "$output" 'linked worktree'
}

test_finish_rejects_dirty_tree() {
  prepare_feature
  printf 'dirty\n' > "$WORKTREE/dirty.txt"
  if output=$("$FINISH" 'Feature title' "$BODY" 2>&1); then
    fail 'dirty finish succeeded'
  fi
  assert_contains "$output" 'working tree is not clean'
  test ! -s "$GH_LOG" || fail 'gh was called for a dirty tree'
  assert_ref_missing "$ORIGIN" refs/heads/codex/finish-case
}

test_finish_rejects_no_commits() {
  new_fixture
  "$START" no-commits >/dev/null
  WORKTREE="$REPO/.worktrees/no-commits"
  FINISH="$WORKTREE/.agents/skills/feature-workflow/scripts/finish-feature.sh"
  write_pr_body
  install_mocks
  if output=$("$FINISH" 'Feature title' "$BODY" 2>&1); then
    fail 'empty feature succeeded'
  fi
  assert_contains "$output" 'no commits over origin/main'
  test ! -s "$GH_LOG" || fail 'gh was called without feature commits'
  assert_ref_missing "$ORIGIN" refs/heads/codex/no-commits
}

test_finish_rejects_detached_head() {
  prepare_feature
  git -C "$WORKTREE" checkout --detach >/dev/null 2>&1
  if output=$("$FINISH" 'Feature title' "$BODY" 2>&1); then
    fail 'detached HEAD succeeded'
  fi
  assert_contains "$output" 'detached HEAD'
  test ! -s "$GH_LOG" || fail 'gh was called from detached HEAD'
  assert_ref_missing "$ORIGIN" refs/heads/codex/finish-case
}

test_finish_rejects_wrong_branch() {
  prepare_feature
  git -C "$WORKTREE" branch -m feature/wrong-branch
  if output=$("$FINISH" 'Feature title' "$BODY" 2>&1); then
    fail 'wrong branch succeeded'
  fi
  assert_contains "$output" 'unexpected feature branch'
  test ! -s "$GH_LOG" || fail 'gh was called from a wrong branch'
  assert_ref_missing "$ORIGIN" refs/heads/feature/wrong-branch
}

test_finish_rejects_invalid_body() {
  prepare_feature
  printf 'No required sections.\n' > "$BODY"
  if output=$("$FINISH" 'Feature title' "$BODY" 2>&1); then
    fail 'invalid body succeeded'
  fi
  assert_contains "$output" '## Summary'
  test ! -s "$NPM_LOG" || fail 'npm ran with an invalid PR body'
  test ! -s "$GH_LOG" || fail 'gh ran with an invalid PR body'
  assert_ref_missing "$ORIGIN" refs/heads/codex/finish-case
}

test_finish_stops_on_check_failure() {
  prepare_feature
  export NPM_FAIL=1
  if output=$("$FINISH" 'Feature title' "$BODY" 2>&1); then
    unset NPM_FAIL
    fail 'failed check succeeded'
  fi
  unset NPM_FAIL
  assert_contains "$(cat "$NPM_LOG")" 'run check'
  test ! -s "$GH_LOG" || fail 'gh was called after a failed check'
  assert_ref_missing "$ORIGIN" refs/heads/codex/finish-case
}

test_finish_stops_on_auth_failure() {
  prepare_feature
  export GH_AUTH_FAIL=1
  if output=$("$FINISH" 'Feature title' "$BODY" 2>&1); then
    unset GH_AUTH_FAIL
    fail 'failed auth succeeded'
  fi
  unset GH_AUTH_FAIL
  assert_contains "$output" 'not authenticated'
  assert_contains "$(cat "$GH_LOG")" 'auth status'
  if grep -Fq 'pr create' "$GH_LOG"; then
    fail 'PR creation ran after failed auth'
  fi
  assert_ref_missing "$ORIGIN" refs/heads/codex/finish-case
}

test_finish_stops_when_gh_is_missing() {
  prepare_feature
  no_gh_bin="$FIXTURE_ROOT/no-gh-bin"
  mkdir -p "$no_gh_bin"
  for command_name in bash dirname git grep npm; do
    command_path=$(command -v "$command_name")
    ln -s "$command_path" "$no_gh_bin/$command_name"
  done
  if output=$(PATH="$no_gh_bin" "$FINISH" 'Feature title' "$BODY" 2>&1); then
    fail 'missing gh succeeded'
  fi
  assert_contains "$output" 'gh is not installed'
  assert_ref_missing "$ORIGIN" refs/heads/codex/finish-case
}

test_finish_detects_pr_verification_mismatch() {
  prepare_feature
  export GH_VIEW_BASE=develop
  if output=$("$FINISH" 'Feature title' "$BODY" 2>&1); then
    unset GH_VIEW_BASE
    fail 'mismatched PR verification succeeded'
  fi
  unset GH_VIEW_BASE
  assert_contains "$output" 'unexpected base'
  case "$output" in
    *'PR_URL='*) fail 'reported PR URL after verification mismatch' ;;
  esac
}

test_finish_success() {
  prepare_feature
  output=$("$FINISH" 'Feature title' "$BODY")
  assert_contains "$output" 'PR_URL=https://github.com/example/repo/pull/1'
  assert_contains "$(cat "$NPM_LOG")" 'run check'
  assert_contains "$(cat "$GH_LOG")" 'auth status'
  assert_contains "$(cat "$GH_LOG")" 'pr create --base main --head codex/finish-case --title Feature title'
  assert_contains "$(cat "$GH_LOG")" 'pr view https://github.com/example/repo/pull/1'
  assert_eq "$(git -C "$WORKTREE" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}')" 'origin/codex/finish-case'
}

test_skill_layout_and_contract() {
  skill_file="$SKILL_DIR/SKILL.md"
  metadata_file="$SKILL_DIR/agents/openai.yaml"
  repo_root=$(git -C "$SKILL_DIR" rev-parse --show-toplevel)

  test -f "$skill_file" || fail 'SKILL.md is missing'
  test -f "$metadata_file" || fail 'agents/openai.yaml is missing'
  assert_contains "$(sed -n '1,8p' "$skill_file")" 'name: feature-workflow'
  assert_contains "$(sed -n '1,8p' "$skill_file")" 'description: Use when'
  if grep -Eq 'TODO|TBD|\[TODO' "$skill_file"; then
    fail 'SKILL.md contains placeholders'
  fi
  assert_contains "$(cat "$skill_file")" 'scripts/start-feature.sh'
  assert_contains "$(cat "$skill_file")" 'scripts/finish-feature.sh'
  assert_contains "$(cat "$skill_file")" 'WORKTREE_PATH='
  assert_contains "$(cat "$skill_file")" 'PR_URL='
  assert_contains "$(cat "$skill_file")" 'npm run check'
  assert_contains "$(cat "$skill_file")" '[Feature]'
  assert_contains "$(cat "$skill_file")" '[Bug]'
  assert_contains "$(cat "$skill_file")" '[Optimize]'
  assert_contains "$(cat "$skill_file")" 'docs/guides/development-workflow.md'
  assert_contains "$(cat "$metadata_file")" 'display_name: "Feature Workflow"'
  assert_contains "$(cat "$metadata_file")" 'Use $feature-workflow'
  test -x "$SKILL_DIR/scripts/start-feature.sh" || fail 'start script is not executable'
  test -x "$SKILL_DIR/scripts/finish-feature.sh" || fail 'finish script is not executable'
  test "$(wc -w < "$skill_file" | tr -d ' ')" -lt 500 || fail 'SKILL.md exceeds 500 words'
  grep -Fq '"test:feature-workflow"' "$repo_root/package.json" || fail 'package test script is missing'
  git -C "$repo_root" check-ignore -q .worktrees/probe || fail '.worktrees is not ignored'
}

run_case 'start success' test_start_success
run_case 'start rejects invalid slug' test_start_rejects_invalid_slug
run_case 'start rejects dirty tree' test_start_rejects_dirty_tree
run_case 'start rejects ahead main' test_start_rejects_ahead_main
run_case 'start rejects behind main' test_start_rejects_behind_main
run_case 'start rejects diverged main' test_start_rejects_diverged_main
run_case 'start rejects existing branch' test_start_rejects_existing_branch
run_case 'start rejects path conflict' test_start_rejects_path_conflict
run_case 'start rejects registered missing worktree' test_start_rejects_registered_missing_worktree
run_case 'start rejects linked worktree context' test_start_rejects_linked_worktree_context
run_case 'finish rejects primary worktree' test_finish_rejects_primary_worktree
run_case 'finish rejects dirty tree' test_finish_rejects_dirty_tree
run_case 'finish rejects no commits' test_finish_rejects_no_commits
run_case 'finish rejects detached HEAD' test_finish_rejects_detached_head
run_case 'finish rejects wrong branch' test_finish_rejects_wrong_branch
run_case 'finish rejects invalid body' test_finish_rejects_invalid_body
run_case 'finish stops on check failure' test_finish_stops_on_check_failure
run_case 'finish stops on auth failure' test_finish_stops_on_auth_failure
run_case 'finish stops when gh is missing' test_finish_stops_when_gh_is_missing
run_case 'finish detects PR verification mismatch' test_finish_detects_pr_verification_mismatch
run_case 'finish success' test_finish_success
run_case 'skill layout and contract' test_skill_layout_and_contract

printf '%s passed, %s failed\n' "$PASS_COUNT" "$FAIL_COUNT"
test "$FAIL_COUNT" -eq 0
