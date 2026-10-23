import databaseQueries from '../dashboard/site/src/data/queries/database.json' with { type: 'json' };
import { queryInputNames } from '../dashboard/site/src/data/queries/declarative.js';

const DETAIL_STORES = new Set([
  'runs', 'tools', 'domains', 'skills', 'friction', 'audits', 'issues',
  'experimentAssignments', 'graderObservations', 'evalObservations'
]);

/**
 * A migration inventory, not an execution planner. An additive reducer alone
 * cannot prove aggregate eligibility: filters, joins, time boundaries, and
 * observation denominators must also be representable at the aggregate grain.
 *
 * @param {{ dashboard: { queries: Record<string, any>[] } }} document
 */
export function queryStorageInventory(document) {
  const queries = document.dashboard.queries;
  const definitions = new Map([
    ...databaseQueries.map((query) => [query.name, query]),
    ...queries.map((query) => [query.name, query])
  ]);

  /** @param {string} name */
  function dependencies(name) {
    const visited = new Set();
    const stores = new Set();
    const unresolved = new Set();
    const stages = [];
    const pending = [name];
    while (pending.length) {
      const source = pending.pop();
      if (visited.has(source)) continue;
      visited.add(source);
      if (source.startsWith('$')) {
        stores.add(source.slice(1));
        continue;
      }
      const definition = definitions.get(source);
      if (!definition) {
        if (DETAIL_STORES.has(source)) stores.add(source);
        else unresolved.add(source);
        continue;
      }
      stages.push(definition);
      for (const store of definition.stores ?? []) stores.add(store);
      pending.push(...queryInputNames(definition));
    }
    return { stores: [...stores].sort(), unresolved: [...unresolved].sort(), stages };
  }

  return {
    version: 1,
    purpose: 'Migration review only; does not select a runtime storage layer.',
    invariants: [
      'Never infer population totals by counting retained statistical samples.',
      'Aggregate eligibility requires equivalent filters, dimensions, UTC boundaries, and observation counts.',
      'Distinct counts and arbitrary historical filters are not additive daily metrics.',
      'Retained execution navigation requires hot or statistical detail.',
      'No query is marked migrated until its executable declaration and contract tests change.'
    ],
    queries: [...queries].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
      .map((query) => {
        const { stores, unresolved, stages } = dependencies(query.name);
        const detail = stores.some((store) => DETAIL_STORES.has(store));
        const reducers = [...new Set(stages.flatMap((stage) =>
          (stage.aggregate?.values ?? []).map((value) => value.reducer)))].sort();
        const hasAggregate = reducers.length > 0;
        const blockers = [];
        if (detail && hasAggregate) {
          blockers.push('Verify aggregate grain, predicates, observation denominators, and partial-day boundaries.');
        }
        if (reducers.some((reducer) => !['sum', 'count'].includes(reducer))) {
          blockers.push('Non-additive reducers require sufficient statistics or retained details; do not sum daily distinct counts or average daily averages.');
        }
        if (detail && stages.some((stage) => stage.joins?.length)) {
          blockers.push('Verify join cardinality and historical attribution before replacing execution evidence.');
        }
        if (unresolved.length) {
          blockers.push('Resolve external or runtime sources before assigning a storage tier.');
        }
        return {
          id: query.name,
          subject: query.subject ?? '',
          objective: query.objective ?? '',
          acceptance: query.acceptance ?? '',
          stores,
          'external-sources': unresolved,
          reducers,
          status: detail ? (hasAggregate ? 'mixed-layer-review-required' : 'remains-detail-based') : 'unchanged',
          'preferred-layer': detail
            ? (hasAggregate ? 'daily-aggregates-where-equivalent; otherwise hot/statistical' : 'hot; statistical for older retained examples')
            : 'inventory-or-external',
          migrated: false,
          blockers
        };
      })
  };
}
