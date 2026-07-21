# Change Workflow Revision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the feature-only repository workflow with a typed change workflow that creates worktrees from a locked `origin/main` SHA and aligns branch prefixes, commit labels, and PR titles.

**Architecture:** Add a new `.agents/skills/change-workflow` package with separate start and finish Bash entrypoints. Exercise both entrypoints in disposable Git repositories with mocked `npm` and `gh`, then switch active repository metadata and delete the old Skill only after the new contract passes.

**Tech Stack:** Bash 3.2-compatible scripts, Git worktrees, GitHub CLI, npm scripts, repository-local Skill metadata, Markdown.

## Global Constraints

- Types are exactly `feature`, `bug`, `docs`, `refactor`, `optimize`, `test`, and `chore`.
- Branches are `<type>/<slug>`; slug matches `^[a-z0-9]+(-[a-z0-9]+)*$`.
- Worktrees are `.worktrees/<type>-<slug>` below the primary repository root.
- Start fetches `origin` and creates from the recorded `origin/main` SHA; local `main` and primary-worktree dirtiness are not gates.
- Finish derives the label from the branch, checks every commit in `origin/main..HEAD`, runs `npm run check`, uses a normal push, and reports success only after verifying an open PR.
- Labels are `[Feature]`, `[Bug]`, `[Docs]`, `[Refactor]`, `[Optimize]`, `[Test]`, and `[Chore]`; `[Init]` remains initialization-only.
- Never automate stash, pull, merge, rebase, hard reset, force push, recursive deletion, or worktree cleanup.
- Historical specs and plans remain historical records; active Skill files, tests, package scripts, `AGENTS.md`, and the development guide use the new workflow.

---

### Task 1: Create changes from a locked remote baseline

**Files:**
- Create: `.agents/skills/change-workflow/scripts/start-change.sh`
- Create: `.agents/skills/change-workflow/tests/test-helper.sh`
- Create: `.agents/skills/change-workflow/tests/start-change.test.sh`
- Create: `.agents/skills/change-workflow/tests/change-workflow.test.sh`

**Interfaces:**
- Consumes: `start-change.sh <type> <slug>`, a primary Git worktree, and `origin/main`.
- Produces: `<type>/<slug>`, `.worktrees/<type>-<slug>`, and `WORKTREE_PATH`, `BRANCH`, `CHANGE_TYPE`, `BASE_COMMIT` output keys.

- [ ] **Step 1: Create the common test harness**

Extract the existing assertions and fixture setup from `feature-workflow.test.sh` into `test-helper.sh`, changing the fixture identity and copied paths exactly as follows:

```bash
TEST_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
SKILL_DIR=$(cd "$TEST_DIR/.." && pwd -P)
SOURCE_START="$SKILL_DIR/scripts/start-change.sh"
SOURCE_FINISH="$SKILL_DIR/scripts/finish-change.sh"
ORIGINAL_PATH=$PATH
PASS_COUNT=0
FAIL_COUNT=0

new_fixture() {
  FIXTURE_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/change-workflow.XXXXXX")
  FIXTURE_ROOT=$(cd "$FIXTURE_ROOT" && pwd -P)
  ORIGIN="$FIXTURE_ROOT/origin.git"
  REPO="$FIXTURE_ROOT/repo"
  git init --bare "$ORIGIN" >/dev/null
  git clone "$ORIGIN" "$REPO" >/dev/null 2>&1
  REPO=$(cd "$REPO" && pwd -P)
  git -C "$REPO" config user.name 'Change Workflow Test'
  git -C "$REPO" config user.email 'change-workflow@example.com'
  git -C "$REPO" checkout -b main >/dev/null 2>&1
  mkdir -p "$REPO/.agents/skills/change-workflow/scripts"
  test ! -f "$SOURCE_START" || cp "$SOURCE_START" "$REPO/.agents/skills/change-workflow/scripts/start-change.sh"
  test ! -f "$SOURCE_FINISH" || cp "$SOURCE_FINISH" "$REPO/.agents/skills/change-workflow/scripts/finish-change.sh"
  printf '.worktrees/\n' > "$REPO/.gitignore"
  printf '{"scripts":{"check":"true"}}\n' > "$REPO/package.json"
  git -C "$REPO" add .
  git -C "$REPO" commit -m '[Init] 初始化测试仓库' >/dev/null
  git -C "$REPO" push -u origin main >/dev/null 2>&1
  git -C "$ORIGIN" symbolic-ref HEAD refs/heads/main
  START="$REPO/.agents/skills/change-workflow/scripts/start-change.sh"
}
```

