---
name: setup-central-agentic-ops
description: "Set up a Central Agentic Ops (CAO) control plane from scratch. Use when a user asks to create, bootstrap, initialize, install, or get started with CAO; asks which installed catalog operations they want and whether they want to author a custom package, creates or reuses a control repository, installs the root CAO package with gh aw add, writes .github/workflows/cao.json, and proves the boundary with one user-selected review target."
argument-hint: "Provide the control repository, desired catalog operations, custom-package interest, and optional first target repository"
---

# Set Up Central Agentic Ops

Create a new Central Agentic Ops control plane and prove it safely with one reviewed run against a repository the user chooses. Carry the setup through that run unless the user asks to stop earlier.

## Safety Invariants

- Support a source-managed control topology for any repository that maintains the workflows it will execute in-tree. Require the user to select that topology explicitly and require `.github/workflows/cao.json` plus the CAO runtime sources to be present or committed. Never infer control-plane operation from workflow sources, catalog files, or the repository name alone.
- When a source-managed control repository is also a catalog, treat it as a supported dogfood repository and apply both catalog and control-repository safety rules. Keep package manifests as package source, `.github/workflows/cao.json` as rollout and live-activation policy, and Actions variables and secrets as credentials. Do not require package records for workflows maintained directly in-tree or authority files in target repositories.
- Public and private control repositories are supported. Preserve an existing repository's visibility; for a new repository, use the visibility the user chooses.
- In a public control repository, policy, workflow runs, operational metadata, and review safe outputs are public. State that exposure before creation and never place confidential target information in those outputs.
- Install the root CAO package from one published GitHub release. Use the latest release by default, pin its tag in `gh aw add`, and never install CAO from `main`, another branch, or by copying package files.
- Keep one package-installed copy of `control.md`, `control.mjs`, `policy.mjs`, the policy schema, and the setup CLI together under `.github/workflows/shared/`. These files are available in the shared checkout; never fetch another copy from the CAO repository or materialize duplicate runtime files under `.github/aw/cao/`.
- The root package installs `.github/aw/default-AGENTS.md` as package-owned source for control-repository ambient context. If the control repository has no root `AGENTS.md`, materialize that source as `AGENTS.md`; never overwrite or merge into existing agent instructions without the user's approval.
- Keep rollout policy only in `.github/workflows/cao.json`. Do not create `CENTRAL_AGENTIC_OPS_*` variables or another policy channel.
- Keep credentials out of files, chat, command arguments, and workflow inputs. Have the user enter secrets directly through GitHub or an interactive terminal prompt.
- Keep the catalog's committed root `aw.yml` free of `config` so ordinary installation remains non-interactive. When the user chooses automated App setup, run the package-installed `.github/workflows/shared/setup-github-apps.mjs` helper and target the control repository explicitly.
- Require confirmed organization billing for Copilot inference. Every Copilot-backed CAO workflow declares `copilot-requests: write` and uses the built-in workflow token; do not configure `COPILOT_GITHUB_TOKEN`. A GitHub App or `GH_AW_GITHUB_TOKEN` for target access does not authenticate Copilot inference.
- Ask which outcomes the user wants from the catalog operations installed by the root package. Do not silently choose Dependabot or infer package intent from the target repository.
- Separately ask whether the user wants to create an operation package of their own. When they do, record the operation idea and hand it to `.github/skills/create-ops-package/SKILL.md` after the base control-plane boundary is proven; setup must not improvise a standalone custom workflow.
- Ask the user which repository the first run should target. Offer the control repository as the safe default, but accept another existing `owner/repository` after validating its visibility, access, output exposure, and authentication profile.
- Keep the first run at `max_repos=1`, `rollout_percent=100`, and `safe_output_mode=review`. Keep review outputs in the control repository and never offer `live` during setup.
- Do not report success until the run and its review-routing boundary have been verified.

## Authentication Boundary

Choose authentication after the user chooses the first target. Control-repository visibility does not determine target access.

- use `GITHUB_TOKEN` for control-repository self-review or an exact public target in `review` when outputs remain in the control repository, and report inaccessible cross-repository evidence as incomplete;
- require separate least-privilege read-only and write-capable GitHub Apps before running against a private or internal target or writing across repositories; and
- offer a fine-grained PAT only when an App cannot be obtained, the PAT can reach the exact repositories and APIs, and the user explicitly consents after hearing that it is user-bound, longer-lived, and manually rotated. A PAT cannot grant access the user does not already have. Never use a classic PAT.

Do not place private target evidence in a public control repository. If the selected target or required evidence is non-public, require a private control repository before configuring credentials or running the operation.

## Required Values

Resolve these values once before installation and use the same exact values in every command, file, and report:

