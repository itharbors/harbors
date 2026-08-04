# 浏览器原生本机文件选择实现计划

> **给 agentic 工作者：** 必需的子 skill：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法进行跟踪。

**目标：** 为所有 Panel 提供浏览器原生的本机文件打开/保存能力，并将 SQLite、CSV 从自制目录浏览器迁移到这一公共契约。

**架构：** Panel Runtime 在用户手势内直接调用浏览器文件选择 API，Electron preload 仅把选择产生的 `File` 解析为真实磁盘路径；Web 无路径桥时返回统一的本地功能错误。SQLite 与 CSV core 继续把路径视为不可信输入并完成最终文件校验，Kit Panel 不再判断宿主或枚举目录。

**技术栈：** TypeScript、浏览器 File API、File System Access API、Electron 43 `webUtils`、Vitest/jsdom、Node.js `fs`、better-sqlite3

## 全局约束

- 不把浏览器选中的文件上传、复制或缓存到 Harbors Server。
- 不允许 Web 通过文件内容、文件名或 `C:\\fakepath` 猜测本机绝对路径。
- 不提供目录选择、批量选择、拖放或持久化文件权限。
- 不改变 CSV 的编码、分隔符、预览和索引策略。
- 不改变 SQLite 默认只读、写入解锁、连接状态或数据库校验策略。
- 不为当前没有文件字段的 MySQL 连接表单增加证书功能。
- Web 与 Electron 复用同一套 Kit Panel 业务逻辑，不增加 Electron 原生 `dialog` 或文件系统 IPC。
- renderer 无法取得路径时使用 `LOCAL_FILE_PATH_UNAVAILABLE` 和文案“该功能只能读取运行 Harbors 的本机文件，请在桌面版中使用。”
- Electron bridge 只接受浏览器产生的 `File`，不接受任意路径字符串，不读取文件，不枚举目录。
- SQLite 新建只接受不存在目标或零字节非符号链接普通文件，拒绝覆盖非空文件。
- 所有实现提交使用 `[Feature]`、`[Bug]`、`[Docs]`、`[Refactor]`、`[Optimize]`、`[Test]` 或 `[Chore]` 加简洁中文摘要且无句号。

---

## 文件结构

- `packages/plugin-types/src/panel.ts`：对 Kit 声明 `PanelContext.file`、选项与返回类型。
- `packages/plugin-types/src/global.d.ts`：同步 `window.editor.file` 的浏览器全局类型。
- `packages/server/src/editor/types.ts`：同步 Server 侧 `PanelRuntime.file` 契约。
- `packages/server/src/routes/panel-file-runtime.ts`：提供可直接执行测试、也可序列化注入 Panel 的共享打开/保存实现。
- `packages/server/src/routes/panel-asset.ts`：把共享文件运行时接入每个 Panel。
- `packages/server/tests/routes/panel-file-runtime.test.ts`：用真实 DOM 行为验证选择、取消、清理、路径解析和保存边界。
- `packages/server/tests/routes/panel-asset.test.ts`：验证共享文件运行时已接入最终 Panel HTML。
- `scripts/electron-preload.cjs`：暴露唯一的 `harborsFiles.getPathForFile(File)` 窄桥。
- `packages/client/src/electron/types.ts`：声明 Electron 文件桥与 `Window.harborsFiles`。
- `scripts/lib/electron-launcher.test.mjs`：验证 preload 使用 `webUtils` 且未增加文件 IPC/任意路径能力。
- `kits/sqlite/plugins/sqlite-core/main/src/file-browser.ts`：删除目录枚举，只保留创建目标策略。
- `kits/sqlite/plugins/sqlite-core/main/src/sqlite-service.ts`：删除目录/最近路径状态，安全接受保存选择器生成的空文件。
- `kits/sqlite/plugins/sqlite-core/main/src/index.ts`、`package.json`：删除选择器专用 request。
- `kits/sqlite/plugins/sqlite-explorer/panel.connection/src/index.ts`、`index.css`：使用 `context.file` 并删除自制文件弹窗。
- `kits/sqlite/plugins/sqlite-core/tests/*`、`kits/sqlite/plugins/sqlite-explorer/tests/connection-panel.test.ts`：替换目录浏览测试为路径策略和原生选择流程测试。
- `kits/csv/packages/contracts/src/request.ts`：删除目录枚举请求名。
- `kits/csv/plugins/csv-core/main/src/file-policy.ts`：删除目录枚举和默认目录，只保留文件策略。
- `kits/csv/plugins/csv-core/main/src/csv-service.ts`、`index.ts`、`package.json`：删除选择器专用方法与声明。
- `kits/csv/plugins/csv-explorer/panel.connection/src/index.ts`、`index.css`：使用 `context.file.openLocal` 并删除自制目录弹窗。
- `kits/csv/plugins/csv-core/tests/*`、`kits/csv/plugins/csv-explorer/tests/connection-panel.test.ts`、`kits/csv/tests/kit-manifest.test.ts`：证明旧 API 消失且预览/打开行为保持。
- `kits/sqlite/README.md`、`kits/csv/README.md`：说明浏览器原生选择和桌面本机路径限制。
- `kits/{sqlite,csv}/{kit.json,package.json,package-lock.json}`：将两个已变更市场 Kit 从 `0.1.0-preview.1` 同步提升到 `0.1.0-preview.2`。

