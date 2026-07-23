#!/usr/bin/env bash

test_finish_targets_main_for_all_types() {
  for type in feature bug docs refactor optimize test chore; do
    prepare_change "$type"
    output=$("$FINISH" sqlite '完成 Kit 变更' "$BODY")
    label=$(label_for_type "$type")
    assert_contains "$output" 'PR_URL=https://github.com/example/repo/pull/1'
    assert_contains "$(cat "$GH_LOG")" "pr create --base main --head kit-change/sqlite/$type/finish-case --title [$label] 完成 Kit 变更"
    npm_log=$(cat "$NPM_LOG")
    assert_contains "$npm_log" 'run kit:check -- sqlite --output-directory'
    assert_not_contains "$npm_log" 'run check'
    assert_not_contains "$npm_log" 'run kit:validate'
    assert_not_contains "$npm_log" 'run kit:pack'
  done
}

test_finish_rejects_wrong_kit_label_state_and_identity() {
  prepare_change feature
  if output=$("$FINISH" mysql '完成变更' "$BODY" 2>&1); then fail 'wrong Kit succeeded'; fi
  assert_contains "$output" 'Kit argument does not match branch'

  prepare_change feature
  git -C "$WORKTREE" commit --amend -m '[Bug] 使用错误标签' >/dev/null
  if output=$("$FINISH" sqlite '完成变更' "$BODY" 2>&1); then fail 'wrong label succeeded'; fi
  assert_contains "$output" 'commits must start with [Feature]'

  prepare_change docs
  printf 'dirty\n' > "$WORKTREE/dirty.txt"
  if output=$("$FINISH" sqlite '更新文档' "$BODY" 2>&1); then fail 'dirty state succeeded'; fi
  assert_contains "$output" 'working tree is not clean'

  prepare_change chore
  git -C "$WORKTREE" config --local user.email 'wrong@example.com'
  if output=$("$FINISH" sqlite '维护 Kit' "$BODY" 2>&1); then fail 'wrong identity succeeded'; fi
  assert_contains "$output" 'Git user.email must be devhacker520@hotmail.com'
}

test_finish_stops_before_push_when_targeted_check_fails() {
  prepare_change optimize
  export NPM_FAIL=1
  if "$FINISH" sqlite '优化性能' "$BODY" >/dev/null 2>&1; then unset NPM_FAIL; fail 'failed check succeeded'; fi
  unset NPM_FAIL
  test ! -s "$GH_LOG" || fail 'gh ran after failed check'
  assert_contains "$(cat "$NPM_LOG")" 'run kit:check -- sqlite --output-directory'
}

test_finish_rejects_unrelated_history() {
  prepare_change feature
  git -C "$WORKTREE" switch --orphan unrelated >/dev/null 2>&1
  git -C "$WORKTREE" rm -rf . >/dev/null 2>&1 || true
  write_repository_files "$WORKTREE"
  git -C "$WORKTREE" add .
  git -C "$WORKTREE" commit -m '[Feature] 制造无关历史' >/dev/null
  git -C "$WORKTREE" branch -M kit-change/sqlite/feature/finish-case
  if output=$("$FINISH" sqlite '完成变更' "$BODY" 2>&1); then fail 'unrelated history succeeded'; fi
  assert_contains "$output" 'is not based on origin/main'
  test ! -s "$GH_LOG" || fail 'gh ran for unrelated history'
}

run_finish_tests() {
  run_case 'finish targets main for all types' test_finish_targets_main_for_all_types
  run_case 'finish rejects wrong Kit, label, state, and identity' test_finish_rejects_wrong_kit_label_state_and_identity
  run_case 'finish stops before push when targeted check fails' test_finish_stops_before_push_when_targeted_check_fails
  run_case 'finish rejects unrelated history' test_finish_rejects_unrelated_history
}
