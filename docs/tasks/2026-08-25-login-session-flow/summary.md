# 登录式用户与 Session 入口交付摘要

## 最终结论

工作台入口已从并排管理表单改为三步登录式流程：先选择图标化用户，再选择可继续的 Session，最后选择工作台。Session 可以保持未选；点击“继续选择工作台”时会先创建并选中 Session，因此进入工作台选择页时 Session 始终已经确定。未授权远程设备也使用同一套用户选择体验，但只能选择既有用户并发起待审批申请；批准前不能读取工作数据，批准后设备固定绑定到申请用户。

启动数据语义也已收敛：普通 Dev 与 Production 默认共用 `~/.harbors`，都可用 `--data-root <absolute-path>` 整体切换 Session 数据库、Kit 配置与 Plugin data/cache/temp。Web Host runner 继续默认临时隔离，也可安全复用调用方提供的外部持久根。

## 需求完成情况

- 本地管理入口第一屏只显示用户头像卡片和新用户入口，不显示 Session 或 Kit。
- 选择用户后进入独立 Session 列表；有 Session 时默认选中最近使用的一项，用户仍可明确选择“不选择，创建新 Session”。
- Session 屏和 Kit 屏都提供返回动作；远程用户身份固定，不展示更换用户和授权管理入口。
- 两个返回入口统一放在内容顶部，以“上一步 · 选择用户 / 选择 Session”明确说明返回目标；从 Kit 返回时保留并聚焦当前 Session。
- 选择既有 Session 后直接复用；保持未选时，点击“继续选择工作台”请求 Server 分配并持久化新 Session，成功后才展示 Kit。
- 有效 URL Session 可以恢复 owner、Session 和 Kit 选择步骤；仅 localStorage 有旧值时不再跳过用户登录屏。
- 创建用户、重命名和 ownerless Session 认领继续保留为次要管理动作，context 刷新后恢复原步骤与选择。
- 创建用户和重命名改为用户卡原地编辑，支持 Enter 提交、Escape 取消、输入校验、请求锁定和失败重试，不再依赖浏览器原生 prompt。
- 空用户、空 Session、身份异常、入口加载失败和 Session 创建失败均有可恢复状态。
- 远程未授权首屏只展示已有用户头像，不提供创建、重命名或删除；选择前不产生待审批记录，选择后进入等待页。
- 本机审批明确显示申请用户且不能改绑；拒绝后远程返回用户选择，批准后才进入该用户的 Session 流程。

## 主要改动

- `kit-picker.ts` 改为显式 `user | session | kit` 状态机，并支持跨 context reload 的 `resumeState`。
- Session 步骤负责在无选择时完成 `POST → 持久化 URL/localStorage → 进入 Kit 步骤`；创建期间冻结整个选择区，失败留在原页重试。
- Kit 入口由直接链接改为可访问按钮；Kit 步骤始终持有真实 Session，点击只负责导航，不再创建 Session。
- `index.ts` 只从 URL 恢复 Session，入口失败重试保留当前 resumeState，并提供可执行测试入口。
- UI 增加稳定用户徽记、Session 单选列表、步骤返回、异步 busy/alert、标题焦点、窄屏/safe-area/reduced-motion 样式。
- 步骤返回由标题旁的弱文本调整为有边界的统一导航按钮，宽屏与窄屏位置一致，降低选错后的恢复成本。
- 工作台步骤的返回导航使用与工作台列表一致的 860px 内容宽度，按钮左边缘不再因沿用 Session 页 720px 宽度而向页面中间缩进。
- 用户卡容器、圆形头像/加号、宽高和网格位置始终使用同一 DOM 与样式；卡片无背景、无位移动效，点击“新用户”只以同宽 input 替换 `.kit-user-name`，重命名同理，创建成功后直接进入新用户的 Session 步骤。
- 根 `#app` 使用不可滚动的 `overflow: clip`，避免浏览器在聚焦卡片内输入框时把整页滚动 19px；输入框仅以原位下划线表达编辑状态。
- Host masthead 的垂直内边距统一为上下 18px；输入框移除浏览器 appearance、outline 与聚焦 glow，只保留底部边线明暗变化。
- 用户编辑在 blur 时恢复原名称；完整“重命名 用户名”替换为 hover/focus 时出现的“改 / 删”紧凑动作，触摸设备保持可见。删除使用原位二次确认。
- Session 行增加 hover/focus 时出现的紧凑删除动作，触摸设备保持可见；原位确认后复用现有删除接口销毁运行时和持久状态。删除选中项会清空原选择；若仍有其他 Session，则默认切换到最近使用项，失败时保留原项与选中状态。
- Server 新增 local-admin-only 用户删除端点；仅允许删除无 Session、无授权设备绑定的用户，占用冲突返回 `409 USER_IN_USE`，不级联删除。
- 普通 `pnpm dev` 与隔离 Web Host runner 统一采用“Gateway 对外、上游回环”：Gateway 监听 IPv4 wildcard `0.0.0.0`，Server 与 Vite Client 继续监听 `127.0.0.1`；runner 的 loopback health 控制保持不变。
- 开发栈与 runner 的监听契约已加入根级 Framework 测试命令，防止 Gateway 或上游绑定地址回归。
- 入口测试从源码字符串断言扩展为真实 URL、localStorage、失败重试与状态清理行为测试。
- 远程授权协议拆为精简用户目录、显式申请和纯读状态三部分；公开用户只含 `userId/displayName`，待审批身份首次写入后冻结，同用户重试幂等、不同用户重试冲突。
- 本机 HTTP 审批对新申请强制绑定 `requestedUserId`，拒绝 userId/displayName 覆盖；待审批用户也视为占用，不能在审批完成前删除。
- 远程等待页复用工作台 masthead、网格背景、用户舷窗与排版 token，移除原来的显示名输入卡片。
- `resolveStartConfig` 新增统一 `HARBORS_DATA_ROOT`，从根派生 `harbors.db`、`config.sqlite` 和 `plugins/{data,cache,temp}`；CLI 参数优先于统一环境变量，原有 DB/Plugin 细分变量保留为兼容覆盖。
- Dev 与 Production 增加同语义 `--data-root` 参数解析、绝对路径和重复参数校验；Production 同步使用 Dev 的 credential mode 装配，并让两入口都显式消费 `configDataDir`。
- Web Host runner 改用标准目录形状并返回实际 `dataRoot`；它会清除继承的 DB/Plugin 细分路径，拒绝与临时根发生规范或物理重叠的外部根，停止或启动失败只清理自建临时目录。

