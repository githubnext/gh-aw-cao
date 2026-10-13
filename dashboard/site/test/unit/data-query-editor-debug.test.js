import { afterEach, describe, expect, it, vi } from 'vitest';

import previewFixture from '../fixtures/query-editor.json' with { type: 'json' };

const previewDocument = () => structuredClone(previewFixture);

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('query editor data validation debug logging', () => {
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
    const { validateQueryEditorDocument } = await import('../../src/data/query-editor.js');

    validateQueryEditorDocument(JSON.stringify(previewDocument()));
    validateQueryEditorDocument('not json at all');
    validateQueryEditorDocument('');

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs accepted and rejected outcomes under the predictable data:query-editor category when enabled', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=data:query-editor', output })
      };
    });
    vi.resetModules();
    const { validateQueryEditorDocument } = await import('../../src/data/query-editor.js');

    const accepted = validateQueryEditorDocument(JSON.stringify(previewDocument()));
    expect(accepted.ok).toBe(true);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:data:query-editor]',
      expect.objectContaining({ operation: 'validate-document', status: 'accepted', viewCount: 1, sourceCount: 1 })
    );

    output.debug.mockClear();
    const boundsRejected = validateQueryEditorDocument('');
    expect(boundsRejected.ok).toBe(false);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:data:query-editor]',
      { operation: 'validate-document', status: 'rejected', reason: 'bounds' }
    );

    output.debug.mockClear();
    const schemaRejected = validateQueryEditorDocument('not valid json');
    expect(schemaRejected.ok).toBe(false);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:data:query-editor]',
      expect.objectContaining({ operation: 'validate-document', status: 'rejected', reason: 'schema' })
    );
  });

  it('never logs document content, only scalar metadata', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=data:query-editor', output })
      };
    });
    vi.resetModules();
    const { validateQueryEditorDocument } = await import('../../src/data/query-editor.js');

    validateQueryEditorDocument(JSON.stringify(previewDocument()));
    validateQueryEditorDocument('');
    validateQueryEditorDocument('not valid json');

    expect(output.debug.mock.calls.length).toBeGreaterThan(0);
    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain('Workflow failures');
      expect(serialized).not.toContain('failure-counts');
    }
  });
});
