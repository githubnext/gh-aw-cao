---
title: Using GitHub Apps with the GitHub Actions deployment
description: Configure private read and write GitHub Apps as the GitHub API credentials for a production GitHub Actions only deployment.
---

> [!WARNING]
> **Experimental:** This credential profile is experimental. App permissions, variable and secret names, setup commands, and the credential fallback order can change between releases. Validate the profile with bounded `review` runs before any `live` use.

## About the GitHub Apps profile

GitHub Apps are the recommended credential profile for production use of the [GitHub Actions only deployment](deployment-actions.md). The Activity collector, orchestrators, and workers create short-lived installation tokens from two private GitHub Apps that your organization or enterprise owns.

- **Read app.** Used by GitHub tools, admission, control precompute, and the Activity collector (`cao-activity.yml`).
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
| App ownership | Permission to create private GitHub Apps in the owning organization. For several organizations, you need this permission in the enterprise. Public apps aren't supported. |
| App installation | An organization owner in every enrolled organization who can approve an installation on selected repositories. |
| Read app permissions | Read-only access to Actions, Checks, Contents, Issues, Campaigns, Pull requests, Secret scanning alerts, Security events, Commit statuses, Vulnerability alerts, and Metadata. No write permissions. On data residency hosts (`*.ghe.com`), omit Campaigns. |
| Write app permissions | Write access to Actions, Contents, Issues, and Pull requests. Read access to Administration and Metadata. |
| Webhooks | Turned off for both apps. |

