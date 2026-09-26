---
title: GitHub Actions with a fine-grained PAT
description: Run the GitHub Actions only deployment with separate read and write fine-grained personal access tokens when a GitHub App cannot be installed.
---

> [!WARNING]
> **Experimental:** This deployment profile is experimental and is a consented fallback, not a recommended default. Secret names, setup commands, and fallback order may change between releases. Prefer [GitHub Apps](deployment-actions-github-app.md) whenever an App can be installed.

This profile runs the [GitHub Actions only](deployment-actions.md) deployment with two **fine-grained** personal access tokens (PATs) instead of GitHub Apps:

- A **read PAT** used by GitHub tools, admission, control precompute, and the Activity collector (`cao-activity.yml`).
- A **write PAT** used only by trusted safe-output processing.

Dashboard hosting is the same as in the base profile. The build and Pages deploy jobs never use the PATs; they use the automatic `github.token` and Pages OIDC.

## When to use this profile

All of the following are true. If any is false, use a GitHub App, narrow or split the scope, or involve an organization owner. A PAT is not an access bypass.

1. No GitHub App can be installed for the required scope.
1. The token owner already has access to every enrolled repository.
1. Every enrolled repository has **one resource owner**. A fine-grained PAT cannot span organizations.
1. Organization and enterprise policy permits fine-grained PATs, and any required approval can be obtained before the first run.
1. Every API the installed campaigns need supports fine-grained PATs. For example, the Checks API does not.
1. Each token can be limited to exact repositories and minimum permissions, with an expiration and a named rotation owner.

Before configuring a PAT, confirm that its owner understands the trade-offs: it is tied to one user, lives longer than an App token, covers one resource owner, is subject to policy and endpoint gaps, and must be rotated and revoked by hand. The presence of an existing PAT secret is not consent.

## Prerequisites

