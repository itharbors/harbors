# Agent Guard 增加浏览器打开菜单 实现总结

## 最终结论

Agent Guard 已在 Kit 菜单的“文件”分组增加“在浏览器中打开”。点击后复用 Framework 的 `open-current-url` 结果协议：Electron Host 调用系统默认浏览器，Web Host 在没有桌面 bridge 时降级为新标签页。

## 需求完成情况

- Agent Guard Kit 菜单新增“文件 → 在浏览器中打开”。
- Center 插件新增 `openInBrowser` 菜单方法并声明 request 能力。
- 当前页面 URL 由 Client 菜单运行时统一处理，Kit 不接触 Electron API 或操作系统命令。
- Kit 版本从 `0.1.0-preview.6` 提升到 `0.1.0-preview.7`。

## 主要改动

- 扩展 Agent Guard Center 插件菜单声明与主进程方法。
- 新增菜单声明、request 映射和方法返回值的聚焦测试。
- 同步 `kit.json`、`package.json`、`package-lock.json` 三处版本。

## 关键决定

- 复用 Framework 现有的 `open-current-url` 菜单结果协议，不在 Kit 中复制 URL 打开逻辑。
- 将入口放在“文件”菜单，保留现有“视图 → 面板 → Agent Guard”入口的职责与行为。

## 验证结果

- `npm run test:kit -- --run plugins/agent-guard-center/tests/main.test.ts`：2/2 通过。
- `npm run kits:check -- agent-guard`：通过，包含 build、test、validate、pack、inspect。
- Web 开发 Host：bootstrap 返回“文件 → 在浏览器中打开”，触发接口返回 `{ type: 'open-current-url' }`。
- Electron 实机烟测：原生 Agent Guard 菜单显示该动作，点击后 Safari 成功打开同一 Agent Guard 会话页面。
- `git diff --check`：通过。

## 影响与风险

改动仅新增一个无参数菜单动作，实际 URL 打开和安全校验继续由 Framework/Electron Host 负责。现有面板菜单、后台监控与历史数据行为不变。

## 偏差与遗留

无。

## 后续关注

无。

## 相关正式文档

无。
