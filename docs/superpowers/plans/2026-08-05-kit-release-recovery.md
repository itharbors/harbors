# Kit 不可变发布恢复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 发布受信的 `kit-publish-v3`，并在不移动 Agent Guard Preview 3 产品 Tag 的前提下补齐 Release、attestation 与 Registry。

**Architecture:** `publish-kit.yml` 把 Tag push、Tag-ref dispatch 和受限的 main recovery dispatch 归一化成一个产品 Tag；`publish-kit-reusable.yml@kit-publish-v3` 始终从该 Tag 解析源码 Commit、消费 `kit:check` 的单一 `.hkit` 并签名发布。生成端只接受 v3 signer，读取端与 Registry policy 同时信任 v1、v2、v3，以保持历史 Release 兼容。

**Tech Stack:** GitHub Actions YAML、Node.js 22.18.0、`node:test`、GitHub CLI、Harbors Kit CLI/Registry 发布库。

## Global Constraints

- 产品 Tag `kit/agent-guard/v0.1.0-preview.3` 必须保持指向 `ecbe04824e4ca10d2f695bcb12663caed8a91e32`。
- 不删除、移动、覆盖或重建任何已有 Kit Tag 或 GitHub Release。
- 恢复只允许从 `refs/heads/main` dispatch，并且只在精确 Release 返回 HTTP 404 时继续。
- 所有构建、checkout、元数据 Commit 和产品 workflow identity 都来自 `refs/tags/{release-tag}`，不能来自恢复调用的 `GITHUB_SHA`、`GITHUB_REF` 或 `GITHUB_WORKFLOW_REF`。
- 新生成的 `release.json.source.signerWorkflow` 必须精确等于 `itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v3`。
- Registry 必须继续信任 `kit-publish-v1`、`kit-publish-v2`，并新增 `kit-publish-v3`；`main` 等可变 signer ref 仍然拒绝。
- Preview 与 Stable 都必须在 attestation 之前拒绝已有 Release，且禁止 `--clobber`、资产替换和 Release 删除。
- 工作分支为 `bug/kit-release-recovery`；实现提交使用 `[Bug]`，文档或测试独立提交可使用 `[Docs]`、`[Test]`。

---

## File map

- `.github/workflows/publish-kit.yml`：把触发上下文解析为权威产品 Tag，限制 main recovery，检出产品 Tag，并调用不可变 v3 publisher。
- `.github/workflows/publish-kit-reusable.yml`：定义 v3 的 `release-tag` 输入、Tag/Commit 身份、制品准备、非覆盖检查、attestation 与 Release。
- `scripts/lib/kit-publish/metadata.mjs`：限制新生成发布元数据只能声明 v3 signer。
- `scripts/lib/kit-publish/registry.mjs`：验证历史和新 Release 的不可变 signer allowlist。
- `scripts/lib/kit-monorepo.mjs`：严格校验仓库 policy 只含经批准的 v1、v2、v3 signer。
- `registry/policy.json`：Registry Release 扫描器的仓库级 signer allowlist。
- `scripts/lib/kit-publish/{metadata,cli,registry,release-source,workflows}.test.mjs`：发布元数据、CLI、Registry、线上 Release 扫描和 workflow 静态契约测试。
- `scripts/lib/kit-monorepo.test.mjs`：验证官方 policy 精确 signer 列表。

### Task 1: 建立 v3 元数据与 Registry 信任闭环

**Files:**
- Modify: `scripts/lib/kit-publish/metadata.test.mjs`
- Modify: `scripts/lib/kit-publish/cli.test.mjs`
- Modify: `scripts/lib/kit-publish/registry.test.mjs`
- Modify: `scripts/lib/kit-publish/release-source.test.mjs`
- Modify: `scripts/lib/kit-monorepo.test.mjs`
- Modify: `scripts/lib/kit-publish/metadata.mjs`
- Modify: `scripts/lib/kit-publish/registry.mjs`
- Modify: `scripts/lib/kit-monorepo.mjs`
- Modify: `registry/policy.json`

