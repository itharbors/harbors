import {
  normalizeHistoryStatus,
  normalizeSnapshot,
  normalizeTrafficHistoryResult,
  type AgentEndpointSnapshot,
  type AgentGuardCommand,
  type AgentGuardSnapshot,
  type HistoryStatus,
  type HistoryPoint,
  type HistorySeries,
  type IncidentSummary,
  type PolicyV1,
  type TrafficHistoryResult,
} from '@itharbors/agent-guard-contracts';

type PanelContext = {
  message: { request(plugin: string, name: string, ...args: unknown[]): Promise<unknown> };
};

const PLUGIN = '@itharbors/agent-guard-center';
const POLL_MS = 2_000;
const HISTORY_POLL_MS = 30_000;
let context: PanelContext | null = null;
let root: HTMLElement | null = null;
let timer: number | null = null;
let historyTimer: number | null = null;
let mounted = false;
let version = 0;
let requestGeneration = 0;
let refreshPromise: Promise<void> | null = null;
let mutation: Promise<void> | null = null;
let mutationError: string | null = null;
let signature = '';
let latestSnapshot: AgentGuardSnapshot | null = null;
let historyResult: TrafficHistoryResult | null = null;
let historyResultQueryKey: string | null = null;
let historyStatus: HistoryStatus | null = null;
let historyError: string | null = null;
let historyVersion = 0;
let historyRange: '1h' | '24h' | '7d' | '30d' | '90d' | '1y' = '24h';
let historyDomain: 'network' | 'model-usage' = 'network';
let clearConfirmation = false;
export type DashboardTab = 'overview' | 'incidents' | 'settings';
const DASHBOARD_TABS: readonly DashboardTab[] = ['overview', 'incidents', 'settings'];
let activeTab: DashboardTab = 'overview';
let policyDraft: { warning: string; trip: string } | null = null;

type RenderState = {
  focusAction: string | null;
  focusIncidentId: string | null;
  selection: [number, number] | null;
  scrollX: number;
  scrollY: number;
};

const panel = {
  async mount(nextContext: PanelContext) {
    version += 1;
    context = nextContext;
    root = document.getElementById('guard-root');
    if (!root) throw new Error('Agent Guard root is missing');
    mounted = true;
    signature = '';
    activeTab = 'overview';
    policyDraft = null;
    mutationError = null;
    renderState('正在启动本机流量监控…', 'loading');
    await refresh();
    if (mounted) void refreshHistory();
    if (mounted) timer = window.setInterval(() => { void refresh(); }, POLL_MS);
    if (mounted) historyTimer = window.setInterval(() => { void refreshHistory(); }, HISTORY_POLL_MS);
  },
  unmount() {
    mounted = false;
    version += 1;
    requestGeneration += 1;
    if (timer !== null) window.clearInterval(timer);
    if (historyTimer !== null) window.clearInterval(historyTimer);
    timer = null;
    historyTimer = null;
    refreshPromise = null;
    mutation = null;
    context = null;
    root = null;
    latestSnapshot = null;
    activeTab = 'overview';
    policyDraft = null;
    mutationError = null;
  },
};

export default panel;

function refresh(): Promise<void> {
  if (!mounted || !context || mutation) return Promise.resolve();
  if (refreshPromise) return refreshPromise;
  const activeContext = context;
  const activeVersion = version;
  const generation = ++requestGeneration;
  let operation: Promise<void>;
  operation = (async () => {
    try {
      const snapshot = normalizeSnapshot(await activeContext.message.request(PLUGIN, 'getSnapshot'));
      if (!isCurrent(activeVersion, generation)) return;
      const nextSignature = JSON.stringify(snapshot);
      if (nextSignature !== signature) {
        signature = nextSignature;
        renderSnapshot(snapshot);
      }
    } catch (error) {
      if (isCurrent(activeVersion, generation)) {
        renderState('流量监控暂不可用', 'unavailable', errorDetail(error));
      }
    } finally {
      if (refreshPromise === operation) refreshPromise = null;
    }
  })();
  refreshPromise = operation;
  return operation;
}

function isCurrent(activeVersion: number, generation: number) {
  return mounted && version === activeVersion && requestGeneration === generation;
}

function runCommand(command: AgentGuardCommand): void {
  runMutation('executeCommand', command);
}

