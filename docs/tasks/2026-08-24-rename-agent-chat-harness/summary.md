# Harbors Harness 重命名 Task 总结

## 最终结论

本 Task 已完成 `agent-chat` Kit 到 `harness` 的产品重命名、目录与活动引用迁移、配置与 Model Service API Key 的通用幂等迁移接线，以及旧入口不兼容处理。产品展示名为 **Harbors Harness**；内部 `agent` Plugin、Plugin 列表、request/broadcast 协议、Provider streaming 和 Web-only 宿主边界保持不变。

实现与验证阶段已完成，当前仍处于 `consolidation`，没有待解除的 blocking。本文仅记录总结证据，不表示已提交、push、创建 PR 或整合到 `main`。

## 需求完成情况

| 验收项 | 结果 | 证据/说明 |
| --- | --- | --- |
| `kits/harness` 存在，活动 `kits/agent-chat` 不存在；descriptor/package 使用 `harness` | 已完成 | Kit 目录和 descriptor 已迁移；`kit.json.id`、`package.json.name` 为 `harness` |
| 菜单及用户可见产品名为 Harbors Harness | 已完成 | Kit menu label、Kit-owned title smoke 断言、chooser label 和文档使用 `Harbors Harness`；浏览器宿主 shell title 保持 `ITHARBORS` |
| `agent` Plugin 身份与行为保持不变 | 已完成 | Plugin 目录仍为 `plugins/agent`；13/13 Plugin 在浏览器中加载，协议和业务终态未改 |
| 窗口 ID 改为 `harness-main`，布局缓存不迁移 | 已完成 | `layout.json` 使用 `harness-main`；旧浏览器布局缓存按已确认决定丢弃 |
| 配置与 Model Service 凭据迁移幂等、优先新值且失败保留旧数据 | 已完成 | descriptor 声明 `legacyKitIds: ["agent-chat"]`；配置和凭据迁移按通用规则接线并覆盖新值优先、重复执行、失败保留旧数据等回归场景 |
| 旧 URL、CLI、catalog、runtimeKit 不提供 alias/重定向 | 已完成 | 新 slug 与绝对 path 入口均验收；旧入口不作为活动 Kit 解析，相关路由、catalog 和 runtime fixture 已更新 |
| 活动代码、测试、正式架构/指南不再使用旧活动 Kit 标识 | 已完成 | 活动 Kit、入口和正式文档已更新；历史 Task/迁移声明中的 legacy ID 保留为历史事实 |
| descriptor、迁移、runtime smoke、assembly、build、Kit test 通过 | 已完成 | `pnpm --filter @itharbors/server test` 覆盖 61 files、761 tests；Kit assembly/test/build/smoke、`kits:test`、`kits:check` 均通过；integration/catalog/runtime targeted 重验另有 29 tests 通过 |
| 唯一 Web 宿主浏览器验收通过 | 已完成 | 绝对 path 与 slug 入口、chooser label、13/13 Plugin、Settings 面板可见；无新增 console error |
| `git diff --check` 与边界要求 | 已完成 | 当前改动集中在 Kit 重命名、必要 Framework/Server 迁移能力、活动引用/文档和对应测试；未执行提交、push、PR 或 main 整合 |

## 主要改动

1. 将 `kits/agent-chat` 迁移为 `kits/harness`，更新 Kit descriptor、package、菜单、产品摘要、HTML title、README、测试入口和默认窗口 ID；九个既有 Kit Plugin 的身份、顺序和实现保持不变。
2. 在 `KitPackageManifest` 增加可选 `legacyKitIds`，由 descriptor 声明 `agent-chat` 为存储迁移来源。该字段不参与 resolver、catalog、URL、CLI、runtimeKit 或公开 Bootstrap，因此不是兼容 alias。
3. 为持久配置 layer/backend 接入按 descriptor 顺序执行的事务迁移：当前值优先、旧行保留、重复执行幂等；单个 backend 失败只回滚该 backend 并阻断依赖的 Kit activation，不宣称跨多个 layer/file 的总事务。
4. 为 Credential Vault 接入 profile 与 secret 的迁移及并发/失败安全语义，保留旧 profile 和旧 Keyring account；迁移拒绝后可重试，成功后新 scope 的更新与删除继续有效。
5. 更新显式 Kit 解析和入口测试，使未知的旧 Kit 标识不会静默回退默认 Kit；同步更新架构文档、开发/测试指南、客户端与 Server 测试 fixture。

## 关键决定

### 关键决定

