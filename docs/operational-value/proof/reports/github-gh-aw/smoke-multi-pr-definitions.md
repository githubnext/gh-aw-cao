---
title: "What Smoke Multi PR measures"
description: "Definitions, evidence rules, and interpretation for the Smoke Multi PR operational-value report."
---

This page explains the operational-value timeline in plain language. It defines what was measured; it does not decide whether an agent or workflow caused the observed changes.

## Value review

**Assessment:** not-rated. No agreed native keep bar and review duration.

**Latest repository outcome:** 4 branch payloads; incomplete-evidence

**Measurement:** interval; 7-day window, 7-day cadence.

**Recent change:** unavailable: Fresh complete mature evidence is required for recent movement.

**Review basis:** No keep bar has been agreed; native evidence is still reported.

**Outcome-matched costs:** Not measured. No cost-per-outcome or monetary return is inferred.

| Period ending, UTC | Verified payloads (branch payloads) | Verified CRLF payloads (branch payloads) | Unassessed payload cases (candidate cases) | Eligible opportunities | Evidence |
|---|---:|---:|---:|---:|---|
| 2026-08-02T15:00:12Z | unknown | unknown | 112 | unknown | incomplete-evidence: No independent protected-operation and immutable target-byte receipt in this period. |
| 2026-08-09T15:00:12Z | unknown | unknown | 86 | unknown | incomplete-evidence: No independent protected-operation and immutable target-byte receipt in this period. |
| 2026-08-16T15:00:12Z | unknown | unknown | 52 | unknown | incomplete-evidence: No independent protected-operation and immutable target-byte receipt in this period. |
| 2026-08-23T15:00:12Z | unknown | unknown | 28 | unknown | incomplete-evidence: No independent protected-operation and immutable target-byte receipt in this period. |
| 2026-08-30T15:00:12Z | 4 | 2 | 114 | unknown | incomplete-evidence |
| 2026-09-06T15:00:12Z | 6 | 2 | 66 | unknown | incomplete-evidence |
| 2026-09-13T15:00:12Z | 8 | 4 | 188 | unknown | incomplete-evidence |
| 2026-09-20T15:00:12Z | 2 | 1 | 116 | unknown | incomplete-evidence |
| 2026-09-27T15:00:12Z | 6 | 3 | 100 | unknown | incomplete-evidence |
| 2026-10-04T15:00:12Z | 6 | 3 | 38 | unknown | incomplete-evidence |
| 2026-10-11T15:00:12Z | 8 | 4 | 128 | unknown | incomplete-evidence |
| 2026-10-18T15:00:12Z | 4 | 2 | 94 | unknown | incomplete-evidence |

The latest 12 periods are shown; the full native series is in the timeline.
Repository attainment includes other actors. Only a separately declared, independently verified contribution measure supports a workflow keep/change recommendation; it is not causal attribution.
Demonstrated workflow-enabled improvements count as shared contribution even when another agent or person implements them. Report measured progress, full goal completion, safeguards and attribution confidence separately. An unknown quality dimension does not cancel independently verified improvement; a merge alone does not verify that improvement.

## How to read the timeline

- Observations begin at workflow adoption on `2026-02-21`.
- No comparable pre-adoption evidence is available. Complete adjacent post-adoption periods may still show recent change, but not change relative to adoption.
- Each dot is one immutable observation. Missing evidence is omitted, never treated as zero.
- Execution activity is diagnostic only. It does not prove repository value.
- Recent change compares the immediately preceding equal-duration period, not lifetime movement. Interval windows must abut without overlap; snapshot values compare cutoff states.
- Two observations show observed change, not a sustained trend, statistical anomaly or target attainment. Unknown coverage, gaps and provisional evidence make comparison unavailable.
- Adoption comparison is separate. Stable-but-bad outcomes are not healthy merely because their latest delta is zero; workload-mix changes can explain aggregate movement.

## What was measured

