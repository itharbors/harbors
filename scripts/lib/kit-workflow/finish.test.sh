#!/usr/bin/env bash

assert_no_finish_writes() {
  test ! -s "$PUSH_LOG" || fail 'push ran before a Task gate failed'
  test ! -s "$GH_CREATE_LOG" || fail 'PR create ran before a Task gate failed'
  test ! -s "$GH_EDIT_LOG" || fail 'PR edit ran before a Task gate failed'
  assert_not_contains "$(cat "$NPM_LOG")" 'kit:boundary'
  assert_not_contains "$(cat "$NPM_LOG")" 'kit:check'
  assert_not_contains "$(cat "$NODE_LOG")" 'scripts/plan-kit-releases.mjs'
}

assert_single_task_section() {
  assert_eq "$(grep -c '^## Task$' "$GH_BODY")" 1
}

prepare_change_without_task() {
  new_fixture
  install_mocks
  WORKTREE="$REPO/.worktrees/kit-sqlite-feature-no-task"
  git -C "$REPO" worktree add -b kit-change/sqlite/feature/no-task "$WORKTREE" origin/main >/dev/null 2>&1
  FINISH="$WORKTREE/.agents/skills/kit-workflow/scripts/finish-kit-change.sh"
  printf 'change\n' > "$WORKTREE/kits/sqlite/change.txt"
  set_kit_version "$WORKTREE" 0.1.0-preview.2 preview
  git -C "$WORKTREE" add kits/sqlite
  git -C "$WORKTREE" commit -m '[Feature] 添加无 Task 变更' >/dev/null
  BODY="$FIXTURE_ROOT/pr-body.md"
  printf '## Summary\n\nChange.\n\n## Testing\n\n- npm run kit:check -- sqlite\n' > "$BODY"
}

test_finish_targets_main_for_all_types() {
  for type in feature bug docs refactor optimize test chore; do
    prepare_change "$type"
    pre_pr_sha=$(git -C "$WORKTREE" rev-parse HEAD)
    output=$("$FINISH" sqlite '完成 Kit 变更' "$BODY")
    label=$(label_for_type "$type")
    assert_contains "$output" 'PR_URL=https://github.com/example/repo/pull/1'
    assert_contains "$(cat "$GH_LOG")" "pr create --base main --head kit-change/sqlite/$type/finish-case --title [$label] 完成 Kit 变更"
    assert_eq "$($REAL_NODE -p "require('$TASK_DIR/status.json').pullRequest.number")" 1
    assert_eq "$(git -C "$WORKTREE" log -1 --format=%s)" "[$label] 记录 Task PR 编号"
    assert_contains "$(cat "$GH_BODY")" "https://github.com/example/repo/blob/$pre_pr_sha/docs/tasks/$TASK_ID/summary.md"
    assert_single_task_section
    assert_eq "$(wc -l < "$PUSH_LOG" | tr -d ' ')" 2
    npm_log=$(cat "$NPM_LOG")
    assert_eq "$(grep -c "run kit:boundary -- sqlite --task $TASK_ID --base refs/remotes/origin/main --head HEAD" "$NPM_LOG")" 2
    assert_contains "$npm_log" 'run kit:check -- sqlite --output-directory'
    assert_not_contains "$npm_log" 'run check'
    assert_not_contains "$npm_log" 'run kit:validate'
    assert_not_contains "$npm_log" 'run kit:pack'
  done
}

