// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { button, h, injectStyleOnce, span } from '../../src/dom.js';

describe('h', () => {
  it('gives otherwise unidentified form controls unique ids', () => {
    const input = h('input', { type: 'search' });
    const select = h('select');
    const textarea = h('textarea');

    expect(input.id).toMatch(/^cao-field-\d+$/);
    expect(select.id).toMatch(/^cao-field-\d+$/);
    expect(textarea.id).toMatch(/^cao-field-\d+$/);
    expect(new Set([input.id, select.id, textarea.id])).toHaveLength(3);
  });

  it('preserves explicit form control ids and names', () => {
    expect(h('input', { id: 'query' }).id).toBe('query');
    expect(h('select', { name: 'horizon' }).hasAttribute('id')).toBe(false);
  });
});

describe('element helpers', () => {
  it('creates span elements with h-compatible props and children', () => {
    const element = span({ className: 'label' }, 'Status');

    expect(element).toBeInstanceOf(HTMLSpanElement);
    expect(element.className).toBe('label');
    expect(element.textContent).toBe('Status');
  });

  it('creates button elements with h-compatible props and children', () => {
    const onClick = vi.fn();
    const element = button({ type: 'button', onClick }, 'Retry');

    element.click();

    expect(element).toBeInstanceOf(HTMLButtonElement);
    expect(element.type).toBe('button');
    expect(element.textContent).toBe('Retry');
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe('injectStyleOnce', () => {
  afterEach(() => {
    document.head.replaceChildren();
  });

  it('appends a marked style element with the given css', () => {
    injectStyleOnce(document, 'widget-styles', '.widget { color: red; }');

    const style = document.querySelector('style[data-widget-styles]');
    expect(style?.textContent).toBe('.widget { color: red; }');
  });

  it('skips a second injection for the same marker', () => {
    injectStyleOnce(document, 'widget-styles', '.widget { color: red; }');
    injectStyleOnce(document, 'widget-styles', '.widget { color: blue; }');

    const styles = document.querySelectorAll('style[data-widget-styles]');
    expect(styles).toHaveLength(1);
    expect(styles[0].textContent).toBe('.widget { color: red; }');
  });
});