function runMutation(method: 'executeCommand' | 'updatePolicy', input: AgentGuardCommand | PolicyV1): void {
  if (!context || mutation) return;
  const activeContext = context;
  const capturedState = captureRenderState();
  mutationError = null;
  mutation = (async () => {
    setButtonsDisabled(true);
    try {
      await activeContext.message.request(PLUGIN, method, input);
      signature = '';
      latestSnapshot = null;
      historyResult = null;
      historyResultQueryKey = null;
      historyStatus = null;
      historyError = null;
      historyVersion += 1;
      historyRange = '24h';
      historyDomain = 'network';
      clearConfirmation = false;
      mutation = null;
      await refresh();
    } catch (error) {
      mutationError = errorDetail(error) ?? '操作暂不可用';
      if (latestSnapshot) renderSnapshotWithState(latestSnapshot, capturedState);
      else renderState('操作失败', 'unavailable', mutationError);
    } finally {
      mutation = null;
      setButtonsDisabled(false);
    }
  })();
}

function renderSnapshot(snapshot: AgentGuardSnapshot): void {
  if (!root) return;
  renderSnapshotWithState(snapshot, captureRenderState());
}

export function createDashboardTabs(snapshot: AgentGuardSnapshot): HTMLElement {
  const tabs = document.createElement('div');
  tabs.className = 'dashboard-tabs';
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Agent Guard 工作区');
  tabs.append(
    createDashboardTab('overview', '总览', snapshot.incidents.length),
    createDashboardTab('incidents', '事件记录', snapshot.incidents.length),
    createDashboardTab('settings', '设置', snapshot.incidents.length),
  );
  return tabs;
}

function createDashboardTab(tab: DashboardTab, label: string, incidentCount: number): HTMLButtonElement {
  const value = button(label, `dashboard-tab-${tab}`, () => activateDashboardTab(tab, true));
  value.classList.add('dashboard-tab');
  value.id = `${tab}-tab`;
  value.dataset.tab = tab;
  value.setAttribute('role', 'tab');
  value.setAttribute('aria-controls', `${tab}-panel`);
  value.setAttribute('aria-selected', String(activeTab === tab));
  value.tabIndex = activeTab === tab ? 0 : -1;
  if (tab === 'incidents') {
    value.setAttribute('aria-label', `事件记录，${incidentCount} 条`);
    const badge = textElement('span', 'dashboard-tab-badge', String(incidentCount));
    badge.dataset.state = incidentCount > 0 ? 'nonzero' : 'zero';
    badge.setAttribute('aria-hidden', 'true');
    value.append(badge);
  }
  value.addEventListener('keydown', (event) => {
    const target = event.key === 'ArrowLeft' || event.key === 'ArrowRight'
      ? adjacentTab(tab, event.key === 'ArrowLeft' ? -1 : 1)
      : event.key === 'Home' ? 'overview'
      : event.key === 'End' ? 'settings'
      : event.key === 'Enter' || event.key === ' ' ? tab
      : null;
    if (!target) return;
    event.preventDefault();
    activateDashboardTab(target, true);
  });
  return value;
}

function adjacentTab(current: DashboardTab, direction: -1 | 1): DashboardTab {
  const index = DASHBOARD_TABS.indexOf(current);
  return DASHBOARD_TABS[(index + direction + DASHBOARD_TABS.length) % DASHBOARD_TABS.length];
}

export function activateDashboardTab(tab: DashboardTab, focusTab: boolean): void {
  if (!latestSnapshot) return;
  activeTab = tab;
  root?.querySelectorAll<HTMLButtonElement>('[role="tab"]').forEach((value) => {
    const selected = value.dataset.tab === tab;
    value.setAttribute('aria-selected', String(selected));
    value.tabIndex = selected ? 0 : -1;
  });
  const state = captureRenderState();
  if (focusTab) state.focusAction = `dashboard-tab-${tab}`;
  renderSnapshotWithState(latestSnapshot, state);
}

function createOverviewPanel(snapshot: AgentGuardSnapshot): HTMLElement {
  const panel = document.createElement('section');
  panel.id = 'overview-panel';
  panel.setAttribute('role', 'tabpanel');
  panel.setAttribute('aria-labelledby', 'overview-tab');
  panel.append(createTrafficSection(snapshot.endpoints), createHistorySection());
  return panel;
}

function createIncidentsPanel(snapshot: AgentGuardSnapshot): HTMLElement {
  const panel = document.createElement('section');
  panel.id = 'incidents-panel';
  panel.setAttribute('role', 'tabpanel');
  panel.setAttribute('aria-labelledby', 'incidents-tab');
  panel.append(createIncidentLedger(snapshot.incidents));
  return panel;
}

function createSettingsPanel(): HTMLElement {
  const panel = document.createElement('section');
  panel.id = 'settings-panel';
  panel.setAttribute('role', 'tabpanel');
  panel.setAttribute('aria-labelledby', 'settings-tab');
  panel.append(
    settingsSection('保护策略', createPolicyPanel()),
    settingsSection('历史采集', createBackfillSettings()),
    settingsSection('缓存管理', createCacheSettings()),
    settingsSection('隐私说明', createPrivacyNote()),
  );
  return panel;
}

