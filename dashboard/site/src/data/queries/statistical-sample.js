/**
 * A frozen projection of the current canonical snapshot, not a historical
 * reservoir. Selection precedes every consumer's predicates and never evicts
 * exact evidence. The caller supplies a recorded logical clock.
 */
import { timestampMilliseconds } from '../model/schema.js';
import { createDashboardQueryBudget, DASHBOARD_QUERY_LIMITS } from './declarative.js';

export const STATISTICAL_CAPACITIES = Object.freeze({ postgres: 64000, sqlite: 8000, indexeddb: 16000 });
export const STATISTICAL_VERSION = 'canonical-snapshot-bottom-k-v1';
export const STATISTICAL_FRAME_VERSION = 'canonical-snapshot-frame-v2';
export const STATISTICAL_INPUT_LIMITS = Object.freeze({
  rows: DASHBOARD_QUERY_LIMITS['max-input-rows'], bytes: 256 * 1024 * 1024
});
const SEED = 'cao-statistical-v1';
const WEEK = 7 * 86400000;
const FAILURES = new Set(['failure', 'timed_out', 'action_required', 'startup_failure']);
const OUTCOMES = new Set(['success', ...FAILURES, 'cancelled', 'skipped', 'neutral', 'stale']);

/** @param {unknown} value */
function instant(value) {
  return timestampMilliseconds(value) ?? NaN;
}

/** @param {Record<string, unknown>[]} rows */
export function canonicalStatisticalWatermark(rows) {
  let latest = -Infinity;
  for (const row of rows) {
    for (const field of ['startedAt', 'createdAt', 'completedAt', 'updatedAt']) {
      const at = instant(row[field]);
      if (Number.isFinite(at)) latest = Math.max(latest, at);
    }
  }
  return Number.isFinite(latest) ? new Date(latest).toISOString() : '';
}

