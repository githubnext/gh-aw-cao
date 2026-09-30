// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

const VALID_ROUTE = 'githubnext/gh-aw-cao:.github/workflows/ambient-context.md';

/** @param {{ search: string, output: { debug: import('vitest').Mock } }} options */
async function importWorkflowRouteWithDebug({ search, output }) {
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
  return import('../../src/components/workflow-route.js');
}

describe('workflow-route debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const output = { debug: vi.fn() };
    const module = await importWorkflowRouteWithDebug({ search: '', output });

    module.parseWorkflowRoute(VALID_ROUTE);
    module.parseWorkflowRoute('invalid');
    module.workflowRouteValue('githubnext/gh-aw-cao', '.github/workflows/ambient-context.md');

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('is selected by the predictable "workflow-route" category derived from the filename, not enabled by unrelated categories', async () => {
    const output = { debug: vi.fn() };
    const module = await importWorkflowRouteWithDebug({ search: '?debug=some-other-category', output });

    module.parseWorkflowRoute(VALID_ROUTE);

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs valid and invalid parse outcomes and format calls under its predictable category when enabled', async () => {
    const output = { debug: vi.fn() };
    const module = await importWorkflowRouteWithDebug({ search: '?debug=workflow-route', output });

    const route = module.parseWorkflowRoute(VALID_ROUTE);
    expect(route).toEqual({ repository: 'githubnext/gh-aw-cao', workflow: '.github/workflows/ambient-context.md' });
    expect(output.debug).toHaveBeenCalledWith('[cao:workflow-route]', {
      operation: 'parse',
      status: 'valid',
      inputLength: VALID_ROUTE.length
    });

    output.debug.mockClear();
    const invalid = module.parseWorkflowRoute('not-a-route');
    expect(invalid).toBeNull();
    expect(output.debug).toHaveBeenCalledWith('[cao:workflow-route]', {
      operation: 'parse',
      status: 'invalid',
      inputLength: 'not-a-route'.length
    });

    output.debug.mockClear();
    const formatted = module.workflowRouteValue('githubnext/gh-aw-cao', '.github/workflows/ambient-context.md');
    expect(formatted).toBe(VALID_ROUTE);
    expect(output.debug).toHaveBeenCalledWith('[cao:workflow-route]', {
      operation: 'format',
      status: 'formatted',
      outputLength: VALID_ROUTE.length
    });
  });

  it('never logs sensitive payload content, only scalar metadata', async () => {
    const output = { debug: vi.fn() };
    const module = await importWorkflowRouteWithDebug({ search: '?debug=workflow-route', output });

    module.parseWorkflowRoute(VALID_ROUTE);
    module.parseWorkflowRoute('<invalid>');
    module.workflowRouteValue('githubnext/gh-aw-cao', '.github/workflows/ambient-context.md');

    expect(output.debug.mock.calls.length).toBeGreaterThan(0);
    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
