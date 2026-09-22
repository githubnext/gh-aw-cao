import { performance } from 'node:perf_hooks';
import { executeDashboardQuery } from '../../dashboard/site/src/data/queries/declarative.js';
import { queryDashboardSourceObservations } from '../../dashboard/site/src/data/queries/ingestion.js';
import { normalize } from '../../dashboard/site/src/data/normalize/index.js';
import { queryCollection, readCollection } from '../../dashboard/site/src/data/storage/indexeddb.js';
import { createDebug } from '../debug.mjs';
import {
  computeRuntimeHealthPortfolio,
  evaluateRuntimeHealthPartition,
  workerEvaluationState
} from './runtime-health.mjs';

export const COMPUTATION_NAMES = Object.freeze(['runtime-health']);
const debugRuntimeHealth = createDebug('computation:runtime-health');

export function hasComputation(name) {
  return COMPUTATION_NAMES.includes(name);
}

const WORKFLOW_ROLES = ['orchestrator', 'worker'];
const TARGET_MEMBERSHIPS = new Set(['expected', 'observed-extra', 'unknown']);
const DIAGNOSTIC_GROUP_LIMIT = 5;
const DIAGNOSTIC_RUN_LIMIT = 5;
const DIAGNOSTIC_RECORD_LIMIT = 20;
const RUNTIME_COMPARISON_FIELDS = [
  'ghAwVersion',
  'engine',
  'engineVersion',
  'agentVersion',
  'requestedModel',
  'resolvedModel',
  'firewallVersion'
];
const RUN_METADATA_FIELDS = [
  'id',
  'githubRunId',
  'attempt',
  'startedAt',
  'completedAt',
  'duration',
  'status',
  'conclusion',
  'failureKind',
  'classification',
  'targetRepository',
  'rolloutMode',
  ...RUNTIME_COMPARISON_FIELDS,
  'firewallAllowedCalls',
  'firewallBlockedCalls',
  'mcpToolCalls',
  'highPriorityAuditItems',
  'mediumPriorityAuditItems',
  'errorCount',
  'runLink'
];
const DIAGNOSTIC_RECORD_FIELDS = Object.freeze({
  audits: ['id', 'runId', 'timestamp', 'observedAt', 'source', 'type', 'status', 'summary', 'error'],
  tools: ['id', 'runId', 'timestamp', 'observedAt', 'type', 'status', 'summary', 'mcpServer', 'mcpTool'],
  domains: ['id', 'runId', 'timestamp', 'observedAt', 'domain', 'decision', 'requestCount'],
  issues: [
    'id',
    'runId',
    'timestamp',
    'observedAt',
    'type',
    'status',
    'summary',
    'safeOutputType',
    'correlationId'
  ]
});

function source(name, rows) {
  return {
    source: name,
    rows,
    metadata: {
      'source-id': name,
      'source-kind': 'canonical-query',
      availability: 'available',
      completeness: 'complete',
      freshness: 'unknown'
    }
  };
}

