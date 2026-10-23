// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

/** @param {string} search */
async function load(search) {
  const output = { debug: vi.fn() };
  vi.doMock('../../src/debug.js', async () => {
    const actual = /** @type {typeof import('../../src/debug.js')} */ (await vi.importActual('../../src/debug.js'));
    return { ...actual, createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => search, output }) };
  });
  vi.resetModules();
  const module = await import('../../src/data/model/workflow-value-collection.js');
  return { ...module, output };
}

/** @param {Record<string, unknown>} [extra] */
function record(extra = {}) {
  return {
    schemaVersion: 1, id: 'workflow-value-collection:owner%2Frepo%3Aci', repository: 'owner/repo', workflow: 'ci',
    sourcePath: '.github/workflows/ci.md', observedAt: '2026-01-01T00:00:00Z', policyDigest: 'a'.repeat(64),
    registration: 'enabled', collector: 'collectors/ci.mjs', state: 'available', reasonCode: 'captured',
    reason: 'Accepted evidence is available at its original capture and cutoff dates.', ...extra
  };
}

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('workflow-value-collection debug logging', () => {
  it('is disabled by default', async () => {
    const { mergeWorkflowValueCollection, output } = await load('');
    mergeWorkflowValueCollection(undefined, record());
    expect(() => mergeWorkflowValueCollection(undefined, record({ schemaVersion: 2 }))).toThrow();
    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs merges and rejections under the predictable category without record content', async () => {
    const { mergeWorkflowValueCollection, output } = await load('?debug=workflow-value-collection');
    mergeWorkflowValueCollection(undefined, record());
    expect(output.debug).toHaveBeenLastCalledWith('[cao:workflow-value-collection]', { event: 'merged', hadPrevious: false, decision: 'incoming' });

    mergeWorkflowValueCollection(record(), record({ observedAt: '2025-12-31T00:00:00Z' }));
    expect(output.debug).toHaveBeenLastCalledWith('[cao:workflow-value-collection]', { event: 'merged', hadPrevious: true, decision: 'previous' });

    expect(() => mergeWorkflowValueCollection(undefined, record({ schemaVersion: 2 }))).toThrow(TypeError);
    expect(output.debug).toHaveBeenLastCalledWith('[cao:workflow-value-collection]', { event: 'validation-rejected' });
  });

  it('logs conflicts with scalar metadata only', async () => {
    const { mergeWorkflowValueCollection, output } = await load('?debug=workflow-value-collection');
    expect(() => mergeWorkflowValueCollection(record(), record({ policyDigest: 'b'.repeat(64) }))).toThrow(/decisions/);
    expect(output.debug).toHaveBeenLastCalledWith('[cao:workflow-value-collection]', { event: 'merge-conflict', kind: 'decision' });
    for (const [, payload] of output.debug.mock.calls) {
      expect(JSON.stringify(payload)).not.toMatch(/owner|collectors|aaaa/);
    }
  });
});
