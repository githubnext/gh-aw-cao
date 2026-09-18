# Repo Assist

> [!NOTE]
> **Experimental campaign:** Worker boundaries and output contracts may change as review evidence accumulates.

Repo Assist makes bounded progress on enrolled repositories. Its orchestrator ranks current maintenance signals and dispatches at most three applicable workers per selected repository.

## Campaign Contents

| Workflow | Responsibility |
| --- | --- |
| [`repo-assist`](../.github/workflows/repo-assist.md) | Weekly and manually dispatchable orchestrator that ranks repositories and applicable workers. |
| [`repo-assist-issue-triage`](../.github/workflows/repo-assist-issue-triage.md) | Advances one open issue with evidence-backed labels, guidance, or a clarification request. |
| [`repo-assist-issue-fix`](../.github/workflows/repo-assist-issue-fix.md) | Implements one confidently bounded issue fix and validates the patch. |
| [`repo-assist-maintenance`](../.github/workflows/repo-assist-maintenance.md) | Implements one low-risk engineering, code, documentation, performance, testing, or hygiene improvement. |
| [`repo-assist-pr-upkeep`](../.github/workflows/repo-assist-pr-upkeep.md) | Repairs one owned Repo Assist pull request with an actionable code blocker. |

Workers are independently dispatchable and handle exactly one authorized target repository. Review mode routes issue findings to the control repository and publishes proposed patches as review-bundle artifacts. Live mode may label or comment on a selected issue, create a draft pull request, or update an owned Repo Assist pull request branch.

## Install

Install from a reviewed catalog release into a Central Agentic Ops control repository:

```bash
gh aw add githubnext/gh-aw-cao/repo-assist@<catalog-release>
```

Configure the campaign in `.github/workflows/cao.json`:

```json
{
  "version": 1,
  "control-plane": {
    "campaigns": {
      "repo-assist": {
        "mode": "review",
        "max-repositories": 1,
        "workers": {
          "issue-triage": { "workflow": "repo-assist-issue-triage" },
          "issue-fix": { "workflow": "repo-assist-issue-fix" },
          "maintenance": { "workflow": "repo-assist-maintenance" },
          "pr-upkeep": { "workflow": "repo-assist-pr-upkeep" }
        }
      }
    }
  }
}
```

Keep eligible owners and repositories bounded under `control-plane.scope`. The campaign defaults to review mode; installation does not grant live authority.

## Validate

Compile the installed workflows, then run one explicit review target:

```bash
gh aw compile --strict --schedule-seed OWNER/CONTROL-REPOSITORY
gh aw run repo-assist --ref main \
  --raw-field target_repo="OWNER/REPOSITORY" \
  --raw-field max_repos="1" \
  --raw-field rollout_percent="100" \
  --raw-field safe_output_mode="review"
```

Review the orchestrator report, worker runs, central review issues, and review-bundle artifacts. Confirm that the target repository was not changed before considering a separately reviewed live-mode policy change.

## Safety Boundaries

- CAO policy decides whether and where the campaign may run; workflow capabilities do not grant rollout authority.
- Orchestrators only rank and dispatch. Workers cannot discover repositories, dispatch more work, or widen mode.
- GitHub reads use scoped tools. Repository mutations use declared safe outputs only.
- Stable titles and machine markers prevent equivalent issues, fixes, maintenance proposals, and upkeep attempts from being recreated.
- New dependencies, breaking changes, speculative refactors, infrastructure-only retries, and human-owned pull request updates are excluded.
- Optional consumer steering belongs in `.github/cao/repo-assist.md` and cannot expand authority or capabilities.

## Operational Value

Each worker registers a deterministic one-shot operational-value evaluator:

| Worker | Primary metric | Attained evidence |
| --- | --- | --- |
| Issue Triage | `bounded-issue-triage-request` | One issue receives a bounded target-repository triage request, or review mode produces equivalent decision evidence. |
| Issue Fix | `decision-ready-issue-fix-request` | One target-bound patch request includes a stable issue identity, root cause, action, and validation evidence. |
| Maintenance | `decision-ready-maintenance-patch` | One target-bound improvement request includes a stable work identity, evidence, rationale, action, and validation. |
| PR Upkeep | `target-bound-pr-repair-request` | One identified Repo Assist pull request receives a bounded repair request, or review mode produces equivalent patch evidence. |

The evaluators grade validated requests available in the current run. They do not treat a requested issue, pull request, comment, label, or branch update as applied, accepted, or merged. Missing target evidence and explicit no-op outcomes remain `null`; malformed, inconsistent, or off-target requests score `0`.

## Pause or Stop

Set `control-plane.campaigns.repo-assist.enabled` to `false` in a reviewed policy change and cancel active runs. Disable an individual worker for a narrower stop. Re-enable in review mode after resolving the incident.