**Interfaces:**
- Consumes: `createKitPublicationMetadata(input)`、`validateRegistryRelease(entry, release)`、`loadKitPolicy({ repositoryRoot })`。
- Produces: 新元数据固定 v3 signer；Registry/Release scanner 接受精确的 v1、v2、v3 signer Tag，拒绝其他 Tag 和 branch ref。

- [ ] **Step 1: 把生成端测试切换到 v3 signer**

  在 `metadata.test.mjs` 将 `publishSignerWorkflow` 改为：

  ```js
  const publishSignerWorkflow = 'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v3';
  ```

  在非法 signer 用例中使用一个未授权的不可变版本，保证测试不是只拒绝路径错误：

  ```js
  ['signer workflow', {
    signerWorkflow: 'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v4',
  }],
  ```

  将 `cli.test.mjs` 的 `runPrepare`、`runDirectoryPrepare` 参数和 `release.source.signerWorkflow` 断言全部改为 `kit-publish-v3`；将目录用例标题改为 `prepare supports the legacy directory input contract without weakening publication output guarantees`，说明 v2 workflow 的历史代码不被改写，而 main 上的新生成器使用 v3 身份。

- [ ] **Step 2: 扩展读取端测试，明确 v1/v2/v3 兼容边界**

  在 `registry.test.mjs` 新增：

  ```js
  const publishSignerV3 = 'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v3';
  ```

  将 signer 测试改名为 `trusts only immutable v1, v2, or v3 signer releases with Tag-based caller workflows`，通过列表使用：

  ```js
  for (const signerWorkflow of [publishSignerV1, publishSignerV2, publishSignerV3]) {
  ```

  拒绝列表精确包含：

  ```js
  [
    'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v4',
    'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/heads/main',
  ]
  ```

  将同文件其他把 v3 当作非法 signer 的 mutation 改成 v4。把 `release-source.test.mjs` 的 `signerWorkflow` fixture 改成 v3，让 Release API、Tag peeling、asset 与 provenance 的端到端测试覆盖新 signer。

  在 `kit-monorepo.test.mjs` 的 policy 断言中按顺序增加：

  ```js
  'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v3',
  ```

- [ ] **Step 3: 运行测试并确认红灯来自 v3 尚未受信**

  Run:

  ```bash
  node --test \
    scripts/lib/kit-publish/metadata.test.mjs \
    scripts/lib/kit-publish/cli.test.mjs \
    scripts/lib/kit-publish/registry.test.mjs \
    scripts/lib/kit-publish/release-source.test.mjs \
    scripts/lib/kit-monorepo.test.mjs
  ```

  Expected: FAIL；至少包含 `signerWorkflow must equal ...kit-publish-v2`、v3 signer 不受信或 policy 缺少 v3 的断言差异。

- [ ] **Step 4: 实现最小 v3 生成与兼容读取配置**

  在 `metadata.mjs` 只把生成常量更新为：

  ```js
  const PUBLISH_SIGNER_WORKFLOW = 'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v3';
  ```

  在 `registry.mjs` 的 `PUBLISH_SIGNER_WORKFLOWS` 尾部增加：

  ```js
  'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v3',
  ```

  在 `registry/policy.json` 的 `signerWorkflows` 中按 v1、v2、v3 顺序加入同一 v3 字符串。不要删除 v1/v2，也不要加入 branch ref 或未创建的 v4。

  在 `kit-monorepo.mjs` 的 `expectedSigners` 中按相同顺序增加 v3；继续使用完整数组相等校验，不能改成前缀匹配或任意 Tag 接受。

- [ ] **Step 5: 运行发布库与 policy 测试并确认绿灯**

  Run:

  ```bash
  node --test \
    scripts/lib/kit-publish/metadata.test.mjs \
    scripts/lib/kit-publish/cli.test.mjs \
    scripts/lib/kit-publish/registry.test.mjs \
    scripts/lib/kit-publish/release-source.test.mjs \
    scripts/lib/kit-monorepo.test.mjs
  ```

  Expected: PASS；生成测试只使用 v3，Registry 兼容测试接受 v1/v2/v3 并拒绝 v4/main。

