# Repository Feature Workflow Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Harbors 仓库内实现一个可发现、可测试的 `feature-workflow` skill，安全地创建功能 worktree，并在验证、推送后创建 GitHub PR。

**Architecture:** 仓库级 `SKILL.md` 负责识别“开始功能”和“完成功能”意图、生成 slug、审查改动与组织提交；两个 Bash 脚本负责确定性的 Git、测试、push 和 PR 不变量。单一 shell 测试文件在临时 bare 远端与临时克隆中运行，使用 PATH 测试替身隔离 npm 和 GitHub CLI。

**Tech Stack:** Bash 3.2+、Git、GitHub CLI `gh`、Node.js/npm、Codex Agent Skills。

## Global Constraints

- Skill 只保存到仓库根目录 `.agents/skills/feature-workflow/`，不得写入用户级或系统级 skill 目录。
- 基线固定为 `origin/main`，功能分支固定为 `codex/<slug>`，worktree 固定为 `.worktrees/<slug>`。
- Slug 只允许小写 ASCII 字母、数字和单连字符分段，匹配 `^[a-z0-9]+(-[a-z0-9]+)*$`。
- 开始流程只允许从主工作树的 `main` 运行，且本地 `main` 必须与 `origin/main` 指向同一提交。
- 完成流程只允许从 linked worktree 的 `codex/<slug>` 分支运行，并要求工作树干净且相对 `origin/main` 至少有一个提交。
- 完成流程必须依次通过 `npm run check`、`gh auth status`、非强制 push、`gh pr create` 和 `gh pr view` 验证后，才能报告 PR 已创建。
- 不执行 hard reset、force push、自动 stash、自动 merge/rebase、递归删除或 worktree 自动清理。
- `.worktrees/` 已存在于仓库根 `.gitignore`，实现时只验证，不重复修改。

---

## File Map

- Create `.agents/skills/feature-workflow/SKILL.md`: 描述触发条件、开始/开发/完成编排和安全边界。
- Create `.agents/skills/feature-workflow/scripts/start-feature.sh`: 校验基线并创建功能分支与 linked worktree。
- Create `.agents/skills/feature-workflow/scripts/finish-feature.sh`: 校验功能分支、运行项目检查、push、创建并验证 PR。
- Create `.agents/skills/feature-workflow/tests/feature-workflow.test.sh`: 临时仓库测试框架、Git 状态测试和 npm/gh 隔离替身。
- Modify `package.json`: 增加只运行该 skill 测试的 `test:feature-workflow` 命令，并让根 `test` 包含它。

### Task 1: Start-feature safety and worktree creation

**Files:**
- Create: `.agents/skills/feature-workflow/scripts/start-feature.sh`
- Create: `.agents/skills/feature-workflow/tests/feature-workflow.test.sh`

**Interfaces:**
- Consumes: one positional `slug` matching `^[a-z0-9]+(-[a-z0-9]+)*$`; the Git repository containing the script.
- Produces: linked worktree `.worktrees/<slug>`, branch `codex/<slug>`, and stdout keys `WORKTREE_PATH=`, `BRANCH=`, `BASE_COMMIT=`.

- [ ] **Step 1: Write the failing start-flow tests and fixture helpers**

Create the test harness with explicit assertion helpers and isolated Git identity:

