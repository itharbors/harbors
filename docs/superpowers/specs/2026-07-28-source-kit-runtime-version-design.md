# 源码 Electron Kit 安装兼容修复设计

## 背景与根因

源码入口通过根目录执行 `electron scripts/electron.mjs`。根 `package.json` 不声明应用版本，
因此未打包 Electron 的 `app.getVersion()` 返回 Electron 自身版本。Kit Manager 把该值作为
`harborsVersion` 参与 Kit 兼容性检查，导致满足桌面应用版本范围的线上 Kit 在下载前被错误拒绝。

打包应用不存在该问题：`electron-builder` 以 `packages/desktop/package.json` 为应用目录，
`app.getVersion()` 与发布版本一致。修复必须保留这一发布身份边界，不能在根 `package.json`
复制第二份应用版本。

## 版本解析

新增可独立测试的桌面版本解析模块：

- 打包态继续接受 Electron `app.getVersion()`，它仍是已安装应用的权威版本；
- 源码态读取 `packages/desktop/package.json` 的 `version`，它是仓库内唯一的应用版本声明；
- 两种来源都必须是合法 SemVer；缺失、格式错误或文件不可读时启动失败并给出明确错误；
- 解析结果同时供 Kit runtime 与更新控制器使用，避免同一进程出现两个应用版本。

Electron 入口只负责收集 `app.isPackaged`、`app.getVersion()`、仓库路径和文件读取适配器，
版本选择与校验留在纯 Node 模块中。

## Kit Manager 反馈

安装兼容错误继续通过受限 IPC 返回公开错误码和消息，不扩大 renderer 权限。兼容资产解析失败时，
保留底层兼容检查的具体原因，例如 Harbors 版本范围不满足，而不是统一改写为
“no unique compatible asset”。

Kit Dock 的全局操作状态改为视口内可见的 sticky 提示。安装开始时立即显示正在处理的 Kit 和
版本，失败或成功后复用同一区域，并保持现有 `role=status` / `role=alert` 语义。按钮仍在操作期间
禁用，避免重复安装。

## 测试与验收

测试先覆盖以下失败场景，再实现修复：

1. 源码态解析到桌面包版本，而不是传入的 Electron 版本；
2. 打包态保留 Electron 应用版本；
3. 任一来源不是合法 SemVer 时明确失败；
4. Electron 入口把同一解析版本同时传给 Kit runtime 和更新控制器；
5. 不兼容 Release 返回具体的版本范围原因；
6. 点击安装后立即出现进度状态，失败状态在滚动页面中保持可见；
7. 现有 Kit Manager IPC、resolver、view 与桌面测试全部通过。

最终手工验收从源码运行 Electron，刷新线上 Registry，安装 Preview Kit，确认产物能够下载并进入
已安装状态；Electron 专属安装链路必须在桌面宿主中验收，Web 模式不能替代该步骤。