function settingsSection(title: string, content: HTMLElement): HTMLElement {
  const section = document.createElement('section');
  section.className = 'settings-section';
  section.append(textElement('h2', '', title), content);
  return section;
}

function createLiveStatus(snapshot: AgentGuardSnapshot): HTMLElement {
  const status = document.createElement('p');
  status.className = 'sr-only';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.textContent = `已观测 ${snapshot.endpoints.length} 个端点，保护状态：${stateLabel(snapshot.state)}`;
  return status;
}

function captureRenderState(): RenderState {
  const activeElement = document.activeElement;
  const focusedElement = activeElement instanceof HTMLElement && root?.contains(activeElement)
    ? activeElement
    : null;
  const input = focusedElement instanceof HTMLInputElement ? focusedElement : null;
  const warning = root?.querySelector<HTMLInputElement>('input[name="warning-outbound"]');
  const trip = root?.querySelector<HTMLInputElement>('input[name="trip-outbound"]');
  if (warning && trip) policyDraft = { warning: warning.value, trip: trip.value };
  return {
    focusAction: focusedElement?.dataset.action ?? null,
    focusIncidentId: focusedElement?.closest<HTMLElement>('[data-incident-id]')?.dataset.incidentId ?? null,
    selection: input && input.selectionStart !== null && input.selectionEnd !== null
      ? [input.selectionStart, input.selectionEnd]
      : null,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  };
}

function renderSnapshotWithState(snapshot: AgentGuardSnapshot, renderState: RenderState): void {
  if (!root) return;
  latestSnapshot = snapshot;
  const workspace = document.createElement('div');
  workspace.className = 'guard-workspace';
  workspace.append(createHeader(snapshot), createDashboardTabs(snapshot));
  const dashboardContent = document.createElement('div');
  dashboardContent.className = 'dashboard-content';
  if (mutationError) dashboardContent.append(createOperationError(mutationError));
  const content = activeTab === 'overview'
    ? createOverviewPanel(snapshot)
    : activeTab === 'incidents'
      ? createIncidentsPanel(snapshot)
      : createSettingsPanel();
  dashboardContent.append(content);
  workspace.append(dashboardContent, createLiveStatus(snapshot));
  root.replaceChildren(workspace);
  restoreRenderState(renderState);
}

function restoreRenderState(renderState: RenderState): void {
  if (!root) return;
  if (renderState.focusAction) {
    const candidates = root.querySelectorAll<HTMLElement>(`[data-action="${renderState.focusAction}"]`);
    const focusTarget = renderState.focusIncidentId
      ? Array.from(candidates).find((candidate) => (
        candidate.closest<HTMLElement>('[data-incident-id]')?.dataset.incidentId === renderState.focusIncidentId
      )) ?? null
      : candidates[0] ?? null;
    focusTarget?.focus();
    if (focusTarget instanceof HTMLInputElement && renderState.selection) {
      focusTarget.setSelectionRange(...renderState.selection);
    }
  }
  if (renderState.scrollX || renderState.scrollY) window.scrollTo(renderState.scrollX, renderState.scrollY);
}

async function refreshHistory(): Promise<void> {
  if (!mounted || !context) return;
  const activeContext = context;
  const activeVersion = version;
  const requestVersion = ++historyVersion;
  const queryKey = historyQueryKey(historyDomain, historyRange);
  const to = Date.now();
  const input = {
    from: to - historyRangeMs(historyRange),
    to,
    domain: historyDomain,
    agents: ['claude', 'codex'],
    hostnames: [],
    preferredBucket: historyBucket(historyRange),
  } as const;
  historyError = null;
  if (historyResultQueryKey !== queryKey && latestSnapshot) renderSnapshot(latestSnapshot);
  try {
    const [result, status] = await Promise.all([
      activeContext.message.request(PLUGIN, 'getTrafficHistory', input),
      activeContext.message.request(PLUGIN, 'getHistoryStatus'),
    ]);
    if (!mounted || version !== activeVersion || historyVersion !== requestVersion) return;
    historyResult = normalizeTrafficHistoryResult(result);
    historyResultQueryKey = queryKey;
    historyStatus = normalizeHistoryStatus(status);
    if (latestSnapshot) renderSnapshot(latestSnapshot);
  } catch (error) {
    if (!mounted || version !== activeVersion || historyVersion !== requestVersion) return;
    historyError = errorDetail(error) ?? '历史数据暂不可用';
    if (latestSnapshot) renderSnapshot(latestSnapshot);
  }
}

