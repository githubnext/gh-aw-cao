import { nativeSchemaCoverageModule } from "../../../../scripts/native-schema-coverage-value.mjs";

export const { definition, collectBatch, scoreMetric } = nativeSchemaCoverageModule({
  "workflowId": "schema-feature-coverage",
  "repository": "github/gh-aw",
  "sourceRevision": "c86377ec47b38f0b5af463277ee55d1d03d08da8",
  "sourceGitBlob": "821efff82151dd15b99f895e82a56cab4b65f2c1",
  "until": "2026-10-18T15:00:12Z",
  "nativeModelSha256": "30d86662ae751b89d39976046a4ff387ed9ff732816fe1158d16e03a89c9ff4e",
  "validatorSha256": "4a540ac49d4e5b4c9ee6e49d201b9bd935cadaf629b0df63e1837e7dafd83c96",
  "yamlVersion": "2.9.0",
  "validatorVersion": "jsonschema-4.23.0-draft7-no-format-assertions",
  "adoption": {
    "commit": "759d1461747a3fa7e7f2a5b6c86ae96ee2f84667",
    "adoptedAt": "2026-03-19T21:40:26Z",
    "baselineCommit": "550245d3a5126f8e8f4a0553ff57db0a4131b8dd",
    "baselineAt": "2026-03-19T21:36:55Z"
  }
});
