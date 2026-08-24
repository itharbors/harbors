#!/usr/bin/env bash

test_integration_requires_confirmation() {
  prepare_change
  before=$(git -C "$REPO" rev-parse main)
  if output=$($INTEGRATE "$WORKTREE" ff 2>&1); then fail 'integration without confirmation succeeded'; fi
  assert_contains "$output" '--confirm'
  assert_eq "$(git -C "$REPO" rev-parse main)" "$before"
}

test_integration_requires_clean_primary_and_source() {
  prepare_change
  printf 'dirty\n' > "$REPO/dirty.txt"
  if output=$($INTEGRATE "$WORKTREE" ff --confirm 2>&1); then fail 'dirty primary succeeded'; fi
  assert_contains "$output" 'primary main worktree is not clean'
  rm "$REPO/dirty.txt"
  printf 'dirty\n' > "$WORKTREE/dirty.txt"
  if output=$($INTEGRATE "$WORKTREE" ff --confirm 2>&1); then fail 'dirty source succeeded'; fi
  assert_contains "$output" 'source worktree is not clean'
}

test_fast_forward_keeps_source_and_does_not_push() {
  prepare_change
  source_head=$(git -C "$WORKTREE" rev-parse HEAD)
  remote_head=$(git -C "$REPO" ls-remote origin refs/heads/main | awk '{print $1}')
  output=$($INTEGRATE "$WORKTREE" ff --confirm)
  assert_contains "$output" 'INTEGRATED=1'
  assert_contains "$output" 'STRATEGY=ff'
  assert_eq "$(git -C "$REPO" rev-parse HEAD)" "$source_head"
  assert_eq "$(git -C "$WORKTREE" rev-parse HEAD)" "$source_head"
  assert_eq "$(git -C "$REPO" ls-remote origin refs/heads/main | awk '{print $1}')" "$remote_head"
  test -d "$WORKTREE" || fail 'integration removed source worktree'
  git -C "$REPO" show-ref --verify --quiet refs/heads/feature/integration-case || fail 'integration removed source branch'
}

test_merge_commit_is_explicit_and_preserves_source() {
  prepare_change bug
  printf 'local main\n' > "$REPO/local-main.txt"
  git -C "$REPO" add local-main.txt
  git -C "$REPO" commit -m '[Chore] 添加本地 main 测试提交' >/dev/null
  remote_head=$(git -C "$REPO" ls-remote origin refs/heads/main | awk '{print $1}')
  source_head=$(git -C "$WORKTREE" rev-parse HEAD)
  if output=$($INTEGRATE "$WORKTREE" merge --confirm 2>&1); then fail 'merge without title succeeded'; fi
  assert_contains "$output" 'requires a commit title'
  output=$($INTEGRATE "$WORKTREE" merge --confirm '[Bug] 整合本地缺陷修复')
  assert_contains "$output" 'STRATEGY=merge'
  assert_contains "$output" 'MAIN_AHEAD_ORIGIN=3'
  assert_contains "$output" 'MAIN_BEHIND_ORIGIN=0'
  assert_eq "$(git -C "$REPO" ls-remote origin refs/heads/main | awk '{print $1}')" "$remote_head"
  test "$(git -C "$REPO" rev-list --parents -n 1 HEAD | awk '{print NF}')" -eq 3 || fail 'merge did not create a two-parent commit'
  assert_eq "$(git -C "$REPO" log -1 --format=%s)" '[Bug] 整合本地缺陷修复'
  assert_eq "$(git -C "$WORKTREE" rev-parse HEAD)" "$source_head"
}

