import type { KitMenuRoot, MenuTreeNode } from '../core/session';
import { getDeviceId } from '../core/storage';

interface MenuOpenPanelResult {
  disposition: 'reuse' | 'open-window-group';
  panelInstanceId: string;
  panelName: string;
  windowGroupId: string | null;
  carrier: 'window-group' | 'floating';
  url: string | null;
}

export interface MenuRuntimeInput {
  sessionId: string;
  menuMode?: 'single' | 'multi';
  menuTree: MenuTreeNode[];
  applicationMenuTree?: MenuTreeNode[];
  kitMenuTree?: MenuTreeNode[];
  kitMenuRoot?: KitMenuRoot | null;
}

export interface MenuRuntime {
  attach(container: HTMLElement): void;
  update(input: MenuRuntimeInput): void;
  dispose(): void;
}

/** Web menu uses only Session menu actions; Application Runtime is read-only. */
export function mountMenuRuntime(initialInput: MenuRuntimeInput): MenuRuntime {
  let input = initialInput;
  let inputGeneration = 0;
  let disposed = false;
  let applicationTree: MenuTreeNode[] = [];
  let applicationRevision = 0;
  const root = document.createElement('div');
  root.className = 'web-menu-root';
  const shadow = root.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>
    :host { display:block; height:32px; flex:none; color:var(--ce-text-primary,#edf1f7); background:var(--ce-surface-raised,#1b222c); border-bottom:1px solid var(--ce-border,#2a3440); font:13px/1.4 system-ui,sans-serif; }
    * { box-sizing:border-box; }
    .bar { display:flex; align-items:center; height:31px; gap:2px; overflow-x:auto; overflow-y:hidden; padding:0 8px; scrollbar-width:thin; }
    button { font:inherit; color:inherit; border:0; background:transparent; cursor:pointer; }
    .top { flex:none; height:28px; padding:0 10px; border-radius:5px; white-space:nowrap; }
    .top:hover, .top[aria-expanded="true"], .item:hover:not(:disabled) { background:var(--ce-surface-hover,#26303d); }
    button:focus-visible { outline:2px solid var(--ce-focus-ring,#3b82f6); outline-offset:-2px; }
    .popup { position:fixed; z-index:100000; min-width:220px; max-width:calc(100vw - 16px); max-height:min(70vh,600px); overflow:auto; padding:5px; border:1px solid var(--ce-border-strong,#475568); border-radius:8px; background:var(--ce-surface-raised,#1b222c); box-shadow:0 8px 24px #0008; }
    [hidden] { display:none !important; }
    .item { display:flex; width:100%; min-height:30px; align-items:center; justify-content:space-between; gap:16px; padding:6px 9px; border-radius:5px; text-align:left; }
    .item:disabled { color:var(--ce-text-muted,#94a3b8); opacity:.65; cursor:not-allowed; }
    .sub { margin-left:12px; border-left:1px solid var(--ce-border,#2a3440); padding-left:4px; }
    .separator { height:1px; margin:4px 6px; background:var(--ce-border,#2a3440); }
    .hint { padding:6px 9px; font-size:11px; color:var(--ce-text-muted,#94a3b8); }
    .error { position:fixed; z-index:100001; top:36px; right:8px; max-width:min(420px,calc(100vw - 16px)); padding:8px 12px; border-radius:6px; background:#542d35; color:#fff; }
  </style><div class="bar" role="menubar" aria-label="工作台菜单"></div><div class="error" role="status" hidden></div>`;
  const bar = shadow.querySelector<HTMLElement>('.bar')!;
  const error = shadow.querySelector<HTMLElement>('.error')!;
  let openPopup: HTMLElement | null = null;
  let openTop: HTMLButtonElement | null = null;

  const closeMenu = (restoreFocus = false) => {
    if (openPopup) openPopup.hidden = true;
    if (openTop) {
      openTop.setAttribute('aria-expanded', 'false');
      if (restoreFocus) openTop.focus();
    }
    openPopup = null;
    openTop = null;
  };
  const outside = (event: Event) => { if (!event.composedPath().includes(root)) closeMenu(); };
  const windowBlur = () => closeMenu();
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('focusin', outside, true);
  window.addEventListener('blur', windowBlur);

  const kitActionIds = () => {
    const ids = new Set<string>();
    const visit = (nodes: MenuTreeNode[]) => nodes.forEach((node) => {
      if (node.type !== 'menu') return;
      if (!node.children.length && !node.role) ids.add(node.id);
      visit(node.children);
    });
    visit(input.kitMenuTree ?? []);
    return ids;
  };

  const trigger = async (id: string) => {
    const sessionId = input.sessionId;
    const generation = inputGeneration;
    closeMenu(true);
    error.hidden = true;
    try {
      const response = await fetch('/api/menu/trigger', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, menuId: id, presentation: 'local' }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(typeof payload?.message === 'string' ? payload.message : '菜单操作失败');
      if (disposed || inputGeneration !== generation) return;
      if (isLocalPanelResult(payload?.result)) {
        const accepted = root.dispatchEvent(new CustomEvent('ce-local-panel-open', { bubbles: true, composed: true, cancelable: true, detail: { panelName: payload.result.panelName } }));
        if (!accepted) throw new Error('面板不可用或未注册');
      } else if (isMenuOpenPanelResult(payload?.result)) await handleMenuOpenPanelResult(sessionId, payload.result);
      else if (isMenuOpenCurrentUrlResult(payload?.result)) handleMenuOpenCurrentUrl();
    } catch (cause) {
      if (disposed || inputGeneration !== generation) return;
      error.textContent = cause instanceof Error ? cause.message : '菜单操作失败';
      error.hidden = false;
    }
  };

  const navigateTop = (button: HTMLButtonElement, event: KeyboardEvent) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const roots = Array.from(bar.querySelectorAll<HTMLButtonElement>('.top:not(:disabled)'));
      const index = roots.indexOf(button);
      const next = roots[(index + (event.key === 'ArrowRight' ? 1 : -1) + roots.length) % roots.length];
      const wasOpen = openTop !== null;
      if (wasOpen) { closeMenu(); if (next?.hasAttribute('aria-haspopup')) next.click(); }
      next?.focus();
    }
    if (event.key === 'Escape') { event.preventDefault(); closeMenu(true); }
  };

  const items = (nodes: MenuTreeNode[], parent: HTMLElement, actionable: Set<string>, readOnly: boolean) => {
    for (const node of nodes) {
      if (node.type === 'separator') {
        const separator = document.createElement('div'); separator.className = 'separator'; separator.setAttribute('role', 'separator'); parent.append(separator); continue;
      }
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'item'; button.setAttribute('role', 'menuitem');
      const label = document.createElement('span'); label.textContent = node.label; button.append(label);
      if (node.children.length) {
        button.setAttribute('aria-haspopup', 'menu'); button.setAttribute('aria-expanded', 'false');
        const arrow = document.createElement('span'); arrow.textContent = '›'; arrow.setAttribute('aria-hidden', 'true'); button.append(arrow);
        const child = document.createElement('div'); child.className = 'sub'; child.setAttribute('role', 'menu'); child.hidden = true;
        const toggle = () => { child.hidden = !child.hidden; button.setAttribute('aria-expanded', String(!child.hidden)); };
        button.addEventListener('click', toggle);
        button.addEventListener('keydown', (event) => {
          if (event.key === 'ArrowRight') { event.preventDefault(); if (child.hidden) toggle(); firstEnabled(child)?.focus(); }
          if (event.key === 'ArrowLeft' && !child.hidden) { event.preventDefault(); toggle(); button.focus(); }
        });
        parent.append(button, child);
        items(node.children, child, actionable, readOnly);
      } else {
        const enabled = !readOnly && !node.role && actionable.has(node.id);
        button.disabled = !enabled;
        if (!enabled) button.title = readOnly ? '应用菜单在 Web 中仅供查看' : '此操作在 Web 中不可用';
        if (enabled) button.addEventListener('click', () => { void trigger(node.id); });
        parent.append(button);
      }
    }
  };

  const addRoot = (label: string, nodes: MenuTreeNode[], actionable: Set<string>, readOnly: boolean, focusKey: string) => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'top'; button.textContent = label;
    button.dataset.focusKey = focusKey;
    button.setAttribute('role', 'menuitem'); button.setAttribute('aria-haspopup', 'menu'); button.setAttribute('aria-expanded', 'false');
    const popup = document.createElement('div'); popup.className = 'popup'; popup.setAttribute('role', 'menu'); popup.hidden = true;
    if (readOnly) {
      const hint = document.createElement('div'); hint.className = 'hint'; hint.textContent = '应用菜单仅供查看，Web 暂不支持触发'; popup.append(hint);
    }
    items(nodes, popup, actionable, readOnly);
    const show = () => {
      if (openTop === button) { closeMenu(); return; }
      closeMenu(); openTop = button; openPopup = popup;
      const rect = button.getBoundingClientRect();
      popup.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 236))}px`;
      popup.style.top = `${rect.bottom}px`;
      popup.hidden = false; button.setAttribute('aria-expanded', 'true');
    };
    button.addEventListener('click', show);
    button.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); if (openTop !== button) show();
        const candidates = visibleEnabled(popup);
        (event.key === 'ArrowUp' ? candidates.at(-1) : candidates[0])?.focus();
      }
      navigateTop(button, event);
    });
    popup.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(true); return; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const candidates = visibleEnabled(popup);
        const index = candidates.indexOf(shadow.activeElement as HTMLButtonElement);
        const next = event.key === 'ArrowDown' ? (index + 1) % candidates.length : (index - 1 + candidates.length) % candidates.length;
        candidates[next]?.focus();
      }
      if (event.key === 'ArrowLeft') {
        const current = shadow.activeElement as HTMLElement | null;
        const sub = current?.closest<HTMLElement>('.sub');
        if (sub) { event.preventDefault(); sub.hidden = true; const owner = sub.previousElementSibling as HTMLButtonElement | null; owner?.setAttribute('aria-expanded', 'false'); owner?.focus(); }
      }
    });
    bar.append(button); shadow.append(popup);
  };

  const draw = () => {
    const hadFocus = shadow.activeElement !== null;
    const focusedKey = openTop?.dataset.focusKey ?? (shadow.activeElement as HTMLElement | null)?.dataset.focusKey;
    closeMenu();
    bar.replaceChildren();
    shadow.querySelectorAll('.popup').forEach((node) => node.remove());
    const actions = kitActionIds();
    for (const node of input.kitMenuTree ?? []) {
      if (node.type !== 'menu') continue;
      if (node.children.length) addRoot(node.label, node.children, actions, false, `session:${node.id}`);
      else {
        const direct = document.createElement('button');
        direct.type = 'button'; direct.className = 'top'; direct.textContent = node.label; direct.setAttribute('role', 'menuitem');
        direct.dataset.focusKey = `session:${node.id}`;
        direct.disabled = Boolean(node.role) || !actions.has(node.id);
        if (direct.disabled) direct.title = '此操作在 Web 中不可用';
        else direct.addEventListener('click', () => { void trigger(node.id); });
        direct.addEventListener('keydown', (event) => navigateTop(direct, event));
        bar.append(direct);
      }
    }
    if (applicationTree.some((node) => node.type === 'menu')) {
      addRoot('应用菜单', applicationTree, new Set(), true, 'application:root');
    }
    if (hadFocus) {
      const candidates = Array.from(bar.querySelectorAll<HTMLButtonElement>('.top:not(:disabled)'));
      (candidates.find((candidate) => candidate.dataset.focusKey === focusedKey) ?? candidates[0])?.focus();
    }
  };
  const acceptApplication = (value: unknown) => {
    if (!value || typeof value !== 'object') return false;
    const menu = (value as { menu?: unknown }).menu;
    if (!menu || typeof menu !== 'object' || !Array.isArray((menu as { tree?: unknown }).tree)) return false;
    applicationTree = (menu as { tree: MenuTreeNode[] }).tree;
    return true;
  };
  const initialRevision = applicationRevision;
  void fetch('/api/application/bootstrap').then(async (response) => {
    if (!response.ok) throw new Error('application bootstrap unavailable');
    const value: unknown = await response.json();
    if (disposed || initialRevision !== applicationRevision) return;
    acceptApplication(value);
    draw();
  }).catch(() => { /* No application menu is shown when it cannot be read. */ });
  let applicationEvents: EventSource | null = null;
  try {
    applicationEvents = new EventSource(`/sse/application?deviceId=${encodeURIComponent(getDeviceId())}`);
    applicationEvents.onmessage = (event) => {
      try {
        const value: unknown = JSON.parse(event.data);
        if (!value || typeof value !== 'object' || (value as { type?: unknown }).type !== 'application-bootstrap') return;
        if (!acceptApplication((value as { bootstrap?: unknown }).bootstrap)) return;
        applicationRevision += 1; if (!disposed) draw();
      } catch { /* Ignore malformed events; retain last valid snapshot. */ }
    };
  } catch { /* Bootstrap remains available when SSE is unsupported. */ }
  draw();
  return {
    attach(container) { if (!disposed && root.parentElement !== container) container.append(root); },
    update(next) { if (!disposed) { inputGeneration += 1; input = next; draw(); } },
    dispose() { inputGeneration += 1; disposed = true; applicationEvents?.close(); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('focusin', outside, true); window.removeEventListener('blur', windowBlur); root.remove(); },
  };
}

function visibleEnabled(root: HTMLElement): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
    .filter((button) => !button.closest('[hidden]'));
}
function firstEnabled(root: HTMLElement): HTMLButtonElement | undefined { return visibleEnabled(root)[0]; }

export function getMenuModeFromURL(): 'single' | 'multi' {
  return new URLSearchParams(window.location.search).get('menuMode') === 'multi' ? 'multi' : 'single';
}

async function handleMenuOpenPanelResult(sessionId: string, payload: MenuOpenPanelResult): Promise<void> {
  if (payload.disposition === 'reuse' || !payload.url) { notifyEditorApp({ type: 'ce-open-panel-result', payload }); return; }
  const popup = window.open(payload.url, `_ce_${payload.windowGroupId}`);
  if (popup) { notifyEditorApp({ type: 'ce-open-panel-result', payload }); return; }
  const response = await fetch('/api/panel-instance/fallback', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, panelInstanceId: payload.panelInstanceId }),
  });
  const fallback = await response.json();
  if (!response.ok) throw new Error(fallback?.error || 'Failed to fallback panel');
  notifyEditorApp({ type: 'ce-open-panel-floating', payload: fallback });
}
function handleMenuOpenCurrentUrl(): void { window.open(window.location.href, '_blank', 'noopener,noreferrer'); }
function notifyEditorApp(message: { type: string; payload: unknown }): void { window.postMessage(message, '*'); }
function isMenuOpenPanelResult(value: unknown): value is MenuOpenPanelResult {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (candidate.disposition === 'reuse' || candidate.disposition === 'open-window-group')
    && typeof candidate.panelInstanceId === 'string' && typeof candidate.panelName === 'string'
    && (typeof candidate.windowGroupId === 'string' || candidate.windowGroupId === null)
    && (candidate.carrier === 'window-group' || candidate.carrier === 'floating')
    && (typeof candidate.url === 'string' || candidate.url === null);
}
function isLocalPanelResult(value: unknown): value is { type: 'local-panel'; panelName: string } {
  return Boolean(value) && typeof value === 'object' && (value as Record<string, unknown>).type === 'local-panel'
    && typeof (value as Record<string, unknown>).panelName === 'string';
}
function isMenuOpenCurrentUrlResult(value: unknown): boolean {
  return Boolean(value) && typeof value === 'object' && (value as Record<string, unknown>).type === 'open-current-url';
}
