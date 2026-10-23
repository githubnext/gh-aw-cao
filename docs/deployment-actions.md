---
title: Deploying the dashboard with GitHub Actions
description: Build the Central Agentic Ops dashboard in GitHub Actions and publish it as a static GitHub Pages site, with no servers or cloud accounts to operate.
---

> [!WARNING]
> **Experimental:** The GitHub Actions only deployment is experimental. Workflow names, cache keys, payload layout, and configuration fields can change between releases. The published site can contain private repository data. Confirm your Pages access boundary before the first deployment.

## About the GitHub Actions only deployment

The GitHub Actions only deployment is the default way to host the dashboard. Everything runs in your control repository:

1. The [CAO Activity](activity.md) workflow collects evidence.
1. The CAO Dashboard workflow builds a static site and its data payload.
1. GitHub Pages serves the site.

Queries run in each viewer's browser, in a web worker over a local IndexedDB database. You don't operate a server, a database, or a cloud account. For more information about how the browser loads data, see [Browser data pipeline](dashboard-data-ingestion.md#browser-data-pipeline).

## Prerequisites

| Requirement | Details |
| --- | --- |
| Control repository | Public or private. Use private for non-public evidence; repository visibility does not determine Pages visibility. |
| GitHub Actions | Enabled for the repository. You need GitHub-hosted `ubuntu-latest` runners or compatible self-hosted runners, and enough minutes for an hourly Activity run. |
| Actions cache | Stores the Activity snapshot (`cao-activity-v5-*`) and built dashboard (`central-agentic-ops-dashboard`). Automatic builds fall back only to the triggering Activity run's artifact; manual builds can use the latest successful snapshot. See [Keeping the site up to date](#keeping-the-site-up-to-date). |
| Actions artifacts | Stores the `cao-activity-index` and `central-agentic-ops-dashboard` artifacts. The dashboard artifact is kept for one day. |
| GitHub Pages | The publishing source must be **GitHub Actions**. To make the site private, you need a plan that supports access control for Pages, such as GitHub Enterprise Cloud. Otherwise, the site is public. |
| `github-pages` environment | Created automatically by GitHub Pages. You can protect it with required reviewers. |
| Browser | A current browser that supports web workers, IndexedDB, and JavaScript modules. The browser downloads and indexes the data on first load. |

The dashboard build, Pages artifact, and deploy jobs don't need additional
secrets. The build job uses the automatic `github.token` with `actions: read`
and `contents: read` permissions. A separate job packages and uploads the Pages
artifact before the deploy job uses OpenID Connect (OIDC) with `pages: write`
and `id-token: write` permissions.

> [!NOTE]
> Don't create a `REPORT_PAGES_TOKEN` secret. The current dashboard doesn't use it.

The Pages artifact and deploy jobs rely on the standard Pages actions to report
configuration and deployment errors; they do not separately verify Pages
visibility with the Actions token. The Configure Pages step sets
`ignore-if-missing: true`, but the pinned action does not currently support
that input, so it can still fail when Pages settings are unavailable. Confirm
the publishing source and intended access boundary in **Settings > Pages**
before deployment.

## Choosing a credential profile

Collection credentials and Pages hosting are separate decisions. Choose the
least-privilege profile that can read the evidence you need. Installing
monitoring does not require enabling campaigns or granting target-write access.

| Profile | Best for | Credentials | Limitations |
| --- | --- | --- | --- |
| [Built-in workflow token](authentication.md#public-only-monitoring-quickstart) | Monitor the control repository and confirmed public remote targets | Actions `GITHUB_TOKEN`; no App/PAT setup | Remote scope must be explicitly public-only; restricted evidence remains partial. No cross-repository writes. |
| [GitHub Apps](deployment-actions-github-app.md) | Durable private/internal and cross-repository access | Separate private read and write Apps | Requires approved, selected-repository installations; write access stays limited to approved outputs. |
| [Fine-grained PATs](deployment-actions-pat.md) | Evaluation when suitable Apps are unavailable | Owner-scoped read/write tokens | User-bound, expiring, manually rotated, API-limited; tokens from the same user share that user's quota. |

Explicit App and PAT modes **fail closed** when the selected credential or
mapping is missing; they do not silently switch profiles. Stored credentials
for another profile may remain inactive. The job token still handles trusted
control-repository operations. See
[runtime credential selection](authentication.md#runtime-credential-selection)
for the distinction from legacy unset-mode compatibility.

## Deploying the dashboard

1. Complete [Set Up CAO](setup-quickstarts.md) to install the runtime, review exact
   collection scope and authentication, configure Pages, and publish reviewed
   files. Setup selects **GitHub Actions** as the Pages source; it does **not**
   automatically make a private repository's site private. It asks before
   accepting public publication. Decline for non-public evidence and configure
   restricted access in **Settings > Pages** before publishing.
2. Optionally, protect the `github-pages` environment with
   [required reviewers](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-deployments/managing-environments-for-deployment).
3. Follow **CAO Activity**, then the automatically triggered **CAO Dashboard**
   workflow, including its `deploy` job. If no collection is queued, request it
   once as described in the setup guide. Confirm the site shows only the reviewed
   collection scope, which may include explicitly enrolled remote repositories.

Before the first successful collection, a manual Dashboard build can publish
local inventory with an explicitly empty activity set. This is
[bootstrap evidence](dashboard-data-ingestion.md#before-the-first-activity-snapshot),
not proof that remote repositories have no activity. Invalid restored data or
missing artifacts from an existing successful collection still fail; they are
not treated as an empty installation.

<details>
<summary>Install the components individually in an already configured control repository</summary>

For a deliberately component-managed installation, gh-aw can install the
Activity and Dashboard packages separately:

```bash
gh aw add githubnext/gh-cao/activity
gh aw add githubnext/gh-cao/dashboard
```

Unpinned coordinates resolve the latest release. These commands are not a
replacement for scope, credentials, Pages visibility, or reviewed publication.
Use the complete setup guide for a new control repository.

</details>

To learn how to read the dashboard, see [Dashboard](dashboard.md) and [Overview](dashboard-overview.md).

### Keeping the site up to date

CAO Activity runs hourly, on manual dispatch, and on relevant default-branch
pushes. These include policy, Activity/Dashboard workflow sources, `activity/**`,
`dashboard/**`, and campaign dashboard or value-collector files. The exact
filters live in [`cao-activity.yml`](https://github.com/githubnext/gh-cao/blob/main/.github/workflows/cao-activity.yml).

Dashboard has no push trigger or schedule. Every successful default-branch
Activity run triggers one Dashboard build, so a relevant push produces one
collection-and-publication sequence without a duplicate deployment.

Failed or cancelled Activity runs produce skipped Dashboard runs rather than publishing an invalid snapshot. If every Activity-triggered Dashboard run is skipped, inspect the upstream Activity run first. A confirmed API capacity limit is recoverable: Activity indexes retained and downloaded runs, marks the affected repository coverage as partial, and skips further issue-status and operational-value API work. Authentication, visibility, and invalid-data failures still block publication.

An automatically triggered Dashboard build restores the exact triggering
Activity run and attempt's cache, falling back only to that run's artifact.
It cannot silently publish a different run's older snapshot. Manual dispatch can
still rebuild from the last cached snapshot without collecting fresh evidence.

## Configuration reference

| Setting | Location | Default | Description |
| --- | --- | --- | --- |
| `control-plane.campaigns.dashboard.deploy` | `.github/workflows/cao.json` | `true` | A boolean. When `false`, the workflow still builds and caches the dashboard artifact but doesn't deploy it to Pages. |
| Activity schedule | `.github/workflows/cao-activity.yml` | Hourly | Controls how fresh the evidence is. Change it in the campaign source and run `gh aw update`. Don't edit the installed lock file. |
| Activity retention | Ingestion steps in `cao-activity.yml` and `cao-dashboard.yml` | 30-day runs, 7-day linked detail | Bounds the published run evidence; browser and Operational Value retention have separate rules. See [Data ingestion](dashboard-data-ingestion.md#completeness-and-duplicates). |
| Pages visibility | Repository Pages settings | Depends on your plan | Controls who can read the site. |

This dashboard deploys to the **control repository's Pages site**, independently
of campaign `review`/`live` output routing. It does not switch sites when a
campaign changes mode. Campaign-generated reports have a separate
[Pages report routing](rollout-and-routing.md#pages-report-routing) contract.

### Publishing from an existing Pages workflow

If another workflow already publishes your Pages site, set `control-plane.campaigns.dashboard.deploy` to `false`. In your existing workflow, find the latest successful `cao-dashboard.yml` run on the default branch, download its `central-agentic-ops-dashboard` artifact into your site output, and deploy the combined result.

## Monitoring the deployment

This option has no server, so there's no server-side OpenTelemetry endpoint to configure for the dashboard. Use these signals instead.

| Signal | What to check |
| --- | --- |
| Workflow health | GitHub Actions run history is the primary record. When an Activity or dashboard job fails, CAO opens or updates a `CAO Activity workflow failure` or `CAO Dashboard workflow failure` issue with a stable failure code, such as `CAO_DASHBOARD_DEPLOY_FAILED`. |
| Data health | The build runs `node activity/cao.mjs validate-activity-data` and the mutating `node activity/cao.mjs repair-database` against the restored database. Repair backs up before changes and applies retention even without corruption. The results appear in the job log. |
| Credential health | Skipped `create-github-app-token` steps, admission capacity gates, and authentication failures show which credential a run used. For details, see the [GitHub Apps](deployment-actions-github-app.md#monitoring-the-deployment) and [fine-grained PAT](deployment-actions-pat.md#monitoring-the-deployment) profiles. |
| Agentic workflow traces | Orchestrators and workers export OpenTelemetry spans through gh-aw. To turn on export, set the `GH_AW_DEFAULT_OTLP_ENDPOINT` variable and the `GH_AW_DEFAULT_OTLP_HEADERS` secret at the repository, organization, or enterprise level. For more information, see [Optional observability](configuration.md#optional-observability). |
| Browser diagnostics | Add `?debug=1`, `?debug=*`, or a category filter such as `?debug=data:query,-render:*` to the dashboard URL. The browser console then shows structured diagnostics that contain no sensitive data. `?debug=data:query` shows timings for each query stage. |
| Local reproduction | In a catalog checkout, set `DASHBOARD_DATA_URL` to the deployed Pages URL and run `npm run dashboard:local -- --download-sqlite` for Go/SQLite serving. To test browser IndexedDB, build an explicit Pages simulation from an Activity snapshot and serve it with Go; see [Choose a local serving mode](dashboard-data-ingestion.md#choose-a-local-serving-mode). |

## What this deployment guarantees

- **Exact source.** The site is built from the exact workflow commit (`github.workflow_sha`). It publishes only the payload files listed in the manifest.
- **Payload integrity.** Manifested files are hash-verified before ingestion. Missing or invalid payload files fail closed. Integrity does not mean complete evidence: bootstrap, restricted artifacts, or capacity-limited collection can be explicitly partial.
- **No long-lived credentials.** The build, Pages artifact, and deploy jobs
  don't hold long-lived credentials. The deploy job uses OIDC.
- **One deployment at a time.** A running dashboard build finishes publishing its snapshot without being cancelled by newer triggers. GitHub Actions keeps at most one pending eligible build, replacing it when a newer eligible run arrives. Ineligible triggers use separate concurrency groups and cannot displace that pending build.
- **Safe failures.** If a build or deployment fails, the previously deployed site stays in place.

## What this deployment does not guarantee

- **Freshness.** The site is a snapshot of the last successful deployment. It can lag behind the latest Activity run.
- **Confidentiality.** A private repository doesn't make its Pages site private. Access control depends on the Pages visibility settings that your plan supports.
- **Durability.** Actions caches can be evicted, and artifacts expire. The site isn't an archive. Target repository history and Actions run metadata remain the source of truth. To keep history longer, see [Create a historical archive](dashboard-data-ingestion.md#create-a-historical-archive).
- **Scale.** Each viewer's browser downloads and queries all of the data. Large fleets can exceed browser memory or load slowly. If that happens, consider a server-backed option.
- **Per-user authorization.** Anyone who can read the Pages site can read all of its data. There is no per-user or per-repository filtering.
- **Availability.** Availability depends on GitHub Pages and GitHub Actions. CAO adds no SLA.
- **Coverage.** Restricted or unavailable evidence is not a healthy zero. Some collection gaps are explicitly partial; missing selected credentials, failed visibility checks, and invalid data block publication.

## Rolling back or stopping the deployment

- **To roll back,** restore known-good reviewed source through the normal Git process and rebuild. A manual rebuild uses retained Activity evidence, not necessarily the original historical dataset.
- **To stop future deployments,** set `control-plane.campaigns.dashboard.deploy` to `false`. This setting doesn't remove the current site.
- **To take the site down,** unpublish it from your repository's Pages settings, or block the `github-pages` environment.

If private data was exposed, treat it as a Pages incident. For more information, see [Incident response](operations.md#incident-response).

## Next steps

- If collection is not configured, choose the [credential profile](#choosing-a-credential-profile) for your exact scope; public-only monitoring needs no App/PAT setup.
- To publish reports for reviewed campaigns, see [Publishing Pages reports](operations.md#publishing-pages-reports).

## Further reading

- [About deployment options](deployment.md)
- [Set Up CAO](setup-quickstarts.md)
- [Configure authentication](authentication.md)
- [CAO Activity](activity.md)
- [Data ingestion](dashboard-data-ingestion.md)
- [Monitor and recover](operations.md)
- [Configuring a publishing source for your GitHub Pages site](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site) in the GitHub documentation
- [Changing the visibility of your GitHub Pages site](https://docs.github.com/en/enterprise-cloud@latest/pages/getting-started-with-github-pages/changing-the-visibility-of-your-github-pages-site) in the GitHub documentation
