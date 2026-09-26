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
export GH_HOST=github.example.ghe.com # Omit on github.com.

./cao.sh setup-auth github-app \
  --repo acme/central-agentic-ops \
  --dry-run

./cao.sh setup-auth github-app \
  --repo acme/central-agentic-ops
```

The helper uses `GH_HOST`, or `GITHUB_SERVER_URL` in Actions, for repository,
App registration, installation, and settings URLs. On GitHub Enterprise Cloud
data-residency hosts (`*.ghe.com`), it omits the unavailable Campaigns App
permission from the generated read-App manifest.

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

Use the same separate permission ceilings as the organization-owned Apps:

| Enterprise App | Organization installations |
| --- | --- |
| Read App | Install on the control repository and every exact target repository that CAO must inspect, including separate selected-repository installations in each enrolled organization |
| Write App | Install only on organizations and repositories approved to receive safe outputs |

Keep both Apps private and disable webhooks. Generate one private key for each App only after reviewing its permissions and installations. On a GitHub Enterprise Cloud data-residency host, omit the unavailable Campaigns permission from the read App.

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
  --write-repository acme/approved-output-repository
```

The command creates separate `GH_AW_GITHUB_READ_PAT` and `GH_AW_GITHUB_WRITE_PAT` secrets. It reads `.github/workflows/cao.json`, opens host-aware fine-grained-token forms with the resource owner, a 30-day expiration, and role-specific permissions prefilled, and prints the exact repositories to select for each token. GitHub does not support preselecting repository names through token-template URLs, so choose **Only select repositories** and select every repository printed for that role. After generating each token, return to the terminal and enter it only at the corresponding interactive `gh secret set` prompt. CAO never accepts tokens as command arguments. Use `--write-repository OWNER/REPO` one or more times to replace the default write scope of the control repository, `--no-open` to print URLs without opening a browser, `--expires-in DAYS` to choose a shorter approved lifetime, or `--policy PATH` for a non-default policy path.

The two tokens intentionally have different repository selections:

| Token | Select these repositories |
| --- | --- |
| Read PAT | The control repository and every exact repository allowed by `.github/workflows/cao.json` |
| Write PAT | Only repositories explicitly passed with `--write-repository`; otherwise only the control repository |

Do not add a target to the write PAT merely because the read PAT covers it. The write PAT is used only by trusted safe-output processing and should remain narrower than the read PAT whenever review outputs stay in the control repository or writes are approved for only a subset of targets.

The credential is user-bound, longer-lived than an App installation token, normally limited to one resource owner, manually rotated, and potentially incompatible with required APIs. It does not bypass organization approval or repository permissions. Never substitute a classic PAT.

Read operations receive only `GH_AW_GITHUB_READ_PAT`; safe-output processing receives `GH_AW_GITHUB_WRITE_PAT`. The legacy `GH_AW_GITHUB_TOKEN` remains a compatibility fallback but should not be configured for new installations.

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
- For an enterprise App profile, mint and test the read token separately for every enrolled organization, then perform and clean up a reversible write probe using only the write App in an approved output repository.
- Confirm PAT approval, expiration, resource owner, and API compatibility when using a token.
- For a PAT profile, prove independently that the read PAT can read every enrolled repository but cannot perform the selected reversible write probe, then prove that the write PAT can perform and clean up that probe only in an approved output repository.
- When migrating from `GH_AW_GITHUB_TOKEN`, rerun the same proof after deleting the legacy secret so a successful run cannot be using the compatibility fallback.
- Run the first campaign with `max_repos=1`, `rollout_percent=100`, and `safe_output_mode=review`.
- Reassess authentication whenever target scope, campaign API requirements, mode, or review destination changes.

See [Configure Authentication](authentication.md) for permission details, precedence, rotation, and incident response.
