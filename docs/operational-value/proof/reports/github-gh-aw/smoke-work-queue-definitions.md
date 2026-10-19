---
title: "What Smoke Work Queue measures"
description: "Definitions, evidence rules, and interpretation for the Smoke Work Queue operational-value report."
---

This page explains the operational-value timeline in plain language. It defines what was measured; it does not decide whether an agent or workflow caused the observed changes.

## Value review

**Assessment:** not-rated. No agreed native keep bar and review duration.

**Latest repository outcome:** unknown predicates; unavailable

**Measurement:** interval; 7-day window, 7-day cadence.

**Recent change:** unavailable: Fresh complete mature evidence is required for recent movement.

**Review basis:** No keep bar has been agreed; native evidence is still reported.

**Outcome-matched costs:** Not measured. No cost-per-outcome or monetary return is inferred.

| Period ending, UTC | Observer predicates (predicates) | Smoke readbacks (readbacks) | Eligible opportunities | Evidence |
|---|---:|---:|---:|---|
| 2026-10-10T03:22:10Z | unknown | unknown | 3 | incomplete-evidence: No source-bound independent native observer checker/receipts; smoke success is not native conformance. |
| 2026-10-11T15:00:12Z | unknown | unknown | 6 | incomplete-evidence: No source-bound independent native observer checker/receipts; smoke success is not native conformance. |
| 2026-10-17T03:22:10Z | unknown | unknown | 12 | incomplete-evidence: No source-bound independent native observer checker/receipts; smoke success is not native conformance. |
| 2026-10-18T15:00:12Z | unknown | unknown | 9 | incomplete-evidence: No source-bound independent native observer checker/receipts; smoke success is not native conformance. |

The latest 4 periods are shown; the full native series is in the timeline.
Repository attainment includes other actors. Only a separately declared, independently verified contribution measure supports a workflow keep/change recommendation; it is not causal attribution.
Demonstrated workflow-enabled improvements count as shared contribution even when another agent or person implements them. Report measured progress, full goal completion, safeguards and attribution confidence separately. An unknown quality dimension does not cancel independently verified improvement; a merge alone does not verify that improvement.

## How to read the timeline

- Observations begin at workflow adoption on `2026-10-03`.
- No comparable pre-adoption evidence is available. Complete adjacent post-adoption periods may still show recent change, but not change relative to adoption.
- Each dot is one immutable observation. Missing evidence is omitted, never treated as zero.
- Execution activity is diagnostic only. It does not prove repository value.
- Recent change compares the immediately preceding equal-duration period, not lifetime movement. Interval windows must abut without overlap; snapshot values compare cutoff states.
- Two observations show observed change, not a sustained trend, statistical anomaly or target attainment. Unknown coverage, gaps and provisional evidence make comparison unavailable.
- Adoption comparison is separate. Stable-but-bad outcomes are not healthy merely because their latest delta is zero; workload-mix changes can explain aggregate movement.

## What was measured

**Goal:** For initial observer executions, independently verify snapshot-bound absent reads, nonauthoritative explanations and rejection or omission of unassigned finish without staged or durable mutation.

**Accepted outcome:** The real initial-attempt MCP read of __gh_aw_smoke__-RUN_ID returns that exact absent Work and snapshot_sha agreeing with the independently retained activation snapshot; a nonexistent queue branch requires null. The snapshot, producer upload, consumed payload, native operation and host readback share repository/run/attempt/head identity and chronological order. The real initial-attempt MCP explain for the same absent Work returns activation_snapshot, matching snapshot_sha and captured_at, and an absent nonauthoritative explanation. Independently retained native operation and protected host readback must agree with the exact activation payload. The source-bound native observer tools omit claim_finish, or a real unassigned completed finish is rejected without a staged finish. Independent host receipts establish complete staged-intent absence and no observer-attributable durable queue operation, not merely absence from an upload manifest. Concurrent unrelated queue writes are not observer failures.

### Independently verified observer predicates

- **What it tells you:** Independently verified observer predicates. This is a `primary` measure.
- **Native measurement formula:** `Count independently established true native predicates; retain established partial proof through gaps, but return null when all are unknown.`
- **Unit:** `predicates`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Protected smoke readbacks (not native proof)

- **What it tells you:** Protected smoke readbacks (not native proof). This is a `diagnostic` measure.
- **Native measurement formula:** `Count exact reviewed initial-run download and noop/no-finish-artifact assertion steps that succeeded before cutoff. Never credit this as a native predicate.`
- **Unit:** `readbacks`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

## Evidence rules

- **Repository:** `github/gh-aw`
- **Evidence population:** Three observer predicates per initial same-repository scheduled/manual observer-era run. The independently reviewed incompatible finish-staging era is ineligible; unsupported observer runtime profiles remain unassessed. Reruns are not new opportunities.
- **Collection:** Bounded public run/job/artifact inventory, immutable source replay and protected host readback discovery. Native predicate acceptance requires independent source-bound operation, state and mutation-safety receipts, which the frozen profile does not emit.
- **Observation window:** 7 days, sampled every 7 days
- **Maturation delay:** 0 days
- **Filters:** `Frozen before outcome acquisition. Only this exact reviewed task, host job and runtime source profile is supported; other historical profiles remain unassessed.`; `Version 2 preserves the complete v1 predecessor, then classifies two independently reviewed incompatible finish-staging intent sources as ineligible for the later observer goal. Observer-era runtime variants remain unassessed rather than excluded.`; `The frozen source has no independent native checker for any of the three observer predicates. MCP logs and agent summaries cannot substitute for protected assertions.`; `The compiled copy-finish step is followed by an agent artifact upload manifest that omits work-queue.finish.jsonl. A successful downstream missing-file check therefore cannot establish local finish absence.`; `The ordinary noop/failure issue is agent-authored, not an outcome oracle. A successful job establishes only its exact protected smoke assertion.`; `Historical native execution receipts may be expired or were never emitted. Their absence is unknown, not zero failures, zero opportunities, or a native delivery.`; `No keep threshold, full runtime conformance, workflow causation or costs are inferred. Native all-unknown coverage is not measured coverage.`

The frozen definitions and formulas are applied to every post-adoption observation. The structured evidence, exact snapshots, provenance, units, and native values are recorded in the adjacent `smoke-work-queue-timeline.json` artifact.

## Important limitation

This report can show whether the intended outcome is attained after adoption. It cannot estimate change from pre-adoption conditions or attribute attainment to the workflow.

Value-function SHA-256: `c9a23f047f5296d2bed9bd83df3a949739ccd9a62350f43b75d6ea68c865588d`
