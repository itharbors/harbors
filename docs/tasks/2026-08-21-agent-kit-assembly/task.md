# Agent Kit 跨插件装配回归

Task ID: `2026-08-21-agent-kit-assembly`
Type: `test`

## 背景与问题

Agent Chat Kit 由 Chat、Agent、Model Service、Preview 和 Settings 等插件装配而成，单个插件的构建或单元测试无法证明真实 Kit 的 request/broadcast 链路、权限交互、会话恢复和 Web 行为能够协同工作。现有架构文档与实现也需要以实际装配链路为准，避免协议漂移和只在 mock 环境中通过的测试。

## 目标

- 建立真实加载 Agent Chat Kit 全部目标插件的跨插件装配回归测试。
- 覆盖从 conversation/chat 到 agent/model-service 再回到 Chat 的 request、broadcast、trace/status/delta 完整链路。
- 用测试和文档固化发送、工具调用、审批、拒绝、取消、错误、恢复和插件重启的可观察行为。
- 使用 Web 浏览器完成关键用户路径验收；本 Task 只增加测试和文档，不新增产品行为。

## 范围

- Agent Chat Kit 的真实 manifest/装配加载、插件依赖和跨插件消息测试。
- Agent、Chat、Model Service 事件/请求协议的组合测试，包括事件顺序、错误和终态。
- 新建会话、发送消息、工具调用与审批、拒绝、停止、切换会话、恢复和插件重启的 Web 浏览器验收脚本或测试记录。
- 更新 Agent/Model Service 事件协议与装配说明，使其与当前实现和前置协议 Task 一致。

### 链路与验收顺序

1. Chat/Panel 以定向 request 向 Agent 发送消息；Agent 以定向 request 调用 Model Service。
2. Agent 将模型、工具和审批结果归并为 trace/status/delta，并以 broadcast 发送给 Chat；Chat 按关联键和序列重建 Transcript。
3. 工具触发审批时，Agent broadcast waiting/asked；Chat 展示并以定向 request 返回批准或拒绝；Agent 再 broadcast resolved 和 Item/Turn 终态。
4. Stop、错误或插件重启时验证活动请求终止、晚到事件被忽略、会话数据可恢复，随后通过 Web 切换会话确认状态一致。

## 非目标

- 不新增 Agent、Chat、Model Service 或 Framework 的产品行为、能力或安全边界。
- 不在本 Task 中实现真正 Provider streaming、取消机制、runtime 存储迁移或工具安全修复；这些由独立 Task 负责。
- 不替代目标插件自身的单元测试、类型检查和构建测试。
- 不引入 Electron、桌面宿主、原生窗口或桌面 IPC 假设。
- 不发布、合并或修改 Kit 的产品功能，只产出测试、验收和文档。

## 验收标准

- 测试真实加载 Agent Chat Kit 的全部目标插件，并验证依赖、manifest 和消息通道均来自实际装配，而非仅使用孤立 mock。
- 自动化测试覆盖完整链路：`conversation → chat → agent → model-service → trace/status/delta broadcast → chat`，并断言触发方、接收方、request/broadcast 类型和顺序。
- 覆盖新建会话、发送消息、正常完成、工具调用、权限请求、批准、拒绝、超时、错误、停止、会话恢复和重复/晚到事件；每条用例都有可观察断言。
- 覆盖 Agent/Chat Turn/Item 关联键、tagged union、started/delta/completed 生命周期、单调序列和审批 resolved 终态；协议不一致时测试失败而不是静默降级。
- Web 浏览器验收确认：新会话可用、内容按当前实现的输出机制显示、权限审批与拒绝可用、停止生效、会话切换不串数据、插件重启后历史可恢复且旧实例不再广播。
- 更新 Agent/Model Service/Kit 装配相关架构文档，内容包括插件职责、消息顺序、错误/终态和测试边界；文档与测试中的实际协议一致。
- 运行目标 Kit 的装配测试、目标插件聚焦测试、类型检查/构建和 Web 浏览器验收均通过；不因本 Task 引入新的产品行为。
- 运行 `node scripts/task-status.mjs check 2026-08-21-agent-kit-assembly` 通过。

## 约束

- 本 Task 类型为 `test`，代码变更仅限测试夹具、测试辅助和必要的测试配置；行为修复必须转入对应的 Feature/Bug/Refactor Task。
- 文档默认使用中文，并明确 request/broadcast 的触发方、接收方和顺序。
- 浏览器验收使用唯一支持的 Web 宿主；不得加入 Electron 或桌面生命周期假设。
- 测试应使用真实 Kit 装配边界，mock 仅用于隔离不可控外部 Provider，并不得替代插件间协议断言。
- 依赖前置事件协议、streaming/cancellation 和 runtime storage Task 的行为时，测试应记录所需前置条件；不得为使测试通过而改变生产行为。

## 需求变更

- 原始审查中的 Kit assembly 回归、文档同步和 Web 浏览器验收合并为本独立 Test Task。
- 明确本 Task 只做测试与文档，不新增行为；发现生产缺陷时记录证据并转入对应 Task。
