# Value Coverage

Complete the **reporting and evidence disposition** of a frozen workflow
inventory without pretending every workflow is natively measurable. This
campaign builds on the existing operational-value skill and portfolio, not a
replacement scoring system or an agentic version of the dashboard.

**Shipped state: disabled, review-only, no active plan.** Installing
the catalog package does not authorize execution. This source-managed control
repository's `cao.json` disables the campaign and every worker. There is no
automatic acquisition, publishing, merge or target write. A deterministic
15-minute controller is installed but cannot wake agents while policy is disabled.

## Pipeline and ownership

| Workflow | Bounded responsibility |
| --- | --- |
| `operational-value-coverage` | Reconcile inventory, select ready work, dispatch only |
| `value-coverage-pump.yml` | Check the full-inventory ledger/PR/run state and wake the orchestrator only when work is ready |
| `value-coverage-measure-1` through `-4` | One cohort per fixed lane, 1-5 workflows, isolated draft PR |
| `value-coverage-integrate` | Independent validation and one serial integration/report PR |
| `value-coverage-skill` | One evidence-backed regression/skill proposal, never live self-modification |

Four distinct measurement IDs preserve CAO's worker/target/mode deduplication.
Each is repository-serialized with cancellation disabled; an occupied lane or
open work-key PR suppresses duplicate work, not other ready cohorts in that lane.
There are at most four simultaneous
measurement runs, not four cohorts per workflow. Prefer 3-5 related workflows
per cohort only where evidence reuse is compatible. Every native contract
remains per workflow. No worker discovers targets or dispatches other workers.

The control repository owns all proposals and the report index. Measurement
PRs can write only their lane's staging directory. The integration worker alone
can propose changes to the existing report generator and global artifacts;
human review/merge remains the publishing approval boundary. It never deploys
Pages. The root `aw.yml` intentionally continues to install Activity and the
deterministic Dashboard only; this campaign is an opt-in catalog package.

Install into an existing CAO control repository with `gh aw add
githubnext/gh-aw-cao/operational-value-coverage@REVIEWED_COMMIT`, then run
`node .github/workflows/shared/materialize-cao.mjs materialize
operational-value-coverage`. As with the other CAO campaigns, the materializer
provides the campaign-directory helpers; they are not gh-aw manifest resources.
Keep the campaign disabled until the prerequisites below are reviewed.

## One automatic full-inventory pass

The first pass covers the entire frozen inventory, not a pilot or phased
rollout. Add `scope: "full-inventory"` to the reviewed plan and assign **every**
inventory workflow exactly once. Already measured workflows, including File
Diet, are validation-only. Missing native contracts use `author` tasks: draft
them without scoring, obtain human review, then pin the approved instruments
in a new reviewed plan. Contract proposals never count as native evaluations.

Freeze the baseline portfolio and its linked partitions outside the live
report output directory (for example under
`.github/cao/operational-value-coverage/snapshots/`). Set `portfolioPath` and
its pins to that immutable copy. Integration may update the published report
without invalidating the frozen input or claiming that an evolving denominator
is the original full inventory.

After the reviewed installation/plan/enablement reaches the control repository's
default branch, the controller checks every 15 minutes. It uses the existing
`gh aw run` entry point to wake the review-only orchestrator; no custom token,
agent loop, direct worker dispatch or new campaign-wide credit cap is added.
Existing gh-aw per-run limits and platform permissions still apply. Four lanes
are a throughput setting, not a pilot: idle lanes continue with later cohorts
even while earlier PRs await review. There is no new per-cohort go/no-go gate.

The read-only `node operational-value-coverage/sweep.mjs . OWNER/CONTROL`
reports `ready`, `running`, `waiting-for-review`, `blocked`, or `complete`.
Disabled/missing/proposed plans are reported without API acquisition or agent
startup. Invalid plans/pins and API failures fail visibly. Fully terminal
ledgers suppress further agent runs; blocked/rejected work does not spin.
Completion requires accepted native/partial reports or reviewed unavailable
dispositions for **every** inventory entry, not merely exhausting a subset.
Reviewing contracts, merging code and accepting integration PRs remain human
actions. Skill changes still require a new pinned plan.

Staging PRs carry `<!-- value-coverage-work:KEY:ATTEMPT -->` markers. Integration
PRs carry the shared snapshot's `integrationMarker`, binding the plan and
reviewed ledger. The controller reads labeled PR metadata and active Actions
runs only; these claims prevent duplicates but cannot establish acceptance.
Only the reviewed receipt ledger can do that.

