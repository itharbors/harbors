# Framework Plugin Runtime 设计

> **2026-11-05 状态说明：** 本文保留 2026-10-22 的历史核对与设计记录。其后本地提交 `1d0dec9` 已修复流式持久化顺序及 Stop 收口；追加的七组真实 Web 复验未执行。严格 Q30 和工具错误场景的浏览器验收仍未闭环。当前实现与验证边界见 [Turn 持久化修复总结](../../2026-10-22-agent-turn-durability/summary.md)。

## 1. 结论

Framework 已支持 Plugin manifest 硬依赖：load 前解析完整依赖图，按稳定拓扑加载、反向拓扑卸载。静态预检失败不触碰旧 Kit；加载失败时新 Kit 不激活，并尝试恢复旧 Kit。只有恢复成功才可继续使用旧 Kit；恢复也失败时 Editor 不可用，必须重建 runtime。

这项设计不改变 callPlugin 的同进程调用模型，也不把 Agent 或 SQLite 业务放进 Framework。

## 2. 为什么需要

早期实现只有 Kit 列表顺序和 `runtime.plugin.callPlugin()`，不能表达“缺少依赖就禁止运行”、检查依赖环或保证反向卸载。当前硬依赖能力解决这些通用问题。

Context Store 是 Agent 的事实存储，不能只依赖约定顺序，因此需要显式 requires。

## 3. Manifest

MVP 使用最简单的 package name 列表：

~~~json
{
  "ce-editor": {
    "requires": {
      "plugins": ["agent-context-store"]
    }
  }
}
~~~

硬依赖不增加独立 Plugin semver 约束。调用授权复用现有 `contribute.message.request` 的 methods 与 callers；Store 的公开 server methods 仅允许 `agent`，不新增另一套 ACL。

Framework 只管理可信 User、基础 Session、Plugin 身份及能力边界。默认持久 data 属于 User + Plugin，同 User 的基础 Session 共享；Conversation schema 和生命周期由 Store Plugin 管理。缺身份失败，旧无 User 路径不回退，依据 [ADR 0005](../../../decisions/0005-plugin-default-boundaries.md)。

## 4. 加载

加载前：

1. 读取并校验所有 Plugin manifests；
2. 建立唯一 package name 映射；
3. 检查 required dependency 存在；
4. 检查自依赖和依赖环；
5. 生成稳定拓扑顺序；
6. 所有静态错误在触碰旧 Kit 之前返回；
7. 按拓扑顺序调用现有 load；
8. 全部 Plugin 成功后按现有事务一次提交新 Kit。

多个无依赖关系的 Plugin 保持 Kit 原列表顺序，避免无关行为变化。

## 5. 卸载与回滚

- 正常卸载使用反向拓扑顺序；
- dependency 或 dependent load 失败时，按本次实际加载顺序反向回滚，并尝试恢复旧 Kit；
- attach/detach 仍用于可选贡献，不承担硬依赖；
- load 和 cleanup 同时失败时，沿用 AggregateError 保留两类错误。

Context Store 或 Agent load 失败时，新 Kit 不进入 active。旧 Kit 恢复成功后才保持可用；恢复失败则清理已恢复部分、将 Editor 标为不可用并 fail closed。AggregateError 保留本次激活错误、恢复错误及清理错误，Host 必须重建 runtime，不能继续使用半恢复实例。当前依据为 `packages/server/src/editor/index.ts` 的 restoreExternalPlugins/loadKit。

运行中的单 Plugin lifecycle 也遵循依赖保护：有 Running dependent 时，直接 unload dependency 或同名替换返回 `PLUGIN_DEPENDENTS_RUNNING`。MVP 不新增 dependent closure restart 事务。任何时刻都不允许 Running Agent 依赖 non-Running Store。

## 6. callPlugin

callPlugin 继续是当前 Session Runtime 内的 Map 查找和函数调用；普通调用方只可见 Running 目标，不能通过直调提前访问 Loading 或 Unloading 实例。

- dependency 必须处于 Running；
- Loading、Unloading、Idle 状态拒绝调用；
- method 不存在时返回稳定错误；
- 异步 rejection 原样传播给调用方；
- 不增加网络、消息广播或序列化；
- 不允许 import 绕过 Plugin lifecycle。

普通 Plugin facade 由 Host 绑定真实 caller，通过 `callPluginFrom` 复用 request 声明和 callers 检查；不能改用同步入口绕过未公开方法或调用者限制。同步 Store 方法仍同步返回，不为此改成消息请求或异步 API。

## 7. 错误

| Code | 含义 |
| --- | --- |
| PLUGIN_DEPENDENCY_MISSING | required Plugin 不在装配集合 |
| PLUGIN_DEPENDENCY_CYCLE | 依赖图存在环 |
| PLUGIN_DEPENDENCY_INVALID | manifest requires 无效 |
| PLUGIN_LOAD_FAILED | Plugin load 失败；Kit 恢复结果另行报告，不能由此推断旧 Kit 可用 |
| PLUGIN_NOT_RUNNING | callPlugin 目标不处于 Running |
| PLUGIN_METHOD_NOT_FOUND | method 不存在 |
| PLUGIN_DEPENDENTS_RUNNING | 目标仍有 Running dependent |

Server 将这些 code 作为激活诊断；Agent 不负责转换 Framework 错误。MVP 保留错误的 code、plugin 和 dependency 字段，并沿用现有 Kit 切换失败呈现与重试入口。

## 8. 验证

- 无 requires 的现有 Plugin 行为不变；
- 单层、多层和菱形依赖；
- 缺失、自依赖和依赖环；
- 稳定拓扑和反向卸载；
- dependency/dependent load 失败回滚；
- callPlugin 在四种 lifecycle 状态下的行为；
- Kit 切换失败后旧 Kit 状态恢复；
- missing/cycle/invalid 等静态错误发生时旧 Kit 零 unload；
- Store 有 Running dependent 时拒绝 unload 和同名替换；
- activation error 保留稳定 code，并可在故障修复后重试；
- Store 或 Agent 失败时新 Kit 不激活；旧 Kit 恢复成功可继续，恢复失败时 isUsable 为 false、保留两类错误且拒绝继续操作；
- Framework 代码和测试不包含 Agent/Context Store 特判。

## 9. 影响范围

现行实现位于 packages/plugin、packages/server/editor 和 Plugin manifest parser；本次 2026-10-22 仅校正文档，不修改源码或重新证明历史测试通过。通用运行时事实见 [Plugin 运行时模型](../../../architecture/plugin-runtime-model.md)。
