import { nativeSafeOutputFixtureModule } from "../../../../scripts/native-safe-output-fixture-value.mjs";

export const { definition, collectBatch, scoreMetric } = nativeSafeOutputFixtureModule({
  "workflowId": "daily-safe-output-integrator",
  "repository": "github/gh-aw",
  "sourceRevision": "c86377ec47b38f0b5af463277ee55d1d03d08da8",
  "sourceGitBlob": "157bd4eb4d3b03e692dcb255ac200b6f9a1246d9",
  "until": "2026-10-18T15:00:12Z",
  "nativeModelSha256": "96b9ea1e66b3fc6d926d4a65854195bc20a93d942c9536754adc3c5359b3d4fe",
  "validatorSha256": "4a540ac49d4e5b4c9ee6e49d201b9bd935cadaf629b0df63e1837e7dafd83c96",
  "yamlVersion": "2.9.0",
  "validatorVersion": "jsonschema-4.23.0-draft7-no-format-assertions",
  "adoption": {
    "commit": "57982094ad68087ed43382a1a9dea4c08a413a63",
    "adoptedAt": "2026-03-17T16:43:26Z",
    "baselineCommit": "fb7d3e808e18be2903b6c089f9997cdc11bb7399",
    "baselineAt": "2026-03-17T15:34:56Z"
  },
  "schemaInterpreterSha256": "30d86662ae751b89d39976046a4ff387ed9ff732816fe1158d16e03a89c9ff4e"
});
