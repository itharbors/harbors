# Scheduler Kit

Scheduler Kit 在 Harbors 运行期间按本地时间执行 Node.js 脚本，并在应用重启后处理错过的触发。

## 支持范围

- 指定本地日期时间执行一次；
- 从指定时间开始，按分钟、小时或天固定间隔执行；
- 暂停、恢复、编辑、删除和立即运行；
- 查看最近 100 条运行记录、退出状态及 stdout/stderr；
- 错过超过 30 秒的触发时，选择立即补跑一次或跳过。

循环计划始终锚定最初的开始时间。即使应用关闭了多个周期，“立即补跑一次”也只会运行一次，然后推进到第一个未来时间点，不会形成补跑风暴。同一任务的前一次脚本尚未退出时，新触发会记录为“重叠跳过”；不同任务可以并行。

Harbors 本身不会注册操作系统级定时服务。应用未运行时脚本不会执行，下一次启动由上述错过策略决定是否补跑。

## 脚本约束

脚本路径必须是本机绝对路径，扩展名为 `.js`、`.mjs` 或 `.cjs`。Scheduler 使用当前 Harbors 的 Node.js 可执行文件直接启动脚本：

```text
process.execPath <absolute-script-path>
```

执行过程不经过 shell，工作目录为脚本所在目录，环境变量继承 Harbors 进程。脚本拥有当前用户对本机文件和网络的权限；安装 Kit 时应认真审阅 `filesystem` 与 `native-code` 权限。这里的 `native-code` 是 Registry v1 对本地代码执行能力的保守高风险声明。

每次运行的 stdout 和 stderr 分别保留末尾 64 KiB。Harbors 退出时先发送 `SIGTERM`，5 秒后仍未退出才发送 `SIGKILL`。

## 数据位置

桌面版把状态原子写入：

```text
<Harbors userData>/kits/scheduler/state.v1.json
```

开发 Web 模式没有 Electron `userData`，因此回退到仓库中已忽略的 `.harbors-data/kits/scheduler/state.v1.json`。状态文件损坏或 schema 版本不受支持时，启动插件进入 degraded 状态并保留原文件，不会静默覆盖。

## 开发

```bash
npm test -w @itharbors/kit-scheduler
npm run build -w @itharbors/kit-scheduler
npm run dev -- --kit ./kits/scheduler
```
