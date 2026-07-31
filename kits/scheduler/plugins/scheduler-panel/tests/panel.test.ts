// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type PanelDefinition = {
  mount(context: { message: { request: ReturnType<typeof vi.fn> } }): Promise<void>;
  unmount(): void;
};

const snapshot = {
  now: '2026-08-01T01:00:00.000Z',
  activeJobIds: [],
  jobs: [{
    id: 'job-1',
    name: '每日汇总',
    scriptPath: '/Users/demo/jobs/report.mjs',
    schedule: {
      kind: 'interval',
      startAt: '2026-08-01T00:00:00.000Z',
      everyMs: 3_600_000,
    },
    misfirePolicy: 'run-once',
    enabled: true,
    nextRunAt: '2026-08-01T02:00:00.000Z',
    createdAt: '2026-07-31T00:00:00.000Z',
    updatedAt: '2026-07-31T00:00:00.000Z',
  }],
  runs: [{
    id: 'run-1',
    jobId: 'job-1',
    trigger: 'scheduled',
    scheduledFor: '2026-08-01T00:00:00.000Z',
    startedAt: '2026-08-01T00:00:00.000Z',
    finishedAt: '2026-08-01T00:00:01.000Z',
    status: 'succeeded',
    reason: null,
    exitCode: 0,
    signal: null,
    stdout: 'done\n',
    stderr: '',
  }],
};

let panel: PanelDefinition;

beforeEach(async () => {
  document.body.innerHTML = '<div id="panel-root"></div>';
  panel = (await import('../panel.scheduler/src/index')).default as PanelDefinition;
});

