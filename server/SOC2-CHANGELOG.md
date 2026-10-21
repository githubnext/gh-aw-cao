# SOC 2 readiness assessment changelog

This append-only history tracks assessment/specification changes and operator
decisions, not product releases or certification.
See the [assessment specification](../specs/server-soc2-compliance.md), the
[current register](SOC2.md), and the
[assessment procedure](../.github/skills/soc2-server-assessment/SKILL.md).
Dates are UTC. Corrections are new events; original observations remain.

## 2026-10-21 - SOC2-LOG-001 - Assessment initiated

- Type: scope and assessment baseline.
- Source baseline: `ef7d9fb65ea952826f9d81a94bd5890d3cfd5634`;
  procedure/map baseline: `e3daa5d7ad4fa537e6432359076b44f4a90be171`.
- Specification version: not yet established at this event; procedure captured
  in the initial skill and assessment map.
- Recorded the Go server component/profile inventory, evidence statuses and
  initial scope/governance/operational evidence requests in `SOC2.md`.
- Launched four read-only IAM, DATA, EXEC and OPS investigation sessions;
  identifiers were persisted in commit `05c152f21`.
- Related requests: SCOPE-01, SCOPE-02, GOV-01, IAM-OP-01, DATA-OP-01,
  OPS-OP-01, REL-OP-01 and BCP-OP-01.
- Authorization: operator requested assessment, a reusable skill, component
  investigations and findings for operator decisions. No remediation, risk
  acceptance or exclusions approved.
- Limitations: component reports pending; no deployed configuration,
  organizational evidence or operating-period evidence supplied. Readiness
  undetermined.

## 2026-10-21 - SOC2-LOG-002 - Maintained specification established

- Type: assessment specification and maintenance process.
- Source/evidence baseline: unchanged runtime revision
  `ef7d9fb65ea952826f9d81a94bd5890d3cfd5634`; investigations continue against
  `e3daa5d7ad4fa537e6432359076b44f4a90be171`.
- Specification version: 1, `specs/server-soc2-compliance.md`.
- Established maintained record ownership, criterion-family coverage,
  evidence/test/operating-status separation, stable finding IDs, operator
  decision and closure semantics, append-only history and reassessment
  triggers. Aligned the skill and current register with the specification.
- Related requests: all initial evidence requests remain pending.
- Authorization: operator requested maintaining a SOC 2 compliance
  specification and changelogs. This authorizes documentation maintenance,
  not runtime or policy changes.
- Limitations: preliminary cross-component observations are still being
  investigated; no consolidated finding or operator disposition is implied
  by this event. Readiness remains undetermined.

## 2026-10-21 - SOC2-LOG-003 - OPS investigation consolidated

- Type: component findings and operational evidence requests.
- Source/evidence baseline: assessed
  `e3daa5d7ad4fa537e6432359076b44f4a90be171`, runtime
  `ef7d9fb65ea952826f9d81a94bd5890d3cfd5634`; later coordinator changes
  are assessment documentation only.
- Specification version: 1.
- Received OPS report from session
  `76a730cd-672d-4c67-9e03-cb2c3c0460fe`; consolidated material source
  evidence, counter-evidence, verification limitations, suggested owners and
  closure decisions into `SOC2.md`.
- Findings: OPS-01 through OPS-04 are four medium-severity, high-confidence
  scoped design gaps (successful rebuild attribution, Azure template-only
  OTLP route, production use of development source-built images without an
  equivalent assurance gate, and Redis doctor false assurance).
- Evidence requests: OPS-05 through OPS-08 concern independent audit
  operation, recovery commitments/exercises, effective cloud/key boundaries,
  and release/change/scan-exception period evidence. High severity for
  OPS-05/OPS-06 is conditional on the corresponding control commitments.
- Authorization/decisions: all findings open; all operator decisions pending.
  No remediation, risk acceptance, exclusion or production change approved.
- Limitations: focused synthetic/source/contract tests support bounded
  design observations only. Real destinations/providers, several
  PostgreSQL paths, scanning, generated-artifact reproducibility, actual
  deployment, restore and historical operation remain unverified.
  IAM/DATA/EXEC reports pending; readiness undetermined.

## 2026-10-21 - SOC2-LOG-004 - IAM and EXEC investigations consolidated

- Type: component findings, reproducible observations and evidence requests.
- Source/evidence baseline: both reports assessed exact
  `e3daa5d7ad4fa537e6432359076b44f4a90be171`; runtime
  `ef7d9fb65ea952826f9d81a94bd5890d3cfd5634` unchanged.