```bash
#!/usr/bin/env bash
set -euo pipefail

TEST_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
SKILL_DIR=$(cd "$TEST_DIR/.." && pwd -P)
SOURCE_START="$SKILL_DIR/scripts/start-feature.sh"
SOURCE_FINISH="$SKILL_DIR/scripts/finish-feature.sh"
ORIGINAL_PATH=$PATH
PASS_COUNT=0
FAIL_COUNT=0

fail() { printf 'FAIL: %s\n' "$*" >&2; return 1; }
assert_contains() { case "$1" in *"$2"*) ;; *) fail "expected [$1] to contain [$2]";; esac; }
assert_not_exists() { test ! -e "$1" || fail "expected $1 not to exist"; }
assert_eq() { test "$1" = "$2" || fail "expected [$1], got [$2]"; }

new_fixture() {
  FIXTURE_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/feature-workflow.XXXXXX")
  ORIGIN="$FIXTURE_ROOT/origin.git"
  REPO="$FIXTURE_ROOT/repo"
  git init --bare "$ORIGIN" >/dev/null
  git clone "$ORIGIN" "$REPO" >/dev/null 2>&1
  git -C "$REPO" config user.name 'Feature Workflow Test'
  git -C "$REPO" config user.email 'feature-workflow@example.com'
  git -C "$REPO" checkout -b main >/dev/null 2>&1
  mkdir -p "$REPO/.agents/skills/feature-workflow/scripts"
  cp "$SOURCE_START" "$REPO/.agents/skills/feature-workflow/scripts/start-feature.sh"
  if test -f "$SOURCE_FINISH"; then
    cp "$SOURCE_FINISH" "$REPO/.agents/skills/feature-workflow/scripts/finish-feature.sh"
  fi
  printf '.worktrees/\n' > "$REPO/.gitignore"
  printf '{"scripts":{"check":"true"}}\n' > "$REPO/package.json"
  git -C "$REPO" add .
  git -C "$REPO" commit -m 'initial' >/dev/null
  git -C "$REPO" push -u origin main >/dev/null 2>&1
  git -C "$ORIGIN" symbolic-ref HEAD refs/heads/main
  START="$REPO/.agents/skills/feature-workflow/scripts/start-feature.sh"
}

run_case() {
  local name=$1
  shift
  if ( "$@" ); then
    PASS_COUNT=$((PASS_COUNT + 1))
    printf 'PASS: %s\n' "$name"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    printf 'FAIL: %s\n' "$name" >&2
  fi
}
```

Add concrete start cases:

```bash
test_start_success() {
  new_fixture
  output=$("$START" sample-feature)
  assert_contains "$output" "WORKTREE_PATH=$REPO/.worktrees/sample-feature"
  assert_contains "$output" 'BRANCH=codex/sample-feature'
  assert_eq "$(git -C "$REPO/.worktrees/sample-feature" branch --show-current)" 'codex/sample-feature'
  assert_eq "$(git -C "$REPO/.worktrees/sample-feature" rev-parse HEAD)" "$(git -C "$REPO" rev-parse origin/main)"
}

test_start_rejects_invalid_slug() {
  new_fixture
  if output=$("$START" '../bad' 2>&1); then fail 'invalid slug succeeded'; fi
  assert_contains "$output" 'invalid slug'
  assert_not_exists "$REPO/.worktrees/bad"
}

test_start_rejects_dirty_tree() {
  new_fixture
  printf 'dirty\n' > "$REPO/untracked.txt"
  if output=$("$START" dirty-tree 2>&1); then fail 'dirty tree succeeded'; fi
  assert_contains "$output" 'working tree is not clean'
}

test_start_rejects_ahead_main() {
  new_fixture
  printf 'ahead\n' > "$REPO/ahead.txt"
  git -C "$REPO" add ahead.txt
  git -C "$REPO" commit -m ahead >/dev/null
  if output=$("$START" ahead-main 2>&1); then fail 'ahead main succeeded'; fi
  assert_contains "$output" 'main does not match origin/main'
}

test_start_rejects_existing_branch() {
  new_fixture
  git -C "$REPO" branch codex/existing origin/main
  if output=$("$START" existing 2>&1); then fail 'existing branch succeeded'; fi
  assert_contains "$output" 'branch already exists'
}

run_case 'start success' test_start_success
run_case 'invalid slug' test_start_rejects_invalid_slug
run_case 'dirty tree' test_start_rejects_dirty_tree
run_case 'ahead main' test_start_rejects_ahead_main
run_case 'existing branch' test_start_rejects_existing_branch

printf '%s passed, %s failed\n' "$PASS_COUNT" "$FAIL_COUNT"
test "$FAIL_COUNT" -eq 0
```

- [ ] **Step 2: Run the start-flow tests to verify they fail**

Run:

```bash
bash .agents/skills/feature-workflow/tests/feature-workflow.test.sh
```

Expected: FAIL before any case completes because `scripts/start-feature.sh` does not exist.

- [ ] **Step 3: Implement the minimal safe start script**

