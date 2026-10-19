import { readFileSync } from "node:fs";
import { commitFacts, readCustody } from "./custody-reader.mjs";
import { digest } from "./native-oracle.mjs";
import { inspectCases } from "../../../../scripts/native-doc-consolidation.mjs";

const contractBytes = readFileSync(new URL("./contracts-v1.json", import.meta.url));
const contracts = JSON.parse(contractBytes);
const contractSha256 = "b1ebfa9950c758fd1e5f11d0c0d32fb2901296dfcebbac24fcb4121ee17d13e8";
const custodySha256 = "1b7fd31161f82409acb990753fb71acbe1731ae9080b28163a06d73a5b31f701";
if (digest(contractBytes) !== contractSha256) throw new Error("Frozen documentation predicates changed");
const iso = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().replace(".000Z", "Z") === value;
const count = value => Number.isSafeInteger(value) && value >= 0;

function score(id, evidence, slug) {
  if (!evidence || evidence.contract !== contractSha256 || evidence.slug !== slug || evidence.kind !== "bounded-native-cases"
    || !Array.isArray(evidence.cases) || !count(evidence.assessedCases) || !count(evidence.eligibleCount)
    || !count(evidence.candidateCount) || evidence.assessedCases > evidence.eligibleCount
    || evidence.cases.length !== evidence.candidateCount
    || evidence.cases.filter(item => item.native?.status !== "ineligible").length !== evidence.eligibleCount) return null;
  const ids = evidence.cases.map(item => item.id);
  if (new Set(ids).size !== ids.length || evidence.cases.some(item => typeof item.id !== "string" || !item.id)) return null;
  const field = { "native-improvements": "nativeUnits", "full-goal": "fullGoalUnits", "workflow-contribution": "contributionUnits" }[id];
  if (!field) return null;
  const assessed = evidence.cases.filter(item => item.native?.status === "assessed");
  if (assessed.length !== evidence.assessedCases || assessed.some(item => !count(item.native.removed))) return null;
  let expected;
  if (id === "native-improvements") expected = assessed.reduce((sum, item) => sum + item.native.removed, 0);
  else {
    const caseField = id === "full-goal" ? "fullGoal" : "contribution";
    if (evidence.cases.some(item => !count(item[caseField]))) return null;
    expected = evidence.cases.reduce((sum, item) => sum + item[caseField], 0);
  }
  const value = evidence[field];
  return count(value) && value === expected && evidence.assessedCases > 0 ? value : null;
}