Retain the complete existing implementations of `fail`, `assert_contains`, `assert_eq`, `assert_ref_missing`, and `run_case` unchanged.

- [ ] **Step 2: Write failing start-flow tests**

Create `start-change.test.sh` with these exact independent cases and assertions:

| Case | Setup | Required assertion |
| --- | --- | --- |
| all seven types | fresh fixture per type | branch `<type>/sample-change`, path `.worktrees/<type>-sample-change`, all four output keys, HEAD equals fetched `origin/main` |
| invalid type | call with `build valid-slug` | error contains `invalid change type: build`; no branch |
| invalid slug | call with `feature ../bad` | error contains `invalid slug`; no branch |
| dirty primary | create untracked file | start succeeds and new HEAD equals `origin/main` |
| ahead main | make one unpushed local commit | start succeeds from the earlier remote SHA, not local HEAD |
| behind main | push one commit from a second clone | fetch occurs and new HEAD equals the second clone HEAD |
| diverged main | make both previous changes | start succeeds from remote HEAD |
| no local main | checkout `scratch`, delete local `main` | start succeeds from `origin/main` |
| local branch collision | pre-create `feature/existing` | error contains `branch already exists` |
| remote branch collision | push `bug/existing` then fetch | error contains `remote branch already exists` |
| path collision | create `.worktrees/docs-existing` | error contains `worktree path already exists`; no branch |
| registered missing worktree | register then move `.worktrees/test-existing` | error contains `worktree already registered`; no branch |
| linked context | invoke copied script from a linked worktree | error contains `primary worktree`; no new branch |

Use this concrete pattern for every success case:

```bash
output=$("$START" docs sample-change)
worktree="$REPO/.worktrees/docs-sample-change"
base=$(git -C "$REPO" rev-parse origin/main)
assert_contains "$output" "WORKTREE_PATH=$worktree"
assert_contains "$output" 'BRANCH=docs/sample-change'
assert_contains "$output" 'CHANGE_TYPE=docs'
assert_contains "$output" "BASE_COMMIT=$base"
assert_eq "$(git -C "$worktree" rev-parse HEAD)" "$base"
```

Use this concrete pattern for every rejection case:

```bash
if output=$("$START" build valid-slug 2>&1); then fail 'invalid type succeeded'; fi
assert_contains "$output" 'invalid change type: build'
assert_ref_missing "$REPO" refs/heads/build/valid-slug
```

Create `change-workflow.test.sh` as an executable runner that sources `test-helper.sh` and `start-change.test.sh`, invokes every named case through `run_case`, prints `<passed> passed, <failed> failed`, and exits non-zero when `FAIL_COUNT` is not zero.

- [ ] **Step 3: Verify the tests fail before implementation**

Run `bash .agents/skills/change-workflow/tests/change-workflow.test.sh`.

Expected: non-zero exit because `scripts/start-change.sh` is absent.

