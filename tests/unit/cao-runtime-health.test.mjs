import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import {
  buildRuntimeHealthInput,
  computeRuntimeHealthFromCanonicalData
} from '../../activity/computations/index.mjs';
import {
  computeRuntimeHealthCampaign,
  evaluateRuntimeHealthPartition,
  workerEvaluationState
} from '../../activity/computations/runtime-health.mjs';
import { runCli } from '../../activity/cao.mjs';

function fixture() {
  return {
    campaigns: [
      {
        id: 'campaign:inventory:maintenance',
        slug: 'maintenance',
        targets: [{ repository: 'octo/expected' }]
      },
      {
        id: 'campaign:inventory:blocked',
        slug: 'blocked',
        targets: [{ repository: 'octo/expected' }]
      }
    ],
    repositories: [
      { id: 'repository:expected', fullName: 'octo/expected' },
      { id: 'repository:extra', fullName: 'octo/extra' }
    ],
    workflows: [
      {
        id: 'workflow:maintenance',
        campaignId: 'campaign:inventory:maintenance',
        role: 'orchestrator',
        state: 'active'
      },
      {
        id: 'workflow:maintenance-worker',
        campaignId: 'campaign:inventory:maintenance',
        role: 'worker',
        state: 'active'
      },
      {
        id: 'workflow:blocked',
        campaignId: 'campaign:inventory:blocked',
        role: 'orchestrator',
        state: 'active'
      },
      {
        id: 'workflow:blocked-worker',
        campaignId: 'campaign:inventory:blocked',
        role: 'worker',
        state: 'active'
      }
    ],
    runs: [
      run(100, 'workflow:maintenance', 'success', '2026-09-22T10:00:00Z'),
      run(102, 'workflow:maintenance-worker', 'failure', '2026-09-22T12:00:00Z', 'octo/expected'),
      run(101, 'workflow:maintenance-worker', 'success', '2026-09-22T11:00:00Z', 'octo/expected'),
      run(103, 'workflow:maintenance-worker', 'failure', '2026-09-22T13:00:00Z', 'octo/extra'),
      run(200, 'workflow:blocked', 'failure', '2026-09-22T10:00:00Z'),
      run(201, 'workflow:blocked-worker', 'success', '2026-09-22T11:00:00Z', 'octo/expected')
    ]
  };
}

function run(id, workflowId, conclusion, startedAt, targetRepository) {
  return {
    id: `github:run:${id}:attempt:1`,
    workflowId,
    githubRunId: id,
    attempt: 1,
    status: 'completed',
    conclusion,
    startedAt,
    targetRepository,
    runLink: `https://github.com/octo/control/actions/runs/${id}`
  };
}

