# Agent Runtime 存储路径与会话写入收敛

Task ID: `2026-08-21-agent-runtime-storage`
Type: `refactor`

## 背景与问题

Agent Plugin 当前部分会话存储逻辑自行读取环境变量或家目录，未统一使用宿主已经授予 Plugin 的运行时数据目录。现有写入队列以全局顺序为边界，慢会话会阻塞其他会话；会话删除、跨实例写入和 JSONL 损坏处理也缺少一致的并发与错误契约。

Framework 的 `PluginRuntime` 已提供 `ctx.paths.data`。本 Task 只让 Agent Plugin 使用这项已有能力，不增加新的 Context 字段、路径注入机制或 Plugin 间消息协议。

## 目标

- Agent Plugin 加载时使用现有 `ctx.paths.data`，将新会话数据写入该 Plugin 的私有数据目录。
- 采用版本化的 `storage-v1/sessions/<session-uuid>.jsonl` 布局，并移除环境变量、`homedir()` 和固定家目录路径回退。
- 保证同一会话的追加、修复和删除严格经过独立串行队列，同时允许不同会话并行。
- 保留跨 Agent 实例的文件锁，避免多进程写入互相覆盖。
- 对 JSONL 尾部未完成记录提供可验证的修复；对中间记录损坏返回稳定错误，不能静默隐藏会话。
- 删除时在同一会话队列和文件锁内将会话原子移动到 data 目录下的 `.harbors-trash`，并在 `storage-v1/sessions/<id>.deleted` 创建持久 tombstone；活动会话删除直接拒绝。

## 范围

- `kits/agent-chat/plugins/agent/**` 中的 Plugin 加载、Adapter 存储路径和会话文件解析。
- 将 `ctx.paths.data` 作为 Adapter 的显式内部构造参数；校验缺失或非法路径并 fail closed。
- `storage-v1/sessions` 和 `.harbors-trash` 目录的初始化、UUID 会话路径解析、持久 `<id>.deleted` tombstone、同会话队列及既有跨实例锁的组合。
- 会话追加、尾部 JSONL 修复、中间损坏报错、删除到 trash 以及删除与写入竞态处理。
- Agent Plugin 聚焦测试、类型检查/构建和本 Task 文档；不修改 Framework、通用 Kit 或其他 Plugin。

## 非目标

- 不修改 Framework 的 `PluginRuntime`、Context、路径协议或宿主生命周期；不新增第二套路径注入形态。
- 不读取、扫描、迁移或删除 `~/.harbors/pi-agent/sessions` 等旧家目录数据，也不恢复环境变量作为兼容回退；旧会话导入或只读兼容另立需求。
- 不在本阶段制定完整 trash 保留期限、容量上限、自动清理、恢复 API 或恢复 UI；本阶段只保证删除先进入可恢复的 trash，正常路径不做永久删除。
- 不实现 Plugin generation、unload/reload、listener/subscription 清理、旧 runtime 隔离或活动请求的完整取消链路。
- 不实现 Provider streaming、模型能力/ACL、工具 SSRF、workspace 安全或 Agent Turn/Item 事件协议。
- 不新增或改变 Plugin request/broadcast 消息；存储操作保持 Agent Plugin 现有内部调用边界。
- 不加入 Electron、桌面打包、原生窗口生命周期、托盘、更新器或桌面 IPC 假设。

## 验收标准

- Agent Plugin 的新会话、trace 和状态文件只出现在 `ctx.paths.data/storage-v1/sessions` 下；设置环境变量或在家目录准备旧文件都不会改变实际路径，也不会被读取。
- 缺少、非绝对或不可用的 runtime data path 会以稳定错误失败；非法会话 ID 不会创建或访问目录外文件。
- 目录布局固定为：

  ```text
  <ctx.paths.data>/storage-v1/
  ├── sessions/<session-uuid>.jsonl
  ├── sessions/<session-uuid>.deleted
  └── .harbors-trash/<session-uuid>-<timestamp>-<random-uuid>.jsonl
  ```

- 同一会话的并发追加、尾部修复和删除严格串行，序列不重复、不倒退、不丢失；不同会话不会因共享全局队列而相互阻塞。
- 跨 Adapter/进程实例的写入仍经过既有文件锁；临时重写文件位于目标目录内，不能因跨文件系统 rename 造成隐式失败。
- 最后一条不完整 JSONL 记录可按明确规则修复；中间记录损坏、权限错误、锁超时等情况返回稳定错误，列表不能静默过滤损坏会话。
- 活动会话删除返回稳定的 `CONVERSATION_ACTIVE` 类错误且不触发隐式取消；非活动会话删除在会话队列和文件锁内先将源 JSONL 原子 rename 到 `.harbors-trash`，再以独占方式创建持久 `sessions/<id>.deleted` tombstone。删除成功后源文件不存在，后续实例通过 tombstone 返回 `SESSION_DELETED`，不会重新创建旧会话；tombstone 创建失败时删除操作回滚 trash 并返回稳定错误。
- Agent Plugin 相关聚焦测试覆盖路径注入、环境变量隔离、会话队列、跨实例锁、JSONL 损坏、删除竞态和活动会话拒绝；类型检查/构建通过。
- `node scripts/task-status.mjs check 2026-08-21-agent-runtime-storage` 和 `git diff --check` 通过。

## 约束

- `ctx.paths.data` 是唯一合法的数据根来源；它已由宿主按 Plugin owner 隔离，Agent 不得自行推导其他宿主路径。
- Adapter 内部可以接收普通的 `storageRoot` 构造参数，但不得把它扩展成新的 Runtime 注入或注册协议。
- 写入队列以 session ID 为隔离单元；队列错误必须可观察，不能静默丢弃后续写入；队列状态在无任务后释放，避免无界增长。
- 同会话的 append、repair、delete 必须共享同一并发边界；删除使用受验证的会话路径，不能使用不可逆递归删除作为正常路径。
- 对 symlink、路径越界、权限错误和数据损坏采取 fail-closed 行为，不以 home、当前工作目录或环境变量兜底。
- 变更严格位于 Agent Plugin 目录（以及本 Task 文档）；如果实现需要 Framework 或其他边界改动，停止该部分并另建独立 Task。

## 需求变更

- 原始审查将运行时路径、按会话写队列、trash 策略和 Plugin unload/reload 生命周期清理合并为一个较大范围。
- 经过设计确认后，本 Task 收敛为 Agent Plugin 的 runtime data path、`storage-v1` 会话存储、按会话串行写入、既有跨实例锁和安全删除到 trash；Plugin 生命周期清理拆为后续需求。
- 现有 `ctx.paths.data` 已是正式 Plugin Runtime 能力，因此不新增 Context 字段、第二种注入形式或新的 request/broadcast 协议。
- 旧家目录会话不做自动发现、迁移或删除；完整 trash 保留/恢复策略也不在本阶段承诺，待后续需求明确。
