import { describe, expect, it } from 'vitest';
import {
  computeDoesItRunCampaign,
  evaluateDoesItRunPartition,
  workerEvaluationState
} from './does-it-run.js';

/**
 * @param {number} id
 * @param {string|null} conclusion
 * @param {string} startedAt
 * @param {Record<string, unknown>} [overrides]
 */
function run(id, conclusion, startedAt, overrides = {}) {
  return {
    id: `github:run:${id}:attempt:1`,
    githubRunId: id,
    attempt: 1,
    status: conclusion ? 'completed' : 'in_progress',
    conclusion,
    startedAt,
    runLink: `https://github.example/runs/${id}`,
    ...overrides
  };
}

/**
 * @param {Partial<Parameters<typeof evaluateDoesItRunPartition>[0]>} [overrides]
 * @returns {Parameters<typeof evaluateDoesItRunPartition>[0]}
 */
function partition(overrides = {}) {
  return /** @type {Parameters<typeof evaluateDoesItRunPartition>[0]} */ ({
    campaignId: 'campaign:dependabot',
    workflowId: 'workflow:update-planner',
    workflowRole: 'worker',
    workflowState: 'active',
    targetRepositoryId: 'repository:github/gh-aw',
    targetScopeMembership: 'expected',
    orderedNewestFirst: true,
    runs: [],
    ...overrides
  });
}

describe('does-it-run computation', () => {
  it('stops at the latest success and groups only newer failures', () => {
    const result = evaluateDoesItRunPartition(partition({
      runs: [
        run(105, null, '2026-09-22T05:00:00Z'),
        run(104, 'failure', '2026-09-22T04:00:00Z', { failureKind: 'rate-limit' }),
        run(103, 'failure', '2026-09-22T03:00:00Z', { failureKind: 'rate-limit' }),
        run(102, 'success', '2026-09-22T02:00:00Z'),
        run(101, 'failure', '2026-09-22T01:00:00Z', { failureKind: 'old-error' })
      ]
    }));

    expect(result).toMatchObject({
      answer: 'no',
      runsSinceSuccess: 3,
      terminalNonSuccessesSinceSuccess: 2,
      activeRunsSinceSuccess: 1,
      recordsVisited: 4,
      partitionRunCount: 5,
      latestSuccess: { githubRunId: 102 }
    });
    expect(result.errorGroups).toEqual([expect.objectContaining({
      errorKey: 'rate-limit',
      count: 2,
      distinctRunAttemptCount: 2,
      conclusionCounts: { failure: 2 },
      omittedRunReferenceCount: 0
    })]);
  });

  it('rejects partitions that violate the declarative newest-first contract', () => {
    expect(() => evaluateDoesItRunPartition(partition({
      runs: [
        run(501, 'success', '2026-09-22T01:00:00Z'),
        run(502, 'failure', '2026-09-22T02:00:00Z')
      ]
    }))).toThrow(/newest-first/);
  });

  it('keeps target success boundaries independent', () => {
    const failing = evaluateDoesItRunPartition(partition({
      targetRepositoryId: 'repository:github/gh-aw',
      runs: [
        run(202, 'failure', '2026-09-22T02:00:00Z'),
        run(201, 'success', '2026-09-22T01:00:00Z')
      ]
    }));
    const healthy = evaluateDoesItRunPartition(partition({
      targetRepositoryId: 'repository:github/gh-aw-firewall',
      targetScopeMembership: 'observed-extra',
      runs: [run(203, 'success', '2026-09-22T03:00:00Z')]
    }));

    expect(failing.answer).toBe('no');
    expect(healthy.answer).toBe('yes');
  });

  it('gates workers when the orchestrator fails', () => {
    const result = computeDoesItRunCampaign({
      campaignId: 'campaign:dependabot',
      orchestratorPartitions: [partition({
        workflowId: 'workflow:dependabot',
        workflowRole: 'orchestrator',
        targetRepositoryId: null,
        targetScopeMembership: null,
        runs: [run(301, 'failure', '2026-09-22T03:00:00Z')]
      })],
      workerPartitions: [partition({
        runs: [run(302, 'success', '2026-09-22T04:00:00Z')]
      })]
    });

    expect(result.campaignResult).toMatchObject({
      answer: 'no',
      workerEvaluationState: 'blocked-by-orchestrator',
      workerPartitionCount: 0,
      skippedWorkerPartitionCount: 1,
      skippedWorkerRunCount: 1
    });
    expect(result.partitionResults).toHaveLength(1);
  });

  it('treats missing orchestrator evidence as indeterminate', () => {
    const orchestrator = evaluateDoesItRunPartition(partition({
      workflowId: 'workflow:dependabot',
      workflowRole: 'orchestrator',
      targetRepositoryId: null,
      targetScopeMembership: null,
      runs: []
    }));

    expect(orchestrator.answer).toBe('not-observed');
    expect(workerEvaluationState([orchestrator])).toBe('indeterminate-orchestrator');
  });

  it('excludes observed-extra workers from configured campaign health', () => {
    const result = computeDoesItRunCampaign({
      campaignId: 'campaign:dependabot',
      orchestratorPartitions: [partition({
        workflowId: 'workflow:dependabot',
        workflowRole: 'orchestrator',
        targetRepositoryId: null,
        targetScopeMembership: null,
        runs: [run(401, 'success', '2026-09-22T01:00:00Z')]
      })],
      workerPartitions: [
        partition({ runs: [run(402, 'success', '2026-09-22T02:00:00Z')] }),
        partition({
          targetRepositoryId: 'repository:github/gh-aw-firewall',
          targetScopeMembership: 'observed-extra',
          runs: [run(403, 'failure', '2026-09-22T03:00:00Z')]
        })
      ]
    });

    expect(result.campaignResult.answer).toBe('yes');
    expect(result.partitionResults).toHaveLength(3);
  });
});
