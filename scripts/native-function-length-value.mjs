import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { censusDigest, readCensusJson } from "./operational-value-census-io.mjs";

const count = value => Number.isSafeInteger(value) && value >= 0;
export function eligibleFunctionLengthPath(file) {
  return typeof file === "string" && /^(?:cmd|pkg)\/.*\.go$/.test(file) && !file.endsWith("_test.go")
    && !file.split("/").slice(0, -1).some(part => ["testdata", "vendor", "node_modules"].includes(part) || /^[._]/.test(part));
}

export function scanNativeFunctionLengths(evidence) {
  if (evidence?.valid !== true || evidence.complete !== true || !Array.isArray(evidence.files)
    || !evidence.files.length || evidence.files.length > 10000
    || new Set(evidence.files.map(file => file?.path)).size !== evidence.files.length) return null;
  let overlong = 0, diagnostics = 0, eligible = 0, generated = 0;
  for (const file of evidence.files) {
    const fact = file?.feature;
    if (!eligibleFunctionLengthPath(file?.path) || !fact || !/^[a-f0-9]{40}$/.test(fact.id)
      || !/^[a-f0-9]{64}$/.test(fact.contentSha256) || typeof fact.syntaxValid !== "boolean"
      || typeof fact.generated !== "boolean" || typeof fact.hasLineDirectives !== "boolean"
      || !Array.isArray(fact.functions) || fact.functions.some(fn => !fn || !count(fn.line) || !fn.line
        || !Number.isSafeInteger(fn.bodyLines) || fn.bodyLines < -1 || fn.bodyLines > 1e7
        || !["declaration", "literal"].includes(fn.kind) || typeof fn.suppressed !== "boolean")) return null;
    if (!fact.syntaxValid) return null;
    if (fact.generated) { generated++; continue; }
    if (fact.hasLineDirectives) return null;
    eligible += fact.functions.length;
    for (const fn of fact.functions) if (fn.bodyLines > 60) {
      overlong++;
      if (!fn.suppressed) diagnostics++;
    }
  }
  return { "overlong-bodies": overlong, "unsuppressed-bodies": diagnostics,
    "suppressed-bodies": overlong - diagnostics, eligible, generated };
}

export function scoreNativeFunctionLength(id, evidence) {
  if (!["overlong-bodies", "unsuppressed-bodies", "suppressed-bodies"].includes(id)) throw new Error("Unknown native function-length metric");
  return scanNativeFunctionLengths(evidence)?.[id] ?? null;
}

