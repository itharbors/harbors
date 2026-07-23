#!/usr/bin/env bash

test_release_requires_stable_manifest_and_explicit_confirmation() {
  prepare_release
  if output=$("$RELEASE" sqlite 0.1.0 2>&1); then fail 'preview manifest release succeeded'; fi
  assert_contains "$output" 'stable channel'
  assert_ref_missing "$RELEASE_WORKTREE" refs/tags/kit/sqlite/v0.1.0

  git -C "$RELEASE_WORKTREE" switch kit/sqlite >/dev/null 2>&1
  sed -i.bak 's/0.1.0-preview.1/0.1.0/g; s/"preview"/"stable"/g' "$RELEASE_WORKTREE/kit.json" "$RELEASE_WORKTREE/package.json" "$RELEASE_WORKTREE/package-lock.json"
  rm "$RELEASE_WORKTREE/kit.json.bak" "$RELEASE_WORKTREE/package.json.bak" "$RELEASE_WORKTREE/package-lock.json.bak"
  git -C "$RELEASE_WORKTREE" add kit.json package.json package-lock.json
  git -C "$RELEASE_WORKTREE" commit -m '[Feature] 准备稳定版本' >/dev/null
  git -C "$RELEASE_WORKTREE" push origin kit/sqlite >/dev/null 2>&1
  commit=$(git -C "$RELEASE_WORKTREE" rev-parse HEAD)
  if output=$("$RELEASE" sqlite 0.1.0 2>&1); then fail 'unconfirmed release succeeded'; fi
  assert_contains "$output" "RELEASE_CONFIRM=kit/sqlite/v0.1.0@$commit"
  assert_contains "$output" 'RELEASE_COMMIT='
  assert_ref_missing "$RELEASE_WORKTREE" refs/tags/kit/sqlite/v0.1.0
}

test_release_runs_checks_and_pushes_only_confirmed_tag() {
  prepare_release
  sed -i.bak 's/0.1.0-preview.1/0.1.0/g; s/"preview"/"stable"/g' "$RELEASE_WORKTREE/kit.json" "$RELEASE_WORKTREE/package.json" "$RELEASE_WORKTREE/package-lock.json"
  rm "$RELEASE_WORKTREE/kit.json.bak" "$RELEASE_WORKTREE/package.json.bak" "$RELEASE_WORKTREE/package-lock.json.bak"
  git -C "$RELEASE_WORKTREE" add kit.json package.json package-lock.json
  git -C "$RELEASE_WORKTREE" commit -m '[Feature] 准备稳定版本' >/dev/null
  git -C "$RELEASE_WORKTREE" push origin kit/sqlite >/dev/null 2>&1
  commit=$(git -C "$RELEASE_WORKTREE" rev-parse HEAD)
  export HARBORS_KIT_RELEASE_CONFIRM="kit/sqlite/v0.1.0@$commit"
  output=$("$RELEASE" sqlite 0.1.0)
  unset HARBORS_KIT_RELEASE_CONFIRM
  assert_contains "$output" 'RELEASE_TAG=kit/sqlite/v0.1.0'
  git -C "$RELEASE_WORKTREE" ls-remote --exit-code --tags origin refs/tags/kit/sqlite/v0.1.0 >/dev/null
  assert_contains "$(cat "$NPM_LOG")" 'run check'
  assert_contains "$(cat "$NPM_LOG")" 'run kit:validate'
  assert_contains "$(cat "$NPM_LOG")" 'run kit:pack'
}

test_release_rejects_existing_tag_and_unpushed_commit() {
  prepare_release
  sed -i.bak 's/0.1.0-preview.1/0.1.0/g; s/"preview"/"stable"/g' "$RELEASE_WORKTREE/kit.json" "$RELEASE_WORKTREE/package.json" "$RELEASE_WORKTREE/package-lock.json"
  rm "$RELEASE_WORKTREE/kit.json.bak" "$RELEASE_WORKTREE/package.json.bak" "$RELEASE_WORKTREE/package-lock.json.bak"
  git -C "$RELEASE_WORKTREE" add kit.json package.json package-lock.json
  git -C "$RELEASE_WORKTREE" commit -m '[Feature] 尚未推送的稳定版本' >/dev/null
  export HARBORS_KIT_RELEASE_CONFIRM=kit/sqlite/v0.1.0
  if output=$("$RELEASE" sqlite 0.1.0 2>&1); then unset HARBORS_KIT_RELEASE_CONFIRM; fail 'unpushed commit succeeded'; fi
  unset HARBORS_KIT_RELEASE_CONFIRM
  assert_contains "$output" 'current Commit is not origin/kit/sqlite'

  prepare_release
  sed -i.bak 's/0.1.0-preview.1/0.1.0/g; s/"preview"/"stable"/g' "$RELEASE_WORKTREE/kit.json" "$RELEASE_WORKTREE/package.json" "$RELEASE_WORKTREE/package-lock.json"
  rm "$RELEASE_WORKTREE/kit.json.bak" "$RELEASE_WORKTREE/package.json.bak" "$RELEASE_WORKTREE/package-lock.json.bak"
  git -C "$RELEASE_WORKTREE" add kit.json package.json package-lock.json
  git -C "$RELEASE_WORKTREE" commit -m '[Feature] 准备重复版本' >/dev/null
  git -C "$RELEASE_WORKTREE" push origin kit/sqlite >/dev/null 2>&1
  git -C "$RELEASE_WORKTREE" tag kit/sqlite/v0.1.0
  git -C "$RELEASE_WORKTREE" push origin refs/tags/kit/sqlite/v0.1.0 >/dev/null 2>&1
  if output=$("$RELEASE" sqlite 0.1.0 2>&1); then fail 'existing tag succeeded'; fi
  assert_contains "$output" 'release Tag already exists'
}

run_release_tests() {
  run_case 'release requires stable manifest and explicit confirmation' test_release_requires_stable_manifest_and_explicit_confirmation
  run_case 'release runs checks and pushes only confirmed tag' test_release_runs_checks_and_pushes_only_confirmed_tag
  run_case 'release rejects existing tag and unpushed commit' test_release_rejects_existing_tag_and_unpushed_commit
}
