---
name: setup-cao
description: "Set up a bare Central Agentic Ops (CAO) control plane. Use when a user asks to create, bootstrap, initialize, install, or get started with CAO. Create or reuse one control repository, install the runtime, establish exact repository scope, configure authentication, and stop before campaign installation or execution."
argument-hint: "Optionally provide the control repository and repositories CAO should read"
---

# Set Up Central Agentic Ops

## Procedure

1. Identify or create the control repository with explicit approval.
2. Ask for the exact repositories CAO may read before choosing authentication.
3. Install the runtime, then run the repository-local `./cao.sh setup`.
4. Confirm policy contains the exact scope, compatible authentication, and an
   empty campaign map.
5. Validate, show the diff, and stop before campaign installation or execution.

Set up one bare CAO control plane. The successful result has:

- the CAO runtime and repository-local `./cao.sh`;
- exact repository scope in `.github/workflows/cao.json`;
- authentication compatible with that scope;
- an empty campaign map;
- no workflow dispatch.

- Support a source-managed control topology for any repository that maintains the workflows it will execute in-tree. Require the user to select that topology explicitly and require `.github/workflows/cao.json` plus the CAO runtime sources to be present or committed. Never infer control-plane operation from workflow sources, catalog files, or the repository name alone.
- When a source-managed control repository is also a catalog, treat it as a supported dogfood repository and apply both catalog and control-repository safety rules. Keep campaign manifests as campaign source, `.github/workflows/cao.json` as rollout and live-activation policy, and Actions variables and secrets as credentials. Do not require campaign records for workflows maintained directly in-tree or authority files in target repositories.
- Public and private control repositories are supported. Preserve an existing repository's visibility; for a new repository, use the visibility the user chooses.
- In a public control repository, policy, workflow runs, operational metadata, and review safe outputs are public. State that exposure before creation and never place confidential target information in those outputs.
- Bootstrap a separate control repository with the latest root `install.sh`. It installs gh-aw when needed, adds the core CAO runtime, initializes the minimal policy, and makes the repository-local `./cao.sh` CLI executable. Never replace it with ad hoc copying.
- Keep one canonical copy of `control.md`, `control.mjs`, `policy.mjs`, the policy schema, and the setup CLI together under `.github/workflows/shared/`. These files are available in the shared checkout; never fetch another copy from the CAO repository or materialize a second runtime tree.
- Treat installed campaign package sources as immutable. Do not customize their workflow Markdown or other package-owned files after installation. Put additional campaign prompting in the consumer-owned `.github/cao/<campaign-slug>.md` file loaded by each installed workflow's optional `{{#runtime-import? .github/cao/<campaign-slug>.md}}`; never create that steering file unless the user requests custom prompting.
- Preserve consumer-owned root `AGENTS.md` instructions. Keep CAO-specific guidance in `.github/cao/instructions.md`; `.github/aw/instructions.md` is only the gh-aw overlay that points to it.
- Keep rollout policy only in `.github/workflows/cao.json`. Do not create `CENTRAL_AGENTIC_OPS_*` variables or another policy channel.
- Keep credentials out of files, chat, command arguments, and workflow inputs. Have the user enter secrets directly through GitHub or an interactive terminal prompt.
- Keep the catalog's committed root `aw.yml` free of `config` so ordinary installation remains non-interactive. When the user chooses automated App setup, run the repository-local `.github/workflows/shared/setup-github-apps.mjs` helper and target the control repository explicitly.
- Organization billing is optional for CAO installation, but required to run the bundled Copilot-backed workflows. Checking that billing is itself completely optional: the user's token may not have access to billing information, so never require the billing API or administrator confirmation. Those workflows declare `copilot-requests: write` and use the built-in workflow token; do not configure `COPILOT_GITHUB_TOKEN`. Customers may instead author and compile workflows for another supported engine/provider with its own credentials. A GitHub App or target-access PAT does not authenticate model inference.
Campaign discovery, installation, enablement, and execution belong to the separate `add-cao-campaign` skill.

## Safety

- Access is capability, not consent. Ask before creating or reusing a repository, running the installer, configuring credentials, committing, or pushing.
- Ask for exact repositories before asking about authentication.
- Preserve the control repository's visibility. Recommend private unless every target and all operational data may be public.
- Never expose non-public target evidence through a public control repository.
- Keep credentials out of files, chat, command arguments, workflow inputs, and commits.
- Keep rollout authority only in `.github/workflows/cao.json`. Credential reach never widens policy.
- Preserve root `AGENTS.md`. Do not edit generated `.lock.yml` files or campaign ownership records directly.
- Install no user-facing campaign, enable nothing, configure no live mode, and dispatch no workflow.

