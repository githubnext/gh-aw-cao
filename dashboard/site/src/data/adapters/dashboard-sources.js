import { jobId, runId, sourceId } from '../model/ids.js';
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

/**
 * Adapts the current published dashboard source document without exposing its
 * view-shaped field names beyond this boundary.
 *
 * @param {Record<string, unknown>} sources
 * @returns {{ observations: import('../model/schema.js').CanonicalObservation[] }}
 */
export function adaptDashboardSources(sources) {
  const repositories = sourceDocument(sources.repositories);
  const workflows = sourceDocument(sources.workflows);
  const runs = sourceDocument(sources.runs);
  const jobs = sourceDocument(sources['job-performance']);
  const sessions = sourceDocument(sources.sessions);
  const events = sourceDocument(sources.events);
  const workItems = sourceDocument(sources['work-items']);
  const findings = sourceDocument(sources['security-findings']);
  /** @type {import('../model/schema.js').CanonicalObservation[]} */
  const observations = [];
  const publishedRunIds = new Set();
  const publishedJobIds = new Set();
  const publishedSessionIds = new Set();

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
        id: sourceId('repository', SOURCE, fullName.toLowerCase()),
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
    const coordinate = `${fullName}:${path}`.toLowerCase();
    observations.push({
      kind: 'workflow',
      source: SOURCE,
      sourceId: coordinate,
      observedAt: requiredString(row['observed-at'] ?? metadataTimestamp(workflows.metadata), 'workflow.observed-at'),
      data: {
        id: sourceId('workflow', SOURCE, coordinate),
        repositoryId: sourceId('repository', SOURCE, fullName.toLowerCase()),
        name: row['workflow-name'] ?? path,
        path,
        state: row['workflow-active'] === 'true' ? 'active'
          : row['workflow-active'] === 'false' ? 'disabled' : 'unknown',
        ghAwVersion: row['gh-aw-version'] ?? 'unknown',
        ghAwCurrentVersion: row['gh-aw-current-version'] ?? 'unknown',
        ghAwUpdateState: row['gh-aw-update-state'] ?? 'unknown',
        workflowLink: row['workflow-link'] ?? null
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
        repositoryId: sourceId('repository', SOURCE, fullName.toLowerCase()),
        workflowId: sourceId('workflow', SOURCE, `${fullName}:${path}`.toLowerCase()),
        owner,
        repository,
        repositoryFullName: fullName,
        workflowPath: path,
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
        engine: row.engine ?? 'unknown',
        engineVersion: row['engine-version'] ?? 'unknown',
        requestedModel: row['requested-model'] ?? 'unknown',
        resolvedModel: row['resolved-model'] ?? 'unknown'
      }
    });
  }

  for (const candidate of jobs.rows) {
    const row = objectRow(candidate);
    if (!row || row['job-id'] === null || row['job-id'] === undefined) continue;
    const owner = requiredString(row.organization, 'job.organization');
    const repository = requiredString(row.repository, 'job.repository');
    const githubRunId = requiredString(row.run, 'job.run');
    const githubJobId = requiredString(String(row['job-id']), 'job.job-id');
    const sourceAttempt = row['run-attempt'];
    const attempt = Number.isInteger(Number(sourceAttempt)) && Number(sourceAttempt) > 0 ? Number(sourceAttempt) : 1;
    const id = jobId(githubJobId);
    publishedJobIds.add(id);
    observations.push({
      kind: 'job',
      source: SOURCE,
      sourceId: `${owner}/${repository}:${githubRunId}:${attempt}:${githubJobId}`.toLowerCase(),
      observedAt: requiredString(row['started-at'] ?? metadataTimestamp(jobs.metadata), 'job observed time'),
      data: {
        githubJobId,
        runId: runId(githubRunId, attempt),
        name: row.job ?? 'Unknown job',
        status: row['job-status'] ?? 'unknown',
        conclusion: row['job-conclusion'] ?? null,
        startedAt: row['started-at'] ?? null,
        completedAt: null,
        runConclusion: row['run-conclusion'] ?? null,
        rolloutMode: row['rollout-mode'] ?? 'unknown',
        durationSeconds: row['job-duration-seconds'] ?? null,
        runner: row.runner ?? 'unknown',
        runnerName: row['runner-name'] ?? 'unknown',
        runnerGroup: row['runner-group'] ?? 'unknown',
        sandboxRuntime: row['sandbox-runtime'] ?? 'unknown',
        engine: row.engine ?? 'unknown',
        model: row.model ?? 'unknown',
        runLink: row['run-link'] ?? null
      }
    });
  }

  for (const candidate of sessions.rows) {
    const row = objectRow(candidate);
    if (!row) continue;
    const session = requiredString(row.session, 'session.session');
    const githubRunId = requiredString(row.run, 'session.run');
    const sourceAttempt = row['run-attempt'];
    const attempt = Number.isInteger(Number(sourceAttempt)) && Number(sourceAttempt) > 0 ? Number(sourceAttempt) : 1;
    const canonicalRunId = runId(githubRunId, attempt);
    if (!publishedRunIds.has(canonicalRunId)) continue;
    const canonicalJobId = row['job-id'] === undefined || row['job-id'] === null
      ? undefined
      : jobId(requiredString(String(row['job-id']), 'session.job-id'));
    observations.push({
      kind: 'session',
      source: SOURCE,
      sourceId: session,
      observedAt: requiredString(row['observed-at'] ?? row['started-at'] ?? metadataTimestamp(sessions.metadata), 'session observed time'),
      data: {
        id: session,
        runId: canonicalRunId,
        jobId: canonicalJobId === undefined || publishedJobIds.has(canonicalJobId)
          ? canonicalJobId
          : undefined,
        kind: row['session-kind'] ?? 'unified-operational-log',
        status: row['session-status'] ?? 'unknown',
        startedAt: row['started-at'] ?? null,
        completedAt: row['ended-at'] ?? null
      }
    });
    publishedSessionIds.add(session);
  }

  for (const candidate of events.rows) {
    const row = objectRow(candidate);
    if (!row) continue;
    const session = requiredString(row.session, 'event.session');
    if (!publishedSessionIds.has(session)) continue;
    const sourceSequence = Number(row['source-sequence']);
    observations.push({
      kind: 'event',
      source: SOURCE,
      sourceId: requiredString(row.event, 'event.event'),
      observedAt: requiredString(row['observed-at'] ?? row['event-timestamp'] ?? metadataTimestamp(events.metadata), 'event observed time'),
      data: {
        id: requiredString(row.event, 'event.event'),
        sessionId: session,
        timestamp: requiredString(row['event-timestamp'], 'event.event-timestamp'),
        source: requiredString(row['event-source'], 'event.event-source'),
        type: requiredString(row['event-type'], 'event.event-type'),
        summary: row['event-summary'],
        status: row['event-status'],
        correlationId: row['correlation-id'],
        payloadRef: row['payload-ref'],
        sourceSequence: Number.isInteger(sourceSequence) && sourceSequence >= 0 ? sourceSequence : undefined
      }
    });
  }

  for (const candidate of workItems.rows) {
    const row = objectRow(candidate);
    if (!row) continue;
    const workItemId = requiredString(row['work-item-id'], 'work-item.work-item-id');
    observations.push({
      kind: 'work-item',
      source: SOURCE,
      sourceId: workItemId,
      observedAt: requiredString(row['observed-at'] ?? metadataTimestamp(workItems.metadata), 'work-item.observed-at'),
      data: {
        workItemId,
        name: row.name,
        objective: row.objective,
        organization: row.organization,
        repository: row.repository,
        workflowPath: row.workflow,
        githubRunId: row.run,
        workflowName: row['workflow-name'],
        workflowIcon: row['workflow-icon'],
        packageName: row.package,
        scope: row.scope,
        domain: row.domain,
        workType: row['work-type'],
        lifecycleState: row['lifecycle-state'],
        phase: row.phase,
        reason: row.reason,
        reasonEvidenceClass: row['reason-evidence-class'],
        nextAction: row['next-action'],
        nextActor: row['next-actor'],
        safeOutputKind: row['safe-output-kind'],
        waitingOn: row['waiting-on'],
        waitingSince: row['waiting-since'],
        owner: row.owner,
        consequenceTier: row['consequence-tier'],
        verificationState: row['verification-state'],
        outcomeState: row['outcome-state'],
        startedAt: row['started-at'],
        completedAt: row['ended-at'],
        evidenceLink: row['evidence-link'],
        repositoryLink: row['repository-link'],
        runLink: row['run-link']
      }
    });
  }

  for (const candidate of findings.rows) {
    const row = objectRow(candidate);
    if (!row) continue;
    const observationId = requiredString(row['smell-observation-id'], 'finding.smell-observation-id');
    observations.push({
      kind: 'finding',
      source: SOURCE,
      sourceId: observationId,
      observedAt: requiredString(row['observed-at'] ?? metadataTimestamp(findings.metadata), 'finding.observed-at'),
      data: {
        observationId,
        findingId: row['smell-id'],
        organization: row.organization,
        repository: row.repository,
        workflowPath: row.workflow,
        githubRunId: row.run,
        name: row['smell-name'],
        category: row['smell-category'],
        severity: row['smell-severity'],
        summary: row['smell-summary'],
        evidence: row['smell-evidence'],
        recommendation: row['smell-recommendation'],
        evidenceLink: row['evidence-link'],
        repositoryLink: row['repository-link'],
        workflowLink: row['workflow-link'],
        runLink: row['run-link']
      }
    });
  }

  return { observations };
}