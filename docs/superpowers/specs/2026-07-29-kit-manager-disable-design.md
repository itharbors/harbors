# Kit 管理器停用功能设计

## 目标

已安装且已启用的外部 Kit 可以即时停用，同时保留全部本地版本。停用不是删除：它只从当前 Framework 运行时移除 Kit、关闭该 Kit 窗口并重新加载其余 Kit 窗口。用户随后可从已安装版本中重新启用任意版本。

内置 Kit 不提供停用或删除操作。

## 方案选择

采用独立的 `deactivate(id)` 操作，并沿用现有串行 Runtime 替换边界。

- 不复用 staged uninstall，因为停用不得删除文件或删除安装记录。
- 不让 `activate` 接受空版本，因为这会把两个相反动作和两种输入形态混在同一接口中。
- 独立操作保持 IPC 输入最小，只接受一个合法 Kit ID，也能在审计和错误处理中明确区分启用、停用与删除。

## 状态与事务

Store 新增停用转换：要求目标 Kit 当前存在 active 版本，将该版本记录为 `previous`，删除 `active` 和无效的 `pending`。所有已安装版本、异常版本、通道与自动更新设置保持不变。

运行时流程如下：

1. 校验 Kit ID，拒绝内置 Kit、未安装 Kit和已经停用的 Kit。
2. 记录当前 active 版本，提交 Store 停用状态并关闭目标 Kit 窗口。
3. 通过 Runtime Coordinator 串行构建并启动不含该 Kit 的新 Framework generation。
4. 成功后发布新 generation；Manager 列表显示“已安装”，并默认选中最后启用版本。
5. 若构建或启动失败，恢复原 active 版本，重新启动旧 generation，并重新打开此前关闭的目标窗口。界面显示可重试错误。

停用完成后无需重启应用。应用在步骤 2 之后意外退出时，持久化状态已经是停用，下一次启动不会加载该 Kit。

## 接口边界

- Runtime Coordinator 新增 `applyDeactivation(id)`，与启用和删除共用 FIFO 队列。
- Live Kit Manager 新增 `deactivate(id)`，负责合法 ID 与内置 Kit 边界。
- IPC 与 preload 新增固定的 `harbors:kit-manager:deactivate` 通道；Renderer 不能提交路径、版本、窗口或运行时参数。
- Kit Manager API 由六个操作扩展为七个：`list`、`refresh`、`install`、`activate`、`rollback`、`deactivate`、`uninstall`。

## 界面行为

- 已启用的外部 Kit 在操作区显示“停用”，点击前提示会关闭该 Kit 窗口并重新加载其他 Kit 窗口。
- 停用完成后状态显示“已安装”，历史版本下拉默认选中最后启用版本，主按钮显示“启用此版本”。
- 已启用时选择另一个历史版本仍显示“切换到此版本”。
- “删除”继续删除全部已安装版本；视觉上与“停用”保持明确区分。
- 操作期间沿用全局 busy 状态，防止停用、切换、安装和删除并发触发。

## 验证

- Store：停用保留版本并记录最后启用版本；未启用、缺失和 uninstall pending 状态拒绝停用。
- Coordinator：停用与启用、删除共享 FIFO，并在 dispose 后拒绝新请求。
- Electron：成功时关闭目标窗口并发布不含该 Kit 的 generation；失败时恢复 Store、Runtime 和窗口。
- IPC/preload：只接受一个合法 Kit ID，sender ownership 与错误封装保持不变。
- View：已启用显示“停用”，停用后显示“启用此版本”，确认文案和投影刷新正确。
- Acceptance：安装、停用、重新启用、历史版本切换和删除均在实际 Framework generations 中完成。

## 非目标

- 不暂停 Kit 后台任务并保留其 Runtime；停用会完整卸载该 Kit。
- 不新增按版本删除、自动停用或批量停用。
- 不改变内置 Kit 的生命周期。
