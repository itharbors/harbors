import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/ui/tooltip';

describe('ce-tooltip', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('renders wrapped content slot', () => {
    const el = document.createElement('ce-tooltip');
    el.setAttribute('content', 'Help text');
    el.innerHTML = '<button>Hover me</button>';
    document.body.appendChild(el);

    expect(el.shadowRoot!.querySelector('slot')).not.toBeNull();
  });

  it('shows tooltip after configured hover delay', () => {
    const el = document.createElement('ce-tooltip');
    el.setAttribute('content', 'Tooltip text');
    el.setAttribute('delay', '100');
    document.body.appendChild(el);

    el.dispatchEvent(new MouseEvent('mouseenter'));
    expect(el.shadowRoot!.querySelector('.tip')).toBeNull();

    vi.advanceTimersByTime(100);
    const tip = el.shadowRoot!.querySelector('.tip');

    expect(tip).not.toBeNull();
    expect(tip!.textContent).toContain('Tooltip text');
  });

  it('hides tooltip on mouseleave', () => {
    const el = document.createElement('ce-tooltip');
    el.setAttribute('content', 'Tip');
    el.setAttribute('delay', '0');
    document.body.appendChild(el);

    el.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(0);
    expect(el.shadowRoot!.querySelector('.tip')).not.toBeNull();

    el.dispatchEvent(new MouseEvent('mouseleave'));
    expect(el.shadowRoot!.querySelector('.tip')).toBeNull();
  });

  it('applies position class when tooltip is shown', () => {
    const el = document.createElement('ce-tooltip');
    el.setAttribute('content', 'Tip');
    el.setAttribute('position', 'bottom');
    el.setAttribute('delay', '0');
    document.body.appendChild(el);

    el.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(0);

    expect(el.shadowRoot!.querySelector('.tip')!.className).toContain('bottom');
  });
});
