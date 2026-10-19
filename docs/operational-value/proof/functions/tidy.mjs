import { nativeGoSourceModule } from "../../../../scripts/native-go-source-value.mjs";

export const { definition, collectBatch, scoreMetric } = nativeGoSourceModule({
  "workflowId": "tidy",
  "workflowName": "Tidy",
  "facet": "exact-gofmt",
  "graphDirectory": "tidy-lifetime",
  "goal": "Keep code formatted and clean through conservative formatting and lint repairs.",
  "acceptance": "Partial facet: existing non-generated Go files become the exact canonical gofmt output without other source edits. Count signed repairs and exact reversals; JavaScript formatting, other lint rules, behavior and full tests remain separate.",
  "repository": "github/gh-aw",
  "sourceRevision": "c86377ec47b38f0b5af463277ee55d1d03d08da8",
  "sourceGitBlob": "85c3709f5fd9bc94f4859c7e855c04c1e3b7ccc4",
  "until": "2026-10-18T15:00:12Z",
  "adoption": {
    "commit": "bfbe18e6d2c20ee200c980655a041bad6cef28dc",
    "adoptedAt": "2025-09-26T11:14:38Z",
    "baselineCommit": "a8d355a6f241ef8de1e2ce98f691b1d823427270",
    "baselineAt": "2025-09-26T11:11:23Z"
  },
  "nativeModelSha256": "36fc5d086447d5c6c33cdf0793505a0d4f35fb5c87088221b79acdb72f811d46",
  "goModelSha256": "69e0dcb71fb9c72a630278c3a5f3fc620b8e7d880fc9f0e628e30c3b5d91721e",
  "oracleSha256": "753dd2574b4389eaee0a0bb63fb74f7c7357696cc6d8e7c7a6f52e833ba1cf2c",
  "collectorSha256": "58c7bd5af5acc31a8fcb1a1291e398e8ae99231e65b9e097769d4bd2bf56aa4c"
});
