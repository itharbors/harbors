import type {
  PublicKitCatalogEntry,
  PublicSessionSummary,
  WorkbenchContext,
} from '@itharbors/plugin-types';
import '../styles/kit-picker.css';

interface PendingDevice {
  deviceId: string;
  ip: string;
  userAgent: string;
  requestedAt: number;
  displayName: string;
  requestedUserId?: string;
}

interface AuthorizedDevice {
  deviceId: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  user?: { userId: string; displayName: string };
}

export interface KitPickerOptions {
  context: WorkbenchContext;
  selectedSessionId: string | null;
  onSessionSelected(sessionId: string): void;
  onSessionCleared(): void;
  onContextChanged(resumeState?: KitPickerResumeState): void;
  resumeState?: KitPickerResumeState;
  navigate?(href: string): void;
}

export interface KitPickerResumeState {
  step: 'user' | 'session' | 'kit';
  selectedUserId: string | null;
  selectedSessionId: string | null;
  createNewSession?: boolean;
  feedback?: WorkbenchFeedback;
}

export interface WorkbenchFeedback {
  kind: 'success' | 'error';
  message: string;
}

export function renderKitPicker(
  host: HTMLElement,
  kits: PublicKitCatalogEntry[],
  options: KitPickerOptions,
): void {
  host.replaceChildren(createPickerShell(kits, options));
  if (options.resumeState) host.querySelector<HTMLElement>('#kit-picker-title')?.focus();
}

export function renderKitPickerLoading(host: HTMLElement): void {
  const status = element('div', 'kit-host-state');
  const spinner = element('span', 'kit-host-spinner', '');
  spinner.setAttribute('aria-hidden', 'true');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.append(
    spinner,
    element('strong', '', '正在读取 Kit…'),
    element('span', '', '正在同步当前主机上的工作台列表。'),
  );
  host.replaceChildren(status);
}

export function renderKitPickerError(host: HTMLElement, retry: () => void): void {
  const alert = element('div', 'kit-host-state kit-host-error');
  const errorMark = element('span', 'kit-host-error-mark', '!');
  errorMark.setAttribute('aria-hidden', 'true');
  alert.setAttribute('role', 'alert');
  alert.append(
    errorMark,
    element('strong', '', '无法打开工作台入口'),
    element('span', '', '确认服务仍在运行，然后重新加载。'),
  );
  const button = element('button', 'kit-retry', '重新加载');
  button.setAttribute('type', 'button');
  button.addEventListener('click', retry);
  alert.append(button);
  host.replaceChildren(alert);
}

function createPickerShell(kits: PublicKitCatalogEntry[], options: KitPickerOptions): HTMLElement {
  const shell = element('div', 'kit-picker-shell');

  const tabs = element('nav', 'kit-tabs');
  tabs.setAttribute('role', 'tablist');

  const workbenchTab = element('button', 'kit-tab kit-tab-active', '工作台');
  workbenchTab.setAttribute('role', 'tab');
  workbenchTab.setAttribute('aria-selected', 'true');
  const authTab = element('button', 'kit-tab', '授权管理');
  authTab.setAttribute('role', 'tab');
  authTab.setAttribute('aria-selected', 'false');

  tabs.append(workbenchTab);
  if (options.context.actor === 'local-admin') tabs.append(authTab);

  const workbenchPanel = element('div', 'kit-tab-panel');
  workbenchPanel.setAttribute('role', 'tabpanel');
  workbenchPanel.append(createWorkbenchView(kits, options));

  const authPanel = element('div', 'kit-tab-panel');
  authPanel.setAttribute('role', 'tabpanel');
  authPanel.style.display = 'none';
  authPanel.append(createAuthView());

  workbenchTab.addEventListener('click', () => {
    workbenchTab.classList.add('kit-tab-active');
    authTab.classList.remove('kit-tab-active');
    workbenchTab.setAttribute('aria-selected', 'true');
    authTab.setAttribute('aria-selected', 'false');
    workbenchPanel.style.display = '';
    authPanel.style.display = 'none';
  });

  authTab.addEventListener('click', () => {
    authTab.classList.add('kit-tab-active');
    workbenchTab.classList.remove('kit-tab-active');
    authTab.setAttribute('aria-selected', 'true');
    workbenchTab.setAttribute('aria-selected', 'false');
    authPanel.style.display = '';
    workbenchPanel.style.display = 'none';
    void refreshAuthView(authPanel);
  });

  shell.append(tabs, workbenchPanel, authPanel);
  return shell;
}

