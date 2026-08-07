# 本机 Web 文件打开总结

## 最终结论

本机 Web 现在可以通过与 Electron 相同的浏览器原生选择器打开用户明确选择的文件；文件以会话级只读副本暂存在同机 Harbors，远程 Web 在服务端读取内容前被拒绝。

## 需求完成情况

- Electron 继续直接解析原始绝对路径，选择交互未分叉。
- loopback Web 可以打开 SQLite 等需要服务端路径的文件。
- 非 loopback、缺少 Origin、无效会话和超限文件均有稳定拒绝行为。
- 会话删除和 Server 正常停止均清理暂存副本。
- Web 新建和写回原文件按非目标保持不可用。

## 主要改动

- 扩展共享 Panel 文件运行时，在桌面路径桥缺失时流式上传用户选择的 `File`。
- 新增本机 Web 文件路由和存储生命周期，包含 2 GiB 限额、安全文件名、独占临时目录、原子写入、只读权限及失败清理。
- 将文件清理接入 Session 删除和 Server 停止顺序，确保先释放 Kit 文件句柄。
- 更新统一文件选择设计，并新增本机 Web 扩展设计。

## 关键决定

- 使用浏览器生成的 loopback HTTP(S) Origin 作为同机 Web 边界，不信任 Panel 自报宿主信息。
- 保持 `context.file.openLocal()` 的字符串路径契约，避免 Kit 分别判断 Electron/Web。
- Web 使用临时副本而非猜测浏览器绝对路径；原始文件不会被服务端修改或写回。
- `saveLocal()` 继续桌面专用，写回能力需要独立的文件句柄和冲突设计。

## 验证结果

- `npm run build`：通过。
- `CI=1 npm test -w packages/server -- --reporter=dot`：60 files、701 tests 通过。
- 最终聚焦测试：3 files、28 tests 通过。
- `npm run build -w packages/server` 与 `git diff --check`：通过。
- SQLite Web 实际验收：20 KiB 数据库经 localhost 暂存并以只读模式打开，浏览器显示 2 张表、1 个视图及 Alice/Bob 两条记录。

## 影响与风险

- 本机 Web 会把用户主动选择的文件复制到 Harbors 临时目录，最大 2 GiB，占用对应磁盘空间直至 Session 删除或 Server 正常停止。
- 强制终止进程可能来不及执行正常清理；每次运行使用独占目录，遗留副本不会被后续 Session 复用。
- SQLite 复制文件初始只读且无写权限；Web 仍不承诺修改或保存回原文件。

## 偏差与遗留

- 内置浏览器自动化无法捕获 iframe 内动态创建的系统文件选择事件，因此真实验收用同一 Session 的本机文件路由与 SQLite Core 请求完成；Panel 选择器、桥优先和 File 请求体由 JSDOM 测试覆盖。
- Vite 经 Gateway 的开发 WebSocket/HMR 仍有既有连接警告，不影响 HTTP 页面和本次文件打开流程。

## 后续关注

- 若要让 Web 修改并写回用户原文件，需要单独设计 File System Access 句柄、下载/写回、冲突检测和浏览器兼容策略。
- 可另行评估崩溃后过期进程目录的安全回收策略，不能删除其他并行 Harbors 实例的活动目录。

## 相关正式文档

- `docs/superpowers/specs/2026-08-07-local-web-file-open-design.md`
- `docs/superpowers/specs/2026-08-03-unified-local-file-picker-design.md`
