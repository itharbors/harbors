# Agent 基础系统指令与 Skill 渐进披露实现总结

## 最终结论

Harness Agent 已拥有稳定、版本化且不可编辑的 `harbors-agent-core/v1`，并按 Core、用户自定义、Workspace 指令、Skill 目录的固定顺序组合每个 Turn 的 system instructions。Agent Settings、Trace 审计、Skill 渐进披露、真实 Provider 行为评测、独立代码审查和 Web 浏览器验收均已完成，没有阻止合入的问题。

## 需求完成情况

- 无 `AGENTS.md` 或自定义指令时仍注入非空 Core；compaction 等非 Turn 请求不继承工具执行规则。
- 四段 system 使用 UTF-8 长度前缀 framing，Custom、Workspace、Skill catalog 和总量均按固定字节预算 fail closed。
- Skill 目录包含校验后的 name、description 与脱敏路径；同名 winner、裁剪、省略和 shadowing 均确定且可审计。
- `load_skill` 只读取本 Turn 已发现 winner，拒绝路径逃逸、根目录替换和超过 12,000 UTF-8 bytes 的正文。
- Skill 加载因缺失、损坏或超限失败后，Core 明确禁止用通用文件工具绕过受控加载读取该 Skill 正文。
- Agent Settings 支持最多 8 KiB 的全局自定义指令保存、重置和来源摘要；Core 正文不可编辑，敏感正文与绝对路径不进入摘要或 Trace。
- 每个 request/context 与 turn/end 记录 prompt version、组合 digest、脱敏来源和已成功加载的 Skill 名称。

## 主要改动

- `kits/harness/plugins/agent/main/**`：增加 Core、四段 composer、Workspace/Skill discovery、Settings 协议、Trace 元数据和失败 Skill 防绕过规则。
- `kits/harness/plugins/agent/panel.settings/**`：增加自定义指令编辑、来源摘要、UTF-8 byte counter、保存/重置反馈和窄视口适配。
- `kits/harness/plugins/agent/tests/**`：增加真实 Vault eval runner、固定 fixture、公开安全 schema、资源恢复/关闭和工具语义级 bypass 分类。
- Agent 与 Conversation 合流时保留 archive file operations、instruction providers 与既有消息链，没有修改 Model Service 或 Framework 产品行为。

## 关键决定

- Core 只保留跨工具和跨任务的稳定行为规则，具体工具细节继续放在工具描述或 Skill 中。
- Skill metadata 初始注入、正文按需读取；加载失败不能通过 raw file tools 绕过，但无关普通工作区操作仍可安全继续。
- eval runner 通过 Host Vault 给 Model Service 绑定受限 capability；runner 不直接读取、复制或输出 credential/profile 内容。
- bypass detector 只在进程内读取工具参数，并按 read、grep、list_files、glob、bash 的实际路径/搜索根语义分类；公开 JSON 删除参数、路径和内部分类字段。

## 验证结果

- `pnpm --dir kits/harness run test:kit`：290 unit、2 runtime plugin、10 assembly 全部通过。
- `pnpm run kits:check harness`、Agent Plugin check、Harness build、runner typecheck、`git diff --check`：通过。
- 独立 code review 关闭：不同功能合流、并行结果顺序抖动、Vault 未绑定、缺少 recover、close 失败假阳性、失败 Skill raw-file 绕过、路径误报/漏报及 glob brace/unknown 语法。
- 隔离 Web Host 的真实 Chromium 验收通过：Core/来源摘要、72-byte Unicode Custom 保存、reload 持久化、reset、focus-visible，375px Host 中 Agent iframe 为 186/186px 且按钮完整无裁切。
- 最终真实模型评测绑定 commit `6587a1a8370d16397f006cb9d75025fb0e594635`，Provider 配置来源为 Model Service、模型为 `alwaysday1`，4/4 完成且 `blocked=null`：显式/隐式均为 `load_skill → read`，unmatched 无 Skill 调用，oversized 只尝试 `load_skill` 后安全停止。
- 相比 Workspace-only baseline，candidate 每例增加 2,525 input tokens；显式/隐式分别减少 109/624 output tokens，oversized 减少 2,162 output tokens，并消除了失败后的目录与文件绕过探索。

## 影响与风险

- `blocking`：无。
- `non_blocking`：按用户最终指示，live eval 使用正常环境的既有 Model Service/Vault，而不是重新录入独立 data root 凭据；baseline/candidate 会话仍写入独立 `runner-baseline` / `runner-candidate` 子根，凭据未被读取或投影。
- `non_blocking`：正常数据中存在一条既有 `ITEM_AFTER_COMPLETED` session 日志，Kit 初始化会输出列表告警；eval 自有 adapter 使用独立子根，4/4 结果不受影响。
- `non_blocking`：assembly teardown 偶发在临时目录删除后异步读取 lock 的 stderr，但测试最终通过。
- `decision_candidates`：无。

## 偏差与遗留

真实评测的数据根隔离方式由“全新独立 application data root”调整为用户明确要求的正常环境 Vault + 独立 runner session 子根。除此之外没有已知需求偏差；未用 mock 冒充 Provider 行为。

## 后续关注

- 可单独建立维护任务审计并修复正常数据中的既有损坏 session 日志；本 Task 不自动改写用户历史记录。
- Core 增加了稳定输入成本；后续模型或上下文预算变化时应继续使用同一 fixture 观察 input/output token 与行为差异。

## 决策闭环收口

### Decision Delta

- `Task-only`：Core version、四段 framing、Skill catalog/load 预算、Trace 字段和 eval schema 限定在 Harness Agent Plugin。
- `ADR`：无新增或修订。
- `architecture`：没有改变 Web-only Host、Plugin 消息交互、Model Service 或 Vault 的事实所有权。
- `guide`：无需要推广为仓库通用规则的增量。
- `candidate`：无。

### 正式落点

- 需求、Codex 固定 revision、协议、预算、失败语义和验证规则保留在本 Task 的 `task.md`、`.work/**` 与 `summary.md`。
- 产品实现和测试保留在 `kits/harness/plugins/agent/**`；未修改 Framework、Settings 容器或 Model Service 产品代码。

### 反向检索验证

- 查询“harbors-agent-core/v1”“Agent 指令”“Skill 渐进披露”“prompt-eval”可命中本 Task 与 Agent Plugin 实现。
- 未发现需要更新的既有 ADR、architecture 或 guide，也没有待批准的长期决策候选。

## 相关正式文档

- [Task 需求](task.md)
- [Task 状态](status.json)
