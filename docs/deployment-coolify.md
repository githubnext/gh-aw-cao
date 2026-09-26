---
title: Coolify
description: Deploy the Central Agentic Ops dashboard server as a hardened container on a self-hosted Coolify instance.
---

> [!WARNING]
> **Experimental:** The Coolify deployment is experimental. The container image, Compose file, deployment workflow, adapter contract, and environment variables may change between releases. It has not been certified for production use; complete your own security, network, backup, monitoring, and rollback review before exposing it to users.

The Coolify option runs the same Go dashboard server as the [Azure](deployment-azure.md) option, packaged as a non-root container image and started with `serve-hosted`. Coolify's proxy terminates public TLS and is the only ingress. The container reads a pre-populated, hash-verified dashboard artifact from a read-only volume, projects it into Redis, and serves the dashboard to users authenticated with GitHub OAuth and authorized by explicit organization or team membership.

Coolify is a peer of the Azure profile. It does not replace, modify, or weaken it.

## Prerequisites

| Requirement | Detail |
| --- | --- |
| Coolify | A self-hosted Coolify instance able to run Docker Compose resources, with its proxy terminating TLS for a public host name you control |
| Container runtime | Docker on the Coolify server, able to pull from GHCR |
| Container image | `ghcr.io/<owner>/<repository>/cao-dashboard@sha256:...`, built from `server/Dockerfile` and referenced by immutable digest |
| Redis | A Redis service reachable on Coolify's private network, or an external Redis with TLS. No Redis modules are required. Configure `noeviction` and size memory for retained generations. |
| Artifact volume | An existing Coolify-managed named Docker volume containing a complete, verified dashboard payload |
| GitHub OAuth App | Callback URL `https://<public-host>/auth/callback` |
| GitHub webhook | Optional; a webhook secret of at least 32 characters is always required |
| Deployment automation | For `.github/workflows/coolify-deploy.yml`: GitHub environments `coolify-alpha`, `coolify-beta`, and `coolify-stable`, each with `COOLIFY_DEPLOY_ENDPOINT` and `COOLIFY_DEPLOY_TOKEN` secrets, plus a synchronous HTTPS deployment adapter for the Coolify resource |

The runtime container needs no outbound access other than Redis and the GitHub OAuth and API endpoints.

## Deploying the dashboard

1. Build or select an image. To build the image, run the following command from the repository root.

   ```bash
   docker build -f server/Dockerfile \
     --build-arg VERSION=0.0.0-alpha \
     --build-arg REVISION="$(git rev-parse HEAD)" \
     --build-arg CREATED="$(git show -s --format=%cI HEAD)" \
     -t cao-dashboard:test .
   ```

   For hosted use, prefer the image published by `coolify-deploy.yml`, and always reference it as `name@sha256:<digest>`.