function executeQuery(definition, sources) {
  const result = executeDashboardQuery(definition, sources);
  if (result.metadata?.availability === 'unavailable') {
    throw new Error(String(result.metadata['query-diagnostic'] ?? `Query "${definition.name}" is unavailable`));
  }
  return result.rows;
}

  function selectedFields(record, fields) {
    return Object.fromEntries(fields.map((field) => [field, record?.[field] ?? null]));
  }

  function linkedEvidence(records, runId, fields, predicate = () => true) {
    const matches = runId
      ? records.filter((record) => String(record.runId) === runId && predicate(record))
      : [];
    return {
      records: matches
        .sort((left, right) => (
          String(right.timestamp ?? right.observedAt ?? '').localeCompare(
            String(left.timestamp ?? left.observedAt ?? '')
          )
          || String(left.id).localeCompare(String(right.id))
        ))
        .slice(0, DIAGNOSTIC_RECORD_LIMIT)
        .map((record) => selectedFields(record, fields)),
      omitted: Math.max(0, matches.length - DIAGNOSTIC_RECORD_LIMIT)
    };
  }

  function selectDiagnosticGroups(result) {
    const groups = result.errorGroups.slice(0, DIAGNOSTIC_GROUP_LIMIT);
    const partitionByKey = new Map(result.partitionResults.map((partitionResult) => [
      [
        partitionResult.campaignId,
        partitionResult.workflowId,
        partitionResult.targetRepositoryId ?? ''
      ].join('\0'),
      partitionResult
    ]));
    return groups.map((group) => {
      const key = [group.campaignId, group.workflowId, group.targetRepositoryId ?? ''].join('\0');
      const partitionResult = partitionByKey.get(key);
      return {
        group,
        partitionResult,
        failureRunIds: group.runReferences
          .slice(0, DIAGNOSTIC_RUN_LIMIT)
          .map((reference) => String(reference.runId)),
        latestSuccessId: partitionResult?.latestSuccess?.runId
          ? String(partitionResult.latestSuccess.runId)
          : null
      };
    });
}

export function buildRuntimeHealthDiagnostics(result, data) {
    const runsById = new Map(data.runs.map((run) => [String(run.id), run]));

    return {
      groupLimit: DIAGNOSTIC_GROUP_LIMIT,
      omittedGroupCount: Math.max(0, result.errorGroups.length - DIAGNOSTIC_GROUP_LIMIT),
      failures: selectDiagnosticGroups(result).map(({ group, latestSuccessId, failureRunIds }) => {
        const failedRuns = failureRunIds.map((runId) => runsById.get(runId)).filter(Boolean);
        const latestFailure = failedRuns[0] ?? null;
        const latestSuccess = latestSuccessId ? runsById.get(latestSuccessId) ?? null : null;
        const evidenceRunId = latestFailure ? String(latestFailure.id) : null;
        const audits = linkedEvidence(data.audits ?? [], evidenceRunId, DIAGNOSTIC_RECORD_FIELDS.audits);
        const toolErrors = linkedEvidence(
          data.tools ?? [],
          evidenceRunId,
          DIAGNOSTIC_RECORD_FIELDS.tools,
          (record) => record.type === 'tool.error'
        );
        const firewallBlocks = linkedEvidence(
          data.domains ?? [],
          evidenceRunId,
          DIAGNOSTIC_RECORD_FIELDS.domains,
          (record) => record.decision === 'blocked'
        );
        const safeOutputs = linkedEvidence(
          data.issues ?? [],
          evidenceRunId,
          DIAGNOSTIC_RECORD_FIELDS.issues
        );
        return {
          errorGroup: group,
          failedRuns: failedRuns.map((run) => selectedFields(run, RUN_METADATA_FIELDS)),
          omittedFailedRunCount: Math.max(0, group.count - failedRuns.length),
          latestSuccess: latestSuccess ? selectedFields(latestSuccess, RUN_METADATA_FIELDS) : null,
          changedRuntimeFields: latestFailure && latestSuccess
            ? Object.fromEntries(RUNTIME_COMPARISON_FIELDS
              .filter((field) => (latestFailure[field] ?? null) !== (latestSuccess[field] ?? null))
              .map((field) => [field, {
                failed: latestFailure[field] ?? null,
                latestSuccess: latestSuccess[field] ?? null
              }]))
            : {},
          evidence: {
            audits: audits.records,
            toolErrors: toolErrors.records,
            firewallBlocks: firewallBlocks.records,
            safeOutputs: safeOutputs.records
          },
          omittedEvidence: {
            audits: audits.omitted,
            toolErrors: toolErrors.omitted,
            firewallBlocks: firewallBlocks.omitted,
            safeOutputs: safeOutputs.omitted
          },
          actionsRun: latestFailure?.runLink
            ? {
                url: latestFailure.runLink,
                reason: 'Canonical evidence does not contain the exact process error; inspect job logs and stderr.'
              }
            : null
        };
      })
    };
}

