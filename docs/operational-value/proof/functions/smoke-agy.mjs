import { smokeModule } from "../../../../scripts/native-smoke-value.mjs";

export const { definition, collectBatch, scoreMetric } = smokeModule({
  "repository": "github/gh-aw",
  "repositoryId": 1036865607,
  "workflowId": "smoke-agy",
  "sourceRevision": "c86377ec47b38f0b5af463277ee55d1d03d08da8",
  "until": "2026-10-18T15:00:12Z",
  "sourceGitBlob": "99ab5af52c59187d131b662a17e7f18342d5d314",
  "interpreterSha256": "953041410fe74c334c4b78301a6204f7687c6420f213f7c1918474b5c41aeb2a",
  "adoption": {
    "commit": "8f294395da7ab9b3f299bb65e02da62c6aa0c8a2",
    "adoptedAt": "2026-10-08T16:49:03Z",
    "baselineCommit": "d3116e26ca8a320a3bdce2650b4689fca6c4e83e",
    "baselineAt": "2026-10-08T16:34:34Z"
  },
  "name": "Smoke Agy (Experimental)",
  "goal": "Verify experimental Agy authentication, inference, AWF, native MCP and staged safe outputs.",
  "acceptance": "Six shared behavioral cases plus native challenge transport, native infrastructure MCP, native safeoutputs and inference accounting are independently asserted. Full acceptance requires both complete host gates with their fixture/execution safeguards.",
  "limitations": [
    "Repeated monitoring proofs, not new repository fixes. Failed native conjunctions cannot identify failing constituent assertions."
  ],
  "protectedSteps": [
    {
      "name": "Prepare engine conformance fixtures",
      "sha256": "ce65837943982b10b2b8b9afa0c37b8e304004286990f453c1a41aea2ee4cf47"
    },
    {
      "name": "Assert engine conformance",
      "sha256": "3bdd3167e4cf7ab1a59c28be5f80919d1cb6af3cb27d261f61e465dcd0287f7a"
    },
    {
      "name": "Assert native Agy MCP transport and inference accounting",
      "sha256": "d518ea60c4e6670c748d3241e526c2db62c00168e29ad4e697bdb248d28ac93d"
    }
  ],
  "protectedImports": [
    {
      "path": ".github/workflows/shared/agy-conformance.md",
      "acceptedGitBlobs": [
        "3172d2e613e4f9a27880fc05f26fad64a089d227"
      ]
    },
    {
      "path": ".github/workflows/shared/engine-conformance.md",
      "acceptedGitBlobs": [
        "1b304b512a227fdc46929d4d3c1d0bac23b5e812"
      ]
    }
  ]
});
