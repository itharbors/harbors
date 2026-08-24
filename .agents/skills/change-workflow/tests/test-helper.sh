#!/usr/bin/env bash

TEST_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
SKILL_DIR=$(cd "$TEST_DIR/.." && pwd -P)
SOURCE_START="$SKILL_DIR/scripts/start-change.sh"
SOURCE_INTEGRATE="$SKILL_DIR/scripts/integrate-change.sh"
SOURCE_REPO_ROOT=$(git -C "$SKILL_DIR" rev-parse --show-toplevel)
SOURCE_TASK_CLI="$SOURCE_REPO_ROOT/scripts/task-status.mjs"
SOURCE_TASK_DOMAIN="$SOURCE_REPO_ROOT/scripts/lib/task-status.mjs"
SOURCE_TASK_SCHEMA="$SOURCE_REPO_ROOT/docs/tasks/status.schema.json"
ORIGINAL_PATH=$PATH
ORIGINAL_TMPDIR=${TMPDIR:-/tmp}
PASS_COUNT=0
FAIL_COUNT=0

fail() { printf 'FAIL: %s\n' "$*" >&2; return 1; }
assert_contains() { case "$1" in *"$2"*) ;; *) fail "expected [$1] to contain [$2]" ;; esac; }
assert_not_contains() { case "$1" in *"$2"*) fail "expected [$1] not to contain [$2]" ;; *) ;; esac; }
assert_eq() { test "$1" = "$2" || fail "expected [$2], got [$1]"; }

run_case() {
  local name=$1 status
  shift
  set +e
  (set -e; "$@")
  status=$?
  set -e
  if test "$status" -eq 0; then PASS_COUNT=$((PASS_COUNT + 1)); printf 'PASS: %s\n' "$name"
  else FAIL_COUNT=$((FAIL_COUNT + 1)); printf 'FAIL: %s\n' "$name" >&2; fi
}

new_fixture() {
  export PATH="$ORIGINAL_PATH" TMPDIR="$ORIGINAL_TMPDIR"
  FIXTURE_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/change-workflow.XXXXXX")
  FIXTURE_ROOT=$(cd "$FIXTURE_ROOT" && pwd -P)
  ORIGIN="$FIXTURE_ROOT/origin.git"
  REPO="$FIXTURE_ROOT/repo"
  git init --bare "$ORIGIN" >/dev/null
  git clone "$ORIGIN" "$REPO" >/dev/null 2>&1
  REPO=$(cd "$REPO" && pwd -P)
  git -C "$REPO" config user.name 'Change Workflow Test'
  git -C "$REPO" config user.email 'change-workflow@example.com'
  git -C "$REPO" checkout -b main >/dev/null 2>&1
  mkdir -p "$REPO/.agents/skills/change-workflow/scripts" "$REPO/scripts/lib" "$REPO/docs/tasks"
  cp "$SOURCE_START" "$REPO/.agents/skills/change-workflow/scripts/start-change.sh"
  cp "$SOURCE_INTEGRATE" "$REPO/.agents/skills/change-workflow/scripts/integrate-change.sh"
  cp "$SOURCE_TASK_CLI" "$REPO/scripts/task-status.mjs"
  cp "$SOURCE_TASK_DOMAIN" "$REPO/scripts/lib/task-status.mjs"
  cp "$SOURCE_TASK_SCHEMA" "$REPO/docs/tasks/status.schema.json"
  chmod +x "$REPO/.agents/skills/change-workflow/scripts/"*.sh
  printf '.worktrees/\n' > "$REPO/.gitignore"
  printf '{"scripts":{"check":"true"}}\n' > "$REPO/package.json"
  git -C "$REPO" add .
  git -C "$REPO" commit -m '[Init] 初始化测试仓库' >/dev/null
  git -C "$REPO" push -u origin main >/dev/null 2>&1
  git -C "$ORIGIN" symbolic-ref HEAD refs/heads/main
  START="$REPO/.agents/skills/change-workflow/scripts/start-change.sh"
  INTEGRATE="$REPO/.agents/skills/change-workflow/scripts/integrate-change.sh"
}

label_for_type() {
  case "$1" in
    feature) printf 'Feature\n' ;; bug) printf 'Bug\n' ;; docs) printf 'Docs\n' ;;
    refactor) printf 'Refactor\n' ;; optimize) printf 'Optimize\n' ;;
    test) printf 'Test\n' ;; chore) printf 'Chore\n' ;; *) fail "unknown type: $1" ;;
  esac
}

prepare_change() {
  local type=${1:-feature}
  new_fixture
  TASK_ID=$(cd "$REPO" && node scripts/task-status.mjs init "$type" integration-case)
  TASK_DIR="$REPO/docs/tasks/$TASK_ID"
  cat > "$TASK_DIR/task.md" <<EOF
# $TASK_ID

Task ID: \`$TASK_ID\`
Type: \`$type\`

## 背景与问题

测试背景。

## 目标

验证本地整合流程。

## 范围

测试仓库。

## 非目标

真实网络。

## 验收标准

测试通过。

## 约束

只读源 worktree，不自动解决冲突。

## 需求变更

无。
EOF
  start_output=$($START worktree "$TASK_ID" 2>/dev/null)
  WORKTREE="$REPO/.worktrees/$type-integration-case"
  TASK_DIR="$WORKTREE/docs/tasks/$TASK_ID"
  cat > "$TASK_DIR/summary.md" <<'EOF'
# 测试总结

## 最终结论

完成。

## 需求完成情况

已完成。

## 主要改动

测试变更。

## 关键决定

使用临时 Git。

## 验证结果

通过。

## 影响与风险

无。

## 偏差与遗留

无。

## 后续关注

无。

## 相关正式文档

无。
EOF
  (cd "$WORKTREE" &&
    node scripts/task-status.mjs complete "$TASK_ID" design >/dev/null &&
    node scripts/task-status.mjs start "$TASK_ID" implementation >/dev/null &&
    node scripts/task-status.mjs complete "$TASK_ID" implementation >/dev/null &&
    node scripts/task-status.mjs start "$TASK_ID" verification >/dev/null &&
    node scripts/task-status.mjs complete "$TASK_ID" verification >/dev/null &&
    node scripts/task-status.mjs start "$TASK_ID" consolidation >/dev/null &&
    node scripts/task-status.mjs complete "$TASK_ID" consolidation >/dev/null)
  printf 'change\n' > "$WORKTREE/change.txt"
  git -C "$WORKTREE" add change.txt "docs/tasks/$TASK_ID"
  git -C "$WORKTREE" commit -m "[$(label_for_type "$type")] 添加测试变更" >/dev/null
}
