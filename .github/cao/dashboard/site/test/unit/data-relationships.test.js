import { describe, expect, it } from 'vitest';
import { relationshipErrors } from '../../src/data/model/schema.js';
import { normalize } from '../../src/data/normalize/index.js';

const observedAt = '2026-09-09T05:00:00Z';

/**
 * @param {import('../../src/data/model/schema.js').EntityKind} kind
 * @param {string} sourceId
 * @param {Record<string, unknown>} data
 * @returns {import('../../src/data/model/schema.js').CanonicalObservation}
 */
function observation(kind, sourceId, data) {
  return { kind, source: 'fixture', sourceId, observedAt, data };
}

function completeGraph() {
  return normalize([
    observation('package', 'package-0', {
      slug: 'dashboard',
      name: 'Dashboard'
    }),
    observation('repository', 'repository-1', {
      githubId: 1,
      fullName: 'githubnext/gh-aw-cao'
    }),
    observation('workflow', 'workflow-2', {
      githubId: 2,
      repositoryId: 'github:repository:1',
      packageId: 'package:fixture:dashboard',
      package: 'dashboard',
      name: 'Dashboard'
    }),
    observation('run', 'run-3', {
      githubRunId: 3,
      attempt: 1,
      repositoryId: 'github:repository:1',
      workflowId: 'github:workflow:2'
    }),
    observation('job', 'job-4', {
      githubJobId: 4,
      runId: 'github:run:3:attempt:1',
      name: 'build'
    }),
    observation('session', 'session-5', {
      id: 'session:5',
      runId: 'github:run:3:attempt:1',
      jobId: 'github:job:4',
      kind: 'agent'
    }),
    observation('event', 'event-6', {
      id: 'event:6',
      sessionId: 'session:5',
      timestamp: observedAt,
      source: 'runtime',
      type: 'runtime.started'
    })
  ]);
}

describe('canonical entity relationships', () => {
  it('accepts a complete Repository to Event graph', () => {
    const batch = completeGraph();

    expect(relationshipErrors(batch)).toEqual([]);
    expect(batch).toMatchObject({
      packages: [{ id: 'package:fixture:dashboard', slug: 'dashboard' }],
      repositories: [{ id: 'github:repository:1' }],
      workflows: [{
        id: 'github:workflow:2',
        repositoryId: 'github:repository:1',
        packageId: 'package:fixture:dashboard'
      }],
      runs: [{
        id: 'github:run:3:attempt:1',
        repositoryId: 'github:repository:1',
        workflowId: 'github:workflow:2'
      }],
      jobs: [{ id: 'github:job:4', runId: 'github:run:3:attempt:1' }],
      sessions: [{ id: 'session:5', runId: 'github:run:3:attempt:1', jobId: 'github:job:4' }],
      events: [{ id: 'event:6', sessionId: 'session:5', sequence: 0 }]
    });
  });

  it('allows a session to belong directly to a run without a job', () => {
    const batch = completeGraph();
    delete batch.sessions[0].jobId;

    expect(relationshipErrors(batch)).toEqual([]);
  });

  it('reports every dangling mandatory relationship before activation', () => {
    const batch = completeGraph();
    batch.workflows[0].repositoryId = 'github:repository:missing';
    batch.workflows[0].packageId = 'package:fixture:missing';
    batch.runs[0].workflowId = 'github:workflow:missing';
    batch.jobs[0].runId = 'github:run:missing:attempt:1';
    batch.sessions[0].jobId = 'github:job:missing';
    batch.events[0].sessionId = 'session:missing';

    expect(relationshipErrors(batch)).toEqual([
      'github:workflow:2.repositoryId does not reference an existing repository',
      'github:workflow:2.packageId does not reference an existing package',
      'github:run:3:attempt:1.workflowId does not reference an existing workflow',
      'github:job:4.runId does not reference an existing run',
      'session:5.jobId does not reference an existing job',
      'event:6.sessionId does not reference an existing session'
    ]);
  });

  it('rejects relationships that cross canonical parent boundaries', () => {
    const batch = completeGraph();
    batch.repositories.push({ id: 'github:repository:7' });
    batch.workflows.push({ id: 'github:workflow:8', repositoryId: 'github:repository:7' });
    batch.runs[0].workflowId = 'github:workflow:8';
    batch.runs.push({
      id: 'github:run:9:attempt:1',
      repositoryId: 'github:repository:1',
      workflowId: 'github:workflow:2'
    });
    batch.jobs[0].runId = 'github:run:9:attempt:1';

    expect(relationshipErrors(batch)).toEqual([
      'github:run:3:attempt:1.workflowId references a workflow from another repository',
      'session:5.jobId references a job from another run'
    ]);
  });
});