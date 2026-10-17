---
title: Central Agentic Ops Hosted CLI Actions Specification
description: Normative requirements for executing dashboard CLI actions in the hosted CAO server with a GitHub App and single-use installation tokens.
version: 1.0.0
status: Working Draft
editors:
  - GitHub Next
---

# Central Agentic Ops Hosted CLI Actions Specification

**Version:** 1.0.0
**Status:** Working Draft
**Latest Version:** https://github.com/githubnext/gh-aw-cao/blob/main/specs/server-hosted-cli.md
**Editors:** GitHub Next

## Abstract

This specification defines the optional hosted CLI actions mode of the CAO
dashboard server. Authorized administrators submit dashboard-declared CLI
actions. The server queues the actions, and a backend executor runs each one
with a short-lived, repository-scoped GitHub App installation token that is
revoked as soon as the command finishes. The specification covers enablement,
administrator step-up authentication, admission, the token broker, execution
isolation, and the required formal model.

## Status of This Document

This document is a Working Draft. It is the canonical normative contract for
hosted CLI actions and administrator step-up authentication. `server/README.md`
and `server/SECURITY.md` are explanatory and MUST NOT override this
specification.

## 1. Status and conformance

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT,
RECOMMENDED, MAY, and OPTIONAL are to be interpreted as described in RFC 2119.

A conforming implementation satisfies every MUST in this document. The
loopback-only local development profile is out of scope. Its CLI queue runs
on the operator's workstation with the operator's own credentials.

## 2. Enablement

1. Hosted CLI actions MUST be disabled by default and MUST be treated as an
   experimental server feature.
2. `serve-hosted` MUST admit CLI actions only when started with both
   `--experimental` and `--hosted-cli-actions`. Without either flag, the server
   MUST NOT register the `/__cli_commands` routes. The local SQLite debugging
   mode is subject to the same experimental gate.
3. Enablement MUST fail at startup unless GitHub OAuth and the PostgreSQL
   operational store are configured. The mode MUST NOT fall back to the
   memory or Redis operational backends.
4. The accepted actions MUST come from the dashboard document named by
   `--cli-actions-catalog`. A request MUST NOT name an arbitrary command.
5. A separate `execute-cli` process MUST drain the queue. The web server
   process MUST NOT hold the App private key.
6. For local debugging only, `serve-hosted --experimental
   --hosted-cli-actions --hosted-cli-sqlite PATH` and `execute-cli --sqlite
   PATH` MAY replace the PostgreSQL queue and audit
   table with one SQLite file shared by both processes on one host.
   `--hosted-cli-sqlite` MUST be rejected unless both `--experimental` and
   `--hosted-cli-actions` are present and MUST fail at startup unless `--listen`
   is a loopback address. The file
   MUST be created with mode `0600`, and the path MUST NOT carry URI
   parameters. The SQLite store MUST implement the same queue and audit
   contracts (§7 items 1–2), with these differences: one global namespace,
   timestamps from the host clock, and triggers that anyone with write access
   to the file can drop. It MUST NOT be used in production.

## 3. Administrator step-up

Every administrator operation MUST require a fresh, assured interactive
GitHub OAuth authentication. This covers `/mcp`, collection controls, quota
controls, operations, and all `/__cli_commands` routes.

1. **Freshness.** The session MUST record `AuthenticatedAt` only when a full
   interactive authorization-code flow completes. Token refresh and session
   revalidation MUST NOT update it. A session is fresh while
   `now - AuthenticatedAt <= CAO_ADMIN_REAUTH_MAX_AGE`. The default maximum
   age is 15 minutes, and the configured value MUST be between 1 minute and
   1 hour. Startup MUST fail on a malformed or out-of-range value.
   Timestamps in the future MUST be rejected.
2. **Assurance.** At the interactive callback, the session MUST record an
   assurance only from verified evidence:
   - `2fa` only when GitHub's `/user` response explicitly reports
     `two_factor_authentication: true`. A missing or false field MUST NOT
     count as two-factor evidence.
   - `sso:<org>` only when the organization is listed in
     `CAO_GITHUB_SSO_ORGANIZATIONS` and an organization membership read
     succeeds with the fresh token. The operator attests that the listed
     organizations enforce SAML SSO for OAuth access.
