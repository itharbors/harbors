#!/usr/bin/env bash

test_finish_supports_all_types() {
  for type in feature bug docs refactor optimize test chore; do
    prepare_change "$type"
    output=$("$FINISH" '完成测试变更' "$BODY")
    label=$(label_for_type "$type")
    assert_contains "$output" 'PR_URL=https://github.com/example/repo/pull/1'
    assert_contains "$(cat "$GH_LOG")" "pr create --base main --head $type/finish-case --title [$label] 完成测试变更"
    assert_eq "$(git -C "$WORKTREE" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}')" "origin/$type/finish-case"
  done
}

test_finish_rejects_context_and_summary() {
  new_fixture
  BODY="$FIXTURE_ROOT/body.md"; printf '## Summary\n\nX\n\n## Testing\n\nX\n' > "$BODY"
  if output=$("$REPO/.agents/skills/change-workflow/scripts/finish-change.sh" '摘要' "$BODY" 2>&1); then fail 'primary succeeded'; fi
  assert_contains "$output" 'linked worktree'
  prepare_change bug
  for summary in '' '[Bug] 重复' $'包含\n换行' '句号。' 'period.'; do
    if output=$("$FINISH" "$summary" "$BODY" 2>&1); then fail 'invalid summary succeeded'; fi
    assert_contains "$output" 'invalid PR summary'
  done
}

test_finish_rejects_state_and_label() {
  prepare_change feature
  git -C "$WORKTREE" commit --amend -m '[Bug] 使用错误标签' >/dev/null
  if output=$("$FINISH" '完成变更' "$BODY" 2>&1); then fail 'wrong label succeeded'; fi
  assert_contains "$output" 'commits must start with [Feature]'
  test ! -s "$NPM_LOG" || fail 'npm ran after label failure'
  prepare_change docs
  printf 'dirty\n' > "$WORKTREE/dirty.txt"
  if output=$("$FINISH" '更新文档' "$BODY" 2>&1); then fail 'dirty succeeded'; fi
  assert_contains "$output" 'working tree is not clean'
}

test_finish_stops_on_checks_and_verification() {
  prepare_change optimize
  export NPM_FAIL=1
  if "$FINISH" '优化性能' "$BODY" >/dev/null 2>&1; then unset NPM_FAIL; fail 'failed check succeeded'; fi
  unset NPM_FAIL
  test ! -s "$GH_LOG" || fail 'gh ran after failed check'
  prepare_change refactor
  export GH_VIEW_BASE=develop
  if output=$("$FINISH" '重构模块' "$BODY" 2>&1); then unset GH_VIEW_BASE; fail 'bad PR succeeded'; fi
  unset GH_VIEW_BASE
  assert_contains "$output" 'unexpected base'
  case "$output" in *PR_URL=*) fail 'reported unverified URL' ;; esac
}

run_finish_tests() {
  run_case 'finish supports all types' test_finish_supports_all_types
  run_case 'finish rejects context and summary' test_finish_rejects_context_and_summary
  run_case 'finish rejects state and label' test_finish_rejects_state_and_label
  run_case 'finish stops on checks and verification' test_finish_stops_on_checks_and_verification
}
