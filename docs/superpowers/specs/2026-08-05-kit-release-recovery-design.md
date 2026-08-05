# Kit 不可变发布恢复设计

## 背景

Agent Guard `kit/agent-guard/v0.1.0-preview.3` 已由合并自动发布流程创建并精确指向
`ecbe04824e4ca10d2f695bcb12663caed8a91e32`，但 `Publish Kit` 在准备发布四件套时失败。失败的
`kit-publish-v2` 可复用工作流对已经通过隔离 `kit:check` 的 Kit 再次执行源码目录打包；自包含 Kit 的插件
`dist` 只存在于隔离检查目录，因此目录打包找不到插件入口。Tag 保留、Release 不存在，Registry 也没有该版本。

仓库 `main` 上的可复用工作流已经改为直接消费 `kit:check` 产出的 `.hkit`，但普通发布入口仍固定调用不可变的
`kit-publish-v2` Tag。重跑失败任务不会获得这项修复；删除或移动产品 Tag 则违反不可变发布规则。

## 目标

- 保留现有 Agent Guard Preview 3 Tag 和目标 Commit，补齐不可变 Preview Release、attestation 与 Registry。
- 发布一个新的不可变签名器 `kit-publish-v3`，让正常自动发布与缺失 Release 恢复使用同一条制品链路。
- 允许从 `main` 对“Tag 已存在、Release 不存在”的精确 Kit Tag 发起受控恢复。
- 保持旧版 `kit-publish-v1`、`kit-publish-v2` Release 的验证兼容性。

## 非目标

- 不删除、移动、覆盖或重建任何已有 Kit Tag。
- 不覆盖已有 GitHub Release 或上传替换资产。
- 不自动恢复历史上的其他失败 Kit；本次上线后只实际恢复 Agent Guard Preview 3。
- 不改变 Kit 内容、版本、渠道、Stable Environment 审批或 Registry 数据模型。

## 方案选择

采用通用的 `kit-publish-v3` 发布契约，而不是复制一套 Agent Guard 专用工作流。一次性工作流会复制身份校验、
attestation、Release 与 Registry 逻辑，容易与正常发布漂移；改发 Preview 4 虽然简单，却会留下不可解释的孤立
Preview 3 Tag，并且不能修复后续 Kit 的相同失败。

## 发布入口

`.github/workflows/publish-kit.yml` 保留 Tag push 与自动编排使用的 Tag-ref dispatch，同时允许人工恢复从
`main` dispatch。两种 dispatch 都必须提供完整 `kit/<slug>/v<version>` Tag 和唯一 `request-id`。

入口先解析一个权威发布引用：

- Tag push 使用 `github.ref_name`；
- workflow dispatch 使用 `release-tag`；
- 自动路径在对应 Tag ref 上运行；
- 恢复路径只允许在 `refs/heads/main` 上运行。

入口检出权威 Tag，而不是调用者分支，并要求 Tag 解析后的 Commit 是 `origin/main` 的祖先。恢复路径额外查询
GitHub Releases API：只有精确 Release 返回 404 才继续；Release 已存在或 API 返回其他错误都失败关闭。
正常自动路径仍由现有自动编排器在调度前完成幂等检查。

## `kit-publish-v3` 契约

`.github/workflows/publish-kit-reusable.yml` 新增必填 `workflow_call` 输入 `release-tag`。所有 job 都以
`refs/tags/<release-tag>` 为唯一源码，context job 输出解析后的 `release-commit`，后续元数据不得使用恢复调用者的
`GITHUB_SHA`。入口和可复用工作流共同构造三个不可混用的值：

- `release-ref`：`refs/tags/<release-tag>`，用于 checkout 和 `release.json.source.ref`；
- `release-commit`：该 Tag 实际解析出的 Commit，用于构建、祖先校验和 `release.json.source.commit`；
- `source-workflow`：`itharbors/harbors/.github/workflows/publish-kit.yml@<release-ref>`，表示产品发布契约，不能取恢复
  调用的 `GITHUB_WORKFLOW_REF`。

产品构建与发布控制面必须分离。prepare job 只在产品 Tag 检出目录中、使用 Kit 选择的 runner 执行一次目标
`kit:check`，解析并上传恰好一个 `.hkit`；它不得执行产品 Tag 中的 `kit-publish.mjs`。独立 package job 只检出
`kit-publish-v3`，下载已检查的 `.hkit`，再用 v3 的 `kit-publish.mjs prepare --kit-artifact` 生成发布四件套：

