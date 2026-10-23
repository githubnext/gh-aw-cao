import { canonicalJson, compareCanonicalStrings } from '../normalize/order.js';

export const TIER_POLICY_VERSION = 1;
export const DAY_MS = 86_400_000;
export const STATISTICAL_WINDOW_MS = 7 * DAY_MS;
export const STORAGE_TIER_CAPACITIES = Object.freeze({
  postgres: Object.freeze({ hot: 16_000, statistical: 64_000 }),
  sqlite: Object.freeze({ hot: 2_000, statistical: 8_000 }),
  indexeddb: Object.freeze({ hot: 1_000, statistical: 16_000 })
});

/**
 * @typedef {{
 *   backend: keyof typeof STORAGE_TIER_CAPACITIES, namespace: string,
 *   watermark: number, seed: string,
 *   capacities?: { hot?: number, statistical?: number },
 *   sourcePrecedence?: Record<string, number>
 * }} StorageTierOptions
 * @typedef {{ id: string, priorityWeight: number, priority: number }} StatisticalCandidate
 */

/**
 * @param {keyof typeof STORAGE_TIER_CAPACITIES} backend
 * @param {{ hot?: number, statistical?: number }} [overrides]
 */
export function storageTierCapacities(backend, overrides = {}) {
  if (!Object.hasOwn(STORAGE_TIER_CAPACITIES, backend)) throw new TypeError('Unknown canonical storage backend');
  const defaults = STORAGE_TIER_CAPACITIES[backend];
  const hot = overrides.hot === undefined ? defaults.hot : overrides.hot;
  const statistical = overrides.statistical === undefined ? defaults.statistical : overrides.statistical;
  if (![hot, statistical].every((value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) {
    throw new TypeError('Hot and statistical capacities must independently be non-negative safe integers');
  }
  return Object.freeze({ hot, statistical });
}

/** @param {unknown} watermark */
export function logicalWatermark(watermark) {
  if (typeof watermark !== 'number' || !Number.isSafeInteger(watermark)
    || !Number.isFinite(new Date(watermark).getTime())) {
    throw new TypeError('An explicit logical watermark in epoch milliseconds is required');
  }
  return watermark;
}

/** @param {number} watermark */
export function metricWeekCutoff(watermark) {
  const date = new Date(logicalWatermark(watermark));
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7) - 14);
  return date.getTime();
}

