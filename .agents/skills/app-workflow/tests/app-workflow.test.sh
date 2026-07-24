#!/usr/bin/env bash

set -euo pipefail

TEST_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
SKILL_DIR=$(cd "$TEST_DIR/.." && pwd -P)
RELEASE="$SKILL_DIR/scripts/release-app.sh"
REPOSITORY_SOURCE=$(git -C "$TEST_DIR" rev-parse --show-toplevel)
ORIGINAL_PATH=$PATH
PASS_COUNT=0
FAIL_COUNT=0

fail() { printf 'FAIL: %s\n' "$*" >&2; return 1; }
assert_contains() { case "$1" in *"$2"*) ;; *) fail "expected [$1] to contain [$2]" ;; esac; }

assert_no_publish() {
  if grep -Eq '^(tag -a|push origin )' "$FAKE_GIT_LOG"; then
    fail "release published before validation: $(cat "$FAKE_GIT_LOG")"
  fi
}

new_fixture() {
  if test -n "${FIXTURE_ROOT:-}"; then rm -rf -- "$FIXTURE_ROOT"; fi
  FIXTURE_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/app-workflow.XXXXXX")
  FIXTURE_ROOT=$(cd "$FIXTURE_ROOT" && pwd -P)
  MOCK_BIN="$FIXTURE_ROOT/mock-bin"
  FAKE_GIT_LOG="$FIXTURE_ROOT/git.log"
  FAKE_NPM_LOG="$FIXTURE_ROOT/npm.log"
  DESKTOP_VERSION=${1:-0.1.0-preview.1}
  mkdir -p "$FIXTURE_ROOT/packages/desktop" "$MOCK_BIN" "$FIXTURE_ROOT/node_modules"
  printf '{\n  "name": "@itharbors/desktop",\n  "version": "%s"\n}\n' "$DESKTOP_VERSION" \
    > "$FIXTURE_ROOT/packages/desktop/package.json"
  ln -s "$REPOSITORY_SOURCE/node_modules/semver" "$FIXTURE_ROOT/node_modules/semver"
  : > "$FAKE_GIT_LOG"
  : > "$FAKE_NPM_LOG"
  export FIXTURE_ROOT FAKE_GIT_LOG FAKE_NPM_LOG
  export FAKE_STATUS='' FAKE_BRANCH='main'
  export FAKE_HEAD='0123456789012345678901234567890123456789'
  FAKE_TRACKING_REF="$FIXTURE_ROOT/origin-main"
  FAKE_REMOTE_MAIN="$FIXTURE_ROOT/remote-main"
  printf '%s\n' "$FAKE_HEAD" > "$FAKE_TRACKING_REF"
  printf '%s\n' "$FAKE_HEAD" > "$FAKE_REMOTE_MAIN"
  export FAKE_TRACKING_REF FAKE_REMOTE_MAIN FAKE_TRACKING_REF_EXISTS=1 FAKE_FETCH_FAIL=0
  export FAKE_LOCAL_GIT_NAME='VisualSJ' FAKE_LOCAL_GIT_EMAIL='devhacker520@hotmail.com'
  export FAKE_GLOBAL_GIT_NAME='VisualSJ' FAKE_GLOBAL_GIT_EMAIL='devhacker520@hotmail.com'
  export FAKE_ORIGIN_URL='https://github.com/itharbors/harbors.git'
  export FAKE_LOCAL_TAG='' FAKE_LS_REMOTE='missing'
  export FAKE_TOOLCHAIN_TAG='exists' FAKE_TOOLCHAIN_BRANCH='missing'
  write_fake_git
  write_fake_npm
}

