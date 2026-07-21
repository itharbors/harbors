import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  renderKitPicker,
  renderKitPickerError,
  renderKitPickerLoading,
} from '../../src/components/kit-picker';

describe('Kit picker', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders stable, semantic Kit links without leaking local paths', () => {
    const host = mountHost();

    renderKitPicker(host, [
      { id: 'mysql', name: '@itharbors/kit-mysql', label: 'MySQL' },
      { id: 'sqlite', name: '@itharbors/kit-sqlite', label: 'SQLite' },
    ]);

    expect(host.querySelector('main')?.getAttribute('aria-labelledby')).toBe('kit-picker-title');
    expect(host.querySelector('h1')?.textContent).toBe('选择工作台');
    expect(host.textContent).toContain('多 Kit 主机');
    expect(host.querySelector('[role="list"]')).not.toBeNull();
    const mysql = host.querySelector<HTMLAnchorElement>('[data-kit-id="mysql"]');
    expect(mysql?.getAttribute('href')).toBe('/kits/mysql');
    expect(mysql?.textContent).toContain('MySQL');
    expect(mysql?.textContent).toContain('@itharbors/kit-mysql');
    expect(mysql?.textContent).toContain('打开工作台');
    expect(mysql?.querySelector('.kit-package')?.getAttribute('translate')).toBe('no');
    expect(mysql?.querySelector('.kit-route')?.getAttribute('translate')).toBe('no');
    expect(mysql?.querySelector('.kit-open-arrow')?.getAttribute('aria-hidden')).toBe('true');
    expect(host.querySelector('[data-kit-id="sqlite"]')?.getAttribute('href')).toBe('/kits/sqlite');
    expect(host.textContent).not.toContain('/private');
  });

  it('renders a directional empty state without creating links', () => {
    const host = mountHost();

    renderKitPicker(host, []);

    expect(host.textContent).toContain('没有可用的 Kit');
    expect(host.textContent).toContain('检查 kits 目录中的 package.json');
    expect(host.querySelector('a')).toBeNull();
  });

  it('renders loading and retryable failure states', () => {
    const host = mountHost();
    const retry = vi.fn();

    renderKitPickerLoading(host);
    expect(host.querySelector('[role="status"]')?.textContent).toContain('正在读取 Kit');
    expect(host.querySelector('.kit-host-spinner')?.getAttribute('aria-hidden')).toBe('true');

    renderKitPickerError(host, retry);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('无法读取 Kit 列表');
    (host.querySelector('button') as HTMLButtonElement).click();
    expect(retry).toHaveBeenCalledOnce();
  });

  it('defines the approved palette, keyboard focus, responsive layout, and reduced motion', () => {
    const css = fs.readFileSync(path.resolve('src/styles/kit-picker.css'), 'utf8');

    expect(css).toContain('#111722');
    expect(css).toContain('#182231');
    expect(css).toContain('#5b8def');
    expect(css).toContain('#a9c7f7');
    expect(css).toMatch(/:root\s*{[^}]*color-scheme:\s*dark;/s);
    expect(css).toMatch(/\.kit-picker-intro h1\s*{[^}]*white-space:\s*nowrap;/s);
    expect(css).toMatch(/\.kit-link:focus-visible/);
    expect(css).toMatch(/\.kit-link\s*{[^}]*touch-action:\s*manipulation;/s);
    expect(css).toMatch(/\.kit-count\s*{[^}]*font-variant-numeric:\s*tabular-nums;/s);
    expect(css).toMatch(/@media\s*\(max-width:\s*700px\)/);
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  });
});

function mountHost(): HTMLElement {
  const host = document.createElement('div');
  host.id = 'app';
  document.body.append(host);
  return host;
}
