---
name: add-cao-campaign
description: "Discover, compare, recommend, or install an existing Central Agentic Ops (CAO) catalog campaign. Use when a user wants to browse the CAO catalog, find an operation for an outcome, compare campaigns, or add a campaign to a control repository safely."
argument-hint: "Describe the desired operational outcome or name a CAO catalog campaign"
---

# Add a CAO Campaign

Help the user choose and install an existing CAO operational campaign. Discover from the current catalog instead of relying on a hard-coded campaign list. Never silently select or install a campaign.

## Boundaries

- Use this skill for adopting an existing campaign. Use the `create-cao-campaign` skill when the user wants to author a new campaign or no existing campaign fits.
- Work in the intended CAO control repository. Require `.github/workflows/cao.json` and the executable installed CAO CLI at `./cao.sh`; hand off to the `setup-cao` skill when the control plane is not initialized.
- Keep catalog discovery read-only. Do not install anything until the user explicitly selects a campaign after seeing the recommendation and safety summary.
- Install through `cao add`, not the underlying campaign installer directly. The CAO wrapper validates the installed declaration and merges its orchestrator and workers into policy without enabling live mode or broadening repository scope.
- Never edit generated `.lock.yml` files or `.github/aw/campaigns/*.json` ownership records directly.

## Discover the Catalog

1. Verify GitHub authentication with `gh auth status`.
2. Resolve the current default-branch commit for `githubnext/gh-aw-cao` once. Use that immutable commit for every manifest, declaration, README, and workflow inspected during this decision so the recommendation cannot mix catalog revisions.
3. Enumerate top-level directories at that commit. A candidate operational campaign must contain both `aw.yml` and `cao.json` in the same directory.
4. Parse each candidate's `aw.yml` as YAML and `cao.json` as JSON. Do not infer metadata with regular expressions. Exclude campaigns with `private: true`; label campaigns with `experimental: true` clearly.
5. Read each remaining campaign's manifest description, README, CAO declaration, orchestrator source, and worker sources from the same commit. Derive outcomes and tradeoffs from those files rather than campaign names.

If GitHub authentication, catalog access, structured parsing, or revision consistency fails, stop and report discovery as incomplete. Do not guess from a remembered or partial campaign list.

## Recommend

When the user has not named a campaign, ask what operational outcome they want. Recommend no more than three installable campaigns, ordered by fit. For each recommendation, summarize:

- the outcome it targets;
- its orchestrator and worker responsibilities;
- whether it is experimental;
- notable permissions, network access, credentials, and safe outputs;
- the main tradeoff or reason it may not fit.

Include `None of these` as a choice. Require the user to select one exact campaign; do not treat a vague outcome, the first recommendation, or lack of response as consent. If no campaign fits, offer the `create-cao-campaign` handoff without installing anything.

When the user names a campaign, verify it against the same catalog process and still present its safety summary before asking for installation approval.

## Review Before Installation

Before requesting approval, inspect the selected campaign at the resolved commit and report:

- campaign name, slug, catalog commit, and maturity;
- installed orchestrator and workers from `cao.json`;
- workflow permissions, tools, network hosts, credentials, schedules, and AI credit limits;
- safe-output types and whether they remain review-routed by current policy;
- the exact files and campaign record that campaign installation will own;
- the current campaign policy, exact target overrides, and global scope from `.github/workflows/cao.json`.

Treat missing declarations, invalid metadata, inaccessible sources, unresolved placeholders, or conflicts with an existing installed campaign as blockers. Never suggest that credential reach expands CAO policy.

## Install

After explicit approval, run the repository-local CLI from the control repository:

```bash
./cao.sh add githubnext/gh-aw-cao/<campaign-slug>@<catalog-commit>
```

Forward additional campaign-installer options only when the user requested them and they do not weaken the reviewed boundary. Do not pass secrets in command arguments.

After installation:

1. Parse `.github/workflows/cao.json` and reject unresolved placeholders.
2. Confirm the new campaign identity, orchestrator, and workers match the installed `<campaign-slug>/cao.json` declaration.
3. Confirm global scope, campaign mode, exact target overrides, worker settings, and unrelated campaign settings did not broaden or change. A newly added campaign must remain in review unless the user separately requests and approves a policy change.
4. Run `gh aw doctor --dir .` and report any incomplete prerequisites without bypassing them.
5. Review `git diff` for campaign-owned files and policy changes. Do not commit, push, enable workers, dispatch workflows, or promote live mode unless the user explicitly asks.

Report the selected campaign, catalog commit inspected, installed orchestrator and workers, safety-relevant capabilities, policy preservation result, validation result, and any next approval required.