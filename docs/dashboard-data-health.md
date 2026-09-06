---
title: Dashboard data health
---

# Dashboard data health

Data Health answers whether the dashboard's evidence is sufficiently complete,
current, compatible, and internally consistent to represent the live agentic
system. Cache population is retained as a secondary diagnostic and is never
used as proof of live-system coverage.

## Independent evidence axes

Every logical source preserves three independent states:

- **Availability** says whether evidence can be read. An unavailable source is
  not equivalent to a successfully collected empty result.
- **Completeness** says whether the authoritative expected scope was collected.
  Partial evidence remains partial even when every retained row is populated.
- **Freshness** compares the evidence's source time and requested horizon, not
  merely the collector completion time. A stale fallback remains available but
  stale.

Unknown values and unknown denominators remain `unknown`; they are not coerced
to zero or 100%.

## Deterministic confidence rules

Confidence has no numeric score. It is derived from the required evidence
dependencies declared for each dashboard domain.

1. **Insufficient**: a required source is unavailable, its collection failed,
   or its producer contract is unsupported.
2. **Unknown**: required source state, scope, denominator, or producer
   compatibility cannot be determined.
3. **Degraded**: required evidence has a known bounded completeness, freshness,
   compatibility, collection, or reconciliation gap.
4. **Trusted**: every required source is available, complete, fresh, compatible,
   and internally consistent.

The overall state is the most consequential domain state in this order:
`insufficient`, `unknown`, `degraded`, then `trusted`. Optional source failures
do not change a domain's confidence.

## Coverage and zero activity

Coverage records contain `expected`, `observed`, `missing`, and
`coverage-percent`. A percentage is emitted only when `expected` is an
authoritative number. Zero expected and zero observed is complete zero activity;
an unqueried source is missing collection. Requested and observed evidence
horizons are compared separately, so a recent two-day collection cannot claim
complete coverage for a requested 30-day window.

## Compatibility and reconciliation

Producer versions are classified as `compatible`, `limited`, `unsupported`, or
`unknown`. Missing optional fields from supported legacy producers are expected;
required fields missing from a current compatible contract are unexpected.
Parser failures remain collection failures rather than version differences.

Reconciliation uses repository, workflow, and run identifiers. It never joins
records by timestamps or display names. Relationships cover inventory through
workflows and runs, run evidence through usage and security telemetry, and Safe
Outputs through outcomes. Ineligible records are excluded before their
authoritative denominator is constructed.
