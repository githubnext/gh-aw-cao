# Go server SOC 2 readiness assessment

## Assessment boundary and current status

Started 2026-10-21 against source revision
`ef7d9fb65ea952826f9d81a94bd5890d3cfd5634`.
This is an evidence-driven readiness investigation, not a SOC 2 attestation or
a declaration of compliance. No deployed environment, examination period,
service commitments, or organizational control evidence has been supplied.
This assessment alone authorizes no runtime or deployment changes. Subsequent
user-directed repository remediation is recorded in the authorization section
below; production changes and merging remain unauthorized.

All four bounded component investigations have reported. The initial
technical pass found **10 scoped design gaps** (one high, eight medium,
one low), **21 evidence-needed records**, and **one proposed profile
exclusion**, in addition to the initial cross-cutting evidence register.
These are workstream records, not independent criterion/control counts;
shared operational evidence dependencies are linked below. The initial
dispositions are preserved below; current remediation decisions are recorded
separately. Operating effectiveness is not assessed and no compliance
conclusion follows.

Highest-priority demonstrated design issue: DATA-01 can delete another
repository's evidence when distinct coordinates flatten to the same shard
prefix. Other demonstrated data gaps concern shared withdrawal erasure and
erasure projection ordering. Identity gaps concern unknown-expiry credential
cleanup and metadata-only long-lived stream authorization; EXEC-01's impact
depends on unverified account rename/reassignment behavior. OPS findings are
explicitly scoped to the stated audit/monitoring/build/diagnostic objectives.
An existing temporal query contract check also failed (DATA-08); the
assessment MUST NOT be described as having a clean overall validation gate.

The reusable procedure is
[soc2-server-assessment](../.github/skills/soc2-server-assessment/SKILL.md).
The maintained [assessment specification](../specs/server-soc2-compliance.md)
defines the evidence and decision contract; the append-only
[assessment changelog](SOC2-CHANGELOG.md) records changes and dispositions.
This register uses specification version 1. Component reports and later
operator decisions MUST update this register and append a changelog event.
The authoritative security intent remains [SECURITY.md](SECURITY.md) and the
referenced specifications. This inventory does not change the architecture.

Initial scope covers the `server/` Go module and its direct shared query,
deployment, and build dependencies. GitHub, database/cloud providers, the
operator's identity lifecycle, and downstream workflows are external trust
boundaries: assess their integration here, request independent operational
evidence, and do not assume their controls are effective.

