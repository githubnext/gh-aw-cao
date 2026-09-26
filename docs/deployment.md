---
title: Deployment options
description: Compare the GitHub Actions only, Azure, and Coolify deployment options for the Central Agentic Ops dashboard.
---

> [!WARNING]
> **Experimental:** Every deployment option on this page is experimental. Interfaces, configuration names, infrastructure templates, and operating procedures may change between releases without a migration path. None of the options has been certified for production use. Complete your own security, compliance, privacy, network, monitoring, incident-response, and rollback review before exposing a deployment to real users or data.

The control plane itself always runs in GitHub Actions: orchestrators, workers, and the Activity collector are Actions workflows in the control repository. A deployment option decides only **where the dashboard is served and where its query data lives**. It never changes campaign policy, rollout mode, credentials, or target authority; those remain in the control repository's reviewed `.github/workflows/cao.json`.

Three hosting options are currently available. The GitHub Actions only option has two credential profiles, which are listed separately below:

| Option | Dashboard host | Query execution | Authentication | Extra infrastructure |
| --- | --- | --- | --- | --- |
| [GitHub Actions only with GitHub Apps](deployment-actions-github-app.md) | GitHub Pages (static site) | In the browser, in a Web Worker over IndexedDB | GitHub Pages access control | Private read and write GitHub Apps |
| [GitHub Actions only with a fine-grained PAT](deployment-actions-pat.md) | GitHub Pages (static site) | In the browser, in a Web Worker over IndexedDB | GitHub Pages access control | Read and write fine-grained PATs owned by one user |
| [Azure](deployment-azure.md) | Azure Functions (custom Go handler) | Go server over Azure Managed Redis | GitHub OAuth plus explicit organization/team authorization | Function App, Key Vault, Azure Managed Redis, storage, Application Insights; optional Container Apps collectors |
| [Coolify](deployment-coolify.md) | Container on a Coolify host behind its TLS proxy | Go server over Redis | GitHub OAuth plus explicit organization/team authorization | Coolify host, Redis, GHCR image, deployment adapter |

## Choosing an option

- Start with **GitHub Actions only**. It needs no infrastructure beyond the control repository and is what `gh aw add githubnext/gh-aw-cao` installs by default.
- Within GitHub Actions only, use **GitHub Apps** by default. Use a **fine-grained PAT** only with informed consent, when no App can be installed and the scope is one resource owner with PAT-compatible APIs. For self-review, or bounded review of public targets, the built-in workflow token needs neither. For more information, see [Choosing a credential profile](deployment-actions.md#choosing-a-credential-profile).
- The credential profile also applies to Azure and Coolify, because the Activity workflow still collects their evidence in GitHub Actions. Dashboard users authenticate separately with a GitHub OAuth App. The Azure collection profile requires a GitHub App and does not support PATs.
- Choose **Azure** or **Coolify** only when you need server-side query execution for data that is too large for the browser, per-user GitHub OAuth authorization instead of Pages visibility, or webhook-driven refresh.
- Azure and Coolify run the same Go service (`server/`) with the same authentication, authorization, CSRF, webhook, rate-limit, and logging protections. They differ in platform, secret management, ingress, and delivery.

## About the shared data flow

Every option serves data derived from the same evidence:

1. `cao-activity.yml` collects bounded `gh aw logs` evidence on a schedule in GitHub Actions.
1. `cao-dashboard.yml` assembles the dashboard site plus a hash-manifested data payload (`payload-hashes.json`, `inventory-sources.json`, `gh-aw-logs-runs/*.jsonl`, `gh-aw-logs-records/*.jsonl`).
1. The selected option serves that payload: GitHub Pages ships it to the browser, while the Go server verifies it, projects it into Redis, and answers bounded queries.

The optional Azure *collection profile* replaces step 1 with server-side collection workers driven by GitHub App webhooks. For more information, see [Using the optional collection profile](deployment-azure.md#using-the-optional-collection-profile).

## What every option guarantees

- The dashboard is read-only with respect to campaigns. It cannot start work, approve outputs, change policy, or write to target repositories.
- Dashboard data is derived state. IndexedDB (Actions only) and Redis (Azure, Coolify) are disposable projections that can be rebuilt from the retained artifact; neither is an authority.
- Payload files are verified against `payload-hashes.json` before they are parsed. Missing manifests, hash mismatches, unsafe paths, or malformed records fail closed.
- Secrets are never written to the dashboard site, API responses, URLs, or logs.

## What no option guarantees

- No option is a live feed. Freshness is bounded by the Activity schedule and by when the dashboard payload was last rebuilt or re-ingested.
- No option provides an availability SLA, backup service, or disaster-recovery objective beyond what the underlying platform offers.
- No option makes the dashboard a compliance record. Compliance evidence remains GitHub Actions run history, the checked-in policy, infrastructure definitions, and platform audit logs.
- No option stops, cancels, or governs workflows. Use the [emergency stop](operations.md#emergency-stop) procedure for that.

## Further reading

- [Deployment and governance](deployment-and-governance.md) covers control-repository topology, ownership, and enrollment.
- [Configuration](configuration.md#optional-observability) covers OpenTelemetry export for the agentic workflows themselves.
- [`server/README.md`](https://github.com/githubnext/gh-aw-cao/blob/main/server/README.md) and [`server/SECURITY.md`](https://github.com/githubnext/gh-aw-cao/blob/main/server/SECURITY.md) are the detailed references for the Go server.
