---
title: Using GitHub Apps with the GitHub Actions deployment
description: Configure private read and write GitHub Apps as the GitHub API credentials for a production GitHub Actions only deployment.
---

> [!WARNING]
> **Experimental:** This credential profile is experimental. Permissions and setup interfaces can change between releases. Validate the profile with bounded `review` runs before any explicitly authorized `live` use.

## About the GitHub Apps profile

GitHub Apps are the preferred durable credential profile for the
[GitHub Actions only deployment](deployment-actions.md) when the built-in token
cannot cover the required evidence or approved outputs. The Activity collector
and participating workflows use short-lived installation tokens from separate
private Apps owned by your organization or enterprise.

- **Read app.** Used for scoped GitHub reads, control precompute, and Activity collection.
- **Write app.** Used only by trusted safe-output processing.

The apps don't affect how the dashboard is hosted. The dashboard build and deploy jobs never use the apps. They use the automatic `github.token` and OpenID Connect (OIDC).

Use this profile when any of the following is true:

- Your targets are private or internal, span many repositories, or belong to several organizations in one GitHub Enterprise Cloud enterprise.
- Your campaigns read Actions, security, issue, or pull request evidence across repositories.
- Your review outputs go to a separate repository, or your campaigns write `live` safe outputs.
- Your credentials must not depend on one person's access.

## Prerequisites

You need everything in the [prerequisites for the GitHub Actions only deployment](deployment-actions.md#prerequisites), plus the following.

| Requirement | Details |
| --- | --- |
| App ownership | An approved private App pair and access to its keys, or permission to create Apps in the owning organization/enterprise. Public apps aren't supported. |
| App installation | Appropriate approval for each new organization installation. Repository administrators can extend an already-approved installation to their repositories where organization policy permits. |
| Permissions | Use the [permission matrix](authentication.md#permissions) as a ceiling, narrowed to the installed workflows. The read App has no write permissions; write scope covers only approved outputs. |
| Webhooks | Turned off for both apps. |

## Deploying the dashboard

Use [Set Up One Organization](setup-one-organization.md) or
[Set Up Multiple Organizations](setup-multiple-organizations.md) for a new
installation. For credential-only changes, follow
[Reuse approved Apps](control-plane-authentication.md#reuse-approved-apps) or
[Configure private GitHub Apps](control-plane-authentication.md#configure-private-github-apps).
Those procedures own the commands, selected-repository installation steps,
host differences, and secure key prompts.

Before dispatching workers, admit the write App's `APP-SLUG[bot]` login in each
worker's `on.bots` allowlist and recompile its source. Successful pre-activation
with skipped activation is not a successful worker run.

Then follow [Deploying the dashboard](deployment-actions.md#deploying-the-dashboard)
for publication and Pages visibility, and the activation checks below before
enabling agentic work. App access never makes a Pages site private.

## Configuration reference

Set `GH_AW_GITHUB_AUTH_MODE=app`; use the
[credential reference](authentication.md#credential-reference) for App variable
and secret names. Explicit App mode fails closed when keys, IDs, installations,
or repository access are missing. It does not fall back to a PAT. Stored PATs
may remain inactive during a verified transition.

The [runtime selection rules](authentication.md#runtime-credential-selection)
explain trusted job-token operations and legacy unset-mode compatibility.
Installation IDs are resolved at runtime, not stored in policy or dispatch
inputs. `.github/workflows/cao.json` still decides scope and mode.

## Monitoring the deployment

This profile uses the same signals as [the GitHub Actions only deployment](deployment-actions.md#monitoring-the-deployment), plus the following.

| Signal | What to check |
| --- | --- |
| Token selection | Inspect the selected authentication mode, token-creation steps, and precompute diagnostics. A skipped App step alone does not prove fallback or successful authentication. |
| API capacity | Before discovery, admission checks `GET /rate_limit` for the selected credential. Each app installation has its own rate limit, which grows with the size of the installation. A failed capacity gate points to one installation, and the dashboard shows it as a GitHub API capacity admission gate. |
| Audit logs | Installation token activity appears in organization and enterprise audit logs under the app's identity, not under a user. |

## What this deployment guarantees

- **Short-lived tokens.** Tokens expire after about one hour and are scoped to one installation. Each safe-output token is limited to the permissions of the selected handler.
- **Separate read and write identities.** The read app can't write.
- **No dependency on individuals.** The credentials keep working if a user loses access or leaves.
- **Multi-organization support.** One enterprise can span several organizations through separate installations in each organization.
- **No cross-profile fallback.** Explicit App mode rejects missing access rather than borrowing PAT credentials.

## What this deployment does not guarantee

- **Proof from local diagnostics alone.** `gh cao doctor` checks the operator's login, not the workflow App's runtime access or safe-output publication.
- **Access outside the enterprise.** A private app can't be installed outside the organization or enterprise that owns it. For unrelated owners, use separate control planes.
- **Access from an enterprise installation.** Installing an app on the enterprise doesn't grant access to any repositories. Every organization needs its own installation on selected repositories.
- **Automatic key rotation.** Private keys don't expire. You must rotate them.
- **Policy changes.** Installation scope doesn't widen or narrow CAO policy. CAO still refuses a repository that the app can reach but policy doesn't allow.

## Validating the credentials

Start with [read-only runtime credential verification](authentication.md#explicit-runtime-credential-verification),
then follow [Validate before activation](control-plane-authentication.md#validate-before-activation).
Verify each organization's selected installation, separate read/write ceilings,
and the actual review destination. Any write canary needs independent authority
for that exact destination; it is not part of read-only verification.

## Rotating and revoking credentials

Follow [Rotation and revocation](authentication.md#rotation-and-revocation).
App keys do not expire automatically. Disabling a campaign does not revoke its
installation or cancel active runs; use [Emergency stop](operations.md#emergency-stop)
when responding to exposure.

## Further reading

- [Deploying the dashboard with GitHub Actions](deployment-actions.md)
- [Using a fine-grained PAT with the GitHub Actions deployment](deployment-actions-pat.md)
- [Configure authentication](authentication.md)
- [Authentication profiles](control-plane-authentication.md)
- [Credentials](configuration.md#credentials)
- [Admission gates](admission.md), including [Diagnose a skipped run](admission.md#diagnose-a-skipped-run)
- [About creating GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/about-creating-github-apps) in the GitHub documentation
- [Making authenticated API requests with a GitHub App in a GitHub Actions workflow](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/making-authenticated-api-requests-with-a-github-app-in-a-github-actions-workflow) in the GitHub documentation