## Evidence and approval boundary

Start from the existing report's `portfolio.json.gz` and digest-linked workflow
partitions. `coverage.mjs inventory` validates those partitions and reconciles
counts from actual rows. It does not treat output counts as outcomes. The
current retained integration is commit
`c576d538cf9a8463d8d8a7d1de852f90358dfa3c`; inventory revisions/cutoffs are read
from the report, never inferred from that control repository commit.

```sh
node operational-value-coverage/coverage.mjs inventory . \
  docs/operational-value/gh-aw-workflows/portfolio.json.gz
```

Before activation, a human reviews and merges
`.github/cao/operational-value-coverage/active.json`, alongside an initial
`.github/cao/operational-value-coverage/receipts.json` containing `[]`.
Both are control-repository-owned records, never installed or overwritten by
the campaign package/materializer. The plan schema is enforced by
`validatePlan()`:

- `schemaVersion: 1`, stable `id`, `status: "approved"`, exact `repository`,
  `sourceRevision`, `until`, `portfolioPath` and `portfolioSha256` (SHA-256 of the parsed
  portfolio serialized with `JSON.stringify`).
- `instrumentRevision`: immutable control-source commit; `pins` contains
  `{path, sha256}` byte digests for the skill, pipeline helpers and the **entire
  transitive evaluator/helper/oracle/evidence closure**, including archive
  partitions. No mutable refs or target-provided approval records.
- `limits: {measurementLanes: 4, cohortSize: 5, maxAttempts: 2}`. Changes to
  capacity require another reviewed pipeline change, not a dispatch input.
- `cohorts`: stable `id`, fixed `lane` (1-4), evidence `compatibility` rationale,
  and 1-5 `workflows`. Each entry has `id`, `sourceGitBlob`, pinned contract
  `path`/`sha256`, `dependencies` (pinned paths), `acceptance`, `limitations`,
  `design` (`ex-ante` or `outcome-informed-retrospective`) and `task`.
- `task: "author"` authorizes only a contract proposal before outcome
  inspection; `task: "measure"` requires a separately reviewed frozen
  instrument and an unmeasured workflow; `task: "validate"` checks retained
  reports without recounting native coverage. The campaign does not grant blanket batch approval to new
  formulas. Preserve stricter predecessor measures and rejected predicates.
- `acquisition`: exact repository/cutoff, `status: "retained"` with pinned
  `index`/`sha256`, or `status: "blocked"` with a visible `reason`.

There is deliberately no generated "approved" plan. Plan merge and policy
activation are separate approvals. A plan grants no repository reach, runtime,
network or write authority. Installed consumers must retain the existing
measurement/reporting integration and provide its reviewed evidence paths;
this small campaign package does not ship the large research evidence corpus.

`instrumentFiles(root)` enumerates the required pipeline files, skill contract
and every installed skill script/asset. Pin all of them, not only `SKILL.md`;
missing or changed implementation pins stop admission. Contract-specific
collectors, oracle helpers and retained evidence are separately pinned
dependencies of each workflow.

Use the existing Activity cache and `activity/cao.mjs` for bounded discovery,
after checking schema, scope, freshness and completeness. Reuse the retained
`collect-output-history.mjs` archive for shared lineage; it covers issues/PRs,
not Discussions/comments or proof of native outcomes. Never query a browser
IndexedDB instance as an operational service.

Missing originals require a separately authorized, single-owner deterministic
acquisition using the existing collector's `--request-budget 200 --resume`,
one producer per repository/cutoff. Preserve original responses, immutable
identity, acquisition time and digest-linked partitions. Stop on quota,
Retry-After or authorization failure; do not retry in measurement workers.
No new acquisition was authorized by adding this campaign. Cached facts do not
repair expired historical evidence or widen policy.

## Restartable work ledger

```sh
node operational-value-coverage/coverage.mjs ledger . \
  docs/operational-value/gh-aw-workflows/portfolio.json.gz \
  .github/cao/operational-value-coverage/active.json \
  .github/cao/operational-value-coverage/receipts.json
node operational-value-coverage/coverage.mjs select . \
  docs/operational-value/gh-aw-workflows/portfolio.json.gz \
  .github/cao/operational-value-coverage/active.json \
  .github/cao/operational-value-coverage/receipts.json 1
```

