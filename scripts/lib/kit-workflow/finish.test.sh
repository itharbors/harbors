#!/usr/bin/env bash

test_finish_targets_matching_product_for_all_types() {
  for type in feature bug docs refactor optimize test chore; do
    prepare_change "$type"
    output=$("$FINISH" sqlite '完成 Kit 变更' "$BODY")
    label=$(label_for_type "$type")
    assert_contains "$output" 'PR_URL=https://github.com/example/repo/pull/1'
    assert_contains "$(cat "$GH_LOG")" "pr create --base kit/sqlite --head kit-change/sqlite/$type/finish-case --title [$label] 完成 Kit 变更"
    assert_contains "$(cat "$NPM_LOG")" 'run check'
    assert_contains "$(cat "$NPM_LOG")" 'run kit:validate'
    assert_contains "$(cat "$NPM_LOG")" 'run kit:pack'
  done
}

test_finish_rejects_wrong_kit_label_and_state() {
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
}

test_finish_stops_before_push_when_checks_fail() {
  prepare_change optimize
  export NPM_FAIL=1
  if "$FINISH" sqlite '优化性能' "$BODY" >/dev/null 2>&1; then unset NPM_FAIL; fail 'failed check succeeded'; fi
  unset NPM_FAIL
  test ! -s "$GH_LOG" || fail 'gh ran after failed check'
}

test_finish_rejects_unrelated_history() {
  prepare_change feature
  git -C "$WORKTREE" switch --orphan unrelated >/dev/null 2>&1
  git -C "$WORKTREE" rm -rf . >/dev/null 2>&1 || true
  write_product_files "$WORKTREE"
  git -C "$WORKTREE" add .
  git -C "$WORKTREE" commit -m '[Feature] 制造无关历史' >/dev/null
  git -C "$WORKTREE" branch -M kit-change/sqlite/feature/finish-case
  if output=$("$FINISH" sqlite '完成变更' "$BODY" 2>&1); then fail 'unrelated history succeeded'; fi
  assert_contains "$output" 'is not based on origin/kit/sqlite'
  test ! -s "$GH_LOG" || fail 'gh ran for unrelated history'
}

run_finish_tests() {
  run_case 'finish targets matching product for all types' test_finish_targets_matching_product_for_all_types
  run_case 'finish rejects wrong Kit, label, and state' test_finish_rejects_wrong_kit_label_and_state
  run_case 'finish stops before push when checks fail' test_finish_stops_before_push_when_checks_fail
  run_case 'finish rejects unrelated history' test_finish_rejects_unrelated_history
}