Everything in the [prerequisites for GitHub Actions only](deployment-actions.md#prerequisites), plus:

| Requirement | Detail |
| --- | --- |
| Token owner | A user, ideally a dedicated and governed account, with access to every enrolled repository |
| Fine-grained PATs | Enabled for the resource owner, with approval completed if the organization requires it |
| Read PAT scope | The control repository and every exact repository allowed by `.github/workflows/cao.json`, with read-only permissions matching the [read App ceiling](authentication.md#permissions) |
| Write PAT scope | Only approved safe-output repositories (by default, just the control repository), with the write permissions the enabled safe outputs need |
| Classic PATs | Not supported. Never substitute one to work around an endpoint gap. |

## Deploying the dashboard

1. Install the campaign and dashboard as described in the [GitHub Actions only deployment procedure](deployment-actions.md#deploying-the-dashboard), but do not run any workflow yet.
1. Create both tokens with the helper:

   ```bash
   ./cao.sh setup-auth token \
     --repo acme/central-agentic-ops \
     --write-repository acme/approved-output-repository
   ```

   It reads `.github/workflows/cao.json` and opens host-aware fine-grained token forms with the resource owner, a 30-day expiration, and role-specific permissions prefilled. It also prints the exact repositories to select for each token. Choose **Only select repositories** and select exactly those repositories. Use `--expires-in DAYS` for a shorter approved lifetime and `--no-open` to print the URLs without opening a browser.
1. Enter each token only at its interactive `gh secret set` prompt. Tokens are never accepted as command arguments.
1. Do not configure the legacy `GH_AW_GITHUB_TOKEN` secret, and make sure no `GH_AW_GITHUB_*_APP_ID` variable or `GH_AW_GITHUB_*_APP_PRIVATE_KEY` secret is left half-configured.
1. Run **CAO Activity**, then **CAO Dashboard**, and continue with the GitHub Actions only deployment procedure.
1. [Validating the credentials](#validating-the-credentials) before enabling any campaign in `live`.

## Configuration reference

| Name | Kind | Purpose |
| --- | --- | --- |
| `GH_AW_GITHUB_READ_PAT` | Actions secret | Read-only fine-grained PAT |
| `GH_AW_GITHUB_WRITE_PAT` | Actions secret | Write-capable fine-grained PAT for safe outputs |
| `GH_AW_GITHUB_TOKEN` | Actions secret (deprecated) | Legacy combined fallback. Do not configure it for new installations. |

When no App is configured, read steps use `GH_AW_GITHUB_READ_PAT`, then `GH_AW_GITHUB_TOKEN`, then `github.token`. Safe outputs use `GH_AW_GITHUB_WRITE_PAT`, then `GH_AW_GITHUB_TOKEN`, then `github.token`. A configured GitHub App always takes precedence over a PAT.

Keep the write PAT narrower than the read PAT. Do not add a target to the write PAT only because the read PAT covers it.

## Monitoring the deployment

This profile uses the same telemetry as the [GitHub Actions only deployment](deployment-actions.md#monitoring-the-deployment), with these differences:

- **API capacity.** Every run shares the token owner's rate limit (5,000 REST requests per hour on github.com) with anything else that user or their other tokens do. Admission checks `GET /rate_limit` for the selected token and stops before discovery when capacity is short.
- **Expiration.** An expired or revoked PAT shows up as authentication failures, which open a `CAO Activity workflow failure` or equivalent issue. Monitor expiration dates outside CAO; CAO does not warn in advance.
- **Audit.** API activity is attributed to the token owner's user account in audit logs.

## What this deployment guarantees

- Read and write credentials are separate secrets with separate repository selections.
- Tokens stay in Actions secrets and are never passed to workers, prompts, logs, safe outputs, or dispatch inputs.
- CAO policy still bounds scope and mode. A token's reach does not widen policy.
- Missing API access produces incomplete evidence, not speculative results.

## What this deployment does not guarantee

- **User binding.** The deployment stops working when the owner loses access, leaves, or has the token revoked.
- **Multi-organization scope.** One token cannot cover more than one resource owner. Use a GitHub App or separate control planes.
- **API coverage.** Some endpoints, including Checks, do not accept fine-grained PATs. Campaigns that need them report incomplete evidence.
- **Rotation.** Tokens expire on the date you set, and rotation is manual. Rotation is not automated or alerted.
- **Rate-limit isolation.** Capacity is shared with the owner's other activity.
- **Least privilege at runtime.** A PAT cannot be narrowed per job. Each run holds the full permissions of the token it uses.

## Validating the credentials

- Prove the read PAT can read every enrolled repository but cannot perform the selected reversible write probe.
- Prove the write PAT can perform and clean up that probe only in an approved output repository.
- Confirm resource owner, approval status, expiration, and API compatibility.

When migrating from `GH_AW_GITHUB_TOKEN`, create two new independent tokens rather than copying the legacy token into both secrets. Delete the legacy secret afterwards and rerun a bounded review. For more information, see [Migrate from the legacy PAT](authentication.md#migrate-from-the-legacy-pat).

## Rotating and revoking credentials

1. Create replacement read and write PATs with the same or narrower access.
1. Replace `GH_AW_GITHUB_READ_PAT` and `GH_AW_GITHUB_WRITE_PAT`.
1. Validate read access and safe-output writes independently.
1. Revoke the previous tokens.

For suspected exposure, set affected campaign kill switches to `false`, cancel active runs, revoke the PAT, then investigate. To move to the recommended profile, follow [GitHub Actions with GitHub Apps](deployment-actions-github-app.md) and delete both PAT secrets afterwards.

## Further reading

- [GitHub Actions only](deployment-actions.md)
- [Admission gates](admission.md), including [Diagnose a skipped run](admission.md#diagnose-a-skipped-run)
- [Credentials](configuration.md#credentials) in the configuration reference
- [Control plane authentication profiles](control-plane-authentication.md#configure-a-fine-grained-token)
- [Fine-grained PAT fallback](authentication.md#fine-grained-pat-fallback)
- [GitHub Actions with GitHub Apps](deployment-actions-github-app.md)
- [Managing your personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) in the GitHub documentation
