#!/usr/bin/env bash

TEST_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
REPO_SOURCE=$(git -C "$TEST_DIR" rev-parse --show-toplevel)
SKILL_SOURCE="$REPO_SOURCE/.agents/skills/kit-workflow"
SOURCE_START="$SKILL_SOURCE/scripts/start-kit-change.sh"
SOURCE_FINISH="$SKILL_SOURCE/scripts/finish-kit-change.sh"
SOURCE_RELEASE="$SKILL_SOURCE/scripts/release-kit.sh"
SOURCE_LIB="$SKILL_SOURCE/scripts/_kit-workflow-lib.sh"
ORIGINAL_PATH=$PATH
REAL_GIT=$(command -v git)
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
  if test "$status" -eq 0; then
    PASS_COUNT=$((PASS_COUNT + 1)); printf 'PASS: %s\n' "$name"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1)); printf 'FAIL: %s\n' "$name" >&2
  fi
}

copy_workflow_scripts() {
  local directory=$1
  mkdir -p "$directory/.agents/skills/kit-workflow/scripts"
  cp "$SOURCE_LIB" "$directory/.agents/skills/kit-workflow/scripts/_kit-workflow-lib.sh"
  cp "$SOURCE_START" "$directory/.agents/skills/kit-workflow/scripts/start-kit-change.sh"
  cp "$SOURCE_FINISH" "$directory/.agents/skills/kit-workflow/scripts/finish-kit-change.sh"
  cp "$SOURCE_RELEASE" "$directory/.agents/skills/kit-workflow/scripts/release-kit.sh"
}

write_kit_files() {
  local directory=$1 kit=${2:-sqlite} version=${3:-0.1.0-preview.1} channel=${4:-preview}
  mkdir -p "$directory/kits/$kit"
  printf '%s\n' \
    '{' \
    "  \"name\": \"@itharbors/kit-$kit\"," \
    "  \"version\": \"$version\"," \
    '  "private": true' \
    '}' > "$directory/kits/$kit/package.json"
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
    '}' > "$directory/kits/$kit/kit.json"
}

write_repository_files() {
  local directory=$1
  copy_workflow_scripts "$directory"
  mkdir -p "$directory/registry"
  printf '%s\n' \
    '{' \
    '  "name": "itharbors",' \
    '  "private": true,' \
    '  "scripts": { "kit:check": "true" }' \
    '}' > "$directory/package.json"
  printf '%s\n' \
    '{' \
    '  "name": "itharbors",' \
    '  "lockfileVersion": 3,' \
    '  "requires": true,' \
    '  "packages": {' \
    '    "": { "name": "itharbors" },' \
    '    "kits/sqlite": { "name": "@itharbors/kit-sqlite", "version": "0.1.0-preview.1" }' \
    '  }' \
    '}' > "$directory/package-lock.json"
  printf '%s\n' \
    '{' \
    '  "schemaVersion": 1,' \
    '  "repository": "itharbors/harbors",' \
    '  "workflow": "itharbors/harbors/.github/workflows/publish-kit.yml",' \
    '  "signerWorkflows": ["itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v2"],' \
    '  "kits": {' \
    '    "mysql": { "id": "@itharbors/kit-mysql", "label": "MySQL", "summary": "MySQL", "runner": "ubuntu-latest" },' \
    '    "notifications": { "id": "@itharbors/kit-notifications", "label": "Notifications", "summary": "Notifications", "runner": "ubuntu-latest" },' \
    '    "sqlite": { "id": "@itharbors/kit-sqlite", "label": "SQLite", "summary": "SQLite", "runner": "macos-14" }' \
    '  }' \
    '}' > "$directory/registry/policy.json"
  write_kit_files "$directory"
}

