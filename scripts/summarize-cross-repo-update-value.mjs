import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { readJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { definition } from "../docs/operational-value/proof/functions/smoke-update-cross-repo-pr.mjs";

const root = "docs/operational-value/proof/cross-repo-update";
const slug = definition.slug;
const reports = `${root}/reports/github-gh-aw/${slug}`;
const acquisition = readJsonArchive(`${root}/acquisition.json`);
const contract = readJsonArchive(`${root}/contract.json`);
const timeline = readJsonArchive(`${reports}-timeline.json`);
const pulse = readJsonArchive(`${reports}-pulse.json`);
const functionPath = `docs/operational-value/proof/functions/${slug}.mjs`;
const digest = value => createHash("sha256").update(value).digest("hex");
const functionSha256 = digest(readFileSync(functionPath));
assert.equal(timeline.valueFunction.sha256, functionSha256);
assert.equal(pulse.valueFunctionSha256, functionSha256);
assert.equal(timeline.snapshots.length, 34);
assert(timeline.snapshots.every(row => row.metrics["sequential-appends"] === null
  && row.metrics["nonduplicate-line-appends"] === null && row.evidence.coverageStatus === "missing"));
assert.equal(pulse.signal.status, "insufficient-evidence");
const acquisitionSha256 = digest(JSON.stringify(acquisition));
assert(timeline.snapshots.every(row => row.provenance.some(provenance =>
  provenance.repository === definition.repository && provenance.kind === "public-source-and-run-inventory"
  && provenance.ref === acquisitionSha256)));
const measuredPeriods = timeline.snapshots.filter(row => Number.isFinite(row.metrics["sequential-appends"])).length;
const index = {
  schemaVersion: 1, workflowId: slug, repository: definition.repository,
  status: "blocked-not-measured", sourceReviewComplete: true, publicRetainedRunInventoryComplete: true,
  nativeEvidenceReady: false, complete: false, sourceRevision: contract.revision,
  sourceGitBlob: contract.sourceBlob, until: contract.until,
  functionPath, functionSha256, interpreterSha256: contract.interpreterSha256,
  contractPath: `${root}/contract.json`, contractSha256: digest(JSON.stringify(contract)),
  acquisitionPath: `${root}/acquisition.json`, acquisitionSha256,
  sourcePath: `${root}/sources.json`, sourceProfiles: definition.sourceReview.profiles.length,
  retainedRunMetadataCount: acquisition.runs.length, nativeAssessmentCount: 0,
  independentlyMeasuredPeriods: measuredPeriods, unavailableAssessments: timeline.snapshots.length,
  eligibleOpportunities: null, acceptedNativeAppends: null, signal: pulse.signal.status,
  scope: "Public source/compiled profiles and public run metadata only; target visibility metadata only.",
  targetVisibility: acquisition.targets, missing: acquisition.missing,
  classification: { mode: "attainment-only", antecedent: definition.sourceReview.antecedent,
    historicalBaseline: "unavailable", outcomeMeasurability: "blocked-by-authority-and-missing-sequence-oracle" },
  retainedMeasures: [
    { id: "sequential-appends", role: "primary", unit: "verified line appends", value: null },
    { id: "nonduplicate-line-appends", role: "diagnostic", unit: "verified line appends", value: null },
  ],
  rejectedProxies: ["run counts", "successful run/job counts", "issue reports", "PR state", "push counts",
    "editable agent text", "current target state backdated into history"],
  registration: { contract: `${root}/contract.json`, index: `${root}/index.json`, function: functionPath,
    timeline: `${reports}-timeline.json`, pulse: `${reports}-pulse.json`, plot: `${reports}-pulse.html`,
    primaryMetric: "sequential-appends", provenanceKind: "public-source-and-run-inventory",
    provenancePath: `${root}/acquisition.json`, provenanceRef: acquisitionSha256,
    evidenceReadinessGuard: "index.nativeEvidenceReady === true && index.independentlyMeasuredPeriods > 0 && timeline.snapshots.some(s => Number.isFinite(s.metrics['sequential-appends']))",
    registerAsMeasured: false },
  validations: [
    { command: "node --test tests/unit/cao-operational-value-cross-repo-update.test.mjs", result: "10 passed" },
    { command: `node .github/skills/add-operational-value/scripts/verify-value-function.mjs --collector ${functionPath}`, result: "passed" },
    { command: `node .github/skills/add-operational-value/scripts/evaluate.mjs --end ${contract.until} --output-dir ${root}/reports --function ${functionPath} github/gh-aw ${slug}`,
      result: "34 unavailable assessments, standard native-unit timeline/HTML plot; not measured" },
    { command: "npx eslint scripts/collect-cross-repo-update-value.mjs scripts/author-cross-repo-update-value.mjs scripts/native-cross-repo-update-value.mjs scripts/summarize-cross-repo-update-value.mjs docs/operational-value/proof/functions/smoke-update-cross-repo-pr.mjs",
      result: "passed" },
    { command: "npm run typecheck:cao", result: "passed" },
    { command: "npm run compile", result: "72 succeeded, 2 pre-existing action-version warnings; gh aw v0.92.5" },
  ],
  lessons: [
    "Check repository metadata visibility before any cross-repository content read; authenticated access never establishes public authority.",
    "Freeze an edition/sequence mapping before scoring natural-language next-item goals; exact-byte append proof alone cannot establish semantic order.",
    "Bind cross-repository outcomes to the exact source-era target, stable repository/PR identity, branch and independently retained pre/post head receipts.",
    "Review compiled protected-file fallback behavior: a successful review request or handler result need not establish an actual target-branch content change.",
    "Exhaust time-partitioned retained run inventories beyond the API's 1000-result filter cap, but never promote discovery completeness to native opportunity completeness.",
    "An all-unknown native plot is a preserved evidence gap, not measured workflow coverage or zero operational value.",
    "Registration provenance kind and reference must match actual collector provenance; missingness labels are not provenance identities.",
    "Native receipt acceptance requires independently expected run/attempt/source/runtime/branch identities, exact artifact payload digests, producer host joins and protected chronology.",
  ],
};
writeFileSync(`${root}/index.json`, `${JSON.stringify(index, null, 2)}\n`);
console.log(JSON.stringify({ status: index.status, periods: timeline.snapshots.length,
  measuredPeriods, functionSha256, registeredAsMeasured: false }));