write_fake_git() {
  cat > "$MOCK_BIN/git" <<'GIT'
#!/usr/bin/env bash
set -eu
if test "${1:-}" = -C; then shift 2; fi
printf '%s\n' "$*" >> "$FAKE_GIT_LOG"
case "${1:-}" in
  rev-parse)
    if test "${2:-}" = --verify; then ref=${3:-}; else ref=${2:-}; fi
    case "$ref" in
      --show-toplevel) printf '%s\n' "$FIXTURE_ROOT" ;;
      --abbrev-ref) printf '%s\n' "$FAKE_BRANCH" ;;
      HEAD) printf '%s\n' "$FAKE_HEAD" ;;
      origin/main|refs/remotes/origin/main)
        test "$FAKE_TRACKING_REF_EXISTS" = 1 || exit 128
        cat "$FAKE_TRACKING_REF" ;;
      *) exit 2 ;;
    esac ;;
  status) printf '%s\n' "$FAKE_STATUS" ;;
  fetch)
    if test "$FAKE_FETCH_FAIL" = 1; then
      printf '%s\n' 'simulated fetch failure' >&2
      exit 128
    fi
    if test "${2:-}" = origin && test "${3:-}" = --prune; then
      cp "$FAKE_REMOTE_MAIN" "$FAKE_TRACKING_REF"
    fi ;;
  remote)
    test "${2:-}" = get-url && test "${3:-}" = origin || exit 2
    printf '%s\n' "$FAKE_ORIGIN_URL" ;;
  config)
    case "${2:-}" in
      --local) scope=LOCAL; key=${4:-} ;;
      --get) scope=GLOBAL; key=${3:-} ;;
      *) exit 2 ;;
    esac
    case "$key" in
      user.name) value_name="FAKE_${scope}_GIT_NAME"; printf '%s\n' "${!value_name}" ;;
      user.email) value_name="FAKE_${scope}_GIT_EMAIL"; printf '%s\n' "${!value_name}" ;;
      *) exit 1 ;;
    esac ;;
  tag)
    if test "${2:-}" = --list; then printf '%s\n' "$FAKE_LOCAL_TAG"; else exit 0; fi ;;
  ls-remote)
    query=${!#}
    case "$query" in
      refs/tags/app-publish-v1) state=$FAKE_TOOLCHAIN_TAG ;;
      refs/heads/app-publish-v1) state=$FAKE_TOOLCHAIN_BRANCH ;;
      *) state=$FAKE_LS_REMOTE ;;
    esac
    case "$state" in
      missing) exit 2 ;;
      exists) printf '%s\t%s\n' "$FAKE_HEAD" "$query" ;;
      failed) printf '%s\n' 'simulated ls-remote failure' >&2; exit 128 ;;
      *) exit 2 ;;
    esac ;;
  push) exit 0 ;;
  *) exit 2 ;;
esac
GIT
  chmod +x "$MOCK_BIN/git"
}

write_fake_npm() {
  cat > "$MOCK_BIN/npm" <<'NPM'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$FAKE_NPM_LOG"
test "${FAKE_NPM_FAIL:-0}" != 1
NPM
  chmod +x "$MOCK_BIN/npm"
}

run_release() {
  set +e
  RELEASE_OUTPUT=$(PATH="$MOCK_BIN:$ORIGINAL_PATH" "$RELEASE" 0.1.0-preview.1 2>&1)
  RELEASE_STATUS=$?
  set -e
}

assert_rejected_before_publish() {
  local name=$1 expected=$2
  run_release
  if test "$RELEASE_STATUS" -eq 0; then
    fail "$name unexpectedly succeeded"
    return 1
  fi
  assert_contains "$RELEASE_OUTPUT" "$expected" || return 1
  assert_no_publish || return 1
}

test_dirty_tree_is_rejected_before_publish() {
  new_fixture
  export FAKE_STATUS=' M packages/desktop/package.json'
  assert_rejected_before_publish 'dirty release' 'working tree is not clean'
}

test_non_main_is_rejected_before_publish() {
  new_fixture
  export FAKE_BRANCH='feature/app-release'
  assert_rejected_before_publish 'non-main release' 'release must run from main'
}

