# Harbors 单分支多 Kit 目录设计

## 背景

Harbors 的 `main` 已经包含 `kits/sqlite`、`kits/mysql` 和 `kits/notifications`，但当前发布体系又把
三个产品投影到 `kit/sqlite`、`kit/mysql`、`kit/notifications` 长期分支，并通过独立的
`kit-registry` 分支保存逐版本市场元数据。这形成了两份产品源码、四条长期分支和额外的 Registry
提交链，也让公共发布工具、文档和本地开发 Skill 必须跨分支同步。

本设计取消长期 Kit 产品分支。三个官方 Kit 以 `main` 下的独立目录作为唯一源码来源，使用仓库级唯一
Tag 选择要发布的 Kit。GitHub Actions 只从被选中的目录构建 `.hkit` Release Asset，随后从可信
Release 全量重建市场索引。Kit 发布和 Framework 发布使用不同 Tag 与 Workflow，因此 Kit 进入
`main` 不会改变 Framework 版本，也不会触发 Framework 发布。

本设计取代《Kit 独立发布与市场设计》中关于产品分支、Preview 分支发布和 `kit-registry` 逐版本提交
的内容。Kit 制品格式、签名校验、安装、激活、回滚和审计协议保持不变。

## 目标

1. `main` 是三个官方 Kit 的唯一长期源码分支。
2. SQLite、MySQL 和 Notifications 分别位于 `kits/sqlite`、`kits/mysql` 和
   `kits/notifications`。
3. 每个 Kit 独立声明 manifest、版本、依赖、测试、构建命令和发布载荷。
4. `kit/<slug>/v<semver>` Tag 只发布 `kits/<slug>`。
5. 发布只上传经过验证的 `.hkit`、`release.json`、checksums、SBOM 和 Attestation；GitHub 自动生成
   的仓库源码 ZIP 不参与安装。
6. Release 成功后自动从可信 Releases 全量重建 `index.v1.json`，不再提交逐版本 Registry JSON。
7. Framework 保持现有发现、下载、验证、安装、激活和回滚能力；普通 Kit 发布不要求发布新
   Framework。
8. 新链路完成验收前保留旧产品分支与 `kit-registry` 分支作为只读回退来源。

## 非目标

- 不把每个 Kit 拆成独立仓库。
- 不继续建设 `itharbors/harbors-kits`；本地克隆与远端仓库暂时保留，但不作为发布源。
- 不把 GitHub 自动生成的 Source code ZIP 改造成可安装制品。
- 不改变 `.hkit`、`kit.json`、`release.json`、Registry index 或本地 Store schema。
- 不在新链路验收前删除、force-push 或重写旧产品分支、Tag、Release。
- 不要求每个 Kit 使用独立 npm 锁文件；根 `package-lock.json` 负责可复现的 monorepo 安装，每个 Kit
  的 `package.json` 负责独立依赖声明。

## 仓库模型

```text
harbors/
├── apps/                         # Framework 应用
├── packages/                     # Framework 与发布工具包
├── plugins/                      # Framework 内建插件
├── kits/
│   ├── default/                  # Framework 随附的默认 Kit
│   ├── sqlite/
│   │   ├── kit.json
│   │   ├── package.json
│   │   ├── plugins/
│   │   └── tests/
│   ├── mysql/
│   │   └── ...
│   └── notifications/
│       └── ...
├── registry/
│   ├── policy.json               # 可信发布来源与版本选择政策
│   └── revocations.json          # 被撤回的版本或摘要
└── .github/workflows/
    ├── kit-ci.yml                # 路径感知的 Kit PR/主干检查
    ├── publish-kit.yml           # Tag 驱动的单 Kit 发布
    └── publish-kit-registry.yml  # Release 驱动的索引重建与 Pages 部署
```

`main` 是唯一长期开发分支。Kit 功能分支使用普通短期分支并向 `main` 提交 PR，不再以产品分支作为
PR base。`change-workflow` 负责常规分支生命周期；`kit-workflow` 只保留 Kit 范围识别、版本准备、
发布前验证和受确认保护的 Tag 发布能力。

`harbors-kits/` 本地克隆加入父仓库 `.gitignore`，避免被父仓库误提交。其现有 Git 历史和远端内容
保持不变，待本方案稳定后再单独决定归档方式。

## Kit 目录契约

每个可发布目录必须至少包含：

```text
kits/<slug>/
├── kit.json
├── package.json
├── layout.json
├── main.html
├── secondary.html
├── plugins/
└── tests/
```

目录名 `<slug>` 是发布标识。`kit.json.id`、`package.json.name` 和菜单 ID 继续使用现有协议值，发布
工具维护一份显式 slug 到 Kit ID 的映射并拒绝目录名、Tag 和 manifest 不一致。每个 Kit 的
`package.json` 独立声明其产品依赖和测试/构建入口；根 workspace 负责复用 Framework 工具包与锁定
整仓依赖。