Create `.agents/skills/feature-workflow/scripts/start-feature.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

fail() { printf 'error: %s\n' "$*" >&2; exit 1; }
test "$#" -eq 1 || fail 'usage: start-feature.sh <slug>'
slug=$1
[[ "$slug" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || fail "invalid slug: $slug"

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
repo_root=$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null) || fail 'skill is not inside a Git repository'
git_dir=$(git -C "$repo_root" rev-parse --absolute-git-dir)
git_common=$(git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir)
test "$git_dir" = "$git_common" || fail 'start must run from the primary worktree'
test "$(git -C "$repo_root" branch --show-current)" = main || fail 'primary worktree must be on main'
git -C "$repo_root" remote get-url origin >/dev/null 2>&1 || fail 'origin remote is missing'

git -C "$repo_root" fetch origin --prune
git -C "$repo_root" show-ref --verify --quiet refs/heads/main || fail 'local main is missing'
git -C "$repo_root" show-ref --verify --quiet refs/remotes/origin/main || fail 'origin/main is missing'
test -z "$(git -C "$repo_root" status --porcelain=v1 --untracked-files=all)" || fail 'working tree is not clean'

local_main=$(git -C "$repo_root" rev-parse refs/heads/main)
remote_main=$(git -C "$repo_root" rev-parse refs/remotes/origin/main)
test "$local_main" = "$remote_main" || fail "main does not match origin/main (main=$local_main origin/main=$remote_main)"

branch="codex/$slug"
worktree_path="$repo_root/.worktrees/$slug"
git -C "$repo_root" show-ref --verify --quiet "refs/heads/$branch" && fail "branch already exists: $branch"
test ! -e "$worktree_path" || fail "worktree path already exists: $worktree_path"
git -C "$repo_root" worktree list --porcelain | grep -Fqx "worktree $worktree_path" && fail "worktree already registered: $worktree_path"

git -C "$repo_root" worktree add -b "$branch" "$worktree_path" origin/main
command -v gh >/dev/null 2>&1 || printf 'warning: gh is not installed; it is required to finish and create a PR\n' >&2
printf 'WORKTREE_PATH=%s\nBRANCH=%s\nBASE_COMMIT=%s\n' "$worktree_path" "$branch" "$remote_main"
```

- [ ] **Step 4: Add lagging/diverged/path-conflict coverage and run all start tests**

Add three concrete cases:

```bash
test_start_rejects_behind_main() {
  new_fixture
  OTHER="$FIXTURE_ROOT/other"
  git clone "$ORIGIN" "$OTHER" >/dev/null 2>&1
  git -C "$OTHER" config user.name test
  git -C "$OTHER" config user.email test@example.com
  printf 'remote\n' > "$OTHER/remote.txt"
  git -C "$OTHER" add remote.txt
  git -C "$OTHER" commit -m remote >/dev/null
  git -C "$OTHER" push origin main >/dev/null 2>&1
  if output=$("$START" behind-main 2>&1); then fail 'behind main succeeded'; fi
  assert_contains "$output" 'main does not match origin/main'
}

test_start_rejects_diverged_main() {
  new_fixture
  printf 'local\n' > "$REPO/local.txt"
  git -C "$REPO" add local.txt
  git -C "$REPO" commit -m local >/dev/null
  OTHER="$FIXTURE_ROOT/other"
  git clone "$ORIGIN" "$OTHER" >/dev/null 2>&1
  git -C "$OTHER" config user.name test
  git -C "$OTHER" config user.email test@example.com
  printf 'remote\n' > "$OTHER/remote.txt"
  git -C "$OTHER" add remote.txt
  git -C "$OTHER" commit -m remote >/dev/null
  git -C "$OTHER" push origin main >/dev/null 2>&1
  if output=$("$START" diverged-main 2>&1); then fail 'diverged main succeeded'; fi
  assert_contains "$output" 'main does not match origin/main'
}

test_start_rejects_path_conflict() {
  new_fixture
  mkdir -p "$REPO/.worktrees/path-conflict"
  if output=$("$START" path-conflict 2>&1); then fail 'path conflict succeeded'; fi
  assert_contains "$output" 'worktree path already exists'
}
```

Run `bash .agents/skills/feature-workflow/tests/feature-workflow.test.sh`; expected: every start case prints `PASS` and the summary ends in `0 failed`.

- [ ] **Step 5: Commit the start-flow deliverable**

```bash
git add .agents/skills/feature-workflow/scripts/start-feature.sh .agents/skills/feature-workflow/tests/feature-workflow.test.sh
git commit -m "功能：添加安全的功能 worktree 创建流程"
```

### Task 2: Finish, push, and verified GitHub PR creation

