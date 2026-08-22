#!/usr/bin/env bash

test_skill_layout_and_contract() {
  skill_file="$SKILL_DIR/SKILL.md"
  metadata_file="$SKILL_DIR/agents/openai.yaml"
  test -f "$skill_file" || fail 'SKILL.md is missing'
  test -f "$metadata_file" || fail 'agents/openai.yaml is missing'
  skill=$(cat "$skill_file")
  assert_contains "$skill" 'name: change-workflow'
  assert_contains "$skill" 'scripts/start-change.sh'
  assert_contains "$skill" 'scripts/integrate-change.sh'
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
  test -x "$SKILL_DIR/scripts/integrate-change.sh" || fail 'integration script is not executable'
  test ! -e "$SKILL_DIR/scripts/$old_finish" || fail 'automatic finish script remains'
  old_finish_test='finish''-change.test.sh'
  test ! -e "$TEST_DIR/$old_finish_test" || fail 'automatic finish tests remain'
}

test_no_automatic_finish_references() {
  if rg -n 'PR_URL=|pr create|pr edit|git .*push' "$SKILL_DIR/scripts" "$SKILL_DIR/SKILL.md"; then
    fail 'skill still contains automatic PR/push workflow references'
  fi
}

run_contract_tests() {
  run_case 'skill layout and explicit integration contract' test_skill_layout_and_contract
  run_case 'no automatic finish references' test_no_automatic_finish_references
}
