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
  assert_contains "$(cat "$metadata_file")" 'display_name: "Change Workflow"'
  grep -Fq '"test:change-workflow"' "$repo_root/package.json" || fail 'new package test script is missing'
  old_skill='feature''-workflow'; old_start='start''-feature'; old_finish='finish''-feature'; old_prefix='codex''/'
  test -z "$(find "$repo_root/.agents/skills/$old_skill" -type f -print 2>/dev/null)" || fail 'old Skill files remain'
  if rg -n "$old_prefix|$old_skill|$old_start|$old_finish" "$repo_root/.agents" "$repo_root/AGENTS.md" "$repo_root/package.json" "$repo_root/docs/guides/development-workflow.md"; then
    fail 'active workflow still references old naming'
  fi
}

run_contract_tests() { run_case 'skill layout and active contract' test_skill_layout_and_contract; }
