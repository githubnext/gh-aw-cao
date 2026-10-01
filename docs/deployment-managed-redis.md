---
title: Managed Redis in one minute
description: Connect the hosted CAO dashboard to AWS ElastiCache, Redis Cloud, GCP Memorystore, Railway, Render, or DigitalOcean.
sidebar:
  order: 1325
---

# Managed Redis in one minute

The hosted server reads non-secret host capabilities from
`.github/workflows/cao.json`. Redis credentials stay in deployment environment
variables. Redis provider modules only select conventional environment-variable names
and consistency constraints;
they do not add provider SDKs or weaken TLS verification.
To keep hosting settings separate from rollout policy, you can instead use a
reviewed [deployment-specific host extension](configuration.md#deployment-specific-host-extensions).

## 1. Add the host policy

Add `control-plane.web.host` to `cao.json`:

```json
{
  "target": {
    "module": "container",
    "name": "managed-redis"
  },
  "redis": {
    "module": "generic",
    "url-env": "REDIS_URL",
    "namespace-env": "REDIS_NAMESPACE",
    "session": "pooled",
    "tls": {
      "mode": "required",
      "server-name-env": "REDIS_TLS_SERVER_NAME",
      "ca-certificate-env": "REDIS_TLS_CA_CERT"
    }
  }
}
```

The container includes the checked-in policy. For another location, set
`CAO_POLICY_PATH` to the mounted `cao.json`. `REDIS_URL` accepts
`redis://` or `rediss://`; `tls.mode: "required"` establishes verified TLS even
when the supplied URL uses `redis://`. The server derives the certificate name
from the URL host unless `REDIS_TLS_SERVER_NAME` is set. Put PEM certificate
contents—not a path—in `REDIS_TLS_CA_CERT`.

Use `tls.mode: "disabled"` only with a private endpoint and
`allow-private-plaintext: true`. Public plaintext endpoints are rejected.

The target and Redis provider are independent modules. Change `target.module`
without changing the Redis connection, or change `redis.module` without changing
the app server target. Built-in targets are `container` and `azure-functions`;
`generic` accepts explicit OAuth, listener, proxy,
and single-replica capabilities for a new platform.

### Module deployment flow

1. Policy validation rejects unknown modules and provider-owned capability
   overrides.
2. The target module resolves authentication, listener ownership, HTTPS, and
   proxy trust.
3. The Redis module resolves environment names, TLS minimums, connection
   semantics, replica constraints, and collection support.
4. Startup composes both modules into one host profile, constructs the generic
   Redis client, and asserts that the client and runtime match every capability.
5. The selected target adapter starts the process listener or delegates it to
   the platform. Readiness must succeed before deployment promotion.

Target modules never resolve Redis credentials. Redis modules never own HTTP
request handling or deployment authority. Adding a module requires a reviewed
registry entry, schema and policy validation, documentation, and composition
tests; modules cannot be loaded from an untrusted path at runtime.

Hosted startup requires this modular `web.host` policy. Flat host objects,
`redis.preset`, and environment-only host selection are rejected.

| App target module | Use |
| --- | --- |
| `container` | Coolify, Railway, Render, Kubernetes, VMs, and similar process-owned hosts. |
| `azure-functions` | Azure Functions' platform-owned listener and trusted platform proxy. |
| `generic` | A new platform with explicit reviewed capabilities. |

### Externally owned Go HTTP listener

For an HTTP server that owns its own socket and shutdown, select the
`generic` target with `authentication: "github-oauth"` and
`listener: "external"` in a reviewed host extension; keep the Redis module
independent:

```json
{
  "target": {
    "module": "generic",
    "name": "external-host",
    "authentication": "github-oauth",
    "listener": "external"
  },
  "redis": { "module": "redis-cloud", "tls": { "mode": "required" } }
}
```

The public `server/hosting` package accepts built-site and query-document
paths, then offers `New`, `Start`, `Handler`, and `Stop`. Start CAO before
admitting requests; shut down and drain the HTTP server before calling `Stop`.
Only the host owns the socket and TLS certificates: a CAO process listen address
or TLS files are rejected. The host must pass the complete handler unchanged;
CAO still verifies OAuth, session/CSRF, webhook signatures, request hosts, and
rate limits. Direct requests require HTTPS, or the host can use a trusted
private proxy with `CAO_TRUSTED_PROXY_CIDRS` and an exact `CAO_ALLOWED_HOSTS`
allowlist. Forwarded headers from other peers are rejected.

Preserve the root paths and streaming support, including `http.Flusher` and
response deadline control. `/api/v1/events` is long-lived, so a global
whole-request timeout cannot encompass it; apply bounded deadlines to ordinary
routes instead. Bound concurrent connections and streams at the host because
per-request rate limiting alone does not cap active streams. Public package
builds require no host framework or private dependency.

### Example compositions

Coolify and other container platforms pair the `container` target with any
compatible Redis module:

```json
{
  "target": { "module": "container", "name": "coolify" },
  "redis": { "module": "redis-cloud", "tls": { "mode": "required" } }
}
```

Azure Functions can use the same Redis modules without changing its listener
adapter:

```json
{
  "target": { "module": "azure-functions" },
  "redis": { "module": "gcp-memorystore", "tls": { "mode": "required" } }
}
```

Local development remains the `cao-dashboard serve` example with loopback Redis;
the `local` Redis module describes its ordinary pooled semantics. Upstash pairs
the `container` target with the constrained `upstash` Redis module; see the
[Upstash deployment guide](deployment-upstash.md).

## 2. Pick a Redis provider module

Change only `redis.module`, then map the provider connection into the listed
variables. Percent-encode usernames and passwords placed in a URL.

### AWS ElastiCache

```json
{ "module": "aws-elasticache", "tls": { "mode": "required" } }
```

```bash
REDIS_URL='rediss://PRIMARY_OR_CONFIGURATION_ENDPOINT:PORT'
```

Use the endpoint and port reported by ElastiCache. Add URL credentials only when
the cache uses RBAC. Serverless caches require in-transit encryption.

### Redis Cloud

```json
{ "module": "redis-cloud", "tls": { "mode": "required", "ca-certificate-env": "REDIS_TLS_CA_CERT" } }
```

```bash
REDIS_URL='rediss://DATABASE_ENDPOINT:PORT'
```

Use the database security page's CA PEM in `REDIS_TLS_CA_CERT` only when Redis
Cloud supplies a private CA.

### GCP Memorystore

The module can assemble a URL from `REDISHOST`, `REDISPORT`,
`REDIS_USERNAME`, and `REDIS_PASSWORD`.

```json
{ "module": "gcp-memorystore", "tls": { "mode": "required", "ca-certificate-env": "REDIS_TLS_CA_CERT" } }
```

```bash
REDISHOST="$(gcloud redis instances describe INSTANCE --region=REGION --format='value(host)')"
REDISPORT="$(gcloud redis instances describe INSTANCE --region=REGION --format='value(port)')"
REDIS_TLS_CA_CERT="$(gcloud redis instances describe INSTANCE --region=REGION --format='value(serverCaCerts[0].cert)')"
export REDISHOST REDISPORT REDIS_TLS_CA_CERT
```

If AUTH is enabled, set `REDIS_PASSWORD` to the instance AUTH string. Use
`tls.mode: "disabled"` plus `allow-private-plaintext: true` only for a private
non-TLS instance.

### Railway

```json
{ "module": "railway", "tls": { "mode": "disabled" }, "allow-private-plaintext": true }
```

In the CAO service variables:

```text
REDIS_URL=${{Redis.REDIS_URL}}
```

Use the actual Redis service name. Prefer Railway's private URL; do not expose a
TCP proxy solely for CAO.

### Render

For a service in the same Render private network:

```json
{ "module": "render", "tls": { "mode": "disabled" }, "allow-private-plaintext": true }
```

```text
REDIS_URL=<Render Internal Redis URL>
```

For an external client, use the External Redis URL and
`tls.mode: "required"`.

### DigitalOcean Managed Valkey

```json
{ "module": "digitalocean", "tls": { "mode": "required" } }
```

```text
REDIS_URL=<TLS connection URI from Connection Details>
```

Use the reported URI and port rather than assuming a default.

## Generic connection fields

| Field | Default | Purpose |
| --- | --- | --- |
| `module` | Required | Provider environment mapping and fixed consistency capabilities. |
| `url-env` | Module-specific, usually `REDIS_URL` | Complete Redis URL. |
| `host-env`, `port-env` | Module-specific | Build a URL when no URL variable is supplied. |
| `username-env`, `password-env` | Preset-specific | Credentials used only while building a URL. |
| `namespace-env` | `REDIS_NAMESPACE` | Stable deployment identity; defaults to `hosted-dashboard`. |
| `session` | `pooled` | `pooled` or fail-closed `serialized`. |
| `isolate-process-namespace` | `false` | Use a fresh namespace each process start. |
| `allow-private-plaintext` | `false` | Permit plaintext only for a private host. |
| `tls.mode` | `auto` | Infer from URL, require TLS, or disable TLS. |

The `upstash` module fixes serialized sessions, process namespace isolation, one
replica, required TLS, and disabled server-side collection. The `generic` module
is the only Redis module that accepts explicit consistency capability fields.
Local Redis, Azure Functions, Coolify, and Upstash are compositions of target and
Redis modules; they are not separate shared request implementations.

## Verify

Start the server and check:

```bash
curl -fsS https://YOUR_HOST/api/health
curl -fsS https://YOUR_HOST/api/readiness
```

Both endpoints include Redis dependency state. Never use them as process-only
liveness probes.

## Provider references

- [AWS ElastiCache endpoints](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/Endpoints.html) and [in-transit encryption](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/in-transit-encryption.html)
- [Redis Cloud connections](https://redis.io/docs/latest/operate/rc/databases/connect/) and [TLS](https://redis.io/docs/latest/operate/rc/security/database-security/tls-ssl/)
- [GCP Memorystore TLS](https://cloud.google.com/memorystore/docs/redis/about-in-transit-encryption) and [AUTH](https://cloud.google.com/memorystore/docs/redis/manage-auth)
- [Railway Redis variables](https://docs.railway.com/databases/redis)
- [Render Key Value connections](https://render.com/docs/key-value)
- [DigitalOcean Managed Valkey connections](https://docs.digitalocean.com/products/databases/valkey/how-to/connect/)
