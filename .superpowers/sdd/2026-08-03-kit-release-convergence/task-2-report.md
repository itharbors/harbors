# Task 2：创建 MySQL 不可变修复版本

## 实现

- 将 MySQL 制品契约更新为 `kit-mysql-0.1.0-preview.3-any-any.hkit`。
- 将 `kits/mysql/kit.json`、`kits/mysql/package.json` 和 `kits/mysql/package-lock.json` 的根与 `packages[""]` 版本同步为 `0.1.0-preview.3`。
- 未修改 TraceWeave、线上 Registry 或计划文件；已有不可变 Tag `kit/mysql/v0.1.0-preview.2` 未被复用。

## RED 证据

在仅修改 `scripts/lib/kit-check.test.mjs` 的两个 MySQL 制品字面量后，运行：

```bash
node --test scripts/lib/kit-check.test.mjs
```

结果为预期失败：17 个测试中 15 个通过、2 个失败。两个失败断言的实际路径均为 `kit-mysql-0.1.0-preview.2-any-any.hkit`，期望路径为 `kit-mysql-0.1.0-preview.3-any-any.hkit`，证明 manifest 仍持有已占用的 Preview 2 身份。

## GREEN 与验证

以下命令均以退出码 0 完成：

```bash
node --test scripts/lib/kit-check.test.mjs
npm run kits:boundary -- mysql
node scripts/run-kit-matrix.mjs check mysql
output_directory="$(mktemp -d)"
npm run kit:check -- mysql --output-directory "$output_directory"
```

- 契约测试：17/17 通过。
- 边界检查：`KIT_ARCHITECTURE_BOUNDARY_OK scope=mysql`。
- 矩阵检查：`KIT=mysql STATUS=passed`。
- 真实检查：生成目录 `/var/folders/j7/600t_ng52rn2zw60cjn89x9w0000gn/T/tmp.alsDBhxED2` 中恰有 1 个 `.hkit` 制品：`kit-mysql-0.1.0-preview.3-any-any.hkit`；检查输出确认 `KIT_VERSION=0.1.0-preview.3`。

## 修改文件

- `scripts/lib/kit-check.test.mjs`
- `kits/mysql/kit.json`
- `kits/mysql/package.json`
- `kits/mysql/package-lock.json`
- `.superpowers/sdd/2026-08-03-kit-release-convergence/task-2-report.md`

## 自审

- 四处版本身份与制品契约完全一致。
- 测试在实现前针对旧 Preview 2 路径失败，并在版本同步后通过。
- `git diff --check` 通过；变更范围仅限任务文件。

## 关注点

- 本任务只创建新的 Preview 3 源码身份和本地可验证制品，不会也不能修改既有 Preview 2 不可变 Tag 或线上 Registry。
