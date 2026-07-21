# 插件与 Kit 开发指南

本指南提供当前构建工具可接受的最小结构。开始前先阅读
[插件运行时模型](../architecture/plugin-runtime-model.md)与
[Kit 与会话模型](../architecture/kit-and-session-model.md)。

## 选择放置位置

- 框架级、所有 Kit 都需要的贡献控制器放在 `plugins/<name>`。
- 只属于某个产品 Kit 的插件放在 `kits/<kit>/plugins/<name>`。
- 不要仅为了复用而把产品功能提升为内置插件；先提取协议或通用基础能力。

## 创建插件

### 目录

```text
my-plugin/
├── package.json
├── main/
│   └── src/index.ts
└── panel.main/
    └── src/
        ├── index.html
        ├── index.ts
        └── index.css
```

`dist/` 由构建工具生成，不要把 manifest 指向 `src/`。

### manifest

```json
{
  "name": "@example/my-plugin",
  "version": "0.0.1",
  "type": "module",
  "main": "./main/dist/index.js",
  "ce-editor": {
    "contribute": {
      "panel": {
        "main": {
          "entry": "./panel.main/dist/index.html",
          "title": "My Panel",
          "width": 420,
          "height": 300,
          "minWidth": 240,
          "minHeight": 160,
          "multiInstance": false
        }
      },
      "message": {
        "request": {
          "getState": ["getState"],
          "openPanel": ["openPanel"]
        },
        "broadcast": {
          "state.changed": ["panel.onStateChanged"]
        }
      }
    }
  }
}
```

完整 Panel 名为 `@example/my-plugin.main`。

### main entry

```typescript
declare const editor: any;

let runtime: any;
let state = { value: 0 };

editor.plugin.define({
  lifecycle: {
    load(ctx: any) {
      runtime = ctx;
    },
    unload() {
      runtime = undefined;
    }
  },
  methods: {
    getState() {
      return state;
    },
    setValue(value: number) {
      state = { value };
      runtime.message.broadcast("state.changed", state);
      return state;
    },
    openPanel() {
      return runtime.window.openPanel("@example/my-plugin.main");
    }
  }
});
```

manifest 的 request method 名称必须与 `definition.methods` 对应。贡献控制器会把它们
注册到 MessageModule。

### Panel

`index.html` 只提供文档结构和同目录样式：

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <link rel="stylesheet" href="./index.css">
  </head>
  <body>
    <div id="panel-root"></div>
  </body>
</html>
```

`index.ts` 默认导出 Panel definition：

```typescript
let context: any;

export default {
  async mount(ctx: any) {
    context = ctx;
    const state = await ctx.message.request("@example/my-plugin", "getState");
    render(state);
  },
  unmount() {
    context = undefined;
  },
  methods: {
    onStateChanged(state: unknown) {
      render(state);
    }
  }
};

function render(state: unknown) {
  const root = document.querySelector("#panel-root");
  if (root) root.textContent = JSON.stringify(state);
}
```

Panel 不直接导入其他插件。需要数据时发 request，需要通知多个订阅者时 broadcast。

### 构建

```bash
node scripts/ce-plugin.mjs build path/to/my-plugin
node scripts/ce-plugin.mjs check path/to/my-plugin
```

构建会编译 main 与 Panel TypeScript、复制 Panel HTML/CSS/资源并校验产物。

## 公开静态资源

在 manifest 中声明允许公开的根：

```json
{
  "ce-editor": {
    "assets": {
      "public": ["./static"]
    },
    "contribute": {}
  }
}
```

Panel 中使用 `ctx.assets.url("models/example.glb")`，不要拼接文件系统路径。只有
`static` 下且真实路径仍位于插件根内的文件会返回。

## 创建 Kit

### 目录

```text
kits/my-kit/
├── package.json
├── layout.json
├── main.html
├── secondary.html
└── plugins/
    └── my-plugin/
