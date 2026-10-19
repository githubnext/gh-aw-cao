import { engineConformanceModule } from "../../../../scripts/native-engine-conformance.mjs";

export const { definition, collectBatch, scoreMetric } = engineConformanceModule({
  "repository": "github/gh-aw",
  "workflowId": "engine-conformance-aider",
  "engine": "aider",
  "sourceGitBlob": "94750d4a65309829fb31d5b0fd2a3921601898e6",
  "sourceRevision": "c86377ec47b38f0b5af463277ee55d1d03d08da8",
  "until": "2026-10-18T15:00:12Z",
  "nativeModelSha256": "50ef1e13f2524444c409dfb8ee4d09250318d8e2b98597b15067ec63c4f525da",
  "adoption": {
    "commit": "a4cd539c00675ff60b56934e9dc66153cb88aab1",
    "adoptedAt": "2026-10-03T18:10:37Z",
    "baselineCommit": "1a62fa28ef5d2339aa1d62c7dbf20e6767b8a8b6",
    "baselineAt": "2026-10-03T18:09:18Z"
  },
  "acceptedCheckerScripts": [
    "e2b3c9bcd15201a0c28a4ed11aacf096cb0285d8a2136b8294a563ac9b8fcddd",
    "95a5152fdd9fdf22e892d65cd9de8c34f565c608ee009045a03a2b258159a52a"
  ]
});
