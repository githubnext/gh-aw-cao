---
title: Control Plane Authentication Profiles
description: Configure private organization or enterprise GitHub Apps, or owner-scoped fine-grained PATs.
---

CAO supports private GitHub Apps as its durable authentication model and a fine-grained personal access token (PAT) when an operator cannot obtain App installation rights. Authentication grants credential reach; `.github/workflows/cao.json` remains the reviewed authority for where a workflow may run.

## Choose a profile

| Profile | Use when | Boundary |
| --- | --- | --- |
| Organization-owned private Apps | The control repository and targets belong to one organization | Apps can be installed only on their owning organization |
| Enterprise-owned private Apps | Targets span organizations in one GitHub Enterprise Cloud enterprise | Apps are installed separately on each enrolled organization |
| Fine-grained PATs | The operator cannot install an App and the required repositories and APIs are PAT-compatible | One user-bound token pair per resource owner, repository-selected, and subject to organization approval |

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
  --repo acme/central-agentic-ops \
  --write-repository acme/approved-output-repository
```

The read App is installed on the control repository and every exact repository
allowed by `.github/workflows/cao.json`. The write App defaults to only the
control repository for review outputs. Repeat `--write-repository OWNER/REPO`
to replace that default with the exact repositories approved for safe-output
writes.

The helper uses `GH_HOST`, or `GITHUB_SERVER_URL` in Actions, for repository,
App registration, installation, API, and settings URLs. The generated read-App
manifest requests only supported repository permissions.

The helper mints a short-lived installation token from each newly created App
key to read the selected repository list and verify every exact repository
before setup can complete. It does not use OAuth-only `/user/installations`
endpoints. If setup resumes after the process has lost the private key, Actions
secrets cannot be read back; setup fails closed and directs the operator to use
`--force` to create and verify a replacement App. The first bounded workflow
run must still prove read access to every intended repository and write access
only in an approved safe-output repository.

An organization-owned private App fails closed when policy enrolls a repository owned by another organization.

For organizations in one enterprise, create the read and write Apps manually in the enterprise settings. [GitHub App manifests do not support enterprise-owned Apps](https://docs.github.com/en/enterprise-cloud@latest/apps/sharing-github-apps/registering-a-github-app-from-a-manifest). Install each private App separately on the selected repositories in every enrolled organization, then configure the control repository:

```bash
./cao.sh setup-auth enterprise-app \
  --repo acme/central-agentic-ops \
  --read-client-id '<read-app-client-id>' \
  --write-client-id '<write-app-client-id>' \
  --policy .github/workflows/cao.json \
  --write-repository acme/central-agentic-ops \
  --dry-run

./cao.sh setup-auth enterprise-app \
  --repo acme/central-agentic-ops \
  --read-client-id '<read-app-client-id>' \
  --write-client-id '<write-app-client-id>' \
  --policy .github/workflows/cao.json \
  --write-repository acme/central-agentic-ops
```

The command derives the read-App repository selection from the policy and
records the exact read and write scopes in its result. Repeat
`--write-repository OWNER/REPO` only for additional repositories explicitly
approved to receive safe outputs. Without that option, interactive setup keeps
the write scope at the control repository.

Use the same separate permission ceilings as the organization-owned Apps:

| Enterprise App | Organization installations |
| --- | --- |
| Read App | Install on the control repository and every exact target repository that CAO must inspect, including separate selected-repository installations in each enrolled organization |
| Write App | Install only on organizations and repositories approved to receive safe outputs |

Keep both Apps private and disable webhooks. Generate one private key for each App only after reviewing its permissions and installations.

The client IDs are not secrets. The command stores them as repository variables and prompts for each PEM private key through `gh secret set`; never put a private key in a command argument. The operator must be able to create Apps for that enterprise and approve each organization installation.

:::caution[Enterprise installation is not repository access]
[Installing an App on the enterprise](https://docs.github.com/en/enterprise-cloud@latest/apps/using-github-apps/installing-a-github-app-on-your-enterprise) grants only requested enterprise permissions. CAO's read and write Apps require separate organization installations to access organization or repository resources. GitHub's enterprise-installed App capability is in public preview; CAO does not depend on it for normal runtime access.
:::

The setup commands store App client IDs in `GH_AW_GITHUB_READ_APP_ID` and `GH_AW_GITHUB_WRITE_APP_ID` repository variables. They send private keys to the corresponding Actions secrets through standard input and do not save them to disk.

## Configure a fine-grained token

Use a PAT only after confirming:

1. the user already has access to every selected repository;
2. the operator can create a separate token pair for every resource owner represented by the selected repositories;
3. enterprise and organization policy permits the token and any required approval can be obtained;
4. every required API supports fine-grained PATs;
5. the token has exact repository selection, minimum permissions, an expiration, and a rotation owner.

Run:

```bash
./cao.sh setup-auth token \
  --repo acme/central-agentic-ops \
  --write-repository acme/approved-output-repository
