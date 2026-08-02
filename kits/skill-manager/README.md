# Skill Manager

Skill Manager 是一个本地 Codex Skill 工作台。它默认管理 `$CODEX_HOME/skills`；未设置
`CODEX_HOME` 时使用 `~/.codex/skills`。选择来源目录后，可以把另一棵目录中的 Skill 与全局安装
并排比较，再执行安装或更新。来源目录只保留在当前 Session，关闭或重启 Server 后不会自动恢复。

## 工作流

1. 打开 Kit 即可查看全局 Skill、系统 Skill 和可恢复项目。
2. 选择一个来源目录后，工作台递归发现其中包含有效 `SKILL.md` 的目录。
3. 按状态筛选或搜索，在详情区核对描述、摘要和诊断。
4. 安装、更新、停用、卸载或恢复前确认目标；操作完成后列表自动重新扫描。

清除或切换来源会取消旧扫描并开始新的 generation。详情和变更请求都携带当前 snapshot revision；
如果文件在扫描后发生变化，服务端会拒绝过期请求并要求重新扫描。

## 状态

| 状态 | 含义 | 可用操作 |
| --- | --- | --- |
| `source-only` | 只在来源目录中存在 | 安装 |
| `current` | 来源与全局内容摘要一致 | 无 |
| `update-available` | 同名 Skill 两侧内容不同 | 更新 |
| `global-only` | 只在全局目录中存在 | 停用、卸载 |
| `disabled` | 已移动到可恢复的停用区 | 恢复 |
| `trashed` | 已移动到可恢复的卸载区 | 恢复 |
| `protected` | 位于 `.system` 的系统 Skill | 无 |
| `conflict` | 同名、目录名或恢复目标存在歧义 | 解决冲突后重扫 |
| `invalid` | frontmatter、文件结构或恢复记录无效 | 修复内容后重扫 |

## 安全与恢复

- Renderer 只收发不透明目录 ID、Skill ID、revision 和 digest，不接收或提交原始文件系统路径。
- 来源扫描拒绝符号链接、目录逃逸、超限文件和缺少有效 frontmatter 的 `SKILL.md`。
- `.system` 始终只读；系统 Skill 不能更新、停用或卸载。
- 安装与更新先在同一父目录暂存并完整校验，再以原子目录操作发布。
- 停用与卸载不做永久删除，而是移动到 `$CODEX_HOME/skill-manager-store/v1`；工作台可恢复这些项目。
- 当前版本只管理用户明确选择的本机目录，不访问网络或 GitHub，也不支持远程仓库安装。

## 开发与检查

```bash
npm run dev -- --kit ./kits/skill-manager
npm run build -w @itharbors/kit-skill-manager
npm run test -w @itharbors/kit-skill-manager
npm run kit:check -- skill-manager --output-directory "$PWD/dist/skill-manager-check"
```

## Local lifecycle

```bash
npm ci --prefix kits/skill-manager
npm run build --prefix kits/skill-manager
npm run test --prefix kits/skill-manager
```

本 Kit 未声明独立 smoke 脚本，以仓库目标 Kit 的完整检查验收。

## Permissions

`filesystem`。

## Platform

支持任意平台与架构。

## Ownership boundary

Skill 管理功能、状态与测试均由本目录拥有。
