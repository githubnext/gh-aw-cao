import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  computeIntelligencePortfolio,
  intelligenceFingerprint
} from '../../activity/computations/intelligence.mjs';
import {
  COMPUTATION_NAMES,
  computeIntelligenceFromCanonicalData,
  hasComputation
} from '../../activity/computations/index.mjs';
import { runCli } from '../../activity/cao.mjs';

function runtimeHealth(overrides = {}) {
  const partitionResults = [
    partition('workflow:a', 'repository:a'),
    partition('workflow:b', 'repository:b')
  ];
  return {
    measureId: 'runtime-health',
    measureVersion: '1.0.0',
    campaignResults: [],
    partitionResults,
    errorGroups: [
      errorGroup('workflow:a', 'repository:a', 2, 101),
      errorGroup('workflow:b', 'repository:b', 1, 102)
    ],
    ...overrides
  };
}

function partition(workflowId, targetRepositoryId, overrides = {}) {
  return {
    campaignId: 'campaign:maintenance',
    workflowId,
    workflowRole: 'worker',
    targetRepositoryId,
    targetScopeMembership: 'expected',
    recoveryMayBeInProgress: false,
    ...overrides
  };
}

function errorGroup(workflowId, targetRepositoryId, count, runId, overrides = {}) {
  return {
    campaignId: 'campaign:maintenance',
    workflowId,
    workflowRole: 'worker',
    targetRepositoryId,
    targetScopeMembership: 'expected',
    errorKey: 'driver-exit',
    count,
    distinctRunAttemptCount: count,
    latestObservedAt: `2026-09-22T${String(runId - 90).padStart(2, '0')}:00:00Z`,
    runReferences: [{
      runId: `github:run:${runId}:attempt:1`,
      githubRunId: runId,
      attempt: 1
    }],
    ...overrides
  };
}

test('intelligence correlates matching signals into one deterministic advisory Decision', () => {
  const input = runtimeHealth();
  const first = computeIntelligencePortfolio(input);
  const second = computeIntelligencePortfolio({
    ...input,
    partitionResults: input.partitionResults.toReversed(),
    errorGroups: input.errorGroups.toReversed()
  });

  assert.deepEqual(second, first);
  assert.equal(first.agentInvocations, 0);
  assert.equal(first.signalCount, 2);
  assert.equal(first.correlatedCandidateCount, 1);
  assert.equal(first.decisionCount, 1);
  assert.equal(first.decisions[0].state, 'act-now');
  assert.equal(first.decisions[0].recommendation.dispatchable, false);
  assert.deepEqual(first.decisions[0].subject.workflowIds, ['workflow:a', 'workflow:b']);
  assert.deepEqual(first.decisions[0].subject.targetRepositoryIds, [
    'repository:a',
    'repository:b'
  ]);
  assert.match(first.decisions[0].inputFingerprint, /^sha256:[a-f0-9]{64}$/);
});

test('intelligence suppresses out-of-scope and recovering signals before correlation', () => {
  const input = runtimeHealth({
    partitionResults: [
      partition('workflow:a', 'repository:a', { recoveryMayBeInProgress: true }),
      partition('workflow:b', 'repository:b', {
        targetScopeMembership: 'observed-extra'
      })
    ],
    errorGroups: [
      errorGroup('workflow:a', 'repository:a', 1, 101),
      errorGroup('workflow:b', 'repository:b', 1, 102, {
        targetScopeMembership: 'observed-extra'
      })
    ]
  });
  const result = computeIntelligencePortfolio(input);

  assert.equal(result.decisionCount, 0);
  assert.deepEqual(result.suppressions.map((item) => item.rule).sort(), [
    'outside-declared-target-scope',
    'recovery-in-progress'
  ]);
});

