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

1. Hosted CLI actions MUST be disabled by default.
2. `serve-hosted` MUST admit CLI actions only when started with
   `--hosted-cli-actions`. Without the flag, the server MUST NOT register the
   `/__cli_commands` routes.
3. Enablement MUST fail at startup unless GitHub OAuth and the PostgreSQL
   operational store are configured. The mode MUST NOT fall back to the
   memory or Redis operational backends.
4. The accepted actions MUST come from the dashboard document named by
   `--cli-actions-catalog`. A request MUST NOT name an arbitrary command.
5. A separate `execute-cli` process MUST drain the queue. The web server
   process MUST NOT hold the App private key.

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

## 5. Token broker

1. The executor MUST authenticate as the hosted CLI GitHub App, configured
   with `CAO_HOSTED_CLI_APP_ID` and `CAO_HOSTED_CLI_PRIVATE_KEY` or its
   `_FILE` or `_BASE64` variant. The App SHOULD be created with
   `cao setup-auth hosted-cli`, which requests only actions, contents,
   pull requests, and workflows write, plus metadata read.
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

## 6. Execution

1. The executor MUST hold the single queue lease. Additional replicas stand by.
2. Before running, the executor MUST re-plan the command, require a matching
   `Actor` and `Repository`, and recheck that the actor still has `admin` or
   `write` collaborator permission on the target repository. If the recheck
   fails, the command MUST fail without running.
3. The executor does not recheck administrator step-up at run time. Admission
   is the authorization point. The live permission recheck and the command
   deadline (default 15 minutes) bound execution.
4. Each command MUST run in a new workspace with mode `0700`, which is removed
   afterwards. The subprocess environment MUST be minimal: `GH_TOKEN`, an
   empty system git configuration, the `gh` credential helper, and the App bot
   identity. It MUST NOT inherit server secrets.
5. Control-checkout commands (`./cao.sh`) MUST run only at the
   operator-reviewed commit SHA configured by
   `CAO_HOSTED_CLI_CONTROL_REVISION`. The executor MUST clone without
   checking out and MUST then check out that detached revision. The live
   default branch MUST NOT be executed. Without a configured revision, these
   commands MUST fail before a token is acquired. A value that is not a full
   commit SHA MUST fail startup.
6. Each command MUST receive a private copy of the operator's gh extensions
   inside its workspace (`XDG_DATA_HOME`). Symbolic links are resolved and
   copied as content. A command MUST NOT be able to modify the extensions
   that later commands run.
7. The subprocess MUST run in its own process group and MUST be killed on
   cancellation, deadline, or loss of the lease.
8. Command output MUST redact the token. Logs MUST NOT contain tokens,
   private keys, or OAuth credentials.

## 7. Audit trail

1. The web and executor processes MUST emit append-only JSON audit events,
   one per line, each with `"audit":"cao"`, `event`, `outcome`
   (`success`, `denied`, or `failure`), and a timestamp. Events go to
   standard error, or to the file named by `CAO_AUDIT_LOG`, which is opened
   for append with mode `0600`.
2. The web process MUST record `admin.denied` with the reason
   (`step_up_required` or `not_admin`), the method, and the path for every
   refused administrator request. It MUST record `cli_command.admitted`,
   `cli_command.rejected`, `cli_command.cancel_requested`, and
   `cli_command.retried`. Each admitted event carries the actor, action,
   repository, assurance factors, and step-up time.
3. The executor MUST record `token.minted`, `token.revoked`, and
   `token.revoke_failed`. It MUST also record `cli_command.started`,
   `cli_command.permission_denied`, and `cli_command.finished`, with the
   actor, repository, installation, granted permissions, control revision,
   status, and exit code.
4. Events MUST NOT contain tokens, keys, or OAuth credentials. Token events
   MUST identify the token by `hashed_token`, the Base64 SHA-256 digest that
   GitHub uses in its audit log. Operators can then join CAO events to
   GitHub's audit-log entries for the App's actions.

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
- `server/internal/hostedcli`: broker single use, revocation and retry, pool
  bounds, executor recheck, isolation, redaction, and audit events without
  secrets.
- `server/internal/githubapp/scoped_token_test.go`: over-broad grants are
  revoked and rejected, and `hashed_token` matches GitHub's format.
- `server/internal/audit`: event shape and append-only `0600` file output.
- `tests/unit/setup-hosted-cli-app.test.mjs`: least-privilege App manifest and
  helper safety.

## 10. Security considerations

The App private key grants every permission the App has on every installed
repository. Operators MUST store it as a secret available only to the
`execute-cli` process. Operators SHOULD limit the installation to the control
repository and the explicitly enrolled targets. A compromised administrator
session is limited to the step-up window and to catalog-declared actions on
repositories the administrator can already write.

Subprocesses run as the executor's OS user. The App private key and the
operational database credentials are readable by that user, so operators
SHOULD run `execute-cli` under a dedicated, unprivileged user or container
and SHOULD advance `CAO_HOSTED_CLI_CONTROL_REVISION` only after reviewing the
control repository at that commit. Code at the reviewed revision is trusted
to the same degree as the executor itself.

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
