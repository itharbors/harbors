export function renderWaitingForAuthorization(host: HTMLElement): () => void {
  host.replaceChildren(createWaitingPage());
  let stopped = false;
  return () => {
    stopped = true;
  };
}

function createWaitingPage(): HTMLElement {
  const main = element('main', 'auth-waiting-shell');
  main.setAttribute('role', 'status');
  main.setAttribute('aria-live', 'polite');

  const card = element('div', 'auth-waiting-card');

  const spinner = element('div', 'auth-waiting-spinner');
  spinner.setAttribute('aria-hidden', 'true');

  const title = element('h1', 'auth-waiting-title', '等待主机授权');
  const desc = element('p', 'auth-waiting-desc', '请在运行 Harbors 的主机上打开授权管理页面，批准此设备的访问请求。');

  const deviceInfo = element('div', 'auth-waiting-device');
  deviceInfo.append(
    element('span', 'auth-waiting-label', '设备 ID'),
    element('code', 'auth-waiting-device-id', getShortDeviceId()),
  );

  card.append(spinner, title, desc, deviceInfo);
  main.append(card);
  return main;
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