- [ ] **Step 6: 提交信任链修改**

  ```bash
  git add \
    registry/policy.json \
    scripts/lib/kit-monorepo.mjs \
    scripts/lib/kit-monorepo.test.mjs \
    scripts/lib/kit-publish/cli.test.mjs \
    scripts/lib/kit-publish/metadata.mjs \
    scripts/lib/kit-publish/metadata.test.mjs \
    scripts/lib/kit-publish/registry.mjs \
    scripts/lib/kit-publish/registry.test.mjs \
    scripts/lib/kit-publish/release-source.test.mjs
  git commit -m '[Bug] 信任 Kit 发布器 v3'
  ```

### Task 2: 让正常发布与 main recovery 共用产品 Tag 身份

**Files:**
- Modify: `scripts/lib/kit-publish/workflows.test.mjs`
- Modify: `.github/workflows/publish-kit.yml`
- Modify: `.github/workflows/publish-kit-reusable.yml`

**Interfaces:**
- Consumes: caller input `release-tag: string` 和当前触发上下文；官方 Kit policy；Task 1 的 v3 metadata signer。
- Produces: reusable input `release-tag`；context outputs `release-ref: string`、`release-commit: 40-char SHA`、Kit identity；发布元数据使用规范产品 workflow 与 v3 signer。

- [ ] **Step 1: 修改 workflow 契约测试以描述 main recovery 和 v3**

  把 caller 用例改名为 `mainline caller normalizes exact Kit Tags for automatic publication and main recovery through immutable v3 workflows`，保留 push/dispatch/run-name 断言，并增加以下约束：

  ```js
  assert.match(context, /GITHUB_REF.*refs\/heads\/main/u);
  assert.match(context, /refs\/tags\/\$release_tag/u);
  assert.match(context, /gh api "repos\/\$GITHUB_REPOSITORY\/releases\/tags\/\$RELEASE_TAG"/u);
  assert.match(context, /HTTP 404/u);
  assert.match(context, /git merge-base --is-ancestor "\$release_commit" origin\/main/u);
  assert.match(context, /actions\/checkout@v6[\s\S]*ref:\s*refs\/tags\/\$\{\{ steps\.release\.outputs\.release-tag \}\}/u);
  assert.match(preflight, /ref:\s*refs\/tags\/\$\{\{ needs\.context\.outputs\.release-tag \}\}/u);
  assert.match(publish, /uses:\s*itharbors\/harbors\/\.github\/workflows\/publish-kit-reusable\.yml@kit-publish-v3/u);
  assert.match(publish, /release-tag:\s*\$\{\{ needs\.context\.outputs\.release-tag \}\}/u);
  ```

  把 reusable context 测试改为要求必填字符串输入：

  ```js
  assert.match(workflow, /^on:\n  workflow_call:\n    inputs:\n      release-tag:\n        description:\s*.+\n        required:\s*true\n        type:\s*string$/mu);
  ```

  并断言 context 先校验 canonical Tag，再使用 `refs/tags/${{ inputs.release-tag }}` checkout，输出 `release-ref` 与 `release-commit`，祖先校验使用解析出的 `$release_commit`。prepare 测试改为断言 checkout 使用 `${{ needs.context.outputs.release-ref }}`，且 prepare 命令包含：

  ```text
  --commit "$RELEASE_COMMIT"
  --workflow "$GITHUB_REPOSITORY/.github/workflows/publish-kit.yml@$RELEASE_REF"
  --signer-workflow itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v3
  --ref "$RELEASE_REF"
  ```

  在 Preview/Stable 测试中，对每个 publish job 比较字符串位置，要求 `Require missing` step 在 `actions/attest@v4` 之前，404 检查在 attestation 之前，并要求 Release notes 使用 `$RELEASE_COMMIT`。将 registry reusable pin 断言更新为 `publish-kit-registry.yml@kit-publish-v3`。

