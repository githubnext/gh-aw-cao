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

/**
 * Adapts the current published dashboard source document without exposing its
 * view-shaped field names beyond this boundary.
 *
 * @param {Record<string, unknown>} sources
 * @returns {{ observations: import('../model/schema.js').CanonicalObservation[] }}
 */
export function adaptDashboardSources(sources) {
  const repositories = sourceDocument(sources.repositories);
  const packages = sourceDocument(sources.packages);
  const workflows = sourceDocument(sources.workflows);
  const runs = sourceDocument(sources.runs);
  const events = sourceDocument(sources.events);
  /** @type {import('../model/schema.js').CanonicalObservation[]} */
  const observations = [];
  const publishedRunIds = new Set();
  const publishedPackageIds = new Map();

  for (const candidate of packages.rows) {
    const row = objectRow(candidate);
    if (!row) continue;
    const slug = requiredString(row.package, 'package.package');
    const id = sourceId('package', SOURCE, slug);
    publishedPackageIds.set(slug, id);
    observations.push({
      kind: 'package',
      source: SOURCE,
      sourceId: slug,
      observedAt: requiredString(row['observed-at'] ?? metadataTimestamp(packages.metadata), 'package.observed-at'),
      data: {
        id,
        slug,
        name: row['package-name'] ?? slug,
        description: row['package-description'] ?? '',
        icon: row['package-icon'] ?? 'package',
        mode: row['package-mode'] ?? 'unknown',
        enabled: row['package-enabled'] !== false,
        maxRepositories: row['package-max-repositories'] ?? null,
        rolloutPercent: row['package-rollout-percent'] ?? null,
        monthlyAiCreditBudget: row['package-monthly-ai-credit-budget'] ?? null,
        aiCreditAllowance: row['package-aic-allowance'] ?? null,
        workerCount: row['package-worker-count'] ?? 0,
        inventoryWarnings: row['package-inventory-warnings'] ?? 0,
        workers: row['package-workers'] ?? [],
        targets: row['package-targets'] ?? [],
        minVersion: row['package-min-version'] ?? '',
        version: row['package-version'] ?? 'unknown',
        currentVersion: row['package-current-version'] ?? 'unknown',
        updateState: row['package-update-state'] ?? 'unknown',
        experimental: row['package-experimental'] === true,
        readmePath: row['package-readme-path'] ?? '',
        readme: row['package-readme'] ?? '',
        packageLink: row['package-link'] ?? null
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
        packageId: typeof row.package === 'string' ? publishedPackageIds.get(row.package) : undefined,
        package: typeof row.package === 'string' ? row.package : undefined,
        packageName: row['package-name'],
        packageIcon: row['package-icon'],
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

  for (const candidate of events.rows) {
    const row = objectRow(candidate);
    if (!row) continue;
    const githubRunId = requiredString(row.run, 'event.run');
    const sourceAttempt = row['run-attempt'];
    const attempt = Number.isInteger(Number(sourceAttempt)) && Number(sourceAttempt) > 0 ? Number(sourceAttempt) : 1;
    const canonicalRunId = runId(githubRunId, attempt);
    if (!publishedRunIds.has(canonicalRunId)) continue;
    const sourceSequence = Number(row['source-sequence']);
    observations.push({
      kind: 'event',
      source: SOURCE,
      sourceId: requiredString(row.event, 'event.event'),
      observedAt: requiredString(row['observed-at'] ?? row['event-timestamp'] ?? metadataTimestamp(events.metadata), 'event observed time'),
      data: {
        id: requiredString(row.event, 'event.event'),
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

  return { observations };
}