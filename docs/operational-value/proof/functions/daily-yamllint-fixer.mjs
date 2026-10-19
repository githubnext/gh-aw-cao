import { lintNativeModule } from "../../../../scripts/lint-native-value.mjs";

export const { definition, collectBatch, scoreMetric } = lintNativeModule({
  "workflow": "daily-yamllint-fixer",
  "directory": "yamllint-fixer",
  "facetDirectory": ".",
  "workflowName": "Daily yamllint Fixer",
  "facet": "self-output-trailing-spaces",
  "label": "Generated sentinel trailing-space reductions",
  "goal": "Reduce yamllint noise in generated lock files by repairing Go generator root causes.",
  "acceptance": "Partial native output facet only: signed trailing-whitespace-line reductions in the fixed self-output sentinel .github/workflows/daily-yamllint-fixer.lock.yml. A local lexical check matches trailing-spaces line findings, including CRLF. This does not establish YAML syntax validity, other yamllint categories, generator root-cause repair, regeneration equivalence or full fleet acceptance.",
  "opportunity": "Immutable modifications to the fixed generated self-output sentinel after adoption; never extrapolated to all generated files.",
  "filters": [
    "Fixed self-output sentinel selected as a bounded source-specific output observation, not a representative sample or fleet total.",
    "The full generated-file population is outside this partial instrument; output changes do not prove generator-source causation.",
    "Trailing-space defects are lexical facts even when YAML syntax or generator safeguards are unknown."
  ],
  "adoption": {
    "commit": "cfb0b8854e28a9bd3d95da7f6527708ab0bffdc2",
    "adoptedAt": "2026-06-26T02:53:35Z",
    "baselineCommit": "c38906bb3fd04ab5bb9d8e0c41ea3f18470d8157",
    "baselineAt": "2026-06-26T01:33:58Z"
  },
  "revision": "c86377ec47b38f0b5af463277ee55d1d03d08da8",
  "cutoff": "2026-10-18T15:00:12Z",
  "sourceGitBlob": "667408c131c48c4d3b51720ba32787b93d7e30ba",
  "adoptionGitBlob": "a24e2aa3be10f717b212ab9ba5949bfa706939f8",
  "oracleSha256": "75ff591735266914f799b6bb49e484ea8b3a291d37089b5a603c936666e913b1",
  "collectorSha256": "f059a5d0f39b292066bc6d95f2d0645af8d5fd0f0c5ba4e0b001e9789c2c208a",
  "nativeIndexSha256": "8d3ff7e0173c89559fb905333ddb295f4f05896ea1342265027957cacb38c131",
  "linksSha256": "67e1146635677a3e6ad7315c709bcc46c50c7aa85fe2ea92a77fae7b729a11d7",
  "modelSha256": "f314bc7bec6149bdc08e4ee2fb230e69a893536f46db03e73c759dd1f1ed6c31"
});
