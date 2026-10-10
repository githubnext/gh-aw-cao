import { describe, expect, it } from 'vitest';
import { validateDashboardDocument } from '../../src/validator.js';
import { nearestIdentifier } from '../../src/validator-common.js';

const document = {
  'language-version': '0.1.0',
  dashboard: {
    id: 'authoring-eval',
    title: 'Authoring eval',
    queries: [{ name: 'recent-runs', subject: 'Recent runs', from: 'runs', select: [{ field: 'run' }] }],
    pages: [{
      id: 'summary',
      kind: 'custom',
      views: [{
        id: 'run-count',
        data: { source: 'recent-runs' },
        mark: 'metric',
        encoding: { value: { field: 'run', aggregate: 'count' } }
      }]
    }]
  }
};

describe('dashboard authoring diagnostic eval', () => {
  it.each([
    ['mistyped source', (/** @type {any} */ value) => { value.dashboard.queries[0].from = 'runns'; }, '$.dashboard.queries[0].from', 'Did you mean "runs"?'],
    ['mistyped field beyond the displayed field list', (/** @type {any} */ value) => { value.dashboard.queries[0].select[0].field = 'runn'; }, '$.dashboard.queries[0].select[0].field', 'Did you mean "run"?'],
    ['mistyped query clause', (/** @type {any} */ value) => { value.dashboard.queries[0].aggregrate = {}; }, '$.dashboard.queries[0].aggregrate', 'Did you mean "aggregate"?']
  ])('%s points to a concrete correction', (_label, mutate, path, hint) => {
    const input = structuredClone(document);
    mutate(input);
    const result = validateDashboardDocument(JSON.stringify(input));
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path, message: expect.stringContaining(hint) })
    ]));
  });

  it('does not invent a correction when the match is ambiguous or distant', () => {
    expect(nearestIdentifier('foa', ['foo', 'for'])).toBeUndefined();
    expect(nearestIdentifier('missing', ['run', 'repository'])).toBeUndefined();
    expect(nearestIdentifier('x'.repeat(100), ['runs'])).toBeUndefined();
    expect(nearestIdentifier('rnu', ['rnu', 'run'])).toBeUndefined();
  });

  it('suggests a transposed identifier when the correction is unique', () => {
    expect(nearestIdentifier('rnu', ['run'])).toBe('run');
  });

  it('accepts the document after applying the indicated corrections', () => {
    const input = structuredClone(document);
    expect(validateDashboardDocument(JSON.stringify(input))).toMatchObject({ ok: true, errors: [] });
  });
});
