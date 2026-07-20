#!/usr/bin/env bash

TEST_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
SKILL_DIR=$(cd "$TEST_DIR/.." && pwd -P)
SOURCE_START="$SKILL_DIR/scripts/start-change.sh"
SOURCE_FINISH="$SKILL_DIR/scripts/finish-change.sh"
ORIGINAL_PATH=$PATH
PASS_COUNT=0
FAIL_COUNT=0

fail() { printf 'FAIL: %s\n' "$*" >&2; return 1; }
assert_contains() { case "$1" in *"$2"*) ;; *) fail "expected [$1] to contain [$2]" ;; esac; }
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
  test ! -f "$SOURCE_START" || cp "$SOURCE_START" "$REPO/.agents/skills/change-workflow/scripts/start-change.sh"
  test ! -f "$SOURCE_FINISH" || cp "$SOURCE_FINISH" "$REPO/.agents/skills/change-workflow/scripts/finish-change.sh"
  printf '.worktrees/\n' > "$REPO/.gitignore"
  printf '{"scripts":{"check":"true"}}\n' > "$REPO/package.json"
  git -C "$REPO" add .
  git -C "$REPO" commit -m '[Init] 初始化测试仓库' >/dev/null
  git -C "$REPO" push -u origin main >/dev/null 2>&1
  git -C "$ORIGIN" symbolic-ref HEAD refs/heads/main
  START="$REPO/.agents/skills/change-workflow/scripts/start-change.sh"
}
