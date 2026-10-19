import { eventPulse, timelinePulse } from "./pulse-model.mjs";
import { isRepository } from "./common.mjs";

export function workflowPortfolio(history, proposals, measurements = [], progress = []) {
  const { index, entities } = history;
  if (!index.complete) throw new Error("A partial output traversal cannot stand in for a repository-wide inventory");
  if (!isRepository(index.repository) || !Array.isArray(index.workflows) || !Array.isArray(entities)
    || !Number.isFinite(Date.parse(index.until))
    || index.workflows.some(workflow => !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(workflow.id)
      || workflow.path !== `.github/workflows/${workflow.id}.md` || !/^[a-f0-9]{40}$/.test(workflow.gitBlob))
    || new Set(index.workflows.map(workflow => workflow.id)).size !== index.workflows.length
    || new Set(proposals.map(proposal => proposal.path)).size !== proposals.length) {
    throw new Error("Invalid portfolio source inventory or conflicting goal proposals");
  }
  const contracts = new Map(proposals.map(proposal => [proposal.path, proposal]));
  const measured = new Map();
  const workflows = new Map(index.workflows.map(workflow => [workflow.id, workflow]));
  const active = new Map();
  for (const entry of progress) {
    const workflow = workflows.get(entry.workflowId);
    if (!workflow || active.has(workflow.id) || entry.sourceGitBlob !== workflow.gitBlob
      || typeof entry.stage !== "string" || !entry.stage || typeof entry.detail !== "string" || !entry.detail
      || !["functionReady", "evidenceReady", "evaluationReady", "plotReady"].every(key => typeof entry[key] === "boolean")
      || (entry.plotReady && !entry.evaluationReady)
      || (entry.evaluationReady && (!entry.functionReady || !entry.evidenceReady))) {
      throw new Error("Invalid or source-mismatched portfolio progress");
    }
    active.set(workflow.id, entry);
  }
  for (const entry of measurements) {
    const workflow = workflows.get(entry.workflowId);
    if (!workflow || measured.has(workflow.id) || entry.input.repository !== index.repository) {
      throw new Error("Duplicate or out-of-scope portfolio measurement");
    }
    const model = entry.input.kind === "operational-value-events" ? eventPulse(entry.input) : timelinePulse(entry.input);
    if (model.workflowSlug !== workflow.id || model.sourcePath !== workflow.path
      || !Number.isFinite(Date.parse(model.window.endAt)) || Date.parse(model.window.endAt) > Date.parse(index.until)) {
      throw new Error("Portfolio measurement identity or cutoff mismatch");
    }
    const cadenceDays = entry.input.kind === "operational-value-events" ? entry.input.cadenceDays
      : entry.input.valueFunction.definition.evidence.window.cadenceDays;
    const fresh = Date.parse(index.until) - Date.parse(model.window.endAt) < cadenceDays * 86400000;
    measured.set(workflow.id, { model, fresh });
  }
  for (const [id, entry] of active) {
    if (entry.evaluationReady && !measured.has(id)) throw new Error("Completed progress has no native portfolio evaluation");
  }
  const roots = new Map(index.workflows.map(workflow => [workflow.id, []]));
  const markerOnly = new Map(index.workflows.map(workflow => [workflow.id, 0]));
  let unresolvedRunMarkers = 0, unknownWorkflowMarkers = 0, markerErrors = 0;
  const relatedPulls = new Map();
  for (const entity of entities.filter(row => row.kind === "PullRequest")) {
    for (const number of entity.relatedCandidates) {
      if (!relatedPulls.has(number)) relatedPulls.set(number, []);
      relatedPulls.get(number).push(entity);
    }
  }
  for (const entity of entities) {
    if (entity.referenceError) markerErrors++;
    if (markerOnly.has(entity.unverifiedWorkflowId)) {
      markerOnly.set(entity.unverifiedWorkflowId, markerOnly.get(entity.unverifiedWorkflowId) + 1);
    }
    const reference = entity.workflowReference;
    if (!reference) continue;
    if (!reference.workflowId) unresolvedRunMarkers++;
    else if (!roots.has(reference.workflowId)) unknownWorkflowMarkers++;
    else roots.get(reference.workflowId).push(entity);
  }
  const rows = index.workflows.map(workflow => {
    const proposal = contracts.get(workflow.path);
    const matched = proposal?.sourceGitBlob === workflow.gitBlob;
    const measurement = measured.get(workflow.id);
    const work = active.get(workflow.id);
    const model = measurement?.model;
    const currentSignal = !model ? null : measurement.fresh ? model.signal : { ...model.signal,
      status: "insufficient-evidence", attention: "evidence-needed",
      current: null, previous: null, directionAwareGain: null,
      reason: "The retained report cutoff is stale relative to the portfolio cutoff; historical value is preserved." };
    const outputs = roots.get(workflow.id);
    const candidates = new Map();
    for (const output of outputs) {
      if (output.kind === "PullRequest") candidates.set(output.id, output);
      for (const pull of relatedPulls.get(output.number) ?? []) candidates.set(pull.id, pull);
    }
    const status = model ? "measured" : work?.blocked ? "evidence-unavailable"
      : work ? "evaluation-in-progress" : !matched ? "intent-review-needed"
      : proposal.designStatus === "candidate" ? "instrumentation-needed" : "outcome-contract-needed";
    return { ...workflow,
      sourceUrl: `https://github.com/${index.repository}/blob/${index.sourceRevision}/${workflow.path}`,
      intent: { status: matched ? "source-matched-proposal" : "source-review-needed",
        goal: proposal?.goal ?? null, acceptance: proposal?.acceptance ?? null,
        metricName: proposal?.metricName ?? null, formula: proposal?.formula ?? null,
        unit: proposal?.unit ?? null, direction: proposal?.direction ?? null,
        limitation: matched ? proposal.limitation : "The prior intent proposal does not match this frozen source blob." },
      measurement: { status, signal: currentSignal, fresh: measurement?.fresh ?? null,
        progress: work ?? null,
        attention: currentSignal?.attention ?? "evidence-needed",
        window: model?.window ?? null, model: model ?? null,
        limitation: model ? model.limitation
          : "No verified native outcome evaluation exists here. Output and merge counts are not zero value or accepted work." },
      discovery: { markerLinkedOutputs: outputs.length,
        markerOnlyCandidates: markerOnly.get(workflow.id),
        relatedPullRequestCandidates: candidates.size,
        mergedCandidates: [...candidates.values()].filter(pull => pull.mergedAt
          && Date.parse(pull.mergedAt) < Date.parse(index.until)).length,
        firstSurvivingMarkerCreatedAt: outputs.map(output => output.createdAt).sort()[0] ?? null,
        adoptionAt: null,
        rootNumbers: outputs.map(output => output.number).sort((a, b) => a - b),
        candidatePullNumbers: [...candidates.values()].map(pull => pull.number).sort((a, b) => a - b),
        limitation: "Editable markers and body references are unverified lineage candidates; first surviving output is not adoption." },
    };
  });
  return { schemaVersion: 1, kind: "workflow-value-portfolio", repository: index.repository,
    repositoryId: index.repositoryId, sourceRevision: index.sourceRevision, until: index.until,
    acquisition: { startedAt: index.startedAt, completedAt: index.completedAt,
      entities: index.totalEntities, knownRunReferences: index.knownRunReferences,
      unresolvedRunMarkers, unknownWorkflowMarkers, markerErrors, limitations: index.limitations },
    totals: { workflows: rows.length, measured: measured.size,
      inProgress: rows.filter(row => row.measurement.status === "evaluation-in-progress").length,
      evidenceUnavailable: rows.filter(row => row.measurement.status === "evidence-unavailable").length,
      needsInstrumentation: rows.filter(row => row.measurement.status === "instrumentation-needed").length,
      needsOutcomeContract: rows.filter(row => row.measurement.status === "outcome-contract-needed").length,
      needsIntentReview: rows.filter(row => row.measurement.status === "intent-review-needed").length },
    limitation: "This is an instrumentation/evidence inventory, not a completed value evaluation of every workflow. Units and shared contributions are never summed across workflows.",
    workflows: rows };
}