/** @param {Record<string, unknown>} record */
export function runEventTime(record) {
  for (const field of ['startedAt', 'completedAt']) {
    if (typeof record[field] !== 'string') continue;
    const timestamp = Date.parse(record[field]);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  throw new TypeError('A run requires a valid startedAt or completedAt');
}

/** @param {unknown} value @param {string} name */
export function tierIdentifier(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required`);
  return value;
}

/**
 * Total order for normalized run conflicts. Callers must use a single frozen
 * source precedence map for a ledger's lifetime.
 * @param {Record<string, unknown>} record
 * @param {Record<string, number>} [sourcePrecedence]
 */
export function normalizedRunPrecedence(record, sourcePrecedence = {}) {
  const provenance = /** @type {{ source?: string, sourceId?: string }} */ (record.provenance ?? {});
  const observedAt = typeof record.observedAt === 'string' ? Date.parse(record.observedAt) : NaN;
  if (!Number.isFinite(observedAt)) throw new TypeError('A run requires a valid observedAt');
  const source = provenance.source ?? '';
  const rank = Object.hasOwn(sourcePrecedence, source) ? sourcePrecedence[source] : 0;
  if (!Number.isFinite(rank)) throw new TypeError('Source precedence must be finite');
  return { rank, observedAt, source, sourceId: provenance.sourceId ?? '', content: canonicalJson(record) };
}

/**
 * @param {ReturnType<typeof normalizedRunPrecedence>} left
 * @param {ReturnType<typeof normalizedRunPrecedence>} right
 */
export function compareRunPrecedence(left, right) {
  return left.rank - right.rank || left.observedAt - right.observedAt
    || compareCanonicalStrings(left.source, right.source)
    || compareCanonicalStrings(left.sourceId, right.sourceId)
    || compareCanonicalStrings(left.content, right.content);
}

/** @param {Record<string, unknown>} run */
function outcomePriorityWeight(run) {
  switch (run.conclusion) {
    case 'failure': case 'timed-out': case 'startup-failure': case 'action-required':
    case 'timed_out': case 'startup_failure': case 'action_required': return 4;
    case 'cancelled': return 2;
    default: return 1;
  }
}

/**
 * A reproducible non-cryptographic rank, not a source of random inclusion
 * probabilities. Two lanes reduce accidental ties; the ID is the final tie.
 * @param {string} value
 */
function priorityUnit(value) {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    first = Math.imul(first ^ value.charCodeAt(index), 0x01000193) >>> 0;
    second = Math.imul(second ^ value.charCodeAt(index), 0x85ebca6b) >>> 0;
  }
  return ((first >>> 0) * 0x200000 + (second >>> 11) + 1) / (2 ** 53 + 2);
}

/**
 * Worst-first heap: discarded candidates never retain their Run payloads.
 * @template T
 * @param {number} capacity
 * @param {(left: T, right: T) => number} compare Best-first ordering.
 */
function boundedSelection(capacity, compare) {
  /** @type {T[]} */
  const heap = [];
  return {
    get size() { return heap.length; },
    /** @param {T} value */
    add(value) {
      if (capacity === 0) return;
      if (heap.length < capacity) {
        heap.push(value);
        let index = heap.length - 1;
        while (index > 0) {
          const parent = Math.floor((index - 1) / 2);
          if (compare(heap[index], heap[parent]) <= 0) break;
          [heap[index], heap[parent]] = [heap[parent], heap[index]];
          index = parent;
        }
        return;
      }
      if (compare(value, heap[0]) >= 0) return;
      heap[0] = value;
      let index = 0;
      while (2 * index + 1 < heap.length) {
        let child = 2 * index + 1;
        if (child + 1 < heap.length && compare(heap[child + 1], heap[child]) > 0) child += 1;
        if (compare(heap[child], heap[index]) <= 0) break;
        [heap[index], heap[child]] = [heap[child], heap[index]];
        index = child;
      }
    },
    sorted() { return [...heap].sort(compare); }
  };
}

/**
 * @param {{ namespace: string, watermark: number, capacities: { hot: number, statistical: number } }} policy
 * @param {string[]} hot
 * @param {StatisticalCandidate[]} statistical
 * @param {number} population
 * @param {number} future
 */
function tierPlan(policy, hot, statistical, population, future) {
  const census = population <= policy.capacities.statistical;
  return {
    policyVersion: TIER_POLICY_VERSION,
    ...policy,
    hot,
    statistical: statistical.map((entry) => ({
      ...entry,
      inclusionProbability: census ? 1 : null,
      inverseProbabilityWeight: census ? 1 : null
    })),
    statisticalPopulation: population,
    statisticalWindow: { start: policy.watermark - STATISTICAL_WINDOW_MS, end: policy.watermark },
    weightsValid: census,
    weightValidity: census ? 'census' : 'deterministic-priority-only',
    deferredFutureRuns: future,
    evictionEnabled: false
  };
}

/**
 * Consumes a complete population in ascending canonical ID order. Adjacent
 * revisions reconcile before selection; a later, smaller ID invalidates the
 * entire scan. Only finish() publishes a plan, never a prefix population.
 * @param {StorageTierOptions} options
 */
export function createStorageTierPlanner(options) {
  const watermark = logicalWatermark(options.watermark);
  const namespace = tierIdentifier(options.namespace, 'namespace');
  const seed = tierIdentifier(options.seed, 'seed');
  const capacities = storageTierCapacities(options.backend, options.capacities);
  const sourcePrecedence = { ...options.sourcePrecedence };
  if (Object.values(sourcePrecedence).some((rank) => !Number.isFinite(rank))) {
    throw new TypeError('Source precedence must be finite');
  }
  /** @type {ReturnType<typeof boundedSelection<{ id: string, timestamp: number }>>} */
  const hot = boundedSelection(capacities.hot, (left, right) =>
    right.timestamp - left.timestamp || compareCanonicalStrings(left.id, right.id));
  /** @type {ReturnType<typeof boundedSelection<StatisticalCandidate>>} */
  const statistical = boundedSelection(capacities.statistical, (left, right) =>
    right.priority - left.priority || compareCanonicalStrings(left.id, right.id));
  /** @type {{ id: string, record: Record<string, unknown>, precedence: ReturnType<typeof normalizedRunPrecedence> } | null} */
  let pending = null;
  let population = 0;
  let future = 0;
  let closed = false;

  function flush() {
    if (!pending) return;
    const { id, record } = pending;
    const timestamp = runEventTime(record);
    if (timestamp > watermark) {
      future += 1;
    } else {
      hot.add({ id, timestamp });
      if (timestamp >= watermark - STATISTICAL_WINDOW_MS) {
        population += 1;
        const priorityWeight = outcomePriorityWeight(record);
        statistical.add({
          id, priorityWeight, priority: priorityWeight / priorityUnit(canonicalJson([namespace, seed, id]))
        });
      }
    }
    pending = null;
  }

  function assertOpen() {
    if (closed) throw new Error('Storage tier planner is closed');
  }

  return {
    get retainedCandidateCount() { return hot.size + statistical.size + (pending ? 1 : 0); },
    /** @param {Record<string, unknown>} record */
    add(record) {
      assertOpen();
      try {
        const id = tierIdentifier(record.id, 'run.id');
        if (pending && compareCanonicalStrings(id, pending.id) < 0) {
          throw new Error('Storage tier input must be in ascending canonical ID order');
        }
        const precedence = normalizedRunPrecedence(record, sourcePrecedence);
        if (pending && pending.id !== id) flush();
        if (!pending || compareRunPrecedence(pending.precedence, precedence) < 0) {
          pending = {
            id, precedence,
            record: { startedAt: record.startedAt, completedAt: record.completedAt, conclusion: record.conclusion }
          };
        }
      } catch (error) {
        closed = true;
        throw error;
      }
    },
    finish() {
      assertOpen();
      closed = true;
      flush();
      return tierPlan({ namespace, watermark, capacities },
        hot.sorted().map(({ id }) => id), statistical.sorted(), population, future);
    }
  };
}

/**
 * Non-destructive planning only. Hot and statistical capacities are independent;
 * their selections may overlap and are never added as independent populations.
 * @param {Record<string, unknown>[]} runs
 * @param {StorageTierOptions} options
 */
export function planStorageTiers(runs, options) {
  const watermark = logicalWatermark(options.watermark);
  const namespace = tierIdentifier(options.namespace, 'namespace');
  const seed = tierIdentifier(options.seed, 'seed');
  const capacities = storageTierCapacities(options.backend, options.capacities);
  /** @type {Map<string, { record: Record<string, unknown>, precedence: ReturnType<typeof normalizedRunPrecedence> }>} */
  const winners = new Map();
  for (const record of runs) {
    const id = tierIdentifier(record.id, 'run.id');
    const precedence = normalizedRunPrecedence(record, options.sourcePrecedence);
    const previous = winners.get(id);
    if (!previous || compareRunPrecedence(previous.precedence, precedence) < 0) {
      winners.set(id, { record, precedence });
    }
  }
  const ordered = [...winners].map(([id, { record }]) => ({ id, record, timestamp: runEventTime(record) }))
    .sort((left, right) => right.timestamp - left.timestamp || compareCanonicalStrings(left.id, right.id));
  const visible = ordered.filter(({ timestamp }) => timestamp <= watermark);
  const hot = visible.slice(0, capacities.hot).map(({ id }) => id);
  const population = visible.filter(({ timestamp }) => timestamp >= watermark - STATISTICAL_WINDOW_MS);
  const ranked = population.map(({ id, record }) => {
    const priorityWeight = outcomePriorityWeight(record);
    return { id, priorityWeight, priority: priorityWeight / priorityUnit(canonicalJson([namespace, seed, id])) };
  }).sort((left, right) => right.priority - left.priority || compareCanonicalStrings(left.id, right.id));
  return tierPlan({ namespace, watermark, capacities }, hot,
    ranked.slice(0, capacities.statistical), population.length, ordered.length - visible.length);
}
