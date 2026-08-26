# Agent 基础系统指令与 Skill 渐进披露

Task ID: `2026-08-26-agent-system-instructions`
Type: `feature`

## 背景与问题

Harness Agent 当前会在每轮模型调用前读取工作区 `AGENTS.md`，并把结果作为 `system` 发送给 Model Service；没有工作区指令时，Turn 可能完全没有 system 内容。Agent 已提供 `list_skills` / `load_skill` 工具，但 `list_skills` 只返回 Skill 名称，模型既看不到描述，也没有稳定基础规则要求它在采取行动前判断、选择并完整加载适用 Skill。

这导致 Agent 的执行纪律依赖用户每次临时提醒，例如“执行前检查 Skill”，也缺少统一的修改前检查、权限边界、验证与完成声明规则。用户要求建立 Task，引入基础系统提示词，并明确参考最近开放源码的 Codex agent harness，而不是凭印象重新发明一套提示架构。

## 目标

1. 为 `purpose: turn` 的 Agent 模型请求提供精简、稳定、版本化的基础 system instructions，即使工作区没有 `AGENTS.md` 也始终存在。
2. 建立明确的指令分层：不可编辑的 Agent 基础规则、用户全局自定义指令、工作区 `AGENTS.md` 链和按需加载的 Skill 指令；当前用户消息继续保持独立 user role。
3. 让模型在任务行动前看到受预算约束的 Skill `name + description + path` 目录，显式点名或语义匹配时先完整读取对应 `SKILL.md`。
4. 在 Agent Settings 中提供用户自定义指令和生效来源可见性，但不允许覆盖基础安全、权限和项目边界。
5. 为每次 Turn 记录可审计的基础指令版本、组合摘要和已加载 Skill，不持久化完整敏感提示词。
6. 参考 Codex 的公开文档与开源 harness 实现，并在设计阶段固定具体源码 revision，形成可复核的差异分析。

## 范围

- `kits/harness/plugins/agent/main/**`：基础提示、指令组合、Skill 元数据发现、Settings 读写、Turn 请求注入和 Trace 元数据。
- `kits/harness/plugins/agent/panel.settings/**`：用户自定义指令编辑、重置、生效说明和只读来源摘要。
- `kits/harness/plugins/agent/package.json`：仅在 Agent 自有 Settings 请求契约需要同步时修改。
- Agent Plugin 针对性测试、提示行为 eval fixture、构建产物和本 Task 档案。
- 设计阶段对官方 Codex 文档和固定 commit 的 `openai/codex` 源码进行只读研究；不把外部源码复制进 Harbors。

## 非目标

- 不切换到 Codex SDK、Codex app-server 或替换 Harbors 自有 Agent loop。
- 不照抄 Codex 的完整系统提示词，也不以兼容 Codex 私有/托管行为为验收目标。
- 不修改 Model Service 的 Provider、模型选择、请求重试或消息协议；继续复用现有 `system` 字段。
- 不引入 project/session 级可编辑提示词；第一版只提供 Agent 全局自定义指令和既有工作区文件链。
- 不对所有工具调用实施“未加载 Skill 一律拒绝”的运行时硬门禁；第一版通过目录注入、基础规则、Trace 和代表性 eval 建立行为约束。
- 不把完整 system prompt、`AGENTS.md` 内容、用户自定义指令或 Skill 正文写入普通日志和 Trace。
- design work unit 不实施业务代码、不修改 `status.json`、不创建分支/worktree、不 push、不创建 PR；实现只允许在计划审查通过后的 implementation work unit 开始。

## 指令分层与组合规则

每次 `purpose: turn` 请求按稳定顺序组合：

1. **Agent Core**：随代码发布、带版本号、用户不可编辑；定义角色、指令优先级、Skill 使用、工具副作用、修改前检查、权限、验证、进度和完成声明。
2. **User Custom Instructions**：Agent Settings 中的全局偏好，属于宽泛用户约定；不得声明自己能覆盖 Core、工作区更具体规则或当前直接请求。
3. **Workspace Instructions**：复用并完善现有 `AGENTS.md` 发现链，从全局到项目根、再到 cwd，越具体越靠后；保留字节预算、去重和安全 framing。
4. **Available Skills Catalog**：只注入经过校验和预算裁剪的 `name`、`description`、`SKILL.md` 路径以及触发规则；Skill 被选择后，再通过工具完整加载正文。