function createWorkbenchView(kits: PublicKitCatalogEntry[], options: KitPickerOptions): HTMLElement {
  const main = element('main', 'kit-picker-body');
  main.setAttribute('aria-labelledby', 'kit-picker-title');
  const masthead = createMasthead();
  const stage = element('div', 'kit-flow-stage');
  const feedbackRegion = element('div', 'kit-feedback-region');
  feedbackRegion.setAttribute('aria-label', '操作反馈');
  const live = element('p', 'kit-flow-live');
  live.setAttribute('aria-live', 'polite');
  const footer = element('footer', 'kit-picker-footer');
  footer.append(element('span', '', '同一端口 · 独立 Session'), element('span', '', 'ITHARBORS WORKBENCH'));
  main.append(masthead, stage, feedbackRegion, live, footer);

  const restored = options.selectedSessionId
    ? options.context.sessions.find((session) => session.sessionId === options.selectedSessionId)
    : undefined;
  const remoteUserId = options.context.actor === 'user' ? options.context.currentUser?.userId ?? null : null;
  const resume = options.resumeState;
  let sessionSummaries = [...options.context.sessions];
  const state: KitPickerResumeState = resume
    ? normalizeResumeState(resume, options.context)
    : restored
      ? { step: 'kit', selectedUserId: restored.ownerUserId, selectedSessionId: restored.sessionId }
      : { step: remoteUserId ? 'session' : 'user', selectedUserId: remoteUserId, selectedSessionId: null };
  let creationLocked = false;
  let returnFocusId: string | null = null;
  let allowDefaultSession = options.resumeState?.createNewSession !== true;
  let activeFeedback: HTMLElement | null = null;
  let dismissTimer: number | undefined;
  let removalTimer: number | undefined;

  const removeFeedback = (feedback: HTMLElement) => {
    if (activeFeedback !== feedback) return;
    feedback.remove();
    activeFeedback = null;
    dismissTimer = undefined;
    removalTimer = undefined;
  };

  const showFeedback = (feedback: WorkbenchFeedback) => {
    if (dismissTimer !== undefined) window.clearTimeout(dismissTimer);
    if (removalTimer !== undefined) window.clearTimeout(removalTimer);
    activeFeedback?.remove();

    const tip = element('div', `kit-feedback-tip kit-feedback-${feedback.kind}`);
    tip.setAttribute('role', feedback.kind === 'success' ? 'status' : 'alert');
    tip.setAttribute('aria-live', feedback.kind === 'success' ? 'polite' : 'assertive');
    tip.setAttribute('aria-atomic', 'true');
    const mark = element('span', 'kit-feedback-mark', feedback.kind === 'success' ? '✓' : '!');
    mark.setAttribute('aria-hidden', 'true');
    tip.append(mark, element('span', 'kit-feedback-message', feedback.message));
    feedbackRegion.replaceChildren(tip);
    activeFeedback = tip;

    const visibleDuration = feedback.kind === 'success' ? 4_000 : 8_000;
    dismissTimer = window.setTimeout(() => {
      if (activeFeedback !== tip) return;
      if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        removeFeedback(tip);
        return;
      }
      tip.classList.add('kit-feedback-leaving');
      removalTimer = window.setTimeout(() => removeFeedback(tip), 200);
    }, visibleDuration);
  };

  const finishOperationAnnouncement = (progressMessage: string) => {
    if (live.textContent === progressMessage) live.textContent = '';
  };

  const renderStep = (focusTitle = false) => {
    stage.replaceChildren();
    stage.className = `kit-flow-stage kit-flow-step-${state.step}`;
    if (options.context.actor === 'user' && !options.context.currentUser) {
      stage.append(createIdentityUnavailable(() => window.location.reload()));
      return;
    }
    if (state.step === 'user') stage.append(createUserStep());
    if (state.step === 'session') stage.append(createSessionStep());
    if (state.step === 'kit') stage.append(createKitStep());
    if (focusTitle) stage.querySelector<HTMLElement>('#kit-picker-title')?.focus();
  };

  const moveTo = (step: KitPickerResumeState['step'], focusTitle = true) => {
    state.step = step;
    live.textContent = step === 'user' ? '请选择使用者' : step === 'session' ? '请选择 Session' : '请选择工作台';
    renderStep(focusTitle);
  };

  const createUserStep = (): HTMLElement => {
    const section = createStepSection('使用者', '选择使用者', '选择你的头像，继续进入工作台。');
    const grid = element('div', 'kit-user-grid');
    for (const user of options.context.users) {
      const group = element('div', 'kit-user-choice');
      const card = createUserCard(createAvatar(user.userId, user.displayName), user.displayName);
      card.dataset.userId = user.userId;
      card.id = `kit-user-${safeDomId(user.userId)}`;
      const chooseUser = () => {
        state.selectedUserId = user.userId;
        state.selectedSessionId = null;
        allowDefaultSession = true;
        returnFocusId = card.id;
        options.onSessionCleared();
        moveTo('session');
      };
      card.addEventListener('click', (event) => {
        if (event.target instanceof HTMLInputElement) return;
        chooseUser();
      });
      card.addEventListener('keydown', (event) => {
        if (event.target !== card || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        chooseUser();
      });
      const actions = element('div', 'kit-user-actions');
      actions.setAttribute('role', 'group');
      actions.setAttribute('aria-label', `${user.displayName}的用户操作`);
      const rename = element('button', 'kit-user-action kit-user-rename', '改');
      rename.type = 'button';
      rename.title = `重命名 ${user.displayName}`;
      rename.setAttribute('aria-label', `重命名 ${user.displayName}`);
      rename.addEventListener('click', () => showUserEditor(card, user, rename));
      const remove = element('button', 'kit-user-action kit-user-delete', '删');
      remove.type = 'button';
      remove.title = `删除 ${user.displayName}`;
      remove.setAttribute('aria-label', `删除 ${user.displayName}`);
      remove.addEventListener('click', () => showDeleteConfirmation(group, actions, user, rename, remove));
      actions.append(rename, remove);
      group.append(card, actions);
      grid.append(group);
    }
    const create = createUserCard(element('span', 'kit-user-create-mark', '＋'), '新用户');
    create.classList.add('kit-user-create');
    create.addEventListener('click', (event) => {
      if (event.target instanceof HTMLInputElement) return;
      showUserEditor(create);
    });
    create.addEventListener('keydown', (event) => {
      if (event.target !== create || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      showUserEditor(create);
    });
    grid.append(create);
    section.append(grid);
    if (options.context.users.length === 0) {
      section.append(element('p', 'kit-flow-hint', '这里还没有用户。创建一个用户后即可继续。'));
    }
    return section;

    function createUserCard(mark: HTMLElement, label: string): HTMLElement {
      const card = element('div', 'kit-user-card');
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.setAttribute('aria-label', label);
      card.append(mark, element('span', 'kit-user-name', label));
      return card;
    }

    function showDeleteConfirmation(
      group: HTMLElement,
      actions: HTMLElement,
      user: WorkbenchContext['users'][number],
      rename: HTMLButtonElement,
      remove: HTMLButtonElement,
    ): void {
      if (section.querySelector('.kit-user-delete-confirming')) return;
      group.classList.add('kit-user-delete-confirming');
      const cancel = element('button', 'kit-user-action kit-user-delete-cancel', '取消');
      cancel.type = 'button';
      cancel.setAttribute('aria-label', `取消删除 ${user.displayName}`);
      const confirm = element('button', 'kit-user-action kit-user-delete-confirm', '删除');
      confirm.type = 'button';
      confirm.setAttribute('aria-label', `确认删除 ${user.displayName}`);
      const restore = () => {
        group.classList.remove('kit-user-delete-confirming');
        actions.replaceChildren(rename, remove);
        remove.focus();
      };
      cancel.addEventListener('click', restore);
      confirm.addEventListener('click', async () => {
        cancel.disabled = true;
        confirm.disabled = true;
        group.setAttribute('aria-busy', 'true');
        const progressMessage = `正在删除 ${user.displayName}…`;
        live.textContent = progressMessage;
        try {
          const response = await fetch(`/api/workbench/user/${encodeURIComponent(user.userId)}`, { method: 'DELETE' });
          if (!response.ok) {
            if (response.status === 409) throw new Error('in-use');
            throw new Error(String(response.status));
          }
          finishOperationAnnouncement(progressMessage);
          options.onContextChanged({
            ...state,
            step: 'user',
            selectedUserId: null,
            selectedSessionId: null,
            feedback: { kind: 'success', message: `已删除用户“${user.displayName}”` },
          });
        } catch (error) {
          finishOperationAnnouncement(progressMessage);
          group.removeAttribute('aria-busy');
          group.classList.remove('kit-user-delete-confirming');
          const inUse = error instanceof Error && error.message === 'in-use';
          const message = inUse
            ? `无法删除“${user.displayName}”：该用户仍有关联 Session。请先删除 Session。`
            : `未能删除用户“${user.displayName}”，请重试。`;
          actions.replaceChildren(rename, remove);
          remove.disabled = false;
          showFeedback({ kind: 'error', message });
          remove.focus();
        }
      });
      actions.replaceChildren(cancel, confirm);
      confirm.focus();
    }

    function showUserEditor(card: HTMLElement, user?: WorkbenchContext['users'][number], returnTarget?: HTMLButtonElement): void {
      if (section.querySelector('.kit-user-editor')) return;
      const isRename = !!user;
      const name = card.querySelector<HTMLElement>('.kit-user-name');
      if (!name) return;
      const input = document.createElement('input');
      input.className = 'kit-user-name kit-user-editor-input';
      input.name = 'displayName';
      input.type = 'text';
      input.setAttribute('aria-label', isRename ? `${user!.displayName}的新名称` : '新用户名称');
      input.setAttribute('aria-description', '按 Enter 确认，按 Escape 取消');
      input.placeholder = isRename ? '用户名称' : '输入名称';
      input.required = true;
      input.maxLength = 80;
      input.autocomplete = 'off';
      input.value = user?.displayName ?? '';
      name.replaceWith(input);
      card.classList.add('kit-user-editor');
      card.setAttribute('aria-busy', 'false');
      card.removeAttribute('role');
      card.tabIndex = -1;
      let editingLocked = false;
      let editorClosed = false;
      const focusInputWithoutViewportShift = () => {
        input.focus({ preventScroll: true });
      };

      const close = (restoreFocus = true) => {
        if (editingLocked || editorClosed) return;
        editorClosed = true;
        input.replaceWith(name);
        card.classList.remove('kit-user-editor', 'kit-user-editor-invalid');
        card.removeAttribute('aria-busy');
        card.setAttribute('role', 'button');
        card.tabIndex = 0;
        if (restoreFocus) (returnTarget ?? card).focus();
      };
      input.addEventListener('blur', () => close(false));
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          close();
        } else if (event.key === 'Enter') {
          event.preventDefault();
          void save();
        }
      });

      const save = async () => {
        if (editingLocked) return;
        const displayName = input.value.trim();
        if (!displayName) {
          card.classList.add('kit-user-editor-invalid');
          input.setAttribute('aria-invalid', 'true');
          input.placeholder = '请输入名称';
          live.textContent = '请输入用户名称。';
          focusInputWithoutViewportShift();
          return;
        }
        if (displayName.length > 80) {
          card.classList.add('kit-user-editor-invalid');
          input.setAttribute('aria-invalid', 'true');
          live.textContent = '用户名称不能超过 80 个字符。';
          focusInputWithoutViewportShift();
          return;
        }
        editingLocked = true;
        card.classList.remove('kit-user-editor-invalid');
        card.setAttribute('aria-busy', 'true');
        input.disabled = true;
        input.removeAttribute('aria-invalid');
        const progressMessage = isRename ? '正在保存用户名称…' : '正在创建用户…';
        live.textContent = progressMessage;
        try {
          const response = await fetch(user ? `/api/workbench/user/${encodeURIComponent(user.userId)}` : '/api/workbench/user', {
            method: user ? 'PATCH' : 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ displayName }),
          });
          if (!response.ok) throw new Error(String(response.status));
          finishOperationAnnouncement(progressMessage);
          if (user) {
            options.onContextChanged({
              ...state,
              step: 'user',
              feedback: { kind: 'success', message: `已将用户重命名为“${displayName}”` },
            });
          } else {
            const created = await response.json() as { userId: string };
            options.onContextChanged({
              step: 'session',
              selectedUserId: created.userId,
              selectedSessionId: null,
              feedback: { kind: 'success', message: `已创建用户“${displayName}”` },
            });
          }
        } catch {
          finishOperationAnnouncement(progressMessage);
          editingLocked = false;
          card.setAttribute('aria-busy', 'false');
          card.classList.add('kit-user-editor-invalid');
          input.disabled = false;
          input.setAttribute('aria-invalid', 'true');
          showFeedback({
            kind: 'error',
            message: isRename ? '未能保存用户名称，请检查连接后重试。' : '未能创建用户，请检查连接后重试。',
          });
          focusInputWithoutViewportShift();
        }
      };
      focusInputWithoutViewportShift();
    }
  };

  const createSessionStep = (): HTMLElement => {
    const user = selectedUser(options.context, state.selectedUserId);
    if (!user) {
      state.step = 'user';
      return createUserStep();
    }
    const section = createStepSection(user.displayName, '选择 Session', '继续之前的工作，或保持不选并在继续时创建新的 Session。');
    section.setAttribute('aria-busy', 'false');
    if (options.context.actor === 'local-admin') {
      const back = backButton('选择用户', () => {
        state.selectedSessionId = null;
        options.onSessionCleared();
        moveTo('user');
        if (returnFocusId) stage.querySelector<HTMLElement>(`#${returnFocusId}`)?.focus();
      });
      section.prepend(back);
    }
    const owned = sessionSummaries
      .filter((session) => session.ownerUserId === user.userId)
      .sort((left, right) => right.lastAccessAt - left.lastAccessAt);
    if (allowDefaultSession && !state.selectedSessionId && owned.length > 0) {
      state.selectedSessionId = owned[0].sessionId;
      options.onSessionSelected(owned[0].sessionId);
      live.textContent = `已默认选择最近使用的 Session ${shortId(owned[0].sessionId)}`;
    }
    const fieldset = element('fieldset', 'kit-session-fieldset');
    fieldset.append(element('legend', 'kit-session-legend', '最近使用'));
    if (owned.length === 0) {
      fieldset.append(element('p', 'kit-empty-copy', '还没有可继续的 Session。'));
    } else {
      for (const session of owned) fieldset.append(createSessionChoice(session));
    }
    const clear = element('button', 'kit-session-clear', '不选择，创建新 Session');
    clear.type = 'button';
    clear.setAttribute('aria-pressed', String(state.selectedSessionId === null));
    clear.addEventListener('click', () => {
      state.selectedSessionId = null;
      allowDefaultSession = false;
      options.onSessionCleared();
      for (const radio of fieldset.querySelectorAll<HTMLInputElement>('input[type="radio"]')) radio.checked = false;
      clear.setAttribute('aria-pressed', 'true');
      live.textContent = '已选择在继续时创建新 Session';
    });
    const continueButton = element('button', 'kit-primary-action', '继续选择工作台');
    continueButton.type = 'button';
    continueButton.addEventListener('click', async () => {
      if (state.selectedSessionId) {
        moveTo('kit');
        return;
      }
      if (creationLocked) return;
      creationLocked = true;
      section.setAttribute('aria-busy', 'true');
      setSessionControlsDisabled(section, true);
      const progressMessage = '正在创建 Session…';
      live.textContent = progressMessage;
      try {
        const response = await fetch('/api/workbench/session', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: user.userId }),
        });
        if (!response.ok) throw new Error(String(response.status));
        const session = await response.json() as PublicSessionSummary;
        if (!sessionSummaries.some((item) => item.sessionId === session.sessionId)) {
          sessionSummaries = [...sessionSummaries, session];
        }
        state.selectedSessionId = session.sessionId;
        options.onSessionSelected(session.sessionId);
        creationLocked = false;
        finishOperationAnnouncement(progressMessage);
        moveTo('kit');
        showFeedback({ kind: 'success', message: `已创建 Session ${shortId(session.sessionId)}` });
      } catch {
        finishOperationAnnouncement(progressMessage);
        creationLocked = false;
        section.setAttribute('aria-busy', 'false');
        setSessionControlsDisabled(section, false);
        showFeedback({ kind: 'error', message: '未能创建 Session，请检查连接后重试。' });
        continueButton.focus();
      }
    });
    const note = element('p', 'kit-flow-hint', '未选择时，继续后会先创建新 Session，再选择工作台。');
    section.append(fieldset, clear, note, continueButton);
    return section;

    function createSessionChoice(session: PublicSessionSummary): HTMLElement {
      const entry = element('div', 'kit-session-entry');
      const label = element('label', 'kit-session-option');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'workbench-session';
      radio.value = session.sessionId;
      radio.checked = state.selectedSessionId === session.sessionId;
      radio.addEventListener('change', () => {
        state.selectedSessionId = session.sessionId;
        allowDefaultSession = true;
        options.onSessionSelected(session.sessionId);
        clear.setAttribute('aria-pressed', 'false');
        live.textContent = `已选择 Session ${shortId(session.sessionId)}`;
      });
      const copy = element('span', 'kit-session-copy');
      copy.append(element('strong', '', shortId(session.sessionId)), element('span', '', `最近使用 ${formatTime(session.lastAccessAt)}`));
      label.append(radio, copy);
      const actions = element('div', 'kit-session-actions');
      actions.setAttribute('role', 'group');
      actions.setAttribute('aria-label', `${shortId(session.sessionId)} 的 Session 操作`);
      const remove = element('button', 'kit-session-action kit-session-delete', '删');
      remove.type = 'button';
      remove.title = `删除 Session ${shortId(session.sessionId)}`;
      remove.setAttribute('aria-label', `删除 Session ${shortId(session.sessionId)}`);
      remove.addEventListener('click', () => showSessionDeleteConfirmation());
      actions.append(remove);
      entry.append(label, actions);
      return entry;

      function showSessionDeleteConfirmation(): void {
        if (fieldset.querySelector('.kit-session-delete-confirming')) return;
        entry.classList.add('kit-session-delete-confirming');
        const cancel = element('button', 'kit-session-action kit-session-delete-cancel', '取消');
        cancel.type = 'button';
        cancel.setAttribute('aria-label', `取消删除 Session ${shortId(session.sessionId)}`);
        const confirm = element('button', 'kit-session-action kit-session-delete-confirm', '删除');
        confirm.type = 'button';
        confirm.setAttribute('aria-label', `确认删除 Session ${shortId(session.sessionId)}`);
        const warning = element('span', 'kit-session-delete-warning', '将关闭运行中的工作台，并永久删除状态。');
        warning.id = `kit-session-delete-warning-${safeDomId(session.sessionId)}`;
        confirm.setAttribute('aria-describedby', warning.id);
        const restore = () => {
          entry.classList.remove('kit-session-delete-confirming');
          warning.remove();
          actions.replaceChildren(remove);
          remove.focus();
        };
        cancel.addEventListener('click', restore);
        confirm.addEventListener('click', async () => {
          cancel.disabled = true;
          confirm.disabled = true;
          section.setAttribute('aria-busy', 'true');
          setSessionControlsDisabled(section, true);
          const progressMessage = `正在删除 Session ${shortId(session.sessionId)}…`;
          live.textContent = progressMessage;
          try {
            const response = await fetch(`/api/session/${encodeURIComponent(session.sessionId)}`, { method: 'DELETE' });
            if (!response.ok) throw new Error(String(response.status));
            sessionSummaries = sessionSummaries.filter((item) => item.sessionId !== session.sessionId);
            if (state.selectedSessionId === session.sessionId) {
              state.selectedSessionId = null;
              allowDefaultSession = true;
              options.onSessionCleared();
            }
            finishOperationAnnouncement(progressMessage);
            renderStep(true);
            showFeedback({ kind: 'success', message: `已删除 Session ${shortId(session.sessionId)}` });
          } catch {
            finishOperationAnnouncement(progressMessage);
            section.setAttribute('aria-busy', 'false');
            setSessionControlsDisabled(section, false);
            entry.classList.remove('kit-session-delete-confirming');
            warning.remove();
            actions.replaceChildren(remove);
            showFeedback({ kind: 'error', message: `未能删除 Session ${shortId(session.sessionId)}，请重试。` });
            remove.focus();
          }
        });
        actions.replaceChildren(cancel, confirm);
        entry.append(warning);
        confirm.focus();
      }
    }
  };

  const createKitStep = (): HTMLElement => {
    const user = selectedUser(options.context, state.selectedUserId);
    if (!user) {
      state.step = options.context.actor === 'user' ? 'session' : 'user';
      return state.step === 'session' ? createSessionStep() : createUserStep();
    }
    if (!state.selectedSessionId) {
      state.step = 'session';
      return createSessionStep();
    }
    const section = createStepSection(`${user.displayName} · ${shortId(state.selectedSessionId)}`, '选择工作台', '选择一个 Kit，开始工作。');
    const back = backButton('选择 Session', () => {
      moveTo('session', false);
      const target = state.selectedSessionId
        ? stage.querySelector<HTMLInputElement>(`input[value="${cssEscape(state.selectedSessionId)}"]`)
        : stage.querySelector<HTMLButtonElement>('.kit-session-clear');
      target?.focus();
    });
    section.prepend(back);
    const berth = element('section', 'kit-berth');
    berth.setAttribute('aria-label', '可用 Kit');
    berth.setAttribute('aria-busy', 'false');
    const header = element('div', 'kit-berth-heading');
    header.append(element('span', '', '可用工作台'), element('span', 'kit-count', `${kits.length} KIT${kits.length === 1 ? '' : 'S'}`));
    berth.append(header);
    if (kits.length === 0) {
      const empty = element('div', 'kit-empty');
      empty.append(element('strong', '', '没有可用的 Kit'), element('p', '', '检查 kits 目录中的 package.json，确认 Kit manifest 完整有效。'));
      berth.append(empty);
    } else {
      const list = element('ul', 'kit-list');
      list.setAttribute('role', 'list');
      for (const kit of kits) list.append(createKitItem(kit, () => openKit(kit.id)));
      berth.append(list);
    }
    section.append(berth);
    return section;
  };

  const openKit = (kitId: string) => {
    const sessionId = state.selectedSessionId;
    if (!sessionId) return;
    const href = `/kits/${encodeURIComponent(kitId)}?session=${encodeURIComponent(sessionId)}`;
    if (options.navigate) options.navigate(href);
    else window.location.assign(href);
  };

  renderStep();
  if (resume?.feedback) showFeedback(resume.feedback);
  return main;
}