test_finish_task_gates_precede_boundary_pack_push_and_pr() {
  prepare_change feature
  git -C "$WORKTREE" rm "docs/tasks/$TASK_ID/summary.md" >/dev/null
  git -C "$WORKTREE" commit -m '[Feature] 删除 Task 总结' >/dev/null
  if output=$("$FINISH" sqlite '完成变更' "$BODY" 2>&1); then fail 'missing summary succeeded'; fi
  assert_contains "$output" 'summary.md'
  assert_no_finish_writes

  prepare_change feature
  (cd "$WORKTREE" && node scripts/task-status.mjs rewind "$TASK_ID" verification >/dev/null)
  git -C "$WORKTREE" add "docs/tasks/$TASK_ID/status.json"
  git -C "$WORKTREE" commit -m '[Feature] 恢复验证阶段' >/dev/null
  if output=$("$FINISH" sqlite '完成变更' "$BODY" 2>&1); then fail 'nonterminal Task succeeded'; fi
  assert_contains "$output" 'all stages must be terminal'
  assert_no_finish_writes

  prepare_change_without_task
  if output=$("$FINISH" sqlite '完成变更' "$BODY" 2>&1); then fail 'zero Task candidates succeeded'; fi
  assert_contains "$output" 'expected exactly one changed Task status, found 0'
  assert_no_finish_writes

  prepare_change feature
  duplicate_id="$(date +%F)-duplicate-task"
  mkdir -p "$WORKTREE/docs/tasks/$duplicate_id"
  cp "$TASK_DIR/status.json" "$WORKTREE/docs/tasks/$duplicate_id/status.json"
  git -C "$WORKTREE" add "docs/tasks/$duplicate_id/status.json"
  git -C "$WORKTREE" commit -m '[Feature] 添加重复 Task 候选' >/dev/null
  if output=$("$FINISH" sqlite '完成变更' "$BODY" 2>&1); then fail 'two Task candidates succeeded'; fi
  assert_contains "$output" 'expected exactly one changed Task status, found 2'
  assert_no_finish_writes
}

test_finish_rejects_and_parses_task_headings() {
  prepare_change feature
  printf '\n  ## Task ##  \n\nForged.\n' >> "$BODY"
  if output=$("$FINISH" sqlite '拒绝 Task' "$BODY" 2>&1); then fail 'Task heading succeeded'; fi
  assert_contains "$output" 'must not contain ## Task'
  assert_no_finish_writes

  prepare_change feature
  printf '\n```markdown`invalid\n## Task\n```\n' >> "$BODY"
  if output=$("$FINISH" sqlite '拒绝非法围栏' "$BODY" 2>&1); then fail 'invalid fence hid Task'; fi
  assert_contains "$output" 'must not contain ## Task'
  assert_no_finish_writes

  prepare_change feature
  printf '\n```markdown\n## Task ##\n````\n\n~~~ markdown\n## Task\n~~~\n' >> "$BODY"
  output=$("$FINISH" sqlite '允许合法围栏' "$BODY")
  assert_contains "$output" 'PR_URL=https://github.com/example/repo/pull/1'
}

test_finish_reuses_open_pr_and_reruns_without_empty_commit() {
  prepare_change feature
  export GH_OPEN_PR_COUNT=1
  output=$("$FINISH" sqlite '完成恢复变更' "$BODY")
  first_head=$(git -C "$WORKTREE" rev-parse HEAD)
  assert_contains "$output" 'PR_URL=https://github.com/example/repo/pull/1'
  test ! -s "$GH_CREATE_LOG" || fail 'created duplicate PR'
  assert_eq "$(wc -l < "$GH_EDIT_LOG" | tr -d ' ')" 1

  output=$("$FINISH" sqlite '完成恢复变更' "$BODY")
  assert_contains "$output" 'PR_URL=https://github.com/example/repo/pull/1'
  assert_eq "$(git -C "$WORKTREE" rev-parse HEAD)" "$first_head"
  test ! -s "$GH_CREATE_LOG" || fail 'rerun created duplicate PR'
  assert_eq "$(wc -l < "$GH_EDIT_LOG" | tr -d ' ')" 2
  assert_single_task_section
}

test_finish_recovers_after_second_push_failure() {
  prepare_change feature
  export GIT_FAIL_PUSH_NUMBER=2
  if output=$("$FINISH" sqlite '完成可恢复变更' "$BODY" 2>&1); then fail 'second push failure succeeded'; fi
  unset GIT_FAIL_PUSH_NUMBER
  case "$output" in *PR_URL=*) fail 'reported URL after second push failed' ;; esac
  assert_eq "$(wc -l < "$GH_CREATE_LOG" | tr -d ' ')" 1
  assert_eq "$($REAL_NODE -p "require('$TASK_DIR/status.json').pullRequest.number")" 1

  output=$("$FINISH" sqlite '完成可恢复变更' "$BODY")
  assert_contains "$output" 'PR_URL=https://github.com/example/repo/pull/1'
  assert_eq "$(wc -l < "$GH_CREATE_LOG" | tr -d ' ')" 1
  assert_eq "$(wc -l < "$GH_EDIT_LOG" | tr -d ' ')" 1
}

