# 取消本机 Web 文件大小上限总结

## 最终结论

localhost/loopback Web 打开用户选择的本机文件时不再设置 Harbors 应用层大小上限；文件继续以流式方式写入只读会话副本。

## 需求完成情况

- 移除默认 2 GiB 上限和默认 `LOCAL_FILE_TOO_LARGE` 拒绝。
- 保持 Electron 直接路径、远程 Origin 拒绝、会话清理和 Server 清理行为不变。
- 保留显式配置字节上限的底层能力及失败残片清理。

## 主要改动

- `LocalWebFileStore` 的 `maxBytes` 从默认常量改为可选配置。
- 仅在调用方显式提供 `maxBytes` 时校验 `Content-Length` 和累计流量。
- 新增超过原 2 GiB 声明长度时默认路径仍可暂存的回归测试。
- 更新本机 Web 文件打开设计中的大小与磁盘约束。

## 关键决定

- loopback Web 已由服务端 Origin 校验限制为同机访问，不再施加固定应用层文件大小政策。
- “不限制”不改变浏览器文件模型：仍需完整复制临时副本，而非随机读取原文件。
- 磁盘空间不足和文件系统错误继续作为普通上传失败处理并触发残片清理。

## 验证结果

- `npx vitest run packages/server/tests/routes/local-web-file.test.ts --reporter=dot`：1 file、16 tests 通过。
- `npm run build`：通过，包含 Framework 与内置插件构建。
- `CI=1 npm test -w packages/server -- --reporter=dot`：60 files、703 tests 通过。
- `npm run build -w packages/server` 与 `git diff --check`：通过。

## 影响与风险

- 大文件会占用与源文件接近的临时磁盘空间，空间不足时打开失败。
- 上传耗时随文件大小增长；当前没有应用层进度、配额或预留空间检查。
- 临时副本仍在 Session 删除或 Server 正常停止时清理。

## 偏差与遗留

- 新 worktree 首次完整测试因内置插件尚未构建而失败；执行仓库构建后消除。
- 一次重跑因多轮工作流自测临时目录耗尽磁盘而失败；清理当天生成的测试临时仓库并恢复 47 GiB 可用空间后，完整测试通过。

## 后续关注

- 如需避免大文件完整复制，应独立设计浏览器文件句柄与随机分片读取协议。
- 可另行增加上传进度、剩余空间提示和崩溃后临时目录回收。

## 相关正式文档

- `docs/superpowers/specs/2026-08-07-local-web-file-open-design.md`
