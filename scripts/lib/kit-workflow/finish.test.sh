#!/usr/bin/env bash

test_finish_targets_main_for_all_types() {
  for type in feature bug docs refactor optimize test chore; do
    prepare_change "$type"
    output=$("$FINISH" sqlite '完成 Kit 变更' "$BODY")
    label=$(label_for_type "$type")
    assert_contains "$output" 'PR_URL=https://github.com/example/repo/pull/1'
    assert_contains "$(cat "$GH_LOG")" "pr create --base main --head kit-change/sqlite/$type/finish-case --title [$label] 完成 Kit 变更"
    npm_log=$(cat "$NPM_LOG")
    assert_contains "$npm_log" 'run kit:boundary -- sqlite --base refs/remotes/origin/main --head HEAD'
    assert_contains "$npm_log" 'run kit:check -- sqlite --output-directory'
    assert_not_contains "$npm_log" 'run check'
    assert_not_contains "$npm_log" 'run kit:validate'
    assert_not_contains "$npm_log" 'run kit:pack'
  done
}

test_finish_rejects_wrong_kit_label_state_and_identity() {
  prepare_change feature
  if output=$("$FINISH" mysql '完成变更' "$BODY" 2>&1); then fail 'wrong Kit succeeded'; fi
  assert_contains "$output" 'Kit argument does not match branch'

  prepare_change feature
  git -C "$WORKTREE" commit --amend -m '[Bug] 使用错误标签' >/dev/null
  if output=$("$FINISH" sqlite '完成变更' "$BODY" 2>&1); then fail 'wrong label succeeded'; fi
  assert_contains "$output" 'commits must start with [Feature]'

  prepare_change docs
  printf 'dirty\n' > "$WORKTREE/dirty.txt"
  if output=$("$FINISH" sqlite '更新文档' "$BODY" 2>&1); then fail 'dirty state succeeded'; fi
  assert_contains "$output" 'working tree is not clean'

  prepare_change chore
  git -C "$WORKTREE" config --local user.email 'wrong@example.com'
  if output=$("$FINISH" sqlite '维护 Kit' "$BODY" 2>&1); then fail 'wrong identity succeeded'; fi
  assert_contains "$output" 'Git user.email must be devhacker520@hotmail.com'
}

test_finish_runs_boundary_check_before_pack_and_push() {
  prepare_change optimize
  install_git_logging_mock
  export NPM_FAIL=1
  if "$FINISH" sqlite '优化性能' "$BODY" >/dev/null 2>&1; then unset NPM_FAIL; fail 'failed boundary succeeded'; fi
  unset NPM_FAIL
  test ! -s "$GH_LOG" || fail 'gh ran after boundary failure'
  npm_log=$(cat "$NPM_LOG")
  assert_contains "$npm_log" 'run kit:boundary -- sqlite --base refs/remotes/origin/main --head HEAD'
  assert_not_contains "$npm_log" 'kit:check'
  git_log=$(cat "$GIT_LOG")
  assert_not_contains "$git_log" 'fetch origin'
  assert_not_contains "$git_log" 'push --set-upstream'
}

install_boundary_aware_npm_mock() {
  export REPO_SOURCE
  cat > "$MOCK_BIN/npm" <<'NPM'
#!/usr/bin/env bash
printf "%s\n" "$*" >> "$NPM_LOG"
repository_root=
expect_prefix=0
for arg in "$@"; do
  if test "$expect_prefix" -eq 1; then
    repository_root=$arg
    expect_prefix=0
  elif test "$arg" = '--prefix'; then
    expect_prefix=1
  fi
done
if test "${1:-}" = ci; then
  mkdir -p node_modules
  test -e node_modules/semver || ln -s "$SEMVER_SOURCE" node_modules/semver
fi
found_boundary=0
found_dashdash=0
boundary_args=()
for arg in "$@"; do
  if test "$found_boundary" -eq 1 && test "$found_dashdash" -eq 1; then
    boundary_args+=("$arg")
  elif test "$arg" = 'kit:boundary'; then
    found_boundary=1
  elif test "$found_boundary" -eq 1 && test "$arg" = '--'; then
    found_dashdash=1
  fi
done
if test "$found_boundary" -eq 1; then
  test -n "$repository_root"
  cd "$repository_root"
  exec node "$REPO_SOURCE/scripts/check-kit-boundary.mjs" "${boundary_args[@]}"
fi
test "${NPM_FAIL:-0}" != 1
NPM
  chmod +x "$MOCK_BIN/npm"
}

