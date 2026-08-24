#!/usr/bin/env bash

test_start_rejects_legacy_entry() {
  new_fixture
  if output=$("$START" feature sample-change 2>&1); then fail 'legacy start entry succeeded'; fi
  assert_contains "$output" 'invalid start mode: feature'
}

test_start_requires_existing_task() {
  new_fixture
  task_id="$(date +%F)-missing-task"
  if output=$("$START" worktree "$task_id" 2>&1); then fail 'missing Task succeeded'; fi
  assert_contains "$output" "Task directory is missing: $task_id"
}
test_start_rejects_invalid_names() {
  new_fixture
  if output=$("$START" invalid valid 2>&1); then fail 'invalid mode succeeded'; fi
  assert_contains "$output" 'invalid start mode: invalid'
  if output=$("$START" worktree '../bad' 2>&1); then fail 'invalid task id succeeded'; fi
  assert_contains "$output" 'invalid task id: ../bad'
}

test_start_ignores_dirty_and_ahead_main() {
  new_fixture
  printf 'local\n' > "$REPO/local.txt"
  git -C "$REPO" add local.txt
  git -C "$REPO" commit -m '[Feature] 添加本地提交' >/dev/null
  base=$(git -C "$REPO" rev-parse main)
  printf 'dirty\n' > "$REPO/dirty.txt"
  make_task_in_current
  "$START" worktree "$TASK_ID" >/dev/null
  assert_eq "$(git -C "$REPO/.worktrees/feature-selected-task" rev-parse HEAD)" "$base"
}

advance_remote() {
  OTHER="$FIXTURE_ROOT/other"
  git clone "$ORIGIN" "$OTHER" >/dev/null 2>&1
  git -C "$OTHER" config user.name test
  git -C "$OTHER" config user.email test@example.com
  printf 'remote\n' > "$OTHER/remote.txt"
  git -C "$OTHER" add remote.txt
  git -C "$OTHER" commit -m '[Bug] 添加远端提交' >/dev/null
  git -C "$OTHER" push origin main >/dev/null 2>&1
}

test_start_uses_local_main_without_fetching_remote() {
  new_fixture
  printf 'local\n' > "$REPO/local.txt"
  git -C "$REPO" add local.txt
  git -C "$REPO" commit -m '[Feature] 添加本地提交' >/dev/null
  advance_remote
  expected=$(git -C "$REPO" rev-parse main)
  make_task_in_current
  "$START" worktree "$TASK_ID" >/dev/null
  assert_eq "$(git -C "$REPO/.worktrees/feature-selected-task" rev-parse HEAD)" "$expected"
}

test_start_requires_local_main() {
  new_fixture
  git -C "$REPO" checkout -b scratch >/dev/null 2>&1
  git -C "$REPO" branch -D main >/dev/null
  make_task_in_current
  if output=$("$START" worktree "$TASK_ID" 2>&1); then fail 'start without local main succeeded'; fi
  assert_contains "$output" 'primary worktree must be on main'
}

make_task_in_current() {
  local workspace=${1:-$REPO}
  TASK_ID=$(cd "$workspace" && node scripts/task-status.mjs init feature selected-task --date 2026-08-24)
  TASK_DIR="$workspace/docs/tasks/$TASK_ID"
  cat > "$TASK_DIR/task.md" <<EOF
# $TASK_ID

Task ID: __TASK_ID__
Type: feature

## 背景与问题

测试背景。

## 目标

测试目标。

## 范围

测试范围。

## 非目标

测试非目标。

## 验收标准

测试验收。

## 约束

测试约束。

## 需求变更

无。
EOF
  task_ref=$(printf '`%s`' "$TASK_ID")
  type_ref=$(printf '`feature`')
  sed -i '' "s|__TASK_ID__|$TASK_ID|g; s|Task ID: $TASK_ID|Task ID: $task_ref|; s|Type: feature|Type: $type_ref|" "$TASK_DIR/task.md"
}

test_start_current_starts_design_without_creating_environment() {
  new_fixture
  make_task_in_current
  printf 'keep me\n' > "$REPO/dirty.txt"
  output=$($START current "$TASK_ID")
  assert_contains "$output" 'MODE=current'
  assert_contains "$output" "WORKTREE_PATH=$REPO"
  assert_contains "$output" 'BRANCH=main'
  test ! -d "$REPO/.worktrees" || test -z "$(find "$REPO/.worktrees" -mindepth 1 -maxdepth 1 -print -quit)"
  test -f "$REPO/dirty.txt" || fail 'current mode removed dirty files'
  assert_eq "$(node -p "require('$TASK_DIR/status.json').stages.design")" 'in_progress'
}

test_start_current_supports_linked_non_main_workspace() {
  new_fixture
  linked="$REPO/.worktrees/chore-current"
  git -C "$REPO" worktree add -b chore/current "$linked" main >/dev/null 2>&1
  make_task_in_current "$linked"
  printf 'keep linked changes\n' > "$linked/dirty.txt"
  base=$(git -C "$linked" rev-parse HEAD)
  output=$("$linked/.agents/skills/change-workflow/scripts/start-change.sh" current "$TASK_ID")
  assert_contains "$output" 'MODE=current'
  assert_contains "$output" "WORKTREE_PATH=$linked"
  assert_contains "$output" 'BRANCH=chore/current'
  assert_contains "$output" "BASE_COMMIT=$base"
  assert_eq "$(node -p "require('$TASK_DIR/status.json').stages.design")" 'in_progress'
  test -f "$linked/dirty.txt" || fail 'current linked mode removed dirty files'
}

