# Commit Message Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Harbors 的提交格式恢复为 `[Init|Feature|Bug|Optimize] 摘要`，修正所有尚未推送的本地提交，同时保持远端历史和代码树安全。

**Architecture:** 规范写入开发指南和根 `AGENTS.md`；功能工作流 Skill 通过测试先行增加相同约束。历史重写使用临时 Node.js 脚本调用 `git commit-tree` 创建新提交对象，保留 tree、作者/提交者及日期，再通过带旧 SHA 条件的 `git update-ref --stdin` 原子更新三个本地分支。

**Tech Stack:** Git plumbing、Node.js 20、Bash、Markdown、Codex Agent Skills。

## Global Constraints

- 合规标题匹配 `^\[(Init|Feature|Bug|Optimize)\] .+`。
- `[Feature]` 覆盖新功能、文档、测试和新增维护内容；`[Bug]` 覆盖修复；`[Optimize]` 覆盖重构、性能和结构优化；`[Init]` 仅用于初始化。
- 只重写 `origin/main` 之后的本地历史和 `codex/feature-workflow-skill` 的一个提交。
- `origin/main` 必须始终保持 `b36201262321f22f78814fc427edf2c98cba6ad8`，不 push、不 force push。
- 保留提交 tree、作者、作者日期、提交者、提交者日期和正文，只转换标题与父 SHA。
- 三个 worktree 在写 ref 前必须干净；不使用 hard reset、不删除 worktree。
- 历史写入前必须生成包含三个本地分支的 Git bundle。

---

### Task 1: Publish and enforce the repository convention

**Files:**
- Create: `AGENTS.md`
- Modify: `docs/guides/development-workflow.md`
- Modify: `docs/superpowers/plans/2026-07-19-database-kits-chinese-localization.md`
- Modify: `docs/superpowers/plans/2026-07-19-mysql-kit.md`
- Modify: `docs/superpowers/plans/2026-07-19-sqlite-kit.md`

**Interfaces:**
- Consumes: observed historical tags `[Init]`, `[Feature]`, `[Bug]`, `[Optimize]`.
- Produces: human-readable convention plus repository-level Codex instructions.

- [ ] **Step 1: Verify the documentation currently lacks the convention**

Run:

```bash
test ! -f AGENTS.md
! rg -n '^## 提交信息规范' docs/guides/development-workflow.md
rg -n "git commit -m ['\"](功能|文档|修复|重构|优化)：" \
  docs/superpowers/plans/2026-07-19-database-kits-chinese-localization.md \
  docs/superpowers/plans/2026-07-19-mysql-kit.md \
  docs/superpowers/plans/2026-07-19-sqlite-kit.md
```

Expected: `AGENTS.md` and the guide section are absent; plan examples using the Chinese-colon format are listed.

- [ ] **Step 2: Create repository-level instructions**

Create `AGENTS.md`:

```markdown
# Harbors repository instructions

## Commit messages

Use exactly one of these title formats:

- `[Init] 摘要` — repository initialization only.
- `[Feature] 摘要` — features, documentation, tests, and newly added maintenance content.
- `[Bug] 摘要` — bug and regression fixes.
- `[Optimize] 摘要` — refactoring, performance, structure, and maintainability improvements without intended feature changes.

Keep the tag capitalization exact, write a concise Chinese summary without a trailing period, and keep each commit focused on one reviewable change. See `docs/guides/development-workflow.md` for the full convention.
```

- [ ] **Step 3: Add the developer-facing convention**

Add a `## 提交信息规范` section before `## 提交前最小检查` in `docs/guides/development-workflow.md`. Include the exact regex, the four-type table, examples, capitalization requirement, concise Chinese summary rule, and one-logical-change rule from the design.

- [ ] **Step 4: Normalize executable commit examples in active plans**

Change only `git commit -m` examples:

```text
功能：<摘要> -> [Feature] <摘要>
文档：<摘要> -> [Feature] <摘要>
修复：<摘要> -> [Bug] <摘要>
重构：<摘要> / 优化：<摘要> -> [Optimize] <摘要>
```

Leave prose that explains the old-to-new history conversion unchanged.

- [ ] **Step 5: Verify and commit the convention**

Run:

```bash
rg -n '^## 提交信息规范' docs/guides/development-workflow.md
! rg -n "git commit -m ['\"](功能|文档|修复|重构|优化)：" \
  docs/superpowers/plans/2026-07-19-database-kits-chinese-localization.md \
  docs/superpowers/plans/2026-07-19-mysql-kit.md \
  docs/superpowers/plans/2026-07-19-sqlite-kit.md
git diff --check
```

Commit:

```bash
git add AGENTS.md docs/guides/development-workflow.md docs/superpowers/plans/2026-07-19-database-kits-chinese-localization.md docs/superpowers/plans/2026-07-19-mysql-kit.md docs/superpowers/plans/2026-07-19-sqlite-kit.md
git commit -m '[Feature] 规范提交信息格式'
```

### Task 2: Teach the feature workflow Skill the convention with TDD

