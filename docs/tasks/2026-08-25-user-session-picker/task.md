# 在工作台入口增加用户与 Session 选择

Task ID: `2026-08-25-user-session-picker`
Type: `feature`

## 背景与问题

当前 Web Host 裸入口会在浏览器中自动保留一个 `sessionId`，随后直接让用户选择 Kit。授权系统只识别 `deviceId`，授权管理页面也只展示设备短 ID、IP 和 User-Agent；Framework 没有用户实体、Session owner 或按用户查询 Session 的能力。因此当前界面无法表达“谁正在使用哪个 Session”，同一用户也不能从多个既有 Session 中选择或显式新建工作台。

用户通过浏览器批注明确提出：在现有“选择工作台”页面增加用户 / Session 选择。前序讨论进一步确定目标关系为 `User 1:N Session`：选择用户后，可以继续该用户已有 Session，或由 Server 分配新 Session，再进入所选 Kit。

## 目标

1. 为 Web Host 建立最小用户身份模型，使授权设备可以绑定稳定用户身份与显示名。
2. 为 Framework Session 增加 owner，使一个用户可以拥有多个 Session，并能列出、继续或新建自己的 Session。
3. 在现有工作台入口中增加“用户 → Session → Kit”的选择流程，保留当前页面的视觉语言、响应式行为和键盘可访问性。
4. 保持不同 Session 各自拥有独立 Editor runtime；选择已有 Session 时复用其身份，选择新建时由 Server 分配新 ID。

## 范围

- `packages/server` 中用户身份、设备授权绑定、Session owner、用户/Session 查询与创建 API，以及相应持久化和测试。
- `packages/gateway` 中可信原始客户端地址的代理边界，确保唯一 Web Host 经 Gateway 访问时不会把远程请求提升为本地管理员。
- `packages/plugin-types` 中 Client 可见的最小用户与 Session 摘要协议。
- `packages/client` 中远程设备申请授权时的显示名输入、授权管理中的用户绑定，以及工作台入口的用户/Session 选择、加载、错误和空状态。
- 当前正式 Session/授权架构文档及本 Task 档案。
- 为完成唯一 Web Host 浏览器验收而必需的隔离 Web Host 测试辅助修正。
- 对既有授权设备与无 owner Session 的非破坏兼容策略；旧记录不得因 schema 升级被删除。

## 非目标

- 不在本 Task 引入 Project 实体、Project 权限、多人实时协同、编辑锁或冲突合并。
- 不把用户显示名当作安全身份；安全寻址使用稳定 `userId`。
- 不允许远程设备通过普通工作台入口切换成其他用户；远程身份由已授权设备绑定决定。
- 不改变 Kit descriptor、Kit Plugin 业务协议或 Harness 内部 conversation 模型。
- 不实现云账号、密码登录、SSO、跨 Server 用户同步或互联网身份认证。
- 不引入 Electron、桌面窗口或其他非 Web 宿主假设。
- 不执行 push、创建 PR、发布或整合到本地 `main`；交付动作需后续单独授权。

## 验收标准

1. 用户具有稳定 `userId` 和可编辑显示名；显示名重名不造成身份冲突。
2. 远程设备发起授权时提供显示名，授权者可以将设备绑定到既有用户或创建新用户；授权状态能够返回当前用户的公开摘要。
3. Session 持久记录包含 owner；Server 可以按当前用户列出 Session，并创建属于该用户的新 Session。
4. 远程请求只能读取和使用当前设备所属用户的 Session；未知、无权访问或伪造的用户/Session 请求被拒绝。主机本地管理入口可以查看用户并为其选择或分配 Session。
5. “选择工作台”页面在 Kit 列表前清晰展示当前/所选用户和 Session：可以选择已有 Session，也可以新建 Session；Kit 链接始终携带当前选定的 Session。
6. 选择已有 Session 后刷新页面仍保持该 Session；新建 Session 后无需手工复制 ID 即可进入任意可用 Kit。
7. 无用户、无 Session、加载失败、授权待处理和无权访问均有明确且可恢复的界面状态；键盘操作、焦点样式、窄屏布局和 reduced-motion 保持可用。
8. 既有授权设备和无 owner Session 通过非破坏兼容策略保留；升级不得删除既有 Session、授权记录或运行数据，兼容行为有测试覆盖并在界面中可解释。
9. Server 与 Client 针对性测试、协议类型检查、`git diff --check` 通过，并使用唯一 Web 宿主在浏览器验收完整入口流程。
10. 实际变更限于 Framework Client/Server/协议、必要正式文档和本 Task 目录，不修改 Kit 或 Plugin 业务实现。