### 任务 1：公共 Panel 文件运行时与 Electron 窄桥

**文件：**
- 修改：`packages/plugin-types/src/panel.ts`
- 修改：`packages/plugin-types/src/global.d.ts`
- 修改：`packages/server/src/editor/types.ts`
- 创建：`packages/server/src/routes/panel-file-runtime.ts`
- 修改：`packages/server/src/routes/panel-asset.ts`
- 创建：`packages/server/tests/routes/panel-file-runtime.test.ts`
- 修改：`packages/server/tests/routes/panel-asset.test.ts`
- 修改：`scripts/electron-preload.cjs`
- 修改：`packages/client/src/electron/types.ts`
- 修改：`scripts/lib/electron-launcher.test.mjs`

**接口：**
- 产出：`PanelContext.file.openLocal(options?: { accept?: string }): Promise<string | null>`
- 产出：`PanelContext.file.saveLocal(options?: { accept?: string; suggestedName?: string }): Promise<string | null>`
- 产出：`window.harborsFiles?.getPathForFile(file: File): string`
- 错误：`Error & { code: 'LOCAL_FILE_PATH_UNAVAILABLE' }`

- [ ] **步骤 1：为 runtime 真实行为、Panel 接入和 preload 桥编写失败测试**

创建 `packages/server/tests/routes/panel-file-runtime.test.ts`（jsdom 环境），直接执行共享 runtime 并验证可观察行为：

```ts
it('opens one native file input and resolves the selected local path', async () => {
  window.harborsFiles = { getPathForFile: vi.fn(() => '/tmp/data.csv') };
  vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function () {
    Object.defineProperty(this, 'files', { value: [new File(['x'], 'data.csv')] });
    this.dispatchEvent(new Event('change'));
  });

  await expect(runtime.openLocal({ accept: '.csv' })).resolves.toBe('/tmp/data.csv');
  expect(document.querySelector('input[type="file"]')).toBeNull();
});
```

同一测试文件还覆盖：`cancel` 返回 `null` 且清理 input；Web 缺少桥或桥返回空路径时抛稳定 code/message；`saveLocal` 在无桥时不调用 `showSaveFilePicker`；保存成功通过 `handle.getFile()` 解析路径；`AbortError` 返回 `null`。

在 `packages/server/tests/routes/panel-asset.test.ts` 只保留一项集成断言：最终 HTML 把序列化后的真实 runtime 连接到 `window.editor.file`，不再用实现字符串代替行为测试。

在 `scripts/lib/electron-launcher.test.mjs` 使用 `node:vm` 执行真实 `scripts/electron-preload.cjs`，伪造 Electron 外部能力并断言调用行为：

```js
const exposed = new Map();
const selectedFile = {};
const getPathForFile = mock.fn((file) => {
  assert.equal(file, selectedFile);
  return '/tmp/data.csv';
});
runPreloadInVm({ exposed, webUtils: { getPathForFile } });

const bridge = exposed.get('harborsFiles');
assert.deepEqual(Object.keys(bridge), ['getPathForFile']);
assert.equal(bridge.getPathForFile(selectedFile), '/tmp/data.csv');
assert.equal(getPathForFile.mock.callCount(), 1);
```

