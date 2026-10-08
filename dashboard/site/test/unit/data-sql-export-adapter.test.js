import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { adaptSqlExport } from '../../src/data/adapters/sql-export.js';
import { relationshipErrors } from '../../src/data/model/schema.js';
import { normalize } from '../../src/data/normalize/index.js';
import { IDBFactory } from 'fake-indexeddb';
import { ingestSqlExport } from '../../src/data/ingest/coordinator.js';
import { queryDatabaseSources } from '../../src/data/queries/database.js';
import { queryDashboardSourceObservations } from '../../src/data/queries/ingestion.js';

function fixture() {
  return JSON.parse(readFileSync(resolve('test/fixtures/sql-export-v4.json'), 'utf8'));
}

describe('SQL export adapter', () => {
  it('round-trips projected owner attribution and historical diagnostics through canonical queries', async () => {
    const input = fixture();
    const clock = '2026-09-09T04:00:00.000Z';
    const attribution = { originId: 'absorbed-grader', source: 'grader', status: 'unavailable',
      timestamp: clock, observedAt: clock, attempt: 1, templateVersion: 1 };
    Object.assign(input.rows.find((/** @type {Record<string, unknown>} */ row) => row.entity_kind === 'run'), {
      run_task_domain_label: 'Research', run_session_label: 'Pi/copilot/gpt-5.4',
      run_behavior_evidence: { ...attribution, originId: 'absorbed-behavior' }
    });
    input.rows.push(
      { entity_kind: 'grader', source_id: 'grader:quality', observed_at: clock,
        github_workflow_id: '202', source_grader_id: 'quality', name: 'quality',
        unit: 'new-unit', direction: 'maximize' },
      { entity_kind: 'grader-observation', source_id: 'result:quality', observed_at: clock,
        github_run_id: '303', grader_id: 'grader:quality', value: null, status: 'unavailable',
        timestamp: clock, observed_name: null, observed_unit: 'historical-unit',
        observed_direction: null, message: null, error: 'Missing runtime helper',
        audit_evidence: attribution }
    );
    const indexedDB = new IDBFactory();
    await ingestSqlExport(indexedDB, input, {
      now: Date.parse(clock), maxDatabaseBytes: Number.MAX_SAFE_INTEGER
    });
    const sources = await queryDatabaseSources(indexedDB, {}, ['runs', 'grader-observations']);
    expect(sources.runs.rows[0]).toMatchObject({
      'task-domain-label': 'Research', 'session-label': 'Pi/copilot/gpt-5.4',
      'behavior-evidence': { originId: 'absorbed-behavior' }
    });
    expect(sources['grader-observations'].rows[0]).toMatchObject({
      value: null, status: 'unavailable', unit: 'historical-unit', direction: null,
      'grader-name': null, message: null, error: 'Missing runtime helper',
      'audit-evidence': attribution, 'current-definition-unit': 'new-unit'
    });
    expect(sources.runs.metadata['as-of']).not.toBe('');
  });

  it('preserves recorded null and absence in declarative result import mappings', () => {
    const { observations } = queryDashboardSourceObservations({
      'grader-observations': {
        rows: [{ id: 'result', 'run-id': 'run', 'grader-id': 'grader',
          'result-timestamp': '2026-09-09T04:00:00Z', value: null,
          unit: null, direction: null, error: null }],
        metadata: { 'as-of': '2026-09-09T04:00:00Z' }
      }
    });
    expect(observations[0].data).toMatchObject({
      value: null, observedUnit: null, observedDirection: null, error: null
    });
    expect(observations[0].data).not.toHaveProperty('observedName');
    expect(observations[0].data).not.toHaveProperty('message');
  });

  it('converts a versioned static export into a complete ordered canonical graph', () => {
    const adapted = adaptSqlExport(fixture());
    const batch = normalize(adapted.observations);

    expect(relationshipErrors(batch)).toEqual([]);
    expect(batch).toMatchObject({
      repositories: [{ id: 'github:repository:101', owner: 'githubnext', name: 'gh-aw-cao' }],
      workflows: [{ id: 'github:workflow:202', repositoryId: 'github:repository:101' }],
      runs: [{
        id: 'github:run:githubnext/gh-aw-cao:303',
        repositoryId: 'github:repository:101',
        workflowId: 'github:workflow:202'
      }],
      audits: expect.arrayContaining([
        expect.objectContaining({ runId: 'github:run:githubnext/gh-aw-cao:303' })
      ]),
      domains: [expect.objectContaining({
        runId: 'github:run:githubnext/gh-aw-cao:303',
        domain: 'api.github.com'
      })]
    });
    expect(batch.audits.map((audit) => [audit.sequence, audit.type])).toEqual([
      [0, 'message.user']
    ]);
    expect(batch.audits[0]).toMatchObject({
      safeOutputType: 'create_issue',
      githubEntityType: 'issue'
    });
  });

  it('rejects unknown schema versions', () => {
    expect(() => adaptSqlExport({ ...fixture(), schema_version: 1 }))
      .toThrow('Unsupported SQL export schema version: 1');
  });

  it('does not infer missing issue entity-type evidence', () => {
    const input = fixture();
    input.rows.push({
      entity_kind: 'issue',
      source_id: 'safe-output-without-entity-type',
      observed_at: '2026-09-09T04:00:00Z',
      github_run_id: '303',
      run_attempt: 1,
      is_pull_request: false,
      url: 'https://github.com/githubnext/gh-aw-cao/issues/42'
    });

    const [issue] = normalize(adaptSqlExport(input).observations).issues;

    expect(issue).toMatchObject({ isPullRequest: false });
    expect(issue).not.toHaveProperty('githubEntityType');
  });

  it('preserves token intervention lifecycle identity and evidence', () => {
    const input = fixture();
    input.rows.push({
      entity_kind: 'audit',
      source_id: 'event-token-lifecycle',
      observed_at: '2026-09-09T05:00:00Z',
      github_run_id: '303',
      run_attempt: 1,
      event_timestamp: '2026-09-09T04:00:03Z',
      event_source: 'token-intervention-lifecycle',
      event_type: 'token_efficiency.intervention',
      source_sequence: 3,
      optimization_target_repo: 'octo/example',
      optimization_workflow_path: '.github/workflows/review.md',
      optimization_opportunity_id: 'token-opportunity:1',
      optimization_opportunity_kind: 'unbounded-context-growth',
      optimization_assignment_run_id: '6999',
      optimization_evidence_window_start: '2026-09-01T00:00:00Z',
      optimization_evidence_window_end: '2026-09-08T00:00:00Z',
      optimization_evidence_confidence: 0.9,
      optimization_cost_grain: 'invocation',
      optimization_evidence_provenance: [{ source: 'activity', runId: '6999' }],
      optimization_attributable_run_ids: ['6999', '7001'],
      optimization_intervention_id: 'token-intervention:1',
      optimization_lifecycle_observation_id: 'token-lifecycle:1',
      optimization_previous_intervention_state: 'accepted',
      optimization_intervention_state: 'running',
      optimization_previous_recommendation_disposition: 'unapplied',
      optimization_recommendation_disposition: 'applied',
      optimization_evidence_state: 'complete',
      optimization_safe_output_id: 'github:issue:githubnext/gh-aw-cao:11861',
      optimization_safe_output_url: 'https://github.com/githubnext/gh-aw-cao/issues/11861',
      optimization_implementation_change_id: 'github:pull-request:octo/example:42',
      optimization_implementation_pull_request_url: 'https://github.com/octo/example/pull/42',
      optimization_implementation_run_ids: ['7001'],
      optimization_optimizer_run_attempt: 1,
      optimization_optimizer_workflow_path: '.github/workflows/optimization-token-optimizer.md',
      optimization_optimizer_workflow_name: 'Optimization / Token Optimizer',
      optimization_claim_run_id: '1189001',
      optimization_claim_run_attempt: 1,
      optimization_actor: 'maintainer',
      optimization_source_provenance: {
        kind: 'workflow-dispatch-claim',
        sourceId: 'github-actions-run:githubnext/gh-aw-cao:1189001:attempt:1'
      },
      optimization_accepted_at: '2026-09-08T04:00:00Z',
      optimization_implementation_started_at: '2026-09-08T05:00:00Z',
      optimization_implementation_completed_at: '2026-09-09T04:00:00Z'
    });

    const event = normalize(adaptSqlExport(input).observations).audits
      .find((candidate) => candidate.type === 'token_efficiency.intervention');
    expect(event).toMatchObject({
      targetOrganization: 'octo', targetRepository: 'example',
      targetWorkflowPath: '.github/workflows/review.md',
      opportunityId: 'token-opportunity:1',
      opportunityKind: 'unbounded-context-growth',
      assignmentRunId: '6999',
      evidenceWindowStart: '2026-09-01T00:00:00.000Z',
      evidenceWindowEnd: '2026-09-08T00:00:00.000Z',
      evidenceConfidence: 0.9,
      costGrain: 'invocation',
      evidenceProvenance: [{ source: 'activity', runId: '6999' }],
      attributableRunIds: ['6999', '7001'],
      interventionId: 'token-intervention:1',
      lifecycleObservationId: 'token-lifecycle:1',
      interventionState: 'running',
      recommendationDisposition: 'applied',
      implementationRunIds: ['7001'],
      claimRunId: '1189001',
      claimRunAttempt: 1,
      actor: 'maintainer',
      sourceProvenance: {
        kind: 'workflow-dispatch-claim',
        sourceId: 'github-actions-run:githubnext/gh-aw-cao:1189001:attempt:1'
      }
    });
  });
});