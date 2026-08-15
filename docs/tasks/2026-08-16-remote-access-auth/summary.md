# 2026-08-16-remote-access-auth Summary

## 最终结论

已实现浏览器 session ID 持久化与远程访问授权功能。同一浏览器再次打开时复用原 session ID；远程访问需经 host 机器授权后才能进入，本地访问直接放行。

## 需求完成情况

1. **Session ID 持久化**：使用 localStorage 存储 session ID，picker 与 editor 共用。若本地存储的 ID 在服务端不存在，按现有逻辑重新生成。
2. **远程访问授权**：本地访问（localhost / 127.x.x.x / ::1）直接放行；远程访问需授权。授权粒度为浏览器（deviceId），有效期 7 天，可续期。
3. **授权管理 UI**：picker 页面内增加「授权管理」tab，展示待授权和已授权设备列表，支持授权、拒绝、撤销、续期操作。

## 主要改动

### 服务端

- 新增 `packages/server/src/auth/`：
  - `device-store.ts`：SQLite 存储已授权设备（deviceId、createdAt、expiresAt、lastSeenAt）
  - `pending-store.ts`：内存存储待授权请求（deviceId、ip、userAgent、requestedAt）
  - `index.ts`：AuthManager，提供授权状态查询、批准、拒绝、撤销、续期等方法，以及本地请求检测、客户端 IP 获取、deviceId 提取
- 新增 `packages/server/src/routes/auth.ts`：授权 API 路由
  - `GET /api/auth/status` — 查询设备授权状态
  - `GET /api/auth/pending` — 待授权列表（仅本地）
  - `POST /api/auth/approve/:deviceId` — 授权（7 天）
  - `POST /api/auth/reject/:deviceId` — 拒绝
  - `GET /api/auth/authorized` — 已授权列表（仅本地）
  - `DELETE /api/auth/authorized/:deviceId` — 撤销授权
  - `POST /api/auth/refresh/:deviceId` — 续期 7 天
- 修改 `app.ts`：集成 auth 路由，对远程未授权设备的非授权/健康检查请求返回 403
- 修改 `server.ts`：创建 AuthManager 并传入 createApp，服务器停止时关闭

### 客户端

- 新增 `packages/client/src/core/storage.ts`：localStorage 工具，提供 deviceId 生成/读取、sessionId 读写、本地主机判断
- 新增 `packages/client/src/components/auth-waiting.ts`：远程未授权时的等待页面
- 修改 `index.ts`：
  - 全局 fetch 拦截，自动注入 `X-Device-Id` header
  - session ID 优先从 localStorage 读取
  - 远程访问时先检查授权状态，未授权则显示等待页面并轮询
- 修改 `editor-app.ts`：session ID 优先从 localStorage 读取
- 修改 `transport.ts`：SSE 连接通过 query 参数传递 deviceId
- 修改 `kit-picker.ts`：增加「工作台」「授权管理」tab，授权管理 tab 展示待授权/已授权设备列表及操作按钮
- 修改 `kit-picker.css`：新增 tab、授权管理、等待页面样式

## 关键决定

1. **deviceId 与 sessionId 分离**：deviceId 是稳定的浏览器标识（用于授权），sessionId 是服务端会话标识（可被销毁）。授权基于 deviceId，不依赖 sessionId。
2. **deviceId 传递方式**：fetch 请求通过 `X-Device-Id` header 传递；SSE（EventSource 不支持自定义 header）通过 query 参数 `deviceId` 传递。
3. **本地/远程判断**：服务端通过 `req.socket.remoteAddress` 判断是否为本地请求（127.x.x.x、::1）。
4. **授权数据存储**：已授权设备持久化到 SQLite（与 session 共用 dbPath）；待授权请求存储在内存中（服务重启后丢失，客户端会重新发起）。
5. **授权有效期**：默认 7 天，续期操作重新计算 7 天。

## 验证结果

- 服务端构建通过
- 客户端构建通过
- 服务端测试：694 passed
- 客户端测试：257 passed
- 手动验证授权 API：status / pending / approve / reject / authorized / refresh / revoke 均正常工作
- 本地访问无需授权，可正常获取 kit 列表

## 影响与风险

- 远程未授权设备的所有 API 请求（除 `/api/auth/status` 和 `/api/health` 外）将返回 403
- 待授权请求存储在内存中，服务重启后丢失，客户端需重新发起授权请求
- deviceId 存储在 localStorage 中，清除浏览器数据会导致 deviceId 变化，需要重新授权

## 偏差与遗留

- 未实现授权状态的实时推送（当前远程客户端通过轮询 `/api/auth/status` 等待授权）
- 未实现已授权设备的 IP/UA 变更检测
- native-credential-vault 测试在当前环境失败（与本次变更无关，为预存问题）

## 后续关注

- 可考虑使用 SSE 推送授权状态变更，替代轮询
- 可增加授权请求的通知机制（如 host 端收到新请求时的提示）
- 可增加授权日志审计

## 相关正式文档

无
