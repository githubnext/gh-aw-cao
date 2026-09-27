---
title: Authentication
description: Choose and configure the least-privilege GitHub credential for your CAO scope.
---

Authentication controls what CAO *can reach*. The checked-in `.github/workflows/cao.json` policy controls what CAO *may operate on*. A credential never expands policy.

## Control Repository Visibility

Public and private control repositories are supported. Their contents inherit that visibility, including policy, workflow runs, operational metadata, dashboard data, and review outputs.

Use a private control repository whenever the target or required evidence is private or internal. Use a public control repository only when all review material may be public.

## Do You Need Another Credential?

| Your run | Use |
| --- | --- |
| Public target, `review` mode, output in the control repository | Built-in `GITHUB_TOKEN` |
| Private targets in one organization | Organization-owned private GitHub Apps |
| Targets across organizations in one enterprise | Enterprise-owned private GitHub Apps |
| Apps are unavailable and one-owner scope is API-compatible | Fine-grained PAT |

App or PAT is not required for a bounded `review` run when every target repository is public and outputs remain in the current control repository.

:::tip[Prefer GitHub Apps]
Apps use short-lived, installation-scoped tokens and do not depend on one person's continued access. CAO separates a read-only App from a write-capable App.
:::

## Configure Your Profile

Run these commands from the control repository.

### Public review

```bash
./cao.sh setup-auth workflow-token
```

For this profile, use `review` mode and keep safe outputs in the current control repository. Public visibility does not grant access to another repository's Actions logs, security data, issues, pull requests, or write APIs. If required evidence is unavailable, the worker must report incomplete and produce no speculative result.

Always configure an App or PAT for private or internal targets, an alternate review repository, or any `live` cross-repository write.

### Automated App setup

Use this path when the control repository and every target belong to one organization.

Before setup, add every private target and alternate review repository to the exact allowlist in `.github/workflows/cao.json`:

```json
{
  "control-plane": {
    "scope": {
      "allowed-owners": ["acme"],
      "allowed-repositories": ["acme/example-service"]
    }
  }
}
```

The helper reads `allowed-repositories`; it does not expand `allowed-owners` into a repository list. It adds the control repository automatically.

Preview the two private App manifests and exact repository selections:

```bash
./cao.sh setup-auth github-app \
  --repo acme/central-agentic-ops \
  --dry-run
```

Then create and configure the Apps:

```bash
./cao.sh setup-auth github-app \
  --repo acme/central-agentic-ops
```

Choose **Only select repositories** and select only those printed by the command. CAO stores client IDs as repository variables and sends private keys directly to Actions secrets.

Automated setup uses the same selected-repository installation scope for both Apps while keeping their permissions separate. When the write App must cover fewer repositories than the read App, create and install the Apps manually: install the read App on every evidence source and the write App only on approved output destinations. Then configure the credentials:

```bash
gh variable set GH_AW_GITHUB_READ_APP_ID \
  --repo acme/central-agentic-ops \
  --body '<read-app-client-id>'
gh secret set GH_AW_GITHUB_READ_APP_PRIVATE_KEY \
  --repo acme/central-agentic-ops \
  < read-app-private-key.pem

gh variable set GH_AW_GITHUB_WRITE_APP_ID \
  --repo acme/central-agentic-ops \
  --body '<write-app-client-id>'
gh secret set GH_AW_GITHUB_WRITE_APP_PRIVATE_KEY \
  --repo acme/central-agentic-ops \
  < write-app-private-key.pem
```

The installed helper can also run directly:

```bash
node .github/workflows/shared/setup-github-apps.mjs --repo acme/central-agentic-ops
```

### Multiple organizations in one enterprise

