---
name: integrate-cao-workflow
description: Integrate an existing agentic workflow as a locally maintained CAO standalone variant with admission, review policy, authentication, and safe-output routing.
metadata:
  argument-hint: "Workflow, control repository, and exact target"
---

# Integrate a Workflow with CAO

Adapt an existing workflow, not a campaign or new CLI command. `gh aw add` and
`gh aw update` retain upstream installation ownership. Integration requires
reasoning about repository selection, credentials, and outputs, not just YAML.

## Procedure

1. Load `agentic-workflows` and follow its existing-workflow update route.
   Read the policy, `shared/control.md`, its dependencies,
   and the [standalone contract](https://github.com/githubnext/gh-cao/blob/main/docs/configuration.md#standalone-agentic-workflows).
   If CAO is absent, use `setup-cao` separately; do not invent runtime files or
   configure credentials as a side effect of integration.
2. Inspect the installed Markdown, imports, compiled workflow, upstream
   reference and resolved revision, and ownership metadata. Trace all triggers,
   repository assumptions, checkout and tool authentication, reads, writes,
   and safe outputs, including updates, comments, labels, and closing old reports.
   Consult pinned `gh aw` help; never guess syntax.
   If installation is needed, use `gh aw add` only with explicit approval.
3. Prepare a **locally maintained variant** with a distinct filename slug,
   such as `repo-status-cao`. Leave upstream-managed source and ownership
   metadata unchanged. Record upstream path, revision, and manual update
   responsibility. Do not claim that
   `gh aw update` will maintain the variant or that a wrapper preserves semantics
   without verifying the pinned compiler's import behavior.
4. Preserve the original mission, engine, tools, and capability limits unless a
   necessary change is explained and approved. Start with manual dispatch only;
   do not copy an active schedule or event trigger into the new variant.
   Document the later cutover so the original and variant never both run the
   same scheduled mission. Do not disable the original automatically.
5. Add `shared/control.md` with `role: standalone` and
   `workflow: <exact-variant-slug>`. Preserve existing activation conditions
   while adding the pre-activation admission output and fail-closed activation
   gate from the maintained contract and
   [compilation fixture](https://github.com/githubnext/gh-cao/blob/main/tests/fixtures/workflows/fleet-audit.md).
   Pre-activation requires `contents: read` and `actions: read`. Pass every
   required GitHub read permission through its matching `read_<permission>`
   input and bind tools to the admitted repository's scoped read credential.
   Do not replace the workflow's engine or widen tool, network, or write access.
6. Add only the exact variant under `control-plane.workflows` in `cao.json`.
   Default to `enabled: false`, `mode: review`, `max-mode: review`,
   `max-repositories: 1`, and an explicitly identified in-scope target.
   Do not broaden global scope, change existing declarations, enable the
   variant, or promote any target to live without explicit approval.
   No campaign or worker records are needed.
7. Adapt the mission to read `/tmp/gh-aw/agent/control-precompute.json` and act
   only on admitted candidates, using each candidate's `safe_output_mode` and
   `safe_output_repo`. Empty admission is a no-op; unavailable or invalid
   evidence is incomplete, never a reason to discover additional targets.
   Explicitly replace source-repository assumptions in reads and checkout.
8. Route every declared safe output to the resolved destination using supported
   gh-aw configuration, repository allowlists, and existing credentials.
   Review mode executes the agent and may create review outputs; it is not a
   no-write simulation. Never redirect only issue creation while leaving
   close-older-issues, edits, comments, or other mutations targeting production.
   Direct write tools, external publishing, cross-repository issue references,
   unsupported routing, or insufficient credentials are blockers to resolve,
   not effects made safe merely by importing control. Use an artifact-backed
   review bundle for target-bound effects only where the contract supports it.
9. Compile with the policy-pinned `gh aw` and required repository flags.
   Never edit `.lock.yml` by hand. Validate policy and inspect generated gates,
   authentication, destinations, and triggers. Add focused contract and
   compilation tests covering undeclared/disabled denial, empty admission,
   a bounded review target, routed outputs, and denial of mode widening.
   Distinguish static validation from live proof; compilation alone cannot
   establish that the agent follows its mission or that credentials work.
10. Present the diff, provenance, update responsibility, validation, capability
    changes, and blockers. Keep source, lock, and policy in one reviewed revision.
    Do not commit, push, dispatch, enable, alter remote secrets, or activate a
    schedule unless separately requested. Live review proof requires approval:
    verify the review destination changed while the target did not.

## Daily Repo Status example

Resolve `githubnext/agentics/workflows/daily-repo-status.md` and its current
redirect before adapting it. Route issue creation, labels, and
`close-older-issues` to review. The `repo-status-cao` variant reports on admitted
targets, not implicitly on the control repository. The unmodified upstream
workflow is not CAO-integrated.

## Guardrails

- CAO controls whether and where; gh-aw controls execution capabilities.
  Credential reach is not rollout authority.
- Keep secrets in Actions secrets, never source, policy, prompts, or reports.
- Never edit campaign ownership records or upstream install metadata to
  disguise a local variant as an automatically updated upstream workflow.
- Do not run an incomplete integration. Report blockers explicitly rather
  than claiming success after adding an import or policy entry.
