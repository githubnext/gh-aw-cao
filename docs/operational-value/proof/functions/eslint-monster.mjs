import { lintNativeModule } from "../../../../scripts/lint-native-value.mjs";

export const { definition, collectBatch, scoreMetric } = lintNativeModule({
  "workflow": "eslint-monster",
  "directory": "eslint-monster",
  "facetDirectory": "radix",
  "workflowName": "ESLint Monster",
  "facet": "missing-radix",
  "label": "Missing-radix diagnostic reductions",
  "goal": "Remediate actionable ESLint factory findings in actions/setup/js, including downstream implementation.",
  "acceptance": "Partial native facet: signed removal of missing radix diagnostics on global parseInt and Number.parseInt in existing non-test CommonJS files, checked by isolated ESLint 9.39.5 builtin radix/always. No upstream config is loaded. Other radix equivalents, invalid radix values, other factory rules and full validation are not measured.",
  "opportunity": "Immutable modifications to tracked non-test actions/setup/js/*.cjs files after workflow adoption.",
  "filters": [
    "Only builtin radix missingRadix diagnostics count; this is a strict partial facet of the frozen factory's require-parseInt-radix rule.",
    "ESLint 9.39.5; CommonJS, latest supported ECMAScript; no upstream modules, configs, scripts or plugins execute.",
    "A separately retained initial plain-object-throw facet has zero known movement; it is not substituted for this radix facet."
  ],
  "adoption": {
    "commit": "35777da04c8f5230a9627bc0ad01f8a6b98dd72c",
    "adoptedAt": "2026-06-27T22:21:12Z",
    "baselineCommit": "5b7ef28a594bd0a936367cd130726c4980bc2637",
    "baselineAt": "2026-06-27T22:09:02Z"
  },
  "revision": "c86377ec47b38f0b5af463277ee55d1d03d08da8",
  "cutoff": "2026-10-18T15:00:12Z",
  "sourceGitBlob": "142319d6a938db921d5db885fd01d159a929c7bc",
  "adoptionGitBlob": "2a03df41cc7f75321d3bd4796bc184264c665288",
  "oracleSha256": "a77d056e5ce33d425767e6730e231d686d76636c592ebca4a7fe52b696f66837",
  "collectorSha256": "fb62f55885f72b0a38865998988d4a6954ab63b1cf98c785971caea897bc12b2",
  "nativeIndexSha256": "d254bb8ead915e8486582b9d74e1d6783740847acbc578f9e8b78a8b96c712d1",
  "linksSha256": "ddf690872805f4187b690773ff4b54079cb07cfbb52d7d57e590034457a65dc2",
  "modelSha256": "f314bc7bec6149bdc08e4ee2fb230e69a893536f46db03e73c759dd1f1ed6c31"
});
