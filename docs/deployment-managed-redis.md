---
title: Managed Redis in one minute
description: Connect the hosted CAO dashboard to AWS ElastiCache, Redis Cloud, GCP Memorystore, Railway, Render, or DigitalOcean.
sidebar:
  order: 1325
---

# Managed Redis in one minute

The hosted server reads non-secret host capabilities from
`.github/workflows/cao.json`. Redis credentials stay in deployment environment
variables. Provider presets only select conventional environment-variable names;
they do not add provider SDKs or weaken TLS verification.

## 1. Add the host policy

Add `control-plane.web.host` to `cao.json`:

```json
{
  "name": "managed-redis",
  "authentication": "github-oauth",
  "listener": "process",
  "require-https": true,
  "supports-collection": true,
  "redis": {
    "preset": "generic",
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

## 2. Pick a provider preset

Change only `redis.preset`, then map the provider connection into the listed
variables. Percent-encode usernames and passwords placed in a URL.

### AWS ElastiCache

```json
{ "preset": "aws-elasticache", "tls": { "mode": "required" } }
```

```bash
REDIS_URL='rediss://PRIMARY_OR_CONFIGURATION_ENDPOINT:PORT'
```

Use the endpoint and port reported by ElastiCache. Add URL credentials only when
the cache uses RBAC. Serverless caches require in-transit encryption.

### Redis Cloud

```json
{ "preset": "redis-cloud", "tls": { "mode": "required", "ca-certificate-env": "REDIS_TLS_CA_CERT" } }
```

```bash
REDIS_URL='rediss://DATABASE_ENDPOINT:PORT'
```

Use the database security page's CA PEM in `REDIS_TLS_CA_CERT` only when Redis
Cloud supplies a private CA.

### GCP Memorystore

The preset can assemble a URL from `REDISHOST`, `REDISPORT`,
`REDIS_USERNAME`, and `REDIS_PASSWORD`.

```json
{ "preset": "gcp-memorystore", "tls": { "mode": "required", "ca-certificate-env": "REDIS_TLS_CA_CERT" } }
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
{ "preset": "railway", "tls": { "mode": "disabled" }, "allow-private-plaintext": true }
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
{ "preset": "render", "tls": { "mode": "disabled" }, "allow-private-plaintext": true }
```

```text
REDIS_URL=<Render Internal Redis URL>
```

For an external client, use the External Redis URL and
`tls.mode: "required"`.

### DigitalOcean Managed Valkey

```json
{ "preset": "digitalocean", "tls": { "mode": "required" } }
```

```text
REDIS_URL=<TLS connection URI from Connection Details>
```

Use the reported URI and port rather than assuming a default.

## Generic connection fields

| Field | Default | Purpose |
| --- | --- | --- |
| `preset` | `generic` | Environment mapping only. |
| `url-env` | Preset-specific, usually `REDIS_URL` | Complete Redis URL. |
| `host-env`, `port-env` | Preset-specific | Build a URL when no URL variable is supplied. |
| `username-env`, `password-env` | Preset-specific | Credentials used only while building a URL. |
| `namespace-env` | `REDIS_NAMESPACE` | Stable deployment identity; defaults to `hosted-dashboard`. |
| `session` | `pooled` | `pooled` or fail-closed `serialized`. |
| `isolate-process-namespace` | `false` | Use a fresh namespace each process start. |
| `allow-private-plaintext` | `false` | Permit plaintext only for a private host. |
| `tls.mode` | `auto` | Infer from URL, require TLS, or disable TLS. |

The Upstash example combines `session: "serialized"`,
`isolate-process-namespace: true`, `single-replica: true`, and disabled
server-side collection. Local Redis, Azure Functions, Coolify, and Upstash are
deployment examples built from the same host and Redis fields; they are not
separate server implementations.

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