现有 updater preload 测试可以继续验证既有源码约束；新增文件桥必须通过真实执行证明，而不是正则匹配。

- [ ] **步骤 2：运行测试验证红灯**

运行：

```bash
npm run test -w packages/server -- --run \
  tests/routes/panel-file-runtime.test.ts \
  tests/routes/panel-asset.test.ts
node --test scripts/lib/electron-launcher.test.mjs
```

预期：共享 runtime 尚不存在，Panel 尚未接入，preload 未暴露 `harborsFiles`，测试因缺少目标行为而失败。

- [ ] **步骤 3：实现公共类型和最小 runtime**

在 plugin types 与 Server types 中声明：

```ts
export interface LocalFilePickerOptions { accept?: string }
export interface LocalFileSaveOptions extends LocalFilePickerOptions { suggestedName?: string }
export interface PanelFileRuntime {
  openLocal(options?: LocalFilePickerOptions): Promise<string | null>;
  saveLocal(options?: LocalFileSaveOptions): Promise<string | null>;
}
```

`panel-file-runtime.ts` 导出自包含的 `createPanelFileRuntime(windowObject, documentObject)`。测试直接调用这个实现；`panel-asset.ts` 序列化同一个函数并在 Panel 中执行，避免测试实现和注入实现分叉。公共实现遵循以下结构：

```js
function localFileError() {
  const error = new Error('该功能只能读取运行 Harbors 的本机文件，请在桌面版中使用。');
  error.code = 'LOCAL_FILE_PATH_UNAVAILABLE';
  return error;
}

function resolveLocalFilePath(file) {
  const hostWindow = window.parent === window ? window : window.parent;
  const path = hostWindow.harborsFiles?.getPathForFile(file) ?? '';
  if (typeof path !== 'string' || path.length === 0) throw localFileError();
  return path;
}
```

`openLocal` 在调用栈内创建 input、附加到 `document.body` 并调用 `click()`；`change` 解析第一个 `File`，`cancel` 返回 `null`，两个分支都只完成一次并移除 input。`saveLocal` 在无桥时先抛标准错误；有桥时调用 `showSaveFilePicker`，把 `AbortError` 转成 `null`，其余异常原样抛出，并通过 `handle.getFile()` 取得 `File` 后解析路径。

preload 只增加：

```js
const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('harborsFiles', Object.freeze({
  getPathForFile(file) {
    return webUtils.getPathForFile(file);
  },
}));
```

- [ ] **步骤 4：运行聚焦测试和类型构建验证绿灯**

运行：

```bash
npm run build -w @itharbors/plugin-types
npm run test -w packages/server -- --run \
  tests/routes/panel-file-runtime.test.ts \
  tests/routes/panel-asset.test.ts
node --test scripts/lib/electron-launcher.test.mjs
```

预期：全部通过，且 Electron 测试证明没有新增文件 IPC、`dialog` 或目录读取能力。

- [ ] **步骤 5：提交公共能力**

```bash
git add packages/plugin-types/src/panel.ts packages/plugin-types/src/global.d.ts \
  packages/server/src/editor/types.ts packages/server/src/routes/panel-file-runtime.ts \
  packages/server/src/routes/panel-asset.ts packages/server/tests/routes/panel-file-runtime.test.ts \
  packages/server/tests/routes/panel-asset.test.ts scripts/electron-preload.cjs \
  packages/client/src/electron/types.ts scripts/lib/electron-launcher.test.mjs
git commit -m '[Feature] 增加统一的本机文件运行时'
```

### 任务 2：SQLite core 文件创建策略与旧 API 清理

**文件：**
- 修改：`kits/sqlite/plugins/sqlite-core/main/src/file-browser.ts`
- 修改：`kits/sqlite/plugins/sqlite-core/main/src/sqlite-service.ts`
- 修改：`kits/sqlite/plugins/sqlite-core/main/src/index.ts`
- 修改：`kits/sqlite/plugins/sqlite-core/package.json`
- 修改：`kits/sqlite/plugins/sqlite-core/tests/file-browser.test.ts`
- 修改：`kits/sqlite/plugins/sqlite-core/tests/sqlite-service.test.ts`
- 修改：`kits/sqlite/plugins/sqlite-core/tests/plugin-main.test.ts`