function createKitItem(kit: PublicKitCatalogEntry, open: () => void): HTMLLIElement {
  const item = element('li', 'kit-item');
  const link = element('button', 'kit-link');
  link.type = 'button';
  link.dataset.kitId = kit.id;
  link.addEventListener('click', open);

  const symbol = element('span', 'kit-symbol', monogram(kit.label));
  symbol.setAttribute('aria-hidden', 'true');
  const copy = element('span', 'kit-copy');
  const packageName = element('span', 'kit-package', kit.name);
  packageName.setAttribute('translate', 'no');
  const route = element('span', 'kit-route', `/kits/${kit.id}`);
  route.setAttribute('translate', 'no');
  copy.append(
    element('strong', 'kit-label', kit.label),
    packageName,
    route,
  );
  const action = element('span', 'kit-open', '打开工作台');
  const arrow = element('span', 'kit-open-arrow', '↗');
  arrow.setAttribute('aria-hidden', 'true');
  action.append(arrow);
  link.append(symbol, copy, action);
  item.append(link);
  return item;
}

function createMasthead(): HTMLElement {
  const masthead = element('header', 'kit-masthead');
  const identity = element('div', 'kit-host-identity');
  identity.append(element('span', 'kit-host-mark', 'IH'), element('span', 'kit-host-name', 'ITHARBORS'));
  masthead.append(identity, element('span', 'kit-host-mode', 'Web Host / Multi-Kit'));
  return masthead;
}

