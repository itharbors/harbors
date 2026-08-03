# Kit 合并自动发布设计

## 目标

Kit 开发 PR 必须携带对应版本升级。PR 合并到 `main` 即表示发布授权：仓库自动为每个升级的市场 Kit 创建
`kit/<slug>/v<version>` Tag，随后显式启动现有不可变 GitHub Release 与 Registry 发布链路。

## 发布契约

- 只要 `kits/<slug>/` 内的市场 Kit 产品内容发生变化，该 Kit 的 `kit.json`、`package.json` 和
  `package-lock.json` 根包版本就必须同步升级。
- 版本必须是无 build metadata 的规范 SemVer，并且严格高于合并基线中的版本。
- 普通 SemVer 对应 `stable`，带 prerelease 段的 SemVer 对应 `preview`；`kit.json.channel` 必须一致。
- 一个 PR 可以升级多个市场 Kit；所有候选必须先全部验证通过，才允许创建任何 Tag。
- 内置 Default Kit 随主程序发布，不进入独立 Kit Tag 流程。
- PR 合并本身就是发布授权，不再要求自动路径额外取得 `Tag@Commit` 人工确认。
- Stable Release 继续受 `kit-stable` GitHub Environment 审批保护；Preview Release 自动执行。

## 组件与数据流

### 发布意图规划器

新增一个无网络副作用的 Node.js 模块与 CLI。CLI 接收 `base SHA` 和 `head SHA`，读取 NUL 分隔的 Git diff，
只选择直接修改的 `kits/<slug>/` 目录。对每个市场 Kit，它从两个 Git revision 读取版本快照，校验清单、包、
lockfile、频道和 SemVer 递增关系，最后按 slug 排序输出单行 JSON 发布计划。

规划器同时服务三个入口：

1. Kit CI 在 PR、merge queue 和 `main` push 上验证发布意图；
2. `finish-kit-change.sh` 在 push 和创建 PR 前执行相同门禁；
3. 自动发布工作流在创建 Tag 前重新计算完全相同的计划。

这样本地、PR 和合并后的判断不会形成三套实现。

### PR 与 merge queue 门禁

现有 `Kit CI` 的 `select` job 已经解析不同事件的精确 base/head。它在同一个既有 job 中调用发布意图规划器，
把计划写入 Step Summary。校验失败会使已有 CI job 失败，不依赖额外的仓库 branch-protection 配置。

如果两个并行 PR 为同一 Kit 选择相同版本，要求 status check 使用最新 `main`；后合并的 PR 在更新基线后会因版本
不再严格递增而失败，必须选择新版本。

### 合并后 Tag 编排

新增只监听 `main` push 的工作流。它以事件的 `before` 和当前 SHA 计算计划，并在任何写操作前完整验证所有候选。
随后通过 GitHub Git refs API 创建轻量 Tag，Tag 必须精确指向本次 `main` Commit。

自动编排使用仓库内置 `GITHUB_TOKEN`，权限最小化为 `contents: write` 和 `actions: write`，不引入 PAT 或长期
Secret。由于 `GITHUB_TOKEN` 创建的 Tag 不会再次触发普通 `push` 工作流，编排器会对每个 Tag 显式调用
`publish-kit.yml` 的 `workflow_dispatch` 入口。

### 发布工作流兼容

`publish-kit.yml` 保留原有 `push: tags: kit/*/v*` 入口，继续支持受控手动恢复；同时新增
`workflow_dispatch`，要求 `release-tag` 和唯一 `request-id`。dispatch 必须运行在同一个 Tag ref 上，并验证输入 Tag
与 `GITHUB_REF` 完全一致，然后继续调用受保护的 `kit-publish-v2` 可复用工作流。现有签名、attestation、不可变
Release、Stable Environment 和 Registry 刷新逻辑不变。

## 幂等、冲突与恢复

- Tag 不存在：创建指向合并 Commit 的轻量 Tag，然后调度发布。
- Tag 已存在且指向同一 Commit：视为已完成 Tag 阶段，不修改 Tag；若 Release 不存在则再次调度发布。
- Tag 已存在但指向其他 Commit，或不是直接指向 Commit 的轻量 Tag：失败关闭，绝不删除、移动或覆盖 Tag。
- Release 已存在：视为该 Tag 已发布，不重复调度，避免不可变 Release 冲突。
- 工作流在部分 Tag 创建后失败：重新运行同一 `main` workflow，已创建且身份一致的 Tag 会安全通过，剩余 Tag 继续创建。
- 发布失败：Tag 保留。修复可重跑对应合并工作流或使用保留的手动发布入口；已发布资产永不覆盖。
- 自动发布工作流使用单一并发组且不取消运行，避免多个 `main` 合并交错创建与调度 Tag。

## 测试与文档

- 纯单元测试覆盖无关变更、单 Kit、多 Kit、新 Kit、版本未升级、版本倒退、清单/lockfile/频道不一致和确定性输出。
- CLI 集成测试使用临时 Git 仓库验证真实 revision 与 NUL 分隔路径处理。
- 工作流契约测试验证权限、触发器、Tag 身份校验、显式 dispatch、幂等检查和既有发布门禁未被削弱。
- Kit workflow shell 测试验证 finish 在发布意图无效时先于 push 失败。
- 更新 Kit Skill 与开发指南：正常路径改为“开发 PR 携带版本，合并自动发布”，手动 `release-kit.sh` 仅用于恢复。
