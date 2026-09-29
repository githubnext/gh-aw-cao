---
title: Authentication
description: Choose and configure the least-privilege GitHub credential for your CAO scope.
---

Authentication controls what CAO *can reach*. The checked-in `.github/workflows/cao.json` policy controls what CAO *may operate on*. A credential never expands policy.

## Control Repository Visibility

Public and private control repositories are supported. Their contents inherit that visibility, including policy, workflow runs, operational metadata, dashboard data, and review outputs.

Use a private control repository whenever the target or required evidence is private or internal. Use a public control repository only when all review material may be public.

## Choose Cross-Repository Authentication

| Your run | Use |
| --- | --- |
| Private targets in one organization | Organization-owned private GitHub Apps |
| Targets across organizations in one enterprise | Enterprise-owned private GitHub Apps |
| Apps are unavailable and the required APIs are PAT-compatible | One fine-grained PAT pair per resource owner |

Interactive setup always configures an App or PAT profile that can authenticate to every selected repository. The repository-provided `GITHUB_TOKEN` remains a bounded runtime fallback for control-repository operations; it is not a cross-repository authentication profile.

:::tip[Prefer GitHub Apps]
Apps use short-lived, installation-scoped tokens and do not depend on one person's continued access. CAO separates a read-only App from a write-capable App.
:::

## Configure Your Profile

Run these commands from the control repository.

### Policy

Target-repository authentication is defined once in `.github/workflows/shared/control.md` and inherited by Orchestrator and worker workflows. Before GitHub MCP or CLI proxy startup, shared control resolves the exact read scope, mints a repository-scoped App token with only the importing workflow's declared read permissions or selects the exact owner-scoped PAT, and binds the GitHub tools to that credential. Checkout authentication alone is not evidence that the agent's GitHub tools use the same token. A separate write-capable App serves safe outputs. Safe-output tokens are narrowed to the selected handler's permissions. Copilot inference permission remains explicit in every Copilot-backed workflow. Workflow-local GitHub App blocks should not be added unless a future Agentic Workflow has a documented isolation requirement that shared control cannot satisfy.

The supported control-plane credentials are:

| Priority | Credential | Configuration |
| --- | --- | --- |
| 1 | Read-only GitHub App | Repository variable `GH_AW_GITHUB_READ_APP_ID` and repository secret `GH_AW_GITHUB_READ_APP_PRIVATE_KEY` |
| 1 | Write-capable GitHub App | Repository variable `GH_AW_GITHUB_WRITE_APP_ID` and repository secret `GH_AW_GITHUB_WRITE_APP_PRIVATE_KEY` |
| 2 | Owner-scoped read-only fine-grained PAT | Repository secret `GH_AW_GITHUB_READ_PAT_<OWNER>` selected through `GH_AW_GITHUB_READ_PAT_REPOSITORIES` |
| 2 | Owner-scoped write-capable fine-grained PAT | Repository secret `GH_AW_GITHUB_WRITE_PAT_<OWNER>` selected through `GH_AW_GITHUB_WRITE_PAT_REPOSITORIES` |
| 3 | Legacy fine-grained PAT fallback | Repository secret `GH_AW_GITHUB_TOKEN` |
| 4 | Runtime fallback | Repository-provided `GITHUB_TOKEN` for control-repository operations it can authorize |

`GH_AW_GITHUB_AUTH_MODE` explicitly selects `app` or `pat`; setup writes it only
after the selected profile is complete. In `pat` mode, read operations and safe
outputs select the owner-scoped secret mapped to their exact repository and do
not fall through to App credentials, legacy PAT secrets, or `GITHUB_TOKEN`.
Missing map entries and missing mapped secrets fail closed. In `app` mode,
missing App IDs, private keys, installations, or repository grants likewise
fail closed instead of borrowing PAT credentials.

The committed root `aw.yml` intentionally has no `config` block so normal installation remains compatible with non-interactive `gh aw add`. See [Control Plane Authentication Profiles](control-plane-authentication.md) for private organization Apps, private enterprise Apps, and the fine-grained token fallback; follow Automated App setup below to configure both credential pairs.