test('intelligence reuses unchanged Decisions and suppresses unchanged terminal results', () => {
  const initial = computeIntelligencePortfolio(runtimeHealth());
  const reused = computeIntelligencePortfolio(runtimeHealth(), {
    previousResult: initial
  });
  assert.deepEqual(reused.decisions, initial.decisions);
  assert.deepEqual(reused.reusedDecisionIds, [initial.decisions[0].decisionId]);

  const terminal = structuredClone(initial);
  terminal.decisions[0].disposition = 'accepted';
  const suppressed = computeIntelligencePortfolio(runtimeHealth(), {
    previousResult: terminal
  });
  assert.equal(suppressed.decisionCount, 0);
  assert.equal(suppressed.suppressions[0].rule, 'unchanged-terminal-result');
  assert.equal(suppressed.suppressions[0].relatedDecisionId, initial.decisions[0].decisionId);
});

test('changed evidence preserves Decision identity but changes its input fingerprint', () => {
  const initial = computeIntelligencePortfolio(runtimeHealth());
  const changedInput = runtimeHealth();
  changedInput.errorGroups[0] = errorGroup('workflow:a', 'repository:a', 3, 103);
  const changed = computeIntelligencePortfolio(changedInput, {
    previousResult: initial
  });

  assert.equal(changed.decisions[0].decisionId, initial.decisions[0].decisionId);
  assert.notEqual(
    changed.decisions[0].inputFingerprint,
    initial.decisions[0].inputFingerprint
  );
  assert.deepEqual(changed.reusedDecisionIds, []);
});

test('intelligence is registered and computes from canonical runtime-health evidence', () => {
  assert.deepEqual(COMPUTATION_NAMES, ['intelligence', 'runtime-health']);
  assert.equal(hasComputation('intelligence'), true);
  const output = computeIntelligenceFromCanonicalData({
    campaigns: [{
      id: 'campaign:inventory:maintenance',
      slug: 'maintenance',
      targets: [{ repository: 'octo/target' }]
    }],
    repositories: [{
      id: 'repository:target',
      fullName: 'octo/target'
    }],
    workflows: [{
      id: 'workflow:maintenance',
      campaignId: 'campaign:inventory:maintenance',
      role: 'orchestrator',
      state: 'active'
    }],
    runs: [{
      id: 'github:run:101:attempt:1',
      workflowId: 'workflow:maintenance',
      githubRunId: 101,
      attempt: 1,
      status: 'completed',
      conclusion: 'failure',
      failureKind: 'driver-exit',
      startedAt: '2026-09-22T11:00:00Z'
    }]
  });

  assert.equal(output.command, 'computation');
  assert.equal(output.computation, 'intelligence');
  assert.equal(output.result.decisionCount, 1);
  assert.equal(output.result.decisions[0].decisionClass, 'protect');
});

test('fingerprints are canonical and reject non-JSON values', () => {
  assert.equal(
    intelligenceFingerprint({ b: 2, a: { d: 4, c: 3 } }),
    intelligenceFingerprint({ a: { c: 3, d: 4 }, b: 2 })
  );
  assert.throws(() => intelligenceFingerprint({ invalid: undefined }), /undefined/);
  assert.throws(() => intelligenceFingerprint({ invalid: Number.NaN }), /finite/);
});

test('cao computation intelligence accepts prior output and rejects unsupported diagnostics', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cao-intelligence-'));
  const inventory = path.join(root, 'inventory-sources.json');
  const previous = path.join(root, 'previous.json');
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
  await writeFile(previous, JSON.stringify(computeIntelligencePortfolio(runtimeHealth())));

  const output = await runCli([
    'computation',
    'intelligence',
    '--database',
    path.join(root, 'activity.sqlite'),
    '--inventory',
    inventory,
    '--previous',
    previous
  ]);
  assert.equal(output.computation, 'intelligence');
  assert.equal(output.result.agentInvocations, 0);
  await assert.rejects(
    runCli([
      'computation',
      'intelligence',
      '--database',
      path.join(root, 'activity.sqlite'),
      '--inventory',
      inventory,
      '--campaign',
      'maintenance',
      '--diagnose'
    ]),
    /--diagnose is supported only for the runtime-health computation/
  );
});
