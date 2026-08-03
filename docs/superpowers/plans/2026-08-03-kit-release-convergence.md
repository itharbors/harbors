# Kit 发布收敛修复实现计划

> **给 agentic 工作者：** 必需的子 skill：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法进行跟踪。

**目标：** 修复 MySQL Kit 发布预检的共享工作区构建缺口，以不可变的新 Preview 版本重新发布，并让已经发布的 TraceWeave 出现在在线 Registry。

**架构：** Kit 检查入口在加载 Server 前显式构建其 TypeScript 工作区依赖，使本地检查、发布预检和可复用发布任务使用同一依赖闭包。MySQL 已失败的 `preview.2` Tag 保持不变，修复版本推进到 `preview.3`；TraceWeave 不重新打 Tag，而是使用已经合入 `main` 的动态 Release 发现逻辑重新生成 Registry。

**技术栈：** Node.js 22、npm workspaces、TypeScript、Node test runner、GitHub Actions、GitHub Pages Kit Registry。

## 全局约束

- 不修改或复用不可变的 `kit/mysql/v0.1.0-preview.2` Tag。
- MySQL 修复版本必须是 `0.1.0-preview.3`，channel 保持 `preview`。
- `kit.json`、`package.json`、Kit lockfile 根身份和制品名称必须使用同一版本。
- TraceWeave 保持 `0.1.0-preview.1`，不得创建替代 Release。
- 所有代码改动留在 `bug/kit-release-convergence` 工作区中。

---

### Task 1：补齐 Kit 检查的共享构建依赖

**文件：**
- 修改：`scripts/lib/kit-matrix.test.mjs`
- 修改：`scripts/lib/kit-check.test.mjs`
- 修改：`scripts/run-kit-matrix.mjs`
- 修改：`package.json`

**接口：**
- 消费：npm workspace `build` scripts。
- 产出：在 `@itharbors/server` 之前依次构建 `@itharbors/plugin-types` 和 `@itharbors/host-security` 的 Kit 检查启动序列。

- [ ] **步骤 1：编写失败的构建顺序测试**

  将矩阵测试的第一条真实命令期望改为：

  ```js
  ['run', 'build',
    '-w', '@itharbors/kit-core',
    '-w', '@itharbors/kit-cli',
    '-w', '@itharbors/plugin-types',
    '-w', '@itharbors/host-security',
    '-w', '@itharbors/server']
  ```

  同时将根 `kit:check` 契约改为完全相同的 workspace 顺序后再调用 `node scripts/check-kit.mjs`。这两个断言捕获的故障是：新增 Server 工作区依赖后，干净 checkout 的发布任务仍跳过依赖构建。

- [ ] **步骤 2：运行测试并验证预期失败**

  运行：

  ```bash
  node --test scripts/lib/kit-matrix.test.mjs scripts/lib/kit-check.test.mjs
  ```

  预期：FAIL，实际命令缺少 `@itharbors/plugin-types` 和 `@itharbors/host-security`。

- [ ] **步骤 3：实现最小构建闭包修复**

  在 `runKitMatrix()` 的启动命令和 `package.json` 的 `kit:check` script 中插入这两个 workspace，保持 Server 最后构建，不改其他生命周期逻辑。

- [ ] **步骤 4：运行测试并验证通过**

  运行：

  ```bash
  node --test scripts/lib/kit-matrix.test.mjs scripts/lib/kit-check.test.mjs
  ```

  预期：PASS。

### Task 2：创建 MySQL 不可变修复版本

**文件：**
- 修改：`scripts/lib/kit-check.test.mjs`
- 修改：`kits/mysql/kit.json`
- 修改：`kits/mysql/package.json`
- 修改：`kits/mysql/package-lock.json`

**接口：**
- 消费：任务 1 的干净 checkout 构建闭包。
- 产出：`@itharbors/kit-mysql@0.1.0-preview.3` 以及 `kit-mysql-0.1.0-preview.3-any-any.hkit`。

- [ ] **步骤 1：先把 MySQL 制品契约改为 Preview 3**

  将 `scripts/lib/kit-check.test.mjs` 中 MySQL 的两个制品字面量改成 `kit-mysql-0.1.0-preview.3-any-any.hkit`。该测试捕获的故障是 manifest 仍指向已经占用且发布失败的 Preview 2 身份。

- [ ] **步骤 2：运行测试并验证预期失败**

  运行：

  ```bash
  node --test scripts/lib/kit-check.test.mjs
  ```

  预期：FAIL，实际制品路径仍包含 `0.1.0-preview.2`。

- [ ] **步骤 3：同步四处版本身份**

  将 `kits/mysql/kit.json.version`、`kits/mysql/package.json.version`、`kits/mysql/package-lock.json.version` 和 `kits/mysql/package-lock.json.packages[""].version` 更新为 `0.1.0-preview.3`。

- [ ] **步骤 4：验证 MySQL 检查和真实制品**

  运行：

  ```bash
  node --test scripts/lib/kit-check.test.mjs
  npm run kits:boundary -- mysql
  node scripts/run-kit-matrix.mjs check mysql
  output_directory="$(mktemp -d)"
  npm run kit:check -- mysql --output-directory "$output_directory"
  ```

  预期：全部退出 0，输出目录中只有一个 Preview 3 `.hkit`。

### Task 3：重新生成线上 TraceWeave Registry 条目

**文件：**
- 不修改仓库文件；操作现有 `publish-kit-registry.yml`。

**接口：**
- 消费：`main` 已合入的动态 Kit Tag 发现与 TraceWeave Release `kit/traceweave/v0.1.0-preview.1`。
- 产出：线上 `index.v1.json` 中 `@itharbors/kit-traceweave` 的 Preview 1 条目。

- [ ] **步骤 1：从 main 调度 Registry 刷新**

  运行：

  ```bash
  gh workflow run publish-kit-registry.yml --ref main -f request-id="manual-traceweave-convergence-<timestamp>"
  ```

- [ ] **步骤 2：等待对应工作流完成**

  使用精确 `request-id` 查找 run，随后运行 `gh run watch <run-id> --exit-status`。预期：工作流成功。

- [ ] **步骤 3：验证线上条目**

  下载 `https://itharbors.github.io/harbors/index.v1.json`，断言存在 `@itharbors/kit-traceweave`，版本为 `0.1.0-preview.1`，Release manifest URL 指向既有 Tag。

### Task 4：回归验证并交付 PR

**文件：**
- 修改：`docs/superpowers/plans/2026-08-03-kit-release-convergence.md`

**接口：**
- 消费：任务 1–3 的修复和验证证据。
- 产出：聚焦的 `[Bug]` 提交和目标为 `main` 的已验证 PR。

- [ ] **步骤 1：运行聚焦与工作流测试**

  运行：

  ```bash
  node --test scripts/lib/kit-matrix.test.mjs scripts/lib/kit-check.test.mjs scripts/lib/kit-publish/workflows.test.mjs scripts/lib/kit-release-intent-cli.test.mjs
  npm run kit:check -- mysql --output-directory "$(mktemp -d)"
  ```

- [ ] **步骤 2：检查差异并提交**

  只暂存本计划列出的文件，提交标题：

  ```text
  [Bug] 修复 Kit 发布收敛与 MySQL 预检
  ```

- [ ] **步骤 3：使用仓库变更工作流创建 PR**

  PR 摘要使用“修复 Kit 发布收敛与 MySQL 预检”，正文包含实际运行过的 `## Summary` 和 `## Testing`，然后调用 `finish-change.sh` 并验证 PR 目标分支为 `main`。
