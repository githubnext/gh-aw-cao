import {
  repositoryCoordinateId,
  runId,
  sourceId,
  workflowCoordinateId,
  workflowSourcePath
} from '../model/ids.js';
import { requiredString } from '../model/schema.js';

const SOURCE = 'dashboard-sources';

/** @param {unknown} value */
function sourceDocument(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { rows: [], metadata: {} };
  const source = /** @type {{ rows?: unknown, metadata?: unknown }} */ (value);
  return {
    rows: Array.isArray(source.rows) ? source.rows : [],
    metadata: source.metadata && typeof source.metadata === 'object' && !Array.isArray(source.metadata)
      ? /** @type {Record<string, unknown>} */ (source.metadata)
      : {}
  };
}

/** @param {Record<string, unknown>} metadata */
function metadataTimestamp(metadata) {
  return requiredString(metadata['as-of'] ?? metadata['retrieved-at'], 'source metadata timestamp');
}

/** @param {unknown} row */
function objectRow(row) {
  return row && typeof row === 'object' && !Array.isArray(row)
    ? /** @type {Record<string, unknown>} */ (row)
    : null;
}

/** @param {unknown} value @param {string} fallback */
function normalizedId(value, fallback) {
  return value !== undefined && value !== null && String(value).trim()
    ? String(value).trim()
    : fallback;
}

/** @param {unknown} value */
function optionalString(value) {
  return value !== undefined && value !== null && String(value).trim()
    ? String(value).trim()
    : undefined;
}

/** @param {Record<string, unknown>} row @param {string} field */
function campaignField(row, field) {
  return row[`campaign-${field}`] ?? row[`package-${field}`];
}

/**
 * Adapts the current published dashboard source document without exposing its
 * view-shaped field names beyond this boundary.
 *
 * @param {Record<string, unknown>} sources
 * @returns {{ observations: import('../model/schema.js').CanonicalObservation[] }}
 */
