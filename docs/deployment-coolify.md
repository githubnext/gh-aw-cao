---
title: Deploying the dashboard to Coolify
description: Run the Central Agentic Ops dashboard server as a hardened container on your own Coolify instance.
---

> [!WARNING]
> **Experimental:** The Coolify deployment is experimental and isn't certified for production use. The Dockerfile, Compose file, source-build contract, and environment variables can change between releases. Before you expose the deployment to users, complete your own security, network, backup, monitoring, and rollback reviews.

## About the Coolify deployment

The Coolify deployment runs the same Go dashboard server as [the Azure deployment](deployment-azure.md), packaged as a container image that runs as a non-root user. The container starts with the `serve-hosted` command.

- The Coolify proxy is the only way into the container. It terminates public TLS.
- The container reads a verified dashboard artifact from a read-only volume, stores dashboard rows in PostgreSQL, and uses Redis for operational state.
- Users sign in with GitHub OAuth. Only active members of GitHub organizations or teams that you allow can access the dashboard.

The Coolify deployment is an alternative to the Azure deployment. It doesn't replace, change, or weaken the Azure deployment.

## Prerequisites

| Requirement | Details |
| --- | --- |
| Coolify | A self-hosted Coolify instance that can run Docker Compose resources. Its proxy must terminate TLS for a public host name that you control. |
| Container runtime | Docker on the Coolify server, with enough CPU, memory, and disk to build and run the image. |
| Source access | A Coolify GitHub App with read access to this repository and webhook delivery enabled. |
| PostgreSQL | A PostgreSQL service on the Coolify private network. CAO stores dashboard rows there. |
| Redis | A Redis service on the Coolify private network, or an external Redis service that uses TLS, such as [Upstash Redis](deployment-upstash.md). No Redis modules are required. Set the eviction policy to `noeviction`, and size memory for operational caches, queues, sessions, and rate limits. |
| Artifact volume | A named Docker volume, managed by Coolify, that contains a complete and verified dashboard payload. |
| GitHub OAuth app | An OAuth app with the callback URL `https://PUBLIC-HOST/auth/callback`. |
| Webhook secret | A secret of at least 32 characters. The server requires one even if you don't use webhooks. |
| Deployment automation | A Git-backed Coolify resource configured for automatic deployments from the protected `main` branch. |

The running container needs outbound access only to PostgreSQL, Redis, and the GitHub OAuth and API endpoints.

## Deploying the dashboard

In the following steps, replace `PUBLIC-HOST` with the public host name of your dashboard.

1. Create a Docker Compose resource from this repository through the Coolify GitHub App. Select the protected `main` branch, set the Compose location to `server/coolify/compose.yml`, enable automatic deployments, and disable previews unless you provision isolated preview credentials and data.
1. In the resource's advanced settings, enable **Include Source Commit in Build**. Coolify then provides `SOURCE_COMMIT`, which the Compose build embeds in the image labels and exposes as the server build version.
1. In the same advanced settings, enable **Connect To Predefined Network**. The
   Docker Compose application otherwise remains on its resource-specific
   network and cannot reach separately managed Coolify PostgreSQL and Redis
   resources. Put all three resources on the same server and destination.

1. Register a GitHub OAuth app. Set its **Authorization callback URL** to `https://PUBLIC-HOST/auth/callback`. For more information, see [Creating an OAuth app](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app) in the GitHub documentation.
1. Create a PostgreSQL service in Coolify on the same destination as the dashboard. Copy its generated Internal URL and store it as the dashboard resource's secret `CAO_POSTGRES_URL`. The database resource name, such as `cao-postgres`, is only a display label and must not be substituted for the container hostname in the generated URL.
1. Create a Redis service in Coolify on the same destination as the dashboard, copy its generated Internal URL into `REDIS_URL`, or use an external `rediss://` endpoint. The Redis display name, such as `cao-redis`, is not a stable cross-resource DNS contract. To use Upstash, follow [Deploying the dashboard with Upstash Redis](deployment-upstash.md), select the `upstash` Redis module with `target.replicas: 1`, and keep the Coolify resource at exactly one replica.
1. Review `.github/workflows/cao.coolify.json`. This CAO deployment profile
   extends the authoritative `cao.json` rollout policy with only the
   `control-plane.web.host` settings required by Coolify. The Compose file
   bakes both files into the image and startup fails when the composed profile
   is missing or invalid. For an external Redis service, change only the profile's Redis
   provider module as described in
   [Managed Redis in one minute](deployment-managed-redis.md); don't copy host
   settings into `cao.json`.