test_main_behind_origin_does_not_block_local_integration() {
  prepare_change
  other="$FIXTURE_ROOT/other"
  git clone "$ORIGIN" "$other" >/dev/null 2>&1
  git -C "$other" config user.name 'Other Test'
  git -C "$other" config user.email 'other@example.com'
  printf 'remote main\n' > "$other/remote-main.txt"
  git -C "$other" add remote-main.txt
  git -C "$other" commit -m '[Chore] 添加远端 main 测试提交' >/dev/null
  git -C "$other" push origin main >/dev/null 2>&1
  git -C "$REPO" fetch origin main >/dev/null 2>&1
  before_source=$(git -C "$WORKTREE" rev-parse HEAD)
  output=$($INTEGRATE "$WORKTREE" ff --confirm)
  assert_contains "$output" 'INTEGRATED=1'
  assert_contains "$output" 'MAIN_BEHIND_ORIGIN=1'
  assert_eq "$(git -C "$REPO" rev-parse main)" "$before_source"
  assert_eq "$(git -C "$WORKTREE" rev-parse HEAD)" "$before_source"
  assert_eq "$(git -C "$REPO" status --porcelain=v1 --untracked-files=all)" ''
}

test_missing_origin_main_does_not_block_local_integration() {
  prepare_change
  git -C "$REPO" update-ref -d refs/remotes/origin/main
  source_head=$(git -C "$WORKTREE" rev-parse HEAD)
  output=$($INTEGRATE "$WORKTREE" ff --confirm)
  assert_contains "$output" 'INTEGRATED=1'
  assert_contains "$output" 'MAIN_AHEAD_ORIGIN=unavailable'
  assert_contains "$output" 'MAIN_BEHIND_ORIGIN=unavailable'
  assert_eq "$(git -C "$REPO" rev-parse main)" "$source_head"
}

test_squash_requires_valid_label_and_creates_one_commit() {
  prepare_change docs
  if output=$($INTEGRATE "$WORKTREE" squash --confirm '[Docs] 有句号。' 2>&1); then fail 'trailing period accepted'; fi
  assert_contains "$output" 'commit title'
  if output=$($INTEGRATE "$WORKTREE" squash --confirm '[Docs] no chinese' 2>&1); then fail 'non-Chinese title accepted'; fi
  assert_contains "$output" 'Chinese characters'
  source_head=$(git -C "$WORKTREE" rev-parse HEAD)
  output=$($INTEGRATE "$WORKTREE" squash --confirm '[Docs] 整合本地文档变更')
  assert_contains "$output" 'STRATEGY=squash'
  assert_eq "$(git -C "$REPO" log -1 --format=%s)" '[Docs] 整合本地文档变更'
  assert_eq "$(git -C "$WORKTREE" rev-parse HEAD)" "$source_head"
}

test_squash_commit_failure_restores_clean_main() {
  prepare_change
  hooks="$FIXTURE_ROOT/hooks"
  mkdir "$hooks"
  cat > "$hooks/pre-commit" <<'EOF'
#!/usr/bin/env sh
exit 1
EOF
  chmod +x "$hooks/pre-commit"
  git -C "$REPO" config core.hooksPath "$hooks"
  before=$(git -C "$REPO" rev-parse HEAD)
  if output=$($INTEGRATE "$WORKTREE" squash --confirm '[Docs] 触发提交失败' 2>&1); then fail 'squash hook failure succeeded'; fi
  assert_contains "$output" 'squash commit failed; main was restored'
  assert_eq "$(git -C "$REPO" rev-parse HEAD)" "$before"
  assert_eq "$(git -C "$REPO" status --porcelain=v1 --untracked-files=all)" ''
  test ! -e "$REPO/change.txt" || fail 'source-added file survived squash rollback'
}

