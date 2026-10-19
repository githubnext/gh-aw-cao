---
name: add-cao-campaign
description: "Discover, compare, recommend, or install an existing Central Agentic Ops (CAO) catalog campaign. Use when a user wants to browse the CAO catalog, find an operation for an outcome, compare campaigns, or add a campaign to a control repository safely."
metadata:
  argument-hint: "Describe the desired operational outcome or name a CAO catalog campaign"
---

# Add a CAO Campaign

## Procedure

1. Verify the control plane and resolve one immutable catalog commit.
2. Discover eligible campaigns from structured manifests at that commit.
3. Recommend at most three matches with safety tradeoffs and `None of these`.
4. Require selection and explicit installation approval.
5. Install through `gh cao campaigns add`, validate policy preservation, and report.

Choose from the current catalog. Never use a hard-coded list or silently select
or install a campaign.

## Deterministic boundary

The agent interprets intent, compares candidates, and explains tradeoffs.
After selection, `gh cao campaigns add` owns package resolution,
installation, policy merging, and installed-declaration validation. Use
`gh cao doctor` and `gh aw doctor --dir .` for local checks; inspect CAO validation
in Actions after approved changes are published. Do not reimplement package or
policy mutation.

## Boundaries

- Use `create-cao-campaign` to author a new campaign or when none fits.
- Require `.github/workflows/cao.json` and installed `gh cao`; hand off to
  `setup-cao` when the control repository is not initialized.
- Keep discovery read-only until the user sees the recommendation and safety
  summary, selects a campaign, and approves installation.
- Install through `gh cao campaigns add`, which validates the declaration and merges
  policy without enabling live mode or broadening scope.
- Never edit generated `.lock.yml` files or `.github/aw/campaigns/*.json` ownership records directly.
- Treat all installed campaign package sources as immutable. Add requested prompt guidance only through the consumer-owned `.github/cao/<campaign-slug>.md` file loaded by the installed workflows' optional `runtime-import`; do not patch installed workflow Markdown or other package-owned files.

## Discover the Catalog

1. Verify GitHub authentication with `gh auth status`.
2. Resolve the `githubnext/gh-cao` default-branch commit once and use it for
   every inspected file to prevent mixed-revision recommendations.
3. Enumerate top-level directories at that commit. A candidate operational campaign must contain both `aw.yml` and `cao.json` in the same directory.
4. Parse each candidate's `aw.yml` as YAML and `cao.json` as JSON. Do not infer metadata with regular expressions. Exclude campaigns with `private: true`; label campaigns with `experimental: true` clearly.
5. Read each remaining manifest, README, CAO declaration, orchestrator, and
   worker from the same commit. Derive outcomes from files, not names.

If authentication, catalog access, parsing, or revision consistency fails, stop
and report discovery as incomplete. Do not guess from partial catalog data.

## Recommend

When no campaign is named, ask for the operational outcome. Recommend no more than three installable campaigns, ordered by fit. For each, summarize:

- the outcome it targets;
- its orchestrator and worker responsibilities;
- whether it is experimental;
- notable permissions, network access, credentials, and safe outputs;
- the main tradeoff or reason it may not fit.

Include `None of these`. Require one exact selection; a vague outcome, first
recommendation, or no response is not consent. If none fits, offer the
`create-cao-campaign` handoff without installing.

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
gh cao campaigns add githubnext/gh-cao/<campaign-slug>@<catalog-commit>
```

Forward additional campaign-installer options only when the user requested them and they do not weaken the reviewed boundary. Do not pass secrets in command arguments.

After installation:

1. Parse `.github/workflows/cao.json` and reject unresolved placeholders.
2. Confirm the new campaign identity, orchestrator, and workers match the installed `<campaign-slug>/cao.json` declaration.
3. Confirm global scope, campaign mode, exact target overrides, worker settings, and unrelated campaign settings did not broaden or change. A newly added campaign must remain in review unless the user separately requests and approves a policy change.
4. Run `gh aw doctor --dir .` and report any incomplete prerequisites without bypassing them.
5. Review `git diff` for campaign-owned files and policy changes. Reject any customization of installed package sources; when the user requested additional prompting, confirm the only prompt customization is `.github/cao/<campaign-slug>.md`. Do not commit, push, enable workers, dispatch workflows, or promote live mode unless the user explicitly asks.

Report the selected campaign, catalog commit inspected, installed orchestrator and workers, safety-relevant capabilities, policy preservation result, validation result, and any next approval required.