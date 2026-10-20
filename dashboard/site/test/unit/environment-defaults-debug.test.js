// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

/** @param {string} search */
async function load(search) {
  const output = { debug: vi.fn() };
  vi.doMock('../../src/debug.js', async () => {
    const actual = /** @type {typeof import('../../src/debug.js')} */ (await vi.importActual('../../src/debug.js'));
    return {
      ...actual,
      createDebug: (/** @type {string} */ category, /** @type {object} */ options) =>
        actual.createDebug(category, { ...options, search: () => search, output })
    };
  });
  vi.resetModules();
  return { ...(await import('../../src/environment-defaults.js')), output };
}

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('environment defaults debug logging', () => {
  it('is silent by default', async () => {
    const { parseEnvironmentDefaults, output } = await load('');
    parseEnvironmentDefaults('default_a: "x"');
    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs scalar metadata without values', async () => {
    const { parseEnvironmentDefaults, environmentDefaultsCommand, output } = await load('?debug=src:environment-defaults');
    parseEnvironmentDefaults('default_token: "super-secret"');
    environmentDefaultsCommand('gh aw env get cao-governance.yml --scope org --org acme');
    expect(output.debug).toHaveBeenCalledWith('[cao:src:environment-defaults]', { event: 'parsed', keys: 1 });
    expect(output.debug).toHaveBeenCalledWith('[cao:src:environment-defaults]',
      { event: 'command', recognized: true, operation: 'get', scope: 'org' });
    expect(JSON.stringify(output.debug.mock.calls)).not.toMatch(/super-secret|acme/);
  });

  it('logs rejection reason only and still throws', async () => {
    const { parseEnvironmentDefaults, output } = await load('?debug=src:*');
    expect(() => parseEnvironmentDefaults('  ')).toThrow('Defaults YAML');
    expect(output.debug).toHaveBeenCalledWith('[cao:src:environment-defaults]', { event: 'parse-rejected', reason: 'size' });
  });
});
