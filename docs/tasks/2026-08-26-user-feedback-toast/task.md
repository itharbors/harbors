# 工作台操作反馈改为浮层 Tips

Task ID: `2026-08-26-user-feedback-toast`
Type: `feature`

## 背景与问题

工作台入口的用户与 Session 操作目前把失败文案插入卡片操作区或步骤正文。用户删除被授权设备占用的兼容用户时，只看到“仍在使用”等短文案；反馈既没有解释阻塞原因和恢复动作，又会占据布局位置、造成卡片抖动。用户明确要求把保存与操作结果展示清楚，并改为弹出的 Tips，不在固定位置占位。

## 目标

1. 为工作台入口提供统一的临时浮层反馈，用明确文案呈现用户与 Session 操作的成功或失败结果。
2. Tips 不参与卡片和步骤正文布局，不因显示或消失造成页面重排。
3. 失败反馈说明可执行的下一步，例如用户仍绑定授权设备时提示先到“授权管理”撤销设备授权。
4. 保持键盘、读屏、窄屏和 reduced-motion 场景可用。

## 范围

- `packages/client/src/components/kit-picker.ts` 中用户创建、重命名、删除及 Session 创建、删除的瞬态操作反馈。
- `packages/client/src/styles/kit-picker.css` 中与工作台 Tips 容器、状态色、定位、动效和响应式相关的样式。
- `packages/client/tests/components/kit-picker.test.ts` 中相应行为与无布局占位断言。
- 本 Task 的 `task.md`、`status.json`、`.work/**` 和收口阶段的 `summary.md`。

## 非目标

- 不修改用户、授权设备或 Session 的持久化模型和迁移策略。
- 不改变用户删除的 Server 约束，不自动撤销设备授权或删除 Session。
- 不把页面级加载失败、身份失效、删除确认等需要持续处理的阻塞状态改成自动消失的 Tips。
- 不修改 Kit、Plugin 业务实现或消息协议。
- 不执行 push、创建 PR 或整合到本地 `main`；交付动作需要后续单独授权。

## 验收标准

1. 用户创建、重命名和删除成功后显示简洁、动作一致的成功 Tips；失败时显示清晰的失败 Tips。
2. 删除被授权设备、Session 或待授权请求占用的用户时，提示说明用户仍在使用，并指引先处理关联资源，而不是只显示“仍在使用”。
3. Session 创建或删除失败使用相同的浮层反馈机制；现有页面级阻塞错误仍保留原位置。
4. Tips 使用合适的 `role` / `aria-live` 语义；连续反馈可被替换或排队，不产生重复残留节点。
5. Tips 固定在工作台可视区域内，不参与 `.kit-user-grid`、卡片操作区或步骤正文排版；窄屏不溢出视口。
6. 动画克制且支持 `prefers-reduced-motion`；成功与失败不只依赖颜色区分。
7. Client 针对性测试、类型构建、`git diff --check` 通过，并使用唯一 Web 宿主在浏览器验收用户操作反馈。
8. 变更限制在 Framework Client 和本 Task 档案内。

## 约束

- Harbors 仅支持 Web 宿主；共享可见行为必须通过 Web 浏览器验收。
- 反馈文案使用用户可理解的动作和恢复路径，不暴露内部错误堆栈、设备完整标识或其他敏感信息。
- Tips 是瞬态操作反馈，不替代确认对话、长期错误状态和表单字段级校验。
- 保留当前工作区已有改动；不得 stash、reset、清理或覆盖用户文件。
- `status.json` 只通过 Task CLI 修改。

## 决策上下文与处置

### Decision Context

- 2026-08-26 仓库检索意图为“工作台入口、用户与 Session 操作反馈、toast/tips、aria-live、页面级错误”。扫描覆盖 `docs/decisions`、`docs/architecture`、`docs/guides`、相关 Task、`packages/client/src/components/kit-picker.ts`、`packages/client/src/styles/kit-picker.css` 与对应测试。
- 已批准 ADR 中仅 `0002-web-only-host` 直接适用：反馈必须在唯一 Web 宿主内完成，不引入桌面通知或 Electron 假设。仓库没有统一 Toast 组件或已批准的全局瞬态反馈规范；现有 `ce-tooltip` 只处理悬停说明，不适合操作结果。检索质量为完整本地路径扫描，未发现需要外部决策记忆才能解释的缺口。
- 当前实现事实：用户删除失败把 `kit-user-action-error` 插入卡片操作区，Session 删除失败使用 `kit-session-action-error`，Session 创建失败使用正文 `kit-creation-error`；这些反馈机制不统一且会参与布局。
- owner：当前主 Agent，负责需求边界、Task 状态、实现 diff 与最终验收。
- reviewer：执行计划中的独立审查角色，负责可访问性、反馈生命周期、文案和回归风险审查。
- approver：当前用户，负责确认浮层 Tips 方向、工作环境和后续交付选择。

### 逐条处置与分工

- **适用**：Web-only Host 约束；Tips 作为 Client UI 行为实现，不连接系统通知。
- **需新增且已由用户提出**：瞬态操作结果改为不占位的浮层 Tips，并使用清晰文案。
- **适用**：失败状态必须提供恢复路径；用户被设备占用时明确引导到“授权管理”。
- **不适用**：`ce-tooltip` 依赖悬停/聚焦解释控件，不能承担异步保存和删除结果。
- **不适用**：页面级加载失败与身份不可用需要持续展示，不能被自动消失的 Tips 替代。
- **角色反馈**：用户在真实工作台页面观察到删除失败反馈不清晰且占位；该反馈直接形成需求与验收标准，但不自动成为仓库级 ADR。

### 过程关联

- 浮层反馈结构与生命周期映射到 `kit-picker.ts` 实现及组件测试。
- 定位、状态区分、窄屏和 reduced-motion 映射到 `kit-picker.css` 与真实浏览器验收。
- Server 删除约束保持不变；测试只验证 Client 对既有错误码的可操作文案投影。

## 需求变更

- 初始需求来自真实工作台删除失败场景：操作反馈应展示清楚，并以弹出 Tips 呈现，不在卡片或正文位置占位。
- Task 定义将该要求收敛为工作台入口内用户与 Session 瞬态操作反馈统一；页面级阻塞状态、确认交互和数据模型明确排除在外。