test_start_worktree_transfers_untracked_task_from_main() {
  new_fixture
  make_task_in_current
  printf 'unrelated\n' > "$REPO/dirty.txt"
  base=$(git -C "$REPO" rev-parse main)
  output=$($START worktree "$TASK_ID")
  worktree="$REPO/.worktrees/feature-selected-task"
  assert_contains "$output" 'MODE=worktree'
  assert_contains "$output" "BASE_COMMIT=$base"
  test ! -e "$REPO/docs/tasks/$TASK_ID" || fail 'Task remained in primary worktree'
  test -f "$worktree/docs/tasks/$TASK_ID/task.md" || fail 'Task was not transferred'
  assert_eq "$(git -C "$worktree" rev-parse HEAD)" "$base"
  assert_eq "$(git -C "$worktree" branch --show-current)" 'feature/selected-task'
  assert_eq "$(node -p "require('$worktree/docs/tasks/$TASK_ID/status.json').stages.design")" 'in_progress'
  test -f "$REPO/dirty.txt" || fail 'unrelated dirty file was removed'
}

test_start_rejects_branch_conflicts() {
  new_fixture
  make_task_in_current
  git -C "$REPO" branch feature/selected-task origin/main >/dev/null
  if output=$("$START" worktree "$TASK_ID" 2>&1); then fail 'local conflict succeeded'; fi
  assert_contains "$output" 'branch already exists: feature/selected-task'
  new_fixture
  make_task_in_current
  git -C "$REPO" push origin origin/main:refs/heads/feature/selected-task >/dev/null 2>&1
  if output=$("$START" worktree "$TASK_ID" 2>&1); then fail 'remote conflict succeeded'; fi
  assert_contains "$output" 'remote branch already exists: feature/selected-task'
}

test_start_rejects_worktree_conflicts() {
  new_fixture
  make_task_in_current
  mkdir -p "$REPO/.worktrees/feature-selected-task"
  if output=$("$START" worktree "$TASK_ID" 2>&1); then fail 'path conflict succeeded'; fi
  assert_contains "$output" 'worktree path already exists'
  new_fixture
  make_task_in_current
  registered="$REPO/.worktrees/feature-selected-task"
  git -C "$REPO" worktree add --detach "$registered" origin/main >/dev/null 2>&1
  mv "$registered" "$FIXTURE_ROOT/moved"
  if output=$("$START" worktree "$TASK_ID" 2>&1); then fail 'registered conflict succeeded'; fi
  assert_contains "$output" 'worktree already registered'
}

test_start_rejects_linked_context() {
  new_fixture
  make_task_in_current
  linked="$REPO/.worktrees/chore-linked"
  git -C "$REPO" worktree add -b chore/linked "$linked" origin/main >/dev/null 2>&1
  if output=$("$linked/.agents/skills/change-workflow/scripts/start-change.sh" worktree "$TASK_ID" 2>&1); then fail 'linked start succeeded'; fi
  assert_contains "$output" 'primary worktree'
}

test_start_rejects_worktrees_symlink() {
  new_fixture
  make_task_in_current
  target="$FIXTURE_ROOT/outside"
  mkdir "$target"
  ln -s "$target" "$REPO/.worktrees"
  if output=$("$START" worktree "$TASK_ID" 2>&1); then fail 'symlink worktrees succeeded'; fi
  assert_contains "$output" '.worktrees must not be a symlink'
  new_fixture
  make_task_in_current
  printf 'not a directory\n' > "$REPO/.worktrees"
  if output=$("$START" worktree "$TASK_ID" 2>&1); then fail 'file worktrees succeeded'; fi
  assert_contains "$output" '.worktrees must be a directory inside the repository'
}

test_start_accepts_idempotent_current_registration() {
  new_fixture
  make_task_in_current
  first=$($START current "$TASK_ID")
  second=$($START current "$TASK_ID")
  assert_contains "$first" 'WORKSPACE_DIRTY=1'
  assert_contains "$second" 'WORKSPACE_DIRTY=1'
  assert_eq "$(node -p "require('$TASK_DIR/status.json').stages.design")" 'in_progress'
}

run_start_tests() {
  run_case 'start rejects legacy entry' test_start_rejects_legacy_entry
  run_case 'start requires existing Task' test_start_requires_existing_task
  run_case 'start rejects invalid names' test_start_rejects_invalid_names
  run_case 'start ignores dirty and ahead main' test_start_ignores_dirty_and_ahead_main
  run_case 'start uses local main without fetching remote' test_start_uses_local_main_without_fetching_remote
  run_case 'start requires local main' test_start_requires_local_main
  run_case 'start rejects branch conflicts' test_start_rejects_branch_conflicts
  run_case 'start rejects worktree conflicts' test_start_rejects_worktree_conflicts
  run_case 'start rejects linked context' test_start_rejects_linked_context
  run_case 'start rejects symlink worktrees' test_start_rejects_worktrees_symlink
  run_case 'start current is idempotent' test_start_accepts_idempotent_current_registration
  run_case 'start current starts design in place' test_start_current_starts_design_without_creating_environment
  run_case 'start current supports linked non-main workspace' test_start_current_supports_linked_non_main_workspace
  run_case 'start worktree transfers untracked Task' test_start_worktree_transfers_untracked_task_from_main
}
