type SettingsRequestName = 'getSettings' | 'saveSettings' | 'resetSettings';
type Settings = {
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access';
  approvalPolicy: 'ask' | 'always';
  global: { sandboxMode: boolean; approvalPolicy: boolean };
};

type SettingsPageResponse = {
  type: 'settings-page-response';
  requestId: string;
  ok?: boolean;
  result?: unknown;
  error?: unknown;
};

type PendingRequest = { resolve: (value: unknown) => void; reject: (error: Error) => void };

const pending = new Map<string, PendingRequest>();
let requestSequence = 0;
let activeWindow: Window | null = null;
let activeDocument: Document | null = null;
let removeMessageListener: (() => void) | null = null;
let removeFormListeners: (() => void) | null = null;

function errorFrom(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === 'string') return new Error(value);
  if (value && typeof value === 'object' && typeof (value as { message?: unknown }).message === 'string') {
    return new Error((value as { message: string }).message);
  }
  return new Error('设置请求失败');
}

function handleResponse(event: MessageEvent<SettingsPageResponse>): void {
  if (!activeWindow || (event.source && event.source !== activeWindow.parent)) return;
  const response = event.data;
  if (!response || response.type !== 'settings-page-response' || typeof response.requestId !== 'string') return;
  const entry = pending.get(response.requestId);
  if (!entry) return;
  pending.delete(response.requestId);
  if (response.ok === false || response.error !== undefined) entry.reject(errorFrom(response.error));
  else entry.resolve(response.result);
}

export function requestSettings(name: SettingsRequestName, ...args: unknown[]): Promise<unknown> {
  if (!activeWindow?.parent) return Promise.reject(new Error('设置页面不可用'));
  const requestId = `agent-settings-${Date.now()}-${requestSequence++}`;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    window.parent.postMessage({ type: 'settings-page-request', requestId, name, args }, '*');
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
    if (activeWindow) setStatus(errorFrom(error).message, 'error');
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
      if (activeWindow) setStatus(errorFrom(error).message, 'error');
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
      if (activeWindow) setStatus(errorFrom(error).message, 'error');
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
  removeMessageListener?.();
  removeMessageListener = null;
  removeFormListeners?.();
  removeFormListeners = null;
  const error = new Error('设置页面已卸载');
  for (const entry of pending.values()) entry.reject(error);
  pending.clear();
  activeWindow = null;
  activeDocument = null;
}

const definition = {
  mount() {
    unmount();
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    activeWindow = window;
    activeDocument = document;
    const onMessage = (event: MessageEvent<SettingsPageResponse>) => handleResponse(event);
    activeWindow.addEventListener('message', onMessage);
    removeMessageListener = () => activeWindow?.removeEventListener('message', onMessage);
    bindForm();
    void loadSettings();
  },
  unmount,
};

export default definition;
