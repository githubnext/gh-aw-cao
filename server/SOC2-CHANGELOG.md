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

## 2026-10-21 - SOC2-LOG-007 - OPS-04 validated draft remediation received

- Type: proposed code remediation and validation evidence.
- Source/evidence: commit `c480c3027785444a53e814802bf9776bb9f02fbc`,
  draft [#19304](https://github.com/githubnext/gh-cao/pull/19304), targeting
  the assessment branch. Coordinator checked GitHub open/draft/head/base
  identity and commit scope; it did not rerun the session's test suite.
- Specification version: 1. Related finding: OPS-04.
- Proposed change: missing/malformed Redis persistence evidence warns;
  unknown AOF status remains unknown; historical RDB success does not assert
  active snapshot policy; enabled-AOF write success is narrowly described.
  Added classification/INFO boundary tests and operator documentation.
- Reported validation: formatting, doctor normal/race tests, vet/build,
  full server golangci-lint (zero issues), workflow compilation and diff
  checks passed.
- Decision/lifecycle: `remediate` / `in-progress`; draft awaiting review,
  not merged/deployed and not closed. Original assessment evidence preserved.
- Limitations: no live CONFIG/provider access or restore exercise.
  DATA-07/OPS-06 provider durability/recovery evidence remains pending.

## 2026-10-21 - SOC2-LOG-008 - DATA-08 contract correction proposed

- Type: validation root-cause disposition and draft test-only remediation.
- Source/evidence: commit `d2d640bd3301617d27919e6634ef63c2b50f321f`,
  draft [#19305](https://github.com/githubnext/gh-cao/pull/19305).
  Coordinator checked open/draft/head/base and one-file scope, not rerun
  results independently.
- Specification version: 1. Related finding: DATA-08.
- Root cause: legacy Operational Value pages were intentionally retired;
  the temporal SQL test still searched the removed page instead of the
  shared native-measure fixture. No runtime processing defect inferred.
- Proposed change: correct fixture/test naming, preserve existing semantic
  assertions and strengthen source/metric/point/dimension/row-bound checks.
- Reported validation: original failure reproduced; corrected targeted
  check and PostgreSQL-backed full query suite passed (214 passing
  test/subtest events, zero failures/skips); 74 related dashboard contract
  tests, query vet/build/lint, formatting, workflow compile and diff checks
  passed. Disposable database removed; no deployed service examined.
- Decision/lifecycle: `remediate` / `in-progress`; review/integration and
  post-integration gate evidence pending. Historical baseline failure is
  preserved and no other provider/period evidence is closed.

## 2026-10-21 - SOC2-LOG-009 - Review-state refresh and DATA-08 CI dependency

- Type: current review state and integration limitation.
- Source/evidence: GitHub refresh around 15:39 UTC reports
  [#19304](https://github.com/githubnext/gh-cao/pull/19304) and
  [#19305](https://github.com/githubnext/gh-cao/pull/19305) open/non-draft;
  original proposal head commits remain unchanged. Initial draft-creation
  events remain accurate history; no review-state changes were made here.
- Specification version: 1. Related findings: OPS-04 and DATA-08.
- OPS-04 Go CI has one failing completed check. Its session's log review
  and query/fixture baseline tree comparison attribute failure to the
  pre-existing DATA-08 temporal assertion, not the doctor change.
  The separate DATA-08 correction is proposed in #19305.
- Decision/lifecycle: both remain `remediate` / `in-progress`.
  No cross-PR code copy, merge, CI rerun or closure authorized/performed.
  Integration must resolve the known dependency and produce clean relevant
  gate evidence before closure; provider/period limitations remain.

## 2026-10-21 - SOC2-LOG-010 - Two corrections integrated on assessment branch

- Type: observed remote integration and coordinator verification.
- Source/evidence: GitHub reports OPS-04
  [#19304](https://github.com/githubnext/gh-cao/pull/19304) merged at
  15:40:18 UTC as `90b865397`, DATA-08
  [#19305](https://github.com/githubnext/gh-cao/pull/19305) merged at
  15:40:41 UTC as `c85b8dfe7`, both into the assessment branch.
  This supersedes SOC2-LOG-009's earlier open-state observation.
- Specification version: 1. Related findings: OPS-04 and DATA-08.
- Coordinator's push detected remote advancement; it preserved both
  externally merged fixes and rebased its unpublished documentation commit.
  No remote merge, force push or PR-state change was performed by coordinator.
- Integrated check:
  `go -C server test ./internal/doctor ./internal/query -count=1 -json`
  passed with 311 passing test/subtest events, 18 PostgreSQL-dependent
  skipped cases and zero failures. Native-measure contract and doctor cases
  passed; this is not real-provider or full-repository validation.
- Decision/lifecycle: `remediate` / `in-progress` pending parent/default-branch
  integration and final required gates; no production/period control closed.
  Original design/failed-gate observations and skip limitations preserved.

## 2026-10-21 - SOC2-LOG-011 - Daily SelfCare worker authored and proposed

- Type: recurring workflow authoring/contract-validation milestone.
- Source/evidence: commit `c132cc6d01809d2b99fb86e36dd56430355a44ef`,
  draft [#19310](https://github.com/githubnext/gh-cao/pull/19310).
  Coordinator verified GitHub draft/head/base, changed-file scope and policy
  registration diff; authoring-session validation is separately attributed.
- Specification version: 1, section 8.
- Proposal: `self-care-server-soc2`, rolling 24-hour orchestrator eligibility
  and manual duplicate-day guard; exact existing target/live authority only.
  Worker registered across inventory/manifests/policy/dispatch; ceiling
  20 to 21 workers, no target/mode/credit-ceiling widening.
- Behavior: daily assessment/report even with an existing fix PR; at most
  three ranked current verified compatible code issues in one bounded draft
  PR; open/addressed remediation exclusion, no fabricated operational evidence.
  One-package/12-file/50-KiB/path limits protect workflow/policy/credentials.
  Blocked durable record deltas require explicit human consolidation.
- Reported validation: 303 workflow/policy and 258 control integration
  tests passed without skips; lint/both type checks passed; 73 workflows
  compiled and locks regenerated with fixed seed and inspected.
- Activation: pending review/default-control-branch integration, prerequisites,
  credentials and Actions configuration. No run/merge/deployment performed
  by authoring session or coordinator. Artifact retention is not proof of
  examination-period retention or effective controls.
- Decisions/findings: no risk accepted, exclusion approved or prior finding
  closed. SOC 2 readiness remains undetermined.

## 2026-10-21 - SOC2-LOG-012 - Stream and development-assurance proposals received

- Type: two bounded draft remediation proposals and validation handoffs.
- Source/evidence: IAM-002 commit
  `6839329d8c442f58f5ab552ddda792c104bc2c59`,
  draft [#19318](https://github.com/githubnext/gh-cao/pull/19318);
  OPS-03 commit `bb897f7e76932704aa5c22640257abfaa940237b`,
  draft [#19317](https://github.com/githubnext/gh-cao/pull/19317).
  Coordinator verified open/draft identities and scopes; session validation
  remains separately attributed.
- Specification version: 1.
- IAM-002 proposal: fixed OAuth stream authorization deadlines and bounded
  heartbeat session reads; existing helpers handle reconnect. Reported
  real-boundary/failure tests and repeated race checks pass; full server
  result retains database-dependent skips. Proxy/buffer/backend operation
  evidence remains required.
- OPS-03 proposal: reviewed config and plan explicitly restrict source-build
  apply to development; separate target digests/read-back and honest
  assurance receipts added. No production scanner/promotion pipeline
  claimed. Reported native check/race, Bicep/assets/package contracts,
  lint/type/compile/docs checks pass with mocked Azure calls.
- Integration dependencies: preserve IAM-001 expired-read semantics with
  stream checks; preserve separate image parameters when combining OPS-02
  telemetry templates; regenerate combined ARM.
- Decision/lifecycle: both `remediate` / `in-progress`, unmerged and
  undeployed. No production assurance/effectiveness or prior finding closed.
