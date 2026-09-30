import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/**
 * @param {ReturnType<typeof vi.fn>} debugFn
 * @param {string} search
 */
function mockDebugModule(debugFn, search) {
  const output = /** @type {Pick<Console, 'debug'>} */ ({ debug: debugFn });
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
}

/** @param {Partial<Record<string, unknown>>} overrides */
function outcome(overrides = {}) {
  return {
    'workflow-name': 'Daily review',
    'outcome-category': 'pull-request',
    'outcome-status': 'closed',
    'outcome-state': 'lifecycle-close',
    'rollout-mode': 'live',
    'outcome-body-html': '<p>Safe content</p><script>window.bad = true</script>',
    ...overrides
  };
}

describe('outcome-detail-sections debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '');
    const { renderOutcomeDetailSection } = await import('../../src/components/outcome-detail-sections.js');

    renderOutcomeDetailSection(outcome(), 'discussion');
    renderOutcomeDetailSection(outcome(), 'metadata');
    renderOutcomeDetailSection(outcome(), 'unsupported');

    expect(debugFn).not.toHaveBeenCalled();
  });

  it('logs discussion sanitization with predictable category and dropped-node count', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=outcome-detail-sections');
    const { renderOutcomeDetailSection } = await import('../../src/components/outcome-detail-sections.js');

    renderOutcomeDetailSection(outcome(), 'discussion');

    expect(debugFn).toHaveBeenCalledWith('[cao:outcome-detail-sections]', {
      event: 'discussion-sanitized',
      outputNodes: 1,
      droppedNodes: 1
    });
  });

  it('logs metadata resolution with link presence booleans, not link values', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=outcome-detail-sections');
    const { renderOutcomeDetailSection } = await import('../../src/components/outcome-detail-sections.js');

    renderOutcomeDetailSection(outcome({
      'external-link': { href: 'https://github.com/octo/repo/pull/1', label: 'View output' }
    }), 'metadata');

    expect(debugFn).toHaveBeenCalledWith('[cao:outcome-detail-sections]', {
      event: 'metadata-resolved',
      hasSourceLink: true,
      hasRunLink: false,
      hasWorkflowLink: false
    });
  });

  it('logs an unknown-section-body event without rendering', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=outcome-detail-sections');
    const { renderOutcomeDetailSection } = await import('../../src/components/outcome-detail-sections.js');

    const result = renderOutcomeDetailSection(outcome(), 'unsupported');

    expect(result).toBeNull();
    expect(debugFn).toHaveBeenCalledWith('[cao:outcome-detail-sections]', {
      event: 'unknown-section-body',
      requested: 'unsupported'
    });
  });

  it('never logs record content, HTML, or link values, only scalar metadata', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=outcome-detail-sections');
    const { renderOutcomeDetailSection } = await import('../../src/components/outcome-detail-sections.js');

    renderOutcomeDetailSection(outcome({
      'external-link': { href: 'https://github.com/octo/repo/pull/1', label: 'View output' },
      'run-link': { href: 'https://github.com/octo/repo/actions/runs/1', label: 'View run' }
    }), 'discussion');
    renderOutcomeDetailSection(outcome({
      'external-link': { href: 'https://github.com/octo/repo/pull/1', label: 'View output' }
    }), 'metadata');

    for (const call of debugFn.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
