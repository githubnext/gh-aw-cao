---
title: Using a fine-grained PAT with the GitHub Actions deployment
description: Get started quickly by using read and write fine-grained personal access tokens as the GitHub API credentials for a GitHub Actions only deployment.
---

> [!WARNING]
> **Experimental:** This credential profile is experimental and isn't intended for production. Secret names, setup commands, and the credential fallback order can change between releases. For production, use [GitHub Apps](deployment-actions-github-app.md).

## About the fine-grained PAT profile

A fine-grained personal access token (PAT) is the fastest way to start using the [GitHub Actions only deployment](deployment-actions.md). You don't need an organization owner to create or install a GitHub App, so this profile works well for evaluation and experimentation. It isn't suitable for production, because the tokens belong to one user and you must rotate them by hand.

The profile uses a separate token pair for each resource owner:

- **Read PAT for an owner.** Used when GitHub tools, admission, control precompute, or the Activity collector (`cao-activity.yml`) operate on a repository owned by that account.
- **Write PAT for an owner.** Used only when trusted safe-output processing writes to an approved repository owned by that account.

The tokens don't affect how the dashboard is hosted. The dashboard build and deploy jobs never use the PATs. They use the automatic `github.token` and OpenID Connect (OIDC).

### Deciding whether a PAT is right for you

You can use a PAT only if all of the following are true:

- The user creating each token already has access to every repository selected for that token. A PAT can't grant access that its user doesn't have.
- You can create and maintain a separate read/write pair for every resource owner represented by the enrolled repositories.
- Your organization and enterprise policies allow fine-grained PATs, and you can get any required approval before the first run.
- Every API that your campaigns need supports fine-grained PATs. For example, the Checks API doesn't.
- You can limit each token to specific repositories and the minimum permissions, with an expiration date and a named person responsible for rotation.

If any condition isn't met, use a GitHub App, narrow or split the scope, or ask an organization owner for help.

> [!IMPORTANT]
> Before you configure PATs, make sure that their users understand and accept the trade-offs. Each token is tied to one user, covers one resource owner, and lives longer than an App token. Every owner pair is subject to policy and API gaps and must be rotated and revoked manually. Existing PAT secrets don't count as consent.

## Prerequisites

