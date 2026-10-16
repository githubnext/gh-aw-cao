import { afterEach, describe, expect, it, vi } from 'vitest';

const selector = {
  label: 'SECRET-LABEL', 'debounce-ms': 50,
  query: { command: 'gh search repos', fields: ['fullName'], limit: 5 },
  mapping: { value: 'fullName', label: 'fullName', target: 'repository' }
};

/** @param {string} debug */
async function reject(debug) {
  vi.resetModules();
  history.replaceState(null, '', debug ? `/?debug=${debug}` : '/');
  const output = vi.spyOn(console, 'debug').mockImplementation(() => {});
  const { assertDialogSelector } = await import('../../src/dialog-selector.js');
  expect(() => assertDialogSelector(selector, ['repository'])).toThrow('Dialog selector must declare');
  return output;
}

afterEach(() => {
  vi.restoreAllMocks();
  history.replaceState(null, '', '/');
});

describe('dialog selector validation debug logging', () => {
  it('is silent by default and for other categories', async () => {
    expect((await reject('')).mock.calls).toHaveLength(0);
    expect((await reject('other')).mock.calls).toHaveLength(0);
  });

  it('emits scalar metadata for src:dialog-selector without declared values', async () => {
    const output = await reject('src:dialog-selector');
    expect(output).toHaveBeenCalledTimes(1);
    const text = JSON.stringify(output.mock.calls);
    expect(text).toContain('selector-rejected');
    expect(text).toContain('queryFieldCount');
    expect(text).not.toContain('SECRET-LABEL');
    expect(text).not.toContain('fullName');
  });
});