| Value | Source | Replaces |
| --- | --- | --- |
| `control-owner` | selected organization login | `<organization>` |
| `control-repository` | selected control repository name | `<control-repository>` |
| `target-owner` | canonical owner login from the selected target's `nameWithOwner` | every `<target-owner>` |
| `target-repository` | canonical repository name from the selected target's `nameWithOwner` | every `<target-repository>` |
| `default-branch` | control repository's `defaultBranchRef.name` | `<default-branch>` |
| `cao-release` | latest published CAO GitHub release tag | `${cao_release}` |
| `gh-aw-version` | `min-version` from root CAO `aw.yml` | `<gh-aw-version>` |
| `initial-package` | package slug for the catalog operation selected for the first proof | `<package-slug>` |
| `initial-orchestrator` | source filename stem for the selected package orchestrator | `<orchestrator-workflow>` |

Do not leave angle-bracket placeholders in authored files or pass placeholders to GitHub. The control repository and target repository are independent values; substitute the control repository as the target only when the user selected self-review.

## Procedure

1. Load `docs/getting-started.md`, `docs/configuration.md`, and `docs/authentication.md`. Treat them as authoritative for current CAO policy fields and credential selection. Inspect root `aw.yml` and the manifests and READMEs for the operations it includes so package choices reflect the immutable catalog being installed, not a stale list. The gh-aw workflow-authoring guide applies when creating custom workflows, not when installing this existing package. Before finalizing a configuration or declaring success, read the control repository's `.github/workflows/cao.json` and the current dashboard state to confirm what is actually running, in which mode, and on which repositories. If the policy and the live dashboard disagree, raise the drift to the user on the dashboard and pause before continuing.
2. Determine the GitHub organization and control repository name. CAO requires an organization-owned control repository because its workflows use organization-billed Copilot inference. Use a separate control repository by default. If the selected repository maintains the workflows it will execute in-tree, confirm that it is organization-owned, record it as a source-managed control repository, and preserve its visibility. If it is also the catalog for those workflows, record the dogfood topology and apply both roles. Explain that policy, workflow runs, operational metadata, dashboards, and review safe outputs inherit the control repository's visibility. If another repository exists, detect and preserve its visibility. If it does not exist, ask whether to create it as `public` or `private`; do not assume either.
3. Ask these two package questions separately before choosing the first target. Use a multi-select question followed by a yes/no question when an interactive question tool is available:
  - **Catalog operations:** Ask, "What do you want CAO to do with the catalog operations installed by the root package?" Present the current package display names and outcome-focused descriptions from their manifests and READMEs, allow more than one answer, and include `Not sure yet`. Explain that the immutable root package installs its core catalog workflows as one unit; this answer controls initial enablement and onboarding, not partial rewriting of the package. If the user selects more than one operation, ask which one should prove setup first. Record the exact `initial-package`, `initial-orchestrator`, and worker-to-workflow mapping from the selected package's catalog policy. Never silently default the package to Dependabot.
  - **Custom operation:** Ask, "Do you also want to create an operation package of your own?" If yes, ask for a short description of the desired outcome and target repositories, record it without expanding setup scope, and plan an explicit handoff to `.github/skills/create-ops-package/SKILL.md` after step 13. If no catalog operation is selected, explain that one installed operation is required for the bounded setup proof and ask the user to choose one; `Not sure yet` must not silently enable a package.
4. Ask which repository the first review run should target unless the user already supplied one. Offer `<organization>/<control-repository>` as the default and accept an alternate exact `owner/repository`. For an alternate target:
  - verify that it exists, record its visibility and owner, and confirm the authenticated user can access it;
  - explain that review outputs, run metadata, and target identifiers will be stored with the control repository's visibility;
  - require a private control repository when the target or required evidence is non-public; and
  - select and validate the authentication profile from `docs/authentication.md` before installation or execution. Configure both Apps or a consented PAT only when the selected target requires additional authentication.