```

### package

```json
{
  "name": "@example/kit-my",
  "version": "0.0.1",
  "ce-editor": {
    "kit": {
      "menuRoot": {
        "id": "my-kit",
        "label": "My Kit"
      },
      "layouts": {
        "default": "layout.json"
      },
      "windowEntries": {
        "main": "main.html",
        "secondary": "secondary.html"
      },
      "plugin": [
        "@example/my-plugin"
      ],
      "theme": {
        "--ce-accent": "#7c5cff"
      }
    }
  }
}
```

`menuRoot`、`default` layout 与两个 window entry 是必需项。单 Kit 启动时忽略 menuRoot 并
平铺菜单；多 Kit 启动时 menuRoot label 成为顶层菜单名。Kit 下的插件仍需先生成 dist。

### layout

```json
{
  "windows": [
    {
      "id": "my-main",
      "kind": "main",
      "type": "panel-area",
      "layout": {
        "type": "hsplit",
        "sizes": [280, 1],
        "children": [
          {
            "type": "leaf",
            "panel": "@example/my-plugin.main"
          },
          {
            "type": "leaf",
            "panel": "@example/another-plugin.preview"
          }
        ]
      }
    }
  ],
  "activePanel": "@example/my-plugin.main"
}
```

`sizes` 大于 1 表示固定像素，小于等于 1 表示弹性份额。结构性区域应使用 layout tree，
不要在 window entry 中另建一套主工作台布局。

## 验证 Kit

```bash
node scripts/ce-plugin.mjs build kits/my-kit/plugins/my-plugin
npm run dev -- --kit ./kits/my-kit
```

检查：

1. Server 能解析 Kit 和全部 plugin package name。
2. bootstrap 返回预期 Kit、Panel 与 Window。
3. request 返回值和 broadcast 更新均能到达 Panel。
4. 打开单实例 Panel 时复用既有实例。
5. 切换 Kit 后旧 Panel、菜单和消息路由不再存在。
6. 主窗口与次窗口都能加载各自 entry。

## SQLite Kit

仓库内置的 `@itharbors/kit-sqlite` 提供本地 SQLite 数据库工作台。启动前先构建它的插件：

```bash
npm run plugins:build
npm run dev -- --kit ./kits/sqlite
```

SQLite Kit 由 Core、Explorer、Data、Schema、Relationships 和 SQL 六个插件组成。启动后在左侧
资源管理器打开或创建数据库；已有文件默认只读，需要修改时必须显式启用写入。右侧原生标签组
提供分页数据编辑、结构、全库关系图和 SQL 工作区。视图、虚拟表、影子表及没有稳定行标识的表
保持只读，BLOB 显示大小与十六进制摘要。

SQL 页每次执行一个语句，可运行查询、DDL 或 DML；结果集每页最多返回 50 行。所有表格生成的
写操作使用参数绑定，删除记录与写 SQL 都会要求确认。

## MySQL Kit

仓库内置的 `@itharbors/kit-mysql` 提供远程 MySQL 数据库工作台。启动前先构建它的插件：

```bash
npm run plugins:build
npm run dev -- --kit ./kits/mysql
```

连接时需要填写主机、端口、用户、密码和数据库名，也可启用 TLS。密码只保留在当前 Server
会话中，不会写入配置或返回 Panel；连接成功后输入框会立即清空。启用 TLS 时由 MySQL 驱动
验证服务端证书，证书不受信任会导致连接失败。

MySQL Kit 由 Core、Explorer、Data、Schema、Relationships 和 SQL 六个插件组成。左侧列出表与
视图，右侧原生标签组提供分页数据编辑、结构、全库关系图和 SQL。关系图只使用当前 database
真实声明的外键，支持复合、自引用、循环和平行关系。视图始终只读；没有可用主键的表可预览
和新增，但不能修改或删除。BLOB 只显示大小与十六进制摘要，二进制主键不参与行编辑。

SQL 页每次显式执行一个语句，可运行查询、DDL 或 DML；结果集最多预览 500 行。表格 CRUD
使用参数绑定并在事务中校验影响行数，数据库权限仍由所连接的 MySQL 账号控制。

## Notification Kit 与 Agent Skill

`@itharbors/kit-notifications` 提供通知中心，Electron 主进程同时启动仅监听 loopback 的
Notification Host。Agent 应使用 `notify-user` Skill 的脚本，不要自行拼 HTTP，也不要退回到
平台专属通知命令：

```bash
node .agents/skills/notify-user/scripts/notify.mjs \
  --title "Approval required" \
  --body "The release is waiting for production approval" \
  --level warning \
  --persistent
```

参数约束：

- `--title` 必填，最多 120 字符；`--body` 最多 2,000 字符；
- `--level` 可取 `info`、`success`、`warning`、`error`；
- `--duration` 仅用于临时通知，范围 1,000–60,000 毫秒，默认 8,000；
- `--persistent` 用于阻塞、审批或其他需要用户处理的事项；
- `--source` 默认是 `Codex`。

脚本输出 `Notification sent: <id>` 且退出码为 0 才表示 Host 已接收。若 Electron 未运行，
应把投递失败告知用户，不应声称通知成功。开发时可通过以下接口检查完整状态流：

| Method | Path | 用途 |
| --- | --- | --- |
| `GET` | `/health` | Host 存活检查 |
| `POST` / `GET` | `/v1/notifications` | 创建通知 / 获取快照 |
| `POST` | `/v1/notifications/:id/read` | 标记单条已读 |
| `POST` | `/v1/notifications/read-all` | 全部已读 |
| `DELETE` | `/v1/notifications/:id` | 删除通知 |

默认端口是 `17896`，可用 `HARBORS_NOTIFICATION_PORT` 修改；无论端口如何配置，Host 都只绑定
`127.0.0.1`。通知是桌面应用生命周期内的内存状态，不承诺跨重启保存。

## 参考实现

- [默认 Kit](../../kits/default/package.json)
- [默认布局](../../kits/default/layout.json)
- [Log 插件 manifest](../../kits/default/plugins/log/package.json)
- [Log main](../../kits/default/plugins/log/main/src/index.ts)
- [Log Panel](../../kits/default/plugins/log/panel.log/src/index.ts)
- [共享插件协议](../../packages/plugin-types/src/index.ts)
- [Notification Kit](../../kits/notifications/package.json)
- [notify-user Skill](../../.agents/skills/notify-user/SKILL.md)