set_kit_version() {
  local directory=$1 version=$2 channel=$3
  node - "$directory" "$version" "$channel" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [root, version, channel] = process.argv.slice(2);
for (const relative of ['kits/sqlite/kit.json', 'kits/sqlite/package.json']) {
  const file = path.join(root, relative);
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  value.version = version;
  if (relative.endsWith('kit.json')) value.channel = channel;
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
const lockFile = path.join(root, 'package-lock.json');
const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
lock.packages['kits/sqlite'].version = version;
fs.writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
NODE
}

new_fixture() {
  FIXTURE_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/kit-workflow.XXXXXX")
  FIXTURE_ROOT=$(cd "$FIXTURE_ROOT" && pwd -P)
  ORIGIN="$FIXTURE_ROOT/origin.git"
  REPO="$FIXTURE_ROOT/repo"
  git init --bare "$ORIGIN" >/dev/null
  git clone "$ORIGIN" "$REPO" >/dev/null 2>&1
  REPO=$(cd "$REPO" && pwd -P)
  git -C "$REPO" config --local user.name 'VisualSJ'
  git -C "$REPO" config --local user.email 'devhacker520@hotmail.com'
  git -C "$REPO" checkout -b main >/dev/null 2>&1
  write_repository_files "$REPO"
  printf '.worktrees/\nnode_modules/\n' > "$REPO/.gitignore"
  git -C "$REPO" add .
  git -C "$REPO" commit -m '[Init] 初始化测试仓库' >/dev/null
  git -C "$REPO" push -u origin main >/dev/null 2>&1
  git -C "$ORIGIN" symbolic-ref HEAD refs/heads/main
  START="$REPO/.agents/skills/kit-workflow/scripts/start-kit-change.sh"
  RELEASE="$REPO/.agents/skills/kit-workflow/scripts/release-kit.sh"
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
  mkdir -p "$MOCK_BIN" "$REPO/node_modules"
  ln -s "$REPO_SOURCE/node_modules/semver" "$REPO/node_modules/semver"
  SEMVER_SOURCE="$REPO_SOURCE/node_modules/semver"
  : > "$GH_LOG"; : > "$NPM_LOG"; export GH_LOG NPM_LOG REAL_GIT SEMVER_SOURCE
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'printf "%s\n" "$*" >> "$NPM_LOG"' \
    'if test "${1:-}" = ci; then mkdir -p node_modules; test -e node_modules/semver || ln -s "$SEMVER_SOURCE" node_modules/semver; fi' \
    'test "${NPM_FAIL:-0}" != 1' > "$MOCK_BIN/npm"
  printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\n" "$*" >> "$GH_LOG"' \
    'case "$1 $2" in' \
    "'auth status') test \"\${GH_AUTH_FAIL:-0}\" != 1 ;;" \
    "'pr create') printf '%s\\n' 'https://github.com/example/repo/pull/1' ;;" \
    "'pr view') printf '%s\\t%s\\t%s\\t%s\\n' \"\${GH_VIEW_BASE:-main}\" \"\${GH_VIEW_HEAD:-\$(git branch --show-current)}\" \"\${GH_VIEW_STATE:-OPEN}\" \"\${GH_VIEW_URL:-https://github.com/example/repo/pull/1}\" ;;" \
    '*) exit 2 ;;' 'esac' > "$MOCK_BIN/gh"
  chmod +x "$MOCK_BIN/npm" "$MOCK_BIN/gh"
  export PATH="$MOCK_BIN:$ORIGINAL_PATH"
}

install_failing_ls_remote_git() {
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'for argument in "$@"; do' \
    '  if test "$argument" = ls-remote; then printf "simulated ls-remote failure\\n" >&2; exit 128; fi' \
    'done' \
    'exec "$REAL_GIT" "$@"' > "$MOCK_BIN/git"
  chmod +x "$MOCK_BIN/git"
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
  printf '## Summary\n\nChange.\n\n## Testing\n\n- npm run kit:check -- sqlite\n' > "$BODY"
}

prepare_release() {
  new_fixture
  install_mocks
}
