type SettingsRequestName = 'getSettings' | 'saveSettings' | 'resetSettings';
type PanelContext = { message?: { request(plugin: string, name: string, ...args: unknown[]): Promise<unknown> } };
type MessageRequest = (plugin: string, name: string, ...args: unknown[]) => Promise<unknown>;
type Settings = {
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access';
  approvalPolicy: 'ask' | 'always';
  global: { sandboxMode: boolean; approvalPolicy: boolean };
};

type PendingRequest = { reject: (error: Error) => void };

const pending = new Set<PendingRequest>();
let activeRequest: MessageRequest | null = null;
let activeDocument: Document | null = null;
let removeFormListeners: (() => void) | null = null;

function errorFrom(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === 'string') return new Error(value);
  if (value && typeof value === 'object' && typeof (value as { message?: unknown }).message === 'string') {
    return new Error((value as { message: string }).message);
  }
  return new Error('设置请求失败');
}

export function requestSettings(name: SettingsRequestName, ...args: unknown[]): Promise<unknown> {
  if (!activeRequest) return Promise.reject(new Error('设置页面不可用'));
  return new Promise((resolve, reject) => {
    const entry = { reject };
    pending.add(entry);
    Promise.resolve()
      .then(() => activeRequest?.('agent', name, ...args))
      .then(resolve, reject)
      .finally(() => pending.delete(entry));
  });
}

function setStatus(message: string, kind: 'success' | 'error' | 'loading' = 'loading'): void {
  const status = activeDocument?.getElementById('status');
  if (!status) return;
  status.textContent = message;
  status.dataset.kind = kind;
}

function hasTagName(value: Element | null, tagName: string): boolean {
  return Boolean(value && typeof value.tagName === 'string' && value.tagName.toLowerCase() === tagName);
}

function controls(): { sandboxMode: HTMLSelectElement; approvalPolicy: HTMLSelectElement; save: HTMLButtonElement; reset: HTMLButtonElement } | null {
  const sandboxMode = activeDocument?.getElementById('sandbox-mode');
  const approvalPolicy = activeDocument?.getElementById('approval-policy');
  const save = activeDocument?.getElementById('save-button');
  const reset = activeDocument?.getElementById('reset-button');
  if (!hasTagName(sandboxMode, 'select') || !hasTagName(approvalPolicy, 'select') || !hasTagName(save, 'button') || !hasTagName(reset, 'button')) return null;
  return {
    sandboxMode: sandboxMode as HTMLSelectElement,
    approvalPolicy: approvalPolicy as HTMLSelectElement,
    save: save as HTMLButtonElement,
    reset: reset as HTMLButtonElement,
  };
}

function applySettings(settings: Settings): void {
  const elements = controls();
  if (!elements) return;
  elements.sandboxMode.value = settings.sandboxMode;
  elements.approvalPolicy.value = settings.approvalPolicy;
}

async function loadSettings(): Promise<void> {
  setStatus('正在读取设置…');
  try {
    applySettings(await requestSettings('getSettings') as Settings);
    setStatus('设置已加载', 'success');
  } catch (error) {
    if (activeDocument) setStatus(errorFrom(error).message, 'error');
  }
}

function bindForm(): void {
  const elements = controls();
  const form = activeDocument?.getElementById('settings-form');
  if (!elements || !hasTagName(form, 'form')) return;

  const saveForm = async () => {
    elements.save.disabled = true;
    elements.reset.disabled = true;
    setStatus('正在保存设置…');
    try {
      const settings = await requestSettings('saveSettings', {
        sandboxMode: elements.sandboxMode.value,
        approvalPolicy: elements.approvalPolicy.value,
      }) as Settings;
      applySettings(settings);
      setStatus('设置已保存，仅影响新对话；当前对话不变。', 'success');
    } catch (error) {
      if (activeDocument) setStatus(errorFrom(error).message, 'error');
    } finally {
      elements.save.disabled = false;
      elements.reset.disabled = false;
    }
  };
  const onSubmit = (event: SubmitEvent) => {
    event.preventDefault();
    void saveForm();
  };
  const onSaveClick = (event: MouseEvent) => {
    // Some Web hosts expose the panel button without dispatching native form submit.
    // Prevent the default submit here and keep Enter-to-submit on the form below.
    event.preventDefault();
    void saveForm();
  };
  const onReset = async () => {
    elements.save.disabled = true;
    elements.reset.disabled = true;
    setStatus('正在恢复默认…');
    try {
      const settings = await requestSettings('resetSettings') as Settings;
      applySettings(settings);
      setStatus('已恢复默认设置，仅影响新对话；当前对话不变。', 'success');
    } catch (error) {
      if (activeDocument) setStatus(errorFrom(error).message, 'error');
    } finally {
      elements.save.disabled = false;
      elements.reset.disabled = false;
    }
  };
  form.addEventListener('submit', onSubmit);
  elements.save.addEventListener('click', onSaveClick);
  elements.reset.addEventListener('click', onReset);
  removeFormListeners = () => {
    form.removeEventListener('submit', onSubmit);
    elements.save.removeEventListener('click', onSaveClick);
    elements.reset.removeEventListener('click', onReset);
  };
}

function unmount(): void {
  removeFormListeners?.();
  removeFormListeners = null;
  const error = new Error('设置页面已卸载');
  for (const entry of pending) entry.reject(error);
  pending.clear();
  activeRequest = null;
  activeDocument = null;
}

const definition = {
  mount(ctx: PanelContext) {
    unmount();
    if (typeof window === 'undefined' || typeof document === 'undefined' || typeof ctx?.message?.request !== 'function') return;
    activeRequest = ctx.message.request;
    activeDocument = document;
    bindForm();
    void loadSettings();
  },
  unmount,
};

export default definition;