**Files:**
- Create: `.agents/skills/feature-workflow/scripts/finish-feature.sh`
- Modify: `.agents/skills/feature-workflow/tests/feature-workflow.test.sh`

**Interfaces:**
- Consumes: positional PR title and PR body-file path; clean linked worktree on `codex/<slug>`; `origin/main`; `npm`; authenticated `gh`.
- Produces: pushed upstream branch and verified stdout key `PR_URL=<url>`.

- [ ] **Step 1: Add failing finish-flow tests and command mocks**

Extend the fixture with executable PATH mocks and the complete finish cases:

```bash
install_mocks() {
  MOCK_BIN="$FIXTURE_ROOT/mock-bin"
  mkdir -p "$MOCK_BIN"
  GH_LOG="$FIXTURE_ROOT/gh.log"
  NPM_LOG="$FIXTURE_ROOT/npm.log"
  export GH_LOG NPM_LOG
  cat > "$MOCK_BIN/npm" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$NPM_LOG"
test "${NPM_FAIL:-0}" != 1
MOCK
  cat > "$MOCK_BIN/gh" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GH_LOG"
case "$1 $2" in
  'auth status') test "${GH_AUTH_FAIL:-0}" != 1 ;;
  'pr create') printf '%s\n' 'https://github.com/example/repo/pull/1' ;;
  'pr view') printf 'main\t%s\tOPEN\thttps://github.com/example/repo/pull/1\n' "$(git branch --show-current)" ;;
  *) exit 2 ;;
esac
MOCK
  chmod +x "$MOCK_BIN/npm" "$MOCK_BIN/gh"
  export PATH="$MOCK_BIN:$ORIGINAL_PATH"
}

prepare_feature() {
  new_fixture
  "$START" finish-case >/dev/null
  WORKTREE="$REPO/.worktrees/finish-case"
  FINISH="$WORKTREE/.agents/skills/feature-workflow/scripts/finish-feature.sh"
  printf 'feature\n' > "$WORKTREE/feature.txt"
  git -C "$WORKTREE" add feature.txt
  git -C "$WORKTREE" commit -m feature >/dev/null
  BODY="$FIXTURE_ROOT/pr-body.md"
  printf '## Summary\n\nFeature.\n\n## Testing\n\n- npm run check\n' > "$BODY"
  install_mocks
}

test_finish_rejects_primary_worktree() {
  new_fixture
  BODY="$FIXTURE_ROOT/pr-body.md"
  printf '## Summary\n\nFeature.\n\n## Testing\n\n- npm run check\n' > "$BODY"
  FINISH="$REPO/.agents/skills/feature-workflow/scripts/finish-feature.sh"
  if output=$("$FINISH" 'Feature title' "$BODY" 2>&1); then fail 'primary worktree succeeded'; fi
  assert_contains "$output" 'linked worktree'
}

test_finish_rejects_dirty_tree() {
  prepare_feature
  printf 'dirty\n' > "$WORKTREE/dirty.txt"
  if output=$("$FINISH" 'Feature title' "$BODY" 2>&1); then fail 'dirty finish succeeded'; fi
  assert_contains "$output" 'working tree is not clean'
  test ! -s "$GH_LOG" || fail 'gh was called for a dirty tree'
}

test_finish_rejects_no_commits() {
  new_fixture
  "$START" no-commits >/dev/null
  WORKTREE="$REPO/.worktrees/no-commits"
  FINISH="$WORKTREE/.agents/skills/feature-workflow/scripts/finish-feature.sh"
  BODY="$FIXTURE_ROOT/pr-body.md"
  printf '## Summary\n\nFeature.\n\n## Testing\n\n- npm run check\n' > "$BODY"
  install_mocks
  if output=$("$FINISH" 'Feature title' "$BODY" 2>&1); then fail 'empty feature succeeded'; fi
  assert_contains "$output" 'no commits over origin/main'
}

test_finish_rejects_detached_head() {
  prepare_feature
  git -C "$WORKTREE" checkout --detach >/dev/null 2>&1
  if output=$("$FINISH" 'Feature title' "$BODY" 2>&1); then fail 'detached HEAD succeeded'; fi
  assert_contains "$output" 'detached HEAD'
  test ! -s "$GH_LOG" || fail 'gh was called from detached HEAD'
}

test_finish_rejects_wrong_branch() {
  prepare_feature
  git -C "$WORKTREE" branch -m feature/wrong-branch
  if output=$("$FINISH" 'Feature title' "$BODY" 2>&1); then fail 'wrong branch succeeded'; fi
  assert_contains "$output" 'unexpected feature branch'
  test ! -s "$GH_LOG" || fail 'gh was called from a wrong branch'
}

test_finish_stops_on_check_failure() {
  prepare_feature
  export NPM_FAIL=1
  if output=$("$FINISH" 'Feature title' "$BODY" 2>&1); then fail 'failed check succeeded'; fi
  unset NPM_FAIL
  test ! -s "$GH_LOG" || fail 'gh was called after a failed check'
  git -C "$ORIGIN" show-ref --verify --quiet refs/heads/codex/finish-case && fail 'branch was pushed after a failed check'
}

test_finish_stops_on_auth_failure() {
  prepare_feature
  export GH_AUTH_FAIL=1
  if output=$("$FINISH" 'Feature title' "$BODY" 2>&1); then fail 'failed auth succeeded'; fi
  unset GH_AUTH_FAIL
  assert_contains "$output" 'not authenticated'
  ! grep -Fq 'pr create' "$GH_LOG" || fail 'PR creation ran after failed auth'
  git -C "$ORIGIN" show-ref --verify --quiet refs/heads/codex/finish-case && fail 'branch was pushed after failed auth'
}

test_finish_stops_when_gh_is_missing() {
  prepare_feature
  NO_GH_BIN="$FIXTURE_ROOT/no-gh-bin"
  mkdir -p "$NO_GH_BIN"
  for command_name in bash dirname git grep npm; do
    command_path=$(command -v "$command_name")
    ln -s "$command_path" "$NO_GH_BIN/$command_name"
  done
  if output=$(PATH="$NO_GH_BIN" "$FINISH" 'Feature title' "$BODY" 2>&1); then fail 'missing gh succeeded'; fi
  assert_contains "$output" 'gh is not installed'
  git -C "$ORIGIN" show-ref --verify --quiet refs/heads/codex/finish-case && fail 'branch was pushed without gh'
}

test_finish_success() {
  prepare_feature
  output=$("$FINISH" 'Feature title' "$BODY")
  assert_contains "$output" 'PR_URL=https://github.com/example/repo/pull/1'
  assert_contains "$(cat "$NPM_LOG")" 'run check'
  assert_contains "$(cat "$GH_LOG")" 'pr create --base main --head codex/finish-case --title Feature title'
  assert_eq "$(git -C "$WORKTREE" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}')" 'origin/codex/finish-case'
}

run_case 'finish rejects primary worktree' test_finish_rejects_primary_worktree
run_case 'finish rejects dirty tree' test_finish_rejects_dirty_tree
run_case 'finish rejects no commits' test_finish_rejects_no_commits
run_case 'finish rejects detached HEAD' test_finish_rejects_detached_head
run_case 'finish rejects wrong branch' test_finish_rejects_wrong_branch
run_case 'finish stops on check failure' test_finish_stops_on_check_failure
run_case 'finish stops on auth failure' test_finish_stops_on_auth_failure
run_case 'finish stops when gh is missing' test_finish_stops_when_gh_is_missing
run_case 'finish success' test_finish_success
```