3. **Denial.** When a listed administrator lacks a fresh, assured session,
   the server MUST respond `401` with
   `WWW-Authenticate: CAO-Step-Up realm="admin", max_age=<seconds>` and a JSON
   body containing `code: "admin_step_up_required"` and
   `reauthenticate: "/auth/login"`. Every other principal MUST receive `403`.
   The server MUST NOT reveal step-up state to non-administrators.
4. `GET /api/auth/session` SHOULD expose `adminAssuranceExpiresAt` so the
   dashboard can prompt for re-authentication before denial.

GitHub OAuth cannot force password or two-factor re-entry. Freshness therefore
means a recently completed authorization flow, and assurance depends on what
GitHub discloses or on the operator's SSO attestation.

## 4. Admission

`POST /__cli_commands` MUST perform these checks in order and reject the
request on the first failure:

1. Administrator step-up as defined in section 3.
2. Resolve the request against the declared catalog action, then plan the
   command. Planning MUST bind the command to exactly one target repository
   and reject commands outside the supported command set.
3. Use the requester's own OAuth token to confirm `admin`, `maintain`, or
   `push` permission on the target repository.
4. Enqueue the command with its `Actor` and `Repository`, using an optional
   idempotency key.

List, detail, output, cancel, and retry routes MUST require the same
step-up. Retry MUST create a new admission subject to the same checks.
Cancel MUST confirm, with the requester's own OAuth token, write access to
the command's target repository before changing the command.

The backend MUST validate the requester's write permission on the target
repository before it issues any work: before a command is queued, retried,
or canceled, before a work-scoped token is pre-minted or acquired, and before
a subprocess starts.

## 5. Token broker

1. The executor MUST authenticate as the hosted CLI GitHub App, configured
   with `CAO_HOSTED_CLI_APP_ID` and `CAO_HOSTED_CLI_PRIVATE_KEY` or its
   `_FILE` or `_BASE64` variant. The App SHOULD be created with
   `cao setup-auth hosted-cli`, which requests only actions, contents,
   pull requests, and workflows write, plus metadata read.
   Operators MUST store the App private key in the executor deployment's
   managed secret store and expose it only to `execute-cli`, preferably through
   a secret-manager-mounted file. The setup command's mode-`0600` local output
   is temporary bootstrap material, not durable secret storage; operators
   MUST import it into the vault and remove the local copy. The key MUST NOT
   be configured on the `serve-hosted` process.
2. Each command MUST use an installation token minted for exactly its target
   repository, with the narrowest permissions its plan requires.
3. The broker MUST verify the grant GitHub returns. If the response omits the
   granted permissions or repositories, grants a permission that was not
   requested or at a higher level, or covers different repositories, the
   broker MUST revoke the token immediately and fail the mint.
4. A token MUST be used by at most one command. After the command reaches a
   terminal state, the token MUST be revoked and MUST NOT return to the pool.
5. If revocation fails, the broker MUST retry until the token is revoked or
   expires.
6. The broker MAY pre-mint unused tokens for queued backlog. The pool MUST be
   bounded in total (`--max-pooled-tokens`, default 8, 0 disables pooling),
   per scope (default 2), and by idle lifetime (default 2 minutes). Idle
   tokens MUST be revoked when they expire from the pool and at shutdown.
7. The broker MUST discard a pooled token that would expire before the
   command deadline plus one minute.
8. Concurrent token minting MUST be bounded (default 4).
9. Operators MUST rotate the App private key using a two-key rollover: create
   and deploy the new key while the old key remains active, restart every
   executor, verify token minting with the new key, and only then revoke the old
   key. The executor loads the configured key at startup; changing its
   environment or key file MUST NOT be assumed to update a running process.
   Because shutdown cancels in-flight commands, operators MUST pause admissions
   and wait for queued and running commands to finish before restarting the
   executor for rotation.

## 6. Execution

1. In production, all web and executor replicas MUST use the same durable
   PostgreSQL operational namespace. Admission and queue state MUST survive process
   restart. Web replicas MAY admit requests concurrently; executor replicas
   MUST coordinate through one durable queue lease, and only its current holder
   may claim work. SQLite is limited to the single-host debugging profile.
