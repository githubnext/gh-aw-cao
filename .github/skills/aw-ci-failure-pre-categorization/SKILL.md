# AW CI Failure Pre-Categorization

Use this skill to do a low-cost first-pass severity triage for recent agentic workflow CI failures before deciding whether to escalate to deep investigation.

## Input

- `/tmp/gh-aw/agent/aw-ci-doctor/prefetch.json`

## Classification rules

Classify each target repository state as one of:

- `P0`: evidence of broad blocking failure.
- `P1`: repeated workflow failures that look actionable but not globally blocking.
- `P2`: isolated or low-impact failures.
- `NO_FAILURE`: no recent qualifying failures.

Treat these as `P0` when supported by prefetch evidence:

- any `startup_failure` conclusion;
- two or more failures for the same workflow in the lookback window;
- failures affecting three or more distinct workflows in the lookback window.

Use `P1` for a single workflow with one failure (`failure` or `timed_out`) and no P0 signal.

Use `P2` only when evidence shows a non-blocking, isolated failure with no repetition.

Use `NO_FAILURE` when no failed agentic workflow run is present.

## Output shape

Return a compact triage summary with:

- classification (`P0`/`P1`/`P2`/`NO_FAILURE`)
- brief rationale
- representative run URLs
- affected workflow count
- total failed run count

Never fetch additional data unless the caller explicitly asks.