function measureRun(id, conclusion, startedAt, overrides = {}) {
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

function measurePartition(overrides = {}) {
  return {
    campaignId: 'campaign:dependabot',
    workflowId: 'workflow:update-planner',
    workflowRole: 'worker',
    workflowState: 'active',
    targetRepositoryId: 'repository:github/gh-aw',
    targetScopeMembership: 'expected',
    orderedNewestFirst: true,
    runs: [],
    ...overrides
  };
}

test('runtime-health stops at the latest success and groups only newer failures', () => {
  const result = evaluateRuntimeHealthPartition(measurePartition({
    runs: [
      measureRun(105, null, '2026-09-22T05:00:00Z'),
      measureRun(104, 'failure', '2026-09-22T04:00:00Z', { failureKind: 'rate-limit' }),
      measureRun(103, 'failure', '2026-09-22T03:00:00Z', { failureKind: 'rate-limit' }),
      measureRun(102, 'success', '2026-09-22T02:00:00Z'),
      measureRun(101, 'failure', '2026-09-22T01:00:00Z', { failureKind: 'old-error' })
    ]
  }));

  assert.deepEqual({
    answer: result.answer,
    runsSinceSuccess: result.runsSinceSuccess,
    terminalNonSuccessesSinceSuccess: result.terminalNonSuccessesSinceSuccess,
    activeRunsSinceSuccess: result.activeRunsSinceSuccess,
    recordsVisited: result.recordsVisited,
    partitionRunCount: result.partitionRunCount,
    latestSuccess: result.latestSuccess?.githubRunId
  }, {
    answer: 'no',
    runsSinceSuccess: 3,
    terminalNonSuccessesSinceSuccess: 2,
    activeRunsSinceSuccess: 1,
    recordsVisited: 4,
    partitionRunCount: 5,
    latestSuccess: 102
  });
  assert.equal(result.errorGroups.length, 1);
  assert.deepEqual({
    errorKey: result.errorGroups[0].errorKey,
    count: result.errorGroups[0].count,
    distinctRunAttemptCount: result.errorGroups[0].distinctRunAttemptCount,
    conclusionCounts: result.errorGroups[0].conclusionCounts,
    omittedRunReferenceCount: result.errorGroups[0].omittedRunReferenceCount
  }, {
    errorKey: 'rate-limit',
    count: 2,
    distinctRunAttemptCount: 2,
    conclusionCounts: { failure: 2 },
    omittedRunReferenceCount: 0
  });
});

test('runtime-health rejects partitions outside newest-first query order', () => {
  assert.throws(() => evaluateRuntimeHealthPartition(measurePartition({
    runs: [
      measureRun(501, 'success', '2026-09-22T01:00:00Z'),
      measureRun(502, 'failure', '2026-09-22T02:00:00Z')
    ]
  })), /newest-first/);
});

test('runtime-health gates workers when the orchestrator fails', () => {
  const result = computeRuntimeHealthCampaign({
    campaignId: 'campaign:dependabot',
    orchestratorPartitions: [measurePartition({
      workflowId: 'workflow:dependabot',
      workflowRole: 'orchestrator',
      targetRepositoryId: null,
      targetScopeMembership: null,
      runs: [measureRun(301, 'failure', '2026-09-22T03:00:00Z')]
    })],
    workerPartitions: [measurePartition({
      runs: [measureRun(302, 'success', '2026-09-22T04:00:00Z')]
    })]
  });

  assert.deepEqual({
    answer: result.campaignResult.answer,
    gate: result.campaignResult.workerEvaluationState,
    workers: result.campaignResult.workerPartitionCount,
    skippedPartitions: result.campaignResult.skippedWorkerPartitionCount,
    skippedRuns: result.campaignResult.skippedWorkerRunCount
  }, {
    answer: 'no',
    gate: 'blocked-by-orchestrator',
    workers: 0,
    skippedPartitions: 1,
    skippedRuns: 1
  });
  assert.equal(result.partitionResults.length, 1);
});

test('runtime-health treats missing orchestrator evidence as indeterminate', () => {
  const orchestrator = evaluateRuntimeHealthPartition(measurePartition({
    workflowId: 'workflow:dependabot',
    workflowRole: 'orchestrator',
    targetRepositoryId: null,
    targetScopeMembership: null,
    runs: []
  }));

  assert.equal(orchestrator.answer, 'not-observed');
  assert.equal(workerEvaluationState([orchestrator]), 'indeterminate-orchestrator');
});

test('runtime-health excludes observed-extra workers from configured campaign health', () => {
  const result = computeRuntimeHealthCampaign({
    campaignId: 'campaign:dependabot',
    orchestratorPartitions: [measurePartition({
      workflowId: 'workflow:dependabot',
      workflowRole: 'orchestrator',
      targetRepositoryId: null,
      targetScopeMembership: null,
      runs: [measureRun(401, 'success', '2026-09-22T01:00:00Z')]
    })],
    workerPartitions: [
      measurePartition({ runs: [measureRun(402, 'success', '2026-09-22T02:00:00Z')] }),
      measurePartition({
        targetRepositoryId: 'repository:github/gh-aw-firewall',
        targetScopeMembership: 'observed-extra',
        runs: [measureRun(403, 'failure', '2026-09-22T03:00:00Z')]
      })
    ]
  });

  assert.equal(result.campaignResult.answer, 'yes');
  assert.equal(result.partitionResults.length, 3);
});

test('runtime-health does not invent unselected worker partitions', () => {
  const result = computeRuntimeHealthCampaign({
    campaignId: 'campaign:conditional',
    orchestratorPartitions: [measurePartition({
      campaignId: 'campaign:conditional',
      workflowId: 'workflow:conditional',
      workflowRole: 'orchestrator',
      targetRepositoryId: null,
      targetScopeMembership: null,
      runs: [measureRun(501, 'success', '2026-09-22T01:00:00Z')]
    })],
    workerPartitions: []
  });

  assert.deepEqual({
    version: result.campaignResult.measureVersion,
    answer: result.campaignResult.answer,
    workers: result.campaignResult.workerPartitionCount,
    attention: result.campaignResult.attentionPartitionCount
  }, {
    version: '1.0.0',
    answer: 'yes',
    workers: 0,
    attention: 0
  });
});

test('runtime-health queries canonical relationships and preserves target-local success boundaries', () => {
  const output = computeRuntimeHealthFromCanonicalData(fixture());

  assert.equal(output.command, 'computation');
  assert.equal(output.computation, 'runtime-health');
  assert.equal(output.result.measureId, 'runtime-health');
  assert.equal(output.result.measureVersion, '1.0.0');
  assert.deepEqual(output.result.campaignResults.map((result) => ({
    campaignId: result.campaignId,
    answer: result.answer,
    gate: result.workerEvaluationState,
    workers: result.workerPartitionCount
  })), [
    {
      campaignId: 'campaign:inventory:blocked',
      answer: 'no',
      gate: 'blocked-by-orchestrator',
      workers: 0
    },
    {
      campaignId: 'campaign:inventory:maintenance',
      answer: 'no',
      gate: 'eligible',
      workers: 2
    }
  ]);

  const expectedTarget = output.result.partitionResults.find((result) => (
    result.targetRepositoryId === 'repository:expected'
  ));
  const extraTarget = output.result.partitionResults.find((result) => (
    result.targetRepositoryId === 'repository:extra'
  ));
  assert.equal(expectedTarget.answer, 'no');
  assert.equal(expectedTarget.latestSuccess.githubRunId, 101);
  assert.equal(extraTarget.answer, 'no');
  assert.equal(extraTarget.targetScopeMembership, 'observed-extra');
  assert.equal(output.result.partitionResults.some((result) => (
    result.workflowId === 'workflow:blocked-worker'
  )), false);
});

test('runtime-health diagnosis drills from a failure group to bounded canonical evidence', () => {
  const data = fixture();
  Object.assign(data.runs.find((candidate) => candidate.githubRunId === 102), {
    failureKind: 'driver-exit',
    classification: 'runtime',
    ghAwVersion: '0.89.17',
    engine: 'copilot',
    requestedModel: 'model-new'
  });
  Object.assign(data.runs.find((candidate) => candidate.githubRunId === 101), {
    ghAwVersion: '0.89.16',
    engine: 'copilot',
    requestedModel: 'model-old'
  });
  const failedRunId = 'github:run:102:attempt:1';
  Object.assign(data, {
    audits: [{
      id: 'audit:102',
      runId: failedRunId,
      type: 'workflow_run_grader',
      status: 'error',
      summary: 'Post-run grader failed',
      prompt: 'must not be exposed'
    }],
    tools: [{
      id: 'tool:102',
      runId: failedRunId,
      type: 'tool.error',
      status: 'error',
      summary: 'Tool call did not complete',
      mcpServer: 'github',
      mcpTool: 'get_file_contents',
      responseBody: 'must not be exposed'
    }],
    domains: [{
      id: 'domain:102',
      runId: failedRunId,
      domain: 'api.github.com',
      decision: 'blocked',
      requestCount: 2
    }],
    issues: [{
      id: 'issue:102',
      runId: failedRunId,
      type: 'safe_output.created',
      status: 'created',
      summary: 'Created investigation issue',
      correlationId: 'https://github.com/octo/expected/issues/42'
    }]
  });

  const output = computeRuntimeHealthFromCanonicalData(data, {
    campaign: 'maintenance',
    diagnose: true
  });
  const diagnosis = output.result.diagnostics.failures.find((candidate) => (
    candidate.errorGroup.targetRepositoryId === 'repository:expected'
  ));

  assert.equal(output.result.diagnostics.omittedGroupCount, 0);
  assert.equal(diagnosis.errorGroup.errorKey, 'driver-exit');
  assert.equal(diagnosis.failedRuns[0].githubRunId, 102);
  assert.equal(diagnosis.latestSuccess.githubRunId, 101);
  assert.deepEqual(diagnosis.changedRuntimeFields, {
    ghAwVersion: {
      failed: '0.89.17',
      latestSuccess: '0.89.16'
    },
    requestedModel: {
      failed: 'model-new',
      latestSuccess: 'model-old'
    }
  });
  assert.equal(diagnosis.evidence.audits[0].summary, 'Post-run grader failed');
  assert.equal(diagnosis.evidence.toolErrors[0].mcpTool, 'get_file_contents');
  assert.equal(diagnosis.evidence.firewallBlocks[0].requestCount, 2);
  assert.equal(diagnosis.evidence.safeOutputs[0].safeOutputType, null);
  assert.deepEqual(diagnosis.actionsRun, {
    url: 'https://github.com/octo/control/actions/runs/102',
    reason: 'Canonical evidence does not contain the exact process error; inspect job logs and stderr.'
  });
  assert.doesNotMatch(JSON.stringify(diagnosis), /must not be exposed/);
});

test('runtime-health campaign selection fails closed for an unknown slug', () => {
  const data = fixture();
  assert.throws(() => buildRuntimeHealthInput(
    data.campaigns,
    data.workflows,
    data.runs,
    data.repositories,
    'missing'
  ), /Unknown campaign: missing/);
});

test('cao computation runtime-health routes through the extensible computation namespace', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cao-runtime-health-'));
  const inventory = path.join(root, 'inventory-sources.json');
  await writeFile(inventory, JSON.stringify({
    campaigns: {
      rows: [{
        campaign: 'maintenance',
        'campaign-name': 'Maintenance',
        'observed-at': '2026-09-22T10:00:00Z'
      }],
      metadata: { 'as-of': '2026-09-22T10:00:00Z' }
    },
    repositories: {
      rows: [{
        organization: 'octo',
        repository: 'control',
        'observed-at': '2026-09-22T10:00:00Z'
      }],
      metadata: { 'as-of': '2026-09-22T10:00:00Z' }
    },
    workflows: {
      rows: [{
        organization: 'octo',
        repository: 'control',
        workflow: '.github/workflows/maintenance.md',
        campaign: 'maintenance',
        'workflow-role': 'orchestrator',
        'workflow-active': 'true',
        'observed-at': '2026-09-22T10:00:00Z'
      }],
      metadata: { 'as-of': '2026-09-22T10:00:00Z' }
    }
  }));
  const output = await runCli([
    'computation',
    'runtime-health',
    '--database',
    path.join(root, 'activity.sqlite')
  ]);

  assert.equal(output.command, 'computation');
  assert.equal(output.computation, 'runtime-health');
  assert.equal(output.result.measureId, 'runtime-health');
  assert.equal(output.result.campaignResults.length, 1);
  assert.equal(output.result.campaignResults[0].answer, 'unknown');
  await assert.rejects(
    runCli(['computation', 'does-it-run', '--database', path.join(root, 'activity.sqlite')]),
    /Unknown computation: does-it-run/
  );
});