5. Confirm prerequisites without changing repositories:
   - Run `gh auth status` and ensure the authenticated account can create repositories and workflows in the organization.
   - Run `gh aw version`. Compare it with `min-version` in the root CAO `aw.yml`; upgrade `github/gh-aw` only when the installed version is older. Do not require the catalog maintainer's current local version when the package supports an older release.
  - Confirm that the organization can authenticate the root package's Copilot-backed workflows:

    ```bash
    gh api orgs/<organization>/copilot/billing \
      --jq '{seat_management_setting, total_seats: .seat_breakdown.total}'
    ```

    Proceed only with API evidence of an active entitlement or explicit confirmation from an organization administrator when the billing endpoint is inaccessible or inconclusive. Treat `total_seats: 0` with `seat_management_setting: unconfigured` as unavailable: the workflow token can still receive `copilot-requests: write`, but Copilot model-catalog authorization fails with HTTP 403 before the agent starts. Stop until organization billing is enabled, and do not replace `auto` with an explicit model or configure `COPILOT_GITHUB_TOKEN` to hide that failure.
  - Run `gh aw doctor --repo <organization>/<control-repository> --dir .` only from an attached checkout of an existing repository. Run `gh aw --help` before creating a repository or clone. If the extension is unavailable, install `github/gh-aw`, then rerun the check.
   - Check whether the proposed control repository already exists. Reuse it only with the user's agreement; record its visibility and never delete, overwrite, empty, or change its visibility implicitly.
6. Create and clone the control repository with the chosen `--public` or `--private` visibility when it does not exist. Perform every remaining file and Git operation inside that clone. For an explicitly selected source-managed control repository, remain in its source checkout instead: confirm its active remote is the intended control repository and verify `.github/workflows/cao.json`, `.github/workflows/shared/control.mjs`, `.github/workflows/shared/policy.mjs`, and the in-tree workflow sources and locks. Run `gh aw doctor --repo <organization>/<control-repository> --dir .` before configuring credentials or executing CAO.
7. Install the root CAO package in a separate control repository. Before installing, review the manifest metadata: `gh aw add` rejects packages marked `private` and warns for packages marked `experimental`. `gh aw add` reads root `aw.yml`, installs its orchestrators, workers, shared controls, skills, resources, and the deterministic core activity index, and compiles the workflow lock files without rewriting their authentication profile:

    ```bash
    cao_release=$(gh release view --repo githubnext/gh-aw-cao --json tagName --jq '.tagName')
    [[ "$cao_release" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
      echo "No published semantic CAO release was found." >&2
      exit 1
    }
    gh aw add "githubnext/gh-aw-cao@${cao_release}"
    ```

    `gh release view` resolves the latest published release; pinning that tag keeps every package dependency on the same immutable release. Use an older published release only when the user explicitly selects it. Do not pass `main`, another branch, or a commit SHA, and do not copy control files separately: `gh aw add` installs the complete package, including the shared control runtime. In a source-managed control repository, do not install a package over workflows maintained directly in-tree. Its reviewed workflow sources, generated locks, runtime files, and policy form the runtime revision; verify them at the current commit instead.

    When the selected authentication profile requires GitHub Apps and the user wants automated creation, run the credential-only helper installed with the package:

    ```bash
    node .github/workflows/shared/setup-github-apps.mjs --repo <organization>/<control-repository>
    ```

    In a source-managed control repository, use the in-tree helper:

    ```bash
    node .github/workflows/shared/setup-github-apps.mjs --repo <organization>/<control-repository>
    ```

    The helper mirrors gh-aw's App manifest conversion flow without changing package delivery, keeps the root package manifest config-free, stores client IDs as repository variables, and sends private keys to repository secrets through standard input. Do not install the package over in-tree workflows in a source-managed control repository. After setup, verify these names exist in the control repository:

    - variable `GH_AW_GITHUB_READ_APP_ID` and secret `GH_AW_GITHUB_READ_APP_PRIVATE_KEY`;
    - variable `GH_AW_GITHUB_WRITE_APP_ID` and secret `GH_AW_GITHUB_WRITE_APP_PRIVATE_KEY`.

    Existing complete credential pairs are left unchanged. Use `--dry-run` before creation when reviewing custom App names or permissions. The helper creates private Apps owned by the control repository organization; expand their installations only to approved repositories owned by that organization. Multi-organization enrollment requires an explicitly reviewed App publication and installation plan. Confirm the read App has no write permission and the write App is installed only on repositories approved for safe outputs.

    Verify every installed Copilot-backed source declares `copilot-requests: write`, every corresponding generated lock grants that permission and maps `COPILOT_GITHUB_TOKEN` to `${{ github.token }}`, and no generated lock declares `${{ secrets.COPILOT_GITHUB_TOKEN }}`. Confirm the package installed `control.mjs`, `policy.mjs`, and `setup-github-apps.mjs` under `.github/workflows/shared/`, no duplicate `.github/aw/cao` runtime exists, and `.github/workflows/activity.yml` plus `.github/aw/activity/index.mjs` were installed. Installed operations that need recent workflow-run history should restore the schema-versioned activity cache first and download only evidence absent from its bounded, complete scope. Do not rewrite installed workflow authentication or edit generated `.lock.yml` files directly.

