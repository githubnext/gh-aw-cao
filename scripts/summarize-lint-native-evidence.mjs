import { existsSync } from "node:fs";
import { censusDigest, readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";

for (const [workflow, directory, facet] of [
  ["eslint-monster", "eslint-monster", "radix"],
  ["daily-yamllint-fixer", "yamllint-fixer", "."],
]) {
  const base = `docs/operational-value/proof/${directory}`;
  const index = readCensusJson(`${base}/${facet}/native-index.json`);
  const links = readCensusJson(`${base}/graph/links.json.gz`);
  const module = await import(`../docs/operational-value/proof/functions/${workflow}.mjs`);
  const [result] = module.collectBatch([{ windowStart: module.definition.adoption.adoptedAt,
    windowEnd: index.cutoff, observedAt: index.cutoff }]);
  const rows = index.partitions.flatMap(part => readCensusJson(`${base}/${facet}/${part.file}`));
  const file = `${base}/coverage.json`;
  if (existsSync(file)) throw new Error("Refusing to overwrite retained coverage");
  const prefix = `${base}/reports/github-gh-aw/${workflow}`;
  const evidence = result.evidence;
  writeCensusJson(file, {
    schemaVersion: 1, workflow, repository: index.repository, sourceRevision: index.revision, cutoff: index.cutoff,
    sourceGitBlob: index.sourceGitBlob, adoptionGitBlob: index.adoptionGitBlob,
    adoption: module.definition.adoption,
    adoptionValidation: { actualAdditionAgainstRealParent: index.adoptionVerified,
      parent: index.adoptionParent, sourceAbsentInParent: index.sourceParentAbsent },
    coverage: { function: "complete", nativePartialFacetEvidence: "complete", evaluation: "complete",
      nativePlot: "complete", fullGoalSafeguards: "not-measured", exclusiveCausality: "not-claimed",
      repositoryPopulation: workflow === "eslint-monster" ? "non-test scoped CommonJS modifications"
        : "one fixed generated self-output sentinel; never extrapolated to the fleet" },
    functionPath: `docs/operational-value/proof/functions/${workflow}.mjs`,
    reportPaths: { timeline: `${prefix}-timeline.json`, nativePlot: `${prefix}-pulse.html`,
      plotData: `${prefix}-pulse.json`, definition: `${prefix}-definitions.md`,
      evidenceArchive: `${prefix}-evidence-archive.json` },
    nativeIndex: `${base}/${facet}/native-index.json`, nativeIndexSha256: censusDigest(index),
    graph: `${base}/graph/links.json.gz`, archivedBlobCount: index.blobs, nativeAssessments: evidence.assessedFiles,
    knownAssessments: evidence.knownAssessments, unknownAssessments: evidence.unknownAssessments,
    linkedKnownAssessments: evidence.knownLinkedAssessments,
    linkedUnknownAssessments: rows.filter(row => row.value === null
      && links.contributions.some(link => link.mergeCommit === row.commit)).length,
    nativeMeasuredTotals: Object.fromEntries(module.definition.metrics.map(metric =>
      [metric.id, module.scoreMetric(metric.id, evidence)])),
    acceptedNativeEvents: rows.filter(row => row.value !== null && row.value !== 0).map(row => ({
      commit: row.commit, at: row.at, path: row.path, beforeBlob: row.beforeBlob, afterBlob: row.afterBlob,
      before: row.before.defects, after: row.after.defects, nativeValue: row.value,
      linked: links.contributions.filter(link => link.mergeCommit === row.commit)
        .map(link => ({ number: link.number, url: link.url, attribution: link.attribution })),
    })),
    unknownGaps: ["File additions/deletions and unsupported modes are not native repair assertions.",
      ...(workflow === "eslint-monster" ? ["Parse failures remain unknown; other factory lint categories and invalid-radix diagnostics are unmeasured.",
        "One linked added file remains unknown; five observed linked reductions are a subtotal, not a complete contribution total."]
        : ["Fleet-wide lint, generator root causes, full YAML validity and other yamllint categories are not measured.",
          "Eleven repository sentinel reductions have no corroborated workflow link; do not credit them to this workflow."]),
      "Retained marker lineage is corroborated shared contribution, not authoritative creation proof; edited-away and deleted outputs are gaps.",
      "Required checks, behavior preservation, full goal acceptance, and costs are not measured."],
    validations: ["node --test tests/unit/lint-native-operational-value.test.mjs (5 passing)",
      "verify-value-function.mjs --collector (both modules passing)",
      "Focused ESLint (zero errors; tests ignored by repository policy)", "npm run typecheck:cao (passing)",
      "npm run compile (72 workflows passing; two pre-existing outdated-action warnings)",
      "All owned files <=256KiB"],
    portfolioIntegration: `Register the explicit functionPath and reportPaths above as native partial-facet coverage. `
      + `Do not infer full-goal or causal completion. Use observed-linked-net as the contribution signal. `
      + `Evidence must resolve from ${base}; source-specific index and partition digests are frozen.`,
    skillLessons: "Freeze a narrow source-intrinsic native facet before replay. Validate adoption against a real parent, "
      + "not a shallow log boundary. Pin tool and helper identities, isolate trusted builtins from upstream configs, "
      + "and separate signed diagnostic movement from merged outputs. Keep unknown additions, parsing, full safeguards "
      + "and attribution separate. A bounded fixed sentinel is partial output evidence, never a fleet-wide generator fix.",
  });
  console.log(file);
}