1. Prepare the artifact volume.

   1. Create a new volume that isn't attached to any service.
   1. From one trusted `cao-dashboard.yml` artifact, copy
      `payload-hashes.json`, `inventory-sources.json`, and every payload file
      named by the manifest into the volume. Do not combine files from
      different publication generations.
   1. Verify every hash declared by `payload-hashes.json`. If downloading from
      a mutable published URL, also confirm that both `payload-hashes.json` and
      `inventory-sources.json` remained unchanged from the start through the
      end of the download.
   1. Make every directory traversable and every file readable by the
      container's non-root UID `65532`.

   > [!CAUTION]
   > Never copy files into a volume that a running service uses.

1. Attach your public domain to container port `8080` through the Coolify proxy. The Compose file doesn't publish a host port.
1. Set the variables and secrets listed in [Configuration reference](#configuration-reference), following [Setting the variables in Coolify](#setting-the-variables-in-coolify). Store every credential as a Coolify secret.
1. Set `CAO_TRUSTED_PROXY_CIDRS` to the exact private subnet that Coolify assigns to its proxy network. Don't use `0.0.0.0/0` or a whole private address range. The server doesn't start if the value is missing, malformed, or public.
1. Deploy the resource. When the container starts, `serve-hosted` reads the data in `CAO_SOURCE_DIRECTORY` (`/app/source`) and transactionally replaces the current dashboard rows in PostgreSQL.
1. Verify the deployment.

   1. Confirm that `https://PUBLIC-HOST/api/readiness` returns `200`.
   1. Sign in with an authorized account and run a bounded query.
   1. Confirm that the dashboard refuses an unauthorized account.
   1. If you use webhooks, send a signed test delivery.

### Deploying the githubnext production application

For the production deployment of the `githubnext/gh-aw-cao` dashboard:

1. Create a Git-backed Docker Compose application in Coolify from this repository.
   Keep the repository root as the working directory and set the Compose location
   to `server/coolify/compose.yml`.
1. Enable **Include Source Commit in Build** so `SOURCE_COMMIT` identifies the
   exact checkout in image labels and `/api/version`.
1. Enable **Connect To Predefined Network**, and place the application,
   PostgreSQL, and Redis resources on the same Coolify server and destination.
1. Enable automatic deployments for `main`. Keep preview deployments disabled
   for the production resource.
1. Configure the runtime values from
   `server/coolify/.env.example`. Do not add `CAO_IMAGE`, registry credentials,
   Coolify API credentials, or GitHub deployment-environment secrets.
1. Deploy once from the Coolify UI, then verify readiness, authentication,
   authorization, a bounded query, and webhook validation.

The Dockerfile bakes `cao.json` and `cao.coolify.json` into the image, so
**Preserve Repository During Deployment** is not required. On later pushes, the
GitHub App webhook tells Coolify to fetch the new `main` commit, build the
Compose service, and deploy it. Coolify owns build logs, deployment history,
health evaluation, and rollback.

### Updating the data

To update the data, prepare a new volume in the same way, set `CAO_ARTIFACT_VOLUME` to the new volume, and redeploy. An administrator listed in `CAO_GITHUB_ADMIN_USERS` can also start a rebuild with `POST /api/admin/rebuild`.

### Automating delivery

The Coolify GitHub App webhook is the deployment trigger. Configure the resource
for automatic deployments from the protected `main` branch. Coolify checks out
the source commit, evaluates `server/coolify/compose.yml`, builds
`server/Dockerfile`, and replaces the running service after the container passes
its health check.

The Compose service enables the read-only `/mcp` endpoint alongside the dashboard.
The `Hosted MCP integration` workflow verifies the deployed endpoint against
`https://cao.githubnext.com/mcp` after changes to the repository's default
branch and on manual dispatch from that branch.
It uses a GitHub Actions token with read access to Actions, contents, issues,
and pull requests plus a short-lived Actions OIDC token with audience
`https://cao.githubnext.com`. It lists tools, inspects the catalog, and runs a
named query. A successful push can precede Coolify's asynchronous deployment;
the workflow retries while waiting for the new server to become available.

The deployment-neutral `.github/workflows/cao-package.yml` workflow continues
to test, scan, attest, and publish the official
`ghcr.io/githubnext/gh-aw-cao/cao-server` package. That package is useful for
releases and other consumers, but it is not an input or admission gate for this
Coolify source deployment. No GitHub deployment Action, `COOLIFY_API_TOKEN`,
public Coolify API, Tailscale credentials, or mutable image tag is required.

If branch protection, GitHub App access, the checkout, the build, required
runtime variables, or container health fails, Coolify must leave the failed
deployment inactive. Review Coolify's build and deployment logs before retrying.

## Configuration reference

The `server/coolify/compose.yml` file reads the following variables.

| Variable | Required | Secret | Description |
| --- | --- | --- | --- |
| `CAO_ARTIFACT_VOLUME` | Yes | No | Existing Coolify volume that contains the verified payload. It is mounted read-only at `/app/source`. |
| `CAO_POSTGRES_URL` | Yes | Yes | Internal PostgreSQL connection URL copied from the Coolify database resource. |
| `REDIS_URL` | Yes | Yes | Redis URL selected by `control-plane.web.host.redis.url-env`. Use `rediss://` when possible. |
| `REDIS_NAMESPACE` | No. Defaults to `coolify-dashboard`. | No | Prefix selected by `control-plane.web.host.redis.namespace-env`. |
| `CAO_POLICY_PATH` | Set by Compose. | No | Points at the baked-in `cao.coolify.json` deployment profile, which extends `cao.json`. |
| `CAO_ALLOWED_HOSTS` | Yes | No | Comma-separated list of public host names. |
| `CAO_TRUSTED_PROXY_CIDRS` | Yes | No | Exact private CIDR of the Coolify proxy network. |
| `CAO_GITHUB_CLIENT_ID` | Yes | No | Client ID of the OAuth app. |
| `CAO_GITHUB_CLIENT_SECRET_ROTATED` | Yes | Yes | Client secret of the OAuth app. Compose maps it to the server's `CAO_GITHUB_CLIENT_SECRET` runtime variable. |
| `CAO_GITHUB_REDIRECT_URL` | Yes | No | `https://PUBLIC-HOST/auth/callback` |
| `CAO_SESSION_SECRET_ROTATED` | Yes | Yes | Session key. At least 32 characters. Compose maps it to the server's `CAO_SESSION_SECRET` runtime variable. |
| `CAO_SESSION_SECRET_PREVIOUS` | No | Yes | Previous session key, used during rotation. |
| `CAO_GITHUB_ALLOWED_ORGS` | At least one of these two | No | Organizations whose active members can sign in. |
| `CAO_GITHUB_ALLOWED_TEAMS` | At least one of these two | No | Teams, in `ORGANIZATION/TEAM-SLUG` format, whose active members can sign in. |
| `CAO_GITHUB_ADMIN_USERS` | Yes | No | GitHub usernames that can start rebuilds. |
| `CAO_GITHUB_WEBHOOK_SECRET_ROTATED` | Yes | Yes | Secret for verifying webhook signatures. At least 32 characters. Compose maps it to the server's `CAO_GITHUB_WEBHOOK_SECRET` runtime variable. |
| `CAO_MCP_ACTIONS_REPOSITORY` | Yes | No | Exact `OWNER/REPO` GitHub repository selected as this Coolify resource's Git source; only its Actions OIDC provenance and read-scoped token can access `/mcp`. |
| `SOURCE_COMMIT` | Set by Coolify. | No | Commit SHA embedded in the image and reported as the build version. Enable **Include Source Commit in Build**. |
| `DEBUG` | No. Defaults to `cao:server*,cao:query,cao:ingest,cao:telemetry`. | No | Server log categories written to container output. |
| `CAO_SERVER_LOGS_ENABLED` | No. Defaults to `true` in Coolify. | No | Mounts `GET /api/admin/logs`, a JSON download of up to 10,000 recent server debug records plus Redis ingestion counters and collection queue counts. Set to `false` to disable. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | No | Shared base OTLP/HTTP endpoint. The exporter appends the signal path. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | No | No | Full OTLP/HTTP trace endpoint. Use this to reuse the control plane's `GH_AW_DEFAULT_OTLP_ENDPOINT`. |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | No | No | Full OTLP/HTTP metrics endpoint. |
| `OTEL_EXPORTER_OTLP_HEADERS` | No | Yes | Shared OTLP authentication headers. |
| `OTEL_EXPORTER_OTLP_TRACES_HEADERS` | No | Yes | Trace-specific OTLP authentication headers. |
| `OTEL_EXPORTER_OTLP_METRICS_HEADERS` | No | Yes | Metrics-specific OTLP authentication headers. |
| `OTEL_SERVICE_NAME` | No. Defaults to `cao-dashboard`. | No | Stable service name used by the observability backend. |
| `OTEL_RESOURCE_ATTRIBUTES` | No. Defaults to `deployment.environment.name=production`. | No | Reviewed, non-sensitive deployment attributes. |
| `OTEL_SDK_DISABLED` | No. Defaults to `false`. | No | Set to `true` to disable telemetry export. |

### Setting the variables in Coolify

Coolify marks a variable **Required** when `compose.yml` declares it with the `${NAME:?...}` form. A deployment fails before the container starts if any of those values are missing, so set all of them before the first deploy.

Set these required variables:

- `CAO_ARTIFACT_VOLUME`
- `CAO_POSTGRES_URL`
- `CAO_ALLOWED_HOSTS`
- `CAO_TRUSTED_PROXY_CIDRS`
- `CAO_GITHUB_CLIENT_ID`
- `CAO_GITHUB_CLIENT_SECRET_ROTATED`
- `CAO_GITHUB_REDIRECT_URL`
- `CAO_SESSION_SECRET_ROTATED`
- `CAO_GITHUB_ADMIN_USERS`
- `CAO_GITHUB_WEBHOOK_SECRET_ROTATED`
- `CAO_MCP_ACTIONS_REPOSITORY`

Also set `REDIS_URL`, `CAO_GITHUB_CLIENT_SECRET_ROTATED`,
`CAO_SESSION_SECRET_ROTATED`, `CAO_GITHUB_WEBHOOK_SECRET_ROTATED`, and at least
one of `CAO_GITHUB_ALLOWED_ORGS` or `CAO_GITHUB_ALLOWED_TEAMS`. Compose leaves
these runtime secrets empty during the image-build phase so Coolify does not
expose them as Docker build arguments. The server fails closed at startup when
any required runtime value is absent.

Set `CAO_MCP_ACTIONS_REPOSITORY` to the repository configured in this Coolify resource's Git source, including its owner. Coolify does not expose that repository identity as a documented Compose variable, so the setting is required rather than falling back to the catalog's repository or reading potentially credential-bearing Git metadata into the build.

Follow these rules when you add the values.

- **Store credentials as Coolify secrets.** `CAO_POSTGRES_URL`, `REDIS_URL`, `CAO_GITHUB_CLIENT_SECRET_ROTATED`, `CAO_SESSION_SECRET_ROTATED`, `CAO_SESSION_SECRET_PREVIOUS`, `CAO_GITHUB_WEBHOOK_SECRET_ROTATED`, and every `OTEL_EXPORTER_OTLP_*_HEADERS` value are credentials. Never commit them to the repository, paste them into `.env.example`, or echo them in a build or deployment log.
- **Generate the two server-side secrets yourself.** `CAO_SESSION_SECRET_ROTATED` and `CAO_GITHUB_WEBHOOK_SECRET_ROTATED` must each be at least 32 characters. Generate each one separately, and don't reuse one value for both.

  ```bash
  openssl rand -hex 32
  ```

  Use the same `CAO_GITHUB_WEBHOOK_SECRET_ROTATED` value in the GitHub webhook configuration. A webhook secret is required even when you don't send webhooks.
- **Take the OAuth values from your OAuth app.** `CAO_GITHUB_CLIENT_ID` and `CAO_GITHUB_CLIENT_SECRET_ROTATED` come from the GitHub OAuth app that you registered, and `CAO_GITHUB_REDIRECT_URL` must exactly match that app's **Authorization callback URL**, `https://PUBLIC-HOST/auth/callback`.
- **Enable Runtime.** The server reads every operator-provided variable at startup, so each one needs the **Runtime** scope. Coolify injects `SOURCE_COMMIT` into the build when **Include Source Commit in Build** is enabled.
- **Leave managed variables alone.** Coolify shows `CAO_SOURCE_DIRECTORY` as **Managed**, because `compose.yml` pins it to `/app/source`, the read-only mount of the artifact volume. Don't override it. `CAO_POLICY_PATH` is set the same way.
- **Duplicate the values for Preview if you use preview deployments.** Coolify keeps **Production** and **Preview** values separate, so a preview deployment fails on the same required variables until you set them again for **Preview**. Give each preview its own `REDIS_NAMESPACE`, artifact volume, host name, OAuth app, and secrets. Sharing a namespace or session secret with production lets a preview build read and write production sessions and data. If you don't use preview deployments, turn them off instead of copying production credentials.

After a value changes, redeploy the resource. The container reads its environment only at startup.

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

The checked-in `compose.yml` passes standard `OTEL_*` variables from the
Coolify resource into the container. Export remains off until an endpoint is
configured.

To reuse the same collector as the control plane, copy
`GH_AW_DEFAULT_OTLP_ENDPOINT` into `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` and
copy `GH_AW_DEFAULT_OTLP_HEADERS` into
`OTEL_EXPORTER_OTLP_TRACES_HEADERS`. The trace endpoint is a complete
`/v1/traces` URL. Configure the corresponding `/v1/metrics` URL separately
when the backend accepts metrics.

Responses include `X-Trace-Id` and `X-Span-Id` headers, and the server
continues traces from incoming `traceparent` headers. JSON failures repeat
those values as `traceId` and `spanId`. The dashboard displays the trace ID as
the request ID on a failed page, so an operator or agent can retrieve the
matching telemetry without receiving internal error details.

#### Minimal Coolify backend with OpenObserve

If the control plane doesn't already export to an OTLP backend, deploy the
one-click **OpenObserve** resource in Coolify. The template runs one
single-node service, persists `/data`, and doesn't require another database.

1. Create an OpenObserve service on the same Coolify server and destination as
   the CAO application. Enable **Connect To Predefined Network** for both
   resources.
1. Before the first deployment, set `ZO_ROOT_USER_EMAIL` and retain the
   generated `SERVICE_PASSWORD_OPENOBSERVE` value as a secret.
1. Keep the OpenObserve UI restricted to administrators. Do not expose its
   ingestion endpoint publicly when the CAO application can reach it through
   the predefined network.
1. In OpenObserve, open **Data Sources**, select OTLP traces, and copy the
   generated HTTP endpoint and `Authorization` header. The trace endpoint
   includes the organization path, for example
   `/api/default/v1/traces`; preserve that complete path.
1. Set the CAO application's `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` to the full
   internal endpoint, using the OpenObserve service's Coolify network name and
   port `5080` in place of its public origin. Store the copied header as a
   Coolify secret in `OTEL_EXPORTER_OTLP_TRACES_HEADERS`, using the
   OpenTelemetry environment format `Authorization=Basic ...`.
1. To send workflow traces to the same OpenObserve instance, expose a
   separately reviewed HTTPS ingestion route that GitHub-hosted runners can
   reach. Set that full trace endpoint as `GH_AW_DEFAULT_OTLP_ENDPOINT` and the
   same OpenTelemetry-formatted header as the
   `GH_AW_DEFAULT_OTLP_HEADERS` Actions secret. Do not put OpenObserve's
   private Coolify network address in the control repository; omit these
   workflow settings when no secure runner-reachable route exists.
1. Redeploy CAO, make one authenticated request, and confirm that the returned
   request ID finds the `cao-dashboard` trace in OpenObserve.

OpenObserve is optional infrastructure, not dashboard authority. It receives
telemetry only; PostgreSQL remains the dashboard entity store and Redis remains
operational state.

### Logs

Container output appears in the Coolify log view and is available through
Coolify's log API, CLI, and MCP tooling. The default `DEBUG` value enables the
server, query, ingestion, and telemetry categories. Every JSON HTTP failure
emits its status and matching trace and span IDs, allowing an agent to search
recent Coolify logs and then open the full request trace in the OTLP backend.
Logs never contain tokens, credentials, query payloads, source records, OTLP
endpoints, or exporter headers.

### Diagnostics

To check Redis, dashboard data, and queries without changing anything, run the following command in the container. `REDIS_URL` must be set in the container's environment.

```bash
/app/cao-dashboard doctor --redis-namespace coolify-dashboard
```

Add `--deep` to read every active source, `--format json` for automation, or `--strict` to fail on warnings.

To verify the complete CAO-to-OpenObserve path, run the smoke test inside the
live CAO container after a deployment:

```bash
/app/cao-dashboard otel-smoke
```

The command requests local readiness, checks the internal OpenObserve health
endpoint, and polls OpenObserve for the resulting trace. It exits non-zero
unless every stage succeeds. Its JSON output contains only HTTP status codes
and booleans; it never reports endpoints, authorization headers, trace IDs, or
span IDs. Pass `--trace-stream NAME` only when OpenObserve stores CAO traces
outside the default `default` stream.

### Delivery history

Coolify records each source commit, build, deployment status, and retained deployment in the resource's deployment history.

### Agentic workflow traces

You configure traces for orchestrators and workers in the control repository. For more information, see [Optional observability](configuration.md#optional-observability).

## What this deployment guarantees

- **The same protections as Azure.** `serve-hosted` applies GitHub OAuth, organization or team authorization, encrypted server-side sessions, CSRF protection, webhook signature verification and deduplication, Redis-backed rate limits that fail closed, and logs with secrets removed. It rejects PATs and the local bearer capability.
- **Trusted proxies only.** The server trusts forwarded headers only from `CAO_TRUSTED_PROXY_CIDRS`. The forwarded protocol must be `https`, and the host must exactly match `CAO_ALLOWED_HOSTS`.
- **Encrypted Redis by default.** The server refuses plaintext Redis unless you allow it for a private address or a single-label service name.
- **Source-bound builds.** Coolify fetches the configured `main` commit and embeds `SOURCE_COMMIT` into the image metadata. Mutable registry tags don't select production code.
- **Native deployment history.** Coolify retains deployment records and supports rollback to a prior deployment or source revision.
- **Safe ingestion.** Ingestion and rebuilds replace dashboard rows in a PostgreSQL transaction. If they fail, the previously committed rows remain available.

## What this deployment does not guarantee

- **Platform operations.** You operate Coolify, the host, Docker, TLS certificates, and the proxy network. CAO provides no SLA and doesn't harden the host.
- **Package admission.** The source-built production image does not pass through the GHCR package workflow's Trivy, Grype, Dockle, SBOM, or artifact-attestation admission gates. Those checks still run for published packages.
- **Automatic verified rollback.** Coolify, rather than a repository-owned API client, controls rollback. Operators must verify readiness after restoring a prior deployment.
- **Redis operations.** You're responsible for Redis authentication, access control lists, persistence, memory sizing, and network isolation. Redis holds operational caches and security state, not dashboard entities.
- **Data freshness.** Nothing refreshes the artifact volume automatically. Data is only as fresh as the last volume that you prepared or the last rebuild. For the upstream schedule, see [CAO Activity](activity.md).
- **Live updates.** Server-sent events are best effort. If they stop, clients fall back to polling.
- **Per-repository authorization.** Authorized users can read all of the active data.
- **Secret rollback.** Rolling back an image doesn't roll back OAuth, webhook, or session secrets.

## Rolling back the deployment

Use the Coolify resource's deployment history to select the last known-good deployment. Alternatively, revert the responsible commit on `main` and let automatic deployment rebuild the reverted source.

1. In Coolify, redeploy the selected prior deployment or source revision.
1. Confirm readiness, OAuth sign-in and authorization, a bounded query, webhook signature handling, and rate limits.
1. If the new version wrote unusable dashboard data to PostgreSQL, rebuild it from the retained artifact. Clear the Redis namespace only when intentionally invalidating operational caches and active sessions.

If you suspect an incident, see [Incident response](operations.md#incident-response). For the detailed reference, see the [Coolify container profile](https://github.com/githubnext/gh-aw-cao/blob/main/server/README.md#coolify-container-profile) in `server/README.md` and the [Coolify profile](https://github.com/githubnext/gh-aw-cao/blob/main/server/SECURITY.md#coolify-profile) in `server/SECURITY.md`.

## Further reading

- [About deployment options](deployment.md)
- [Deploying the dashboard with GitHub Actions](deployment-actions.md)
- [Deploying the dashboard to Azure](deployment-azure.md)
- [Deploying the dashboard with Upstash Redis](deployment-upstash.md)
- [Data ingestion](dashboard-data-ingestion.md)
- [Data model](dashboard-data-model.md)
- [`server/README.md`](https://github.com/githubnext/gh-aw-cao/blob/main/server/README.md)
- [`server/SECURITY.md`](https://github.com/githubnext/gh-aw-cao/blob/main/server/SECURITY.md)
