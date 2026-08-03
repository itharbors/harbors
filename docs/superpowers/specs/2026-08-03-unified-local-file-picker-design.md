# 浏览器原生本机文件选择设计

## 背景

Harbors 的 Kit Panel 同时运行在 Web 与 Electron 宿主中。SQLite 与 CSV 当前分别通过各自的
server-side core 插件枚举目录，再在 Panel 内渲染一套文件浏览弹窗。两套实现重复维护目录导航、
默认目录、条目模型、弹窗状态、焦点、取消和错误处理，也让 Kit 业务代码承担了宿主差异。

当前主线中的 MySQL 没有文件选择器；本次不虚构或修改不存在的 MySQL 业务流程。统一能力应当成为
Panel Runtime 的公共契约，供 SQLite、CSV 立即迁移，也供 MySQL 以后选择 TLS 证书等本机文件时复用。

普通浏览器的 `<input type="file">` 只提供 `File`，不会公开原始绝对路径。Electron 43 可以在
preload 中通过 `webUtils.getPathForFile(file)` 取得磁盘支持的 `File` 路径。因此能够统一的是选择交互，
而不是让普通 Web 页面获得额外的文件系统权限。

## 目标

1. 所有 Kit 通过同一个 Panel Runtime API 调用浏览器原生打开或保存选择器。
2. Electron 对用户刚选中的磁盘 `File` 解析真实路径；普通 Web 无法解析时给出稳定的本地功能提示。
3. SQLite 与 CSV 删除各自的目录枚举接口、自制文件弹窗和手动路径入口。
4. SQLite 保留打开已有数据库与新建数据库；CSV 保留选择、预览和打开流程。
5. Kit core 继续独立验证绝对路径、普通文件、允许的创建目标和竞态条件，不能把 renderer 结果当作可信输入。
6. Web 与 Electron 复用同一套 Kit Panel 业务逻辑，不增加 Electron 原生 `dialog` 或文件系统 IPC。

## 非目标

- 不把浏览器选中的文件上传、复制或缓存到 Harbors Server。
- 不允许 Web 通过文件内容、文件名或 `C:\\fakepath` 猜测本机绝对路径。
- 不提供目录选择、批量选择、拖放或持久化文件权限。
- 不改变 CSV 的编码、分隔符、预览和索引策略。
- 不改变 SQLite 默认只读、写入解锁、连接状态或数据库校验策略。
- 不为当前没有文件字段的 MySQL 连接表单增加证书功能。

## 架构决策

### 1. Panel Runtime 提供统一文件能力

`PanelContext` 与注入到 Panel 页面的 `window.editor` 增加：

```ts
type LocalFilePickerOptions = {
  accept?: string;
};

type LocalFileSaveOptions = LocalFilePickerOptions & {
  suggestedName?: string;
};

interface PanelFileRuntime {
  openLocal(options?: LocalFilePickerOptions): Promise<string | null>;
  saveLocal(options?: LocalFileSaveOptions): Promise<string | null>;
}
```

返回值是绝对路径；用户取消返回 `null`。Kit 不接收 `File`、文件句柄或宿主标志，也不判断 Electron。
`accept` 只作为浏览器选择器提示，服务端仍负责真实验证。

选择器逻辑位于公共 Panel Runtime 注入脚本中，而不是复制到每个 Kit：

- `openLocal()` 同步创建并触发一个临时 `<input type="file">`，监听 `change` 与 `cancel`，完成后移除节点；
- `saveLocal()` 在用户手势中调用 `window.showSaveFilePicker()`，使用 `suggestedName` 和从 `accept` 派生的扩展名提示；
- 两个方法都把最终 `File` 交给桌面桥解析路径；
- 选择器取消是正常结果，不显示错误，也不改变现有连接或预览。

选择器必须直接在 Panel 的点击调用栈中启动，保留浏览器要求的瞬时用户激活。不能先经异步 HTTP、IPC 或
`postMessage` 再触发选择器。

### 2. Electron 只暴露磁盘 File 到路径的窄桥

