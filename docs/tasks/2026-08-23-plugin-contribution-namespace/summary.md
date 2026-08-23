# 2026-08-23-plugin-contribution-namespace 实现总结

## 最终结论

已明确自定义 Plugin contribution 的消费者命名空间规则，消除“顶层键开放扩展”等同于可使用任意功能名的歧义。本次只补充既有通用规则，不涉及 Agent Tool Provider、Todo 或其他尚未确认的协议。

## 需求完成情况

- Plugin 运行时模型已规定自定义 contribution 顶层键必须使用消费者插件的 `package.json.name`。
- Plugin/Kit 开发指南已补充正确结构、正反示例和消费者生命周期职责。
- 两份文档均明确区分消费者命名空间、来源 owner 和 Framework 校验边界。
- 未修改 Framework、Kit、Plugin 代码或测试。

## 主要改动

- 在 Plugin 运行时模型中定义抽象结构 `contribute.<consumerPluginName>.<contributionType>`。
- 说明 scoped package name 是完整 JSON key，不产生额外嵌套层级。
- 说明 Framework 对未知 contribution 只校验 JSON-safe，消费者负责协议内容校验。
- 在开发指南中增加 `settings`、`chat` 正例以及功能名直接占用顶层的反例。
- 明确重复 attach 必须幂等，detach 必须按来源 owner 清理。

## 关键决定

- `panel`、`menu` 和 `message` 是 Framework 保留贡献点，不适用自定义消费者命名空间规则。
- `lifecycle.attach(pluginName, contribute)` 中的 `pluginName` 表示贡献来源 owner，不是消费者插件名。
- 当前只通过正式文档约束命名；Framework parser 不新增消费者存在性或协议类型校验。

## 验证结果

- `git diff --check`：通过。
- 两份目标文档共 12 个 JSON 代码块均可被 `JSON.parse` 解析。
- 已检索确认目标文档未出现 `agentTools`、`agent.tools`、Todo 或 Tool Provider 内容。
- 相对本地 `main` 的正式文档差异仅包含两份目标文档。

## 影响与风险

- 该规则目前是跨 Plugin 文档协议，不是 manifest parser 的强制校验；违规 manifest 仍可能被 Framework 接受，但消费者应忽略或拒绝非法贡献。
- 后续若实现 Agent Tool Provider，应在独立需求中基于本规则定义消费者命名空间内部协议。

## 偏差与遗留

- 无功能代码变更，因此未运行 Framework、Kit 或浏览器测试。
- 未新增 Agent Tool Provider 协议文档；该内容明确留待对应需求。
- 未 push、未创建 PR。

## 后续关注

- 新增自定义 contribution 时，评审应检查顶层 key 是否等于真实消费者插件名。
- 如果未来需要加载期强制校验，应另行设计能够识别消费者集合的校验阶段。

## 相关正式文档

- [Plugin 运行时模型](../../architecture/plugin-runtime-model.md)
- [Plugin/Kit 开发指南](../../guides/developing-plugins-and-kits.md)
