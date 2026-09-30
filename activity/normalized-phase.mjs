import { NORMALIZED_COLLECTIONS } from './cli-usage.mjs';

const RUN_COLLECTIONS = new Set([
  'campaigns', 'repositories', 'workflows', 'runs', 'experiments', 'experimentAssignments'
]);

const EVIDENCE_RELATIONSHIPS = [
  ['experimentAssignments', 'experiments', 'experimentId'],
  ['graderObservations', 'graders', 'graderId'],
  ['evalObservations', 'evals', 'evalId']
];

export function relationshipSafeEvidenceBatch(batch, runWorkflowIds = new Map(
  (batch.runs ?? []).map((run) => [String(run.id), String(run.workflowId)])
)) {
  const safe = { ...batch };
  for (const [childCollection, parentCollection, parentField] of EVIDENCE_RELATIONSHIPS) {
    const parentWorkflowIds = new Map(
      (batch[parentCollection] ?? []).map((definition) =>
        [String(definition.id), String(definition.workflowId)])
    );
    safe[childCollection] = (batch[childCollection] ?? []).filter((record) => {
      const runWorkflowId = runWorkflowIds.get(String(record.runId));
      const definitionWorkflowId = parentWorkflowIds.get(String(record[parentField]));
      return runWorkflowId !== undefined && definitionWorkflowId === runWorkflowId;
    });
  }
  return safe;
}

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
