type MisfirePolicy = 'run-once' | 'skip';
type JobSchedule =
  | { kind: 'once'; runAt: string }
  | { kind: 'interval'; startAt: string; everyMs: number };

type SchedulerJob = {
  id: string;
  name: string;
  scriptPath: string;
  schedule: JobSchedule;
  misfirePolicy: MisfirePolicy;
  enabled: boolean;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type JobRun = {
  id: string;
  jobId: string;
  trigger: 'scheduled' | 'manual' | 'misfire';
  scheduledFor: string;
  startedAt: string | null;
  finishedAt: string | null;
  status: 'running' | 'succeeded' | 'failed' | 'skipped' | 'interrupted';
  reason: string | null;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
};

type SchedulerSnapshot = {
  now: string;
  jobs: SchedulerJob[];
  runs: JobRun[];
  activeJobIds: string[];
  serviceError: string | null;
};

type ScriptDirectoryListing = {
  currentPath: string;
  parentPath: string | null;
  entries: Array<{
    name: string;
    path: string;
    kind: 'directory' | 'file';
  }>;
};

type PanelContext = {
  message: {
    request(plugin: string, route: string, method: string, ...args: unknown[]): Promise<unknown>;
  };
};

const SERVICE = '@itharbors/scheduler-service';
const ROUTE = 'scheduler';
const POLL_INTERVAL_MS = 2_000;
const MISFIRE_GRACE_MS = 30_000;
const DEFAULT_LEAD_MS = 5 * 60_000;
const PREVIEW_COUNT = 3;

let context: PanelContext | null = null;
let root: HTMLElement | null = null;
let snapshot: SchedulerSnapshot | null = null;
let pollTimer: number | null = null;
let mounted = false;
let lifecycleVersion = 0;
let refreshGeneration = 0;
let refreshPromise: Promise<void> | null = null;
let actionBusy = false;
let formVisible = false;
let editingJobId: string | null = null;
let formDirty = false;
let returnFocusTarget: { action: 'new-job' | 'edit-job'; jobId?: string } | null = null;
let confirmDeleteId: string | null = null;
let unavailableMessage: string | null = null;
let actionMessage: string | null = null;

const definition = {
  async mount(ctx: PanelContext) {
    lifecycleVersion += 1;
    context = ctx;
    root = document.getElementById('panel-root');
    if (!root) throw new Error('Panel root element #panel-root not found');
    mounted = true;
    snapshot = null;
    formVisible = false;
    editingJobId = null;
    formDirty = false;
    returnFocusTarget = null;
    confirmDeleteId = null;
    unavailableMessage = null;
    actionMessage = null;
    renderLoading();
    await refresh(false);
    if (mounted) {
      pollTimer = window.setInterval(() => {
        void refresh(true);
      }, POLL_INTERVAL_MS);
    }
  },
  unmount() {
    mounted = false;
    lifecycleVersion += 1;
    refreshGeneration += 1;
    if (pollTimer !== null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
    context = null;
    root = null;
    snapshot = null;
    refreshPromise = null;
    actionBusy = false;
    formVisible = false;
    editingJobId = null;
    formDirty = false;
    returnFocusTarget = null;
    confirmDeleteId = null;
    unavailableMessage = null;
    actionMessage = null;
  },
};

export default definition;

function refresh(preserveOpenForm: boolean): Promise<void> {
  if (!mounted || !context) return Promise.resolve();
  if (refreshPromise) return refreshPromise;
  const version = lifecycleVersion;
  const generation = ++refreshGeneration;
  const currentContext = context;
  let operation: Promise<void>;
  operation = (async () => {
    try {
      const value = await currentContext.message.request(SERVICE, ROUTE, 'getSnapshot');
      if (!isCurrent(version, generation)) return;
      snapshot = normalizeSnapshot(value);
      unavailableMessage = null;
      if (preserveOpenForm && formVisible) {
        updateVisibleServiceStatus(true);
      } else {
        renderWorkspace();
      }
    } catch (error) {
      if (!isCurrent(version, generation)) return;
      unavailableMessage = errorMessage(error);
      if (preserveOpenForm && formVisible) {
        updateVisibleServiceStatus(false);
      } else {
        renderUnavailable();
      }
    } finally {
      if (refreshPromise === operation) refreshPromise = null;
    }
  })();
  refreshPromise = operation;
  return operation;
}

async function runAction(method: string, ...args: unknown[]) {
  if (!mounted || !context || actionBusy) return;
  actionBusy = true;
  actionMessage = null;
  try {
    await context.message.request(SERVICE, ROUTE, method, ...args);
    if (!mounted) return;
    confirmDeleteId = null;
    if (method === 'saveJob' || method === 'deleteJob') {
      formVisible = false;
      editingJobId = null;
      formDirty = false;
      returnFocusTarget = null;
    }
    refreshPromise = null;
    await refresh(false);
  } catch (error) {
    if (!mounted) return;
    actionMessage = errorMessage(error);
    renderWorkspace();
  } finally {
    actionBusy = false;
  }
}

function renderLoading() {
  if (!root) return;
  const loading = document.createElement('main');
  loading.className = 'scheduler-workspace loading-shell';
  loading.setAttribute('aria-label', '正在读取调度时刻表');
  loading.setAttribute('aria-busy', 'true');

  const status = document.createElement('span');
  status.className = 'sr-only';
  status.setAttribute('role', 'status');
  status.textContent = '正在读取调度时刻表';

  const header = document.createElement('div');
  header.className = 'loading-header';
  header.setAttribute('aria-hidden', 'true');
  header.append(createSkeleton('loading-line loading-line--title'));
  const headerMeta = createSkeleton('loading-line loading-line--meta');
  header.append(headerMeta);

  const summary = document.createElement('div');
  summary.className = 'loading-summary';
  summary.setAttribute('aria-hidden', 'true');
  for (let index = 0; index < 4; index += 1) {
    const item = document.createElement('div');
    item.className = 'loading-summary__item';
    item.append(
      createSkeleton('loading-line loading-line--label'),
      createSkeleton('loading-line loading-line--value'),
    );
    summary.append(item);
  }

  const tables = document.createElement('div');
  tables.className = 'loading-tables';
  tables.setAttribute('aria-hidden', 'true');
  for (let index = 0; index < 2; index += 1) {
    const table = document.createElement('section');
    table.className = 'loading-table';
    table.append(
      createSkeleton('loading-line loading-line--section'),
      createSkeleton('loading-block'),
    );
    tables.append(table);
  }

  loading.append(status, header, summary, tables);
  root.replaceChildren(loading);
}

function createSkeleton(className: string) {
  const skeleton = document.createElement('span');
  skeleton.className = `loading-skeleton ${className}`;
  return skeleton;
}

function renderUnavailable() {
  if (!root) return;
  const state = createState('调度服务暂时不可用', 'unavailable');
  const detail = document.createElement('p');
  detail.textContent = unavailableMessage
    ? `服务返回：${unavailableMessage}`
    : '确认 Harbors 服务正在运行，然后重试。';
  state.append(detail, createButton('重新连接', 'retry', () => {
    refreshPromise = null;
    void refresh(false);
  }, 'button-primary'));
  root.replaceChildren(state);
}

function renderWorkspace() {
  if (!root || !snapshot) return;
  const workspace = document.createElement('main');
  workspace.className = 'scheduler-workspace';
  workspace.setAttribute('aria-label', '脚本调度工作台');
  workspace.append(createSkipLink(), createHeader());

  if (snapshot.serviceError) {
    workspace.append(createActionAlert(`后台状态保存失败，正在自动重试：${snapshot.serviceError}`));
  }
  if (actionMessage) {
    workspace.append(createActionAlert(actionMessage));
  }

  workspace.append(createSummary(), createJobsSection(), createHistory());
  if (formVisible) workspace.append(createDrawer());

  const status = document.createElement('div');
  status.className = 'sr-only';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.textContent = `${snapshot.jobs.length} 个计划，${snapshot.activeJobIds.length} 个正在运行`;
  workspace.append(status);
  root.replaceChildren(workspace);
}

function createSkipLink() {
  const link = document.createElement('a');
  link.className = 'skip-link';
  link.href = '#jobs-table';
  link.textContent = '跳到计划任务';
  return link;
}

function createActionAlert(message: string) {
  const alert = document.createElement('div');
  alert.className = 'action-alert';
  alert.setAttribute('role', 'alert');
  alert.textContent = message;
  return alert;
}

function createSummary() {
  const failedRuns = snapshot!.runs.filter((run) =>
    run.status === 'failed' || run.status === 'interrupted').length;
  const enabledJobs = snapshot!.jobs.filter((job) => job.enabled).length;
  const runningJobs = snapshot!.activeJobIds.length;
  const summary = document.createElement('section');
  summary.className = 'summary-strip';
  summary.setAttribute('aria-label', '调度概览');
  summary.append(
    createMetricCard('计划总数', snapshot!.jobs.length, 'neutral'),
    createMetricCard('已启用', enabledJobs, enabledJobs > 0 ? 'success' : 'neutral'),
    createMetricCard('正在运行', runningJobs, runningJobs > 0 ? 'warning' : 'neutral'),
    createMetricCard('失败记录', failedRuns, failedRuns > 0 ? 'danger' : 'neutral'),
  );
  return summary;
}

function createMetricCard(
  label: string,
  value: number,
  tone: 'neutral' | 'success' | 'warning' | 'danger',
) {
  const card = document.createElement('article');
  card.className = `summary-stat summary-${tone}`;
  card.dataset.testid = 'metric-card';
  const copy = document.createElement('span');
  copy.className = 'metric-label';
  copy.textContent = label;
  const count = document.createElement('strong');
  count.className = 'metric-value';
  count.textContent = String(value);
  card.append(copy, count);
  return card;
}

function createHeader() {
  const header = document.createElement('header');
  header.className = 'scheduler-header';
  const identity = document.createElement('div');
  identity.className = 'scheduler-identity';
  const copy = document.createElement('div');
  const breadcrumb = document.createElement('nav');
  breadcrumb.className = 'scheduler-breadcrumb';
  breadcrumb.setAttribute('aria-label', '面包屑');
  breadcrumb.textContent = 'Scheduler / 定时脚本';
  const title = document.createElement('h1');
  title.textContent = '定时脚本';
  const description = document.createElement('p');
  description.textContent = '按计划运行本地 Node.js 脚本，并保留每次执行结果。';
  copy.append(breadcrumb, title, description);
  identity.append(copy);

  const actions = document.createElement('div');
  actions.className = 'header-actions';
  const service = document.createElement('span');
  service.className = 'service-status';
  service.setAttribute('role', 'status');
  setServiceStatus(service, true, Boolean(snapshot!.serviceError));
  const timezone = document.createElement('small');
  timezone.className = 'timezone-label';
  timezone.textContent = localTimezone();
  actions.append(service, timezone, createButton('新建计划', 'new-job', () => {
    openForm(null, { action: 'new-job' });
  }, 'button-primary'));
  header.append(identity, actions);
  return header;
}

function updateVisibleServiceStatus(available: boolean) {
  const service = root?.querySelector<HTMLElement>('.service-status');
  if (service) setServiceStatus(service, available, Boolean(snapshot?.serviceError));
}

function setServiceStatus(service: HTMLElement, available: boolean, degraded = false) {
  service.classList.toggle('is-error', !available);
  service.classList.toggle('is-degraded', available && degraded);
  const dot = document.createElement('span');
  dot.className = 'service-status-dot';
  dot.setAttribute('aria-hidden', 'true');
  service.replaceChildren(
    dot,
    document.createTextNode(
      !available ? '调度服务连接中断' : degraded ? '调度服务降级' : '调度服务正常',
    ),
  );
}

function createJobsSection() {
  const section = document.createElement('section');
  section.className = 'jobs-section';
  section.setAttribute('aria-labelledby', 'jobs-title');
  const heading = document.createElement('div');
  heading.className = 'section-heading';
  const headingCopy = document.createElement('div');
  const title = document.createElement('h2');
  title.id = 'jobs-title';
  title.textContent = '计划任务';
  const count = document.createElement('span');
  count.className = 'count-chip';
  count.textContent = String(snapshot!.jobs.length);
  headingCopy.append(title, count);
  heading.append(headingCopy);
  section.append(heading);

  const tableWrap = document.createElement('div');
  tableWrap.className = 'table-scroll';
  const table = document.createElement('table');
  table.id = 'jobs-table';
  table.className = 'admin-table jobs-table';
  table.setAttribute('aria-labelledby', 'jobs-title');
  const head = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const label of ['计划', '触发规则', '下次执行', '状态', '操作']) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = label;
    headerRow.append(cell);
  }
  head.append(headerRow);
  const body = document.createElement('tbody');
  if (snapshot!.jobs.length === 0) {
    const emptyRow = document.createElement('tr');
    emptyRow.dataset.state = 'empty';
    const emptyCell = document.createElement('td');
    emptyCell.colSpan = 5;
    const emptyTitle = document.createElement('strong');
    emptyTitle.textContent = '还没有计划任务';
    const emptyDetail = document.createElement('p');
    emptyDetail.textContent = '创建第一个计划，选择脚本并确认下一次执行时间。';
    const emptyAction = createButton('新建计划', 'empty-new-job', () => {
      openForm(null, { action: 'new-job' });
    }, 'button-quiet button-inline-primary');
    emptyCell.append(emptyTitle, emptyDetail, emptyAction);
    emptyRow.append(emptyCell);
    body.append(emptyRow);
  } else {
    for (const job of [...snapshot!.jobs].sort(compareJobs)) body.append(createJobRow(job));
  }
  table.append(head, body);
  tableWrap.append(table);
  section.append(tableWrap);
  return section;
}

