#!/usr/bin/env bash

assert_no_pr_writes() {
  test ! -s "$PUSH_LOG" || fail 'push ran before a local gate failed'
  test ! -s "$GH_CREATE_LOG" || fail 'PR create ran before a local gate failed'
  test ! -s "$GH_EDIT_LOG" || fail 'PR edit ran before a local gate failed'
}

assert_single_task_section() {
  assert_eq "$(grep -c '^## Task$' "$GH_BODY")" 1
}

prepare_change_without_task() {
  new_fixture
  WORKTREE="$REPO/.worktrees/feature-no-task"
  git -C "$REPO" worktree add -b feature/no-task "$WORKTREE" origin/main >/dev/null 2>&1
  FINISH="$WORKTREE/.agents/skills/change-workflow/scripts/finish-change.sh"
  printf 'change\n' > "$WORKTREE/change.txt"
  git -C "$WORKTREE" add change.txt
  git -C "$WORKTREE" commit -m '[Feature] 添加无 Task 变更' >/dev/null
  BODY="$FIXTURE_ROOT/pr-body.md"
  printf '## Summary\n\nChange.\n\n## Testing\n\n- npm run check\n' > "$BODY"
  install_mocks
}

test_finish_supports_all_types_and_records_task_pr() {
  for type in feature bug docs refactor optimize test chore; do
    prepare_change "$type"
    pre_pr_sha=$(git -C "$WORKTREE" rev-parse HEAD)
    label=$(label_for_type "$type")

    output=$("$FINISH" '完成测试变更' "$BODY")

    assert_contains "$output" 'PR_URL=https://github.com/example/repo/pull/1'
    assert_contains "$(cat "$GH_LOG")" "pr create --base main --head $type/finish-case --title [$label] 完成测试变更"
    assert_eq "$(git -C "$WORKTREE" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}')" "origin/$type/finish-case"
    assert_eq "$($REAL_NODE -p "require('$TASK_DIR/status.json').pullRequest.number")" 1
    assert_eq "$(git -C "$WORKTREE" log -1 --format=%s)" "[$label] 记录 Task PR 编号"
    assert_contains "$(cat "$GH_BODY")" "https://github.com/example/repo/blob/$pre_pr_sha/docs/tasks/$TASK_ID/summary.md"
    assert_single_task_section
    assert_eq "$(wc -l < "$PUSH_LOG" | tr -d ' ')" 2
  done
}

test_finish_task_gates_precede_pr_writes() {
  prepare_change feature
  git -C "$WORKTREE" rm "docs/tasks/$TASK_ID/summary.md" >/dev/null
  git -C "$WORKTREE" commit -m '[Feature] 删除 Task 总结' >/dev/null
  if output=$("$FINISH" '完成变更' "$BODY" 2>&1); then fail 'missing summary succeeded'; fi
  assert_contains "$output" 'summary.md'
  assert_no_pr_writes

  prepare_change feature
  (cd "$WORKTREE" && node scripts/task-status.mjs rewind "$TASK_ID" verification >/dev/null)
  git -C "$WORKTREE" add "docs/tasks/$TASK_ID/status.json"
  git -C "$WORKTREE" commit -m '[Feature] 恢复验证阶段' >/dev/null
  if output=$("$FINISH" '完成变更' "$BODY" 2>&1); then fail 'nonterminal Task succeeded'; fi
  assert_contains "$output" 'all stages must be terminal'
  assert_no_pr_writes

  prepare_change_without_task
  if output=$("$FINISH" '完成变更' "$BODY" 2>&1); then fail 'zero Task candidates succeeded'; fi
  assert_contains "$output" 'expected exactly one changed Task status, found 0'
  assert_no_pr_writes

  prepare_change feature
  duplicate_id="$(date +%F)-duplicate-task"
  mkdir -p "$WORKTREE/docs/tasks/$duplicate_id"
  cp "$TASK_DIR/status.json" "$WORKTREE/docs/tasks/$duplicate_id/status.json"
  git -C "$WORKTREE" add "docs/tasks/$duplicate_id/status.json"
  git -C "$WORKTREE" commit -m '[Feature] 添加重复 Task 候选' >/dev/null
  if output=$("$FINISH" '完成变更' "$BODY" 2>&1); then fail 'two Task candidates succeeded'; fi
  assert_contains "$output" 'expected exactly one changed Task status, found 2'
  assert_no_pr_writes

  prepare_change feature
  printf '\n## Task\n\nForged.\n' >> "$BODY"
  if output=$("$FINISH" '完成变更' "$BODY" 2>&1); then fail 'existing Task section succeeded'; fi
  assert_contains "$output" 'must not contain ## Task'
  assert_no_pr_writes
}