当前用户消息和历史消息不拼接进 system 字符串，继续使用既有 role。非 Turn 用途（例如 compaction）使用各自最小 purpose prompt，不继承整套工具执行规则。

第一版采用以下确定性协议，避免把预算、覆盖关系或审计字段留给实现时临时决定：

- Core 版本固定为 `harbors-agent-core/v1`；Core 由 Agent Plugin 源码发布，Settings 只能显示版本，不能读取或编辑正文。
- 用户自定义指令使用全局配置键 `agent.instructions.custom`，UTF-8 正文最多 8 KiB；保存或重置后从下一次 Turn 起对新旧对话共同生效，不改写历史消息。
- Workspace 段继续使用 32 KiB 的渲染后 UTF-8 预算；发现顺序为用户全局、项目根到 cwd，按规范化内容去重，越具体越靠后。来源摘要只暴露 `~` 或仓库相对 display path，不暴露绝对家目录。
- Repo Skill roots 从项目根到 cwd 逐层扫描 `.agents/skills`，再纳入用户 `~/.agents/skills`；同名 Skill 采用“最具体 repo > 更宽 repo > user”的单一胜者规则，并产生非敏感 shadowing 诊断，因为当前 `load_skill(name)` 契约无法无歧义地同时加载同名 Skill。
- Skill 必须是包含可读 `SKILL.md` 的目录，frontmatter 必须给出合法的单行 `name` 和非空单行 `description`；`name` 最多 64 个字符且匹配 `^[a-z0-9]+(?:-[a-z0-9]+)*$`，规范化后的 description 与 display path 各最多 1,024 UTF-8 字节。目录 scope rank 固定为 repo=0、user=1；同名胜者按 `(scopeRank 升序, repoDepth 降序且 user=-1, displayPath UTF-8 字节序)` 选择，最终目录按 `(scopeRank, name UTF-8 字节序, displayPath UTF-8 字节序)` 排序，不使用 locale-sensitive compare。
- Skill 目录的 8 KiB 是包含固定 header、条目和固定宽度 status footer 的渲染后 UTF-8 预算。每条固定部分是 `- <name>: `、` (file: <displayPath>)\n`；description 最小配额为 32 字节，超长时取不拆 Unicode scalar 的最长 29 字节前缀并加 ASCII `...`。若所有条目的最小成本仍超限，从排序结果末尾依次省略；余量按排序顺序逐轮增加一个完整 Unicode scalar，始终为仍截断条目预留 `...`。footer 使用 8 位十进制计数，记录 total/included/omitted/truncated/errors/shadowed；计数溢出即准备失败。该算法及省略顺序不得依赖文件系统枚举顺序。
- `load_skill` 只能按本 Turn 已发现目录中的胜者名称读取；读取前重新校验真实路径仍位于已发现 Skill 根，正文超过 12,000 UTF-8 字节时返回明确超限错误，不返回截断正文。成功读取才计入 `loadedSkills`。
- 最终 system 不使用可被正文伪造的关闭 tag，而以固定顺序的 UTF-8 长度前缀 framing 序列化四段。每段 header 精确为 `@@harbors-section <name> <10 位零填充十进制正文 UTF-8 字节数>\n`，随后写入精确数量的正文 bytes；段名依次为 `agent_core`、`user_custom_instructions`、`workspace_instructions`、`available_skills`，动态段为空时仍保留 header 并写 `0000000000`，段间只增加固定 LF。正文中的任何 tag/header 字样都只是数据。长度在 LF 规范化后、拼接前计算；无法用 10 位表达或解析不完全消费四段即准备失败。组合后的 system 总上限为 64 KiB，Core 不裁剪；单段预算与 wrapper 开销必须保证正常组合不越界，越界作为可诊断请求准备错误处理，不静默丢 Core。
- `agent.instructions.custom` 的保存、读取和 Turn 组合必须共用同一个校验器：缺失/空字符串为合法禁用，字符串且不超过 8 KiB 为合法启用，非字符串、超限或读取失败均 fail closed，不进入 system。手写/既有坏配置不自动覆盖；Settings 编辑器可通过 Agent 自有定向 request 取回合法的用户自有正文，但来源/错误诊断与 Trace 只返回 `configured/applied/code` 等非敏感字段，坏值绝不返回，且不返回长度、异常文本或磁盘路径。保存先校验再写入并重读等值校验，重置删除后重读确认。
- Trace 只记录 `promptVersion`、最终组合文本的单个 `sha256:<hex>`、非敏感来源计数/相对 display path、目录裁剪诊断和 `loadedSkills` 名称。每个 `request/context` 记录发起该模型请求前的 Skill 快照，`turn/end` 记录本 Turn 最终集合；不记录各敏感段的独立 digest，避免把 Trace 做成正文猜测索引。

