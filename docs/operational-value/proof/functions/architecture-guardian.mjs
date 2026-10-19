import { nativeGoSourceModule } from "../../../../scripts/native-go-source-value.mjs";

export const { definition, collectBatch, scoreMetric } = nativeGoSourceModule({
  "workflowId": "architecture-guardian",
  "workflowName": "Architecture Guardian",
  "facet": "go-file-blocker",
  "graphDirectory": "architecture-guardian",
  "goal": "Detect structural violations before they accumulate and enable corrective repository improvements.",
  "acceptance": "Partial facet: reduce the non-generated, non-test Go file population above the frozen default 1000-newline blocker boundary. New blockers and reversals offset reductions; syntax, behavior, JavaScript, functions, exports, import cycles and other configured thresholds remain separate.",
  "repository": "github/gh-aw",
  "sourceRevision": "c86377ec47b38f0b5af463277ee55d1d03d08da8",
  "sourceGitBlob": "900be8b47e5672378c238a265ccaa4b231c664fc",
  "until": "2026-10-18T15:00:12Z",
  "adoption": {
    "commit": "559b2b35135e58298a50c265fbd1cba60a019cd7",
    "adoptedAt": "2026-04-08T17:05:30Z",
    "baselineCommit": "78968004568b2f0fdbf08f088a7dcb1a87d6ee9a",
    "baselineAt": "2026-04-08T17:04:36Z"
  },
  "nativeModelSha256": "36fc5d086447d5c6c33cdf0793505a0d4f35fb5c87088221b79acdb72f811d46",
  "goModelSha256": "69e0dcb71fb9c72a630278c3a5f3fc620b8e7d880fc9f0e628e30c3b5d91721e",
  "oracleSha256": "753dd2574b4389eaee0a0bb63fb74f7c7357696cc6d8e7c7a6f52e833ba1cf2c",
  "collectorSha256": "58c7bd5af5acc31a8fcb1a1291e398e8ae99231e65b9e097769d4bd2bf56aa4c"
});
