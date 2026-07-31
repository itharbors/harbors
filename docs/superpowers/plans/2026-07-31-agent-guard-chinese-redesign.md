# Agent Guard Chinese Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Agent Guard 面板改造成简体中文的深色工业监控台，并让流量线路只在存在真实速率时运动。

**Architecture:** 保留现有面板 DOM 构建、两秒轮询、消息协议和后台服务，只修改 `panel.guard` 的展示层。中文文案继续由面板直接生成，不引入 i18n 或组件依赖；动态状态由现有枚举映射函数转换，流量动效由端点速率派生的 `data-active` 属性控制。

**Tech Stack:** TypeScript、原生 DOM、原生 CSS、Vitest、jsdom、Harbors panel plugin build、Electron development host。

## Global Constraints

- 保留 `Agent Guard`、`Claude`、`Codex`、域名、供应商名、规则 ID、错误码和技术单位。
- 不改变监控采样、流量归因、策略协议、拦截行为、存储格式或桌面通知。
- 不新增运行时依赖，不引入完整 i18n 或第三方设计系统。
- 页面保持单一深色主题、直角容器和低饱和青色主强调色；橙色与琥珀色只表达真实告警。
- 页面可见文案不得包含 em dash 或 en dash 字符。
- 自动动效必须由真实流量状态驱动，并继续支持 `prefers-reduced-motion`。

---

### Task 1: 中文界面与状态文案

**Files:**
- Modify: `kits/agent-guard/plugins/agent-guard-center/tests/panel.test.ts`
- Modify: `kits/agent-guard/plugins/agent-guard-center/panel.guard/src/index.ts`
- Modify: `kits/agent-guard/plugins/agent-guard-center/panel.guard/src/index.html`

**Interfaces:**
- Consumes: `AgentGuardSnapshot.state`、`AgentEndpointSnapshot.confidence`、`IncidentSummary` 和现有 `panel.mount()`。
- Produces: 中文 `stateLabel()`、中文 `confidenceLabel()`、中文正常/空/加载/失败/告警 DOM，供 Task 2 原样排版。

- [ ] **Step 1: 为正常状态写失败测试**

在 `panel.test.ts` 的首个真实挂载测试中，将英文断言替换为中文界面契约，并继续验证技术标识未被翻译：

```ts
expect(document.querySelector('h1')?.textContent).toBe('本机智能体流量');
expect(document.querySelector('[data-metric="bytes-out"]')?.textContent).toBe('12.0 MiB/min');
expect(document.querySelector('[data-confidence]')?.textContent).toBe('已确认');
expect(document.body.textContent).toContain('观测路由');
expect(document.body.textContent).toContain('事件记录');
expect(document.body.textContent).toContain('双重信号触发暂停');
expect(document.body.textContent).toContain('仅采集本机连接元数据');
expect(document.body.textContent).toContain('relay.example.test');
expect(document.body.textContent).not.toContain('Local agent traffic');
```

- [ ] **Step 2: 为加载、失败、空状态和告警操作写失败测试**

增加四个真实渲染断言：

```ts
it('renders Chinese loading copy while the first snapshot is pending', async () => {
  let release!: (value: unknown) => void;
  const request = vi.fn(() => new Promise((resolve) => { release = resolve; }));
  const panel = (await import('../panel.guard/src/index')).default;
  const mounting = panel.mount({ message: { request } });
  expect(document.body.textContent).toContain('正在启动本机流量监控');
  release(snapshot());
  await mounting;
  panel.unmount();
});

it('renders Chinese unavailable copy for an unknown failure', async () => {
  const request = vi.fn(async () => Promise.reject('offline'));
  const panel = (await import('../panel.guard/src/index')).default;
  await panel.mount({ message: { request } });
  expect(document.body.textContent).toContain('流量监控暂不可用');
  expect(document.querySelector('[data-action="retry"]')?.textContent).toBe('重试');
  panel.unmount();
});
```

为无端点快照断言“当前没有活跃的 Claude 或 Codex 模型端点，后台监控仍在继续。”；为 `tripped` 事件断言“已暂停”“恢复任务”“结束任务”“忽略 15 分钟”。快照夹具必须保留完整契约字段，只覆盖 `endpoints`、`incidents` 或 `state`。

- [ ] **Step 3: 运行测试并确认因现有英文文案失败**

Run:

```bash
npm test -w @itharbors/kit-agent-guard -- --run plugins/agent-guard-center/tests/panel.test.ts
```

Expected: FAIL，首个差异包含 `Local agent traffic` 与期望的“本机智能体流量”；加载、失败和操作测试因现有英文文案失败。

- [ ] **Step 4: 实现最小中文文案替换**

在 `index.ts` 中完成以下映射和文案：

