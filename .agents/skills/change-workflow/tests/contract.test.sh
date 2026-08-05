#!/usr/bin/env bash

test_skill_layout_and_contract() {
  skill_file="$SKILL_DIR/SKILL.md"
  metadata_file="$SKILL_DIR/agents/openai.yaml"
  repo_root=$(git -C "$SKILL_DIR" rev-parse --show-toplevel)
  test -f "$skill_file" || fail 'SKILL.md is missing'
  test -f "$metadata_file" || fail 'agents/openai.yaml is missing'
  assert_contains "$(sed -n '1,8p' "$skill_file")" 'name: change-workflow'
  assert_contains "$(cat "$skill_file")" 'scripts/start-change.sh'
  assert_contains "$(cat "$skill_file")" 'scripts/finish-change.sh'
  skill=$(cat "$skill_file")
  assert_contains "$skill" '背景、目标、范围、非目标、验收、约束'
  assert_contains "$skill" 'feature`/`bug`/`optimize`/`docs`/`refactor`/`test`/`chore'
  assert_contains "$skill" '立即填写 `task.md`'
  assert_contains "$skill" '截止时间、负责人授权和已投入时间都不是跳过 Task 的例外'
  assert_contains "$skill" '已有代码但没有 Task'
  assert_contains "$skill" '`.work/` 默认不提交'
  assert_contains "$skill" '`status.json` 只由 `task:status` CLI 管理'
  assert_contains "$skill" '原因猜测、风险判断、交接说明、下一步建议'
  assert_contains "$skill" '先完成 `summary.md`'
  assert_contains "$skill" '`--ready-for-pr`'
  assert_contains "$skill" '不可变 commit'
  assert_contains "$skill" '回写 PR 号、自动提交并二次 push'
  assert_contains "$skill" '`rewind`'
  assert_contains "$skill" 'GitHub PR 已 merged'
  assert_contains "$skill" '最新 head commit 的 repository-required checks 成功'
  assert_contains "$skill" '三份 Task 正式文件已在 `main`'
  assert_contains "$skill" '才能宣布需求完成并归档当前 Codex 会话'
  assert_contains "$skill" '先读 `task.md` 和 `status.json`'
  assert_contains "$skill" '查询 GitHub 实时事实'
  assert_contains "$skill" '跨机或跨环境'
  assert_contains "$skill" '不为会话归档制造合并后 commit'
  assert_contains "$skill" '用户说“完成”不授权 merge'
  assert_contains "$(cat "$metadata_file")" 'display_name: "Change Workflow"'
  grep -Fq '"test:change-workflow"' "$repo_root/package.json" || fail 'new package test script is missing'
  old_skill='feature''-workflow'; old_start='start''-feature'; old_finish='finish''-feature'; old_prefix='codex''/'
  test -z "$(find "$repo_root/.agents/skills/$old_skill" -type f -print 2>/dev/null)" || fail 'old Skill files remain'
  if rg -n "$old_prefix|$old_skill|$old_start|$old_finish" "$repo_root/.agents" "$repo_root/AGENTS.md" "$repo_root/package.json" "$repo_root/docs/guides/development-workflow.md"; then
    fail 'active workflow still references old naming'
  fi
}

run_contract_tests() { run_case 'skill layout and active contract' test_skill_layout_and_contract; }