test_finish_ignores_task_heading_inside_code_fence() {
  prepare_change feature
  printf '\n```markdown\n## Task\n```\n' >> "$BODY"

  output=$("$FINISH" '完成代码围栏变更' "$BODY")

  assert_contains "$output" 'PR_URL=https://github.com/example/repo/pull/1'
  assert_contains "$(cat "$GH_BODY")" '```markdown'
  assert_contains "$(cat "$GH_BODY")" '## Task'
}

test_finish_success_order_and_temp_cleanup() {
  prepare_change feature
  pre_pr_sha=$(git -C "$WORKTREE" rev-parse HEAD)
  user_file="$TMPDIR/user-owned.txt"
  printf 'keep\n' > "$user_file"

  output=$("$FINISH" '完成时序验证' "$BODY")

  assert_contains "$output" 'PR_URL=https://github.com/example/repo/pull/1'
  test -f "$user_file" || fail 'finish removed a user-owned temporary file'
  test -z "$(find "$TMPDIR" -name 'change-workflow-pr-body.*' -print)" || fail 'body temporary file remains'
  assert_contains "$(cat "$GH_BODY")" "https://github.com/example/repo/blob/$pre_pr_sha/docs/tasks/$TASK_ID/summary.md"
  resolve_line=$(grep -n 'node scripts/task-status.mjs resolve' "$EVENTS_LOG" | head -1 | cut -d: -f1)
  task_check_line=$(grep -n 'node scripts/task-status.mjs check' "$EVENTS_LOG" | head -1 | cut -d: -f1)
  npm_line=$(grep -n 'npm run check' "$EVENTS_LOG" | head -1 | cut -d: -f1)
  first_push_line=$(grep -n '^push ' "$EVENTS_LOG" | head -1 | cut -d: -f1)
  create_line=$(grep -n 'gh pr create' "$EVENTS_LOG" | head -1 | cut -d: -f1)
  set_pr_line=$(grep -n 'node scripts/task-status.mjs set-pr' "$EVENTS_LOG" | head -1 | cut -d: -f1)
  second_push_line=$(grep -n '^push ' "$EVENTS_LOG" | tail -1 | cut -d: -f1)
  final_view_line=$(grep -n 'gh pr view' "$EVENTS_LOG" | tail -1 | cut -d: -f1)
  test "$resolve_line" -lt "$npm_line" || fail 'Task resolve did not precede checks'
  test "$task_check_line" -lt "$first_push_line" || fail 'Task check did not precede first push'
  test "$npm_line" -lt "$first_push_line" || fail 'checks did not precede first push'
  test "$first_push_line" -lt "$create_line" || fail 'first push did not precede PR creation'
  test "$create_line" -lt "$set_pr_line" || fail 'PR validation did not precede set-pr'
  test "$set_pr_line" -lt "$second_push_line" || fail 'set-pr did not precede second push'
  test "$second_push_line" -lt "$final_view_line" || fail 'second push did not precede final head verification'
}

test_finish_reuses_open_pr_and_reruns_without_empty_commit() {
  prepare_change feature
  export GH_OPEN_PR_COUNT=1
  output=$("$FINISH" '完成恢复变更' "$BODY")
  first_head=$(git -C "$WORKTREE" rev-parse HEAD)

  assert_contains "$output" 'PR_URL=https://github.com/example/repo/pull/1'
  test ! -s "$GH_CREATE_LOG" || fail 'created a duplicate PR instead of reusing the open PR'
  assert_eq "$(wc -l < "$GH_EDIT_LOG" | tr -d ' ')" 1
  assert_eq "$($REAL_NODE -p "require('$TASK_DIR/status.json').pullRequest.number")" 1

  output=$("$FINISH" '完成恢复变更' "$BODY")

  assert_contains "$output" 'PR_URL=https://github.com/example/repo/pull/1'
  assert_eq "$(git -C "$WORKTREE" rev-parse HEAD)" "$first_head"
  test ! -s "$GH_CREATE_LOG" || fail 'rerun created a duplicate PR'
  assert_eq "$(wc -l < "$GH_EDIT_LOG" | tr -d ' ')" 2
  assert_single_task_section
}

