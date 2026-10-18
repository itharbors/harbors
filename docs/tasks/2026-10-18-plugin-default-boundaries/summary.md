# Plugin 默认边界修复总结

## 最终结论

本 Task 的实现、文档和功能验收已完成，独立代码审查通过。改动保存在独立 `bug/plugin-default-boundaries` 分支，基于本地 main `a5338e5065fae42492c1284539e937ad549f895e`；尚未执行 main 整合、push、PR 或部署。

Framework 通过默认接口绑定可信 User、基础 Session 和 Plugin 身份，使正常使用自动保持数据和资源边界。业务数据模型继续由 Plugin 管理。

## 需求完成情况

1. **路径与身份**：Session Plugin 加载必须提供 Host 注入的身份；data/cache 为 User + Plugin，temp/sessionData 为 User + 基础 Session + Plugin。Application scope 保持应用级。缺身份明确失败。
2. **Config 与 Credentials**：Config 使用当前 User 根下的 SQLite，保留 Kit/Plugin/layer 命名空间；Credentials scope 包含 User/Kit/Plugin。用户目录路径保持真实路径边界，拒绝符号链接逃逸；均无旧共享位置回退。
3. **Owner 写入**：普通 Plugin 的注销、重置和删除仅影响自身 owner，核对实际注册 owner；Host-only 清理不进入普通 facade。内置控制器的窄化委托继续有效。
4. **独立快照**：Plugin、Panel、Menu、Message、Kit 元数据，以及 Config JSON 和每次 lifecycle.attach 交付值均与内部可写状态解耦。注册输入数组和对象同样复制。
5. **调用权限**：保留同步 callPlugin 返回值，固定可信 caller，并复用 manifest server request/callers 声明；未声明方法拒绝。Application 子进程同样检查。Context Store 的 12 个现有方法增加仅允许 Agent 的声明。
6. **验证**：Runtime、受影响 Server、真实 Harness runtime/assembly、HTTP smoke 和 Web 浏览器验收通过。
7. **文档**：架构、开发指南、核心原则和 ADR 0005 已同步，导航、失效源码链接及 Task 双向关联已补齐。
8. **工作区**：原 main 工作区已有 Conversation knowledge-base 和 tool-error-reporting Task 变更保持原位；本轮未修改真实运行数据或凭据。

## 主要改动

- `packages/plugin`：新增可信 Session 身份、User/Session 路径、调用授权检查；普通 facade 显式白名单，避免宿主能力泄漏。
- `packages/server`：从 Session owner 装配身份，绑定用户配置与凭据；保持 Application 调用来源；补齐元数据快照与公开 testing harness。
- `kits/harness`：Context Store 公开声明适配；测试显式使用合成身份；新增双 User、同 User 多 Session 的真实 Kit 组合回归。评测入口要求明确 `--user-id`，不会使用隐含测试身份访问评测配置。
- 正式文档：新增默认正确、共享显式、写 owner、读快照和统一调用权限原则；更新旧 Editor 简化模型与各存储位置说明。

## 关键决定

- Framework 只处理 User、Session、Plugin 及通用能力，Conversation、Project 和业务 schema 留在 Plugin。
- 持久私有数据默认跨同一 User 的 Session 共享，工作台运行状态仍各自独立；不引入跨 Session 实时广播。
- 复用现有路径与 Config/Vault 能力，不新增通用数据库平台；配置的 global 是当前 User 的持久层名称。
- 同步调用保留以避免 Agent 存储接口大规模异步重构，但调用入口不能改变有效授权；通配观察路由和 Panel 路由不授予同步方法访问。
- 新身份范围不猜测旧数据的 User；旧目录、旧配置与凭据条目保持原样，新绑定不回退它们。旧数据迁移工具不在本 Task。

## 验证结果

以下是本 worktree 的实际验证，数量存在交叉，不累计为独立总数：

| 验证 | 结果 |
| --- | --- |
| `pnpm --filter @itharbors/magnet test`、`build` | 最终 typecheck、59 项测试与构建通过；Runtime worker 执行 |
| `pnpm --filter @itharbors/server run build`、`typecheck` | 主 Agent 最终构建与类型检查通过 |
| `pnpm --filter @itharbors/server exec vitest run tests/framework tests/credentials tests/application tests/integration tests/routes tests/config-storage` | 主 Agent 最终复验 45 个文件、659 项通过 |
| Panel/Message/Menu 与 Plugin 局部测试、内置 Message node tests | Runtime worker 的 95 项及 5 项通过，已由主 Agent 的扩展验证和实际 diff 复核 |
| `pnpm --dir kits/harness run build`、`test:assembly` | 构建通过；11 项真实装配测试通过，包含双 User/同 User 双 Session 历史及配置范围 |
| `pnpm --dir kits/harness run test:plugin` | 两个文件、3 项通过，包含真实 Agent → Context Store 和 Model Service 消息链 |
| `pnpm exec tsx --test kits/harness/plugins/agent/tests/prompt-eval.credentials.test.ts` | 3 项 fake Keyring 及清理测试通过；未执行真实模型评测 |
| `node packages/kit-cli/dist/cli.js validate kits/harness`、`pnpm --dir kits/harness run smoke` | descriptor 与真实 Gateway/Server/Client HTTP smoke 通过 |
| 独立 code-review | 首轮发现 layouts getter 被对象展开固定；最小修复并增加先失败后通过的测试，复审通过 |
| 正式文档链接与 `git diff --check` | 链接检查通过；无空白错误 |

