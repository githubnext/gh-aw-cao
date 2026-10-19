import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { censusDigest, readCensusJson } from "./operational-value-census-io.mjs";
import { verifyPublicGitBlob } from "./immutable-public-git-source.mjs";

export const workQueueDirectory = "docs/operational-value/proof/work-queue";
const positive = value => Number.isSafeInteger(value) && value > 0;
const timestamp = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().replace(".000Z", "Z") === value;

export function queueHostSuccess(step, until) {
  return positive(step?.number) && step.status === "completed" && step.conclusion === "success"
    && timestamp(step.started_at) && timestamp(step.completed_at)
    && step.completed_at >= step.started_at && step.completed_at < until;
}

export function assessQueueRun(row, contract) {
  const missing = reason => ({ predicates: contract.predicates.map(({ id }) => ({ id, passed: null })),
    smokeReadback: null, reason });
  const run = row?.run;
  if (!positive(run?.id) || run.attempt !== 1 || run.repositoryId !== contract.repositoryId
    || !["schedule", "workflow_dispatch"].includes(run.event) || run.path !== contract.compiledPath
    || !/^[a-f0-9]{40}$/.test(run.headSha) || !timestamp(run.createdAt)
    || run.createdAt < contract.adoption.adoptedAt || run.createdAt >= contract.until) {
    return missing("No eligible same-repository initial execution identity.");
  }
  if (contract.incompatibleIntentProfiles.some(profile => profile.sourceGitBlob === row.source?.sourceGitBlob)) {
    return { ...missing("Incompatible historical finish-staging intent, not an observer outcome."), eligible: false };
  }
  if (row.source?.reviewed !== true || row.source.sourceGitBlob !== contract.sourceGitBlob
    || row.source.hostJobSha256 !== contract.hostJobSha256
    || row.source.headSha !== run.headSha) return missing("Unsupported or unavailable historical source profile.");
  const result = missing("The reviewed source has no independent native observer predicate checker.");
  const jobs = row.jobs?.filter(job => job.name === contract.smokeReadback.job);
  if (jobs?.length !== 1 || !positive(jobs[0].id) || jobs[0].runId !== run.id
    || jobs[0].headSha !== run.headSha || jobs[0].attempt !== 1) return result;
  const download = jobs[0].steps.filter(step => step.name === contract.smokeReadback.downloadStep);
  const assertion = jobs[0].steps.filter(step => step.name === contract.smokeReadback.assertionStep);
  if (download.length === 1 && assertion.length === 1
    && queueHostSuccess(download[0], contract.until) && queueHostSuccess(assertion[0], contract.until)
    && download[0].number < assertion[0].number && run.createdAt <= download[0].started_at
    && download[0].completed_at <= assertion[0].started_at) result.smokeReadback = true;
  return result;
}

export function scoreQueueMetric(id, evidence, contract) {
  if (!["observed-predicates", "smoke-readbacks"].includes(id)) {
    throw new Error("Unknown work queue metric");
  }
  if (evidence?.valid !== true || evidence.contractSha256 !== censusDigest(contract)
    || !Array.isArray(evidence.assessments)
    || new Set(evidence.assessments.map(row => row?.id)).size !== evidence.assessments.length
    || evidence.assessments.some(row => !positive(row?.id) || !Array.isArray(row.predicates)
      || row.predicates.length !== contract.predicates.length
      || row.predicates.some((item, i) => item?.id !== contract.predicates[i].id || ![true, false, null].includes(item.passed))
      || ![true, null].includes(row.smokeReadback))) return null;
  const cases = evidence.assessments.flatMap(row => row.predicates);
  const known = cases.filter(item => item.passed !== null);
  if (id === "smoke-readbacks") {
    return evidence.assessments.some(row => row.smokeReadback === true)
      ? evidence.assessments.filter(row => row.smokeReadback === true).length : null;
  }
  if (!cases.length || !known.length) return null;
  return known.filter(item => item.passed === true).length;
}

