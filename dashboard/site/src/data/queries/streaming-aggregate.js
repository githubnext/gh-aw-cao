import { tidy } from '../../data-operations.js';
import { DASHBOARD_QUERY_LIMITS } from './declarative.js';

/**
 * Exact incremental reducers: distinct sets span every batch, and sums consume
 * values in source order rather than adding rounded batch subtotals.
 * @param {NonNullable<import('./declarative.js').DashboardQuery['aggregate']>} aggregate
 * @param {import('./declarative.js').QueryBudget} budget
 */
export function createStreamingAggregate(aggregate, budget) {
  if (aggregate.values.some((value) => !['sum', 'count', 'distinct-count'].includes(value.reducer))
      || new Set(aggregate.values.map((value) => value.as)).size !== aggregate.values.length) {
    throw new TypeError('Streaming aggregates require supported reducers with distinct output names');
  }
  const by = aggregate.by ?? [];
  /** @type {Map<string, { row: Record<string, unknown>, distinct: Map<string, Set<string>> }>} */
  const groups = new Map();
  let distinctEntries = 0;
  const distinctReducers = aggregate.values.filter((value) => value.reducer === 'distinct-count').length;
  /** @param {Record<string, unknown>} row */
  function groupFor(row) {
    const key = JSON.stringify(by.map((field) => row[field]));
    let group = groups.get(key);
    if (!group) {
      if (groups.size >= DASHBOARD_QUERY_LIMITS['max-input-rows']) {
        throw new Error('Streaming aggregate exceeded max-input-rows groups');
      }
      group = {
        row: Object.fromEntries([
          ...by.map((field) => [field, row[field]]),
          ...aggregate.values.map((value) => [value.as, 0])
        ]),
        distinct: new Map()
      };
      groups.set(key, group);
    }
    return group;
  }
  return {
    /** @param {Record<string, unknown>[]} rows */
    append(rows) {
      budget.spend(rows.length);
      for (const row of rows) groupFor(row);
      for (const value of aggregate.values) {
        budget.spend(rows.length * (1 + (value.filter?.predicates.reduce(
          (cost, predicate) => cost + 1 + (predicate.in?.length ?? 0), 0
        ) ?? 0)));
        const contributing = value.filter
          ? tidy(rows, [{ op: 'filter', ...value.filter }]) : rows;
        for (const row of contributing) {
          const input = row[value.field];
          if (input == null || input === '') continue;
          const group = groupFor(row);
          if (value.reducer === 'distinct-count') {
            let distinct = group.distinct.get(value.as);
            if (!distinct) {
              distinct = new Set();
              group.distinct.set(value.as, distinct);
            }
            const key = String(input);
            if (!distinct.has(key)) {
              if (distinctEntries >= DASHBOARD_QUERY_LIMITS['max-input-rows'] * distinctReducers) {
                throw new Error('Streaming aggregate exceeded max-input-rows distinct values');
              }
              distinct.add(key);
              distinctEntries += 1;
              group.row[value.as] = distinct.size;
            }
          } else if (value.reducer === 'count') {
            group.row[value.as] = Number(group.row[value.as]) + 1;
          } else {
            const number = Number(input);
            if (Number.isFinite(number)) group.row[value.as] = Number(group.row[value.as]) + number;
          }
        }
      }
      budget.checkpoint();
    },
    rows() {
      budget.checkpoint();
      if (groups.size === 0 && by.length === 0) groupFor({});
      return [...groups.values()].map((group) => group.row);
    }
  };
}
