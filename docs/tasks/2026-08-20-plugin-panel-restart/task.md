# 2026-08-20-plugin-panel-restart

Task ID: `2026-08-20-plugin-panel-restart`
Type: `bug`

## Summary

修复普通 Session 插件执行 `unload → load` 时 Web 面板仍保留旧 iframe 的问题。

## 背景与问题

服务端会在插件卸载与加载期间注销、重新注册 Panel contribution，但客户端没有收到面板可用性变化，因此旧 iframe、旧 Panel runtime 和旧资源继续存活。

## 目标

- 插件面板注销时移除对应 iframe，并在原位置显示“插件未加载”。
- Panel contribution 重新注册后原位恢复面板并创建新 iframe。
- 保留布局、Tab、激活状态、尺寸、Window Group 与 Panel Instance。
- 不重建无关插件面板。

## 范围

- Framework Panel registry 的变更通知。
- Session SSE 的 Panel 可用性事件。
- Web Client 对目标面板的定点卸载、占位和恢复。
- 对应服务端与浏览器侧回归测试。

## 非目标

- 不新增插件 `restart` 生命周期。
- 不改变 Application startup plugin 的独立进程重启语义。
- 不加入 Electron 或桌面宿主能力。

## 验收标准

- 面板 unregister 后目标 iframe 被销毁并显示“插件未加载”。
- 面板 register 后目标 iframe 重新创建并再次 mount。
- 其他插件面板 iframe 保持不变。
- 重复或乱序事件不会恢复过期状态。
- 针对性服务端测试和 Web 客户端测试通过。

## 约束

- 保留用户当前工作区已有改动，不覆盖或回退无关文件。
- 插件与浏览器宿主之间继续通过消息/SSE 投影状态。

## 需求变更

- 用户授权直接在当前本地分支修改，不使用基于 `origin/main` 的独立 worktree。