You need everything in the [prerequisites for the GitHub Actions only deployment](deployment-actions.md#prerequisites), plus the following.

| Requirement | Details |
| --- | --- |
| Token users | For each resource owner, a user with access to every repository selected for that owner's tokens. Ideally, use dedicated accounts governed by the participating organizations. |
| Fine-grained PATs | Allowed by every resource owner, with any required approvals complete. |
| Read PAT scope | For each owner, only that owner's repositories allowed by `.github/workflows/cao.json`. Grant read-only permissions that match the [read App permissions](authentication.md#permissions). |
| Write PAT scope | For each owner, only approved safe-output repositories. By default, only the control repository's owner needs a write PAT. Grant only the permissions required by safe outputs. |

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

   The helper reads `.github/workflows/cao.json`, groups repositories by resource owner, and opens one token form for each required owner and role. Each form has the resource owner, a 30-day expiration, and the right permissions already filled in. The helper also lists the repositories to select for that token.

   - To set a shorter expiration, add `--expires-in DAYS`.
   - To print the URLs instead of opening a browser, add `--no-open`.
1. In each token form, select **Only select repositories**, then select exactly the repositories that the helper listed.
1. When the helper prompts you, paste each token into its `gh secret set` prompt. The helper never accepts tokens as command arguments.
1. Confirm that `GH_AW_GITHUB_AUTH_MODE` is `pat` and that both repository maps contain every intended repository. Existing App credentials may remain stored; they are inactive in PAT mode. Don't configure the deprecated `GH_AW_GITHUB_TOKEN` secret.
1. Run the CAO Activity workflow, then the CAO Dashboard workflow. For the remaining steps, see [Deploying the dashboard](deployment-actions.md#deploying-the-dashboard).
1. Before you enable any campaign in `live` mode, validate the credentials. For more information, see [Validating the credentials](#validating-the-credentials).

## Configuration reference

| Name | Type | Description |
| --- | --- | --- |
| `GH_AW_GITHUB_READ_PAT_<OWNER>` | Actions secret | Read-only fine-grained PAT for one resource owner |
| `GH_AW_GITHUB_WRITE_PAT_<OWNER>` | Actions secret | Write-capable fine-grained PAT for one resource owner, used for safe outputs |
| `GH_AW_GITHUB_READ_PAT_REPOSITORIES` | Actions variable | JSON map from each readable repository to its owner-scoped secret name |
| `GH_AW_GITHUB_WRITE_PAT_REPOSITORIES` | Actions variable | JSON map from each approved output repository to its owner-scoped secret name |
| `GH_AW_GITHUB_AUTH_MODE` | Actions variable | Explicit profile selector; `pat` enables owner-scoped routing |
| `GH_AW_GITHUB_TOKEN` | Actions secret (deprecated) | Legacy combined token. Don't configure it for new installations. |

In PAT mode, CAO resolves the exact repository in the corresponding map and uses only the named owner-scoped secret. Missing entries or missing mapped secrets fail before agent execution; CAO does not substitute the repository-provided token or another owner's PAT. In App mode, owner-scoped PATs are inactive. Legacy split or combined PAT names are considered only when no explicit authentication mode has been configured.

Keep the write PAT narrower than the read PAT. Don't add a repository to the write PAT only because the read PAT covers it.

## Monitoring the deployment

This profile uses the same signals as [the GitHub Actions only deployment](deployment-actions.md#monitoring-the-deployment), plus the following.

| Signal | What to check |
| --- | --- |
| API capacity | Every run shares the token owner's rate limit with that user's other activity and tokens. On GitHub.com, the limit is 5,000 REST API requests per hour. Admission checks `GET /rate_limit` for the selected token and stops before discovery when capacity is low. |
| Expiration | An expired or revoked PAT causes authentication failures, and CAO opens a `CAO Activity workflow failure` issue or a similar issue. CAO doesn't warn you before a token expires, so track expiration dates yourself. |
| Audit logs | API activity appears in audit logs under the token owner's user account. |

## What this deployment guarantees

- **Separate credentials.** Every resource owner has separate read and write secrets with separate repository selections.
- **Contained secrets.** Tokens stay in Actions secrets. CAO never passes them to workers, prompts, logs, safe outputs, or dispatch inputs.
- **Policy still applies.** CAO policy still limits scope and mode. A token's access doesn't widen policy.
- **Honest gaps.** When CAO can't reach an API, it reports incomplete evidence instead of guessing.

## What this deployment does not guarantee

- **Continuity.** The deployment stops working if the token owner loses access, leaves, or has the token revoked.
- **Single-token multi-owner access.** Each token still covers exactly one resource owner; CAO achieves multi-owner reach by routing each repository to that owner's token pair.
- **API coverage.** Some APIs, including Checks, don't accept fine-grained PATs. Campaigns that need them report incomplete evidence.
- **Automatic rotation.** Tokens expire on the date you set. CAO doesn't rotate them or warn you before they expire.
- **Rate-limit isolation.** CAO shares API capacity with the token owner's other activity.
- **Least privilege for each job.** A PAT can't be narrowed for each job. Every run has all the permissions of the token that it uses.

## Validating the credentials

1. For each resource owner, confirm that its read PAT can read every mapped repository but can't make the reversible test change.
1. For each resource owner with approved outputs, confirm that its write PAT can make and undo the test change only in mapped output repositories.
1. Confirm each token's resource owner, approval status, expiration date, API compatibility, and repository-map entry.

If you're migrating from `GH_AW_GITHUB_TOKEN`, create two new tokens. Don't copy the legacy token into both secrets. After the migration, delete the legacy secret and run a bounded `review` run. For more information, see [Migrate from the legacy PAT](authentication.md#migrate-from-the-legacy-pat).

## Rotating and revoking credentials

1. Create replacement read and write PATs for the affected owner with the same access or less.
1. Replace that owner's `GH_AW_GITHUB_READ_PAT_<OWNER>` and `GH_AW_GITHUB_WRITE_PAT_<OWNER>` secrets.
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
