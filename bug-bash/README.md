# Bug Bash

> **Find a bug you can reproduce. Review a fix you can understand.**

> [!NOTE]
> **Experimental campaign:** Worker boundaries, verification gates, and output contracts may change as review evidence accumulates.

Bug Bash is the recommended getting-started campaign for a new Central Agentic Ops control repository. It does one small thing end to end: pick one repository, run one bounded defect investigation, verify the result adversarially, and hand a maintainer either one reviewable finding or an honest `no-finding`.

It is deliberately the least ambitious campaign in the catalog. Nothing is written to the investigated repository, the whole run is review evidence in your own control repository, and a first run that finds nothing is a success, not a failure.

## Campaign Contents

| Workflow | Responsibility |
| --- | --- |
| [`bug-bash`](../.github/workflows/bug-bash.md) | Manually dispatched orchestrator that selects at most one repository and dispatches exactly one investigation. |
| [`bug-bash-investigation`](../.github/workflows/bug-bash-investigation.md) | Runs one bounded investigation phase, then a clearly separate verification phase, and publishes at most one review bundle and one deduplicated review issue. |

| Package file | Purpose |
| --- | --- |
| [`investigation-contract.mjs`](investigation-contract.mjs) | Deterministic outcomes, verification gates, identity, budget split, retry plan, and review-bundle validation. The workflows call it instead of restating the rules. |
| [`intelligence.json`](intelligence.json) | Campaign intelligence declaration: trigger, resource envelope, deduplication, backoff, stop conditions, and the operational-value position. |
| [`fixtures/historical-pilot.json`](fixtures/historical-pilot.json) | Labeled historical pilot evidence from a pre-campaign manual exercise. Not produced by this harness and not a promise of results. |

## Install

```bash
./cao.sh add githubnext/gh-aw-cao/bug-bash
```

Use the control repository's `./cao.sh add` lifecycle command, not a direct `gh aw add`. `cao add` materializes the complete canonical runtime — including `.github/workflows/cao.json` policy — that a direct gh-aw install does not produce. See [repository layout and installation §4.3](../specs/repository-layout-and-installation.md#43-lifecycle-entry-points).

The campaign is runnable once the campaign is declared in checked-in policy. There is no schedule: every run is an explicit decision.

## Configure

Declare the campaign in `.github/workflows/cao.json`:

```json
{
	"version": 1,
	"control-plane": {
		"campaigns": {
			"bug-bash": {
				"mode": "review",
				"max-repositories": 1,
				"workers": {
					"investigation": { "workflow": "bug-bash-investigation", "max-mode": "review" }
				}
			}
		}
	}
}
```

`max-mode: review` caps the worker at review mode regardless of the campaign's resolved mode. Set shared owner and repository boundaries under `control-plane.scope`.

A schedule is opt-in. Add one only after you have read several runs and decided the campaign earns a recurring slot.

## Validate in review mode

1. Open the generated **Bug Bash** workflow in your control repository's **Actions** tab.
2. Select **Run workflow**.
3. Set `target_repo` to `githubnext/gh-aw-cao`, or leave it blank to let discovery choose an admitted candidate.
4. Keep `max_repos` at `1` and `safe_output_mode` at `review`.
5. Read the dispatched investigation's issue in the control repository, and the review bundle artifact when one was published.

### Starter target

| Field | Value |
| --- | --- |
| Repository | `githubnext/gh-aw-cao` |
| Revision | `5263be06676f6b3509a55bd2937a488c941c6aac` |
| Focus | `eslint-rules/rules-db.mjs`, `tests/unit/eslint-rules-db.test.mjs` |

The revision is an immutable commit SHA, not a branch, so a later push cannot quietly change what "reproduced" means. The focus is a small standard-library-only module with an existing test file, so the run fits the budget and two runs are comparable.

## Outcomes

Every run ends in exactly one outcome, computed by `investigation-contract.mjs` rather than asserted in prose:

| Outcome | Meaning |
| --- | --- |
| `no-finding` | The investigation completed and found no contract violation, or the finding was already surfaced. **This is the expected result of a single run.** |
| `blocked` | Admission denied, model access unavailable, or environment setup failed. Nothing was looked at. |
| `inconclusive` | A failure was seen but did not replay in a fresh environment, did not reproduce on the source revision, or classified as setup rather than behavior. |
| `reproduced-candidate` | A defect reproduces and contradicts a stated contract, but the repair is missing, incomplete, unverified, or weakens tests. |
| `review-ready` | Every verification gate passed. One reproduction and one understandable repair are ready for a maintainer. |

