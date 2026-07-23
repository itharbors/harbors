#!/usr/bin/env bash

test_start_uses_product_baseline_for_all_types() {
  for type in feature bug docs refactor optimize test chore; do
    new_fixture
    install_mocks
    output=$("$START" sqlite "$type" sample-change)
    worktree="$REPO/.worktrees/kit-sqlite-$type-sample-change"
    base=$(git -C "$REPO" rev-parse origin/kit/sqlite)
    assert_contains "$output" 'KIT=sqlite'
    assert_contains "$output" 'TARGET_BRANCH=kit/sqlite'
    assert_contains "$output" "WORKTREE_PATH=$worktree"
    assert_contains "$output" "BRANCH=kit-change/sqlite/$type/sample-change"
    assert_contains "$output" "BASE_COMMIT=$base"
    assert_eq "$(git -C "$worktree" rev-parse HEAD)" "$base"
    assert_contains "$(cat "$NPM_LOG")" 'ci'
  done
}

test_start_rejects_invalid_names_and_missing_product() {
  new_fixture
  if output=$("$START" '../bad' feature valid 2>&1); then fail 'invalid kit succeeded'; fi
  assert_contains "$output" 'invalid Kit name'
  if output=$("$START" sqlite build valid 2>&1); then fail 'invalid type succeeded'; fi
  assert_contains "$output" 'invalid change type'
  if output=$("$START" sqlite feature '../bad' 2>&1); then fail 'invalid slug succeeded'; fi
  assert_contains "$output" 'invalid slug'
  if output=$("$START" mysql feature missing 2>&1); then fail 'missing product succeeded'; fi
  assert_contains "$output" 'origin/kit/mysql is missing'
}

test_start_rejects_manifest_and_runtime_mismatch() {
  new_fixture
  git -C "$PRODUCT" checkout kit/sqlite >/dev/null 2>&1
  sed -i.bak 's/@itharbors\/kit-sqlite/@itharbors\/kit-wrong/g' "$PRODUCT/kit.json"
  rm "$PRODUCT/kit.json.bak"
  git -C "$PRODUCT" add kit.json
  git -C "$PRODUCT" commit -m '[Bug] 制造身份错误' >/dev/null
  git -C "$PRODUCT" push origin kit/sqlite >/dev/null 2>&1
  if output=$("$START" sqlite bug bad-manifest 2>&1); then fail 'bad manifest succeeded'; fi
  assert_contains "$output" 'Kit identity mismatch'

  new_fixture
  git -C "$PRODUCT" checkout kit/sqlite >/dev/null 2>&1
  sed -i.bak 's/22.18.0/99.0.0/g' "$PRODUCT/package.json" "$PRODUCT/package-lock.json"
  rm "$PRODUCT/package.json.bak" "$PRODUCT/package-lock.json.bak"
  git -C "$PRODUCT" add package.json package-lock.json
  git -C "$PRODUCT" commit -m '[Bug] 制造运行时错误' >/dev/null
  git -C "$PRODUCT" push origin kit/sqlite >/dev/null 2>&1
  if output=$("$START" sqlite bug bad-runtime 2>&1); then fail 'bad runtime succeeded'; fi
  assert_contains "$output" 'Node version mismatch'
}

test_start_rejects_conflicts_and_linked_context() {
  new_fixture
  git -C "$REPO" branch kit-change/sqlite/feature/existing origin/kit/sqlite >/dev/null
  if output=$("$START" sqlite feature existing 2>&1); then fail 'local conflict succeeded'; fi
  assert_contains "$output" 'branch already exists'

  new_fixture
  linked="$REPO/.worktrees/linked"
  git -C "$REPO" worktree add --detach "$linked" origin/kit/sqlite >/dev/null 2>&1
  if output=$("$linked/.agents/skills/kit-workflow/scripts/start-kit-change.sh" sqlite feature nested 2>&1); then fail 'linked start succeeded'; fi
  assert_contains "$output" 'primary worktree'
}

run_start_tests() {
  run_case 'start uses Kit product baseline for all types' test_start_uses_product_baseline_for_all_types
  run_case 'start rejects invalid names and missing product' test_start_rejects_invalid_names_and_missing_product
  run_case 'start rejects manifest and runtime mismatch' test_start_rejects_manifest_and_runtime_mismatch
  run_case 'start rejects conflicts and linked context' test_start_rejects_conflicts_and_linked_context
}