function createStepSection(eyebrowText: string, titleText: string, ledeText: string): HTMLElement {
  const section = element('section', 'kit-flow-section');
  const intro = element('header', 'kit-picker-intro');
  const title = element('h1', '', titleText);
  title.id = 'kit-picker-title';
  title.tabIndex = -1;
  intro.append(element('p', 'kit-picker-eyebrow', eyebrowText), title, element('p', 'kit-picker-lede', ledeText));
  section.append(intro);
  return section;
}

function createAvatar(userId: string, name: string): HTMLElement {
  const avatar = element('span', `kit-user-avatar kit-user-avatar-${hash(userId) % 5}`, monogram(name));
  avatar.setAttribute('aria-hidden', 'true');
  return avatar;
}

function createIdentityUnavailable(reload: () => void): HTMLElement {
  const section = createStepSection('身份不可用', '无法确认当前用户', '此设备的授权没有关联可用用户。请重新加载或联系主机管理员。');
  const alert = element('p', 'kit-creation-error', '当前授权身份不可用。');
  alert.setAttribute('role', 'alert');
  const button = element('button', 'kit-primary-action', '重新加载');
  button.type = 'button';
  button.addEventListener('click', reload);
  section.append(alert, button);
  return section;
}

function backButton(label: string, action: () => void): HTMLElement {
  const nav = element('nav', 'kit-step-nav');
  nav.setAttribute('aria-label', '步骤导航');
  const button = element('button', 'kit-back-action', `← 上一步 · ${label}`);
  button.type = 'button';
  button.addEventListener('click', action);
  nav.append(button);
  return nav;
}

