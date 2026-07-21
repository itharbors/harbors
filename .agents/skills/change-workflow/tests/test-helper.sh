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

label_for_type() {
  case "$1" in
    feature) printf 'Feature\n' ;; bug) printf 'Bug\n' ;; docs) printf 'Docs\n' ;;
    refactor) printf 'Refactor\n' ;; optimize) printf 'Optimize\n' ;;
    test) printf 'Test\n' ;; chore) printf 'Chore\n' ;; *) fail "unknown type: $1" ;;
  esac
}

install_mocks() {
  MOCK_BIN="$FIXTURE_ROOT/mock-bin"; GH_LOG="$FIXTURE_ROOT/gh.log"; NPM_LOG="$FIXTURE_ROOT/npm.log"
  mkdir -p "$MOCK_BIN"; : > "$GH_LOG"; : > "$NPM_LOG"; export GH_LOG NPM_LOG
  printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >> "$NPM_LOG"\ntest "${NPM_FAIL:-0}" != 1\n' > "$MOCK_BIN/npm"
  printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\n" "$*" >> "$GH_LOG"' \
    'case "$1 $2" in' \
    "'auth status') test \"\${GH_AUTH_FAIL:-0}\" != 1 ;;" \
    "'pr create') printf '%s\\n' 'https://github.com/example/repo/pull/1' ;;" \
    "'pr view') printf '%s\\t%s\\t%s\\t%s\\n' \"\${GH_VIEW_BASE:-main}\" \"\${GH_VIEW_HEAD:-\$(git branch --show-current)}\" \"\${GH_VIEW_STATE:-OPEN}\" \"\${GH_VIEW_URL:-https://github.com/example/repo/pull/1}\" ;;" \
    '*) exit 2 ;;' 'esac' > "$MOCK_BIN/gh"
  chmod +x "$MOCK_BIN/npm" "$MOCK_BIN/gh"
  export PATH="$MOCK_BIN:$ORIGINAL_PATH"
}

prepare_change() {
  local type=${1:-feature}
  new_fixture
  "$START" "$type" finish-case >/dev/null
  WORKTREE="$REPO/.worktrees/$type-finish-case"
  FINISH="$WORKTREE/.agents/skills/change-workflow/scripts/finish-change.sh"
  printf 'change\n' > "$WORKTREE/change.txt"
  git -C "$WORKTREE" add change.txt
  git -C "$WORKTREE" commit -m "[$(label_for_type "$type")] 添加测试变更" >/dev/null
  BODY="$FIXTURE_ROOT/pr-body.md"
  printf '## Summary\n\nChange.\n\n## Testing\n\n- npm run check\n' > "$BODY"
  install_mocks
}
