# 文档维护指南

文档是架构接口的一部分。代码改动如果改变了边界、流程、命令或扩展协议，应在同一
变更中更新对应文档。

## 文档分工

| 位置 | 内容 | 更新方式 |
| --- | --- | --- |
| `readme.md` | 定位、快速开始、架构摘要、主导航 | 保持短小，不复制专题细节 |
| `docs/architecture` | 当前行为、模型、不变量、失败边界 | 跟随实现变化 |
| `docs/guides` | 可执行任务步骤 | 跟随命令、目录与工具变化 |
| `docs/decisions` | 重要设计取舍及历史上下文 | 新 ADR 取代旧 ADR，不覆盖历史 |
| `docs/superpowers` | 文档/实施过程记录 | 不进入产品文档主导航 |

## 代码变化到文档的映射

| 变化区域 | 至少检查 |
| --- | --- |
| Gateway、Server 启动与端口 | 根 README、系统架构、开发工作流 |
| session、bootstrap、SSE、路由 | 核心运行流程、Kit 与会话模型 |
| Editor 装配或模块边界 | 核心原则、系统架构 |
| plugin manifest/lifecycle/resolver | 插件运行时模型、插件与 Kit 指南 |
| Kit manifest/layout/switch | Kit 与会话模型、布局模型、开发指南 |
| Window/PanelInstance/LayoutNode | 布局模型、核心运行流程 |
| Client Web Components/theme | UI 系统 |
| Electron preload/IPC | 系统架构、UI 系统 |
| npm scripts/build tools | 根 README、开发工作流 |

## 写作规则

- 先写职责和不变量，再写实现细节。
- 明确区分“当前行为”“设计约束”“未来方向”。
- 命令从仓库根目录可执行；如果必须切换目录，明确写出。
- API 路径、字段、包名和脚本名使用源码中的真实拼写。
- 每篇架构文档末尾保留“源码索引”。
- 同一事实只设一个主要维护点，其他文档使用链接和摘要。
- Mermaid 图表达边界或流程，不用图替代必要的错误语义说明。

## 源码索引规则

源码链接使用相对路径，指向负责该行为的入口文件，而不是任意测试或生成产物。例如：

```markdown
- [Editor 装配](../../packages/server/src/editor/index.ts)
- [Client transport](../../packages/client/src/core/transport.ts)
```

不要链接 `dist/`、数据库文件或本地缓存作为架构依据。测试可以作为行为证据，但主要
索引仍应指向实现。

## ADR 规则

需要 ADR 的变化通常具有以下特征之一：

- 改变插件、Kit、session 或状态权威边界；
- 引入新的跨进程/跨窗口通信方式；
- 采用难以轻易撤销的技术或目录策略；
- 替代已有已接受决策。

编号使用四位递增数字。状态至少为“提议”“已接受”“已取代”之一。取代旧决策时新
ADR 链接旧 ADR，旧 ADR 只更新状态和反向链接，不重写原始理由。

## 提交前检查

1. 从根 README 按导航逐个打开修改过的文档。
2. 确认所有相对 Markdown 链接目标存在。
3. 搜索模糊占位：

   ```bash
   rg -n "T[B]D|T[D]O|待[补]充|以后再[写]" readme.md docs --glob "*.md"
   ```

4. 搜索已经删除的主结构路径，区分历史规格和产品主文档。
5. 对照 `package.json` 核对命令，对照源码核对 API、字段和生命周期。
6. 检查格式：

   ```bash
   git diff --check
   ```

7. 查看变更范围，避免把本地数据库、dist 或缓存混入文档提交。

## 文档偏差处理

如果文档与源码冲突：

1. 先确认当前运行行为和测试覆盖。
2. 若只是文档过期，修正文档并说明适用版本/状态。
3. 若源码违反已接受 ADR，不在文档中悄悄改变原则；提出代码变更或新 ADR。
4. 若仓库正处于迁移中，只描述已存在且可验证的新结构，并在过程规格中保留迁移背景。

关联阅读：[知识库入口](../README.md) · [ADR 索引](../decisions/README.md)
