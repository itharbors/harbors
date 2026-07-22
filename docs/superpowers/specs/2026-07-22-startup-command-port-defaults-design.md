# 启动命令与默认端口调整设计

## 目标

以 `npm run start` 作为日常稳定桌面端入口，保留 `npm run dev` 作为隔离开发桌面端入口，并将两套默认端口迁移到较少冲突的高位端口。

## 命令契约

| 命令 | 用途 | 说明 |
| --- | --- | --- |
| `npm run start` | 日常稳定 Electron | 新的正式稳定启动入口。 |
| `npm run dev` | 隔离开发 Electron | 保持现有开发语义。 |
| `npm run dev:web` | 隔离浏览器开发栈 | 保持现有开发语义。 |
| `npm run electron` | 旧稳定入口 | 保留为 `start` 的兼容别名。 |

## 默认端口

| 运行配置 | Gateway | Server | Client | Notification Host |
| --- | ---: | ---: | ---: | ---: |
| `stable`（`npm run start`） | 48380 | 48381 | 48382 | 48383 |
| `development`（`npm run dev` / `npm run dev:web`） | 49380 | 49381 | 49382 | 49383 |

这两组端口均位于非特权高位范围，彼此完全不重叠。端口覆盖变量仍严格限定为 `HARBORS_GATEWAY_PORT`、`HARBORS_SERVER_PORT`、`HARBORS_CLIENT_PORT` 与 `HARBORS_NOTIFICATION_PORT`；每个值必须为 1–65535 的整数，且同一运行配置内不得重复。

## 实现边界

`scripts/lib/runtime-ports.mjs` 继续作为唯一默认端口来源。所有启动器从运行配置解析端口，Gateway、Server、Vite 和 Notification Host 不引入额外硬编码。

`npm run kill` 只清理开发 Web 栈的默认端口 49380、49381、49382，永远不关闭稳定实例或开发 Electron 的 Notification Host。

## 文档与验证

README、开发指南和运行流程说明将统一使用 `start` 作为稳定入口和新的两组端口。测试覆盖端口解析、`start`/`electron` 命令契约、开发清理边界及文档所述端口。验证时稳定与开发端口组必须可并行监听，开发 Gateway 健康检查可用，停止开发栈后稳定端口仍保持监听。