test_finish_recovers_after_second_push_failure() {
  prepare_change feature
  export GIT_FAIL_PUSH_NUMBER=2
  if output=$("$FINISH" '完成可恢复变更' "$BODY" 2>&1); then unset GIT_FAIL_PUSH_NUMBER; fail 'second push failure succeeded'; fi
  unset GIT_FAIL_PUSH_NUMBER
  case "$output" in *PR_URL=*) fail 'reported URL after second push failed' ;; esac
  assert_eq "$(wc -l < "$GH_CREATE_LOG" | tr -d ' ')" 1
  assert_eq "$($REAL_NODE -p "require('$TASK_DIR/status.json').pullRequest.number")" 1

  output=$("$FINISH" '完成可恢复变更' "$BODY")

  assert_contains "$output" 'PR_URL=https://github.com/example/repo/pull/1'
  assert_eq "$(wc -l < "$GH_CREATE_LOG" | tr -d ' ')" 1
  assert_eq "$(wc -l < "$GH_EDIT_LOG" | tr -d ' ')" 1
}

test_finish_recovers_staged_status_after_commit_identity_failure() {
  prepare_change feature
  git -C "$WORKTREE" config user.useConfigOnly true
  git -C "$WORKTREE" config --unset-all user.name
  git -C "$WORKTREE" config --unset-all user.email
  : > "$FIXTURE_ROOT/empty-global.gitconfig"
  export GIT_CONFIG_GLOBAL="$FIXTURE_ROOT/empty-global.gitconfig"

  if output=$("$FINISH" '完成身份恢复变更' "$BODY" 2>&1); then fail 'commit identity failure succeeded'; fi
  assert_contains "$output" 'Author identity unknown'
  assert_eq "$(wc -l < "$GH_CREATE_LOG" | tr -d ' ')" 1
  assert_eq "$($REAL_NODE -p "require('$TASK_DIR/status.json').pullRequest.number")" 1
  assert_eq "$(git -C "$WORKTREE" status --porcelain=v1 --untracked-files=all)" "M  docs/tasks/$TASK_ID/status.json"

  git -C "$WORKTREE" config user.name 'Change Workflow Test'
  git -C "$WORKTREE" config user.email 'change-workflow@example.com'
  output=$("$FINISH" '完成身份恢复变更' "$BODY")

  assert_contains "$output" 'PR_URL=https://github.com/example/repo/pull/1'
  assert_eq "$(wc -l < "$GH_CREATE_LOG" | tr -d ' ')" 1
  assert_eq "$(wc -l < "$GH_EDIT_LOG" | tr -d ' ')" 1
  assert_eq "$(git -C "$WORKTREE" log -1 --format=%s)" '[Feature] 记录 Task PR 编号'
  assert_eq "$(git -C "$WORKTREE" status --porcelain=v1 --untracked-files=all)" ''
}