function createHistorySection(): HTMLElement {
  const section = document.createElement('section');
  section.className = 'history-deck';
  section.setAttribute('aria-labelledby', 'history-title');
  const heading = textElement('div', 'section-heading history-heading', '');
  const title = textElement('h2', '', '历史用量');
  title.id = 'history-title';
  heading.append(title, textElement('span', 'section-note', historyStatus?.persistent === false ? '当前 Web 会话 · 不持久化' : '仅保存在本机'));
  section.append(heading, createHistoryControls());
  if (historyError) {
    section.append(textElement('p', 'history-message', `历史数据暂不可用：${historyError}`));
    return section;
  }
  if (!historyResult || historyResultQueryKey !== historyQueryKey(historyDomain, historyRange)) {
    section.append(textElement('p', 'history-message', '正在读取历史数据…'));
    return section;
  }
  section.append(createHistorySummary(historyResult), createHistoryChart(historyResult));
  return section;
}

function createHistoryControls(): HTMLElement {
  const controls = document.createElement('div');
  controls.className = 'history-controls';
  const domains = document.createElement('div');
  domains.className = 'history-switch';
  for (const [value, label] of [['network', '网络流量'], ['model-usage', '模型用量']] as const) {
    const control = button(label, `history-domain-${value}`, () => {
      historyDomain = value;
      void refreshHistory();
    });
    control.setAttribute('aria-pressed', String(historyDomain === value));
    domains.append(control);
  }
  const ranges = document.createElement('div');
  ranges.className = 'history-switch history-ranges';
  for (const value of ['1h', '24h', '7d', '30d', '90d', '1y'] as const) {
    const control = button(value, `history-range-${value}`, () => {
      historyRange = value;
      void refreshHistory();
    });
    control.setAttribute('aria-pressed', String(historyRange === value));
    ranges.append(control);
  }
  controls.append(domains, ranges);
  return controls;
}

export type DisplayHistorySeries = Pick<HistorySeries, 'metric' | 'unit' | 'points'>;

export function visibleHistoryMetrics(domain: TrafficHistoryResult['domain']): HistorySeries['metric'][] {
  return domain === 'network'
    ? ['bytes-in', 'bytes-out']
    : ['input-tokens', 'output-tokens'];
}

export function mergeHistorySeriesByMetric(result: TrafficHistoryResult): DisplayHistorySeries[] {
  return visibleHistoryMetrics(result.domain).map((metric) => {
    const inputs = result.series.filter((series) => series.metric === metric);
    if (inputs.length === 0) return { metric, unit: historyMetricUnit(metric), points: [] };
    const buckets = new Map<string, HistoryPoint[]>();
    for (const series of inputs) for (const point of series.points) {
      const key = `${point.start}\u0000${point.end}`;
      buckets.set(key, [...(buckets.get(key) ?? []), point]);
    }
    return {
      metric: inputs[0].metric,
      unit: inputs[0].unit,
      points: [...buckets.values()]
        .sort((left, right) => left[0].start - right[0].start)
        .map((points) => mergeHistoryPoints(points)),
    };
  });
}

function mergeHistoryPoints(points: HistoryPoint[]): HistoryPoint {
  const present = points.filter((point) => point.value !== null);
  const coverage = present.length === 0
    ? 'missing'
    : points.every((point) => point.coverage === 'complete') ? 'complete' : 'partial';
  const first = points[0];
  const source = present[0];
  return {
    start: first.start,
    end: first.end,
    value: present.length === 0 ? null : present.reduce((sum, point) => sum + point.value!, 0),
    coverage,
    coverageReason: coverage === 'complete' ? null : points.find((point) => point.coverageReason !== null)?.coverageReason ?? null,
    provenance: source?.provenance ?? null,
    quality: source?.quality ?? null,
  };
}

function createHistorySummary(result: TrafficHistoryResult): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'history-summary';
  const title = result.domain === 'network' ? '实测网络流量' : '本地日志回填';
  wrapper.append(textElement('strong', '', title));
  const rows = result.domain === 'model-usage'
    ? [['primary', ['input-tokens', 'output-tokens', 'cache-tokens']], ['secondary', ['requests', 'sessions']]] as const
    : [['primary', ['bytes-in', 'bytes-out']]] as const;
  for (const [rowName, metrics] of rows) {
    const row = document.createElement('div');
    row.className = 'history-summary-row';
    if (result.domain === 'model-usage') row.dataset.summaryRow = rowName;
    for (const metric of metrics) {
      const item = result.summary.find((summary) => summary.metric === metric);
      row.append(createHistorySummaryCard(metric, item ?? null));
    }
    wrapper.append(row);
  }
  const expectedSummaryMetrics = rows.flatMap(([, metrics]) => [...metrics]);
  const missing = expectedSummaryMetrics.some((metric) => !result.summary.some((item) => item.metric === metric))
    || result.series.flatMap((item) => item.points).some((point) => point.coverage === 'missing');
  if (missing) wrapper.append(textElement('span', 'history-warning', '未采集区间不会按零流量计算'));
  return wrapper;
}