test_squash_hook_extra_file_is_preserved_and_reported() {
  prepare_change
  hooks="$FIXTURE_ROOT/hooks"
  mkdir "$hooks"
  cat > "$hooks/pre-commit" <<EOF
#!/usr/bin/env sh
printf 'hook output\\n' > '$REPO/hook-extra.txt'
exit 1
EOF
  chmod +x "$hooks/pre-commit"
  git -C "$REPO" config core.hooksPath "$hooks"
  before=$(git -C "$REPO" rev-parse HEAD)
  if output=$($INTEGRATE "$WORKTREE" squash --confirm '[Docs] 保留额外文件' 2>&1); then fail 'squash extra-file hook succeeded'; fi
  assert_contains "$output" 'squash commit failed and could not restore clean main'
  assert_eq "$(git -C "$REPO" rev-parse HEAD)" "$before"
  test -f "$REPO/hook-extra.txt" || fail 'hook extra file was unexpectedly removed'
  test ! -e "$REPO/change.txt" || fail 'source-added file survived partial rollback'
  rm "$REPO/hook-extra.txt"
}

test_conflict_is_not_resolved_automatically() {
  prepare_change
  printf 'main\n' > "$REPO/change.txt"
  git -C "$REPO" add change.txt
  git -C "$REPO" commit -m '[Bug] 制造主分支冲突' >/dev/null
  if output=$($INTEGRATE "$WORKTREE" merge --confirm '[Feature] 整合冲突变更' 2>&1); then fail 'conflicting merge succeeded'; fi
  assert_contains "$output" 'no conflict resolution was attempted'
  assert_eq "$(git -C "$REPO" status --porcelain=v1 --untracked-files=all)" ''
}

test_squash_conflict_is_preflighted_without_dirty_main() {
  prepare_change
  printf 'main\n' > "$REPO/change.txt"
  git -C "$REPO" add change.txt
  git -C "$REPO" commit -m '[Bug] 制造 squash 冲突' >/dev/null
  before=$(git -C "$REPO" rev-parse HEAD)
  if output=$($INTEGRATE "$WORKTREE" squash --confirm '[Feature] 整合冲突变更' 2>&1); then fail 'conflicting squash succeeded'; fi
  assert_contains "$output" 'integration has conflicts'
  assert_eq "$(git -C "$REPO" rev-parse HEAD)" "$before"
  assert_eq "$(git -C "$REPO" status --porcelain=v1 --untracked-files=all)" ''
}

test_rejects_source_from_another_repository() {
  prepare_change
  other="$FIXTURE_ROOT/other"
  git init "$other" >/dev/null 2>&1
  git -C "$other" config user.name 'Other Test'
  git -C "$other" config user.email 'other@example.com'
  printf 'other\n' > "$other/file.txt"
  git -C "$other" add file.txt
  git -C "$other" commit -m '[Feature] 其他仓库提交' >/dev/null
  other_worktree="$other/.worktrees/feature-other"
  git -C "$other" worktree add -b feature/other "$other_worktree" >/dev/null 2>&1
  if output=$($INTEGRATE "$other_worktree" ff --confirm 2>&1); then fail 'foreign worktree accepted'; fi
  assert_contains "$output" 'different repository'
}

run_integration_tests() {
  run_case 'integration requires explicit confirmation' test_integration_requires_confirmation
  run_case 'integration requires clean primary and source' test_integration_requires_clean_primary_and_source
  run_case 'fast-forward keeps source and does not push' test_fast_forward_keeps_source_and_does_not_push
  run_case 'merge commit is explicit' test_merge_commit_is_explicit_and_preserves_source
  run_case 'main behind origin does not block local integration' test_main_behind_origin_does_not_block_local_integration
  run_case 'missing origin main does not block local integration' test_missing_origin_main_does_not_block_local_integration
  run_case 'squash requires a valid label' test_squash_requires_valid_label_and_creates_one_commit
  run_case 'squash commit failure restores clean main' test_squash_commit_failure_restores_clean_main
  run_case 'squash hook extra file is preserved' test_squash_hook_extra_file_is_preserved_and_reported
  run_case 'conflicts are not resolved automatically' test_conflict_is_not_resolved_automatically
  run_case 'squash conflicts are preflighted' test_squash_conflict_is_preflighted_without_dirty_main
  run_case 'foreign repositories are rejected' test_rejects_source_from_another_repository
}
