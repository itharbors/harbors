# Notification Kit 与 Agent 通知 Skill 设计

## 目标

新增 `@itharbors/kit-notifications`，让本机 Agent 可以通过稳定的外部接口向
ITHARBORS 发送通知。收到通知后，桌面宿主立即更新未读角标，并在桌面右下角显示可自动
消失或保持的提示窗口。Kit 本身提供通知中心，用户可以查看历史、标记已读和删除通知；
仓库级 `notify-user` Skill 为 Agent 提供无需手写 HTTP 请求的调用方式。

本功能以 Electron 桌面模式为主。`npm run dev:web` 仍可加载 Notification Kit，但会明确
显示桌面通知服务不可用，不伪造桌面能力。

## 方案与边界

通知状态由 Electron 主进程中的应用级 `NotificationHost` 持有，而不是由某个 renderer
窗口持有。这样关闭或隐藏 Notification Kit 窗口后，本地接口、角标和桌面提示仍然可用。
Notification Kit 是状态的产品界面，Agent Skill 是状态的外部生产者。

没有采用系统原生 Notification 作为唯一展示方式，因为不同桌面系统对常驻、堆叠和关闭
行为的支持并不一致。没有把状态只放进 Server 插件，因为 Electron 窗口被关闭后，独立的
Server runtime 无法可靠创建桌面提示窗口或更新系统任务栏。

首版不包括远程访问、跨设备同步、重启恢复、富文本、图片、操作按钮和声音。`persistent`
只表示提示窗口不会因定时器自动关闭，不表示应用重启后恢复。

## 组件

### NotificationHost

新增 `scripts/lib/notification-host.mjs`，提供可独立测试的通知状态和 HTTP 服务。Electron
在 `app.whenReady()` 后先启动 Host，再启动 Framework 子进程。

- 默认绑定 `127.0.0.1:17896`；可通过 `HARBORS_NOTIFICATION_PORT` 修改端口。
- 只监听 IPv4 回环地址，不设置 CORS 响应头，不接受局域网连接。
- 端口值由 Electron 显式传给 Framework 子进程，Notification Kit 插件使用同一地址。
- 端口被占用或 Host 启动失败时，Electron 输出明确错误并退出，避免 Agent 请求发送到未知
  服务或出现无提示的半可用状态。
- 状态仅驻留内存，应用退出时统一关闭提示窗口、HTTP server 和定时器。

Host 通过回调把状态变化交给 Electron 适配层。适配层负责系统角标、托盘菜单、提示窗口和
打开 Notification Kit；HTTP 与状态模块不直接依赖 Electron，便于使用 Node 测试。

### Notification Kit

新增 `kits/notifications`，manifest 名称为 `@itharbors/kit-notifications`，菜单根名称为
`Notifications`。默认布局只有 `@itharbors/notification-center.center` 一个 Panel。

`@itharbors/notification-center` 插件提供：

- `getSnapshot`：读取通知、未读数和 Host 状态；
- `markRead`：标记单条通知已读；
- `markAllRead`：全部标记已读；
- `removeNotification`：删除单条通知；
- `openCenterPanel`：从菜单打开或聚焦通知中心。

插件通过 Node `fetch` 调用回环 Host，Panel 仍使用现有 message request API，不直接跨源访问
Host。Panel 每秒获取一次快照；Agent 创建通知时，角标和桌面提示由 Host 即时处理，通知中心
最多延迟一秒刷新。Host 不可达时，Panel 显示可恢复的“桌面通知服务不可用”状态。

通知中心按新到旧展示标题、正文、来源、级别、创建时间和未读状态，并提供单条已读、删除及
全部已读操作。它不在打开时自动清空未读，避免仅聚焦窗口便丢失计数。

### Agent Skill

新增 `.agents/skills/notify-user/SKILL.md` 和
`.agents/skills/notify-user/scripts/notify.mjs`。Skill 指导 Agent 在长任务完成、需要用户处理、
后台失败或重要状态变化时发送通知，并避免为普通对话或高频进度刷屏。

脚本使用 Node `fetch` 和 JSON 序列化，避免 Agent 自行拼接易出错的 shell JSON：

```bash
node .agents/skills/notify-user/scripts/notify.mjs \
  --title "任务完成" \
  --body "构建与测试已通过"
```

可选参数为 `--level info|success|warning|error`、`--source <name>`、
`--duration <milliseconds>` 和 `--persistent`。脚本读取
`HARBORS_NOTIFICATION_PORT`，缺省使用 `17896`，失败时使用非零退出码并输出 Host 返回的错误。

## HTTP API

所有响应均使用 JSON，错误格式为 `{ "error": { "code", "message" } }`。

| 方法与路径 | 用途 | 成功响应 |
| --- | --- | --- |
| `GET /health` | Skill 启动检查与诊断 | `{ "status": "ok" }` |
| `POST /v1/notifications` | 创建通知 | `201` 和完整通知对象 |
| `GET /v1/notifications` | 获取当前快照 | `{ "notifications", "unreadCount" }` |
| `POST /v1/notifications/:id/read` | 标记单条已读 | 更新后的通知对象 |
| `POST /v1/notifications/read-all` | 全部已读 | `{ "unreadCount": 0 }` |
| `DELETE /v1/notifications/:id` | 删除通知 | `204` |

创建请求格式：

