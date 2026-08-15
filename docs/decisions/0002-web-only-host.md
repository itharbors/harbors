# ADR 0002：主程序收敛为单一 Web host

- 状态：已接受
- 日期：2026-08-15
- 决策者：项目维护者

## 上下文

仓库同时维护 Web 与 Electron 宿主、桌面打包更新、原生窗口和通知 Host、Kit 本地市场与多套启动路径。大量代码和测试只负责宿主差异，主程序发布与 Kit 相关流程也形成两条独立链路。

## 决策

1. Harbors 只支持 Web host。
2. `pnpm run dev` 与 `pnpm run dev:web` 使用浏览器开发栈；`pnpm start` 直接启动 Web Server。
3. 仓库只内置 `default` Kit；其他 Kit 作为独立源码目录维护。
4. 删除 Electron、桌面打包、自动更新、Tray、BrowserWindow、桌面 IPC、Notification Host 和桌面 Kit Manager。
5. 保留通用的 Kit descriptor、制品校验与本地打包能力，不建立远程 Kit 发布流程。
6. Server 运行数据写入 `.data/`，不得进入源码目录或 Git。

## 替代方案

### 继续维护双宿主

未采用：共享路径之外仍需维护桌面生命周期、原生桥接、打包签名与额外验收矩阵，成本与当前目标不匹配。

### Electron 作为可选兼容层

未采用：兼容层仍会固化桌面类型、依赖和发布约束，无法真正简化 Framework 边界。

## 影响

- 浏览器成为唯一受支持交互入口，开发和验收默认使用 `pnpm run dev:web`。
- 不再提供托盘、多原生窗口、桌面通知、自动更新或签名桌面安装包。
- Client 不依赖 Electron bridge，插件子进程始终使用 Node。
- Kit 制品仅用于本地校验、分发或导入，不触发远程 Release、Tag 或 Registry 发布。
- 旧桌面发行和本地安装文档不再描述当前能力。

## 关联

- [系统架构](../architecture/system-overview.md)
- [核心运行流程](../architecture/runtime-flows.md)
- [Web Server 入口](../../packages/server/src/start.ts)
- [ADR 0001：插件优先架构](./0001-plugin-first-architecture.md)