### Repository-provided token fallback

The repository-provided `GITHUB_TOKEN` is not offered by setup as an authentication profile. It remains available for bounded control-repository operations and compatibility when no explicit mode has been configured. Public visibility alone does not make it a reliable credential for another repository's Actions logs, security data, issues, pull requests, or write APIs.

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

The CLI reads `control-plane.scope.allowed-repositories` from `.github/workflows/cao.json`, groups the control repository and exact allowed repositories by owner, and verifies a selected-repository installation for each account. The manifest helper creates private organization-owned Apps only, so every selected repository must belong to the control repository organization. For multiple organizations in one enterprise, manually create enterprise-owned private Apps because GitHub App manifests do not support enterprise-owned App creation. Install them separately on each enrolled organization, then run `./cao.sh setup-auth enterprise-app` to store their client IDs and interactively enter their private keys. Installation IDs and tokens are not stored in policy or dispatch inputs. gh-aw selects the correct installation from the target owner and repository at runtime.

On a GitHub Enterprise Cloud data-residency hostname, export `GH_HOST` before
running setup. The helper uses that host for repository API calls and all App
registration, installation, and settings URLs. It omits the Campaigns
permission from data-residency App manifests because that permission is not
available on those hosts.

Enterprise ownership does not grant repository access or widen CAO policy. The App still has no access until each organization approves a selected-repository installation, and shared control still enforces the exact checked-in allowlist. Confirm the read App has no write permission and install the write App only where approved safe outputs may write. Public Apps are unsupported; replace an earlier public App with private organization- or enterprise-owned Apps after reviewing credential rotation.

When read-only workflow steps need `GH_TOKEN`, the selected authentication mode
determines the profile. App mode uses the imported read App token. PAT mode maps
the exact target repository to its owner-scoped read secret. Safe-output
processing independently maps the exact destination repository to its
owner-scoped write secret. The legacy split or combined PAT names are consulted
only when no explicit authentication mode is configured. Missing, incomplete,
or invalid credentials must not be copied into dispatch inputs or persisted in
artifacts.

CAO Activity applies the same separation independently from agentic workflow
authentication. It creates one collection job per resource owner. App mode
mints a fresh installation token for that owner and its exact repository
selection, which supports both organization-owned Apps and enterprise-owned
Apps installed in each enrolled organization. PAT mode requires a non-empty
exact `allowed-repositories` scope, validates every
`GH_AW_GITHUB_READ_PAT_REPOSITORIES` entry against the expected
`GH_AW_GITHUB_READ_PAT_<OWNER>` name, and exposes only that owner's token to its
collection job. Logs, inventory, issue status, and operational-value evidence
are collected in owner-scoped fragments and merged before the unchanged
snapshot and cache publication stages. `GITHUB_TOKEN` is used only for trusted
control-repository checkout and notification operations.

## API Capacity Admission

Before activation, shared control checks the primary REST API capacity of the exact credential selected for control precompute. The check uses GitHub's `GET /rate_limit` endpoint, which [does not consume primary rate-limit capacity](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#checking-the-status-of-your-rate-limit). Admission reserves at least 100 core requests and raises that requirement for broader configured inventory scans.

When capacity is insufficient, the run stops before repository discovery. The admission summary reports remaining and required requests, the UTC reset timestamp, and the approximate minutes and hours until reset. The dashboard exposes the latest failure as a GitHub API capacity admission gate rather than an undifferentiated workflow failure.

### Fetch GitHub data efficiently

Integrations that repeatedly read GitHub data should minimize both request volume and response size:

- Use [conditional requests](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests) for data that may be unchanged. Persist the last response's `ETag` and send it as `If-None-Match` on the next request; GitHub returns `304 Not Modified` without consuming the primary rate-limit quota when the representation is unchanged.
- Use [GraphQL](https://docs.github.com/en/graphql/guides/using-graphql-with-github-actions) when a workflow needs related data from many repositories or resources. A single query can select only the fields needed and batch relationships that would otherwise require many REST requests.
- Keep discovery bounded and reuse data already fetched in the current run. Do not poll while waiting for rate-limit replenishment; stop and report incomplete work instead.

For direct HTTP clients, send the conditional-request headers explicitly. The CAO control precompute helper uses `gh api --cache 60s` for its bounded read requests; this lets the GitHub CLI reuse cached responses and negotiate conditional requests. For GitHub MCP calls, prefer one bounded query over repeated lookups. Conditional requests and GraphQL reduce avoidable traffic but do not replace the admission capacity check or the fail-closed limits described below.

Follow this order:

1. Do not rerun before the reported reset time. GitHub directs integrations with zero remaining capacity to wait until `x-ratelimit-reset`; repeated requests while limited can result in integration blocking. See [rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#exceeding-the-rate-limit) and [REST API best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#handle-rate-limit-errors-appropriately).
2. For long-lived cross-repository automation, configure the least-privilege GitHub App profile. Follow [GitHub's guide to authenticated App requests in Actions](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/making-authenticated-api-requests-with-a-github-app-in-a-github-actions-workflow). Shared control requests only `Actions: read` and `Contents: read` for pre-activation and still applies the checked-in CAO scope.
3. If an App cannot be installed and the exact scope is PAT-compatible, use separate owner-scoped read-only and write-capable fine-grained PATs only after informed consent. Follow [GitHub's fine-grained PAT guidance](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token), restrict each token to its required repositories and permissions, set expirations, and let `cao setup-auth token` store the protected Actions secrets and non-secret repository maps.

## Fine-Grained PAT Fallback

A PAT is not a substitute for repository or organization access. It can only exercise access already held by the user who created it, and it becomes unusable when that user loses the underlying access. Lack of organization-owner permission to install an App does not by itself make a PAT viable.

Before offering a PAT fallback, verify all of these conditions:

1. The user can select the target organization as the PAT resource owner and already has the required access to every enrolled repository.
2. Organization and enterprise policy permits fine-grained PATs, and any required organization approval can be obtained before the first run.
3. Each token covers repositories from exactly one resource owner. A multi-owner control plane requires a separate read token and, when writes are approved, a separate write token for every represented owner.
4. Every API required by the installed campaign supports fine-grained PATs. Fine-grained PATs do not currently support every endpoint, including the Checks API; do not replace a required App with a classic PAT to work around an endpoint gap.
5. The PAT can be limited to the exact enrolled repositories, campaign-required permissions, and an explicit expiration and rotation owner.

If any condition fails, stop and recommend obtaining a GitHub App installation, narrowing or splitting the scope, or involving an organization owner. Do not present a PAT as an access bypass.

Before selecting, configuring, validating, or using a PAT, explain that it is user-bound, longer-lived than an App installation token, limited to one resource owner, subject to organization policy and endpoint gaps, and dependent on manual rotation and revocation. Obtain explicit confirmation to proceed. Inability to use an App, or the presence of an existing PAT secret, is not consent.

## Public Read-Only Profile

An App or PAT is not required for a bounded `review` run when every target repository is public and outputs remain in the current control repository. GitHub Actions automatically provides `GITHUB_TOKEN`; the workflows use it for control-repository workflow discovery, public checkout, and review outputs authorized in the control repository. This is built-in-token operation, not anonymous or credential-free operation.

:::caution[Public does not mean fully readable]
The built-in token may check out public code, but it does not automatically gain access to another repository's Actions logs, security data, issues, pull requests, or write APIs.
:::

Keep this profile within these boundaries:

- use `review` mode and keep safe outputs in the current control repository;
- keep target owners allowlisted and all repository and dispatch caps in force;
- treat unavailable cross-repository API data, including Actions logs or security data, as incomplete rather than weakening the requested analysis;
- configure an App or PAT for private or internal targets, an alternate review repository, or any `live` cross-repository write.

The workflow token is scoped to the repository containing the workflow. Public checkout does not grant target-repository write access, and a public repository's visibility does not expand the token's Actions, security, issue, or pull-request permissions. If a worker cannot read required target evidence with the available token, it must report incomplete and produce no speculative result.

## Credential Boundary

- Each App client ID lives in its control-repository Actions variable, and each private key or PAT lives in its corresponding Actions secret.
- worker workflows receive repository names and routing policy, never credentials.
- Each Orchestrator and worker workflow run resolves its own token through imported shared control.
- Tokens must not appear in prompts, logs, safe outputs, Repo Memory, review bundles, or correlation metadata.
- For campaigns outside the public read-only profile, the App installation or PAT repository selection must cover every repository the enabled campaigns may read or update.

## Permissions

Grant only permissions required by installed campaigns. The current full catalog separates these App-level ceilings; each minted token is narrower when its job or safe-output handler needs fewer permissions:

| Permission | Read App | Write App | Reason |
| --- | --- | --- | --- |
| Actions | Read | Write | Inspect runs and dispatch approved workers |
| Administration | None | Read | Validate repository settings needed by approved maintenance outputs |
| Checks | Read | None | Inspect checks |
| Contents | Read | Write | Read repositories and create approved changes |
| Issues | Read | Write | Inspect issues and emit issue or comment safe outputs |
| Campaigns | Read | None | Inspect campaign evidence |
| Pull requests | Read | Write | Inspect pull requests and emit approved pull-request outputs |
| Secret scanning alerts | Read | None | Inspect code-security evidence |
| Security events | Read | None | Inspect code-security evidence |
| Commit statuses | Read | None | Inspect status evidence |
| Vulnerability alerts | Read | None | Prioritize dependency security work |
| Metadata | Read | Read | Required automatically for GitHub Apps |

A campaign-only installation should narrow these permissions to that campaign's workflows. Fine-grained PATs should be limited to the same repositories and permissions.

Preview the owner-scoped PAT configuration:

```bash
./cao.sh setup-auth token \
  --repo acme/central-agentic-ops \
  --write-repository acme/approved-output-repository \
  --dry-run
```

Then configure the profile:

```bash
./cao.sh setup-auth token \
  --repo acme/central-agentic-ops \
  --write-repository acme/approved-output-repository
```

The command prompts for every owner/role token without echoing it, stores
owner-scoped secrets, writes repository-to-secret-name variables, and sets
`GH_AW_GITHUB_AUTH_MODE=pat` last. Do not include a token directly in the
command. `GH_AW_GITHUB_READ_PAT`, `GH_AW_GITHUB_WRITE_PAT`, and
`GH_AW_GITHUB_TOKEN` remain deprecated compatibility fallbacks for existing
installations whose authentication mode is unset.

If setup is interrupted after storing one or more tokens, rerun the same
command. The helper verifies existing repository secret names and asks whether
to keep each one without reading its value. It prompts for missing or replaced
owner/role tokens, then writes the complete maps and selects PAT mode. Use
`--keep-existing` for an unattended resume or `--replace-existing` when
intentionally rotating every configured token.

### Migrate from the legacy PAT

Do not copy one broad legacy token into both new secrets. Create independent tokens with separate permission and repository ceilings:

1. Run the setup preview and verify one read token per resource owner covers only the exact repositories CAO must inspect.
2. Verify each write token covers only approved safe-output repositories. When review outputs stay in the control repository, the control repository normally is the only write destination.
3. Run a bounded review that proves the read PAT can read all intended repositories and cannot perform a reversible write probe.
4. Prove separately that the write PAT can perform and clean up the same probe only in an approved output repository.
5. Confirm `GH_AW_GITHUB_AUTH_MODE=pat`, delete `GH_AW_GITHUB_TOKEN` and any legacy split-PAT secrets, then repeat the bounded review to prove neither path depended on a compatibility fallback.

Use a disposable tag, branch, or equivalent repository-standard probe and always clean it up. Do not perform a write probe against an unapproved production repository.

### Fine-grained PAT fallback

A PAT is not a substitute for repository or organization access. Use one only when:

- the user already has access to every selected repository;
- every token has one resource owner, with separate owner-scoped token pairs for a multi-owner allowlist;
- organization policy permits the token and any required approval is complete;
- every campaign API supports it, including the Checks API when the campaign requires checks;
- repository selection, permissions, expiration, and rotation owner are explicit.

Explain that the PAT is user-bound, longer-lived than an App token, API-limited, and manually rotated. Obtain explicit confirmation to proceed. Inability to install an App, or the presence of an existing PAT secret, is not consent.

```bash
./cao.sh setup-auth token \
  --repo acme/central-agentic-ops
```

For PATs:

1. Create replacement read and write fine-grained PATs with the same or narrower repository access for each affected owner.
2. Replace the corresponding `GH_AW_GITHUB_READ_PAT_<OWNER>` and `GH_AW_GITHUB_WRITE_PAT_<OWNER>` secrets.
3. Validate read access and safe-output writes independently.
4. Revoke the previous PATs.

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

For this reason, verifying it up front is completely optional: most user tokens cannot read organization billing, and a granted `copilot-requests: write` permission alone does not ensure model access. Without an entitlement, a bundled workflow fails with HTTP 403 before the agent starts. Customers may author workflows with another gh-aw-supported engine/provider and configure its Actions secrets; that requires an explicit workflow change and compilation. CAO does not support `COPILOT_GITHUB_TOKEN` inference fallback, runtime token precedence, or mixed authentication profiles, and target-access credentials cannot authenticate model inference.

## Credential Reference

CAO resolves available target-access credentials in this order:

| Priority | Credential | Configuration |
| --- | --- | --- |
| 1 | Read App | `GH_AW_GITHUB_READ_APP_ID` and `GH_AW_GITHUB_READ_APP_PRIVATE_KEY` |
| 1 | Write App | `GH_AW_GITHUB_WRITE_APP_ID` and `GH_AW_GITHUB_WRITE_APP_PRIVATE_KEY` |
| 2 | Owner-scoped fine-grained PATs | `GH_AW_GITHUB_AUTH_MODE=pat`, repository maps, and `GH_AW_GITHUB_{READ,WRITE}_PAT_<OWNER>` |
| 3 | Legacy PAT fallback | `GH_AW_GITHUB_READ_PAT`, `GH_AW_GITHUB_WRITE_PAT`, or `GH_AW_GITHUB_TOKEN` when no explicit mode is set |
| 4 | Workflow token | `GITHUB_TOKEN` |

This is runtime availability precedence, not permission to choose a PAT silently. Setup must validate the intended profile rather than relying on fallback.

Tokens are resolved inside each run. They never belong in policy, dispatch inputs, prompts, logs, safe outputs, or review bundles.

### API capacity

Before discovery, shared control checks the selected credential's REST API capacity and stops if it cannot preserve the required reserve.

Reduce requests with [conditional requests](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests): persist the response `ETag` and send it as `If-None-Match`. Use [GraphQL](https://docs.github.com/en/graphql/guides/using-graphql-with-github-actions) when one bounded query can replace many REST calls. Do not poll while rate-limited.

### Rotation and incidents

For Apps, add replacement keys, validate review runs, revoke old keys, and recheck installations. For PATs, replace the affected owner-scoped read or write secret, validate its repository boundary, then revoke the previous token.

:::danger[Suspected exposure]
Cancel active runs and revoke the credential first. Disabling a campaign does not revoke its App installation or PAT. Inspect logs and outputs, rotate credentials, and resume only in `review` mode.
:::

## Validation

Before promotion, verify:

- App-only authentication when an App is configured;
- separate read-token minting for each enrolled organization when using enterprise-owned Apps;
- write-App installation only on approved safe-output repositories, including a reversible write-and-cleanup probe;
- PAT-only authentication only when the App is intentionally absent, the fallback is eligible, and the operator explicitly consented;
- expected precedence when both are configured;
- target repository coverage;
- organization PAT policy, approval state, resource-owner scope, expiration, and required API compatibility when using a PAT;
- read operations for repository and workflow discovery, plus a negative assertion that the read credential cannot perform the selected write probe;
- write operations only through the write credential and only in an approved safe-output repository, including cleanup of any reversible probe;
- absence of `GH_AW_GITHUB_TOKEN` after a split-PAT migration has passed without the compatibility fallback;
- a review output in the intended control repository without credential material;
- authentication-profile review whenever target scope, campaign API requirements, mode, or review destination changes.