export function createValueModule(slug, anchor) {
  const contract = contracts.workflows[slug];
  if (!contract) throw new Error("Unknown documentation cohort");
  const example = number => ({ contract: contractSha256, slug, kind: "bounded-native-cases",
    cases: [{ id: "validation-only", native: { status: "assessed", removed: number }, fullGoal: number, contribution: number }],
    candidateCount: 1, eligibleCount: 1, assessedCases: 1, nativeUnits: number, fullGoalUnits: number, contributionUnits: number });
  const metric = (id, name, role, unit) => ({ id, name, role, formula: `Sum accepted ${unit} across original native cases in [windowStart,windowEnd); null when unassessed.`,
    direction: "increase", unit, presentation: { name, legendLabel: id === "native-improvements" ? "Native partial outcomes" : name, transform: "identity" } });
  const definition = {
    schemaVersion: 3, slug, repository: contracts.repository, workflowName: slug,
    sourcePath: `.github/workflows/${slug}.md`,
    intent: { goal: contract.goal, acceptance: contract.partialAcceptance, temporalAnchor: "workflow-adoption" },
    adoption: anchor, evaluation: { mode: "attainment-only" },
    evidence: { key: `doc-consolidation-v1/${slug}`, repositories: [contracts.repository],
      opportunity: contract.opportunity, filters: [contract.partialAcceptance, contracts.sharedRules.historicalApplicability],
      collection: "Offline original Git custody and complete production issue/PR discovery. Bounded candidate cohort; missing originals and Discussions remain gaps, not zero delivery.",
      measurementKind: "interval", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 } },
    model: { architecture: "Deterministic original-byte native predicates; strict full-goal, semantic usability and attribution remain separate.",
      recommendation: "Not rated: no native keep bar or matched costs; bounded cases do not establish full historical coverage.",
      presentation: { label: "Native partial documentation outcomes", betterLabel: "More independently verified outcomes" } },
    summary: { nativeLabel: contract.nativeUnit },
    metrics: [
      metric("native-improvements", "Native partial outcomes", "primary", contract.nativeUnit),
      metric("full-goal", "Full goal completion", "diagnostic", "fully verified documentation outcomes"),
      metric("workflow-contribution", "Verified contribution", "diagnostic", "receipt-verified contributed outcomes"),
    ],
    validationExamples: { targetAttained: example(1), targetMissed: example(0), missing: null, malformed: { cases: [] } },
    contractVersion: "doc-consolidation-v1", contractSha256, custodySha256, frozenSourceBlob: contract.sourceBlob,
    retrospectiveAssessment: contracts.sharedRules.historicalApplicability,
    historicalClassification: { phenomenonPredatesWorkflow: true, baseline: "No comparable pre-adoption native cohort has been established by this bounded study; not an assertion that history is exhausted.",
      adoptionComparison: "unavailable", currentInstrumentNotWorkflowIntroduction: true },
    fullAcceptance: contract.fullAcceptance, rejectedProxies: contract.rejected,
    limitations: [contracts.sharedRules.missing, contracts.sharedRules.fullGoal,
      "A non-null bounded count is not evidence of complete repository-period coverage or full-goal attainment.",
      ...(contract.discoveryLimitation ? [contract.discoveryLimitation] : []),
      ...(contract.scopeAmbiguity ? [contract.scopeAmbiguity] : [])],
  };

  async function collectBatch(requests, context = {}) {
    if (!Array.isArray(requests)) throw new Error("Collector requires a batch array");
    for (const request of requests) {
      if (!iso(request.observedAt) || !iso(request.windowStart) || !iso(request.windowEnd)
        || Date.parse(request.windowStart) >= Date.parse(request.windowEnd)
        || Date.parse(request.windowEnd) > Date.parse(request.observedAt)
        || Date.parse(request.observedAt) > Date.parse(contracts.cutoff)
        || request.repository && request.repository !== contracts.repository) throw new Error("Invalid source, clock or observation window");
    }
    const custody = readCustody(context.custodyDirectory);
    if (custody.sha256 !== custodySha256) throw new Error("Frozen study custody identity mismatch");
    if (custody.archive.workflows[slug]?.blob !== contract.sourceBlob
      || !custody.object(contract.sourceBlob, "blob")) throw new Error("Frozen source identity mismatch");
    const source = custody.resolve(contracts.sourceRevision, definition.sourcePath);
    if (source.status !== "present" || source.blob !== contract.sourceBlob) throw new Error("Frozen source path not proven");
    const introduction = custody.resolve(anchor.commit, definition.sourcePath);
    const predecessor = custody.resolve(anchor.baselineCommit, definition.sourcePath);
    const introduced = commitFacts(custody, anchor.commit);
    const workflowIntroductionVerified = introduction.status === "present" && predecessor.status === "absent"
      && introduced?.parent === anchor.baselineCommit && introduced.timestamp === anchor.adoptedAt;
    const allCases = inspectCases(custody).filter(item => item.slug === slug);
    const selected = custody.archive.selections.find(item => item.slug === slug);
    return requests.map(request => {
      const cases = allCases.filter(item => Date.parse(item.timestamp) >= Date.parse(request.windowStart)
        && Date.parse(item.timestamp) < Date.parse(request.windowEnd));
      const eligible = cases.filter(item => item.native.status !== "ineligible");
      const assessed = cases.filter(item => item.native.status === "assessed");
      const unresolved = eligible.length - assessed.length;
      const nativeUnits = assessed.length ? assessed.reduce((sum, item) => sum + item.native.removed, 0) : null;
      const missingReason = !workflowIntroductionVerified ? "Workflow introduction source proof incomplete; no source-era acceptance inferred."
        : !eligible.length ? "No acquired eligible native case in this period; bounded candidate selection is not an exhaustive native opportunity population."
          : unresolved ? "Selected original native cases lack defining acceptance facts; retained known outcomes are partial only."
            : "Bounded native-case cohort only; repository-period opportunity coverage is not exhaustive.";
      return {
        evidence: { kind: "bounded-native-cases", contract: contractSha256, slug, ...request,
          coverageStatus: assessed.length ? "partial" : "missing", maturityStatus: assessed.length ? "matured" : "unavailable",
          missingReason, workflowIntroductionVerified, historicalApplicability: contracts.sharedRules.historicalApplicability,
          candidateCount: cases.length, eligibleCount: eligible.length, assessedCases: assessed.length, unresolvedCases: unresolved,
          nativeUnits: workflowIntroductionVerified ? nativeUnits : null, fullGoalUnits: null, contributionUnits: null,
          populationDigest: digest(JSON.stringify(eligible.map(item => [item.id, item.commit]))),
          candidateDigest: digest(JSON.stringify(cases.map(item => [item.id, item.commit]))),
          cases, discovery: { issuePrComplete: custody.discovery.index.complete,
            selectedCandidateCount: selected?.candidateCount ?? null,
            discussionsComplete: false, absentReferencesPreserved: true },
          costs: "not measured", decision: "not rated",
        },
        provenance: [
          { repository: contracts.repository, kind: "immutable-workflow-source", ref: `git:${contracts.sourceRevision}:${definition.sourcePath}#${contract.sourceBlob}` },
          { repository: contracts.repository, kind: "verified-local-original-custody", ref: `sha256:${custody.sha256}` },
          { repository: contracts.repository, kind: "frozen-outcome-predicates", ref: `sha256:${contractSha256}` },
          ...cases.map(item => ({ repository: contracts.repository, kind: "immutable-native-change", ref: `git:${item.commit}` })),
        ],
      };
    });
  }
  return { definition, collectBatch, scoreMetric: (id, evidence) => score(id, evidence, slug) };
}
