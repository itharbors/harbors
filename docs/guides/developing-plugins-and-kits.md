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
      "startup": {
        "plugins": [
          "@example/my-background"
        ]
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

`menuRoot`、`default` layout 与两个 window entry 是必需项。Electron 窗口统一使用聚合菜单，
`menuRoot.label` 成为该 Kit 的顶层菜单名。`startup.plugins` 缺省为空，`plugin` 仍是普通
Session 插件，两者不能在同一 Kit 中包含同一 package name。Electron 默认不自动打开 Kit，
用户首次从 Tray 选择或通过 `--kit` 直达时才创建 Session；Kit 下的插件仍需先生成 dist。

要生成可独立传递的 Kit 制品，还需在 Kit 根增加发布协议 `kit.json`，并使用
`npm run kit -- validate/pack/inspect`。完整字段、目标 ABI、制品内容和本地 Store 行为见
[Kit 制品与本地安装](./kit-artifacts.md)。`--kit <path>` 仍是开发期显式路径，不会写入
Installed Kit Store。

### 官方 Kit 的目录与发布边界

Kit 的 descriptor 通过 `harbors.distribution` 声明 builtin 或 market；builtin 中恰好一个以
`harbors.default=true` 声明默认角色。实现固定保存在主分支的 `kits/<name>`；development profile
发现全部合法 Kit，stable profile 只选择 descriptor 声明的 builtin，并从隔离构建生成的 staging
加载。每个目录独立维护 `kit.json`、`package.json`、`package-lock.json`、依赖安装、插件、测试和
构建产物，仓库只共享通用发布工具链。
修改某个 Kit 时使用 `kit-workflow` 从 `origin/main` 创建短期分支，PR 仍合回 `main`；普通合并
不会发布 Kit 或 Framework。

准备版本时必须同步 Kit manifest、package 和锁文件中的版本。只有显式创建
`kit/<name>/v<semver>` Tag 才会选择对应 `kits/<name>` 目录执行检查与打包。发布得到独立 `.hkit`
Release Asset，随后市场工作流自动扫描可信 Release 并重建 `index.v1.json`；开发者不提交逐版本
Registry entry。具体确认令牌、Stable/Preview 频道和回滚规则见
[Kit 制品与本地安装](./kit-artifacts.md)。

### 应用启动插件

只有必须在任何 Kit 窗口打开前可用、且不需要 UI 的能力才应放进 `startup.plugins`，例如本机
服务桥接或全局安装动作。启动插件仍是标准插件 package，但 manifest 只能贡献应用菜单和
Server message，不能贡献 Panel、Window、Layout 或 `panel.*` / browser message。

典型实现会让 application-scope 插件维护宿主级服务，让 session-scope 插件通过
`application.request` 转发结构化结果；Panel 始终不直接获得进程、文件系统或其他宿主权限。

```json
{
  "name": "@example/my-background",
  "type": "module",
  "main": "./main/dist/index.js",
  "ce-editor": {
    "contribute": {
      "message": {
        "request": {
          "refresh": ["refresh"]
        }
      },
      "menu": [
        {
          "type": "menu",
          "id": "refresh-background-service",
          "label": "Refresh Background Service",
          "message": "refresh"
        }
      ]
    }
  }
}
```

其 `lifecycle.load(ctx)` 只收到 `plugin`、`menu`、`message`、`service` 和 `host`。`host.mode`
为 `desktop` 或 `web`；依赖 Electron 的方法在 web 模式应返回明确错误。启动失败会在
`GET /api/application/bootstrap` 中显示为 `degraded`，但不阻止其他插件或 Kit 启动。
`menu` 只允许启动插件 attach/detach 自己的贡献和读取当前状态，不提供清空全局菜单的能力。
应用菜单的 HTTP 触发接口是 Electron 内部控制面，要求每次启动生成的令牌，不能作为普通网页
或外部工具 API 使用。

每个唯一的 Application 启动插件在独立 OS 进程中运行；多个 Kit 声明同一 package name 时共享
同一 Supervisor/process。这个迁移只覆盖 `startup.plugins`，普通 `plugin` 仍在 Session Editor
所在的 Framework 进程内运行。子进程中的 definition、lifecycle、方法和 handler 不会复制到 Host，
跨边界只传 method/handler id 与结构化数据。

### 跨进程数据与 service

IPC 使用 generation-scoped protocol v1 和 advanced serialization，但公开 payload 仍只接受普通
对象/数组、有限数值、字符串、布尔值与 `null`：最大 1 MiB、最多 32 层、最多 256 个 pending
request。不要传函数、class instance、Proxy、accessor、symbol、稀疏数组或循环引用。

`service.register(name, value)` 会经过 `structuredClone` 与同一 IPC 校验，所以 value 不能包含函数
或循环引用。`service.get()` 读取的是异步下发、深冻结的 snapshot；register/unregister 不提供同步
read-your-write，慢插件只会收敛到最新 snapshot。需要确认另一个插件已经处理某次变更时，用
`message.request` 或 `plugin.callPlugin` 的 Promise 返回值，不要轮询 service 当共享内存。

### 故障、清理与恢复

公开进程状态为 `pending`、`starting`、`running`、`restarting`、`failed`、`stopping`、`stopped`。
initialize/load 最长 30 秒，正常 unload/shutdown 最长 10 秒；随后 Host 发送 `SIGTERM`，2 秒未退出
再发 `SIGKILL`。前三次自动重启依次 backoff 250 ms、1 s、4 s；滚动 60 秒内第 4 次失败熔断，
连续运行 5 分钟重置预算。

失败时 Host 固定撤销 lifecycle attachment，清静态 attach，再按 menu、message、service 顺序清理
owner，最后广播新 snapshot。`failed` 可由 Electron 内部控制面调用
`POST /api/application/plugin/retry` 恢复；请求必须带 application token、使用 JSON 且 body 只有
canonical `{ "plugin": "@scope/name" }`，带浏览器 Origin 的请求会被拒绝。

该进程边界是 crash containment，不是权限 sandbox。插件仍是受信 Node.js 代码，以同一 OS 账号
运行，使用 Framework cwd，并拥有该账号的文件系统权限。新插件应优先使用
`ctx.paths.data/cache/temp/legacyData`；这些 owner 专属路径和环境过滤都不是文件访问隔离。

child env 从 Framework 父环境的副本开始，然后删除权威固定 host secret 键和集成方显式提供的
`secretEnvironmentKeys`。固定 Application token、Notification owner token 与 credential transport
secret 不会进入插件 argv/env，但这不是通用 secret detector，也不是只传安全值的 allowlist：未登记
的自定义 token、云凭据等敏感值仍可能被继承。插件开发者不得把敏感值放进普通环境变量；Framework
集成方捕获或新增 host secret 时，必须通过 capture 并在 `secretEnvironmentKeys` 登记变量名，或使用
未来提供的窄化 capability。

### 官方 Kit 与 runner 兼容

官方 Notifications、Scheduler 和 Agent Guard 的现有 startup plugin package 继续走同一 manifest
与 runtime facade，不需要为进程化复制一份实现。为兼容 Scheduler 已发布行为，
`HARBORS_DATA_ROOT` 目前因未列入移除键而与 `PATH`、locale 等父环境一起保留；它不得承载敏感值。
新代码仍应优先使用 `ctx.paths`，不要把 `HARBORS_DATA_ROOT` 当成新的通用插件 API，也不要把 host
token 或云凭据塞入未登记的自定义环境变量。

Web/source 开发从当前 Server 源码解析 `runner.ts` 并使用仓库 `tsx` loader；编译 Server 使用同目录
`runner.js`。packaged Electron 使用自己的 executable 配合 `ELECTRON_RUN_AS_NODE=1`，并从
`Contents/Resources/runtime/packages/server/dist/application/plugin-process/runner.js` 启动。执行
`npm run desktop:prepare` 会先构建 Server，再把本次 runner 放入 desktop runtime staging；不要依赖
手工生成或历史残留的 `packages/server/dist`。

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

`--kit` 是直达快捷方式：它把外部 Kit 临时追加到 Catalog，并在服务就绪后只自动打开该 Kit；
它不会隐藏仓库中的其他 Kit，也不会改变 Web 根页面。使用内置浏览器调试时，从启动日志复制
`Requested Kit` 地址。

检查：

1. Server 能解析 Kit 和全部 plugin package name。
2. bootstrap 返回预期 Kit、Panel 与 Window。
3. request 返回值和 broadcast 更新均能到达 Panel。
4. 打开单实例 Panel 时复用既有实例。
5. 切换 Kit 后旧 Panel、菜单和消息路由不再存在。
6. 主窗口与次窗口都能加载各自 entry。

## Kit 专属文档

Framework 文档只维护通用的 Kit、Plugin、Catalog 与 Host 契约。每个 Kit 的功能、生命周期、
权限、平台限制、资源上限和验证命令由 `kits/<slug>/README.md` 维护；新增或修改产品行为时，
应在对应 Kit 内同步更新。仓库级 Agent 通知流程另见
[notify-user Skill](../../.agents/skills/notify-user/SKILL.md)。

## 参考实现

- `kits/<name>/package.json` 与 `kit.json`
- `kits/<name>/layout.json`
- `kits/<name>/plugins/<plugin>/package.json`
- [共享插件协议](../../packages/plugin-types/src/index.ts)
- 各 Kit 自己的 README
- [notify-user Skill](../../.agents/skills/notify-user/SKILL.md)
