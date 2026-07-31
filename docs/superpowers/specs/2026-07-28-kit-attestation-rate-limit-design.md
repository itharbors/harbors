# Kit 证明接口限流处理设计

## 背景

Kit Manager 安装官方 Kit 时，会通过 GitHub Artifact Attestations API 获取证明 bundle，再在本地完成 Sigstore 与发布声明校验。未认证请求共享 GitHub 每小时 60 次的 core API 限额；限额耗尽后，当前实现把 HTTP 403 统一转换为 `PROVENANCE_FAILED`，界面只显示 `Artifact attestation verification failed`。这既无法说明重试时间，也会让开发走查误判为 Install 没有执行。

CSV `0.1.0-preview.1` 的发布证明已经用认证请求和 Electron 运行时校验通过，因此本次问题是证明 API 可用性与错误表达问题，不是发布物损坏。

## 范围

本次修复包含：

- 开发或受控环境可通过 `HARBORS_KIT_GITHUB_TOKEN` 为证明 API 提供可选认证。
- GitHub 明确返回限流状态时，保留独立错误码和可信重试时间。
- Resolver 与 Kit Manager 将该限流信息展示给用户，不再降级为普通证明失败。
- 继续保证 token 只发送到由受信仓库和 digest 推导出的 `api.github.com` 证明接口；bundle 下载不得携带 token。

本次不改变 Registry 或 Release schema，不增加证明 bundle 缓存，也不改变证明校验的安全策略。将 bundle 随 Registry 发布、彻底移除安装时的 GitHub API 依赖，作为独立架构工作处理。

## 配置与数据流

`createKitManagerService` 从传入的环境对象读取可选 `HARBORS_KIT_GITHUB_TOKEN`，直接交给 `GitHubArtifactAttestationVerifier`。该值不进入公开的 service config、快照、日志或错误消息。

Verifier 仍只在 GitHub 证明 API 请求中设置 `Authorization: Bearer <token>`。Release manifest、Registry、bundle 与 Kit artifact 请求保持无认证，避免凭据跨主机或跨用途传播。

开发走查可使用已经配置的 GitHub CLI 凭据启动：

```bash
HARBORS_KIT_GITHUB_TOKEN="$(gh auth token)" npm run electron
```

## 限流识别与错误

只有证明 API 响应同时满足以下条件时，才识别为 GitHub 限流：

- HTTP 状态为 403 或 429；
- `x-ratelimit-remaining` 严格等于 `0`；
- `x-ratelimit-reset` 是安全的正整数 Unix 秒时间戳。

Verifier 抛出稳定错误码 `ATTESTATION_RATE_LIMITED`，消息使用 UTC ISO 时间，例如：

`GitHub verification rate limit reached. Retry after 2026-07-28T12:27:57.000Z.`

缺少或非法限流头时继续使用 `ATTESTATION_FETCH_FAILED`，不信任任意远端错误正文。Resolver 只允许 `ATTESTATION_RATE_LIMITED` 穿透；所有证明内容、身份或密码学失败仍统一为 `PROVENANCE_FAILED`，避免暴露内部校验细节。

## 用户反馈

现有 Kit Manager 已在点击后立即显示 `Installing <Kit> <version>…`，并在失败时显示 IPC 返回的公共错误。限流错误穿透后，顶部状态条将直接展示重试时间；按钮恢复可用，用户可在重置后重试。原生代码确认弹窗与安装安全边界保持不变。

## 测试与验收

- Verifier 单测覆盖认证头仅发送到证明 API。
- Verifier 单测覆盖有效 403/429 限流头、非法或缺失限流头。
- Resolver 单测覆盖只穿透 `ATTESTATION_RATE_LIMITED`，其他证明错误仍被统一处理。
- Service 单测覆盖 `HARBORS_KIT_GITHUB_TOKEN` 被传给证明请求且不出现在公开 config。
- 运行相关 Kit Manager、Resolver 与 Attestation 测试。
- 使用 GitHub CLI token 启动 Electron，在线安装 CSV，确认状态变为 Installed 且审计日志记录 `kit.install / success`。
- 最终运行 `npm run check`。
