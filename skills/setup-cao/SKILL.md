---
name: setup-cao
description: "Set up a Central Agentic Ops (CAO) control plane from scratch. Use when a user asks to create, bootstrap, initialize, install, or get started with CAO; asks which catalog operations they want and whether they want to author a custom campaign, creates or reuses a control repository, runs the CAO Bash installer, and proves the boundary with one user-selected review target."
argument-hint: "Provide the control repository, desired catalog operations, custom-campaign interest, and optional first target repository"
---

# Set Up Central Agentic Ops

Create a new Central Agentic Ops control plane and prove it safely with one reviewed run against a repository the user chooses. Carry the setup through that run unless the user asks to stop earlier.

## Safety Invariants

- Support a source-managed control topology for any repository that maintains the workflows it will execute in-tree. Require the user to select that topology explicitly and require `.github/workflows/cao.json` plus the CAO runtime sources to be present or committed. Never infer control-plane operation from workflow sources, catalog files, or the repository name alone.
- When a source-managed control repository is also a catalog, treat it as a supported dogfood repository and apply both catalog and control-repository safety rules. Keep campaign manifests as campaign source, `.github/workflows/cao.json` as rollout and live-activation policy, and Actions variables and secrets as credentials. Do not require campaign records for workflows maintained directly in-tree or authority files in target repositories.
- Public and private control repositories are supported. Preserve an existing repository's visibility; for a new repository, use the visibility the user chooses.
- In a public control repository, policy, workflow runs, operational metadata, and review safe outputs are public. State that exposure before creation and never place confidential target information in those outputs.
- Bootstrap a separate control repository with the latest root `install.sh`. It installs gh-aw when needed, adds the latest published core CAO campaign, initializes the minimal policy, and makes the repository-local `./cao.sh` CLI executable. Never replace it with ad hoc campaign copying.
- Keep one canonical copy of `control.md`, `control.mjs`, `policy.mjs`, the policy schema, and the setup CLI together under `.github/workflows/shared/`. These files are available in the shared checkout; never fetch another copy from the CAO repository or materialize a second runtime tree.
- Preserve consumer-owned root `AGENTS.md` instructions. Keep CAO-specific guidance in `.github/cao/instructions.md`; `.github/aw/instructions.md` is only the gh-aw overlay that points to it.
- Keep rollout policy only in `.github/workflows/cao.json`. Do not create `CENTRAL_AGENTIC_OPS_*` variables or another policy channel.
- Keep credentials out of files, chat, command arguments, and workflow inputs. Have the user enter secrets directly through GitHub or an interactive terminal prompt.
- Keep the catalog's committed root `aw.yml` free of `config` so ordinary installation remains non-interactive. When the user chooses automated App setup, run the repository-local `.github/workflows/shared/setup-github-apps.mjs` helper and target the control repository explicitly.
- Organization billing is optional for CAO installation, but required to run the bundled Copilot-backed workflows. Checking that billing is itself completely optional: the user's token may not have access to billing information, so never require the billing API or administrator confirmation. Those workflows declare `copilot-requests: write` and use the built-in workflow token; do not configure `COPILOT_GITHUB_TOKEN`. Customers may instead author and compile workflows for another supported engine/provider with its own credentials. A GitHub App or `GH_AW_GITHUB_TOKEN` for target access does not authenticate model inference.
- Ask which outcomes the user wants from the catalog operations installed by the root campaign. Do not silently choose Dependabot or infer campaign intent from the target repository.
- Separately ask whether the user wants to create an operation campaign of their own. When they do, record the operation idea and hand it to the `create-cao-campaign` skill after the base control-plane boundary is proven; setup must not improvise a standalone custom workflow.
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
| `gh-aw-version` | `min-version` from root CAO `aw.yml` | `<gh-aw-version>` |
| `initial-campaign` | campaign slug for the catalog operation selected for the first proof | `<campaign-slug>` |
| `initial-orchestrator` | source filename stem for the selected campaign orchestrator | `<orchestrator-workflow>` |

Do not leave angle-bracket placeholders in authored files or pass placeholders to GitHub. The control repository and target repository are independent values; substitute the control repository as the target only when the user selected self-review.

