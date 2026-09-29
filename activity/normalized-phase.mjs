import { NORMALIZED_COLLECTIONS } from './cli-usage.mjs';

const RUN_COLLECTIONS = new Set([
  'campaigns', 'repositories', 'workflows', 'runs', 'experiments', 'experimentAssignments'
]);

export function normalizedPhaseBatch(batch, phase) {
  if (!['runs', 'records'].includes(phase)) throw new TypeError(`Unsupported normalized phase: ${phase}`);
  return Object.fromEntries(NORMALIZED_COLLECTIONS.map((collection) => {
    if (RUN_COLLECTIONS.has(collection) !== (phase === 'runs')) return [collection, []];
    const records = batch[collection] ?? [];
    return [collection, collection === 'audits'
      ? records.filter((audit) => String(audit.status ?? '').trim().toLowerCase() !== 'info')
      : records];
  }));
}