afterEach(() => {
  panel.unmount();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Scheduler panel', () => {
  it('renders the admin summary, job table, and job controls', async () => {
    const request = vi.fn(async () => structuredClone(snapshot));

    await panel.mount({ message: { request } });

    expect(request).toHaveBeenCalledWith(
      '@itharbors/scheduler-service',
      'scheduler',
      'getSnapshot',
    );
    expect(document.querySelector('main[aria-label="脚本调度工作台"]')).not.toBeNull();
    expect(document.querySelector('.scheduler-breadcrumb')?.textContent).toContain('Scheduler');
    expect(document.querySelector('.summary-strip')).not.toBeNull();
    expect(document.querySelectorAll('.summary-strip .summary-stat')).toHaveLength(4);
    expect(document.querySelectorAll('[data-testid="metric-card"]')).toHaveLength(4);
    expect(metricValue('计划总数')).toBe('1');
    expect(metricValue('已启用')).toBe('1');
    expect(metricValue('正在运行')).toBe('0');
    expect(metricValue('失败记录')).toBe('0');
    expect(document.querySelector('#jobs-table')).toBeInstanceOf(HTMLTableElement);
    expect(document.querySelector('#jobs-table thead')?.textContent).toContain('下次执行');
    expect(document.querySelector('[data-job-id="job-1"]')?.textContent).toContain('每日汇总');
    expect(document.querySelector('[data-job-id="job-1"]')?.textContent).toContain('每 1 小时');
    expect(document.querySelector('[data-job-id="job-1"] .status-badge')?.textContent)
      .toBe('已启用');
    expect(document.querySelector('[data-run-id="run-1"]')?.textContent).toContain('成功');
    expect(document.querySelector('[data-run-id="run-1"]')?.textContent).toContain('done');
  });

  it('renders retained runs as a semantic history table with duration', async () => {
    const request = vi.fn(async () => structuredClone(snapshot));

    await panel.mount({ message: { request } });

    expect(document.querySelector('#history-table')).toBeInstanceOf(HTMLTableElement);
    expect(document.querySelector('#history-table thead')?.textContent).toContain('触发来源');
    expect(document.querySelector('[data-run-id="run-1"]')?.textContent).toContain('定时触发');
    expect(document.querySelector('[data-run-id="run-1"]')?.textContent).toContain('1 秒');
    expect(document.querySelector('[data-run-id="run-1"] details pre')?.textContent)
      .toContain('done');
  });

  it('surfaces a degraded scheduler when background persistence is retrying', async () => {
    const request = vi.fn(async () => ({
      ...structuredClone(snapshot),
      serviceError: 'state write failed',
    }));

    await panel.mount({ message: { request } });

    expect(document.querySelector('.service-status')?.textContent).toContain('调度服务降级');
    expect(document.querySelector('[role="alert"]')?.textContent)
      .toContain('state write failed');
  });

  it('creates a one-time job from labeled form controls', async () => {
    const request = vi.fn(async (
      _plugin: string,
      _route: string,
      method: string,
    ) => method === 'getSnapshot' ? structuredClone(snapshot) : undefined);
    await panel.mount({ message: { request } });
    click('[data-action="new-job"]');
    setInput('input[name="name"]', '夜间清理');
    setInput('input[name="scriptPath"]', '/Users/demo/jobs/cleanup.mjs');
    setInput('input[name="runAt"]', '2026-08-02T03:30');
    setSelect('select[name="misfirePolicy"]', 'skip');
    document.addEventListener('click', (event) => event.preventDefault(), {
      capture: true,
      once: true,
    });

    click('[data-action="save-job"]');
    await eventually(() => request.mock.calls.some((call) => call[2] === 'saveJob'));

    const call = request.mock.calls.find((item) => item[2] === 'saveJob')!;
    expect(call.slice(0, 3)).toEqual([
      '@itharbors/scheduler-service',
      'scheduler',
      'saveJob',
    ]);
    expect(call[3]).toMatchObject({
      name: '夜间清理',
      scriptPath: '/Users/demo/jobs/cleanup.mjs',
      misfirePolicy: 'skip',
      schedule: {
        kind: 'once',
        runAt: new Date('2026-08-02T03:30').toISOString(),
      },
    });
  });

  it('browses service-provided script directories and selects a supported file', async () => {
    const request = vi.fn(async (
      _plugin: string,
      _route: string,
      method: string,
      directory?: string,
    ) => {
      if (method === 'getSnapshot') return structuredClone(snapshot);
      if (method !== 'listScriptDirectory') return undefined;
      if (directory === '/Users/demo/jobs') {
        return {
          currentPath: '/Users/demo/jobs',
          parentPath: '/Users/demo',
          entries: [{
            name: 'cleanup.mjs',
            path: '/Users/demo/jobs/cleanup.mjs',
            kind: 'file',
          }],
        };
      }
      return {
        currentPath: '/Users/demo',
        parentPath: '/Users',
        entries: [{ name: 'jobs', path: '/Users/demo/jobs', kind: 'directory' }],
      };
    });
    await panel.mount({ message: { request } });
    click('[data-action="new-job"]');

    expect(document.querySelector('input[type="file"]')).toBeNull();
    click('[data-action="choose-script"]');
    await eventually(() => hasCall(request, 'listScriptDirectory'));
    expect(document.querySelector('[data-testid="script-browser"]')?.textContent)
      .toContain('/Users/demo');

    click('[data-script-entry-path="/Users/demo/jobs"]');
    await eventually(() => request.mock.calls.some(
      (call) => call[2] === 'listScriptDirectory' && call[3] === '/Users/demo/jobs',
    ));
    click('[data-script-entry-path="/Users/demo/jobs/cleanup.mjs"]');

    expect(document.querySelector<HTMLInputElement>('input[name="scriptPath"]')?.value)
      .toBe('/Users/demo/jobs/cleanup.mjs');
    expect(document.querySelector('[data-testid="script-browser"]')).toBeNull();
  });

  it('dispatches pause, manual run, and confirmed delete actions', async () => {
    const request = vi.fn(async (
      _plugin: string,
      _route: string,
      method: string,
    ) => method === 'getSnapshot' ? structuredClone(snapshot) : undefined);
    await panel.mount({ message: { request } });

    click('[data-job-id="job-1"] [data-action="toggle-job"]');
    await waitForAction(request, 'setJobEnabled', 2);
    click('[data-job-id="job-1"] [data-action="run-job"]');
    await waitForAction(request, 'runJobNow', 3);
    click('[data-job-id="job-1"] [data-action="delete-job"]');
    expect(document.querySelector('[data-action="confirm-delete"]')).not.toBeNull();
    click('[data-action="confirm-delete"]');
    await eventually(() => hasCall(request, 'deleteJob'));

    expect(request.mock.calls.find((call) => call[2] === 'setJobEnabled')?.slice(3)).toEqual([
      'job-1',
      false,
    ]);
    expect(request.mock.calls.find((call) => call[2] === 'runJobNow')?.[3]).toBe('job-1');
    expect(request.mock.calls.find((call) => call[2] === 'deleteJob')?.[3]).toBe('job-1');
  });

  it('shows actionable empty and unavailable states', async () => {
    const emptyRequest = vi.fn(async () => ({
      now: snapshot.now,
      activeJobIds: [],
      jobs: [],
      runs: [],
    }));
    await panel.mount({ message: { request: emptyRequest } });
    expect(document.querySelector('[data-state="empty"]')?.textContent).toContain('创建第一个计划');
    expect(document.querySelector('h1')?.textContent).toBe('定时脚本');
    expect(document.querySelector('.service-status')?.textContent).toContain('调度服务正常');
    expect(document.querySelector('.service-status')?.getAttribute('role')).toBe('status');
    expect(document.querySelector('#jobs-title')?.textContent).toBe('计划任务');
    expect(document.querySelector('.runtime-clock')).toBeNull();
    expect(document.querySelectorAll('[data-action="new-job"]')).toHaveLength(1);
    expect(document.querySelector('.scheduler-workbench')).toBeNull();

    click('[data-action="empty-new-job"]');
    expect(document.querySelector('.jobs-section')).not.toBeNull();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelector('#job-form-title')?.textContent).toBe('新建计划');
    panel.unmount();

    document.body.innerHTML = '<div id="panel-root"></div>';
    const failedRequest = vi.fn(async () => {
      throw new Error('Scheduler service is unavailable');
    });
    await panel.mount({ message: { request: failedRequest } });
    expect(document.querySelector('[data-state="unavailable"]')?.textContent)
      .toContain('调度服务暂时不可用');
    expect(document.querySelector('[data-action="retry"]')).not.toBeNull();
  });

  it('labels retained history without exposing a deleted job id', async () => {
    const deletedSnapshot = {
      ...structuredClone(snapshot),
      jobs: [],
    };
    const request = vi.fn(async () => deletedSnapshot);

    await panel.mount({ message: { request } });

    expect(document.querySelector('[data-run-id="run-1"]')?.textContent)
      .toContain('已删除计划');
    expect(document.querySelector('[data-run-id="run-1"]')?.textContent)
      .not.toContain('job-1');
  });

  it('polls without replacing an open form and clears the timer on unmount', async () => {
    vi.useFakeTimers();
    const request = vi.fn(async () => structuredClone(snapshot));
    await panel.mount({ message: { request } });
    click('[data-action="new-job"]');
    setInput('input[name="name"]', '保留中的输入');

    await vi.advanceTimersByTimeAsync(2_000);

    expect((document.querySelector('input[name="name"]') as HTMLInputElement).value)
      .toBe('保留中的输入');
    const callsBeforeUnmount = request.mock.calls.length;
    panel.unmount();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(request).toHaveBeenCalledTimes(callsBeforeUnmount);
  });

  it('updates service status without discarding an open form when polling fails', async () => {
    vi.useFakeTimers();
    let snapshotCalls = 0;
    const request = vi.fn(async () => {
      snapshotCalls += 1;
      if (snapshotCalls > 1) throw new Error('Scheduler service is unavailable');
      return structuredClone(snapshot);
    });
    await panel.mount({ message: { request } });
    click('[data-action="new-job"]');
    setInput('input[name="name"]', '不会丢失的输入');

    await vi.advanceTimersByTimeAsync(2_000);

    expect(document.querySelector('.service-status')?.textContent).toContain('调度服务连接中断');
    expect(document.querySelector('.service-status')?.classList.contains('is-error')).toBe(true);
    expect((document.querySelector('input[name="name"]') as HTMLInputElement).value)
      .toBe('不会丢失的输入');
  });

  it('opens the plan form as an accessible drawer dialog', async () => {
    const request = vi.fn(async () => structuredClone(snapshot));
    await panel.mount({ message: { request } });

    click('[data-action="new-job"]');

    const drawer = document.querySelector('[role="dialog"]');
    expect(drawer?.getAttribute('aria-modal')).toBe('true');
    expect(drawer?.getAttribute('aria-labelledby')).toBe('job-form-title');
    expect(document.querySelector('.drawer-backdrop')).not.toBeNull();
    expect(document.querySelector('[data-action="close-form"]')?.getAttribute('aria-label'))
      .toBe('关闭计划编辑器');
    expect(document.querySelector('#jobs-table')).not.toBeNull();
    expect(document.querySelector('.skip-link')?.getAttribute('href')).toBe('#jobs-table');
    expect(document.querySelector('#jobs-table')?.getAttribute('aria-labelledby')).toBe('jobs-title');
    expect(document.querySelector('#history-table')?.getAttribute('aria-labelledby')).toBe('history-title');
    expect(drawer?.querySelector('.drawer-header #job-form-title')).not.toBeNull();
    expect(drawer?.querySelector('.drawer-body input[name="name"]')).not.toBeNull();
    expect(drawer?.querySelector<HTMLInputElement>('input[name="name"]')?.autocomplete).toBe('off');
    expect(drawer?.querySelector('.form-actions')).not.toBeNull();
  });

  it('closes a pristine drawer with Escape and restores focus to its opener', async () => {
    const request = vi.fn(async () => structuredClone(snapshot));
    await panel.mount({ message: { request } });
    click('[data-action="new-job"]');

    pressDrawerKey('Escape');

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(document.querySelector('[data-action="new-job"]'));
  });

  it('keeps a dirty drawer open when discarding changes is declined', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const request = vi.fn(async () => structuredClone(snapshot));
    await panel.mount({ message: { request } });
    click('[data-action="new-job"]');
    setInput('input[name="name"]', '未保存的计划');

    pressDrawerKey('Escape');

    expect(confirm).toHaveBeenCalledWith('放弃未保存的更改？');
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('contains keyboard focus inside the open drawer', async () => {
    const request = vi.fn(async () => structuredClone(snapshot));
    await panel.mount({ message: { request } });
    click('[data-action="new-job"]');

    const close = document.querySelector<HTMLButtonElement>('[data-action="close-form"]')!;
    const save = document.querySelector<HTMLButtonElement>('[data-action="save-job"]')!;
    close.focus();
    close.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }));
    expect(document.activeElement).toBe(save);

    save.focus();
    save.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    }));
    expect(document.activeElement).toBe(close);
  });

  it('blocks a one-time plan that would immediately enter missed-trigger handling', async () => {
    const request = vi.fn(async (
      _plugin: string,
      _route: string,
      method: string,
    ) => method === 'getSnapshot' ? structuredClone(snapshot) : undefined);
    await panel.mount({ message: { request } });
    click('[data-action="new-job"]');
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-labelledby'))
      .toBe('job-form-title');
    expect(document.querySelector('#job-form-title')?.getAttribute('tabindex')).toBe('-1');
    setInput('input[name="name"]', '过期任务');
    setInput('input[name="scriptPath"]', '/Users/demo/jobs/expired.mjs');
    setInput('input[name="runAt"]', toLocalInputValue(snapshot.now));

    click('[data-action="save-job"]');

    expect(hasCall(request, 'saveJob')).toBe(false);
    const error = document.querySelector('[data-error-for="runAt"]');
    expect(error?.textContent).toContain('至少晚于当前服务时间 30 秒');
    expect(error?.getAttribute('role')).toBe('alert');
    expect(document.querySelector('input[name="runAt"]')?.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(document.querySelector('input[name="runAt"]'));
  });

  it('previews the next three interval occurrences from the original cadence', async () => {
    const request = vi.fn(async () => structuredClone(snapshot));
    await panel.mount({ message: { request } });
    click('[data-action="new-job"]');
    setSelect('select[name="scheduleKind"]', 'interval');
    setInput('input[name="startAt"]', toLocalInputValue('2026-08-01T00:30:00.000Z'));
    setInput('input[name="intervalValue"]', '1');
    setSelect('select[name="intervalUnit"]', 'hour');

    const times = [...document.querySelectorAll<HTMLTimeElement>('[data-testid="schedule-preview"] time')];
    expect(times.map((time) => time.dateTime)).toEqual([
      '2026-08-01T01:30:00.000Z',
      '2026-08-01T02:30:00.000Z',
      '2026-08-01T03:30:00.000Z',
    ]);
    expect(document.querySelector('[data-testid="schedule-preview"]')?.textContent)
      .toContain('仍沿原始起始时间推进');
  });

  it('shows a localized inline error when the selected script is unavailable', async () => {
    const request = vi.fn(async (
      _plugin: string,
      _route: string,
      method: string,
    ) => {
      if (method === 'getSnapshot') return structuredClone(snapshot);
      if (method === 'saveJob') {
        throw new Error('Node script does not exist: /Users/demo/jobs/missing.mjs');
      }
      return undefined;
    });
    await panel.mount({ message: { request } });
    click('[data-action="new-job"]');
    setInput('input[name="name"]', '缺失脚本');
    setInput('input[name="scriptPath"]', '/Users/demo/jobs/missing.mjs');
    setInput('input[name="runAt"]', toLocalInputValue('2026-08-01T02:00:00.000Z'));

    click('[data-action="save-job"]');
    await eventually(() => document.querySelector('[data-error-for="scriptPath"]') !== null);

    expect(document.querySelector('[data-error-for="scriptPath"]')?.textContent)
      .toContain('找不到这个脚本文件');
    expect((document.querySelector('input[name="name"]') as HTMLInputElement).value)
      .toBe('缺失脚本');
  });

  it('disables the editor and reports progress while a plan is saving', async () => {
    let finishSave: (() => void) | undefined;
    const pendingSave = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    const request = vi.fn(async (
      _plugin: string,
      _route: string,
      method: string,
    ) => method === 'getSnapshot' ? structuredClone(snapshot) : pendingSave);
    await panel.mount({ message: { request } });
    click('[data-action="new-job"]');
    setInput('input[name="name"]', '等待保存');
    setInput('input[name="scriptPath"]', '/Users/demo/jobs/waiting.mjs');
    setInput('input[name="runAt"]', toLocalInputValue('2026-08-01T02:00:00.000Z'));

    click('[data-action="save-job"]');
    await Promise.resolve();

    const save = document.querySelector<HTMLButtonElement>('[data-action="save-job"]');
    expect(save?.disabled).toBe(true);
    expect(save?.textContent).toBe('正在保存…');
    expect(document.querySelector('form')?.getAttribute('aria-busy')).toBe('true');
    finishSave?.();
    await eventually(() => hasCall(request, 'saveJob'));
  });
});

