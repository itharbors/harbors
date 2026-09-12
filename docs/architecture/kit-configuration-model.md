# Kit 配置持久化模型

本文记录当前已实现的 Kit 配置声明、存储解析和运行时生命周期。它描述的是
`kit.json`、Web 宿主、Framework 与配置 backend 之间的边界，不扩展模型服务、凭据
或其他产品入口兼容设计。

## 目标与范围

Kit 可以通过 manifest 声明自己的配置层。Framework 只消费已经装配好的配置 backend，
不直接解释宿主文件系统路径；Web 宿主负责把 manifest 的抽象 storage root 解析为受控的
绝对路径。

当前模型包含：

- `config` 可选声明，schema 版本为 `1`；
- 内存 default 层和 SQLite global 层；
- 同一个 SQLite 文件内按 Kit、层和配置键隔离；
- Kit 切换时对配置层进行 activate/deactivate 事务处理；
- Settings 通过显式层参数写入 default 值，用户修改写入 global 层。

当前模型不包含 project 配置层，也不提供旧 Kit namespace 的自动迁移或入口 alias。

## Manifest 声明

`kit.json` 的 `config` 是可选字段。声明包括：

| 字段 | 含义 |
| --- | --- |
| `schemaVersion` | 配置声明 schema 版本，当前必须为 `1`。 |
| `defaultsLayer` | 默认值所在层；该层必须使用 `storage: null`。 |
| `writeLayer` | 未显式指定层时的写入层；该层必须使用持久化 storage。 |
| `layers` | 层名称、优先级和 storage 声明。名称及优先级不能重复。 |

storage 当前支持两种形式：

```json
{ "storage": null }
```

这表示每次装配得到一个新的内存 backend。持久化 storage 使用 SQLite、宿主提供的
`application-data` root 和安全的相对路径：

```json
{
  "storage": {
    "driver": "sqlite",
    "root": "application-data",
    "path": "config.sqlite"
  }
}
```

`path` 只能是相对路径，不能包含绝对路径、反斜杠、空路径、`.`、`..` 或空路径段。
运行时还会校验解析后的真实目录、父目录和已有文件仍位于 application-data root 内。

### 当前内置声明

`kits/default/kit.json` 和 `kits/harness/kit.json` 当前都声明如下配置：

```json
{
  "config": {
    "schemaVersion": 1,
    "defaultsLayer": "default",
    "writeLayer": "global",
    "layers": [
      { "name": "default", "priority": 0, "storage": null },
      {
        "name": "global",
        "priority": 10,
        "storage": {
          "driver": "sqlite",
          "root": "application-data",
          "path": "config.sqlite"
        }
      }
    ]
  }
}
```

因此当前内置 Kit 只有 default 和 global 两层，没有 project 层。优先级数值越大，读取
时越优先；global 覆盖 default。

## Web 宿主与存储路径

`application-data` 是 manifest 使用的抽象 root，不是由 Kit 或 Plugin 自己解析的路径。
Web 宿主默认将它解析为用户主目录下的 `~/.harbors`，也可由统一启动参数解析为自定义绝对 data root，并通过
`configStorageRoots` 传入 Editor。宿主启动时确保该目录存在。

Framework 只接收抽象的 `ConfigLayerBackend`，由 config-storage 根据 Kit 声明选择内存
backend 或 SQLite backend。这样 Framework 不感知 `~/.harbors`、当前工作目录或其他宿主
路径约定。

直接嵌入或测试调用 `createServer` 时，如果没有显式提供 `configStorageRoots`，服务端会
回退到 `pluginPathRoots.applicationData`；显式提供的 root 必须是绝对路径。正式与开发 Web 入口都从
`HARBORS_DATA_ROOT` 派生并显式传入相同 root，Kit 模型自身不读取启动环境。

## SQLite 数据隔离

持久化层默认使用 `~/.harbors/config.sqlite`；自定义 data root 时使用 `<root>/config.sqlite`。多个 Kit 可以共享同一个 SQLite 文件；表中
每条配置记录由以下组合键唯一确定：

```text
(kit_id, layer_name, key)
```

配置值以 JSON 文本存储。相同 Kit、相同层和相同 key 的写入执行 upsert；删除只影响该
三元组。因而不同 Kit 或不同层之间不会互相覆盖，SQLite 文件共享不会取消 Kit 边界。

