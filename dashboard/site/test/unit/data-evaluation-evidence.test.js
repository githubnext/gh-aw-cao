import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseUnifiedSessionDocument } from '../../src/data/adapters/unified-session.js';
import { adaptCachedGhAwJsonl, adaptGhAwLogs } from '../../src/data/adapters/gh-aw-logs.js';
import { normalize } from '../../src/data/normalize/index.js';
import { relationshipErrors } from '../../src/data/model/schema.js';
import { ingestCachedGhAwJsonl } from '../../src/data/ingest/coordinator.js';
import { processDataRequest } from '../../src/data-worker.js';
import { authoritativeDashboard } from '../authoritative-dashboard.js';
import contract from '../fixtures/evaluation-evidence-contract.json' with { type: 'json' };

const content = readFileSync(resolve('test/fixtures/evaluation-session.jsonl'), 'utf8');
const projection = () => ({
  version: 1, path: 'usage/aw_session.jsonl',
  ...parseUnifiedSessionDocument(content, 'usage/aw_session.jsonl', { runId: '303', attempt: 1 })
});
const cached = () => `${JSON.stringify({
  schema_version: 5, kind: 'run', run: {
    run_id: 303, run_attempt: 1, organization: 'octo', repository: 'octo/api',
    workflow_name: 'Worker', workflow_path: '.github/workflows/worker.lock.yml',
    created_at: '2026-10-15T10:00:00Z', updated_at: '2026-10-15T10:01:00Z',
    status: 'completed', conclusion: 'success',
    experiments: { assignments: { legacy: 'control' } },
    graders: { results: [{ id: 'legacy', value: 1, status: 'fail' }] },
    evals: [{ id: 'legacy', answer: 'NO' }],
    cao_unified_session: projection()
  }
})}\n`;

afterEach(() => vi.unstubAllGlobals());

