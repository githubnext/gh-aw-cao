import { tidy } from '../../data-operations.js';
import { createDebug } from '../../debug.js';
import { DASHBOARD_QUERY_LIMITS } from './declarative.js';

const debugIncrementalAggregate = createDebug('incremental-aggregate');

/**
 * Storage-native reduction retains scalar state, never partial distinct counts.
 * Input order and the ordinary reducer's grouping/coercion semantics are retained.
 * @param {NonNullable<import('./declarative.js').DashboardQuery['aggregate']>} aggregate
 * @param {import('./declarative.js').QueryBudget} budget
 */
export function incrementalAggregate(aggregate, budget) {
  const fields = aggregate.by ?? [];
  /** @type {Map<string, { row: Record<string, unknown>, values: Array<number | Set<string>> }>} */
  const groups = new Map();
  const distinctValues = aggregate.values.map(() => 0);
  /** @param {Record<string, unknown>} row */
  const groupFor = (row) => {
    const key = JSON.stringify(fields.map((field) => row[field]));
    let group = groups.get(key);
    if (!group) {
      if (groups.size >= DASHBOARD_QUERY_LIMITS['max-input-rows']) {
        debugIncrementalAggregate({ event: 'budget-exceeded', limit: 'group-count', groups: groups.size });
        throw new Error('Native aggregate exceeded max-input-rows');
      }
      group = {
        row: Object.fromEntries(fields.map((field) => [field, row[field]])),
        values: aggregate.values.map((value) => value.reducer === 'distinct-count' ? new Set() : 0)
      };
      groups.set(key, group);
    }
    return group;
  };
  return {
    /** @param {Record<string, unknown>[]} rows */
    append(rows) {
      for (const row of rows) {
        budget.spend(1 + aggregate.values.reduce((cost, value) => cost + 1 + (
          value.filter?.predicates.reduce((sum, predicate) => sum + 1 + (predicate.in?.length ?? 0), 0) ?? 0
        ), 0));
        const group = groupFor(row);
        aggregate.values.forEach((value, index) => {
          if (value.filter && tidy([row], [{ op: 'filter', predicates: value.filter.predicates }]).length === 0) return;
          const input = row[value.field];
          if (input == null || input === '') return;
          const state = group.values[index];
          if (state instanceof Set) {
            const key = String(input);
            if (!state.has(key)) {
              if (distinctValues[index] >= DASHBOARD_QUERY_LIMITS['max-input-rows']) {
                debugIncrementalAggregate({ event: 'budget-exceeded', limit: 'distinct-values', valueIndex: index });
                throw new Error('Native aggregate exceeded distinct-value budget');
              }
              state.add(key);
              distinctValues[index]++;
            }
          } else if (value.reducer === 'count') {
            group.values[index] = state + 1;
          } else {
            const numeric = Number(input);
            if (Number.isFinite(numeric)) group.values[index] = state + numeric;
          }
        });
      }
    },
    rows() {
      if (groups.size === 0 && fields.length === 0) groupFor({});
      debugIncrementalAggregate({ event: 'rows-materialized', groups: groups.size, groupFields: fields.length, values: aggregate.values.length });
      return [...groups.values()].map((group) => ({
        ...group.row,
        ...Object.fromEntries(aggregate.values.map((value, index) => {
          const state = group.values[index];
          return [value.as, state instanceof Set ? state.size : state];
        }))
      }));
    }
  };
}