SQLite backend 使用 WAL 模式，并在 backend 销毁后拒绝继续读写。数据库无法打开、路径
越界、存储值不是合法 JSON 或 backend 已关闭时，操作失败并返回对应配置存储错误；装配
失败会清理本次已经创建的 backend。

## Framework 配置边界

Framework 的配置模块只管理层排序、读写路由、变更事件和 backend 生命周期：

- 不直接创建或解析 manifest storage 路径；
- 读取未指定层时，按 priority 从高到低返回第一个已有值；
- 未指定层的 `set`/`delete` 路由到 manifest 的 `writeLayer`；
- `get`、`set`、`delete` 暂保留显式层参数，以支持 Settings 向 default 层注入默认值；
- 不提供 Plugin 的 `registerTypes` 配置注册流程。

Settings 的默认值来自 Plugin contribution 的 `defaultValue`。它使用显式的
`'default'` 层写入内存 backend；用户修改写入 `'global'` 层并持久化到 SQLite。重置时
删除 global 值，读取因此回退到 default 值。当前 Settings UI 只暴露 global 选择，不暴露
project 层。

## Kit 切换与事务

Kit 装载配置声明后，Editor 先为新声明创建全部 backend，再调用配置模块的 `activate`。
activate 会立即使新层成为当前层，并返回一次性的事务句柄：

1. 新 Kit 的外部 Plugin 装载成功后调用 `commit`，销毁不再使用的旧 backend。
2. 任一后续装载步骤失败时调用 `rollback`，恢复旧层和旧 write layer，并销毁新 backend。
3. 切换到没有 `config` 声明的 Kit 时调用 `deactivate`；提交会销毁旧层，回滚会恢复旧层。
4. 同一时间存在未决 activate/deactivate 事务时，新的激活操作会被拒绝。

这保证了 Kit 切换过程中，旧配置不会被提前销毁；新配置也不会在插件装载失败后继续
留在当前 Editor 中。

## 接口与源码边界

| 责任 | 实现位置 |
| --- | --- |
| Manifest 类型与 schema 校验 | [`packages/kit-core/src/model.ts`](../../packages/kit-core/src/model.ts)、[`packages/kit-core/src/schema.ts`](../../packages/kit-core/src/schema.ts) |
| 内存 backend、层排序和切换事务 | [`packages/server/src/framework/config/`](../../packages/server/src/framework/config/) |
| storage root 解析、SQLite backend 和隔离键 | [`packages/server/src/config-storage/`](../../packages/server/src/config-storage/) |
| Web root 装配 | [`packages/server/src/start.ts`](../../packages/server/src/start.ts)、[`packages/server/src/index.ts`](../../packages/server/src/index.ts)、[`packages/server/src/app.ts`](../../packages/server/src/app.ts) |
| Editor 在 Kit 切换时激活配置 | [`packages/server/src/editor/index.ts`](../../packages/server/src/editor/index.ts) |
| 内置 Kit 声明 | [`kits/default/kit.json`](../../kits/default/kit.json)、[`kits/harness/kit.json`](../../kits/harness/kit.json) |

## 事实覆盖与验证

| 已实现事实 | 对应章节 | 状态 |
| --- | --- | --- |
| `config` schemaVersion/defaultsLayer/writeLayer/layers | Manifest 声明 | 已覆盖 |
| null 内存层与 SQLite application-data 相对路径 | Manifest 声明、Web 宿主与存储路径 | 已覆盖 |
| Web 使用 `~/.harbors`，Framework 不解析宿主路径 | Web 宿主与存储路径 | 已覆盖 |
| SQLite 按 Kit、层、key 隔离 | SQLite 数据隔离 | 已覆盖 |
| 无 project 层、Settings 默认值注入 | Framework 配置边界 | 已覆盖 |
| Kit 切换 activate/deactivate 事务 | Kit 切换与事务 | 已覆盖 |

该文档的示例与当前两个内置 `kit.json` 的配置声明一致。当前 Kit 只使用 descriptor 中的
现行 ID，不从旧 Kit namespace 自动复制配置、凭据或浏览器布局缓存。文档校验使用
`git diff --check`；实现行为的测试位于 `packages/kit-core/tests/schema.test.ts`、
`packages/server/tests/framework/config.test.ts` 和
`packages/server/tests/config-storage/config-storage.test.ts`。
