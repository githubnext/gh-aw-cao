export const DAILY_WORKFLOW_AGGREGATES = 'daily_workflow_aggregates';
export const DAILY_WORKFLOW_CONTRIBUTIONS = 'daily_workflow_contributions';
export const DAILY_WORKFLOW_STORES = [DAILY_WORKFLOW_AGGREGATES, DAILY_WORKFLOW_CONTRIBUTIONS];
export const DAILY_WORKFLOW_METRICS = [
  'aicTotal', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens',
  'reasoningTokens', 'actionMinutes', 'agenticDurationSeconds', 'githubApiCalls',
  'safeItemsCount', 'errorCount', 'firewallAllowedCalls', 'firewallBlockedCalls',
  'mcpToolCalls', 'mcpResponseBytes', 'highPriorityAuditItems', 'mediumPriorityAuditItems',
  'toolCalls', 'domainCalls'
];
export const DAILY_WORKFLOW_EVIDENCE = Object.freeze({
  tools: { ledger: 'toolEvidence', field: 'invocationCount', metric: 'toolCalls' },
  domains: { ledger: 'domainEvidence', field: 'requestCount', metric: 'domainCalls' }
});
export const DAILY_WORKFLOW_OUTCOMES = Object.freeze({
  success: 'successCount', failure: 'failureCount', cancelled: 'cancelledCount',
  skipped: 'skippedCount', timed_out: 'timedOutCount', action_required: 'actionRequiredCount',
  neutral: 'neutralCount', startup_failure: 'startupFailureCount'
});

/** Current UTC Monday and the preceding two complete weeks. @param {number} now */
export function dailyWorkflowCutoff(now) {
  if (!Number.isFinite(now)) throw new TypeError('Daily workflow retention requires a finite time');
  const day = new Date(now);
  day.setUTCHours(0, 0, 0, 0);
  day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7 - 14);
  if (!Number.isFinite(day.getTime())) throw new TypeError('Daily workflow retention requires a valid date');
  return day.getTime();
}

/**
 * A compact, replaceable contribution, never a second copy of tool evidence.
 * @param {Record<string, unknown>} run
 * @param {number} [now]
 * @param {Record<string, unknown> | null} [previous]
 * @returns {Record<string, unknown> | null}
 */
export function dailyWorkflowContribution(run, now = Date.now(), previous = null) {
  const timestamp = [run.startedAt, run.completedAt, run.createdAt]
    .find((value) => typeof value === 'string' && Number.isFinite(Date.parse(value)));
  if (typeof timestamp !== 'string' || typeof run.repositoryId !== 'string'
      || !run.repositoryId || typeof run.workflowId !== 'string' || !run.workflowId
      || typeof run.id !== 'string' || !run.id) return null;
  const time = Date.parse(timestamp);
  if (time < dailyWorkflowCutoff(now) || time >= now - now % 86400000 + 86400000) return null;
  const namespace = typeof run.namespace === 'string' ? run.namespace : '';
  const day = new Date(time).toISOString().slice(0, 10);
  const groupId = JSON.stringify([namespace, day, run.repositoryId, run.workflowId]);
  /** @type {Record<string, unknown>} */
  let contribution = {
    id: String(run.id), namespace, day, repositoryId: run.repositoryId,
    workflowId: run.workflowId, groupId,
    ...(typeof run.conclusion === 'string' && run.conclusion.trim() ? { conclusion: run.conclusion } : {}),
    ...Object.fromEntries(DAILY_WORKFLOW_METRICS
      .filter((metric) => !['toolCalls', 'domainCalls'].includes(metric)
        && typeof run[metric] === 'number' && Number.isFinite(run[metric]))
      .map((metric) => [metric, run[metric]]))
  };
  for (const store of /** @type {const} */ (['tools', 'domains'])) {
    const key = DAILY_WORKFLOW_EVIDENCE[store].ledger;
    if (previous?.[key]) contribution = withDailyWorkflowEvidence(contribution, store, [], previous);
  }
  return contribution;
}

/**
 * Compact identity/value pairs survive detail expiry so late record corrections
 * replace prior evidence rather than add another invocation. Absence is not zero.
 * @param {Record<string, unknown>} contribution
 * @param {'tools' | 'domains'} store
 * @param {Record<string, unknown>[]} records
 * @param {Record<string, unknown>} [previous]
 * @param {string[]} [removedIds]
 */