test_noncanonical_origin_is_rejected_before_publish() {
  new_fixture
  export FAKE_ORIGIN_URL='https://github.com/example/harbors.git'
  assert_rejected_before_publish 'wrong origin release' 'origin must be the canonical itharbors/harbors repository'
}

test_canonical_ssh_origin_is_accepted() {
  new_fixture
  export FAKE_ORIGIN_URL='git@github.com:itharbors/harbors.git'
  run_release
  test "$RELEASE_STATUS" -ne 0 || fail 'unconfirmed SSH-origin release unexpectedly succeeded'
  assert_contains "$RELEASE_OUTPUT" 'App release requires explicit confirmation' || return 1
  assert_no_publish || return 1
}

test_origin_mismatch_is_rejected_before_publish() {
  new_fixture
  printf '%s\n' '9999999999999999999999999999999999999999' > "$FAKE_REMOTE_MAIN"
  assert_rejected_before_publish 'origin mismatch release' 'current Commit is not origin/main'
}

test_stale_tracking_ref_is_refreshed_before_publish() {
  new_fixture
  printf '%s\n' '9999999999999999999999999999999999999999' > "$FAKE_REMOTE_MAIN"
  export HARBORS_APP_RELEASE_CONFIRM="v0.1.0-preview.1@$FAKE_HEAD"
  run_release
  unset HARBORS_APP_RELEASE_CONFIRM
  if test "$RELEASE_STATUS" -eq 0; then
    fail 'stale tracking ref release unexpectedly succeeded'
    return 1
  fi
  assert_contains "$RELEASE_OUTPUT" 'current Commit is not origin/main' || return 1
  assert_no_publish || return 1
}

test_missing_fetched_tracking_ref_is_rejected_before_publish() {
  new_fixture
  export FAKE_TRACKING_REF_EXISTS=0
  assert_rejected_before_publish 'missing fetched tracking ref release' 'unable to resolve fetched origin/main'
}

test_failed_origin_fetch_is_rejected_before_publish() {
  new_fixture
  export FAKE_FETCH_FAIL=1
  assert_rejected_before_publish 'failed origin fetch release' 'unable to fetch origin'
}

test_missing_toolchain_tag_is_rejected_before_publish() {
  new_fixture
  export FAKE_TOOLCHAIN_TAG='missing'
  assert_rejected_before_publish 'missing toolchain tag release' 'app-publish-v1 Tag must be activated before app releases'
}

test_same_named_toolchain_branch_is_rejected_before_publish() {
  new_fixture
  export FAKE_TOOLCHAIN_BRANCH='exists'
  assert_rejected_before_publish 'toolchain branch release' 'app-publish-v1 must not exist as a branch'
}

test_wrong_repository_identity_is_rejected_before_publish() {
  new_fixture
  export FAKE_LOCAL_GIT_EMAIL='wrong@example.com' FAKE_GLOBAL_GIT_EMAIL='wrong@example.com'
  assert_rejected_before_publish 'wrong identity release' 'Git user.email must be devhacker520@hotmail.com'
}

test_global_only_identity_is_rejected_before_publish() {
  new_fixture
  export FAKE_LOCAL_GIT_NAME='' FAKE_LOCAL_GIT_EMAIL=''
  export HARBORS_APP_RELEASE_CONFIRM="v0.1.0-preview.1@$FAKE_HEAD"
  run_release
  unset HARBORS_APP_RELEASE_CONFIRM
  if test "$RELEASE_STATUS" -eq 0; then
    fail 'global-only identity release unexpectedly succeeded'
    return 1
  fi
  assert_contains "$RELEASE_OUTPUT" 'Git user.name must be VisualSJ' || return 1
  assert_no_publish || return 1
}

test_desktop_version_mismatch_is_rejected_before_publish() {
  new_fixture 0.1.0-preview.2
  assert_rejected_before_publish 'desktop version mismatch release' 'desktop package version is 0.1.0-preview.2'
}

