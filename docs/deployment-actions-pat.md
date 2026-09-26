---
title: Using a fine-grained PAT with the GitHub Actions deployment
description: Get started quickly by using read and write fine-grained personal access tokens as the GitHub API credentials for a GitHub Actions only deployment.
---

> [!WARNING]
> **Experimental:** This credential profile is experimental and isn't intended for production. Secret names, setup commands, and the credential fallback order can change between releases. For production, use [GitHub Apps](deployment-actions-github-app.md).

## About the fine-grained PAT profile

A fine-grained personal access token (PAT) is the fastest way to start using the [GitHub Actions only deployment](deployment-actions.md). You don't need an organization owner to create or install a GitHub App, so this profile works well for evaluation and experimentation. It isn't suitable for production, because the tokens belong to one user and you must rotate them by hand.

The profile uses two tokens:

- **Read PAT.** Used by GitHub tools, admission, control precompute, and the Activity collector (`cao-activity.yml`).
- **Write PAT.** Used only by trusted safe-output processing.

The tokens don't affect how the dashboard is hosted. The dashboard build and deploy jobs never use the PATs. They use the automatic `github.token` and OpenID Connect (OIDC).

### Deciding whether a PAT is right for you

You can use a PAT only if all of the following are true:

- The token owner already has access to every enrolled repository. A PAT can't grant access that its owner doesn't have.
- Every enrolled repository has the same resource owner. A fine-grained PAT can't span organizations.
- Your organization and enterprise policies allow fine-grained PATs, and you can get any required approval before the first run.
- Every API that your campaigns need supports fine-grained PATs. For example, the Checks API doesn't.
- You can limit each token to specific repositories and the minimum permissions, with an expiration date and a named person responsible for rotation.

If any condition isn't met, use a GitHub App, narrow or split the scope, or ask an organization owner for help.

> [!IMPORTANT]
> Before you configure a PAT, make sure that its owner understands and accepts the trade-offs. The token is tied to one user and lives longer than an app token. It covers one resource owner and is subject to policy and API gaps. It must be rotated and revoked by hand. An existing PAT secret doesn't count as consent.

## Prerequisites