Two rules hold the promise together, and both are enforced in the classifier:

- **A generated failing test is not a bug.** The failure must also contradict a quoted contract, replay in a fresh environment on the pinned revision, and classify as product behavior rather than setup.
- **Passing tests are not a correct repair.** The minimal reproduction must flip, boundaries must have been challenged, and no test may have been deleted, skipped, relaxed, or suppressed.

## Verification

Verification is a separate adversarial phase whose job is to reject the investigation's claim. It checks the quoted contract, replays on the original pinned revision in a fresh worktree and environment, classifies setup failures apart from behavior failures, requires separate test and production patches, re-runs the applicable existing tests, challenges boundary conditions and alternative explanations, and diffs the test inventory to detect weakened or suppressed tests.

The worker reserves part of its budget for this phase. A long search cannot consume the budget verification needs; when the investigation phase reaches its share, it stops searching and verifies what it already has.

## Review Bundle

A `review-ready` outcome publishes one artifact containing `summary.md`, `contract.md`, `reproduction.md`, `tests.patch`, `production.patch`, `validation.txt`, and `verification.json`, sealed with a `bundle-contract.json` carrying a sha256 digest per file. `summary.md` stands alone: repository, source revision, violated contract, impact, the fix in one sentence, the verifier decision, and the main uncertainty, without needing any other file.

## Identity and Limits

| Concept | Definition |
| --- | --- |
| Work identity | repository + revision + hypothesis version + harness version. Repeating the same work is skipped. |
| Finding identity | repository + violated contract + symptom signature + entry point. Independent of revision and harness, so a repeat investigation on a later commit recognizes the same defect instead of filing a near-duplicate. |
| Concurrency | One investigation at a time, one per run, at most one surfaced finding. |
| Retry | Bounded attempts with explicit backoff for transient faults only. Exhausted credits, rate limits, denied admission, and unavailable model access are terminal. |

## Safety Boundaries

- CAO policy decides whether and where the campaign may run; workflow capabilities do not grant rollout authority.
- The orchestrator only ranks and dispatches. The worker cannot discover repositories, dispatch more work, or widen mode.
- Nothing is written to the investigated repository: no issue, no pull request, no branch, no push, no merge. Every change stays a patch inside a review bundle.
- Outputs land only in the control repository, deduplicated by title, expiring after 14 days.
- The target checkout uses the built-in workflow token path, so a public starter target needs **no additional GitHub credentials**.

> [!IMPORTANT]
> "No additional GitHub credentials" is not the same as "free". Every run consumes the agentic engine's model entitlement and the campaign's AI credit budget, which are billed and rate-limited separately from GitHub permissions. The orchestrator is capped at 200 AI credits and the investigation worker at 500, with `max-daily-ai-credits` unset so your control-plane defaults apply. A private target still requires a GitHub App or PAT with read access.

## Operational Value

Bug Bash declares its operational value and deliberately does **not** claim to measure it yet.

The value of this campaign is a maintainer-confirmed defect and an accepted repair. Neither is observable inside the run that produced it, and no proxy available at run time is honest: a complete review bundle shows conformance to the output contract, not that anyone agreed a bug exists. Grading bundle completeness would reward the campaign for producing well-formed claims.

`intelligence.json` therefore records the outcome contract, the maturation period, and the anti-metrics — count of surfaced candidates, count of published bundles, and run success rate — that must not be read as value. Measurement becomes possible once enough maintainer decisions on `review-ready` bundles exist to compare against the baseline.

## Historical Pilot Evidence

[`fixtures/historical-pilot.json`](fixtures/historical-pilot.json) records a manual exercise that preceded this campaign: three pinned repositories, 998 selected existing tests, and two surfaced candidates — impossible calendar dates in a CAO date helper, and empty-input chunking behavior in Boltons.

Read it as design evidence only, and read the disclaimers it carries:

- **Zero of the two candidates were confirmed by a maintainer.** Both remain maintainer-unreviewed.
- The exercise was **not** run by this harness, so its results are not a baseline for this campaign and not a prediction of what a run will produce.
- It contains no source, no patches, no reproductions, and no logs. It is scope and lessons, not seeded findings.

The expected outcome of your first Bug Bash run is `no-finding`.

## Pause or Stop

Set `control-plane.campaigns.bug-bash.enabled` to `false` in a reviewed policy change and cancel active runs. Disable the `investigation` worker for a narrower stop. Re-enable in review mode after resolving the incident.
