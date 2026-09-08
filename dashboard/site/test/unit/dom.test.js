// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { h } from '../../src/dom.js';

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
