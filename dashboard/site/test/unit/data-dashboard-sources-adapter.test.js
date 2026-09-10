import { describe, expect, it } from 'vitest';
import { adaptDashboardSources } from '../../src/data/adapters/dashboard-sources.js';
import { relationshipErrors } from '../../src/data/model/schema.js';
import { normalize } from '../../src/data/normalize/index.js';

const metadata = {
  'as-of': '2026-09-09T05:00:00Z',
  'artifact-generation': 'abc123'
};

describe('current dashboard source adapter', () => {
  it('converts real source-shaped repository, workflow, and run rows', () => {
    const adapted = adaptDashboardSources({
      repositories: {
        rows: [{
          organization: 'githubnext', repository: 'gh-aw-cao', 'observed-at': '2026-09-09T04:00:00Z',
          'organization-link': { relation: 'organization', href: 'https://github.com/githubnext' },
          'repository-link': { relation: 'repository', href: 'https://github.com/githubnext/gh-aw-cao' }
        }],
        metadata
      },
      workflows: {
        rows: [{
          organization: 'githubnext',
          repository: 'gh-aw-cao',
          workflow: '.github/workflows/dashboard.md',
          'workflow-name': 'Dashboard',
          'workflow-active': 'true',
          'gh-aw-version': '0.88.8',
          'gh-aw-current-version': '0.88.9',
          'gh-aw-update-state': 'update-available',
          'workflow-link': { relation: 'workflow', href: 'https://github.com/githubnext/gh-aw-cao/actions' },
          'observed-at': '2026-09-09T04:30:00Z'
        }],
        metadata
      },
      runs: {
        rows: [{
          organization: 'githubnext',
          repository: 'gh-aw-cao',
          workflow: '.github/workflows/dashboard.md',
          run: '12345',
          'run-attempt': 2,
          event: 'workflow_dispatch',
          'run-status': 'completed',
          'run-conclusion': 'success',
          'rollout-mode': 'review',
          engine: 'copilot',
          'engine-version': '1.2.3',
          'requested-model': 'model-a',
          'resolved-model': 'model-b',
          'started-at': '2026-09-09T04:45:00Z',
          'ended-at': '2026-09-09T04:50:00Z'
        }],
        metadata
      },
      'job-performance': {
        rows: [{
          organization: 'githubnext',
          repository: 'gh-aw-cao',
          workflow: '.github/workflows/dashboard.md',
          run: '12345',
          'run-attempt': 2,
          'job-id': '67890',
          job: 'build',
          'job-status': 'completed',
          'job-conclusion': 'success',
          'started-at': '2026-09-09T04:46:00Z',
          'job-duration-seconds': 240,
          runner: 'ubuntu-latest',
          engine: 'copilot',
          model: 'model-b'
        }],
        metadata
      }
    });

    const batch = normalize(adapted.observations, { generation: adapted.generation });

    expect(adapted.generation).toBe('abc123');
    expect(batch.repositories[0]).toMatchObject({
      id: 'repository:dashboard-sources:githubnext%2Fgh-aw-cao',
      fullName: 'githubnext/gh-aw-cao',
      repositoryLink: { relation: 'repository', href: 'https://github.com/githubnext/gh-aw-cao' }
    });
    expect(batch.workflows[0]).toMatchObject({
      id: 'workflow:dashboard-sources:githubnext%2Fgh-aw-cao%3A.github%2Fworkflows%2Fdashboard.md',
      repositoryId: 'repository:dashboard-sources:githubnext%2Fgh-aw-cao',
      state: 'active',
      ghAwVersion: '0.88.8',
      ghAwUpdateState: 'update-available'
    });
    expect(batch.runs[0]).toMatchObject({
      id: 'github:run:12345:attempt:2',
      workflowId: batch.workflows[0].id,
      repositoryId: batch.repositories[0].id,
      status: 'completed',
      conclusion: 'success',
      rolloutMode: 'review',
      engine: 'copilot',
      engineVersion: '1.2.3',
      requestedModel: 'model-a',
      resolvedModel: 'model-b'
    });
    expect(batch.jobs[0]).toMatchObject({
      id: 'github:job:67890',
      runId: 'github:run:12345:attempt:2',
      name: 'build',
      conclusion: 'success',
      durationSeconds: 240,
      runner: 'ubuntu-latest',
      engine: 'copilot',
      model: 'model-b'
    });
  });

  it('rejects source documents without generation metadata', () => {
    expect(() => adaptDashboardSources({ repositories: { rows: [], metadata: {} } }))
      .toThrow('dashboard source generation is required');
  });

  it('rejects source documents containing multiple artifact generations', () => {
    const sources = {
      repositories: { rows: [], metadata },
      runs: {
        rows: [],
        metadata: { ...metadata, 'artifact-generation': 'different-generation' }
      }
    };

    expect(() => adaptDashboardSources(sources))
      .toThrow('Dashboard sources contain multiple artifact generations');
  });

  it('joins published transaction logs to canonical runs and jobs', () => {
    const sources = {
      repositories: {
        rows: [{ organization: 'githubnext', repository: 'gh-aw-cao' }],
        metadata
      },
      workflows: {
        rows: [{ organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dashboard.md' }],
        metadata
      },
      runs: {
        rows: [{
          organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dashboard.md',
          run: '303', 'run-attempt': 1, 'started-at': '2026-09-09T04:00:00Z'
        }],
        metadata
      },
      'job-performance': {
        rows: [{
          organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dashboard.md',
          run: '303', 'run-attempt': 1, 'job-id': '404', job: 'agent', 'started-at': '2026-09-09T04:00:00Z'
        }],
        metadata
      },
      sessions: {
        rows: [{
          run: '303', 'run-attempt': 1, 'job-id': '404', session: 'githubnext/gh-aw-cao:303:1:gh-aw',
          'session-kind': 'unified-operational-log', 'started-at': '2026-09-09T04:00:01Z'
        }],
        metadata
      },
      events: {
        rows: [{
          session: 'githubnext/gh-aw-cao:303:1:gh-aw', event: 'event-1',
          'event-timestamp': '2026-09-09T04:00:01Z', 'event-source': 'agent',
          'event-type': 'agent_turn', 'source-sequence': 1
        }],
        metadata
      }
    };

    const adapted = adaptDashboardSources(sources);
    const batch = normalize(adapted.observations, { generation: adapted.generation });

    expect(relationshipErrors(batch)).toEqual([]);
    expect(batch.sessions).toEqual([expect.objectContaining({
      runId: 'github:run:303:attempt:1', jobId: 'github:job:404'
    })]);
    expect(batch.events).toEqual([expect.objectContaining({
      sequence: 0, source: 'agent', type: 'agent_turn'
    })]);
  });

  it('reconciles retained transaction logs with the published run and job horizon', () => {
    const sources = {
      repositories: {
        rows: [{ organization: 'githubnext', repository: 'gh-aw-cao' }],
        metadata
      },
      workflows: {
        rows: [{ organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dashboard.md' }],
        metadata
      },
      runs: {
        rows: [{
          organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dashboard.md',
          run: '303', 'run-attempt': 1, 'started-at': '2026-09-09T04:00:00Z'
        }],
        metadata
      },
      'job-performance': { rows: [], metadata },
      sessions: {
        rows: [
          {
            run: '302', 'run-attempt': 1, 'job-id': '402', session: 'stale-session',
            'started-at': '2026-09-08T04:00:01Z'
          },
          {
            run: '303', 'run-attempt': 1, 'job-id': '403', session: 'current-session',
            'started-at': '2026-09-09T04:00:01Z'
          }
        ],
        metadata
      },
      events: {
        rows: [
          {
            session: 'stale-session', event: 'stale-event',
            'event-timestamp': '2026-09-08T04:00:01Z', 'event-source': 'agent', 'event-type': 'agent_turn'
          },
          {
            session: 'current-session', event: 'current-event',
            'event-timestamp': '2026-09-09T04:00:01Z', 'event-source': 'agent', 'event-type': 'agent_turn'
          }
        ],
        metadata
      }
    };

    const adapted = adaptDashboardSources(sources);
    const batch = normalize(adapted.observations, { generation: adapted.generation });

    expect(relationshipErrors(batch)).toEqual([]);
    expect(batch.sessions).toEqual([expect.objectContaining({
      id: 'current-session', runId: 'github:run:303:attempt:1'
    })]);
    expect(batch.sessions[0].jobId).toBeUndefined();
    expect(Object.keys(batch.sessions[0])).not.toContain('jobId');
    expect(batch.events).toEqual([expect.objectContaining({
      id: 'current-event', sessionId: 'current-session'
    })]);
  });
});