8. Confirm `.github/aw/default-AGENTS.md` was installed. If the repository has no root `AGENTS.md`, read the installed template and create `AGENTS.md` with exactly that content using a file-editing tool. If root `AGENTS.md` already exists, preserve it unchanged unless the user explicitly approves a merge; the packaged file remains the reference default and package updates must not overwrite consumer-owned ambient context.

9. Write `.github/workflows/cao.json` with a file-editing tool. The package cannot install this file because it is consumer-owned rollout policy, and `gh aw add` does not create it. If the file already exists, parse and review it first; do not replace or broaden it without the user's approval. For a new control plane, write exactly this template and enable the selected first-proof package:

   ```json
   {
     "version": 1,
     "gh-aw-version": "<gh-aw-version>",
     "control-plane": {
       "scope": {
         "allowed-owners": ["<target-owner>"],
         "allowed-repositories": ["<target-owner>/<target-repository>"]
       },
       "packages": {
         "<package-slug>": {
           "workers": {
             "<worker-slug>": {
               "workflow": "<worker-workflow-slug>"
             }
           }
         }
       }
     }
   }
   ```

    Replace `<gh-aw-version>` with the root manifest's `min-version`, both occurrences of `<target-owner>` with `target-owner`, the one occurrence of `<target-repository>` with `target-repository`, `<package-slug>` with `initial-package`, and repeat the worker entry for every worker in the recorded catalog mapping. Each worker entry must preserve its exact worker and workflow slugs; the resolver loads this mapping directly from policy. Do not put `control-owner` or `control-repository` into this policy unless the selected target is the control repository. Keep the omitted defaults: `review`, one repository, and 100 percent rollout. Do not enable the user's other selected catalog operations yet; onboard each through a separate reviewed policy change after the first proof. Do not add broader owners, repositories, packages, optional worker controls, modes, rollout settings, or budgets during initial setup.

    Parse the file and reject unresolved placeholders before continuing:

    ```bash
    node - <<'NODE'
    const fs = require('node:fs');
    const source = fs.readFileSync('.github/workflows/cao.json', 'utf8');
    JSON.parse(source);
    if (/<[^>]+>/.test(source)) throw new Error('unresolved policy placeholder');
    NODE
    ```

    Keep initial setup entirely in review. For a later, separately approved promotion of one repository, retain the package's `mode: "review"` and add that exact repository under the package's `targets` map with `mode: "live"`. Workers inherit that resolved mode unless an explicit `max-mode` narrows them. Confirm the target remains in global scope and has granted matching live authority. Do not promote the package default merely to make one target live.
10. Review the installed and authored files and commit `.github` and the newly materialized `AGENTS.md`, when present, atomically so `github.workflow_sha` identifies one workflow-and-policy revision. Push the control repository's default branch. Do not include credentials or unrelated files in the commit.
11. Run the selected installed orchestrator in review mode against the selected target, with review outputs remaining in the control repository:

    ```bash
    gh aw run <orchestrator-workflow> --ref <default-branch> \
       --raw-field target_repo="<target-owner>/<target-repository>" \
       --raw-field max_repos="1" \
       --raw-field rollout_percent="100" \
       --raw-field safe_output_mode="review"
    ```

12. Watch the orchestrator to completion and inspect its correlated worker run. Verify that exactly the selected target was selected, no more than one worker was dispatched, the effective mode was `review`, and every write was a declared review safe output in the control repository rather than a live target effect. A no-op or incomplete worker result is successful when these boundaries hold and its inaccessible evidence is identified.
13. Report the control repository and visibility, selected catalog operation and worker, selected target and visibility, authentication profile, installed CAO source reference, agent-instructions path, policy path, run URLs, and verification result. Treat other selected catalog operations, broader enrollment, or `live` promotion as separate follow-up work. If the user chose to create a custom operation, now load and follow `.github/skills/create-ops-package/SKILL.md`, carrying forward the recorded outcome and target-repository description; keep package authoring separate from the proven setup commit and run.

## Stop Conditions

Stop before installation or execution and explain the blocker when:

- the authenticated account lacks required organization or workflow access;
- organization-billed Copilot inference is unavailable or unconfirmed;
- any installed Copilot-backed source omits `copilot-requests: write` or any generated lock requires `secrets.COPILOT_GITHUB_TOKEN`;
- the installed root package does not contain `.github/aw/default-AGENTS.md`;
- the root package does not install the control runtime under `.github/workflows/shared/`;
- the selected target does not exist, cannot be accessed, requires credentials that were not configured, or would expose non-public evidence through a public control repository;
- the existing repository contains conflicting files that the user has not approved replacing;
- root package installation fails; or
- generated workflows or policy validation fail.

Preserve completed work when stopping. Never weaken visibility expectations, permissions, policy, or review-mode constraints to force setup through.