首次干净构建缺少 magnet 的 dist，先单独构建 magnet 后 `build:runtime` 成功；没有为此修改构建系统。扩展测试中的旧 fixture 补齐可信身份及真实 builtin kind 后通过，未弱化权限断言。

### Web 浏览器验收

- 唯一 Web Host 使用本 worktree、临时 data root、credentials=off；最终验收地址为 `http://127.0.0.1:58373`，Gateway/Server/Client 为隔离端口。
- 使用 Playwright 的真实浏览器，通过用户选择器创建 Scope A、Scope B，再创建三个不同 Session，均打开真实 Harness。
- Scope A 保存专属指令；Scope B 加载完成后为空并保存另一值；Scope A 的第二 Session 读到 A 值；A 原 Session 刷新后仍保留 A 值。每次等待“设置已加载/已保存”后断言，避免把输入框初始空值当持久结果。
- Plugin 面板显示 14/14 已加载；菜单、对话区域和设置正常渲染。未捕获 JavaScript 错误为 0，正常路径无 console error。
- Chat Panel 通过公开消息 API 请求 Context Store 的受限方法，被可信 caller 校验拒绝；沿既有错误映射返回 500，属于主动拒绝测试的预期响应。首次 bootstrap 的 404 为现有 runtime 初始化流程，随后成功加载。
- 初轮设置诊断沿既有行为枚举用户级指令/技能元信息；最终一轮为子进程预加载合成 homedir 后完整重跑，排除真实用户目录依赖。未修改 HOME、真实文件或 Keychain，未调用模型。
- 页面、浏览器和本轮两个 Host runner 已关闭；runner 自建临时 data root 已清理。

## 影响与风险

- 新接口不自动显示旧无 User 位置的数据、模型配置和凭据；升级可能出现空历史或默认配置。旧数据仍原地保留，未来迁移需明确归属与授权。
- 外部 Session Plugin/嵌入宿主需提供可信 identity；需要同步调用的方法必须有明确 server request 声明。普通 Plugin 不能再使用宿主全局清理或依赖可写查询引用。
- 同 User 多 Session 的持久内容共享需要 Plugin 存储自身支持并发；此轮不引入实时跨 Session 通知或 OS 沙箱。

## 偏差与遗留

没有超出本 Task 范围的功能变更。Session 销毁并发、SSE 重连同步和客户端布局权威问题按 Task 非目标保留为其他工作；没有将它们描述成本轮已修复。

## 后续关注

- 旧数据认领或迁移若有需要，应单独定义 User 来源、授权、范围和回退方案。
- 需要跨 User 共享或跨 Session 实时通知时，再设计明确能力；当前默认接口不隐式提供。

## 相关正式文档

- [ADR 0005：Plugin 默认接口绑定可信身份与所有权](../../decisions/0005-plugin-default-boundaries.md)
- [核心设计原则](../../architecture/core-principles.md)
- [插件运行时模型](../../architecture/plugin-runtime-model.md)
- [Kit 与会话模型](../../architecture/kit-and-session-model.md)
- [Kit 配置持久化模型](../../architecture/kit-configuration-model.md)
- [系统架构](../../architecture/system-overview.md)
- [Agent Context Store](../../architecture/agent-context-store.md)
- [Model Service](../../architecture/model-service-plugin.md)
- [Plugin 与 Kit 开发指南](../../guides/developing-plugins-and-kits.md)

## 决策闭环收口

### Decision Delta

- **ADR／已批准方向**：用户明确授权本轮默认边界修复及设计原则更新。可信身份、默认私有范围、owner 写入、快照和调用权限一致性进入 ADR 0005；业务模型不进入 Framework。
- **architecture／当前事实**：新路径、Config 用户根、凭据 scope、facade 和同步 ACL 写入相应模型；旧 Editor 简化描述由 ADR 0005 明确部分取代，其他约束继续有效。
- **guide／操作方法**：开发者使用已绑定路径和凭据，不自行推导身份；声明公开同步方法，并按双 User/Session/Plugin 验证。更新现有指南，无额外状态系统。
- **Task-only／验证证据**：干净构建顺序、fixture 适配、getter 回归修复和最终浏览器断言保留于本总结，不升级为无关长期架构。

### 反向检索验证

仓库检索“默认接口／可信身份／User Session Plugin／owner／独立快照／callPlugin callers／旧无 User 数据”可命中 ADR 0005、核心原则、Plugin 模型、配置模型和开发指南。Task 与 ADR、正式投影双向关联，README 与 ADR 索引均可到达相关文档。正式 decision memory 本轮无命中、fresh、failed_files=0；以仓库已发布来源完成发现与验证，不写外部记忆。

### 发现项分类

- **blocking**：无；首轮 layouts getter 阻塞已修复并复审通过。
- **non_blocking**：旧无 User 数据不会自动呈现，是本轮明确的兼容边界；无需对真实数据执行操作即可交付代码。
- **decision_candidates**：无未决的本轮实施方案；旧数据迁移、跨用户共享和实时广播保持未授权后续范围。
- **follow_up**：按用户需要单独设计旧数据认领；此前已知 Session/SSE/布局问题继续独立处理。本轮不自动开启这些变更。
