# Kit 下载移除 GitHub 认证依赖

Task ID: `2026-08-07-offline-kit-attestation`
Type: `bug`

## 背景与问题

Kit Manager 在解析公开 Release 时调用 GitHub Artifact Attestations REST API 发现 Sigstore bundle。共享匿名额度耗尽后，公开插件安装也会以 `ATTESTATION_RATE_LIMITED` 失败；终端用户不应为了下载或更新公开 Kit 而登录 GitHub。

## 目标

Kit Manager 安装和更新不读取 GitHub Token、不调用 GitHub Attestations API。Registry Pages 为可安装制品发布按 SHA-256 寻址的 bundle，客户端从 Registry 获取后继续执行完整的本地来源证明校验。

## 范围

调整 Registry 聚合器、Kit Manager 的证明获取路径、证明校验器、发布工作流合同、相关测试与 Kit 制品文档。现有不可变 Release 通过重新聚合 Registry 获得 bundle，无需重发。

## 非目标

不弱化来源证明、publisher policy、digest、revocation 或 Release identity 校验；不改变 `.hkit` 格式和 Release manifest schema；不为私有 Registry 增加认证协议。

## 验收标准

无 GitHub Token 时可以从 Registry bundle 路径完成证明校验；客户端安装请求不访问 Attestations API 且不发送 `Authorization`；缺失、超限、篡改或 claims 不匹配的 bundle 均 fail closed；Registry aggregate 同时输出索引与选中制品的 bundle；全量检查通过。

## 约束

bundle URL 只能由已验证的 Registry URL 与 SHA-256 推导，不能接受 Renderer 或 Release 提供的任意 URL。Registry 发布阶段仍可使用仓库级 GitHub Actions Token 获取并验证证明，但凭据不得进入客户端。

## 需求变更

实施中未发生产品需求变更。全量验证发现两个既有 Agent Guard 测试仍断言旧版本 `0.1.0-preview.6`，实际正式清单已是 `preview.7`；仅同步测试基线并独立提交，不修改产品行为。