- [ ] **Step 2: 运行 workflow 测试并确认旧 v2/ref 语义失败**

  Run:

  ```bash
  node --test scripts/lib/kit-publish/workflows.test.mjs
  ```

  Expected: FAIL；caller 仍固定 v2，reusable 无 `release-tag` 输入，checkout/metadata 仍读取 caller ref 与 SHA，Release 缺失检查仍位于 attestation 之后。

- [ ] **Step 3: 在 caller 中解析并约束唯一产品 Tag**

  在 `.github/workflows/publish-kit.yml` 的 context job 增加 `release-tag` output，并用一个 `id: release` step 完成以下精确逻辑：

  ```bash
  set -euo pipefail
  if [[ "$GITHUB_EVENT_NAME" == push ]]; then
    release_tag="$GITHUB_REF_NAME"
  elif [[ "$GITHUB_EVENT_NAME" == workflow_dispatch ]]; then
    release_tag="$EXPECTED_TAG"
    if [[ "$GITHUB_REF" != "refs/tags/$release_tag" && "$GITHUB_REF" != refs/heads/main ]]; then
      echo "Dispatch must run on the exact release Tag or main recovery" >&2
      exit 1
    fi
  else
    echo "Unsupported publication event: $GITHUB_EVENT_NAME" >&2
    exit 1
  fi
  if [[ ! "$release_tag" =~ ^kit/[a-z0-9]+(-[a-z0-9]+)*/v.+$ ]]; then
    echo "Publication requires an exact canonical Kit Tag" >&2
    exit 1
  fi
  echo "release-tag=$release_tag" >> "$GITHUB_OUTPUT"
  ```

  该 step 通过 `EXPECTED_TAG: ${{ inputs['release-tag'] }}` 接收 dispatch 输入。随后 checkout 明确设置：

  ```yaml
  ref: refs/tags/${{ steps.release.outputs.release-tag }}
  ```

  checkout 后通过 `git cat-file -t` 要求 lightweight Tag，通过 `git rev-parse --verify "$RELEASE_REF^{commit}"` 得到 `release_commit`，fetch `origin/main` 后执行：

  ```bash
  git merge-base --is-ancestor "$release_commit" origin/main
  ```

  `Resolve trusted release Kit` 不再解析 `GITHUB_REF`，而是从 `RELEASE_TAG: ${{ steps.release.outputs.release-tag }}` 提取 slug。仅当 `github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'` 时运行恢复预检；使用 `gh api "repos/$GITHUB_REPOSITORY/releases/tags/$RELEASE_TAG"`，status 0 报 `Release already exists`，stderr 不含 `(HTTP 404)` 时原样失败，只有 404 继续。

  preflight checkout 使用 `refs/tags/${{ needs.context.outputs.release-tag }}`。publish job 改为：

  ```yaml
  needs: [context, preflight]
  uses: itharbors/harbors/.github/workflows/publish-kit-reusable.yml@kit-publish-v3
  with:
    release-tag: ${{ needs.context.outputs.release-tag }}
  secrets: inherit
  ```