## 约束

- Harbors 仅支持 Web 宿主；UI 和共享可见行为必须通过浏览器验收。
- 用户身份由 Server 根据设备授权解析，不能信任客户端直接提交的 `userId`；本地主机管理能力与远程用户能力必须明确分开。
- Session ID 继续是不可猜测的 opaque identifier，不由显示名拼接生成。
- 数据库 schema 升级保持幂等、非破坏，测试必须使用临时数据根，不读取或修改真实用户数据。
- Session runtime 继续由 `SessionRuntimeRegistry` 维护唯一内存映射；路由不得维护第二份 Editor map。
- 保留当前工作区已有的 `.codex/skills/delegate-codex-subagents/**` 用户修改，不 stash、reset、覆盖或纳入本 Task。
- `status.json` 只通过 Task CLI 更新。

## 决策上下文与处置

### Decision Context

- 2026-08-25 查询已批准决策记忆，检索意图为“Harbors 用户身份、设备授权、Session owner、多 Session 与工作台选择”；未命中条目，索引状态为 `partial` 且 `failed_files=1`。该结果不能证明不存在历史决定，且不授权本 Task 自动接受长期身份方案。
- 仓库定向扫描覆盖 `docs/decisions`、`docs/architecture`、`docs/guides`、相关 `docs/tasks`、`packages/server/src/auth`、`packages/server/src/session` 和 `packages/client/src/components/kit-picker.ts`。当前事实是：授权只绑定设备，Session 只保存 workspace/文件列表/时间戳，裸入口在 localStorage 中复用一个浏览器 Session，Kit runtime 可按复合 runtime ID 隔离 Editor。
- `docs/tasks/2026-08-16-agent-chat/task.md` 曾明确把多用户隔离列为该历史 Kit Task 的非目标，仅约束当时范围，不构成 Framework 永久禁止多用户身份的决策。
- ADR `0002-web-only-host` 适用：身份、Session 和入口均只能建立在单一 Web Host 上，不加入 Electron 或桌面生命周期。
- owner：当前主 Agent，来源为本 Task 编排者，负责需求边界、Task 状态、实际 diff 与最终验收。
- reviewer：执行计划中的独立 sub-agent，负责身份边界、兼容策略、UI 可理解性和回归风险审查。
- approver：当前用户，来源为功能提出者，负责确认用户 / Session 入口方向、工作环境和后续交付选择。

### 逐条处置与分工

- **需新增且已由用户提出**：工作台入口增加用户 / Session 选择，用户可以继续既有 Session 或新建 Session。该需求进入 Framework Client/Server，而不是由具体 Kit 实现。
- **适用**：一个 runtime ID 对应一个独立 Editor 的当前架构事实；本 Task增加 Session owner 和选择入口，不把多个 Session 合并为一个 Editor。
- **适用**：Web-only 与 Server 权威状态约束；用户身份和 Session owner 由 Server 持久化并校验，Client 只渲染公开投影。
- **需设计审查**：既有授权设备和 ownerless Session 的兼容归属。要求非破坏、可解释、远程不可越权；具体迁移呈现由 design 阶段比较方案后确定并由 reviewer 复核。
- **不适用**：Project 级资源隔离和多人协同。本 Task 只建立 User 与 Session 的选择、归属和授权链路，不借机宣称 Session 已成为项目安全边界。
- **角色反馈**：用户通过当前 Web 页面批注明确了入口位置与核心动作，属于本 Task 的需求授权；正式身份、兼容和安全语义仍需在设计与验证中以 Server 约束证明。

## 需求变更

- 初始讨论从 Session 是否隔离项目开始，逐步收敛为 `User 1:N Session`。
- 用户最终通过当前工作台页面批注确认：在该入口增加用户 / Session 选择；选择用户后可继续已有 Session 或重新分配一个 Session。本 Task 以该最终入口行为为准，不继续扩展 Project 或实时协作范围。
- consolidation 反向检索发现开发 Gateway 会让 Server 只看到 loopback 上游地址，远程请求可能被误判为本地管理员；该问题直接破坏本 Task 的 owner 安全边界，因此扩围到 Gateway 原始客户端地址传递与真实代理链路测试。
- 浏览器验收发现隔离 Web Host helper 的插件存储根不满足安全目录拓扑，无法启动 Kit runtime；为满足完整入口验收，允许对该测试辅助做最小修正并增加回归覆盖。
