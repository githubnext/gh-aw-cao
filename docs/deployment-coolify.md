---
title: Deploying the dashboard to Coolify
description: Run the Central Agentic Ops dashboard server as a hardened container on your own Coolify instance.
---

> [!WARNING]
> **Experimental:** The Coolify deployment is experimental and isn't certified for production use. The container image, Compose file, deployment workflow, adapter contract, and environment variables can change between releases. Before you expose the deployment to users, complete your own security, network, backup, monitoring, and rollback reviews.

## About the Coolify deployment

The Coolify deployment runs the same Go dashboard server as [the Azure deployment](deployment-azure.md), packaged as a container image that runs as a non-root user. The container starts with the `serve-hosted` command.

- The Coolify proxy is the only way into the container. It terminates public TLS.
- The container reads a verified dashboard artifact from a read-only volume and loads it into Redis.
- Users sign in with GitHub OAuth. Only active members of GitHub organizations or teams that you allow can access the dashboard.

The Coolify deployment is an alternative to the Azure deployment. It doesn't replace, change, or weaken the Azure deployment.

## Prerequisites

| Requirement | Details |
| --- | --- |
| Coolify | A self-hosted Coolify instance that can run Docker Compose resources. Its proxy must terminate TLS for a public host name that you control. |
| Container runtime | Docker on the Coolify server, with access to pull images from GitHub Container Registry (GHCR). |
| Container image | `ghcr.io/OWNER/REPOSITORY/cao-dashboard@sha256:DIGEST`, built from `server/Dockerfile`. Always refer to the image by its digest. |
| Redis | A Redis service on the Coolify private network, or an external Redis service that uses TLS. No Redis modules are required. Set the eviction policy to `noeviction`, and size memory for the number of data generations that you keep. |
| Artifact volume | A named Docker volume, managed by Coolify, that contains a complete and verified dashboard payload. |
| GitHub OAuth app | An OAuth app with the callback URL `https://PUBLIC-HOST/auth/callback`. |
| Webhook secret | A secret of at least 32 characters. The server requires one even if you don't use webhooks. |
| Deployment automation (optional) | To use `.github/workflows/coolify-deploy.yml`, you need the GitHub environments `coolify-alpha`, `coolify-beta`, and `coolify-stable`. Each needs the `COOLIFY_DEPLOY_ENDPOINT` and `COOLIFY_DEPLOY_TOKEN` secrets. You also need a deployment adapter for your Coolify resource. For more information, see [Automating delivery](#automating-delivery). |

The running container needs outbound access only to Redis and to the GitHub OAuth and API endpoints.

## Deploying the dashboard

In the following steps, replace `PUBLIC-HOST` with the public host name of your dashboard.

1. Build or choose an image.

   - **To build an image for testing,** run the following command from the root of the repository.

     ```bash
     docker build -f server/Dockerfile \
       --build-arg VERSION=0.0.0-alpha \
       --build-arg REVISION="$(git rev-parse HEAD)" \
       --build-arg CREATED="$(git show -s --format=%cI HEAD)" \
       -t cao-dashboard:test .
     ```

   - **For hosted use,** choose an image that `coolify-deploy.yml` published. Always refer to it as `NAME@sha256:DIGEST`.

1. Register a GitHub OAuth app. Set its **Authorization callback URL** to `https://PUBLIC-HOST/auth/callback`. For more information, see [Creating an OAuth app](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app) in the GitHub documentation.
1. Create a Redis service in Coolify on the same private network as the dashboard, or use an external `rediss://` endpoint.
1. Prepare the artifact volume.

   1. Create a new volume that isn't attached to any service.
   1. From a trusted `cao-dashboard.yml` artifact, copy `payload-hashes.json` and every inventory, run, and record file that it lists into the volume.
   1. Verify the hash of every file.

   > [!CAUTION]
   > Never copy files into a volume that a running service uses.

1. In Coolify, create a Docker Compose resource from `server/coolify/compose.yml`. The file doesn't publish a host port. Attach your public domain to container port `8080` through the Coolify proxy.
1. Set the variables and secrets listed in [Configuration reference](#configuration-reference). Store every credential as a Coolify secret.
1. Set `CAO_TRUSTED_PROXY_CIDRS` to the exact private subnet that Coolify assigns to its proxy network. Don't use `0.0.0.0/0` or a whole private address range. The server doesn't start if the value is missing, malformed, or public.
1. Deploy the resource. When the container starts, `serve-hosted` reads the data in `CAO_SOURCE_DIRECTORY` (`/app/source`), prepares a generation, and makes it active.
1. Verify the deployment.

   1. Confirm that `https://PUBLIC-HOST/api/readiness` returns `200`.
   1. Sign in with an authorized account and run a bounded query.
   1. Confirm that the dashboard refuses an unauthorized account.
   1. If you use webhooks, send a signed test delivery.

### Updating the data

To update the data, prepare a new volume in the same way, set `CAO_ARTIFACT_VOLUME` to the new volume, and redeploy. An administrator listed in `CAO_GITHUB_ADMIN_USERS` can also start a rebuild with `POST /api/admin/rebuild`.

### Automating delivery

The `.github/workflows/coolify-deploy.yml` workflow builds, scans, publishes, and deploys container images. Trivy scans each image, and the workflow fails on critical or high findings. Every image is identified by its digest.

| Trigger | Image | Environment |
| --- | --- | --- |
| A published `vX.Y.Z` release that isn't a prerelease | `vX.Y.Z`, built from the release commit | `coolify-stable` |
| A published SemVer prerelease | `vX.Y.Z-PRERELEASE`, built from the release commit | `coolify-beta` |
| A push to `main` that changes server or dashboard sources | `sha-COMMIT` | `coolify-alpha` |
| A manual run for `alpha`, `beta`, or `stable`, from `main` or `release` | The current `main`, or the latest eligible release for the channel | The matching environment |

The workflow refuses payloads from forks. Before it calls the adapter, it checks that the source is still current for its channel. To require approvals, use environment protection rules.

The repository doesn't include a deployment adapter. Your adapter must do the following:

1. Record the digest that is currently deployed.
1. Set `CAO_IMAGE` to the requested digest.
1. Start the Coolify deployment, then poll until it finishes.
1. Verify `/api/readiness`.
1. If any step fails, redeploy the previous digest, verify it, and then return an error.

The adapter reports success only by returning this JSON body, with the requested image and digest:

```json
{"status":"ready","image":"NAME@sha256:DIGEST","digest":"sha256:DIGEST"}
```

The workflow treats any other response as a failure, including responses that say the deployment is queued or accepted.

## Configuration reference

The `server/coolify/compose.yml` file reads the following variables.

| Variable | Required | Secret | Description |
| --- | --- | --- | --- |
| `CAO_IMAGE` | Yes | No | Image reference by digest, in the form `ghcr.io/...@sha256:DIGEST`. |
| `CAO_ARTIFACT_VOLUME` | Yes | No | Existing Coolify volume that contains the verified payload. It is mounted read-only at `/app/source`. |
| `CAO_REDIS_URL` | Yes | Yes | Redis URL. Use `rediss://` when possible. |
| `CAO_ALLOW_PRIVATE_PLAINTEXT_REDIS` | No. Defaults to `false`. | No | Set to `true` to allow `redis://` to a private IP address or a single-label service name on the private network. |
| `CAO_REDIS_NAMESPACE` | No. Defaults to `coolify-dashboard`. | No | Prefix for Redis keys. |
| `CAO_ALLOWED_HOSTS` | Yes | No | Comma-separated list of public host names. |
| `CAO_TRUSTED_PROXY_CIDRS` | Yes | No | Exact private CIDR of the Coolify proxy network. |
| `CAO_GITHUB_CLIENT_ID` | Yes | No | Client ID of the OAuth app. |
| `CAO_GITHUB_CLIENT_SECRET` | Yes | Yes | Client secret of the OAuth app. |
| `CAO_GITHUB_REDIRECT_URL` | Yes | No | `https://PUBLIC-HOST/auth/callback` |
| `CAO_SESSION_SECRET` | Yes | Yes | Session key. At least 32 characters. |
| `CAO_SESSION_SECRET_PREVIOUS` | No | Yes | Previous session key, used during rotation. |
| `CAO_GITHUB_ALLOWED_ORGS` | At least one of these two | No | Organizations whose active members can sign in. |
| `CAO_GITHUB_ALLOWED_TEAMS` | At least one of these two | No | Teams, in `ORGANIZATION/TEAM-SLUG` format, whose active members can sign in. |
| `CAO_GITHUB_ADMIN_USERS` | Yes | No | GitHub usernames that can start rebuilds. |
| `CAO_GITHUB_WEBHOOK_SECRET` | Yes | Yes | Secret for verifying webhook signatures. At least 32 characters. |
| `CAO_BUILD_VERSION` | No | No | Build version that the server reports. |

The Compose service also sets the following hardening options. Keep them in place.

- A read-only root file system (`read_only: true`).
- A 64 MiB `/tmp` mounted with `noexec`.
- All Linux capabilities dropped, and `no-new-privileges`.
- An `init` process.
- The non-root user `65532:65532`.

## Monitoring the deployment

### Container health

The image's `HEALTHCHECK` calls `/api/readiness` every 30 seconds through the trusted host path. Coolify shows the health status and restarts the service according to the `restart: unless-stopped` policy.

### OpenTelemetry traces

The server emits a span for every HTTP request through `otelhttp`, plus `cao_dashboard.query.execute` and `cao_dashboard.ingest.run` spans. Spans contain no secrets.

The checked-in `compose.yml` file doesn't pass any `OTEL_*` variables, so tracing is off by default. To turn it on, add the following variables to the service environment in your Coolify resource, and point them at an OTLP/HTTP collector that you run.

| Variable | Description |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Turns on trace export. |
| `OTEL_EXPORTER_OTLP_HEADERS` | Optional. Authentication headers for the collector. Store the value as a Coolify secret. |
| `OTEL_SERVICE_NAME` | Optional. Service name. Defaults to `cao-dashboard`. |
| `OTEL_SDK_DISABLED` | Set to `true` to turn off tracing even when an endpoint is set. |

Responses include `X-Trace-Id` and `X-Span-Id` headers, and the server continues traces from incoming `traceparent` headers.

### Logs

Container output appears in the Coolify log view. To turn on debug logs, set `DEBUG` to `cao:*`, or to a narrower pattern such as `cao:server,cao:query`. Logs never contain tokens, credentials, query payloads, or source records.

### Diagnostics

To check Redis, dashboard data, and queries without changing anything, run the following command in the container. `CAO_REDIS_URL` must be set in the container's environment.

```bash
/app/cao-dashboard doctor --redis-namespace coolify-dashboard
```

Add `--deep` to read every active source, `--format json` for automation, or `--strict` to fail on warnings.

### Delivery history

The deployment history of each `coolify-*` environment on GitHub records every digest that was deployed.

### Agentic workflow traces

You configure traces for orchestrators and workers in the control repository. For more information, see [Optional observability](configuration.md#optional-observability).

## What this deployment guarantees

- **The same protections as Azure.** `serve-hosted` applies GitHub OAuth, organization or team authorization, encrypted server-side sessions, CSRF protection, webhook signature verification and deduplication, Redis-backed rate limits that fail closed, and logs with secrets removed. It rejects PATs and the local bearer capability.
- **Trusted proxies only.** The server trusts forwarded headers only from `CAO_TRUSTED_PROXY_CIDRS`. The forwarded protocol must be `https`, and the host must exactly match `CAO_ALLOWED_HOSTS`.
- **Encrypted Redis by default.** The server refuses plaintext Redis unless you allow it for a private address or a single-label service name.
- **Immutable images.** Every deployment uses an exact, scanned image digest. Channel tags never identify a deployment, and no channel promotes another channel's image.
- **Automatic rollback.** If an adapter deployment fails, the adapter redeploys and verifies the previous digest before it reports the failure.
- **Safe ingestion.** Ingestion and rebuilds activate only complete generations. If they fail, the previous generation stays active.

## What this deployment does not guarantee

- **Platform operations.** You operate Coolify, the host, Docker, TLS certificates, and the proxy network. CAO provides no SLA and doesn't harden the host.
- **Redis operations.** You're responsible for Redis authentication, access control lists, persistence, memory sizing, and network isolation. Redis holds disposable data, and CAO doesn't back it up.
- **A deployment adapter.** The repository doesn't include a Coolify deployment adapter. You must build and secure one that meets the [contract](#automating-delivery).
- **Data freshness.** Nothing refreshes the artifact volume automatically. Data is only as fresh as the last volume that you prepared or the last rebuild. For the upstream schedule, see [CAO Activity](activity.md).
- **Live updates.** Server-sent events are best effort. If they stop, clients fall back to polling.
- **Per-repository authorization.** Authorized users can read all of the active data.
- **Secret rollback.** Rolling back an image doesn't roll back OAuth, webhook, or session secrets.

## Rolling back the deployment

Before every rollout, record the last known-good `NAME@sha256:DIGEST` from the GitHub deployment history.

1. Using the adapter for the same protected environment, set `CAO_IMAGE` to that exact digest and redeploy. Don't retag images.
1. Confirm readiness, OAuth sign-in and authorization, a bounded query, webhook signature handling, and rate limits.
1. If the new version wrote unusable data to Redis, clear only the deployment's Redis namespace. The service then loads the retained artifact again.

If you suspect an incident, see [Incident response](operations.md#incident-response). For the detailed reference, see the [Coolify container profile](https://github.com/githubnext/gh-aw-cao/blob/main/server/README.md#coolify-container-profile) in `server/README.md` and the [Coolify profile](https://github.com/githubnext/gh-aw-cao/blob/main/server/SECURITY.md#coolify-profile) in `server/SECURITY.md`.

## Further reading

- [About deployment options](deployment.md)
- [Deploying the dashboard with GitHub Actions](deployment-actions.md)
- [Deploying the dashboard to Azure](deployment-azure.md)
- [Data ingestion](dashboard-data-ingestion.md)
- [Data model](dashboard-data-model.md)
- [`server/README.md`](https://github.com/githubnext/gh-aw-cao/blob/main/server/README.md)
- [`server/SECURITY.md`](https://github.com/githubnext/gh-aw-cao/blob/main/server/SECURITY.md)