The deterministic ledger is derived, not another evidence database.
`workKey()` binds the complete plan digest, repository, source blob, workflow,
contract digest and cutoff. Fixed assignments and stable PR keys prevent
parallel ownership races. Advisory repo memory holds at most 100 short-lived
references, never authoritative claims. The checked-in receipt log is updated
only through the integration PR after comparing the latest accepted state.

Receipts contain `key`, `attempt`, `status`, `reason`. A submitted attempt can
advance to accepted/rework/blocked without consuming a new attempt. Exact
duplicate events are idempotent; conflicting or unordered events fail closed. Terminal
`accepted-native`, `accepted-partial` or `unavailable` additionally require
the measurement code's human-reviewed `reviewCommit` and
`reportManifestSha256`. Submitted work is not accepted. `blocked` needs a
reviewed acquisition/disposition decision; `rework` can retry only within the
two-attempt ceiling. A new plan preserves the old receipts as historical
records, rather than silently reusing them under changed semantics.

## File Diet reporting acceptance

The already-computed `daily-file-diet` entry is the completeness reference, not
another backlog item. Inspect its published pulse, retained
`proof/reports/file-diet-value-events.json`, lifetime evidence, original frozen
module, timeline and definitions. Its stronger lifetime delivery report and its
original snapshot contract are distinct; neither replaces the other.

`report.mjs` exposes twelve required checks: intent/effective executor,
adoption/predecessors, frozen native contract, collector/independent replay,
evidence identity/cutoff, timeline/definitions, HTML/JSON plot,
repository outcome/contribution, partial/full attainment,
safeguards/attribution, historical/missing-vs-zero coverage, costs/unrated
decision. Each check records `status` (`verified` or `unavailable`), a specific
`reason` and pinned `evidence` paths. Equivalent completeness means explaining
every dimension, not copying File Diet's outcome formula or fabricating facts.

A report manifest has `schemaVersion: 1`, work `key`, `repository`, `workflow`,
`disposition` (`native`, `partial`, `unavailable`), `nativeEvaluated`, `files`
(`{path,sha256}`), `checks`, `decision` (`rated`, `not-rated`), `cost` (`matched`,
`not-measured`) and `limitation`. Native/partial manifests name pinned
`timeline`, `definitions`, `plotInput`, `pulseJson`, `pulseHtml`, plus an
evaluated `metricId` (primary for native, explicitly named for partial); unavailable
manifests retain a `blocker` and cannot claim native evaluation.

```sh
node operational-value-coverage/report.mjs . \
  .github/cao/operational-value-coverage/active.json WORKFLOW MANIFEST.json
```

The structural gate delegates timeline validation, signal semantics and plot
rendering to the existing skill. It verifies hashes, identity, cutoff and exact
HTML/JSON parity without reimplementing query or measurement semantics.
Independent native replay and semantic review are **additional required
checks**, not a claim a manifest can self-certify. In particular, File Diet's
48 structural reductions and 13 receipt-strength subset must stay separate
from unknown behavior preservation, full acceptance, costs and causation.
No recomputation or new File Diet coverage is needed to verify its existing
artifact path.

## Scale feedback and worker evaluation

After each accepted integration, record accepted **new** native evaluations
per elapsed hour, outcome-matched credits per accepted evaluation, and
rework/attempt fraction in the integration evidence. `progressMetrics(plan,
receipts, executions, startAt, endAt)` computes these from a bounded acceptance
batch and distinct `{key, attempt, aiCredits}` execution records; validation
tasks do not count as new evaluations. Keep null for unavailable
costs or an empty denominator. Do not optimize for generated reports, closed
issues, attempted workflows or completed dispositions. Increase concurrency
only after these observations justify a separately reviewed change.

No per-run operational-value evaluator is installed for these workers yet:
their useful outcome is independently reviewed, durable coverage improvement
or a regression-preventing skill change, which matures **after** a worker ends.
An agent's proposal, structural checker or successful run cannot deterministically
prove that outcome from its session. Lane/integration/skill outcomes therefore
remain unmeasured, not zero. A future reviewed evaluator can use merge-bound
acceptance receipts plus native replay; it must exclude author-only proposals,
rework, old accepted measurements and gap dispositions from native gains.

## Activation prerequisites

Review the campaign PR, authorize the exact repository and review destination,
merge the pinned plan/contracts/evidence, confirm configured read/write App or
PAT access, then separately review enablement in control `cao.json`. Shared
control resolves policy at the workflow SHA. Do not change live authority,
target scope, schedules, cost/resource authority or merge policy as part of
measurement approval. No backlog execution is part of this implementation.
