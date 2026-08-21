# 2026-08-20-simplify-plugin-settings 实现总结

## 最终结论

插件设置页通信已按确认方案完成重构：全局 Settings 只负责页面注册、导航和容器；Agent 与 Model Service 的 Settings Panel 直接请求各自插件，由业务插件继续拥有并读写自己的配置。专项测试、构建、插件检查与 Web 浏览器验收均已通过。

## 需求完成情况

- Settings schemaVersion 3：已完成。
- 删除 Settings 业务请求代理：已完成。
- Agent 与 Model Service 设置页直连 owner：已完成。
- Panel owner 身份进入服务端 `callers` 检查：已完成。
- Framework、目标插件、Kit 和 Web 局部验证：已完成。

## 主要改动

- Settings 贡献升级到 schemaVersion 3，只保留 `panel` 与可选 `order`；页面标题直接复用 Panel 注册信息。
- Settings 主插件只维护页面注册表并提供 `getPages`、`openSettingsPanel`，删除 `requestPage` 业务转发。
- Settings Panel 只负责页面导航和 iframe 容器，删除子页面 `postMessage` 请求/响应桥。
- Agent Settings Panel 直接请求 `agent.getSettings`、`agent.saveSettings`、`agent.resetSettings`。
- Model Service Settings Panel 直接请求 `model-service` 的设置与 Provider 管理方法。
- 两个业务插件的设置路由分别限制 `callers` 为 `agent` 和 `model-service`。
- Framework 为 Panel HTML 注入绑定 session、Panel 和 owner 的签名 capability；消息入口验证后通过 `requestFrom(owner, ...)` 分发。未携带有效 capability 的旧式无 ACL 请求保持兼容。
- 动态 Panel HTML 返回 `Cache-Control: no-store`，避免 Server 重启后复用旧 capability。
- 服务端对无效或过期 capability 返回 `403 / PANEL_CAPABILITY_INVALID`；Panel Runtime 收到该错误后重新读取当前 Panel HTML、更新 capability，并仅重试原请求一次。并发请求共享同一个刷新过程，刷新失败后后续请求仍可再次尝试。
- Settings 左侧页面导航从固定 190px 改为内容驱动宽度：常规面板限制在 120–220px，窄面板限制在 96–112px，长标题沿用省略显示，把更多空间留给业务设置页。

## 关键决定

- Settings Center 是目录、导航和容器，不拥有业务配置，也不代理业务请求。
- 每个业务插件拥有自己的 Settings Panel 与配置读写接口。
- Panel API 仍使用 `ctx.message.request(plugin, name, ...args)`；所属插件身份由 Framework 附加，不由页面请求体声明。
- 未携带有效 capability 的既有无 ACL 请求保持兼容。

## 验证结果

- `pnpm --filter @itharbors/server exec vitest run tests/integration/routes.test.ts`：23 项通过。
- `pnpm --filter @itharbors/server exec vitest run tests/routes/panel-asset.test.ts tests/integration/routes.test.ts`：38 项通过，覆盖 capability 签发与校验、无效 capability 明确错误、旧请求兼容、禁止缓存、自动刷新成功及二次 403 不循环重试。
- Settings 主插件、schema 和 Panel 定向测试：11 项通过。
- Agent 与 Model Service 主插件及 Settings Panel 定向测试：37 项通过。
- `pnpm --filter @itharbors/server run typecheck`：通过。
- `pnpm --filter @itharbors/server run build`：通过。
- Settings、Agent、Model Service 的 `ce-plugin check`：通过。
- Settings Panel 定向测试：4 项通过。
- `pnpm --dir kits/agent-chat run build`：通过，构建 9 个插件。
- `pnpm --dir kits/agent-chat run test:kit`：通过，校验 8792 个文件。
- Web 浏览器验收：设置中心显示 Agent 与 Model Service 两个页面；本轮修复后 Agent 页面正常显示“设置已加载”，未再出现 caller 权限报错；左侧导航在当前窄面板中收缩，内容区获得更多宽度，长标题正常省略；此前已确认 Model Service 页面成功读取 Provider、模型和凭据配置状态，Settings 插件只暴露 1 个 request。未执行保存、删除或凭据操作。

## 已确认事实

- 配置所有权保持在业务插件，Settings 不读取业务 config 或 credentials。
- 完整链路为：Settings Center 加载业务 Settings Panel → Panel 直接 request owner 插件 → owner 插件读写自身配置。
- 保留现有 Mermaid 修复、Audio 移除、Chat UI 和 iframe 权限等未提交改动，未将其纳入本任务。

## 尚未完成事项

- 本任务不包含 Panel 插件间的完整浏览器安全隔离；该能力需要后续独立 Framework 设计。
- 当前未按用户授权执行提交、push 或 PR 操作。

## 影响与风险

Panel capability 能阻止请求体直接声明 `caller`，但当前所有 Panel 仍运行在同一 Web origin。恶意已安装 Panel 可以读取另一个 Panel HTML 中的 bearer capability 并重放；因此它不是插件间的完整安全隔离。彻底解决需要独立 origin、opaque-origin sandbox 或宿主级不可读取通道，属于后续 Framework 安全设计范围。

## 偏差与遗留

- 业务通信简化目标已完成。
- Framework capability 只作为宿主签发与防篡改身份，不宣称在同源 Panel 模型下抵御恶意插件重放。
- Mermaid 修复、Audio 移除、Chat UI 和 iframe 权限等现有未提交改动均被保留，未纳入本任务。

## 后续关注

- 单独设计 Panel origin 隔离或可信宿主通道，再将 `callers` 提升为恶意插件边界上的强安全控制。
- 后续业务插件只需注册自有 Settings Panel 和 owner 请求，不再给 Settings 增加业务代理。

## 相关正式文档

- [Task 需求快照](./task.md)