## Procedure

1. Verify GitHub CLI before any other setup work:

   ```bash
   gh --version
   gh auth status
   ```

   The CAO installer installs the `gh-aw` extension after the control repository exists. Do not run `gh aw init`: CAO bootstraps its workflows, shared runtime, and policy through `install.sh`.
2. Load `docs/getting-started.md`, `docs/configuration.md`, and `docs/authentication.md`. Treat them as authoritative for current CAO policy fields and credential selection. Inspect root `aw.yml` and the manifests and READMEs for the operations it includes so campaign choices reflect the immutable catalog being installed, not a stale list. The gh-aw workflow-authoring guide applies when creating custom workflows, not when installing this existing campaign. Before finalizing a configuration or declaring success, read the control repository's `.github/workflows/cao.json` and the current dashboard state to confirm what is actually running, in which mode, and on which repositories. If the policy and the live dashboard disagree, raise the drift to the user on the dashboard and pause before continuing.
3. Determine the GitHub organization and control repository name. This setup uses an organization-owned control repository; organization-billed Copilot inference is only needed to run Copilot-backed workflows. Use a separate control repository by default. If the selected repository maintains the workflows it will execute in-tree, confirm that it is organization-owned, record it as a source-managed control repository, and preserve its visibility. If it is also the catalog for those workflows, record the dogfood topology and apply both roles. Explain that policy, workflow runs, operational metadata, dashboards, and review safe outputs inherit the control repository's visibility. If another repository exists, detect and preserve its visibility. If it does not exist, ask whether to create it as `public` or `private`; do not assume either.
4. Ask these two campaign questions separately before choosing the first target. Use a multi-select question followed by a yes/no question when an interactive question tool is available:
  - **Catalog operations:** Ask, "What do you want CAO to do with the catalog operations installed by the root campaign?" Present the current campaign display names and outcome-focused descriptions from their manifests and READMEs, allow more than one answer, and include `Not sure yet`. Explain that the immutable root campaign installs its core catalog workflows as one unit; this answer controls initial enablement and onboarding, not partial rewriting of the campaign. If the user selects more than one operation, ask which one should prove setup first. Record the exact `initial-campaign`, `initial-orchestrator`, and worker-to-workflow mapping from the selected campaign's catalog policy. Never silently default the campaign to Dependabot.
  - **Custom operation:** Ask, "Do you also want to create an operation campaign of your own?" If yes, ask for a short description of the desired outcome and target repositories, record it without expanding setup scope, and plan an explicit handoff to the `create-cao-campaign` skill after step 14. If no catalog operation is selected, explain that one installed operation is required for the bounded setup proof and ask the user to choose one; `Not sure yet` must not silently enable a campaign.
5. Ask which repository the first review run should target unless the user already supplied one. Offer `<organization>/<control-repository>` as the default and accept an alternate exact `owner/repository`. For an alternate target:
  - verify that it exists, record its visibility and owner, and confirm the authenticated user can access it;
  - explain that review outputs, run metadata, and target identifiers will be stored with the control repository's visibility;
  - require a private control repository when the target or required evidence is non-public; and
  - select and validate the authentication profile from `docs/authentication.md` before installation or execution. Configure both Apps or a consented PAT only when the selected target requires additional authentication.
6. Confirm prerequisites without changing repositories:
   - Run `gh auth status` and ensure the authenticated account can create repositories and workflows in the organization.
  - Checking Copilot organization billing is completely optional. The authenticated user's token usually cannot read organization billing, so never require this check, never require an administrator to confirm it, and never block installation or a run on its result. When the selected first-proof workflow uses Copilot inference, you may run it once as informational evidence:

    ```bash
    gh api orgs/<organization>/copilot/billing \
      --jq '{seat_management_setting, total_seats: .seat_breakdown.total}'
    ```

    If the command fails, is forbidden, or is inconclusive, say so once and continue. Only an affirmative `total_seats: 0` with `seat_management_setting: unconfigured` is evidence that Copilot inference is unavailable: the workflow token can still receive `copilot-requests: write`, but Copilot model-catalog authorization then fails with HTTP 403 before the agent starts. In that case explain that the user can enable organization billing or explicitly author and compile a workflow using another supported engine/provider and its required credentials. Do not replace `auto` with an explicit model or configure `COPILOT_GITHUB_TOKEN` to hide an inference failure.
   - Check whether the proposed control repository already exists. Reuse it only with the user's agreement; record its visibility and never delete, overwrite, empty, or change its visibility implicitly.