export function withDailyWorkflowEvidence(contribution, store, records, previous = contribution, removedIds = []) {
  const definition = DAILY_WORKFLOW_EVIDENCE[store];
  const existing = previous[definition.ledger];
  const evidence = new Map(Object.entries(existing && typeof existing === 'object' && !Array.isArray(existing)
    ? existing : {}));
  for (const id of removedIds) evidence.delete(id);
  for (const record of records) {
    evidence.set(String(record.id), typeof record[definition.field] === 'number'
      && Number.isFinite(record[definition.field]) ? record[definition.field] : null);
  }
  const values = [...evidence.values()].filter((value) => typeof value === 'number' && Number.isFinite(value));
  return {
    ...contribution,
    [definition.ledger]: Object.fromEntries(evidence),
    [definition.metric]: values.length ? values.reduce((sum, value) => sum + value, 0) : null,
    [`${definition.metric}ObservedCount`]: values.length
  };
}

/**
 * Subtract the prior contribution before adding its replacement. Null sums and
 * observation counts distinguish missing evidence from a measured zero.
 * @param {Record<string, unknown> | undefined} aggregate
 * @param {Record<string, unknown>} contribution
 * @param {1 | -1} sign
 * @returns {Record<string, unknown>}
 */
export function applyDailyWorkflowContribution(aggregate, contribution, sign) {
  /** @type {Record<string, unknown>} */
  const next = {
    ...aggregate,
    id: contribution.groupId, namespace: contribution.namespace, day: contribution.day,
    repositoryId: contribution.repositoryId, workflowId: contribution.workflowId,
    runCount: Number(aggregate?.runCount ?? 0) + sign
  };
  for (const metric of DAILY_WORKFLOW_METRICS) {
    const observed = typeof contribution[metric] === 'number' && Number.isFinite(contribution[metric]);
    const observations = ['toolCalls', 'domainCalls'].includes(metric)
      ? Number(contribution[`${metric}ObservedCount`] ?? 0) : observed ? 1 : 0;
    const count = Number(aggregate?.[`${metric}ObservedCount`] ?? 0) + sign * observations;
    const sum = Number(aggregate?.[`${metric}Sum`] ?? 0) + (observed ? sign * Number(contribution[metric]) : 0);
    next[`${metric}ObservedCount`] = count;
    next[`${metric}Sum`] = count === 0 ? null : sum;
    if (count < 0) throw new Error('Daily workflow observation accounting is inconsistent');
  }
  for (const [conclusion, field] of Object.entries(DAILY_WORKFLOW_OUTCOMES)) {
    next[field] = Number(aggregate?.[field] ?? 0) + (contribution.conclusion === conclusion ? sign : 0);
    if (Number(next[field]) < 0) throw new Error('Daily workflow outcome accounting is inconsistent');
  }
  const observedConclusion = typeof contribution.conclusion === 'string' && contribution.conclusion.trim() !== '';
  next.observedConclusionCount = Number(aggregate?.observedConclusionCount ?? 0) + (observedConclusion ? sign : 0);
  if (Number(next.observedConclusionCount) < 0) throw new Error('Daily workflow conclusion accounting is inconsistent');
  if (Number(next.runCount) < 0) throw new Error('Daily workflow run accounting is inconsistent');
  return next;
}

/**
 * Rebuild only during explicit repair, not routine ingestion.
 * @param {Record<string, unknown>[]} runs
 * @param {number} now
 * @param {Record<string, unknown>[]} [ledger]
 * @param {{ tools?: Record<string, unknown>[], domains?: Record<string, unknown>[] }} [evidence]
 */
export function rebuildDailyWorkflowAggregates(runs, now, ledger = [], evidence = {}) {
  /** @type {Map<string, Record<string, unknown>>} */
  const aggregates = new Map();
  /** @type {Map<string, Record<string, unknown>>} */
  const contributions = new Map();
  for (const contribution of ledger) {
    if (typeof contribution.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(contribution.day)) continue;
    const canonical = dailyWorkflowContribution(
      { ...contribution, startedAt: `${contribution.day}T00:00:00Z` }, now, contribution
    );
    if (canonical) contributions.set(String(canonical.id), canonical);
  }
  for (const run of runs) {
    const contribution = dailyWorkflowContribution(run, now, contributions.get(String(run.id)));
    contributions.delete(String(run.id));
    if (!contribution) continue;
    contributions.set(String(contribution.id), contribution);
  }
  for (const store of /** @type {const} */ (['tools', 'domains'])) {
    const grouped = new Map();
    for (const record of evidence[store] ?? []) {
      const key = String(record.runId);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(record);
    }
    for (const [key, records] of grouped) {
      const contribution = contributions.get(key);
      if (contribution) contributions.set(key, withDailyWorkflowEvidence(contribution, store, records));
    }
  }
  for (const contribution of contributions.values()) {
    const key = String(contribution.groupId);
    aggregates.set(key, applyDailyWorkflowContribution(aggregates.get(key), contribution, 1));
  }
  return {
    [DAILY_WORKFLOW_AGGREGATES]: [...aggregates.values()],
    [DAILY_WORKFLOW_CONTRIBUTIONS]: [...contributions.values()]
  };
}