export function nativeFunctionLengthModule(contract) {
  if (contract.threshold !== 60 || contract.interpreterSha256 !== createHash("sha256")
    .update(readFileSync(import.meta.filename)).digest("hex")) throw new Error("Frozen native function-length predicate changed");
  const example = bodyLines => ({ valid: true, complete: true, files: [{ path: "pkg/example/example.go",
    feature: { id: "a".repeat(40), contentSha256: "b".repeat(64), syntaxValid: true, generated: false,
      hasLineDirectives: false, functions: [{ line: 2, bodyLines, kind: "declaration", suppressed: false },
        { line: 70, bodyLines, kind: "declaration", suppressed: true }] } }] });
  const metric = (id, role, name, label, formula) => ({ id, role, name, formula, unit: "functions", direction: "decrease",
    presentation: { name, legendLabel: label, transform: "identity" } });
  return { definition: { schemaVersion: 3, slug: contract.workflowId, repository: contract.repository,
    workflowName: "LintMonster", sourcePath: contract.sourcePath,
    intent: { goal: "Reduce large Go function bodies without treating suppression as a refactoring.",
      acceptance: "Independent Go AST replay counts function declarations and literals exceeding the native frozen 60-body-line boundary. This is the all-platform structural facet, not a full golint-custom result or behavior-preservation proof.",
      temporalAnchor: "workflow-adoption" },
    adoption: contract.adoption, evaluation: { mode: "attainment-only" },
    evidence: { key: "native-largefunc-source-facet-v1", repositories: [contract.repository],
      sourcePolicySha256: censusDigest(contract),
      opportunity: "All tracked non-test Go sources under cmd/ and pkg/ at each endpoint, excluding generated sources and Go-ignored directories.",
      filters: ["Use parsed function bodies and the native brace-line difference minus one, not whole-file length or a printed diagnostic count.",
        "Keep declarations and nested literals as distinct native analyzer opportunities.",
        "Count raw overlength bodies as primary; suppression changes alone cannot improve that primary.",
        "Report native same-line/previous-line largefunc/all suppressions separately.",
        "Syntax failures and line-directive source remain unknown, not clean. Generated and test sources are excluded.",
        "All-platform source replay does not claim historical build-tag selection, typechecking, other lint rules, behavior preservation or workflow causation.",
        "Freeze the current native 60-line default for comparison; historical configurable policies may differ."],
      collection: "Retained immutable source-tree identities, hash-verified Go blobs, pinned AST features and native rule sources.",
      measurementKind: "snapshot", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 } },
    model: { architecture: "Pinned standard-library Go parser extracts native function spans without executing repository code.",
      recommendation: "Inspect raw structural movement alongside suppressions, complete lint checks and behavior safeguards.",
      presentation: { label: "Large Go function bodies", betterLabel: "Fewer bodies above the native 60-line boundary" } },
    summary: { nativeLabel: "Overlength Go function bodies" },
    metrics: [
      metric("overlong-bodies", "primary", "Overlength Go function bodies", "Overlength bodies", "Count non-generated Go declaration/literal bodies with closing-brace line minus opening-brace line minus one greater than 60, regardless of suppression."),
      metric("unsuppressed-bodies", "diagnostic", "Unsuppressed overlength bodies", "Unsuppressed bodies", "The same native bodies without a same-line or previous-line largefunc/all suppression."),
      metric("suppressed-bodies", "diagnostic", "Suppressed overlength bodies", "Suppressed bodies", "Raw overlength bodies minus unsuppressed overlength bodies; suppression is not a repair."),
    ],
    validationExamples: { targetAttained: example(60), targetMissed: example(61), missing: { valid: false },
      malformed: example("sixty-one") } },
  scoreMetric: scoreNativeFunctionLength, collectBatch(requests) {
    const index = readCensusJson(`${contract.directory}/index.json`);
    const facts = readCensusJson(`${contract.directory}/facts.json.gz`);
    if (!index.complete || index.contractSha256 !== censusDigest(contract) || index.factsSha256 !== censusDigest(facts)
      || index.repository !== contract.repository || index.sourceRevision !== contract.sourceRevision
      || index.rulesSha256 !== censusDigest(readCensusJson(`${contract.directory}/rules.json.gz`))) {
      throw new Error("Native function-length evidence changed");
    }
    const features = new Map(facts.features.map(fact => [fact.id, fact]));
    if (features.size !== facts.features.length) throw new Error("Duplicate native function-length features");
    return requests.map(request => {
      if (request.repository && request.repository !== contract.repository) throw new Error("Native function-length repository mismatch");
      const state = facts.states.find(state => state.windowEnd === request.windowEnd);
      const files = state?.files.map(file => ({ path: file.path, feature: features.get(file.gitBlob) }));
      const evidence = { valid: Boolean(state), complete: state?.complete === true, files: files ?? [] };
      const scan = scanNativeFunctionLengths(evidence);
      return { evidence: { ...evidence, coverageStatus: scan ? "complete" : "unknown", maturityStatus: "matured",
        eligibleCount: scan?.eligible ?? null, missingReason: scan ? null : "Complete parseable source cohort unavailable.",
        fullGoalAcceptance: "not-measured", behaviorPreservation: "not-measured",
        workflowCausation: "not-measured", costs: "not-measured" },
      provenance: [{ repository: contract.repository, kind: "immutable-workflow-source", ref: contract.sourceGitBlob },
        { repository: contract.repository, kind: "native-function-length-index", ref: censusDigest(index) }],
      commit: state?.commit ?? contract.sourceRevision };
    });
  } };
}
