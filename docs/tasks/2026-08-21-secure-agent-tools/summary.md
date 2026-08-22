# Agent 本地工具安全边界修复实现总结

## 最终结论

Agent Plugin 的文件、`web_fetch` 和 Bash 工具已完成安全边界与失败语义收口。文件路径现在在词法解析后校验真实
workspace 路径及所有已存在父级，符号链接和不存在目标均 fail closed；网络请求逐跳解析并校验 DNS/IP，手动跟随
有限重定向并有界读取响应；Bash 的非零退出、信号、超时、取消和输出上限均返回失败，不会伪装成成功工具结果。

## 需求完成情况

- 普通文件路径、绝对/`..` 路径、父目录符号链接、目标符号链接和跨边界移动均经过真实路径检查；写入目标的不存在父级也从最近已存在祖先开始校验。
- `web_fetch` 覆盖 IPv4、IPv6、loopback、RFC1918、link-local、保留/文档/组播地址及解析到受限地址的域名；每一跳重定向重新校验，重定向次数、响应字节数和读取超时集中受限。
- Bash 改用可终止的进程组执行；成功仅限退出码为零，非零退出和信号带稳定错误码，超时/取消会终止进程组并抛出失败。
- 新增 Agent Plugin 工具回归测试，覆盖符号链接越界、正常文件路径、SSRF 地址和 Bash 失败语义。

## 主要改动

- `kits/agent-chat/plugins/agent/main/src/adapter/tools.ts`
  - 以 `realpathSync` 和最近已存在祖先校验 workspace 边界，使用 `lstat` 删除链接本身，避免通过路径前缀或先访问后校验绕过。
  - `web_fetch` 使用 Node HTTP(S) 请求、受控 DNS lookup 和手动重定向；限制为最多 5 跳、2 MiB 响应体和 30 秒每跳预算。
  - Bash 使用 detached 进程组、受控 stdout/stderr 缓冲和统一 `ToolExecutionError` 错误码。
- `kits/agent-chat/plugins/agent/main/src/adapter/tools.test.ts`
  - 新增 5 项可复现回归测试。
- `docs/tasks/2026-08-21-secure-agent-tools/status.json`
  - 通过 Task CLI 推进设计和实现阶段。

## 关键决定

- 文件安全检查保留现有权限升级模型：默认 workspace-write 下越界请求必须经过明确的 danger-full-access 审批；未获批准时不执行操作。
- 网络请求采用手动 HTTP(S) transport，以便在连接 lookup 和每一跳重定向前都执行完整地址校验。

## 验证结果

- `pnpm exec tsx --test $(rg --files kits/agent-chat/plugins/agent/main/src kits/agent-chat/plugins/agent/panel.settings/src | rg '\.test\.ts$')`：31/31 通过。
- 严格局部 TypeScript 检查（`tools.ts`、`tools.test.ts`）：通过。
- Agent Plugin 工具测试 bundle：5/5 通过。
- `web_fetch` 公网成功路径（`http://example.com/`）：通过，返回受限文本结果。
- `pnpm --dir kits/agent-chat build`：通过。
- `pnpm --dir kits/agent-chat test:kit`：通过。
- `git diff --check`：通过。
- `pnpm run plugins:build:runtime --force`：被 worktree 既有依赖问题阻塞：`packages/kit-core` 缺少 `semver` 类型声明及 `@itharbors/magnet/manifest` 构建产物；未发现本次 Agent Plugin 类型错误。

## 影响与风险

- 受限路径在现有权限模型下仍可触发一次 `danger-full-access` 审批；未获批准时 fail closed，已批准时表示用户明确扩大授权范围。
- 网络请求改用 Node HTTP(S) 以获得逐跳 DNS 校验；不再依赖运行时 `fetch` 的自动重定向行为。
- 完整 runtime 构建的阻塞来自共享 Kit Core 构建环境，不属于本 Task 允许修改范围；Agent Plugin 聚焦测试、构建装配和局部类型检查已通过。

## 偏差与遗留

无超出 Task 范围的源码变更。未修改 Model Service、Chat、Preview、Framework、Gateway 或 Server。

## 后续关注

修复共享构建环境中的 `semver` 类型与 `@itharbors/magnet/manifest` 产物后，应重新运行完整 `plugins-runtime` 构建门禁。

## 相关正式文档

- [Task 需求快照](./task.md)
