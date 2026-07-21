# 可安装的 notify-user Skill 设计

## 目标

Harbors 仓库继续内置 `.agents/skills/notify-user` 作为唯一分发源。用户不需要额外安装器，
只需让本地 Codex 从 GitHub 目录安装该 Skill 到用户级 Skill 目录，之后所有项目中的 Agent
都能使用 Harbors 桌面通知。

## 分发与安装

Skill 保持自包含结构：

```text
notify-user/
├── SKILL.md
├── agents/openai.yaml
└── scripts/notify.mjs
```

文档提供一条可直接交给 Codex 的安装提示词。安装目标默认为
`~/.codex/skills/notify-user`，但 Harbors 不主动写入用户目录，也不提供专用安装器。

## 运行契约

Agent 必须先定位已加载 `SKILL.md` 所在目录，再通过绝对路径执行同目录下的
`scripts/notify.mjs`。调用不能依赖当前工作目录，也不能假设当前项目是 Harbors。

Skill 首版只负责发送通知。历史、未读、已读和删除继续由 Notification Center Kit 管理。
脚本退出码为 0 且输出 `Notification sent: <id>` 才代表 Host 已接收；失败时 Agent 如实说明
投递失败，但除非“发送通知”本身就是用户任务，否则不把主任务标记为失败。

## 边界

- Electron 桌面 Host 必须正在运行；默认访问 `127.0.0.1:17896`。
- 不手写 HTTP，也不回退到 `osascript`、`notify-send` 或 PowerShell。
- 仅在用户明确要求、重要长任务完成、异步失败、阻塞或需要用户注意时通知。
- 普通可见进度不通知，同一事件不重复通知。

## 验证

- 从与 Harbors 无关的工作目录执行已复制 Skill 中的脚本，通知仍能成功送达模拟 Host。
- Skill 静态校验通过，并明确要求使用自身目录而非仓库相对路径。
- README 包含 GitHub 源目录、默认安装目标和可复制的一句话安装提示。