- [ ] **Step 4: Implement `start-change.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

test "$#" -eq 2 || fail 'usage: start-change.sh <type> <slug>'
change_type=$1
slug=$2
case "$change_type" in
  feature|bug|docs|refactor|optimize|test|chore) ;;
  *) fail "invalid change type: $change_type" ;;
esac
[[ "$slug" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || fail "invalid slug: $slug"

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
repo_root=$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null) || fail 'skill is not inside a Git repository'
git_dir=$(git -C "$repo_root" rev-parse --absolute-git-dir)
git_common=$(git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir)
test "$git_dir" = "$git_common" || fail 'start must run from the primary worktree'
git -C "$repo_root" remote get-url origin >/dev/null 2>&1 || fail 'origin remote is missing'

git -C "$repo_root" fetch origin --prune
git -C "$repo_root" show-ref --verify --quiet refs/remotes/origin/main || fail 'origin/main is missing'
base_commit=$(git -C "$repo_root" rev-parse refs/remotes/origin/main)
branch="$change_type/$slug"
worktree_path="$repo_root/.worktrees/$change_type-$slug"

git -C "$repo_root" show-ref --verify --quiet "refs/heads/$branch" && fail "branch already exists: $branch"
git -C "$repo_root" show-ref --verify --quiet "refs/remotes/origin/$branch" && fail "remote branch already exists: $branch"
test ! -e "$worktree_path" || fail "worktree path already exists: $worktree_path"
if git -C "$repo_root" worktree list --porcelain | grep -Fqx "worktree $worktree_path"; then
  fail "worktree already registered: $worktree_path"
fi

git -C "$repo_root" worktree add -b "$branch" "$worktree_path" "$base_commit"
command -v gh >/dev/null 2>&1 || printf 'warning: gh is not installed; it is required to finish and create a PR\n' >&2
printf 'WORKTREE_PATH=%s\nBRANCH=%s\nCHANGE_TYPE=%s\nBASE_COMMIT=%s\n' \
  "$worktree_path" "$branch" "$change_type" "$base_commit"
```

Mark the start script and suite runner executable.

- [ ] **Step 5: Verify start behavior passes**

Run `bash .agents/skills/change-workflow/tests/change-workflow.test.sh`.

Expected: all 13 start cases pass, including dirty, ahead, behind, diverged, and missing local `main`.

- [ ] **Step 6: Review and commit**

Inspect `git status --short`, `git diff`, `git diff --cached`, and `git diff --check`; stage only the four new Task 1 files and commit:

```bash
git commit -m '[Feature] 支持按变更类型创建工作树'
```

---

### Task 2: Validate and finish typed change branches

**Files:**
- Create: `.agents/skills/change-workflow/scripts/finish-change.sh`
- Create: `.agents/skills/change-workflow/tests/finish-change.test.sh`
- Modify: `.agents/skills/change-workflow/tests/test-helper.sh`
- Modify: `.agents/skills/change-workflow/tests/change-workflow.test.sh`

**Interfaces:**
- Consumes: `finish-change.sh <summary> <body-file>` from a clean linked worktree on `<type>/<slug>`.
- Produces: derived PR title `[$label] <summary>`, validated/pushed commits, verified open PR, and `PR_URL=<url>`.

- [ ] **Step 1: Add finish fixtures and mocks**

Move the existing `install_mocks` and `write_pr_body` helpers into the new helper file, changing only fixture paths. Add this exact type mapping and prepared change:

```bash
label_for_type() {
  case "$1" in
    feature) printf 'Feature\n' ;; bug) printf 'Bug\n' ;;
    docs) printf 'Docs\n' ;; refactor) printf 'Refactor\n' ;;
    optimize) printf 'Optimize\n' ;; test) printf 'Test\n' ;;
    chore) printf 'Chore\n' ;; *) fail "unknown test type: $1" ;;
  esac
}

prepare_change() {
  local type=${1:-feature}
  new_fixture
  "$START" "$type" finish-case >/dev/null
  WORKTREE="$REPO/.worktrees/$type-finish-case"
  FINISH="$WORKTREE/.agents/skills/change-workflow/scripts/finish-change.sh"
  printf 'change\n' > "$WORKTREE/change.txt"
  git -C "$WORKTREE" add change.txt
  git -C "$WORKTREE" commit -m "[$(label_for_type "$type")] 添加测试变更" >/dev/null
  write_pr_body
  install_mocks
}
```

- [ ] **Step 2: Write failing finish-flow tests**

Create `finish-change.test.sh` and add it to the runner. Cover these exact cases:

- Seven fresh successful fixtures; each asserts the upstream is `origin/<type>/finish-case`, `npm` logged `run check`, and `gh` logged `pr create --base main --head <branch> --title [<Label>] 完成测试变更` plus `pr view`.
- Primary worktree, detached HEAD, `build/wrong-branch`, dirty worktree, missing commits, and body missing each required heading.
- Empty, labelled, multiline, Chinese-period, and ASCII-period summaries; all must fail before `npm` or `gh`.
- A `feature` branch amended to `[Bug] 使用错误标签`; error must contain `commits must start with [Feature]` and no remote branch may exist.
- Failed `npm run check`, missing `gh`, failed `gh auth status`, and mismatched PR base/head/state/URL; none may emit `PR_URL=`.

