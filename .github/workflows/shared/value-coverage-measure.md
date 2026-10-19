---
---

For your fixed measurement lane N, run `node operational-value-coverage/sweep.mjs
. "$REVIEW_OUTPUT_REPO" N`. This ignores your own running lane for assignment,
while respecting other runs and PR claims. Work only on your lane's first
`readyCohorts` entry and its listed keys. No ready cohort is a noop. Open PRs
for earlier cohorts do not prevent selecting later ready cohorts. Within that cohort, operate
only on pending/rework entries below the attempt ceiling. Group acquisition
reuse, never native formulas. Keep all proposed files under
`operational-value-coverage/work/measure-N/COHORT/KEY/`, replacing N with your
fixed lane. Do not edit predecessors, the global ledger or report index.

For `author`, propose the per-workflow contract, adoption/source-history plan,
native quantity, evidence interface, acceptance and deterministic evaluator
with positive/negative/missing/malformed fixtures. Do not measure; request human
approval of a new pinned plan. For `measure`, use only the already approved
contract and retained inputs; deterministic collection/scoring/replay/rendering
must not call a model. Execute the pinned evaluator's focused tests.
For `validate`, inspect existing reports only; never recompute or count a new
native evaluation for an already measured workflow.

Use the already-computed daily-file-diet entry and its linked lifetime evidence,
timeline, definitions and HTML/JSON pulse as the reporting-completeness example,
not a new work item and never a formula template for another workflow. Supply
the twelve checks in `reportingChecklist` from `report.mjs`, with digest-pinned
evidence and explicit limitations. Native partial outcomes remain separate from
full acceptance, safeguards, historical coverage and receipt-strength subsets.
All-unknown results are gap reports, not native evaluations. Unknown is null;
do not invent history, costs, keep bars, exclusive causation or zero outcomes.

Submit one isolated PR for the cohort with manifests and a proposed receipt per
work key. Include an exact `<!-- value-coverage-work:KEY:ATTEMPT -->` marker
for every proposed key, using the ledger-derived next attempt (1 or 2). These
machine-readable markers let the controller keep other cohorts moving without
redispatching submitted work. A submitted receipt is not accepted; only independent integration
followed by human review can advance global coverage. At most two attempts;
record bounded blockers rather than retrying or downloading missing evidence.
