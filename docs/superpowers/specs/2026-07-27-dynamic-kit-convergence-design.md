# 动态 Kit 机制收口设计

## 背景

Kit 来源统一改造已经让桌面启动器在 stable profile 下只把显式 builtin 和已激活 installed Kit
交给 Server，development profile 则额外加入仓库 Kit。但运行链路仍残留若干旧假设：Server 可以绕过
来源快照自行扫描目录，窗口入口会再次从仓库猜测 Kit 根目录，稳定启动仍构建全部开发 Kit，Tray 会展示
当前 Catalog 中不存在的历史工作区，冲突 Kit 还可能阻断整个 Catalog。桌面打包和文档中也保留了独立的
Kit 名单或旧环境变量。

这些残留会造成“Catalog 已经识别 Kit，但页面无法打开”“没有加载开发 Kit，却仍被它的构建错误阻塞”
以及菜单中出现不可点击项等表面矛盾。本设计将所有运行时消费者收口到同一份不可变来源快照。

## 目标

1. Electron、Server、Session、窗口入口和测试只消费统一的 `kitSources` 快照。
2. 动态安装 Kit 的主窗口和次级窗口资源从实际激活目录加载，不再扫描仓库或 `node_modules` 猜测。
3. `npm run start` 只构建稳定运行时及 builtin Kit；开发 Kit 的构建失败不能阻止稳定启动。
4. Tray 只展示当前 Catalog 中可用的 Kit，同时保留历史工作区数据供重新安装后恢复。
5. 包名或菜单根节点冲突只隔离相关 Kit，并输出可诊断信息，不阻止无关 Kit 启动。
6. builtin 清单成为运行、构建和桌面打包的共同声明源。
7. 删除旧的 installed-only Server 配置入口，不保留双机制兼容层。

## 非目标

- 不改变 `.hkit`、Registry、Release、签名、摘要或兼容性协议。
- 不增加新的启动子命令，也不改变 `npm run dev` 会加载仓库开发 Kit 的语义。
- 不实现 Kit 热替换、卸载或历史版本垃圾回收。
- 不删除用户的历史工作区记录。
- 不改变同一 Kit 只有一个 active 安装版本参与启动的规则。

## 方案选择

采用一次性彻底收口方案：删除 `HARBORS_INSTALLED_KITS`、`installedKitDirs` 和生产运行时的目录扫描
回退，并同步修复所有依赖旧机制的调用方、测试、构建和文档。

没有采用兼容桥接方案，因为保留旧入口会允许直接启动 Server 时绕过桌面 Catalog 的身份、来源优先级和
冲突决策，继续形成两套真实行为。也没有只修复窗口 404 和 Tray 的最小补丁，因为它无法解决 stable
启动被开发 Kit 构建阻断以及打包清单漂移的问题。

## 统一运行时边界

### 来源快照

启动器解析候选来源后生成不可变快照：

```ts
interface AssemblyKitSource {
  directory: string;
  source: 'builtin' | 'installed' | 'development';
}
```

桌面进程将该快照通过唯一的 `HARBORS_KIT_SOURCES` 环境变量交给 Framework 子进程。Server 的程序化
入口通过必填的 `kitSources` 选项接收同一结构。生产代码不再接受 `installedKitDirs`，不再读取
`HARBORS_INSTALLED_KITS`，也不会在缺少快照时扫描 `kits/*` 或安装目录。

`createDefaultAssemblyConfig` 仍可负责与插件、客户端资源有关的默认路径，但 Kit 解析必须拥有显式
`kitSources`。直接运行 Server 而未提供有效快照应在监听端口前失败，并给出缺少统一来源快照的错误。
测试若需要多个仓库 Kit，必须由测试 helper 显式构造来源快照，不能恢复生产回退逻辑。

### Session 与窗口入口

Assembly 从快照解析 Kit 后，Session 使用解析结果中的绝对目录加载 Kit。Editor 在成功加载时保存当前
Kit 的内部运行时目录，并在切换失败回滚时同时恢复该目录。这个目录只用于 Server 内部资源解析，不加入
公开 bootstrap 数据，避免向 renderer 暴露本地文件系统路径。

窗口入口路由直接从对应 Session 的 Editor 取得当前 Kit 目录，随后：

1. 读取已经验证的 `windowEntries.main` 或 `windowEntries.secondary` 相对路径；
2. 对根目录和目标执行真实路径解析；
3. 拒绝绝对路径、符号链接逃逸、目录目标和不存在的文件；
4. 只返回位于当前 Kit 根目录内的普通文件。

路由不再调用插件信息推断 Kit 身份，也不扫描工作目录、父目录或 `node_modules`。因此 Catalog 选中的
installed 目录就是资源加载的唯一依据。

## Catalog 冲突隔离

每个候选先独立完成 manifest、安装元数据和启动插件校验。无效的 installed/development 候选记录诊断
后被隔离；显式请求或 pending 激活校验仍保持严格失败。

来源优先级固定为：

1. `builtin`
2. `development`
3. `installed`

该顺序保证 builtin 永远不能被商城覆盖，同时 `npm run dev` 的仓库源码临时遮蔽同 ID 的已安装版本。
包名和 `menuRoot` 使用同一套分组决策：

