# Kit 不可变发布恢复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to execute this plan with verification checkpoints.

**Goal:** 发布受信的 `kit-publish-v4`，在不移动 Agent Guard Preview 3 产品 Tag 的前提下补齐 Release、attestation 与 Registry。

**Architecture:** 产品 Tag/Commit 由 `release.json` 与 GitHub Tag 精确解析证明；GitHub 默认 SLSA provenance 证明实际
执行上下文。v4 verifier 仅对精确的不可变 v4 signer 接受受限 main recovery provenance，历史 signer 规则保持不变。

## Constraints

- 产品 Tag 必须继续指向 `ecbe04824e4ca10d2f695bcb12663caed8a91e32`。
- 不删除、移动、force push 或重建任何产品 Tag、基础设施 Tag 或已有 Release。
- 恢复只允许从 main dispatch，且精确 Release 必须不存在。
- 新元数据 signer 固定为 `kit-publish-v4`；读取端保留 v1–v4。
- v4 attestation 使用 action 默认 predicate，不伪装产品 Tag 执行上下文。

## Task 1: 锁定 v3 失败并建立 v4 测试

- [x] 确认 v3 recovery 在 `actions/attest@v4` 持久化阶段因 OIDC ref 与 custom predicate ref 不一致失败。
- [x] 增加 v4 main recovery 接受测试，并证明 v3 拒绝同一 main provenance。
- [x] 增加错误 branch、workflow、repository、dependency ref 与 Commit 的拒绝测试。
- [x] 更新 workflow、metadata、Registry、policy 与桌面默认 policy 的 v4 契约测试。

## Task 2: 实现 v4 双来源证明

- [x] 删除 custom predicate CLI、模块、测试和 workflow artifact 传递。
- [x] 将发布器、Registry reusable、metadata signer 固定到 v4。
- [x] Registry verifier 对 v1–v4 保留产品 Tag provenance；仅精确 v4 signer 接受严格 main execution provenance。
- [x] 仓库 policy、Registry 扫描器与桌面 Kit Manager 信任精确 v1–v4 signer。
- [x] 运行定向测试。
- [x] 运行完整 `npm run check`。
- [x] 完成独立代码审查。

## Task 3: 合并并创建不可变 v4 publisher

- [ ] 使用 `[Bug] 修复 Kit 恢复发布证明` 提交并创建 PR。
- [ ] 等待所有必需 CI 通过并合并，不绕过保护。
- [ ] 核验远端尚无 `refs/tags/kit-publish-v4`。
- [ ] 在 PR merge Commit 创建 lightweight `kit-publish-v4` 并推送一次；失败时不 force。
- [ ] 再次核验 v4 Tag 精确指向 merge Commit，产品 Tag SHA 未变，产品 Release 仍不存在。

## Task 4: 恢复 Agent Guard Preview 3

- [ ] 从 main dispatch `publish-kit.yml`，输入 `kit/agent-guard/v0.1.0-preview.3` 和唯一 request id。
- [ ] 等待 publish 与 Registry refresh 全部成功；失败时保留所有不可变状态并先诊断。
- [ ] 核验 prerelease、四件套、产品 Commit/workflow、v4 signer、artifact digest 和两个 attestation subject。
- [ ] 核验 Registry 最新 Preview 为 `0.1.0-preview.3`，远端产品 Tag 仍指向原 Commit。
- [ ] 在 Electron Kit Manager 中安装/刷新 Agent Guard，确认 Agent 信息和非英文 locale 进程识别正确。