function targetName(target) {
  if (typeof target === 'string') return target.trim().toLowerCase();
  if (!target || typeof target !== 'object') return '';
  return String(target.repository ?? '').trim().toLowerCase();
}

function repositoryIdByName(repositories) {
  return new Map(repositories.flatMap((repository) => {
    const fullName = String(repository.fullName ?? (
      repository.owner && repository.name ? `${repository.owner}/${repository.name}` : ''
    )).trim().toLowerCase();
    return fullName ? [[fullName, String(repository.id)]] : [];
  }));
}

function expectedTargetIds(campaign, repositoriesByName) {
  return new Set((Array.isArray(campaign.targets) ? campaign.targets : [])
    .map(targetName)
    .filter(Boolean)
    .map((name) => repositoriesByName.get(name) ?? `repository:${encodeURIComponent(name)}`));
}

function targetRepositoryId(run, repositoriesByName) {
  const name = String(run.targetRepository ?? '').trim().toLowerCase();
  if (!name) return null;
  return repositoriesByName.get(name) ?? `repository:${encodeURIComponent(name)}`;
}

function targetMembership(targetId, expectedTargets) {
  if (!targetId) return 'unknown';
  if (expectedTargets.has(targetId)) return 'expected';
  return expectedTargets.size > 0 ? 'observed-extra' : 'unknown';
}

function mergeRecords(retained, incoming) {
  const records = new Map(retained.map((record) => [String(record.id), record]));
  for (const record of incoming) {
    const id = String(record.id);
    records.set(id, { ...records.get(id), ...record });
  }
  return [...records.values()];
}

function partition(campaignId, workflow, runs, targetId, membership) {
  return {
    campaignId,
    workflowId: String(workflow.id),
    workflowRole: workflow.role,
    workflowState: String(workflow.state ?? 'unknown'),
    ...(workflow.role === 'worker'
      ? { targetRepositoryId: targetId, targetScopeMembership: membership }
      : {}),
    orderedNewestFirst: true,
    runs
  };
}

function queryRuns(name, workflows, runs) {
  if (workflows.length === 0) return [];
  return executeQuery({
    name,
    from: 'runs',
    joins: [{
      source: 'selected-workflows',
      type: 'inner',
      on: [{ left: 'workflowId', right: 'id' }],
      fields: [{ field: 'campaignId', as: '_campaign-id' }]
    }],
    compute: [{
      as: '_runtime-date',
      function: 'coalesce',
      args: [{ field: 'startedAt' }, { field: 'createdAt' }, { field: 'updatedAt' }]
    }],
    'order-by': [
      { field: '_campaign-id', direction: 'asc' },
      { field: 'workflowId', direction: 'asc' },
      { field: 'targetRepository', direction: 'asc' },
      { field: '_runtime-date', direction: 'desc' },
      { field: 'githubRunId', direction: 'desc' },
      { field: 'attempt', direction: 'desc' }
    ]
  }, {
    runs: source('runs', runs),
    'selected-workflows': source('selected-workflows', workflows)
  });
}

export function buildRuntimeHealthInput(campaigns, workflows, runs, repositories, campaignSlug) {
  const { campaignRows, workflowRows } = selectRuntimeHealthDefinitions(
    campaigns,
    workflows,
    campaignSlug
  );
  return buildRuntimeHealthInputFromSelection(campaignRows, workflowRows, runs, repositories);
}

