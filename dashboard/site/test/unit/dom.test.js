// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { h, injectStyleOnce } from '../../src/dom.js';

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
