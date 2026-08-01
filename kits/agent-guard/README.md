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

## 预警与熔断

动态基线或固定流量阈值先产生警告。自动暂停必须同时具备确认的模型流量和重复的任务/会话增长；
确认的递归任务树可按叶到根结束。控制目标每次都重新验证 PID、启动时间、可执行身份、进程组和
任务角色，Agent host 与 Harbors 自身进程组不可控制。暂停使用 `SIGSTOP`，恢复使用 `SIGCONT`；
独立看门狗在后台异常退出时只有 `SIGCONT` 权限。

## 隐私与资源

只保存域名、Provider、带盐远端地址摘要、字节、连接/任务数量、证据代码和控制结果。Prompt、
Response、凭据、完整 Header、环境变量、命令行参数和精确请求总数不会收集。数据位于
Framework 分配给插件的 owner data 目录，普通指标最多 20 MiB/天，保留 7 天；事件保留 30 天。
旧版 `userData/agent-guard` 仅提供一个版本周期的只读兼容：只在 owner 文件不存在时读取，
Agent Guard 不会在该旧目录中创建、修改或删除任何内容。

开发运行：

```bash
npm run dev -- --kit ./kits/agent-guard
```

在 Kit 目录中定向验证：

```bash
cd kits/agent-guard
npm run test:kit
npm run build
npm run smoke -- --duration-seconds 900 \
  --report reports/agent-traffic-guard-performance.md
```

烟测脚本不接受 PID，只创建和控制自己的隔离子进程，并在 `finally` 中恢复、结束和清理夹具。
