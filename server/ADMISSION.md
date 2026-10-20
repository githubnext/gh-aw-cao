# Cooperative workflow admission

The hosted server optionally implements `POST /api/admission` from the
[gh-aw admission specification](https://github.com/github/gh-aw/blob/be70cb4ec4317135a1ab21d5b830b6fae7d5be4a/docs/src/content/docs/specs/admission-service-specification.md).
Its safety contract follows the
[activation TLA+ model](https://github.com/github/gh-aw/blob/be70cb4ec4317135a1ab21d5b830b6fae7d5be4a/specs/workflow-security/ActivationAdmission.tla):
verified invocation identity, stable retry allowances, private denial reasons,
and no financial side effects. The model is a reference, not proof of the Go
implementation. The gh-aw client owns activation and downstream allowance
handling; validated primary/detection/evals allowances override the corresponding
runtime caps, while omitted optional fields preserve existing component policy.
The server returns policy values, never credentials.

This is **separate from CAO control-policy admission**. A successful response
does not enroll a CAO target, enable a campaign, promote review to live, or
grant repository writes. `.github/workflows/cao.json` remains the authority for
those decisions. The service is a cooperative start-time check, not a billing
API or a hard spending cap. A client using outage `ignore`, changing its managed
variables, or omitting the helper can bypass it.

## Protocol revision and compatibility

This implementation supports the v1.2 wire contract merged in
[github/gh-aw#70429](https://github.com/github/gh-aw/pull/70429), checked against
commit `be70cb4ec4317135a1ab21d5b830b6fae7d5be4a`. The upstream document retains
its draft version label; this pin identifies the actual merged implementation.
It preserves the explicit
requirements for ten request fields (including `workflow_hash`), required primary
and independently optional component allowances, and **no response correlation
identifier**. The merged client's protocol parser is unchanged from the earlier
verified draft (Git blob `a8ea9216b6c946352288332fce48405d1317e915`, SHA-256
`96ff134b1597e839702e5df389ab52a48fb5f35bcc5bada7a4bbc61751490ae4`).
The merged client uses an isolated compiler-owned `admission` job, relays its
validated allowances and caller-owned trace context through activation, and
records a structured `guardrail.admission` session event with admission
provenance. Those are client-owned orchestration/evidence surfaces; this server
neither implements them nor assumes OIDC identifies which helper requested the
token. Independent OIDC grants elsewhere do not attest this helper ran.

It is **not wire-compatible** with the original merged
[github/gh-aw#70286](https://github.com/github/gh-aw/pull/70286) specification at
`d9abaf92a50fd8778f12fa122138b30c75daf8f2`: that v1.0 contract requires nine
request fields and exactly `max_ai_credits` plus a server-generated
`correlation_id` in success. Such clients are denied here for missing the
required hash and would reject this server's success shape. There is no
negotiation, legacy fallback, or implicit protocol selection. Deploy only with
a client implementing the pinned v1.2 wire contract; the fact that the original
proposal merged does not make an older client compatible.

This is a restricted supported profile, not a claim of full upstream acceptance
coverage. Enterprise issuers, reusable invocation disambiguation, policy use of
the rerun initiator, backend App provisioning, trusted usage collection and
automatic replay-record garbage collection remain unsupported or
deployment-owned as described below. No deployment or live acceptance is
established by the automated fixtures.

## Enable the service

Use an existing HTTPS hosted deployment with the **PostgreSQL operational
backend**. Local SQLite, Redis and volatile operational backends cannot enable
this service. The same handler is used by the process, external-listener and
Azure Functions profiles; the existing trusted-host/proxy policy still applies.
The endpoint authenticates OIDC independently of dashboard OAuth and CSRF.
It never accepts a dashboard session or local bearer capability as admission.

Set both server settings:

```sh
CAO_ADMISSION_AUDIENCE=https://cao.example.org/api/admission
CAO_ADMISSION_POLICY_FILE=/run/cao/admission-snapshot.json
```

Neither setting is secret. Both absent disables the service; partial settings,
an invalid audience, an unreadable/malformed initial snapshot, an unsupported
backend or a non-HTTPS profile fail startup. When disabled, the route returns
the same empty denial instead of falling through to dashboard authentication.
No production policy, scope or managed Actions variable is changed automatically.

Provision the participating workflows' `GH_AW_DEFAULT_ADMISSION_URL` and
`GH_AW_DEFAULT_ADMISSION_AUDIENCE` to the matching public endpoint/audience.
Choose and protect `GH_AW_DEFAULT_ADMISSION_ON_OUTAGE=block` if outages must
prevent execution. The gh-aw client defaults to `ignore`. Admission itself needs
no GitHub App, PAT, `GITHUB_TOKEN`, installation token, or provisioning credential.

The native operator commands apply repository-level changes; use `--dry-run`
to preview without applying:

```sh
gh cao setup admission --repo acme/project \
  --url https://cao.example.org/api/admission --dry-run
gh cao admission setup --repo acme/project \
  --url https://cao.example.org/api/admission
gh cao admission status --repo acme/project --json
gh cao admission disable --repo acme/project --dry-run
```

Setup defaults to `block` (unlike gh-aw's built-in `ignore` fallback), and the
audience defaults to the URL; use `--audience` or `--on-outage ignore` explicitly
when required. It preserves unrelated variables and writes the URL last.
After first-time setup, omit `--url` to reuse the target repository's effective
endpoint/audience. For bulk scopes, or a target disabled by an empty override,
the defaults come from the current control repository's effective admission
variables. Missing or unreadable defaults fail rather than guessing a server.
Updates are sequential, not atomic; an error reports partial progress without
claiming success or automatically retrying. Inspect status before retrying.
Status resolves repository overrides and organization variables available to
that repository, including their sources, and fails rather than guessing when
inheritance cannot be read. Disable writes an **empty repository URL**, never
deletes it: deletion could reactivate an inherited organization endpoint.
By default, `--repo` changes only that repository. Bulk setup uses the same
flags through either `gh cao setup admission` or `gh cao admission setup`:

```sh
# Preview the repositories in the current control repository's policy scope.
gh cao setup admission --all-repos --dry-run
# Apply organization defaults (repeat --org for multiple organizations).
gh cao setup admission --org acme --org engineering \
  --url https://cao.example.org/api/admission
# Preview defaults in every organization enumerated from this enterprise.
gh cao setup admission --enterprise company \
  --url https://cao.example.org/api/admission --dry-run
gh cao admission status --enterprise company --json
gh cao admission disable --all-repos --dry-run
```

Select exactly one scope: `--repo`, `--all-repos`, repeatable `--org`, or
`--enterprise`. `--all-repos` reads the local validated CAO policy's global
`control-plane.scope`: an exact `allowed-repositories` list is used without
additional discovery, otherwise every repository visible to the operator in
each exact allowed organization is enumerated. The credential must see the full
intended fleet; the command cannot discover repositories hidden from its owner.
Personal owners need an explicit repository list. This is global scope, not a
campaign's current rollout subset; it never widens CAO policy or enrolls targets.

`--org` writes organization variables with **visibility all**, including future
repositories. `--enterprise` enumerates its organizations through paginated
GraphQL reads and applies those same organization variables; GitHub has no
enterprise Actions-variable scope. Enterprise read access and each organization's
Variables write permission are independently required. Existing variable
visibility is intentionally changed to all when configuring organization scope.
Existing repository overrides are never removed and may still disable admission,
select another endpoint, or use outage `ignore`. Organization status reports
defaults, not per-repository effective state or visibility coverage. Organization
disable cannot defeat an existing nonempty repository override.

All target discovery and variable-read preflight finishes before any mutation.
Empty, malformed or failed discovery/preflight stops without changes. Rollouts
are limited to 1000 targets, sorted and deduplicated, and applied sequentially.
On a write failure, completed targets are reported, the command fails, and
there is no automatic retry or rollback; the failing target may have partial
settings. With `--json`, multiple target results are under `results`; single
target output retains the ordinary report with a `scope` discriminator.

These commands require the
operator's GitHub variable-management permissions, never send credentials to
the authority, and do not provision the trusted accounting publisher or grant
server enrollment.

## Protected policy and accounting input

The authority reads one bounded, versioned snapshot from a **server-owned**
file after verifying the caller. A trusted accounting publisher must atomically
replace that file (write a sibling, then rename) so policy and usage are one
consistent snapshot. The file and its directory must not be writable by
workflows, dashboard users, target repositories or other untrusted processes.
This is not a public upload API. The server does not synthesize missing usage
from browser IndexedDB, client-supplied amounts or workflow success.

The example below is synthetic. Replace identities, the exact reviewed workflow
revision and usage timestamps with authoritative evidence before deployment:

```json
{
  "version": 1,
  "repositories": [{
    "repository": "acme/project",
    "repository_id": "1001",
    "repository_owner_id": "42",
    "enabled": true,
    "subjects": ["repo:acme/project:ref:refs/heads/main"],
    "workflows": [{
      "workflow_ref": "acme/project/.github/workflows/triage.lock.yml@refs/heads/main",
      "workflow_sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "events": ["workflow_dispatch"],
      "actor_ids": ["101"],
      "allowances": {
        "max_ai_credits": 1000,
        "max_ai_credits_threat_detection": 100,
        "max_ai_credits_evals": 50
      }
    }],
    "usage": {
      "unit": "ai-credits",
      "observed_at": "2026-10-20T06:00:00Z",
      "window_start": "2026-10-20T00:00:00Z",
      "window_end": "2026-10-21T00:00:00Z",
      "used": 10,
      "limit": 10000
    }
  }]
}
```

The publisher owns aggregation and provenance. `used` is an explicitly supplied
nonnegative integer count of **AI Credits**, across the enrolled repository's
workflows and components in the specified window; never token counts or
currency. `limit` is the repository's positive threshold in the same units.
This first policy profile does not implement organization-wide aggregation or
actor-specific balances. The publisher must not omit known component usage,
and must report incomplete collection as unavailable rather than publish zero.
Do not enable the service until such a trusted publisher exists.

The window must contain the current time, last at most 24 hours, and contain
the observation timestamp. Observations may be at most two minutes old and at
most 30 seconds ahead. Missing, malformed, stale or unreadable accounting is a
dependency failure (`503`), **not zero usage**. A disabled/unconfigured identity,
unsupported workflow revision, or usage at/above its threshold is a durable
denial (`403`). Policy precedence is exact issuer/repository IDs, exact slug
and subject, then exact workflow reference/SHA, event and signed original actor
ID. There is no wildcard, workflow-hash selector, fallback or case folding.
Duplicate repository IDs and duplicate workflow/reference revision policies
invalidate the snapshot. The file is limited to 1 MiB, 1000 repositories and
100 workflow revisions per repository.

Allowances are positive `int32` policy constants and never computed as a
remaining balance. Optional detection/evals fields are independent; omission
means unspecified. Hidden spend affects only allow/deny, not their values or
presence. Admission does not charge, reserve or decrement anything. Active
executions continue independently and concurrent starts can overshoot the
threshold; authoritative hard caps must be enforced at the controlled backend.

## Supported identity profile

| Input | Accepted profile |
| --- | --- |
| Issuer | Exactly `https://token.actions.githubusercontent.com`; no token-directed discovery |
| Signature | RS256, RSA signature key from the fixed GitHub JWKS endpoint |
| Audience | One JSON string exactly matching the server setting; arrays denied |
| Time | Integer `iat`, `nbf`, `exp`; at most 30 seconds future skew and 600 seconds lifetime; expired tokens denied |
| Immutable identities | Signed string `repository_id`, `repository_owner_id`, `actor_id` |
| Invocation | Signed string `repository`, `run_id`, `run_attempt`, `ref`, `event_name`, `actor` |
| Workflow | Signed `workflow_ref` and 40-character `workflow_sha`, exactly enrolled |
| Subject | Signed `sub`, exactly enrolled (including explicitly reviewed customized subjects) |
| Reusable workflows | Unsupported: either `job_workflow_ref` or `job_workflow_sha` causes denial |
| Rerun initiator | `triggering_actor` is informational only, never authorization or accounting identity |

Reusable workflows are intentionally denied because repeated calls of one
executing reference can share the protocol's invocation identifier. Supporting
them requires an authoritative, unambiguous invocation mapping and additional
deployment fixtures, not a caller-controlled discriminator. Other GitHub
issuers and audience-array profiles are also unsupported, not downgraded.
Trigger/ref/subject combinations must be explicitly enrolled; enrollment is not
inferred from a valid signature. Original actor privileges never become the
rerun initiator's privileges.

Public signing keys are cached for five minutes. Unknown keys trigger bounded
refresh; refresh work is serialized, cancellable and throttled (one request per
second, at most one additional unknown-key refresh per 30 seconds). Failure or
refresh throttling is an outage; a definitively absent key or bad signature is
a denial. Redirects are not followed and no caller credentials reach the issuer.

## Replay, expiry and revocation

The decision key hashes only verified issuer, immutable repository/owner IDs,
run, attempt, original actor ID, workflow reference and revision. It contains no
token or token hash. `workflow_call_id` is independently checked, while
`workflow_hash` remains an untrusted hint and is not used for authorization or
decision caching.

PostgreSQL namespace transactions atomically retain the **first** successful
allowances, including optional-field presence. Their authorization window is
fixed at five minutes from the first database-time commitment, covering the
client's 60-second retry horizon. Neither retries, token renewal, policy changes
nor another replica extend it or replace the response values. Every replay
requires fresh OIDC verification and current policy/usage revalidation.
Dependency failure returns `503` without deleting/replacing the decision;
recovery returns the original allowances. A later durable policy denial revokes
the record permanently when the revocation commits. Durable denials remain
`403` even if recording revocation fails (reported only to protected server
logging); they must not become an outage-based budget bypass. Expiry also
permanently denies that invocation. Retained expiry/revocation is checked even
when current policy/accounting revalidation is unavailable.

Records deliberately have **no evictable cache TTL** and are not removed by
ordinary operational maintenance. Expired/revoked records are tombstones,
preventing late replay from becoming a new decision. They share the existing
protected-entry/byte budgets (default 200000 entries / 128 MiB); capacity
exhaustion is an operational outage, not permission to evict tombstones.
There is no automatic garbage collection or namespace-reset recovery in this
profile. Operators must size/monitor protected capacity and must not delete
records or reset the namespace while the corresponding workflow invocations
could still be eligible. A future collector must first establish an independent
trusted invocation cutoff; token expiry or cache age alone is insufficient.

## Wire, privacy and availability

Requests use exactly the ten string fields in the upstream specification,
with an 8 KiB body, a 16 KiB token, and a 32 KiB aggregate application-header
limit excluding discarded observability fields (which remain subject to the
listener's overall transport limits). Run/attempt strings are canonical positive ASCII decimals, compared
without numeric conversion (up to 128 digits). JSON duplicate/unknown names,
invalid UTF-8/unpaired surrogate escapes, wrong types, control characters,
query parameters and malformed hashes are denied. Request strings are decoded
once and compared exactly.

All durable failures have an empty `403`; dependency failures have an empty
`503`. Unsupported methods never evaluate policy. A separate 60/minute
trusted-client-address bucket may return empty `429`, independently of spend,
without quota/reset/Retry-After headers. Successful JSON contains only the
required primary allowance and the supplied optional allowances. Every
response is `cache-control: no-store`; there are no redirects, trace IDs, policy
reasons, budget balances or internal diagnostics.

The complete application bounds admission responses to five seconds, including
rate limiting, key lookup, reads and decision storage. Key HTTP requests have a
two-second deadline. External listeners should support per-request read
deadlines and impose their own connection/header limits as well; the response
timeout still applies when per-request transport deadlines are unavailable.
The service does not claim constant-time networking.

Only a single valid incoming `traceparent` is retained for server correlation.
Its trace ID is the server HTTP span's trace ID, and its client span ID is that
server span's remote parent. Request-scoped dependencies receive the server
span context, so their spans remain on the same trace. Correlate this trace
with the caller-owned context the merged gh-aw client relays to activation and
subsequent workflow telemetry; no server-issued correlation identifier is
necessary. HTTP instrumentation consumes only the sanitized context, not a
second global propagator that could inject another parent or private metadata.
Missing, invalid or duplicate context starts a fresh context; baggage and
tracestate are discarded. The inbound sampled flag is replaced with a local
choice and the configured server exporter/sampler still owns export. No trace
headers are returned, including on timeouts, disabled service, drain or
operational throttling. Admission does not enable exporters.

### OpenTelemetry operations

Admission uses the server's existing vendor-neutral OTLP/HTTP setup and bounded
shutdown flush; it does not start another exporter or provider. Configure the
same `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_EXPORTER_OTLP_ENDPOINT`
or signal-specific trace/metric endpoints used by the hosted server:

```sh
export OTEL_SERVICE_NAME=cao-dashboard
export OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production
export OTEL_EXPORTER_OTLP_ENDPOINT=https://collector.example.org
```

Keep exporter authorization headers in protected server configuration. Standard
OTLP per-signal headers and endpoints remain supported; no exporter credentials
belong in workflow admission variables. With no configured endpoints, no
exporter starts; `OTEL_SDK_DISABLED=true` disables exporter setup. Log export is
separately opt-in (`CAO_OTEL_LOGS_ENABLED=true`) and debug-category gated, not a
required source of admission diagnostics.

The ordinary `http.server.request.duration` histogram captures admission status
and latency using the fixed `http.route=/api/admission` label, including durable
denials, operational throttles and unavailability. It carries no trace, actor,
repository or policy identifiers as dimensions. Stage spans are fixed names:

| Span | Operation |
| --- | --- |
| `cao_dashboard.admission.identity.verify` | Signature and signed identity verification |
| `cao_dashboard.admission.keys.refresh` | Trusted JWKS refresh, nested under verification |
| `cao_dashboard.admission.policy.evaluate` | Protected policy and accounting read/evaluation |
| `cao_dashboard.admission.decision.resolve` | Durable first-decision/revocation transition |
| `cao_dashboard.admission.replay.check` | Retained eligibility check during a dependency outage |

Dependency failures have only a generic unavailable status; telemetry never
records raw exceptions, tokens, claims, request bodies, allowance values or
budget/denial reasons. Policy denial is not marked as a dependency failure.
Exporter errors do not change the result, retry admission, or grant authority.
Server-side spans and HTTP metrics use the existing configured providers and
resource attributes, so a collector can correlate and monitor the service
without exposing per-tenant operational data.

Keep ingress/access logging and exception capture free of Authorization,
request bodies, raw claims and accounting evidence. The application does not
log them or emit tenant/actor/trace IDs as metric dimensions. Public responses
cannot distinguish hidden spend bands or denial reasons; repeated authenticated
probes can still reveal eligibility changes, as with any cooperative gate.

## Validation

`go -C server test ./internal/admission ./internal/server` exercises strict
protocol/claim fixtures and the full handler's authentication, response,
tracing, probe-limit and timeout boundaries. Set `POSTGRES_URL` to a disposable,
owner-accessible local PostgreSQL database and run
`go -C server test ./internal/operational/postgres -run ActivationAdmission`
for real cross-replica retry, revocation, expiry, outage recovery and capacity
checks. All credentials and accounting in these tests are synthetic.

`TestAdmissionClientTraceparentExportedThroughFullHandler` inspects exported
server and dependency spans for sampled/unsampled callers, retries, malformed,
missing, zero, oversized and duplicate context, including metadata stripping
and absent response identifiers. To reproduce the actual merged client parser
check, download `actions/setup/js/admission_protocol.cjs` and its sibling
`error_codes.cjs` from the pinned merge using the GitHub contents API's
base64-decoded bytes, then run:

```sh
GH_AW_ADMISSION_PROTOCOL_PATH=/absolute/path/admission_protocol.cjs \
  go -C server test ./internal/admission -run TestMergedGhAWClientConformance
```

The test verifies the parser's SHA-256, builds the request using the real
client, sends it through the production service with synthetic signed OIDC, and
parses every allowance combination and integer boundaries using that client.
Without the explicit fixture path it skips; ordinary Go tests need no Node
runtime or network fetch. Do not use sanitized `gh api` raw-terminal output as
parser source: decode the contents API's `content` field and verify its bytes.
The OTel tests also export protobuf to an isolated HTTP collector and verify
shutdown flush, service resource identity, caller trace continuity and
redaction. Separate metric checks cover denial/throttle/unavailability routing;
an injected exporter failure verifies instrumentation cannot change the result.