**接口：**
- 消费：`openDatabase({ path: string, create: boolean })`
- 产出：`validateCreateTarget({ directory, fileName }): { path: string; existingEmptyFile: boolean }`
- 删除：`listDirectory`、`getDefaultDirectory`、`getRecentDatabases`

- [ ] **步骤 1：把文件策略测试改为新建目标边界并先验证失败**

保留非法文件名、无效父目录和自动补 `.sqlite` 测试；删除目录列表测试；新增：

```ts
it('accepts a browser save picker empty regular file without accepting non-empty files', () => {
  const empty = path.join(tempDir, 'new.sqlite');
  fs.writeFileSync(empty, '');
  expect(validateCreateTarget({ directory: tempDir, fileName: 'new.sqlite' })).toEqual({
    path: fs.realpathSync(empty),
    existingEmptyFile: true,
  });
  fs.writeFileSync(empty, 'content');
  expect(() => validateCreateTarget({ directory: tempDir, fileName: 'new.sqlite' }))
    .toThrow('同名数据库文件已经存在');
});
```

在 service 测试中新增空文件成功创建、非空拒绝、符号链接拒绝、空文件身份变化拒绝且失败不删除预先存在文件；在 plugin main 测试中断言旧三项方法和 manifest request 不存在。

- [ ] **步骤 2：运行 SQLite core 聚焦测试验证红灯**

运行：

```bash
npm run test --prefix kits/sqlite -- --run \
  plugins/sqlite-core/tests/file-browser.test.ts \
  plugins/sqlite-core/tests/sqlite-service.test.ts \
  plugins/sqlite-core/tests/plugin-main.test.ts
```

预期：空普通文件仍得到 `PATH_EXISTS`，旧方法仍被注册，测试失败。

- [ ] **步骤 3：最小实现创建目标双状态并删除旧状态**

`validateCreateTarget` 对不存在目标返回 `{ path: target, existingEmptyFile: false }`；对存在目标使用 `lstatSync`，仅接受 `isFile() && size === 0 && !isSymbolicLink()`，真实化路径后返回 `existingEmptyFile: true`。

`openDatabase`：

- 不存在目标继续使用 `openSync(path, 'wx', 0o600)` 并标记 `createdByService = true`；
- 已有空文件使用 `openSync(path, 'r+')`，通过 `fstat` 再确认普通文件和零大小；
- 两种路径都记录 device/inode，并在 SQLite 连接后比较身份；
- 失败时仅删除 `createdByService` 创建且身份未变化的保留文件，绝不删除保存选择器预先生成的空文件。

同时删除 `homedir`、`recentDatabasePaths`、`rememberDatabasePath`、service 三个旧方法、main methods 和 manifest request。

- [ ] **步骤 4：运行 SQLite core 测试验证绿灯**

运行任务 2 步骤 2 的命令。

预期：创建策略、连接回滚和 API 删除全部通过。

- [ ] **步骤 5：提交 SQLite core**

```bash
git add kits/sqlite/plugins/sqlite-core/main/src/file-browser.ts \
  kits/sqlite/plugins/sqlite-core/main/src/sqlite-service.ts \
  kits/sqlite/plugins/sqlite-core/main/src/index.ts \
  kits/sqlite/plugins/sqlite-core/package.json \
  kits/sqlite/plugins/sqlite-core/tests/file-browser.test.ts \
  kits/sqlite/plugins/sqlite-core/tests/sqlite-service.test.ts \
  kits/sqlite/plugins/sqlite-core/tests/plugin-main.test.ts
git commit -m '[Feature] 收口 SQLite 本机文件策略'
```

### 任务 3：SQLite Panel 迁移到浏览器原生选择器

**文件：**
- 修改：`kits/sqlite/plugins/sqlite-explorer/panel.connection/src/index.ts`
- 修改：`kits/sqlite/plugins/sqlite-explorer/panel.connection/src/index.css`
- 修改：`kits/sqlite/plugins/sqlite-explorer/tests/connection-panel.test.ts`

**接口：**
- 消费：`context.file.openLocal({ accept: '.sqlite,.sqlite3,.db' })`
- 消费：`context.file.saveLocal({ accept: '.sqlite,.sqlite3,.db', suggestedName: 'database.sqlite' })`
- 产出：`openDatabase({ path, create: false|true })`