- [ ] **Step 4: 在 reusable 中只信任输入产品 Tag 和解析出的 Commit**

  将 workflow header 改为：

  ```yaml
  on:
    workflow_call:
      inputs:
        release-tag:
          description: Exact immutable Kit release Tag
          required: true
          type: string
  ```

  context job 的第一个 shell step `id: identity` 用 `RELEASE_TAG: ${{ inputs.release-tag }}` 校验相同 canonical 正则，并输出 `release-ref=refs/tags/$RELEASE_TAG`。checkout 使用 `${{ steps.identity.outputs.release-ref }}`。checkout 后的 `id: source` step 必须：

  ```bash
  set -euo pipefail
  test "$(git cat-file -t "$RELEASE_REF")" = commit
  release_commit="$(git rev-parse --verify "$RELEASE_REF^{commit}")"
  git fetch --no-tags origin main
  git rev-parse --verify origin/main
  git merge-base --is-ancestor "$release_commit" origin/main
  echo "release-commit=$release_commit" >> "$GITHUB_OUTPUT"
  ```

  context outputs 增加：

  ```yaml
  release-ref: ${{ steps.identity.outputs.release-ref }}
  release-commit: ${{ steps.source.outputs.release-commit }}
  ```

  policy Node step 使用显式 `RELEASE_REF` 和 `RELEASE_TAG` 环境变量，不读取 `GITHUB_REF`。prepare checkout 使用 `${{ needs.context.outputs.release-ref }}`；prepare env 增加 `RELEASE_REF` 与 `RELEASE_COMMIT`，调用参数精确改为：

  ```bash
  --commit "$RELEASE_COMMIT" \
  --workflow "$GITHUB_REPOSITORY/.github/workflows/publish-kit.yml@$RELEASE_REF" \
  --signer-workflow itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v3 \
  --ref "$RELEASE_REF"
  ```

  Preview 与 Stable job 都从 `${{ needs.context.outputs.release-commit }}` 设置 `RELEASE_COMMIT`。在 attestation step 之前分别增加 `Require missing Preview Release` 和 `Require missing Stable Release`，两者使用与 caller recovery 相同的 `gh api` status/404 判断。保留 `gh release create --verify-tag` 作为竞态保护，删除 attestation 之后的 `gh release view`，Release notes 改为引用 `$RELEASE_COMMIT`。最后把 `publish-kit-registry.yml` 的 reusable pin 改为 `@kit-publish-v3`。

- [ ] **Step 5: 运行 workflow 和完整 Kit 发布测试**

  Run:

  ```bash
  node --test scripts/lib/kit-publish/workflows.test.mjs
  npm run test:kit-publish
  ```

  Expected: PASS；静态契约中不再存在产品构建使用 `${{ github.ref }}`、`$GITHUB_SHA`、`$GITHUB_WORKFLOW_REF` 或 v2 signer 的路径，CLI/metadata/Registry 测试全部通过。

- [ ] **Step 6: 提交 workflow 修复**

  ```bash
  git add \
    .github/workflows/publish-kit.yml \
    .github/workflows/publish-kit-reusable.yml \
    scripts/lib/kit-publish/workflows.test.mjs
  git commit -m '[Bug] 支持 Kit 不可变发布恢复'
  ```

### Task 3: 完成本地验证并提交 PR

**Files:**
- Verify: all files changed by Tasks 1-2
- Create outside repository: temporary PR body file from `mktemp`

**Interfaces:**
- Consumes: Task 1 的 v3 trust chain 和 Task 2 的 workflow contract。
- Produces: clean `bug/kit-release-recovery` worktree and a verified open PR targeting `main`。

- [ ] **Step 1: 运行发布、release intent 与仓库预检**

  Run:

  ```bash
  npm run test:kit-publish
  npm run test:kit-release-intent
  npm run test:preflight
  ```

  Expected: 三条命令均 exit 0；所有 `node:test` suite PASS。

- [ ] **Step 2: 检查差异、提交历史和工作树**

  Run:

  ```bash
  git diff --check
  git status --short
  git log --oneline origin/main..HEAD
  ```

  Expected: `git diff --check` 无输出，`git status --short` 无输出；提交历史只包含设计文档、实施计划、v3 trust 和 recovery workflow 四个聚焦提交。

- [ ] **Step 3: 使用仓库 finish workflow 推送并创建 PR**

  在仓库外创建 body：

  ```bash
  pr_body="$(mktemp)"
  printf '%s\n' \
    '## Summary' \
    '- add immutable kit-publish-v3 signer trust while preserving v1/v2 compatibility' \
    '- allow fail-closed main recovery for an existing Kit Tag with no Release' \
    '- derive checkout, metadata, attestation, and notes from the product Tag Commit' \
    '' \
    '## Testing' \
    '- npm run test:kit-publish' \
    '- npm run test:kit-release-intent' \
    '- npm run test:preflight' > "$pr_body"
  /Users/bytedance/Project/harbors/.agents/skills/change-workflow/scripts/finish-change.sh \
    '支持 Kit 不可变发布恢复' \
    "$pr_body"
  ```

  Expected: 输出匹配 `^PR_URL=https://github.com/itharbors/harbors/pull/[1-9][0-9]*$`，并验证 PR open、base `main`、head `bug/kit-release-recovery`。