2. The queue MUST serialize lease acquisition, renewal, release, and command
   claims transactionally. Each claim MUST atomically persist its running state
   and execution claim before the command starts. The execution claim MUST
   prevent another replica from running the same command, and active claims
   MUST count against the configured concurrency limit.
3. The executor MUST hold the single queue lease. Additional replicas stand by.
   Lease ownership MUST be fenced so a stale executor cannot write output,
   finish, or settle work after another replica acquires a newer lease.
4. Before running, the executor MUST re-plan the command, require a matching
   `Actor` and `Repository`, and recheck that the actor still has `admin` or
   `write` collaborator permission on the target repository. The recheck MUST
   use a separate installation token scoped to the target repository with
   only `metadata: read`, which is revoked as soon as the check returns. No
   work-scoped token may be minted, taken from the pool, or pre-minted for a
   command until its requester passes this check. If the recheck fails, the
   command MUST fail without running and without a work token.
5. The executor does not recheck administrator step-up at run time. Admission
   is the authorization point. The live permission recheck and the command
   deadline (default 15 minutes) bound execution. The deadline MUST be stored
   durably with the claim and MUST apply across executor restarts.
6. Each command MUST run in a new workspace with mode `0700`, which is removed
   afterwards. It MUST execute in the official `ghcr.io/github/gh-aw` image
   pinned by OCI SHA-256 digest (default
   `ghcr.io/github/gh-aw@sha256:7ff77dc03182d4edcebc902fa94b0239eb9cde65ea212509aef700bcab354090`),
   or in an operator-approved digest-pinned mirror. An unpinned image reference
   MUST fail startup. The executor MUST use the local Docker `default` context;
   remote contexts MUST NOT be used because the command's workspace is a
   host-local bind mount.
7. The Go planner MUST accept only fixed `gh` and `gh-aw` container entrypoints.
   It MUST NOT execute `cao.sh`, arbitrary shell commands, or control-repository
   scripts. A CAO campaign update MUST be translated to a native `gh-aw update`
   command scoped to the configured control repository and the catalog-selected
   CAO package. The container image reference MUST be recorded in the audit
   event for command start.
8. The container MUST use a read-only root filesystem, drop all Linux
   capabilities, enable `no-new-privileges`, and apply process and memory
   limits. The per-command workspace MUST be its only writable host bind mount;
   `/tmp` MAY be a bounded tmpfs. The executor MUST NOT mount the host home,
   Docker socket, App key, database credentials, or other server files.
9. The subprocess environment MUST be minimal: the single-use `GH_TOKEN`, an
   empty system git configuration, the `gh` credential helper, and the App bot
   identity. The executor MUST pass it through a temporary mode-`0600`
   environment file outside the mounted workspace, remove that file after
   container creation, and MUST NOT place token values in command arguments.
10. The executor MUST forcibly remove the container on cancellation, deadline,
   or loss of the lease. Command output MUST redact the token. Logs MUST NOT
   contain tokens, private keys, or OAuth credentials.
11. A terminal result MUST NOT release its concurrency claim until container
   exit has been confirmed and settlement is durably stored. If a lease expires
   while a command is still claimed or running, the replacement executor MUST
   mark the outcome interrupted, block further claims, and require explicit
   operator recovery acknowledgement after confirming the old container has
   stopped. It MUST NOT automatically retry the interrupted command: external
   side effects may have completed before the crash, so the system guarantees
   at-most-once dispatch, not exactly-once external effects. A retry MUST use a
   new command ID and explicit admission.

## 7. Audit trail

1. The authoritative audit trail is the PostgreSQL operational table
   `cao_operational_audit_events`. Each row has a per-namespace, gap-free
   `sequence`, a database-clock `occurred_at`, `event`, `outcome`
   (`success`, `denied`, or `failure`), `actor`, and the exact canonical JSON
   `record` that was hashed. `hash = SHA-256(prev_hash || record)` chains each
   row to its predecessor; the first row uses 32 zero bytes. Appends MUST
   serialize on the namespace row so the chain has no forks.
