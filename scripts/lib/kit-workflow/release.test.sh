#!/usr/bin/env bash

test_release_preview_requires_exact_confirmation_and_runs_one_check() {
  prepare_release
  commit=$(git -C "$REPO" rev-parse HEAD)
  confirmation="kit/sqlite/v0.1.0-preview.1@$commit"
  if output=$("$RELEASE" sqlite 0.1.0-preview.1 2>&1); then fail 'unconfirmed preview succeeded'; fi
  assert_contains "$output" 'RELEASE_KIT=sqlite'
  assert_contains "$output" 'RELEASE_VERSION=0.1.0-preview.1'
  assert_contains "$output" 'RELEASE_TAG=kit/sqlite/v0.1.0-preview.1'
  assert_contains "$output" "RELEASE_CONFIRM=$confirmation"
  assert_ref_missing "$REPO" refs/tags/kit/sqlite/v0.1.0-preview.1

  export HARBORS_KIT_RELEASE_CONFIRM="$confirmation"
  output=$("$RELEASE" sqlite 0.1.0-preview.1)
  unset HARBORS_KIT_RELEASE_CONFIRM
  assert_contains "$output" 'RELEASE_TAG=kit/sqlite/v0.1.0-preview.1'
  git -C "$REPO" ls-remote --exit-code --tags origin refs/tags/kit/sqlite/v0.1.0-preview.1 >/dev/null
  npm_log=$(cat "$NPM_LOG")
  assert_contains "$npm_log" 'run kit:check -- sqlite --output-directory'
  assert_not_contains "$npm_log" 'run check'
  assert_not_contains "$npm_log" 'run kit:validate'
  assert_not_contains "$npm_log" 'run kit:pack'
}

test_release_supports_stable_and_enforces_channel_from_semver() {
  prepare_release
  if output=$("$RELEASE" sqlite 0.1.0 2>&1); then fail 'plain SemVer with preview manifest succeeded'; fi
  assert_contains "$output" 'stable channel is required'

  prepare_release
  set_kit_version "$REPO" 0.1.0-preview.1 stable
  git -C "$REPO" add kits/sqlite package-lock.json
  git -C "$REPO" commit -m '[Bug] 制造预览频道错误' >/dev/null
  git -C "$REPO" push origin main >/dev/null 2>&1
  if output=$("$RELEASE" sqlite 0.1.0-preview.1 2>&1); then fail 'prerelease with stable manifest succeeded'; fi
  assert_contains "$output" 'preview channel is required'

  prepare_release
  set_kit_version "$REPO" 0.1.0 stable
  git -C "$REPO" add kits/sqlite package-lock.json
  git -C "$REPO" commit -m '[Feature] 准备稳定版本' >/dev/null
  git -C "$REPO" push origin main >/dev/null 2>&1
  commit=$(git -C "$REPO" rev-parse HEAD)
  confirmation="kit/sqlite/v0.1.0@$commit"
  if output=$("$RELEASE" sqlite 0.1.0 2>&1); then fail 'unconfirmed stable succeeded'; fi
  assert_contains "$output" "RELEASE_CONFIRM=$confirmation"
  export HARBORS_KIT_RELEASE_CONFIRM="$confirmation"
  "$RELEASE" sqlite 0.1.0 >/dev/null
  unset HARBORS_KIT_RELEASE_CONFIRM
  git -C "$REPO" ls-remote --exit-code --tags origin refs/tags/kit/sqlite/v0.1.0 >/dev/null
}

