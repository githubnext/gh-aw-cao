import { nativeFunctionLengthModule } from "../../../../scripts/native-function-length-value.mjs";

export const { definition, collectBatch, scoreMetric } = nativeFunctionLengthModule({
  "repository": "github/gh-aw",
  "workflowId": "lint-monster",
  "sourcePath": ".github/workflows/lint-monster.md",
  "sourceRevision": "c86377ec47b38f0b5af463277ee55d1d03d08da8",
  "until": "2026-10-18T15:00:12Z",
  "directory": "docs/operational-value/proof/function-length",
  "threshold": 60,
  "sourceGitBlob": "d9e38633aac4cfc21bc7160d52a803cb22a176f8",
  "interpreterSha256": "26b93871038c6925b80133c5fda26dccaeceda2ad213130af13eb978a04045c0",
  "oracleSha256": "bb3f26ffae05ff602f2f8bf37e636c8fa2eae07006db81e0449fd1bdf8713882",
  "ruleSourcesSha256": "e5c0c8f804b4756ad4dffb52d818cb37a23c1b506af87e9f5274289df3ac7377",
  "toolchain": "go version go1.25.3 darwin/arm64",
  "scope": "All tracked regular non-test non-generated cmd/pkg Go sources across platforms; raw native body spans before suppression.",
  "limits": {
    "maxStates": 100,
    "maxFiles": 10000,
    "maxBlobs": 20000,
    "maxBytes": 268435456
  },
  "adoption": {
    "commit": "3829bb8bd594ce7e843f575ab99e89c8bd9e52ab",
    "adoptedAt": "2026-05-16T19:21:56Z",
    "baselineCommit": "d2edba037ff41842735da128e4ff185423f8b6a9",
    "baselineAt": "2026-05-16T19:03:35Z"
  }
});