Grant only the permissions that your installed campaigns need. For more information, see [Permissions](authentication.md#permissions).

## Deploying the dashboard

1. Install the dashboard. For more information, see [Deploying the dashboard](deployment-actions.md#deploying-the-dashboard). Don't run any workflows yet.
1. Create and install the apps.

   - **For one organization,** use the manifest helper. Preview the changes with `--dry-run` first. If you use GitHub Enterprise Cloud with data residency, set `GH_HOST` to your host name. Otherwise, omit it.

     ```bash
     export GH_HOST=HOSTNAME
     ./cao.sh setup-auth github-app --repo OWNER/CONTROL-REPOSITORY --dry-run
     ./cao.sh setup-auth github-app \
       --repo OWNER/CONTROL-REPOSITORY \
       --write-repository OWNER/OUTPUT-REPOSITORY
     ```

   - **For several organizations in one enterprise,** create both private apps in your enterprise settings. The manifest helper can't create apps that an enterprise owns. Install each app on selected repositories in every enrolled organization, then run the following command.

     ```bash
     ./cao.sh setup-auth enterprise-app \
       --repo OWNER/CONTROL-REPOSITORY \
       --read-client-id READ-APP-CLIENT-ID \
       --write-client-id WRITE-APP-CLIENT-ID
     ```

   Replace the placeholders as follows:

   - `OWNER/CONTROL-REPOSITORY` with your control repository.
   - `OWNER/OUTPUT-REPOSITORY` with an approved safe-output repository.
   - `READ-APP-CLIENT-ID` and `WRITE-APP-CLIENT-ID` with the client IDs of your apps.
1. For every installation, select **Only select repositories**.
   - Install the read app on the control repository and on every repository that `.github/workflows/cao.json` allows.
   - Install the write app only on approved safe-output repositories. By default, that's only the control repository.
1. Confirm that the helper stored the client IDs as variables and the private keys as secrets. For the names, see [Configuration reference](#configuration-reference). The helper passes private keys to `gh secret set` through standard input, so they are never written to disk or passed as command arguments.
1. Delete any `GH_AW_GITHUB_READ_PAT`, `GH_AW_GITHUB_WRITE_PAT`, or `GH_AW_GITHUB_TOKEN` secrets. If you leave them in place and an app is misconfigured, CAO silently uses the PAT instead.
1. Run the CAO Activity workflow, then the CAO Dashboard workflow. For the remaining steps, see [Deploying the dashboard](deployment-actions.md#deploying-the-dashboard).
1. Before you enable any campaign in `live` mode, validate the credentials. For more information, see [Validating the credentials](#validating-the-credentials).

## Configuration reference

| Name | Type | Description |
| --- | --- | --- |
| `GH_AW_GITHUB_READ_APP_ID` | Actions variable | Client ID of the read app |
| `GH_AW_GITHUB_READ_APP_PRIVATE_KEY` | Actions secret | Private key of the read app, in PEM format |
| `GH_AW_GITHUB_WRITE_APP_ID` | Actions variable | Client ID of the write app |
| `GH_AW_GITHUB_WRITE_APP_PRIVATE_KEY` | Actions secret | Private key of the write app, in PEM format |

CAO chooses a credential for each step in this order.

| Step type | Order |
| --- | --- |
| Read steps | Read app token, then `GH_AW_GITHUB_READ_PAT`, then `GH_AW_GITHUB_TOKEN`, then `github.token` |
| Safe outputs | Write app token, then `GH_AW_GITHUB_WRITE_PAT`, then `GH_AW_GITHUB_TOKEN`, then `github.token` |

An app token is used only when both its variable and its secret are set. CAO looks up installation IDs at runtime from the target owner and repository. It never stores them in policy or dispatch inputs.

The apps control which repositories CAO can reach, not which ones it may act on. The `.github/workflows/cao.json` file still decides scope and mode.

## Monitoring the deployment

This profile uses the same signals as [the GitHub Actions only deployment](deployment-actions.md#monitoring-the-deployment), plus the following.

| Signal | What to check |
| --- | --- |
| Token selection | The `actions/create-github-app-token` step in each job shows whether CAO created an app token. If the step was skipped, the run used a PAT or `github.token` instead. |
| API capacity | Before discovery, admission checks `GET /rate_limit` for the selected credential. Each app installation has its own rate limit, which grows with the size of the installation. A failed capacity gate points to one installation, and the dashboard shows it as a GitHub API capacity admission gate. |
| Audit logs | Installation token activity appears in organization and enterprise audit logs under the app's identity, not under a user. |

## What this deployment guarantees

- **Short-lived tokens.** Tokens expire after about one hour and are scoped to one installation. Each safe-output token is limited to the permissions of the selected handler.
- **Separate read and write identities.** The read app can't write.
- **No dependency on individuals.** The credentials keep working if a user loses access or leaves.
- **Multi-organization support.** One enterprise can span several organizations through separate installations in each organization.
- **No inferred access.** If an app isn't configured, CAO skips it. It never infers access from another credential.

## What this deployment does not guarantee

- **Protection from silent fallback.** If an app variable or secret is missing, the run uses the next available credential. CAO can't tell whether that was intended, so delete PAT secrets that you don't use.
- **Access outside the enterprise.** A private app can't be installed outside the organization or enterprise that owns it. For unrelated owners, use separate control planes.
- **Access from an enterprise installation.** Installing an app on the enterprise doesn't grant access to any repositories. Every organization needs its own installation on selected repositories.
- **Automatic key rotation.** Private keys don't expire. You must rotate them.
- **Policy changes.** Installation scope doesn't widen or narrow CAO policy. CAO still refuses a repository that the app can reach but policy doesn't allow.

## Validating the credentials

1. For every enrolled organization, create a read token and confirm that it can read the expected repositories but can't write.
1. In an approved output repository, use only the write app to make a reversible change, then undo it.
1. Confirm that neither app is installed on unrelated repositories.

## Rotating and revoking credentials

1. Generate a new private key for each app, and replace the matching secret.
1. Run a bounded `review` run for each installed campaign.
1. Delete the old private keys, then review the installations and permissions again.

If you suspect that a key was exposed:

1. Set the kill switch for each affected campaign to `false`.
1. Cancel active runs.
1. Delete the private key, or suspend the installation.
1. Investigate the exposure.

For more information, see [Rotation and revocation](authentication.md#rotation-and-revocation).

## Further reading

- [Deploying the dashboard with GitHub Actions](deployment-actions.md)
- [Using a fine-grained PAT with the GitHub Actions deployment](deployment-actions-pat.md)
- [Configure authentication](authentication.md)
- [Authentication profiles](control-plane-authentication.md)
- [Credentials](configuration.md#credentials)
- [Admission gates](admission.md), including [Diagnose a skipped run](admission.md#diagnose-a-skipped-run)
- [About creating GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/about-creating-github-apps) in the GitHub documentation
- [Making authenticated API requests with a GitHub App in a GitHub Actions workflow](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/making-authenticated-api-requests-with-a-github-app-in-a-github-actions-workflow) in the GitHub documentation
