# 2026-08-16-remote-access-auth

Task ID: `2026-08-16-remote-access-auth`
Type: `feature`

## 背景与问题

当前 Harbors Web 宿主在打开页面时会动态生成 session ID，但该 ID 仅保存在 URL 中，浏览器关闭后即丢失。同时，服务端未对远程访问进行授权控制，任何能访问到端口的设备都可以直接进入。

## 目标

1. 浏览器持久化 session ID，同一浏览器再次打开时复用原 ID
2. 远程访问需经 host 机器授权后才能进入，本地访问（localhost/127.x.x.x/::1）直接放行

## 范围

- 服务端：新增设备授权数据模型与 API、远程访问拦截
- 客户端：session ID / deviceId 持久化、授权管理 UI、等待授权页面

## 非目标

- 不实现多用户账户体系
- 不实现细粒度权限控制（仅允许/拒绝）
- 不修改 Kit / Plugin 内部逻辑

## 验收标准

1. 同一浏览器多次打开页面，session ID 保持不变
2. 本地访问无需授权，可直接进入 picker
3. 远程访问未授权时显示"等待授权"页面
4. host 机器可在 picker 的"授权管理"tab 中看到待授权设备列表
5. host 可授权/拒绝待授权设备，授权有效期 7 天
6. host 可查看已授权设备列表，可撤销授权或续期 7 天
7. 授权后远程设备可正常进入 picker

## 约束

- 使用 localStorage 持久化 session ID 和 deviceId
- 授权数据使用 SQLite 持久化（与 session 共用 dbPath）
- 待授权请求使用内存存储（服务重启后丢失）
- 授权有效期默认 7 天

## 需求变更

无