test_release_rejects_noncanonical_semver_and_version_mismatch() {
  prepare_release
  oversized_prerelease="1.2.3-$(printf 'a%.0s' {1..260})"
  for version in v0.1.0 01.2.3 1.2 1.2.3+build.7 1.2.3-preview.01 9007199254740992.0.0 "$oversized_prerelease"; do
    if output=$("$RELEASE" sqlite "$version" 2>&1); then fail "invalid version succeeded: $version"; fi
    assert_contains "$output" 'canonical SemVer'
  done

  prepare_release
  node - "$REPO/kits/sqlite/package.json" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const value = JSON.parse(fs.readFileSync(file, 'utf8'));
value.version = '0.1.0-preview.2';
fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
NODE
  git -C "$REPO" add kits/sqlite/package.json
  git -C "$REPO" commit -m '[Bug] 制造发布版本错误' >/dev/null
  git -C "$REPO" push origin main >/dev/null 2>&1
  if output=$("$RELEASE" sqlite 0.1.0-preview.1 2>&1); then fail 'mismatched versions succeeded'; fi
  assert_contains "$output" 'Kit manifest and package versions do not match'
}

test_release_requires_clean_exact_main_and_repository_identity() {
  prepare_release
  git -C "$REPO" switch -c feature/not-main >/dev/null 2>&1
  if output=$("$RELEASE" sqlite 0.1.0-preview.1 2>&1); then fail 'non-main release succeeded'; fi
  assert_contains "$output" 'release must run from main'

  prepare_release
  printf 'ahead\n' > "$REPO/ahead.txt"
  git -C "$REPO" add ahead.txt
  git -C "$REPO" commit -m '[Chore] 制造未推送提交' >/dev/null
  if output=$("$RELEASE" sqlite 0.1.0-preview.1 2>&1); then fail 'unpushed main succeeded'; fi
  assert_contains "$output" 'current Commit is not origin/main'

  prepare_release
  printf 'dirty\n' > "$REPO/dirty.txt"
  if output=$("$RELEASE" sqlite 0.1.0-preview.1 2>&1); then fail 'dirty release succeeded'; fi
  assert_contains "$output" 'working tree is not clean'

  prepare_release
  git -C "$REPO" config --local user.email wrong@example.com
  if output=$("$RELEASE" sqlite 0.1.0-preview.1 2>&1); then fail 'wrong identity succeeded'; fi
  assert_contains "$output" 'Git user.email must be devhacker520@hotmail.com'
}

test_release_rejects_existing_local_or_remote_tag() {
  prepare_release
  tag=kit/sqlite/v0.1.0-preview.1
  git -C "$REPO" tag "$tag"
  if output=$("$RELEASE" sqlite 0.1.0-preview.1 2>&1); then fail 'existing local tag succeeded'; fi
  assert_contains "$output" 'release Tag already exists locally'

  prepare_release
  tag=kit/sqlite/v0.1.0-preview.1
  git -C "$REPO" tag "$tag"
  git -C "$REPO" push origin "refs/tags/$tag" >/dev/null 2>&1
  git -C "$REPO" tag -d "$tag" >/dev/null
  if output=$("$RELEASE" sqlite 0.1.0-preview.1 2>&1); then fail 'existing remote tag succeeded'; fi
  assert_contains "$output" 'release Tag already exists'
}

test_release_fails_closed_when_remote_tag_query_fails() {
  prepare_release
  install_failing_ls_remote_git
  if output=$("$RELEASE" sqlite 0.1.0-preview.1 2>&1); then fail 'failed remote query succeeded'; fi
  assert_contains "$output" 'unable to query origin release Tag'
  assert_contains "$output" 'simulated ls-remote failure'
  assert_ref_missing "$REPO" refs/tags/kit/sqlite/v0.1.0-preview.1
}

run_release_tests() {
  run_case 'release Preview requires exact confirmation and one targeted check' test_release_preview_requires_exact_confirmation_and_runs_one_check
  run_case 'release supports Stable and enforces channel from SemVer' test_release_supports_stable_and_enforces_channel_from_semver
  run_case 'release rejects noncanonical SemVer and version mismatch' test_release_rejects_noncanonical_semver_and_version_mismatch
  run_case 'release requires clean exact main and repository identity' test_release_requires_clean_exact_main_and_repository_identity
  run_case 'release rejects existing local or remote Tag' test_release_rejects_existing_local_or_remote_tag
  run_case 'release fails closed when remote Tag query fails' test_release_fails_closed_when_remote_tag_query_fails
}
