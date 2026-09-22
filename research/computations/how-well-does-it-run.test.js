import { describe, expect, it } from 'vitest';
import {
  computeHowWellPortfolio,
  evaluateHowWellPartition
} from './how-well-does-it-run.js';

/**
 * @param {Partial<Parameters<typeof evaluateHowWellPartition>[0]>} [overrides]
 * @returns {Parameters<typeof evaluateHowWellPartition>[0]}
 */
function partition(overrides = {}) {
  return /** @type {Parameters<typeof evaluateHowWellPartition>[0]} */ ({
    campaignId: 'campaign:dependabot',
    workflowId: 'workflow:update-planner',
    workflowRole: 'worker',
    targetRepositoryId: 'repository:github/gh-aw',
    targetScopeMembership: 'expected',
    runtimeAnswer: 'yes',
    evidenceWindowStart: '2026-08-24T00:00:00Z',
    evidenceWindowEnd: '2026-09-22T00:00:00Z',
    successfulRuns: [],
    ...overrides
  });
}

/**
 * @param {number} id
 * @param {Record<string, unknown>} [overrides]
 */
function run(id, overrides = {}) {
  return {
    id: `github:run:${id}:attempt:1`,
    githubRunId: id,
    conclusion: 'success',
    observedAt: '2026-09-22T00:00:00Z',
    runLink: `https://github.example/runs/${id}`,
    ...overrides
  };
}

describe('how-well-does-it-run computation', () => {
  it('deduplicates repeated output observations and preserves output kinds', () => {
    const output = {
      correlationId: 'https://github.com/github/gh-aw/issues/1',
      type: 'safe_output.created',
      status: 'created',
      safeOutputType: 'create_issue',
      url: 'https://github.com/github/gh-aw/issues/1'
    };
    const result = evaluateHowWellPartition(partition({
      successfulRuns: [run(1, {
        safeItemsCount: 1,
        outputs: [output, { ...output, observedAt: '2026-09-22T00:01:00Z' }]
      })]
    }));

    expect(result).toMatchObject({
      productionState: 'produced',
      producerReportedOutputCount: 1,
      distinctOutputCount: 1,
      outputKinds: { create_issue: 1 },
      valueMeasurementState: 'not-configured'
    });
  });

  it('retains producer output evidence when detailed records expired', () => {
    const result = evaluateHowWellPartition(partition({
      successfulRuns: [run(7, { safeItemsCount: 2 })]
    }));

    expect(result).toMatchObject({
      productionState: 'produced',
      producerReportedOutputCount: 2,
      distinctOutputCount: 0,
      outputEvidenceCoverage: 1
    });
  });

  it('keeps measured value separate from produced output', () => {
    const result = evaluateHowWellPartition(partition({
      successfulRuns: [run(2, {
        safeItemsCount: 0,
        outputs: [],
        operationalValueResults: [{
          status: 'pass',
          value: 0,
          unit: 'ratio',
          direction: 'higher_is_better'
        }],
        aic: 12,
        durationSeconds: 30
      })]
    }));

    expect(result).toMatchObject({
      productionState: 'none-observed',
      valueMeasurementState: 'measured',
      measuredOperationalValues: [{
        runId: 'github:run:2:attempt:1',
        value: 0,
        unit: 'ratio',
        direction: 'higher_is_better'
      }],
      efficiencyState: 'measured',
      aic: { total: 12, median: 12 },
      durationSeconds: { total: 30, median: 30 }
    });
  });

  it('reports grader failure without converting it to zero value', () => {
    const result = evaluateHowWellPartition(partition({
      successfulRuns: [run(3, {
        outputs: [],
        operationalValueResults: [{ status: 'error', value: null }]
      })]
    }));

    expect(result.valueMeasurementState).toBe('evaluation-error');
    expect(result.measuredOperationalValues).toEqual([]);
  });

  it('does not infer no output when output evidence is missing', () => {
    const result = evaluateHowWellPartition(partition({
      successfulRuns: [run(4)]
    }));

    expect(result.productionState).toBe('unknown');
    expect(result.outputEvidenceCoverage).toBe(0);
  });

  it('rejects failed runtime partitions on the default path', () => {
    expect(() => evaluateHowWellPartition(partition({
      runtimeAnswer: /** @type {any} */ ('no'),
      successfulRuns: [run(8, { safeItemsCount: 1 })]
    }))).toThrow(/runtimeAnswer/);
  });

  it('aggregates partition totals without a composite quality score', () => {
    const result = computeHowWellPortfolio({
      partitions: [
        partition({ successfulRuns: [run(5, { safeItemsCount: 0, outputs: [] })] }),
        partition({
          targetRepositoryId: 'repository:github/gh-aw-firewall',
          successfulRuns: [run(6, {
            safeItemsCount: 1,
            outputs: [{ id: 'issue:1', safeOutputType: 'create_issue' }]
          })]
        })
      ]
    });

    expect(result.totals).toEqual({
      partitionCount: 2,
      successfulRunCount: 2,
      distinctOutputCount: 1,
      measuredOperationalValueCount: 0
    });
    expect(result).not.toHaveProperty('score');
  });
});