[GitHub App manifests cannot create enterprise-owned Apps](https://docs.github.com/en/enterprise-cloud@latest/apps/sharing-github-apps/registering-a-github-app-from-a-manifest). Create read and write Apps in enterprise settings, install both on selected repositories in every enrolled organization, then run:

```bash
./cao.sh setup-auth enterprise-app \
  --repo acme/central-agentic-ops \
  --read-client-id '<read-app-client-id>' \
  --write-client-id '<write-app-client-id>' \
  --dry-run

./cao.sh setup-auth enterprise-app \
  --repo acme/central-agentic-ops \
  --read-client-id '<read-app-client-id>' \
  --write-client-id '<write-app-client-id>'
```

The command prompts for each private key. Never put a private key in a command argument. Enterprise ownership alone does not grant repository access; each organization installation is still required.

### Fine-grained PAT fallback

A PAT is not a substitute for repository or organization access. Use one only when:

- the user already has access to every selected repository;
- every repository has one resource owner. A fine-grained PAT cannot access multiple organizations at once;
- organization policy permits the token and any required approval is complete;
- every campaign API supports it, including the Checks API when the campaign requires checks;
- repository selection, permissions, expiration, and rotation owner are explicit.

Explain that the PAT is user-bound, longer-lived than an App token, API-limited, and manually rotated. Obtain explicit confirmation to proceed. Inability to install an App, or the presence of an existing PAT secret, is not consent.

```bash
./cao.sh setup-auth token \
  --repo acme/central-agentic-ops \
  --acknowledge-token-risks
```

Enter the token only at the `gh secret set` prompt. Never use a classic PAT.

## Validate Before Activation

Run one campaign with:

```text
max_repos=1
rollout_percent=100
safe_output_mode=review
```

Verify that:

- the credential covers enrolled repositories and no unrelated repositories;
- the read App has no write permissions;
- the write App is installed only where approved outputs need it;
- repository discovery and evidence reads succeed;
- output reaches the intended private review repository;
- the target repository does not change.

Repeat this check whenever scope, campaign APIs, output mode, or review destination changes.

## Model Inference Is Separate

CAO installation does not require Copilot organization billing. Bundled workflows do: they use `copilot-requests: write` and the built-in workflow token for inference.

For this reason, verifying it up front is completely optional: most user tokens cannot read organization billing. Without an entitlement, a bundled workflow fails with HTTP 403 before the agent starts.

Customers may author workflows with another gh-aw-supported engine/provider and configure its Actions secrets. That requires an explicit workflow change and compilation. CAO does not support `COPILOT_GITHUB_TOKEN` inference fallback, and target-access credentials cannot authenticate model inference.

## Credential Reference

CAO resolves available target-access credentials in this order:

| Priority | Credential | Configuration |
| --- | --- | --- |
| 1 | Read App | `GH_AW_GITHUB_READ_APP_ID` and `GH_AW_GITHUB_READ_APP_PRIVATE_KEY` |
| 1 | Write App | `GH_AW_GITHUB_WRITE_APP_ID` and `GH_AW_GITHUB_WRITE_APP_PRIVATE_KEY` |
| 2 | Fine-grained PAT | `GH_AW_GITHUB_TOKEN` |
| 3 | Workflow token | `GITHUB_TOKEN` |

This is runtime availability precedence, not permission to choose a PAT silently. Setup must validate the intended profile rather than relying on fallback.

Tokens are resolved inside each run. They never belong in policy, dispatch inputs, prompts, logs, safe outputs, or review bundles.

### API capacity

Before discovery, shared control checks the selected credential's REST API capacity and stops if it cannot preserve the required reserve.

Reduce requests with [conditional requests](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests): persist the response `ETag` and send it as `If-None-Match`. Use [GraphQL](https://docs.github.com/en/graphql/guides/using-graphql-with-github-actions) when one bounded query can replace many REST calls. Do not poll while rate-limited.

### Rotation and incidents

For Apps, add replacement keys, validate review runs, revoke old keys, and recheck installations. For a PAT, replace `GH_AW_GITHUB_TOKEN`, validate, then revoke the previous token.

:::danger[Suspected exposure]
Cancel active runs and revoke the credential first. Disabling a campaign does not revoke its App installation or PAT. Inspect logs and outputs, rotate credentials, and resume only in `review` mode.
:::
