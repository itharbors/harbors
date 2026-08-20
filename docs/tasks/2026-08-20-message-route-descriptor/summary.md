# 2026-08-20-message-route-descriptor 实现总结

## 最终结论

已为 Message Plugin 增加 request/broadcast 对象路由描述符解析，并保留字符串及字符串数组兼容写法。对象路由的 methods 提取和非法输入处理包含在 77 项 Node 测试中且全部通过；`callers` 仍作为调用方白名单元数据存在，未在 Message Plugin 内另行复制授权逻辑。

## 需求完成情况

- request 和 broadcast 均支持包含 `methods` 的对象路由描述符。
- 旧字符串/字符串数组路由继续注册和分发。
- 空 methods、缺少 methods、空方法名和非字符串方法名会被跳过。
- attach/detach 注册生命周期保持不变。
- `callers` 未被误当成方法名或业务参数，权限边界仍交由消息层既有机制处理。

## 主要改动

- 在 Message Plugin 增加统一的 `routeMethods` 归一化逻辑。
- request/broadcast attach 都改用该逻辑提取 methods。
- 增加对象描述符、旧写法和非法路由的 request/broadcast 测试。

## 关键决定

- 兼容旧 manifest，避免所有 Plugin 同时迁移。
- 只负责描述符兼容解析，不在 Message Plugin 内重新实现 callers 授权；这样能保持消息注册/分发层的单一权限边界。

## 验证结果

- `pnpm exec tsx --test` 覆盖 message、agent、model-service、settings、model-catalog、transcript：77/77 通过，其中包含对象 request/broadcast 路由测试。
- `ce-plugin build/check` 对 settings、agent、model-service、chat、audio、mermaid 均 exit 0。
- Server 聚焦测试 118/119；唯一失败为本次未修改断言 `broadcasts enriched config change payloads...`。
- Server 全量 737/741，另外三个 integration session/kit 失败，均不在本次 diff；Client 聚焦 75/76、全量 285/286，唯一失败为本次未修改的 legacy Electron bridge bootstrap 测试。

## 影响与风险

- 新旧 manifest 两种写法并存，后续仍需维护归一化契约和文档。
- 本 Task 不证明 callers 在所有消息宿主路径都完成实际授权校验；若调用方白名单只被解析但未被消费，仍需由独立安全审查确认。
- Kit test 因隔离环境缺少 `yazl` 未通过，但不影响本 Plugin 的 77 项 Node 测试结果。

## 偏差与遗留

- 没有新增独立的 callers 授权实现，保持其为消息层元数据；是否需要更强的跨 Plugin 授权测试留待后续讨论。
- Server/Client 的范围外既有失败仍存在，未在本 Task 修复。

## 后续关注

- 检查 Framework 消息注册/分发实际消费 callers 的路径，并增加端到端拒绝未授权调用的测试。
- 后续新 Plugin 优先使用对象描述符，同时保留旧写法解析直到兼容窗口结束。

## 相关正式文档

- [Task 需求快照](./task.md)