2. The table MUST be append-only. A trigger MUST reject `UPDATE`, and MUST
   reject `DELETE` except for retention maintenance and namespace removal.
   Retention MUST keep at least 400 days, MUST remove only a contiguous oldest
   prefix in bounded batches, and MUST always keep the newest row so sequences
   never restart. `VerifyAudit` MUST recompute the chain over retained rows and
   report a gap, broken link, hash mismatch, or column that differs from the
   hashed record as `ErrAuditTampered`. The chain detects tampering by anyone
   who cannot also rewrite every later hash; operators who need protection
   against a database superuser MUST also forward the mirror (item 3) to
   write-once storage.
3. Every event MUST also be mirrored as one JSON line with `"audit":"cao"`,
   `event`, `outcome`, `stored`, and, when stored, `sequence`. The mirror goes
   to standard error, or to the file named by `CAO_AUDIT_LOG`, opened for
   append with mode `0600`, for SIEM forwarding.
4. Enabling hosted CLI actions, in either process, MUST fail unless the
   operational store provides the audit table. Privileged steps MUST fail
   closed when their event cannot be stored: a minted token is revoked and not
   used; a command is failed before it runs when `cli_command.started` cannot
   be stored. Admission, retry, and cancellation MUST commit the queue mutation
   and its hash-chained event in the same transaction, in both PostgreSQL and
   SQLite. Hosted enablement MUST require `AuditedCLICommandQueue`; a separate
   enqueue followed by append and compensating cancellation is prohibited.
   Append failure MUST roll back the mutation, idempotency reservation, queue
   revision, and capacity accounting. A failed or uncertain commit returns
   `503` without compensation: either both records committed or neither did.
   The response MUST tell the requester to inspect the queue and reuse the
   original idempotency key, not infer that execution was prevented. Repeating
   a nonempty key with the same invocation and retry ancestry MUST return the
   same retained command, and MUST atomically audit the repeated request; a different
   invocation or retry ancestor MUST conflict. Audit failure on a replay MUST
   NOT cancel a previously committed command. Denials and completion events
   are best-effort, and a storage failure still appears in the mirror with
   `stored:false` (unconfirmed, not proof that no durable event exists).
5. The web process MUST record `admin.denied` with the reason
   (`step_up_required` or `not_admin`), the method, and the path for every
   refused administrator request. It MUST record `cli_command.admitted`,
   `cli_command.rejected`, `cli_command.cancel_requested`, and
   `cli_command.retried`. Each admitted event carries the actor, action,
   repository, assurance factors, and step-up time.
6. The executor MUST record `token.minted`, `token.revoked`, and
   `token.revoke_failed`. It MUST also record `cli_command.started`,
   `cli_command.permission_denied`, and `cli_command.finished`, with the
   actor, repository, installation, granted permissions, container image,
   status, and exit code.
7. Events MUST NOT contain tokens, keys, or OAuth credentials. Token events
   MUST identify the token by `hashed_token`, the Base64 SHA-256 digest that
   GitHub uses in its audit log. Operators can then join CAO events to
   GitHub's audit-log entries for the App's actions.
8. `cao-dashboard audit verify` MUST recompute the chain and print the
   verification as JSON, including `lastSequence` and the head `lastHash`. It
   MUST record `audit.verified` or `audit.verify_failed` with that head, so the
   head also reaches the mirror and OTLP. Each `--anchor SEQUENCE:HASH` MUST
   match the retained row at that sequence. An anchor beyond the chain head
   MUST fail as tampering (rollback), and an anchor older than the retained
   prefix is reported in `anchorsExpired`. Because a database superuser can
   rewrite the whole chain consistently, operators SHOULD run `audit verify`
   on a schedule and keep recent heads in write-once storage outside the
   database, passing them back as anchors.
9. `cao-dashboard audit export` MUST write retained rows as JSON Lines in
   sequence order, optionally filtered by `--after`, `--event`, and `--actor`,
   for evidence requests and SIEM backfill.
10. When OpenTelemetry is configured, every audit event MUST also be emitted as
    an OTLP log record named `cao.audit.<event>`, with severity `ERROR` for
    `failure`, `WARN` for `denied`, and `INFO` otherwise. Audit events recorded
    inside a span MUST carry `trace_id` and `span_id` in the stored record.
