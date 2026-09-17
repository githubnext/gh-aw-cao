import { describe, expect, it, vi } from 'vitest';
import {
  cliActionTemplateFields,
  renderCliActionCommand
} from '../../src/cli-action-template.js';

describe('CLI action command templates', () => {
  it('lists unique template fields and renders a repository slug', () => {
    const command = 'gh aw update --repo {{repository}} --source {{repository}}';

    expect(cliActionTemplateFields(command)).toEqual(['repository']);
    expect(renderCliActionCommand(command, { repository: 'octo/example' }))
      .toBe('gh aw update --repo octo/example --source octo/example');
  });

  it.each([
    [{}, 'missing or invalid'],
    [{ repository: 'octo/example --force' }, 'not a safe command token'],
    [{ repository: 'octo' }, 'not a safe command token'],
    [{ repository: '-/example' }, 'not a safe command token']
  ])('rejects unsafe repository template values', (values, message) => {
    expect(() => renderCliActionCommand(
      'gh aw update --repo {{repository}}',
      values
    )).toThrow(message);
  });

  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => '', output })
      };
    });
    vi.resetModules();
    const { renderCliActionCommand: renderWithoutDebug } = await import('../../src/cli-action-template.js');

    renderWithoutDebug('gh aw update --repo {{repository}}', { repository: 'octo/example' });
    expect(() => renderWithoutDebug('gh aw update --repo {{repository}}', {})).toThrow();

    expect(output.debug).not.toHaveBeenCalled();

    vi.doUnmock('../../src/debug.js');
    vi.resetModules();
  });

  it('logs only scalar metadata under its predictable category when enabled', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=cli-action-template', output })
      };
    });
    vi.resetModules();
    const { renderCliActionCommand: renderWithDebug } = await import('../../src/cli-action-template.js');

    renderWithDebug('gh aw update --repo {{repository}}', { repository: 'octo/example' });
    expect(output.debug).toHaveBeenCalledWith('[cao:cli-action-template]', { event: 'render-completed', fieldCount: 1 });

    expect(() => renderWithDebug('gh aw update --repo {{repository}}', {}))
      .toThrow('missing or invalid');
    expect(output.debug).toHaveBeenCalledWith('[cao:cli-action-template]', {
      event: 'render-rejected',
      field: 'repository',
      reason: 'missing-or-invalid'
    });

    expect(() => renderWithDebug('gh aw update --repo {{repository}}', { repository: 'octo' }))
      .toThrow('not a safe command token');
    expect(output.debug).toHaveBeenCalledWith('[cao:cli-action-template]', {
      event: 'render-rejected',
      field: 'repository',
      reason: 'unsafe-token'
    });

    for (const call of output.debug.mock.calls) {
      const metadata = call[1];
      expect(Object.values(metadata).every((value) => typeof value !== 'object')).toBe(true);
    }

    vi.doUnmock('../../src/debug.js');
    vi.resetModules();
  });
});
