import databaseQueries from '../queries/database.json' with { type: 'json' };
import routing from '../../../dashboard-fragments/model-routing.json' with { type: 'json' };
import ingestionQueries from './routing-aggregate.json' with { type: 'json' };
import { executeDashboardQueries } from '../queries/declarative.js';
import { dashboardFormDefaultValues, resolveDashboardQueryParameters } from '../queries/view-payload-compiler.js';

const transientFields = ['routingBaselineModel', 'routingBaselineComplete', 'routingBaselineMainRequests', 'eligibleChoices', 'catalogueOverlap'];

/** Stored facts are query outputs, not a second JavaScript accounting implementation. */
export const ROUTING_AGGREGATE_FIELDS = {
  routingState: 'routing-state', routingSelectedModel: 'pick-model', routingSelectedEffort: 'pick-effort',
  routingGoal: 'routing-goal', routingConfiguredMode: 'routing-configured-mode', routingMode: 'routing-mode',
  routingStatus: 'harness-status', routingAwfVersion: 'routing-awf-version',
  routingSessionClock: 'run-clock', routingSelectionCount: 'selection-count',
  routingFailureCount: 'failure-count', routingDegraded: 'routing-degraded',
  routingConfigurationConflict: 'configuration-conflict', routingWarnings: 'warnings',
  routingAgentResult: 'agent-result', routingFlaggedRequests: 'flagged-requests',
  routingDeviatedRequests: 'deviated-requests', routingCompleteAic: 'complete-aic',
  routingMainAic: 'main-aic', routingBaselineModel: 'baseline-model',
  routingBaselineAic: 'baseline-aic', routingBaselineComplete: 'baseline-complete',
  routingFailureCodes: 'routing-failure-codes', routingDeviationCodes: 'routing-deviation-codes',
  routingResolutionCodes: 'routing-resolution-codes', routingUpstreamCodes: 'routing-upstream-codes',
  routingCandidateCoverage: 'candidate-coverage',
  routingTaskType: 'routing-task-type', routingScope: 'routing-scope', routingComplexity: 'routing-complexity'
};

/**
 * Materialize one compact routing aggregate on each owning Run. The same
 * declarative accounting and attribution used by drill-downs owns these facts.
 * @param {import('../model/schema.js').CanonicalBatch} batch
 */
export function compactRoutingRuns(batch) {
  if (!batch.audits.some((record) => record.type === 'session.format')) return;
  const auditProjection = databaseQueries.find((query) => query.name === 'audits');
  if (!auditProjection?.select) throw new TypeError('Routing ingestion requires the canonical Audit projection');
  const definitions = /** @type {Array<Record<string, unknown>>} */ (resolveDashboardQueryParameters([...routing.queries, ...ingestionQueries],
    dashboardFormDefaultValues(routing.pages[0].form)));
  /** @param {string} source @param {Record<string, unknown>[]} rows */
  const input = (source, rows) => ({ source, rows, metadata: {
    'source-id': source, 'source-kind': 'canonical',
    'as-of': '1970-01-01T00:00:00.000Z', 'retrieved-at': '1970-01-01T00:00:00.000Z',
    completeness: /** @type {const} */ ('unknown'), freshness: /** @type {const} */ ('unknown')
  } });
  const result = executeDashboardQueries([
    { ...auditProjection, select: [...auditProjection.select, { field: 'runId', as: 'canonical-run-id' },
      ...transientFields.map((field) => ({ field }))] },
    ...definitions.map((query) => query.name === 'routing-runs' ? {
      name: 'routing-runs', from: 'routing-resolved-runs',
      compute: [{ as: 'full-repository', function: 'concat', args: [
        { field: 'organization' }, { value: '/' }, { field: 'repository' }
      ] }]
    } : query.name === 'routing-run-facts' ? {
      ...query, aggregate: { ...routing.queries.find((entry) => entry.name === query.name)?.aggregate,
        values: [...(routing.queries.find((entry) => entry.name === query.name)?.aggregate?.values ?? []),
          { field: 'canonical-run-id', as: 'canonical-run-id', reducer: 'unique' }] }
    } : query)
  ], {
    $audits: input('$audits', batch.audits), $runs: input('$runs', batch.runs)
  }, ['routing-ingestion-aggregate'])['routing-ingestion-aggregate'];
  if (result.metadata?.availability === 'unavailable') {
    throw new TypeError(`Routing aggregate unavailable: ${JSON.stringify(result.metadata)}`);
  }
  const runs = new Map(batch.runs.map((run) => [run.id, run]));
  for (const row of result.rows) {
    const run = runs.get(row['canonical-run-id']);
    if (!run) throw new TypeError('Routing aggregate has no owning Run');
    run.routingAggregateVersion = 1;
    for (const [field, source] of Object.entries(ROUTING_AGGREGATE_FIELDS)) {
      run[field] = row[source] ?? null;
    }
  }
  // No inventory, generic proxy events or ingestion-only facts enter storage,
  // including when replaying older cached session projections.
  batch.audits = batch.audits.filter((record) => !['model.inventory', 'firewall.event'].includes(String(record.type)))
    .map((record) => Object.fromEntries(Object.entries(record).filter(([field]) => !transientFields.includes(field))));
}
