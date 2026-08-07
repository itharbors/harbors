# 插件制品架构收敛总结

## 最终结论

Harbors 的插件与 Kit 制品现在由共享严格 schema、明确的原生目标、多资产发布验证、可核验的桌面 runtime inventory 和更完整的 SPDX SBOM 共同约束；真实打包应用可以仅通过 loopback 启动 Framework，并加载默认 Kit 完成 Session bootstrap。

## 需求完成情况

- Plugin manifest 的构建、打包、桌面 staging 与运行时消费统一使用 `kit-core` parser，并兼容缺省 `schemaVersion` 的旧制品。
- 同一 Kit 版本可携带多个 target artifact；发布、Registry 聚合和客户端解析逐资产核对摘要、attestation 与目标唯一性。
- `native-code` 必须声明具体 platform、arch 和 Node ABI；payload 出现 `.node` 而未声明原生权限时直接失败。
- 桌面 staging 生成逐文件 runtime inventory，最终 `.app` 对缺失、额外、摘要漂移和符号链接均 fail closed。
- SPDX SBOM 包含组件版本、许可证、PURL、依赖关系、payload 文件及其归属。
- runtime 投影携带 Kit、Plugin、artifact 的版本与摘要来源；Kit Manager 和文档明确 permissions 是安装风险声明。

## 主要改动

- 新增共享 Plugin schema 模块，并接入 Kit CLI、Server 与 Desktop 构建链路。
- 扩展 Kit release schema、发布 CLI、GitHub workflows、Registry 聚合和 resolver 的多 target 契约。
- 强化 native target、权限一致性、归档 payload 与 SBOM 校验。
- 新增桌面 runtime manifest，electron-builder 完成后对最终资源目录做闭包验证。
- 将 App 发布 smoke 提升为真实 Session/default Kit/plugin bootstrap 验证。
- 在打包实测中修正 runtime inventory 生成时机、Framework bundle 凭据扫描边界及桌面 API 的 loopback-only 监听。

## 关键决定

- 共享 parser 是 Plugin manifest 语义的唯一来源，消费者只负责各阶段自己的投影和错误上下文。
- Release 仍保持现有 schema 主版本和单资产兼容读取，多资产通过逐 target 唯一性与完整 asset set 实现。
- `native-code` 只表达 ABI 相关原生载荷；Node.js 子进程风险由 `process-control` 表达。
- runtime inventory 在全部 Framework 与内置 Kit 完成 staging 后生成，避免清单证明中间态。
- Framework bundle 只允许已隔离的 application plugin process 源段使用 `child_process`，credential 源段继续严格拒绝。
- 桌面 Framework 固定绑定 `127.0.0.1`，不向局域网接口暴露本地 API。

## 验证结果

- Plugin/Kit parser、native target、SBOM、多资产发布、Registry、resolver、桌面 runtime 与凭据边界聚焦测试：通过。
- `npm run desktop:dir`：通过，生成 `mac-arm64/ITHARBORS.app` 并完成最终 runtime 闭包校验。
- 真实打包产物冒烟：创建 `packaged-default-kit-smoke` Session，加载 `@itharbors/kit-default`，bootstrap 返回 6 个 panels，Framework 仅监听 `127.0.0.1`。
- `npm run check`：通过；Server 60 files/702 tests、Client 33 files/263 tests、kit-core 85 tests、kit-cli 59 tests、发布与工作流测试、9 个 Kit matrix 及 Framework Plugin 检查全部通过。
- `git diff --check`：通过。

## 影响与风险

- 原生或多 target Kit 的错误声明会比过去更早被拒绝，这是预期的 fail-closed 行为。
- 发布 workflow 会为每个 `.hkit` 资产分别生成和校验 provenance，发布耗时与资产数线性增加。
- runtime inventory 对 electron-builder 注入 runtime 的任何新文件都会失败；新增合法运行时文件时必须由 staging 明确纳入清单。
- permissions 仍不是通用 OS sandbox；只有现有 owner-bound capability 由宿主执行授权，界面不再把风险声明误述为强隔离。

## 偏差与遗留

- 未改变 `.hkit` 归档格式或 Release schema 主版本，也未实现第三方 Session Plugin 的 OS sandbox，符合非目标。
- macOS 本地产物未使用 Developer ID 签名；目录包验证和真实运行通过，正式签名仍由发布环境负责。
- 本地安全策略阻止测试命令自动删除临时冒烟目录，保留了隔离的 `/private/tmp/harbors-packaged-smoke.*` 诊断目录，不影响仓库或应用状态。

## 后续关注

- 合并后观察首次 App 与多 target Kit 发布，确认每个 asset 的 GitHub attestation、Registry bundle 和客户端选择保持一一对应。
- 后续若引入第三方 Session Plugin 强隔离，应独立设计 OS sandbox、资源限额和 capability enforcement，不能复用风险声明文案替代安全边界。

## 相关正式文档

- [Kit 制品与发布](../../guides/kit-artifacts.md)
- [Task 需求快照](./task.md)
