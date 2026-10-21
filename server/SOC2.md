# Go server SOC 2 readiness assessment

## Assessment boundary and current status

Started 2026-10-21 against source revision
`ef7d9fb65ea952826f9d81a94bd5890d3cfd5634`.
This is an evidence-driven readiness investigation, not a SOC 2 attestation or
a declaration of compliance. No deployed environment, examination period,
service commitments, or organizational control evidence has been supplied.
No runtime or deployment changes are authorized by this assessment.

The reusable procedure is
[soc2-server-assessment](../.github/skills/soc2-server-assessment/SKILL.md).
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
| IAM: identity and HTTP access | CC6, CC7; authorization, sessions, transport and resource admission | Launched; report pending |
| DATA: persistence and data handling | CC6, CC7; candidate C1, PI1 and A1; storage, integrity, retention and recovery | Launched; report pending |
| EXEC: admission, gateway and execution | CC6, CC7, CC8; candidate PI1; bounded authority and privileged side effects | Launched; report pending |
| OPS: audit, operations and releases | CC7, CC8, CC9; candidate A1; evidence integrity and operational dependencies | Launched; report pending |

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

For every scoped control claim, use `design-supported`, `design-gap`,
`evidence-needed`, or `not-applicable-proposed`; record tests and operating
effectiveness separately. Report confirmed gaps separately from hypotheses.
Preserve citations, limitations, and compensating controls.

The final operator table must identify the finding, working TSC mapping,
severity/confidence, affected profile, proposed action, suggested owner,
closure evidence, and pending decision. The operator chooses whether to
investigate, remediate, collect evidence, approve an exclusion, or accept a
time-bounded risk. This assessment does not make those choices automatically.

Until the component reports and organizational/deployment evidence are
reviewed, the conclusion is **readiness undetermined; assessment in progress**.