function createJobRow(job: SchedulerJob) {
  const running = snapshot!.activeJobIds.includes(job.id);
  const row = document.createElement('tr');
  row.className = `${job.enabled ? '' : 'is-paused'}${running ? ' is-running' : ''}`.trim();
  row.dataset.jobId = job.id;

  const planCell = createTableCell('计划');
  const title = document.createElement('strong');
  title.className = 'job-name';
  title.textContent = job.name;
  const script = document.createElement('code');
  script.className = 'script-path';
  script.textContent = job.scriptPath;
  planCell.append(title, script);

  const scheduleCell = createTableCell('触发规则');
  const schedule = document.createElement('span');
  schedule.className = 'schedule-copy';
  schedule.textContent = formatSchedule(job.schedule);
  const policy = document.createElement('small');
  policy.className = 'policy-label';
  policy.textContent = job.misfirePolicy === 'run-once' ? '错过后补跑一次' : '错过后跳过';
  scheduleCell.append(schedule, policy);

  const nextCell = createTableCell('下次执行');
  const nextTime = document.createElement('time');
  if (job.nextRunAt) nextTime.dateTime = job.nextRunAt;
  nextTime.textContent = job.nextRunAt ? formatDateTime(job.nextRunAt) : '暂无安排';
  nextCell.append(nextTime);

  const statusCell = createTableCell('状态');
  const status = running
    ? { label: '运行中', tone: 'running' }
    : job.enabled
      ? { label: '已启用', tone: 'enabled' }
      : { label: '已暂停', tone: 'paused' };
  const badge = document.createElement('span');
  badge.className = `status-badge status-${status.tone}`;
  badge.textContent = status.label;
  statusCell.append(badge);

  const actionCell = createTableCell('操作');
  const actions = document.createElement('div');
  actions.className = 'job-actions';
  actions.append(
    createButton(running ? '运行中' : '立即运行', 'run-job', () => {
      void runAction('runJobNow', job.id);
    }, 'button-quiet button-inline-primary', running),
    createButton(job.enabled ? '暂停' : '恢复', 'toggle-job', () => {
      void runAction('setJobEnabled', job.id, !job.enabled);
    }, 'button-quiet'),
    createButton('编辑', 'edit-job', () => {
      openForm(job.id, { action: 'edit-job', jobId: job.id });
    }, 'button-quiet'),
    createButton('删除', 'delete-job', () => {
      confirmDeleteId = job.id;
      renderWorkspace();
    }, 'button-danger'),
  );
  if (confirmDeleteId === job.id) {
    const confirm = document.createElement('div');
    confirm.className = 'delete-confirm';
    const prompt = document.createElement('span');
    prompt.textContent = '删除计划？历史记录会保留。';
    confirm.append(
      prompt,
      createButton('取消', 'cancel-delete', () => {
        confirmDeleteId = null;
        renderWorkspace();
      }, 'button-quiet'),
      createButton('确认删除', 'confirm-delete', () => {
        void runAction('deleteJob', job.id);
      }, 'button-danger'),
    );
    actions.append(confirm);
  }
  actionCell.append(actions);
  row.append(planCell, scheduleCell, nextCell, statusCell, actionCell);
  return row;
}

