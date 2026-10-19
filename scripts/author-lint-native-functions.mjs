import { existsSync, writeFileSync } from "node:fs";
import { censusDigest, readCensusJson } from "./operational-value-census-io.mjs";
import { hashFile } from "./collect-lint-native-history.mjs";

for (const [workflow, directory, facetDirectory, details] of [
  ["eslint-monster", "eslint-monster", "radix", {
    workflowName: "ESLint Monster", facet: "missing-radix",
    label: "Missing-radix diagnostic reductions",
    goal: "Remediate actionable ESLint factory findings in actions/setup/js, including downstream implementation.",
    acceptance: "Partial native facet: signed removal of missing radix diagnostics on global parseInt and Number.parseInt in existing non-test CommonJS files, checked by isolated ESLint 9.39.5 builtin radix/always. No upstream config is loaded. Other radix equivalents, invalid radix values, other factory rules and full validation are not measured.",
    opportunity: "Immutable modifications to tracked non-test actions/setup/js/*.cjs files after workflow adoption.",
    filters: ["Only builtin radix missingRadix diagnostics count; this is a strict partial facet of the frozen factory's require-parseInt-radix rule.",
      "ESLint 9.39.5; CommonJS, latest supported ECMAScript; no upstream modules, configs, scripts or plugins execute.",
      "A separately retained initial plain-object-throw facet has zero known movement; it is not substituted for this radix facet."],
    adoption: { commit: "35777da04c8f5230a9627bc0ad01f8a6b98dd72c", adoptedAt: "2026-06-27T22:21:12Z",
      baselineCommit: "5b7ef28a594bd0a936367cd130726c4980bc2637", baselineAt: "2026-06-27T22:09:02Z" },
  }],
  ["daily-yamllint-fixer", "yamllint-fixer", ".", {
    workflowName: "Daily yamllint Fixer", facet: "self-output-trailing-spaces",
    label: "Generated sentinel trailing-space reductions",
    goal: "Reduce yamllint noise in generated lock files by repairing Go generator root causes.",
    acceptance: "Partial native output facet only: signed trailing-whitespace-line reductions in the fixed self-output sentinel .github/workflows/daily-yamllint-fixer.lock.yml. A local lexical check matches trailing-spaces line findings, including CRLF. This does not establish YAML syntax validity, other yamllint categories, generator root-cause repair, regeneration equivalence or full fleet acceptance.",
    opportunity: "Immutable modifications to the fixed generated self-output sentinel after adoption; never extrapolated to all generated files.",
    filters: ["Fixed self-output sentinel selected as a bounded source-specific output observation, not a representative sample or fleet total.",
      "The full generated-file population is outside this partial instrument; output changes do not prove generator-source causation.",
      "Trailing-space defects are lexical facts even when YAML syntax or generator safeguards are unknown."],
    adoption: { commit: "cfb0b8854e28a9bd3d95da7f6527708ab0bffdc2", adoptedAt: "2026-06-26T02:53:35Z",
      baselineCommit: "c38906bb3fd04ab5bb9d8e0c41ea3f18470d8157", baselineAt: "2026-06-26T01:33:58Z" },
  }],
]) {
  const base = `docs/operational-value/proof/${directory}`;
  const index = readCensusJson(`${base}/${facetDirectory}/native-index.json`);
  const links = readCensusJson(`${base}/graph/links.json.gz`);
  const contract = { workflow, directory, facetDirectory, ...details, revision: index.revision, cutoff: index.cutoff,
    sourceGitBlob: index.sourceGitBlob, adoptionGitBlob: index.adoptionGitBlob,
    oracleSha256: index.oracleSha256, collectorSha256: index.collectorSha256,
    nativeIndexSha256: censusDigest(index), linksSha256: censusDigest(links),
    modelSha256: hashFile(new URL("./lint-native-value.mjs", import.meta.url)) };
  const file = `docs/operational-value/proof/functions/${workflow}.mjs`;
  if (existsSync(file)) throw new Error("Refusing to overwrite existing native function");
  writeFileSync(file, `import { lintNativeModule } from "../../../../scripts/lint-native-value.mjs";\n\n`
    + `export const { definition, collectBatch, scoreMetric } = lintNativeModule(${JSON.stringify(contract, null, 2)});\n`);
  console.log(file);
}
