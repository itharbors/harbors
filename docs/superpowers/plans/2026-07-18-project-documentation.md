# 项目说明体系重建实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重写根 README，并在 `docs/` 下建立准确解释 ITHARBORS 设计、架构、运行流程和扩展方式的知识库。

**Architecture:** 使用“入口 → 架构 → 指南 → 决策”的分层结构。根 README 保持简洁，架构文档描述当前行为和不变量，指南提供可执行步骤，ADR 保存设计取舍；关键结论均提供当前源码入口。

**Tech Stack:** Markdown、Mermaid、npm workspace、Node.js、TypeScript、Vite、Electron

## Global Constraints

- 只修改 `.md` 文件；需要修改源码、配置或测试时先征询用户。
- 以当前 `packages/`、`plugins/`、`kits/`、`scripts/` 实现为事实来源。
- 根 README 使用现有文件名 `readme.md`，不进行大小写重命名。
- 不承诺尚未实现的 API 稳定性、发布流程或兼容策略。
- `docs/superpowers/` 不加入普通读者的主导航。

---

### Task 1: 项目入口与知识库导航

**Files:**
- Modify: `readme.md`
- Create: `docs/README.md`

**Interfaces:**
- Consumes: 根 `package.json` 中的脚本、workspace 布局和服务端口。
- Produces: 全部后续文档的顶层导航与推荐阅读路径。

- [x] **Step 1: 核对入口事实**

运行 `node -e "const p=require('./package.json'); console.log(p.workspaces); console.log(p.scripts)"`。
预期输出三个 workspace glob 以及 `dev`、`electron`、`build`、`test`、`plugins:build`、`plugins:check` 等脚本。

- [x] **Step 2: 重写根 README**

保留项目定位、环境要求和快速开始，加入简化系统图、核心概念、仓库地图和分层文档入口；避免复制专题文档细节。

- [x] **Step 3: 创建知识库入口**

`docs/README.md` 提供按角色的阅读路径、完整文档地图、文档职责和“当前行为/历史设计”的区分方式。

- [x] **Step 4: 验证入口链接**

遍历 Markdown 相对链接并确认目标存在。预期根 README 和 `docs/README.md` 的本地链接全部有效。

### Task 2: 设计原则、系统边界与运行流程

**Files:**
- Create: `docs/architecture/core-principles.md`
- Create: `docs/architecture/system-overview.md`
- Create: `docs/architecture/runtime-flows.md`
- Create: `docs/architecture/kit-and-session-model.md`

**Interfaces:**
- Consumes: Gateway、Server app/editor、Client transport、会话/SSE/Kit 实现。
- Produces: 其他专题文档共同引用的系统词汇、边界、不变量和端到端流程。

- [x] **Step 1: 编写核心原则**

明确插件优先、Kit 能力边界、会话隔离、Server 权威状态、声明式布局、双宿主和安全资源边界。

- [x] **Step 2: 编写系统总览**

用 Mermaid 图说明 Browser/Electron → Gateway → Server/Client；用表格列出各 workspace 和运行时模块的职责与依赖方向。

- [x] **Step 3: 编写运行流程**

覆盖开发栈启动、会话/bootstrap、request、broadcast/SSE、Kit 切换、打开面板/窗口六条流程，并说明失败与回滚边界。

- [x] **Step 4: 编写 Kit 与会话模型**

说明 `sessionId`、Editor 实例、SQLite 元数据、Kit descriptor、内置/外部插件差异，以及 Kit 切换的清理与恢复。

- [x] **Step 5: 核对源码索引**

每篇文档末尾列出实现对应行为的当前源码文件，并逐一确认路径存在。

### Task 3: 插件、布局、UI 与开发指南

**Files:**
- Create: `docs/architecture/plugin-runtime-model.md`
- Create: `docs/architecture/layout-model.md`
- Create: `docs/architecture/ui-system.md`
- Create: `docs/guides/development-workflow.md`
- Create: `docs/guides/developing-plugins-and-kits.md`
- Create: `docs/guides/maintaining-docs.md`

**Interfaces:**
- Consumes: 插件 resolver/build/validate、framework plugin/message/panel/window、Client layout/UI/theme、Electron bridge 和默认 Kit。
- Produces: 扩展开发者与日常维护者可直接使用的专题说明。

- [x] **Step 1: 编写插件运行时模型**

说明 manifest、解析优先级、register/load/attach 与 detach/unload、贡献点、资源白名单、消息位置和错误清理。

- [x] **Step 2: 编写布局模型**

定义 Window、WindowGroup、PanelInstance、LayoutNode、leaf/tab/hsplit/vsplit、尺寸与拖放约束，以及 Server 快照到 Client 组件的映射。

- [x] **Step 3: 编写 UI 系统**

说明 Web Components、设计 token、Kit theme、iframe 主题注入、组件职责和 Electron preload 边界。

- [x] **Step 4: 编写开发工作流**

按环境准备、启动、构建、测试、插件校验、指定 Kit、Electron 和故障排查组织命令。

- [x] **Step 5: 编写插件与 Kit 指南**

提供真实目录树、最小 manifest、生命周期骨架、构建/校验命令、Kit package 与 layout 示例，并链接默认实现。

- [x] **Step 6: 编写文档维护指南**

定义文档职责、代码变更触发的更新范围、源码索引规则、ADR 规则和提交前清单。

### Task 4: 设计决策、交叉链接与最终验证

**Files:**
- Create: `docs/decisions/README.md`
- Create: `docs/decisions/0001-plugin-first-architecture.md`
- Modify: `readme.md`
- Modify: `docs/README.md`
- Modify: `docs/architecture/*.md`
- Modify: `docs/guides/*.md`

**Interfaces:**
- Consumes: 前三项任务的全部文档。
- Produces: 可追溯、无断链、职责清晰的最终说明体系。

- [x] **Step 1: 建立 ADR 索引和首篇决策**

ADR 0001 包含状态、上下文、决策、替代方案、正负影响、约束和关联文档；索引说明编号与取代规则。

- [x] **Step 2: 检查本地链接**

遍历所有 Markdown 链接，忽略网络 URL 和页内锚点；解析相对路径并确认文件存在。预期零个缺失目标。

- [x] **Step 3: 检查占位与旧结构泄漏**

运行 `rg -n "TBD|TODO|待补充|app/source|workflow/source|kit/example|plugin/message" readme.md docs --glob '*.md'`。
预期主文档无占位符；旧路径只允许出现在设计规格的迁移背景中。

- [x] **Step 4: 检查变更范围与格式**

运行 `git diff --check` 和 `git status --short`。预期无空白错误，且本次目标变更全部是 Markdown。

- [x] **Step 5: 对照需求逐项审计**

确认根 README、设计思路、架构、流程、插件/Kit、布局/UI、开发指南、ADR、导航和维护规则均有独立且互相链接的落点，并抽查命令、路径和关键流程的源码依据。
