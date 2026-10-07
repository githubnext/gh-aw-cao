// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Loads action-validator.js with a stubbed debug output so assertions can
 * inspect emitted metadata without depending on module state left over from
 * other tests.
 * @param {string} search
 */
async function loadActionValidatorWithDebug(search) {
  const output = { debug: vi.fn() };
  vi.doMock('../../src/debug.js', async () => {
    const actual = /** @type {typeof import('../../src/debug.js')} */ (
      await vi.importActual('../../src/debug.js')
    );
    return {
      ...actual,
      createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => search, output })
    };
  });
  vi.resetModules();
  const module = await import('../../src/action-validator.js');
  return { ...module, output };
}

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('action-validator debug logging', () => {
  it('is disabled by default when the debug query is absent', async () => {
    const { isReadOnlyCliAction, validWorkflowDispatchArguments, validateActionLevel, output } =
      await loadActionValidatorWithDebug('');

    isReadOnlyCliAction({ command: 'gh aw status' });
    validWorkflowDispatchArguments(['ci.yml']);
    validateActionLevel('not-a-level', 'action.level', []);

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs the read-only CLI check outcome under its predictable category when enabled', async () => {
    const { isReadOnlyCliAction, output } = await loadActionValidatorWithDebug('?debug=action-validator');

    isReadOnlyCliAction({ command: 'gh aw status' });
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:action-validator]',
      { event: 'read-only-cli-check', status: 'allowed', tokenCount: 3 }
    );

    output.debug.mockClear();
    isReadOnlyCliAction({ command: 'gh aw delete-everything' });
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:action-validator]',
      { event: 'read-only-cli-check', status: 'rejected', tokenCount: 3 }
    );
  });

  it('logs the workflow-dispatch argument validation outcome', async () => {
    const { validWorkflowDispatchArguments, output } = await loadActionValidatorWithDebug('?debug=action-validator');

    validWorkflowDispatchArguments(['ci.yml', '--repo', 'owner/repo']);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:action-validator]',
      { event: 'workflow-dispatch-arguments-checked', status: 'valid', argumentCount: 3 }
    );

    output.debug.mockClear();
    validWorkflowDispatchArguments(['ci.yml', '--unknown']);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:action-validator]',
      { event: 'workflow-dispatch-arguments-checked', status: 'invalid', argumentCount: 2 }
    );
  });

  it('logs action-level rejection reasons without logging on success', async () => {
    const { validateActionLevel, output } = await loadActionValidatorWithDebug('?debug=action-validator');

    validateActionLevel('propose', 'action.level', []);
    expect(output.debug).not.toHaveBeenCalled();

    validateActionLevel('not-a-level', 'action.level', []);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:action-validator]',
      { event: 'action-level-rejected', reason: 'unknown-level' }
    );

    output.debug.mockClear();
    validateActionLevel('ui', 'action.level', []);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:action-validator]',
      { event: 'action-level-rejected', reason: 'ui-reserved' }
    );
  });

  it('never logs sensitive payload content, only scalar metadata', async () => {
    const { isReadOnlyCliAction, validWorkflowDispatchArguments, validateActionLevel, output } =
      await loadActionValidatorWithDebug('?debug=action-validator');

    isReadOnlyCliAction({ command: 'gh aw status' });
    validWorkflowDispatchArguments(['ci.yml', '--repo', 'owner/repo']);
    validateActionLevel('ui', 'action.level', []);

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
