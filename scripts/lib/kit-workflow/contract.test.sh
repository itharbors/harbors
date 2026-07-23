#!/usr/bin/env bash

test_skill_layout_and_contract() {
  test -f "$SKILL_SOURCE/SKILL.md" || fail 'SKILL.md is missing'
  test -f "$SKILL_SOURCE/agents/openai.yaml" || fail 'agents/openai.yaml is missing'
  test -x "$SOURCE_START" || fail 'start-kit-change.sh is missing or not executable'
  test -x "$SOURCE_FINISH" || fail 'finish-kit-change.sh is missing or not executable'
  test -x "$SOURCE_RELEASE" || fail 'release-kit.sh is missing or not executable'
  assert_contains "$(sed -n '1,8p' "$SKILL_SOURCE/SKILL.md")" 'name: kit-workflow'
  assert_contains "$(cat "$SKILL_SOURCE/SKILL.md")" 'origin/kit/<kit>'
  assert_contains "$(cat "$SKILL_SOURCE/agents/openai.yaml")" 'display_name: "Kit Workflow"'
  grep -Fq '"test:kit-workflow"' "$REPO_SOURCE/package.json" || fail 'package test script is missing'
}

run_contract_tests() { run_case 'skill layout and active contract' test_skill_layout_and_contract; }