**Goal:** Deliver two distinct source-required branch payloads in one execution, preserving CRLF bytes.

**Accepted outcome:** A source-bound protected create-pull-request operation receipt binds the original branch/base/head identities to immutable target-tree pre/post bytes. The base lacks the expected file; the head changes exactly that file with the run-specific required content, unchanged supplied bytes and no sibling payload. CRLF cases retain every carriage return. Each case is credited once, at the native delivery receipt.

### Verified payloads

- **What it tells you:** Verified payloads. This is a `primary` measure.
- **Native measurement formula:** `Count source-bound branch payloads whose original bytes equal the exact intended immutable target-tree addition, once per initial case.`
- **Unit:** `branch payloads`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Verified CRLF payloads

- **What it tells you:** Verified CRLF payloads. This is a `diagnostic` measure.
- **Native measurement formula:** `Count verified CRLF cases with every supplied carriage return preserved in the target Git blob.`
- **Unit:** `branch payloads`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Unassessed payload cases

- **What it tells you:** Unassessed payload cases. This is a `diagnostic` measure.
- **Native measurement formula:** `Count inventoried source-era candidate cases without independent immutable delivery evidence; exact eligibility is unknown.`
- **Unit:** `candidate cases`
- **Goal:** Lower values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

## Evidence rules

- **Repository:** `github/gh-aw`
- **Evidence population:** Every retained initial workflow execution before the cutoff; reruns are separately inventoried and never double-credit an initial execution.
- **Collection:** Digest-checked source profiles, exhaustive retained initial-run/job/artifact inventory, original native patches, protected Git API operation receipts and immutable target-tree objects. No network during evaluation.
- **Observation window:** 7 days, sampled every 7 days
- **Maturation delay:** 0 days
- **Filters:** `verified-payload-deliveries`; `branch payloads`; `Every retained initial workflow execution before the cutoff; reruns are separately inventoried and never double-credit an initial execution.`; `A source-bound protected create-pull-request operation receipt binds the original branch/base/head identities to immutable target-tree pre/post bytes. The base lacks the expected file; the head changes exactly that file with the run-specific required content, unchanged supplied bytes and no sibling payload. CRLF cases retain every carriage return. Each case is credited once, at the native delivery receipt.`; `Each independently verified branch payload counts even when its sibling or the summary-comment acceptance is unknown. Two PRs or a merge do not prove payload delivery.`; `Documentation and original configuration cases have the source's four required LF lines. CRLF cases have the first four required CRLF lines and the final CRLF annotation, accepting the literal annotation or the six-line expansion produced by the source's actual Bash printf; preserve the exact representation and report it separately. A nonempty printable timestamp must parse as a date.`; `Missing/expired operations, original head/base receipts, supplied payload bytes, source identity or immutable target trees remain null; no successes are inferred from run/job status or editable PR bodies.`; `Original config case and later CRLF case are different predicates; keep profile-specific quantities and do not infer a comparable trend across the switch.`; `Exactly two correct separate branches from main in one initial execution, matching intended bytes, plus protected proof of the required summary comment. Contribution is receipt-bound, not sole attribution; costs unmeasured.`; `The multi-PR test opportunities are introduced with this workflow. Generic PR creation existed earlier but is not the same test; no invented pre-adoption baseline.`; `Canonical run/tool/issue summaries do not contain original Git trees, binary payloads or protected patch/application receipts. Immutable Git plus retained Actions artifacts/logs are required; no dashboard query is substituted.`

The frozen definitions and formulas are applied to every post-adoption observation. The structured evidence, exact snapshots, provenance, units, and native values are recorded in the adjacent `smoke-multi-pr-timeline.json` artifact.

## Important limitation

This report can show whether the intended outcome is attained after adoption. It cannot estimate change from pre-adoption conditions or attribute attainment to the workflow.

Value-function SHA-256: `e4241801eed432e088516e68ee7575abe06ba87934a45690a60e3a083211916f`
