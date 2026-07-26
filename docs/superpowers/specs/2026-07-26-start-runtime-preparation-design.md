# 启动运行时产物准备设计

## 背景

仓库文档将 `npm run start` 定义为稳定 Electron 入口，但干净执行 `npm ci` 后，
`@itharbors/kit-core` 等 workspace 只有 TypeScript 源码，没有 package export 指向的
`dist` 产物。Electron 入口在加载阶段同步导入这些 package，因而在桌面生命周期开始前抛出
`ERR_MODULE_NOT_FOUND`。

## 目标

- `npm run start` 在干净安装后可以直接启动；
- 拉取源码后不会使用缺失或陈旧的构建产物；
- 保持 Electron 入口、参数转发、稳定端口和 `npm run electron` 兼容入口不变；
- 构建失败时不启动 Electron，并向调用者返回构建失败状态。

## 方案比较

1. 在 `prestart` 生命周期中执行统一 `npm run build`。可靠性最高，复用现有构建顺序，
   代价是每次启动都增加构建时间。
2. 在 `postinstall` 中构建。日常启动更快，但拉取源码而不重新安装依赖时仍可能使用陈旧产物。
3. 只在文档中要求先运行 `npm run build`。没有兑现 `npm run start` 是稳定入口的命令契约。

采用方案 1。当前目标是修复启动正确性，不引入增量缓存或新的产物状态判断。

## 行为与错误处理

根 package 增加 `prestart`，调用现有根 `build`。npm 仅在 `prestart` 以退出码 0 完成后执行
`start`，因此构建错误会原样显示且 Electron 不会启动。`start` 本身仍调用固定版本的本地
Electron；`electron` 兼容入口继续转发到 `start`，也会获得同样的准备行为。

## 测试

- 先添加回归断言，证明稳定启动拥有构建前置生命周期，并观察它在修改前失败；
- 修改根 package 后运行聚焦启动器测试；
- 清理可再生产物后执行 `npm run start`，确认构建完成且 Notification Host、Gateway、
  Server、Vite 均成功监听；
- 检查 Git 差异与工作区状态，确保没有夹带生成产物。