context job 同样用 v3 的严格 loader 和 v3 自带的当前 Registry policy 校验产品 Tag 快照。旧产品 Tag 中的历史
policy 只描述当时已存在的 signer，不能用来判断新的恢复发布器是否受信；Kit 描述、版本、lockfile 与构建内容仍
全部从产品 Tag 读取。

1. 经过检查的 `.hkit` 原始字节；
2. `release.json`；
3. `registry-entry.json`；
4. `sbom.spdx.json`。

prepared artifact 的摘要必须与 `kit:check` artifact 完全相同。package job 还从已经校验的 `release.json` 生成
SLSA v1 predicate，其中产品 workflow、Tag ref 与 Commit 均来自产品 Tag，而 builder 固定为不可变 v3 signer。
Preview 与 Stable job 保持非覆盖语义，先拒绝已有 Release，再通过 `actions/attest@v4` 的 custom predicate 模式为
`.hkit` 和 `release.json` 签名，最后一次性创建 Release。不能使用 action 的默认自动 provenance：main recovery 的
OIDC 运行上下文是 `refs/heads/main`，会与产品 Tag 来源冲突。Registry 只在恰好一个渠道发布 job 成功后刷新。

`publish-kit.yml` 固定调用 `publish-kit-reusable.yml@kit-publish-v3` 并传入权威 Tag。合并修复 PR 后，在同一经过
评审的 merge Commit 创建不可变基础设施 Tag `kit-publish-v3`；不移动 `kit-publish-v1` 或 `kit-publish-v2`。

## 信任与兼容

新生成的 `release.json.source.signerWorkflow` 固定为
`itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v3`。Registry 信任列表新增 v3，
同时保留 v1 和 v2，因此旧 Release 继续通过验证。Release source 的 workflow 字段仍记录产品 Tag 上的
`publish-kit.yml` 规范身份，commit 字段记录产品 Tag 解析出的 Commit。custom SLSA predicate 重复绑定这两个产品
来源字段；Sigstore 证书身份和 predicate 的 builder 则绑定不可变 `kit-publish-v3`。因此恢复调用者的 main ref/Commit
既不会冒充产品来源，也不会削弱实际签名器校验。

任何下列情况都必须在创建 attestation 或 Release 前终止：Tag 语法错误、Tag 不存在、Tag 与 Kit 版本不一致、
Tag Commit 不属于 `main`、Kit 未列入 Registry policy、渠道与 SemVer 不一致、检查制品数量不为一、制品身份或摘要
漂移、Release 已存在。

## 恢复 Agent Guard Preview 3

发布器修复合入并创建 `kit-publish-v3` 后，从 `main` dispatch `publish-kit.yml`，输入：

- `release-tag=kit/agent-guard/v0.1.0-preview.3`；
- 唯一且可追踪的 `request-id`。

工作流必须检出已有 Tag 的 `ecbe04824e4ca10d2f695bcb12663caed8a91e32`，重新执行目标 Kit 检查，并创建
Preview Release。完成后核验 Tag 未变化、Release 为 prerelease、四个资产齐全、`.hkit` digest 与工作流输出一致、
attestation 可验证、Registry 最新 Preview 指向 `0.1.0-preview.3`，再通过桌面 Kit Manager 安装并确认 Agent Guard
能够识别非英文 locale 下的 Codex 进程。

## 测试

- 工作流契约测试先失败，证明普通发布固定到 v3、调用时传入精确 Tag、恢复只允许 main、产品构建 checkout 使用
  产品 Tag、发布控制面 checkout 使用 `kit-publish-v3`、元数据使用 Tag Commit、Release 存在时拒绝以及发布链路
  消费 `--kit-artifact`。
- provenance 测试证明默认 main-dispatch provenance 会被 Registry 拒绝，而 v3 生成并签名的 custom predicate 精确
  绑定产品 Tag ref/Commit；历史发布脚本不得参与 v3 打包。
- Registry 单元测试先失败，证明 v3 signer 尚未受信；实现后同时验证 v1、v2、v3，拒绝 `main` 等可变 ref。
- CLI 与发布元数据测试同步 signer 常量，继续验证四件套、摘要、Tag、版本和渠道不匹配时失败关闭。
- 运行 `npm run test:kit-publish`、`npm run test:kit-release-intent` 和工作流相关预检；PR CI 必须全部通过。
- 线上恢复只执行一次；失败后保留 Tag 和任何已生成证明，仍不删除或覆盖 Release。

## 运维边界

正常 Kit 发布仍以“PR 合并即授权”为准。人工恢复只修补缺失 Release，不提供版本回退、Tag 修订、资产替换或
Release 重建能力。恢复入口和正常入口共享同一个 v3 publisher，以保证后续安全修复不会形成两套发布实现。
