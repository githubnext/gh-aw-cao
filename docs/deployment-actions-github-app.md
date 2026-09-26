---
title: GitHub Actions with GitHub Apps
description: Run the GitHub Actions only deployment with private read and write GitHub Apps as its GitHub API credentials.
---

:::caution[Experimental]
This deployment profile is experimental. App permission sets, variable and secret names, setup commands, and fallback order may change between releases. Validate the profile with bounded `review` runs before any live use.
:::

This is the recommended credential profile for the [GitHub Actions only](deployment-actions.md) deployment. The Activity collector, orchestrators, and workers all run in GitHub Actions and mint short-lived installation tokens from two **private** GitHub Apps owned by your organization or enterprise:

- a **read App** used by GitHub tools, admission, control precompute, and the Activity collector (`cao-activity.yml`);
- a **write App** used only by trusted safe-output processing.

Dashboard hosting is the same as in the base profile. The build and Pages deploy jobs never use the Apps; they use the automatic `github.token` and Pages OIDC.

## Choose this profile when

- targets are private or internal, span many repositories, or live in several organizations of one GitHub Enterprise Cloud enterprise;
- the campaign must read cross-repository Actions, security, issue, or pull-request evidence;
- review outputs go to a separate repository, or the campaign writes live safe outputs;
- credentials must not depend on one person's continued access.

## Service requirements

Everything in the [base requirements](deployment-actions.md#service-requirements), plus:

| Requirement | Detail |
| --- | --- |
| App ownership | Permission to create private GitHub Apps in the owning organization, or in the enterprise for multi-organization scope. Public Apps are unsupported. |
| App installation | An organization owner who can approve a **selected-repository** installation in every enrolled organization |
| Read App permissions | Read-only: Actions, Checks, Contents, Issues, Campaigns, Pull requests, Secret scanning alerts, Security events, Commit statuses, Vulnerability alerts, Metadata. No write permission. Omit Campaigns on data-residency (`*.ghe.com`) hosts. |
| Write App permissions | Actions write, Administration read, Contents write, Issues write, Pull requests write, Metadata read |
| Webhooks | Disabled on both Apps |

Narrow either permission set to what the installed campaigns actually need. See [Permissions](authentication.md#permissions).

## Deploy

1. Install the campaign and dashboard as described in the [base procedure](deployment-actions.md#deploy), but do not run any workflow yet.
2. Create and install the Apps.

   For a single organization, use the manifest helper. Review the dry run first:

   ```bash
   export GH_HOST=github.example.ghe.com # Omit on github.com.
   ./cao.sh setup-auth github-app --repo acme/central-agentic-ops --dry-run
   ./cao.sh setup-auth github-app \
     --repo acme/central-agentic-ops \
     --write-repository acme/approved-output-repository
   ```

   For several organizations in one enterprise, create both private Apps manually in the enterprise settings, since manifests cannot create enterprise-owned Apps. Install each App separately on the selected repositories of every enrolled organization, then run:

   ```bash
   ./cao.sh setup-auth enterprise-app \
     --repo acme/central-agentic-ops \
     --read-client-id '<read-app-client-id>' \
     --write-client-id '<write-app-client-id>'
   ```

3. For every installation, choose **Only select repositories**. Install the read App on the control repository and every exact repository allowed by `.github/workflows/cao.json`. Install the write App only on approved safe-output repositories; by default that is just the control repository.
4. Confirm that the helper stored the client IDs as variables and the private keys as secrets (see [Configuration](#configuration)). Private keys go through `gh secret set` standard input and are never written to disk or passed as arguments.
5. Remove any `GH_AW_GITHUB_READ_PAT`, `GH_AW_GITHUB_WRITE_PAT`, or legacy `GH_AW_GITHUB_TOKEN` secret. Otherwise an incomplete App configuration silently falls back to a PAT.
6. Run **CAO Activity**, then **CAO Dashboard**, and continue with the base procedure.
7. [Validate](#validate) before enabling any campaign in `live`.

## Configuration

| Name | Kind | Purpose |
| --- | --- | --- |
| `GH_AW_GITHUB_READ_APP_ID` | Actions variable | Read App client ID |
| `GH_AW_GITHUB_READ_APP_PRIVATE_KEY` | Actions secret | Read App private key (PEM) |
| `GH_AW_GITHUB_WRITE_APP_ID` | Actions variable | Write App client ID |
| `GH_AW_GITHUB_WRITE_APP_PRIVATE_KEY` | Actions secret | Write App private key (PEM) |

Each read step uses the read App token when both the variable and secret are present, then falls back to `GH_AW_GITHUB_READ_PAT`, `GH_AW_GITHUB_TOKEN`, and finally `github.token`. Safe outputs use the write App token first, then `GH_AW_GITHUB_WRITE_PAT`, `GH_AW_GITHUB_TOKEN`, and `github.token`. Installation IDs are resolved at runtime from the target owner and repository and are never stored in policy or dispatch inputs.

The Apps grant credential reach only. `.github/workflows/cao.json` still decides scope and mode.

## Telemetry and observability

This profile uses the same telemetry as the [base profile](deployment-actions.md#telemetry-and-observability), with these additions:

- **Token selection.** The `actions/create-github-app-token` step in each job shows whether an App token was minted. If the step was skipped, the run fell back to a PAT or `github.token`.
- **API capacity.** Admission checks the exact selected credential's `GET /rate_limit` before discovery. Each App installation has its own rate limit, which grows with installation size, so a failed capacity gate points to one installation. The dashboard shows it as a GitHub API capacity admission gate.
- **Audit.** App installation-token activity appears in organization and enterprise audit logs under the App's identity, not under a user.

## Guarantees

- Tokens are short-lived (about one hour) and scoped to one installation. Each safe-output token is narrowed to the selected handler's permissions.
- Read and write authority are separate identities; the read App cannot write.
- Credentials do not depend on any individual user's access or employment.
- A multi-organization scope works within one enterprise through separate per-organization installations.
- A missing App configuration is skipped (`ignore-if-missing`), never inferred from another credential's reach.

## Non-guarantees

- **Silent fallback.** If an App's variable or secret is missing, the run uses the next available credential. CAO cannot tell that the fallback was unintended; remove unused PAT secrets.
- **Cross-enterprise reach.** A private App cannot be installed outside its owning organization or enterprise. Use independent control planes for unrelated owners.
- **Enterprise installation.** Installing an App on the enterprise grants no repository access; every organization needs its own selected-repository installation.
- **Automatic rotation.** Private keys do not expire. Rotation is an operator task.
- **Policy.** App installation scope does not widen or narrow CAO policy. A repository the App can reach but policy does not allow is still refused.

## Validate

- Mint and test the read token for every enrolled organization, and confirm it cannot write.
- Perform and clean up a reversible write probe using only the write App, in an approved output repository.
- Confirm neither App is installed on unrelated repositories.

## Rotate and revoke

1. Generate a new private key for each App and replace its secret.
2. Run bounded review runs for each installed campaign.
3. Revoke the old private keys and recheck installations and permissions.

For suspected exposure, set affected campaign kill switches to `false`, cancel active runs, revoke the key or suspend the installation, then investigate. See [Rotation and revocation](authentication.md#rotation-and-revocation).