function createHistorySummaryCard(
  metric: HistorySeries['metric'],
  item: TrafficHistoryResult['summary'][number] | null,
): HTMLElement {
  const card = document.createElement('div');
  card.className = 'history-stat';
  card.append(
    textElement('span', '', historyMetricLabel(metric)),
    textElement('b', '', item ? formatHistoryValue(item.value, item.unit) : '未采集'),
    textElement('small', '', `覆盖 ${item ? (item.coverageRatio * 100).toFixed(0) : '0'}%`),
  );
  return card;
}

function createHistoryChart(result: TrafficHistoryResult): HTMLElement {
  const figure = document.createElement('figure');
  figure.className = 'history-chart';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 720 180');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', result.domain === 'network' ? '网络流量历史趋势' : '模型用量历史趋势');
  const series = mergeHistorySeriesByMetric(result);
  const values = series.flatMap((item) => item.points).flatMap((point) => point.value === null ? [] : [point.value]);
  const maximum = Math.max(1, ...values);
  for (const [seriesIndex, item] of series.entries()) {
    let pathData = '';
    let previousPoint: HistoryPoint | null = null;
    for (const point of item.points) {
      if (point.value === null) {
        previousPoint = point;
        continue;
      }
      const position = (point.start - result.from) / (result.to - result.from);
      const x = Math.min(1, Math.max(0, position)) * 700 + 10;
      const y = 165 - point.value / maximum * 145;
      const contiguous = previousPoint?.value !== null && previousPoint?.end === point.start;
      pathData += `${contiguous ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)} `;
      previousPoint = point;
    }
    const pathElement = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    pathElement.setAttribute('d', pathData.trim());
    pathElement.dataset.metric = item.metric;
    pathElement.dataset.series = String(seriesIndex);
    pathElement.dataset.values = item.points.map((point) => String(point.value)).join(',');
    svg.append(pathElement);
  }
  const legend = document.createElement('ul');
  legend.className = 'history-legend';
  for (const item of series) legend.append(textElement('li', '', historyMetricLabel(item.metric)));
  const caption = textElement('figcaption', 'sr-only', result.summary
    .map((item) => `${historyMetricLabel(item.metric)} ${formatHistoryValue(item.value, item.unit)}`).join('，'));
  figure.append(svg, legend, caption);
  return figure;
}

function createBackfillSettings(): HTMLElement {
  const aside = document.createElement('aside');
  aside.className = 'history-management';
  const control = button(
    historyStatus?.settings.localSessionBackfill ? '关闭本地日志回填' : '开启本地日志回填',
    'toggle-backfill',
    () => {
      if (historyStatus) void updateBackfill(!historyStatus.settings.localSessionBackfill);
    },
  );
  control.disabled = !historyStatus;
  aside.append(control);
  return aside;
}

function createCacheSettings(): HTMLElement {
  const aside = document.createElement('aside');
  aside.className = 'history-management';
  if (historyStatus) {
    const details = document.createElement('div');
    details.className = 'cache-status';
    details.append(
      textElement('span', 'section-note', historyStatus.persistent ? '本机持久化' : '当前会话内存'),
      textElement('span', 'section-note', `占用 ${formatBytes(historyStatus.storageBytes)}`),
      textElement('span', 'section-note', `最早记录 ${formatLocalTimestamp(historyStatus.earliestAt)}`),
      textElement('span', 'section-note', `最新记录 ${formatLocalTimestamp(historyStatus.latestAt)}`),
    );
    aside.append(details);
  } else {
    aside.append(textElement('span', 'section-note', '存储状态未知'));
  }
  if (clearConfirmation) {
    aside.append(
      textElement('span', 'history-warning', '只清空历史，不删除策略和异常事件。'),
      button('确认清空', 'confirm-clear-history', () => { void clearHistoryData(); }),
      button('取消', 'cancel-clear-history', () => {
        clearConfirmation = false;
        if (latestSnapshot) renderSnapshot(latestSnapshot);
      }),
    );
  } else {
    aside.append(button('清空历史', 'clear-history', () => {
      clearConfirmation = true;
      if (latestSnapshot) renderSnapshot(latestSnapshot);
    }));
  }
  return aside;
}