7. Create and clone the control repository with the chosen `--public` or `--private` visibility when it does not exist. Perform every remaining file and Git operation inside that clone. For an explicitly selected source-managed control repository, remain in its source checkout instead: confirm its active remote is the intended control repository and verify `.github/workflows/cao.json`, `.github/workflows/shared/control.mjs`, `.github/workflows/shared/policy.mjs`, and the in-tree workflow sources and locks.
8. In a separate control repository, run the CAO Bash installer:

    ```bash
    curl --fail --silent --show-error --location \
      https://raw.githubusercontent.com/githubnext/gh-aw-cao/main/install.sh |
      bash
    ```

    The installer verifies or installs gh-aw, adds the latest published root campaign, and creates a minimal review-safe `.github/workflows/cao.json`. It also makes the repository-local `./cao.sh` CLI executable. It exits without changing CAO files when the core runtime and policy are already installed. Run `gh aw doctor --repo <organization>/<control-repository> --dir .` after installation. In a source-managed control repository, do not run the installer over workflows maintained directly in-tree; verify its committed runtime and policy instead.

    When the selected authentication profile requires GitHub Apps and the user wants automated creation, run the credential-only helper installed with the campaign:

    ```bash
    node .github/workflows/shared/setup-github-apps.mjs --repo <organization>/<control-repository>
    ```

    In a source-managed control repository, use the in-tree helper:

    ```bash
    node .github/workflows/shared/setup-github-apps.mjs --repo <organization>/<control-repository>
    ```

    Prefer the installed CAO command. The helper mirrors gh-aw's App manifest conversion flow without changing campaign delivery:

    ```bash
    ./cao.sh setup-auth github-app --repo <organization>/<control-repository>
    ```

    For multiple organizations in one enterprise, GitHub App manifests cannot create enterprise-owned Apps. Require an enterprise owner to create the private read and write Apps manually and install them separately on selected repositories in each enrolled organization. Then configure their existing client IDs and enter each PEM only at the interactive secret prompt:

    ```bash
    ./cao.sh setup-auth enterprise-app \
      --repo <organization>/<control-repository> \
      --read-client-id <read-app-client-id> \
      --write-client-id <write-app-client-id>
    ```

    The helper keeps the root campaign manifest config-free, stores client IDs as repository variables, and sends private keys to repository secrets through standard input. Do not install the campaign over in-tree workflows in a source-managed control repository. After setup, verify these names exist in the control repository:

    - variable `GH_AW_GITHUB_READ_APP_ID` and secret `GH_AW_GITHUB_READ_APP_PRIVATE_KEY`;
    - variable `GH_AW_GITHUB_WRITE_APP_ID` and secret `GH_AW_GITHUB_WRITE_APP_PRIVATE_KEY`.

    Existing complete credential pairs are left unchanged. Use `--dry-run` before creation when reviewing custom App names or permissions. The helper creates private Apps only: organization-owned Apps for one organization, or enterprise-owned Apps installed separately on selected repositories in each enrolled organization. For a consented fine-grained PAT fallback, use `./cao.sh setup-auth token --repo <organization>/<control-repository> --acknowledge-token-risks`; enter the token only at the interactive prompt. Confirm the read App has no write permission and the write App is installed only on repositories approved for safe outputs.

    Verify every installed Copilot-backed source declares `copilot-requests: write`, every corresponding generated lock grants that permission and maps `COPILOT_GITHUB_TOKEN` to `${{ github.token }}`, and no generated lock declares `${{ secrets.COPILOT_GITHUB_TOKEN }}`. Confirm the campaign installed `control.mjs`, `policy.mjs`, and `setup-github-apps.mjs` under `.github/workflows/shared/`, and `.github/workflows/cao-activity.yml` plus `activity/cao.mjs` were installed. Installed operations that need recent workflow-run history should restore the schema-versioned activity cache first and download only evidence absent from its bounded, complete scope. Do not rewrite installed workflow authentication or edit generated `.lock.yml` files directly.