function createTableCell(label: string) {
  const cell = document.createElement('td');
  cell.dataset.label = label;
  return cell;
}

function createDrawer() {
  const backdrop = document.createElement('div');
  backdrop.className = 'drawer-backdrop';
  const drawer = document.createElement('aside');
  drawer.className = 'scheduler-drawer';
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('aria-modal', 'true');
  drawer.setAttribute('aria-labelledby', 'job-form-title');
  const close = createButton('×', 'close-form', requestCloseForm, 'drawer-close');
  close.setAttribute('aria-label', '关闭计划编辑器');
  drawer.append(close, createJobForm());
  drawer.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      requestCloseForm();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(drawer.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), summary',
    )).filter((element) => !element.hidden && element.tabIndex !== -1);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) requestCloseForm();
  });
  backdrop.append(drawer);
  return backdrop;
}

function createJobForm() {
  const existing = editingJobId
    ? snapshot!.jobs.find((job) => job.id === editingJobId) ?? null
    : null;
  const form = document.createElement('form');
  form.className = 'job-form';
  form.noValidate = true;
  const heading = document.createElement('h2');
  heading.id = 'job-form-title';
  heading.tabIndex = -1;
  heading.textContent = existing ? '编辑计划' : '新建计划';
  const hint = document.createElement('p');
  hint.textContent = '选择要运行的本地脚本，再确认它下一次何时执行。';
  const drawerHeader = document.createElement('div');
  drawerHeader.className = 'drawer-header';
  drawerHeader.append(heading, hint);
  const drawerBody = document.createElement('div');
  drawerBody.className = 'drawer-body';
  form.append(drawerHeader, drawerBody);

  const name = createInput('计划名称', 'name', 'text', existing?.name ?? '', '例如：每日数据汇总');
  name.input.required = true;
  name.input.maxLength = 80;
  const script = createInput(
    '脚本路径',
    'scriptPath',
    'text',
    existing?.scriptPath ?? '',
    '/Users/name/jobs/report.mjs',
  );
  script.input.required = true;
  const scriptPicker = document.createElement('div');
  scriptPicker.className = 'script-picker';
  script.input.replaceWith(scriptPicker);
  const chooseScript = createButton('选择脚本', 'choose-script', () => {
    void browseScriptDirectory();
  }, 'button-quiet');
  scriptPicker.append(script.input, chooseScript);
  const scriptBrowserHost = document.createElement('div');
  scriptBrowserHost.className = 'script-browser-host';
  script.field.append(scriptBrowserHost);

  const fieldErrors = new Map<string, { control: HTMLInputElement; error: HTMLElement }>();
  for (const field of [name, script]) {
    fieldErrors.set(field.input.name, {
      control: field.input,
      error: createFieldError(field.field, field.input),
    });
  }

  let browserGeneration = 0;
  async function browseScriptDirectory(directory?: string) {
    if (!mounted || !context) return;
    const generation = ++browserGeneration;
    chooseScript.disabled = true;
    chooseScript.textContent = '正在读取…';
    try {
      const value = await context.message.request(
        SERVICE,
        ROUTE,
        'listScriptDirectory',
        ...(directory ? [directory] : []),
      );
      if (!mounted || generation !== browserGeneration || !form.isConnected) return;
      renderScriptBrowser(normalizeScriptDirectoryListing(value));
    } catch (error) {
      if (!mounted || generation !== browserGeneration || !form.isConnected) return;
      setFieldError(
        fieldErrors,
        'scriptPath',
        `无法读取脚本目录：${errorMessage(error)}`,
      );
    } finally {
      if (generation === browserGeneration && chooseScript.isConnected) {
        chooseScript.disabled = false;
        chooseScript.textContent = '选择脚本';
      }
    }
  }

  function renderScriptBrowser(listing: ScriptDirectoryListing) {
    const browser = document.createElement('section');
    browser.className = 'script-browser';
    browser.dataset.testid = 'script-browser';
    browser.setAttribute('aria-label', '脚本文件浏览器');

    const header = document.createElement('div');
    header.className = 'script-browser__header';
    const currentPath = document.createElement('code');
    currentPath.textContent = listing.currentPath;
    currentPath.title = listing.currentPath;
    const closeBrowser = createButton('关闭', 'close-script-browser', () => {
      browserGeneration += 1;
      scriptBrowserHost.replaceChildren();
      chooseScript.focus();
    }, 'button-quiet');
    header.append(currentPath, closeBrowser);

    const navigation = document.createElement('div');
    navigation.className = 'script-browser__navigation';
    if (listing.parentPath) {
      navigation.append(createButton('← 上级目录', 'browse-parent-directory', () => {
        void browseScriptDirectory(listing.parentPath!);
      }, 'button-quiet'));
    }

    const entries = document.createElement('ul');
    entries.className = 'script-browser__entries';
    if (listing.entries.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'script-browser__empty';
      empty.textContent = '此目录中没有子目录或可用的 Node.js 脚本。';
      navigation.append(empty);
    } else {
      for (const entry of listing.entries) {
        const item = document.createElement('li');
        const button = createButton(
          entry.name,
          'browse-script-entry',
          () => {
            if (entry.kind === 'directory') {
              void browseScriptDirectory(entry.path);
              return;
            }
            script.input.value = entry.path;
            script.input.dispatchEvent(new Event('input', { bubbles: true }));
            browserGeneration += 1;
            scriptBrowserHost.replaceChildren();
            chooseScript.focus();
          },
          'script-browser__entry',
        );
        button.dataset.scriptEntryPath = entry.path;
        button.dataset.entryKind = entry.kind;
        item.append(button);
        entries.append(item);
      }
    }

    browser.append(header, navigation, entries);
    scriptBrowserHost.replaceChildren(browser);
  }

  const scheduleField = document.createElement('label');
  scheduleField.className = 'form-field';
  const scheduleLabel = document.createElement('span');
  scheduleLabel.textContent = '触发方式';
  const scheduleType = document.createElement('select');
  scheduleType.name = 'scheduleKind';
  scheduleType.append(
    option('once', '指定时间执行一次'),
    option('interval', '按固定间隔循环'),
  );
  scheduleType.value = existing?.schedule.kind ?? 'once';
  scheduleField.append(scheduleLabel, scheduleType);

  const defaultTime = toLocalInput(
    new Date(Date.parse(snapshot!.now) + DEFAULT_LEAD_MS).toISOString(),
  );
  const once = createInput(
    '执行时间',
    'runAt',
    'datetime-local',
    existing?.schedule.kind === 'once' ? toLocalInput(existing.schedule.runAt) : defaultTime,
  );
  once.field.dataset.scheduleFields = 'once';
  once.input.required = true;
  once.label.append(createTimezoneNote());
  fieldErrors.set(once.input.name, {
    control: once.input,
    error: createFieldError(once.field, once.input),
  });

  const intervalGroup = document.createElement('div');
  intervalGroup.className = 'interval-fields';
  intervalGroup.dataset.scheduleFields = 'interval';
  const start = createInput(
    '起始时间',
    'startAt',
    'datetime-local',
    existing?.schedule.kind === 'interval' ? toLocalInput(existing.schedule.startAt) : defaultTime,
  );
  start.input.required = true;
  start.label.append(createTimezoneNote());
  fieldErrors.set(start.input.name, {
    control: start.input,
    error: createFieldError(start.field, start.input),
  });
  const intervalValue = createInput(
    '间隔',
    'intervalValue',
    'number',
    String(existing?.schedule.kind === 'interval'
      ? intervalParts(existing.schedule.everyMs).value
      : 1),
  );
  intervalValue.input.min = '1';
  intervalValue.input.step = '1';
  intervalValue.input.required = true;
  fieldErrors.set(intervalValue.input.name, {
    control: intervalValue.input,
    error: createFieldError(intervalValue.field, intervalValue.input),
  });
  const unitField = document.createElement('label');
  unitField.className = 'form-field compact-field';
  const unitLabel = document.createElement('span');
  unitLabel.textContent = '单位';
  const unit = document.createElement('select');
  unit.name = 'intervalUnit';
  unit.append(option('minute', '分钟'), option('hour', '小时'), option('day', '天'));
  unit.value = existing?.schedule.kind === 'interval'
    ? intervalParts(existing.schedule.everyMs).unit
    : 'hour';
  unitField.append(unitLabel, unit);
  intervalGroup.append(start.field, intervalValue.field, unitField);

  const preview = document.createElement('section');
  preview.className = 'schedule-preview';
  preview.dataset.testid = 'schedule-preview';
  preview.setAttribute('aria-label', '执行预览');

  const policyField = document.createElement('label');
  policyField.className = 'form-field';
  const policyLabel = document.createElement('span');
  policyLabel.textContent = '错过触发时';
  const policy = document.createElement('select');
  policy.name = 'misfirePolicy';
  policy.append(
    option('run-once', '恢复后立即执行一次（推荐）'),
    option('skip', '不补跑，等待下一次'),
  );
  policy.value = existing?.misfirePolicy ?? 'run-once';
  policyField.append(policyLabel, policy);
  const policyHint = document.createElement('small');
  policyHint.textContent = 'Harbors 停止运行或系统休眠，超过计划时间 30 秒时使用此规则。';
  policyField.append(policyHint);
  drawerBody.append(
    createFormGroup('job-form-basics', '基础信息', name.field, script.field),
    createFormGroup(
      'job-form-schedule',
      '时间安排',
      scheduleField,
      once.field,
      intervalGroup,
      preview,
    ),
    createFormGroup('job-form-misfire', '错过触发', policyField),
  );

  const formError = document.createElement('div');
  formError.className = 'form-error';
  formError.setAttribute('role', 'alert');
  formError.hidden = true;
  drawerBody.append(formError);

  const actions = document.createElement('div');
  actions.className = 'form-actions';
  actions.append(
    createButton('取消', 'cancel-form', requestCloseForm, 'button-quiet'),
  );
  const submit = async () => {
    if (!validateForm()) return;
    const data = new FormData(form);
    const kind = String(data.get('scheduleKind'));
    const schedule: JobSchedule = kind === 'interval'
      ? {
          kind: 'interval',
          startAt: localInputToIso(String(data.get('startAt'))),
          everyMs: intervalMilliseconds(
            Number(data.get('intervalValue')),
            String(data.get('intervalUnit')),
          ),
        }
      : {
          kind: 'once',
          runAt: localInputToIso(String(data.get('runAt'))),
        };
    const payload = {
      ...(existing ? { id: existing.id } : {}),
      name: String(data.get('name')),
      scriptPath: String(data.get('scriptPath')),
      schedule,
      misfirePolicy: String(data.get('misfirePolicy')),
    };
    if (!mounted || !context || actionBusy) return;
    actionBusy = true;
    actionMessage = null;
    setFormBusy(form, save, true);
    try {
      await context.message.request(SERVICE, ROUTE, 'saveJob', payload);
      if (!mounted) return;
      formVisible = false;
      editingJobId = null;
      formDirty = false;
      returnFocusTarget = null;
      refreshPromise = null;
      await refresh(false);
    } catch (error) {
      if (!mounted) return;
      const localized = localizeFormError(error);
      if (localized.field) {
        setFieldError(fieldErrors, localized.field, localized.message);
      } else {
        formError.textContent = localized.message;
        formError.hidden = false;
        heading.focus();
      }
    } finally {
      actionBusy = false;
      if (form.isConnected) setFormBusy(form, save, false);
    }
  };
  const save = createButton(
    existing ? '保存更改' : '保存计划',
    'save-job',
    () => {
      void submit();
    },
    'button-primary',
  );
  actions.append(save);
  form.append(actions);

  const syncScheduleFields = () => {
    const interval = scheduleType.value === 'interval';
    once.field.hidden = interval;
    once.input.disabled = interval;
    intervalGroup.hidden = !interval;
    for (const control of Array.from(
      intervalGroup.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select'),
    )) {
      control.disabled = !interval;
    }
    syncPreview();
  };

  const readSchedule = (): JobSchedule | null => {
    try {
      if (scheduleType.value === 'interval') {
        const everyMs = intervalMilliseconds(Number(intervalValue.input.value), unit.value);
        if (!Number.isInteger(everyMs) || everyMs <= 0) return null;
        return {
          kind: 'interval',
          startAt: localInputToIso(start.input.value),
          everyMs,
        };
      }
      return { kind: 'once', runAt: localInputToIso(once.input.value) };
    } catch {
      return null;
    }
  };

  function syncPreview() {
    renderSchedulePreview(preview, readSchedule(), snapshot!.now);
  }

  function validateForm() {
    clearFieldErrors(fieldErrors);
    formError.hidden = true;
    const invalid: string[] = [];
    if (!name.input.value.trim()) {
      setFieldError(fieldErrors, 'name', '请输入计划名称。', false);
      invalid.push('name');
    }
    const scriptPath = script.input.value.trim();
    if (!scriptPath) {
      setFieldError(fieldErrors, 'scriptPath', '请选择脚本或输入绝对路径。', false);
      invalid.push('scriptPath');
    } else if (!isAbsolutePathLike(scriptPath)) {
      setFieldError(fieldErrors, 'scriptPath', '请输入脚本的绝对路径。', false);
      invalid.push('scriptPath');
    } else if (!/\.(?:js|mjs|cjs)$/i.test(scriptPath)) {
      setFieldError(fieldErrors, 'scriptPath', '仅支持 .js、.mjs 或 .cjs 脚本。', false);
      invalid.push('scriptPath');
    }

    const schedule = readSchedule();
    if (scheduleType.value === 'once') {
      if (!schedule || schedule.kind !== 'once') {
        setFieldError(fieldErrors, 'runAt', '请选择有效的执行时间。', false);
        invalid.push('runAt');
      } else if (Date.parse(schedule.runAt) <= Date.parse(snapshot!.now) + MISFIRE_GRACE_MS) {
        setFieldError(
          fieldErrors,
          'runAt',
          '执行时间需要至少晚于当前服务时间 30 秒。',
          false,
        );
        invalid.push('runAt');
      }
    } else {
      if (!start.input.value) {
        setFieldError(fieldErrors, 'startAt', '请选择有效的起始时间。', false);
        invalid.push('startAt');
      }
      if (!Number.isInteger(Number(intervalValue.input.value)) || Number(intervalValue.input.value) < 1) {
        setFieldError(fieldErrors, 'intervalValue', '间隔必须是大于 0 的整数。', false);
        invalid.push('intervalValue');
      }
    }
    if (invalid.length > 0) {
      fieldErrors.get(invalid[0])?.control.focus();
      return false;
    }
    return true;
  }

  scheduleType.addEventListener('change', syncScheduleFields);
  form.addEventListener('input', (event) => {
    formDirty = true;
    if (event.target instanceof HTMLInputElement) {
      clearFieldError(fieldErrors, event.target.name);
    }
    syncPreview();
  });
  form.addEventListener('change', () => {
    formDirty = true;
    syncPreview();
  });
  syncScheduleFields();

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submit();
  });
  form.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || !(event.target instanceof HTMLInputElement)) return;
    event.preventDefault();
    void submit();
  });
  return form;
}