## Preferred Human Flow

The canonical first-time experience is the repository-local interactive setup:

```bash
curl --fail --silent --show-error --location \
  https://raw.githubusercontent.com/githubnext/gh-aw-cao/main/install.sh |
  bash

./cao.sh setup
```

The installer materializes the CAO runtime and invokes `./cao.sh init` when policy is absent. `./cao.sh setup` then:

1. detects the control repository;
2. asks which exact repositories CAO should read;
3. verifies their visibility and owners;
4. offers only authentication profiles compatible with that scope;
5. shows the plan and asks before changing policy or credentials.

Do not replace this with a questionnaire in documentation or ask the user to understand App/PAT topology before running setup.

## Agent Procedure

When acting as the setup agent:

1. Verify prerequisites:

   ```bash
   gh --version
   gh auth status
   ```

2. Identify the control repository.
   - Prefer a separate private repository.
   - A repository may instead be a source-managed control plane only when the user explicitly chooses to run its in-tree workflows and it already contains `.github/workflows/cao.json` plus the CAO runtime.
   - A catalog may dogfood its own workflows, but campaign source, rollout policy, credentials, and target authority remain separate.

3. Ask for approval before creating or reusing the control repository. For a new repository:

   ```bash
   gh repo create OWNER/CONTROL_REPOSITORY --private --clone
   cd CONTROL_REPOSITORY
   ```

4. Ask for approval, then run the installer in a separate control repository:

   ```bash
   curl --fail --silent --show-error --location \
     https://raw.githubusercontent.com/githubnext/gh-aw-cao/main/install.sh |
     bash
   ```

   Do not run `gh aw init` or copy runtime files manually. Do not run the installer over workflows maintained directly in-tree by a source-managed control repository.

5. Prefer handing control to the interactive CLI:

   ```bash
   ./cao.sh setup
   ```

   If the execution environment cannot support an interactive terminal, reproduce only its two decisions:

   - ask for the comma-separated exact repositories CAO should read;
   - inspect each repository's canonical `nameWithOwner` and visibility;
   - present only compatible authentication choices;
   - show the final scope and credential plan;
   - ask once more before changing policy or credentials.

6. Choose authentication from the verified scope:

   | Scope | Compatible profile |
   | --- | --- |
   | Private or privileged repositories under the control repository organization | `github-app` |
   | Repositories across organizations in one enterprise | `enterprise-app` |
   | Approved owner-scoped credentials where Apps are unavailable, including multiple owners | `token` |

   Every setup profile must authenticate cross-repository access for the full selected scope. GitHub Apps are preferred for durable automation. Fine-grained PATs are valid when organization policy permits them and required APIs support them; setup creates a separate read/write pair for each resource owner. Never use a classic PAT.

7. For a non-interactive agent path:
   - edit only `control-plane.scope.allowed-owners` and `allowed-repositories`;
   - keep `control-plane.campaigns` empty;
   - use the matching `./cao.sh setup-auth ...` command;
   - use `--dry-run` before App or PAT creation;
   - ask before opening credential pages or storing variables and secrets.

8. Validate:

   ```bash
   node - <<'NODE'
   const fs = require('node:fs');
   const source = fs.readFileSync('.github/workflows/cao.json', 'utf8');
   const policy = JSON.parse(source);
   if (/<[^>]+>/.test(source)) throw new Error('unresolved policy placeholder');
   const campaigns = policy?.['control-plane']?.campaigns;
   if (!campaigns || typeof campaigns !== 'object' || Array.isArray(campaigns)) {
     throw new Error('control-plane.campaigns must be an object');
   }
   if (Object.keys(campaigns).length !== 0) {
     throw new Error('initial setup must not declare a user-facing campaign');
   }
   NODE

   gh aw doctor --repo OWNER/CONTROL_REPOSITORY --dir .
   git diff --check
   ```

9. Show the exact diff and ask before committing or pushing. Commit runtime and policy together; exclude credentials and unrelated changes.

10. Report the control repository, visibility, exact read scope, authentication profile, validation result, and whether changes were committed. State explicitly that no campaign was installed or run.

If the user asks what CAO should do next, load `add-cao-campaign`.

## Stop Conditions

Stop without weakening boundaries when:

- repository scope is missing or malformed;
- a selected repository cannot be inspected;
- a public control repository would expose non-public evidence;
- no available authentication profile covers the scope;
- credential creation is declined or incomplete;
- installation or validation fails;
- the existing repository has unapproved conflicting files; or
- the proposed diff contains a user-facing campaign, live policy, credentials, or unrelated changes.