构建结果不得写回其他 Kit 目录。打包器接收明确的 Kit 目录，只收集该 Kit manifest 所描述的运行时
载荷；`packages/` 中用于构建的 CLI、schema 或测试工具不得作为隐式源码目录打进 `.hkit`。Kit 构建
必须把运行时所需代码打入插件产物或显式载荷，离线 inspect 拒绝未解析的 workspace 依赖。

## 开发与路径级 CI

普通 Kit 变更从 `main` 创建短期分支，PR base 固定为 `main`。Workflow 先对 base/head diff 分类：

- 只修改 `kits/<slug>/**`：运行该 Kit 的 build、test、validate、dry-run pack 和 inspect。
- 修改多个 Kit：验证所有受影响 Kit。
- 修改 Kit 公共协议、CLI、打包器、发布脚本、公共 Workflow、根锁文件或 Registry schema：验证全部三个
  官方 Kit。
- 只修改与 Kit 无关的 Framework 文件：不运行昂贵的 Kit 全矩阵，但保留现有 Framework CI。

路径分类只是减少无关检查，不能作为安全边界。发布 Tag Workflow 始终重新运行目标 Kit 的完整检查，
不会复用未经验证的 PR 产物。

Kit PR 合并不会创建 GitHub Release、更新 Registry Pages 或修改 Framework 版本。需要发布时，在
已经合入 `main` 的 Commit 上准备并推送受保护 Tag。

## Tag 与版本规则

发布 Tag 采用仓库级唯一格式：

```text
kit/sqlite/v1.2.0
kit/mysql/v2.0.1
kit/notifications/v1.1.0
```

Workflow 对 Tag 执行严格解析：

1. `<slug>` 必须属于 `sqlite`、`mysql` 或 `notifications`，且 `kits/<slug>` 存在。
2. Tag 必须指向 `main` 可达的 Commit；游离提交或未合并功能分支不能发布。
3. Tag 的 SemVer 必须与目标 `kit.json.version` 及 `package.json.version` 完全一致。
4. 普通 `X.Y.Z` 版本要求 `kit.json.channel` 为 `stable`。
5. `X.Y.Z-<prerelease>` 版本要求 `kit.json.channel` 为 `preview`。
6. 同名 Tag 或 GitHub Release 已存在时失败，不覆盖现有资产。
7. 发布元数据记录 Tag Commit、仓库、Workflow ref、Kit 目录和制品 SHA-256。

GitHub Tag 指向的是整个 monorepo Commit，但 Tag 名只选择一个 Kit。其他 Kit 在该 Commit 中的状态不会
进入目标 `.hkit`，也不会被写入该版本的 `release.json`。

## 发布流程

```text
push kit/<slug>/v<semver>
  -> checkout Tag Commit
  -> 解析 slug 与版本
  -> 验证 Commit 可从 origin/main 到达
  -> npm ci（根锁文件）
  -> 目标 Kit build/test/validate
  -> pack kits/<slug>
  -> 离线 inspect .hkit
  -> 生成 release.json、checksums 与 SBOM
  -> 生成 Artifact Attestation
  -> 创建不可覆盖的 GitHub Release
  -> 触发 Registry 全量重建
```

发布 Workflow 通过最小权限运行。测试和构建阶段只读仓库；创建 Release 的 Job 仅获得
`contents: write` 与生成 Attestation 所需的 `id-token`/`attestations` 权限。Workflow 明确设置
`GH_REPO=itharbors/harbors` 或对所有 `gh` 命令传入 `--repo`，不能依赖当前目录的 Git remote。

`.hkit` 是唯一供 Framework 下载和安装的 Kit 载荷。GitHub Release 页面可以同时显示 GitHub 自动
生成的 Source code ZIP/TAR，但 Registry 不为它们生成下载 URL，Framework 也不接受它们作为 Kit
制品。

## 自动市场索引

`main` 只保存低频治理文件：

```text
registry/policy.json
registry/revocations.json
```

`publish-kit.yml` 创建 Release 后，以最后一个 reusable-workflow Job 调用
`publish-kit-registry.yml`；只有该次 Release Job 成功才会进入聚合。Registry Workflow 同时提供
`workflow_dispatch`，用于部署失败后的人工重试，以及 policy 或 revocations 合并后的主动重建。
聚合器使用 GitHub API 枚举仓库中符合 `kit/*/v*` 的可信 Releases，并对每个候选执行：

1. 严格解析 Tag、`release.json` 与资产名称。
2. 校验 Kit ID、slug、版本、channel、Tag Commit、Workflow identity 和 SHA-256 一致。
3. 要求 `.hkit` Attestation 的 subject digest 与 Release Asset 一致。
4. 应用 `registry/policy.json` 的发布者和兼容性政策。
5. 应用 `registry/revocations.json`，剔除被撤回的 Tag、版本或摘要。
6. 按确定性规则计算每个 Kit 的最新 Stable 和 Preview，并保留协议要求的版本列表。

