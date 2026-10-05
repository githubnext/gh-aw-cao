---
title: About deployment options
description: Compare the ways you can host the Central Agentic Ops dashboard, and choose the option that fits your data, audience, and infrastructure.
---

> [!WARNING]
> **Experimental:** All deployment options are experimental. Interfaces, configuration names, infrastructure templates, and procedures can change between releases without a migration path. No option is certified for production use. Before you expose a deployment to real users or data, complete your own security, compliance, privacy, network, monitoring, incident-response, and rollback reviews.

## About deployment options

Central Agentic Ops (CAO) has two parts that you deploy separately:

- **The control plane.** The [control plane](architecture.md) always runs in GitHub Actions. Its [orchestrators and workers](orchestrators-and-workers.md) and the [CAO Activity](activity.md) collector are workflows in your control repository.
- **The dashboard.** The [dashboard](dashboard.md) is a read-only view of the evidence that the control plane collects. A deployment option decides where the dashboard is served and where its query data lives.

Choosing a deployment option never changes campaign policy, rollout mode, credentials, or target authority. Those settings stay in the reviewed `.github/workflows/cao.json` file in your control repository. For more information, see [Control policy](configuration.md#control-policy) and [Roll out a campaign](rollout-and-routing.md).

## Comparing the options

Choose between two dashboard architectures based on the size of the data you
expect to inspect and the experience your viewers need. GitHub Pages is the
starter option: it has no extra server or database to operate. The server-backed
option moves storage and query work to PostgreSQL for larger datasets or when
browser-side loading and querying no longer meet your needs. Server-backed
deployments also require Redis for operational state; Redis may come from the
platform or a compatible external provider such as Upstash.

| Architecture | Choose it when | Where queries run | Hosting options |
| --- | --- | --- | --- |
| **GitHub Actions only (starter)** | You are getting started, your published dataset is manageable for viewers' browsers, and Pages access is sufficient. | In each viewer's browser. Every viewer downloads and indexes the snapshot locally. | [GitHub Pages with GitHub Apps](deployment-actions-github-app.md) or [a fine-grained PAT](deployment-actions-pat.md). No dashboard server, database, or cloud account to operate. |
| **Server-backed (scale-oriented)** | The dataset is too large or slow for comfortable browser loading and queries, or you need per-user sign-in or webhook-driven refresh. | On the server, over PostgreSQL. Viewers use the same API; they do not each query a local copy of the full dataset. | [Azure](deployment-azure.md) or [Coolify](deployment-coolify.md), with PostgreSQL and Redis. You operate or provision the server and its supporting services. |

### How to choose

Start with GitHub Pages unless you already know you need the server-backed
capabilities. In the Pages model, each viewer's browser downloads, stores, and
queries its own copy, so per-viewer performance depends on dataset size and the
viewer's device. Move to a server-backed deployment when real or representative
data makes that browser work too slow, memory-heavy, or unreliable for your
intended users. PostgreSQL centralizes data and query work, but you must
provision and monitor its capacity (and Redis for operational state); server-
backed hosting is not automatic or unlimited scale.

## Choosing an option

1. **Start with GitHub Actions only** if the browser-based workload fits your expected dataset and viewers. It needs no dashboard infrastructure beyond your control repository, and it is what `gh aw add githubnext/gh-aw-cao` installs by default. If you don't have a control repository yet, follow [Set Up CAO](setup-quickstarts.md) first.
1. **Choose a credential profile.** To try CAO with the least setup, use a fine-grained PAT. For production, use GitHub Apps. For more information, see [Choosing a credential profile](deployment-actions.md#choosing-a-credential-profile).
1. **Choose Azure or Coolify when the browser is the constraint** or when you need server-backed capabilities such as per-user sign-in or webhook-driven refresh. Base the scale decision on representative data and actual viewer devices; CAO does not prescribe a dataset-size threshold.

Azure and Coolify run the same Go service from the `server/` directory, with the same authentication, authorization, cross-site request forgery (CSRF), webhook, rate-limit, and logging protections. They differ in platform, secret management, ingress, and delivery.

Use the [one-minute managed Redis guide](deployment-managed-redis.md) to connect
AWS ElastiCache, Redis Cloud, GCP Memorystore, Railway, Render, or DigitalOcean.
The same provider-neutral `cao.json` host contract also defines the local Redis,
Azure, Coolify, and Upstash examples.

### Using Upstash Redis

[Upstash Redis](deployment-upstash.md) is a managed Redis option for the host-neutral Go server. Upstash doesn't host the CAO application. Run the container on Coolify or another application platform, provide its verified artifact there, and configure the server to use the Upstash TLS Redis endpoint.

> [!NOTE]
> Your credential profile still matters for Azure and Coolify. The CAO Activity workflow collects their evidence in GitHub Actions, using the profile that you configure. Dashboard users sign in separately, through a GitHub OAuth app. The optional Azure collection profile requires a GitHub App and doesn't support PATs.

## About the shared data flow

Every option serves data derived from the same evidence.

1. The `cao-activity.yml` workflow collects bounded `gh aw logs` evidence on a schedule.
1. The `cao-dashboard.yml` workflow builds the dashboard site and a data payload. The payload includes a hash manifest (`payload-hashes.json`), an inventory (`inventory-sources.json`), and run and record files (`gh-aw-logs-runs/*.jsonl` and `gh-aw-logs-records/*.jsonl`).
1. Your deployment serves the payload. GitHub Pages sends it to the browser. The Go server verifies it, transactionally loads dashboard entities into PostgreSQL, and answers bounded queries from PostgreSQL. Redis retains only operational caches and state.

The optional Azure collection profile replaces the first step with server-side collection workers that GitHub App webhooks drive. For more information, see [Using the optional collection profile](deployment-azure.md#using-the-optional-collection-profile).

For collection boundaries, retention, and browser processing, see [Data ingestion](dashboard-data-ingestion.md). For entities and identities, see [Data model](dashboard-data-model.md).

## What every option guarantees

- **Read-only access.** The dashboard can't start work, approve outputs, change policy, or write to target repositories. For more information, see [Know the boundary](dashboard.md#know-the-boundary) and [Execution and safety](execution-and-safety.md).
- **Disposable data.** Browser storage (IndexedDB) and hosted PostgreSQL hold rebuildable dashboard projections. Redis holds rebuildable operational caches and state. None is the authoritative Activity evidence source.
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
- [`server/README.md`](https://github.com/githubnext/gh-aw-cao/blob/main/server/README.md) and [`server/SECURITY.md`](https://github.com/githubnext/gh-aw-cao/blob/main/server/SECURITY.md), the detailed references for the Go server