Concrete label-mismatch test:

```bash
prepare_change feature
git -C "$WORKTREE" commit --amend -m '[Bug] 使用错误标签' >/dev/null
if output=$("$FINISH" '完成测试变更' "$BODY" 2>&1); then fail 'mismatched label succeeded'; fi
assert_contains "$output" 'commits must start with [Feature]'
test ! -s "$NPM_LOG" || fail 'npm ran after label failure'
test ! -s "$GH_LOG" || fail 'gh ran after label failure'
assert_ref_missing "$ORIGIN" refs/heads/feature/finish-case
```

- [ ] **Step 3: Verify finish tests fail before implementation**

Run the suite. Expected: start cases pass; finish cases fail because `finish-change.sh` is absent.

- [ ] **Step 4: Implement `finish-change.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

test "$#" -eq 2 || fail 'usage: finish-change.sh <summary> <pr-body-file>'
summary=$1
body_file=$2
test -n "$summary" || fail 'invalid PR summary: must not be empty'
[[ "$summary" != *$'\n'* && "$summary" != *$'\r'* ]] || fail 'invalid PR summary: must be one line'
[[ ! "$summary" =~ ^\[ ]] || fail 'invalid PR summary: omit the bracketed label'
[[ ! "$summary" =~ [。.]$ ]] || fail 'invalid PR summary: omit the trailing period'
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
[[ "$branch" =~ ^(feature|bug|docs|refactor|optimize|test|chore)/[a-z0-9]+(-[a-z0-9]+)*$ ]] || fail "unexpected change branch: $branch"
change_type=${BASH_REMATCH[1]}
case "$change_type" in
  feature) label=Feature ;; bug) label=Bug ;; docs) label=Docs ;;
  refactor) label=Refactor ;; optimize) label=Optimize ;;
  test) label=Test ;; chore) label=Chore ;;
esac

test -z "$(git -C "$repo_root" status --porcelain=v1 --untracked-files=all)" || fail 'working tree is not clean'
git -C "$repo_root" remote get-url origin >/dev/null 2>&1 || fail 'origin remote is missing'
git -C "$repo_root" fetch origin --prune
git -C "$repo_root" show-ref --verify --quiet refs/remotes/origin/main || fail 'origin/main is missing'
test "$(git -C "$repo_root" rev-list --count origin/main..HEAD)" -gt 0 || fail 'change branch has no commits over origin/main'
while IFS= read -r subject; do
  case "$subject" in "[$label] "*) ;; *) fail "commits must start with [$label]: $subject" ;; esac
done < <(git -C "$repo_root" log --format=%s origin/main..HEAD)

(cd "$repo_root" && npm run check)
command -v gh >/dev/null 2>&1 || fail 'gh is not installed; install GitHub CLI before finishing'
gh auth status >/dev/null 2>&1 || fail 'gh is not authenticated; run gh auth login'
pr_title="[$label] $summary"
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

Mark the finish script executable.

- [ ] **Step 5: Verify all behavioral tests pass**

Run the suite. Expected: every start and finish case passes; successful cases alone push and emit `PR_URL=`.

- [ ] **Step 6: Review and commit**

Inspect status and all staged/unstaged diffs, run `git diff --check`, stage only Task 2 files, and commit:

```bash
git commit -m '[Feature] 校验并提交分类变更分支'
```

---

### Task 3: Switch active repository conventions to the change workflow

**Files:**
- Create: `.agents/skills/change-workflow/SKILL.md`
- Create: `.agents/skills/change-workflow/agents/openai.yaml`
- Create: `.agents/skills/change-workflow/tests/contract.test.sh`
- Modify: `.agents/skills/change-workflow/tests/change-workflow.test.sh`
- Modify: `AGENTS.md`
- Modify: `docs/guides/development-workflow.md`
- Modify: `package.json`
- Delete: all five tracked files under `.agents/skills/feature-workflow`

**Interfaces:**
- Consumes: Task 1 and Task 2 scripts.
- Produces: `$change-workflow`, npm script `test:change-workflow`, and commit regex `^\[(Init|Feature|Bug|Docs|Refactor|Optimize|Test|Chore)\] .+`.

- [ ] **Step 1: Add a failing active-contract test**

Create `contract.test.sh`, source it from the suite runner, and run this function through `run_case`:

```bash
test_skill_layout_and_contract() {
  skill_file="$SKILL_DIR/SKILL.md"
  metadata_file="$SKILL_DIR/agents/openai.yaml"
  repo_root=$(git -C "$SKILL_DIR" rev-parse --show-toplevel)
  test -f "$skill_file" || fail 'SKILL.md is missing'
  test -f "$metadata_file" || fail 'agents/openai.yaml is missing'
  assert_contains "$(sed -n '1,8p' "$skill_file")" 'name: change-workflow'
  assert_contains "$(cat "$skill_file")" 'scripts/start-change.sh'
  assert_contains "$(cat "$skill_file")" 'scripts/finish-change.sh'
  assert_contains "$(cat "$skill_file")" 'CHANGE_TYPE='
  assert_contains "$(cat "$metadata_file")" 'display_name: "Change Workflow"'
  assert_contains "$(cat "$metadata_file")" 'Use $change-workflow'
  test -x "$SKILL_DIR/scripts/start-change.sh" || fail 'start script is not executable'
  test -x "$SKILL_DIR/scripts/finish-change.sh" || fail 'finish script is not executable'
  grep -Fq '"test:change-workflow"' "$repo_root/package.json" || fail 'new package test script is missing'
  old_skill='feature''-workflow'
  old_start='start''-feature'
  old_finish='finish''-feature'
  old_prefix='codex''/'
  if grep -Fq "\"test:$old_skill\"" "$repo_root/package.json"; then fail 'old package test script remains'; fi
  test ! -e "$repo_root/.agents/skills/$old_skill" || fail 'old Skill directory remains'
  git -C "$repo_root" check-ignore -q .worktrees/probe || fail '.worktrees is not ignored'
  if rg -n "$old_prefix|$old_skill|$old_start|$old_finish" \
    "$repo_root/.agents" "$repo_root/AGENTS.md" "$repo_root/package.json" \
    "$repo_root/docs/guides/development-workflow.md"; then
    fail 'active workflow still references old naming'
  fi
}
```

- [ ] **Step 2: Verify the contract test fails before migration**

Run the suite. Expected: behavioral tests pass; the contract test fails because metadata, npm/docs references, and the old Skill have not migrated.

- [ ] **Step 3: Create active Skill instructions and metadata**

Create `SKILL.md` with the following required structure and exact operational rules:

```markdown
---
name: change-workflow
description: Use when starting, continuing, or finishing feature, bug, docs, refactor, optimization, test, or maintenance work in the Harbors repository, especially requests mentioning a worktree, branch, push, or GitHub pull request. Do not use for release branches or work outside this repository.
---