function selectRuntimeHealthDefinitions(campaigns, workflows, campaignSlug) {
  const campaignRows = executeQuery({
    name: 'runtime-health-campaigns',
    from: 'campaigns',
    ...(campaignSlug ? { filter: { predicates: [{ field: 'slug', equals: campaignSlug }] } } : {}),
    'order-by': [{ field: 'slug', direction: 'asc' }]
  }, { campaigns: source('campaigns', campaigns) });
  if (campaignSlug && campaignRows.length === 0) {
    throw new Error(`Unknown campaign: ${campaignSlug}`);
  }

  const workflowRows = campaignRows.length === 0 ? [] : executeQuery({
    name: 'runtime-health-workflows',
    from: 'workflows',
    joins: [{
      source: 'selected-campaigns',
      type: 'inner',
      on: [{ left: 'campaignId', right: 'id' }],
      fields: [{ field: 'id', as: '_selected-campaign-id' }]
    }],
    filter: { predicates: [{ field: 'role', in: WORKFLOW_ROLES }] },
    'order-by': [
      { field: 'campaignId', direction: 'asc' },
      { field: 'role', direction: 'asc' },
      { field: 'id', direction: 'asc' }
    ]
  }, {
    workflows: source('workflows', workflows),
    'selected-campaigns': source('selected-campaigns', campaignRows)
  });
  return { campaignRows, workflowRows };
}

function buildRuntimeHealthInputFromSelection(campaignRows, workflowRows, runs, repositories) {
  const repositoriesByName = repositoryIdByName(repositories);
  const workflowsByCampaign = Map.groupBy(workflowRows, (workflow) => String(workflow.campaignId));
  const orchestratorWorkflows = workflowRows.filter((workflow) => workflow.role === 'orchestrator');
  const orchestratorRuns = queryRuns('runtime-health-orchestrator-runs', orchestratorWorkflows, runs);
  const orchestratorRunsByWorkflow = Map.groupBy(orchestratorRuns, (run) => String(run.workflowId));
  const orchestratorPartitionsByCampaign = new Map(campaignRows.map((campaign) => {
    const campaignId = String(campaign.id);
    const definitions = workflowsByCampaign.get(campaignId) ?? [];
    return [campaignId, definitions
      .filter((workflow) => workflow.role === 'orchestrator')
      .map((workflow) => partition(
        campaignId,
        workflow,
        orchestratorRunsByWorkflow.get(String(workflow.id)) ?? [],
        null,
        null
      ))];
  }));
  const eligibleCampaigns = new Set([...orchestratorPartitionsByCampaign.entries()]
    .filter(([, partitions]) => (
      workerEvaluationState(partitions.map(evaluateRuntimeHealthPartition)) === 'eligible'
    ))
    .map(([campaignId]) => campaignId));
  const eligibleWorkerWorkflows = workflowRows.filter((workflow) => (
    workflow.role === 'worker' && eligibleCampaigns.has(String(workflow.campaignId))
  ));
  const workerRuns = queryRuns('runtime-health-worker-runs', eligibleWorkerWorkflows, runs);
  const workerRunsByWorkflow = Map.groupBy(workerRuns, (run) => String(run.workflowId));

  return {
    campaigns: campaignRows.map((campaign) => {
      const campaignId = String(campaign.id);
      const expectedTargets = expectedTargetIds(campaign, repositoriesByName);
      const definitions = workflowsByCampaign.get(campaignId) ?? [];
      const orchestratorPartitions = orchestratorPartitionsByCampaign.get(campaignId) ?? [];
      const workerPartitions = eligibleCampaigns.has(campaignId) ? definitions
        .filter((workflow) => workflow.role === 'worker')
        .flatMap((workflow) => {
          const workflowRuns = workerRunsByWorkflow.get(String(workflow.id)) ?? [];
          const byTarget = Map.groupBy(workflowRuns, (run) => (
            targetRepositoryId(run, repositoriesByName) ?? ''
          ));
          return [...byTarget.entries()].map(([targetId, targetRuns]) => {
            const membership = targetMembership(targetId || null, expectedTargets);
            if (!TARGET_MEMBERSHIPS.has(membership)) {
              throw new Error(`Invalid target membership for ${targetId}`);
            }
            return partition(campaignId, workflow, targetRuns, targetId || null, membership);
          });
        }) : [];
      return { campaignId, orchestratorPartitions, workerPartitions };
    })
  };
}