```ts
function confidenceLabel(value: AgentEndpointSnapshot['confidence']): string {
  return value === 'confirmed' ? '已确认' : value === 'probable' ? '较可信' : '未知';
}

function stateLabel(value: AgentGuardSnapshot['state']): string {
  return ({
    learning: '学习基线',
    normal: '正常监控',
    warning: '流量警告',
    tripped: '已暂停',
    cooldown: '冷却观察',
    degraded: '降级监控',
  } as const)[value];
}
```

同时替换标题、描述、指标、事件区、策略区、按钮、隐私说明、屏幕阅读器状态、加载与失败 fallback。保留 `incident.summary`、`incident.ruleId`、Agent 名、供应商、域名与单位原值。将 `index.html` 的 `lang="en"` 改为 `lang="zh-CN"`，并把 `aria-label` 改为“Agent Guard 本机流量监控”。

- [ ] **Step 5: 运行聚焦测试并确认通过**

Run:

```bash
npm test -w @itharbors/kit-agent-guard -- --run plugins/agent-guard-center/tests/panel.test.ts tests/panel-accessibility.test.ts
```

Expected: PASS，两个测试文件均无失败。

- [ ] **Step 6: 提交中文界面**

```bash
git add kits/agent-guard/plugins/agent-guard-center/tests/panel.test.ts kits/agent-guard/plugins/agent-guard-center/panel.guard/src/index.ts kits/agent-guard/plugins/agent-guard-center/panel.guard/src/index.html
git diff --cached --check
git commit -m '[Feature] 中文化智能体守卫界面'
```

---

### Task 2: 工业监控台排版与真实流量动效

**Files:**
- Modify: `kits/agent-guard/plugins/agent-guard-center/tests/panel.test.ts`
- Modify: `kits/agent-guard/plugins/agent-guard-center/panel.guard/src/index.ts`
- Modify: `kits/agent-guard/plugins/agent-guard-center/panel.guard/src/index.css`

**Interfaces:**
- Consumes: Task 1 产出的中文 DOM 和 `AgentEndpointSnapshot.bytesInPerMinute` / `bytesOutPerMinute`。
- Produces: `.flow-lane[data-active="true|false"]` 状态、紧凑页头、高密度路由行、主要事件区和次要策略区。

- [ ] **Step 1: 为真实流量动效写失败测试**

在正常快照测试中断言正速率端点为活跃：

```ts
expect(document.querySelector('.flow-lane')?.getAttribute('data-active')).toBe('true');
```

增加零速率快照测试：

```ts
it('keeps the route indicator still when both traffic rates are zero', async () => {
  const idle = snapshot();
  idle.endpoints[0].bytesInPerMinute = 0;
  idle.endpoints[0].bytesOutPerMinute = 0;
  const request = vi.fn(async () => idle);
  const panel = (await import('../panel.guard/src/index')).default;
  await panel.mount({ message: { request } });
  expect(document.querySelector('.flow-lane')?.getAttribute('data-active')).toBe('false');
  panel.unmount();
});
```

- [ ] **Step 2: 运行测试并确认缺少派生状态**

Run:

```bash
npm test -w @itharbors/kit-agent-guard -- --run plugins/agent-guard-center/tests/panel.test.ts
```

Expected: FAIL，`data-active` 当前为 `null`。

- [ ] **Step 3: 实现流量活跃属性**

在 `createRoute()` 创建 `.flow-lane` 后加入：

```ts
const hasTraffic = endpoint.bytesInPerMinute > 0 || endpoint.bytesOutPerMinute > 0;
lane.dataset.active = String(hasTraffic);
```

不得依据连接数或累计字节触发动效，因为它们不能证明当前采样窗口仍有流量。

- [ ] **Step 4: 重排 CSS 为紧凑监控台**

在 `index.css` 中执行以下具体调整：

- `:root` 字体改为 `-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif`；
- `.guard-workspace` 使用纯色背景和 `clamp(20px, 2.4vw, 34px)` 内边距，删除装饰性径向渐变；
- `h1` 使用中文系统字体、`clamp(30px, 3.6vw, 46px)`、`line-height: 1.12`，不再使用 72px 英文窄体标题；
- `.protection-header` 顶部对齐，状态模块宽度控制在 176px 到 210px；
- `.traffic-route` 保持直角，用网格将身份、线路、域名与四项指标组织成一行，980px 以下继续复用现有折行规则；
- 将动画选择器从 `.flow-lane i` 改为 `.flow-lane[data-active="true"] i`，默认线路静止；
- `.lower-deck` 保持事件区约 70%、策略区约 30%，策略区不使用阴影或圆角；
- `button` 增加 `white-space: nowrap` 和 `button:active { transform: translateY(1px); }`；
- 输入框增加 `:focus-visible` 青色边框和 outline；
- 保留 980px 与 640px 响应式断点，中文按钮在窄窗口允许操作区换行但按钮自身不换行；
- `prefers-reduced-motion: reduce` 下禁用线路动画和按钮 transform。

关键 CSS 应采用以下确定值，其他既有选择器只做对应的间距收敛：

