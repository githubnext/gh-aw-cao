---
title: Deploying the dashboard to Railway
description: Run the Central Agentic Ops dashboard server on Railway, with Railway Redis, GitHub OAuth sign-in, and a payload baked into the image.
---

> [!WARNING]
> **Experimental:** The Railway deployment is experimental and isn't certified for production use. The container image, configuration file, environment variables, and procedures can change between releases. Before you expose the deployment to users, complete your own security, network, backup, monitoring, and rollback reviews.

## About the Railway deployment

The Railway deployment runs the same Go dashboard server as [the Coolify deployment](deployment-coolify.md) and [the Azure deployment](deployment-azure.md). Railway builds `server/Dockerfile` from your repository, runs the container with `serve-hosted`, terminates public TLS at its edge proxy, and connects the service to a Railway Redis database over the project's private network.

Railway can't pre-populate a volume, so the image bakes a verified dashboard payload at build time. The `CAO_DATA_URL` build argument points at a published `payload-hashes.json`; the build downloads every file the manifest lists and fails when a hash doesn't match. New data means a new build, which is exactly one immutable deployment per payload.

- Users sign in with GitHub OAuth. Only active members of the GitHub organizations or teams that you allow can read the dashboard.
- The browser never receives Redis credentials. It calls the same-origin API only.
- The server trusts forwarded headers only from the private CIDRs that you configure, and only when the forwarded protocol is `https` and the forwarded host is in `CAO_ALLOWED_HOSTS`.

## Prerequisites

