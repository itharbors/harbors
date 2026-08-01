# Skill Manager Kit 设计

## 背景

Harbors 需要一个独立发布的 Skill Manager Kit，用来发现和管理 Codex Skills。用户可以不选择
任何文件夹，直接管理用户级全局 Skills；也可以选择一个来源文件夹，递归发现其中的 Skills，
并与全局安装状态进行对照。

本设计采用“双根目录对照”：全局目录始终是实际管理目标，所选文件夹只是可选来源库。这样既
保留了打开即用的全局管理体验，也让仓库、下载目录或自建 Skill 集合能够安全地安装和更新到
全局目录。

## 目标

- 新增可独立发布的 `@itharbors/kit-skill-manager`。
- 未选择来源文件夹时，发现、搜索、查看和管理全局 Codex Skills。
- 选择来源文件夹后，递归发现 `SKILL.md`，并与全局 Skills 显示安装、相同、可更新和冲突状态。
- 支持安装、原子更新、停用、恢复和可恢复卸载。
- 将所有本机文件访问和写入限制在服务端插件，Panel 只使用受控消息协议。
- 保护系统 Skill、符号链接和并发变化，不以便利性换取文件安全。

## 非目标

- 不编辑或创建 `SKILL.md`。
- 不从 GitHub、Skill 市场或任意 URL 下载内容。
- 不自动更新 Skill，也不在后台静默扫描上次选择的来源目录。
- 不管理 Claude、Agents 或其他工具的全局 Skill 根目录。
- 不永久删除 Skill；首版卸载始终可恢复。
- 不修改 Harbors Electron IPC，也不依赖原生目录选择器。

## 核心产品决策

### 全局根目录

全局根目录固定为 `$CODEX_HOME/skills`；`CODEX_HOME` 未配置时使用
`~/.codex/skills`。Panel 不能覆盖这个路径。

普通全局 Skill 是全局根目录的直接子目录。`.system` 下的系统 Skills 也会被发现，但始终标记
为受保护、只读。其他以点开头的目录不作为可操作 Skill。

### 来源根目录

来源根目录是可选、仅当前 Kit Session 有效的扫描范围。Kit 重启或 Session 重建后回到全局
模式，不静默访问旧路径。

目录选择使用服务端目录浏览器：服务端从用户主目录和平台文件系统根开始返回不透明目录 ID，
Panel 只能使用服务端签发的 ID 浏览和确认目录，不能提交任意绝对路径。每次选择生成新的扫描
代次，旧扫描结果不得覆盖新状态。

### Skill 身份

一个候选 Skill 必须满足：

- 目录中存在常规文件 `SKILL.md`；
- `SKILL.md` 包含 YAML frontmatter；
- `name` 和 `description` 是非空字符串；
- 目录及其内容不包含符号链接或不受支持的特殊文件。

对照身份使用 frontmatter `name`，安装目录名保留来源 Skill 目录的 basename。来源或全局范围
内出现重复 `name` 时，所有同名项进入冲突状态，不自动选择胜者。父子目录都包含 `SKILL.md`
时标记为重叠来源，禁止生命周期操作，避免一次安装隐含另一个 Skill。

### 内容摘要

每个有效 Skill 对目录内所有常规文件按相对路径排序后计算 SHA-256。摘要覆盖脚本、资源和
说明文件，而不只覆盖 `SKILL.md`。扫描器不跟随符号链接，并为文件数量、单文件大小和总大小
设置明确的安全上限；超过上限的候选仍展示诊断，但不能安装或更新。

## 用户体验

### 全局模式

Kit 打开后立即扫描全局目录和恢复区，不要求用户先选择文件夹。

用户可以：

- 搜索并按已安装、已停用、已卸载、系统内置、无效分类筛选；
- 查看名称、描述、路径、内容摘要、文件清单和只读 `SKILL.md` 源码；
- 重新扫描；
- 停用普通全局 Skill；
- 将普通全局 Skill 移入可恢复卸载区；
- 恢复已停用或已卸载的 Skill。

### 来源对照模式

用户选择来源文件夹后，列表合并来源、全局和恢复区记录，并显示：

| 状态 | 含义 | 主操作 |
| --- | --- | --- |
| `source-only` | 来源存在、全局不存在 | 安装 |
| `current` | 来源和全局同名且摘要相同 | 无 |
| `update-available` | 来源和全局同名但摘要不同 | 查看差异、更新 |
| `global-only` | 只存在于全局 | 停用或卸载 |
| `disabled` | 位于停用恢复区 | 恢复 |
| `trashed` | 位于卸载恢复区 | 恢复 |
| `protected` | `.system` 内置 Skill | 只读 |
| `conflict` | 名称、目标目录或重叠来源冲突 | 只读并解释冲突 |
| `invalid` | manifest、文件类型、权限或大小不符合要求 | 只读诊断 |