# Change Workflow

## Quick reference

| Intent | Action | Success evidence |
| --- | --- | --- |
| Start | `scripts/start-change.sh <type> <slug>` | `WORKTREE_PATH=`, `BRANCH=`, `CHANGE_TYPE=`, `BASE_COMMIT=` |
| Continue | Work only in the emitted worktree | Branch equals emitted `<type>/<slug>` |
| Finish | `scripts/finish-change.sh <summary> <body-file>` | Verified `PR_URL=` |

Types map one-to-one to labels: `feature`/`[Feature]`, `bug`/`[Bug]`, `docs`/`[Docs]`, `refactor`/`[Refactor]`, `optimize`/`[Optimize]`, `test`/`[Test]`, and `chore`/`[Chore]`. `[Init]` is initialization-only.

## Start

Choose a slug matching `^[a-z0-9]+(-[a-z0-9]+)*$`, run the start script from the primary checkout, and use its emitted worktree for every edit. The script locks fetched `origin/main`; never alter local `main` to make start pass. Report branch, path, fetch, and collision failures exactly.

## Develop and commit

Confirm the current branch before editing. Run focused tests, inspect `git status --short`, `git diff`, and `git diff --cached`, stage only relevant files, and never use `git add .`. Every commit uses the label matching its branch, with a concise Chinese summary and no trailing period.

## Finish and create a PR

Commit all work and require a clean worktree. Put `## Summary` and `## Testing` in a body file outside the repository and list only checks that ran. Call the finish script with an unlabelled single-line Chinese summary. Report success only after `PR_URL=`; keep worktrees and branches unless removal is explicitly requested.

