# 2026-08-19-kit-config-layers

Task ID: `2026-08-19-kit-config-layers`
Type: `feature`

## 背景与问题

Framework 当前固定维护 `shared/editor` 两类存储，并由 Plugin 通过 `registerTypes` 注册 `default/global/project` 等配置层。该模型把层名、作用域和存储策略泄漏给 Framework 与业务 Plugin，也无法让 Kit 明确声明自身需要的配置持久化方式。

需要把配置层的声明权移到 Kit：Kit 只描述逻辑层及抽象存储位置，Web 宿主负责把受控的 application-data 根目录解析成实际路径，Framework 只消费宿主注入的配置后端。

## 目标

- 扩展 `kit.json`，由 Kit 声明配置层、默认值层、默认写入层与抽象存储。
- 支持 `storage: null` 的内存层和位于 Harbors application-data 根目录下的 SQLite 层。
- 让 Framework 仅依赖抽象配置后端，不感知 `default/global`、SQLite 或物理路径。
- 移除 Plugin 公开的配置层注册能力，配置层在外部 Plugin 加载前由 Kit 激活。
- 移除 `project` 配置层；默认层只驻留内存，global 层持久化到 `.harbors/config.sqlite` 对应的宿主数据目录。

## 范围

- `packages/kit-core`：Kit 配置声明的类型、严格解析与安全校验。
- `packages/server`：配置后端抽象、内存后端、SQLite 后端、Kit 激活和 Web 宿主路径装配。
- `kits/default/kit.json` 与 `kits/agent-chat/kit.json`：声明 `default/global` 两层。
- Agent Chat Settings 的最小兼容调整：停止注册层并移除 project 层入口。
- 对应的 Kit Core、Server、Kit 单元/集成测试与 Web 可见行为验收。

## 非目标

- 不设计或实现模型服务、Token 中转站、模型参数配置界面。
- 不修改 Agent 当前的模型选择、环境变量或 DSH 读取逻辑。
- 不导入、读取、修改或删除 `~/.dsh/settings.yaml`。
- 不迁移历史 DSH 配置，也不处理 `ctx.credentials` 中的真实 Token。
- 不新增 Electron、桌面宿主或原生窗口假设。

## 验收标准

- Kit manifest 能声明任意安全层名，并拒绝重复层、重复优先级、悬空的 defaults/write layer、绝对路径与目录穿越。
- `defaultsLayer` 必须是 `storage: null`；`writeLayer` 必须指向持久化层。
- Plugin 不能通过 `ctx.config` 注册或改变层定义。
- 未激活 Kit 配置时操作失败；Kit 激活后按优先级读取，无显式层的写入/删除只作用于 Kit 的 write layer。
- `default` 值不写入磁盘；`global` 值在编辑器/服务重建后仍可读取。
- 同一 Kit 共享自身 global 配置，不同 Kit 即使使用相同 key 也相互隔离。
- Agent Chat Settings 不再暴露 project 层，默认值仍可回退，global 值可持久化。
- 聚焦测试、类型检查、Kit 校验和必要的 Web 浏览器验收通过。

## 约束

- 用户明确要求直接在当前分支修改，不创建新分支或 worktree。
- 保留当前工作区已有的文档、Skill 与 Task 改动，不覆盖、不混入本次实现。
- 物理路径由 Web 宿主解析；Kit 只能使用受控 root 和安全相对路径，Framework 不解析路径。
- SQLite 数据按 Kit ID 和逻辑层隔离。
- 仅先实施配置系统迁移到 Kit；其他模型与凭据方案后续另行讨论。

## 需求变更

用户确认第一阶段只实施配置系统迁移到 Kit，并要求直接在现有分支修改。
