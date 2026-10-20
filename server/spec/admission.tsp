import "@typespec/http";
import "@typespec/json-schema";

using TypeSpec.Http;
using TypeSpec.JsonSchema;
namespace Cao;

/** Activation-only gh-aw admission metadata. All identifiers are exact decoded strings; run numbers use canonical positive ASCII decimal spelling. Unknown or duplicate fields, invalid Unicode, query parameters and bodies over 8192 bytes are denied. workflow_hash is an untrusted cache hint, never authority. */
@jsonSchema
@example(#{
  repo: "acme/project",
  workflow_id: "acme/project/.github/workflows/triage.lock.yml@refs/heads/main",
  workflow_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  workflow_call_id: "1234-2:acme/project/.github/workflows/triage.lock.yml@refs/heads/main",
  run_id: "1234", run_attempt: "2", ref: "refs/heads/main",
  event_type: "workflow_dispatch", actor: "octocat", triggering_actor: "hubot"
})
model AdmissionRequest {
  ...Record<never>;
  @minLength(3) @maxLength(140)
  @pattern("^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}$")
  repo: string;
  @minLength(1) @maxLength(1024) workflow_id: string;
  @pattern("^[0-9a-f]{64}:[0-9a-f]{64}$") workflow_hash: string;
  /** Exactly run_id + "-" + run_attempt + ":" + workflow_id. */
  @minLength(1) @maxLength(1400) workflow_call_id: string;
  @minLength(1) @maxLength(128) @pattern("^[1-9][0-9]*$") run_id: string;
  @minLength(1) @maxLength(128) @pattern("^[1-9][0-9]*$") run_attempt: string;
  @minLength(1) @maxLength(1024) ref: string;
  @minLength(1) @maxLength(100) event_type: string;
  @minLength(1) @maxLength(100) actor: string;
  /** Informational only; the initial server profile never authorizes or attributes spend from this unsigned value. */
  @minLength(1) @maxLength(100) triggering_actor: string;
}

/** Independent policy allowances, not remaining spend or reservations. The gh-aw client applies validated values to the corresponding runtime caps; omitted optional allowances preserve component policy. Wire numbers are plain positive decimal integers. Approval also idempotently publishes a sparse canonical Run with status admitted before returning 200; denied/blocked attempts publish no run. Publication failure is transient and preserves the original decision for retry. */
@jsonSchema
@example(#{max_ai_credits: 1000, max_ai_credits_threat_detection: 100, max_ai_credits_evals: 50})
model AdmissionAllowances {
  ...Record<never>;
  @minValue(1) @maxValue(2147483647) max_ai_credits: int32;
  @minValue(1) @maxValue(2147483647) max_ai_credits_threat_detection?: int32;
  @minValue(1) @maxValue(2147483647) max_ai_credits_evals?: int32;
}

@tag("Activation admission")
namespace Admission {
  /** Implements the v1.2 wire contract merged in github/gh-aw#70429 at be70cb4ec4317135a1ab21d5b830b6fae7d5be4a, not the incompatible nine-field/correlation_id v1.0 contract merged in #70286 at d9abaf92a50fd8778f12fa122138b30c75daf8f2. Optional hosted service, authenticated exclusively with an Actions RS256 OIDC bearer token from the compiler-owned admission job and an independently configured audience. No OAuth cookie, CSRF token, GitHub API token, redirect or credential fallback. Every response is no-store and has no trace, quota, reset or reason headers. All durable denials are identical empty 403s; transient dependency failures are empty 503s. Spend-independent probe limiting may return empty 429s. Valid caller traceparent parents the server HTTP span and its dependencies; invalid or duplicate trace context starts a fresh server trace without changing the decision. Baggage and tracestate are ignored; sampling is locally controlled. The initial supported claim profile is GitHub.com, string audience, non-reusable workflows; unsupported reusable identities fail closed. */
  @route("/api/admission")
  @useAuth(BearerAuth)
  @post op admit(
    @header("content-type") contentType: "application/json",
    /** Conforming clients send no-store; the server never permits response caching regardless of this request field. */
    @header("cache-control") cacheControl?: "no-store",
    /** Conforming clients always send this field. The server tolerates absent/malformed/duplicate context without changing authorization. */
    @header traceparent?: string,
    @body body: AdmissionRequest
  ):
    { @statusCode code: 200; @header("cache-control") cacheControl: "no-store"; @body body: AdmissionAllowances }
    | { @statusCode code: 403; @header("cache-control") cacheControl: "no-store" }
    | { @statusCode code: 429; @header("cache-control") cacheControl: "no-store" }
    | { @statusCode code: 503; @header("cache-control") cacheControl: "no-store" };
}
