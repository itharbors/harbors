# 应用内安装 notify-user Skill 设计

## 目标

Harbors 软件包内置完整的 `notify-user` Skill。Notification Kit 在自己的主菜单中注册安装
命令，用户点击一次即可把 Skill 安装到用户级 Codex Skill 目录。正式用户流程不依赖 GitHub、
Codex CLI 或其他外部安装器。

## 用户入口

Notification Kit 注册一个顶层菜单动作：

```text
Notifications
└── Install or Update Codex Notification Skill…
```

菜单项通过现有 `menuId -> message -> plugin method` 链路调用 Notification Center 服务端插件的
`installCodexSkill` 方法。安装入口不放进 Notification Center Panel，也不新增 loopback HTTP
安装接口或 Electron IPC。

## 内置资源

仓库中的 `.agents/skills/notify-user` 仍是开发时的规范源，结构保持自包含：

```text
notify-user/
├── SKILL.md
├── agents/openai.yaml
└── scripts/notify.mjs
```

发布构建把该目录复制到 Harbors 应用资源目录。Electron 启动 Framework 子进程时，通过受控
环境变量传入内置 Skill 的绝对路径；服务端插件只接受这一路径作为安装源，不访问网络。

## 安装服务

Notification Center 服务端插件包含一个可独立测试的安装模块。它只允许目标
`$CODEX_HOME/skills/notify-user`，未设置 `CODEX_HOME` 时使用
`~/.codex/skills/notify-user`，不接受来自菜单或 Panel 的任意源路径、目标路径或 Skill 名称。

安装过程先校验源目录及 `SKILL.md`，再复制到目标目录同级的临时目录，最后通过 rename 原子
切换。成功安装会写入 Harbors 管理标记和内容摘要，用于区分以下状态：

- 未安装：直接安装；
- 已由 Harbors 安装且摘要一致：不重复写入，报告已经是最新版本；
- 已由 Harbors 安装但摘要不同：原子更新，失败时恢复旧版本；
- 存在没有 Harbors 管理标记的同名 Skill：拒绝覆盖，保留用户内容并报告冲突。

并发点击复用同一个进行中的安装 Promise，避免两个安装过程竞争目标目录。

## 结果反馈

菜单动作捕获安装结果并通过已经运行的 Notification Host 创建桌面通知：

- 安装或更新成功：临时 `success` 通知，并说明从下一轮 Codex 对话开始生效；
- 已是最新版本：临时 `info` 通知；
- 权限、资源缺失或同名冲突：常驻 `error` 通知，正文给出可执行的原因。

安装失败不伪装成成功，也不回退到 GitHub、外部 Codex 命令或平台专属复制脚本。

## Skill 运行契约

安装后的 Agent 先定位已加载 `SKILL.md` 所在目录，再通过绝对路径执行同目录下的
`scripts/notify.mjs`。Skill 只负责发送通知；历史、未读、已读和删除仍由 Notification Center
管理。脚本退出码为 0 且输出 `Notification sent: <id>` 才代表 Host 已接收。

## 安全边界

- 安装方法只注册给固定的 Notification Kit 菜单命令，且不接收调用方提供的路径参数；Panel
  不暴露安装按钮。
- 安装源固定为 Electron 提供的应用内资源，目标固定为 Codex 用户级 Skill 目录。
- 不覆盖未标记为 Harbors 管理的同名目录，不跟随目标目录中的符号链接写到目录外。
- 临时目录、备份和失败恢复都限制在目标父目录中。
- Electron 必须提供有效的内置资源路径；Web-only 模式调用时明确报告桌面安装能力不可用。

## 验证

- 菜单 manifest、消息映射和插件方法完整连通；
- 覆盖首次安装、重复安装、受管更新、同名冲突、权限失败、符号链接和并发点击；
- 从无关工作目录运行安装后的 CLI，仍能向模拟 Host 发送通知；
- 安装过程不访问网络，也不会写入测试临时目录以外的真实用户目录；
- README 只把主菜单一键安装描述为正式用户流程。