function createFormGroup(id: string, title: string, ...children: HTMLElement[]) {
  const group = document.createElement('section');
  group.className = 'form-group';
  group.setAttribute('aria-labelledby', id);
  const heading = document.createElement('h3');
  heading.id = id;
  heading.textContent = title;
  group.append(heading, ...children);
  return group;
}

function createHistory() {
  const section = document.createElement('section');
  section.className = 'history-section';
  section.setAttribute('aria-labelledby', 'history-title');
  const heading = document.createElement('div');
  heading.className = 'section-heading';
  const title = document.createElement('h2');
  title.id = 'history-title';
  title.textContent = '运行记录';
  const note = document.createElement('span');
  note.textContent = '最近 100 条';
  heading.append(title, note);
  section.append(heading);

  const tableWrap = document.createElement('div');
  tableWrap.className = 'table-scroll';
  const table = document.createElement('table');
  table.id = 'history-table';
  table.className = 'admin-table history-table';
  table.setAttribute('aria-labelledby', 'history-title');
  const head = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const label of ['运行结果', '触发来源', '执行时间', '耗时', '输出']) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = label;
    headerRow.append(cell);
  }
  head.append(headerRow);
  const body = document.createElement('tbody');
  if (snapshot!.runs.length === 0) {
    const emptyRow = document.createElement('tr');
    emptyRow.dataset.state = 'history-empty';
    const emptyCell = document.createElement('td');
    emptyCell.colSpan = 5;
    emptyCell.textContent = '脚本运行后，退出状态和输出会显示在这里。';
    emptyRow.append(emptyCell);
    body.append(emptyRow);
  } else {
    for (const run of snapshot!.runs) body.append(createRunRow(run));
  }
  table.append(head, body);
  tableWrap.append(table);
  section.append(tableWrap);
  return section;
}

