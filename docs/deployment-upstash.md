---
title: Deploying the dashboard with Upstash Redis
description: Use Upstash Redis as the managed Redis service for a hosted Central Agentic Ops dashboard.
---

> [!WARNING]
> **Experimental:** The hosted dashboard and its Upstash Redis configuration are experimental and aren't certified for production use. Before you expose the deployment to users, complete your own security, privacy, capacity, cost, monitoring, and recovery reviews.

## About the Upstash deployment

Upstash supplies operational Redis for the hosted dashboard. It doesn't run the
dashboard application and it doesn't store dashboard entities. Run the CAO
container on [Coolify](deployment-coolify.md), a virtual machine, Kubernetes, or
another container platform, connect it to PostgreSQL for dashboard data, and
connect it to Upstash by using the database's TLS Redis URL.

The deployment uses the existing host-neutral `serve-hosted` profile:

- The CAO server connects to Upstash over the Redis TCP protocol with TLS.
- The browser connects only to the CAO server. It never receives the Upstash endpoint or credentials.
- This single-session provider uses core Redis hashes, streams, and Lua scripts. It doesn't use the Upstash REST API or require Redis modules.
- The Upstash `cao.json` example serializes every Redis operation through one TCP session. If that session is lost, the client fails closed until the process restarts.
- Each process start uses a fresh internal Redis namespace, so active sessions and transient operational state from an earlier TCP session can't reappear after a restart. The encrypted pending-revocation queue uses a stable deployment-scoped prefix so failed GitHub token revocations remain retryable after restart.
- PostgreSQL stores dashboard entities and executes queries. Upstash stores server-side sessions, rate limits, webhook delivery markers, rebuild coordination, and bounded caches.

```mermaid
flowchart LR
  Browser["Authorized browser"] -->|"HTTPS"| Host["CAO dashboard container<br/>serve-hosted"]
  Host -->|"OAuth and membership"| GitHub["GitHub OAuth + API"]
  Host -->|"PostgreSQL protocol"| Postgres["PostgreSQL<br/>dashboard entities + queries"]
  Host -->|"rediss:// over TLS"| Upstash["Upstash Redis<br/>operational state"]
  Artifact["Verified dashboard artifact"] -->|"read-only mount"| Host
```

## Prerequisites

| Requirement | Details |
| --- | --- |
| Application host | A container platform or host that can run exactly one replica of `server/Dockerfile` behind HTTPS. Upstash mode doesn't support load-balanced replicas. To use the checked-in Compose profile, follow the [Coolify deployment](deployment-coolify.md). |
| PostgreSQL | A PostgreSQL database reachable by the application host. It stores all dashboard entity sources, documents, diagnostics, and revision state. |
| Upstash Redis | A dedicated Upstash Redis database for this deployment's security boundary, with TLS enabled. Place it near the application host to reduce query and ingestion latency. |
| Capacity | Enough PostgreSQL capacity for dashboard data and enough Upstash storage and command capacity for operational state. |
| Eviction | Disable Redis eviction. If Upstash reaches its data limit, writes must fail instead of silently evicting security or queue state. |
| Dashboard artifact | A complete payload from the `cao-dashboard.yml` workflow, including `payload-hashes.json` and every file that it lists. |
| GitHub OAuth app | An OAuth app with the callback URL `https://PUBLIC-HOST/auth/callback`. |

The application host needs outbound access to PostgreSQL, the Upstash Redis endpoint, and the GitHub OAuth and API endpoints.

## Deploying the dashboard

