export function previousRunRecords(previousIndex, registryByRepository, windowStart) {
  const records = new Map();
  for (const workflow of previousIndex?.workflows || []) {
    const registry = registryByRepository.get(workflow.repository);
    if (!registry || ![...registry.values()].some((entry) => entry.id === workflow.id)) continue;
    for (const run of workflow.runHealth?.runRecords || []) {
      if (Date.parse(run.createdAt) < windowStart.getTime()) continue;
      records.set(`${workflow.id}:${run.runId}`, { workflowId: workflow.id, run });
    }
  }
  return records;
}

export function previousIndexCanRetainRuns(previousIndex, windowStart, context) {
  const generatedAt = Date.parse(previousIndex?.generatedAt);
  const previousWindowStart = Date.parse(previousIndex?.runHealth?.windowStart);
  if (previousIndex?.schemaVersion !== 1
    || previousIndex.organization !== context.organization
    || previousIndex.repositoryScope !== context.repositoryScope
    || previousIndex.includePrivate !== context.includePrivate
    || previousIndex.runHealth?.windowHours !== context.runWindowHours
    || !Number.isFinite(generatedAt)
    || !Number.isFinite(previousWindowStart)
    || previousWindowStart > windowStart.getTime()) return false;
  return JSON.stringify(previousIndex.allowedRepositories || []) === JSON.stringify(context.allowedRepositories || []);
}

export function previousIndexIsReusable(previousIndex, windowStart, context) {
  return previousIndexCanRetainRuns(previousIndex, windowStart, context)
    && previousIndex.runHealth?.available === true
    && previousIndex.runHealth?.complete === true;
}