| Requirement | Details |
| --- | --- |
| Railway account | A [railway.com](https://railway.com) account signed in with GitHub. A paid plan or an active trial is required to keep a service and a database running. |
| Repository access | Railway's GitHub app must be able to read the repository (or your fork) that holds `server/Dockerfile` and `railway.json`. |
| Control policy | `control-plane.web.host` in `.github/workflows/cao.json`, committed on the branch that Railway deploys. |
| Published payload | A reachable `payload-hashes.json`, such as `https://OWNER.github.io/REPOSITORY/cao/payload-hashes.json` from the `cao-dashboard.yml` workflow. |
| GitHub OAuth app | An OAuth app whose callback URL is `https://PUBLIC-HOST/auth/callback`. |
| Secrets | A session secret and a webhook secret, each at least 32 characters. |

## Configuring the repository

Both files are checked in and reviewed. Railway reads them at build time.

1. `railway.json` at the repository root selects the Dockerfile builder, `server/Dockerfile`, one replica, and restart-on-failure. It intentionally declares no `healthcheckPath`: Railway's platform health check sends `Host: healthcheck.railway.app` over plain HTTP, and the hosted server answers `421` for any host outside `CAO_ALLOWED_HOSTS`. Verify readiness through your public domain instead.
1. `control-plane.web.host` in `.github/workflows/cao.json` declares the host capabilities:

   ```json
   {
     "target": { "module": "container", "name": "railway", "replicas": 1 },
     "redis": {
       "module": "railway",
       "url-env": "REDIS_URL",
       "namespace-env": "REDIS_NAMESPACE",
       "allow-private-plaintext": true,
       "tls": { "mode": "disabled" }
     }
   }
   ```

   Plaintext is permitted only because `${{Redis.REDIS_URL}}` resolves to a `*.railway.internal` address on the project's private network. If you connect an external Redis provider instead, use its module and `tls.mode: "required"` from [Managed Redis in one minute](deployment-managed-redis.md), and never expose a Railway TCP proxy for Redis.

## Deploying on Railway

Replace `PUBLIC-HOST` with the domain that Railway generates, such as `cao-dashboard-production.up.railway.app`, or your own custom domain.

1. **Create the project.** In Railway, choose **New Project**, then **Deploy from GitHub repo**, and select the repository and branch. Railway detects `railway.json` and builds `server/Dockerfile` with the repository root as the build context.
1. **Add Redis.** In the same project, choose **Create**, then **Database**, then **Add Redis**. Keep it in the same project so the private network connects the two services. Set its eviction policy to `noeviction`, because CAO stores complete data generations rather than a cache.
1. **Point the dashboard service at Redis.** Open the dashboard service, then **Variables**, and add `REDIS_URL` with the reference value `${{Redis.REDIS_URL}}`, using the actual Redis service name. Railway resolves it to the private `redis://default:PASSWORD@redis.railway.internal:6379` URL.
1. **Register the GitHub OAuth app.** In GitHub, create an OAuth app with the homepage `https://PUBLIC-HOST` and the callback `https://PUBLIC-HOST/auth/callback`. For more information, see [Creating an OAuth app](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app).
1. **Expose the service.** Open **Settings**, then **Networking**, and choose **Generate Domain** with target port `8080`, or attach a custom domain. Add the resulting host name to `CAO_ALLOWED_HOSTS` and to the OAuth app URLs.
1. **Set the variables.** Add every variable in [Configuration reference](#configuration-reference). Railway exposes service variables to the build, so `CAO_DATA_URL` is both the build argument that bakes the payload and a service variable.
1. **Deploy and verify.** Railway rebuilds on each change. Confirm the checks in [Verifying the deployment](#verifying-the-deployment).

### Where secrets go

Store every credential as a Railway service variable in the dashboard service, or as a shared variable in the project when several services need it. Railway encrypts variable values at rest and hides them in build logs.

- Store `CAO_GITHUB_CLIENT_SECRET`, `CAO_SESSION_SECRET`, `CAO_SESSION_SECRET_PREVIOUS`, and `CAO_GITHUB_WEBHOOK_SECRET` only as Railway variables.
- Reference Redis credentials only as `${{Redis.REDIS_URL}}`. Never paste a resolved Redis URL into a variable, a commit, an issue, or chat.
- Never put a secret in `cao.json`, in `railway.json`, in a Dockerfile build argument that you commit, or in a start command.
- Generate secrets locally, for example with `openssl rand -hex 32`, and rotate them by setting `CAO_SESSION_SECRET_PREVIOUS` to the old value for one deployment before removing it.

Railway variables are not the control plane's credentials. Campaign authority, rollout mode, and target repositories stay in the reviewed control policy and in Actions secrets.

### Setting the trusted proxy CIDR

`CAO_TRUSTED_PROXY_CIDRS` must list the private CIDR that Railway's edge proxy uses when it connects to your container. Railway routes that traffic over the project's private IPv6 network, so start with the unique local address range:

```text
CAO_TRUSTED_PROXY_CIDRS=fd00::/8
```

The server accepts only private prefixes and rejects public ones, so a wrong value fails closed with `421 Misdirected Request` rather than trusting an untrusted peer. To diagnose a rejection, set `DEBUG=cao:server` on the service and read the fixed branch identifier in the logs:

| Log identifier | Meaning |
| --- | --- |
| `access.proxy_rejected.peer_untrusted` | The forwarding peer isn't inside `CAO_TRUSTED_PROXY_CIDRS`. |
| `access.proxy_rejected.host_not_allowed` | The forwarded host isn't in `CAO_ALLOWED_HOSTS`. This is expected for Railway's platform health check. |
| `access.proxy_rejected.scheme_not_https` | The forwarded protocol wasn't `https`. |

These identifiers never contain addresses, hosts, users, or credentials. Narrow the CIDR to the smallest prefix that keeps the deployment working.

### Updating the data

The payload is immutable inside the image, so refresh data with a new build.

1. Wait for the control repository's `cao-dashboard.yml` workflow to publish a new payload.
1. Redeploy the Railway service. The build downloads and verifies the current payload again, and ingestion activates the new generation only when it is complete.

An administrator listed in `CAO_GITHUB_ADMIN_USERS` can also `POST /api/admin/rebuild`, which re-reads the payload baked into the running image. It doesn't fetch newer data.

## Configuration reference

| Variable | Required | Secret | Description |
| --- | --- | --- | --- |
| `CAO_DATA_URL` | Yes | No | Published `payload-hashes.json` URL that the build downloads and verifies. |
| `REDIS_URL` | Yes | Yes | `${{Redis.REDIS_URL}}` reference to the Railway Redis service. |
| `REDIS_NAMESPACE` | No. Defaults to `hosted-dashboard`. | No | Stable key prefix for this deployment. |
| `CAO_ALLOWED_HOSTS` | Yes | No | Comma-separated public host names, such as `PUBLIC-HOST`. |
| `CAO_TRUSTED_PROXY_CIDRS` | Yes | No | Private CIDR of Railway's forwarding proxy. |
| `CAO_GITHUB_CLIENT_ID` | Yes | No | OAuth app client ID. |
| `CAO_GITHUB_CLIENT_SECRET` | Yes | Yes | OAuth app client secret. |
| `CAO_GITHUB_REDIRECT_URL` | Yes | No | `https://PUBLIC-HOST/auth/callback` |
| `CAO_SESSION_SECRET` | Yes | Yes | Session encryption key of at least 32 characters. |
| `CAO_SESSION_SECRET_PREVIOUS` | No | Yes | Previous session key, kept only during rotation. |
| `CAO_GITHUB_ALLOWED_ORGS` | At least one of these two | No | Organizations whose active members can sign in. |
| `CAO_GITHUB_ALLOWED_TEAMS` | At least one of these two | No | Teams in `ORGANIZATION/TEAM-SLUG` form whose active members can sign in. |
| `CAO_GITHUB_ADMIN_USERS` | Yes | No | GitHub logins allowed to trigger a rebuild. |
| `CAO_GITHUB_WEBHOOK_SECRET` | Yes | Yes | Webhook signature secret of at least 32 characters. |
| `CAO_SOURCE_DIRECTORY` | Set by the image to `/app/source`. | No | Directory that holds the verified payload. |
| `DEBUG` | No | No | Debug namespaces, such as `cao:server` or `cao:*`. |

## Verifying the deployment

1. Open `https://PUBLIC-HOST/api/readiness` and confirm `200` with `"ready": true` and `"available": true`.
1. Sign in with an authorized account and run a query from a dashboard page.
1. Confirm that an account outside the allowed organizations or teams is refused.
1. Confirm that `curl -sS https://PUBLIC-HOST/api/readiness -H 'Host: other.example'` is refused with `421`.
1. If you use webhooks, send a signed test delivery.

## Rolling back

Railway keeps previous deployments. To roll back, open the service's **Deployments** tab and redeploy the last known-good build, which restores both the server version and the payload that was baked into it. Rolling back doesn't roll back OAuth, session, or webhook secrets; rotate those separately. If a deployment wrote unusable data, clear only this deployment's Redis namespace and redeploy, which loads the baked payload again.

For incidents, see [Incident response](operations.md#incident-response).

## What this deployment guarantees

- **The same protections as Azure and Coolify.** `serve-hosted` applies GitHub OAuth, organization or team authorization, encrypted server-side sessions, CSRF protection, webhook signature verification, Redis-backed rate limits that fail closed, and logs with secrets removed. It rejects PATs and the local bearer capability.
- **Verified payloads.** The build verifies every payload file against `payload-hashes.json`, and ingestion activates only complete generations.
- **Trusted proxies only.** Forwarded headers are honored only from the private CIDRs that you list, with `https` and an allowed host.
- **One replica.** The policy and `railway.json` both pin a single replica, which matches the ingestion and session model.

## What this deployment does not guarantee

- **Platform operations.** You operate the Railway project, its plan, its domains, its Redis database, and its backups. CAO provides no SLA.
- **Data freshness.** Data is only as fresh as the payload baked into the current build. Nothing refreshes it automatically.
- **Server-side collection.** This profile ingests published snapshots. It doesn't run the collection profile.
- **Per-repository authorization.** Every authorized user can read all of the active data.

## Further reading

- [About deployment options](deployment.md)
- [Deploying the dashboard to Coolify](deployment-coolify.md)
- [Deploying the dashboard to Azure](deployment-azure.md)
- [Managed Redis in one minute](deployment-managed-redis.md)
- [`server/README.md`](https://github.com/githubnext/gh-aw-cao/blob/main/server/README.md)
- [`server/SECURITY.md`](https://github.com/githubnext/gh-aw-cao/blob/main/server/SECURITY.md)