```

The command groups the exact repositories by resource owner and creates one
owner-scoped read secret and, where needed, one owner-scoped write secret. For
example, owner `acme` uses `GH_AW_GITHUB_READ_PAT_ACME` and
`GH_AW_GITHUB_WRITE_PAT_ACME`. It stores non-secret repository-to-secret-name
maps in `GH_AW_GITHUB_READ_PAT_REPOSITORIES` and
`GH_AW_GITHUB_WRITE_PAT_REPOSITORIES`, then sets
`GH_AW_GITHUB_AUTH_MODE=pat` only after every secret and map has been stored.
Existing App credentials may remain during validation; they are inactive while
the mode is `pat`.

The command reads `.github/workflows/cao.json`, opens one host-aware
fine-grained-token form for each owner and role with a 30-day expiration and
role-specific permissions prefilled, and prints the exact repositories to
select. GitHub does not support preselecting repository names through
token-template URLs, so choose **Only select repositories** and select every
repository printed for that token. Return to the terminal and enter each token
only at its interactive `gh secret set` prompt. CAO never accepts tokens as
command arguments.

Use `--write-repository OWNER/REPO` one or more times to replace the default
write scope of the control repository. Use `--dry-run` to review every owner,
secret name, and repository selection before prompting; `--no-open` to print
URLs without opening a browser; `--keep-existing` to retain all existing
repository secrets non-interactively; `--replace-existing` to rotate and
replace them; `--expires-in DAYS` for a shorter approved lifetime; or `--policy
PATH` for a non-default policy path. By default, setup asks whether to keep
each existing secret before continuing. It still writes both repository maps
and selects PAT mode only after every missing or replaced secret has been
configured.

The two tokens intentionally have different repository selections:

| Token | Select these repositories |
| --- | --- |
| Read PAT for each owner | The control repository or exact allowed repositories owned by that resource owner |
| Write PAT for each owner | Only explicitly approved output repositories owned by that resource owner; otherwise only the control repository's owner receives a write PAT |

Do not add a target to the write PAT merely because the read PAT covers it. The write PAT is used only by trusted safe-output processing and should remain narrower than the read PAT whenever review outputs stay in the control repository or writes are approved for only a subset of targets.

The credential is user-bound, longer-lived than an App installation token, normally limited to one resource owner, manually rotated, and potentially incompatible with required APIs. It does not bypass organization approval or repository permissions. Never substitute a classic PAT.

Read operations select the owner-scoped secret mapped to the exact target
repository. Safe-output processing independently selects the owner-scoped
secret mapped to the exact output repository. The legacy
`GH_AW_GITHUB_READ_PAT`, `GH_AW_GITHUB_WRITE_PAT`, and
`GH_AW_GITHUB_TOKEN` names remain compatibility fallbacks only when the
explicit authentication mode is not `pat`.

CAO Activity requires the explicit mode and does not use those compatibility
fallbacks. In PAT mode, every exact allowed repository, including the control
repository, must be present in `GH_AW_GITHUB_READ_PAT_REPOSITORIES` and must map
to `GH_AW_GITHUB_READ_PAT_<OWNER>`. Activity fails before collection when the
map is invalid or incomplete, and each owner-scoped matrix job fails if its
mapped secret is empty. Owner-wide discovery is App-only because a PAT map
cannot safely represent repositories that were not explicitly selected.

In App mode, Activity creates a separate installation token per resource owner.
The same runtime supports a private organization-owned App for a single
organization and a private enterprise-owned App installed separately in every
enrolled organization. Each token is limited to that owner's exact configured
repositories, or to that owner's installation when owner-wide discovery is
explicitly configured. No App job can fall through to a PAT.

For scheduled multi-owner orchestration, the agent receives only the
control-repository owner's token. Public repositories owned elsewhere remain
discoverable, and dispatched workers receive their target owner's token.
Campaigns that require privileged discovery against private repositories in
several owners still require enterprise Apps or separately scheduled
owner-scoped control planes; CAO never exposes every owner token to one agent.
CAO Activity is not an agent orchestrator: it uses isolated owner-scoped jobs
and merges only non-secret collection artifacts, so multiple PATs are never
bundled into one job or one secret.

## Validate before activation

- Confirm the chosen credential covers every enrolled repository but no unrelated repository.
- Confirm the read App has no write permissions.
- Install the write App only where approved safe outputs require writes.
- For App profiles, confirm the write App's bot login (`APP-SLUG[bot]`) is
  admitted by every worker workflow it may dispatch. A successful
  pre-activation job with skipped activation is not a successful worker run.
- For an enterprise App profile, mint and test the read token separately for every enrolled organization, then perform and clean up a reversible write probe using only the write App in an approved output repository.
- Confirm PAT approval, expiration, resource owner, and API compatibility when using a token.
- For a PAT profile, prove independently that the read PAT can read every enrolled repository but cannot perform the selected reversible write probe, then prove that the write PAT can perform and clean up that probe only in an approved output repository.
- When migrating from `GH_AW_GITHUB_TOKEN`, rerun the same proof after deleting the legacy secret so a successful run cannot be using the compatibility fallback.
- Require successful current-revision authentication, Activity, and Dashboard
  runs, and confirm the dedicated Pages site is private and workflow-backed.
- Run the first campaign with `max_repos=1`, `rollout_percent=100`, and
  `safe_output_mode=review`. Require an activated worker, routed guidance in
  the approved review repository, and no target mutation.
- Promote one bounded run to `safe_output_mode=live` only after explicit policy
  approval. Require an activated worker and verify the intended target changes
  while unrelated repositories remain unchanged.
- Reassess authentication whenever target scope, campaign API requirements, mode, or review destination changes.

See [Configure Authentication](authentication.md) for permission details, precedence, rotation, and incident response.