1. Create a dedicated Redis database in the [Upstash console](https://console.upstash.com/).
1. Disable eviction for the database.
1. Copy the database's TLS Redis connection string. Use the `rediss://` connection string for the Redis TCP endpoint, not the REST URL or REST token.
1. Store the complete connection string as the secret `REDIS_URL` on your application host.

   > [!CAUTION]
   > The connection string contains a credential. Don't commit it, pass it as a command-line argument, include it in a URL shown to users, or write it to logs.

1. Add this non-secret host example under `control-plane.web` in
   `.github/workflows/cao.json`:

   ```json
   {
     "host": {
       "target": {
         "module": "container",
         "name": "upstash",
         "replicas": 1
       },
       "redis": {
         "module": "upstash",
         "url-env": "REDIS_URL",
         "namespace-env": "REDIS_NAMESPACE",
         "tls": { "mode": "required" }
       }
     }
   }
   ```

1. Set `REDIS_NAMESPACE` to a unique value, such as `upstash-dashboard`, and
   configure the application host to run exactly the one replica declared by
   `target.replicas`.
1. Configure `CAO_POSTGRES_URL` with the PostgreSQL connection URL.
1. Configure the remaining `serve-hosted` settings, including the allowed host, trusted proxy boundary, GitHub OAuth app, authorization policy, session secret, administrators, webhook secret, and source directory. For the complete list, see the [hosted service profile](https://github.com/githubnext/gh-aw-cao/blob/main/server/README.md#hosted-service-profile).
1. Build or select the CAO container image and provide the verified dashboard artifact to the container as read-only input.

   To deploy with Coolify, use `server/coolify/compose.yml` and follow [Deploying the dashboard to Coolify](deployment-coolify.md#deploying-the-dashboard). Set its `REDIS_URL` secret to the Upstash TLS Redis connection string and keep the resource at one replica.

1. Start the container. On startup, `serve-hosted` verifies the artifact and transactionally replaces the current dashboard dataset in PostgreSQL.
1. Verify the deployment.

   1. Confirm that `GET /api/readiness` returns `200`.
   1. Sign in with an authorized GitHub account.
   1. Run a bounded dashboard query.
   1. Confirm that an unauthorized account is refused.
   1. Review the Upstash metrics for errors, command volume, storage, and latency during ingestion and query traffic.

## Configuration reference

The Upstash-specific settings are:

| Variable | Required | Secret | Description |
| --- | --- | --- | --- |
| `CAO_POSTGRES_URL` | Yes | Yes | PostgreSQL connection URL for dashboard entities and queries. |
| `REDIS_URL` | Yes | Yes | The Upstash Redis TCP connection string. It must use `rediss://`. Don't use the REST URL or token. |
| `REDIS_NAMESPACE` | No | No | Stable deployment identity used to derive a fresh internal namespace at every process start and the durable pending-revocation prefix. Defaults to `hosted-dashboard`. |
| `CAO_POLICY_PATH` | No | No | Mounted `cao.json` location when it is not `.github/workflows/cao.json`. |

Upstash provides causal consistency only within one TCP connection. Upstash mode therefore serializes all Redis commands through one connection, disables connection recycling and retries, and permanently fails that client after transport loss. Restarting creates an isolated Redis namespace; dashboard data remains in PostgreSQL. Server-side collection and standalone collection roles aren't supported in this mode.

## Monitoring the deployment

### Health and diagnostics

Use `GET /api/health` to check the Redis dependency and `GET /api/readiness` to check whether the process can serve dashboard data. Both report a lost Upstash session, so don't use them as process-only liveness probes. Restart the process when readiness fails because of a lost Redis connection.

The standalone `doctor` command starts another TCP session and can't inspect the active process namespace. Use the authenticated diagnostics API and Upstash metrics instead.

### Upstash usage

Monitor rejected commands, latency, connection count, and command volume in Upstash. Dashboard ingestion writes entity rows to PostgreSQL, not Redis. Each restart leaves its isolated Redis namespace behind, so remove superseded process namespaces only while the single application replica is stopped. Do not remove the stable `upstash-…-durable` pending-revocation prefix.

Configure capacity alerts before the database reaches its storage or command limits. The server fails closed when Redis can't enforce authentication-related state or rate limits.

### Logs and traces

Container logs include Redis operation names and argument or batch counts, but not the Upstash URL, credentials, source records, or query payloads. To enable selected debug namespaces, set `DEBUG` to a value such as `cao:server,cao:redis`.

The server exports vendor-neutral OpenTelemetry traces when standard `OTEL_*` environment variables are configured. Keep exporter credentials in your application's secret manager.

## Rotating the Upstash credential

1. Create or obtain the replacement Upstash credential.
1. Update the `REDIS_URL` secret on the application host without logging its value.
1. Restart or redeploy the single CAO server replica. The new process creates an isolated namespace and invalidates every existing CAO session.
1. Confirm readiness, OAuth sign-in, a bounded query, webhook verification, and rate-limit behavior.
1. Revoke the previous credential after every replica uses the replacement.

Credential rotation doesn't require a dashboard data migration because dashboard entities remain in PostgreSQL.

## What this deployment guarantees

- **Encrypted Redis transport.** The CAO server requires the Upstash connection to use `rediss://` and verifies the TLS certificate and host name.
- **Server-side credentials.** The browser never receives the Redis endpoint, password, or REST token.
- **Fail-closed security state.** Requests fail when Redis can't enforce hosted rate limits or required session state.
- **Single-session causal ordering.** One process serializes commands on one TCP session and doesn't reconnect after losing that session.
- **Separated storage.** PostgreSQL owns dashboard entities and queries; Upstash owns only operational Redis state.

## What this deployment does not guarantee

- **Application hosting.** Upstash runs Redis, not the CAO container, HTTPS ingress, artifact storage, or reverse proxy.
- **Private networking.** The application connects to the managed Upstash endpoint over the network. TLS protects the connection, but you must review the provider and network boundary.
- **Capacity or cost.** You must select and monitor both PostgreSQL and Upstash plans for their separate workloads.
- **High availability.** Upstash mode requires one CAO replica. A lost Redis session requires a process restart, and restart invalidates signed-in sessions.
- **Backups.** CAO doesn't back up PostgreSQL or Redis. Retain the authoritative dashboard artifact so PostgreSQL can be rebuilt; Redis operational state is disposable except for bounded revocation retries.
- **Automatic artifact refresh.** Upstash doesn't fetch CAO artifacts. Refresh behavior belongs to the application deployment and control repository.

## Recovering the deployment

If Redis operational state becomes unusable, stop and restart the CAO replica so it uses a fresh namespace. If PostgreSQL dashboard data becomes unusable, rebuild it from the retained verified artifact. Remove superseded Redis process namespaces only while the application is stopped; retain the stable `upstash-…-durable` pending-revocation prefix.

To roll back the application, redeploy the last known-good image digest through the same protected deployment environment. Then verify readiness, OAuth authorization, a bounded query, webhook handling, and rate limits. Rolling back the image doesn't roll back Upstash credentials or session secrets.

## Further reading

- [About deployment options](deployment.md)
- [Deploying the dashboard to Coolify](deployment-coolify.md)
- [Data ingestion](dashboard-data-ingestion.md)
- [Data model](dashboard-data-model.md)
- [Monitor and recover](operations.md)
- [`server/README.md`](https://github.com/githubnext/gh-aw-cao/blob/main/server/README.md)
- [`server/SECURITY.md`](https://github.com/githubnext/gh-aw-cao/blob/main/server/SECURITY.md)
