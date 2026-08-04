# 需求开发检查效率优化实现计划

> **给 agentic 工作者：** 必需的子 skill：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法进行跟踪。

**目标：** 在不减少最终覆盖的前提下，为需求开发提供紧凑快速预检，删除根检查重复阶段，并避免功能分支 push/PR 双 CI。

**架构：** 保留现有公共测试入口，通过 `test:framework:prepared` 让根门禁只构建一次；根门禁只执行一次 `kits:check` 作为 Kit build/test/validate/pack 超集。开发循环使用 dot reporter 预检，finish 继续拥有唯一全量门禁。

**技术栈：** Node.js 22 test runner、npm workspaces、Bash、GitHub Actions YAML。

## 全局约束

- 保留现有最终测试、架构检查和 Kit 生命周期覆盖。
- 第一版不实现 workspace/Kit 依赖闭包选择器。
- 第一版不并发运行本地 Kit matrix。
- 不缓存或复用可编辑的本地“检查通过凭证”。
- 不改变 `npm test`、`kits:test`、`kits:check` 或 `plugins:check` 的独立公共语义。
- 功能分支只通过 pull_request 触发 Framework CI，main push 和 merge group 继续受保护。

---

### 任务 1：锁定根检查去重契约

**文件：**
- 修改：`scripts/lib/ci-workflow.test.mjs`
- 修改：`package.json`

**接口：**
- 产出：`test:framework:prepared`、`test:preflight`、`check:preflight` 和去重后的 `check` npm scripts。

- [ ] **步骤 1：编写失败测试**

在根脚本契约测试中断言：

```js
assert.equal(
  packageJson.scripts['test:framework'],
  'npm run test:toolchain && npm run test:framework:prepared',
);
assert.match(packageJson.scripts['test:framework:prepared'], /npm run test -w packages\/server/u);
assert.match(packageJson.scripts['test:preflight'], /--test-reporter=dot/u);
assert.equal(
  packageJson.scripts['check:preflight'],
  'npm run kits:boundary && npm run test:preflight',
);
assert.equal(
  packageJson.scripts.check,
  'npm run build && npm run test:framework:prepared && npm run test:workflows && npm run kits:check && npm run plugins:check:framework',
);
```

该测试捕获的故障是根 check 再次调用 toolchain build、`kits:test` 或 `kits:build`。

- [ ] **步骤 2：验证 RED**

运行：`node --test scripts/lib/ci-workflow.test.mjs`

预期：FAIL，提示 `test:framework:prepared` 或 `check:preflight` 不存在，或 check 字符串不匹配。

- [ ] **步骤 3：最小实现**

将原 `test:framework` 的 build 后测试内容移动到 `test:framework:prepared`；令公开
`test:framework` 先运行 `test:toolchain` 再委托 prepared。新增 dot reporter 预检并将根 check
改为单次 build、prepared Framework、workflow、`kits:check`、Framework 插件检查。

- [ ] **步骤 4：验证 GREEN**

运行：`node --test scripts/lib/ci-workflow.test.mjs`

预期：全部通过。

- [ ] **步骤 5：提交**

```bash
git add package.json scripts/lib/ci-workflow.test.mjs
git commit -m '[Optimize] 去除根检查重复生命周期'
```

### 任务 2：限制 Framework CI 重复触发

**文件：**
- 修改：`scripts/lib/ci-workflow.test.mjs`
- 修改：`.github/workflows/ci.yaml`

**接口：**
- 消费：现有 `parseWorkflowTriggers` 测试辅助。
- 产出：Framework CI 仅对 main push、pull_request 和 merge_group 运行。

- [ ] **步骤 1：编写失败测试**

增加行为断言：

```js
assert.deepEqual([...triggers.get('push').get('branches')], ['main']);
assert.ok(triggers.has('pull_request'));
assert.ok(triggers.has('merge_group'));
```

如现有 parser 不返回值集合，则以现有 YAML parser 输出结构增加最小 branches 值解析；测试必须
能区分 `push: {}` 与仅 main push。

- [ ] **步骤 2：验证 RED**

运行：`node --test scripts/lib/ci-workflow.test.mjs`

预期：FAIL，因为当前 push 没有 main branches 限制。

- [ ] **步骤 3：最小实现**

将 `.github/workflows/ci.yaml` 的 trigger 改为：

```yaml
push:
  branches:
    - main
merge_group:
pull_request:
  types:
    - opened
    - synchronize
    - ready_for_review
```

- [ ] **步骤 4：验证 GREEN**

运行：`node --test scripts/lib/ci-workflow.test.mjs`

预期：全部通过。

- [ ] **步骤 5：提交**

```bash
git add .github/workflows/ci.yaml scripts/lib/ci-workflow.test.mjs
git commit -m '[Optimize] 避免功能分支重复触发 CI'
```

### 任务 3：记录开发与完成流程

**文件：**
- 修改：`docs/guides/development-workflow.md`
- 修改：`scripts/lib/kit-docs.test.mjs`
- 创建：`docs/superpowers/specs/2026-08-03-development-check-efficiency-design.md`
- 创建：`docs/superpowers/plans/2026-08-03-development-check-efficiency.md`

**接口：**
- 消费：任务 1 的 `check:preflight`。
- 产出：开发循环使用 preflight、finish 运行 full gate 的项目指南。

- [ ] **步骤 1：更新文档门禁契约**

调整 `kit-docs.test.mjs`，要求根 check 直接包含 `test:workflows` 和 `kits:check`，并拒绝
`npm test`、`kits:test`、`kits:build` 与聚合 `plugins:check` 回到最终门禁。

- [ ] **步骤 2：更新项目指南**

更新开发指南：开发阶段运行聚焦测试和 `npm run check:preflight`；提交后直接调用 finish；
finish 内部运行 `npm run check`。明确 preflight 不替代最终门禁。

- [ ] **步骤 3：验证文档契约**

运行：`node --test scripts/lib/kit-docs.test.mjs`

预期：全部通过，项目文档仍满足 Kit 生命周期契约。

- [ ] **步骤 4：提交**

```bash
git add docs/guides/development-workflow.md scripts/lib/kit-docs.test.mjs docs/superpowers/specs/2026-08-03-development-check-efficiency-design.md docs/superpowers/plans/2026-08-03-development-check-efficiency.md
git commit -m '[Optimize] 规范需求开发分层检查流程'
```

### 任务 4：验证性能和最终覆盖

**文件：**
- 不修改生产文件。

**接口：**
- 消费：任务 1–3 的最终工作树。
- 产出：可复现的时间、输出量和完整门禁证据。

- [ ] **步骤 1：测量预检**

以不把子进程完整日志写入 Agent 上下文的 Node 包装运行 `npm run check:preflight`，记录退出码、
耗时、stdout/stderr bytes。预期退出 0、目标耗时不高于 30 秒、成功输出低于 2 KB。

- [ ] **步骤 2：验证公共入口**

运行：`npm run test:framework`

预期：工具链准备和全部 Framework 测试通过。

- [ ] **步骤 3：验证完整门禁**

运行：`npm run check`

预期：退出 0；Framework、workflow、所有 Kit check 和 Framework 插件检查通过。

- [ ] **步骤 4：验证仓库状态**

运行：`git diff --check`、`git status --short` 和 `git log --oneline origin/main..HEAD`。

预期：无 whitespace 错误；状态只包含计划内文档勾选更新，提交标签均为 `[Optimize]`。