- [ ] **步骤 1：重写 Panel 测试表达原生选择流程**

测试 context 增加：

```ts
const file = {
  openLocal: vi.fn(async () => '/tmp/demo.sqlite'),
  saveLocal: vi.fn(async () => '/tmp/new.sqlite'),
};
```

新增/保留用例：

- 点击“打开数据库”调用 `openLocal` 后调用 `openDatabase({ path, create: false })`；
- 点击“新建数据库”调用 `saveLocal` 后调用 `openDatabase({ path, create: true })`；
- 两个选择器返回 `null` 时不请求 core、不改变连接状态；
- `LOCAL_FILE_PATH_UNAVAILABLE` 显示统一中文文案；
- busy、unmount、过期请求、刷新、关闭和启用写入行为保持；
- DOM 中不存在 `[data-file-dialog]`、`[data-file-path]`、手动路径、目录导航和 modal 打开调用。

- [ ] **步骤 2：运行 Panel 测试验证红灯**

运行：

```bash
npm run test --prefix kits/sqlite -- --run plugins/sqlite-explorer/tests/connection-panel.test.ts
```

预期：Panel 仍请求 `getRecentDatabases/listDirectory` 并渲染自制弹窗，测试失败。

- [ ] **步骤 3：删除 FileDialog 状态并实现两个直接动作**

实现：

```ts
async function openDatabaseFromPicker(): Promise<void> {
  const path = await context?.file.openLocal({ accept: '.sqlite,.sqlite3,.db' });
  if (!path) return;
  await requestCore('openDatabase', { path, create: false });
}

async function createDatabaseFromPicker(): Promise<void> {
  const path = await context?.file.saveLocal({
    accept: '.sqlite,.sqlite3,.db',
    suggestedName: 'database.sqlite',
  });
  if (!path) return;
  await requestCore('openDatabase', { path, create: true });
}
```

两者继续通过现有 `runAction`、generation token 和 `panelError` 管理 busy/过期/错误。删除 modal 状态、键盘焦点循环、目录 helper、HTML 弹窗与只供弹窗使用的 CSS；写入解锁确认框继续保留。

- [ ] **步骤 4：运行 SQLite Panel 与完整 Kit 测试**

```bash
npm run test --prefix kits/sqlite -- --run plugins/sqlite-explorer/tests/connection-panel.test.ts
npm run test --prefix kits/sqlite
```

预期：全部通过，旧目录 request 不再出现。

- [ ] **步骤 5：提交 SQLite Panel 迁移**

```bash
git add kits/sqlite/plugins/sqlite-explorer/panel.connection/src/index.ts \
  kits/sqlite/plugins/sqlite-explorer/panel.connection/src/index.css \
  kits/sqlite/plugins/sqlite-explorer/tests/connection-panel.test.ts
git commit -m '[Feature] 迁移 SQLite 原生文件选择'
```

### 任务 4：CSV contracts/core 删除目录浏览能力

**文件：**
- 修改：`kits/csv/packages/contracts/src/request.ts`
- 修改：`kits/csv/plugins/csv-core/main/src/file-policy.ts`
- 修改：`kits/csv/plugins/csv-core/main/src/csv-service.ts`
- 修改：`kits/csv/plugins/csv-core/main/src/index.ts`
- 修改：`kits/csv/plugins/csv-core/package.json`
- 修改：`kits/csv/plugins/csv-core/tests/file-policy.test.ts`
- 修改：`kits/csv/plugins/csv-core/tests/plugin-main.test.ts`
- 修改：`kits/csv/tests/kit-manifest.test.ts`

**接口：**
- 保留：`validateSourcePath`、`sampleFile`、`openFile`
- 删除：`listDirectory`、`getDefaultDirectory`、`CsvDirectoryListing`

- [ ] **步骤 1：先修改 contract/manifest 测试要求旧 API 消失**

```ts
expect(CSV_REQUEST_METHODS).not.toContain('listDirectory');
expect(CSV_REQUEST_METHODS).not.toContain('getDefaultDirectory');
expect(pluginPackage['ce-editor'].contribute.message.request).not.toHaveProperty('listDirectory');
expect(pluginPackage['ce-editor'].contribute.message.request).not.toHaveProperty('getDefaultDirectory');
```