1. Register a GitHub OAuth App and set its **Authorization callback URL** to `https://<public-host>/auth/callback`. For more information, see [Creating an OAuth app](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app) in the GitHub documentation.
1. Provision Redis in Coolify on the same private network as the dashboard, or use an external `rediss://` endpoint.
1. Stage the artifact volume. Create a new, unattached volume, copy in a complete `payload-hashes.json` and every inventory, run, and record file it references from a trusted `cao-dashboard.yml` artifact, and verify every hash. Never copy files into a volume attached to a running service.
1. In Coolify, create a Docker Compose resource from `server/coolify/compose.yml`. The file publishes no host port, so attach the public domain through the Coolify proxy to container port `8080`.
1. Set the variables and secrets listed in [Configuration reference](#configuration-reference). Store every credential as a Coolify secret.
1. Set `CAO_TRUSTED_PROXY_CIDRS` to the exact private subnet Coolify assigns to its proxy network. Do not use `0.0.0.0/0` or a whole RFC 1918 range; startup rejects public, malformed, or missing CIDRs.
1. Deploy the resource. On start, `serve-hosted` ingests `CAO_SOURCE_DIRECTORY` (`/app/source`), stages a generation, and activates it.
1. Verify the deployment.

   - Confirm that `https://<public-host>/api/readiness` returns `200`.
   - Sign in with an authorized account and run a bounded query.
   - Confirm that an unauthorized account is refused.
   - If you use webhooks, send a signed test delivery.

To update data, stage a new volume the same way, set `CAO_ARTIFACT_VOLUME` to it, and redeploy. An administrator listed in `CAO_GITHUB_ADMIN_USERS` can also force a staged rebuild with `POST /api/admin/rebuild`.

### Automating delivery

`.github/workflows/coolify-deploy.yml` builds, scans (Trivy, failing on critical and high findings), publishes, and deploys immutable images:

| Trigger | Image identity | Environment |
| --- | --- | --- |
| Published non-prerelease `vX.Y.Z` release | `vX.Y.Z` at its exact commit | `coolify-stable` |
| Published SemVer prerelease | `vX.Y.Z-<prerelease>` at its exact commit | `coolify-beta` |
| Push to `main` touching server or dashboard sources | `sha-<commit>` | `coolify-alpha` |
| Manual `alpha`, `beta`, or `stable` from `main` or `release` | Current `main`, or the latest eligible release for the channel | Matching environment |

Fork payloads are refused. Before calling the adapter the workflow rechecks that the source is still current for its channel. The adapter must record the previous digest, set `CAO_IMAGE` to the requested digest, trigger Coolify, poll to a terminal state, and verify `/api/readiness`. On failure it must redeploy and verify the previous digest before returning an error. Success is only a bounded JSON body `{"status":"ready","image":"...@sha256:...","digest":"sha256:..."}` that echoes the requested identity; queued or accepted responses are failures. Use environment protection rules for approvals.

## Configuration reference

Variables consumed by `server/coolify/compose.yml`:

| Variable | Required | Secret | Meaning |
| --- | --- | --- | --- |
| `CAO_IMAGE` | Yes | No | Immutable `ghcr.io/...@sha256:...` image reference |
| `CAO_ARTIFACT_VOLUME` | Yes | No | Existing Coolify-managed volume with the verified payload, mounted read-only at `/app/source` |
| `CAO_REDIS_URL` | Yes | Yes | Redis URL; `rediss://` preferred |
| `CAO_ALLOW_PRIVATE_PLAINTEXT_REDIS` | No, default `false` | No | Exact `true` allows `redis://` only to a private IP or single-label service name on the private network |
| `CAO_REDIS_NAMESPACE` | No, default `coolify-dashboard` | No | Redis key namespace |
| `CAO_ALLOWED_HOSTS` | Yes | No | Comma-separated public host names |
| `CAO_TRUSTED_PROXY_CIDRS` | Yes | No | Exact private CIDR of Coolify's proxy network |
| `CAO_GITHUB_CLIENT_ID` | Yes | No | OAuth App client ID |
| `CAO_GITHUB_CLIENT_SECRET` | Yes | Yes | OAuth App client secret |
| `CAO_GITHUB_REDIRECT_URL` | Yes | No | `https://<public-host>/auth/callback` |
| `CAO_SESSION_SECRET` | Yes | Yes | Session key, at least 32 characters |
| `CAO_SESSION_SECRET_PREVIOUS` | No | Yes | Previous session key during rotation |
| `CAO_GITHUB_ALLOWED_ORGS` / `CAO_GITHUB_ALLOWED_TEAMS` | At least one | No | Organizations or `org/team-slug` values whose active members are authorized |
| `CAO_GITHUB_ADMIN_USERS` | Yes | No | GitHub logins allowed to trigger rebuilds |
| `CAO_GITHUB_WEBHOOK_SECRET` | Yes | Yes | Webhook signature secret, at least 32 characters |
| `CAO_BUILD_VERSION` | No | No | Reported build version |

The Compose service also runs with `read_only: true`, a 64 MiB `noexec` `/tmp`, all Linux capabilities dropped, `no-new-privileges`, `init`, and user `65532:65532`. Keep these settings.

## Monitoring the deployment

- **Container health.** The image's `HEALTHCHECK` calls `/api/readiness` every 30 seconds through the trusted-host path. Coolify shows its status and restarts the service according to `restart: unless-stopped`.
- **OpenTelemetry traces.** The server emits `otelhttp` request spans plus `cao_dashboard.query.execute` and `cao_dashboard.ingest.run` spans with non-secret attributes only. The checked-in `compose.yml` does not pass any `OTEL_*` variables, so tracing is off by default. To enable it, add `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`), optional `OTEL_EXPORTER_OTLP_HEADERS` as a Coolify secret, and optional `OTEL_SERVICE_NAME` to the service environment in your Coolify resource, pointing at an OTLP/HTTP collector you operate. `OTEL_SDK_DISABLED=true` forces tracing off. Responses carry `X-Trace-Id` and `X-Span-Id`, and incoming `traceparent` headers are honored.
- **Logs.** Container stdout and stderr appear in Coolify's log view. Add `DEBUG=cao:*` (or a narrower pattern such as `cao:server,cao:query`) to enable debug namespaces; logs never contain tokens, credentials, query payloads, or source records.
- **Diagnostics.** Run `/app/cao-dashboard doctor --redis-namespace coolify-dashboard` in the container with `CAO_REDIS_URL` in its environment for a read-only check of Redis, canonical data, and queries. Add `--deep`, `--format json`, or `--strict` as needed.
- **Delivery history.** GitHub deployment history for each `coolify-*` environment records every rolled-out digest.
- **Agentic workflow traces** are configured in the control repository. For more information, see [Optional observability](configuration.md#optional-observability).

## What this deployment guarantees

- The same `serve-hosted` controls as Azure apply: GitHub OAuth, explicit organization or team authorization, encrypted server-side sessions, CSRF protection, webhook signature verification and deduplication, Redis-backed rate limits that fail closed, and secret-redacting logs. PATs and local bearer capabilities are rejected.
- Forwarded headers are trusted only from `CAO_TRUSTED_PROXY_CIDRS`, the forwarded protocol must be `https`, and the host must match `CAO_ALLOWED_HOSTS` exactly.
- Plaintext Redis is refused unless explicitly opted in for a private address or single-label service name.
- Deployments reference an exact, scanned image digest. Channel tags are never used as deployment identity, and no tier promotes another tier's image.
- A failed adapter deployment rolls back to and verifies the previous digest before reporting failure.
- Ingestion and rebuilds activate only complete generations; a failure leaves the previous generation active.

## What this deployment does not guarantee

- **Platform.** Coolify, the host, Docker, TLS certificates, and the proxy network are operator-managed. CAO provides no SLA and does not harden the host.
- **Redis operations.** Redis authentication, ACLs, persistence, memory sizing, and network isolation are your responsibility. Redis is disposable and not backed up by CAO.
- **Adapter.** The repository does not ship the Coolify deployment adapter; you must implement and secure the synchronous contract above.
- **Data freshness.** Nothing refreshes the artifact volume automatically. Data is as fresh as the last staged volume or rebuild. For the upstream schedule, see [CAO Activity](activity.md).
- **Live updates.** Server-Sent Events are best-effort; clients fall back to refresh polling.
- **Per-repository authorization.** Authorized users can read the full active generation.
- **Secret rollback.** Rolling back an image does not roll back OAuth, webhook, or session secrets.

## Rolling back the deployment

Record the last known-good `name@sha256:...` from the GitHub deployment history before every rollout. To roll back, use the same protected environment's adapter to set `CAO_IMAGE` to that exact prior digest and redeploy; do not retag images. Confirm readiness, OAuth login and authorization, a bounded query, webhook signature handling, and rate limits. If the new binary wrote an unusable projection, clear only the deployment's Redis namespace and let the service re-ingest the retained artifact.

For the detailed reference, see [`server/README.md`](https://github.com/githubnext/gh-aw-cao/blob/main/server/README.md#coolify-container-profile) and [`server/SECURITY.md`](https://github.com/githubnext/gh-aw-cao/blob/main/server/SECURITY.md#coolify-profile).

## Further reading

- [Deployment options](deployment.md)
- [GitHub Actions only](deployment-actions.md)
- [Azure](deployment-azure.md)
- [Data ingestion](dashboard-data-ingestion.md)
- [Data model](dashboard-data-model.md)
- [Incident response](operations.md#incident-response)
- [`server/README.md`](https://github.com/githubnext/gh-aw-cao/blob/main/server/README.md)
- [`server/SECURITY.md`](https://github.com/githubnext/gh-aw-cao/blob/main/server/SECURITY.md)