- Specification version: 1.
- Received IAM and EXEC reports from the registered sessions; consolidated
  findings, source/counter-evidence, suggested choices/owners and closure
  requirements into `SOC2.md`.
- Findings: IAM-001 (medium) unknown-expiry credential cleanup abandonment;
  IAM-002 (low) post-revocation revision-stream metadata; EXEC-01 (medium)
  login-only queued requester identity, with conditional provider-lifecycle
  impact. Three synthetic IAM observations reproduced adverse current
  behavior with and without race detection; no fix was applied.
- Evidence requests: IAM-003 through IAM-006 and EXEC-02 through EXEC-08
  remain open. High priorities concern effective audience/platform isolation
  and enabled production executor isolation/secret separation, not proven
  deployed defects.
- Deduplication: immutable delayed-job identity belongs to EXEC-01; IAM
  callback/consent binding and active rename denial are counter-evidence,
  not closure. Storage and cloud requests retain DATA/OPS dependencies.
- Authorization/decisions: all new records open, all operator decisions
  pending. No remediation, risk acceptance, exclusion or feature activation.
- Limitations: synthetic/platform-limited tests only; real adapters,
  intended executor kernels, provider lifecycle, deployed settings and
  historical operation remain unverified. IAM selectors overlap; test
  counts are not unique controls. DATA report pending; readiness undetermined.

## 2026-10-21 - SOC2-LOG-005 - DATA report and initial technical pass consolidated

- Type: component findings, failed validation and assessment milestone.
- Source/evidence baseline: DATA assessed exact
  `e3daa5d7ad4fa537e6432359076b44f4a90be171`; runtime
  `ef7d9fb65ea952826f9d81a94bd5890d3cfd5634` unchanged.
- Specification version: 1.
- Received DATA report from the registered session and consolidated all
  findings, citations, counter-evidence, closure requirements and limitations.
- Findings: DATA-01 high-severity cross-repository shard-prefix erasure;
  DATA-02 medium shared operational-value retention after withdrawal;
  DATA-03 medium erasure ACK before durable projection intent. Artifact-only
  production-helper observations reproduced all three; no production loss,
  canonical reappearance or real crash-loss was asserted.
- Evidence/applicability: DATA-04 through DATA-08 and DATA-10 need evidence;
  DATA-09 proposes a profile exclusion, not approved. DATA-08 records the
  existing failing temporal campaign SQL contract test; the main selected
  package run exited 1 and is not a passing validation gate.
- Milestone: all four bounded technical reports consolidated. Register has
  10 scoped design gaps (one high, eight medium, one low), 21 evidence-needed
  workstream records and one proposed exclusion, plus initial shared
  requests. Linked/shared dependencies are not independent criterion counts.
- Authorization/decisions: every finding/request remains open with operator
  decision pending. No fixes, production access, exclusions, feature
  activation or risk acceptance authorized.
- Limitations: real databases/providers/executor kernels, deployed settings,
  organizational evidence and historical operation remain unverified.
  Initial technical assessment delivered; SOC 2 readiness undetermined.

## 2026-10-21 - SOC2-LOG-006 - Remediation and daily worker authoring authorized

- Type: explicit operator decision and coordinated implementation launch.
- Source/evidence baseline: remediation sessions start from
  `748093b701ef9cf22e0323ac84fc6b026ea526ac`, containing the consolidated
  assessment. Original runtime observations remain tied to
  `ef7d9fb65ea952826f9d81a94bd5890d3cfd5634`.
- Specification version: 1; added the daily SelfCare worker contract without
  changing evidence/decision record semantics.
- Authorization: operator directed "start session to fix each findings" and
  "create an self care agentic workfler worker that does this check again
  and fixes the top 3 issues daily".
- Decisions: DATA-01/02/03, IAM-001/002, EXEC-01 and OPS-01/02/03/04 now
  `remediate` / `in-progress`; DATA-08 is authorized for contract/root-cause
  investigation and remediation under the same disposition.
- Launched eleven dedicated repository fix sessions and a twelfth session to
  author/register the daily SelfCare assessment/top-three-remediation worker.
  Exact session IDs are maintained in `SOC2.md`.
- Limits: draft PR proposals only, no merge/deployment/production access or
  secret reads. Existing sole-target authority must not widen. Evidence-only
  findings remain open/pending, except DATA-08's concrete failed check;
  proposed exclusions remain unapproved. No risk acceptance inferred.
- Outcome: repository work underway; no fix verified, no finding closed.
  Daily workflow is not active until reviewed/merged/installed. SOC 2
  readiness remains undetermined.
