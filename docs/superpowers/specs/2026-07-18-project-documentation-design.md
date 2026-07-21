# 项目说明体系重建设计

## 背景

ITHARBORS 正从旧的 `app/`、`kit/`、`plugin/`、`workflow/` 目录迁移到由
`packages/`、`kits/`、`plugins/`、`scripts/` 组成的 npm workspace。根目录
README 已经部分按新结构改写，并引用了一组尚不存在的 `docs/` 文档。

本次工作建立一套与当前源码同步的说明体系，使读者既能快速运行项目，也能理解
框架为什么以插件、Kit 和会话为核心，以及请求、事件、布局和窗口状态如何流动。

## 目标与读者

说明体系同时服务两类读者：

- 项目维护者：需要理解系统边界、核心不变量、模块职责、运行流程和演进约束。
- 插件与 Kit 开发者：需要理解扩展点、目录约定、清单格式、生命周期和验证方式。

成功标准：

1. 新读者能从根 README 在十分钟内完成环境判断、启动项目并找到下一步文档。
2. 维护者无需通读全部源码即可说清 Gateway、Server、Client、Electron、Kit、插件、
   会话、消息、窗口和布局之间的关系。
3. 扩展开发者能依据指南定位示例、构建插件、组织 Kit，并理解运行时限制。
4. 每篇架构文档都能追溯到当前源码入口；文档间不存在失效的相对链接。

## 采用的组织方案

采用“由浅入深、按文档职责分层”的方案，而不是单篇长文或完全按代码包拆分。

```text
readme.md                              项目入口、价值、快速开始、架构摘要
docs/
├── README.md                          知识库入口、阅读路径、文档地图
├── architecture/
│   ├── core-principles.md             稳定设计原则与架构约束
│   ├── system-overview.md             进程、模块边界和部署形态
│   ├── runtime-flows.md               启动、会话、消息、Kit 切换、窗口流程
│   ├── plugin-runtime-model.md        插件发现、贡献点和生命周期
│   ├── kit-and-session-model.md       Kit 能力边界与会话隔离
│   ├── layout-model.md                Window、Panel、Tab、Split 状态模型
│   └── ui-system.md                   Web Components、主题、iframe 与 Electron
├── guides/
│   ├── development-workflow.md        开发、构建、测试和常用命令
│   ├── developing-plugins-and-kits.md 插件与 Kit 的可执行开发路径
│   └── maintaining-docs.md            文档职责、更新触发条件与校验清单
└── decisions/
    ├── README.md                      ADR 规则与索引
    └── 0001-plugin-first-architecture.md
                                         插件优先架构的背景与取舍
```

`docs/superpowers/` 只保存本次设计和实施过程，不进入面向普通读者的主导航。

## 内容边界

### 根 README

根 README 只承担项目介绍、核心能力、快速开始、命令、简化架构图、仓库地图和文档
入口。它不复制生命周期、协议字段或复杂状态转换，细节统一链接到 `docs/`。

### 架构文档

架构文档回答“系统是什么、为什么这样分、运行时如何协作”。每篇文档包含：

- 一段职责摘要；
- 关键概念和不变量；
- 必要的 Mermaid 图或表格；
- 典型流程与失败行为；
- “源码索引”，列出负责实现该行为的当前文件。

文档描述当前可验证行为。尚未实现的设想必须明确标注为未来方向，不能与现状混写。

### 指南

指南回答“如何完成一项任务”。命令以仓库根目录为工作目录，给出输入、预期结果和
失败排查入口。指南引用架构文档解释约束，但不重复大段架构叙事。

### 设计决策记录

ADR 回答“为什么选择这个方向”。首篇记录插件优先与 Kit 组合设计，包括上下文、
决策、替代方案、正负影响和后续约束。ADR 一经接受不覆盖历史；后续变化通过新 ADR
取代旧决策。

## 核心架构叙事

所有文档使用同一套主线：

1. Gateway 是开发时统一入口，将 `/api/*`、`/sse/*` 转发给 Server，其余请求转发
   给 Vite Client。
2. Server 按 `sessionId` 创建独立 Editor 运行时。每个 Editor 组合 config、i18n、
   plugin、panel、message、menu、kit 和 window 模块。
3. 内置插件提供框架级贡献点；Kit 声明会话所需的外部插件、窗口入口、主题和布局。
4. Client 通过 HTTP 获取会话与 bootstrap 快照，通过 SSE 接收布局、菜单、国际化和
   panel dispatch 等增量事件。
5. Panel 在受控 iframe 中运行，通过注入的运行时访问消息、资源、国际化和面板操作，
   不直接依赖 Server 内部模块。
6. Electron 是同一 Web 工作台的可选宿主，只通过受限 preload bridge 补充原生菜单
   和外部链接能力。

## 准确性与维护约束

- 以 `packages/`、`plugins/`、`kits/`、`scripts/` 当前源码为事实来源，不描述已删除的
  旧目录实现。
- 使用 `@itharbors/*` 和 `@itharbors/*` 时保持源码中的真实包名，不为了统一文案擅自改名。
- API 路径、脚本名、manifest 字段和生命周期方法必须逐项与源码或 `package.json`
  核对。
- 不在本次工作中修改 TypeScript、JavaScript、JSON、HTML、CSS 或构建配置。
- 发现文档目标依赖代码修复时记录问题并征询用户，不以文档掩盖实现差异。

## 验证策略

文档完成后执行以下检查：

1. 枚举全部 Markdown 相对链接并确认目标存在。
2. 搜索 `TODO`、`TBD`、旧目录名称和不允许的模糊占位内容。
3. 对照根 `package.json` 与各 workspace manifest 核对命令、版本要求和包名。
4. 对照 Server 路由、Editor 装配、Client transport、插件构建脚本与 Electron bridge，
   抽查所有关键流程。
5. 检查 `git diff --check`，确保没有空白错误；确认变更仅包含 Markdown 文档。

## 非目标

- 不生成完整的 HTTP API 参考或 TypeScript API 自动文档。
- 不承诺尚未实现的发布、版本兼容或稳定性政策。
- 不修改框架行为、目录结构、包名、构建脚本或测试。
- 不把历史迁移过程写进面向新读者的主线；仅在必要的 ADR 或维护说明中保留背景。
