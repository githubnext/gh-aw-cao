import { describe, expect, it } from 'vitest';
import { createSubscriptionQueryReuse } from '../../src/data/queries/subscription-query-reuse.js';
import { executeDashboardQueries } from '../../src/data/queries/declarative.js';
import { compileDashboardViewPayloadQueries } from '../../src/data/queries/view-payload-compiler.js';
import { authoritativeDashboard } from '../authoritative-dashboard.js';

/** @param {string} name @param {Record<string, unknown>[]} [rows] */
function result(name, rows = [{ campaign: 'alpha' }]) {
  return executeDashboardQueries([{ name, from: 'campaigns' }], {
    campaigns: { source: 'campaigns', rows, metadata: {
      'source-id': 'fixture', 'source-kind': 'fixture',
      'as-of': '2026-10-19T12:00:00Z', 'retrieved-at': '2026-10-19T12:00:00Z',
      availability: 'available', completeness: 'complete', freshness: 'fresh'
    } }
  }, [name]);
}

describe('subscription-flush query reuse', () => {
  it('normalizes compiled dependency references, not literal values or canonical source identities', () => {
    const reuse = createSubscriptionQueryReuse();
    const queries = authoritativeDashboard.dashboard.queries;
    const page = authoritativeDashboard.dashboard.pages.find((/** @type {{ id: string }} */ candidate) => candidate.id === 'campaigns');
    const first = compileDashboardViewPayloadQueries(page, 'campaigns', { queries, viewId: 'campaigns-dispatches' });
    const second = compileDashboardViewPayloadQueries(page, 'campaigns', { queries, viewId: 'campaigns-inventory' });
    expect(reuse.key([...queries, ...first.queries], first.aliases))
      .toEqual(reuse.key([...queries, ...second.queries], second.aliases));
    const key = reuse.key([{ name: 'one', from: 'campaigns' }], ['one']);
    expect(key).not.toEqual(reuse.key([{ name: 'one', from: 'repositories' }], ['one']));
    expect(reuse.key([{ name: 'one', from: 'campaigns', filter: { predicates: [{ field: 'campaign', equals: 'one' }] } }], ['one']))
      .not.toEqual(reuse.key([{ name: 'two', from: 'campaigns', filter: { predicates: [{ field: 'campaign', equals: 'two' }] } }], ['two']));
    for (const queryContext of [
      { timeWindow: { start: '2026-10-18T00:00:00Z', end: '2026-10-19T00:00:00Z' } },
      { search: { fields: ['campaign-name'], query: 'alpha' } },
      { orderBy: [{ field: 'campaign-name', direction: /** @type {const} */ ('desc') }] }
    ]) {
      const scoped = compileDashboardViewPayloadQueries(page, 'campaigns', { queries, viewId: 'campaigns-dispatches', queryContext });
      expect(reuse.key([...queries, ...scoped.queries], scoped.aliases))
        .not.toEqual(reuse.key([...queries, ...first.queries], first.aliases));
    }
  });

  it('rebinds derived metadata and leaves pagination and the next flush independent', () => {
    const reuse = createSubscriptionQueryReuse();
    reuse.write('same', ['first'], result('first'));
    expect(reuse.read('same', ['second'])).toEqual(result('second'));
    expect(reuse.read('different', ['second'])).toBeUndefined();
    expect(createSubscriptionQueryReuse().read('same', ['second'])).toBeUndefined();
  });

  it('does not retain invalid graphs, failures, native metadata, or oversized payloads', () => {
    const reuse = createSubscriptionQueryReuse();
    expect(reuse.key([{ name: 'bad', from: 'bad' }], ['bad'])).toBeUndefined();
    expect(reuse.key([], [])).toBeUndefined();
    const failed = result('first');
    failed.first.metadata.availability = 'unavailable';
    reuse.write('failure', ['first'], failed);
    expect(reuse.read('failure', ['second'])).toBeUndefined();
    const native = result('first');
    native.first.metadata['source-id'] = 'canonical-source';
    reuse.write('native', ['first'], native);
    expect(reuse.read('native', ['second'])).toBeUndefined();
    reuse.write('rows', ['first'], result('first', Array.from({ length: 1001 }, () => ({ campaign: 'alpha' }))));
    expect(reuse.read('rows', ['second'])).toBeUndefined();
    reuse.write('bytes', ['first'], result('first', [{ campaign: 'a'.repeat(1024 * 1024) }]));
    expect(reuse.read('bytes', ['second'])).toBeUndefined();
  });
});
