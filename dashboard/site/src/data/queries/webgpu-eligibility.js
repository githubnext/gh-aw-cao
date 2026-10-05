export const MIN_GPU_ROWS = 4096;
export const MIN_GPU_INT = -2147483648;
export const MAX_GPU_INT = 2147483647;

/**
 * Structural eligibility only. The worker also checks row count, numeric
 * column values, device availability and cancellation at execution time.
 * @param {Record<string, any>} query
 * @param {Set<string>} queryNames
 */
export function webGpuFilterEligibility(query, queryNames) {
  const predicate = query.filter?.predicates?.[0];
  if (!predicate) return { status: 'no-filter' };
  if (query.union?.length || query.joins?.length || queryNames.has(query.from)) {
    return { status: 'complex-input' };
  }
  if (query.filter.predicates.length !== 1 || query.filter.search?.query
      || typeof predicate.field !== 'string' || predicate.field === '@time'
      || predicate.optional || typeof predicate.equals !== 'number'
      || !Number.isInteger(predicate.equals)
      || predicate.equals <= MIN_GPU_INT || predicate.equals > MAX_GPU_INT
      || predicate.in !== undefined || predicate.includes !== undefined
      || predicate.gte !== undefined || predicate.lt !== undefined) {
    return { status: 'unsupported-filter' };
  }
  return { status: 'candidate', field: predicate.field };
}