```css
:root {
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
}

.guard-workspace {
  min-height: 100vh;
  padding: clamp(20px, 2.4vw, 34px);
  background: var(--harbor-950);
}

h1 {
  margin-bottom: 8px;
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: clamp(30px, 3.6vw, 46px);
  font-weight: 650;
  letter-spacing: -.025em;
  line-height: 1.12;
}

.flow-lane i {
  position: absolute;
  top: 5px;
  left: 24%;
  width: 8px;
  height: 7px;
  border-right: 2px solid var(--signal-cyan);
}

.flow-lane[data-active="true"] i {
  left: -14px;
  animation: travel 4.2s linear infinite;
}

button {
  border-radius: 0;
  white-space: nowrap;
}

button:active { transform: translateY(1px); }

.policy-input input:focus-visible {
  border-color: var(--signal-cyan);
  outline: 1px solid var(--signal-cyan);
  outline-offset: 2px;
}

@media (prefers-reduced-motion: reduce) {
  .flow-lane[data-active="true"] i { animation: none; left: 24%; }
  button:active { transform: none; }
}
```

- [ ] **Step 5: 运行聚焦测试并确认通过**

Run:

```bash
npm test -w @itharbors/kit-agent-guard -- --run plugins/agent-guard-center/tests/panel.test.ts tests/panel-accessibility.test.ts
```

Expected: PASS，动效状态与无障碍契约均通过。

- [ ] **Step 6: 构建面板插件**

Run:

```bash
node ../../scripts/ce-plugin.mjs build plugins/agent-guard-center
```

Working directory: `kits/agent-guard`

Expected: exit 0，`panel.guard/dist/index.html`、`index.js` 与 `index.css` 更新。

- [ ] **Step 7: 提交视觉重排**

```bash
git add kits/agent-guard/plugins/agent-guard-center/tests/panel.test.ts kits/agent-guard/plugins/agent-guard-center/panel.guard/src/index.ts kits/agent-guard/plugins/agent-guard-center/panel.guard/src/index.css
git diff --cached --check
git commit -m '[Feature] 重设计智能体守卫监控台'
```

---

### Task 3: 完整验证与 Electron 视觉验收

**Files:**
- Verify: `kits/agent-guard/plugins/agent-guard-center/panel.guard/src/index.ts`
- Verify: `kits/agent-guard/plugins/agent-guard-center/panel.guard/src/index.css`
- Verify: `kits/agent-guard/plugins/agent-guard-center/panel.guard/src/index.html`

**Interfaces:**
- Consumes: Tasks 1-2 的已提交面板资源。
- Produces: 全套自动化结果、运行中的 Electron 窗口和视觉验收记录。

- [ ] **Step 1: 运行 Agent Guard 完整测试**

Run:

```bash
npm test -w @itharbors/kit-agent-guard
```

Expected: 23 个测试文件全部通过，失败数为 0。

- [ ] **Step 2: 执行静态预检**

Run:

```bash
git diff --check
rg -n "—|–|Local agent traffic|Observed routes|Event ledger|Save policy|Try again" kits/agent-guard/plugins/agent-guard-center/panel.guard/src
```

Expected: `git diff --check` exit 0；`rg` 不返回任何页面可见旧英文或禁止的 dash 字符。

- [ ] **Step 3: 启动隔离的 Electron 开发实例**

先用 `lsof` 确认 `52580-52583` 空闲；若被占用，选择另一组连续且空闲的四个端口。启动命令：

```bash
HARBORS_GATEWAY_PORT=52580 \
HARBORS_SERVER_PORT=52581 \
HARBORS_CLIENT_PORT=52582 \
HARBORS_NOTIFICATION_PORT=52583 \
npm run dev -- --kit ./kits/agent-guard
```

Expected: Gateway、Server、Vite 和 Notification Host 全部监听，Electron 窗口加载 Agent Guard 面板。

- [ ] **Step 4: 完成功能与视觉检查**

使用 Computer Use 读取真实 Electron 窗口并检查：

- 首屏标题、状态、路由指标、事件区、策略区和隐私说明均为中文；
- `Agent Guard`、`Codex`、域名、供应商和单位保持原样；
- 1440x960 启动窗口无横向滚动、裁切、重叠或不可读按钮；
- 青色只作为主要状态强调，橙色和琥珀色只用于真实告警；
- 当前速率为零时线路静止，存在速率时线路运动；
- 窄窗口布局通过 CSS 与测试契约，不需要修改窗口的持久边界；
- 加载、空数据和错误状态保持清晰，焦点与表单对比度可见。

- [ ] **Step 5: 确认工作树与运行状态**

Run:

```bash
git status --short
lsof -nP -iTCP:52580-52583 -sTCP:LISTEN
```

Expected: 工作树干净；四个开发端口均由本次 Harbors 实例监听。保持实例运行，供用户查看。