- [ ] **Step 2: Run tests to verify finish cases fail**

Run `bash .agents/skills/feature-workflow/tests/feature-workflow.test.sh`.

Expected: existing start cases pass; finish cases fail because `finish-feature.sh` is missing.

- [ ] **Step 3: Implement finish script with ordered safety gates**

Create `.agents/skills/feature-workflow/scripts/finish-feature.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

fail() { printf 'error: %s\n' "$*" >&2; exit 1; }
test "$#" -eq 2 || fail 'usage: finish-feature.sh <pr-title> <pr-body-file>'
pr_title=$1
body_file=$2
test -n "$pr_title" || fail 'PR title must not be empty'
test -f "$body_file" || fail "PR body file does not exist: $body_file"
grep -Eq '^## Summary$' "$body_file" || fail 'PR body must contain ## Summary'
grep -Eq '^## Testing$' "$body_file" || fail 'PR body must contain ## Testing'

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
repo_root=$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null) || fail 'skill is not inside a Git repository'
git_dir=$(git -C "$repo_root" rev-parse --absolute-git-dir)
git_common=$(git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir)
test "$git_dir" != "$git_common" || fail 'finish must run from a linked worktree'

branch=$(git -C "$repo_root" branch --show-current)
test -n "$branch" || fail 'detached HEAD cannot be finished'
[[ "$branch" =~ ^codex/[a-z0-9]+(-[a-z0-9]+)*$ ]] || fail "unexpected feature branch: $branch"
test -z "$(git -C "$repo_root" status --porcelain=v1 --untracked-files=all)" || fail 'working tree is not clean'
git -C "$repo_root" remote get-url origin >/dev/null 2>&1 || fail 'origin remote is missing'
git -C "$repo_root" fetch origin --prune
git -C "$repo_root" show-ref --verify --quiet refs/remotes/origin/main || fail 'origin/main is missing'
test "$(git -C "$repo_root" rev-list --count origin/main..HEAD)" -gt 0 || fail 'feature branch has no commits over origin/main'

(cd "$repo_root" && npm run check)
command -v gh >/dev/null 2>&1 || fail 'gh is not installed; install GitHub CLI before finishing'
gh auth status >/dev/null 2>&1 || fail 'gh is not authenticated; run gh auth login'

git -C "$repo_root" push --set-upstream origin "$branch"
pr_url=$(cd "$repo_root" && gh pr create --base main --head "$branch" --title "$pr_title" --body-file "$body_file")
test -n "$pr_url" || fail 'gh pr create returned no PR URL'
verification=$(cd "$repo_root" && gh pr view "$pr_url" --json baseRefName,headRefName,state,url --jq '[.baseRefName,.headRefName,.state,.url] | @tsv')
IFS=$'\t' read -r actual_base actual_head actual_state actual_url <<< "$verification"
test "$actual_base" = main || fail "created PR has unexpected base: $actual_base"
test "$actual_head" = "$branch" || fail "created PR has unexpected head: $actual_head"
test "$actual_state" = OPEN || fail "created PR is not open: $actual_state"
test "$actual_url" = "$pr_url" || fail 'created PR URL verification failed'
printf 'PR_URL=%s\n' "$pr_url"
```