- 产品级 Kit 名称采用 **Harbors Harness**，技术 slug、目录、Kit ID、package name 和新入口采用 `harness`。
- `agent` 是 Kit 内负责 Agent Loop 的 Plugin，不因 Kit 改名而重命名；通用测试夹具中的 `Harness` 术语也不属于产品标识。
- `legacyKitIds` 只表示配置/凭据存储迁移来源，不提供旧 URL、CLI、catalog 或 runtimeKit alias；旧入口直接失效。
- 配置与 API Key 必须迁移且非破坏、幂等；新命名空间已有值时优先，旧数据和旧 secret 保留，不在本 Task 清理。
- 内部窗口 ID 使用 `harness-main`；浏览器布局缓存是可丢弃临时数据，不读取或迁移。

### Decision Delta、正式落点与反向检索

| 变化/决定 | 证据来源 | 影响范围 | 当前状态 | 正式落点 | 反向检索/验证 |
| --- | --- | --- | --- | --- | --- |
| `Agent Chat` 产品身份改为 `Harbors Harness`，slug 为 `harness` | Task 用户决定、task.md、Kit diff | Kit descriptor、目录、入口、菜单、文档 | 已实施 | `kits/harness/kit.json`、`package.json`、`docs/architecture/harness-kit-assembly.md`、相关 architecture/guide | 活动引用扫描、descriptor/Kit 命令、浏览器 slug 入口和 chooser label 已核验 |
| Kit ID 迁移通过 descriptor `legacyKitIds` 声明，且不形成 alias | task.md、`.work/plan.md`、kit-core/Server diff | 配置 SQLite、Credential Vault、Kit loading | 已实施 | `docs/architecture/kit-and-session-model.md`、`kit.json`、Server 迁移实现与回归测试 | 新旧入口、catalog、runtimeKit 和显式未知 Kit 测试已核验；旧标识仅保留在 legacy 声明/迁移测试及历史档案 |
| 旧配置与 API Key 迁移，失败安全并保留旧数据 | 用户决定、计划契约、迁移专项测试 | Config storage、Credential Store/Vault、Editor 接线 | 已实施 | `docs/architecture/kit-configuration-model.md`、`kit-and-session-model.md` 与对应 Server 测试 | Server 全量 61 files、761 tests 通过；integration/catalog/runtime targeted 重验另有 29 tests 通过 |
| 旧入口不兼容，布局缓存丢弃，窗口 ID 改为 `harness-main` | 用户决定、Task 验收、Kit smoke/browser 证据 | Web 路由、catalog、runtime fixture、layout | 已实施且已确认 | `harness` Kit layout、入口测试及测试指南 | 绝对 path/slug 入口、旧入口无重定向、窗口和 UI 可见性已浏览器复验 |

正式文档已随实现更新；本 Task 未新增或自动批准 ADR。反向检索结果以活动引用扫描、入口回归测试和浏览器验收为依据；历史 Task、计划、总结中的 `agent-chat` 作为历史事实和迁移来源保留。

## 验证结果

### 自动化验证

- Server 全量目标回归使用以下命令，覆盖 61 files，共 **761 tests 通过**：

  ```bash
  pnpm --filter @itharbors/server test
  ```
- integration/catalog/runtime targeted 重验另有 **29 tests 通过**；阶段证据未记录该 targeted 命令的完整文字形式。
- Kit-core descriptor 命令为 `pnpm --filter @itharbors/kit-core exec vitest run tests/schema.test.ts tests/repository.test.ts`；package-local Vitest shim 缺失，因此未将该命令伪装为通过。使用等价 runner 重跑，**89 项通过**；等价 runner 的具体命令未在阶段证据中记录。
- Kit 验证命令组均通过：

  ```bash
  pnpm run kit validate kits/harness
  pnpm --dir kits/harness run test:plugin
  pnpm --dir kits/harness run test:assembly
  pnpm --dir kits/harness run test:kit
  pnpm --dir kits/harness run build
  pnpm --dir kits/harness run smoke
  pnpm run kits:test harness
  pnpm run kits:check harness
  ```

  `pnpm run kit validate kits/harness`、`test:kit` 链路中的 descriptor validate、Plugin runtime smoke 和 assembly 均通过。曾尝试 `pnpm run kit -- validate kits/harness`，但因 `--` 包装参数解析失败；修正为上述命令后通过。
- 计划中的入口、catalog、配置迁移、凭据迁移、runtime fixture 和 Kit-owned 回归均纳入上述验证范围；消息顺序和业务终态保持原有语义。

### 浏览器验收

- 通过唯一 Web 宿主进入工作台绝对 path 与 slug 入口，确认 chooser 显示 `Harbors Harness`。
- 确认 13/13 Plugin 加载、Settings 面板可见、核心工作台可见，且无新增 console error。
- Kit-owned title 由 smoke 断言覆盖；浏览器宿主 shell title 为 `ITHARBORS`，不将其声称为 `Harbors Harness`。
- 首轮浏览器验收发现 configured directory 回归；修复后重新验收通过。该回归已闭环，不作为当前阻塞。
- `git diff --check` 与 staged diff check 均通过。

