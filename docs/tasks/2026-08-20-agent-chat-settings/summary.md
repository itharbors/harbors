# 2026-08-20-agent-chat-settings 实现总结

## 最终结论

已按需求将 Settings 调整为设置页面注册、展示和受控转发容器；Agent 与 model-service 分别负责自己的配置校验、持久化和凭据处理。代码构建及相关 Node 测试通过，但 Web 验收仍有模型服务页面自动化切换未生效的问题，因此不能宣称设置功能已完成全部浏览器验收。

## 需求完成情况

- Settings 页面贡献、注册表、排序、attach/detach/replace 和请求白名单已实现。
- Agent 设置页及 sandbox mode、approval policy 的读取、保存、重置接口已实现。
- model-service Provider 设置页、Provider/凭据操作和安全配置返回已实现。
- Provider 变化广播与 Chat 模型目录刷新链路已实现；浏览器自动化切换未生效，仍需后续定位。
- Settings 不保存 Agent/model-service 业务配置，页面请求由所属 Plugin 执行，符合已确认的职责边界。

## 主要改动

- 将 Settings 的通用字段表单模型替换为 schema version 2 的页面贡献注册模型。
- Agent 新增独立设置面板和 `getSettings`、`saveSettings`、`resetSettings` 接口。
- model-service 新增 Provider 设置面板、凭据 Vault 读写/重置和 `model-service.catalog.changed` 广播。
- Chat 订阅模型目录变化并更新模型选择和配置错误状态。

## 关键决定

- Settings 只做页面容器和 RPC 网关，不接管其他 Plugin 的配置存储。
- 页面只能调用自身贡献中声明的 request；Provider 返回安全配置，不返回真实 Token 或凭据内部标识。
- 设置接口使用带 `methods`/`callers` 的消息描述符；调用方限制作为消息层边界保留。

## 验证结果

- `pnpm exec tsx --test` 覆盖 message、agent、model-service、settings、model-catalog、transcript：77/77 通过。
- `ce-plugin build/check` 对 settings、agent、model-service、chat、audio、mermaid 均 exit 0。
- Web 验收加载插件 14/14；Agent 设置页可见且显示已加载；Chat 语音按钮可见。
- Web 自动化切换模型服务页面未生效，不能据此确认 Provider 页面保存和目录刷新在浏览器端完整通过。
- 首次 `kits:check` 因 stale lock 失败；已执行 `pnpm install --lockfile-only --no-frozen-lockfile` 同步锁文件。复跑进入 Kit test 后因隔离环境缺少 `yazl` 失败。
- Server 聚焦测试 118/119，通过项之外唯一失败为未修改断言 `broadcasts enriched config change payloads...`；Server 全量 737/741，另外三个 integration session/kit 失败，均不在本次 diff。
- Client 聚焦测试 75/76、全量 285/286；唯一失败为本次未修改的 legacy Electron bridge bootstrap 测试。

## 影响与风险

- Settings 现在依赖所属 Plugin 的消息接口和 panel contribution；贡献声明错误会使页面被忽略。
- Provider 目录广播依赖 revision 和 Web 侧订阅，页面自动化未生效说明仍需检查 iframe 请求代理、事件注册或浏览器环境。
- Kit 检查受隔离环境缺少 `yazl` 影响，当前没有完整 Kit test 通过证据。
- 本 Task 未改变凭据模式的安全策略；该策略风险记录在 credential-mode Task。

## 偏差与遗留

- 未完成模型服务设置页的浏览器自动化切换验收。
- 未补充上述范围外的 Server、Client、host-security 失败项；它们分别属于既有断言、隔离环境或未修改的兼容测试。
- 本 Task 没有专门新增浏览器自动化测试来覆盖 Provider 保存后的目录刷新。

## 后续关注

- 复现并修复模型服务设置 iframe 的自动化切换，确认 requestPage 白名单、Provider 保存和目录广播端到端一致。
- 在具备完整依赖的环境重跑 Kit test，并观察旧 Server/Client 失败是否仍保持在本次 diff 之外。

## 相关正式文档

- [Task 需求快照](./task.md)
