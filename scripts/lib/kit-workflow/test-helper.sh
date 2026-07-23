#!/usr/bin/env bash

TEST_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
REPO_SOURCE=$(git -C "$TEST_DIR" rev-parse --show-toplevel)
SKILL_SOURCE="$REPO_SOURCE/.agents/skills/kit-workflow"
SOURCE_START="$SKILL_SOURCE/scripts/start-kit-change.sh"
SOURCE_FINISH="$SKILL_SOURCE/scripts/finish-kit-change.sh"
SOURCE_RELEASE="$SKILL_SOURCE/scripts/release-kit.sh"
SOURCE_LIB="$SKILL_SOURCE/scripts/_kit-workflow-lib.sh"
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
  if test "$status" -eq 0; then
    PASS_COUNT=$((PASS_COUNT + 1)); printf 'PASS: %s\n' "$name"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1)); printf 'FAIL: %s\n' "$name" >&2
  fi
}

write_product_files() {
  local directory=$1 kit=${2:-sqlite} version=${3:-0.1.0-preview.1} channel=${4:-preview}
  mkdir -p "$directory/.agents/skills/kit-workflow/scripts"
  test ! -f "$SOURCE_LIB" || cp "$SOURCE_LIB" "$directory/.agents/skills/kit-workflow/scripts/_kit-workflow-lib.sh"
  test ! -f "$SOURCE_START" || cp "$SOURCE_START" "$directory/.agents/skills/kit-workflow/scripts/start-kit-change.sh"
  test ! -f "$SOURCE_FINISH" || cp "$SOURCE_FINISH" "$directory/.agents/skills/kit-workflow/scripts/finish-kit-change.sh"
  test ! -f "$SOURCE_RELEASE" || cp "$SOURCE_RELEASE" "$directory/.agents/skills/kit-workflow/scripts/release-kit.sh"
  printf '%s\n' \
    '{' \
    "  \"name\": \"@itharbors/kit-$kit\"," \
    "  \"version\": \"$version\"," \
    '  "private": true,' \
    '  "scripts": {' \
    '    "check": "true",' \
    '    "kit:validate": "true",' \
    '    "kit:pack": "true"' \
    '  },' \
    '  "engines": { "node": "22.18.0", "npm": "10.9.3" },' \
    '  "harbors": { "kitCli": "0.0.1" },' \
    '  "devDependencies": { "@itharbors/kit-cli": "0.0.1" }' \
    '}' > "$directory/package.json"
  printf '%s\n' \
    '{' \
    "  \"name\": \"@itharbors/kit-$kit\"," \
    "  \"version\": \"$version\"," \
    '  "lockfileVersion": 3,' \
    '  "requires": true,' \
    '  "packages": {' \
    '    "": {' \
    "      \"name\": \"@itharbors/kit-$kit\"," \
    "      \"version\": \"$version\"," \
    '      "devDependencies": { "@itharbors/kit-cli": "0.0.1" },' \
    '      "engines": { "node": "22.18.0", "npm": "10.9.3" }' \
    '    },' \
    '    "node_modules/@itharbors/kit-cli": {' \
    '      "version": "0.0.1",' \
    '      "resolved": "https://registry.npmjs.org/@itharbors/kit-cli/-/kit-cli-0.0.1.tgz",' \
    '      "integrity": "sha512-test"' \
    '    }' \
    '  }' \
    '}' > "$directory/package-lock.json"
  printf '%s\n' \
    '{' \
    '  "schemaVersion": 1,' \
    "  \"id\": \"@itharbors/kit-$kit\"," \
    "  \"version\": \"$version\"," \
    "  \"channel\": \"$channel\"," \
    '  "publisher": "itharbors",' \
    '  "requires": { "harbors": ">=0.0.1", "kitApi": "^1.0.0", "protocolVersion": 1 },' \
    '  "target": { "platform": "any", "arch": "any" },' \
    '  "permissions": ["filesystem"],' \
    '  "entry": "package.json"' \
    '}' > "$directory/kit.json"
}