```json
{
  "title": "任务完成",
  "body": "构建与测试已通过",
  "level": "success",
  "source": "Codex",
  "durationMs": 8000,
  "persistent": false
}
```

字段规则：

- `title` 必填，去除首尾空白后为 1–120 个字符；
- `body` 可选，最多 2,000 个字符；
- `level` 缺省为 `info`，仅接受 `info`、`success`、`warning`、`error`；
- `source` 可选，最多 80 个字符；
- `persistent` 缺省为 `false`；
- 非常驻通知的 `durationMs` 缺省为 8,000，范围为 1,000–60,000；常驻通知忽略该字段；
- 未声明字段被拒绝，body 不是合法 JSON、字段类型错误或超限返回 `400`；
- 未知路由返回 `404`，不支持的方法返回 `405`，未知通知 id 返回 `404`；
- 请求体上限为 16 KiB，防止本地误调用造成无界内存占用。

Host 使用 `crypto.randomUUID()` 创建 id，并记录 ISO 8601 `createdAt`、`read: false`。通知按
创建时间倒序返回。首版在内存中最多保留 500 条；超出时优先移除最旧的已读通知，再移除最旧
通知，保证 Agent 长期运行不会无界增长。

## 桌面交互

### 提示窗口

Electron 使用无边框、置顶、不出现在任务栏中的小型 BrowserWindow 绘制提示，窗口使用
`contextIsolation: true`、`nodeIntegration: false` 和专用 preload。HTML 中所有通知字段先
转义，不加载远程内容。

- 窗口出现在鼠标当前所在显示器的工作区右下角；
- 同时最多显示 3 个提示，自下向上排列，间距 12 px；其余通知先进先出排队；
- 非常驻提示按 `durationMs` 关闭；自动关闭只关闭提示，不标记已读；
- 常驻提示没有自动定时器，用户点击关闭、在通知中心删除或应用退出时才关闭；
- 点击提示正文会标记已读、关闭提示并打开或聚焦 Notification Kit；
- 关闭按钮只关闭本次提示，通知仍保留在中心且保持原有已读状态；
- 一个提示关闭后，剩余窗口重新排布并展示队列下一项。

专用 preload 只公开 `openCenter()` 和 `closeToast()`。Electron 根据发送 IPC 的
`webContents` 反查通知 id，不信任 renderer 传入任意 id。

### 未读计数与托盘

每条新通知使未读数加一；`markRead`、`markAllRead` 和删除未读通知会减少计数。

- macOS 和支持 badge count 的 Linux 桌面调用 `app.setBadgeCount(unreadCount)`；
- Windows 为所有存活的 Kit 窗口调用 `setOverlayIcon()`，使用运行时生成的 `1`–`99+` 数字
  图标；计数为零时清除 overlay；
- 托盘 tooltip 始终显示 `ITHARBORS — N unread notifications`，托盘中的 Notification Kit
  条目显示 `Notifications (N)`；
- 点击托盘 Notification Kit 条目打开或聚焦通知中心；
- 新创建或重建的 Kit 窗口立即应用当前角标，不依赖下一次通知变化。

如果平台不支持应用角标，托盘条目的数字仍提供一致的计数入口。

## 数据流

```text
Agent
  │ notify.mjs / HTTP
  ▼
NotificationHost (127.0.0.1:17896)
  ├─ 更新内存状态与未读数
  ├─ Electron 角标 / 托盘
  └─ 桌面提示窗口队列

Notification Center Panel
  │ editor.message.request
  ▼
notification-center plugin
  │ loopback HTTP
  └──────────────► NotificationHost
```

## 生命周期与错误处理

1. Electron ready 后启动 Host；成功后把端口写入 Framework 子进程环境。
2. Kit catalog 发现 Notification Kit，与其他 Kit 一样预热独立 session 和隐藏窗口。
3. Agent 创建通知；Host 先完成校验和状态写入，再响应 `201`。
4. Electron 适配层同步角标、托盘和提示队列；单个提示窗口创建失败会记录错误，但不会撤销已
   接收的通知或中断后续 API。
5. 应用退出时先停止接受新请求，再关闭提示窗口和定时器，最后沿用现有 Framework/Tray
   清理顺序。

HTTP handler 捕获预期错误并返回结构化 `4xx`；未预期错误返回通用 `500`，详细堆栈只写入
Electron 日志。Skill 不自动重试创建请求，避免响应丢失时产生重复通知。

## 测试与验收

自动化测试覆盖：

1. 创建校验、缺省值、数量上限、未读计数、已读、全部已读和删除语义；
2. 实际监听随机回环端口的 HTTP 路由、状态码、响应结构、body 上限和非回环绑定配置；
3. 提示窗口最多 3 个、FIFO 排队、定时关闭、常驻、点击与删除后的重排；
4. macOS/Linux badge 和 Windows overlay 适配调用，以及托盘 label/tooltip 的计数更新；
5. Notification Kit manifest、布局、插件 message 路由和 Host 不可用状态；
6. `notify.mjs` 参数解析、请求载荷、成功输出和失败退出码；
7. 插件构建/校验、受影响包测试以及仓库完整 `npm run check`。

验收时还要在 Electron 中手工创建一条 1 秒通知和一条常驻通知，确认任务栏/托盘数字、右下角
堆叠、自动关闭、手动关闭、点击打开通知中心和全部已读行为。不同平台无法在当前环境直接验证
的任务栏 API 由适配器测试覆盖，并在交付说明中明确标注。