function selectedUser(context: WorkbenchContext, id: string | null) {
  return context.users.find((user) => user.userId === id) ?? (context.currentUser?.userId === id ? context.currentUser : undefined);
}

function normalizeResumeState(state: KitPickerResumeState, context: WorkbenchContext): KitPickerResumeState {
  const fixedUser = context.actor === 'user' ? context.currentUser?.userId ?? null : state.selectedUserId;
  const validUser = fixedUser && selectedUser(context, fixedUser) ? fixedUser : null;
  const validSession = state.selectedSessionId && context.sessions.some((session) => session.sessionId === state.selectedSessionId && session.ownerUserId === validUser)
    ? state.selectedSessionId : null;
  const step = context.actor === 'user' && !validUser ? 'session' : state.step === 'user' && context.actor === 'user' ? 'session' : !validUser && state.step !== 'user' ? 'user' : state.step;
  return { step, selectedUserId: validUser, selectedSessionId: validSession };
}

function safeDomId(value: string): string { return value.replace(/[^a-zA-Z0-9_-]/g, '-'); }
function cssEscape(value: string): string { return globalThis.CSS?.escape ? globalThis.CSS.escape(value) : value.replace(/["\\]/g, '\\$&'); }
function hash(value: string): number { return [...value].reduce((result, char) => ((result * 31) + char.charCodeAt(0)) >>> 0, 0); }

function setSessionControlsDisabled(section: HTMLElement, disabled: boolean): void {
  for (const control of section.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button, input, select')) {
    control.disabled = disabled;
  }
}

function createAuthView(): HTMLElement {
  const container = element('div', 'auth-view');
  container.append(
    element('h2', 'auth-section-title', '待授权设备'),
    element('div', 'auth-pending-list'),
    element('h2', 'auth-section-title', '已授权设备'),
    element('div', 'auth-authorized-list'),
  );
  return container;
}

async function refreshAuthView(container: HTMLElement): Promise<void> {
  const pendingList = container.querySelector('.auth-pending-list');
  const authorizedList = container.querySelector('.auth-authorized-list');
  if (!(pendingList instanceof HTMLElement) || !(authorizedList instanceof HTMLElement)) return;

  pendingList.replaceChildren(element('div', 'auth-loading', '加载中…'));
  authorizedList.replaceChildren(element('div', 'auth-loading', '加载中…'));

  try {
    const [pending, authorized, context] = await Promise.all([fetchPending(), fetchAuthorized(), fetchWorkbenchContext()]);
    renderPendingList(pendingList, pending, context.users);
    renderAuthorizedList(authorizedList, authorized);
  } catch {
    pendingList.replaceChildren(element('div', 'auth-error', '无法加载待授权列表'));
    authorizedList.replaceChildren(element('div', 'auth-error', '无法加载已授权列表'));
  }
}

function renderPendingList(host: HTMLElement, devices: PendingDevice[], users: WorkbenchContext['users']): void {
  if (devices.length === 0) {
    host.replaceChildren(element('div', 'auth-empty', '暂无待授权请求'));
    return;
  }
  const list = element('ul', 'auth-device-list');
  for (const device of devices) {
    list.append(createPendingItem(device, users, () => void refreshAuthView(host.closest('.auth-view') ?? host)));
  }
  host.replaceChildren(list);
}

function renderAuthorizedList(host: HTMLElement, devices: AuthorizedDevice[]): void {
  if (devices.length === 0) {
    host.replaceChildren(element('div', 'auth-empty', '暂无已授权设备'));
    return;
  }
  const list = element('ul', 'auth-device-list');
  for (const device of devices) {
    list.append(createAuthorizedItem(device, () => void refreshAuthView(host.closest('.auth-view') ?? host)));
  }
  host.replaceChildren(list);
}

function createPendingItem(device: PendingDevice, users: WorkbenchContext['users'], onChanged: () => void): HTMLLIElement {
  const item = element('li', 'auth-device-item');
  const info = element('div', 'auth-device-info');
  const requestedUser = device.requestedUserId ? users.find((user) => user.userId === device.requestedUserId) : undefined;
  info.append(
    element('div', 'auth-device-id', shortId(device.deviceId)),
    element('div', 'auth-device-meta', requestedUser
      ? `申请用户: ${requestedUser.displayName}`
      : `申请名称: ${device.displayName || '未填写'}`),
    element('div', 'auth-device-meta', `IP: ${device.ip || '未知'}`),
    element('div', 'auth-device-meta', `UA: ${device.userAgent || '未知'}`),
    element('div', 'auth-device-meta', `请求时间: ${formatTime(device.requestedAt)}`),
  );
  const actions = element('div', 'auth-device-actions');
  const userSelect = device.requestedUserId ? null : element('select', 'auth-user-select');
  if (userSelect) {
    const createOption = element('option', '', `新建用户：${device.displayName || '远程用户'}`);
    createOption.value = '';
    userSelect.append(createOption);
    for (const user of users) {
      const option = element('option', '', `绑定已有用户：${user.displayName}`);
      option.value = user.userId;
      userSelect.append(option);
    }
  }
  const approveBtn = element('button', 'auth-btn auth-btn-approve', '授权');
  approveBtn.addEventListener('click', async () => {
    try {
      await fetch(`/api/auth/approve/${encodeURIComponent(device.deviceId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(userSelect
          ? userSelect.value
            ? { userId: userSelect.value }
            : { displayName: device.displayName || '远程用户' }
          : {}),
      });
      onChanged();
    } catch {
      // ignore
    }
  });
  const rejectBtn = element('button', 'auth-btn auth-btn-reject', '拒绝');
  rejectBtn.addEventListener('click', async () => {
    try {
      await fetch(`/api/auth/reject/${encodeURIComponent(device.deviceId)}`, { method: 'POST' });
      onChanged();
    } catch {
      // ignore
    }
  });
  if (userSelect) actions.append(userSelect);
  actions.append(approveBtn, rejectBtn);
  item.append(info, actions);
  return item;
}

function createAuthorizedItem(device: AuthorizedDevice, onChanged: () => void): HTMLLIElement {
  const item = element('li', 'auth-device-item');
  const info = element('div', 'auth-device-info');
  const expiresIn = Math.max(0, Math.floor((device.expiresAt - Date.now()) / (1000 * 60 * 60 * 24)));
  info.append(
    element('div', 'auth-device-id', shortId(device.deviceId)),
    element('div', 'auth-device-meta', `用户: ${device.user?.displayName || shortId(device.userId)}`),
    element('div', 'auth-device-meta', `授权时间: ${formatTime(device.createdAt)}`),
    element('div', 'auth-device-meta', `到期时间: ${formatTime(device.expiresAt)}（${expiresIn} 天后）`),
    element('div', 'auth-device-meta', `最后活跃: ${formatTime(device.lastSeenAt)}`),
  );
  const actions = element('div', 'auth-device-actions');
  const refreshBtn = element('button', 'auth-btn auth-btn-refresh', '续期 7 天');
  refreshBtn.addEventListener('click', async () => {
    try {
      await fetch(`/api/auth/refresh/${encodeURIComponent(device.deviceId)}`, { method: 'POST' });
      onChanged();
    } catch {
      // ignore
    }
  });
  const revokeBtn = element('button', 'auth-btn auth-btn-revoke', '撤销');
  revokeBtn.addEventListener('click', async () => {
    try {
      await fetch(`/api/auth/authorized/${encodeURIComponent(device.deviceId)}`, { method: 'DELETE' });
      onChanged();
    } catch {
      // ignore
    }
  });
  actions.append(refreshBtn, revokeBtn);
  item.append(info, actions);
  return item;
}

async function fetchPending(): Promise<PendingDevice[]> {
  const resp = await fetch('/api/auth/pending', { headers: { accept: 'application/json' } });
  if (!resp.ok) throw new Error(`Failed to fetch pending: ${resp.status}`);
  const data = await resp.json() as { pending?: PendingDevice[] };
  return data.pending ?? [];
}

async function fetchAuthorized(): Promise<AuthorizedDevice[]> {
  const resp = await fetch('/api/auth/authorized', { headers: { accept: 'application/json' } });
  if (!resp.ok) throw new Error(`Failed to fetch authorized: ${resp.status}`);
  const data = await resp.json() as { authorized?: AuthorizedDevice[] };
  return data.authorized ?? [];
}

async function fetchWorkbenchContext(): Promise<WorkbenchContext> {
  const response = await fetch('/api/workbench/context', { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`Failed to fetch workbench context: ${response.status}`);
  return response.json() as Promise<WorkbenchContext>;
}

function shortId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-8)}` : id;
}

function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString('zh-CN');
  } catch {
    return String(ts);
  }
}

function monogram(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length > 1) return words.slice(0, 2).map((word) => word[0]).join('').toUpperCase();
  return label.slice(0, 2).toUpperCase();
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