## 关键决定

- “不选择 Session”是真正的 null 状态，不提前创建，也不伪装成一个 Session 选项。
- localStorage 只作为已选择 Session 的持久副本，不再在根入口无提示恢复；只有 URL 中的有效 Session 可以跳过前两步。
- 显式 resumeState 优先于 URL 恢复，用于创建用户、重命名和认领后的 context reload，避免回到错误步骤。
- 程序会聚焦新的步骤标题供读屏确认，但非交互标题不显示浏览器默认巨大 outline；所有真实交互控件保留可见焦点环。
- 匿名用户目录的可见性只服务于登录头像；选择用户代表申请该身份，不代表已经取得该用户的 Session。状态 GET 不创建申请、不更新授权设备时间，已授权设备也不能通过申请接口切换用户。
- development / production 是运行方式，不是数据隔离级别；未显式指定时二者读取同一正式根。非默认自定义根不自动导入仓库 legacy 数据，避免隔离启动被旧数据污染。
- data root 只隔离文件数据，不改变 OS Keychain secret 命名空间；“同一根只由一个 Host 使用”当前是运维约束，不是生命周期锁。

## 验证结果

- Client 聚焦测试：3 files、29 tests 通过。
- Client 全量测试：34 files、308 tests 通过。
- Client typecheck 与 production build 通过。
- Server 全量测试：65 files、794 tests 通过。
- Framework 启动/runner 脚本测试：106 tests 通过；Harness 真实 Web Host smoke 通过。
- Production CLI `pnpm start -- --help` 通过，展示统一 `--data-root` 契约且不启动 Host。
- 正式数据切换：卸载自动保活的 `com.harbors.devserver.48381` launchd 任务后，当前 `51817 → 51818` 开发栈成功切到 `~/.harbors`；Server 日志与文件句柄均确认只打开正式 `harbors.db`。
- 浏览器正式数据复验：原 Harness Session URL 刷新后恢复 4 个对话（Project / harbors 3 个、Knowledge 1 个）、既有消息历史与 13/13 Plugin 装配，确认配置和 Agent 对话随统一 Plugin data root 恢复。
- `git diff --check` 与 Task 状态检查通过。
- 浏览器验证：根路径显示用户头像屏；Session 默认未选；点击“继续选择工作台”后 Session 数由 2 增至 3，进入 Kit 列表时 URL 已带新 Session；点击 Default Kit 后仍为 3；选择已有 Session 进入 Harness 后也保持 3。
- 浏览器视觉复验：步骤标题焦点轮廓修复，用户卡片、Session 单选和工作台按钮焦点样式保留。
- 浏览器返回链路复验：Session 页显示“上一步 · 选择用户”，工作台页显示“上一步 · 选择 Session”；逐级返回成功，Session 返回后原单选项仍 checked，返回用户后 URL 清空。
- 浏览器用户编辑复验：点击前后卡片为同一 DOM，卡片、圆形加号、名称/input 的 x、y、宽、高完全相同；`#app.scrollTop` 前后均为 0，卡片计算样式前后均为透明背景且 `transform: none`。只有“新用户”文字原位变成底线输入框；Escape 恢复原文字，Enter 创建链路通过。
- 浏览器细节复验：Host masthead 上下内容留白均为 18px；输入框无 UA appearance、outline 或 glow，键盘焦点仅通过高对比底线显示。
- 浏览器用户动作复验：无操作时不显示管理长文案；用户动作收为“改 / 删”，删除确认原位显示“取消 / 删除”；空闲用户删除后从列表消失，拥有 Session 的用户保留并显示“仍在使用”。
- 浏览器 Session 删除复验：使用一次性用户与 Session 验证列表仅在操作时显示“删”，原位确认显示“取消 / 删除”，确认后 Session 行消失并进入空状态；验收数据随后清理，未改动用户原有 Session。
- 浏览器默认选择复验：进入“验收用户”的 Session 步骤后自动选中最近使用项并同步 URL；点击“不选择，创建新 Session”后单选清空、URL 恢复根路径且 `aria-pressed=true`。
- 网络边界复验：当前 Gateway 显示 `*:51817`，Server/Client 分别保持 `127.0.0.1:51818/51819`；loopback context 返回 `200 local-admin`，主机 IPv4 context 返回 `403 DEVICE_NOT_AUTHORIZED`，浏览器通过 `http://100.83.214.33:51817/` 正常显示“等待主机授权”。
- 远程授权浏览器复验：未授权远程首屏只显示既存“管理员”头像；选择后等待页显示申请用户与设备 ID；本机授权管理显示“申请用户: 管理员”且无身份下拉；批准后远程自动进入“管理员”的 Session 页面。
- 授权安全回归：公开用户响应严格只有 `userId/displayName`；status 不产生写入；同设备不能覆盖 pending 用户或在授权后换用户；审批不能改绑；未知/已删除用户、无 pending、错误 method 和其他远程管理 API 均失败关闭。
- 网络聚焦测试：Web Host runner 4 tests、Gateway 20 tests、Server 授权/访问矩阵 6 tests、dev/runner/CI contract 23 tests 通过。

