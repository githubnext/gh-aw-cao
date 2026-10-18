---
name: setup-cao
description: "Set up a bare Central Agentic Ops (CAO) control plane. Use when a user asks to create, bootstrap, initialize, install, or get started with CAO. Create or reuse one control repository, install the runtime, establish exact repository scope, configure authentication, and stop before campaign installation or execution."
metadata:
  argument-hint: "Optionally provide the control repository and repositories CAO should read"
---

# Set Up Central Agentic Ops

Create or reuse one bare CAO control plane. Setup leaves the compiled `gh cao`
extension, runtime (including the pipeline-only `./cao.sh`), exact repository
scope and compatible authentication installed,
`control-plane.campaigns` as an empty object, and no user-facing campaign installed or enabled, no live rollout, and no workflow
dispatch.

Campaign discovery and installation are a separate task for `add-cao-campaign`.

## Deterministic boundary

Use `gh cao setup` and `gh cao validate` from the control checkout for
policy construction, authentication setup, external checks, mutation, and
postcondition validation. The agent owns topology clarification, exact scope,
tradeoff explanation, approval, and diff review. Do not recreate setup logic or
write policy JSON directly.

## Invariants

- Establish exact repository scope before selecting authentication. Capability
  is not consent, and credential reach never widens policy.
- Ask before repository creation or reuse, runtime installation, credential
  configuration, commit, or push unless explicitly authorized. Without a user,
  use the safe defaults in the non-interactive reference; absence of a user
  grants no additional effects.
- Keep rollout authority only in `.github/workflows/cao.json`. Keep credentials
  out of files, chat, command arguments, workflow inputs, and commits.
- Fail closed when scope, authority, access, credentials, installation, or
  validation is incomplete.
- Never edit generated `.lock.yml` files directly. Preserve root `AGENTS.md`
  (consumer-owned); do not modify campaign-owned files during setup.
- Install, enable, and execute no campaign during setup.

## Choose the repository role

- Prefer a separate control repository.
- Use a source-managed control repository only when the user explicitly chooses
  to run workflows maintained in-tree and the CAO runtime and policy are present
  or will be committed.
- A repository that is both a catalog and an explicitly selected source-managed
  control plane is a supported dogfood topology; apply both roles without
  combining campaign source, rollout policy, credentials, or target authority.

Read [topology](references/topology.md) when the role is ambiguous or the
repository is source-managed or also a catalog. Read [public control
repositories](references/public-control-repositories.md) before using a public
control repository or selecting a non-public target.

## Preferred human flow

For a separate control repository, prefer interactive setup.
For a new repository, use the review-before-apply [setup quickstart](https://github.com/githubnext/gh-aw-cao/blob/main/docs/setup-quickstarts.md#guided-setup-instead).
The installer's `--setup` flag enters `gh cao setup` directly.

```bash
curl --fail --silent --show-error --location \
  https://raw.githubusercontent.com/githubnext/gh-aw-cao/main/install.sh |
  bash -s -- --create-repo --setup
```

Interactive setup discovers the repository, exact scope, ownership, and
visibility, offers authentication choices based on that scope, then shows its
plan before mutation.
Verify profile prerequisites in the authentication reference before approving;
the prompt does not establish whether selected organizations share an
enterprise. Do not replace it with an independent questionnaire or ad hoc
runtime copying.

## Agent procedure

1. Verify `gh --version` and `gh auth status`; identify the control repository
   and topology and obtain approval to create or reuse it.
2. Obtain exact `OWNER/REPOSITORY` entries CAO may read and verify each
   canonical name, owner, and visibility.
3. With approval, install the runtime in a separate control repository when
   absent; do not run the installer over source-managed workflows.
4. Prefer `gh cao setup`. Read
   [authentication](references/authentication.md) only when selecting or
   troubleshooting an authentication profile.
5. If interaction is unavailable, read
   [non-interactive setup](references/non-interactive.md) and take its safe
   defaults. Do not infer broader scope or configure credentials without
   explicit authorization.
6. Validate policy and repository state:

   ```bash
   gh cao validate
   gh aw doctor --repo OWNER/CONTROL_REPOSITORY --dir .
   git diff --check
   ```

   Confirm `.github/workflows/cao.json` parses, has no unresolved placeholders,
   and contains an empty `control-plane.campaigns` object. This is the canonical
   validator; do not replace it with inline validation.
7. Show the exact diff. Reject campaign, live-mode, credential, generated-lock,
   campaign-owned, or unrelated changes. Ask before commit or push.
8. Report the control repository, visibility, exact read scope, authentication
   profile, validation, and commit status. State explicitly that no campaign was
   installed, enabled, or run.

Read [implementation details](references/implementation-details.md) only when
the installer, runtime layout, generated/source distinction, or steering files
must be inspected.

## Stop conditions

Stop without weakening boundaries for:

- missing or malformed scope, or a repository that cannot be inspected;
- a non-empty pre-existing campaign map;
- a public control repository that could expose non-public evidence;
- no compatible authentication, or declined/incomplete credentials;
- setup fails after approved mutations, until you inspect policy, Pages, and
  credential configuration metadata; never expose secret values;
- installation or validation failure;
- conflicting pre-existing files without approval; or
- unexpected campaign, live, credential, generated-lock, campaign-owned, or
  unrelated changes.