describe('unified evaluation evidence', () => {
  it('retains untimed typed evidence, enriches grader metadata and never stores private bodies', () => {
    const parsed = projection();
    expect(parsed.events).toEqual([]);
    expect(parsed).toMatchObject({
      experiments: { assignments: { prompt: 'candidate' } },
      graders: { results: [{
        id: 'quality', value: 0.93, status: 'pass', name: 'Quality',
        unit: 'ratio', direction: 'higher_is_better', threshold: 0.8,
        evaluatorDigest: 'sha256:quality-v1', sessionPayloadRef: 'usage/aw_session.jsonl#L6'
      }] },
      evals: [{ id: 'quality', answer: 'YES' }, { id: 'uncertain', answer: 'UNKNOWN' }]
    });
    expect(JSON.stringify(parsed)).not.toMatch(/PRIVATE_|other-run|stale/);
  });

  it('prefers each session category over conflicting legacy evidence without mixing entity kinds', () => {
    const batch = normalize(adaptCachedGhAwJsonl(cached()).observations);
    expect(batch.experiments?.map((row) => row.name)).toEqual(['prompt']);
    expect(batch.experimentAssignments).toMatchObject([{ variant: 'candidate' }]);
    expect(batch.graders?.map((row) => row.name)).toEqual(['quality']);
    expect(batch.graderObservations).toMatchObject([{ value: 0.93, status: 'pass' }]);
    expect(batch.evals?.map((row) => row.name)).toEqual(['quality', 'uncertain']);
    expect(batch.evalObservations?.map((row) => row.evalResult)).toEqual(['YES', 'UNKNOWN']);
    expect(batch.graders?.[0].id).not.toBe(batch.evals?.[0].id);
    expect(batch.evalObservations?.every((row) => batch.audits.some((audit) => audit.id === row.auditId))).toBe(true);
    expect(batch.audits.filter((row) => row.type === 'workflow_run_grader')).toHaveLength(1);
    expect(batch.audits.find((row) => row.type === 'workflow_run_eval')?.payloadRef).toBe('usage/aw_session.jsonl#L7');
    expect(relationshipErrors(batch)).toEqual([]);
  });

  it('ingests the same unified evidence through the direct artifact adapter', () => {
    const batch = normalize(adaptGhAwLogs({
      observedAt: '2026-10-15T10:01:00Z',
      repository: { githubId: 1, owner: 'octo', name: 'api' },
      workflow: { githubId: 2, name: 'Worker', path: '.github/workflows/worker.lock.yml' },
      run: { githubRunId: 303, attempt: 1, createdAt: '2026-10-15T10:00:00Z' },
      files: [{ path: 'usage/aw_session.jsonl', content }]
    }).observations);
    expect(batch.graderObservations).toMatchObject([{ value: 0.93 }]);
    expect(batch.evalObservations).toHaveLength(2);
    expect(batch.experimentAssignments).toHaveLength(1);
    expect(relationshipErrors(batch)).toEqual([]);
  });

  it('falls back independently by category while honoring explicit empty session results', () => {
    const envelope = JSON.parse(cached());
    envelope.run.cao_unified_session = {
      version: 1, path: 'usage/aw_session.jsonl',
      ...parseUnifiedSessionDocument([
        { type: 'session.format', data: { version: 1 } },
        { type: 'grader.result', data: { run: { id: '303', attempt: 1 }, results: [] } }
      ].map((row) => JSON.stringify(row)).join('\n'), 'usage/aw_session.jsonl', { runId: '303', attempt: 1 })
    };
    const batch = normalize(adaptCachedGhAwJsonl(`${JSON.stringify(envelope)}\n`).observations);
    expect(batch.graderObservations).toHaveLength(0);
    expect(batch.graders).toHaveLength(0);
    expect(batch.evals?.map((row) => row.name)).toEqual(['legacy']);
    expect(batch.experiments?.map((row) => row.name)).toEqual(['legacy']);
  });

  it('ignores other-run and other-attempt evidence, and never turns state counters into assignments', () => {
    const parsed = parseUnifiedSessionDocument([
      { type: 'session.format', data: { version: 1 } },
      { type: 'experiment.state', data: { counts: { prompt: { candidate: 3 } } } },
      { type: 'experiment.assignment', data: { runAttempt: 2, assignments: { stale: 'control' } } },
      { type: 'grader.manifest', data: { graders: [{ id: 'unobserved', unit: 'score' }] } },
      { type: 'grader.result', data: { run: { id: '303', attempt: 2 }, results: [{ id: 'stale' }] } },
      { type: 'grader.result', data: { id: 'other-run', value: 1, run_id: '404' } },
      { type: 'grader.result', data: { id: 'quality', value: 0.93, runId: '303', metrics: [
        { id: 'accuracy', value: 0.93, message: 'PRIVATE_METRIC' },
        { id: 'error', value: 'PRIVATE_ERROR' }, { value: 1 }
      ] } },
      { type: 'eval.result', data: { id: 'wrong-attempt', answer: 'YES', runId: '303', runAttempt: 2 } },
      { type: 'eval.result', data: { id: 'conflicting', answer: 'YES', runId: '303', run_id: '404' } }
    ].map((row) => JSON.stringify(row)).join('\n'), 'usage/aw_session.jsonl', { runId: '303', attempt: 1 });
    expect(parsed).toMatchObject({ graders: { results: [{ id: 'quality', value: 0.93, metrics: [{ id: 'accuracy', value: 0.93 }] }] } });
    expect(JSON.stringify(parsed)).not.toMatch(/PRIVATE_|stale|other-run|unobserved|wrong-attempt|conflicting/);
    expect(parsed).not.toHaveProperty('experiments');
    expect(parsed).not.toHaveProperty('evals');
  });

  it('resolves separate score and binary-answer views through canonical ingestion and the production worker', async () => {
    const indexedDB = new IDBFactory();
    vi.stubGlobal('indexedDB', indexedDB);
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    await ingestCachedGhAwJsonl(indexedDB, cached(), { now: Date.parse('2026-10-16T00:00:00Z') });
    const dashboard = authoritativeDashboard.dashboard;
    const sources = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (
      await processDataRequest({
        operation: 'query-canonical-dashboard',
        sourceNames: [contract.graders.query, contract.evals.query, 'experiment-assignment-coverage', 'eval-observations'],
        context: { queries: dashboard.queries, pages: dashboard.pages }
      })
    );
    expect(sources[contract.graders.query].rows).toMatchObject([
      { grader: 'quality', value: 0.93, unit: 'ratio', status: 'pass', repository: 'api' }
    ]);
    expect(sources[contract.evals.query].rows).toMatchObject([{ eval: 'quality', 'eval-result': 'YES' }]);
    expect(sources['eval-observations'].rows).toHaveLength(2);
    expect(sources['eval-observations'].rows.every((row) => typeof row['audit-id'] === 'string')).toBe(true);
    expect(sources['experiment-assignment-coverage'].rows).toMatchObject([{ experiment: 'prompt', assignments: 1 }]);
  });
});