- [ ] **Step 4: 等待 PR CI，通过后 squash merge**

  从 `PR_URL` 解析 number，执行：

  ```bash
  gh pr checks "$pr_number" --repo itharbors/harbors --watch --fail-fast
  gh pr merge "$pr_number" --repo itharbors/harbors --squash
  gh pr view "$pr_number" --repo itharbors/harbors --json state,mergedAt,mergeCommit
  ```

  Expected: checks 全部通过；PR state 为 `MERGED`，`mergeCommit.oid` 是 40 字符 SHA。若 branch protection 要求其他合并方式，停止自动重试并保留已通过的 PR，不绕过保护。

### Task 4: 建立不可变 v3 publisher 并恢复 Agent Guard Preview 3

**Files:**
- External Git refs: create `refs/tags/kit-publish-v3` once
- External GitHub Actions/Release/Pages state: dispatch and verify recovery
- No repository file modifications

**Interfaces:**
- Consumes: Task 3 merge Commit、现有产品 Tag `kit/agent-guard/v0.1.0-preview.3`、`publish-kit.yml` recovery inputs。
- Produces: immutable v3 infrastructure Tag；Agent Guard Preview Release quartet；v3 attestations；Registry preview `0.1.0-preview.3`。

- [ ] **Step 1: 核验产品 Tag 和 v3 Tag 的写入前置条件**

  Run:

  ```bash
  product_tag='kit/agent-guard/v0.1.0-preview.3'
  expected_product_commit='ecbe04824e4ca10d2f695bcb12663caed8a91e32'
  git fetch --no-tags origin main
  merge_commit="$(git rev-parse origin/main)"
  test "$(git ls-remote origin "refs/tags/$product_tag" | cut -f1)" = "$expected_product_commit"
  test -z "$(git ls-remote origin refs/tags/kit-publish-v3)"
  if gh release view "$product_tag" --repo itharbors/harbors >/dev/null 2>&1; then
    echo "Release already exists: $product_tag" >&2
    exit 1
  fi
  git merge-base --is-ancestor "$expected_product_commit" "$merge_commit"
  ```

  Expected: 产品 Tag SHA 精确匹配，Release 和 v3 Tag 都不存在，产品 Commit 是最新 `origin/main` 的祖先。任何断言失败都停止，绝不删除或移动 Tag。

- [ ] **Step 2: 创建并推送一次性基础设施 Tag**

  Run:

  ```bash
  git tag kit-publish-v3 "$merge_commit"
  git push origin refs/tags/kit-publish-v3
  test "$(git ls-remote origin refs/tags/kit-publish-v3 | cut -f1)" = "$merge_commit"
  ```

  Expected: 远端 `kit-publish-v3` 精确指向 Task 3 merge Commit。若 push 失败，不使用 force，不移动现有 ref。

- [ ] **Step 3: 从 main 发起唯一一次 Preview 3 恢复**

  Run:

  ```bash
  request_id="kit-recovery-agent-guard-preview-3-$(date -u +%Y%m%dT%H%M%SZ)"
  gh workflow run publish-kit.yml \
    --repo itharbors/harbors \
    --ref main \
    -f release-tag="$product_tag" \
    -f request-id="$request_id"
  run_id=''
  for attempt in {1..60}; do
    run_id="$(gh run list \
      --repo itharbors/harbors \
      --workflow publish-kit.yml \
      --event workflow_dispatch \
      --limit 20 \
      --json databaseId,displayTitle \
      --jq ".[] | select(.displayTitle == \"Publish Kit $product_tag $request_id\") | .databaseId" \
      | head -n 1)"
    if [[ -n "$run_id" ]]; then break; fi
    sleep 2
  done
  test -n "$run_id"
  gh run watch "$run_id" --repo itharbors/harbors --exit-status
  ```

  Expected: recovery run exit 0；context、preflight、v3 reusable publish 和 Registry refresh 全部成功。若 run 失败，保留产品 Tag、v3 Tag、attestation 和 Release 现状，先诊断再决定后续动作，不重复 dispatch。