test_finish_recovery_rejects_unrelated_worktree_changes() {
  for mode in staged unstaged untracked; do
    prepare_change feature
    git -C "$WORKTREE" config user.useConfigOnly true
    git -C "$WORKTREE" config --unset-all user.name
    git -C "$WORKTREE" config --unset-all user.email
    : > "$FIXTURE_ROOT/empty-global.gitconfig"
    export GIT_CONFIG_GLOBAL="$FIXTURE_ROOT/empty-global.gitconfig"
    if "$FINISH" '准备恢复变更' "$BODY" >/dev/null 2>&1; then fail 'commit identity failure succeeded'; fi
    git -C "$WORKTREE" config user.name 'Change Workflow Test'
    git -C "$WORKTREE" config user.email 'change-workflow@example.com'
    case "$mode" in
      staged)
        printf 'unrelated\n' > "$WORKTREE/unrelated-staged.txt"
        git -C "$WORKTREE" add unrelated-staged.txt
        ;;
      unstaged) printf 'unrelated\n' >> "$WORKTREE/change.txt" ;;
      untracked) printf 'unrelated\n' > "$WORKTREE/unrelated-untracked.txt" ;;
    esac
    push_count=$(wc -l < "$PUSH_LOG" | tr -d ' ')
    create_count=$(wc -l < "$GH_CREATE_LOG" | tr -d ' ')
    edit_count=$(wc -l < "$GH_EDIT_LOG" | tr -d ' ')

    if output=$("$FINISH" '恢复含无关变更' "$BODY" 2>&1); then fail "$mode recovery with unrelated changes succeeded"; fi

    assert_contains "$output" 'working tree is not clean'
    assert_eq "$(wc -l < "$PUSH_LOG" | tr -d ' ')" "$push_count"
    assert_eq "$(wc -l < "$GH_CREATE_LOG" | tr -d ' ')" "$create_count"
    assert_eq "$(wc -l < "$GH_EDIT_LOG" | tr -d ' ')" "$edit_count"
  done
}

test_finish_rejects_recorded_pr_number_conflict_before_writes() {
  prepare_change feature
  (cd "$WORKTREE" && node scripts/task-status.mjs set-pr "$TASK_ID" 2 >/dev/null)
  git -C "$WORKTREE" add "docs/tasks/$TASK_ID/status.json"
  git -C "$WORKTREE" commit -m '[Feature] 记录 Task PR 编号' >/dev/null
  before_head=$(git -C "$WORKTREE" rev-parse HEAD)
  before_status=$(git -C "$WORKTREE" show "HEAD:docs/tasks/$TASK_ID/status.json")
  export GH_OPEN_PR_COUNT=1 GH_VIEW_NUMBER=1

  if output=$("$FINISH" '拒绝 PR 编号冲突' "$BODY" 2>&1); then fail 'recorded PR number conflict succeeded'; fi

  assert_contains "$output" 'recorded Task PR number does not match'
  assert_eq "$(git -C "$WORKTREE" rev-parse HEAD)" "$before_head"
  assert_eq "$(git -C "$WORKTREE" show "HEAD:docs/tasks/$TASK_ID/status.json")" "$before_status"
  assert_eq "$(git -C "$WORKTREE" status --porcelain=v1 --untracked-files=all)" ''
  test ! -s "$PUSH_LOG" || fail 'PR number conflict pushed'
  test ! -s "$GH_CREATE_LOG" || fail 'PR number conflict created a PR'
  test ! -s "$GH_EDIT_LOG" || fail 'PR number conflict edited a PR'
}

test_finish_rejects_task_heading_with_closing_hashes() {
  prepare_change feature
  printf '\n  ## Task ##  \n\nForged.\n' >> "$BODY"

  if output=$("$FINISH" '拒绝带闭合井号的 Task' "$BODY" 2>&1); then fail 'Task heading with closing hashes succeeded'; fi

  assert_contains "$output" 'must not contain ## Task'
  assert_no_pr_writes
}

test_finish_rejects_task_hidden_by_invalid_backtick_fence() {
  prepare_change feature
  printf '\n```markdown`invalid\n## Task\n```\n' >> "$BODY"

  if output=$("$FINISH" '拒绝非法围栏隐藏的 Task' "$BODY" 2>&1); then fail 'Task hidden by invalid backtick fence succeeded'; fi

  assert_contains "$output" 'must not contain ## Task'
  assert_no_pr_writes
}

test_finish_allows_task_text_inside_valid_commonmark_fences() {
  prepare_change feature
  printf '\n```markdown\n## Task ##\n````\n\n~~~ markdown\n## Task\n~~~\n' >> "$BODY"

  output=$("$FINISH" '允许合法围栏中的 Task 文本' "$BODY")

  assert_contains "$output" 'PR_URL=https://github.com/example/repo/pull/1'
}

