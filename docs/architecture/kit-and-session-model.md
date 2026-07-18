# Kit 与会话模型

Kit 决定一个编辑器会话拥有哪些产品能力；session 决定这些能力和运行时状态彼此隔离。
两者结合后，ITHARBORS 可以在同一 Server 进程中承载不同配置的工作台。

## Session 的两层状态

| 层 | 内容 | 存放位置 |
| --- | --- | --- |
| 持久元数据 | `sessionId`、workspace path、已保存文件列表、创建与访问时间 | SQLite `sessions` 表；文件数据库可跨重启保存 |
| 运行时状态 | Editor、当前 Kit、插件、窗口、消息、菜单、i18n | `SessionRuntimeRegistry` 管理的 Server 内存 |

SessionManager 的 `getOrCreate` 负责持久元数据；`SessionRuntimeRegistry` 负责同一 Session
并发创建去重、Editor 注册和统一销毁。Server 重启后 SQLite 行仍可存在，但运行时会在
下一次初始化时重新构建。路由可读取注册表的只读 Editor 视图，但不能独立维护第二份 map。

## Editor 是隔离容器

每个 Editor 拥有独立的：

- PluginModule 与外部插件列表；
- PanelModule、MessageModule、MenuModule；
- KitModule 与当前 Kit；
- WindowManager；
- editor 级 config layer 与 i18n 状态。

当前实现有一个显式例外：config 的 shared layer store 位于装配模块级，可被多个 Editor
共享。新增共享状态应同样明确命名和约束，不能依赖全局变量的偶然可见性。

## Kit manifest

Kit package 的核心结构：

```json
{
  "name": "@itharbors/kit-default",
  "ce-editor": {
    "kit": {
      "layouts": {
        "default": "layout.json"
      },
      "windowEntries": {
        "main": "main.html",
        "secondary": "secondary.html"
      },
      "plugin": [
        "@ce/log",
        "@ce/plugin-list"
      ],
      "theme": {
        "--ce-bg-primary": "#1e1e1e"
      }
    }
  }
}
```

约束：

- `name` 和 `ce-editor.kit` 必须存在。
- `layouts` 必须是对象且包含 `default`。
- `windowEntries.main` 与 `secondary` 必须是非空字符串。
- `plugin` 缺省为空数组。
- theme key 使用 `--ce-*` token。

## Kit 解析

传入值像路径时，resolver 先尝试该路径并要求存在 `package.json`。否则在 assembly
配置的 builtin kits 和 kits 目录中枚举一级子目录，使用目录名或 package name 匹配。

默认 assembly 的两个 Kit 目录都指向仓库 `kits/`，默认 Kit 是
`@itharbors/kit-default`。装配配置保留了分离 builtin 与外部目录的能力。

## 插件范围

### 内置插件

`@ce/panel`、`@ce/message`、`@ce/menu`、`@ce/config` 由 Editor 装配层确保装载。
它们提供框架级贡献点，在 Kit 切换时保持可用。

### Kit 外部插件

Kit 的 `plugin` 列表按顺序解析。当前解析目录优先级为：

1. assembly `builtinPluginsDir`；
2. assembly `pluginsDir`；
3. 当前 Kit 下的 `plugins/`。

解析以 package `name` 和 `ce-editor` 字段为准，不使用 Node.js 的隐式模块解析。

## Layout 与窗口入口

每个命名 layout 文件被读取并标准化。第一个未声明 kind 的 window 默认为 `main`，
后续默认为 `secondary`；缺省 entry 根据 kind 取 Kit 的 main 或 secondary HTML。

装载成功后，WindowManager 使用 `layouts.default.windows` 初始化。调用
`kit.applyLayout("name")` 时只提取该布局中的 main window layout，并重排当前 main
window。

## 切换不变量

- 先确保内置插件可用。
- 在修改当前 Kit 前解析、校验并注册全部新插件路径。
- 旧外部插件按装载逆序卸载。
- 插件卸载后按 owner 清除 panel、message 和 menu 贡献。
- 新插件按 Kit 声明顺序装载。
- 解析、旧插件卸载或新插件装载失败时，清理本次集合并恢复完整旧集合。
- 只有新集合完整装载后才注册/激活 Kit 并重建 WindowManager。

恢复成功后，当前 Kit、WindowManager 与外部插件列表都保持切换前状态。恢复也失败时，
Editor 被标记为不可继续服务，错误同时包含切换与恢复原因；调用方必须销毁该 Session。
插件自身的 `unload`/`detach` 仍必须幂等并清理外部资源。

## 销毁生命周期

`DELETE /api/session/:id` 先拒绝该 Session 的 browser request、关闭 SSE，再调用注册表销毁
Editor 和持久元数据。`Editor.dispose()` 幂等，阻止新变更，尽量卸载全部插件并清理菜单、
消息、Panel、i18n、配置、Kit 与窗口引用；多个清理失败通过 `AggregateError` 汇总。

Server 停止时注册表只销毁内存 Editor，不删除可持久化 Session 行，随后关闭 SSE、
BrowserRequestBroker 和数据库。

## 源码索引

- [Session store](../../packages/server/src/session/store.ts)
- [Session manager](../../packages/server/src/session/manager.ts)
- [Session runtime registry](../../packages/server/src/session/runtime-registry.ts)
- [App 中的 Editor 创建](../../packages/server/src/app.ts)
- [Editor 与 Kit 装载](../../packages/server/src/editor/index.ts)
- [Kit 类型](../../packages/server/src/framework/kit/types.ts)
- [Kit 标准化](../../packages/server/src/framework/kit/index.ts)
- [Kit/plugin resolver](../../packages/server/src/plugin/resolver.ts)
- [默认 Kit manifest](../../kits/default/package.json)
- [默认布局](../../kits/default/layout.json)

关联阅读：[插件运行时模型](./plugin-runtime-model.md) ·
[布局模型](./layout-model.md)