test_finish_recovers_exact_staged_status_and_rejects_other_dirty_state() {
  prepare_change feature
  export GIT_FAIL_STATUS_COMMIT=1
  if output=$("$FINISH" sqlite '准备恢复变更' "$BODY" 2>&1); then fail 'identity failure succeeded'; fi
  unset GIT_FAIL_STATUS_COMMIT
  assert_contains "$output" 'simulated status commit failure'
  assert_eq "$(git -C "$WORKTREE" status --porcelain=v1 --untracked-files=all)" "M  docs/tasks/$TASK_ID/status.json"
  recovery_head=$(git -C "$WORKTREE" rev-parse HEAD)
  recovery_author=$(git -C "$WORKTREE" log -1 --format='%an <%ae>')
  recovery_pushes=$(wc -l < "$PUSH_LOG" | tr -d ' ')
  recovery_creates=$(wc -l < "$GH_CREATE_LOG" | tr -d ' ')
  recovery_edits=$(wc -l < "$GH_EDIT_LOG" | tr -d ' ')
  git -C "$WORKTREE" config --local user.name 'Wrong Recovery Author'
  git -C "$WORKTREE" config --local user.email 'wrong-recovery@example.com'
  if output=$("$FINISH" sqlite '拒绝错误身份恢复' "$BODY" 2>&1); then fail 'wrong recovery identity succeeded'; fi
  assert_contains "$output" 'Git user.name must be VisualSJ'
  assert_eq "$(git -C "$WORKTREE" rev-parse HEAD)" "$recovery_head"
  assert_eq "$(git -C "$WORKTREE" log -1 --format='%an <%ae>')" "$recovery_author"
  assert_eq "$(git -C "$WORKTREE" status --porcelain=v1 --untracked-files=all)" "M  docs/tasks/$TASK_ID/status.json"
  assert_eq "$(wc -l < "$PUSH_LOG" | tr -d ' ')" "$recovery_pushes"
  assert_eq "$(wc -l < "$GH_CREATE_LOG" | tr -d ' ')" "$recovery_creates"
  assert_eq "$(wc -l < "$GH_EDIT_LOG" | tr -d ' ')" "$recovery_edits"
  git -C "$WORKTREE" config --local user.name 'VisualSJ'
  git -C "$WORKTREE" config --local user.email 'devhacker520@hotmail.com'
  output=$("$FINISH" sqlite '恢复变更' "$BODY")
  assert_contains "$output" 'PR_URL=https://github.com/example/repo/pull/1'
  assert_eq "$(wc -l < "$GH_CREATE_LOG" | tr -d ' ')" "$recovery_creates"
  assert_eq "$(wc -l < "$GH_EDIT_LOG" | tr -d ' ')" 1

  prepare_change feature
  export GIT_FAIL_STATUS_COMMIT=1
  "$FINISH" sqlite '准备脏状态' "$BODY" >/dev/null 2>&1 || true
  unset GIT_FAIL_STATUS_COMMIT
  printf 'unrelated\n' > "$WORKTREE/unrelated.txt"
  if output=$("$FINISH" sqlite '拒绝脏状态' "$BODY" 2>&1); then fail 'unrelated recovery succeeded'; fi
  assert_contains "$output" 'working tree is not clean'
}

test_finish_rejects_recorded_pr_conflict_and_multiple_prs() {
  prepare_change feature
  (cd "$WORKTREE" && node scripts/task-status.mjs set-pr "$TASK_ID" 2 >/dev/null)
  git -C "$WORKTREE" add "docs/tasks/$TASK_ID/status.json"
  git -C "$WORKTREE" commit -m '[Feature] 记录 Task PR 编号' >/dev/null
  export GH_OPEN_PR_COUNT=1 GH_VIEW_NUMBER=1
  if output=$("$FINISH" sqlite '拒绝冲突' "$BODY" 2>&1); then fail 'PR conflict succeeded'; fi
  assert_contains "$output" 'recorded Task PR number does not match'
  test ! -s "$PUSH_LOG" || fail 'PR conflict pushed'

  prepare_change feature
  export GH_OPEN_PR_COUNT=2
  if output=$("$FINISH" sqlite '拒绝多个 PR' "$BODY" 2>&1); then fail 'multiple PRs succeeded'; fi
  assert_contains "$output" 'multiple open pull requests'
  test ! -s "$GH_CREATE_LOG" || fail 'created with multiple PRs'

  prepare_change feature
  (cd "$WORKTREE" && node scripts/task-status.mjs set-pr "$TASK_ID" 1 >/dev/null)
  git -C "$WORKTREE" add "docs/tasks/$TASK_ID/status.json"
  git -C "$WORKTREE" commit -m '[Feature] 记录 Task PR 编号' >/dev/null
  if output=$("$FINISH" sqlite '拒绝丢失 PR' "$BODY" 2>&1); then fail 'recorded PR without open candidate succeeded'; fi
  assert_contains "$output" 'recorded Task PR has no unique open pull request'
  test ! -s "$PUSH_LOG" || fail 'missing recorded PR pushed'
}

