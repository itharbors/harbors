# Kit 不可变发布恢复设计

## 背景

Agent Guard `kit/agent-guard/v0.1.0-preview.3` 已精确指向
`ecbe04824e4ca10d2f695bcb12663caed8a91e32`，但最初的 v2 发布器重新打包源码，遗漏只存在于
`kit:check` 输出中的插件构建产物，因此没有创建 Release。

v3 将构建与发布控制面分开并直接消费经过检查的 `.hkit`，但恢复运行在 `refs/heads/main`。v3 试图向
`actions/attest@v4` 提交声明产品 Tag 来源的自定义 SLSA predicate，GitHub attestation API 拒绝持久化：predicate
中的 workflow ref 是产品 Tag，而 OIDC 执行 ref 是 `refs/heads/main`。因此 v3 Tag 保持不变，产品 Release 仍不存在。

## 目标与边界

- 不删除、移动或重建产品 Tag；它必须继续指向原 Commit。
- 建立不可变 `kit-publish-v4`，同时支持正常 Tag 发布和受限的 main 恢复。
- 创建不可覆盖的 Preview Release、GitHub attestation，并刷新 Registry。
- 继续验证 v1、v2、v3 历史 Release。
- 不改变 Agent Guard 的内容、版本或渠道，也不覆盖任何已有 Release。

## v4 双来源证明

产品来源与执行来源是两个不同事实，分别验证：

1. `release.json` 记录产品 workflow、完整 Tag ref、Tag 解析 Commit 和 v4 signer。Registry 扫描器通过 GitHub Git
   refs API 独立解析该 Tag，要求它精确指向 `release.json.source.commit`。
2. `actions/attest@v4` 使用默认 SLSA provenance，忠实记录实际执行上下文。正常发布记录产品 Tag；恢复发布记录
   `refs/heads/main`。Sigstore 证书身份始终必须绑定不可变
   `publish-kit-reusable.yml@refs/tags/kit-publish-v4`。

v4 不再生成或上传 custom predicate。Registry verifier 保留历史规则：v1–v3 以及普通 v4 发布都要求 attestation
中的 workflow ref/Commit 精确等于产品 Tag/Commit。只有 signer 精确为 v4 时，额外接受以下恢复执行证明：

- repository 是 `itharbors/harbors` 中 Release 声明的同一仓库；
- workflow path 精确为 `.github/workflows/publish-kit.yml`；
- ref 精确为 `refs/heads/main`；
- resolved dependency 精确为同仓库的 `refs/heads/main`，且 commit 是规范的 40 位小写 SHA。

其他 branch、workflow、repository、dependency ref、可变 signer 或畸形 Commit 全部失败关闭。产品 Tag 身份不从
attestation 的 main Commit 推断，而由第一条独立证据确定。

## 发布链路

`publish-kit.yml` 将 Tag push、Tag-ref dispatch 和仅限 main 的 recovery dispatch 归一化为一个完整产品 Tag。
入口检出产品 Tag，要求它是 lightweight Commit Tag、Commit 属于 main，且恢复时精确 Release 返回 404。

v4 reusable workflow 的 context job 分别检出不可变 v4 发布器与产品 Tag，并用 v4 policy 校验历史产品快照。
prepare job 只在产品 Tag 上运行目标 `kit:check` 并上传恰好一个 `.hkit`；package job 只运行 v4 发布器，按原字节
生成 `.hkit`、`release.json`、`registry-entry.json`、`sbom.spdx.json` 四件套。Preview/Stable job 先拒绝已有
Release，再生成默认 attestation，最后一次性 `gh release create --verify-tag`。Registry 仅在恰好一个渠道 job 成功后刷新。

新生成元数据固定声明 v4 signer。仓库 policy、发布扫描器和桌面 Kit Manager 同时信任不可变 v1–v4 signer，拒绝
`refs/heads/main` 等可变 signer 身份。

## 恢复与验收

修复合并后，在该 merge Commit 创建一次性 lightweight Tag `kit-publish-v4`；已有 v1–v3 Tag 都不移动。随后从
main dispatch `publish-kit.yml`，输入产品 Tag 和唯一 request id。

验收要求：工作流成功；产品 Tag SHA 未变；Release 是 prerelease 且只有四个预期资产；`release.json` 的产品
Commit、workflow 和 v4 signer 正确；`.hkit` digest 匹配；GitHub attestation 与 Registry verifier 均通过；公开
Registry 的 Agent Guard Preview 指向 `0.1.0-preview.3`；Electron Kit Manager 能安装并显示正确 Agent 信息。

## 测试

- TDD 覆盖 v4 main provenance 仅由精确 v4 signer 接受，v3 拒绝相同证明。
- 覆盖 v4 普通 Tag provenance，并拒绝错误 branch、workflow、repository、dependency 和 Commit。
- 静态工作流测试要求 v4 pin、默认 attestation、无 custom predicate 中间产物、发布四件套不变。
- 元数据、Registry、policy 与桌面默认 publisher policy 覆盖 v1–v4 精确 allowlist。
- 合并前运行定向测试和完整 `npm run check`；线上恢复失败时不删除 Tag、Release 或 attestation。
