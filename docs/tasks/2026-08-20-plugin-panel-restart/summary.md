# 插件重启时恢复 Web 面板

## 最终结论

普通 Session 插件继续使用既有 `unload → load` 生命周期。Framework 将 Panel contribution 的注销与重新注册投影为面板可用性事件，Web Client 据此定点销毁、占位并恢复目标 iframe。

## 需求完成情况

- unload 注销面板后显示“插件未加载”。
- load 重新注册面板后创建带新 revision 的 iframe。
- 布局、Tab、激活状态和运行中的 Panel Instance 不因普通重启而删除。
- 无关插件 iframe 不重建。
- 重复和旧 revision 事件被忽略。

## 主要改动

- Panel registry 增加 available/unavailable 订阅事件与单调 revision。
- Session SSE 增加 `panel-availability-changed` 协议。
- `EditorApp` 定点更新普通、嵌套、secondary 与 floating panel。
- `ce-panel` 增加 unavailable 占位表现。
- 增加 Framework、Editor、Panel、Floating Panel 与 EditorApp 回归测试。

## 关键决定

- 不新增插件 `restart` 生命周期。
- 保留面板布局与实例，仅销毁 iframe 运行环境。
- 恢复 URL 加入 `panelRevision`，确保新 iframe 使用本次注册对应的资源。
- 不通过整棵 `EditorApp` 重绘实现刷新。

## 验证结果

- Server Panel/Editor 聚焦测试：7 项通过。
- Client Panel/Floating/EditorApp 聚焦测试：4 项通过。
- Server 与 Client typecheck 通过。
- plugin-types、Server、Client production build 通过。
- Web 浏览器真实重启 `chat`：收到 unavailable revision 7、available revision 8；`chat.main` 恢复为新 iframe，`conversation.list` 未变化。

## 影响与风险

- 变更只影响 Session Panel registry 与 Web 面板投影，不改变 Application startup plugin 进程模型。
- 如果浏览器恰好在极短的 unavailable 窗口刷新，bootstrap 不包含已注销 descriptor；普通布局会在 available 事件后恢复，但未渲染的 floating instance 仍存在客户端重建边界风险。

## 偏差与遗留

- 用户授权直接在本地 `main` 修改，未使用基于 `origin/main` 的独立 worktree。
- 未扩展为跨刷新持久化 unavailable Panel descriptor；该场景不属于本次普通 restart 验收范围。

## 后续关注

- 如需保证 unavailable 窗口内刷新后 floating panel 也原位恢复，可在 bootstrap 中增加 unavailable panel metadata。

## 相关正式文档

- 无。