function createRunRow(run: JobRun) {
  const row = document.createElement('tr');
  row.className = `run-row run-${run.status}`;
  row.dataset.runId = run.id;

  const resultCell = createTableCell('运行结果');
  resultCell.classList.add('run-result');
  const signal = document.createElement('span');
  signal.className = 'run-signal';
  signal.setAttribute('aria-hidden', 'true');
  const resultCopy = document.createElement('div');
  const name = document.createElement('strong');
  name.textContent = snapshot!.jobs.find((job) => job.id === run.jobId)?.name ?? '已删除计划';
  const status = document.createElement('span');
  status.className = 'run-status';
  status.textContent = runStatusLabel(run);
  resultCopy.append(name, status);
  resultCell.append(signal, resultCopy);

  const triggerCell = createTableCell('触发来源');
  triggerCell.textContent = triggerLabel(run.trigger);

  const timeCell = createTableCell('执行时间');
  const time = document.createElement('time');
  const displayTime = run.startedAt ?? run.scheduledFor;
  time.dateTime = displayTime;
  time.textContent = formatDateTime(displayTime);
  timeCell.append(time);

  const durationCell = createTableCell('耗时');
  durationCell.classList.add('run-duration');
  durationCell.textContent = formatDuration(run);

  const outputCell = createTableCell('输出');

  if (run.stdout || run.stderr || run.reason) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = run.status === 'failed' ? '查看错误与输出' : '查看输出';
    const output = document.createElement('pre');
    output.textContent = [
      run.reason ? `原因: ${run.reason}` : '',
      run.stdout,
      run.stderr,
    ].filter(Boolean).join('\n');
    details.append(summary, output);
    outputCell.append(details);
  } else {
    outputCell.textContent = '—';
  }
  row.append(resultCell, triggerCell, timeCell, durationCell, outputCell);
  return row;
}

