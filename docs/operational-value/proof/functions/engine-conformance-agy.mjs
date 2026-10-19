import { agyConformanceModule } from "../../../../scripts/native-agy-conformance.mjs";

export const { definition, collectBatch, scoreMetric } = agyConformanceModule({
  "repository": "github/gh-aw",
  "workflowId": "engine-conformance-agy",
  "engine": "agy",
  "sourceGitBlob": "5a4de4070a9dda04c4007b68272e610659d7884d",
  "sourceRevision": "c86377ec47b38f0b5af463277ee55d1d03d08da8",
  "until": "2026-10-18T15:00:12Z",
  "nativeModelSha256": "50ef1e13f2524444c409dfb8ee4d09250318d8e2b98597b15067ec63c4f525da",
  "agyModelSha256": "9dcda1fbc46c940e2c2cd5f3ae8a9298dc50bb2bb03ec94b8ad0e65c36a98dd7",
  "adoption": {
    "commit": "3e72578a67b636684a42cdb8438ed468f0c8a572",
    "adoptedAt": "2026-10-08T16:21:36Z",
    "baselineCommit": "697ea9ab42c78227a0bd17c854f50f2a215e43ba",
    "baselineAt": "2026-10-08T15:50:54Z"
  },
  "acceptedCheckerScripts": [
    "e2b3c9bcd15201a0c28a4ed11aacf096cb0285d8a2136b8294a563ac9b8fcddd",
    "95a5152fdd9fdf22e892d65cd9de8c34f565c608ee009045a03a2b258159a52a"
  ]
});