清除来源文件夹立即取消来源扫描并回到全局模式。

### 布局

主窗口采用三栏工作区：

- 顶部工具栏显示当前模式、全局根、来源选择、清除来源和重新扫描。
- 左侧是状态筛选和数量统计。
- 中间是可键盘导航的 Skill 列表，展示名称、描述、来源、状态和主操作。
- 右侧是详情区，展示 manifest、路径、摘要、文件清单、只读源码和次要操作。

首次为空时解释全局目录；来源为空时保留全局结果并单独说明“未发现来源 Skill”。加载、取消、
失败和成功反馈使用 `aria-live`，确认对话框管理焦点并支持 Escape。

## 架构

### Kit 结构

```text
kits/skill-manager/
├── kit.json
├── package.json
├── vitest.config.ts
├── layout.json
├── main.html
├── secondary.html
├── README.md
├── tests/
└── plugins/
    └── skill-manager/
        ├── package.json
        ├── main/src/
        ├── panel.manager/src/
        └── tests/
```

Kit 只声明一个普通 Session 插件 `@itharbors/skill-manager`。它不需要 application startup、网络
或 Electron IPC；发布权限只声明 `filesystem`。初始版本为 `0.1.0-preview.1`。

### 服务端模块

插件 main entry 只负责生命周期和消息适配，具体逻辑拆分为：

- `skill-scanner`：发现候选、校验文件类型、解析 manifest、计算摘要和诊断。
- `skill-comparator`：按名称和摘要生成合并状态，检测名称、目录和重叠冲突。
- `directory-browser`：签发 Session 内目录 ID，解析受控导航并拒绝身份变化。
- `skill-store`：管理停用区、卸载区、元数据和恢复。
- `skill-mutator`：安装、更新、停用、卸载与恢复的事务和目标级串行化。
- `skill-service`：拥有当前来源、扫描代次、快照和广播。

这些模块不依赖 Panel DOM，可用临时目录单独测试。

### 消息协议

Panel 请求：

- `getSnapshot()`
- `browseDirectory({ directoryId?, childId? })`
- `selectSource({ directoryId })`
- `clearSource()`
- `rescan()`
- `getSkillDetail({ skillId, revision })`
- `performAction({ action, skillId, revision, expectedDigest })`

服务端广播：

- `snapshot.changed`
- `scan.progress`
- `operation.progress`

`skillId`、`directoryId` 和 `revision` 都是服务端生成的 Session 内不透明值。写操作要求当前
revision 和 expected digest 一致，防止 Panel 使用过期列表覆盖磁盘上的新内容。

### Panel 边界

Panel 只渲染服务端返回的公开投影。它不导入 Node 模块，不拼接路径，不决定目标目录，也不把
Markdown 当 HTML 注入。首版详情显示转义后的源码和结构化 frontmatter；后续如增加 Markdown
渲染，必须使用独立的受测净化器。

## 扫描与比较流程

1. Service 解析固定全局根和恢复区，启动全局扫描。
2. 用户选择来源时递增 generation，取消上一来源扫描。
3. 来源扫描递归遍历目录；忽略 `.git`、`node_modules`、`.worktrees` 和 Skill Manager 恢复区。
4. 每个常规 `SKILL.md` 生成候选或局部诊断。
5. 扫描完成后 Comparator 合并来源、全局、停用和卸载记录。
6. Service 原子替换快照并广播新 revision。
7. Panel 丢弃旧 revision 的详情、进度和操作结果。

单个候选失败不终止整个扫描。无法读取来源根、全局根身份变化或扫描被取消属于扫描级状态，
但必须保留最后一个已确认的全局快照并明确标记其已过期。

## 文件操作与恢复

### Store 布局

恢复区位于 `$CODEX_HOME/skill-manager-store/v1`，不在 `skills` 目录内：

```text
skill-manager-store/v1/
├── disabled/<entry-id>/skill/
├── trash/<entry-id>/skill/
├── records/<entry-id>.json
└── journals/
```

record 保存 entry ID、Skill name、原目录 basename、来源状态、摘要、动作和时间戳。所有 record
字段由服务端生成，恢复时重新校验实际内容，不盲信元数据。

### 安装

安装目标是 `<global-root>/<source-basename>`。若目标 basename 已占用，或全局已有同名 Skill，
则拒绝并返回冲突。服务端先复制到全局根同级暂存目录，校验摘要，再通过 rename 发布；发布
前再次验证全局根身份和目标不存在。

### 更新

更新只允许来源和一个普通全局 Skill 名称相同。服务端记录目标目录身份和摘要，准备并校验新
副本，把旧目录 rename 到同级备份，再发布新目录。任何步骤失败都恢复旧目录；恢复失败时保留
备份并返回其受控 recovery ID，而不是伪装成功。