`scripts/electron-preload.cjs` 使用 Electron `webUtils` 暴露：

```ts
interface ElectronLocalFileBridge {
  getPathForFile(file: File): string;
}

window.harborsFiles?: ElectronLocalFileBridge;
```

桥只接受 Web API `File`，内部只调用 `webUtils.getPathForFile(file)`。它不接受路径字符串，不读取文件，
不枚举目录，不经 IPC 把任意文件系统操作暴露给 renderer。

Panel iframe 与宿主页同源，并带 `allow-scripts allow-same-origin` sandbox。公共 runtime 从当前顶层宿主页
取得 `harborsFiles` 并解析 Panel 选择得到的 `File`。若桥不存在、返回空字符串或抛错，则该文件不能证明为
Harbors 可读取的本机磁盘文件。

### 3. 本机判定与错误契约

“本机文件”同时满足两层条件：

1. renderer 层：Electron `webUtils` 能从用户选择产生的 `File` 返回非空绝对路径；
2. core 层：消费路径的 Kit 服务在使用前重新执行绝对路径、`lstat`/`realpath`、普通文件和业务格式校验。

renderer 无法取得路径时抛出带稳定 code 的错误：

```text
code: LOCAL_FILE_PATH_UNAVAILABLE
message: 该功能只能读取运行 Harbors 的本机文件，请在桌面版中使用。
```

Web 的打开流程仍先展示浏览器原生选择器；选中后因无法获得真实路径而显示上述提示。保存流程在没有桌面桥时
直接提示，不先创建空文件。路径已解析但 core 无法访问、目标不是普通文件或格式非法时，继续使用对应 Kit 的
稳定错误，不把所有业务错误误报成本地宿主限制。

### 4. SQLite 迁移

连接 Panel 的“打开数据库”调用 `context.file.openLocal()`，以 `.sqlite,.sqlite3,.db` 作为选择提示，
得到路径后直接调用现有 `openDatabase({ path, create: false })`。

“新建数据库”调用 `context.file.saveLocal()`，建议文件名 `database.sqlite`，得到路径后调用
`openDatabase({ path, create: true })`。浏览器保存选择器可能先为新目标生成零字节普通文件，因此创建目标验证
调整为接受以下两种状态：

- 路径尚不存在；
- 路径是非符号链接、大小为零的普通文件。

任何非空文件、目录、符号链接或在验证与打开之间发生不安全变化的目标继续被拒绝。core 在打开前再次检查，
避免保存选择器的结果绕过 SQLite 边界。

以下选择器专用能力删除：

- `listDirectory` 与 `getDefaultDirectory` request；
- `file-browser.ts` 的目录条目与枚举逻辑，只保留聚焦的创建目标校验模块；
- 最近路径选择、目录导航、显示全部、手动路径、文件名输入和自制文件弹窗；
- 与上述行为绑定的 manifest 声明、样式和测试。

SQLite core 内部若仅为已删除界面维护最近数据库列表，则一并删除；连接快照仍保存当前数据库路径。

### 5. CSV 迁移

连接 Panel 的“浏览”调用 `context.file.openLocal()`。选择提示包含常见文本数据扩展名，但不改变 core
原有的扩展名无关验证。得到路径后直接进入现有 `sampleFile`，确认配置后继续调用 `openFile`。

以下能力删除：

- CSV contracts 中的 `listDirectory` 与 `getDefaultDirectory`；
- csv-core manifest、main 和 service 的同名方法；
- `file-policy.ts` 中的目录枚举、默认目录和目录条目类型；
- connection Panel 的自制弹窗、目录状态与 modal 占用；
- 对应目录浏览测试。

CSV 的路径校验、采样、取消、过期结果抑制、失败后保留配置和索引状态机保持不变。

## 数据流

### 打开已有文件