function formatDuration(run: JobRun) {
  if (run.status === 'running') return '运行中';
  if (!run.startedAt || !run.finishedAt) return '—';
  const elapsed = Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt));
  return elapsed < 1_000 ? '< 1 秒' : `${Math.round(elapsed / 1_000)} 秒`;
}

function openForm(
  jobId: string | null = null,
  focusTarget: { action: 'new-job' | 'edit-job'; jobId?: string } = { action: 'new-job' },
) {
  formVisible = true;
  editingJobId = jobId;
  formDirty = false;
  returnFocusTarget = focusTarget;
  confirmDeleteId = null;
  actionMessage = null;
  renderWorkspace();
  document.querySelector<HTMLInputElement>('input[name="name"]')?.focus();
}

function requestCloseForm() {
  if (actionBusy) return;
  if (formDirty && !window.confirm('放弃未保存的更改？')) return;
  closeForm();
}

function closeForm() {
  const target = returnFocusTarget;
  formVisible = false;
  editingJobId = null;
  formDirty = false;
  returnFocusTarget = null;
  actionMessage = null;
  renderWorkspace();
  const row = target?.jobId
    ? Array.from(document.querySelectorAll<HTMLElement>('[data-job-id]'))
      .find((element) => element.dataset.jobId === target.jobId)
    : null;
  const focusTarget = row?.querySelector<HTMLElement>('[data-action="edit-job"]')
    ?? document.querySelector<HTMLElement>('[data-action="new-job"]');
  focusTarget?.focus();
}