export function computeRuntimeHealthFromCanonicalData(data, options = {}) {
  const startedAt = performance.now();
  const input = buildRuntimeHealthInput(
    data.campaigns,
    data.workflows,
    data.runs,
    data.repositories,
    options.campaign
  );
  const result = computeRuntimeHealthPortfolio(input);
  const diagnostics = options.diagnose
    ? buildRuntimeHealthDiagnostics(result, data)
    : undefined;
  const durationMilliseconds = performance.now() - startedAt;
  debugRuntimeHealth('computed canonical input in %d ms', durationMilliseconds);
  return {
    command: 'computation',
    computation: 'runtime-health',
    result: diagnostics ? { ...result, diagnostics } : result
  };
}

export async function queryRuntimeHealth(indexedDB, options = {}) {
  const [storedCampaigns, storedWorkflows, storedRepositories] = await Promise.all([
    readCollection(indexedDB, 'campaigns'),
    readCollection(indexedDB, 'workflows'),
    readCollection(indexedDB, 'repositories')
  ]);
  const inventory = options.inventorySources
    ? normalize(queryDashboardSourceObservations(options.inventorySources).observations)
    : { campaigns: [], workflows: [], repositories: [] };
  const campaigns = mergeRecords(storedCampaigns, inventory.campaigns);
  const workflows = mergeRecords(storedWorkflows, inventory.workflows);
  const repositories = mergeRecords(storedRepositories, inventory.repositories);
  if (campaigns.length === 0) {
    throw new Error('Runtime health requires canonical Campaign inventory.');
  }
  const selection = selectRuntimeHealthDefinitions(campaigns, workflows, options.campaign);
  const workflowIds = selection.workflowRows.map((workflow) => String(workflow.id));
  const chunks = [];
  for (let index = 0; index < workflowIds.length; index += 32) {
    chunks.push(workflowIds.slice(index, index + 32));
  }
  const runs = (await Promise.all(chunks.map((ids) => queryCollection(indexedDB, 'runs', [{
    op: 'filter',
    predicates: [{ field: 'workflowId', in: ids }]
  }])))).flat();
  const startedAt = performance.now();
  const input = buildRuntimeHealthInputFromSelection(
    selection.campaignRows,
    selection.workflowRows,
    runs,
    repositories
  );
  const result = computeRuntimeHealthPortfolio(input);
  let diagnostics;
  if (options.diagnose) {
    const selections = selectDiagnosticGroups(result);
    const diagnosticRunIds = [...new Set(selections.flatMap((selection) => selection.failureRunIds))];
    const [audits, tools, domains, issues] = diagnosticRunIds.length === 0
      ? [[], [], [], []]
      : await Promise.all(['audits', 'tools', 'domains', 'issues'].map((collection) => queryCollection(
        indexedDB,
        collection,
        [{ op: 'filter', predicates: [{ field: 'runId', in: diagnosticRunIds }] }]
      )));
    diagnostics = buildRuntimeHealthDiagnostics(result, {
      runs,
      audits,
      tools,
      domains,
      issues
    });
  }
  const durationMilliseconds = performance.now() - startedAt;
  debugRuntimeHealth(
    'computed %d campaign(s) from %d selected run(s) in %d ms',
    selection.campaignRows.length,
    runs.length,
    durationMilliseconds
  );
  return {
    command: 'computation',
    computation: 'runtime-health',
    result: diagnostics ? { ...result, diagnostics } : result
  };
}

export function queryComputation(indexedDB, name, options = {}) {
  if (name === 'runtime-health') return queryRuntimeHealth(indexedDB, options);
  throw new Error(`Unknown computation: ${name}`);
}
