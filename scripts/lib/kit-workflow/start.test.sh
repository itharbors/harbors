#!/usr/bin/env bash

test_start_uses_main_baseline_for_all_types() {
  for type in feature bug docs refactor optimize test chore; do
    new_fixture
    install_mocks
    output=$("$START" sqlite "$type" sample-change)
    worktree="$REPO/.worktrees/kit-sqlite-$type-sample-change"
    base=$(git -C "$REPO" rev-parse origin/main)
    assert_contains "$output" 'KIT=sqlite'
    assert_contains "$output" 'TARGET_BRANCH=main'
    assert_contains "$output" "WORKTREE_PATH=$worktree"
    assert_contains "$output" "BRANCH=kit-change/sqlite/$type/sample-change"
    assert_contains "$output" "BASE_COMMIT=$base"
    assert_eq "$(git -C "$worktree" rev-parse HEAD)" "$base"
    assert_contains "$(cat "$NPM_LOG")" 'ci'
  done
}

test_start_rejects_invalid_and_missing_kits() {
  new_fixture
  if output=$("$START" '../bad' feature valid 2>&1); then fail 'invalid kit succeeded'; fi
  assert_contains "$output" 'invalid Kit name'
  if output=$("$START" sqlite build valid 2>&1); then fail 'invalid type succeeded'; fi
  assert_contains "$output" 'invalid change type'
  if output=$("$START" sqlite feature '../bad' 2>&1); then fail 'invalid slug succeeded'; fi
  assert_contains "$output" 'invalid slug'
  if output=$("$START" redis feature missing 2>&1); then fail 'untrusted Kit succeeded'; fi
  assert_contains "$output" 'not listed in registry policy'

  new_fixture
  rm "$REPO/kits/sqlite/kit.json"
  git -C "$REPO" add -u
  git -C "$REPO" commit -m '[Bug] 删除测试清单' >/dev/null
  git -C "$REPO" push origin main >/dev/null 2>&1
  if output=$("$START" sqlite feature missing-manifest 2>&1); then fail 'missing manifest succeeded'; fi
  assert_contains "$output" 'kits/sqlite/kit.json is missing'
}

test_start_rejects_identity_and_product_mismatch() {
  new_fixture
  git -C "$REPO" config --local user.name 'Wrong Name'
  if output=$("$START" sqlite bug wrong-identity 2>&1); then fail 'wrong identity succeeded'; fi
  assert_contains "$output" 'Git user.name must be VisualSJ'

  new_fixture
  node - "$REPO/kits/sqlite/package.json" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const value = JSON.parse(fs.readFileSync(file, 'utf8'));
value.version = '0.1.0-preview.2';
fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
NODE
  git -C "$REPO" add kits/sqlite/package.json
  git -C "$REPO" commit -m '[Bug] 制造版本错误' >/dev/null
  git -C "$REPO" push origin main >/dev/null 2>&1
  if output=$("$START" sqlite bug bad-version 2>&1); then fail 'version mismatch succeeded'; fi
  assert_contains "$output" 'Kit manifest and package versions do not match'

  new_fixture
  node - "$REPO/registry/policy.json" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const value = JSON.parse(fs.readFileSync(file, 'utf8'));
value.kits.sqlite.id = '@itharbors/kit-wrong';
fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
NODE
  git -C "$REPO" add registry/policy.json
  git -C "$REPO" commit -m '[Bug] 制造策略错误' >/dev/null
  git -C "$REPO" push origin main >/dev/null 2>&1
  if output=$("$START" sqlite bug bad-policy 2>&1); then fail 'policy mismatch succeeded'; fi
  assert_contains "$output" 'Kit policy identity mismatch'
}

test_start_rejects_conflicts_and_linked_context() {
  new_fixture
  git -C "$REPO" branch kit-change/sqlite/feature/existing origin/main >/dev/null
  if output=$("$START" sqlite feature existing 2>&1); then fail 'local conflict succeeded'; fi
  assert_contains "$output" 'branch already exists'

  new_fixture
  linked="$REPO/.worktrees/linked"
  git -C "$REPO" worktree add --detach "$linked" origin/main >/dev/null 2>&1
  if output=$("$linked/.agents/skills/kit-workflow/scripts/start-kit-change.sh" sqlite feature nested 2>&1); then fail 'linked start succeeded'; fi
  assert_contains "$output" 'primary worktree'
}

run_start_tests() {
  run_case 'start uses main baseline for all types' test_start_uses_main_baseline_for_all_types
  run_case 'start rejects invalid and missing Kits' test_start_rejects_invalid_and_missing_kits
  run_case 'start rejects identity and product mismatch' test_start_rejects_identity_and_product_mismatch
  run_case 'start rejects conflicts and linked context' test_start_rejects_conflicts_and_linked_context
}
