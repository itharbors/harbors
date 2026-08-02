# TraceWeave Kit

TraceWeave 是 Harbors 官方的只读 Codex 多轮编排观察器。它直接读取本机 Codex JSONL 会话，
将事件归一化成 Run、Turn、节点和边，并在 Harbors Session 内提供 Flow 主干与 Events 诊断视图。
它不启动独立服务或端口，也不会修改 Codex 会话文件。

```bash
npm run dev -- --kit ./kits/traceweave
```

默认从 `~/.codex` 读取；开发和测试时可用 `CODEX_HOME=/path/to/codex-home` 显式覆盖。

## 使用

- 左侧 Sessions 只列出 Codex 顶层会话，不会把子 Agent 或 `exec` rollout 冒充独立会话。
  Active 默认展开，Archived 默认折叠；选择会话后默认进入 Flow。
- Flow 对每一轮固定呈现 Input → Understand → Execute → Output 四个位置。空阶段会明确显示
  “No recorded …”，不会用推测填充。
- 点击非空阶段可展开按时间排序的步骤；点击步骤打开 Evidence inspector。
- Events 保留完整事件顺序与已记录边，可筛选 Observed、Derived、Inferred，隐藏成功工具，折叠轮次。
- 顶部回放控制按原始 JSONL 偏移逐步揭示节点；系统开启“减少动态效果”时不会自动播放动画。

证据标签含义：

- `Observed`：直接来自 Codex 记录；
- `Derived`：由明确事件组合得到，例如工具调用与输出配对；
- `Inferred`：由有名称的规则推断，带来源与低于 100% 的置信度，例如显式 `SKILL.md` 读取。

Events 的横向排列只表达记录顺序，不根据时间戳推断并发或分支。

## 隐私与支持范围

Core 插件只读扫描 `session_index.jsonl`、`sessions/**/rollout-*.jsonl` 和
`archived_sessions/**/rollout-*.jsonl`，忽略符号链接目录。Panel 只收到不透明 run id、workspace
末级目录名和归一化数据，不接收 Codex Home 或 rollout 绝对路径。

原始证据仅在检查器打开时按需读取。返回前会递归屏蔽常见 token、密码、密钥和授权字段，序列化内容
最多 65,536 字符；超限会标记截断。解析遇到损坏或未知记录时保留其他有效证据并显示告警。

## 验证

```bash
npm run build -w @itharbors/kit-traceweave
npm test -w @itharbors/kit-traceweave
npm run verify:real -w @itharbors/kit-traceweave
npm run kit:check -- traceweave --output-directory "$(mktemp -d)"
```

`verify:real` 只输出顶层 session 的 Active/Archived 分类，以及 turn、node、edge、证据类型和告警的聚合数量，并核对源文件 size/mtime
保持不变；不会打印 prompt、工具参数或文件路径。没有可解析会话时会以 `no_eligible_run` 明确失败。

常见问题：

- Sessions 为空：确认 `CODEX_HOME` 指向包含 `sessions` 或 `archived_sessions` 的目录，然后 Refresh。
- 某阶段为空：切换 Events 检查是否被证据筛选或回放位置隐藏；TraceWeave 不补造缺失事件。
- 原始证据不可用：对应 JSONL 可能已移动或刷新；重新扫描后再选择 run。

## Local lifecycle

```bash
npm ci --prefix kits/traceweave
npm run build --prefix kits/traceweave
npm run test --prefix kits/traceweave
```

本 Kit 未声明独立 smoke 脚本，以仓库目标 Kit 的完整检查验收。

## Permissions

`filesystem`。

## Platform

支持任意平台与架构。

## Ownership boundary

TraceWeave 功能、证据处理与测试均由本目录拥有。