### 停用与卸载

停用和卸载都通过 rename 将完整目录移出全局根，并原子写入 record。两者的差异是用户语义和
筛选位置；首版不提供永久清空 trash。系统 Skill、无效目录、符号链接和扫描后已变化的目录均
拒绝操作。

### 恢复

恢复目标使用 record 中的原 basename。目标被占用、摘要变化、record 与实际目录不匹配时拒绝
覆盖。恢复成功后删除对应 record；失败时内容留在 Store 中。

### 并发与中断恢复

同一全局目标和同一 Store entry 的操作串行化，不同 Skill 可以并行。每个跨两次 rename 的事务
写 journal；下次启动先检查 journal，只有能证明目标或备份完整时才自动完成或回滚，否则保留
隔离内容并返回诊断，不猜测用户意图。

## 错误处理

- 路径、Skill 或 revision 变化：返回 `STALE_SNAPSHOT` 并触发重扫。
- 名称、basename 或恢复目标冲突：返回结构化 `SKILL_CONFLICT`。
- 符号链接、特殊文件或目录身份变化：返回 `UNSAFE_PATH`。
- frontmatter 无效：候选保留为 `invalid`，不允许写操作。
- 权限错误：展示操作和路径范围，不泄露其他目录内容。
- 扫描超过安全上限：展示 `truncated` 及原因，保留已发现项但禁止依赖不完整集合的批量操作。
- 原子更新失败：返回原版本是否已恢复以及 recovery ID。

所有错误都提供稳定 code 和面向用户的中文消息；技术详情放在可展开区域。失败不自动改用网络、
外部 CLI 或不受控复制命令。

## 测试策略

### 单元测试

- Scanner：嵌套 Skill、多个 Skill、无效 frontmatter、重复名称、重叠目录、符号链接、特殊文件、
  权限错误、大小上限和取消。
- Comparator：全部九种状态、目录 basename 冲突和多重同名冲突。
- Browser：不透明 ID、父子导航、伪造 ID、目录替换和跨 Session ID。
- Store/Mutator：首次安装、目标竞争、更新、回滚、停用、卸载、恢复、journal 恢复、并发串行和
  系统 Skill 保护。

### Panel 测试

- 全局模式与来源模式。
- 搜索、状态筛选、列表选择和详情刷新。
- 选择/清除来源、扫描取消和旧 revision 丢弃。
- 安装、更新、停用、卸载、恢复的确认与进度状态。
- 键盘导航、焦点恢复、对话框焦点陷阱、`aria-live` 和 reduced motion。
- 源码转义，确保 Skill 内容不能注入 Panel DOM。

### 集成与制品验证

- 用隔离的临时 `CODEX_HOME` 启动真实插件，完成全局模式和来源对照模式流程。
- Kit manifest 测试验证身份、permissions、布局、消息与 Panel 映射。
- `npm run kit:check -- skill-manager` 必须通过并生成 `.hkit`。
- focused tests、Kit build、Kit check 和相关根级回归测试全部通过后才可完成变更。

任何测试都不得读取或写入真实用户的 `$CODEX_HOME`。

## 发布与仓库集成

首次引入需要同时：

- 将 `kits/skill-manager` 加入 npm workspace lockfile；
- 在 `registry/policy.json` 注册 `skill-manager`，使用 `ubuntu-latest` runner；
- 补充根测试脚本和文档中的官方 Kit 列表；
- 让现有 Kit catalog、CI 选择和发布工作流测试覆盖新 Kit。

首次引入使用仓库级 feature workflow，因为专用 `kit-workflow` 只能启动已在 Registry policy、
manifest 和 lockfile 中存在的 Kit。合并后，后续 Skill Manager Kit 迭代必须使用
`kit-workflow`；只有显式 `kit/skill-manager/v<semver>` Tag 才发布该 Kit。

## 验收标准

1. 不选择来源文件夹即可看到并管理隔离 `CODEX_HOME` 中的全局 Skills。
2. 选择包含多个嵌套 Skills 的文件夹后，列表正确显示来源与全局对照状态。
3. 安装和更新后全局内容摘要与来源一致，失败注入时旧版本保持可用。
4. 停用和卸载会移出全局根且可恢复，不发生永久删除。
5. `.system`、符号链接、无效 Skill、冲突和过期 revision 的写操作全部被拒绝。
6. Panel 无法通过消息协议提交任意文件路径或绕过服务端目标选择。
7. Kit 在桌面和 Web host 的 Session 模型下均可加载；文件访问始终发生在服务端插件。
8. Skill Manager Kit 的 build、tests、manifest 校验和 `.hkit` pack 全部通过。
