import { smokeModule } from "../../../../scripts/native-smoke-value.mjs";

export const { definition, collectBatch, scoreMetric } = smokeModule({
  "repository": "github/gh-aw",
  "repositoryId": 1036865607,
  "workflowId": "smoke-claude-copilot",
  "sourceRevision": "c86377ec47b38f0b5af463277ee55d1d03d08da8",
  "until": "2026-10-18T15:00:12Z",
  "sourceGitBlob": "4c33b4325cbf964f167739f378dabc8987bd59b2",
  "interpreterSha256": "953041410fe74c334c4b78301a6204f7687c6420f213f7c1918474b5c41aeb2a",
  "adoption": {
    "commit": "ace080ce67e4f4f6c51bebb40387c25553291c4a",
    "adoptedAt": "2026-10-06T22:56:26Z",
    "baselineCommit": "382f4b025fefaa7d6b2492c3608f098340bf6536",
    "baselineAt": "2026-10-06T22:21:33Z"
  },
  "name": "Smoke Claude Copilot",
  "goal": "Detect Copilot Anthropic Messages inference, streaming tool-use and follow-up inference incompatibilities without model fallback.",
  "acceptance": "The protected host validates an unpredictable MCP receipt and an exactly matching single noop after tool-result inference, with successful execution and disabled fallback in the trusted environment.",
  "limitations": [
    "No successful run/agent conclusion or self-reported receipt is a substitute for the protected assertion gate."
  ],
  "protectedSteps": [
    {
      "name": "Assert Claude Copilot inference evidence",
      "sha256": "a78ae2e54d720d1bb0ba7a08d8193cce30ff5d9e99f0c05bfff60e3b830384b2"
    }
  ],
  "protectedImports": [
    {
      "path": ".github/workflows/smoke-claude-copilot.md",
      "acceptedGitBlobs": [
        "4c33b4325cbf964f167739f378dabc8987bd59b2"
      ]
    }
  ]
});