test_finish_summary_sha_is_stable_refreshes_and_does_not_trust_title() {
  prepare_change feature
  summary_head=$(git -C "$WORKTREE" rev-parse HEAD)
  "$FINISH" sqlite '保持链接稳定' "$BODY" >/dev/null
  status_head=$(git -C "$WORKTREE" rev-parse HEAD)
  "$FINISH" sqlite '保持链接稳定' "$BODY" >/dev/null
  assert_contains "$(cat "$GH_BODY")" "/blob/$summary_head/docs/tasks/$TASK_ID/summary.md"
  assert_not_contains "$(cat "$GH_BODY")" "/blob/$status_head/docs/tasks/$TASK_ID/summary.md"

  printf '\nSubstantive update.\n' >> "$TASK_DIR/summary.md"
  git -C "$WORKTREE" add "docs/tasks/$TASK_ID/summary.md"
  git -C "$WORKTREE" commit -m '[Feature] 更新 Task 总结' >/dev/null
  substantive_head=$(git -C "$WORKTREE" rev-parse HEAD)
  "$FINISH" sqlite '刷新链接' "$BODY" >/dev/null
  assert_contains "$(cat "$GH_BODY")" "/blob/$substantive_head/docs/tasks/$TASK_ID/summary.md"

  (cd "$WORKTREE" && node scripts/task-status.mjs set-pr "$TASK_ID" 1 >/dev/null)
  git -C "$WORKTREE" add "docs/tasks/$TASK_ID/status.json"
  git -C "$WORKTREE" commit -m '[Feature] 记录 Task PR 编号' >/dev/null
  untrusted_head=$(git -C "$WORKTREE" rev-parse HEAD)
  "$FINISH" sqlite '不信任标题' "$BODY" >/dev/null
  assert_contains "$(cat "$GH_BODY")" "/blob/$untrusted_head/docs/tasks/$TASK_ID/summary.md"
}

test_finish_rejects_invalid_pr_verification() {
  for field in number base head state url head_oid; do
    prepare_change feature
    case "$field" in
      number) export GH_VIEW_NUMBER=0 ;;
      base) export GH_VIEW_BASE=develop ;;
      head) export GH_VIEW_HEAD=kit-change/sqlite/feature/other ;;
      state) export GH_VIEW_STATE=CLOSED ;;
      url) export GH_VIEW_URL='' ;;
      head_oid) export GH_VIEW_HEAD_OID='' ;;
    esac
    if output=$("$FINISH" sqlite '拒绝非法 PR' "$BODY" 2>&1); then fail "invalid $field succeeded"; fi
    case "$output" in *PR_URL=*) fail "invalid $field reported PR_URL" ;; esac
  done
}

test_finish_requires_remote_head_to_match_after_second_push() {
  prepare_change feature
  export GH_VIEW_STALE_HEAD=1
  if output=$("$FINISH" sqlite '拒绝过期远端 HEAD' "$BODY" 2>&1); then fail 'stale remote head succeeded'; fi
  assert_contains "$output" 'headRefOid did not match local HEAD after push'
  case "$output" in *PR_URL=*) fail 'stale remote head reported PR_URL' ;; esac
  assert_eq "$(wc -l < "$GH_CREATE_LOG" | tr -d ' ')" 1
  assert_eq "$($REAL_NODE -p "require('$TASK_DIR/status.json').pullRequest.number")" 1
}

