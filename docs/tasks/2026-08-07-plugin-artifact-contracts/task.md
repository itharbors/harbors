# 插件制品架构收敛

Task ID: `2026-08-07-plugin-artifact-contracts`
Type: `refactor`

## 背景与问题

Harbors 的 Framework Plugin、内置 Kit 与市场 Kit 分别演进出相近但不一致的打包路径：Plugin manifest 在构建、桌面 staging 和运行时被重复解析；Release 模型允许多资产而发布链路只接受单资产；`native-code` 可错误声明为 portable target；Electron 最终包没有证明 runtime 文件闭包；SBOM 和运行时诊断也缺少足够的版本与制品身份。

同时，Kit permissions 在界面上容易被理解为宿主强制隔离，但当前实际语义是安装风险声明，只有少数 owner-bound capability 由宿主强制授权。

## 目标

- 建立唯一、严格、版本化的 Plugin manifest parser，供 build、pack、desktop staging 与 runtime 共用。
- 支持同一 Kit 版本发布多个 target artifact，并逐资产验证摘要与 attestation。
- 禁止原生 Kit 使用 portable target，并在 payload 扫描阶段识别 `.node` 原生模块。
- 为 staged desktop runtime 生成文件 inventory，并在 electron-builder 后验证最终 runtime 闭包。
- 生成包含版本、许可证、PURL、依赖关系和文件归属的 SPDX SBOM。
- 在 runtime/catalog/diagnostics 中携带 Kit、Plugin 与 artifact 身份。
- 明确 permissions 的风险声明语义，并让发布 smoke 真实加载默认 Kit。

## 范围

- `kit-core`、`kit-cli`、Server、Desktop build/package 与 Kit 发布/Registry 链路。
- App 与 Kit 发布 workflow 的制品验证和真实 Session smoke。
- Kit Manager 风险声明文案及对应正式文档。
- 与已合入 Scheduler `0.1.0-preview.2` 权限契约的组合验证。

## 非目标

- 不在本任务中实现第三方 Session Plugin 的 OS sandbox。
- 不改变现有 `.hkit` 归档格式或 Release schema 主版本。
- 不发布、不合并任何 Kit 或 App Release。
- 不修改独立发布 Kit 的产品代码。

## 验收标准

- 四条 Plugin manifest 消费路径使用同一 parser，并对相同输入得到相同结果或错误。
- 多 target Release 可发布、聚合、验证并选择唯一兼容资产；重复 target、权限漂移或资产集合不一致被拒绝。
- `native-code` 缺少具体 platform、arch 或 Node ABI 时在构建前失败；发现 `.node` 而未声明权限时失败。
- 最终 `.app/Contents/Resources/runtime` 与 staging inventory 逐文件一致，缺失、额外、摘要漂移或符号链接均失败。
- 发布 smoke 创建默认 Kit Session，并验证 bootstrap 返回 Kit 名称与非空 panels。
- SPDX 能定位生产组件的 name、version、license、PURL、依赖边与 payload 文件。
- Plugin runtime 投影包含插件版本和可用的 Kit/artifact 来源身份。
- 保留 #62 的离线 attestation bundle 缓存与 #63 的本机 Web 安全打开能力。
- 聚焦测试、完整 `npm run check` 与静态检查通过。

## 约束

- 保持旧单资产 Release 与缺省 Plugin schemaVersion 的兼容读取。
- 最终包校验必须 fail closed，不能静默忽略额外或被修改的 runtime 文件。
- permissions 不得被描述成尚不存在的安全边界。
- 旧实现分支只作参考，所有代码从最新 `origin/main` 人工重放与融合。

## 需求变更

- 原始请求是从架构师角度审查当前插件打包流程与架构；用户随后要求解决发现的问题并通过测试。
- Scheduler 的 `native-code + any/any` 已按独立 Kit 工作流修复并通过 PR #67 合入，本 Task 不再携带跨分支兼容例外。