function createInput(
  labelText: string,
  name: string,
  type: string,
  value: string,
  placeholder = '',
) {
  const field = document.createElement('div');
  field.className = 'form-field';
  const label = document.createElement('label');
  label.textContent = labelText;
  const input = document.createElement('input');
  const id = `job-${name}`;
  label.htmlFor = id;
  input.id = id;
  input.name = name;
  input.type = type;
  input.value = value;
  input.autocomplete = 'off';
  input.placeholder = placeholder;
  field.append(label, input);
  return { field, input, label };
}

function createTimezoneNote() {
  const note = document.createElement('small');
  note.className = 'field-timezone';
  note.textContent = localTimezone();
  return note;
}

function createFieldError(field: HTMLElement, input: HTMLInputElement) {
  const error = document.createElement('small');
  error.className = 'field-error';
  error.id = `${input.id}-error`;
  error.dataset.errorFor = input.name;
  error.setAttribute('role', 'alert');
  error.hidden = true;
  input.setAttribute('aria-describedby', error.id);
  field.append(error);
  return error;
}

function setFieldError(
  fields: Map<string, { control: HTMLInputElement; error: HTMLElement }>,
  name: string,
  message: string,
  focus = true,
) {
  const field = fields.get(name);
  if (!field) return;
  field.error.textContent = message;
  field.error.hidden = false;
  field.control.setAttribute('aria-invalid', 'true');
  if (focus) field.control.focus();
}

function clearFieldError(
  fields: Map<string, { control: HTMLInputElement; error: HTMLElement }>,
  name: string,
) {
  const field = fields.get(name);
  if (!field) return;
  field.error.textContent = '';
  field.error.hidden = true;
  field.control.removeAttribute('aria-invalid');
}

function clearFieldErrors(
  fields: Map<string, { control: HTMLInputElement; error: HTMLElement }>,
) {
  for (const name of fields.keys()) clearFieldError(fields, name);
}

function setFormBusy(form: HTMLFormElement, save: HTMLButtonElement, busy: boolean) {
  form.setAttribute('aria-busy', String(busy));
  for (const control of Array.from(
    form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
      'input, select, button',
    ),
  )) {
    if (busy) {
      control.dataset.wasDisabled = String(control.disabled);
      control.disabled = true;
    } else {
      control.disabled = control.dataset.wasDisabled === 'true';
      delete control.dataset.wasDisabled;
    }
  }
  if (busy) {
    save.dataset.idleLabel = save.textContent ?? '保存计划';
    save.textContent = '正在保存…';
  } else {
    save.textContent = save.dataset.idleLabel ?? '保存计划';
    delete save.dataset.idleLabel;
  }
}

function localizeFormError(error: unknown): { field?: string; message: string } {
  const message = errorMessage(error);
  if (message.startsWith('Node script does not exist:')) {
    return { field: 'scriptPath', message: '找不到这个脚本文件，请检查路径后重试。' };
  }
  if (message.startsWith('Node script is not a file:')) {
    return { field: 'scriptPath', message: '这个路径不是脚本文件，请重新选择。' };
  }
  if (message === 'Script path must be absolute') {
    return { field: 'scriptPath', message: '请输入脚本的绝对路径。' };
  }
  if (message === 'Script extension must be .js, .mjs, or .cjs') {
    return { field: 'scriptPath', message: '仅支持 .js、.mjs 或 .cjs 脚本。' };
  }
  return { message: '保存失败，请检查填写内容后重试。' };
}

function isAbsolutePathLike(value: string) {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
}