install_git_logging_mock() {
  GIT_LOG="$FIXTURE_ROOT/git.log"
  : > "$GIT_LOG"
  export GIT_LOG
  cat > "$MOCK_BIN/git" <<'GIT'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GIT_LOG"
exec "$REAL_GIT" "$@"
GIT
  chmod +x "$MOCK_BIN/git"
}

test_finish_rejects_out_of_boundary_changes_before_pack_and_push() {
  prepare_change feature
  install_boundary_aware_npm_mock
  install_git_logging_mock
  if output=$("$FINISH" sqlite '完成变更' "$BODY" 2>&1); then fail 'out-of-boundary change succeeded'; fi
  assert_contains "$output" 'outside kits/sqlite'
  test ! -s "$GH_LOG" || fail 'gh ran after boundary failure'
  npm_log=$(cat "$NPM_LOG")
  assert_contains "$npm_log" 'kit:boundary'
  assert_not_contains "$npm_log" 'kit:check'
  assert_not_contains "$(cat "$GIT_LOG")" 'fetch origin'
}

test_finish_accepts_in_boundary_changes_with_real_gate() {
  prepare_change feature
  git -C "$WORKTREE" rm change.txt >/dev/null
  printf '\n' >> "$WORKTREE/kits/sqlite/package.json"
  git -C "$WORKTREE" add kits/sqlite/package.json
  git -C "$WORKTREE" commit --amend -m '[Feature] 添加 Kit 内变更' >/dev/null
  install_boundary_aware_npm_mock
  output=$("$FINISH" sqlite '完成变更' "$BODY")
  assert_contains "$output" 'PR_URL=https://github.com/example/repo/pull/1'
  npm_log=$(cat "$NPM_LOG")
  assert_contains "$npm_log" 'kit:boundary'
  assert_contains "$npm_log" 'kit:check'
}

test_finish_rejects_unrelated_history() {
  prepare_change feature
  git -C "$WORKTREE" switch --orphan unrelated >/dev/null 2>&1
  git -C "$WORKTREE" rm -rf . >/dev/null 2>&1 || true
  write_repository_files "$WORKTREE"
  git -C "$WORKTREE" add .
  git -C "$WORKTREE" commit -m '[Feature] 制造无关历史' >/dev/null
  git -C "$WORKTREE" branch -M kit-change/sqlite/feature/finish-case
  if output=$("$FINISH" sqlite '完成变更' "$BODY" 2>&1); then fail 'unrelated history succeeded'; fi
  assert_contains "$output" 'is not based on origin/main'
  test ! -s "$GH_LOG" || fail 'gh ran for unrelated history'
}

run_finish_tests() {
  run_case 'finish targets main for all types' test_finish_targets_main_for_all_types
  run_case 'finish rejects wrong Kit, label, state, and identity' test_finish_rejects_wrong_kit_label_state_and_identity
  run_case 'finish runs boundary check before pack and push' test_finish_runs_boundary_check_before_pack_and_push
  run_case 'finish rejects out-of-boundary changes before pack and push' test_finish_rejects_out_of_boundary_changes_before_pack_and_push
  run_case 'finish accepts in-boundary changes with real gate' test_finish_accepts_in_boundary_changes_with_real_gate
  run_case 'finish rejects unrelated history' test_finish_rejects_unrelated_history
}
