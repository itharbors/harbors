# Agent Guard 增加浏览器打开菜单

Task ID: `2026-08-07-browser-menu`
Type: `feature`

## 背景与问题

Agent Guard 当前只在“视图”菜单提供打开面板的入口。用户希望增加一个菜单动作，点击后把当前 Agent Guard 页面交给系统默认浏览器打开，便于脱离桌面窗口单独查看。

## 目标

- 在 Agent Guard Kit 菜单中增加“在浏览器中打开”动作。
- 菜单动作返回 Framework 已支持的 `open-current-url` 结果，由 Electron Host 使用默认浏览器打开当前页面。
- Web Host 没有 Electron bridge 时继续使用新标签页降级行为。

## 范围

- Agent Guard Center 插件的菜单声明、菜单方法及对应测试。
- Agent Guard Kit 的 Preview 版本记录。

## 非目标

- 不新增或修改 Framework 的外部 URL 打开协议。
- 不改变 Agent Guard 面板、流量采集、模型用量或进程识别逻辑。
- 不自动合并或发布 Kit。

## 验收标准

- Agent Guard 菜单中可见“在浏览器中打开”。
- 点击菜单后，Center 方法返回 `{ type: 'open-current-url' }`。
- 现有“打开 Agent Guard 面板”菜单行为不受影响。
- Agent Guard build、test、validate、pack、inspect 全部通过。

## 约束

- 改动严格位于 `kits/agent-guard` 与当前 Task 三份正式档案的 Kit boundary 内。
- 复用现有 Host 能力，不直接在插件服务端调用操作系统命令或 Electron API。

## 需求变更

无。