function renderSchedulePreview(
  container: HTMLElement,
  schedule: JobSchedule | null,
  now: string,
) {
  container.replaceChildren();
  const heading = document.createElement('strong');
  heading.textContent = '执行预览';
  container.append(heading);
  if (!schedule) {
    const empty = document.createElement('p');
    empty.textContent = '填写时间后，这里会显示下一次执行安排。';
    container.append(empty);
    return;
  }
  const times = nextPreviewTimes(schedule, now, schedule.kind === 'once' ? 1 : PREVIEW_COUNT);
  const list = document.createElement('ol');
  for (const value of times) {
    const item = document.createElement('li');
    const time = document.createElement('time');
    time.dateTime = value;
    time.textContent = formatPreviewDateTime(value);
    item.append(time);
    list.append(item);
  }
  container.append(list);
  if (schedule.kind === 'interval' && Date.parse(schedule.startAt) <= Date.parse(now)) {
    const note = document.createElement('p');
    note.textContent = '起始时间已过；下一次执行仍沿原始起始时间推进，不逐次补跑。';
    container.append(note);
  }
}

function nextPreviewTimes(schedule: JobSchedule, now: string, count: number) {
  if (schedule.kind === 'once') return [schedule.runAt];
  const start = Date.parse(schedule.startAt);
  const current = Date.parse(now);
  const first = current < start
    ? start
    : start + (Math.floor((current - start) / schedule.everyMs) + 1) * schedule.everyMs;
  return Array.from({ length: count }, (_, index) => (
    new Date(first + index * schedule.everyMs).toISOString()
  ));
}

function formatPreviewDateTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

function createButton(
  label: string,
  action: string,
  handler: () => void,
  className = '',
  disabled = false,
) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.dataset.action = action;
  button.disabled = disabled;
  if (className) button.className = className;
  button.addEventListener('click', handler);
  return button;
}

function createState(title: string, stateName: string) {
  const state = document.createElement('section');
  state.className = `panel-state state-${stateName}`;
  state.dataset.state = stateName;
  const marker = document.createElement('span');
  marker.className = 'state-marker';
  marker.setAttribute('aria-hidden', 'true');
  const heading = document.createElement('h2');
  heading.textContent = title;
  state.append(marker, heading);
  return state;
}

function option(value: string, label: string) {
  const element = document.createElement('option');
  element.value = value;
  element.textContent = label;
  return element;
}

function normalizeSnapshot(value: unknown): SchedulerSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('调度服务返回了无效数据');
  }
  const input = value as Record<string, unknown>;
  if (
    typeof input.now !== 'string'
    || !Array.isArray(input.jobs)
    || !Array.isArray(input.runs)
    || !Array.isArray(input.activeJobIds)
    || (input.serviceError !== undefined
      && input.serviceError !== null
      && typeof input.serviceError !== 'string')
  ) {
    throw new Error('调度服务返回了无效数据');
  }
  return {
    ...(structuredClone(value) as Omit<SchedulerSnapshot, 'serviceError'>),
    serviceError: typeof input.serviceError === 'string' ? input.serviceError : null,
  };
}

function normalizeScriptDirectoryListing(value: unknown): ScriptDirectoryListing {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('脚本目录返回了无效数据');
  }
  const input = value as Record<string, unknown>;
  if (
    typeof input.currentPath !== 'string'
    || (input.parentPath !== null && typeof input.parentPath !== 'string')
    || !Array.isArray(input.entries)
  ) {
    throw new Error('脚本目录返回了无效数据');
  }
  const entries = input.entries.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('脚本目录返回了无效数据');
    }
    const candidate = entry as Record<string, unknown>;
    if (
      typeof candidate.name !== 'string'
      || typeof candidate.path !== 'string'
      || (candidate.kind !== 'directory' && candidate.kind !== 'file')
    ) {
      throw new Error('脚本目录返回了无效数据');
    }
    return {
      name: candidate.name,
      path: candidate.path,
      kind: candidate.kind as 'directory' | 'file',
    };
  });
  return {
    currentPath: input.currentPath as string,
    parentPath: input.parentPath as string | null,
    entries,
  };
}

function isCurrent(version: number, generation: number) {
  return mounted && lifecycleVersion === version && refreshGeneration === generation;
}

function compareJobs(left: SchedulerJob, right: SchedulerJob) {
  if (left.nextRunAt === null) return right.nextRunAt === null ? left.name.localeCompare(right.name) : 1;
  if (right.nextRunAt === null) return -1;
  return Date.parse(left.nextRunAt) - Date.parse(right.nextRunAt);
}

function formatSchedule(schedule: JobSchedule) {
  if (schedule.kind === 'once') return '执行一次';
  const { value, unit } = intervalParts(schedule.everyMs);
  return `每 ${value} ${{ minute: '分钟', hour: '小时', day: '天' }[unit]}`;
}

function intervalParts(everyMs: number): { value: number; unit: 'minute' | 'hour' | 'day' } {
  if (everyMs % 86_400_000 === 0) return { value: everyMs / 86_400_000, unit: 'day' };
  if (everyMs % 3_600_000 === 0) return { value: everyMs / 3_600_000, unit: 'hour' };
  return { value: everyMs / 60_000, unit: 'minute' };
}

function intervalMilliseconds(value: number, unit: string) {
  const multiplier = unit === 'day' ? 86_400_000 : unit === 'hour' ? 3_600_000 : 60_000;
  return value * multiplier;
}

function localInputToIso(value: string) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) throw new Error('请选择有效时间');
  return date.toISOString();
}

function toLocalInput(value: string) {
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

function formatClock(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

function localTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local time';
}

function runStatusLabel(run: JobRun) {
  return {
    running: '运行中',
    succeeded: '成功',
    failed: '失败',
    skipped: run.reason === 'overlap' ? '重叠跳过' : '错过跳过',
    interrupted: '已中断',
  }[run.status];
}

function triggerLabel(trigger: JobRun['trigger']) {
  return {
    scheduled: '定时触发',
    manual: '手动触发',
    misfire: '错过补偿',
  }[trigger];
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
