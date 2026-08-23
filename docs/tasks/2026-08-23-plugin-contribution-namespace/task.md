# 2026-08-23-plugin-contribution-namespace

Task ID: `2026-08-23-plugin-contribution-namespace`
Type: `docs`

## 背景与问题

明确自定义 Plugin contribution 的消费者命名空间规则，消除“顶层键开放扩展”可使用任意功能名的歧义。

## 目标

- 在 Plugin 运行时模型中规定自定义 contribution 顶层键必须使用消费者插件名。
- 在 Plugin/Kit 开发指南中提供正确、错误示例及消费者校验与清理要求。
- 明确 Framework 当前只校验未知 contribution 为 JSON-safe，不强制验证消费者命名空间。

## 范围

- `docs/architecture/plugin-runtime-model.md` 中的贡献点所有权规则。
- `docs/guides/developing-plugins-and-kits.md` 中的自定义贡献开发说明。
- 本 Task 的 `task.md`、`status.json` 和 `summary.md`。

## 非目标

- 不设计或实现 Agent Tool Provider、`contribute.agent.tools` 或 Todo 协议。
- 不修改 Framework、Kit、Plugin 代码或测试。
- 不新增 ADR、协议文档或文档导航入口。

## 验收标准

- `docs/architecture/plugin-runtime-model.md` 明确自定义 contribution 的顶层键是消费者插件 `package.json.name`。
- `docs/guides/developing-plugins-and-kits.md` 给出 `settings`、`chat` 等正确示例和功能名直接作为顶层键的错误示例。
- 两份文档一致区分贡献来源方 `pluginName`、消费方命名空间和 owner 清理职责。
- 文档不预设尚未确认的 Agent Tool Provider 需求。
- 聚焦文档校验通过，Task 完成 ready gate，源 worktree 保持 clean。

## 约束

- 文档使用中文。
- 变更仅限本 Task 三份正式文件及上述两份目标文档；`.work/` 记录不提交。
- 提交标题使用 `[Docs] 明确自定义插件贡献命名空间`，末尾不加句号。
- 完成本地提交后按用户授权，以 squash 方式整合回本地 `main`；不 push、不创建 PR。

## 需求变更

- 用户最初讨论了 Agent Tool Provider 文档，随后明确要求当前 Task 排除该需求，只补现有通用文档缺口。
- 用户已明确授权创建隔离 worktree，并在完成后以 squash 方式整合回本地 `main`。