export function adaptDashboardSources(sources) {
  const repositories = sourceDocument(sources.repositories);
  const campaigns = sourceDocument(Object.hasOwn(sources, 'campaigns') ? sources.campaigns : sources.packages);
  const workflows = sourceDocument(sources.workflows);
  const runs = sourceDocument(sources.runs);
  const runLinkedSources = [
    { kind: /** @type {const} */ ('domain'), document: sourceDocument(sources.domains) },
    { kind: /** @type {const} */ ('tool'), document: sourceDocument(sources.tools) },
    { kind: /** @type {const} */ ('audit'), document: sourceDocument(sources.audits) },
    { kind: /** @type {const} */ ('issue'), document: sourceDocument(sources.issues) }
  ];
  /** @type {import('../model/schema.js').CanonicalObservation[]} */
  const observations = [];
  const publishedRunIds = new Set();
  const publishedCampaignIds = new Map();

  for (const candidate of campaigns.rows) {
    const row = objectRow(candidate);
    if (!row) continue;
    const slug = requiredString(row.campaign ?? row.package, 'campaign.campaign');
    const id = sourceId('campaign', SOURCE, slug);
    publishedCampaignIds.set(slug, id);
    observations.push({
      kind: 'campaign',
      source: SOURCE,
      sourceId: slug,
      observedAt: requiredString(row['observed-at'] ?? metadataTimestamp(campaigns.metadata), 'campaign.observed-at'),
      data: {
        id,
        slug,
        name: campaignField(row, 'name') ?? slug,
        description: campaignField(row, 'description') ?? '',
        icon: campaignField(row, 'icon') ?? 'goal',
        mode: campaignField(row, 'mode') ?? 'unknown',
        enabled: campaignField(row, 'enabled') !== false,
        maxRepositories: campaignField(row, 'max-repositories') ?? null,
        rolloutPercent: campaignField(row, 'rollout-percent') ?? null,
        monthlyAiCreditBudget: campaignField(row, 'monthly-ai-credit-budget') ?? null,
        aiCreditAllowance: campaignField(row, 'aic-allowance') ?? null,
        workerCount: campaignField(row, 'worker-count') ?? 0,
        inventoryWarnings: campaignField(row, 'inventory-warnings') ?? 0,
        workers: campaignField(row, 'workers') ?? [],
        targets: campaignField(row, 'targets') ?? [],
        minVersion: campaignField(row, 'min-version') ?? '',
        version: campaignField(row, 'version') ?? 'unknown',
        currentVersion: campaignField(row, 'current-version') ?? 'unknown',
        updateState: campaignField(row, 'update-state') ?? 'unknown',
        experimental: campaignField(row, 'experimental') === true,
        readmePath: campaignField(row, 'readme-path') ?? '',
        readme: campaignField(row, 'readme') ?? '',
        campaignLink: campaignField(row, 'link') ?? null
      }
    });
  }

  for (const candidate of repositories.rows) {
    const row = objectRow(candidate);
    if (!row) continue;
    const owner = requiredString(row.organization, 'repository.organization');
    const name = requiredString(row.repository, 'repository.repository');
    const fullName = `${owner}/${name}`;
    observations.push({
      kind: 'repository',
      source: SOURCE,
      sourceId: fullName,
      observedAt: requiredString(row['observed-at'] ?? metadataTimestamp(repositories.metadata), 'repository.observed-at'),
      data: {
        id: repositoryCoordinateId(owner, name),
        owner,
        name,
        fullName,
        visibility: row.visibility ?? 'unknown',
        organizationLink: row['organization-link'] ?? null,
        repositoryLink: row['repository-link'] ?? null
      }
    });
  }

  for (const candidate of workflows.rows) {
    const row = objectRow(candidate);
    if (!row) continue;
    const owner = requiredString(row.organization, 'workflow.organization');
    const repository = requiredString(row.repository, 'workflow.repository');
    const path = requiredString(row.workflow, 'workflow.workflow');
    const fullName = `${owner}/${repository}`;
    const canonicalPath = workflowSourcePath(path);
    const coordinate = `${fullName}:${canonicalPath}`.toLowerCase();
    const campaign = optionalString(row.campaign ?? row.package);
    observations.push({
      kind: 'workflow',
      source: SOURCE,
      sourceId: coordinate,
      observedAt: requiredString(row['observed-at'] ?? metadataTimestamp(workflows.metadata), 'workflow.observed-at'),
      data: {
        id: workflowCoordinateId(owner, repository, canonicalPath),
        githubId: optionalString(row['workflow-id']),
        repositoryId: repositoryCoordinateId(owner, repository),
        name: row['workflow-name'] ?? path,
        path: canonicalPath,
        state: row['workflow-active'] === 'true' ? 'active'
          : row['workflow-active'] === 'false' ? 'disabled' : 'unknown',
        registryState: optionalString(row['workflow-registry-state']),
        createdAt: optionalString(row['created-at']),
        updatedAt: optionalString(row['updated-at']),
        ghAwVersion: row['gh-aw-version'] ?? 'unknown',
        ghAwCurrentVersion: row['gh-aw-current-version'] ?? 'unknown',
        ghAwUpdateState: row['gh-aw-update-state'] ?? 'unknown',
        workflowLink: row['workflow-link'] ?? null,
        campaignId: campaign ? publishedCampaignIds.get(campaign) : undefined,
        campaign,
        campaignName: campaignField(row, 'name'),
        campaignIcon: campaignField(row, 'icon'),
        role: row['workflow-role'],
        rolloutMode: row['rollout-mode'],
        maxAiCredits: row['max-ai-credits']
      }
    });
  }

  for (const candidate of runs.rows) {
    const row = objectRow(candidate);
    if (!row) continue;
    const owner = requiredString(row.organization, 'run.organization');
    const repository = requiredString(row.repository, 'run.repository');
    const path = requiredString(row.workflow, 'run.workflow');
    const githubRunId = requiredString(row.run, 'run.run');
    const sourceAttempt = row['run-attempt'] ?? row.attempt;
    const attempt = Number.isInteger(Number(sourceAttempt)) && Number(sourceAttempt) > 0 ? Number(sourceAttempt) : 1;
    const fullName = `${owner}/${repository}`;
    const id = runId(githubRunId, attempt);
    publishedRunIds.add(id);
    observations.push({
      kind: 'run',
      source: SOURCE,
      sourceId: `${fullName}:${githubRunId}:${attempt}`.toLowerCase(),
      observedAt: requiredString(row['ended-at'] ?? row['started-at'] ?? metadataTimestamp(runs.metadata), 'run observed time'),
      data: {
        id,
        repositoryId: repositoryCoordinateId(owner, repository),
        workflowId: workflowCoordinateId(owner, repository, path),
        owner,
        repository,
        repositoryFullName: fullName,
        workflowPath: workflowSourcePath(path),
        githubRunId,
        attempt,
        title: row['run-title'] ?? `Run ${githubRunId}`,
        event: row.event ?? 'unknown',
        status: row['run-status'] ?? 'unknown',
        conclusion: row['run-conclusion'] ?? null,
        startedAt: row['started-at'] ?? null,
        completedAt: row['ended-at'] ?? null,
        failureDetail: row['failure-detail'] ?? row['failure-message'] ?? row['failure-step'] ?? `Run ${githubRunId}`,
        runLink: row['run-link'] ?? null,
        rolloutMode: row['rollout-mode'] ?? 'unknown',
        agentId: normalizedId(row['agent-id'], 'copilot'),
        agentVersion: row['agent-version'] ?? null,
        modelId: normalizedId(row['model-id'], 'auto'),
        ghAwVersion: row['gh-aw-version'] ?? null,
        aicTotal: row['aic-total'] ?? null,
        engine: row.engine ?? 'unknown',
        engineVersion: row['engine-version'] ?? 'unknown',
        requestedModel: row['requested-model'] ?? 'unknown',
        resolvedModel: row['resolved-model'] ?? 'unknown'
      }
    });
  }

  for (const { kind, document } of runLinkedSources) {
    for (const candidate of document.rows) {
    const row = objectRow(candidate);
    if (!row) continue;
    const githubRunId = requiredString(row.run, `${kind}.run`);
    const sourceAttempt = row['run-attempt'];
    const attempt = Number.isInteger(Number(sourceAttempt)) && Number(sourceAttempt) > 0 ? Number(sourceAttempt) : 1;
    const canonicalRunId = runId(githubRunId, attempt);
    if (!publishedRunIds.has(canonicalRunId)) continue;
    const sourceSequence = Number(row['source-sequence']);
    observations.push({
      kind,
      source: SOURCE,
      sourceId: requiredString(row.event, `${kind}.event`),
      observedAt: requiredString(row['observed-at'] ?? row['event-timestamp'] ?? metadataTimestamp(document.metadata), `${kind} observed time`),
      data: {
        id: requiredString(row.event, `${kind}.event`),
        runId: canonicalRunId,
        timestamp: requiredString(row['event-timestamp'], 'event.event-timestamp'),
        source: requiredString(row['event-source'], 'event.event-source'),
        type: requiredString(row['event-type'], 'event.event-type'),
        summary: row['event-summary'],
        status: row['event-status'],
        requestCount: row['request-count'],
        correlationId: row['correlation-id'],
        payloadRef: row['payload-ref'],
        mcpServer: row['mcp-server'],
        mcpTool: row['mcp-tool'],
        safeOutputType: row['safe-output-type'],
        githubEntityType: row['github-entity-type'],
        isPullRequest: row['is-pull-request'] === true,
        toolType: row['tool-type'],
        isSkill: row['is-skill'] === true,
        name: row.name,
        targetRepo: row['target-repo'],
        targetOrganization: row['target-organization'],
        targetRepository: row['target-repository'],
        targetWorkflowPath: row['target-workflow-path'],
        optimizerRunAttempt: row['optimizer-run-attempt'],
        optimizerWorkflowPath: row['optimizer-workflow-path'],
        optimizerWorkflowName: row['optimizer-workflow-name'],
        claimRunId: row['claim-run-id'],
        claimRunAttempt: row['claim-run-attempt'],
        actor: row.actor,
        sourceProvenance: row['source-provenance'],
        opportunityId: row['opportunity-id'],
        opportunityKind: row['opportunity-kind'],
        assignmentRunId: row['assignment-run'],
        experimentId: row.experiment,
        evidenceWindowStart: row['evidence-window-start'],
        evidenceWindowEnd: row['evidence-window-end'],
        evidenceState: row['evidence-state'],
        evidenceConfidence: row['evidence-confidence'],
        costGrain: row['cost-grain'],
        evidenceProvenance: row['evidence-provenance'],
        attributableRunIds: row['attributable-run-ids'],
        interventionId: row['intervention-id'],
        lifecycleObservationId: row['lifecycle-observation-id'],
        previousInterventionState: row['previous-intervention-state'],
        interventionState: row['intervention-state'],
        previousRecommendationDisposition: row['previous-recommendation-disposition'],
        recommendationDisposition: row['recommendation-disposition'],
        supersedesInterventionId: row['supersedes-intervention-id'],
        supersededByInterventionId: row['superseded-by-intervention-id'],
        recommendationChurnCount: row['recommendation-churn-count'],
        recommendationChurnRate: row['recommendation-churn-rate'],
        controlVariant: row['control-variant'],
        optimizedVariant: row['optimized-variant'],
        proposedSavingsAic: row['proposed-savings-aic'],
        missingReason: row['missing-reason'],
        safeOutputId: row['safe-output-id'],
        safeOutputUrl: row['safe-output-url'],
        implementationChangeId: row['implementation-change-id'],
        implementationPullRequestUrl: row['implementation-pull-request-url'],
        implementationRunIds: row['implementation-run-ids'],
        acceptedAt: row['accepted-at'],
        implementationStartedAt: row['implementation-started-at'],
        implementationCompletedAt: row['implementation-completed-at'],
        rejectedAt: row['rejected-at'],
        supersededAt: row['superseded-at'],
        sourceSequence: Number.isInteger(sourceSequence) && sourceSequence >= 0 ? sourceSequence : undefined
      }
    });
    }
  }

  return { observations };
}