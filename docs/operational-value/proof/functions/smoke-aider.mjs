import { smokeModule } from "../../../../scripts/native-smoke-value.mjs";

export const { definition, collectBatch, scoreMetric } = smokeModule({
  "repository": "github/gh-aw",
  "repositoryId": 1036865607,
  "workflowId": "smoke-aider",
  "sourceRevision": "c86377ec47b38f0b5af463277ee55d1d03d08da8",
  "until": "2026-10-18T15:00:12Z",
  "sourceGitBlob": "3cab6f5c44dd031b3d0714404dc8816da83eb511",
  "interpreterSha256": "953041410fe74c334c4b78301a6204f7687c6420f213f7c1918474b5c41aeb2a",
  "adoption": {
    "commit": "0699202c88dcede28e9e9dc6359a2de2d130a0ef",
    "adoptedAt": "2026-08-04T17:02:13Z",
    "baselineCommit": "e9c80175689a1cb2050626c4b415d19094c67d77",
    "baselineAt": "2026-08-04T16:55:23Z"
  },
  "name": "Smoke Aider",
  "goal": "Verify Aider prompt delivery, SEARCH/REPLACE file editing, shell/repository access and safe-output publication.",
  "acceptance": "The host checker independently verifies exact expected file content and a successful native shell tool event whose command matches git-log syntax and whose output contains a commit-shaped line. Full acceptance additionally requires independently proven SEARCH/REPLACE editing, readback and correct event-specific safe-output publication, not an agent PASS claim.",
  "limitations": [
    "Two independently checked facets are partial: file content does not establish editing method; the host's git-log command/output regex does not prove the required cat readback, all repository-access semantics or safe-output publication.",
    "Pre-checker historical runs and self-reported output issues cannot prove these native assertions."
  ],
  "protectedSteps": [
    {
      "name": "Verify Aider smoke test evidence",
      "sha256": "e0cc064e2d9b9c24b7110589c603d231fdfb86ad18d1ad976850c2023314d0c0"
    }
  ],
  "protectedImports": [
    {
      "path": ".github/workflows/shared/aider.md",
      "acceptedGitBlobs": [
        "285072bfa3dae9c592e78381b863bb76429830b6",
        "fd3fdae355ea5171a5b5985bba28996bf70ef64e",
        "67393d932cc9e005eed15a3a455f5183815628ef",
        "82dbb7a2e5c0eb0b0136602693644f38c5efc38c",
        "fa2e1f224e8d189c91ed5226c85c26af708a7007"
      ]
    }
  ]
});
