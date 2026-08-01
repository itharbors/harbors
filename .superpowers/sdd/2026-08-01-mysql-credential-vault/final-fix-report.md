# MySQL 系统凭据状态恢复：最终修复报告

## 状态

已完成最终 Important 修复：凭据能力现在反映真实系统后端状态，锁定或暂时不可用的后端可在同一进程内恢复；状态和原因可通过插件边界到达 MySQL Core 与 Connection Panel；面板在凭据操作失败后会刷新状态，并为可恢复状态提供显式重试。

## 根因

1. 原生 keyring 适配器只验证模块与导出对象是否存在，没有向操作系统后端发起只读健康探测。
2. `CredentialVault` 将初始化或操作期间的不可用原因永久锁存，同时丢弃已加载适配器或 loader，后端恢复后仍然只能重启进程。
3. 插件凭据 facade 只有 `available` 布尔值，无法传递 `locked` 与 `unavailable` 的区别和受控原因。
4. MySQL Connection Panel 只在挂载时读取一次能力；凭据操作失败后不刷新，也没有可恢复状态的重试入口。

## 修复

- 使用固定 service 与保留 health account 做只读 `get` 探测；探测路径不会 `set`、`delete`，也不会把业务 profile account 用作健康检查。
- 仅依据受控的原生错误 `code` / `name` 分类 locked、unavailable 与 not-found；不读取或传播原生错误消息，未知错误统一映射为 `CREDENTIAL_OPERATION_FAILED`。
- Vault 保留 adapter 与 loader：已锁存的 locked/unavailable 在下一次能力查询或凭据操作时重新探测，成功后清除锁存状态；并发探测共享同一 Promise。
- `close()` 会等待在途探测或操作完成，并禁止关闭开始后重新装载或重新开放后端。
- `PluginCredentialVault.capability()` 通过 revocable facade 传递完整 `mode/status/available/reason`；撤销后返回稳定的 local/unavailable 快照。
- MySQL Core 保留完整凭据能力，不再把 locked 降级为普通 available/unavailable 布尔值。
- Connection Panel 在受控凭据错误后立即刷新能力并退出 saved 模式；locked/unavailable 提供“重新检测”，重试只读取 capability 与 profile metadata，不读取 secret、不写 storage、不自动连接。
- README、架构、设计与执行计划同步记录恢复语义。

## TDD 证据

先写失败测试，再修改生产代码。

- Server RED：类型检查因缺少 `CREDENTIAL_HEALTH_ACCOUNT`、`probeKeyringAdapter` 与 facade `capability()` 失败。
- MySQL RED：83 个 focused tests 中 5 个失败，覆盖 Core 丢失 mode/status、locked 被误报 available、Panel 无重试，以及操作失败后不刷新 capability。
- 首次 Server 全套运行还暴露一处既有 leak-regression 语义需要更新：现在允许唯一的保留 health account，并新增断言该 account 只能执行 `get`，绝不能执行 `set/delete`。

关键回归覆盖：

- locked 后解除锁定，同一进程中的下一次凭据操作成功。
- unavailable 后恢复时复用已加载 adapter，loader 只调用一次。
- 初次模块导入失败后可重试 loader。
- 并发 capability/list/close 共享恢复探测，关闭期间不会重新开放。
- 插件边界保留 locked/unavailable 原因，撤销后行为稳定。
- Panel 操作失败后刷新；显式重试恢复 saved profile UI。
- 重试期间 profile password 的恶意 getter 读取次数为 0，storage 读写为 0，自动连接次数为 0；只有用户随后点击已保存连接才发起连接。

## 最终验证

- `npm run test -w @itharbors/server`：46 个文件、427 个测试通过。
- `npm run test -w @itharbors/kit-mysql`：14 个文件、182 个测试通过；1 个 runtime integration 因未设置 `MYSQL_TEST_URL` 按既有条件跳过。
- `npm run build -w @itharbors/kit-mysql && npm run build -w @itharbors/server`：通过。
- `npm run build`：整仓通过。
- `git diff --check`：通过。
- `npm run dev:web -- --kit ./kits/mysql` 默认 `off` 浏览器冒烟：1440×900 下手工连接、TLS 往返与不可达主机受控错误通过；off 状态没有重试或 saved controls，页面无横向或纵向溢出。

## 安全与并发自查

- health probe 只做固定 account 的 `get`；生产代码没有健康探测写路径。
- 原生错误消息不跨越凭据边界；只返回 allowlist 中的稳定错误码与安全原因。
- 恢复重试不读取密码、不持久化连接信息、不触发自动连接。
- `off` 模式仍在 loader、keyring 与数据库初始化之前短路。
- 并发恢复、关闭排空和关闭期间不重载均有定向测试。

## 剩余验证边界

- 未对真实 macOS Keychain 的现场锁定/解锁做破坏性手工操作；恢复路径由可控 adapter 回归测试覆盖。目标平台若返回 allowlist 之外的新原生错误 code/name，会安全降级为 `CREDENTIAL_OPERATION_FAILED`，后续可根据现场证据扩充分类。
- 未连接真实 MySQL；需提供 `MYSQL_TEST_URL` 才会运行现有 runtime integration。
- 1024×720 探索视口显示现有固定连接栏会隐藏最右侧 TLS/连接控件；本次 `off` 状态不渲染新增重试控件，因此不是本修复引入，未扩大范围处理。
