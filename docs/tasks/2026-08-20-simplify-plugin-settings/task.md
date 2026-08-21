# 2026-08-20-simplify-plugin-settings

Task ID: `2026-08-20-simplify-plugin-settings`
Type: `refactor`

## Summary

将全局 Settings 插件缩减为设置页面目录、导航和容器；Agent、Model Service 等业务插件注册并拥有自己的 Settings Panel，由页面直接请求所属插件完成配置读写。

## 背景与问题

当前业务设置页需要通过 `postMessage` 请求全局 Settings Panel，再由 Settings 主插件代理到业务插件。该链路让 Settings 同时承担页面容器和业务请求代理，配置所有权不直观，也会形成不必要的高权限转发入口。

## 目标

- 全局 Settings 只管理设置页面目录、导航和容器。
- 每个业务插件注册并拥有自己的 Settings Panel。
- 业务设置页面直接请求所属插件，由所属插件读写自己的配置与凭据。
- Panel 请求在服务端获得所属插件身份，用于执行消息路由的 `callers` 检查。

## 范围

- Framework 为 Web Panel 的消息请求提供服务端可信的所属插件身份。
- Settings 贡献升级到 schemaVersion 3，只声明 Panel 和排序；标题复用 Panel 自身标题。
- Settings 插件保留页面注册、排序、导航、iframe 容器和打开设置中心能力。
- 删除 `settings.requestPage`、`settings.requests` 和设置 iframe 的 `postMessage` 请求桥。
- Agent 与 Model Service 的 Settings Panel 直接请求各自插件。
- 请求路由使用 `callers` 限制为对应插件自己的 Panel 身份。
- 动态 Panel HTML 禁止缓存，避免浏览器复用旧 capability。
- capability 失效时返回明确错误，并由 Panel Runtime 自动刷新一次恢复。
- Settings 页面导航按菜单标题自适应收缩，为业务设置内容保留更多横向空间；窄面板下进一步限制导航宽度。

## 非目标

- 不改变 Agent 或 Model Service 具体配置项和持久化语义。
- 不引入集中式配置存储或让 Settings 读取业务配置。
- 不改动 Chat Mermaid 修复、Audio 插件变更及其他现有未提交内容。
- 不增加 Electron 或桌面宿主能力。

## 验收标准

- 全局 Settings 能列出并切换 Agent、Model Service 设置页面。
- 两个设置页面能正常读取、保存及执行已有业务操作。
- 业务请求直接发送给页面所属插件，不再经过 Settings 代理。
- 浏览器不能通过自行声明 caller 绕过消息路由的 `callers` 限制。
- 无 `callers` 限制的既有 Panel 请求保持兼容。
- Server 重启或热重载后，已打开的设置页能重新取得 capability，不持续显示 `not permitted for caller`。
- 左侧设置页面导航不再固定占用 190px；常规和窄面板下均保持可读且不会挤占过多内容空间。
- Framework、Settings、Agent、Model Service 的局部测试与检查通过，并完成 Web 浏览器验收。

## 约束

- 用户已明确要求继续在 `main` 工作，不创建分支或 worktree。
- 跨边界验证取 Framework、Settings、Agent、Model Service 的并集。

## 需求变更

本任务来自 Settings 插件职责讨论，按用户确认的“设置中心只加载各插件自有 Settings Panel”方案实施。首次 Web 验收后发现 Server 重启会使已打开 Panel 的 capability 失效，用户随后授权补充禁止缓存、明确错误和自动刷新恢复。后续视觉验收中用户认为左侧导航占用过大，因此追加内容驱动的自适应收缩。