You need everything in the [prerequisites for the GitHub Actions only deployment](deployment-actions.md#prerequisites), plus the following.

| Requirement | Details |
| --- | --- |
| Token owner | A user with access to every enrolled repository. Ideally, use a dedicated account that your organization governs. |
| Fine-grained PATs | Allowed for the resource owner, with any required approval complete. |
| Read PAT scope | The control repository and every repository that `.github/workflows/cao.json` allows. Grant read-only permissions that match the [read app permissions](authentication.md#permissions). |
| Write PAT scope | Only approved safe-output repositories. By default, that's only the control repository. Grant only the write permissions that your safe outputs need. |

> [!NOTE]
> Classic PATs aren't supported. Don't use a classic PAT to work around a missing API.

## Deploying the dashboard

1. Install the dashboard. For more information, see [Deploying the dashboard](deployment-actions.md#deploying-the-dashboard). Don't run any workflows yet.
1. Create both tokens with the setup helper. Replace `OWNER/CONTROL-REPOSITORY` with your control repository and `OWNER/OUTPUT-REPOSITORY` with an approved safe-output repository.

   ```bash
   ./cao.sh setup-auth token \
     --repo OWNER/CONTROL-REPOSITORY \
     --write-repository OWNER/OUTPUT-REPOSITORY
   ```

   The helper reads `.github/workflows/cao.json` and opens a token form for each token. Each form has the resource owner, a 30-day expiration, and the right permissions already filled in. The helper also lists the repositories to select for each token.

   - To set a shorter expiration, add `--expires-in DAYS`.
   - To print the URLs instead of opening a browser, add `--no-open`.
1. In each token form, select **Only select repositories**, then select exactly the repositories that the helper listed.
1. When the helper prompts you, paste each token into its `gh secret set` prompt. The helper never accepts tokens as command arguments.
1. Make sure that no GitHub App is partly configured. Delete any `GH_AW_GITHUB_*_APP_ID` variable or `GH_AW_GITHUB_*_APP_PRIVATE_KEY` secret that you don't use. Don't configure the deprecated `GH_AW_GITHUB_TOKEN` secret.
1. Run the CAO Activity workflow, then the CAO Dashboard workflow. For the remaining steps, see [Deploying the dashboard](deployment-actions.md#deploying-the-dashboard).
1. Before you enable any campaign in `live` mode, validate the credentials. For more information, see [Validating the credentials](#validating-the-credentials).

## Configuration reference

| Name | Type | Description |
| --- | --- | --- |
| `GH_AW_GITHUB_READ_PAT` | Actions secret | Read-only fine-grained PAT |
| `GH_AW_GITHUB_WRITE_PAT` | Actions secret | Fine-grained PAT with write access, used for safe outputs |
| `GH_AW_GITHUB_TOKEN` | Actions secret (deprecated) | Legacy combined token. Don't configure it for new installations. |

When no GitHub App is configured, CAO chooses a credential for each step in this order.

| Step type | Order |
| --- | --- |
| Read steps | `GH_AW_GITHUB_READ_PAT`, then `GH_AW_GITHUB_TOKEN`, then `github.token` |
| Safe outputs | `GH_AW_GITHUB_WRITE_PAT`, then `GH_AW_GITHUB_TOKEN`, then `github.token` |

A configured GitHub App always takes precedence over a PAT.

Keep the write PAT narrower than the read PAT. Don't add a repository to the write PAT only because the read PAT covers it.

## Monitoring the deployment

This profile uses the same signals as [the GitHub Actions only deployment](deployment-actions.md#monitoring-the-deployment), plus the following.

| Signal | What to check |
| --- | --- |
| API capacity | Every run shares the token owner's rate limit with that user's other activity and tokens. On GitHub.com, the limit is 5,000 REST API requests per hour. Admission checks `GET /rate_limit` for the selected token and stops before discovery when capacity is low. |
| Expiration | An expired or revoked PAT causes authentication failures, and CAO opens a `CAO Activity workflow failure` issue or a similar issue. CAO doesn't warn you before a token expires, so track expiration dates yourself. |
| Audit logs | API activity appears in audit logs under the token owner's user account. |

## What this deployment guarantees

- **Separate credentials.** The read and write tokens are separate secrets with separate repository selections.
- **Contained secrets.** Tokens stay in Actions secrets. CAO never passes them to workers, prompts, logs, safe outputs, or dispatch inputs.
- **Policy still applies.** CAO policy still limits scope and mode. A token's access doesn't widen policy.
- **Honest gaps.** When CAO can't reach an API, it reports incomplete evidence instead of guessing.

## What this deployment does not guarantee

- **Continuity.** The deployment stops working if the token owner loses access, leaves, or has the token revoked.
- **Multi-organization scope.** One token can't cover more than one resource owner. Use a GitHub App or separate control planes.
- **API coverage.** Some APIs, including Checks, don't accept fine-grained PATs. Campaigns that need them report incomplete evidence.
- **Automatic rotation.** Tokens expire on the date you set. CAO doesn't rotate them or warn you before they expire.
- **Rate-limit isolation.** CAO shares API capacity with the token owner's other activity.
- **Least privilege for each job.** A PAT can't be narrowed for each job. Every run has all the permissions of the token that it uses.

## Validating the credentials

1. Confirm that the read PAT can read every enrolled repository but can't make the reversible test change.
1. Confirm that the write PAT can make and undo the test change, and only in an approved output repository.
1. Confirm the resource owner, approval status, expiration date, and API compatibility of each token.

If you're migrating from `GH_AW_GITHUB_TOKEN`, create two new tokens. Don't copy the legacy token into both secrets. After the migration, delete the legacy secret and run a bounded `review` run. For more information, see [Migrate from the legacy PAT](authentication.md#migrate-from-the-legacy-pat).

## Rotating and revoking credentials

1. Create replacement read and write PATs with the same access or less.
1. Replace the `GH_AW_GITHUB_READ_PAT` and `GH_AW_GITHUB_WRITE_PAT` secrets.
1. Test read access and safe-output writes separately.
1. Revoke the previous tokens.

If you suspect that a token was exposed:

1. Set the kill switch for each affected campaign to `false`.
1. Cancel active runs.
1. Revoke the PAT.
1. Investigate the exposure.

## Next steps

When you're ready for production, move to [GitHub Apps](deployment-actions-github-app.md). After the apps are working, delete both PAT secrets.

## Further reading

- [Deploying the dashboard with GitHub Actions](deployment-actions.md)
- [Using GitHub Apps with the GitHub Actions deployment](deployment-actions-github-app.md)
- [Fine-grained PAT fallback](authentication.md#fine-grained-pat-fallback)
- [Configure a fine-grained token](control-plane-authentication.md#configure-a-fine-grained-token)
- [Credentials](configuration.md#credentials)
- [Admission gates](admission.md), including [Diagnose a skipped run](admission.md#diagnose-a-skipped-run)
- [Managing your personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) in the GitHub documentation