function click(selector: string) {
  const element = document.querySelector<HTMLButtonElement>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  element.click();
}

function setInput(selector: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(selector);
  if (!input) throw new Error(`Missing ${selector}`);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function setSelect(selector: string, value: string) {
  const select = document.querySelector<HTMLSelectElement>(selector);
  if (!select) throw new Error(`Missing ${selector}`);
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function pressDrawerKey(key: string) {
  const drawer = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!drawer) throw new Error('Missing drawer');
  drawer.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

function toLocalInputValue(value: string) {
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function hasCall(request: ReturnType<typeof vi.fn>, method: string) {
  return request.mock.calls.some((call) => call[2] === method);
}

function metricValue(label: string) {
  const card = [...document.querySelectorAll<HTMLElement>('[data-testid="metric-card"]')]
    .find((item) => item.querySelector('.metric-label')?.textContent === label);
  if (!card) throw new Error(`Missing metric ${label}`);
  return card.querySelector('.metric-value')?.textContent;
}

async function waitForAction(
  request: ReturnType<typeof vi.fn>,
  method: string,
  expectedSnapshotCalls: number,
) {
  await eventually(() =>
    hasCall(request, method)
    && request.mock.calls.filter((call) => call[2] === 'getSnapshot').length >= expectedSnapshotCalls,
  );
  await Promise.resolve();
}

async function eventually(predicate: () => boolean) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Condition was not met');
}
