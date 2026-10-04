---
title: Managed Redis in one minute
description: Connect operational Redis alongside Postgres dashboard entity storage on a hosted CAO dashboard.
sidebar:
  order: 1325
---

# Managed Redis in one minute

The hosted server reads non-secret host capabilities from
`.github/workflows/cao.json`. Redis credentials stay in deployment environment
variables. Redis provider modules only select conventional environment-variable names
and consistency constraints;
they do not add provider SDKs or weaken TLS verification.
Configure a Postgres connection separately for current dashboard entity storage
and queries. Redis supports operational caches, queues, and sessions; the
server does not store dashboard entities, RediSearch
indexes, or generations in Redis. Postgres replacements are transactional and
have no generations, projections, or snapshots.
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

## Redis memory budget

All server profiles default to a **200 MB (200,000,000-byte)** whole-node Redis
memory budget. Set `CAO_REDIS_MAX_BYTES` to a positive byte count to change it;
Go embedders can override the environment with `server.Config.RedisMaxBytes`.
Malformed, zero, and negative values fail configuration. Azure has no permanent
free Redis tier: this default leaves headroom on the smallest Azure Cache for
Redis tier (250 MB), not a free-service guarantee.

Cache admission measures Redis `INFO memory` usage, including operational state,
connection buffers, and Redis overhead. If the provider reports `maxmemory`, the
effective budget is the smaller of the configured budget and **80% of
`maxmemory`**. Query-result writes atomically retire expired and oldest cached
results before admission, and remeasure after writing. Marketplace and
repository-memory cache writes atomically decline admission when there is not
enough headroom and discard a newly written entry if its actual allocation
exceeds the budget. Rejected admissions are logged; they do not discard the
freshly computed response.

Startup and a cancellation-scoped **30-second maintenance loop** also enforce
the budget without requiring cache traffic. Maintenance trims query results
first, then incrementally scans and deletes only allowlisted marketplace and
repository-memory cache keys in the current namespace until usage is below the
effective budget. Existing cache TTLs are preserved. ACLs must additionally
allow `INFO memory`, `SCAN`, and `SET` from the cache admission scripts.

This is an automatic cache-pressure target, not permission to discard required
operational state or a hard limit on process RSS, disk persistence, or other
applications. Sessions, queues, quota state, revocation retries, and other
namespaces are never evicted. Redis `maxmemory` and eviction policy are never
changed. If these protected allocations alone exceed the budget, startup fails
explicitly, running maintenance reports memory pressure, and further cache
admissions are declined. Scale Redis or reduce operational state in that case;
cache eviction cannot safely guarantee a whole-node cap against non-cache
growth. Use the same budget across replicas sharing a Redis node and retain the
provider's `noeviction` policy to protect operational state.

## Bounded query-result caching

HTTP and MCP queries share a Redis cache-aside layer. Queries taking at least
100 ms are admitted only when their output fits both a conservative in-memory
size preflight and the compact JSON byte limit. Defaults are **1 MiB per result**,
**64 MiB total**, and **1,024 entries**. Set
`CAO_QUERY_CACHE_MAX_RESULT_BYTES` and `CAO_QUERY_CACHE_MAX_BYTES` to positive byte
counts before starting any server profile; the per-result limit cannot exceed
the total. Go embedders can additionally use `server.Config.QueryCache` to
disable caching or adjust the minimum execution duration.
Set `CAO_QUERY_CACHE_DISABLED=true` to disable result caching at startup without
changing application code. This emergency switch does not disable Redis-backed
authentication, request limits, or other operational dependencies. Invalid
switch values fail startup. Cache debug logs report the effective admission
threshold and limits at startup.

Query ETags are SHA-256 hashes of definitions, parameters, pagination, schema version, and
authorization class, but not data revisions. Cached evidence keeps its original
revision and evaluation time for a fixed **five-minute TTL**. Ingestion, rebuilds,
and result reads do not invalidate or renew entries. Readiness and canonical
entity APIs remain uncached. ETags index the internal result cache; the HTTP
query response contract is unchanged.

A namespaced Redis hash holds only bounded result documents, with a sorted-set
expiry index using Redis server time. One Lua operation prunes expired entries
and evicts the oldest admissions until `MEMORY USAGE` for both keys is within
the budget. Budget reductions evict proportional oldest-first batches and
remeasure actual allocation, avoiding a full hash/index memory scan after every
individual eviction. Both keys also expire after five minutes without new admissions.
This bounds live result and index allocation, including metadata; it is a
separate per-cache limit; the whole-node budget above also applies. No global
`maxmemory` or eviction policy is changed, and session/queue keys are untouched.
Partial key eviction discards the remaining cache structure rather than losing
its accounting. Redis errors surface as a query 503, never as empty results or
an unbounded local-cache fallback.
Restricted Redis ACLs must allow the cache's `EVAL` and the commands called by
its script: `TIME`, `EXISTS`, `DEL`, `MEMORY USAGE`, `HGET`, `HSET`, `HDEL`,
`HSTRLEN`, `HEXISTS`, `ZADD`, `ZREM`, `ZRANGE`, `ZRANGEBYSCORE`, `ZSCORE`,
`ZCARD`, and `PEXPIRE`, scoped to the application namespace.

Enable cache debug logs with `DEBUG=cao:server:query-cache` (or
`DEBUG=cao:server:*`). Logs contain only fixed decisions, timings, byte counts,
entry counts, expiry, and eviction counts—not query ETags, parameters, results,
Redis keys, or errors containing connection details.

The existing standard `OTEL_*` configuration exports
`cao_dashboard.query.cache.lookup` and `.store` spans. Metrics under
`cao_dashboard.query.cache.` include `operations` and `duration` by fixed
operation/outcome, `result.bytes`, last-observed `memory.bytes` and `entries`,
and `retired` counts by `expired`/`evicted`. Lookup outcomes distinguish
hit/miss/error; admissions distinguish stored/result-size/capacity/error;
bypasses identify cheap queries, disabled caching, missing Redis, and readiness
probes. Occupancy gauges are observations at cache operations, not continuously
polled Redis state.

Run the cache integration regressions and bounded performance samples against
an isolated local Redis with:

```bash
REDIS_URL=redis://127.0.0.1:6379/0 go -C server test ./internal/redisx \
  -run '^TestQueryCache' -bench '^BenchmarkQueryCache' -benchmem -benchtime=5x
```

The benchmarks measure a full 1,024-entry hit and a full-cache budget reduction.
They exclude fixture ingestion from the measured time. The regression suite
checks measured allocator memory, namespace isolation, unrelated operational
keys, concurrent duplicate admissions, expiry, malformed replies, and retirement
under a one-second operation deadline.

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

Both endpoints reflect dependency state, including Postgres data readiness and
Redis operations. Never use them as process-only liveness probes.

## Provider references

- [AWS ElastiCache endpoints](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/Endpoints.html) and [in-transit encryption](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/in-transit-encryption.html)
- [Redis Cloud connections](https://redis.io/docs/latest/operate/rc/databases/connect/) and [TLS](https://redis.io/docs/latest/operate/rc/security/database-security/tls-ssl/)
- [GCP Memorystore TLS](https://cloud.google.com/memorystore/docs/redis/about-in-transit-encryption) and [AUTH](https://cloud.google.com/memorystore/docs/redis/manage-auth)
- [Railway Redis variables](https://docs.railway.com/databases/redis)
- [Render Key Value connections](https://render.com/docs/key-value)
- [DigitalOcean Managed Valkey connections](https://docs.digitalocean.com/products/databases/valkey/how-to/connect/)
