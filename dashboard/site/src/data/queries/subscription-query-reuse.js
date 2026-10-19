import { dashboardQueryDefects, dashboardQueryIndex, resolveDashboardQuerySources } from './declarative.js';

/** @typedef {import('../../presenter.js').LogicalSourceInput} Source */

/**
 * Reuse only the last compact, identical view result in one subscription flush.
 * Compiled view names differ, but source identities and every executable clause
 * must match. Nothing survives the flush or a canonical revision change.
 */
export function createSubscriptionQueryReuse() {
  /** @type {{ key: string, sources: Source[] } | undefined} */
  let previous;
  return {
    /**
     * @param {unknown} definitions
     * @param {string[]} aliases
     */
    key(definitions, aliases) {
      if (!aliases.length || dashboardQueryDefects(definitions).size) return undefined;
      const index = dashboardQueryIndex(definitions);
      const required = resolveDashboardQuerySources(definitions, aliases);
      const queries = required.flatMap((name) => {
        const definition = index.get(name);
        return definition ? [definition] : [];
      });
      const names = new Map(queries.map((query, position) => [query.name, position]));
      /** @param {string} name */
      const reference = (name) => names.has(name) ? ['query', names.get(name)] : ['source', name];
      return JSON.stringify([
        aliases.map(reference),
        queries.map((query) => ({
          ...query,
          name: names.get(query.name),
          from: reference(query.from),
          ...(query.union ? { union: query.union.map(reference) } : {}),
          ...(query.joins ? { joins: query.joins.map((join) => ({
            ...join, source: reference(join.source)
          })) } : {})
        }))
      ]);
    },
    /** @param {string | undefined} key @param {string[]} aliases */
    read(key, aliases) {
      const entry = previous;
      if (!key || entry?.key !== key) return undefined;
      return Object.fromEntries(aliases.map((name, position) => {
        const source = entry.sources[position];
        return [name, {
          ...source, source: name,
          metadata: { ...source.metadata, 'source-id': `${name}-query`, 'query-name': name }
        }];
      }));
    },
    /** @param {string | undefined} key @param {string[]} aliases @param {Record<string, Source>} sources */
    write(key, aliases, sources) {
      previous = undefined;
      const selected = aliases.map((name) => sources[name]);
      if (!key || selected.some((source, position) => (
        !source || !['available', 'empty'].includes(String(source.metadata?.availability))
        || source.metadata?.['query-diagnostic'] || source.metadata?.['query-error']
        || source.metadata?.['query-name'] !== aliases[position]
        || source.metadata?.['source-id'] !== `${aliases[position]}-query`
      )) || selected.reduce((count, source) => count + source.rows.length, 0) > 1000) return;
      let bytes = 2 + Math.max(0, selected.length - 1);
      const encoder = new TextEncoder();
      for (const source of selected) {
        bytes += encoder.encode(JSON.stringify({ ...source, rows: [] })).byteLength
          + Math.max(0, source.rows.length - 1);
        for (const row of source.rows) {
          bytes += encoder.encode(JSON.stringify(row)).byteLength;
          if (bytes > 1024 * 1024) return;
        }
      }
      if (bytes > 1024 * 1024) return;
      previous = { key, sources: selected };
    }
  };
}
