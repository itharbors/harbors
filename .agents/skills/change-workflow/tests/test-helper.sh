#!/usr/bin/env bash

TEST_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
SKILL_DIR=$(cd "$TEST_DIR/.." && pwd -P)
SOURCE_START="$SKILL_DIR/scripts/start-change.sh"
SOURCE_FINISH="$SKILL_DIR/scripts/finish-change.sh"
SOURCE_REPO_ROOT=$(git -C "$SKILL_DIR" rev-parse --show-toplevel)
SOURCE_TASK_CLI="$SOURCE_REPO_ROOT/scripts/task-status.mjs"
SOURCE_TASK_DOMAIN="$SOURCE_REPO_ROOT/scripts/lib/task-status.mjs"
SOURCE_TASK_SCHEMA="$SOURCE_REPO_ROOT/docs/tasks/status.schema.json"
ORIGINAL_PATH=$PATH
ORIGINAL_TMPDIR=${TMPDIR:-/tmp}
REAL_GIT=$(command -v git)
REAL_NODE=$(command -v node)
PASS_COUNT=0
FAIL_COUNT=0

fail() { printf 'FAIL: %s\n' "$*" >&2; return 1; }
assert_contains() { case "$1" in *"$2"*) ;; *) fail "expected [$1] to contain [$2]" ;; esac; }
assert_not_contains() { case "$1" in *"$2"*) fail "expected [$1] not to contain [$2]" ;; *) ;; esac; }
assert_eq() { test "$1" = "$2" || fail "expected [$2], got [$1]"; }
assert_ref_missing() { git -C "$1" show-ref --verify --quiet "$2" && fail "expected ref to be missing: $2" || true; }

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
  unset NPM_FAIL GH_AUTH_FAIL GH_OPEN_PR_COUNT GH_REPO_OWNER GH_LIST_URL GH_VIEW_NUMBER GH_VIEW_BASE GH_VIEW_HEAD GH_VIEW_STATE GH_VIEW_URL GH_VIEW_HEAD_OID GH_VIEW_CROSS_REPOSITORY GH_VIEW_HEAD_OWNER GH_VIEW_MERGED_AT GH_FORK_URL GH_REPLACEMENT_MODE GH_OLD_PR_STATE GH_OLD_PR_MERGED_AT GH_CREATE_URL GIT_FAIL_PUSH_NUMBER GIT_CONFIG_GLOBAL
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
  mkdir -p "$REPO/.agents/skills/change-workflow/scripts"
  mkdir -p "$REPO/scripts/lib" "$REPO/docs/tasks"
  test ! -f "$SOURCE_START" || cp "$SOURCE_START" "$REPO/.agents/skills/change-workflow/scripts/start-change.sh"
  test ! -f "$SOURCE_FINISH" || cp "$SOURCE_FINISH" "$REPO/.agents/skills/change-workflow/scripts/finish-change.sh"
  cp "$SOURCE_TASK_CLI" "$REPO/scripts/task-status.mjs"
  cp "$SOURCE_TASK_DOMAIN" "$REPO/scripts/lib/task-status.mjs"
  cp "$SOURCE_TASK_SCHEMA" "$REPO/docs/tasks/status.schema.json"
  printf '.worktrees/\n' > "$REPO/.gitignore"
  printf '{"scripts":{"check":"true"}}\n' > "$REPO/package.json"
  git -C "$REPO" add .
  git -C "$REPO" commit -m '[Init] 初始化测试仓库' >/dev/null
  git -C "$REPO" push -u origin main >/dev/null 2>&1
  git -C "$ORIGIN" symbolic-ref HEAD refs/heads/main
  START="$REPO/.agents/skills/change-workflow/scripts/start-change.sh"
}

label_for_type() {
  case "$1" in
    feature) printf 'Feature\n' ;; bug) printf 'Bug\n' ;; docs) printf 'Docs\n' ;;
    refactor) printf 'Refactor\n' ;; optimize) printf 'Optimize\n' ;;
    test) printf 'Test\n' ;; chore) printf 'Chore\n' ;; *) fail "unknown type: $1" ;;
  esac
}