11. Durable audit writes MUST have a finite five-second budget, including
    connection acquisition, namespace locking, append, and commit. Cleanup
    auditing MAY detach from caller cancellation, but MUST acquire a fresh
    deadline; it MUST NOT use an unbounded `WithoutCancel` context for storage.
    Atomic administrator mutations MUST also honor earlier caller deadlines
    and cancellation. PostgreSQL MUST bound transaction-local lock, statement,
    and idle-in-transaction waits before acquiring the namespace lock. SQLite
    MUST bound its busy wait to one second. Deadline and storage failures MUST
    remain observable and MUST NOT be interpreted as confirmed rollback.

## 7a. Telemetry

Hosted CLI telemetry uses the server's OpenTelemetry setup and MUST NOT
contain tokens, keys, OAuth credentials, command output, or actor logins.
Actors are joined from the audit trail by command ID.

| Signal | Name | Attributes |
|--------|------|------------|
| Span (consumer) | `cao_hostedcli.command.execute` | command ID, repository, status, exit code |
| Span | `cao_hostedcli.token.mint` | installation ID, repository, `hashed_token` |
| Span | `cao_hostedcli.token.revoke` | `hashed_token` |
| Counter | `cao_hostedcli.command.count` | status |
| Histogram (s) | `cao_hostedcli.command.duration` | status |
| Counter | `cao_hostedcli.token.operation.count` | operation (`mint`, `reuse`, `revoke`, `discard`), outcome |
| Gauge | `cao_hostedcli.token.pooled` | none |
| Gauge | `cao_hostedcli.token.pending_revocations` | none |
| UpDownCounter | `cao_hostedcli.lease.held` | none |
| Counter | `cao_audit.event.count` | event, outcome, stored |
| Histogram (s) | `cao_audit.append.duration` | stored |

Span status descriptions MUST be generic. The executor MUST pass only a W3C
`TRACEPARENT` for the command span to the subprocess and MUST NOT forward
baggage, trace state, or exporter configuration.

Operators SHOULD alert when `pending_revocations` stays above zero, when
`cao_audit.event.count{stored="false"}` increases, on any
`audit.verify_failed` event, on spikes in `admin.denied`, and when
`lease.held` is zero while commands are queued.

## 8. Formal model

`specs/tla/HostedCLIActions.tla` models enablement, step-up admission, live
recheck, and the token broker. Its enabled and disabled configurations MUST
pass TLC with no violation of `Safety` or `TerminalTokenInvalidated` before
this specification or the corresponding implementation changes.
`specs/tla/README.md` maps each property to its implementation boundary.

## 9. Conformance tests

- `server/internal/server/admin_step_up_test.go`: freshness, assurance,
  refresh non-extension, and the `401` and `403` responses.
- `server/internal/server/hosted_cli_test.go`: flag gating, admission order,
  and requester permission.
- `server/internal/server/hosted_cli_atomic_test.go`: real SQLite admission,
  retry and cancellation rollback, lost commit acknowledgements, same-key
  recovery, and rejection of non-atomic queues.
- `server/internal/operational/cli_command_audit*_test.go`: both
  store implementations, using independent executor handles and database
  triggers that pause/fail the actual audit insert; concurrent claims cannot
  pass uncommitted admission, rollback preserves queue and hash-chain state,
  repeated requests do not duplicate commands, cancellation retains execution
  claims, process/connection loss cannot leave partial admission, and
  namespace/statement contention cannot block persistence forever.
- `server/internal/hostedcli`: broker single use, revocation and retry, pool
  bounds, executor recheck, isolation, redaction, and audit events without
  secrets.
- `server/internal/hostedcli/executor_test.go`
  (`TestExecutorVerifiesRequesterBeforeIssuingWorkTokens`,
  `TestExecutorVerifiesWithMetadataTokenBeforeWorkToken`) and
  `server/internal/server/hosted_cli_test.go`: requesters without write access
  never receive a work-scoped or pre-minted token, and cannot cancel.
- `server/internal/githubapp/scoped_token_test.go`: over-broad grants are
  revoked and rejected, and `hashed_token` matches GitHub's format.
- `server/internal/audit`: event shape, store mapping, failure mirroring, and
  append-only `0600` file output.
