import { versionCurrencyModule } from "../../../../scripts/native-version-currency-value.mjs";

export const { definition, collectBatch, scoreMetric } = versionCurrencyModule({
  "repository": "github/gh-aw",
  "repositoryId": 1036865607,
  "workflowId": "cli-version-checker",
  "sourceRevision": "c86377ec47b38f0b5af463277ee55d1d03d08da8",
  "until": "2026-10-18T15:00:12Z",
  "sourceGitBlob": "8a5e2684d62c101bca812c9b8624ccc75f97b703",
  "tools": [
    {
      "id": "claude",
      "constant": "DefaultClaudeCodeVersion",
      "registry": "npm",
      "name": "@anthropic-ai/claude-code",
      "cooldownDays": 0
    },
    {
      "id": "copilot",
      "constant": "DefaultCopilotVersion",
      "registry": "npm",
      "name": "@github/copilot",
      "cooldownDays": 0
    },
    {
      "id": "codex",
      "constant": "DefaultCodexVersion",
      "registry": "npm",
      "name": "@openai/codex",
      "cooldownDays": 0
    },
    {
      "id": "playwright",
      "constant": "DefaultPlaywrightCLIVersion",
      "registry": "npm",
      "name": "@playwright/cli",
      "cooldownDays": 3
    },
    {
      "id": "pi",
      "constant": "DefaultPiVersion",
      "registry": "npm",
      "name": "@earendil-works/pi-coding-agent",
      "cooldownDays": 0
    },
    {
      "id": "github-mcp",
      "constant": "DefaultGitHubMCPServerVersion",
      "registry": "github",
      "name": "github/github-mcp-server",
      "cooldownDays": 0
    },
    {
      "id": "mcpg",
      "constant": "DefaultMCPGatewayVersion",
      "registry": "github",
      "name": "github/gh-aw-mcpg",
      "cooldownDays": 0
    },
    {
      "id": "threat-detect",
      "constant": "DefaultThreatDetectVersion",
      "registry": "github",
      "name": "github/gh-aw-threat-detection",
      "cooldownDays": 0
    }
  ],
  "interpreterSha256": "e7c63e2c28b91af627fb026ee091b0828c3dfab2bebfb12f6ffd8041fbffadd6",
  "parserSha256": "ef5166ca2e49800e1d0696f7dbcd60af448a38c9dd1f88497d39acaab12c8930",
  "adoption": {
    "commit": "929c8bfe907beb042dd815658f8ddd96ecffc0a5",
    "adoptedAt": "2025-10-07T16:39:41Z",
    "baselineCommit": "6fb011d32532a463bf51eef8c65b4fa27f1aec0e",
    "baselineAt": "2025-10-07T16:33:24Z"
  }
});
