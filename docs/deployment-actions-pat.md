---
title: Using a fine-grained PAT with the GitHub Actions deployment
description: Use owner-scoped fine-grained tokens for a GitHub Actions deployment when suitable Apps are unavailable.
---

> [!WARNING]
> **Experimental:** This user-bound credential profile is intended for evaluation when suitable Apps are unavailable. Prefer [GitHub Apps](deployment-actions-github-app.md) for durable automation.

## About the fine-grained PAT profile

A fine-grained personal access token (PAT) is an alternative for the
[GitHub Actions only deployment](deployment-actions.md) when you cannot obtain
a suitable App installation and your scope is PAT-compatible. It is not an
access bypass or a prerequisite for monitoring public repositories. Tokens
belong to a user and need manual rotation.

The profile uses a separate token pair for each resource owner:

- **Read PAT for an owner.** Used when GitHub tools, admission, control precompute, or the Activity collector (`cao-activity.yml`) operate on a repository owned by that account.
- **Write PAT for an owner.** Used only when trusted safe-output processing writes to an approved repository owned by that account.

The tokens don't affect how the dashboard is hosted. The dashboard build and deploy jobs never use the PATs. They use the automatic `github.token` and OpenID Connect (OIDC).

### Deciding whether a PAT is right for you

Complete the [PAT eligibility checks](authentication.md#fine-grained-pat-fallback)
before setup: existing user access, organization approval, supported APIs,
one resource owner per token, exact repository selections, expiration, and
a rotation owner. If any condition fails, obtain an App installation or narrow
or split the scope.

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

Use [Set Up with Fine-Grained PATs](setup-fine-grained-pat.md) for a new
installation. For credential-only changes, follow
[Configure a fine-grained token](control-plane-authentication.md#configure-a-fine-grained-token)
for the dry run, owner-specific browser forms, expiration options, secure
prompts, and interrupted-setup recovery.

Then follow [Deploying the dashboard](deployment-actions.md#deploying-the-dashboard)
for publication and Pages visibility. Validate runtime credentials and a
bounded review before any explicitly authorized live work.

## Configuration reference

Set `GH_AW_GITHUB_AUTH_MODE=pat`; use the
[credential reference](authentication.md#credential-reference) for owner-scoped
secret names and read/write repository maps. Missing entries or mapped secrets
fail closed rather than substituting another owner's token or App credentials.
Stored App credentials may remain inactive during validation. Do not configure
the deprecated combined `GH_AW_GITHUB_TOKEN` for new installations.

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
- **API coverage.** Verify support for every endpoint the campaign requires; unsupported or inaccessible evidence must remain incomplete.
- **Automatic rotation.** Tokens expire on the date you set. CAO doesn't rotate them or warn you before they expire.
- **Rate-limit isolation.** CAO shares API capacity with the token owner's other activity.
- **Least privilege for each job.** A PAT can't be narrowed for each job. Every run has all the permissions of the token that it uses.

## Validating the credentials

Follow [Validate before activation](control-plane-authentication.md#validate-before-activation).
Read-only checks cannot establish PAT write permissions or prove safe-output
publication; any write canary needs independent approval and cleanup in its
exact destination. Check each owner's map, approval, expiration, and API support.

For legacy installations, follow [Migrate from the legacy PAT](authentication.md#migrate-from-the-legacy-pat).
Do not copy one broad token into both read and write roles.

## Rotating and revoking credentials

Follow [Rotation and revocation](authentication.md#rotation-and-revocation)
for each affected owner's read/write pair. Track expirations yourself and
revoke replaced tokens after independent read/output validation. Disabling a
campaign does not revoke a PAT or cancel active runs.

## Next steps

For durable automation, move to [GitHub Apps](deployment-actions-github-app.md).
Verify explicit App mode and runtime access before revoking unused PATs and
removing their obsolete secret mappings.

## Further reading

- [Deploying the dashboard with GitHub Actions](deployment-actions.md)
- [Using GitHub Apps with the GitHub Actions deployment](deployment-actions-github-app.md)
- [Fine-grained PAT fallback](authentication.md#fine-grained-pat-fallback)
- [Configure a fine-grained token](control-plane-authentication.md#configure-a-fine-grained-token)
- [Credentials](configuration.md#credentials)
- [Admission gates](admission.md), including [Diagnose a skipped run](admission.md#diagnose-a-skipped-run)
- [Managing your personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) in the GitHub documentation
