# Kit Marketplace Phase 4：GitHub 发布与 Registry 聚合实施计划

> 本计划在 Phase 1–3 已完成的 `.hkit`、Registry 客户端、来源证明和桌面 Kit Manager 之上，补齐 GitHub 侧的自动发布面。实现遵循测试驱动，每个任务形成独立可审查提交。

**目标：** Kit 产品分支通过薄 caller 自动发布 Preview，通过 `kit/<name>/v<semver>` Tag 发布 Stable；所有 `.hkit` 都获得 GitHub Artifact Attestation，并把经过 schema 与远程 Release 校验的索引部署到 GitHub Pages。

**架构：** 产品分支只保留 `.github/workflows/publish-kit.yml` caller，固定调用主仓库中版本化的 reusable workflow。reusable workflow 使用仓库内纯 Node helper 生成不可变 Release 元数据和 Registry channel entry，调用 `actions/attest@v4`，再发布 GitHub Release。Registry 使用独立 `kit-registry` 分支保存逐 channel entry；Preview 串行直推，Stable 创建以 `kit-registry` 为 base 的审核 PR。Registry 分支上的 Pages workflow 调用同一聚合器，严格校验所有 entry、Release manifest 和权限投影后生成 `index.v1.json`。

---

## Task 1：发布元数据生成器

**文件：**

- 新建 `scripts/lib/kit-publish/metadata.mjs`
- 新建 `scripts/lib/kit-publish/metadata.test.mjs`
- 新建 `scripts/kit-publish.mjs`
- 修改 `package.json`

**行为：**

1. 从已打包 `.hkit` 的真实 manifest、SHA-256 和字节数生成 canonical `release.json`。
2. 只接受规范的 GitHub repository、40 位 commit、caller workflow ref、channel 与对应 Tag。
3. 生成可提交到 Registry 分支的 channel entry，包含展示元数据、不可变 Release URL 和 permissions。
4. 拒绝 Stable prerelease、Preview 非 prerelease、Tag/Kit 名不匹配、输出覆盖和任意 URL 注入。
5. CLI 输出稳定的 `KEY=value`，供 GitHub Actions 写入 `$GITHUB_OUTPUT`。

## Task 2：Registry 聚合器

**文件：**

- 新建 `scripts/lib/kit-publish/registry.mjs`
- 新建 `scripts/lib/kit-publish/registry.test.mjs`
- 新建 `registry/revocations.json`
- 修改 `scripts/kit-publish.mjs`

**行为：**

1. 从 `entries/<encoded-id>/<stable|preview>.json` 聚合唯一 Kit/channel。
2. 强制同一 Kit 的 label、publisher、summary 一致，并通过 `parseKitRegistryIndex` 做最终 schema 校验。
3. 远程验证每个不可变 `release.json`：身份、channel、version 和权限投影必须一致；Release URL 必须属于声明的 GitHub repository/tag。
4. `generatedAt` 由 workflow 显式传入，排序和 JSON 编码确定性一致。
5. revocation 走同一 schema 校验，重复或不存在的摘要不会静默进入索引。

## Task 3：Preview/Stable reusable workflow 与产品 caller 模板

**文件：**

- 新建 `.github/workflows/publish-kit-reusable.yml`
- 新建 `.github/kit-templates/publish-kit.yml`
- 新建 `.github/kit-templates/registry-pages.yml`
- 新建 `scripts/lib/kit-publish/workflows.test.mjs`

**行为：**

1. caller 只响应自身 `kit/<name>` push 和 `kit/<name>/v*` Tag，并固定调用 `kit-publish-v1`。
2. reusable workflow 使用最小权限，执行锁定安装、测试、构建、validate、pack、inspect 和离线复验。
3. 为 `.hkit` 与 `release.json` 使用 `actions/attest@v4`；Stable 使用受保护 `kit-stable` environment。
4. Preview 创建 prerelease 并更新 Registry preview entry；Stable 不覆盖 Release，而是创建 Registry 审核 PR。
5. action 版本固定到当前官方大版本，第三方命令只处理脚本生成的安全值。

## Task 4：Registry Pages 验证、文档与阶段验收

**文件：**

- 修改 `docs/guides/kit-artifacts.md`
- 修改 `docs/architecture/kit-and-session-model.md`
- 修改 `readme.md`
- 修改 `scripts/lib/kit-docs.test.mjs`
- 修改 `package.json`

**行为：**

1. Pages workflow 在 PR 中只做聚合与远程校验，在 `kit-registry` push 中上传并部署 Pages artifact。
2. 文档明确仓库设置前置条件：Pages 来源 GitHub Actions、`kit-stable` environment、PR 审批与允许 Actions 创建 PR。
3. 静态 workflow 测试验证触发器、权限、固定 reusable ref、attestation、不可覆盖 Stable 和 Registry PR base。
4. 运行发布 helper 测试、全仓 `npm run check`、`npm audit --omit=dev` 和 `git diff --check`。

完成 Phase 4 后继续实现 `kit-workflow` Skill 和 Kit 产品分支迁移；此阶段不宣称整个 Marketplace 目标完成。