test('runtime-health query and computation median stays below 20 ms', () => {
  const data = performanceFixture(20, 20);
  for (let index = 0; index < 5; index += 1) computeRuntimeHealthFromCanonicalData(data);

  const durations = [];
  for (let index = 0; index < 25; index += 1) {
    const startedAt = performance.now();
    computeRuntimeHealthFromCanonicalData(data);
    durations.push(performance.now() - startedAt);
  }
  durations.sort((left, right) => left - right);
  const median = durations[Math.floor(durations.length / 2)];
  assert.ok(median < 20, `expected median runtime below 20 ms, received ${median.toFixed(3)} ms`);
});

function performanceFixture(campaignCount, runsPerWorkflow) {
  const campaigns = [];
  const workflows = [];
  const runs = [];
  for (let campaignIndex = 0; campaignIndex < campaignCount; campaignIndex += 1) {
    const campaignId = `campaign:inventory:campaign-${campaignIndex}`;
    const orchestratorId = `workflow:orchestrator-${campaignIndex}`;
    const workerId = `workflow:worker-${campaignIndex}`;
    campaigns.push({
      id: campaignId,
      slug: `campaign-${campaignIndex}`,
      targets: [{ repository: `octo/target-${campaignIndex}` }]
    });
    workflows.push(
      { id: orchestratorId, campaignId, role: 'orchestrator', state: 'active' },
      { id: workerId, campaignId, role: 'worker', state: 'active' }
    );
    runs.push(run(
      campaignIndex * 10_000 + 9_999,
      orchestratorId,
      'success',
      '2026-09-22T15:00:00Z'
    ));
    for (let runIndex = 0; runIndex < runsPerWorkflow; runIndex += 1) {
      runs.push(run(
        campaignIndex * 10_000 + runIndex + 1,
        workerId,
        runIndex === runsPerWorkflow - 1 ? 'success' : 'failure',
        new Date(Date.UTC(2026, 8, 22, 14, 0, -runIndex)).toISOString(),
        `octo/target-${campaignIndex}`
      ));
    }
  }
  return {
    campaigns,
    workflows,
    runs,
    repositories: campaigns.map((campaign, index) => ({
      id: `repository:target-${index}`,
      fullName: campaign.targets[0].repository
    }))
  };
}
