import { timestampMilliseconds } from '../model/schema.js';

/** @typedef {{ id: string, visibility: 'visible' | 'hidden' | 'unavailable' }} CalloutVisibility */

/**
 * Executes Dashboard Language callout conditions in the data worker. Only these
 * bounded visibility results, never source rows, are consumed by notification UI.
 * @param {import('../../components/site-callout.js').SiteCallout[]} callouts
 * @param {Record<string, import('../../presenter.js').LogicalSourceInput>} sources
 * @param {AbortSignal} [signal]
 * @returns {CalloutVisibility[]}
 */
export function queryCalloutVisibility(callouts, sources, signal) {
  const now = Date.now();
  return callouts.map((callout) => {
    signal?.throwIfAborted();
    const condition = callout['visible-when'];
    if (!condition) return { id: callout.id, visibility: 'visible' };
    const source = sources[condition.source];
    if (!source || source.metadata?.availability === 'unavailable') {
      return { id: callout.id, visibility: 'unavailable' };
    }
    const visible = source.rows.some((row) => {
      signal?.throwIfAborted();
      if (condition['older-than-hours'] === undefined) return row[condition.field] === condition.equals;
      const value = row[condition.field];
      const timestamp = typeof value === 'number' && Number.isFinite(value) ? value : timestampMilliseconds(value);
      return timestamp !== null && now - timestamp >= condition['older-than-hours'] * 3_600_000;
    });
    return { id: callout.id, visibility: visible ? 'visible' : 'hidden' };
  });
}
