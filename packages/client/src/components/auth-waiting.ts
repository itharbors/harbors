import '../styles/kit-picker.css';

export interface AuthorizationUser {
  userId: string;
  displayName: string;
}

export function renderAuthorizationUserPicker(
  host: HTMLElement,
  users: AuthorizationUser[],
  onSelect: (user: AuthorizationUser) => Promise<void>,
  onRetry: () => void,
): void {
  const shell = createShell();
  const section = createIntro('远程登录', '选择使用者', '选择已有用户，向主机发送访问申请。');
  const live = element('p', 'remote-auth-live');
  live.setAttribute('aria-live', 'polite');

  if (users.length === 0) {
    const empty = element('div', 'remote-auth-empty');
    empty.append(
      element('p', '', '主机上还没有可登录的用户，请先由主机管理员创建用户。'),
      actionButton('重新读取', onRetry),
    );
    section.append(empty, live);
  } else {
    const grid = element('div', 'kit-user-grid remote-auth-user-grid');
    const buttons: HTMLButtonElement[] = [];
    for (const user of users) {
      const button = element('button', 'kit-user-card remote-auth-user-card');
      button.type = 'button';
      button.dataset.userId = user.userId;
      button.setAttribute('aria-label', `以 ${user.displayName} 的身份申请登录`);
      button.append(createAvatar(user), element('span', 'kit-user-name', user.displayName));
      button.addEventListener('click', async () => {
        if (buttons.some((item) => item.disabled)) return;
        buttons.forEach((item) => { item.disabled = true; });
        section.setAttribute('aria-busy', 'true');
        live.textContent = `正在为 ${user.displayName} 发送访问申请…`;
        try {
          await onSelect(user);
        } catch {
          buttons.forEach((item) => { item.disabled = false; });
          section.removeAttribute('aria-busy');
          live.textContent = '申请发送失败，请重新选择用户。';
          live.setAttribute('role', 'alert');
          button.focus();
        }
      });
      buttons.push(button);
      grid.append(button);
    }
    section.append(grid, live);
  }

  shell.querySelector('.kit-flow-stage')?.append(section);
  host.replaceChildren(shell);
  section.querySelector<HTMLElement>('h1')?.focus();
}

export function renderWaitingForAuthorization(host: HTMLElement, user: AuthorizationUser): void {
  const shell = createShell();
  const section = createIntro(user.displayName, '等待主机授权', '请在运行 Harbors 的主机上批准此设备的访问请求。');
  section.setAttribute('role', 'status');
  section.setAttribute('aria-live', 'polite');

  const identity = element('div', 'remote-auth-waiting-identity');
  const spinner = element('span', 'auth-waiting-spinner');
  spinner.setAttribute('aria-hidden', 'true');
  const avatar = createAvatar(user);
  avatar.append(spinner);
  identity.append(
    avatar,
    element('strong', 'remote-auth-waiting-name', user.displayName),
    element('span', 'remote-auth-waiting-copy', '已发送申请，正在等待主机确认'),
  );

  const device = element('div', 'auth-waiting-device');
  device.append(
    element('span', 'auth-waiting-label', '设备 ID'),
    element('code', 'auth-waiting-device-id', getShortDeviceId()),
  );
  section.append(identity, device);
  shell.querySelector('.kit-flow-stage')?.append(section);
  host.replaceChildren(shell);
}

export function renderAuthorizationLoadError(host: HTMLElement, onRetry: () => void): void {
  const shell = createShell();
  const section = createIntro('远程登录', '无法读取登录信息', '确认主机仍在运行，然后重新加载。');
  const error = element('div', 'remote-auth-empty');
  error.setAttribute('role', 'alert');
  error.append(actionButton('重新加载', onRetry));
  section.append(error);
  shell.querySelector('.kit-flow-stage')?.append(section);
  host.replaceChildren(shell);
}

function createShell(): HTMLElement {
  const shell = element('div', 'kit-picker-shell remote-auth-shell');
  const tabs = element('nav', 'kit-tabs');
  tabs.append(element('span', 'kit-tab kit-tab-active', '工作台'));
  const body = element('main', 'kit-picker-body');
  const masthead = element('header', 'kit-masthead');
  const identity = element('div', 'kit-host-identity');
  identity.append(element('span', 'kit-host-mark', 'IH'), element('span', 'kit-host-name', 'ITHARBORS'));
  masthead.append(identity, element('span', 'kit-host-mode', 'WEB HOST / REMOTE'));
  body.append(masthead, element('div', 'kit-flow-stage kit-flow-step-user'), createFooter());
  shell.append(tabs, body);
  return shell;
}

function createIntro(eyebrow: string, title: string, description: string): HTMLElement {
  const section = element('section', 'kit-flow-section remote-auth-section');
  const intro = element('div', 'kit-picker-intro');
  const heading = element('h1', '', title);
  heading.tabIndex = -1;
  intro.append(element('p', 'kit-picker-eyebrow', eyebrow), heading, element('p', 'kit-picker-lede', description));
  section.append(intro);
  return section;
}

function createAvatar(user: AuthorizationUser): HTMLSpanElement {
  const avatar = element('span', `kit-user-avatar kit-user-avatar-${(hash(user.userId) % 4) + 1}`, initials(user.displayName));
  avatar.setAttribute('aria-hidden', 'true');
  return avatar;
}

function createFooter(): HTMLElement {
  const footer = element('footer', 'kit-picker-footer');
  footer.append(element('span', '', '远程访问 · 等待主机授权'), element('span', '', 'ITHARBORS WORKBENCH'));
  return footer;
}

function actionButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = element('button', 'kit-primary-action', label);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

function initials(displayName: string): string {
  return [...displayName.trim()].slice(0, 2).join('').toUpperCase() || '?';
}

function hash(value: string): number {
  return [...value].reduce((result, char) => ((result * 31) + char.charCodeAt(0)) >>> 0, 0);
}

function getShortDeviceId(): string {
  try {
    const id = window.localStorage.getItem('harbors.deviceId') ?? '';
    return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
  } catch {
    return '';
  }
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