test_finish_keeps_summary_url_stable_after_automatic_status_commit() {
  prepare_change feature
  summary_head=$(git -C "$WORKTREE" rev-parse HEAD)
  "$FINISH" '保持自动回写链接稳定' "$BODY" >/dev/null
  status_head=$(git -C "$WORKTREE" rev-parse HEAD)

  output=$("$FINISH" '保持自动回写链接稳定' "$BODY")

  assert_contains "$output" 'PR_URL=https://github.com/example/repo/pull/1'
  assert_contains "$(cat "$GH_BODY")" "https://github.com/example/repo/blob/$summary_head/docs/tasks/$TASK_ID/summary.md"
  assert_not_contains "$(cat "$GH_BODY")" "https://github.com/example/repo/blob/$status_head/docs/tasks/$TASK_ID/summary.md"
}

test_finish_refreshes_summary_url_after_substantive_commit() {
  prepare_change feature
  "$FINISH" '刷新实质变更链接' "$BODY" >/dev/null
  printf '\nSubstantive update.\n' >> "$TASK_DIR/summary.md"
  git -C "$WORKTREE" add "docs/tasks/$TASK_ID/summary.md"
  git -C "$WORKTREE" commit -m '[Feature] 更新 Task 总结' >/dev/null
  substantive_head=$(git -C "$WORKTREE" rev-parse HEAD)

  output=$("$FINISH" '刷新实质变更链接' "$BODY")

  assert_contains "$output" 'PR_URL=https://github.com/example/repo/pull/1'
  assert_contains "$(cat "$GH_BODY")" "https://github.com/example/repo/blob/$substantive_head/docs/tasks/$TASK_ID/summary.md"
}

test_finish_does_not_trust_status_commit_title_alone_for_summary_url() {
  prepare_change feature
  "$FINISH" '拒绝只按标题回溯链接' "$BODY" >/dev/null
  (cd "$WORKTREE" && node scripts/task-status.mjs set-pr "$TASK_ID" 1 >/dev/null)
  git -C "$WORKTREE" add "docs/tasks/$TASK_ID/status.json"
  git -C "$WORKTREE" commit -m '[Feature] 记录 Task PR 编号' >/dev/null
  untrusted_head=$(git -C "$WORKTREE" rev-parse HEAD)

  output=$("$FINISH" '拒绝只按标题回溯链接' "$BODY")

  assert_contains "$output" 'PR_URL=https://github.com/example/repo/pull/1'
  assert_contains "$(cat "$GH_BODY")" "https://github.com/example/repo/blob/$untrusted_head/docs/tasks/$TASK_ID/summary.md"
}

test_finish_rejects_multiple_open_prs_without_creating() {
  prepare_change feature
  export GH_OPEN_PR_COUNT=2
  if output=$("$FINISH" '完成变更' "$BODY" 2>&1); then unset GH_OPEN_PR_COUNT; fail 'multiple open PRs succeeded'; fi
  unset GH_OPEN_PR_COUNT
  assert_contains "$output" 'multiple open pull requests'
  test ! -s "$GH_CREATE_LOG" || fail 'created PR with multiple open candidates'
  test ! -s "$GH_EDIT_LOG" || fail 'edited PR with multiple open candidates'
}

test_finish_rejects_invalid_pr_verification() {
  for field in number base head state url head_oid; do
    prepare_change feature
    case "$field" in
      number) export GH_VIEW_NUMBER=0 ;;
      base) export GH_VIEW_BASE=develop ;;
      head) export GH_VIEW_HEAD=feature/other ;;
      state) export GH_VIEW_STATE=CLOSED ;;
      url) export GH_VIEW_URL='' ;;
      head_oid) export GH_VIEW_HEAD_OID='' ;;
    esac
    if output=$("$FINISH" '完成验证变更' "$BODY" 2>&1); then fail "invalid $field succeeded"; fi
    case "$output" in *PR_URL=*) fail "invalid $field reported PR_URL" ;; esac
  done
}

