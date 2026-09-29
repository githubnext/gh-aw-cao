---
name: setup-cao
description: "Set up a bare Central Agentic Ops (CAO) control plane. Use when a user asks to create, bootstrap, initialize, install, or get started with CAO. Create or reuse one control repository, install the runtime, establish exact repository scope, configure authentication, and stop before campaign installation or execution."
argument-hint: "Optionally provide the control repository and repositories CAO should read"
---

# Set Up Central Agentic Ops

Create or reuse one bare CAO control plane. Successful setup leaves:

- the CAO runtime installed or already present, including repository-local
  `./cao.sh`;
- exact repository scope in `.github/workflows/cao.json` and authentication
  compatible with that scope;
- `control-plane.campaigns` present as an empty object;
- no user-facing campaign installed or enabled, no live rollout, and no workflow
  dispatch.

Campaign discovery and installation are a separate task for `add-cao-campaign`.

## Invariants

- Establish exact repository scope before selecting authentication. Capability
  is not consent, and credential reach never widens policy.
- Ask before repository creation or reuse, runtime installation, credential
  configuration, commit, or push.
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

Read [topology](references/topology.md) when the repository is source-managed,
is also a catalog, or its role is ambiguous. Read
[public control repositories](references/public-control-repositories.md) before
using a public control repository or when any selected target is non-public.

## Preferred human flow

For a separate control repository, prefer the repository-local interactive
setup:

If creating a new repository, follow the approved creation steps in the
[setup quickstart](../../docs/setup-quickstarts.md), then run setup from its
root.

```bash
curl --fail --silent --show-error --location \
  https://raw.githubusercontent.com/githubnext/gh-aw-cao/main/install.sh |
  bash
./cao.sh setup
```

The interactive setup discovers the control repository, obtains exact scope,
verifies repository ownership and visibility, offers authentication choices
based on that scope, and shows its plan before mutation. Verify profile
prerequisites in the authentication reference before approving; in particular,
the prompt does not establish whether selected organizations share an
enterprise. Do not replace setup with an independent questionnaire or ad hoc
runtime copying.

## Agent procedure

1. Verify `gh --version` and `gh auth status`.
2. Identify the intended control repository and topology. Obtain approval to
   create or reuse it before mutation.
3. Obtain the exact `OWNER/REPOSITORY` entries CAO may read and verify each
   repository's canonical name, owner, and visibility.
4. With approval, install the runtime in a separate control repository when it
   is absent. Do not run the installer over workflows maintained directly by a
   source-managed control repository.
5. Prefer `./cao.sh setup`. Read
   [authentication](references/authentication.md) only when selecting or
   troubleshooting an authentication profile.
6. If interaction is unavailable, read
   [non-interactive setup](references/non-interactive.md) and reproduce only the
   required scope and authentication decisions.
7. Validate policy and repository state:

   ```bash
   ./cao.sh validate
   gh aw doctor --repo OWNER/CONTROL_REPOSITORY --dir .
   git diff --check
   ```

   Also confirm `.github/workflows/cao.json` parses, has no unresolved
   placeholders, and contains an empty object at `control-plane.campaigns`.
   `./cao.sh validate` is the canonical control-plane validator; do not replace
   it with duplicated inline validation.
8. Show the exact diff. Reject campaign, live-mode, credential, generated-lock,
   campaign-owned, or unrelated changes. Ask before commit or push.
9. Report the control repository, visibility, exact read scope, authentication
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
- installation or validation failure;
- conflicting pre-existing files without approval; or
- unexpected campaign, live, credential, generated-lock, campaign-owned, or
  unrelated changes.