/** @param {string[]} parts */
function framed(parts) {
  const encoder = new TextEncoder();
  const chunks = parts.map((part) => encoder.encode(part));
  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + 4 + chunk.length, 0));
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (const chunk of chunks) {
    view.setUint32(offset, chunk.length);
    offset += 4;
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/** @param {string} identity @param {string} [seed] */
export async function statisticalPriority(identity, seed = SEED) {
  seed ||= SEED;
  return digest([STATISTICAL_VERSION, seed, identity]);
}

/** @param {string[]} parts */
async function digest(parts) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', framed(parts));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** @param {unknown} value @returns {string} */
function stableJSON(value) {
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = /** @type {Record<string, unknown>} */ (value);
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJSON(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** @param {Map<string, number>} counts @param {number} capacity */
function allocate(counts, capacity) {
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const budget = Math.min(capacity, total);
  const quotas = [...counts].map(([key, count]) => ({
    key, count: total ? Math.floor(budget * count / total) : 0,
    remainder: total ? (budget * count) % total : 0
  }));
  let remainder = budget - quotas.reduce((sum, quota) => sum + quota.count, 0);
  quotas.sort((a, b) => b.remainder - a.remainder || compare(a.key, b.key));
  for (const quota of quotas) if (remainder-- > 0) quota.count++;
  return new Map(quotas.map(({ key, count }) => [key, count]));
}

/** @param {string} a @param {string} b */
function compare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

/** @typedef {{ row: Record<string, unknown>, priority: string }} Candidate */

/** @param {Candidate} a @param {Candidate} b */
function compareCandidates(a, b) {
  return compare(a.priority, b.priority) || compare(String(a.row.id), String(b.row.id));
}

/** @param {Candidate[]} heap @param {Candidate} candidate @param {number} capacity @param {() => void} checkpoint */
function retainCandidate(heap, candidate, capacity, checkpoint) {
  if (heap.length < capacity) {
    let index = heap.length;
    heap.push(candidate);
    while (index > 0) {
      checkpoint();
      const parent = Math.floor((index - 1) / 2);
      if (compareCandidates(heap[parent], candidate) >= 0) break;
      heap[index] = heap[parent];
      index = parent;
    }
    heap[index] = candidate;
    return;
  }
  if (compareCandidates(candidate, heap[0]) >= 0) return;
  let index = 0;
  while (index * 2 + 1 < heap.length) {
    checkpoint();
    let child = index * 2 + 1;
    if (child + 1 < heap.length && compareCandidates(heap[child + 1], heap[child]) > 0) child++;
    if (compareCandidates(candidate, heap[child]) >= 0) break;
    heap[index] = heap[child];
    index = child;
  }
  heap[index] = candidate;
}

/**
 * @param {Record<string, unknown>[]} rows
 * @param {{ watermark: unknown, capacity?: number, complete?: boolean, seed?: string, hotIds?: Iterable<string>, checkpoint?: () => void }} options
 */
export async function sampleStatisticalRuns(rows, options) {
  const budget = createDashboardQueryBudget();
  const checkpoint = () => { budget.spend(1); options.checkpoint?.(); };
  if (rows.length > STATISTICAL_INPUT_LIMITS.rows) throw new Error('Statistical candidate frame exceeds input row budget');
  const watermark = instant(options.watermark);
  const capacity = options.capacity ?? STATISTICAL_CAPACITIES.indexeddb;
  if (!Number.isSafeInteger(capacity) || capacity < 0 || capacity > 100000) throw new Error('Invalid statistical capacity');
  if (!Number.isFinite(watermark)) throw new Error('Statistical sampling requires an explicit canonical UTC watermark');
  const hot = new Set(options.hotIds ?? []);
  const seed = options.seed || SEED;
  /** @type {Map<string, { row: Record<string, unknown>, variants: Set<string> }>} */
  const identities = new Map();
  let invalid = 0;
  let conflicts = 0;
  let inputBytes = 0;
  const encoder = new TextEncoder();
  for (const row of rows) {
    checkpoint();
    const id = row.id;
    if (typeof id !== 'string' || !/^github:run:[^/:]+\/[^:]+:[^:]+$/.test(id)) { invalid++; continue; }
    const json = stableJSON(row);
    inputBytes += encoder.encode(json).byteLength;
    if (inputBytes > STATISTICAL_INPUT_LIMITS.bytes) throw new Error('Statistical candidate frame exceeds working byte budget');
    const prior = identities.get(id);
    const variants = prior?.variants ?? new Set();
    variants.add(json);
    if (!prior) identities.set(id, { row, variants });
  }
  conflicts = [...identities.values()].reduce((sum, entry) => sum + entry.variants.size - 1, 0);
  /** @type {Map<string, Array<{ row: Record<string, unknown>, priority: string }>>} */
  const groups = new Map();
  let incomplete = 0;
  let hotExcluded = 0;
  let quarantined = 0;
  for (const [id, { row, variants }] of identities) {
    checkpoint();
    if (variants.size > 1) { quarantined++; continue; }
    if (row.status !== 'completed') { incomplete++; continue; }
    const started = instant(row.startedAt);
    const at = Number.isFinite(started) ? started : instant(row.createdAt);
    if (!Number.isFinite(at) || typeof row.conclusion !== 'string' || !row.conclusion) { invalid++; continue; }
    if (at < watermark - WEEK || at >= watermark) continue;
    if (hot.has(id)) { hotExcluded++; continue; }
    const outcome = OUTCOMES.has(row.conclusion) ? row.conclusion : 'other';
    const key = `${new Date(at).toISOString().slice(0, 10)}/${outcome}`;
    let group = groups.get(key);
    if (!group) { group = []; groups.set(key, group); }
    group.push({ row, priority: '' });
  }
  const counts = new Map([...groups].map(([key, candidates]) => [key, candidates.length]));
  const failures = new Map([...counts].filter(([key]) => FAILURES.has(key.split('/')[1])));
  const reserve = allocate(failures, capacity > 0 ? Math.ceil(capacity / 10) : 0);
  const reserved = [...reserve.values()].reduce((sum, count) => sum + count, 0);
  const residual = new Map([...counts].map(([key, count]) => [key, count - (reserve.get(key) ?? 0)]));
  const remainder = allocate(residual, capacity - reserved);
  const valid = options.complete === true && invalid === 0 && conflicts === 0;
  /** @type {Record<string, unknown>[]} */
  const selected = [];
  /** @type {Array<{ stratum: string, population: number, allocation: number, cutoff: string | null }>} */
  const strata = [];
  const populationParts = [];
  for (const [key, candidates] of [...groups].sort(([a], [b]) => compare(a, b))) {
    const population = candidates.length;
    const count = (reserve.get(key) ?? 0) + (remainder.get(key) ?? 0);
    candidates.sort((a, b) => {
      checkpoint();
      return compare(String(a.row.id), String(b.row.id));
    });
    populationParts.push(key, String(population));
    for (const candidate of candidates) {
      checkpoint();
      populationParts.push(String(candidate.row.id));
    }
    /** @type {Candidate[]} */
    const retained = [];
    if (count > 0) {
      for (const candidate of candidates) {
        checkpoint();
        const priority = await statisticalPriority(String(candidate.row.id), seed);
        retainCandidate(retained, { row: candidate.row, priority }, count, checkpoint);
      }
      retained.sort((a, b) => {
        checkpoint();
        return compareCandidates(a, b);
      });
    }
    for (const candidate of retained) selected.push({
      ...Object.fromEntries(Object.entries(candidate.row).filter(([field]) => !field.startsWith('statistical-'))),
      'statistical-stratum': key, 'statistical-priority': candidate.priority,
      'statistical-population': population, 'statistical-allocation': count,
      'statistical-weight-valid': valid,
      ...(valid ? { 'statistical-probability': count / population, 'statistical-weight': population / count } : {})
    });
    strata.push({ stratum: key, population, allocation: count, cutoff: count > 0 ? retained[count - 1].priority : null });
  }
  const normalizedWatermark = new Date(watermark).toISOString();
  const frameId = await digest([
    STATISTICAL_FRAME_VERSION, STATISTICAL_VERSION, seed, 'frame', normalizedWatermark, String(capacity), String(valid),
    ...populationParts,
    ...strata.flatMap((stratum) => [
      stratum.stratum, String(stratum.population), String(stratum.allocation), stratum.cutoff ?? ''
    ]),
    ...selected.flatMap((row) => [String(row.id), String(row['statistical-priority']), String(row['statistical-stratum'])])
  ]);
  checkpoint();
  for (const row of selected) row['statistical-frame-id'] = `sha256:${frameId}`;
  return {
    rows: selected,
    frame: {
      version: STATISTICAL_VERSION, 'frame-version': STATISTICAL_FRAME_VERSION,
      seed, watermark: normalizedWatermark, 'frame-id': `sha256:${frameId}`,
      'watermark-policy': 'explicit',
      'window-start': new Date(watermark - WEEK).toISOString(),
      population: 'canonical-snapshot-completed-runs', capacity,
      'timestamp-field': 'startedAt-or-createdAt', 'identity-field': 'id',
      'allocation-policy': 'largest-remainder-failure-reserve-v1',
      'failure-reserve-fraction': 0.1, 'failure-reserve-allocation': reserved,
      'selection-stage': 'before-consumer-filter',
      'hot-exclusion-policy': 'explicit-identities-only', 'hot-exclusion-default': 0,
      'input-count': rows.length, 'population-count': [...counts.values()].reduce((sum, count) => sum + count, 0),
      'selected-count': selected.length, 'invalid-count': invalid, 'incomplete-count': incomplete,
      'duplicate-conflicts': conflicts, 'quarantined-count': quarantined, 'hot-excluded-count': hotExcluded,
      'input-row-limit': STATISTICAL_INPUT_LIMITS.rows, 'input-byte-limit': STATISTICAL_INPUT_LIMITS.bytes,
      'weight-valid': valid, 'full-population-estimable': valid && strata.every((stratum) => stratum.allocation > 0),
      strata
    }
  };
}