async function updateBackfill(enabled: boolean): Promise<void> {
  if (!context) return;
  try {
    historyStatus = normalizeHistoryStatus(await context.message.request(
      PLUGIN, 'updateHistorySettings', { localSessionBackfill: enabled },
    ));
    if (latestSnapshot) renderSnapshot(latestSnapshot);
  } catch (error) {
    historyError = errorDetail(error) ?? '历史设置更新失败';
    if (latestSnapshot) renderSnapshot(latestSnapshot);
  }
}

async function clearHistoryData(): Promise<void> {
  if (!context) return;
  try {
    historyStatus = normalizeHistoryStatus(await context.message.request(
      PLUGIN, 'clearHistory', { confirmation: 'clear-history' },
    ));
    historyResult = null;
    clearConfirmation = false;
    await refreshHistory();
  } catch (error) {
    historyError = errorDetail(error) ?? '历史清理失败';
    if (latestSnapshot) renderSnapshot(latestSnapshot);
  }
}

function createHeader(snapshot: AgentGuardSnapshot): HTMLElement {
  const header = document.createElement('header');
  header.className = 'protection-header';
  const identity = document.createElement('div');
  identity.className = 'identity';
  identity.append(textElement('span', 'eyebrow', 'Agent Guard'));
  const title = textElement('h1', '', '本机智能体流量');
  const description = textElement(
    'p', 'lede', '监控已知智能体进程的累计连接字节与任务活动。',
  );
  identity.append(title, description);

  const seal = document.createElement('div');
  seal.className = `protection-seal state-${snapshot.state}`;
  seal.dataset.state = snapshot.state;
  seal.append(
    textElement('span', 'seal-label', snapshot.state === 'tripped' ? '流量已暂停' : '保护状态'),
    textElement('strong', '', stateLabel(snapshot.state)),
    textElement('span', 'seal-detail', snapshot.collector.incomplete ? '采集存在缺口，仅进行告警' : `采样周期 ${snapshot.collector.epoch}`),
  );
  header.append(identity, seal);
  return header;
}

function createTrafficSection(endpoints: AgentEndpointSnapshot[]): HTMLElement {
  const section = document.createElement('section');
  section.className = 'traffic-deck';
  section.setAttribute('aria-labelledby', 'traffic-title');
  const heading = textElement('div', 'section-heading', '');
  const title = textElement('h2', '', '观测路由');
  title.id = 'traffic-title';
  heading.append(title, textElement('span', 'section-note', '每 2 秒读取累计值，按 60 秒计算速率'));
  section.append(heading);
  if (endpoints.length === 0) {
    section.append(textElement('p', 'empty-route', '当前没有活跃的 Claude 或 Codex 模型端点，后台监控仍在继续。'));
    return section;
  }
  const routes = document.createElement('div');
  routes.className = 'route-list';
  for (const endpoint of endpoints) routes.append(createRoute(endpoint));
  section.append(routes);
  return section;
}

function createRoute(endpoint: AgentEndpointSnapshot): HTMLElement {
  const article = document.createElement('article');
  article.className = 'traffic-route';
  article.dataset.agent = endpoint.agent;
  const start = document.createElement('div');
  start.className = 'route-origin';
  start.append(
    textElement('span', 'agent-mark', endpoint.agent === 'claude' ? 'CL' : 'CX'),
    textElement('strong', '', endpoint.agent === 'claude' ? 'Claude' : 'Codex'),
    textElement('span', 'provider', endpoint.provider),
  );
  const lane = document.createElement('div');
  lane.className = 'flow-lane';
  lane.dataset.active = String(endpoint.bytesInPerMinute > 0 || endpoint.bytesOutPerMinute > 0);
  lane.setAttribute('aria-hidden', 'true');
  lane.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
  const destination = document.createElement('div');
  destination.className = 'route-destination';
  destination.append(textElement('code', '', endpoint.hostname));
  const confidence = textElement('span', `confidence confidence-${endpoint.confidence}`, confidenceLabel(endpoint.confidence));
  confidence.dataset.confidence = endpoint.confidence;
  destination.append(confidence);

  const metrics = document.createElement('dl');
  metrics.className = 'route-metrics';
  metrics.append(
    metric('上行流量', formatRate(endpoint.bytesOutPerMinute), 'bytes-out'),
    metric('下行流量', formatRate(endpoint.bytesInPerMinute), 'bytes-in'),
    metric('连接数', String(endpoint.connections), 'connections'),
    metric('活跃任务', String(endpoint.activeTasks), 'active-tasks'),
  );
  article.append(start, lane, destination, metrics);
  return article;
}