- [ ] **Step 4: 核验 Release 四件套、Commit、digest 和 attestation**

  Run:

  ```bash
  verify_dir="$(mktemp -d)"
  gh release view "$product_tag" \
    --repo itharbors/harbors \
    --json tagName,isDraft,isPrerelease,targetCommitish,assets \
    > "$verify_dir/release-view.json"
  jq -e --arg tag "$product_tag" --arg commit "$expected_product_commit" '
    .tagName == $tag
    and .isDraft == false
    and .isPrerelease == true
    and .targetCommitish == $commit
    and ([.assets[].name] | sort) == [
      "kit-agent-guard-0.1.0-preview.3-darwin-arm64.hkit",
      "registry-entry.json",
      "release.json",
      "sbom.spdx.json"
    ]
  ' "$verify_dir/release-view.json"
  gh release download "$product_tag" --repo itharbors/harbors --dir "$verify_dir/assets"
  jq -e --arg commit "$expected_product_commit" '
    .version == "0.1.0-preview.3"
    and .channel == "preview"
    and .source.commit == $commit
    and .source.workflow == "itharbors/harbors/.github/workflows/publish-kit.yml@refs/tags/kit/agent-guard/v0.1.0-preview.3"
    and .source.signerWorkflow == "itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v3"
  ' "$verify_dir/assets/release.json"
  artifact="$verify_dir/assets/kit-agent-guard-0.1.0-preview.3-darwin-arm64.hkit"
  test "$(shasum -a 256 "$artifact" | cut -d' ' -f1)" = "$(jq -r '.assets[0].sha256' "$verify_dir/assets/release.json")"
  gh attestation verify "$artifact" \
    --repo itharbors/harbors \
    --signer-workflow .github/workflows/publish-kit-reusable.yml
  gh attestation verify "$verify_dir/assets/release.json" \
    --repo itharbors/harbors \
    --signer-workflow .github/workflows/publish-kit-reusable.yml
  ```

  Expected: jq、digest 和两个 attestation verification 都 exit 0；远端产品 Tag 再次解析为原 Commit。

- [ ] **Step 5: 核验 Registry 并在 Electron 中完成安装验收**

  轮询公开 Registry，直到 Agent Guard Preview 指向恢复版本：

  ```bash
  for attempt in {1..30}; do
    if curl --fail --silent --show-error \
      https://itharbors.github.io/harbors/index.v1.json \
      -o "$verify_dir/index.v1.json" \
      && jq -e '
        .kits[]
        | select(.id == "@itharbors/kit-agent-guard")
        | .channels.preview.version == "0.1.0-preview.3"
      ' "$verify_dir/index.v1.json" >/dev/null; then
      break
    fi
    if [[ "$attempt" -eq 30 ]]; then exit 1; fi
    sleep 10
  done
  ```

  然后通过本地 Electron Kit Manager 安装或更新 Agent Guard Preview 3，打开 Agent Guard，确认版本为 `0.1.0-preview.3`，且在 Electron 继承非英文 locale 时运行中的 Codex endpoint 数量大于 0。该步骤使用 `computer-use:computer-use` 操作可见 UI；如果现有 Electron 进程已经退出，只启动仓库提供的 Electron dev 命令，不修改用户其他应用状态。

  Expected: Registry、Kit Manager 和 Agent Guard 页面都显示 `0.1.0-preview.3`，Codex endpoint 不再错误显示为 0。
