---
name: add-cao-package
description: "Discover, compare, recommend, or install an existing Central Agentic Ops (CAO) catalog package. Use when a user wants to browse the CAO catalog, find an operation for an outcome, compare packages, or add a package to a control repository safely."
argument-hint: "Describe the desired operational outcome or name a CAO catalog package"
---

# Add a CAO Package

Help the user choose and install an existing CAO operational package. Discover from the current catalog instead of relying on a hard-coded package list. Never silently select or install a package.

## Boundaries

- Use this skill for adopting an existing package. Use `.github/skills/create-cao-package/SKILL.md` when the user wants to author a new package or no existing package fits.
- Work in the intended CAO control repository. Require `.github/workflows/cao.json` and the installed CAO CLI at `.github/aw/activity/cao.mjs`; hand off to `.github/skills/setup-cao/SKILL.md` when the control plane is not initialized.
- Keep catalog discovery read-only. Do not install anything until the user explicitly selects a package after seeing the recommendation and safety summary.
- Install through `cao add`, not the underlying package installer directly. The CAO wrapper validates the installed declaration and merges its orchestrator and workers into policy without enabling live mode or broadening repository scope.
- Never edit generated `.lock.yml` files or `.github/aw/packages/*.json` ownership records directly.

## Discover the Catalog

1. Verify GitHub authentication with `gh auth status`.
2. Resolve the current default-branch commit for `githubnext/gh-aw-cao` once. Use that immutable commit for every manifest, declaration, README, and workflow inspected during this decision so the recommendation cannot mix catalog revisions.
3. Enumerate top-level directories at that commit. A candidate operational package must contain both `aw.yml` and `cao.json` in the same directory.
4. Parse each candidate's `aw.yml` as YAML and `cao.json` as JSON. Do not infer metadata with regular expressions. Exclude packages with `private: true`; label packages with `experimental: true` clearly.
5. Read each remaining package's manifest description, README, CAO declaration, orchestrator source, and worker sources from the same commit. Derive outcomes and tradeoffs from those files rather than package names.

If GitHub authentication, catalog access, structured parsing, or revision consistency fails, stop and report discovery as incomplete. Do not guess from a remembered or partial package list.

## Recommend

When the user has not named a package, ask what operational outcome they want. Recommend no more than three installable packages, ordered by fit. For each recommendation, summarize:

- the outcome it targets;
- its orchestrator and worker responsibilities;
- whether it is experimental;
- notable permissions, network access, credentials, and safe outputs;
- the main tradeoff or reason it may not fit.

Include `None of these` as a choice. Require the user to select one exact package; do not treat a vague outcome, the first recommendation, or lack of response as consent. If no package fits, offer the `create-cao-package` handoff without installing anything.

When the user names a package, verify it against the same catalog process and still present its safety summary before asking for installation approval.

## Review Before Installation

Before requesting approval, inspect the selected package at the resolved commit and report:

- package name, slug, catalog commit, and maturity;
- installed orchestrator and workers from `cao.json`;
- workflow permissions, tools, network hosts, credentials, schedules, and AI credit limits;
- safe-output types and whether they remain review-routed by current policy;
- the exact files and package record that package installation will own;
- the current package policy, exact target overrides, and global scope from `.github/workflows/cao.json`.

Treat missing declarations, invalid metadata, inaccessible sources, unresolved placeholders, or conflicts with an existing installed package as blockers. Never suggest that credential reach expands CAO policy.

## Install

After explicit approval, run the package-installed CLI from the control repository:

```bash
node .github/aw/activity/cao.mjs add githubnext/gh-aw-cao/<package-slug>@<catalog-commit>
```

Forward additional package-installer options only when the user requested them and they do not weaken the reviewed boundary. Do not pass secrets in command arguments.

After installation:

1. Parse `.github/workflows/cao.json` and reject unresolved placeholders.
2. Confirm the new package identity, orchestrator, and workers match the installed `.github/aw/<package-slug>/cao.json` declaration.
3. Confirm global scope, package mode, exact target overrides, worker settings, and unrelated package settings did not broaden or change. A newly added package must remain in review unless the user separately requests and approves a policy change.
4. Run `gh aw doctor --dir .` and report any incomplete prerequisites without bypassing them.
5. Review `git diff` for package-owned files and policy changes. Do not commit, push, enable workers, dispatch workflows, or promote live mode unless the user explicitly asks.

Report the selected package, catalog commit inspected, installed orchestrator and workers, safety-relevant capabilities, policy preservation result, validation result, and any next approval required.