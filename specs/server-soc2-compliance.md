# Server SOC 2 readiness and evidence specification

Specification version: **1**.
Status: **active assessment contract; compliance undetermined**.
Maintainer: the server assessment coordinator; organizational approval remains
with the service owner and independent auditor.

## 1. Purpose and authority

This specification defines how CAO maintains a systematic SOC 2 readiness
assessment for the Go server. It MUST NOT be represented as an attestation,
certification, auditor opinion, or proof of operating effectiveness.

The assessment MUST use the applicable AICPA Trust Services Criteria agreed
with the operator/auditor. The initial framework reference is the
[2017 Trust Services Criteria with revised points of focus, 2022](https://www.aicpa-cima.com/resources/download/2017-trust-services-criteria-with-revised-points-of-focus-2022).
Mappings here are working assessment mappings, not the standard's complete
requirements or an approved engagement control matrix.

This contract governs assessment records, not new runtime behavior.
`server/SECURITY.md` and domain specifications remain authoritative for
implementation requirements. A discovered mismatch MUST cite the relevant
requirement; proposed hardening MUST NOT silently become a mandatory existing
control. Assessment work MUST NOT change policy, credentials, permissions,
retention, deployment, or enabled features without separate authorization.

## 2. Maintained records

| Record | Purpose | Maintenance rule |
| --- | --- | --- |
| This specification | Stable scope, evidence model and assessment lifecycle | Update when assessment requirements change; increment version for incompatible record/decision semantics |
| `server/SOC2.md` | Current component inventory, investigation coverage, findings and operator decision register | Update as reports arrive and decisions/evidence change; explicitly retain pending work |
| `server/SOC2-CHANGELOG.md` | Append-only assessment and decision history | Add dated events for each material assessment/specification change |
| `.github/skills/soc2-server-assessment/SKILL.md` | Repeatable investigation procedure | Keep aligned with this specification; it MUST NOT weaken evidence or approval gates |
| Session report artifacts | Detailed bounded investigation evidence | Preserve source SHA, report provenance and accessible references when consolidating |

The specification, current register, and changelog MUST link to each other.
The current register MUST be understandable without retrieving a transient
session. Material findings, limitations and pending decisions MUST be
consolidated there; session-only paths MAY retain detailed supporting output
but MUST NOT be the sole durable description of a finding.

## 3. System scope and applicability

Each assessment MUST record its UTC date, source SHA, assessment/specification
version, component owners, evaluated profiles/features, data classes, system
boundaries, external dependencies, explicit exclusions, and deployed evidence
availability. The component inventory in `server/SOC2.md` is the coverage index.

Local SQLite/capability access, hosted/external listeners, Azure Functions,
PostgreSQL/Redis/memory operational adapters, admission-only operation,
gateway ingress/dispatch, and experimental CLI executor platforms MUST be
distinguished. Optional features MUST NOT be assumed enabled. A checked-in
template MUST NOT be treated as deployed configuration.

Security/Common Criteria CC1-CC9 is the initial readiness baseline. Additional
categories MUST remain explicit applicability decisions until approved:

| Working family | Required assessment coverage |
| --- | --- |
| CC1-CC2 | Accountability, personnel/security responsibilities, communication and policy evidence |
| CC3-CC5 | Risk assessment, control selection, monitoring of controls and documented ownership |
| CC6 | Identity lifecycle, logical/privileged access, credentials, data protection and access boundaries |
| CC7 | Detection, event evaluation, response, recovery and evidence completeness |
| CC8 | Reviewed changes, tested releases, provenance, deployment approvals and rollback |
| CC9 | Vendor/dependency risks, continuity and risk mitigation |
| A1 | Proposed availability commitments, capacity, backups and tested recovery objectives |
| PI1 | Proposed processing commitments, validated inputs, completeness, accuracy and replay/atomicity semantics |
| C1 | Proposed confidential-data classification, access, retention and disposal commitments |
| P1-P8 | Proposed personal-information lifecycle, notices/consent, use/disclosure, rights and monitoring obligations |

This table is a coverage prompt, not satisfaction of a criterion. Governance,
personnel, provider, deployment, and historical-operation claims require
organizational evidence; source review alone cannot establish them.

The operator/auditor MUST approve the examination objective, system
description, commitments, category applicability, complementary user-entity
controls and any service-provider carve-outs. Type 1 design evidence at a
specified date MUST be distinguished from Type 2 operating-effectiveness
evidence over a specified period. Until agreed, these fields remain unknown.

## 4. Control and evidence records

Every scoped control claim MUST contain a stable identifier, component/profile,
working TSC mapping, expected property and its authority, evidence status,
implementation citations, test execution status, operating-evidence status,
limitations and requested closure evidence.

Evidence status MUST be one of:

| Status | Meaning |
| --- | --- |
| `design-supported` | Cited implementation supports a narrowly stated design property |
| `design-gap` | Evidence demonstrates a specific missing or contradicted expected design property |
| `evidence-needed` | Required implementation, deployment, organization or period evidence is unavailable |
| `not-applicable-proposed` | A reasoned exclusion is proposed but has not been approved |

A status MUST NOT imply whole-criterion coverage. Test status MUST separately
be `passed`, `failed`, `skipped`, or `not-run`. Operating effectiveness MUST
separately be `not-assessed` or a bounded observation identifying the actual
environment, observation period, sampling method and limitations.

Source citations MUST identify `path:line` ranges at the recorded SHA. Evidence
records MUST distinguish documentation intent, implementation design, executed
test observations and actual operation. Commands MUST record their outcome,
prerequisites and skipped coverage. An overall successful command with skipped
database/platform tests MUST NOT be reported as verified coverage of those
paths. An unavailable check MUST remain visible.

Sanitized evidence references SHOULD include provenance, collection date,
responsible role and applicable period. Secrets, credential-bearing URLs,
raw customer records, personal access-review lists and sensitive production
outputs MUST NOT be committed. Restricted organizational evidence MAY remain
in an approved operator-controlled system with a non-sensitive reference here.

## 5. Findings and operator decisions

Findings MUST have stable workstream-prefixed IDs (`IAM`, `DATA`, `EXEC`, `OPS`);
cross-cutting scope/governance/evidence requests MAY retain their existing
register prefixes. IDs MUST NOT be recycled or renumbered after publication.

Each finding MUST record title, affected profile/feature conditions, working
TSC mapping, severity (`high`, `medium`, `low`, `informational`), confidence
(`high`, `medium`, `low`), evidence status, expected/observed property, source
and test evidence, impact, counter-evidence, compensating controls, proposed
action/tradeoffs, suggested accountable role and closure evidence.

Hypotheses and conditional provider-lifecycle scenarios MUST be labelled.
They MUST NOT be counted as demonstrated deployed failures. Duplicate reports
MUST be linked to a single owning finding while preserving counter-evidence.
Discovery of a design gap does not establish that an incident occurred.

Decision state is independent of evidence status:

| Decision state | Required meaning/evidence |
| --- | --- |
| `pending` | No authorized operator decision supplied |
| `investigate` | Operator chose further bounded investigation; scope/owner recorded |
| `collect-evidence` | Operator assigned the evidence request and owner |
| `remediate` | Operator authorized a defined remediation scope and owner |
| `risk-accepted` | Accountable approver, rationale, scope, compensating controls, expiry and reassessment trigger recorded |
| `exclusion-approved` | Operator/auditor approval and rationale recorded for the scoped exclusion |

The assessor MUST NOT infer approval from silence, test success, a source
commit, this specification, or an instruction to start an assessment.
Suggested actions/owners remain suggestions until assigned.

Finding lifecycle MUST be recorded separately as `open`, `in-progress`,
`closed`, or `reopened`. Closure MUST identify the authoritative decision,
closure evidence, verification date and verifying role. A code fix alone
MUST NOT close missing deployment or period evidence. Risk acceptance records
the decision; it MUST NOT erase the gap or convert it to `design-supported`.
Expired acceptance MUST reopen the unresolved risk for operator review.

## 6. Investigation and consolidation lifecycle

1. Freeze the source baseline and record scope/applicability unknowns.
2. Map every server component and assign primary investigation ownership.
3. Apply the assessment skill to implementation, contracts and focused tests.
4. Preserve each report's provenance and execution limitations; compare SHAs
   before combining evidence. Documentation-only drift MAY be reconciled
   explicitly; behavior drift requires revalidation of affected claims.
5. Consolidate received findings into `server/SOC2.md`, deduplicate shared
   concerns, and retain pending or unreviewed surfaces.
6. Append a changelog entry and present prioritized operator decisions.
7. Record authorized decisions and later verification without rewriting the
   original observation. Reassess affected components after material changes.

A completed technical assessment MUST account for every mapped component,
in-scope criterion family, skipped/unexecuted check, unresolved finding and
operational evidence request. It MAY conclude readiness is undetermined.
No compliance percentage or automatic all-controls-passed conclusion is
permitted.

## 7. Change history and reassessment

The changelog MUST append UTC-dated events with a stable event ID, change type,
source/evidence baseline, affected specification version, related finding
IDs, actual decision/authorization, and remaining limitations. New events
MUST NOT invent approvals or claim work is complete while reports are pending.
Corrections MUST be new events referencing the original event.

Update the register and changelog when a component report arrives, evidence
changes a conclusion, an operator makes a decision, remediation is verified,
an acceptance expires, or scope/specification changes. Material authentication,
authorization, data/retention, audit, execution, dependency, deployment or
provider changes require an affected-scope reassessment entry, not a silent
carry-forward of earlier evidence.

Documentation validation MUST include link/record consistency and the
repository's required workflow compilation after Markdown changes. Runtime
changes separately require their applicable tests/lint/type checks. Passing
documentation validation MUST NOT be recorded as validation of server controls.

## 8. Daily SelfCare reassessment and bounded remediation

The operator authorized authoring a daily SelfCare worker on 2026-10-21.
This section specifies its required behavior; it MUST NOT be taken as
evidence that the workflow has been merged, installed, enabled or run.
Default read-only assessment remains unchanged outside explicit remediation
authorization.

The worker MUST reuse the existing SelfCare control-precompute, campaign
authority and bounded daily dispatch convention. It MUST act only for the
existing exact authorized repository and resolved mode. It MUST NOT
self-discover targets, dispatch more work, widen enrollment or promote a
review candidate to live. Cadence history unavailable or ambiguous MUST
fail closed. Changing unrelated campaign scope/mode is not authorized.

Each eligible daily run MUST reassess current source through the assessment
skill and distinguish confirmed code issues from operator/period evidence
requests. It MUST record current SHA, coverage, outcomes and incomplete
checks. Existing draft/remediation PRs MUST prevent duplicate fixes without
being misrepresented as completed/deployed controls.

Rank actionable issues by severity, confidence and a deterministic stable
tie-break. Propose fixes for at most **three** safely testable issues, not
three invented issues or three forced changes to evidence-only records.
Incompatible changes or changes outside the declared safe-output/file/resource
boundary MUST be deferred with explicit reasons. Fewer than three is valid.
Missing organizational/deployment evidence MUST remain an evidence request.

Repository changes MUST use existing declared safe outputs: at most one
bounded draft PR per run, with focused regression evidence and complete
required validation for the touched scope. Agent GitHub tools MUST remain
read-only. The worker MUST NOT modify credentials/authority/rollout or its
own workflow/policy protections through a remediation PR, deploy, merge,
accept risk, approve exclusions, or claim certification. Untrusted repository
content and finding descriptions MUST NOT override these boundaries.

Daily assessment results MUST remain explicit even when a duplicate-open-PR
guard prevents a new fix PR. Record noop, incomplete, partial or proposed-fix
outcomes honestly. Material new findings/changed evidence MUST update the
register and append the changelog through the authorized output boundary;
never mark a finding closed solely because a patch is proposed.

Contract tests MUST cover registration/cadence, exact target/mode gating,
bounded selection/ranking, duplicate handling, draft safe-output limits and
failure behavior. Editable workflow source, policy registration, manifests,
dispatch ceilings and generated locks MUST be reviewed together at the exact
workflow SHA. No operational control is effective merely because authoring
or compilation succeeds.
