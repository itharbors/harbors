import type { PublicKitCatalogEntry } from '@itharbors/plugin-types';
import '../styles/kit-picker.css';

export function renderKitPicker(host: HTMLElement, kits: PublicKitCatalogEntry[]): void {
  host.replaceChildren(createPicker(kits));
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
    element('strong', '', '无法读取 Kit 列表'),
    element('span', '', '确认服务仍在运行，然后重新加载列表。'),
  );
  const button = element('button', 'kit-retry', '重新加载');
  button.setAttribute('type', 'button');
  button.addEventListener('click', retry);
  alert.append(button);
  host.replaceChildren(alert);
}

function createPicker(kits: PublicKitCatalogEntry[]): HTMLElement {
  const main = element('main', 'kit-picker-shell');
  main.setAttribute('aria-labelledby', 'kit-picker-title');

  const masthead = element('header', 'kit-masthead');
  const identity = element('div', 'kit-host-identity');
  identity.append(
    element('span', 'kit-host-mark', 'IH'),
    element('span', 'kit-host-name', 'ITHARBORS'),
  );
  masthead.append(
    identity,
    element('span', 'kit-host-mode', 'Web Host / Multi-Kit'),
  );

  const intro = element('section', 'kit-picker-intro');
  const eyebrow = element('p', 'kit-picker-eyebrow', '多 Kit 主机');
  const title = element('h1', '', '选择工作台');
  title.id = 'kit-picker-title';
  intro.append(
    eyebrow,
    title,
    element('p', 'kit-picker-lede', '每个工作台使用独立会话。选择一个 Kit，在当前浏览器中开始工作。'),
  );

  const berth = element('section', 'kit-berth');
  berth.setAttribute('aria-label', '可用 Kit');
  const berthHeader = element('div', 'kit-berth-heading');
  berthHeader.append(
    element('span', '', '可用工作台'),
    element('span', 'kit-count', `${kits.length} KIT${kits.length === 1 ? '' : 'S'}`),
  );
  berth.append(berthHeader);

  if (kits.length === 0) {
    const empty = element('div', 'kit-empty');
    empty.append(
      element('strong', '', '没有可用的 Kit'),
      element('p', '', '检查 kits 目录中的 package.json，确认 Kit manifest 完整有效。'),
    );
    berth.append(empty);
  } else {
    const list = element('ul', 'kit-list');
    list.setAttribute('role', 'list');
    for (const kit of kits) list.append(createKitItem(kit));
    berth.append(list);
  }

  const footer = element('footer', 'kit-picker-footer');
  footer.append(
    element('span', '', '同一端口 · 独立 Session'),
    element('span', '', 'ITHARBORS WORKBENCH'),
  );

  main.append(masthead, intro, berth, footer);
  return main;
}

function createKitItem(kit: PublicKitCatalogEntry): HTMLLIElement {
  const item = element('li', 'kit-item');
  const link = element('a', 'kit-link');
  link.dataset.kitId = kit.id;
  link.href = `/kits/${encodeURIComponent(kit.id)}`;

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