- `server/internal/operational/postgres/audit_test.go`: gap-free chain, rejected
  `UPDATE`/`DELETE`, tamper detection, retention suffix, and namespace cascade.
- `server/internal/server/hosted_cli_test.go` and
  `server/internal/hostedcli/executor_test.go`: hosted CLI requires the table,
  and unaudited admission, cancel, token mint, and command start fail closed.
- `server/internal/operational/sqlite/store_test.go`: the SQLite debug store
  shares one file between two handles for queue leases, idempotent admission,
  recovery, the audit chain, rejected `UPDATE`/`DELETE`, tamper detection, and
  retention; `hosted_cli_test.go` rejects it on a non-loopback listener.
- `server/internal/operational/sqlite/store_test.go`
  (`TestAuditAnchorsDetectRewriteAndRollback`) and
  `server/cmd/cao-dashboard/audit_test.go`: anchors detect a consistent
  rewrite and a rollback, malformed anchors are rejected, verification is
  itself audited, and export filters and pages rows.
- `server/internal/hostedcli/telemetry_test.go`: command and token spans and
  metrics exist, the subprocess receives a valid `TRACEPARENT`, and no span
  carries a token or actor.
- `tests/unit/setup-hosted-cli-app.test.mjs`: least-privilege App manifest and
  helper safety.

## 10. Security considerations

The App private key grants every permission the App has on every installed
repository. Operators MUST store it as a secret available only to the
`execute-cli` process. Operators SHOULD limit the installation to the control
repository and the explicitly enrolled targets. A compromised administrator
session is limited to the step-up window and to catalog-declared actions on
repositories the administrator can already write.

The command container runs as the executor's OS user, but receives only its
workspace and scoped token. The executor process and local Docker daemon remain
trusted: the executor can read the App private key and database credentials,
and a Docker administrator can inspect container configuration and its scoped
token. Operators SHOULD run `execute-cli` under a dedicated, unprivileged user
and restrict Docker daemon access to trusted operators. The gh-aw image MUST be
digest-pinned; the container is defense in depth, not a boundary against a
compromised host kernel or Docker daemon.

Operational hardening that this specification does not yet require, in
priority order:

1. Add a gVisor or microVM boundary and restricted network egress around the
   command container.
2. Keep the App private key in a KMS or HSM that signs the App JWT, and
   rotate it on a schedule; GitHub allows two active keys during rotation.
3. Use separate database roles: the web and executor roles get `INSERT` and
   `SELECT` on the audit table only, and only a maintenance role can run
   retention.
4. Forward the audit mirror or OTLP audit logs to write-once storage or a SIEM,
   and schedule `audit verify` with external anchors.
5. Propagate the admission trace context into the queued command so
   admission and execution share one trace.
6. Expose executor liveness and readiness that reflect store, App, and
   revocation health.

### SOC 2 evidence boundary

The hosted CLI provides technical control mechanisms and evidence sources; it
does not establish SOC 2 compliance or provide an attestation. The organization
and its auditor determine the audited system boundary, applicable criteria,
control owners, and review period. In particular, PostgreSQL hash chaining
alone cannot detect a consistent rewrite by a database superuser. Operators
using these records for audit evidence SHOULD forward them to write-once storage
outside the database and retain external verification anchors, verification
results, access/configuration records, and change-approval evidence for the
applicable review period. Application audit and telemetry cannot prove that
organizational access reviews, approvals, or incident responses were performed.

## 11. References

- `server/SECURITY.md`
- `specs/server-operational-storage.md`
- `specs/tla/README.md`
- [GitHub App improvements for least privilege and management](https://github.blog/changelog/2026-10-13-github-app-improvements-for-least-privilege-and-management/)

## 12. Change log

### Version 1.0.0 (Working Draft)

- Initial hosted CLI actions, administrator step-up, and token broker
  contract.
- Added granted-scope verification and the audit trail.
- Added the loopback-only SQLite store for local debugging.
- Validate requester write permission before issuing any work, including
  prefetch and cancel, with a metadata-only verification token.
- Added audit verification with external anchors, audit export, OTLP audit
  logs, trace correlation, and hosted CLI telemetry.
