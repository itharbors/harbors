# TraceWeave 会话分类设计

## 背景

TraceWeave 当前递归扫描 `sessions` 与 `archived_sessions` 中的全部 rollout，并将每个文件平铺为一个顶层 Run。本机验证得到 186 个 rollout，但其中只有 59 个对应 Codex 顶层会话；其余 112 个来自子 Agent，15 个来自 `exec`。因此 UI 的 “Runs 186” 与 Codex 任务列表不一致。

## 方案比较

1. **只做活跃/归档分组**：实现最小，但子 Agent 和 `exec` 仍冒充顶层会话，数量依然错误。
2. **按来源拆成会话、子 Agent、CLI、归档四组**：保留全部底层记录，但左侧导航暴露实现细节，且子 Agent 已经在父会话的 Execute 证据中出现。
3. **过滤顶层会话，再按活跃/归档分组（采用）**：左侧与 Codex 任务语义一致，子 Agent 仍保留在父会话的编排证据里。

## 数据边界

- `payload.source` 为 `exec` 的 rollout 不进入顶层会话列表。
- `payload.source.subagent` 存在的 rollout 不进入顶层会话列表。
- 其他来源以及缺少 `source` 的旧格式 rollout 继续作为顶层会话，以兼容历史数据和测试 fixture。
- `sessions` 下的顶层会话归为 Active，`archived_sessions` 下的顶层会话归为 Archived。
- `payload.id` 是 rollout 自身 ID；`payload.session_id` 可能是子 Agent 的父会话 ID，发现器优先使用 `payload.id`。
- 过滤只影响左侧顶层列表，不改变父会话内的 Skill、Tool 与 Sub-agent 证据解析。

## 界面

- 左侧标题由 `Runs` 改为 `Sessions`，总数只统计顶层会话。
- Active 分组默认展开，显示数量。
- Archived 分组默认折叠，显示数量；用户可通过按钮展开或收起。
- 当前选中的归档会话始终保持所在分组可见。
- 分组按钮提供 `aria-expanded` 与明确名称，键盘可操作。
- 延续现有 TraceWeave 深色观测台视觉；分组标题使用安静的分隔线与等宽数据标签，不引入新装饰。

## 错误与兼容

- 缺少、损坏或未知 `source` 不隐藏 rollout，继续按目录归类。
- 空 rollout 继续作为 failed 顶层会话显示，因为无法证明它属于子 Agent 或 `exec`。
- 归档为空时仍显示 Archived 计数 0，结构保持稳定。

## 测试与验收

1. 发现器 fixture 同时包含顶层、子 Agent 与 `exec` rollout，结果只返回顶层会话。
2. 同时存在 `id` 与父级 `session_id` 时，使用 `id` 作为自身会话标识。
3. RunRail 将活跃与归档会话分组，并默认折叠归档。
4. 展开归档后可选择归档会话；选中状态与无障碍属性正确。
5. 真实 Codex Home 聚合验证输出顶层总数、Active 与 Archived，且不修改源文件。
6. TraceWeave 聚焦测试、构建、插件检查与 Kit check 通过。

## 非目标

- 不把子 Agent 提升为新的一级导航类型。
- 不改变 Codex 文件、归档状态或 session index。
- 不增加搜索、分页或虚拟列表。