install_mocks() {
  MOCK_BIN="$FIXTURE_ROOT/mock-bin"
  GH_LOG="$FIXTURE_ROOT/gh.log"
  NPM_LOG="$FIXTURE_ROOT/npm.log"
  NODE_LOG="$FIXTURE_ROOT/node.log"
  PUSH_LOG="$FIXTURE_ROOT/push.log"
  EVENTS_LOG="$FIXTURE_ROOT/events.log"
  GH_CREATE_LOG="$FIXTURE_ROOT/gh-create.log"
  GH_EDIT_LOG="$FIXTURE_ROOT/gh-edit.log"
  GH_BODY="$FIXTURE_ROOT/final-pr-body.md"
  GH_CREATED="$FIXTURE_ROOT/gh-created"
  mkdir -p "$MOCK_BIN" "$FIXTURE_ROOT/tmp"
  : > "$GH_LOG"; : > "$NPM_LOG"; : > "$NODE_LOG"; : > "$PUSH_LOG"; : > "$EVENTS_LOG"
  : > "$GH_CREATE_LOG"; : > "$GH_EDIT_LOG"
  export REAL_GIT REAL_NODE GH_LOG NPM_LOG NODE_LOG PUSH_LOG EVENTS_LOG GH_CREATE_LOG GH_EDIT_LOG GH_BODY GH_CREATED
  export TMPDIR="$FIXTURE_ROOT/tmp"
  cat > "$MOCK_BIN/git" <<'EOF'
#!/usr/bin/env bash
for argument in "$@"; do
  if test "$argument" = push; then
    printf '%s\n' "$*" >> "$PUSH_LOG"
    printf 'push %s\n' "$*" >> "$EVENTS_LOG"
    push_number=$(wc -l < "$PUSH_LOG" | tr -d ' ')
    if test "${GIT_FAIL_PUSH_NUMBER:-0}" = "$push_number"; then exit 1; fi
    break
  fi
done
exec "$REAL_GIT" "$@"
EOF
  cat > "$MOCK_BIN/node" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$NODE_LOG"
printf 'node %s\n' "$*" >> "$EVENTS_LOG"
exec "$REAL_NODE" "$@"
EOF
  cat > "$MOCK_BIN/npm" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$NPM_LOG"
printf 'npm %s\n' "$*" >> "$EVENTS_LOG"
test "${NPM_FAIL:-0}" != 1
EOF
  cat > "$MOCK_BIN/gh" <<'EOF'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$GH_LOG"
printf 'gh %s\n' "$*" >> "$EVENTS_LOG"

argument_after() {
  local wanted=$1 previous='' argument
  shift
  for argument in "$@"; do
    if test "$previous" = "$wanted"; then printf '%s\n' "$argument"; return 0; fi
    previous=$argument
  done
  return 1
}

case "$1 $2" in
  'auth status') test "${GH_AUTH_FAIL:-0}" != 1 ;;
  'repo view') printf '%s\n' "${GH_REPO_OWNER-example/repo}" ;;
  'pr list')
    test "$3" = --state && test "$4" = open && test "$5" = --head
    test "$6" = "$(git branch --show-current)"
    count=${GH_OPEN_PR_COUNT:-0}
    test ! -f "$GH_CREATED" || count=1
    case "$count" in
      0) ;;
      1) printf '%s\n' "${GH_LIST_URL-${GH_VIEW_URL-https://github.com/example/repo/pull/1}}" ;;
      2) printf '%s\n%s\n' 'https://github.com/example/repo/pull/1' 'https://github.com/example/repo/pull/2' ;;
      *) exit 2 ;;
    esac
    ;;
  'pr create')
    body_file=$(argument_after --body-file "$@")
    cp "$body_file" "$GH_BODY"
    printf '%s\n' "$*" >> "$GH_CREATE_LOG"
    : > "$GH_CREATED"
    printf '%s\n' "${GH_CREATE_URL-https://github.com/example/repo/pull/1}"
    ;;
  'pr edit')
    body_file=$(argument_after --body-file "$@")
    cp "$body_file" "$GH_BODY"
    printf '%s\n' "$*" >> "$GH_EDIT_LOG"
    ;;
  'pr view')
    target=${3:-}
    number=${GH_VIEW_NUMBER-1}
    base=${GH_VIEW_BASE-main}
    head=${GH_VIEW_HEAD-$(git branch --show-current)}
    state=${GH_VIEW_STATE-OPEN}
    case "$target" in https://*) default_url=$target ;; *) default_url=https://github.com/example/repo/pull/1 ;; esac
    url=${GH_VIEW_URL-$default_url}
    head_oid=${GH_VIEW_HEAD_OID-$(git rev-parse HEAD)}
    cross_repository=${GH_VIEW_CROSS_REPOSITORY-false}
    head_owner=${GH_VIEW_HEAD_OWNER-example}
    merged_at=${GH_VIEW_MERGED_AT-}
    if test "${GH_REPLACEMENT_MODE:-0}" = 1; then
      case "$target" in
        1|*/pull/1) number=1; state=${GH_OLD_PR_STATE-CLOSED}; url=https://github.com/example/repo/pull/1; merged_at=${GH_OLD_PR_MERGED_AT-} ;;
        2|*/pull/2) number=2; state=OPEN; url=https://github.com/example/repo/pull/2; merged_at='' ;;
      esac
    fi
    if test -n "${GH_FORK_URL:-}" && test "$target" = "$GH_FORK_URL"; then
      cross_repository=true
      head_owner=fork-owner
    fi
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$number" "$base" "$head" "$state" "$url" "$head_oid" "$cross_repository" "$head_owner" "$merged_at"
    ;;
  *) exit 2 ;;
esac
EOF
  chmod +x "$MOCK_BIN/git" "$MOCK_BIN/node" "$MOCK_BIN/npm" "$MOCK_BIN/gh"
  export PATH="$MOCK_BIN:$ORIGINAL_PATH"
}

prepare_change() {
  local type=${1:-feature}
  new_fixture
  local start_output
  start_output=$("$START" "$type" finish-case)
  WORKTREE="$REPO/.worktrees/$type-finish-case"
  FINISH="$WORKTREE/.agents/skills/change-workflow/scripts/finish-change.sh"
  TASK_ID=$(printf '%s\n' "$start_output" | sed -n 's/^TASK_ID=//p')
  TASK_DIR="$WORKTREE/docs/tasks/$TASK_ID"
  cat > "$TASK_DIR/task.md" <<EOF
# $TASK_ID

Task ID: \`$TASK_ID\`
Type: \`$type\`

## 背景与问题

测试背景。

## 目标

验证流程。

## 范围

测试仓库。

## 非目标

真实网络。

## 验收标准

测试通过。

## 约束

使用 mock GitHub。

## 需求变更

无。
EOF
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
  BODY="$FIXTURE_ROOT/pr-body.md"
  printf '## Summary\n\nChange.\n\n## Testing\n\n- npm run check\n' > "$BODY"
  install_mocks
}