## Agent Core 最小行为契约

- 在采取非简单行动前判断是否存在适用 Skill；用户明确点名 Skill，或任务匹配 Skill description 时，必须在行动前完整加载对应 `SKILL.md`。
- 只加载相关 Skill，不为“检查过”而加载全部 Skill；无适用 Skill 时正常继续。
- 先读取和验证目标事实再修改；保留用户已有改动，不执行未授权的破坏性操作或跨范围副作用。
- 多步骤任务维护清晰计划并提供必要进度；简单问答不强制制造计划。
- 修改后按风险运行局部验证；把新增失败、既有失败、真实阻塞和未验证项分开报告。
- 不把“写完代码”“命令已启动”或“测试未跑”表述为任务完成；最终声明必须与验证证据一致。
- 工具级细节优先放在工具 description 或 Skill 中，Core 只保留跨工具、跨任务都成立的运行规则，避免重复和膨胀。

## Codex 参考基线

### 官方资料

- Open Source：`https://learn.chatgpt.com/docs/open-source`，确认 Codex CLI、SDK、App Server 和 Skills 的开源边界，且 `openai/codex` 是 Codex 开源开发主仓库。
- Open agent harness：`https://learn.chatgpt.com/blog/codex-as-a-platform`，参考 harness 对上下文、工具、sandbox、approval、事件和跨 Turn 状态的职责划分。
- AGENTS.md：`https://learn.chatgpt.com/docs/agent-configuration/agents-md`，参考运行前发现、全局到 cwd 的分层顺序、override 文件和 32 KiB 默认预算。
- Skills：`https://learn.chatgpt.com/docs/build-skills`，参考先暴露 `name + description + path`、选中后读取完整 `SKILL.md` 的渐进披露，以及显式/隐式触发方式和上下文预算。
- Model guidance：`https://developers.openai.com/api/docs/guides/latest-model`，参考稳定前缀、精简提示、工具细节下沉和代表性 eval 的优化原则。

### 开源源码研究要求

设计阶段必须：

1. 从官方 Open Source 页面进入 `openai/codex`，记录研究日期、完整 commit SHA 和所用 license 信息，不以移动的 `main` 分支作为长期证据。
2. 定位并引用该 revision 中与基础 instructions、项目文档发现、Skill metadata/加载、工具策略、sandbox/approval、prompt 组合或 Trace 相关的实际源码路径和测试。
3. 输出“Codex 行为 / Harbors 现状 / 采用 / 调整 / 不采用 / 理由”对照表；只采用与 Harbors Web-only、Plugin 和 Model Service 边界兼容的机制。
4. 不复制来源不清或可能包含产品私有策略的提示文本；实现采用 Harbors 自己的精简行为契约，并保留许可证归属要求。

### 已固定的官方源码 revision

- 研究日期：2026-08-26。
- 仓库：`https://github.com/openai/codex`，由官方 Open Source 页面标注为 Codex 开源开发主仓库。
- 完整 commit：`21c58c90f2298587c6519e077d0692ce4c563d37`；后续审查只使用带该 SHA 的 GitHub permalink，不使用移动的 `main` 链接。
- License：仓库根 `LICENSE` 为 Apache License 2.0。当前方案只研究机制和测试方法，不复制 Codex 提示词或源码；若实现阶段改变为复制或改写可识别源码，必须保留适用版权/许可证通知并由 review 明确检查。

固定 revision 的主要证据（链接、符号和行定位均固定到完整 SHA）：