聚合器每次从全部有效 Releases 重建完整 `index.v1.json`，不做增量修改，也不向 Git 分支提交逐版本
JSON。仓库级 concurrency group 串行化 Pages 部署；任何候选校验或部署失败时保留上一份已验证索引，
并让 Workflow 明确失败。

GitHub Pages 继续提供 Framework 使用的稳定 URL。Framework 默认 Registry URL 若保持不变，则无需
为仓库内迁移发布新版本；只有 URL 或信任策略确实发生变化时，才进行一次 Framework 兼容更新。

## Framework 发布解耦

Framework 和 Kit 使用互不重叠的触发器：

- Framework Workflow 只响应 Framework 自身的版本 Tag 或人工发布入口。
- Kit Workflow 只响应 `kit/*/v*` Tag。
- 普通 `main` push 和 Kit PR 只运行 CI，不创建任何正式 Release。

根 `package.json` 和根锁文件可能因 Kit 依赖变化而更新，这属于 monorepo 源码变更，不代表 Framework
运行时版本发生变化。Framework 的版本号只由 Framework 发布流程维护，Kit Workflow 不修改它。

## 迁移步骤与数据来源

`main` 中现有 `kits/sqlite`、`kits/mysql`、`kits/notifications` 是目标目录，不通过复制整棵产品分支
覆盖。迁移时逐一把旧分支 tip 与 `main` 对应目录进行受控比较：

1. 保存 `origin/kit/<slug>` tip SHA，作为回退证据。
2. 比较业务源码、测试、manifest 和布局；把仅存在于产品分支的有效修复迁入对应目录。
3. 不迁入产品分支根部复制的 Framework 工具包、发布脚本或仓库治理文件。
4. 将产品分支根 `kit.json` 映射为 `kits/<slug>/kit.json`，并确保版本与产品
   `package.json` 一致。
5. 更新根 workspace、锁文件、文档、测试与 Skill，使其只引用 `main` 和 `kits/<slug>`。
6. 实现新的 Tag 发布和 Release 聚合 Workflow。
7. 先用 Notifications prerelease Tag 完成 `.hkit`、Attestation、Release、Pages、Framework 下载与
   安装的端到端验收。

旧产品分支和 `kit-registry` 在验收期内不再接收新版本，但保留为只读回退来源。删除或归档必须另行
审批；本次实施不 force-push 它们。

## 故障处理与回退

- Tag 解析、版本一致性、测试、构建、打包或 inspect 任一步失败：不创建 Release，不更新市场。
- Release 已创建但市场重建失败：保留 Release 供排查，Pages 保持上一版索引；修复后重跑聚合器。
- 多个 Kit 同时发布：发布可并行，Registry 重建串行并全量计算，最终索引必须包含全部成功 Release。
- 错误 Release：不覆盖资产；通过治理变更把对应 Tag、版本或 digest 加入 revocations 后重建市场。
- 新链路无法满足验收：Framework 继续使用旧 Registry，旧分支保持原 tip，不删除任何历史。

## 验证与验收

目录级验收：

- 三个目标目录各有合法且相互独立的 `kit.json` 与 `package.json`。
- 每个 Kit 的 build、test、validate、dry-run pack 与离线 inspect 通过。
- `.hkit` 只包含目标 Kit 的运行时载荷，不包含其他 Kit 或整个仓库源码。
- 旧分支有效产品修复均可在 `main` 对应目录找到，差异有明确解释。

工作流验收：

- 路径级 CI 能正确选择单个、多个或全部 Kit。
- 错误 slug、非 `main` 可达 Commit、版本不一致和重复 Tag 均在创建 Release 前失败。
- Notifications prerelease Tag 只构建 Notifications，并产生可验证的 `.hkit` Asset 与 Attestation。
- Registry 重建不产生 Git commit，Pages `index.v1.json` 包含该 Preview。
- 两个 Kit 连续或并发发布后，最终索引同时包含两者。

系统级验收：

- Framework 从 Pages 索引发现、下载并校验 Notifications Preview。
- 安装后保持待重启激活语义，并能回滚到旧版本。
- Kit 发布过程中没有 Framework Release，也没有 Framework 版本变更。
- 新链路验证完成前，旧产品分支和旧 Registry 均仍可读取。

## Git 与身份治理

- 保护 `main`，通过 PR 合并，禁止 force-push 和删除。
- 保护 `kit/*/v*` Tag，发布前要求明确确认目标 Tag 与 Commit。
- Release Asset 不可覆盖，发布 Workflow 使用固定或受保护的工具链引用。
- 迁移和后续提交的 Author 与 Committer 使用仓库本地配置：
  `VisualSJ <devhacker520@hotmail.com>`。
- 提交标题遵循仓库 `[Feature]`、`[Bug]`、`[Docs]` 等中文摘要规范。
