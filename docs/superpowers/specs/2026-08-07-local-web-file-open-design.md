# 本机 Web 文件打开设计

## 背景

Panel Runtime 已让 Electron 与 Web 共用浏览器原生文件选择器。Electron 可以通过
`webUtils.getPathForFile()` 取得所选文件的真实路径，普通 Web 只能得到 `File`。原设计因此让
Web 在选择后报错，不读取或传输文件内容。

本设计扩展 `openLocal()`：当用户通过 loopback 地址访问运行在同一台设备上的 Harbors 时，
允许把用户刚刚明确选择的文件流式暂存到 Harbors 管理的临时目录，并把暂存路径交给 Kit。
Electron 路径和选择交互保持不变。

## 行为

- Panel 仍只调用 `context.file.openLocal()`，无需判断宿主。
- Electron 路径桥存在时直接返回原始绝对路径，不复制文件。
- Web 无路径桥时把所选 `File` POST 到当前会话的本机文件路由。
- 服务端只接受 HTTP(S) loopback Origin，包括 `localhost`、`*.localhost`、`127.0.0.0/8`
  与 `::1`。缺少 Origin 或非 loopback Origin 在读取请求体前返回
  `REMOTE_LOCAL_FILE_FORBIDDEN`。
- Web 返回的是只读暂存副本；SQLite 打开已有数据库时默认只读。暂存副本的修改不会写回浏览器
  所选原文件。
- `saveLocal()` 继续只支持 Electron；Web 新建和写回需要独立的文件句柄、同步与冲突设计。

## 文件与生命周期安全

- 每个 Harbors Server 进程和 Session 使用随机独占目录，不用 Session ID 或文件名拼接目录。
- 文件名只保留安全 basename，并加随机标识；先写独占 `.part` 文件，成功后去除写权限并原子改名。
- loopback Web 不设置应用层单文件大小上限；可用空间和文件系统错误按正常上传失败处理，失败或中断时删除部分文件。
- Session 删除时先释放 Kit 数据库/文件句柄，再删除对应暂存目录；Server 停止时删除进程目录。
- 请求内容不进入 Session 数据库、URL 日志或前端持久化。

## 远程边界

判断依据是浏览器生成且同源脚本不能伪造的 `Origin`，不是 Panel 自报的宿主标志。通过局域网 IP、
代理域名或公网地址打开 Harbors 时 Origin 不是 loopback，因此服务端拒绝内容。该端点不是通用上传
API，也不替代 Harbors 的访问认证。

## 与原设计的关系

本设计只替代《浏览器原生本机文件选择设计》中“Web 不上传、复制或缓存所选文件”的打开流程非目标。
原设计关于统一原生选择器、Electron 窄路径桥、Kit 对路径重新验证、无目录枚举和 Web 不支持保存的
约束继续有效。