export function workQueueModule(contract, interpreterSha256, contractSha256) {
  if (censusDigest(contract) !== contractSha256) throw new Error("Frozen work queue acceptance contract changed");
  if (createHash("sha256").update(readFileSync(import.meta.filename)).digest("hex") !== interpreterSha256) {
    throw new Error("Frozen work queue interpreter changed");
  }
  const fixture = (passed, count) => ({ valid: true, contractSha256: censusDigest(contract),
    assessments: Array.from({ length: count }, (_, i) => ({ id: i + 1,
      predicates: contract.predicates.map(({ id }) => ({ id, passed })), smokeReadback: true })) });
  const metric = (id, role, name, unit, direction, formula, legendLabel) => ({
    id, role, name, unit, direction, formula, presentation: { name, legendLabel, transform: "identity" },
  });
  return {
    definition: {
      schemaVersion: 3, slug: contract.workflowId, repository: contract.repository,
      workflowName: "Smoke Work Queue", sourcePath: contract.sourcePath,
      intent: {
        goal: "For initial observer executions, independently verify snapshot-bound absent reads, nonauthoritative explanations and rejection or omission of unassigned finish without staged or durable mutation.",
        acceptance: contract.predicates.map(item => item.acceptance).join(" "),
        temporalAnchor: "workflow-adoption",
      },
      adoption: contract.adoption, evaluation: { mode: "attainment-only" },
      evidence: { key: "native-work-queue-observer-v1", repositories: [contract.repository],
        sourcePolicySha256: censusDigest(contract), interpreterSha256,
        opportunity: "Three observer predicates per initial same-repository scheduled/manual observer-era run. The independently reviewed incompatible finish-staging era is ineligible; unsupported observer runtime profiles remain unassessed. Reruns are not new opportunities.",
        filters: contract.limitations,
        collection: "Bounded public run/job/artifact inventory, immutable source replay and protected host readback discovery. Native predicate acceptance requires independent source-bound operation, state and mutation-safety receipts, which the frozen profile does not emit.",
        measurementKind: "interval", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 } },
      model: { architecture: "Native observer predicates separated from the weaker source-defined noop/artifact smoke readback.",
        recommendation: "An all-unknown native function is an instrumentation gap, not measured workflow coverage.",
        presentation: { label: "Verified observer predicates", betterLabel: "More independently verified observer predicates" } },
      summary: { nativeLabel: "Independently verified queue observer predicates" },
      metrics: [
        metric("observed-predicates", "primary", "Independently verified observer predicates", "predicates", "increase",
          "Count independently established true native predicates; retain established partial proof through gaps, but return null when all are unknown.", "Observer predicates"),
        metric("smoke-readbacks", "diagnostic", "Protected smoke readbacks (not native proof)", "readbacks", "increase",
          "Count exact reviewed initial-run download and noop/no-finish-artifact assertion steps that succeeded before cutoff. Never credit this as a native predicate.", "Smoke readbacks"),
      ],
      signal: { metricId: "observed-predicates", basis: "repository-outcome" },
      validationExamples: { targetAttained: fixture(true, 2), targetMissed: fixture(false, 1),
        missing: { valid: false }, malformed: { ...fixture(true, 1), assessments: [{ id: 1, predicates: [] }] } },
    },
    scoreMetric: (id, evidence) => scoreQueueMetric(id, evidence, contract),
    collectBatch(requests) {
      const index = readCensusJson(`${workQueueDirectory}/index.json`);
      const rows = readCensusJson(`${workQueueDirectory}/observations.json.gz`);
      const sources = readCensusJson(`${workQueueDirectory}/sources.json.gz`);
      if (index.complete !== true || index.contractSha256 !== censusDigest(contract)
        || index.observationsSha256 !== censusDigest(rows) || index.observations !== rows.length
        || index.interpreterSha256 !== interpreterSha256 || !Array.isArray(rows)
        || new Set(rows.map(row => row.run?.id)).size !== rows.length) throw new Error("Incomplete or changed work queue evidence");
      if (!Array.isArray(sources) || index.sourcesSha256 !== censusDigest(sources) || index.sources !== sources.length
        || contract.sources.some(item => !sources.some(source => source.sha256 === item.sha256))) {
        throw new Error("Incomplete or changed immutable work queue sources");
      }
      for (const source of sources) {
        const native = Buffer.from(source.native, "base64");
        verifyPublicGitBlob(native, source.id);
        if (source.lfs || source.content !== source.native
          || createHash("sha256").update(native).digest("hex") !== source.sha256) {
          throw new Error("Unsupported or changed immutable queue source payload");
        }
        if (contract.incompatibleIntentProfiles.some(profile => !sources.some(source =>
          source.id === profile.sourceGitBlob && source.sha256 === profile.sourceSha256))) {
          throw new Error("Missing independently reviewed historical intent source");
        }
      }
      return requests.map(request => {
        if (request.repository && request.repository !== contract.repository) throw new Error("Work queue repository mismatch");
        if (!timestamp(request.windowStart) || !timestamp(request.windowEnd)
          || request.windowStart >= request.windowEnd) throw new Error("Invalid work queue measurement window");
        const selected = rows.filter(row => row.run.createdAt >= request.windowStart && row.run.createdAt < request.windowEnd);
        const assessments = selected.map(row => ({ id: row.run.id, ...assessQueueRun(row, contract) }));
        const eligible = assessments.filter(row => row.eligible !== false);
        return { evidence: { valid: request.windowEnd <= contract.until && request.windowStart >= contract.adoption.adoptedAt,
          contractSha256: censusDigest(contract), assessments: eligible,
          inventoryInitialAttempts: selected.length, observerInitialAttempts: eligible.length,
          incompatibleIntentAttempts: selected.length - eligible.length,
          nativePredicateOpportunities: eligible.length * contract.predicates.length,
          independentlyAssessedPredicates: 0, unassessedInitialAttempts: eligible.length,
          eligibleCount: eligible.length * contract.predicates.length, coverageStatus: "missing", nativeCoverage: "not-measured",
          missingReason: "No source-bound independent native observer checker/receipts; smoke success is not native conformance.",
          costs: "not-measured", workflowContribution: "not-measured", limitations: contract.limitations },
        provenance: [{ repository: contract.repository, kind: "immutable-workflow-source", ref: contract.sourceGitBlob },
          { repository: contract.repository, kind: "queue-observer-evidence-index", ref: censusDigest(index) }],
        commit: contract.sourceRevision };
      });
    },
  };
}
