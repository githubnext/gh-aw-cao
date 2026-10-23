---
title: Control Plane Authentication Profiles
description: Configure private organization or enterprise GitHub Apps, or owner-scoped fine-grained PATs.
---

CAO supports private GitHub Apps as its durable authentication model and a fine-grained personal access token (PAT) when an operator cannot obtain App installation rights. Authentication grants credential reach; `.github/workflows/cao.json` remains the reviewed authority for where a workflow may run.

This is the credential **provisioning** guide. For installation and publication,
start with [Set Up CAO](setup-quickstarts.md). For runtime mode selection,
permission ceilings, variable/secret names, and rotation, use
[Authentication](authentication.md).

## Choose a profile

| Profile | Use when | Boundary |
| --- | --- | --- |
| [Public-only monitoring](authentication.md#public-only-monitoring-quickstart) | Observe existing workflows in public repositories without App/PAT setup | Exact reviewed scope, built-in Actions token, runtime public visibility checks, explicitly partial evidence; no agent execution or target writes |
| Organization-owned private Apps | The control repository and targets belong to one organization | Apps can be installed only on their owning organization |
| Enterprise-owned private Apps | Targets span organizations in one GitHub Enterprise Cloud enterprise | Apps are installed separately on each enrolled organization |
| Fine-grained PATs | The operator cannot install an App and the required repositories and APIs are PAT-compatible | One user-bound token pair per resource owner, repository-selected, and subject to organization approval |

CAO does not publish Apps. A private App cannot support organizations outside its
owning organization or enterprise. Unrelated owners need separately approved
owner-scoped PATs where supported, or independent control planes.
See [setup combinations and verification](setup-compatibility.md) for effective
operator permissions, visibility restrictions, and GHE.com prerequisites.

## Reuse approved Apps

Prefer an existing private read/write App pair when your organization or
enterprise has already approved one. In `gh cao setup`, choose **Reuse approved
private GitHub Apps**, or preview and configure it directly:

```bash
gh cao setup auth github-app \
  --repo acme/central-agentic-ops \
  --read-client-id '<read-app-client-id>' \
  --write-client-id '<write-app-client-id>' \
  --dry-run
```

Remove `--dry-run` to apply. Setup securely prompts for each PEM key without
echoing it, authenticates the App, verifies its private visibility and separate
permission ceiling, then checks its selected-repository installations. It
stores each credential pair only after that role's repository membership is
verified. It neither creates replacement Apps nor changes rollout policy.
Organization-owned Apps remain limited to their organization; enterprise-owned
Apps require a separate installation in each enrolled organization.

On GitHub.com, repository administrators can add their repositories to an
**existing, approved installation**, including an App with organization-level
permissions, unless organization policy restricts installation changes to
owners. Setup opens that installation's settings when repositories are missing.
An organization owner must still approve a new installation with organization
permissions, repository administration, or repository creation. These
[GitHub App improvements](https://github.blog/changelog/2026-10-13-github-app-improvements-for-least-privilege-and-management/)
ship in GHES 3.24; follow the host's existing approval requirements on older
versions. Approval does not supply a private key: an authorized App credential
manager must provide it through the secure prompt.

For separate provisioning automation, GitHub now supports
`repository_creation:write` for repository creation without
`administration:write`, and `installation_repositories:write` for adding or
removing an exact repository from an organization installation with a
fine-grained PAT or App token. A user caller must also be a repository
administrator or organization owner. CAO does not request either permission in
its runtime Apps or PATs, does not request a classic `repo` PAT, and does not
automatically enroll repositories. Installation membership never expands the
reviewed CAO allowlist.

## Configure private GitHub Apps

CAO creates separate read-only and write-capable Apps. Review the dry-run manifests before creation.

The helper reads exact `control-plane.scope.allowed-repositories` entries,
adds the control repository, and does not expand `allowed-owners` into a
repository list. Include every approved evidence source in reviewed policy:

```json
{
  "control-plane": {
    "scope": {
      "allowed-owners": ["acme"],
      "allowed-repositories": ["acme/central-agentic-ops", "acme/example-service"]
    }
  }
}
```

For one organization:

```bash
export GH_HOST=github.example.ghe.com # Omit on github.com.

gh cao setup auth github-app \
  --repo acme/central-agentic-ops \
  --dry-run

gh cao setup auth github-app \
  --repo acme/central-agentic-ops \
  --write-repository acme/approved-output-repository
```

The read App is installed on the control repository and every exact repository
allowed by `.github/workflows/cao.json`. The write App defaults to only the
control repository for review outputs. Repeat `--write-repository OWNER/REPO`
to replace that default with the exact repositories approved for safe-output
writes.

For **new installations on github.com**, both guided `gh cao setup` and
`gh cao setup auth github-app` preselect each App's exact repositories, including
the installation page reached immediately after App creation. Review the account
and repository list, keep **Only select repositories**, and approve on GitHub.
Existing installations still open **Configure** when coverage is missing; GHES
and data-residency hosts retain manual selection.

Preselection uses numeric REST repository and owner IDs, with at most **100
repositories per installation**. Missing, invalid, inconsistent, or unreadable
metadata stops setup before opening that new installation; no repositories are
silently omitted and setup never substitutes an all-repositories link. Check
`gh` authentication and access to each exact repository before retrying. For a
larger selection, create and install the Apps manually with **Only select
repositories**, then [reuse their client IDs](#reuse-approved-apps).
`--dry-run --repo OWNER/REPO` remains offline and `--no-open` prints browser URLs.
See GitHub's [installation preselection contract](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/migrating-oauth-apps-to-github-apps#prompt-users-to-install-your-github-app).

The helper uses `GH_HOST`, or `GITHUB_SERVER_URL` in Actions, for repository,
App registration, installation, API, and settings URLs. The generated read-App
manifest requests only supported repository permissions.

The helper uses the App's own signed credentials to look up each organization's
installation, then mints a short-lived, metadata-read-only installation token
to verify every exact selected repository before setup can complete. It needs
neither organization-wide installation-list access for the CLI user nor
OAuth-only `/user/installations` endpoints. When rerun with stored client IDs,
it securely prompts for the existing keys again because Actions secrets cannot
be read back; it does not force App replacement. Use `--force` only when
intentionally creating replacement Apps. The first bounded workflow
run must still prove read access to every intended repository and write access
only in an approved safe-output repository.

An organization-owned private App fails closed when policy enrolls a repository owned by another organization.

### Enterprise-owned Apps

For organizations in one enterprise, create the read and write Apps manually in the enterprise settings. [GitHub App manifests do not support enterprise-owned Apps](https://docs.github.com/en/enterprise-cloud@latest/apps/sharing-github-apps/registering-a-github-app-from-a-manifest). Install each private App separately on the selected repositories in every enrolled organization, then configure the control repository:

```bash
gh cao setup auth enterprise-app \
  --repo acme/central-agentic-ops \
  --read-client-id '<read-app-client-id>' \
  --write-client-id '<write-app-client-id>' \
  --policy .github/workflows/cao.json \
  --write-repository acme/central-agentic-ops \
  --dry-run

gh cao setup auth enterprise-app \
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

The client IDs are not secrets. The legacy `enterprise-app` command stores them
as repository variables and prompts for each PEM private key through
`gh secret set`; it does **not** verify enterprise membership or installation
reach. Never put a private key in a command argument. Prefer the verified
[reuse path](#reuse-approved-apps) for existing enterprise Apps as well.
Creating an enterprise App and approving its first organization installation
still require the appropriate administrative authority; repository
administrators can extend an already-approved installation where organization
policy permits.

:::caution[Enterprise installation is not repository access]
[Installing an App on the enterprise](https://docs.github.com/en/enterprise-cloud@latest/apps/using-github-apps/installing-a-github-app-on-your-enterprise) grants only requested enterprise permissions. CAO's read and write Apps require separate organization installations to access organization or repository resources. GitHub's enterprise-installed App capability is in public preview; CAO does not depend on it for normal runtime access.
:::

The setup commands store App client IDs in `GH_AW_GITHUB_READ_APP_ID` and `GH_AW_GITHUB_WRITE_APP_ID` repository variables. They send private keys to the corresponding Actions secrets through standard input and do not save them to disk.

### Manually storing approved App credentials

Prefer the verified setup path. If you already manage approved Apps and key
files through a separate process, these commands store their credentials
without putting keys in command arguments:

```bash
gh variable set GH_AW_GITHUB_READ_APP_ID \
  --repo acme/central-agentic-ops \
  --body '<read-app-client-id>'
gh secret set GH_AW_GITHUB_READ_APP_PRIVATE_KEY \
  --repo acme/central-agentic-ops \
  < read-app-private-key.pem

gh variable set GH_AW_GITHUB_WRITE_APP_ID \
  --repo acme/central-agentic-ops \
  --body '<write-app-client-id>'
gh secret set GH_AW_GITHUB_WRITE_APP_PRIVATE_KEY \
  --repo acme/central-agentic-ops \
  < write-app-private-key.pem
```

Protect those local key files and never commit them. Storage alone is not
verification: confirm exact installation scope and permissions, explicitly
select `GH_AW_GITHUB_AUTH_MODE=app`, and complete
[runtime credential verification](authentication.md#explicit-runtime-credential-verification).

## Configure a fine-grained token

First complete the [PAT eligibility and consent checks](authentication.md#fine-grained-pat-fallback).
Use exact repository selections and a separate read/write pair per resource
owner, with an expiration and rotation owner. A PAT cannot supply access its
user lacks, and a classic PAT is not a workaround for unsupported APIs.

Run:

```bash
gh cao setup auth token \
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

If setup is interrupted after storing some tokens, rerun the same command.
The helper checks secret names without reading their values, prompts for
missing or replaced tokens, and selects PAT mode only after completing both maps.

The two tokens intentionally have different repository selections:

| Token | Select these repositories |
| --- | --- |
| Read PAT for each owner | The control repository or exact allowed repositories owned by that resource owner |
| Write PAT for each owner | Only explicitly approved output repositories owned by that resource owner; otherwise only the control repository's owner receives a write PAT |

Do not add a target to the write PAT merely because the read PAT covers it. The write PAT is used only by trusted safe-output processing and should remain narrower than the read PAT whenever review outputs stay in the control repository or writes are approved for only a subset of targets.

Explicit App and PAT modes fail closed; neither substitutes another profile
when credentials are missing. Legacy split/combined PAT names are considered
only by shared-control workflows with **no explicit mode**, never by Activity.
See [runtime credential selection](authentication.md#runtime-credential-selection)
and [pre-activation inventory credentials](authentication.md#pre-activation-inventory-credentials)
for exact mappings and multi-owner orchestration limits. Activity's isolated
owner jobs do not mean one agent receives every owner's token.

## Validate before activation

- Confirm the chosen credential covers every enrolled repository but no unrelated repository.
- Confirm `GH_AW_GITHUB_AUTH_MODE` selects the intended profile; stored credentials for another profile do not establish which one a run used.
- Confirm the read App has no write permissions.
- Install the write App only where approved safe outputs require writes.
- For App profiles, confirm the write App's bot login (`APP-SLUG[bot]`) is
  admitted by every worker workflow it may dispatch. A successful
  pre-activation job with skipped activation is not a successful worker run.
- For an enterprise App profile, mint and test the read token separately for every enrolled organization, then perform and clean up a reversible write probe using only the write App in an approved output repository.
- Confirm PAT approval, expiration, resource owner, and API compatibility when using a token.
- For a PAT profile, prove independently that the read PAT can read every enrolled repository but cannot perform the selected reversible write probe, then prove that the write PAT can perform and clean up that probe only in an approved output repository.
- When migrating from `GH_AW_GITHUB_TOKEN`, rerun the same proof after deleting the legacy secret so a successful run cannot be using the compatibility fallback.
- Begin with [read-only runtime credential verification](authentication.md#explicit-runtime-credential-verification).
  A passing check does not prove safe-output publication; write probes require
  separate approval for their exact destination and must be cleaned up.
- Require successful current-revision authentication, Activity, and Dashboard
  runs. Confirm Pages is workflow-backed and its audience matches the evidence;
  non-public evidence requires restricted access.
- Run the first campaign with `max_repos=1`, `rollout_percent=100`, and
  `safe_output_mode=review`. Require an activated worker, routed guidance in
  the approved review repository, and no target mutation.
- Promote one bounded run to `safe_output_mode=live` only after explicit policy
  approval. Require an activated worker and verify the intended target changes
  while unrelated repositories remain unchanged.
- Reassess authentication whenever target scope, campaign API requirements, mode, or review destination changes.

See [Configure Authentication](authentication.md) for permission details, precedence, rotation, and incident response.