9. Preserve any root `AGENTS.md` unchanged. Confirm the campaign did not install a second CAO-owned instruction copy under `.github/aw/`.

10. Install the selected first-proof campaign through the installed CAO CLI so the campaign-owned orchestrator and worker identities are merged into the consumer-owned policy:

    ```bash
    ./cao.sh add githubnext/gh-aw-cao/<campaign-slug>
    ```

    Parse and review the installer-created policy before editing it; do not replace or broaden it without the user's approval. After campaign installation, edit only `control-plane.scope` to add `target-owner` and `target-owner/target-repository`. Do not put `control-owner` or `control-repository` into this policy unless the selected target is the control repository. Keep the omitted defaults: `review`, one repository, and 100 percent rollout. Do not enable the user's other selected catalog operations yet; onboard each through the installed CAO CLI in a separate reviewed change after the first proof.

    Parse the file and reject unresolved placeholders before continuing:

    ```bash
    node - <<'NODE'
    const fs = require('node:fs');
    const source = fs.readFileSync('.github/workflows/cao.json', 'utf8');
    JSON.parse(source);
    if (/<[^>]+>/.test(source)) throw new Error('unresolved policy placeholder');
    NODE
    ```

    Keep initial setup entirely in review. For a later, separately approved promotion of one repository, retain the campaign's `mode: "review"` and add that exact repository under the campaign's `targets` map with `mode: "live"`. Workers inherit that resolved mode unless an explicit `max-mode` narrows them. Confirm the target remains in global scope and has granted matching live authority. Do not promote the campaign default merely to make one target live.
11. Review the installed and authored files and commit `.github` and the newly materialized `AGENTS.md`, when present, atomically so `github.workflow_sha` identifies one workflow-and-policy revision. Push the control repository's default branch. Do not include credentials or unrelated files in the commit.
12. Run the selected installed orchestrator in review mode against the selected target, with review outputs remaining in the control repository:

    ```bash
    gh aw run <orchestrator-workflow> --ref <default-branch> \
       --raw-field target_repo="<target-owner>/<target-repository>" \
       --raw-field max_repos="1" \
       --raw-field rollout_percent="100" \
       --raw-field safe_output_mode="review"
    ```

13. Watch the orchestrator to completion and inspect its correlated worker run. Verify that exactly the selected target was selected, no more than one worker was dispatched, the effective mode was `review`, and every write was a declared review safe output in the control repository rather than a live target effect. A no-op or incomplete worker result is successful when these boundaries hold and its inaccessible evidence is identified.
14. Report the control repository and visibility, selected catalog operation and worker, selected target and visibility, authentication profile, installed CAO source reference, agent-instructions path, policy path, run URLs, and verification result. Treat other selected catalog operations, broader enrollment, or `live` promotion as separate follow-up work. If the user chose to create a custom operation, now load and follow the `create-cao-campaign` skill, carrying forward the recorded outcome and target-repository description; keep campaign authoring separate from the proven setup commit and run.

## Stop Conditions

Stop before the affected installation or run and explain the blocker when:

- the authenticated account lacks required organization or workflow access;
- the selected first-proof workflow uses Copilot inference and the organization is affirmatively reported as having no Copilot entitlement (stop before that run, not before installation; an inaccessible, unchecked, or inconclusive billing endpoint is never a blocker; an explicitly configured non-Copilot workflow may be used instead);
- any installed Copilot-backed source omits `copilot-requests: write` or any generated lock requires `secrets.COPILOT_GITHUB_TOKEN`;
- the installed root campaign writes CAO-owned runtime or ambient-instruction files under `.github/aw/`;
- the root campaign does not install the control runtime under `.github/workflows/shared/`;
- the selected target does not exist, cannot be accessed, requires credentials that were not configured, or would expose non-public evidence through a public control repository;
- the existing repository contains conflicting files that the user has not approved replacing;
- root campaign installation fails; or
- generated workflows or policy validation fail.

Preserve completed work when stopping. Never weaken visibility expectations, permissions, policy, or review-mode constraints to force setup through.