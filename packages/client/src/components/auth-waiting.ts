import '../styles/kit-picker.css';

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
  main.style.cssText = 'display:grid;place-items:center;width:100%;height:100%;min-height:100%;padding:40px 20px;background:#111722;color:#d8e2f0;font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';

  const card = element('div', 'auth-waiting-card');
  card.style.cssText = 'width:min(460px,100%);display:grid;justify-items:center;gap:14px;padding:40px 32px;border:1px solid rgba(169,199,247,0.15);border-radius:18px;background:#182231;text-align:center;';

  const spinner = element('div', 'auth-waiting-spinner');
  spinner.setAttribute('aria-hidden', 'true');
  spinner.style.cssText = 'width:36px;height:36px;border:3px solid rgba(169,199,247,0.18);border-top-color:#5b8def;border-radius:50%;animation:kit-spin 900ms linear infinite;';

  const title = element('h1', 'auth-waiting-title', '等待主机授权');
  title.style.cssText = 'margin:0;color:#f3f7fc;font-size:22px;font-weight:650;';

  const desc = element('p', 'auth-waiting-desc', '请在运行 Harbors 的主机上打开授权管理页面，批准此设备的访问请求。');
  desc.style.cssText = 'margin:0;color:#8d9baf;font-size:14px;line-height:1.7;';

  const deviceInfo = element('div', 'auth-waiting-device');
  deviceInfo.style.cssText = 'margin-top:8px;padding:12px 16px;border:1px solid rgba(169,199,247,0.12);border-radius:10px;background:rgba(17,23,34,0.6);';

  const label = element('span', 'auth-waiting-label', '设备 ID');
  label.style.cssText = 'display:block;color:#8d9baf;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;';

  const deviceId = element('code', 'auth-waiting-device-id', getShortDeviceId());
  deviceId.style.cssText = 'display:block;margin-top:4px;color:#a9c7f7;font-family:"SFMono-Regular",Consolas,monospace;font-size:13px;';

  deviceInfo.append(label, deviceId);
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