- [ ] **Step 4: Run finish tests and prove failure gates do not push or create PRs**

For every negative case, assert `refs/heads/codex/<slug>` is absent from the bare origin and `GH_LOG` contains no `pr create`. Run `bash .agents/skills/feature-workflow/tests/feature-workflow.test.sh`; expected: all cases print `PASS` and the summary ends in `0 failed`.

- [ ] **Step 5: Commit the finish-flow deliverable**

```bash
git add .agents/skills/feature-workflow/scripts/finish-feature.sh .agents/skills/feature-workflow/tests/feature-workflow.test.sh
git commit -m "功能：验证并提交功能分支 PR"
```

### Task 3: Skill orchestration and repository integration

**Files:**
- Create: `.agents/skills/feature-workflow/SKILL.md`
- Modify: `package.json`
- Modify: `.agents/skills/feature-workflow/tests/feature-workflow.test.sh`

**Interfaces:**
- Consumes: natural-language requests to start or finish a Harbors feature.
- Produces: deterministic calls to `scripts/start-feature.sh` or `scripts/finish-feature.sh`, plus accurate progress and failure reporting.

- [ ] **Step 1: Add metadata and package integration checks**

Append this test and register it with `run_case`:

```bash
test_skill_layout() {
  skill_file="$SKILL_DIR/SKILL.md"
  test -f "$skill_file" || fail 'SKILL.md is missing'
  assert_contains "$(sed -n '1,8p' "$skill_file")" 'name: feature-workflow'
  assert_contains "$(sed -n '1,12p' "$skill_file")" 'description:'
  test -x "$SKILL_DIR/scripts/start-feature.sh" || fail 'start script is not executable'
  test -x "$SKILL_DIR/scripts/finish-feature.sh" || fail 'finish script is not executable'
  grep -Fq 'test:feature-workflow' "$SKILL_DIR/../../../package.json" || fail 'package test script is missing'
}
```

Expected initial result: FAIL because `SKILL.md` and package integration are missing.

- [ ] **Step 2: Write the repository-local SKILL.md**

Create `.agents/skills/feature-workflow/SKILL.md`:

```markdown
---
name: feature-workflow
description: Start or finish feature development in the Harbors repository using an isolated Git worktree, a codex/* feature branch, required checks, push, and a verified GitHub pull request. Use when the user asks to start a new feature, create a feature worktree, continue feature work, finish a feature, push its branch, or open a PR. Do not use for hotfixes on an existing branch, release branches, or work outside this repository.
---

# Feature workflow

Use this skill only for the repository containing this file. Never install or copy it to a user-level skill directory.

## Start a feature

1. Turn the requested feature into a short slug matching `^[a-z0-9]+(-[a-z0-9]+)*$`. Preserve meaningful technical names; do not include `codex/` in the slug.
2. Run `scripts/start-feature.sh <slug>` from this skill directory.
3. If the script stops, report the exact repository state and the safe manual decision required. Never reset, stash, merge, rebase, delete, or force-push to bypass it.
4. On success, use the emitted `WORKTREE_PATH` as the working directory for every edit, test, and commit related to the feature.

## Develop in the worktree

1. Confirm `git branch --show-current` is the emitted `codex/<slug>` before editing.
2. Follow repository instructions and run focused tests during development.
3. Before committing, inspect `git status --short`, `git diff`, and `git diff --cached`.
4. Stage only files belonging to this feature; never use `git add .`.
5. Split independent changes into reviewable commits and use concise commit messages.

## Finish and create a PR

1. Confirm all intended changes are committed and the worktree is clean.
2. Create a PR body in a temporary file outside the repository. It must contain `## Summary` and `## Testing`, and list only tests that actually ran.
3. Choose a concise PR title based on the committed change.
4. Run `scripts/finish-feature.sh <title> <body-file>` from this skill directory.
5. Report success only when the script emits `PR_URL=`. If checks, authentication, push, creation, or verification fail, report that failure and do not claim that a PR exists.
6. Keep the worktree and branches after PR creation. Remove them only after an explicit user request.

## Required safety boundaries

- Baseline is always `origin/main`.
- Branches are always `codex/<slug>` and worktrees are always `.worktrees/<slug>`.
- Never use hard reset, force push, automatic stash, automatic merge/rebase, recursive deletion, or automatic worktree cleanup.
- Never treat a compare URL, draft body, or successful push as proof that the PR was created.
```

- [ ] **Step 3: Add the package test command**

Modify only the root `scripts` entries shown:

```json
"test:feature-workflow": "bash .agents/skills/feature-workflow/tests/feature-workflow.test.sh",
"test": "npm run test -w packages/server && npm run test -w packages/client && npm run test -w @itharbors/kit-sqlite && npm run test -w @itharbors/kit-mysql && node --test scripts/lib/kit-path.test.mjs && npm run test:feature-workflow"
```

- [ ] **Step 4: Make scripts executable and run skill-specific validation**

```bash
chmod +x .agents/skills/feature-workflow/scripts/start-feature.sh
chmod +x .agents/skills/feature-workflow/scripts/finish-feature.sh
chmod +x .agents/skills/feature-workflow/tests/feature-workflow.test.sh
npm run test:feature-workflow
```

Expected: every case prints `PASS`; final summary reports `0 failed`.

- [ ] **Step 5: Validate skill metadata and repository scope**

```bash
python3 /Users/bytedance/.codex/skills/.system/skill-creator/scripts/quick_validate.py .agents/skills/feature-workflow
git status --short
git check-ignore -q .worktrees/probe
```

Expected: validator reports `Skill is valid!`; Git status lists only planned skill/package changes; `git check-ignore` exits 0.

- [ ] **Step 6: Run repository verification**

```bash
npm run check
```

Expected: builds, workspace tests, plugin checks, and `test:feature-workflow` all exit 0.

- [ ] **Step 7: Commit the integrated skill**

```bash
git add .agents/skills/feature-workflow/SKILL.md .agents/skills/feature-workflow/scripts/start-feature.sh .agents/skills/feature-workflow/scripts/finish-feature.sh .agents/skills/feature-workflow/tests/feature-workflow.test.sh package.json
git commit -m "功能：添加仓库级功能开发工作流 skill"
```

- [ ] **Step 8: Final evidence review**

```bash
git status --short --branch
git log --oneline --decorate -4
npm run test:feature-workflow
```

Expected: clean worktree, three focused implementation commits are visible, and the fresh skill test run ends with `0 failed`.
