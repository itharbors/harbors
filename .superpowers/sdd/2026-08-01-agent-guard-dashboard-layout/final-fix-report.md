# Agent Guard 仪表盘最终修复报告

实现提交：`6d199cf64d61cd1a5a5f4c92a80bb0a11a60f7d8`

## Important 1：mutation 失败保留 Dashboard 与重试上下文

- 对应发现：`runMutation` 失败时使用整页 `renderState`，导致活动 Tab、焦点和策略草稿丢失，且相同 snapshot 签名可能无法恢复 Dashboard。
- RED 证据：聚焦运行 `keeps a failed policy mutation inline...`，退出码 1；断言期望标题仍为“本机智能体流量”，实际为“操作失败”。
- 实现：mutation 开始前捕获 UI 状态；失败时保存 `mutationError`，使用 `latestSnapshot` 重绘原 Dashboard，并以 `role="alert"` 内联展示错误；原策略输入、焦点和 Tab 随重绘恢复，原操作可直接再次提交。
- GREEN 证据：该失败/重试测试通过；聚焦套件 31/31 通过，全量 Agent Guard 套件 117/117 通过。
- 提交哈希：`6d199cf64d61cd1a5a5f4c92a80bb0a11a60f7d8`
- 剩余顾虑：无已知功能顾虑；测试覆盖策略更新首次失败、第二次成功的真实面板行为。

## Important 2：多 incident 使用唯一焦点键

- 对应发现：轮询重绘只按重复的 `data-action` 恢复焦点，多 incident 时会跳到列表中第一个同名操作。
- RED 证据：聚焦运行 `restores focus to the same incident action...`，退出码 1；期望 `incident-1`，实际焦点落到 `incident-2`。
- 实现：渲染状态同时捕获 `incidentId + action`；恢复时先按 action 收集候选，再按最近 incident 容器的 id 精确匹配。
- GREEN 证据：多 incident 轮询回归通过；聚焦套件 31/31、全量套件 117/117 通过。
- 提交哈希：`6d199cf64d61cd1a5a5f4c92a80bb0a11a60f7d8`
- 剩余顾虑：非 incident 控件继续使用原有唯一 action 键；其既有焦点测试仍通过。

## Important 3：历史结果绑定 domain/range query key

- 对应发现：切换 domain/range 后旧 `historyResult` 仍可在慢请求期间被 snapshot 轮询重绘到新选择下。
- RED 证据：聚焦运行 `does not render a previous history query...`，退出码 1；新 domain 请求 pending 且发生 snapshot poll 后，期望 loading 节点存在，实际为 `null`，旧网络图仍在。
- 实现：以 `domain:range` 作为选择 query key；历史响应记录其 key，选择与结果 key 不一致时立即重绘 loading，且 `createHistorySection` 拒绝展示不匹配结果；原有 `historyVersion` 继续丢弃过期响应。
- GREEN 证据：交错慢历史请求/snapshot 测试通过；聚焦套件 31/31、全量套件 117/117 通过。
- 提交哈希：`6d199cf64d61cd1a5a5f4c92a80bb0a11a60f7d8`
- 剩余顾虑：query key 有意绑定用户选择而非每次轮询的绝对 `from/to`，因此同一选择的 30 秒刷新期间仍保留已完成结果。

## Important 4：固定指标槽并区分未采集与实测零

- 对应发现：响应完全缺少某项 series/summary 时，对应趋势或摘要卡被省略。
- RED 证据：聚焦运行 `renders every fixed history metric as uncollected...`，退出码 1；空响应期望 2 个固定趋势 path，实际为 0。
- 实现：网络趋势固定生成 bytes-in/bytes-out 槽，模型趋势固定生成 input/output 槽；网络摘要固定 2 卡，模型摘要固定 5 卡。缺失 summary 显示“未采集 / 覆盖 0%”，空趋势 path 的 `data-values` 为空字符串，不合成零；实际 `value: 0` 仍走正常格式化显示 `0 B`。
- GREEN 证据：完全缺失指标测试和既有实测零测试分别通过；聚焦套件 31/31、全量套件 117/117 通过。
- 提交哈希：`6d199cf64d61cd1a5a5f4c92a80bb0a11a60f7d8`
- 剩余顾虑：完全没有任何 bucket 的指标使用空 path 表示整段缺失；可见摘要和 warning 明确说明未采集，不伪造 bucket 或零值。

## Important 5：按时间定位并只连接连续 bucket

- 对应发现：x 坐标按各 series 的数组索引/长度拉伸，且缺失整个 bucket 对象时仍跨空档连线。
- RED 证据：`positions unequal history coverage...` 退出码 1，第二点实际 x 为 `710.0`、期望共享时间轴上的 `360.0`；`breaks a history line...` 退出码 1，缺 bucket 时实际只有 1 个 `M`、期望 2 个断开的子路径。
- 实现：x 使用 `(point.start - result.from) / (result.to - result.from)` 映射到统一绘图区；仅当前一点非 null、前一点非 null 且 `previous.end === current.start` 时使用 `L`，否则开启新的 `M` 子路径。
- GREEN 证据： unequal-start 与 missing-bucket 两个测试均通过；聚焦套件 31/31、全量套件 117/117 通过。
- 提交哈希：`6d199cf64d61cd1a5a5f4c92a80bb0a11a60f7d8`
- 剩余顾虑：坐标会将协议范围外的异常时间戳夹到绘图区边界；正常响应仍由 contracts normalizer 校验。

## Minor 1：`data-values` 仅保留在历史 path

- 对应发现：实时 route `<dd>` 也附带历史 `data-values`，且每个 `metric()` 调用重复合并整份历史。
- RED 证据：聚焦运行 `merges all Agent history...`，退出码 1；实时 bytes-out `<dd>` 期望无 `data-values`，实际为 `"1536,0"`。
- 实现：`metric()` 仅保留实时 `data-metric` 标识，删除 history merge 与 `data-values` 写入；测试钩子改为只读取 `.history-chart path[data-metric]`。
- GREEN 证据：合并/零值/钩子回归通过；聚焦套件 31/31、全量套件 117/117 通过。
- 提交哈希：`6d199cf64d61cd1a5a5f4c92a80bb0a11a60f7d8`
- 剩余顾虑：无。

## Minor 2：空事件文案说明后台监控继续

- 对应发现：空事件只说明未记录异常，没有明确后台监控状态。
- RED 证据：聚焦运行 `states that background monitoring continues...`，退出码 1；实际文案不包含“后台监控仍在继续”。
- 实现：空事件文案改为“尚未记录到异常智能体流量，后台监控仍在继续。”
- GREEN 证据：空事件文案测试通过；聚焦套件 31/31、全量套件 117/117 通过。
- 提交哈希：`6d199cf64d61cd1a5a5f4c92a80bb0a11a60f7d8`
- 剩余顾虑：无。

## 最终验证

- 初始基线：聚焦套件 25/25 通过。
- RED：8 个定向回归运行均以预期行为差异失败。
- GREEN：`npx vitest run --root kits/agent-guard --config vitest.config.ts tests/panel-accessibility.test.ts plugins/agent-guard-center/tests/panel.test.ts`，2 个测试文件、31 个测试全部通过。
- 全量：`npm run test:agent-guard`，26 个测试文件、117 个测试全部通过。
- 静态检查：`git diff --check` 通过。
- 环境约束：未启动 Electron，未修改 collector、策略算法、事件规则、存储 schema 或 bridge 协议。

## 整体剩余顾虑

本次 dispatch 已完成自动化回归与全量测试；未在本次集中修复中重复执行此前分支的 Web 视觉手工验收。