1. 用户点击 SQLite“打开数据库”或 CSV“浏览”。
2. Kit 调用 `editor.file.openLocal()`。
3. 公共 runtime 立即打开浏览器原生文件选择器。
4. 用户取消时返回 `null`；业务状态不变。
5. 用户选中文件后，runtime 请求 Electron 窄桥解析路径。
6. Web 无桥或解析为空时抛出 `LOCAL_FILE_PATH_UNAVAILABLE`，Panel 显示统一提示。
7. Electron 返回路径时，Kit 把路径提交给自己的 core request。
8. core 重新验证本机路径和文件后，执行 SQLite 连接或 CSV 采样。

### 新建 SQLite 数据库

1. 用户点击“新建数据库”。
2. runtime 先确认存在桌面路径桥，再立即调用浏览器保存选择器。
3. 用户取消返回 `null`；用户确认后从文件句柄取得磁盘 `File` 并解析路径。
4. SQLite core 接受不存在或零字节普通文件目标，拒绝其他已有目标。
5. SQLite 创建并连接数据库；后续只读与写入解锁行为保持不变。

## 组件边界

- `scripts/electron-preload.cjs`：Electron `File -> path` 适配，不包含业务选择器。
- `packages/client/src/electron/types.ts`：桌面桥类型与 Window 声明。
- `packages/plugin-types`：Kit 可消费的 `PanelContext.file` 公共类型。
- `packages/server/src/routes/panel-asset.ts`：注入共享选择器实现与标准错误。
- `packages/server/src/editor/types.ts`：Server 侧 Panel Runtime 类型保持一致。
- SQLite connection Panel：只编排选择、连接和错误展示。
- CSV connection Panel：只编排选择、采样、确认和错误展示。
- SQLite/CSV core：只处理不可信路径与数据库/文件业务规则。

## 安全与兼容性

- 只有明确用户手势能够打开选择器；脚本不能预填文件路径。
- `accept` 是选择提示而非信任边界，core 必须继续验证。
- preload 不暴露 Node `fs`、Electron `dialog`、IPC 通道或任意路径查询。
- runtime 不读取或上传 `File` 内容，避免 Web 悄悄改变“仅本机路径”语义。
- 选择返回的路径不得写入 URL、日志或前端持久化；SQLite 现有当前连接展示除外。
- Electron 桥缺失是受支持的 Web 状态，不是初始化失败。
- `showSaveFilePicker` 仅用于 Electron 43 所带 Chromium；Web 不依赖其跨浏览器可用性。

## 测试与验收

### 公共契约

- plugin types 与 server runtime 类型都包含 `file.openLocal/saveLocal`。
- Panel asset runtime 测试覆盖打开、保存、取消、临时 input 清理、路径桥成功和无桥错误。
- Electron preload 测试确认只暴露 `getPathForFile`，调用 `webUtils.getPathForFile`，且不新增文件 IPC 或目录权限。

### SQLite

- Panel 测试覆盖打开、新建、取消、Web 本地提示、busy/过期结果和成功连接。
- core 测试覆盖不存在目标、零字节普通文件、非空文件、目录、符号链接和竞态变化。
- manifest 与 main 方法测试证明目录枚举 request 已删除。

### CSV

- Panel 测试覆盖浏览器选择、取消、Web 本地提示、采样失败、重新选择和成功打开。
- core 与 contract 测试证明目录枚举 API 已删除，路径与采样策略仍生效。

### 集成验证

- `npm run dev:web`：SQLite 与 CSV 点击选择后使用浏览器原生选择器，选中文件显示“仅本机”提示；取消无副作用。
- Electron：SQLite 能打开已有数据库、通过保存选择器新建数据库；CSV 能选择、预览并打开本机文件。
- 运行 SQLite、CSV、Client、Server 和 Electron preload 的聚焦测试，再运行仓库 `npm run check`。
- 搜索源码与 manifest，确认 SQLite/CSV 不再包含 `listDirectory`、`getDefaultDirectory` 或自制文件浏览器状态。

## 交付边界

这是一个宿主公共能力与两个现有 Kit 的原子迁移。只有公共契约、Electron 窄桥、SQLite/CSV 迁移、
相关测试和必要文档属于本次范围。新的 MySQL TLS 功能、文件上传、目录选择与通用文件管理器另行设计。