function createIncidentLedger(incidents: IncidentSummary[]): HTMLElement {
  const section = document.createElement('section');
  section.className = 'incident-ledger';
  const heading = textElement('div', 'section-heading', '');
  heading.append(textElement('h2', '', '事件记录'), textElement('span', 'section-note', `当前视图保留 ${incidents.length} 条记录`));
  section.append(heading);
  if (incidents.length === 0) {
    section.append(textElement('p', 'ledger-empty', '尚未记录到异常智能体流量，后台监控仍在继续。'));
    return section;
  }
  for (const incident of [...incidents].reverse()) section.append(createIncident(incident));
  return section;
}

function createIncident(incident: IncidentSummary): HTMLElement {
  const article = document.createElement('article');
  article.className = `incident-row incident-${incident.state}`;
  article.dataset.incidentId = incident.id;
  const marker = textElement('span', 'incident-marker', incidentStateLabel(incident.state));
  const body = document.createElement('div');
  body.className = 'incident-body';
  body.append(
    textElement('strong', '', incident.ruleId),
    textElement('p', '', incident.summary),
    textElement('span', 'incident-meta', `${incident.agent} / ${incident.hostname} / ${confidenceLabel(incident.confidence)}`),
  );
  const actions = document.createElement('div');
  actions.className = 'incident-actions';
  if (incident.state === 'tripped') {
    actions.append(button('恢复任务', 'resume', () => runCommand({ type: 'resume', incidentId: incident.id })));
    actions.append(button('结束任务', 'terminate', () => runCommand({ type: 'terminate', incidentId: incident.id })));
  }
  actions.append(button('忽略 15 分钟', 'ignore', () => runCommand({
    type: 'ignore', incidentId: incident.id, durationMinutes: 15,
  })));
  article.append(marker, body, actions);
  return article;
}

function createPolicyPanel(): HTMLElement {
  const aside = document.createElement('aside');
  aside.className = 'policy-panel';
  aside.append(
    textElement('span', 'policy-version', '策略 v1'),
    textElement('h2', '', '双重信号触发暂停'),
    textElement('p', '', '字节流量突增会先触发警告。只有确认属于模型流量，并且任务或会话持续增长时，系统才会自动暂停。'),
  );
  const form = document.createElement('form');
  form.className = 'policy-form';
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const values = new FormData(form);
    runMutation('updatePolicy', policyWithThresholds(
      Number(values.get('warning-outbound')),
      Number(values.get('trip-outbound')),
    ));
  });
  form.append(
    numberField('警告阈值', 'warning-outbound', policyDraft?.warning ?? String(DEFAULT_POLICY.fixedWarning.outboundMiB), 'MiB / 10 分钟'),
    numberField('暂停阈值', 'trip-outbound', policyDraft?.trip ?? String(DEFAULT_POLICY.fixedTrip.outboundMiB), 'MiB / 10 分钟'),
    button('保存策略', 'save-policy', () => form.requestSubmit()),
  );
  aside.append(form);
  return aside;
}

function numberField(label: string, name: string, value: string, unit: string): HTMLElement {
  const wrapper = document.createElement('label');
  wrapper.className = 'policy-field';
  wrapper.append(textElement('span', '', label));
  const line = document.createElement('span');
  line.className = 'policy-input';
  const input = document.createElement('input');
  input.type = 'number';
  input.dataset.action = name;
  input.name = name;
  input.min = '1';
  input.step = '1';
  input.required = true;
  input.autocomplete = 'off';
  input.value = value;
  line.append(input, textElement('small', '', unit));
  wrapper.append(line);
  return wrapper;
}

function policyWithThresholds(warningOutboundMiB: number, tripOutboundMiB: number): PolicyV1 {
  return {
    ...DEFAULT_POLICY,
    fixedWarning: { ...DEFAULT_POLICY.fixedWarning, outboundMiB: warningOutboundMiB },
    fixedTrip: { ...DEFAULT_POLICY.fixedTrip, outboundMiB: tripOutboundMiB },
  };
}

function createPrivacyNote(): HTMLElement {
  const note = document.createElement('footer');
  note.className = 'privacy-note';
  note.append(
    textElement('span', 'privacy-lock', '仅采集本机连接元数据'),
    textElement('p', '', '不会采集提示词、响应内容、凭据或精确请求总数。'),
  );
  return note;
}

function renderState(message: string, state: string, detail?: string): void {
  if (!root) return;
  const container = document.createElement('section');
  container.className = 'panel-state';
  container.dataset.state = state;
  container.setAttribute('role', state === 'unavailable' ? 'alert' : 'status');
  container.append(textElement('span', 'eyebrow', 'Agent Guard'), textElement('h1', '', message));
  if (detail) container.append(textElement('p', 'state-detail', detail));
  if (state === 'unavailable') container.append(button('重试', 'retry', () => { void refresh(); }));
  root.replaceChildren(container);
}

