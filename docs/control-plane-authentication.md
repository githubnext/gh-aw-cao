---
title: Control Plane Authentication Profiles
description: Configure private organization or enterprise GitHub Apps, a fine-grained token fallback, or the built-in workflow token.
---

CAO supports private GitHub Apps as its durable authentication model and a fine-grained personal access token (PAT) when an operator cannot obtain App installation rights. Authentication grants credential reach; `.github/workflows/cao.json` remains the reviewed authority for where a workflow may run.

## Choose a profile

| Profile | Use when | Boundary |
| --- | --- | --- |
| Organization-owned private Apps | The control repository and targets belong to one organization | Apps can be installed only on their owning organization |
| Enterprise-owned private Apps | Targets span organizations in one GitHub Enterprise Cloud enterprise | Apps are installed separately on each enrolled organization |
| Fine-grained PAT | The operator cannot install an App and the required repositories and APIs are PAT-compatible | User-bound, one resource owner, repository-selected, and subject to organization approval |
| Built-in `GITHUB_TOKEN` | Control-repository work or bounded review of public targets | Scoped to the control repository; cross-repository evidence may be unavailable |

CAO does not publish Apps. A private App cannot support organizations outside its owning organization or enterprise. Use independent control planes for unrelated organizations or enterprises.

## Configure private GitHub Apps

CAO creates separate read-only and write-capable Apps. Review the dry-run manifests before creation.

For one organization:

```bash
./cao.sh setup-auth github-app \
  --repo acme/central-agentic-ops \
  --dry-run

./cao.sh setup-auth github-app \
  --repo acme/central-agentic-ops
```

An organization-owned private App fails closed when policy enrolls a repository owned by another organization.

For organizations in one enterprise, create the read and write Apps manually in the enterprise settings. [GitHub App manifests do not support enterprise-owned Apps](https://docs.github.com/en/enterprise-cloud@latest/apps/sharing-github-apps/registering-a-github-app-from-a-manifest). Install each private App separately on the selected repositories in every enrolled organization, then configure the control repository:

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

The client IDs are not secrets. The command stores them as repository variables and prompts for each PEM private key through `gh secret set`; never put a private key in a command argument. The operator must be able to create Apps for that enterprise and approve each organization installation.

:::caution[Enterprise installation is not repository access]
[Installing an App on the enterprise](https://docs.github.com/en/enterprise-cloud@latest/apps/using-github-apps/installing-a-github-app-on-your-enterprise) grants only requested enterprise permissions. CAO's read and write Apps require separate organization installations to access organization or repository resources. GitHub's enterprise-installed App capability is in public preview; CAO does not depend on it for normal runtime access.
:::

The setup commands store App client IDs in `GH_AW_GITHUB_READ_APP_ID` and `GH_AW_GITHUB_WRITE_APP_ID` repository variables. They send private keys to the corresponding Actions secrets through standard input and do not save them to disk.

## Configure a fine-grained token

Use a PAT only after confirming:

1. the user already has access to every selected repository;
2. all repositories have one resource owner;
3. enterprise and organization policy permits the token and any required approval can be obtained;
4. every required API supports fine-grained PATs;
5. the token has exact repository selection, minimum permissions, an expiration, and a rotation owner.

Run:

```bash
./cao.sh setup-auth token \
  --repo acme/central-agentic-ops \
  --acknowledge-token-risks
```

The command invokes `gh secret set GH_AW_GITHUB_TOKEN` interactively. Enter the token only at that prompt. CAO never accepts it as a command argument.

The acknowledgement confirms that the credential is user-bound, longer-lived than an App installation token, normally limited to one resource owner, manually rotated, and potentially incompatible with required APIs. It does not bypass organization approval or repository permissions. Never substitute a classic PAT.

The current token profile uses one `GH_AW_GITHUB_TOKEN` for reads and approved safe outputs. Its permissions therefore form a shared ceiling; omit write permissions for review-only operation and reconsider private Apps before enabling live outputs.

## Use the workflow token

For control-repository self-review or a bounded public target:

```bash
./cao.sh setup-auth workflow-token
```

This creates no secret. Keep outputs in the control repository and treat unavailable target Actions, security, issue, pull-request, or write APIs as incomplete evidence.

## Validate before activation

- Confirm the chosen credential covers every enrolled repository but no unrelated repository.
- Confirm the read App has no write permissions.
- Install the write App only where approved safe outputs require writes.
- Confirm PAT approval, expiration, resource owner, and API compatibility when using a token.
- Run the first campaign with `max_repos=1`, `rollout_percent=100`, and `safe_output_mode=review`.
- Reassess authentication whenever target scope, campaign API requirements, mode, or review destination changes.

See [Configure Authentication](authentication.md) for permission details, precedence, rotation, and incident response.
