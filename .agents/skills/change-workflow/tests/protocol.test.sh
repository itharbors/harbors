#!/usr/bin/env bash

if test -z "${SKILL_DIR:-}"; then
  TEST_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
  . "$TEST_DIR/test-helper.sh"
fi

test_protocol_references_exist() {
  for reference in protocol.md environment-selection.md execution-plan.md consolidation.md; do
    test -f "$SKILL_DIR/references/$reference" || fail "missing reference: $reference"
  done
}

test_stage_packet_is_minimal_and_structured() {
  protocol=$(cat "$SKILL_DIR/references/protocol.md")
  for field in protocol_version task stage work_unit objective workspace allowed_paths inputs acceptance stop_conditions; do
    assert_contains "$protocol" "\`$field\`"
  done
  for unit in plan review implementation code-review verification repair summary knowledge-extraction retrieval-review; do
    assert_contains "$protocol" "\`$unit\`"
  done
  assert_contains "$protocol" '只传递当前 work unit 所需的最小消息'
  assert_contains "$protocol" '不得放入完整会话记录'
}

test_stage_result_has_evidence_and_issue_contract() {
  protocol=$(cat "$SKILL_DIR/references/protocol.md")
  for field in recommendation artifacts evidence issues decision_candidates follow_up next_action; do
    assert_contains "$protocol" "\`$field\`"
  done
  for outcome in completed needs_repair blocked not_applicable; do
    assert_contains "$protocol" "\`$outcome\`"
  done
  assert_contains "$protocol" 'sub-agent 不得修改 `status.json`'
  assert_contains "$protocol" '主 Agent 必须检查返回值与实际 diff'
  assert_contains "$protocol" '记录后续建议或另一个 Task'
  assert_contains "$protocol" 'category` 是唯一的阻塞判断来源'
  assert_contains "$protocol" '`issues` 是 `{category, summary, evidence}` 数组'
  assert_not_contains "$protocol" '{category, summary, evidence, blocking}'
  assert_contains "$protocol" '不能用来表示未运行、工具不可用、缺少输入或暂时失败'
  assert_contains "$protocol" '通过 Task CLI 明确 skip'
}

test_environment_is_selected_after_task_definition() {
  environment=$(cat "$SKILL_DIR/references/environment-selection.md")
  assert_contains "$environment" 'Task 定义完成、`requirements` 已终态后'
  assert_contains "$environment" '固定询问一次'
  assert_contains "$environment" '`current`'
  assert_contains "$environment" '`worktree`'
  assert_contains "$environment" '`current <task-id>`'
  assert_contains "$environment" '`worktree <task-id>`'
  assert_contains "$environment" '本地 `main` 的 HEAD'
  assert_contains "$environment" '不要静默改用 `origin/main`'
  assert_contains "$environment" '保留用户改动'
  assert_contains "$environment" '拒绝 detached HEAD'
  assert_contains "$environment" 'dirty_policy` 为 `preserve`'
  assert_contains "$environment" '首个纳入 Task 正式文件的提交'
  assert_contains "$environment" 'clean-required'
}

test_execution_plan_maps_existing_stages() {
  execution=$(cat "$SKILL_DIR/references/execution-plan.md")
  assert_contains "$execution" 'plan → review → implementation → code-review → verification → repair'
  assert_contains "$execution" '这些是 work unit，不是新的 Task stages'
  for stage in design implementation verification; do
    assert_contains "$execution" "\`$stage\`"
  done
  assert_contains "$execution" '最多自动修复两轮'
  assert_contains "$execution" '仍失败则返回 `blocked`'
  assert_contains "$execution" '重新调度 `implementation` work unit 在 `implementation` stage 修复'
  assert_contains "$execution" 'verification 失败时才可调度 `repair`'
  assert_contains "$execution" '主 Agent 应 rewind `implementation`'
  assert_contains "$execution" '`not_applicable` 不是“未运行”或“无法完成”'
  assert_contains "$execution" '主 Agent 才能记录 skip'
}

test_consolidation_reports_all_four_categories() {
  consolidation=$(cat "$SKILL_DIR/references/consolidation.md")
  for category in blocking non_blocking decision_candidates follow_up; do
    assert_contains "$consolidation" "\`$category\`"
  done
  assert_contains "$consolidation" '默认自动执行'
  assert_contains "$consolidation" '阻止 ready 或收口'
  assert_contains "$consolidation" '不阻止自动收口'
  assert_contains "$consolidation" '必须由 approver 明确批准'
}

run_protocol_tests() {
  run_case 'protocol references exist' test_protocol_references_exist
  run_case 'StagePacket is minimal and structured' test_stage_packet_is_minimal_and_structured
  run_case 'StageResult carries evidence and issue categories' test_stage_result_has_evidence_and_issue_contract
  run_case 'environment selection follows Task definition' test_environment_is_selected_after_task_definition
  run_case 'execution plan maps existing stages' test_execution_plan_maps_existing_stages
  run_case 'consolidation reports four categories' test_consolidation_reports_all_four_categories
}

if test "${BASH_SOURCE[0]}" = "$0"; then
  run_protocol_tests
  printf '%s passed, %s failed\n' "$PASS_COUNT" "$FAIL_COUNT"
  test "$FAIL_COUNT" -eq 0
fi