test_existing_local_tag_is_rejected_before_publish() {
  new_fixture
  export FAKE_LOCAL_TAG='v0.1.0-preview.1'
  assert_rejected_before_publish 'local tag release' 'release Tag already exists locally'
}

test_existing_remote_tag_is_rejected_before_publish() {
  new_fixture
  export FAKE_LS_REMOTE='exists'
  assert_rejected_before_publish 'remote tag release' 'release Tag already exists on origin'
}

test_failed_remote_query_is_rejected_before_publish() {
  new_fixture
  export FAKE_LS_REMOTE='failed'
  assert_rejected_before_publish 'failed ls-remote release' 'unable to query origin release Tag'
}

test_missing_exact_confirmation_is_rejected_before_publish() {
  new_fixture
  assert_rejected_before_publish 'unconfirmed release' 'App release requires explicit confirmation'
}

test_confirmed_release_checks_then_publishes_one_annotated_tag() {
  new_fixture
  export HARBORS_APP_RELEASE_CONFIRM="v0.1.0-preview.1@$FAKE_HEAD"
  run_release
  unset HARBORS_APP_RELEASE_CONFIRM
  test "$RELEASE_STATUS" -eq 0 || fail "confirmed release failed: $RELEASE_OUTPUT"
  assert_contains "$RELEASE_OUTPUT" 'RELEASE_TAG=v0.1.0-preview.1'
  assert_contains "$(cat "$FAKE_NPM_LOG")" 'run check'
  assert_contains "$(cat "$FAKE_NPM_LOG")" 'run desktop:prepare'
  check_line=$(grep -n 'run check' "$FAKE_NPM_LOG" | cut -d: -f1)
  prepare_line=$(grep -n 'run desktop:prepare' "$FAKE_NPM_LOG" | cut -d: -f1)
  test "$check_line" -lt "$prepare_line" || fail 'expected check before desktop preparation'
  test "$(grep -Ec '^tag -a v0.1.0-preview.1 ' "$FAKE_GIT_LOG")" -eq 1 \
    || fail 'expected one annotated tag'
  test "$(grep -Ec '^push origin refs/tags/v0.1.0-preview.1$' "$FAKE_GIT_LOG")" -eq 1 \
    || fail 'expected one tag push'
}

run_test() {
  local name=$1
  if "$name"; then
    PASS_COUNT=$((PASS_COUNT + 1))
    printf 'PASS: %s\n' "$name"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    printf 'FAIL: %s\n' "$name" >&2
  fi
}

test -x "$RELEASE" || fail 'release-app.sh is missing or not executable'

run_test test_dirty_tree_is_rejected_before_publish
run_test test_non_main_is_rejected_before_publish
run_test test_noncanonical_origin_is_rejected_before_publish
run_test test_canonical_ssh_origin_is_accepted
run_test test_origin_mismatch_is_rejected_before_publish
run_test test_stale_tracking_ref_is_refreshed_before_publish
run_test test_missing_fetched_tracking_ref_is_rejected_before_publish
run_test test_failed_origin_fetch_is_rejected_before_publish
run_test test_missing_toolchain_tag_is_rejected_before_publish
run_test test_same_named_toolchain_branch_is_rejected_before_publish
run_test test_wrong_repository_identity_is_rejected_before_publish
run_test test_global_only_identity_is_rejected_before_publish
run_test test_desktop_version_mismatch_is_rejected_before_publish
run_test test_existing_local_tag_is_rejected_before_publish
run_test test_existing_remote_tag_is_rejected_before_publish
run_test test_failed_remote_query_is_rejected_before_publish
run_test test_missing_exact_confirmation_is_rejected_before_publish
run_test test_confirmed_release_checks_then_publishes_one_annotated_tag

test -z "${FIXTURE_ROOT:-}" || rm -rf -- "$FIXTURE_ROOT"
test "$FAIL_COUNT" -eq 0
printf 'PASS: %s app workflow release tests\n' "$PASS_COUNT"