new_fixture() {
  FIXTURE_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/kit-workflow.XXXXXX")
  FIXTURE_ROOT=$(cd "$FIXTURE_ROOT" && pwd -P)
  ORIGIN="$FIXTURE_ROOT/origin.git"
  REPO="$FIXTURE_ROOT/repo"
  git init --bare "$ORIGIN" >/dev/null
  git clone "$ORIGIN" "$REPO" >/dev/null 2>&1
  REPO=$(cd "$REPO" && pwd -P)
  git -C "$REPO" config user.name 'Kit Workflow Test'
  git -C "$REPO" config user.email 'kit-workflow@example.com'
  git -C "$REPO" checkout -b main >/dev/null 2>&1
  write_product_files "$REPO"
  printf '.worktrees/\n' > "$REPO/.gitignore"
  git -C "$REPO" add .
  git -C "$REPO" commit -m '[Init] 初始化测试仓库' >/dev/null
  git -C "$REPO" push -u origin main >/dev/null 2>&1
  git -C "$ORIGIN" symbolic-ref HEAD refs/heads/main

  PRODUCT="$FIXTURE_ROOT/product"
  git clone "$ORIGIN" "$PRODUCT" >/dev/null 2>&1
  git -C "$PRODUCT" config user.name 'Kit Workflow Test'
  git -C "$PRODUCT" config user.email 'kit-workflow@example.com'
  git -C "$PRODUCT" checkout --orphan kit/sqlite >/dev/null 2>&1
  git -C "$PRODUCT" rm -rf . >/dev/null 2>&1 || true
  write_product_files "$PRODUCT"
  git -C "$PRODUCT" add .
  git -C "$PRODUCT" commit -m '[Init] 初始化 SQLite Kit' >/dev/null
  git -C "$PRODUCT" push -u origin kit/sqlite >/dev/null 2>&1
  git -C "$REPO" fetch origin >/dev/null 2>&1
  START="$REPO/.agents/skills/kit-workflow/scripts/start-kit-change.sh"
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
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'printf "%s\n" "$*" >> "$NPM_LOG"' \
    'if test "${1:-}" = --version; then printf "10.9.3\n"; exit 0; fi' \
    'test "${NPM_FAIL:-0}" != 1' > "$MOCK_BIN/npm"
  printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\n" "$*" >> "$GH_LOG"' \
    'case "$1 $2" in' \
    "'auth status') test \"\${GH_AUTH_FAIL:-0}\" != 1 ;;" \
    "'pr create') printf '%s\\n' 'https://github.com/example/repo/pull/1' ;;" \
    "'pr view') printf '%s\\t%s\\t%s\\t%s\\n' \"\${GH_VIEW_BASE:-kit/sqlite}\" \"\${GH_VIEW_HEAD:-\$(git branch --show-current)}\" \"\${GH_VIEW_STATE:-OPEN}\" \"\${GH_VIEW_URL:-https://github.com/example/repo/pull/1}\" ;;" \
    '*) exit 2 ;;' 'esac' > "$MOCK_BIN/gh"
  chmod +x "$MOCK_BIN/npm" "$MOCK_BIN/gh"
  export PATH="$MOCK_BIN:$ORIGINAL_PATH"
}

prepare_change() {
  local type=${1:-feature}
  new_fixture
  install_mocks
  "$START" sqlite "$type" finish-case >/dev/null
  WORKTREE="$REPO/.worktrees/kit-sqlite-$type-finish-case"
  FINISH="$WORKTREE/.agents/skills/kit-workflow/scripts/finish-kit-change.sh"
  printf 'change\n' > "$WORKTREE/change.txt"
  git -C "$WORKTREE" add change.txt
  git -C "$WORKTREE" commit -m "[$(label_for_type "$type")] 添加测试变更" >/dev/null
  BODY="$FIXTURE_ROOT/pr-body.md"
  printf '## Summary\n\nChange.\n\n## Testing\n\n- npm run check\n' > "$BODY"
}

prepare_release() {
  new_fixture
  RELEASE_WORKTREE="$REPO/.worktrees/kit-sqlite-release"
  git -C "$REPO" worktree add -b kit/sqlite "$RELEASE_WORKTREE" origin/kit/sqlite >/dev/null 2>&1
  RELEASE="$RELEASE_WORKTREE/.agents/skills/kit-workflow/scripts/release-kit.sh"
  install_mocks
}
