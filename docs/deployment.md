---
title: About deployment options
description: Compare the ways you can host the Central Agentic Ops dashboard, and choose the option that fits your data, audience, and infrastructure.
---

> [!WARNING]
> **Experimental:** All deployment options are experimental. Interfaces, configuration names, infrastructure templates, and procedures can change between releases without a migration path. No option is certified for production use. Before you expose a deployment to real users or data, complete your own security, compliance, privacy, network, monitoring, incident-response, and rollback reviews.

## About deployment options

The [control plane and dashboard](architecture.md#control-plane-and-dashboard)
are deployed separately. The control plane runs in GitHub Actions; this guide
compares where to serve the dashboard and run its queries. For the evidence
flow before choosing infrastructure, read [How does CAO work?](how-cao-works.md).

Choosing a deployment option never changes campaign policy, rollout mode, credentials, or target authority. Those settings stay in the reviewed `.github/workflows/cao.json` file in your control repository. For more information, see [Control policy](configuration.md#control-policy) and [Roll out a campaign](rollout-and-routing.md).

## Comparing the options

The table below compares the deployment options. The GitHub Actions only option has two credential profiles, so it appears twice. Server-backed deployments use PostgreSQL for dashboard entities, queries, and operational state by default. Azure still pairs PostgreSQL with Azure Managed Redis for operational caches and security state; Redis remains available elsewhere as an explicit legacy selection, including through a compatible external provider such as Upstash.

| Option | Dashboard host | Where queries run | Who can sign in | Infrastructure you operate |
| --- | --- | --- | --- | --- |
| [GitHub Actions only with GitHub Apps](deployment-actions-github-app.md) | GitHub Pages | In each viewer's browser | Anyone who can read the Pages site | Two private GitHub Apps |
| [GitHub Actions only with a fine-grained PAT](deployment-actions-pat.md) | GitHub Pages | In each viewer's browser | Anyone who can read the Pages site | Two fine-grained personal access tokens (PATs) owned by one user |
| [Azure](deployment-azure.md) | Azure Functions | On the server, over PostgreSQL | Members of allowed GitHub organizations or teams | Function App, PostgreSQL, Key Vault, Azure Managed Redis, storage account, and Application Insights |

## Choosing an option

1. **Start with GitHub Actions only.** It needs no infrastructure beyond your
   control repository and is what the supported CAO installer configures by
   default. If you don't have a control repository yet, follow
   [Set Up CAO](setup-quickstarts.md) first.
1. **Choose a credential profile.** To try CAO with the least setup, use a fine-grained PAT. For production, use GitHub Apps. For more information, see [Choosing a credential profile](deployment-actions.md#choosing-a-credential-profile).
1. **Move to a server-backed option only when you need to.** Choose Azure when your data is too large to query in a browser, when you need per-user sign-in instead of Pages visibility, or when you need webhook-driven refresh.

Azure runs the host-neutral Go service from the `server/` directory, with authentication, authorization, cross-site request forgery (CSRF), webhook, rate-limit, and logging protections. You can also deploy that service on your own container platform; you are responsible for secret management, ingress, and delivery.

**Server-backed means the Go server serves the dashboard itself.** Built HTML
and assets, GitHub sign-in, query APIs, and revision events use the same hosted
origin. Forward the entire application to the Go handler, not just API paths.
Do not publish a separate Pages or static-hosted frontend for hosted mode.
The browser uses server-side PostgreSQL queries; a hosted failure does not
switch to browser storage or the Pages deployment.

Use the [one-minute managed Redis guide](deployment-managed-redis.md) to connect
AWS ElastiCache, Redis Cloud, GCP Memorystore, Railway, Render, or DigitalOcean.
The same provider-neutral `cao.json` host contract also defines the local Redis,
Azure, and Upstash examples.

### Using Upstash Redis

[Upstash Redis](deployment-upstash.md) is a managed Redis option for the host-neutral Go server. Upstash doesn't host the CAO application. Run the container on your application platform, provide its verified artifact there, and configure the server to use the Upstash TLS Redis endpoint.

> [!NOTE]
> Your credential profile still matters for server-backed deployments. The CAO Activity workflow collects their evidence in GitHub Actions, using the profile that you configure. Dashboard users sign in separately, through a GitHub OAuth app. The optional Azure collection profile requires a GitHub App and doesn't support PATs.

## About the shared data flow

Every option serves data derived from the same evidence.

1. The `cao-activity.yml` workflow collects bounded `gh aw logs` evidence on a schedule.
1. The `cao-dashboard.yml` workflow builds the dashboard site and a data payload. The payload includes a hash manifest (`payload-hashes.json`), an inventory (`inventory-sources.json`), and run and record files (`gh-aw-logs-runs/*.jsonl` and `gh-aw-logs-records/*.jsonl`).
1. The selected deployment consumes the payload. In static mode, GitHub Pages serves the UI and data to the browser. In hosted mode, the Go server serves the UI, verifies and transactionally loads the payload into PostgreSQL, and answers bounded same-origin queries. The payload is server ingestion input, not a separately hosted frontend. Operational caches and state live in PostgreSQL by default, or in Redis when a deployment explicitly selects that legacy backend.

The optional Azure collection profile replaces the first step with server-side collection workers that GitHub App webhooks drive. For more information, see [Using the optional collection profile](deployment-azure.md#using-the-optional-collection-profile).

For collection boundaries, retention, and browser processing, see [Data ingestion](dashboard-data-ingestion.md). For entities and identities, see [Data model](dashboard-data-model.md).

## What every option guarantees

- **Read-only access.** The dashboard can't start work, approve outputs, change policy, or write to target repositories. For more information, see [Know the boundary](dashboard.md#know-the-boundary) and [Execution and safety](execution-and-safety.md).
- **Disposable data.** Browser storage (IndexedDB) and hosted PostgreSQL hold rebuildable dashboard projections. PostgreSQL or, where explicitly selected, Redis holds rebuildable operational caches and state. None is the authoritative Activity evidence source.
- **Verified payloads.** Each payload file is checked against `payload-hashes.json` before it is parsed. A missing manifest, a hash mismatch, an unsafe path, or a malformed record stops ingestion.
- **No exposed secrets.** Secrets never appear in the dashboard site, API responses, URLs, or logs.

## What no option guarantees

- **Live data.** The dashboard is not a live feed. Its data is only as fresh as the last Activity run and the last dashboard rebuild or ingestion.
- **Availability.** CAO adds no availability service-level agreement (SLA), backup service, or disaster-recovery objective beyond what the underlying platform provides.
- **Compliance records.** The dashboard is not a compliance record. For compliance evidence, use GitHub Actions run history, your checked-in policy, your infrastructure definitions, and platform audit logs.
- **Workflow control.** The dashboard can't stop, cancel, or govern workflows. To stop campaigns, see [Emergency stop](operations.md#emergency-stop).

## Next steps

- To deploy the default option, see [Deploying the dashboard with GitHub Actions](deployment-actions.md).
- To plan your control repository's topology, ownership, and enrollment, see [Deployment and governance](deployment-and-governance.md).

## Further reading

- [Dashboard](dashboard.md)
- [Monitor and recover](operations.md), including [Publishing Pages reports](operations.md#publishing-pages-reports) and [Incident response](operations.md#incident-response)
- [Optional observability](configuration.md#optional-observability) for the agentic workflows
- [Glossary](glossary.md)
- [`server/README.md`](https://github.com/githubnext/gh-cao/blob/main/server/README.md) and [`server/SECURITY.md`](https://github.com/githubnext/gh-cao/blob/main/server/SECURITY.md), the detailed references for the Go server