test_finish_preserves_context_summary_and_label_guards() {
  new_fixture
  BODY="$FIXTURE_ROOT/body.md"; printf '## Summary\n\nX\n\n## Testing\n\nX\n' > "$BODY"
  if output=$("$REPO/.agents/skills/change-workflow/scripts/finish-change.sh" '摘要' "$BODY" 2>&1); then fail 'primary succeeded'; fi
  assert_contains "$output" 'linked worktree'
  prepare_change bug
  for summary in '' '[Bug] 重复' $'包含\n换行' '句号。' 'period.'; do
    if output=$("$FINISH" "$summary" "$BODY" 2>&1); then fail 'invalid summary succeeded'; fi
    assert_contains "$output" 'invalid PR summary'
  done

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

test_finish_preserves_supporting_commit_labels_and_check_gate() {
  prepare_change bug
  printf 'documentation\n' > "$WORKTREE/documentation.md"
  git -C "$WORKTREE" add documentation.md
  git -C "$WORKTREE" commit -m '[Docs] 补充修复说明' >/dev/null
  printf 'regression\n' > "$WORKTREE/regression.test"
  git -C "$WORKTREE" add regression.test
  git -C "$WORKTREE" commit -m '[Test] 补充回归测试' >/dev/null
  output=$("$FINISH" '完成缺陷修复' "$BODY")
  assert_contains "$output" 'PR_URL=https://github.com/example/repo/pull/1'

  prepare_change refactor
  printf 'fix\n' > "$WORKTREE/fix.txt"
  git -C "$WORKTREE" add fix.txt
  git -C "$WORKTREE" commit -m '[Bug] 修复重构引入的缺陷' >/dev/null
  printf 'regression\n' > "$WORKTREE/regression.test"
  git -C "$WORKTREE" add regression.test
  git -C "$WORKTREE" commit -m '[Test] 补充回归测试' >/dev/null
  printf 'documentation\n' > "$WORKTREE/documentation.md"
  git -C "$WORKTREE" add documentation.md
  git -C "$WORKTREE" commit -m '[Docs] 更新重构说明' >/dev/null
  output=$("$FINISH" '完成重构' "$BODY")
  assert_contains "$output" 'PR_URL=https://github.com/example/repo/pull/1'

  prepare_change optimize
  export NPM_FAIL=1
  if "$FINISH" '优化性能' "$BODY" >/dev/null 2>&1; then unset NPM_FAIL; fail 'failed check succeeded'; fi
  unset NPM_FAIL
  test ! -s "$GH_LOG" || fail 'gh ran after failed check'
  test ! -s "$PUSH_LOG" || fail 'push ran after failed check'
}

run_finish_tests() {
  run_case 'finish supports all types and records Task PR' test_finish_supports_all_types_and_records_task_pr
  run_case 'finish Task gates precede PR writes' test_finish_task_gates_precede_pr_writes
  run_case 'finish ignores Task heading inside code fence' test_finish_ignores_task_heading_inside_code_fence
  run_case 'finish success order and temp cleanup' test_finish_success_order_and_temp_cleanup
  run_case 'finish reuses open PR and reruns without empty commit' test_finish_reuses_open_pr_and_reruns_without_empty_commit
  run_case 'finish recovers after second push failure' test_finish_recovers_after_second_push_failure
  run_case 'finish recovers staged status after commit identity failure' test_finish_recovers_staged_status_after_commit_identity_failure
  run_case 'finish recovery rejects unrelated worktree changes' test_finish_recovery_rejects_unrelated_worktree_changes
  run_case 'finish rejects recorded PR number conflict before writes' test_finish_rejects_recorded_pr_number_conflict_before_writes
  run_case 'finish rejects Task heading with closing hashes' test_finish_rejects_task_heading_with_closing_hashes
  run_case 'finish rejects Task hidden by invalid backtick fence' test_finish_rejects_task_hidden_by_invalid_backtick_fence
  run_case 'finish allows Task text inside valid CommonMark fences' test_finish_allows_task_text_inside_valid_commonmark_fences
  run_case 'finish keeps summary URL stable after automatic status commit' test_finish_keeps_summary_url_stable_after_automatic_status_commit
  run_case 'finish refreshes summary URL after substantive commit' test_finish_refreshes_summary_url_after_substantive_commit
  run_case 'finish does not trust status commit title alone for summary URL' test_finish_does_not_trust_status_commit_title_alone_for_summary_url
  run_case 'finish rejects multiple open PRs without creating' test_finish_rejects_multiple_open_prs_without_creating
  run_case 'finish rejects invalid PR verification' test_finish_rejects_invalid_pr_verification
  run_case 'finish preserves context summary and label guards' test_finish_preserves_context_summary_and_label_guards
  run_case 'finish preserves supporting labels and check gate' test_finish_preserves_supporting_commit_labels_and_check_gate
}