## 影响与风险

- 变更影响 Web Host 工作台入口 Client，并为用户删除增加一个受限 Server API；不改变身份模型、Kit 或 Plugin。删除默认失败关闭，只在不存在 Session 与授权设备绑定时执行，不级联删除数据。
- Gateway 对局域网开放后，临时开发/验收端口可被同网段设备发现；远程访问仍需设备授权。Server 与 Vite Client 保持回环，避免绕过 Gateway 的转发地址清洗和授权边界；当前仅保证 IPv4 wildcard，不包含 IPv6 双栈。
- 匿名远程登录页会向同网段访问者公开主机上的用户显示名与 opaque userId，用于渲染用户头像；它不会公开 Session、时间戳或工作内容。若未来用户目录需要更强隐私，应另行引入邀请标识或账号认证，而不是扩大本次设备审批模型。
- “继续选择工作台”在未选 Session 时包含异步创建；创建期间 Session 页面全部交互冻结，失败后留在原页重试。Kit 打开动作仅导航。
- 根入口不再从 localStorage 自动跳步，用户会更明确地看到身份选择；带有效 Session 的 URL 仍可直接恢复。
- 自定义 data root 不等同完整凭据隔离，且当前没有跨进程 Host root 锁；部署和手工验收必须避免两个 Host 同时使用一个根。本次发现旧正式 Host 由 launchd keepalive 托管，必须先卸载任务而不是只终止子进程。

## 偏差与遗留

- 用户徽记使用稳定首字母与受控色阶，不支持头像上传，符合本 Task 非目标。

## 后续关注

- 若用户数量显著增加，可单独设计搜索、最近用户或分页；当前登录式卡片适用于主机上的小规模用户集合。

## 相关正式文档

- `docs/architecture/system-overview.md`：记录 Web Host 的“用户 → Session → Kit”入口顺序，以及远程精简用户目录、显式申请与审批后访问边界。
- `docs/architecture/kit-and-session-model.md`：记录匿名远程申请身份不等于取得 Session 权限，以及批准后设备身份固定。

## blocking

- 无。

## non_blocking

- 根级 `test:framework:prepared` 在当前工作区执行到未受本次影响的 `@itharbors/host-security` 时，因该包缺少本地 `node_modules/vitest` 链接而中断；本次相关 runner、Gateway、Server 访问矩阵、Client 与 contract 测试均已独立通过。

## decision_candidates