function createOperationError(detail: string): HTMLElement {
  const message = document.createElement('p');
  message.className = 'operation-error';
  message.setAttribute('role', 'alert');
  message.append(textElement('strong', '', '操作失败：'), document.createTextNode(detail));
  return message;
}

function metric(label: string, value: string, name?: string): HTMLElement {
  const wrapper = document.createElement('div');
  const term = textElement('dt', '', label);
  const description = textElement('dd', '', value);
  if (name) {
    description.dataset.metric = name;
  }
  wrapper.append(term, description);
  return wrapper;
}

function button(label: string, action: string, handler: () => void): HTMLButtonElement {
  const value = document.createElement('button');
  value.type = 'button';
  value.dataset.action = action;
  value.textContent = label;
  value.addEventListener('click', handler);
  return value;
}

function setButtonsDisabled(disabled: boolean): void {
  root?.querySelectorAll<HTMLButtonElement>('button').forEach((value) => { value.disabled = disabled; });
}

function textElement<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, value: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = value;
  return element;
}

function formatRate(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB/min`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB/min`;
  return `${bytes} B/min`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

function formatLocalTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(timestamp);
}

function formatHistoryValue(value: number, unit: string): string {
  if (unit === 'bytes') return formatBytes(value);
  return `${value.toLocaleString('zh-CN')} ${unit === 'tokens' ? 'tokens' : unit === 'requests' ? '次请求' : '个会话'}`;
}

function historyMetricLabel(metric: string): string {
  return ({
    'bytes-in': '下行', 'bytes-out': '上行', 'input-tokens': '输入 token',
    'output-tokens': '输出 token', 'cache-tokens': '缓存 token', requests: '请求', sessions: '会话',
  } as Record<string, string>)[metric] ?? metric;
}

function historyRangeMs(value: typeof historyRange): number {
  return ({
    '1h': 60 * 60_000,
    '24h': 24 * 60 * 60_000,
    '7d': 7 * 24 * 60 * 60_000,
    '30d': 30 * 24 * 60 * 60_000,
    '90d': 90 * 24 * 60 * 60_000,
    '1y': 365 * 24 * 60 * 60_000,
  } as const)[value];
}

function historyBucket(value: typeof historyRange): 'minute' | 'hour' | 'day' {
  if (value === '1h' || value === '24h') return 'minute';
  if (value === '7d' || value === '30d') return 'hour';
  return 'day';
}

function historyQueryKey(domain: typeof historyDomain, range: typeof historyRange): string {
  return `${domain}:${range}`;
}

function historyMetricUnit(metric: HistorySeries['metric']): HistorySeries['unit'] {
  if (metric === 'bytes-in' || metric === 'bytes-out') return 'bytes';
  if (metric === 'input-tokens' || metric === 'output-tokens' || metric === 'cache-tokens') return 'tokens';
  return metric;
}

function confidenceLabel(value: AgentEndpointSnapshot['confidence']): string {
  return value === 'confirmed' ? '已确认' : value === 'probable' ? '较可信' : '未知';
}

function incidentStateLabel(value: IncidentSummary['state']): string {
  return ({ warning: '警告', tripped: '已暂停', cooldown: '冷却观察' } as const)[value];
}

function errorDetail(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : undefined;
}

function stateLabel(value: AgentGuardSnapshot['state']): string {
  return ({
    learning: '学习基线', normal: '正常监控', warning: '流量警告', tripped: '已暂停',
    cooldown: '冷却观察', degraded: '降级监控',
  } as const)[value];
}

const DEFAULT_POLICY: PolicyV1 = {
  schemaVersion: 1,
  evaluationWindowSeconds: 60,
  consecutiveWindows: 3,
  trafficWindowMinutes: 10,
  learningHours: 24,
  dynamicWarning: {
    medianMultiplier: 5,
    madMultiplier: 6,
    minOutboundMiBPerMinute: 8,
    corroborators: { sessionsPerMinute: 6, tasksPerMinute: 8, connectionsPerMinute: 20 },
  },
  fixedWarning: { outboundMiB: 128, sessionsOrTasks: 20 },
  fixedTrip: { outboundMiB: 256, sessionsOrTasks: 30, minimumConfidence: 'confirmed' },
  structuralTrip: {
    recursiveDepth: 4,
    recursiveTasks: 8,
    recursiveWindowSeconds: 120,
    burstTasks: 20,
    burstActiveTasks: 8,
    burstWindowSeconds: 60,
  },
};
