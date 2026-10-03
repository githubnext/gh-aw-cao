// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalize } from '../../src/data/normalize/index.js';

/** @type {Record<string, unknown>} */
const RUN = {
  id: 'run:curation',
  startedAt: '2026-10-01T00:00:00Z',
  createdAt: '2026-10-01T00:00:00Z',
  status: 'completed',
  conclusion: 'success'
};

/** Batch with one discardable Audit (a redundant start marker) and one retained Audit (unknown evidence). */
function batch() {
  const result = normalize([]);
  result.runs = [/** @type {any} */ (RUN)];
  result.audits = /** @type {any} */ ([
    {
      id: 'audit:redundant-start', runId: 'run:curation', timestamp: '2026-10-01T00:00:00Z',
      source: 'gh-aw-logs', type: 'workflow_run_started', status: 'completed', summary: ''
    },
    {
      id: 'audit:unique-finding', runId: 'run:curation', timestamp: '2026-10-01T00:05:00Z',
      source: 'audit', type: 'audit.finding', status: 'low', summary: 'Specific diagnosis', diagnosis: 'Specific evidence'
    }
  ]);
  return result;
}

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('audit curation debug logging', () => {
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
    const { curateBatchAudits } = await import('../../src/data/model/audit-curation.js');

    curateBatchAudits(batch());

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs curation outcome counts under its predictable category when enabled', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=audit-curation', output })
      };
    });
    vi.resetModules();
    const { curateBatchAudits } = await import('../../src/data/model/audit-curation.js');

    const curated = curateBatchAudits(batch());

    expect(curated.map((audit) => audit.id)).toEqual(['audit:unique-finding']);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:audit-curation]',
      { event: 'curate-complete', auditCount: 2, retainedCount: 1, discardedCount: 1 }
    );
  });

  it('never logs sensitive Audit content, only scalar metadata', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=audit-curation', output })
      };
    });
    vi.resetModules();
    const { curateBatchAudits } = await import('../../src/data/model/audit-curation.js');

    curateBatchAudits(batch());

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toContain('audit:unique-finding');
      expect(JSON.stringify(payload)).not.toContain('Specific evidence');
      expect(JSON.stringify(payload)).not.toContain('Specific diagnosis');
    }
  });
});