- **用户删除的长期数据策略**：当前实现采用保守策略，存在 Session 或授权设备时返回冲突；若未来需要“一键删除用户及其全部数据”，必须另行明确 Session、运行中 Editor、设备授权和 Plugin 用户数据的清理边界。推荐维持当前阻止删除策略。

## follow_up

- 用户规模扩大时再评估用户搜索或最近用户能力；当前不自动创建后续 Task。

## Decision Delta

- **Task-only｜登录式三步入口**：来源为用户明确否定并排下拉框版本并要求“用户图标 → Session 列表 → 工作台”；影响 Client 入口结构、状态与样式；状态为已实现并通过浏览器与自动化验证；落点为本 Task、`kit-picker.ts` 与对应测试；反向检索 `用户 → Session → Kit` 命中 `docs/architecture/system-overview.md`，确认流程顺序与长期模型一致。
- **Task-only｜进入工作台选择页前确定 Session**：来源为用户澄清“不选 Session 时，进入工作台页面就应该选择了”；影响 Session 继续动作与 Kit 点击时序；状态为已实现，浏览器以继续前后及 Kit 点击前后的 Session 数量验证；落点为本 summary、Client 实现和行为测试；反向检索 `Server 分配` 与 `opaque Session ID` 命中 `docs/architecture/kit-and-session-model.md`，确认 Client 没有自行生成 ID。
- **Task-only｜仅 URL 恢复入口步骤**：来源为计划审查对 localStorage 隐式跳步的识别，并依据用户要求选择登录式首屏；影响根入口刷新体验；状态为已实现和测试；落点为本 summary、`index.ts` 与入口行为测试；反向检索未发现把 localStorage 自动恢复规定为正式架构规则，因此保持 Task-only。
- **Task-only｜显式可逆步骤**：来源为用户指出选错后必须能还原；影响 Session 与 Kit 步骤的返回入口、文案和视觉层级；状态为已实现并完成浏览器逐级返回验证；落点为本 summary、`kit-picker.ts`、样式与行为测试。
- **Task-only｜用户卡原地编辑**：来源为用户在 Web Host 中确认“新用户”点击无效，并进一步否定额外展开的大型表单；影响创建与重命名交互；状态为已修复并完成 Escape/Enter 与真实创建验收；落点为本 summary、`kit-picker.ts`、样式与行为测试。
- **Candidate｜用户删除数据策略**：来源为用户要求在用户卡提供删除动作；决策记忆未检索到既有规则，且索引为 partial、1 个文件失败；当前实现只删除无 Session、无授权设备绑定的用户，不级联清理；长期落点待 approver 决定，当前保持 candidate。
- **Task-only｜Session 显式删除**：来源为用户要求 Session 列表提供删除能力；决策记忆未检索到既有约束，且索引为 partial、1 个文件失败；实现复用既有受访问策略保护的 `DELETE /api/session/:id`，原位二次确认后销毁运行时与持久状态，删除当前选中项同步清空 Client 选择与 URL；落点为本 summary、Client 实现及行为测试。
- **Task-only｜默认继续最近 Session**：来源为用户要求“如果有 Session，默认选一个”；Session 步骤按 `lastAccessAt` 降序排列并默认选中首项，同时保留显式创建新 Session 的覆盖入口；落点为本 summary、Client 状态逻辑与行为测试。
- **Architecture｜Gateway 对外、上游回环**：来源为用户明确要求 Web Host 不限制回环并监听所有地址；决策记忆未检索到既有约束，索引为 partial、1 个文件失败；普通开发栈与隔离 runner 仅将 Gateway 绑定 `0.0.0.0`，Server/Vite 固定 `127.0.0.1`，真实远程请求仍进入设备授权；正式落点为 `system-overview.md`、`harness-kit-assembly.md` 与 `testing.md`，当前只承诺 IPv4。
- **Architecture｜远程选择用户后显式申请**：来源为用户要求远程入口同样选择用户、不能新建、选完等待审批；匿名端只读取 `userId/displayName`，选择后才创建绑定当前设备与申请用户的 pending，status 保持纯读；本机批准只能绑定申请身份，批准前不开放 Session。正式落点为 `system-overview.md`、`kit-and-session-model.md`、Server auth 路由与 Client 远程入口。
- **Architecture｜运行模式与数据根解耦**：来源为用户确认 Dev 不应天然读取另一套目录，是否使用正式数据应由启动参数控制；Dev 与 Production 默认统一为 `~/.harbors`，二者共享 `--data-root` / `HARBORS_DATA_ROOT`，runner 默认临时隔离。非默认根不导入 legacy 数据，Keychain 不随根隔离。正式落点为 ADR 0002、系统架构、运行流程、配置/Plugin/Session 模型与开发测试指南。