## Hard boundaries

Do not stash, pull, merge, rebase, hard reset, force push, recursively delete, automatically clean worktrees, continue an existing branch as new work, or treat a compare URL or successful push as a created PR. Do not install this Skill in a user-level directory.
```

Create `agents/openai.yaml`:

```yaml
interface:
  display_name: "Change Workflow"
  short_description: "Start and finish isolated typed change worktrees"
  default_prompt: "Use $change-workflow to start a typed Harbors change in an isolated worktree."
```

- [ ] **Step 4: Update active commit and npm conventions**

Update `AGENTS.md` and the development guide so the eight allowed labels have these non-overlapping meanings:

| Label | Meaning |
| --- | --- |
| `[Init]` | repository initialization only |
| `[Feature]` | feature plus accompanying tests/docs |
| `[Bug]` | defect or regression fix |
| `[Docs]` | standalone documentation |
| `[Refactor]` | structure change without behavior change |
| `[Optimize]` | performance/resource improvement |
| `[Test]` | standalone tests |
| `[Chore]` | dependencies, build tooling, routine maintenance |

Use the exact regex `^\[(Init|Feature|Bug|Docs|Refactor|Optimize|Test|Chore)\] .+`, retain exact capitalization/Chinese-summary/no-period/single-reviewable-change rules, and include one example for every regular type.

In `package.json`, replace both occurrences of `test:feature-workflow` with `test:change-workflow`, and set its command to:

```json
"test:change-workflow": "bash .agents/skills/change-workflow/tests/change-workflow.test.sh"
```

- [ ] **Step 5: Remove the old active Skill and validate the new contract**

Delete the old `SKILL.md`, metadata, two scripts, and test with `apply_patch`; do not delete worktrees or branches. Run:

```bash
bash .agents/skills/change-workflow/tests/change-workflow.test.sh
python3 /Users/bytedance/.codex/skills/.system/skill-creator/scripts/quick_validate.py .agents/skills/change-workflow
rg -n 'codex/|feature-workflow|start-feature|finish-feature' \
  .agents AGENTS.md package.json docs/guides/development-workflow.md
```

Expected: all behavior and contract cases pass; validator succeeds; `rg` exits 1 with no active-workflow matches.

- [ ] **Step 6: Review and commit**

Inspect status and all diffs, run `git diff --check`, explicitly stage the new Skill, active docs/package changes, and five old-file deletions, then commit:

```bash
git commit -m '[Feature] 启用通用变更分支工作流'
```

---

### Task 4: Verify the complete repository change

**Files:**
- Verify only; no expected file changes.

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: focused-test, Skill-validation, full-check, naming-audit, commit-audit, and clean-worktree evidence.

- [ ] **Step 1: Run focused validation**

```bash
npm run test:change-workflow
python3 /Users/bytedance/.codex/skills/.system/skill-creator/scripts/quick_validate.py .agents/skills/change-workflow
```

Expected: every workflow case passes and Skill validation succeeds.

- [ ] **Step 2: Run the required repository check**

Run `npm run check`.

Expected: all builds, workspace tests, change-workflow tests, and plugin checks pass. Record any environment failure exactly; do not claim completion after a failure.

- [ ] **Step 3: Audit active names, commits, and cleanliness**

```bash
rg -n 'codex/|feature-workflow|start-feature|finish-feature' \
  .agents AGENTS.md package.json docs/guides/development-workflow.md
git log origin/main..HEAD --format='%s' | awk '!/^\[Feature\] / { print; exit 1 }'
git diff --check origin/main...HEAD
git status --short --branch
```

Expected: `rg` exits 1 without output; label and diff audits exit 0; status shows a clean `feature/change-workflow-revision`.

- [ ] **Step 4: Review the final change set**

```bash
git log --oneline --decorate origin/main..HEAD
git diff --stat origin/main...HEAD
git diff origin/main...HEAD -- AGENTS.md package.json docs/guides/development-workflow.md \
  .agents/skills/change-workflow .agents/skills/feature-workflow
```

Expected: the design/plan commits plus three focused implementation commits, with no unrelated files. Do not push or create a PR unless the user explicitly requests remote completion.
