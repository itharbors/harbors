#!/usr/bin/env bash

test_start_supports_all_types() {
  for type in feature bug docs refactor optimize test chore; do
    new_fixture
    output=$("$START" "$type" sample-change)
    worktree="$REPO/.worktrees/$type-sample-change"
    base=$(git -C "$REPO" rev-parse origin/main)
    assert_contains "$output" "WORKTREE_PATH=$worktree"
    assert_contains "$output" "BRANCH=$type/sample-change"
    assert_contains "$output" "CHANGE_TYPE=$type"
    assert_contains "$output" "BASE_COMMIT=$base"
    assert_eq "$(git -C "$worktree" rev-parse HEAD)" "$base"
  done
}
test_start_rejects_invalid_names() {
  new_fixture
  if output=$("$START" build valid 2>&1); then fail 'invalid type succeeded'; fi
  assert_contains "$output" 'invalid change type: build'
  if output=$("$START" feature '../bad' 2>&1); then fail 'invalid slug succeeded'; fi
  assert_contains "$output" 'invalid slug: ../bad'
}

test_start_ignores_dirty_and_ahead_main() {
  new_fixture
  base=$(git -C "$REPO" rev-parse origin/main)
  printf 'local\n' > "$REPO/local.txt"
  git -C "$REPO" add local.txt
  git -C "$REPO" commit -m '[Feature] 添加本地提交' >/dev/null
  printf 'dirty\n' > "$REPO/dirty.txt"
  "$START" feature local-state >/dev/null
  assert_eq "$(git -C "$REPO/.worktrees/feature-local-state" rev-parse HEAD)" "$base"
}

advance_remote() {
  OTHER="$FIXTURE_ROOT/other"
  git clone "$ORIGIN" "$OTHER" >/dev/null 2>&1
  git -C "$OTHER" config user.name test
  git -C "$OTHER" config user.email test@example.com
  printf 'remote\n' > "$OTHER/remote.txt"
  git -C "$OTHER" add remote.txt
  git -C "$OTHER" commit -m '[Bug] 添加远端提交' >/dev/null
  git -C "$OTHER" push origin main >/dev/null 2>&1
}

test_start_fetches_remote_when_main_is_behind_or_diverged() {
  new_fixture
  printf 'local\n' > "$REPO/local.txt"
  git -C "$REPO" add local.txt
  git -C "$REPO" commit -m '[Feature] 添加本地提交' >/dev/null
  advance_remote
  expected=$(git -C "$OTHER" rev-parse HEAD)
  "$START" bug remote-state >/dev/null
  assert_eq "$(git -C "$REPO/.worktrees/bug-remote-state" rev-parse HEAD)" "$expected"
}

test_start_does_not_require_local_main() {
  new_fixture
  git -C "$REPO" checkout -b scratch >/dev/null 2>&1
  git -C "$REPO" branch -D main >/dev/null
  "$START" chore no-main >/dev/null
  assert_eq "$(git -C "$REPO/.worktrees/chore-no-main" rev-parse HEAD)" "$(git -C "$REPO" rev-parse origin/main)"
}

test_start_rejects_branch_conflicts() {
  new_fixture
  git -C "$REPO" branch feature/existing origin/main >/dev/null
  if output=$("$START" feature existing 2>&1); then fail 'local conflict succeeded'; fi
  assert_contains "$output" 'branch already exists: feature/existing'
  new_fixture
  git -C "$REPO" push origin origin/main:refs/heads/bug/existing >/dev/null 2>&1
  if output=$("$START" bug existing 2>&1); then fail 'remote conflict succeeded'; fi
  assert_contains "$output" 'remote branch already exists: bug/existing'
}

test_start_rejects_worktree_conflicts() {
  new_fixture
  mkdir -p "$REPO/.worktrees/docs-existing"
  if output=$("$START" docs existing 2>&1); then fail 'path conflict succeeded'; fi
  assert_contains "$output" 'worktree path already exists'
  new_fixture
  registered="$REPO/.worktrees/test-existing"
  git -C "$REPO" worktree add --detach "$registered" origin/main >/dev/null 2>&1
  mv "$registered" "$FIXTURE_ROOT/moved"
  if output=$("$START" test existing 2>&1); then fail 'registered conflict succeeded'; fi
  assert_contains "$output" 'worktree already registered'
}

test_start_rejects_linked_context() {
  new_fixture
  linked="$REPO/.worktrees/chore-linked"
  git -C "$REPO" worktree add -b chore/linked "$linked" origin/main >/dev/null 2>&1
  if output=$("$linked/.agents/skills/change-workflow/scripts/start-change.sh" feature nested 2>&1); then fail 'linked start succeeded'; fi
  assert_contains "$output" 'primary worktree'
}

run_start_tests() {
  run_case 'start supports all types' test_start_supports_all_types
  run_case 'start rejects invalid names' test_start_rejects_invalid_names
  run_case 'start ignores dirty and ahead main' test_start_ignores_dirty_and_ahead_main
  run_case 'start fetches behind or diverged main' test_start_fetches_remote_when_main_is_behind_or_diverged
  run_case 'start does not require local main' test_start_does_not_require_local_main
  run_case 'start rejects branch conflicts' test_start_rejects_branch_conflicts
  run_case 'start rejects worktree conflicts' test_start_rejects_worktree_conflicts
  run_case 'start rejects linked context' test_start_rejects_linked_context
}