删除只覆盖目录排序、父路径与默认目录的测试，保留并加强普通文件、目录、符号链接、超限和路径归一化测试。

- [ ] **步骤 2：运行 CSV core/manifest 测试验证红灯**

```bash
npm run test --prefix kits/csv -- --run \
  plugins/csv-core/tests/file-policy.test.ts \
  plugins/csv-core/tests/plugin-main.test.ts \
  tests/kit-manifest.test.ts
```

预期：contracts、manifest 和 main 仍公开旧方法，测试失败。

- [ ] **步骤 3：删除目录专用类型、函数、service/main 方法和声明**

从 `file-policy.ts` 删除 `CsvFileEntry`、`CsvDirectoryListing`、`listDirectory`、`getDefaultDirectory` 及只为它们存在的 `homedir/readdir` 逻辑；不得改变 `validateSourcePath`、文件大小与符号链接策略。同步清理 contracts、service、main 和 plugin manifest。

- [ ] **步骤 4：运行任务 4 聚焦测试和 CSV contracts 构建**

```bash
npm run build --prefix kits/csv/packages/contracts
npm run test --prefix kits/csv -- --run \
  plugins/csv-core/tests/file-policy.test.ts \
  plugins/csv-core/tests/plugin-main.test.ts \
  tests/kit-manifest.test.ts
```

预期：全部通过，生成 contracts 不含旧方法。

- [ ] **步骤 5：提交 CSV core 清理**

```bash
git add kits/csv/packages/contracts/src/request.ts \
  kits/csv/plugins/csv-core/main/src/file-policy.ts \
  kits/csv/plugins/csv-core/main/src/csv-service.ts \
  kits/csv/plugins/csv-core/main/src/index.ts \
  kits/csv/plugins/csv-core/package.json \
  kits/csv/plugins/csv-core/tests/file-policy.test.ts \
  kits/csv/plugins/csv-core/tests/plugin-main.test.ts \
  kits/csv/tests/kit-manifest.test.ts
git commit -m '[Feature] 删除 CSV 目录浏览协议'
```

### 任务 5：CSV Panel 迁移到浏览器原生选择器

**文件：**
- 修改：`kits/csv/plugins/csv-explorer/panel.connection/src/index.ts`
- 修改：`kits/csv/plugins/csv-explorer/panel.connection/src/index.css`
- 修改：`kits/csv/plugins/csv-explorer/tests/connection-panel.test.ts`

**接口：**
- 消费：`context.file.openLocal({ accept: '.csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain' })`
- 产出：现有 `sampleFile({ path })`，随后保持现有 `openFile(config)`

- [ ] **步骤 1：把 connection Panel 测试从目录按钮改为 file runtime mock**

```ts
const file = {
  openLocal: vi.fn(async () => '/data/people.csv'),
  saveLocal: vi.fn(),
};
```

覆盖：选择成功调用 `sampleFile`、取消无副作用、无路径桥错误展示、采样失败保留断开状态、重新选择抑制旧结果、确认配置调用 `openFile`、关闭文件与索引取消保持。断言 DOM 不再包含 `[data-file-path]`、目录标题、上一级或自制 backdrop。

- [ ] **步骤 2：运行 CSV Panel 测试验证红灯**

```bash
npm run test --prefix kits/csv -- --run plugins/csv-explorer/tests/connection-panel.test.ts
```

预期：Panel 仍调用 `getDefaultDirectory/listDirectory`，测试失败。

- [ ] **步骤 3：用 `context.file.openLocal` 替换自制浏览器**

删除 `FileEntry`、`FileDialog`、`dialog`、`dialogOpener`、`openBrowser`、`browseDirectory`、`renderDialog` 和 modal 焦点处理。`browse` 动作直接在现有 generation/busy 边界内：

```ts
const path = await context.file.openLocal({
  accept: '.csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain',
});
if (path) await chooseFile(path);
```

确保一次点击只进入一层 busy 管理：把 `chooseFile` 拆成不重复抢占 `actionBusy` 的采样 helper，或让 browse 统一持有整个选择与采样事务。删除只供自制弹窗使用的 CSS。

- [ ] **步骤 4：运行 CSV Panel 与完整 Kit 测试**

```bash
npm run test --prefix kits/csv -- --run plugins/csv-explorer/tests/connection-panel.test.ts
npm run test --prefix kits/csv
```