| 机制 | 固定 permalink 与符号/行 | 本 Task 的采用边界 |
| --- | --- | --- |
| 项目指令发现 | [`load_project_instructions`、`read_agents_md`、`agents_md_paths`, L55-L245](https://github.com/openai/codex/blob/21c58c90f2298587c6519e077d0692ce4c563d37/codex-rs/core/src/agents_md.rs#L55-L245) | 采用 root→cwd 与预算思想；不新增 override 文件名 |
| base/user 上下文分层 | [`BaseInstructionsFragment`, L5-L12](https://github.com/openai/codex/blob/21c58c90f2298587c6519e077d0692ce4c563d37/codex-rs/core/src/context/base_instructions.rs#L5-L12)、[`UserInstructions`, L5-L25](https://github.com/openai/codex/blob/21c58c90f2298587c6519e077d0692ce4c563d37/codex-rs/core/src/context/user_instructions.rs#L5-L25)、[`build_responses_request`, L881-L948](https://github.com/openai/codex/blob/21c58c90f2298587c6519e077d0692ce4c563d37/codex-rs/core/src/client.rs#L881-L948) | Harbors 保留单一 Model Service `system`，但在 Agent 内确定性分段 |
| Skill frontmatter | [`parse_skill_frontmatter_metadata`, L44-L92](https://github.com/openai/codex/blob/21c58c90f2298587c6519e077d0692ce4c563d37/codex-rs/skills/src/parser.rs#L44-L92) | 采用 name/description 校验，不复制解析源码 |
| Skill 目录与预算 | [`render_available_skills_body`, L81-L119](https://github.com/openai/codex/blob/21c58c90f2298587c6519e077d0692ce4c563d37/codex-rs/ext/skills/src/catalog_prompt.rs#L81-L119)、[`skill_metadata_budget`, L127-L153](https://github.com/openai/codex/blob/21c58c90f2298587c6519e077d0692ce4c563d37/codex-rs/ext/skills/src/render.rs#L127-L153)、[`render_available_skills`, L492-L542](https://github.com/openai/codex/blob/21c58c90f2298587c6519e077d0692ce4c563d37/codex-rs/ext/skills/src/render.rs#L492-L542) | 采用 metadata-first 与有界目录；Harbors 使用上述固定字节算法 |
| Skill 按需读取与 invocation | [`ReadTool`, L53-L119](https://github.com/openai/codex/blob/21c58c90f2298587c6519e077d0692ce4c563d37/codex-rs/ext/skills/src/tools/read.rs#L53-L119)、[`emit_explicit_skill_invocations` / `maybe_emit_implicit_skill_invocation`, L37-L121](https://github.com/openai/codex/blob/21c58c90f2298587c6519e077d0692ce4c563d37/codex-rs/core/src/skills.rs#L37-L121) | Harbors 继续 `load_skill(name)`，只把完整成功读取计入 Trace |
| Analytics 路径规范化 | [`skill_id_for_local_skill` / `normalize_path_for_skill_id`, L3557-L3596](https://github.com/openai/codex/blob/21c58c90f2298587c6519e077d0692ce4c563d37/codex-rs/analytics/src/reducer.rs#L3557-L3596)、[repo/user/admin 测试, L1065-L1119](https://github.com/openai/codex/blob/21c58c90f2298587c6519e077d0692ce4c563d37/codex-rs/analytics/src/analytics_client_tests.rs#L1065-L1119) | 上游按 scope 规范化：repo 通常相对，user/admin 仍为上游绝对路径；Harbors 采用更严格规则，任何 scope 都不写绝对路径 |
| License | [根 `LICENSE`, L1-L202](https://github.com/openai/codex/blob/21c58c90f2298587c6519e077d0692ce4c563d37/LICENSE#L1-L202) | Apache-2.0；本 Task 只研究机制，不复制源码/提示文本 |

### 采用差异表

| Codex 行为 | Harbors 现状 | 处置 | 理由 |
| --- | --- | --- | --- |
| Base instructions 与 contextual developer/user fragments 分层进入请求 | 只有 Workspace 文本直接写入 Model Service `system` | 调整采用：保持单一 `system` 字段，但由 Agent Plugin 稳定组合 Core、Custom、Workspace、Skills | Model Service 协议不在本 Task 范围，单字段可实现同等的稳定边界和顺序测试 |
| 从项目根到 cwd 发现 `AGENTS.override.md`/`AGENTS.md`，默认 32 KiB | 已有 `AGENTS.md` 根到 cwd、用户全局、32 KiB、去重，但无 override | 部分采用：保留现有文件名和去重策略，不新增 override；补来源摘要和组合协议 | override 是新产品能力，不是本 Task 必需；避免扩大第一版范围 |
| Skill 初始上下文包含 name、description、path/locator，按上下文预算缩短/省略并告警 | `list_skills` 只返回文件夹名，Turn 初始上下文无 Skill 目录 | 采用并调整：固定 8 KiB UTF-8 预算，先缩描述再省略，记录诊断 | Harbors 没有 Codex tokenizer/多 authority provider；固定字节预算可确定性测试 |
| 多 scope Skill 可保留同名条目并以 locator 区分 | `load_skill` 只有 name 参数 | 不直接采用：最具体同名 Skill 胜出并报告 shadowing | 不修改工具调用协议即可保持无歧义和向后兼容 |
| Skill provider 支持分页读取与多 authority package | 本地 `load_skill` 一次返回字符串并受 12,000 字符 `cap` 截断 | 调整采用：仅允许已发现本地文件，超过 12,000 UTF-8 字节明确失败，不把截断结果伪装成完整 Skill | 第一版不引入 provider/分页协议，同时满足“完整读取或明确失败” |
| Sandbox、approval、tool schema 分属 harness 强制边界 | Harbors 已有 Plugin 自有 permission loop 和工具 schema | 不迁移：Core 只说明行为，不替代现有强制机制 | 保持 Web-only Plugin/Model Service 边界，避免提示词承担安全执行职责 |
| Codex analytics 记录 Skill invocation，并按 scope 规范化路径：repo 可转为相对路径，user/admin 在上游测试中仍保留绝对路径 | Trace 有 `request/context`，未记录 prompt 版本/digest/Skill | 调整采用：Trace 记录版本、单一组合 digest、仓库相对或 `~` display path 与成功加载名称，绝不记录绝对路径 | Harbors 的隐私边界比上游更严格；不能把上游行为误写为通用脱敏 |
| Codex runtime 对不同请求/compaction 有独立构造路径 | Harbors Turn 与 compaction 已用不同 `purpose`，compaction 无 system | 采用：仅 `purpose: turn` 注入完整组合，compaction 保持最小提示 | 防止工具执行规则污染非 Turn 请求，不扩展不存在的标题生成路径 |

## 验收标准

1. 无 `AGENTS.md`、无用户自定义指令时，Turn 请求仍带非空、版本化的 Agent Core system instructions。
2. 有用户自定义指令和多层 `AGENTS.md` 时，组合顺序、优先级说明、去重、长度前缀 framing 和总字节预算确定且有单元测试；跨 Custom/Workspace/Skill 段伪造 header、关闭 tag 和多字节边界的恶意样本不能改变四段边界；更具体工作区规则不会被宽泛自定义偏好覆盖。
3. Skill 初始目录至少包含合法 `name`、`description` 和来源路径；目录有明确预算，超限时先裁剪描述并产生可诊断告警，不静默伪装为完整目录。
4. 用户显式点名 Skill 或代表性任务匹配 description 时，Agent 在相关行动前完整调用 `load_skill`；无匹配任务不会加载所有 Skill。通过确定性组合测试和固定模型/fixture 的小型行为 eval 共同验证；模型不稳定结果只作为行为证据，不替代确定性门禁。
5. `load_skill` 只读取允许的已发现 `SKILL.md`，完整读取结果受单次工具输出上限保护；缺失、损坏或超限 Skill 返回明确错误并允许安全回退。
6. Agent Settings 支持查看、保存、重置最多 8 KiB UTF-8 的全局自定义指令，并清楚说明其优先级以及“下一 Turn 对新旧对话生效”；保存与读取共用校验，既有非字符串、超限或不可读配置 fail closed 且不进入 system；基础 Core 不可编辑。
7. Settings 提供只读生效来源摘要：Core 版本、用户自定义是否启用、发现的工作区 instruction 文件和 Skill 目录状态；不展示敏感正文。
8. 每个 `request/context` 或等价 Trace 记录 `promptVersion`、最终组合 digest、非敏感来源摘要和本 Turn 已加载 Skill 名称；不得记录完整提示正文、磁盘敏感路径或凭据。
9. Core 与动态段落按稳定前缀组织，重复规则被去除；通过 token/字节快照证明提示预算可控，并针对真实任务样本比较启用前后的 Skill 命中、工具顺序、验证率和 token 使用。
10. 当前存在的 compaction 非 Turn 模型调用不会意外继承工具执行 Core；若实现期间发现新的非 Turn purpose，必须加入同类隔离测试，不能假设不存在的标题生成路径；Turn 的 system 注入不改变 Transcript 的 user/assistant/tool role 投影。
11. Agent Plugin 自有 `tests/runtime.smoke.test.ts` 覆盖真实 Plugin handler 的 get/save/reset、config 读写和 Agent→Model Service 消息链；其显式命令、其他针对性测试、构建、Plugin check、`git diff --check` 通过，并在以 `mktemp` 同时隔离 data root 与 `HARBORS_AGENT_WORKSPACE` 的唯一 Web 宿主中验收 Settings、无工作区指令 Turn、显式 Skill 和隐式 Skill 场景。
12. 真实模型 eval 使用同一 provider/model/reasoning 对旧 Workspace-only baseline 与新组合逐例对照；runner 的选择来源、凭据隔离、输出 JSON schema/落点明确。模型、凭据或网络不可用时必须产出 blocked 记录并阻塞验收，不能降级成 mock 通过。
13. 设计证据包含固定 Codex commit SHA、完整固定-SHA permalink、符号/行定位、许可证说明和采用差异表；仅引用官方资料或官方开源仓库，不用二手文章代替事实来源。
14. 业务代码变更限制在 `kits/harness/plugins/agent/**`；若实现发现必须修改 Model Service、Settings 容器或 Framework，停止并先拆分协议/任务或向用户确认。

## 约束

- Harbors 仅支持 Web 宿主；Settings 和可见 Agent 行为必须通过 Web 浏览器验收。
- 基础提示是 Agent Plugin 的运行策略，不是安全 sandbox 的替代品；文件和工具权限继续由现有 sandbox、approval 与工具实现强制执行。
- 用户自定义内容按不可信配置处理，必须限制长度、稳定 framing，并防止伪造分隔标记或提升自身优先级。
- Skill description 同样是不可信本地内容，只用于发现与匹配；完整 Skill 指令不能覆盖 Core、直接用户授权或 Plugin/Host 强制边界。
- Prompt digest 使用稳定序列化和密码学哈希；摘要用于复现，不作为泄露正文的反向索引。
- 参考 Codex 的机制与测试方法，不追求逐行兼容或复制产品身份。
- `status.json` 只通过 Task CLI 修改。

## 决策上下文与处置

### Decision Context

- 当前事实：Harbors 每轮只把 `loadWorkspaceInstructions(workspace)` 的结果传入 Model Service `system`；无工作区指令时 system 可为空。Skill 工具存在，但目录只返回名称。
- 用户提出加入系统提示词，示例规则是“执行前先检查 Skill”，并要求参考近期开放源码的 Codex。
- OpenAI 官方资料确认：Codex 的关键 harness 与集成组件已开放源码；Codex 在工作前读取分层 `AGENTS.md`；Skills 使用 metadata-first、full-instructions-on-selection 的渐进披露。
- 已查询批准决策记忆，未找到 Agent system prompt / Skill 渐进披露的 repository 或 global 条目；索引 freshness 为 `partial`，有 1 个失败文件，不能把空结果解释为完整知识库证明。
- owner：后续任务主 Agent，负责固定外部 revision、Task 状态、提示边界和验收证据。
- implementer：Agent Plugin 后续负责人，只修改 Agent Plugin 路径。
- reviewer：后续独立审查角色，重点检查 instruction injection、Skill 路径、敏感信息、prompt budget、Trace 与行为 eval。
- approver：当前用户，负责产品规则与后续交付选择；本轮只授权建 Task。

### 逐条处置与分工

- **采用 Codex 的机制方向**：分层项目指令、Skill 渐进披露、精简稳定前缀、可审计 harness 边界。
- **不直接采用 Codex runtime**：保留 Harbors Agent loop、Model Service、Plugin request/broadcast、sandbox 与 approval 实现。
- **新增 Harbors Core**：以小型版本化行为契约补齐无工作区 system 的空洞。
- **扩展 Agent Settings**：用户可以维护宽泛自定义指令并查看来源摘要，但不能编辑 Core。
- **先研究再实现**：设计阶段必须用固定 Codex commit 和源码证据验证具体机制，不从文档标题反推实现。

## 需求变更

- 初始讨论确认 Agent 并非完全没有 system：已有 `AGENTS.md` 注入，但缺少稳定基础提示和 Skill 使用规则。
- 用户要求将讨论建立为 Task，并增加“参考最近开源 Codex”的正式要求。
- Task 将第一版收敛为 Core、用户自定义、工作区指令、Skill 目录、Trace 和 eval；project/session 自定义提示与全工具硬门禁留待后续。
- 本轮只完成 Task 定义，后续由其他负责人选择环境并实施。
