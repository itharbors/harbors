#!/usr/bin/env bash

if test -z "${SKILL_DIR:-}"; then
  TEST_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
  . "$TEST_DIR/test-helper.sh"
fi

test_skill_layout_and_contract() {
  skill_file="$SKILL_DIR/SKILL.md"
  metadata_file="$SKILL_DIR/agents/openai.yaml"
  test -f "$skill_file" || fail 'SKILL.md is missing'
  test -f "$metadata_file" || fail 'agents/openai.yaml is missing'
  skill=$(cat "$skill_file")
  assert_contains "$skill" 'name: change-workflow'
  assert_contains "$skill" '定义任务'
  assert_contains "$skill" '工作环境确认'
  assert_contains "$skill" '执行计划'
  assert_contains "$skill" '总结沉淀'
  assert_contains "$skill" '交付处理'
  assert_contains "$skill" 'Task 定义后'
  assert_contains "$skill" 'current'
  assert_contains "$skill" 'worktree'
  assert_contains "$skill" '本地 `main` HEAD'
  assert_contains "$skill" 'requirements'
  assert_contains "$skill" 'design'
  assert_contains "$skill" 'implementation'
  assert_contains "$skill" 'verification'
  assert_contains "$skill" 'consolidation'
  assert_contains "$skill" 'StagePacket'
  assert_contains "$skill" 'StageResult'
  assert_contains "$skill" 'blocking'
  assert_contains "$skill" 'non_blocking'
  assert_contains "$skill" 'decision_candidates'
  assert_contains "$skill" 'follow_up'
  assert_contains "$skill" 'references/protocol.md'
  assert_contains "$skill" 'references/environment-selection.md'
  assert_contains "$skill" 'references/execution-plan.md'
  assert_contains "$skill" 'references/consolidation.md'
  assert_contains "$skill" 'current <task-id>'
  assert_contains "$skill" 'worktree <task-id>'
  assert_contains "$skill" '不新增状态'
  assert_contains "$skill" '主 Agent 独占'
  assert_contains "$skill" 'scripts/integrate-change.sh'
  assert_not_contains "$skill" 'scripts/start-change.sh'
  assert_not_contains "$skill" 'type/slug'
  assert_contains "$skill" 'ff 不传标题'
  old_finish='finish''-change.sh'
  assert_not_contains "$skill" "scripts/$old_finish"
  assert_contains "$skill" '背景、目标、范围、非目标、验收、约束'
  assert_contains "$skill" '完成 `summary.md`'
  assert_contains "$skill" '必须停止'
  assert_contains "$skill" 'A 创建 PR'
  assert_contains "$skill" 'B 整合到本地 `main`'
  assert_contains "$skill" 'C 暂不处理'
  assert_contains "$skill" '分别获得 push 和 `gh`'
  assert_contains "$skill" 'ff`、merge commit 或 squash'
  assert_contains "$skill" 'merge commit 与 squash 都必须提供'
  assert_contains "$skill" '不 push、不创建 PR、不删除分支或 worktree、不自动解决冲突'
  assert_contains "$skill" '用户说“完成”不授权'
  assert_not_contains "$(cat "$metadata_file")" 'finish isolated'
  assert_contains "$(cat "$metadata_file")" '编排 Harbors Task'
  test -x "$SKILL_DIR/scripts/integrate-change.sh" || fail 'integration script is not executable'
  test ! -e "$SKILL_DIR/scripts/$old_finish" || fail 'automatic finish script remains'
  old_finish_test='finish''-change.test.sh'
  test ! -e "$TEST_DIR/$old_finish_test" || fail 'automatic finish tests remain'
}

test_no_independent_stage_skill() {
  test ! -e "$SKILL_DIR/stages" || fail 'independent stage skill directory remains'
  test ! -e "$SKILL_DIR/plan" || fail 'independent plan skill remains'
  test ! -e "$SKILL_DIR/implementation" || fail 'independent implementation skill remains'
}

test_no_automatic_finish_references() {
  if rg -n 'PR_URL=|pr create|pr edit|git .*push' "$SKILL_DIR/scripts" "$SKILL_DIR/SKILL.md"; then
    fail 'skill still contains automatic PR/push workflow references'
  fi
}

run_contract_tests() {
  run_case 'skill layout and explicit integration contract' test_skill_layout_and_contract
  run_case 'one main skill with references only' test_no_independent_stage_skill
  run_case 'no automatic finish references' test_no_automatic_finish_references
}

if test "${BASH_SOURCE[0]}" = "$0"; then
  run_contract_tests
  printf '%s passed, %s failed\n' "$PASS_COUNT" "$FAIL_COUNT"
  test "$FAIL_COUNT" -eq 0
fi