预期：全部通过，采样、配置确认与取消语义保持。

- [ ] **步骤 5：提交 CSV Panel 迁移**

```bash
git add kits/csv/plugins/csv-explorer/panel.connection/src/index.ts \
  kits/csv/plugins/csv-explorer/panel.connection/src/index.css \
  kits/csv/plugins/csv-explorer/tests/connection-panel.test.ts
git commit -m '[Feature] 迁移 CSV 原生文件选择'
```

### 任务 6：产品文档、Kit 版本与完整验收

**文件：**
- 修改：`kits/sqlite/README.md`
- 修改：`kits/csv/README.md`
- 修改：`kits/sqlite/kit.json`
- 修改：`kits/sqlite/package.json`
- 修改：`kits/sqlite/package-lock.json`
- 修改：`kits/csv/kit.json`
- 修改：`kits/csv/package.json`
- 修改：`kits/csv/package-lock.json`

**接口：**
- 产出：SQLite、CSV `0.1.0-preview.2` 发布意图
- 产出：Web 与 Electron 用户行为说明

- [ ] **步骤 1：更新 README 和三个版本来源**

SQLite README 将“受控文件选择/文件浏览器”改为浏览器原生打开与保存选择器，说明 Web 无真实路径时提示桌面本机限制，说明非空文件不覆盖。CSV README 说明浏览器原生选择、仅 Electron 本机路径可直接交给 core，Web 不上传文件。

将两个 Kit 的 `kit.json`、`package.json`、根 `package-lock.json` 中版本全部从 `0.1.0-preview.1` 改为 `0.1.0-preview.2`；不改插件内部 `0.0.1` 版本。

- [ ] **步骤 2：运行静态移除审计**

```bash
! rg -n 'listDirectory|getDefaultDirectory|getRecentDatabases|data-file-path|manualPath|type FileDialog' \
  kits/sqlite kits/csv --glob '!**/dist/**' --glob '!docs/**'
rg -n 'openLocal|saveLocal|LOCAL_FILE_PATH_UNAVAILABLE|getPathForFile' \
  packages scripts kits/sqlite kits/csv --glob '!**/dist/**'
```

预期：第一条无匹配且退出 0；第二条命中公共 runtime、preload 和两个 Kit Panel。

- [ ] **步骤 3：运行聚焦测试、构建和仓库检查**

```bash
npm run build -w @itharbors/plugin-types
npm run test -w packages/server -- --run tests/routes/panel-asset.test.ts
node --test scripts/lib/electron-launcher.test.mjs
npm run test --prefix kits/sqlite
npm run test --prefix kits/csv
npm run check
```

预期：所有命令退出 0；`npm run check` 覆盖框架、全部 Kit、插件构建、工作流和 release intent。

- [ ] **步骤 4：执行 Web 共享路径验收**

运行：

```bash
npm run dev:web -- --kit sqlite
```

在浏览器确认 SQLite“打开数据库”调用系统文件选择器，取消无副作用，选择文件后显示统一“只能读取运行 Harbors 的本机文件”提示。随后以 CSV 直达地址确认同样行为，且页面中没有自制目录弹窗。

- [ ] **步骤 5：执行 Electron 桌面路径验收**

运行：

```bash
npm run dev -- --kit sqlite
```

确认：SQLite 能用系统打开选择器打开现有数据库；系统保存选择器能新建数据库；取消不报错；非空已有文件不被覆盖。再打开 CSV Kit，确认选择本机 CSV 后进入预览并可确认打开。

- [ ] **步骤 6：提交文档与版本**

```bash
git add kits/sqlite/README.md kits/sqlite/kit.json kits/sqlite/package.json kits/sqlite/package-lock.json \
  kits/csv/README.md kits/csv/kit.json kits/csv/package.json kits/csv/package-lock.json
git commit -m '[Feature] 发布数据库 Kit 原生文件选择'
```

- [ ] **步骤 7：完成交付前审计**

```bash
git status --short
git diff origin/main...HEAD --check
git diff --stat origin/main...HEAD
git log --oneline origin/main..HEAD
```

预期：worktree 干净；diff 只包含设计、计划、公共文件能力、SQLite/CSV 迁移、测试、文档和版本；所有实现提交都符合仓库标题格式。