**Files:**
- Modify: `.agents/skills/feature-workflow/tests/feature-workflow.test.sh`
- Modify: `.agents/skills/feature-workflow/SKILL.md`
- Modify: `docs/superpowers/plans/2026-07-19-repository-feature-workflow-skill.md`

**Interfaces:**
- Consumes: repository convention from Task 1.
- Produces: Skill instructions and contract tests that require the exact tag vocabulary.

- [ ] **Step 1: Add the failing Skill contract assertions**

In `test_skill_layout_and_contract`, add:

```bash
assert_contains "$(cat "$skill_file")" '[Feature]'
assert_contains "$(cat "$skill_file")" '[Bug]'
assert_contains "$(cat "$skill_file")" '[Optimize]'
assert_contains "$(cat "$skill_file")" 'docs/guides/development-workflow.md'
```

- [ ] **Step 2: Run RED**

Run `npm run test:feature-workflow` in `.worktrees/feature-workflow-skill`.

Expected: the existing 22 cases run, and `skill layout and contract` fails because the Skill does not yet contain `[Feature]`.

- [ ] **Step 3: Add minimal Skill guidance and normalize its plan examples**

Replace “use concise commit messages” with:

```markdown
5. Follow `docs/guides/development-workflow.md`: use `[Feature]` for features/docs/tests, `[Bug]` for fixes, and `[Optimize]` for refactors or performance/structure improvements. Keep each commit reviewable.
```

Normalize every executable `git commit -m` example in the Skill implementation plan using the Task 1 mapping.

- [ ] **Step 4: Run GREEN and validate the Skill**

Run:

```bash
npm run test:feature-workflow
python3 /Users/bytedance/.codex/skills/.system/skill-creator/scripts/quick_validate.py .agents/skills/feature-workflow
git diff --check
```

Expected: 22 cases pass, validator prints `Skill is valid!`, and diff check exits 0.

- [ ] **Step 5: Fold the change into the existing single feature commit**

From `.worktrees/feature-workflow-skill`:

```bash
git add .agents/skills/feature-workflow/SKILL.md .agents/skills/feature-workflow/tests/feature-workflow.test.sh docs/superpowers/plans/2026-07-19-repository-feature-workflow-skill.md
git commit --amend -m '[Feature] 添加仓库级功能开发工作流 skill'
test "$(git rev-list --count main..HEAD)" -eq 1
```

### Task 3: Back up and rebuild local commits without changing trees

**Files:**
- Temporary only: `<mktemp-dir>/rewrite-local-history.mjs`
- Temporary only: `<mktemp-dir>/harbors-before-normalization.bundle`

**Interfaces:**
- Consumes: exact old SHAs for `origin/main`, `main`, `feat/database-kits-zh-cn`, and `codex/feature-workflow-skill`.
- Produces: new commit objects and new SHAs; does not update refs itself.

- [ ] **Step 1: Record preconditions and create the bundle**

Run read-only checks for all three worktrees, reject merge commits, record ref/tree/count values, then:

```bash
NORMALIZE_TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}harbors-commit-normalization.XXXXXX")
git bundle create "$NORMALIZE_TMP_DIR/harbors-before-normalization.bundle" main feat/database-kits-zh-cn codex/feature-workflow-skill origin/main
git bundle verify "$NORMALIZE_TMP_DIR/harbors-before-normalization.bundle"
```

- [ ] **Step 2: Create the one-time commit-object builder**

Create `<mktemp-dir>/rewrite-local-history.mjs` with these behaviors:

```javascript
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [base, oldMain, oldDatabase, oldFeature] = process.argv.slice(2);
if (![base, oldMain, oldDatabase, oldFeature].every(Boolean)) {
  throw new Error('usage: rewrite-local-history.mjs <base> <main> <database> <feature>');
}

const git = (args, options = {}) => execFileSync('git', args, {
  cwd: process.cwd(),
  encoding: options.encoding ?? 'utf8',
  env: options.env ?? process.env,
  input: options.input,
}).trim();

function normalizeMessage(message) {
  const trimmed = message.replace(/\n+$/, '');
  const [subject, ...bodyLines] = trimmed.split('\n');
  let normalized = subject;
  if (/^(功能|文档)：/.test(subject)) normalized = `[Feature] ${subject.slice(3)}`;
  else if (/^修复：/.test(subject)) normalized = `[Bug] ${subject.slice(3)}`;
  else if (/^(重构|优化)：/.test(subject)) normalized = `[Optimize] ${subject.slice(3)}`;
  else if (!/^\[(Init|Feature|Bug|Optimize)\] .+/.test(subject)) throw new Error(`unmapped subject: ${subject}`);
  return bodyLines.length ? `${normalized}\n${bodyLines.join('\n')}\n` : `${normalized}\n`;
}

function metadata(commit) {
  const raw = execFileSync('git', ['show', '-s', '--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B', commit], { encoding: 'utf8' });
  const [an, ae, ad, cn, ce, cd, ...messageParts] = raw.split('\0');
  return { an, ae, ad, cn, ce, cd, message: messageParts.join('\0') };
}

function createCommit(oldCommit, newParent, tree) {
  const meta = metadata(oldCommit);
  return git(['commit-tree', tree, '-p', newParent], {
    input: normalizeMessage(meta.message),
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: meta.an,
      GIT_AUTHOR_EMAIL: meta.ae,
      GIT_AUTHOR_DATE: meta.ad,
      GIT_COMMITTER_NAME: meta.cn,
      GIT_COMMITTER_EMAIL: meta.ce,
      GIT_COMMITTER_DATE: meta.cd,
    },
  });
}

const commits = git(['rev-list', '--reverse', `${base}..${oldMain}`]).split('\n').filter(Boolean);
const mapping = new Map();
let oldParent = base;
let newParent = base;
for (const oldCommit of commits) {
  const parents = git(['rev-list', '--parents', '-n', '1', oldCommit]).split(' ');
  if (parents.length !== 2 || parents[1] !== oldParent) throw new Error(`non-linear main history at ${oldCommit}`);
  const tree = git(['rev-parse', `${oldCommit}^{tree}`]);
  const newCommit = createCommit(oldCommit, newParent, tree);
  mapping.set(oldCommit, newCommit);
  oldParent = oldCommit;
  newParent = newCommit;
}

const featureParent = git(['rev-parse', `${oldFeature}^`]);
if (git(['rev-list', '--count', `${featureParent}..${oldFeature}`]) !== '1') throw new Error('feature branch must contain one commit');
const tempIndexDir = mkdtempSync(join(tmpdir(), 'harbors-history-index-'));
const indexFile = join(tempIndexDir, 'index');
const indexEnv = { ...process.env, GIT_INDEX_FILE: indexFile };
git(['read-tree', newParent], { env: indexEnv });
const patch = execFileSync('git', ['diff', '--binary', featureParent, oldFeature]);
const applied = spawnSync('git', ['apply', '--cached', '--3way', '--whitespace=nowarn'], { cwd: process.cwd(), env: indexEnv, input: patch });
if (applied.status !== 0) throw new Error(applied.stderr.toString());
const featureTree = git(['write-tree'], { env: indexEnv });
const newFeature = createCommit(oldFeature, newParent, featureTree);
const newDatabase = mapping.get(oldDatabase);
if (!newDatabase) throw new Error('database branch tip is not in rewritten main history');

process.stdout.write(JSON.stringify({ newMain: newParent, newDatabase, newFeature }));
```

- [ ] **Step 3: Build new objects and prepare the feature worktree**

Capture old refs, run the helper, parse the returned JSON, verify main/database tree equality, then apply the expected old-feature-to-new-feature tree delta to the clean feature worktree:

```bash
git diff --binary "$OLD_FEATURE" "$NEW_FEATURE" | git -C .worktrees/feature-workflow-skill apply --index --3way
```

Expected: feature worktree becomes staged only with main-side convention documentation; no conflicts.

- [ ] **Step 4: Atomically update all local refs**

Use old-value guards:

```bash
printf 'start\nupdate refs/heads/main %s %s\nupdate refs/heads/feat/database-kits-zh-cn %s %s\nupdate refs/heads/codex/feature-workflow-skill %s %s\nprepare\ncommit\n' \
  "$NEW_MAIN" "$OLD_MAIN" "$NEW_DATABASE" "$OLD_DATABASE" "$NEW_FEATURE" "$OLD_FEATURE" |
  git update-ref --stdin
```

Expected: transaction commits atomically; all three worktrees become clean because their trees/indexes already match the new refs.

### Task 4: Verify normalized history and repository behavior

**Files:** none.

**Interfaces:**
- Consumes: recorded old refs/trees/counts and rewritten refs.
- Produces: evidence that only local messages/parents and planned documentation changed.

- [ ] **Step 1: Verify refs, trees, counts, and messages**

Run:

```bash
test "$(git rev-parse origin/main)" = b36201262321f22f78814fc427edf2c98cba6ad8
git log origin/main..main --format='%s' | awk '!/^\[(Init|Feature|Bug|Optimize)\] / { exit 1 }'
git log main..codex/feature-workflow-skill --format='%s' | awk '!/^\[(Init|Feature|Bug|Optimize)\] / { exit 1 }'
test "$(git rev-list --count main..codex/feature-workflow-skill)" -eq 1
git -C .worktrees/database-kits-zh-cn status --porcelain=v1
git -C .worktrees/feature-workflow-skill status --porcelain=v1
git status --porcelain=v1
```

Expected: origin SHA unchanged; no nonconforming local subjects; feature branch one commit ahead; all status outputs empty.

- [ ] **Step 2: Run complete validation**

Run in `.worktrees/feature-workflow-skill`:

```bash
git diff --check main..HEAD
python3 /Users/bytedance/.codex/skills/.system/skill-creator/scripts/quick_validate.py .agents/skills/feature-workflow
npm run test:feature-workflow
npm run check
```

Expected: diff check exits 0, validator prints `Skill is valid!`, 22 workflow cases pass, and the full build/test/plugin check exits 0.

- [ ] **Step 3: Report recovery data and stop before any remote action**

Report the bundle path, old-to-new branch SHAs, normalized subjects, preserved remote SHA, and verification totals. Do not push or delete the bundle/worktrees.
