# Agent Guard

Agent Guard 是面向 macOS arm64 的 Claude Code 与 Codex 本机流量守卫。第一版采用零配置监听：
不设置系统代理、不安装证书、不修改 Agent 配置，也不读取 TLS 明文。

## 能看到什么

- 已识别 Agent 进程到模型或自定义 Relay 域名的连接；
- macOS `netstat` 提供的累计上下行字节，以及由连续快照计算出的每分钟速率；
- 连接数量、活跃任务、会话文件创建/更新时间和进程树结构；
- “confirmed / probable / unknown” 归因置信度。

这里的连接不是 HTTP 请求。一个长连接可以承载多轮对话，多个连接也可能只是重试、DNS 或
辅助服务。Relay 域名只有在 Agent 进程、配置端点和 DNS 地址等证据一致时，才会被确认为模型流量。
生命周期短于 5 秒、且完整落在相邻快照之间的连接可能漏记；因此指标用于预警和保守熔断，不作为
精确计费或审计流量。

## 历史流量与模型用量

面板按 1 小时、24 小时、7 天、30 天、90 天和 1 年查看历史，并可按 Claude、Codex 与已知
endpoint 筛选。历史严格分成两个指标域：

- **网络流量**只统计 Agent Guard 实时观测到的上下行字节；完整覆盖下的零流量显示为 0，后台退出、
  Collector 降级或 Agent 被关闭造成的区间显示为“未采集”，不会用零补齐。
- **模型用量**从本机 Claude/Codex 会话日志的 allowlist usage 字段回填 token、请求事件和会话活动，
  并标记为“本地日志回填”。它不会换算成网络字节，也不会与网络流量相加。

关闭面板不会停止 application-scope 后台采集。退出整个 ITHARBORS、停止 Agent Guard 后台或关机后，
漏掉的网络字节无法事后精确恢复；如果本地会话日志仍存在，模型用量可以独立回填。

原始历史保留 7 天、小时聚合保留 90 天、每日聚合保留 365 天。原始记录最多 20 MiB/天，达到上限
后明确标记部分覆盖。用户可以查看占用、关闭本地日志回填或清空历史；清空历史不会删除策略、异常
事件和控制 ledger。Web 开发模式只在当前会话内存中保存历史，并明确显示“不持久化”。

## 预警与熔断

动态基线或固定流量阈值先产生警告。自动暂停必须同时具备确认的模型流量和重复的任务/会话增长；
确认的递归任务树可按叶到根结束。控制目标每次都重新验证 PID、启动时间、可执行身份、进程组和
任务角色，Agent host 与 Harbors 自身进程组不可控制。暂停使用 `SIGSTOP`，恢复使用 `SIGCONT`；
独立看门狗在后台异常退出时只有 `SIGCONT` 权限。

## 隐私与资源

只保存域名、Provider、带盐远端地址/会话/事件摘要、字节、allowlist usage 计数、连接/任务数量、
证据代码和控制结果。Prompt、Response、凭据、完整 Header、环境变量、命令行参数、完整会话正文和
原始 session ID 不会保存。数据位于 Framework 分配给插件的 owner data 目录，普通指标最多
20 MiB/天，保留 7 天；异常事件保留 30 天。旧版 `userData/agent-guard` 仅提供一个版本周期的
只读兼容：只在 owner 文件不存在时读取，Agent Guard 不会在该旧目录中创建、修改或删除任何内容。

普通共享行为使用 Web 版本开发：

```bash
npm run dev:web
```

只有验证 `userData` 持久化、后台生命周期或重启恢复等 Desktop 专属行为时才运行 ITHARBORS Electron
Host；不要为普通 Kit UI 调试启动通用或空白 Electron 进程。

在 Kit 目录中定向验证：

```bash
cd kits/agent-guard
npm run test:kit
npm run build
npm run smoke -- --duration-seconds 900 \
  --report reports/agent-traffic-guard-performance.md
```

烟测脚本不接受 PID，只创建和控制自己的隔离子进程，并在 `finally` 中恢复、结束和清理夹具。

## Local lifecycle

```bash
npm ci --prefix kits/agent-guard
npm run build --prefix kits/agent-guard
npm run test:kit --prefix kits/agent-guard
npm run smoke --prefix kits/agent-guard
```

## Permissions

`network`、`filesystem`、`process-control`、`application-startup`、`notifications`。

## Platform

仅支持 macOS arm64。

## Ownership boundary

功能实现、依赖、测试与烟测均由本目录拥有。
