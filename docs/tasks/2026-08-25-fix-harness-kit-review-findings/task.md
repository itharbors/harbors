# 修复 Harness Kit 走查问题

Task ID: `2026-08-25-fix-harness-kit-review-findings`
Type: `bug`

## 背景与问题

Harbors Harness 改名走查确认产品身份迁移完整，但发现三个会影响实际功能或测试可信度的问题：Settings 菜单引用了未声明的 request route；Kit 级测试脚本未覆盖 Plugin 内并置单元/组件测试；Conversation 与 Chat Panel 创建 React Root 后没有卸载，导致测试结束后仍存在异步活动，并可能在面板重载时残留状态。

## 目标

1. 让 Settings 菜单通过正式消息路由可靠打开设置面板。
2. 将 Harness Kit 内的 Plugin 并置测试纳入 Kit 测试门禁。
3. 为 Conversation 与 Chat Panel 建立对称的 mount/unmount 清理，消除 React Root 和模块状态残留。

## 范围

- `kits/harness/plugins/settings/**` 的消息声明及回归测试。
- `kits/harness/package.json`、Kit-local Vitest 配置及必要的测试装配调整。
- `kits/harness/plugins/conversation/panel.list/**` 与 `kits/harness/plugins/chat/panel.main/**` 的卸载实现和测试。
- 本 Task 的 `task.md`、`status.json`、`.work/**` 与收口阶段的 `summary.md`。

## 非目标

- 不改变 Harness Kit 名称、Plugin 清单、Panel ID 或现有业务消息名称。
- 不调整 Framework 的菜单、消息、Panel 生命周期实现。
- 不处理本次走查中的历史文档链接、Credential Vault 缓存或 Chat renderer Map 等低优先级发现。
- 不引入 Electron、桌面窗口或非 Web 宿主假设。
- 不 push、不创建 PR；用户已授权验证完成后以 squash 方式整合回本地 `main`。

## 验收标准

1. `view/panels/ce-settings-settings` 指向的 `settings.openSettingsPanel` request 已在 Plugin manifest 中声明，并有测试覆盖菜单消息到现有 handler 的映射。
2. Harness 的标准 Kit 测试命令会运行 Kit 内全部适用的 Plugin 并置单元/组件测试，测试发现范围不越出目标 Kit。
3. Conversation 与 Chat Panel 保存各自的 React Root，提供幂等 `unmount()`，清理注册 setter 与缓存状态；重复 mount/unmount 不产生残留或 React 异步错误。
4. 修复前失败的 Conversation Panel 测试通过，新增或更新测试可证明 Chat Panel 的同类清理行为。
5. Harness descriptor、Plugin runtime smoke、Kit assembly、Kit build/check、Web smoke 均通过。
6. 通过唯一 Web 宿主在浏览器验证 Harness 13/13 Plugin 加载、Settings 可见且控制台无 error/warning。
7. `git diff --check`、Task 普通检查与 ready gate 通过，实际 diff 不超出声明范围。

## 约束

- Kit 变更在 `kits/harness` 内独立闭环；除本 Task 档案外不修改 Framework 或其他 Kit。
- Plugin 交互继续通过 request/broadcast，Settings 菜单必须声明并使用既有 request 名称。
- 测试仍遵守 Plugin 单元/组件、runtime smoke、Kit assembly、Web smoke 分层，不用宽泛 mock 替代真实目标边界。
- 保留当前工作区已有的两处用户 Skill 修改，不 stash、reset、覆盖或纳入本 Task。
- `status.json` 只通过 Task CLI 修改。
- 本地 squash 整合必须在 ready gate 通过后，针对已确认源分支和 head 执行，不 push。

## 需求变更

本 Task 未发生需求变更。

## 决策上下文与处置

### Decision Context

- 2026-08-25 仓库定向扫描覆盖 `docs/decisions`、`docs/architecture`、`docs/guides`、Harness 改名 Task、测试指南及三个问题对应的 Kit/Plugin 实现。
- 命中的已批准约束是：Kit 作为装配边界在自身目录闭环；Plugin 通过 request/broadcast 暴露能力；Harbors 仅支持 Web 宿主；Kit、Plugin、Web Host 测试按功能边界分层。
- 本次不形成新的产品、架构或数据治理选择，只修复当前实现与既有约束的偏差；因此无需新增 ADR。
- owner：当前主 Agent，来源为本 Task 编排者，负责需求、实现、状态和最终验收。
- reviewer：执行计划中的独立审查角色，负责方案和实现边界审查。
- approver：当前用户，来源为本 Task 创建及 squash 本地整合授权者，负责范围和交付方式批准。

### 逐条处置与分工

- **适用**：Plugin 消息交互约定。Settings 菜单继续定向 request `settings.openSettingsPanel`，只补齐 manifest 声明，不绕过消息系统。
- **适用**：Kit 独立闭环约束。实现和测试限制在 `kits/harness/**`，Task 档案作为流程例外位于 `docs/tasks/**`。
- **适用**：测试分层约束。Plugin 并置测试进入 Kit test gate，同时保留 runtime smoke、assembly 与 Web smoke 的独立语义。
- **当前实现事实**：Conversation 和 Chat Panel 均创建 React Root 却未保存或卸载；清理应与 Panel 生命周期对称，并清除模块级回调和缓存。
- **不适用**：改名迁移、旧入口兼容、配置/API Key 迁移；这些已由前序改名 Task 完成，本 Task 不重新设计。

### 过程关联

- Settings request 声明 → manifest/route 单元测试 → Kit assembly 或菜单触发验证。
- Plugin 测试门禁 → Harness package script/Vitest 发现配置 → 标准 Kit test/check 证据。
- Panel 生命周期 → Conversation/Chat Panel 单元测试 → Web 浏览器加载、切换及控制台检查。
- 范围和交付约束 → Task check、Kit boundary、ready gate 与最终 squash 本地整合。