Security/Common Criteria is the starting baseline. Availability, Processing
Integrity, Confidentiality, and Privacy require explicit applicability
decisions with the operator/auditor. They are not declared out of scope.
The [AICPA framework reference](https://www.aicpa-cima.com/resources/download/2017-trust-services-criteria-with-revised-points-of-focus-2022)
was consulted on 2026-10-21; exact engagement criteria and edition still need
confirmation.

## System and data-flow map

```text
Browser -> trusted listener/proxy -> same-origin Go app -> canonical query store
                                   | OAuth sessions       PostgreSQL (hosted)
                                   | quotas/cache         SQLite (local)
                                   v
                            operational services
                            PostgreSQL / Redis / memory

GitHub -> signature/OIDC checks -> collection/admission/gateway queues
                                      |                  |
                                      v                  v
                             canonical publication   dispatch GitHub workflows

Step-up administrator -> declared CLI queue -> isolated executor -> GitHub App API

Security-relevant actions -> audit chain -> independent delivery destination
All roles -> bounded telemetry -> operator monitoring and incident process
Reviewed source -> CI/package scans -> image/artifact -> operator-controlled host
```

The arrows are logical boundaries, not a promise that all roles/features run
together. Production gateway ingress and dispatch can be separate processes;
hosted CLI web admission and execution have different credential authority.

| Component | Primary paths | Assets and boundary | Workstream |
| --- | --- | --- | --- |
| Entrypoints and hosting | `server/cmd/`, `server/hosting/`, `server/internal/server/hosted.go` | Local bearer vs hosted OAuth; process roles; trusted HTTPS listener/proxy | IAM |
| HTTP, OAuth, browser session, MCP | `server/internal/server/` auth, OAuth, proxy, CORS, CSRF, rate-limit and MCP handlers | User/admin identity, membership refresh, step-up, Actions OIDC and API tokens | IAM |
| Canonical database and query execution | `server/internal/postgresx/`, `dashboardstore/`, `sqlitex/`, `query/`, `sqlbuilder/`, `internal/dashboardquery/` | Dataset-wide access; bounded queries; transaction/snapshot integrity | DATA |
| Ingestion and collection | `server/internal/ingest/`, `collect/`, server collector handlers | Manifest/source trust, collection credentials, atomic publication and retention | DATA |
| Operational adapters and database privileges | `server/internal/operational/`, `redisx/`, `postgresconn/`, `server/postgres/` | Sessions, protected queues, replay records; owner/runtime/retention/evidence separation | DATA |
| Derived services | `server/internal/repositorymemory/`, `marketplace/`, `operationalvalue/`, `model/` | Untrusted evidence and external registries; caching/publication authority | DATA |
| Activation and conclusion protocols | `server/internal/admission/`, server admission handlers | Exact enrollment, OIDC, accounting freshness, replay and partial evidence | EXEC |
| Webhook gateway | `server/internal/webhookgateway*/`, `server/cmd/cao-webhook-gateway/` | Signed ingress, policy revisions, discovery, durable dispatch and ambiguous outcomes | EXEC |
| Hosted CLI and credential/egress brokers | `server/internal/hostedcli/`, `githubapp/`, `cliegress/`, `githubquota/`, CLI relay/quota commands | Step-up admission, live repository permissions, isolated execution, token cleanup | EXEC |
| Audit trail and independent export | `server/internal/audit/`, `auditdelivery/`, `server/audit-delivery/` | Evidence integrity, independent anchors/destination, retention and alerting | OPS |
| Telemetry, diagnostics and lifecycle | `server/internal/telemetry/`, `logger/`, `doctor/`, server health/lifecycle | Sensitive-data exclusion, alert routing, shutdown/recovery and incident evidence | OPS |
| Build, release, deployment and contract | `server/Dockerfile`, `server/spec/`, `server/azure/`, `.github/workflows/cgo.yml`, `cao-package.yml`, relevant deployment scripts | Provenance, vulnerability management, approvals, secrets, rollback, service providers | OPS |
| Test infrastructure | `server/internal/simulator/`, `testutil/`, package tests | Synthetic evidence only; never a substitute for production operating evidence | Each owner |
| Shared infrastructure | `server/internal/clock/` and shared contracts | Time/expiry assumptions and package relationships | Each owner |

Paths abbreviated within the table are relative to `server/internal/` where
unambiguous. The assessment reports cite exact paths and line ranges.

### Profiles that must not be conflated

| Profile | Assessment distinction |
| --- | --- |
| Local `serve` with SQLite | Trusted loopback operator, capability authentication, read-only snapshot; not a public hosted deployment |
| Hosted/external listener | GitHub OAuth and explicit organization/team policy; same-origin app; exact trusted proxy/host boundary |
| Azure Functions | Hosted identity plus platform listener, secret-manager, network and lifecycle controls; templates are not deployed evidence |
| Operational PostgreSQL | Durable default; canonical and operational state have distinct contracts and privilege requirements |
| Operational Redis | Explicit alternative with transport, namespace, capacity and durability assumptions |
| Operational memory | Explicit single-process volatile exception; restart invalidates state and can lose pending work |
| Admission-only and separate workers | Disabled/explicitly selected capabilities; protected PostgreSQL replay and enrollment required |
| Gateway local SQLite vs production roles | Local file authority differs from PostgreSQL role separation; ingress and dispatch credentials differ |
| Experimental hosted CLI | Off by default; execution platform, egress, image, live authority and cleanup evidence needed per enabled runner |

## Investigation assignments

Four coordinated read-only sessions own the workstreams above. They follow
the assessment skill, investigate implementation and focused tests deeply,
and save reports as session artifacts. They must not fix issues or change
production. Each report includes its exact source SHA, component coverage,
control matrix, findings, limitations and operator decision requests.

| Workstream | Working criteria focus | Initial state |
| --- | --- | --- |
| IAM: identity and HTTP access | CC6, CC7; authorization, sessions, transport and resource admission | Report received; scoped review complete; operational evidence pending |
| DATA: persistence and data handling | CC6, CC7; candidate C1, PI1 and A1; storage, integrity, retention and recovery | Report received; scoped review complete; operational evidence pending |
| EXEC: admission, gateway and execution | CC6, CC7, CC8; candidate PI1; bounded authority and privileged side effects | Report received; scoped review complete; operational evidence pending |
| OPS: audit, operations and releases | CC7, CC8, CC9; candidate A1; evidence integrity and operational dependencies | Report received; scoped review complete; operational evidence pending |

The investigation baseline, including the shared assessment procedure, is
`e3daa5d7ad4fa537e6432359076b44f4a90be171`. It changes documentation only
relative to the runtime revision above. Coordinated session identifiers:

| Workstream | Session ID |
| --- | --- |
| IAM | `0cab34cf-451f-469b-88d8-6c3727a86702` |
| DATA | `3665e605-4134-497a-b22a-08335594f363` |
| EXEC | `295a6967-1963-4ef9-80a1-ec87bee9f18b` |
| OPS | `76a730cd-672d-4c67-9e03-cb2c3c0460fe` |

These are working mappings, not conclusions about whole criteria.
Cross-cutting CC1-CC5 governance and risk assessment remain coordinator-owned
operator evidence requests. Completion requires consolidation of all four
reports, deduplication, and explicit accounting for unreviewed surfaces.

## Initial evidence and operator decision register

The entries below are evidence requests, not confirmed implementation defects.
Source review establishes neither deployed settings nor historical operation.
No operator decision has been made.

| ID | Status | Operator decision/evidence needed | Suggested accountable role |
| --- | --- | --- | --- |
| SCOPE-01 | evidence-needed | Confirm system boundary, production profiles/features, commitments, Type 1/Type 2 objective and examination date/period | Service owner and auditor |
| SCOPE-02 | evidence-needed | Determine applicability of A1, PI1, C1 and P1-P8 using data classification, contracts and actual processing | Compliance/privacy owner |
| GOV-01 | evidence-needed | Supply approved control owners, risk assessment, security policies, personnel training and vendor oversight evidence for CC1-CC5/CC9 | Compliance owner |
| IAM-OP-01 | evidence-needed | Supply sanitized effective identity/admin/App scope configuration, access review and offboarding evidence | Identity owner |
| DATA-OP-01 | evidence-needed | Supply database-role review, encryption/key rotation, retention/deletion configuration, backup and restore evidence | Data/platform owner |
| OPS-OP-01 | evidence-needed | Supply independent audit anchor/destination/retention evidence, alert delivery/acknowledgements and incident exercise records | Security operations |
| REL-OP-01 | evidence-needed | Supply enforced branch protections, actual release approvals, image provenance/digests, scan dispositions and rollback evidence | Release owner |
| BCP-OP-01 | evidence-needed | Define RTO/RPO and service objectives; supply recovery/failover exercises and vendor dependency review | Service/platform owner |

Existing [hosted CLI SOC 2 mapping](SECURITY.md#soc-2-evidence-boundary),
[PostgreSQL authority separation](POSTGRES.md#authorities), and
[independent audit delivery](audit-delivery/README.md) are starting evidence,
not controls certified by this report.

## Consolidation and decision gate

### Current remediation authorization and sessions

On 2026-10-21 the operator directed: "start session to fix each findings",
then "create an self care agentic workfler worker that does this check again
and fixes the top 3 issues daily".

This authorizes scoped repository implementation/tests and draft PRs for the
10 design gaps and investigation/remediation of the failed DATA-08 gate.
Those records now have decision **remediate**, lifecycle **in-progress**.
The assessment observations/statuses below remain the original baseline,
not claims that fixes are verified, merged or deployed. Suggested owners
remain suggested organizational roles; the sessions own repository work only.

Evidence-only records other than DATA-08 and the proposed exclusion retain
decision **pending**, lifecycle **open**. The directive does not manufacture
deployment/history evidence, accept risk, approve an exclusion, grant secret
access, widen rollout, or authorize production execution/merge.

Each remediation session starts from the consolidated assessment baseline
`748093b701ef9cf22e0323ac84fc6b026ea526ac`, owns one focused draft PR and
reports validation/limitations to the coordinator. Central assessment records
remain coordinator-owned to avoid conflicting edits.

| Finding / work | Session ID | Current state |
| --- | --- | --- |
| DATA-01 shard identity/erasure collisions | `603b87ae-e256-4f86-b590-e9181384fda8` | Remediation launched |
| DATA-02 shared withdrawal erasure | `270f92b9-f242-4792-aebc-5333c54a7f91` | Remediation launched |
| DATA-03 durable erasure projection intent | `fcb3024f-e955-4995-89c0-9a3234795319` | Remediation launched |
| IAM-001 unknown-expiry credential cleanup | `5b7894b6-166a-4b55-bfdb-7723269d970d` | Remediation launched |
| IAM-002 existing-stream revocation | `69b8c769-0b58-4322-ae9f-8fe97875d0ca` | Remediation launched |
| EXEC-01 immutable queued requester identity | `1b133541-ad96-4c4e-9944-4497920f71e0` | Remediation launched |
| OPS-01 durable rebuild attribution | `10ab76b1-e205-4b8c-ad67-28870959d441` | Remediation launched |
| OPS-02 explicit Azure Go telemetry route | `69ae4f91-2de9-4617-b1ec-35698d58ba66` | Remediation launched |
| OPS-03 source-built image assurance | `61c4bba4-3caa-43af-89e5-5b3b3573097f` | Remediation launched |
| OPS-04 unknown persistence diagnostic | `39f2395b-aea6-4e1e-9dbc-d9867e7c8083` | [#19304](https://github.com/githubnext/gh-cao/pull/19304) merged into assessment branch; targeted integration passed; default-branch/deployment closure pending |
| DATA-08 failing temporal query contract | `ca0f22b3-e8a7-4244-bf2c-35c0e1027c3d` | [#19305](https://github.com/githubnext/gh-cao/pull/19305) merged into assessment branch; targeted integration passed; default-branch gate pending |
| Daily SelfCare SOC 2 worker | `e0f32d7e-d753-4484-8876-251fd467257d` | Authoring launched; not active/deployed |

The recurring worker must follow
[specification section 8](../specs/server-soc2-compliance.md#8-daily-selfcare-reassessment-and-bounded-remediation).
It is a proposed reviewed workflow, not an app session automation. Daily
execution is not active until the workflow/policy changes are reviewed,
merged and installed on the applicable default branch.

The following report sections preserve initial observations and initial
pending decisions. This current authorization table supersedes only those
decision/lifecycle fields explicitly listed above. A draft PR is not closure.

On 2026-10-21 at approximately 15:39 UTC the coordinator refreshed GitHub:
OPS-04 and DATA-08 PRs are both open and non-draft with unchanged heads.
Their initial draft creation is preserved in history; the current review
state was not overridden. OPS-04's Go CI fails on the existing DATA-08
temporal query assertion, according to the remediation session's log review
and baseline-tree comparison. The coordinator verified the failing check and
the separate DATA-08 correction PR; it has not merged/copied either fix or
declared the affected integration gate clean.

Subsequent GitHub refresh observed OPS-04 merged at 15:40:18 UTC and
DATA-08 at 15:40:41 UTC, into this assessment branch as `90b865397` and
`c85b8dfe7` respectively. These remote merges were not initiated by the
coordinator. It preserved them while rebasing one unpublished documentation
commit, without overriding remote work or changing PR review state.

The coordinator then ran
`go -C server test ./internal/doctor ./internal/query -count=1 -json` on
the integrated source: **311 passing test/subtest events, 18 skipped,
zero failures**. All skips are PostgreSQL-dependent query cases; the
renamed native-measure contract and doctor cases passed. The DATA-08 session's
isolated PostgreSQL-backed result remains additional, separately sourced
evidence. Artifact:
`/Users/peli/.copilot/session-state/d19b961a-c3f0-469a-847f-bcd18d3c8d23/files/soc2-integrated-doctor-query-tests.jsonl`.

Both records remain decision **remediate**, lifecycle **in-progress** for
default-branch integration/relevant final checks. OPS-04's original design-gap
and DATA-08's original failed-gate observations remain historical; the
assessment branch now contains their technical corrections. No deployed
provider/backup control or operating-period evidence is closed.

#### OPS-04 remediation proposal received 2026-10-21

Draft [#19304](https://github.com/githubnext/gh-cao/pull/19304), commit
`c480c3027785444a53e814802bf9776bb9f02fbc`, targets this assessment branch.
The coordinator verified its open/draft state, exact head and three-file
scope: doctor implementation/tests and server README. The finding remains
**design-gap**, decision **remediate**, lifecycle **in-progress** until
review/integration and applicable closure evidence; it is not deployed.

The proposal warns on missing/malformed persistence observations, preserves
unknown AOF enablement instead of coercing it to disabled, and no longer treats
RDB-only historical success as proof of active snapshot policy. Explicit
enabled-AOF successful writes pass only as a limited observation, not proof
of durability/recoverability. Known write errors still warn.

The remediation session reports passing formatting, doctor normal/race
tests, vet/build, full server golangci-lint (zero issues), workflow compilation
and diff checks. Added tables cover missing/malformed/partial/RDB/AOF/
combined/provider omissions. These are reported local results, not a new
independent provider assessment or historical operating evidence.

No CONFIG access, live Redis changes or merge occurred. Provider persistence
policy, backup retention, accepted-work RPO/RTO and actual restore operation
remain evidence requests under DATA-07/OPS-06 and are not closed by this PR.

#### DATA-08 remediation proposal received 2026-10-21

Draft [#19305](https://github.com/githubnext/gh-cao/pull/19305), commit
`d2d640bd3301617d27919e6634ef63c2b50f321f`, targets this assessment branch.
The coordinator verified open/draft/head/base identity and that the only
changed file is `server/internal/query/sql_temporal_test.go`.

The remediation session traced the failure to stale fixture wiring:
[#19293](https://github.com/githubnext/gh-cao/pull/19293) intentionally
retired legacy Operational Value pages and moved
`operational-value-plot-series` to
`dashboard/site/test/fixtures/native-measure-history-query.json`.
The SQL test still searched `campaign-insights.json`. The proposal names
the test `TestTemporalSQLNativeMeasureHistoryQuery`, loads the shared
fixture, preserves panel/link/order assertions and adds canonical source/
native metric identity, point metadata, dimension-isolation and 100,000-row
SQL bound checks. It does not alter production queries or infer a runtime
processing defect.

The session reports reproducing the original failure, then passing the
renamed targeted check and full query suite against isolated PostgreSQL
18.6 with both `POSTGRES_URL` and `TEMPORAL_TEST_POSTGRES_URL`: 214 passing
test/subtest events, zero failures/skips. Related dashboard contract
selectors passed 74 tests; query vet/build/lint, formatting, workflow
compilation and diff checks passed. Temporary DB resources were removed;
no deployed service/data was examined. Evidence:
`/Users/peli/.copilot/session-state/ca0f22b3-e8a7-4244-bf2c-35c0e1027c3d/files/data08-query-tests.json`.

Decision remains **remediate**, lifecycle **in-progress**, evidence status
**evidence-needed** at the original baseline until reviewed integration.
The historical failed gate is preserved, not rewritten as a pass.
Post-integration relevant-gate evidence is still required for closure;
other workstreams' skipped database/operating evidence remains unverified.

### DATA report received 2026-10-21

Assessed exact source `e3daa5d7ad4fa537e6432359076b44f4a90be171`, runtime
`ef7d9fb65ea952826f9d81a94bd5890d3cfd5634`. Detailed report:
`/Users/peli/.copilot/session-state/3665e605-4134-497a-b22a-08335594f363/files/soc2-data-assessment.md`.
All records are lifecycle **open**, decision **pending**, operating
effectiveness **not-assessed**. Confidence is **high** in observations and
evidence absence; DATA-10 operational impact confidence is **medium**.
No production loss, deployed collision or actual crash-loss was established.

| ID / status / severity | Profile, expected/observed property and working mapping | Source evidence at assessed SHA | Counter-evidence / limits |
| --- | --- | --- | --- |
| DATA-01 / design-gap / high | Collector lake: repository identity must remain distinct during acquisition/erasure. Flattening slash to hyphen makes valid `octo-a/b` and `octo/a-b` share `octo-a-b-logs-`; Forget of one deletes the other's matching files. CC6.1; PI1.3/A1.2 candidates | `server/internal/collect/lake.go:74-78,125-145,160-169`; `server/internal/collect/runner.go:249-276` | Production-helper observation reproduced cross-repository file deletion using synthetic files. Volatile startup detects ambiguity (`server/internal/collect/volatile_recovery.go:89-91,146-172`), but ordinary durable collection/Forget does not use that check. Enrollment ownership/leases do not make encoding injective. |
| DATA-02 / design-gap / medium | Collector withdrawal: shared `operational-values.jsonl` retains withdrawn repository bytes; Forget removes only prefixed shards, while retained merge has no withdrawal filter and zero-enrollment refresh returns early. CC6.5; C1.2/P4/P6 candidates | `server/internal/collect/lake.go:125-145`; `server/internal/collect/projector.go:273-279,302-330`; `server/internal/operationalvalue/collector.go:341-357,845-897`; `specs/server-ingestion.md:362-388` | Synthetic production-helper test confirms retained disk bytes, NOT canonical reappearance. Prefixed shards are removed and durable erasure admission exists. Explicit independently published packets require DATA-06's separate scope decision, not indiscriminate deletion. |
| DATA-03 / design-gap / medium | Collector erasure ACK precedes durable projection intent; crash/cancellation/state-write failure in the gap can leave old canonical rows until later replay/activity. CC7.2; PI1.3/C1.2 candidates | `server/internal/collect/worker.go:153-165,242-271,312-347`; `server/internal/collect/queue.go:320-327`; `server/internal/collect/projector.go:122-131`; `specs/server-ingestion.md:386-389` | Production worker-helper observation leaves queue empty and projection marker false; no real crash injected. Restart backfill/future activity can repair, and scope refresh persists intent before ACK. This is not permanent loss or a backend replacement-atomicity defect. |
| DATA-04 / evidence-needed / high conditional authority priority | Hosted PostgreSQL/Redis: deployed owner/runtime/evidence/retention roles, inherited/PUBLIC/default privileges and principal isolation remain unknown. CC6.1-CC6.3 | `server/postgres/operational-grants.sql:1-45`; `server/postgres/canonical-grants.sql:1-28`; `server/POSTGRES.md:70-176`; `server/internal/operational/postgres/store.go:154-177`; `server/internal/postgresx/provisioned.go:15-31` | Granular fresh-role grants, guards/fixed functions and explicit provisioning support design; startup is not a scrubber for all inherited privileges. Real-principal tests skipped. Namespaces/SQLite files do not establish hostile-principal isolation. |
| DATA-05 / evidence-needed / medium | Persistent databases/lake/snapshots: encryption at rest, key custody, credential rotation/recovery and transport exceptions need actual configuration/period evidence. CC6.1, CC6.7; C1.1 candidate | `server/internal/postgresconn/config.go:29-60`; `server/internal/redisx/client.go:112-151`; `server/internal/server/oauth.go:1313-1369`; `server/internal/operational/sqlite/store.go:82-107`; `server/internal/collect/lake.go:200-232` | Verified remote DB TLS and encrypted session/revocation records support design. File permissions/WAL are not disk encryption and canonical data is not globally application-encrypted. Coordinate IAM-006/OPS-07. |
| DATA-06 / evidence-needed / medium | Governed retention, derived copies, independent packets, legal holds and deployed maintenance/deletion schedules are unknown. CC6.5; C1.2/P3-P8 candidates | `server/internal/postgresx/partitions.go:19-22,38-105,218-293`; `server/internal/operationalvalue/collector.go:30-36`; `server/internal/operational/postgres/schema.sql:158-182`; `server/internal/postgresx/value_preservation.go:13-74` | Default run/linked/value/audit lifetimes differ (30/7/365/400 days); weekly partitions and bounded audit oldest-prefix retention need schedule/backlog review. This does not assert any chosen duration violates commitments. DATA-02 is the separate demonstrated withdrawal gap. |
| DATA-07 / evidence-needed / medium | Provider persistence/replication/eviction and filesystem power-loss semantics have not established accepted-work RPO/RTO. CC7.3-CC7.5, CC9.2; A1.2/A1.3 candidates | `server/internal/operational/postgres/store.go:365-380`; `server/internal/redisx/stream.go:28-85,145-210`; `server/internal/collect/lake.go:200-232`; `server/internal/operationalvalue/collector.go:923-952` | Atomic rename/publication is not unconditional power-loss durability: lake helper does not sync parent directory; value writer lacks file sync. Replay/incomplete-recovery handling exists. No crash-loss finding; OPS-06 owns overall backup/restore commitments. |
| DATA-08 / evidence-needed / medium validation priority | Existing `TestTemporalSQLDeployedCampaignQuery` fails: required `operational-value-plot-series` fragment query not found. CC8.1; PI1.2 candidate | `server/internal/query/sql_temporal_test.go:182-220` | Scoped package command exit 1 with this sole failed test event; no DB needed. Could be stale test or declarative drift; no runtime processing defect inferred. Independent local evaluator passes do not resolve the failed SQL/campaign contract. |
| DATA-09 / not-applicable-proposed / informational | Local read-only SQLite, local operational SQLite and acknowledged hosted memory need explicit applicability decisions for production durability/principal-isolation commitments. CC6.3; A1.2/C1.1 candidates | `server/internal/server/local_sqlite.go:45-52`; `server/internal/sqlitex/store.go:58-73`; `server/internal/operational/sqlite/store.go:1-5,82-107`; `server/internal/server/operational_factory.go:85-102` | Local/volatile guards preserve identity controls but do not grant durable availability. Local confidentiality/privacy is not automatically excluded. No exclusion approved. |
| DATA-10 / evidence-needed / low | Physical SQL/temp/process and metadata-source ceilings need bounded-work measurements, not only logical row/operation limits. CC7.1; A1.1 candidate | `server/internal/postgresx/sql_plan.go:104-172`; `server/internal/postgresx/store.go:317-339`; `server/internal/repositorymemory/memory.go:112-134,159-174`; `server/internal/marketplace/resolve.go:78-91` | Query timeout/structural limits and trusted-source/HTTP bounds reduce exposure. Manifest reads/JSON helper lack some pre-materialization byte guards; actual resource impact or arbitrary attacker source control not demonstrated. Fleet stress not run. |

#### DATA operator choices and closure evidence

| Finding | Proposed choice / tradeoff | Suggested owner | Evidence required for closure |
| --- | --- | --- | --- |
| DATA-01 | Prioritize sanitized collision inventory and authorize collision-safe encoding/migration or fail-closed admission; preserve legacy evidence. | Collector/data + platform | Valid colliding-coordinate production-helper regressions, legacy cache/replay migration, unrelated-evidence preservation and sanitized rollout verification |
| DATA-02 | Define and authorize repository-scoped shared/derived evidence deletion; separately decide independent packet/hold authority. | Data + privacy/compliance | End-to-end withdrawal across shared shards/canonical/cache/applicable packets, zero-enrollment, unrelated rows and failure/retry trace |
| DATA-03 | Persist follow-up before ACK and review restart-safe marker/epoch clearing; safe repeat projection trades load for recoverability. | Collector reliability | Marker-write/cancel/crash failure injection through canonical commit, preserving concurrent intent; review `server/internal/collect/projector.go:174-195` |
| DATA-04 | Collect effective grants and authorize disposable real-principal checks. | DBA/platform/security | Sanitized ownership/membership/table/column/default/PUBLIC ACL/search-path review, absent owner credentials in runtime, distinct principal boundaries and real role tests |
| DATA-05 | Collect provider/disk/KMS/TLS/key lifecycle evidence; choose encryption design against commitments, not blanket field encryption. | Platform/security + IAM/OPS | Sanitized encryption/credential scope/rotation/retirement/recovery references and explicit transport exceptions |
| DATA-06 | Approve per-copy retention, partition overshoot, erasure SLA and holds; retain independent evidence only under agreed authority. | Data/privacy + DBA | Approved inventory/lifetimes, actual maintenance/backlog/hold/alert records, end-to-end disposal and backup-expiration references |
| DATA-07 | Define accepted-work RPO/RTO and assess selected volume/provider durability. | SRE/platform + data/OPS | Effective WAL/replication/non-eviction/volume settings, real recovery/replay tests preserving queues/revocations/audit and residual replay window |
| DATA-08 | Investigate contract/test drift in an authorized follow-up; do not weaken/skip assertion to green the gate. | Dashboard/query | Reviewed cause/disposition, targeted failing test and clean relevant SQL/fixture gate |
| DATA-09 | Approve narrow profile exclusion or prohibit weak profiles for specific commitments. | Service owner + auditor | Actual enabled-profile inventory and explicit applicability approval; classified local data remains accounted for |
| DATA-10 | Measure effective DB/process/source ceilings and authorize tighter bounds only if required. | Query/data + SRE | Work/temp/concurrency/source-publication bounds, targeted worst-case measurements and alert evidence; assess legitimate-workload rejection tradeoff |

#### DATA verification and remaining coverage

The main scoped package command exited **1**, reporting 1,055 passed,
220 skipped and one failed test/subtest events: DATA-08. It covered
postgresconn/sqlbuilder/query/sqlitex, memory/Redis/PostgreSQL stores,
ingest/collect, registry/repository memory/value services and model/store
contracts. Additional commands passed: selected boundary cases (66 pass,
20 skip events), operational/SQLite conformance (118 pass, 21 skip),
`go -C internal/dashboardquery test -json ./...` (1,121 pass), and synthetic
snapshot/CLI download checks (76 pass).

Three artifact-only `go -C server test -overlay ... -json ./internal/collect
-run '^TestDATAObserve' -count=1` observations passed by reproducing current
DATA-01/02/03 adverse behavior, not verifying fixes. Counts overlap and include
subtests; they MUST NOT be summed into unique controls or a compliance rate.
Real PostgreSQL/Redis role, retention, recovery, transaction/parity and
connection-loss paths remain skipped/unverified; no live services were used.
The initial local Go 1.27.1 prerequisite failed, then automatic required
toolchain selection allowed execution. No runtime/repository changes made.
Full exact commands, overlay sources, logs and skip breakdown are in the
report artifact directory.

Source hashes authenticate content relative to their manifest, not publisher
identity. Operator-selected server snapshots can use HTTP and lack the native
CLI's independent manifest pin; trusted HTTPS or independently verified local
input remains an explicit operator boundary. Replay cannot reconstruct
unretained external events or lost revocation/independent-publication state.

### IAM and EXEC reports received 2026-10-21

Both reports assessed exact source
`e3daa5d7ad4fa537e6432359076b44f4a90be171` and unchanged runtime
`ef7d9fb65ea952826f9d81a94bd5890d3cfd5634`. Detailed reports:

- IAM: `/Users/peli/.copilot/session-state/0cab34cf-451f-469b-88d8-6c3727a86702/files/soc2-iam-readiness.md`.
- EXEC: `/Users/peli/.copilot/session-state/295a6967-1963-4ef9-80a1-ec87bee9f18b/files/exec-soc2-readiness.md`.

All findings below have lifecycle **open**, operator decision **pending** and
operating effectiveness **not-assessed**. Confidence is **high** in the stated
source observation/evidence absence; EXEC-01's conditional provider-lifecycle
impact has **medium** confidence. No live exploit, incident, production
configuration or provider lifecycle behavior was established.

| ID / status / severity | Profile, expected/observed property and working mapping | Source evidence at assessed SHA | Counter-evidence / limits |
| --- | --- | --- | --- |
| IAM-001 / design-gap / medium | OAuth responses without expiry metadata: callback assigns local deadlines; no-refresh near-expiry deletes session without staging credential cleanup, and queued cleanup treats assigned deadlines as provider expiry. Session lifetime is not actual credential expiry. CC6.2, CC6.3, CC7.4 | `server/internal/server/oauth.go:483-495,744-752,1136-1147,1175-1181` | CAO access fails closed; cookies clear; normal logout/CAS/durable retry design is supported. Concern is abandoned still-valid provider credentials, not restored CAO authority or disclosed tokens. Provider grants/scopes remain unknown. |
| IAM-002 / design-gap / low | OAuth SSE streams retain connection-time authorization after revocation/admin assurance expiry; no application-level stream revalidation or maximum age. CC6.2, CC6.3 | `server/internal/server/server.go:1011-1044,1258-1320,1336-1341,1892-1906`; `server/internal/server/oauth.go:690-742` | Only revision/healthRevision integers continue, not rows, credentials or execution authority. New HTTP requests fail; drain/cancel closes streams. Proxy lifetime may mitigate but was not verified. |
| IAM-003 / evidence-needed / high evidence priority | Effective audience, administrator scope and identity lifecycle are unknown. Explicit AllowedUsers authorizes OR org/team, intentionally; dataset-wide entitlement needs approval. CC6.1-CC6.3; CC1-CC5/CC9.2 dependencies | `server/internal/server/oauth.go:970-990`; `server/internal/server/hosted.go:176-189`; `server/internal/server/azure.go:323-337`; `server/internal/server/server.go:1065-1100` | Explicit-user/member-removal/assurance/OIDC scenarios pass. Source cannot establish real access reviews/offboarding or that org/team-only shorthand describes effective configuration. No accidental bypass asserted. |
| IAM-004 / evidence-needed / medium | Privileged OAuth assurance is recent authorization plus 2FA enrollment/attested SSO, not evidence of a fresh second-factor ceremony. CC6.3 | `server/internal/server/oauth.go:400-403,525-529,614-651`; `specs/server-hosted-cli.md:111-136` | Bounded assurance age/admin allowlist/no-refresh extension are enforced. This matches the existing assurance specification; a stronger company MFA claim needs provider evidence, not a fabricated implementation defect. |
| IAM-005 / evidence-needed / high evidence priority | Trusted proxy/platform forwarding and custom-handler isolation need deployed proof. Azure intentionally relies on platform forwarding rather than app CIDRs. CC6.6, CC6.7, CC7.1, CC9.2 | `server/internal/server/hosted.go:198-208,281-318`; `server/internal/server/azure.go:108-153,171-185,318-322,375-389,414-425`; `server/cmd/cao-functions/main.go:42-55,76-98` | Loopback defaults, host-neutral trusted peers/TLS and development gates exist. No exposed backend or forged-header acceptance was demonstrated. Coordinate with OPS-07. |
| IAM-006 / evidence-needed / medium | Key custody/rotation, durable revocation and real-adapter failure/restart guarantees lack operating evidence; volatile exceptions need explicit disposition. CC6.2, CC6.7, CC7.4, CC9.1; A1/C1 candidates | `server/internal/server/oauth.go:262-277,1116-1181,1319-1382`; `specs/server-operational-storage.md:181-210`; `server/internal/testutil/postgres.go:19-28` | AES-GCM, current/previous key support, CAS and capability validation support design. Memory intentionally loses retries on restart. Durable storage does not fix IAM-001's independent application lifecycle defect. |
| EXEC-01 / design-gap / medium | Hosted CLI queues preserve mutable actor login, not numeric requester identity; delayed permission recheck cannot prove it addresses the original account after rename/reassignment. CC6.2, CC6.3; PI1 candidate | `server/internal/operational/cli_commands.go:95-106`; `server/internal/server/hosted_cli.go:250-255`; `server/internal/hostedcli/executor.go:303-313,405-417`; `server/internal/githubapp/scoped_token.go:211-230` | Conditional stronger identity-continuity objective, not a wire-spec violation or proven GitHub exploit. Admission step-up, live writer permission and single-repository limits remain; callback/consent bind numeric identity and active renames deny subsequent session use, but not already queued work. |
| EXEC-02 / evidence-needed / high if production CLI enabled | Real Linux Docker isolation/egress has not been validated on the intended executor. CC6.6, CC6.7, CC7.1 | `specs/server-hosted-cli.md:471-518`; `server/internal/server/hosted_cli_runtime.go:28-48`; `server/internal/hostedcli/docker_container.go:43-133`; `server/internal/hostedcli/docker_egress.go:26-132` | Strict startup/network-none/read-only/capability/relay/digest controls have mock coverage. CONNECT restricts destinations, not content/exfiltration to allowed hosts. Real kernel boundary deliberately not run on this macOS assessment. |
| EXEC-03 / evidence-needed / medium | Admission is a cooperative start check: protected accurate accounting publisher and effective client/outage configuration are required, not an unavoidable financial cap. CC6.3, CC7.2; PI1 candidate | `server/internal/admission/policy.go:140-203`; `server/internal/server/activation_admission.go:47-58`; `server/ADMISSION.md:3-21,182-210,266-278` | Exact identity/enrollment/freshness fail closed; conclusion deliberately admits completed-run evidence independently of budget freshness. Upstream client interoperability fixtures were absent. |
| EXEC-04 / evidence-needed / medium | Durable replay receipts, fences, cleanup journals and recovery need selected real-backend/namespace/capacity evidence. CC6.5, CC7.4, CC7.5; A1/PI1 candidates | `server/internal/operational/postgres/activation_admission.go:40-77`; `server/internal/operational/postgres/conclusion_admission.go:27-95`; `server/internal/hostedcli/broker.go:394-484,491-600`; `server/internal/hostedcli/recovery.go:10-37` | Synthetic/SQLite restart/fault cases support design, not PostgreSQL durability. Permanent receipts intentionally trade capacity for replay protection; deleting them is not an authorized recovery. DATA/OPS recovery evidence remains a dependency. |
| EXEC-05 / evidence-needed / high if privileged features enabled | Gateway/CLI App keys, process identities, secret mounts and installation reach require actual separation/access evidence. CC6.1-CC6.3, CC6.5, CC9.2 | `server/cmd/cao-webhook-gateway/main.go:175-202`; `server/internal/githubapp/webhook_gateway_role.go:14-64`; `server/internal/githubapp/scoped_token.go:126-192,318-353`; `server/internal/server/hosted_cli_env.go:85-139` | Role-variable rejection, dedicated keys and repository-scoped tokens support design. App-key/host compromise has broader reach. Startup-loaded keys require coordinated restart; gateway tokens must not be described as hosted-CLI single-use cleanup tokens. |
| EXEC-06 / evidence-needed / medium | Authorization observation, local reservation and remote acceptance are not atomic; accepted sends cannot be recalled and ambiguity is terminal for automatic replay. CC6.3, CC7.4, CC8.1; PI1 candidate | `server/internal/webhookgatewayhost/authority.go:104-176`; `server/internal/webhookgateway/worker.go:128-249`; `specs/rfc-033-webhook-gateway.md:764-808`; `specs/server-hosted-cli.md:300-322` | Fresh worker checks/fences/ambiguity handling bound risk. CLI step-up is checked at admission, not each execution. Do not promise immediate remote revocation or exactly-once workflow execution. |
| EXEC-07 / evidence-needed / medium for enabled native development | Apple/Windows SQLite development runners need actual platform ownership, workspace and termination evidence or explicit exclusion. CC6.1, CC6.6, CC7.4, CC7.5 | `server/internal/hostedcli/apple_container.go:34-98`; `server/internal/hostedcli/apple_execution.go:109-183`; `server/internal/hostedcli/windows_sandbox.go:148-234,273-356,389-496`; `specs/server-hosted-cli.md:400-467` | Fake-command/lifecycle tests pass; explicit platform/SQLite gating exists. Native runners permit network access and are not production Docker's restricted-egress boundary. Real Apple/Windows behavior unverified. |
| EXEC-08 / evidence-needed / low scoping priority, medium if confidential outputs unmanaged | Output/evidence classification, retention and scope require approval; local simulation/quota cannot establish real dispatch or distributed authority. CC7.2, CC8.1, CC9; A1/PI1/C1/P applicability | `server/internal/hostedcli/output.go:14-127`; `server/ADMISSION.md:141-168`; `server/internal/webhookgatewaylocal/simulation.go:128-133`; `server/cmd/cao-cli-quota/main.go:414-441` | Known-token redaction is not universal PII/content redaction; protected receipts intentionally outlive compact payloads. Local dispatcher is explicitly synthetic and local quota uses memory. Coordinate DATA/OPS evidence, not duplicate independent-audit findings. |

#### IAM and EXEC operator choices and closure evidence

| Finding | Proposed choice / tradeoff | Suggested owner | Evidence required for closure |
| --- | --- | --- | --- |
| IAM-001 | Separate session lifetime from provider expiry and preserve unknown-expiry cleanup; reconcile abandoned grants. Retained cleanup consumes protected capacity and may need escalation. | Identity/security + DATA | No-refresh/queued unknown-expiry regressions, provider-confirmed expiry cases, durable restart/outage/key/capacity tests and sanitized outstanding-grant reconciliation |
| IAM-002 | Bound/revalidate/reconnect stream authority within approved revocation interval, or explicitly accept metadata-only residual risk. Checks/reconnects add load. | HTTP/identity | Logout/member-loss/admin-expiry/outage stream tests showing updates stop/narrow, plus deployed proxy lifetime policy |
| IAM-003 | Approve exact audience and collect access-lifecycle evidence; any narrowing is a separate operator policy decision. | IAM/compliance | Effective deployed revision/config, dataset/role entitlement approvals and sanitized access-review/offboarding/exception samples |
| IAM-004 | Approve accurate recent-authorization assurance wording or require stronger provider-side ceremony. | Identity architect + compliance | Approved assurance policy/age, provider SSO/session enforcement and bounded period evidence |
| IAM-005 | Collect authorized topology/header/isolation evidence; request stronger gates only if separately chosen. | Platform/network + IAM/OPS | Reviewed bind/ingress/final-hop TLS/overwrite policy, no public development modes, authorized untrusted-path rejection tests |
| IAM-006 | Collect real-adapter/key-drain/cleanup operation evidence and decide scoped volatile exceptions. | Secrets/platform + DATA/IAM | Key rotation/retirement runbook, restart/restore/failure tests, queue drain/alert records and approved exceptions |
| EXEC-01 | Investigate numeric actor continuity and provider lifecycle assumptions; changing queue contract requires legacy-record handling. | Execution maintainer + IAM | Account lifecycle/queue-age policy, reviewed immutable-ID contract, changed-ID/same-login and renamed-original fixtures, deployment disposition of old pending commands |
| EXEC-02 | Collect intended-executor evidence; do not infer enablement authorization. | Execution platform + release/OPS | Real Linux boundary/allowed-traffic results, OS/daemon/admin boundary, reviewed egress policy and relay/image/source digests |
| EXEC-03 | Confirm cooperative-control commitments and complementary budget controls. | Admission/accounting owner | Protected atomic publisher/client configuration, freshness/failed-publication alerts, pinned interoperability and outage policy |
| EXEC-04 | Collect DATA-owned real backend/recovery proof; preserve fail-closed ambiguity and receipts. | DATA/platform + execution | PostgreSQL/Redis fault/restart tests, grants/namespaces/capacity, old-process termination and restore/replay reconciliation |
| EXEC-05 | Review actual secret/App/host reach and key rotation/offboarding. | Identity/secrets + execution | Sanitized process/mount identity inventory, App scopes/access approvals, daemon controls, pause/drain/two-key restart evidence |
| EXEC-06 | Approve accurate authorization/race contract or request separately reviewed hardening. | Service/security + control operator | Offboarding/cancel runbook, residual-race decision, ambiguous-send/label/downstream reconciliation exercise |
| EXEC-07 | Collect native-platform tests or propose exclusion; strict VM ownership can block shared-workstation use. | Workstation/runtime + compliance | Intended-platform workspace/DACL/VM ownership/termination tests, or operator/auditor-approved scope exclusion |
| EXEC-08 | Confirm classifications and local/synthetic boundaries without deleting protected replay/evidence blindly. | Service/compliance + DATA/OPS | Approved inventory, retention/deletion/backup and independent evidence references; explicit exclusions if warranted |

#### IAM and EXEC verification and deduplication

IAM used existing focused Go tests plus three artifact-only Go overlay
observations reproducing IAM-001's two cleanup paths and IAM-002's
post-revocation stream delivery. The overlay tests passed both ordinary and
`-race` runs: they confirm adverse current behavior, **not fixes**. No
repository tests or runtime files were changed. Main IAM selectors passed
127 and 51 top-level tests respectively, with seven and eight top-level
skips; selectors overlap and MUST NOT be summed as unique coverage.
Four local SQLite and two signature/admin-route tests also passed.
Sixteen PostgreSQL-dependent test/subtest events were skipped. Full selectors,
overlay source, commands and JSON logs remain alongside the report.

EXEC's two bounded `go -C server test -json -count=1 -timeout=180s`
invocations passed 486 top-level tests across 13 package results, zero failed
events and 39 skipped test/subtest events. Package tests cover admission,
hosted CLI, gateway/host/local, App/scoped tokens, egress/quota and selected
server/CLI handlers. Selectors explicitly excluded real Linux Docker egress,
real Apple containers and fleet tests. Windows platform cases, real
PostgreSQL/Redis and pinned upstream compiled-runtime interoperability remain
unverified. Parent tests with skipped children do not verify those children.

IAM and EXEC ran on macOS without live provider, production, service setup or
dependency installation. Runtime/adapter/deployment effectiveness and
historical operation remain unassessed. EXEC-01 exclusively owns the mutable
login handoff: IAM confirms callback/consent numeric binding and active rename
denial (`server/internal/server/oauth.go:333-346,525-540,706-710,785-787`)
but neither binds queued work to the original ID. IAM-006/EXEC-04 depend on
DATA adapter evidence; IAM-005/EXEC-05 overlap OPS deployment evidence and
are linked requests rather than duplicate confirmed defects.

### OPS report received 2026-10-21

Source assessed: `e3daa5d7ad4fa537e6432359076b44f4a90be171`; runtime
`ef7d9fb65ea952826f9d81a94bd5890d3cfd5634`. The report's source matches
the investigation baseline; subsequent coordinator changes are assessment
documentation only. Detailed report:
`/Users/peli/.copilot/session-state/76a730cd-672d-4c67-9e03-cb2c3c0460fe/files/ops-soc2-readiness.md`.
The durable findings and limitations are recorded below; the session artifact
contains supporting control matrices, full commands and output references.

All eight findings have lifecycle **open** and decision **pending**.
Confidence is **high** in the stated source observation or evidence absence,
not in any claim that a production deployment is affected. Operating
effectiveness is **not-assessed**. Severity is a readiness prioritization,
not a vulnerability/exploitability rating. Criteria mappings are provisional.

| ID / status / severity | Profile, working mapping and observed property | Source evidence at assessed SHA | Counter-evidence / limits |
| --- | --- | --- | --- |
| OPS-01 / design-gap / medium | Administrative rebuild: successful changes lack durable actor-attributable lifecycle history; the replaceable rebuild status has no actor/request ID, and terminal persistence errors are discarded. CC6.3, CC7.2, CC7.3 | `server/internal/server/operations.go:56-136,352-357`; `server/internal/server/server.go:1103-1112` | Admin/step-up/CSRF gating, projection lease, atomic publication and denied-admin audit remain. This is an evidence-coverage objective, not an authorization bypass or a claim every local operation must use the hosted-CLI audit table. |
| OPS-02 / design-gap / medium | Azure template-only monitoring: Application Insights settings do not activate Go OTLP exports without the separate endpoint/collector and log opt-in. CC7.2, CC7.3 | `server/azure/main.bicep:466-469`; `server/azure/collector.bicep:282-300`; `server/internal/telemetry/telemetry.go:82-108`; `server/README.md:3173-3177` | Platform/container logs, stderr audit mirrors and independent delivery may provide alternative monitoring. A tenant overlay may already supply OTLP; none was provided. Optional instrumentation is not evidence that all monitoring is absent. |
| OPS-03 / design-gap / medium | Production use of Azure development source-build without an external gate: ACR build/apply lacks the official candidate image scan/SBOM/attestation step for those rebuilt targets. CC7.1, CC8.1 | `internal/cli/deploy_azure_images.go:251-309`; `internal/cli/deploy_azure_apply.go:130-149,186-208`; `.github/workflows/cao-package.yml:427-527` | Explicitly a development path; digest-pinned bases, reviewed context, digest receipts, locked tags and plan checks exist. An independent pipeline could supply the missing gate. Published-image guarantees do not cover later rebuilds. |
| OPS-04 / design-gap / medium | Redis doctor: empty RDB status with AOF disabled is labelled healthy writes instead of insufficient evidence. CC7.1, CC7.2; A1 candidate | `server/internal/doctor/checks_redis.go:375-430`; `server/internal/doctor/checks_redis_test.go:310-314` | Known write errors warn and other diagnostics expose persistence details. The existing passing test confirms this diagnostic behavior, not disabled backups, lost writes or a provider SLA failure. |
| OPS-05 / evidence-needed / high if independently durable audit is relied upon | Independent destination, anchor enrollment, complete committed-row export, retention and independent heartbeat/alert operation are unestablished. CC6.3, CC7.2, CC7.3, CC9.2; C1 candidate | `server/audit-delivery/README.md:3-12,49-57,95-109,133-171,201-221`; `server/SECURITY.md:879-901` | Chain/anchor verification, read-back, immutable objects, CAS and replay fault tests support design. Real destination conformance was skipped. Storage-owned events need committed-row export rather than mirror-only collection. |
| OPS-06 / evidence-needed / high if availability/durable-work commitments apply | RTO/RPO and complete consistent restoration of protected operational state, lake evidence and audit history are unestablished. CC7.5, CC9.1; A1.2/A1.3 candidate | `server/azure/network.bicep:105-112`; `server/azure/collector.bicep:143-208`; `server/README.md:2299-2306,3306-3309` | Seven-day baseline PostgreSQL backups, rebuild/replay and drain exist; baseline HA/geo backup is disabled. These are tradeoffs, not universal SOC 2 failures. Rebuilding canonical projections does not recover all accepted work or audit/revocation state. |
| OPS-07 / evidence-needed / medium | Effective cloud privileges, secret/key rotation, network restrictions and log/evidence classification are unknown. CC6.1, CC6.3, CC6.7, CC9.2; C1/P applicability pending | `server/azure/main.bicep:299-315,433-447,527-577`; `server/azure/worker-roles.bicep:15-36`; `server/azure/function-roles.bicep:48-76`; `server/azure/collector.bicep:143-221` | Secret-scoped RBAC, managed identities, TLS and separated roles are modeled; public authenticated ingress is not itself a defect. Templates cannot establish actual grants, key retirement, lake account-key access or deployed boundaries. |
| OPS-08 / evidence-needed / medium | Production release approvals, actual digest/provenance verification, scan exception disposition, evidence retention and rollback need period evidence. CC7.1, CC7.4, CC8.1, CC9.2 | `.github/workflows/cao-package-publish.yml:199-303`; `.github/workflows/release-promote.yml:110-155`; `.github/workflows/cao-package.yml:314-323,487-498,566-579`; `.grype.yaml:1-7` | Official image scanning/sealed publication/attestation is design-supported. Trivy ignores unfixed findings and the committed zlib exception for CVE-2026-85091 has no recorded approver/expiry; current CVE/fix status was not verified. An external approval/archive may exist. Passing scans do not close exceptions. |

#### OPS operator choices and closure evidence

Suggested owners below are not assigned or authorized by the assessment.
No risk acceptance, exclusion, remediation or production action has been
approved.

| Finding | Proposed choice / tradeoff | Suggested owner | Evidence required for closure |
| --- | --- | --- | --- |
| OPS-01 | Define audited admin coverage; authorize lifecycle audit or demonstrate equivalent protected history. A restricted local exception requires explicit acceptance. | Server owner + SecOps | Actor/correlation/start/outcome fixtures, outage behavior, retained independent evidence and approved scope; account for cross-store transaction coupling without logging payloads |
| OPS-02 | Complete a reviewed collector overlay or approve an adequate alternative monitoring boundary; avoid making request availability depend on the telemetry backend without design review. | Platform observability | Sanitized effective OTLP/log settings, TLS/collector topology, end-to-end receipts, forced-failure alert acknowledgement |
| OPS-03 | Restrict the source-build route to development or gate each exact target digest before production promotion; equivalent independent assurance is acceptable if reviewed. | Release/platform security | Per-target scan policy/results/dispositions, SBOM and source/context provenance, promotion approval and deployed digest read-back; include dirty-context digest |
| OPS-04 | Authorize explicit unknown/warn semantics and separately verify provider durability; do not demand unsupported managed-service CONFIG permissions. | Server diagnostics + data platform | Missing-field regression no longer falsely passes, plus approved provider persistence and restore evidence |
| OPS-05 | Collect independent audit operating evidence and authorize any missing provisioning separately. | SecOps/evidence platform | Real adapter conformance, independent anchor provenance, WORM/role/retention/checkpoint policy, complete sequence reconciliation, dead-scheduler/backlog alert receipts and outage/retention-gap exercise |
| OPS-06 | Approve recovery commitments and an isolated restore exercise, or explicitly accept a time-bounded service limitation. | Service owner + SRE/data platform | Complete protected-state backup inventory, timed restore/data-loss measurements, queue/revocation/audit-anchor/lake reconciliation, key availability and failback report |
| OPS-07 | Collect sanitized effective settings and assess key, network, vendor and privacy boundaries. | Cloud security with IAM/DATA/privacy | Privilege/access review references, identity separation, key rotation/retirement exercise, network exceptions, lake/export authority and log/evidence classification/retention review |
| OPS-08 | Retain examination-period exact-source/digest change samples and review exceptions; target-specific rebuilt images require separate evidence. | Release/change manager | Required-check/review/environment/bypass rules, actual approvals, scanner policy/database/results, exception approver/expiry/reassessment, verified provenance/deployed digest, evidence archive and rollback drill |

#### OPS verification and remaining coverage

The investigator reported these bounded results, with exact selectors and logs
in the detailed report:

- `go -C server test ./internal/audit ./internal/auditdelivery ./internal/telemetry ./internal/logger ./internal/doctor -count=1 -json`:
  passed, 151 top-level passes; real audit destination and OpenObserve tests
  skipped, plus an intentional parent subprocess-helper skip.
- Focused server/Functions/dashboard audit and lifecycle command: passed,
  21 top-level passes and five PostgreSQL-dependent skips. Focused
  diagnostics/hosting command: passed, eight passes and two PostgreSQL skips.
- Mocked Azure CLI deployment selectors: eight passes. These did not
  authenticate to Azure, build images or verify actual deployment.
- `npm --prefix server/spec test`: passed, 29 tests, after missing locked
  dependencies were restored; `node --test tests/unit/cao-package-contract.test.mjs`:
  five passes after a missing root dependency restore;
  `node --test tests/unit/cao-azure-assets.test.mjs`: seven passes.
- API TypeSpec compile with `noEmit`: passed, zero diagnostics. No
  generated-artifact reproducibility gate or artifact regeneration was run.

Local execution used Go 1.27.3/darwin-arm64 and Node 26.9.0; Node differed
from CI's Node 24. No scanner/build/publication, real database/Redis provider,
production access, restore/failover, real alert routing or period-operation
test was run. Doctor coverage was bounded; generic logging APIs were not
proved to redact arbitrary caller fields. DATA, IAM and EXEC implementation
internals were outside OPS ownership; their reports are consolidated above.
CC1-CC5 and category applicability remain operator evidence requests.

### Overall decision gate

For every scoped control claim, use `design-supported`, `design-gap`,
`evidence-needed`, or `not-applicable-proposed`; record tests and operating
effectiveness separately. Report confirmed gaps separately from hypotheses.
Preserve citations, limitations, and compensating controls.

The final operator table must identify the finding, working TSC mapping,
severity/confidence, affected profile, proposed action, suggested owner,
closure evidence, and pending decision. The operator chooses whether to
investigate, remediate, collect evidence, approve an exclusion, or accept a
time-bounded risk. This assessment does not make those choices automatically.

All four bounded technical reports are now consolidated, including recorded
coverage exclusions, skipped checks and the failed DATA-08 validation.
Organizational/deployment/period evidence remains pending. Scoped repository
remediation and a daily worker are authorized and underway as listed above;
OPS-04 and DATA-08 technical corrections are integrated and locally checked
on this assessment branch, but default-branch/deployment closure is pending.
The conclusion is
**initial technical assessment delivered; SOC 2 readiness undetermined**.