test_finish_task_and_kit_gate_order() {
  prepare_change feature
  "$FINISH" sqlite '验证时序' "$BODY" >/dev/null
  resolve_line=$(grep -n 'node scripts/task-status.mjs resolve' "$EVENTS_LOG" | head -1 | cut -d: -f1)
  first_boundary_line=$(grep -n 'npm --prefix .*kit:boundary' "$EVENTS_LOG" | head -1 | cut -d: -f1)
  release_line=$(grep -n 'node scripts/plan-kit-releases.mjs' "$EVENTS_LOG" | head -1 | cut -d: -f1)
  pack_line=$(grep -n 'npm run kit:check' "$EVENTS_LOG" | head -1 | cut -d: -f1)
  first_push_line=$(grep -n '^push ' "$EVENTS_LOG" | head -1 | cut -d: -f1)
  set_pr_line=$(grep -n 'node scripts/task-status.mjs set-pr' "$EVENTS_LOG" | head -1 | cut -d: -f1)
  second_push_line=$(grep -n '^push ' "$EVENTS_LOG" | tail -1 | cut -d: -f1)
  final_view_line=$(grep -n 'gh pr view' "$EVENTS_LOG" | tail -1 | cut -d: -f1)
  test "$resolve_line" -lt "$first_boundary_line" || fail 'Task resolve did not precede boundary'
  test "$first_boundary_line" -lt "$release_line" || fail 'boundary did not precede release intent'
  test "$release_line" -lt "$pack_line" || fail 'release intent did not precede pack checks'
  test "$pack_line" -lt "$first_push_line" || fail 'pack checks did not precede push'
  test "$first_push_line" -lt "$set_pr_line" || fail 'PR validation did not precede set-pr'
  test "$set_pr_line" -lt "$second_push_line" || fail 'set-pr did not precede second push'
  test "$second_push_line" -lt "$final_view_line" || fail 'second push did not precede head verification'
  test -z "$(find "$TMPDIR" \( -name 'kit-workflow-pr-body.*' -o -name 'kit-workflow-pack.*' \) -print)" \
    || fail 'finish left temporary files behind'
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

test_finish_runs_boundary_check_before_pack_and_push() {
  prepare_change optimize
  install_git_logging_mock
  export NPM_FAIL=1
  if "$FINISH" sqlite '优化性能' "$BODY" >/dev/null 2>&1; then unset NPM_FAIL; fail 'failed boundary succeeded'; fi
  unset NPM_FAIL
  test ! -s "$GH_LOG" || fail 'gh ran after boundary failure'
  npm_log=$(cat "$NPM_LOG")
  assert_contains "$npm_log" "run kit:boundary -- sqlite --task $TASK_ID --base refs/remotes/origin/main --head HEAD"
  assert_not_contains "$npm_log" 'kit:check'
  git_log=$(cat "$GIT_LOG")
  assert_not_contains "$git_log" 'fetch origin'
  assert_not_contains "$git_log" 'push --set-upstream'
}

install_boundary_aware_npm_mock() {
  export REPO_SOURCE
  cat > "$MOCK_BIN/npm" <<'NPM'
#!/usr/bin/env bash
printf "%s\n" "$*" >> "$NPM_LOG"
repository_root=
expect_prefix=0
for arg in "$@"; do
  if test "$expect_prefix" -eq 1; then
    repository_root=$arg
    expect_prefix=0
  elif test "$arg" = '--prefix'; then
    expect_prefix=1
  fi
done
if test "${1:-}" = ci; then
  mkdir -p node_modules
  test -e node_modules/semver || ln -s "$SEMVER_SOURCE" node_modules/semver
fi
found_boundary=0
found_dashdash=0
boundary_args=()
for arg in "$@"; do
  if test "$found_boundary" -eq 1 && test "$found_dashdash" -eq 1; then
    boundary_args+=("$arg")
  elif test "$arg" = 'kit:boundary'; then
    found_boundary=1
  elif test "$found_boundary" -eq 1 && test "$arg" = '--'; then
    found_dashdash=1
  fi
done
if test "$found_boundary" -eq 1; then
  test -n "$repository_root"
  cd "$repository_root"
  exec node "$REPO_SOURCE/scripts/check-kit-boundary.mjs" "${boundary_args[@]}"
fi
test "${NPM_FAIL:-0}" != 1
NPM
  chmod +x "$MOCK_BIN/npm"
}

install_git_logging_mock() {
  GIT_LOG="$FIXTURE_ROOT/git.log"
  : > "$GIT_LOG"
  export GIT_LOG
  cat > "$MOCK_BIN/git" <<'GIT'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GIT_LOG"
exec "$REAL_GIT" "$@"
GIT
  chmod +x "$MOCK_BIN/git"
}

test_finish_rejects_out_of_boundary_changes_before_pack_and_push() {
  prepare_change feature
  printf 'outside\n' > "$WORKTREE/outside.txt"
  git -C "$WORKTREE" add outside.txt
  git -C "$WORKTREE" commit --amend -m '[Feature] 添加越界变更' >/dev/null
  install_boundary_aware_npm_mock
  install_git_logging_mock
  if output=$("$FINISH" sqlite '完成变更' "$BODY" 2>&1); then fail 'out-of-boundary change succeeded'; fi
  assert_contains "$output" 'outside kits/sqlite'
  test ! -s "$GH_LOG" || fail 'gh ran after boundary failure'
  npm_log=$(cat "$NPM_LOG")
  assert_contains "$npm_log" 'kit:boundary'
  assert_not_contains "$npm_log" 'kit:check'
  assert_not_contains "$(cat "$GIT_LOG")" 'fetch origin'
}

test_finish_accepts_in_boundary_changes_with_real_gate() {
  prepare_change feature
  git -C "$WORKTREE" rm kits/sqlite/change.txt >/dev/null
  printf '\n' >> "$WORKTREE/kits/sqlite/package.json"
  git -C "$WORKTREE" add kits/sqlite/package.json
  git -C "$WORKTREE" commit --amend -m '[Feature] 添加 Kit 内变更' >/dev/null
  install_boundary_aware_npm_mock
  output=$("$FINISH" sqlite '完成变更' "$BODY")
  assert_contains "$output" 'PR_URL=https://github.com/example/repo/pull/1'
  npm_log=$(cat "$NPM_LOG")
  assert_contains "$npm_log" 'kit:boundary'
  assert_contains "$npm_log" 'kit:check'
}

test_finish_rejects_changed_kit_without_version_increase_before_pack_and_push() {
  prepare_change feature
  set_kit_version "$WORKTREE" 0.1.0-preview.1 preview
  git -C "$WORKTREE" add kits/sqlite
  git -C "$WORKTREE" commit --amend -m '[Feature] 遗漏 Kit 版本升级' >/dev/null
  install_git_logging_mock
  if output=$($FINISH sqlite '完成变更' "$BODY" 2>&1); then fail 'unchanged Kit version succeeded'; fi
  assert_contains "$output" 'must increase from 0.1.0-preview.1'
  assert_not_contains "$(cat "$NPM_LOG")" 'kit:check'
  assert_not_contains "$(cat "$GIT_LOG")" 'push --set-upstream'
  test ! -s "$GH_LOG" || fail 'gh ran after release intent failure'
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
  assert_contains "$output" 'could not inspect Task changes from Git'
  test ! -s "$GH_LOG" || fail 'gh ran for unrelated history'
}

run_finish_tests() {
  run_case 'finish targets main for all types' test_finish_targets_main_for_all_types
  run_case 'finish Task gates precede boundary, pack, push, and PR' test_finish_task_gates_precede_boundary_pack_push_and_pr
  run_case 'finish parses real and fenced Task headings' test_finish_rejects_and_parses_task_headings
  run_case 'finish reuses open PR and reruns without empty commit' test_finish_reuses_open_pr_and_reruns_without_empty_commit
  run_case 'finish recovers after second push failure' test_finish_recovers_after_second_push_failure
  run_case 'finish recovers exact staged status and rejects other dirt' test_finish_recovers_exact_staged_status_and_rejects_other_dirty_state
  run_case 'finish rejects PR number conflicts and multiple PRs' test_finish_rejects_recorded_pr_conflict_and_multiple_prs
  run_case 'finish preserves and refreshes summary SHA safely' test_finish_summary_sha_is_stable_refreshes_and_does_not_trust_title
  run_case 'finish rejects invalid PR verification' test_finish_rejects_invalid_pr_verification
  run_case 'finish requires remote head after second push' test_finish_requires_remote_head_to_match_after_second_push
  run_case 'finish preserves Task and Kit gate order' test_finish_task_and_kit_gate_order
  run_case 'finish rejects wrong Kit, label, state, and identity' test_finish_rejects_wrong_kit_label_state_and_identity
  run_case 'finish runs boundary check before pack and push' test_finish_runs_boundary_check_before_pack_and_push
  run_case 'finish rejects out-of-boundary changes before pack and push' test_finish_rejects_out_of_boundary_changes_before_pack_and_push
  run_case 'finish accepts in-boundary changes with real gate' test_finish_accepts_in_boundary_changes_with_real_gate
  run_case 'finish rejects a changed Kit without a version increase' test_finish_rejects_changed_kit_without_version_increase_before_pack_and_push
  run_case 'finish rejects unrelated history' test_finish_rejects_unrelated_history
}
