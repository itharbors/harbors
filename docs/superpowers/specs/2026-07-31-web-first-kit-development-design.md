# Kit Web 优先开发规则设计

## 背景

Harbors 的 Kit 界面与业务流程在 Web 和 Electron 中复用同一套 Gateway、Server、Client 与插件运行时。现有规则虽然要求日常开发优先使用 `npm run dev:web`，但又要求所有改动在交付前统一通过 Electron 验收。这让不涉及桌面宿主的 Kit 改动承担了重复的验收成本，也弱化了 Web 入口作为主要开发环境的定位。

## 决策

普通 Kit 开发、调试和最终验收默认使用 `npm run dev:web` 与浏览器。只要改动在 Web 与 Electron 中共享实现，浏览器验收即可作为该改动的界面验收证据，不再额外要求 Electron 收口。

以下改动仍必须使用 Electron 开发或完成补充验收：

- 系统托盘与 `BrowserWindow` 生命周期；
- 原生对话框与桌面 IPC；
- 通知、自动更新和应用打包；
- 操作系统集成；
- 明确修改了 Web 与 Electron 不同的控件、入口或行为。

同时影响共享界面和桌面专属行为的改动，需要分别验证浏览器共享路径与 Electron 专属路径。开发者可以为普通 Kit 改动自愿执行 Electron 冒烟检查，但它不是统一门禁。

## 文档落点

- 根目录 `AGENTS.md`：将开发验证规则改为 Kit Web 优先，并移除统一的 Electron 最终验收要求。
- `docs/guides/development-workflow.md`：将“Web 优先、Electron 收口”改为“Kit Web 优先、桌面能力按需验收”，写明选择验证入口的判断条件。

## 验证

本次只调整仓库开发规则，不改变运行时代码。验证包含：

- 检查两处规则对 Web 默认路径和 Electron 触发条件的描述一致；
- 搜索并移除“所有改动必须 Electron 验收”之类的冲突表述；
- 运行仓库文档测试，确认链接、命令和开发指南契约仍然有效。

## 非目标

- 不修改 Web 或 Electron 的运行时行为；
- 不改变桌面专属功能的测试要求；
- 不把 Electron 冒烟检查加入普通 Kit 的默认验收流程。