- 最高优先级只有一个候选时选择它，并忽略该组的低优先级候选；
- 最高优先级存在多个不同目录时，整个冲突组都不进入 Catalog，不回退到低优先级候选；
- 指向同一真实目录的重复输入先去重，不视为冲突；
- 每个被忽略或隔离的候选都产生不包含敏感安装元数据的诊断记录。

冲突处理按包名分组后再按 `menuRoot` 分组。任一组的异常只影响组内候选；其他 Kit 继续进入 Catalog。
显式请求的 Kit 如果在冲突处理中被隔离，启动应返回明确的冲突错误，而不是退回 Default Kit。

## 稳定启动构建边界

根 `build` 保持完整仓库构建语义，继续服务 CI、开发和发布。新增稳定运行时构建链，由 `prestart` 调用，
只构建：

- Framework 所需 contracts 和共享 packages；
- client 与 server；
- Framework builtin plugins；
- `BUILTIN_KITS` 声明目录中的 Kit plugins；
- 稳定运行时需要的随包资源。

稳定构建目标从统一 builtin 声明派生，禁止枚举普通 `kits/*`。因此 CSV、SQLite、MySQL、Notifications
等非 builtin 仓库 Kit 即使源码暂时无法构建，也不会阻止 `npm run start`。`npm run dev` 和根 `build`
仍可构建全部仓库 Kit。

构建失败应保持非零退出，Electron 不得启动。不会在本次改造中引入增量缓存或吞掉构建错误。

## Tray 与工作区状态

WorkspaceStore 继续保留所有历史记录，包括当前未安装 Kit 的 session id 和窗口位置。读取状态时仍可标记
Catalog 可用性，但 Tray 模板只遍历当前 Catalog 条目，不再为 `available: false` 的记录创建禁用菜单项。

当用户重新安装并激活同一 Kit 后，它重新进入 Catalog，原工作区记录可再次用于恢复 session 和窗口位置。
本次改造不迁移或删除 `workspaces.json`，从而兼顾菜单准确性和状态可恢复性。

## 桌面打包声明

桌面运行时 staging 删除独立的 `PRODUCT_KITS` 与 builtin 插件硬编码名单。允许复制的 Kit 目录和需要随包
的 Kit 插件均从 `BUILTIN_KITS` 派生；任何不在声明中的 `kits/<slug>` 输入都在复制前拒绝。

当前 `BUILTIN_KITS` 只有 Default Kit，因此稳定桌面包不包含 CSV、SQLite、MySQL、Notifications。
未来若增加 builtin，只修改一份声明即可同步运行时发现、稳定构建和桌面打包。

## 错误处理与可观测性

- 来源快照缺失或格式错误：Framework 在监听端口前失败。
- installed/development 单个候选无效：隔离候选并记录诊断；不影响无关 Kit。
- pending 激活或显式请求无效：严格失败，Kit Manager 可据此回滚。
- 包名或 `menuRoot` 冲突：按优先级选择或隔离冲突组，并记录候选来源与冲突键。
- 窗口入口越界或不存在：继续使用现有结构化 404/安全错误，不尝试其他目录。
- 稳定构建缺失必要 builtin 产物：`prestart` 非零退出，不启动 Electron。

诊断可以写入现有启动日志或 Catalog diagnostics，但不得包含 digest、下载凭据或用户目录之外的无关环境
信息。对 UI 暴露诊断不属于本次范围。

## 测试与验收

### 测试先行回归

1. 用临时外部目录创建 installed Kit，通过 `kitSources` 启动真实 Server Session，并验证 main/secondary
   窗口入口均返回 200 与正确内容。
2. 证明 Server 拒绝 `installedKitDirs` 和 `HARBORS_INSTALLED_KITS`，并在缺少 `kitSources` 时启动失败。
3. 构造包名和 `menuRoot` 冲突，验证冲突组被隔离、健康 Kit 仍可用、builtin/development 优先级生效。
4. 验证 Tray 只包含 Catalog Kit，同时 WorkspaceStore 仍保留 unavailable 记录。
5. 在临时非 builtin Kit 中制造构建错误，验证稳定构建成功而完整构建仍会检查该 Kit。
6. 验证桌面 staging 只接受 `BUILTIN_KITS`，并覆盖 CSV 在内的所有非 builtin 目录。

### 迁移与文档检查

- 将 Server、Kit Registry 和 Kit Manager 验收测试全部改为显式 `kitSources`。
- 全仓搜索确保生产代码和有效文档中不存在 `HARBORS_INSTALLED_KITS` 或 `installedKitDirs`。
- 更新 Kit artifact 与开发指南，明确 Default 是 builtin，其余官方 Kit 通过市场安装，开发模式才加载源码。

### 完成门槛

- 相关单元与集成测试通过；
- `npm run build` 与完整 `npm test` 通过；
- `npm run start` 的稳定构建不枚举非 builtin Kit；
- 动态安装 Kit 的 Session、主窗口和次级窗口可完整打开；
- Catalog 冲突不会阻断无关 Kit；
- Git 差异不包含生成产物或用户状态文件。
