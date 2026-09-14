import { DASHBOARD_QUERY_LIMITS } from './queries/declarative.js';

const TABLE_ROW_LIMITS = {
  constrained: 10000,
  modest: 25000,
  standard: 50000,
  maximum: DASHBOARD_QUERY_LIMITS['max-output-rows']
};

/**
 * @param {{ deviceMemory?: number, heapSizeLimit?: number, hardwareConcurrency?: number, mobile?: boolean }} environment
 */
export function tableRowLimitForEnvironment(environment) {
  if (environment.mobile === true) return TABLE_ROW_LIMITS.constrained;
  const limits = [];
  const deviceMemory = Number(environment.deviceMemory);
  if (Number.isFinite(deviceMemory)) {
    limits.push(deviceMemory <= 2
      ? TABLE_ROW_LIMITS.constrained
      : deviceMemory <= 4
        ? TABLE_ROW_LIMITS.modest
        : deviceMemory <= 8
          ? TABLE_ROW_LIMITS.standard
          : TABLE_ROW_LIMITS.maximum);
  }
  const heapSizeLimit = Number(environment.heapSizeLimit);
  if (Number.isFinite(heapSizeLimit)) {
    const gibibytes = heapSizeLimit / (1024 ** 3);
    limits.push(gibibytes <= 1
      ? TABLE_ROW_LIMITS.constrained
      : gibibytes <= 2
        ? TABLE_ROW_LIMITS.modest
        : gibibytes <= 4
          ? TABLE_ROW_LIMITS.standard
          : TABLE_ROW_LIMITS.maximum);
  }
  if (limits.length > 0) return Math.min(...limits);
  return Number(environment.hardwareConcurrency) <= 4
    ? TABLE_ROW_LIMITS.modest
    : TABLE_ROW_LIMITS.standard;
}

/** @param {Window} browserWindow */
export function browserTableCapacityDecision(browserWindow) {
  const browserNavigator = /** @type {Navigator & { deviceMemory?: number, userAgentData?: { mobile?: boolean } }} */ (
    browserWindow.navigator
  );
  const browserPerformance = /** @type {Performance & { memory?: { jsHeapSizeLimit?: number } }} */ (
    browserWindow.performance
  );
  const environment = {
    deviceMemory: browserNavigator.deviceMemory,
    heapSizeLimit: browserPerformance.memory?.jsHeapSizeLimit,
    hardwareConcurrency: browserNavigator.hardwareConcurrency,
    mobile: browserNavigator.userAgentData?.mobile === true
      || (typeof browserWindow.matchMedia === 'function'
        && browserWindow.matchMedia('(pointer: coarse) and (max-width: 768px)').matches)
  };
  const heapSizeLimit = Number(environment.heapSizeLimit);
  return {
    rowLimit: tableRowLimitForEnvironment(environment),
    mobile: environment.mobile,
    deviceMemoryGiB: Number.isFinite(environment.deviceMemory) ? environment.deviceMemory : null,
    heapSizeLimitGiB: Number.isFinite(heapSizeLimit)
      ? Math.round(heapSizeLimit / (1024 ** 3) * 10) / 10
      : null,
    hardwareConcurrency: Number.isFinite(environment.hardwareConcurrency)
      ? environment.hardwareConcurrency
      : null
  };
}

/**
 * @param {ReturnType<typeof browserTableCapacityDecision>} decision
 * @param {{ info: (...data: unknown[]) => void }} [logger]
 */
export function logTableCapacityDecision(decision, logger = console) {
  logger.info('[dashboard-table-capacity]', decision);
}

/**
 * @param {unknown[]} queries
 * @param {Iterable<string>} tableSourceNames
 */
export function applyTableQuerySafetyLimits(queries, tableSourceNames) {
  const tableSources = new Set(tableSourceNames);
  const queryNames = new Set(queries.flatMap((query) => (
    query && typeof query === 'object' && !Array.isArray(query)
      && typeof /** @type {Record<string, unknown>} */ (query).name === 'string'
      ? [/** @type {Record<string, string>} */ (query).name]
      : []
  )));
  const dependencies = new Set(queries.flatMap((query) => {
    if (!query || typeof query !== 'object' || Array.isArray(query)) return [];
    const definition = /** @type {Record<string, unknown>} */ (query);
    const joins = Array.isArray(definition.joins) ? definition.joins : [];
    return [
      definition.from,
      ...joins.map((join) => (
        join && typeof join === 'object' && !Array.isArray(join)
          ? /** @type {Record<string, unknown>} */ (join).source
          : undefined
      ))
    ].filter((name) => typeof name === 'string' && queryNames.has(name));
  }));
  return queries.map((query) => {
    if (!query || typeof query !== 'object' || Array.isArray(query)) return query;
    const definition = /** @type {Record<string, unknown>} */ (query);
    if (typeof definition.name !== 'string'
        || !tableSources.has(definition.name)
        || dependencies.has(definition.name)) return query;
    const declaredLimit = Number(definition.limit);
    return {
      ...definition,
      limit: Number.isSafeInteger(declaredLimit) && declaredLimit > 0
        ? Math.min(declaredLimit, DASHBOARD_QUERY_LIMITS['max-output-rows'])
        : DASHBOARD_QUERY_LIMITS['max-output-rows']
    };
  });
}
