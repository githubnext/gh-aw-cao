# Repo Assist

> [!NOTE]
> **Experimental campaign:** Worker boundaries and output contracts may change as review evidence accumulates.

Repo Assist makes bounded progress on enrolled repositories. Its orchestrator ranks current maintenance signals and dispatches at most three applicable workers per selected repository.

## Campaign Contents

| Workflow | Responsibility |
| --- | --- |
| [`repo-assist`](../.github/workflows/repo-assist.md) | Runs every six hours or on manual dispatch to rank repositories and applicable workers. |
| [`repo-assist-issue-triage`](../.github/workflows/repo-assist-issue-triage.md) | Advances one open issue with evidence-backed labels, guidance, clarification, or live Copilot assignment. |
| [`repo-assist-issue-fix`](../.github/workflows/repo-assist-issue-fix.md) | Implements one confidently bounded issue fix and validates the patch. |
| [`repo-assist-maintenance`](../.github/workflows/repo-assist-maintenance.md) | Implements one low-risk engineering, code, documentation, performance, testing, or hygiene improvement. |
| [`repo-assist-pr-upkeep`](../.github/workflows/repo-assist-pr-upkeep.md) | Repairs one owned Repo Assist pull request with an actionable code blocker. |

Workers are independently dispatchable and handle exactly one authorized target repository. Review mode routes issue findings to the control repository and publishes proposed patches as review-bundle artifacts. Live mode may label or comment on a selected issue, assign one actionable issue to Copilot, create a draft pull request, or update an owned Repo Assist pull request branch.

## First run

After [setting up the control repository](../docs/setup-quickstarts.md), install
the campaign with `gh cao add githubnext/gh-cao/repo-assist`.
For a first review, explicitly select one existing target in policy and enable
only the existing maintenance worker in review mode. Issue triage, issue fix,
and PR upkeep remain disabled. No demo repository or special worker is created.

Maintenance proposes **one small validated patch** in a control-repository
review issue and downloadable review bundle, or records a **no-op** if nothing
appropriate fits. It never changes the target repository.
Proposals are optional, not requirements for using CAO. There are no readiness
grades, required templates, or practice checklists; repositories do not need
existing Agentic Workflows, Actions history, tests, CI, or `AGENTS.md`.

This uses the normal workflow budgets: **250 AI credits** for the orchestrator
and **600** for maintenance, plus the model-based output check (**400** by
default, configurable in gh-aw). The default total is **1,250 AI credits**,
not expected consumption or a measured token count. Normal validation and
review-bundle behavior are unchanged.

Review and commit workflows and policy together, push, and check CAO validation
before requesting work. See the manual
[Repo Assist walkthrough](../docs/repo-assist-quickstart.md) for installation,
dispatch, Activity collection, and dashboard checks.

Enabling the orchestrator also resumes its six-hour schedule. For one manual
run, disable it immediately after dispatch, including if dispatch fails:

```bash
gh workflow enable repo-assist.lock.yml
gh aw run repo-assist --ref main \
  --raw-field target_repo="OWNER/REPOSITORY" \
  --raw-field safe_output_repo="OWNER/CONTROL_REPOSITORY" \
  --raw-field max_repos="1" \
  --raw-field safe_output_mode="review"
gh workflow disable repo-assist.lock.yml
```

Re-enabling also resumes the six-hour schedule. Disable the orchestrator again
after a manual run if you do not want recurring work. Enable additional workers
or live mode only through a separate reviewed policy change.

Copilot assignment uses the `assign-to-agent` safe output and requires Copilot coding agent availability on the target plus a `GH_AW_AGENT_TOKEN` Actions secret with the assignment permissions required by gh-aw. Both the issue and resulting pull request stay in the authorized target repository. Already assigned issues and active fixes are skipped. Review mode never starts a coding agent; maintainers review the suggested prompt before delegation. Assignment does not grant merge authority.

## See Repo Assist in action

The first run demonstrates Maintenance only. Explore the broader campaign
through these real, historical review-mode reports from our
[`githubnext/gh-cao` control repository](https://github.com/githubnext/gh-cao).
They are not canned demo data or a promise that every run finds work.
Reading these reports does not start a workflow or spend AI credits.

| Capability | Observed report and outcome |
| --- | --- |
| Issue triage | [#17740](https://github.com/githubnext/gh-cao/issues/17740) diagnoses a runtime import failure in `githubnext/gh-cao`, explains the evidence, and gives a maintainer action and acceptance checks. [Originating run](https://github.com/githubnext/gh-cao/actions/runs/38399472881). |
| Issue fix | [#17851](https://github.com/githubnext/gh-cao/issues/17851) proposes a patch for false dashboard integration-test failures in `githubnext/gh-cao`, with 12 focused tests reported passing and full-suite baseline failures disclosed. [Originating run](https://github.com/githubnext/gh-cao/actions/runs/38493105790). |
| Maintenance | [#17378](https://github.com/githubnext/gh-cao/issues/17378) proposes a lockfile-sync correction in `githubnext/gh-cao`, with before/after `npm ci --dry-run` evidence and an infrastructure limitation on full installation disclosed. [Originating run](https://github.com/githubnext/gh-cao/actions/runs/38119485916). |
| PR upkeep | [#14060](https://github.com/githubnext/gh-cao/issues/14060) reviews a blocker on `github/gh-aw#56568` and identifies a maintainer design decision rather than inventing a repair. No new patch was made, and the [originating run failed](https://github.com/githubnext/gh-cao/actions/runs/36227760220); this is not a successful repair example. |

These outcomes were checked on 2026-10-14. They show analysis and proposed work,
not proof that a patch was applied, accepted, or merged. Historical reports may
be automatically closed and workflow artifacts may expire; closure alone is
not acceptance. Inspect the report's evidence and originating run rather than
equating workflow success with an applied improvement.

Reading the showcase does not enable workers. Issue triage, issue
fix, PR upkeep, recurring operation, and live authority remain explicit,
separately reviewed choices. Keeping the repository unchanged is valid.

## Install

Install from a reviewed catalog release into a Central Agentic Ops control repository:

```bash
gh cao add githubnext/gh-cao/repo-assist
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

Each worker registers a deterministic one-shot operational grader through gh-aw's `operational-value` protocol:

| Worker | Primary metric | Attained evidence |
| --- | --- | --- |
| Issue Triage | `bounded-issue-triage-request` | One issue receives a bounded target-repository triage request, or review mode produces equivalent decision evidence. |
| Issue Fix | `decision-ready-issue-fix-request` | One target-bound patch request includes a stable issue identity, root cause, action, and validation evidence. |
| Maintenance | `decision-ready-maintenance-patch` | One target-bound improvement request includes a stable work identity, evidence, rationale, action, and validation. |
| PR Upkeep | `target-bound-pr-repair-request` | One identified Repo Assist pull request receives a bounded repair request, or review mode produces equivalent patch evidence. |

The evaluators grade validated requests available in the current run. They do not treat a requested issue, pull request, comment, label, or branch update as applied, accepted, or merged. Missing target evidence and explicit no-op outcomes remain `null`; malformed, inconsistent, or off-target requests score `0`.


## Pause or Stop

Set `control-plane.campaigns.repo-assist.enabled` to `false` in a reviewed policy change and cancel active runs. Disable an individual worker for a narrower stop. Re-enable in review mode after resolving the incident.