## 影响与风险

- 使用旧 `/kits/agent-chat`、`?kit=agent-chat`、旧 CLI slug、旧 catalog ID 或旧 runtimeKit 的调用方不会得到 alias 或重定向，需要改用 `harness`。
- 配置行、credential profile 和 Keyring account 成功迁移后仍保留，可能产生旧/新命名空间的历史数据；本 Task 不执行清理，后续清理必须单独授权并设计可回滚策略。
- 配置迁移保证每个持久 layer/backend 的事务原子性，不保证跨多个 layer 或文件的总事务；当前 Harness 使用一个 global SQLite layer。
- 浏览器布局缓存不迁移，升级后布局可能恢复默认状态。
- kit-core package-local Vitest shim 缺失是验证环境/工具链限制；等价 runner 的 89 项已通过，但应关注本地包命令在后续维护中的可用性。
- code-review 发现：同一 configured Kit 通过等价 symlink 绝对路径访问时，app 目录匹配会用 `realpath` 接受，但 `runtimeKit` 仍保留原始 requestedKit，而 Editor load 使用 catalog canonical directory，因此 canonical 路径与 symlink 路径可能形成两个 runtime key。正常开发中的绝对路径/slug 验收不受影响；这不是越权、alias 或 TOCTOU 问题，也不构成当前阻塞。

## 偏差与遗留

- 计划与实际实现的边界扩大来自用户明确决定：为保留配置和 API Key，新增通用 descriptor、配置和凭据迁移能力；未硬编码 `agent-chat -> harness` 产品映射。
- 浏览器首轮发现 configured directory 回归，已修复并完成重验；无需另开修复 Task。
- kit-core 原计划 package-local Vitest 命令受 shim 缺失影响，采用等价 runner 完成 89 项验证；该工具链差异需保留为非阻塞遗留。
- `pnpm run kit -- validate kits/harness` 曾因 `--` 包装参数解析失败，改用 `pnpm run kit validate kits/harness` 后通过；不影响最终验证结论。
- 当前工作区仍有本 Task 的 staged/unstaged 实现 diff 和新建 Task 档案；本总结不改变 status，也不提交或整合这些改动。

## 后续关注

- 后续若要清理旧配置、旧 credential profile 或旧 Keyring account，应另行定义保留期、审计、回滚和用户可见行为，不在本 Task 自动执行。
- 建议在后续工具链维护中恢复 kit-core package-local Vitest shim，并保留等价 runner 作为独立验证兜底。

## 相关正式文档

- [Harness Kit assembly 架构说明](../../architecture/harness-kit-assembly.md)
- [Kit 与 Session 模型](../../architecture/kit-and-session-model.md)
- [Kit 配置模型](../../architecture/kit-configuration-model.md)
- [Model Service Plugin 架构说明](../../architecture/model-service-plugin.md)
- [Agent JSONL 格式](../../architecture/agent-jsonl-format.md)
- [Agent turn event 协议](../../architecture/agent-turn-event-protocol.md)
- [开发工作流指南](../../guides/development-workflow.md)
- [测试指南](../../guides/testing.md)

### blocking

- 无。实现、Server/Kit 自动化验证和浏览器复验均已完成；没有阻止 consolidation/ready 的已知问题。

### non_blocking

- kit-core package-local Vitest shim 缺失；等价 runner 已通过 89 项，但本地包命令仍需后续工具链维护。
- 旧数据、旧 Keyring account 和旧配置行按决定保留，未做清理；布局缓存按决定丢弃；这些都是已知行为，不阻止收口。
- 浏览器首轮 configured directory 回归已修复并重验通过，作为验证过程记录保留。
- symlink 绝对路径可能导致 canonical 与原始 requestedKit 形成两个 runtime key；当前正常绝对路径/slug 入口不受影响，属于后续入口语义决策，不阻止收口。

### decision_candidates

- 无。用户已确认的旧入口不兼容、布局缓存丢弃和 `harness-main` 窗口 ID 是本 Task 已接受决定，不是待批准候选。

### follow_up

- 在工具链维护窗口修复或升级 kit-core package-local Vitest shim，并复跑 package-local 命令；责任人：Kit-core 维护者；触发条件：Vitest shim 可用或相关依赖升级。
- 如需删除旧配置/凭据数据，先另开明确的迁移清理 Task；责任人：维护者；触发条件：完成保留期和回滚方案批准。
- 如未来正式支持 symlink 入口，先决定 `runtimeKit` canonicalization 规则并增加 canonical/symlink 回归测试；责任人：Server/Editor 维护者；触发条件：symlink 入口进入支持范围。
