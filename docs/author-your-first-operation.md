---
title: Author Your First Operation
description: Turn one recurring repository outcome into a validated operation package and prove it safely on one repository.
---

An operation package captures one repeatable engineering outcome as code. It
contains one orchestrator that selects repositories and at least one worker that
handles one selected repository.

This guide is for the first authoring session. The goal is not a production
rollout. The goal is a complete package that compiles and completes one bounded
run in `review` mode.

## Before the Session

Bring:

- a short description of the repository outcome you want;
- one low-risk repository that can be used for the first review run;
- a GitHub organization with Actions and organization-billed Copilot enabled;
- GitHub CLI authenticated with `repo` and `workflow` scopes;
- GitHub Agentic Workflows `v0.89.15` or newer.

Verify the local tools:

```bash
gh auth status
gh aw version
```

Complete the [Quickstart](getting-started.md) first when you do not yet have a
control repository.

## Start With the Authoring Skill

Open your CAO source or control repository in a coding agent. Then use this
prompt, replacing the bracketed values:

```text
Read and follow .github/skills/create-ops-package/SKILL.md.

Create an operation package for this outcome:
[What should become measurably better in a repository?]

Target repositories:
[Which repositories are eligible, and what evidence identifies them?]

The first proof must use [OWNER/REPOSITORY], stay in review mode, and create no
changes in the target repository. Ask me only about decisions that cannot be
inferred safely. Compile the workflows and report the files, policy registration,
validation results, and first-run command.
```

The packaged skill derives the orchestrator, worker boundaries, permissions,
safe outputs, no-op behavior, and validation from the desired outcome. Do not
begin by copying an existing generated `.lock.yml` file.

## Review the Package Contract

Before running anything, confirm that the change contains:

- one `<package-slug>/aw.yml` manifest and package README;
- one `.github/workflows/<package-slug>.md` orchestrator;
- at least one `.github/workflows/<package-slug>-<worker-slug>.md` worker;
- the package and every worker registered in `.github/workflows/cao.json`;
- read-only agent permissions and only the safe outputs required by the outcome;
- stable duplicate detection and explicit `noop` behavior;
- `review` mode with a one-repository limit.

The orchestrator may select and dispatch work. Each worker must remain scoped to
one authorized repository and cannot discover more repositories or dispatch more
work.

## Validate Before the First Run

In this catalog repository, run:

```bash
npm run compile:locks
npm run compile
npm run docs:build
git diff --check
```

Review the generated lock files, but never edit them directly. Confirm that the
compiled workflows contain no unexpected permissions, network hosts, secrets,
write destinations, or worker dispatches.

For a package authored in another repository, run strict compilation with a
stable schedule seed:

```bash
gh aw compile --strict --schedule-seed OWNER/REPOSITORY
```

## Prove One Review Run

Commit the workflow sources, generated locks, package manifest, and policy
together. Trigger only the orchestrator:

```bash
gh aw run <package-slug> --ref <default-branch> \
  --raw-field target_repo="OWNER/REPOSITORY" \
  --raw-field max_repos="1" \
  --raw-field rollout_percent="100" \
  --raw-field safe_output_mode="review"
```

A successful first run proves that:

- exactly one authorized repository was selected;
- only the expected workers were dispatched;
- proposed outputs stayed in the review repository;
- the target repository was not changed;
- the run produced either one useful review item or an explainable `noop`.

Do not promote the package to `live` during the authoring session.

## Share the Result

A private operation can remain in its control repository. To propose an
operation for the official catalog, open a pull request containing the package,
workflow sources, generated locks, documentation, policy registration, and
focused contract tests.

The current Operations Catalog is curated; it is not yet a self-service
marketplace. Publication is a reviewed source change, and installation or catalog
acceptance never grants rollout authority in another control repository.

## Done Checklist

- [ ] The desired repository outcome is stated in one sentence.
- [ ] The package has one orchestrator and at least one focused worker.
- [ ] Permissions, network access, and safe outputs are minimal and explicit.
- [ ] Duplicate, healthy, and insufficient-evidence cases return `noop`.
- [ ] Strict compilation and documentation build pass.
- [ ] One low-risk repository completes a `review` run without target writes.
- [ ] The author can explain the run result and the next evidence needed.