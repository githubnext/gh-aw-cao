---
title: "What Smoke Workflow Call with Inputs measures"
description: "Definitions, evidence rules, and interpretation for the Smoke Workflow Call with Inputs operational-value report."
---

This page explains the operational-value timeline in plain language. It defines what was measured; it does not decide whether an agent or workflow caused the observed changes.

## Value review

**Assessment:** not-rated. No agreed native keep bar and review duration.

**Latest repository outcome:** unknown verified scenarios; unavailable

**Measurement:** interval; 7-day window, 7-day cadence.

**Recent change:** unavailable: Fresh complete mature evidence is required for recent movement.

**Review basis:** No keep bar has been agreed; native evidence is still reported.

**Outcome-matched costs:** Not measured. No cost-per-outcome or monetary return is inferred.

| Period ending, UTC | Verified scenarios (verified scenarios) | Complete scenarios (verified scenarios) | Eligible opportunities | Evidence |
|---|---:|---:|---:|---|
| 2026-08-13T18:42:05Z | unknown | unknown | unknown | incomplete-evidence: Input-correlated artifact payloads, provider digests or protected consumer readback unavailable. |
| 2026-08-20T18:42:05Z | unknown | unknown | unknown | incomplete-evidence: Input-correlated artifact payloads, provider digests or protected consumer readback unavailable. |
| 2026-08-27T18:42:05Z | unknown | unknown | unknown | incomplete-evidence: Input-correlated artifact payloads, provider digests or protected consumer readback unavailable. |
| 2026-09-03T18:42:05Z | unknown | unknown | unknown | incomplete-evidence: Input-correlated artifact payloads, provider digests or protected consumer readback unavailable. |
| 2026-09-10T18:42:05Z | unknown | unknown | unknown | incomplete-evidence: Input-correlated artifact payloads, provider digests or protected consumer readback unavailable. |
| 2026-09-17T18:42:05Z | unknown | unknown | unknown | incomplete-evidence: Input-correlated artifact payloads, provider digests or protected consumer readback unavailable. |
| 2026-09-24T18:42:05Z | unknown | unknown | unknown | incomplete-evidence: Input-correlated artifact payloads, provider digests or protected consumer readback unavailable. |
| 2026-10-01T18:42:05Z | unknown | unknown | unknown | incomplete-evidence: Input-correlated artifact payloads, provider digests or protected consumer readback unavailable. |
| 2026-10-08T18:42:05Z | unknown | unknown | unknown | incomplete-evidence: Input-correlated artifact payloads, provider digests or protected consumer readback unavailable. |
| 2026-10-11T15:00:12Z | unknown | unknown | unknown | incomplete-evidence: Input-correlated artifact payloads, provider digests or protected consumer readback unavailable. |
| 2026-10-15T18:42:05Z | unknown | unknown | unknown | incomplete-evidence: Input-correlated artifact payloads, provider digests or protected consumer readback unavailable. |
| 2026-10-18T15:00:12Z | unknown | unknown | unknown | incomplete-evidence: Input-correlated artifact payloads, provider digests or protected consumer readback unavailable. |

The latest 12 periods are shown; the full native series is in the timeline.
Repository attainment includes other actors. Only a separately declared, independently verified contribution measure supports a workflow keep/change recommendation; it is not causal attribution.
Demonstrated workflow-enabled improvements count as shared contribution even when another agent or person implements them. Report measured progress, full goal completion, safeguards and attribution confidence separately. An unknown quality dimension does not cancel independently verified improvement; a merge alone does not verify that improvement.

## How to read the timeline

- Observations begin at workflow adoption on `2026-03-12`.
- No comparable pre-adoption evidence is available. Complete adjacent post-adoption periods may still show recent change, but not change relative to adoption.
- Each dot is one immutable observation. Missing evidence is omitted, never treated as zero.
- Execution activity is diagnostic only. It does not prove repository value.
- Recent change compares the immediately preceding equal-duration period, not lifetime movement. Interval windows must abut without overlap; snapshot values compare cutoff states.
- Two observations show observed change, not a sustained trend, statistical anomaly or target attainment. Unknown coverage, gaps and provisional evidence make comparison unavailable.
- Adoption comparison is separate. Stable-but-bad outcomes are not healthy merely because their latest delta is zero; workload-mix changes can explain aggregate movement.

## What was measured

**Goal:** Keep concurrent and sequential reusable-workflow callers isolated: each invocation uploads uniquely input-correlated artifacts whose contents and downstream consumer belong to that invocation.

**Accepted outcome:** All task-a/task-b concurrent and task-c sequential invocations have distinct provider artifact identities/names, SHA256-verified activation and agent payloads containing their exact declared task input, correct noop content, and source-bound protected consumer readback. All additional invocation-scoped artifact families must also be isolated when emitted.

### Verified isolated caller scenarios

- **What it tells you:** Verified isolated caller scenarios. This is a `primary` measure.
- **Native measurement formula:** `Count source-bound three-caller scenarios with distinct input-correlated artifact identities, correct payloads and protected consumer readback.`
- **Unit:** `verified scenarios`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Complete isolated caller scenarios

- **What it tells you:** Complete isolated caller scenarios. This is a `diagnostic` measure.
- **Native measurement formula:** `The same native count only if every eligible scenario in the period has accepted positive or negative evidence.`
- **Unit:** `verified scenarios`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

## Evidence rules

- **Repository:** `github/gh-aw`
- **Evidence population:** Every original smoke-multi-caller execution attempt invoking task-a, task-b concurrently and task-c sequentially against the assigned reusable workflow.
- **Collection:** Offline replay of complete Actions discovery, source-bound caller/callee jobs, provider artifact digests and input-correlated payload/consumer receipts.
- **Observation window:** 7 days, sampled every 7 days
- **Maturation delay:** 0 days
- **Filters:** `Only source-defined smoke-multi-caller opportunities; standalone schedule/dispatch runs do not exercise multiple callers and are inventoried separately.`; `Initial attempts only; inventory later attempts without counting the same opportunity twice.`; `GitHub pull_request uses a merge checkout: missing immutable workflow execution identity remains unknown.`; `Source profiles preserve original caller inputs/defaults, producer/consumer steps and namespace algorithm; incompatible historical profiles remain unknown.`; `SHA256 namespace prefix depends on exact toJSON(inputs) serialization and run attempt. Never hash a guessed JSON serialization.`; `Identical-input calls are an explicitly documented unsupported edge case, not proven safe.`; `Jobs, successful uploads, artifact counts, task echoes and agent-authored noop text alone are not accepted outcome evidence.`

The frozen definitions and formulas are applied to every post-adoption observation. The structured evidence, exact snapshots, provenance, units, and native values are recorded in the adjacent `smoke-workflow-call-with-inputs-timeline.json` artifact.

## Important limitation

This report can show whether the intended outcome is attained after adoption. It cannot estimate change from pre-adoption conditions or attribute attainment to the workflow.

Value-function SHA-256: `6fe4e138b5ac4aead27543d4c21d5e5c4898aef47814a7f04174bb431abf0eff`
