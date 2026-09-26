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
| Control repository | A private repository that runs CAO. GitHub Enterprise is not required. |
| GitHub Actions | Enabled for the repository. You need GitHub-hosted `ubuntu-latest` runners or compatible self-hosted runners, and enough minutes for an Activity run about every 15 minutes. |
| Actions cache | Stores the Activity snapshot (`cao-activity-v5-*`) and the built dashboard (`central-agentic-ops-dashboard`). If the cache is evicted, the dashboard uses the latest successful Activity artifact instead. For more information, see [Cache contract](activity.md#cache-contract). |
| Actions artifacts | Stores the `cao-activity-index` and `central-agentic-ops-dashboard` artifacts. The dashboard artifact is kept for one day. |
| GitHub Pages | The publishing source must be **GitHub Actions**. To make the site private, you need a plan that supports access control for Pages, such as GitHub Enterprise Cloud. Otherwise, the site is public. |
| `github-pages` environment | Created automatically by GitHub Pages. You can protect it with required reviewers. |
| Browser | A current browser that supports web workers, IndexedDB, and JavaScript modules. The browser downloads and indexes the data on first load. |

The dashboard build and deploy jobs don't need any additional secrets. The build job uses the automatic `github.token` with `actions: read` and `contents: read` permissions. The deploy job uses OpenID Connect (OIDC) with `pages: write` and `id-token: write` permissions.

> [!NOTE]
> Don't create a `REPORT_PAGES_TOKEN` secret. The current dashboard doesn't use it.

## Choosing a credential profile

The Activity collector, orchestrators, and workers call the GitHub API with a credential that you configure in the control repository. That credential determines which evidence the dashboard can show and which repositories campaigns can reach. Choose one profile before the first run.

| Profile | Best for | Credentials | Limitations |
| --- | --- | --- | --- |
| [GitHub Apps](deployment-actions-github-app.md) | Production | A private read app and a private write app | You need permission to create and install private GitHub Apps. |
| [Fine-grained PAT](deployment-actions-pat.md) | Getting started and experimentation | A read PAT and a write PAT | Not for production. The tokens are tied to one user, expire, need manual rotation, cover a single resource owner, don't support every API, and share one rate limit. |
| Built-in workflow token | Reviewing the control repository itself, or reviewing public targets | None beyond `github.token` | Cross-repository Actions, security, issue, and pull request evidence is usually unavailable and is reported as incomplete. |

At runtime, CAO uses a configured GitHub App first, then a PAT, then `github.token`.

> [!WARNING]
> CAO falls back to the next credential without any warning. After you choose a profile, delete the credentials for every profile that you aren't using.

For more information, see [Configure authentication](authentication.md).

## Deploying the dashboard

1. Install the dashboard. You can install the root campaign, which includes the dashboard, or install only the Activity and dashboard campaigns from the same release.

   ```bash
   CAO_RELEASE=$(gh release view --repo githubnext/gh-aw-cao --json tagName --jq '.tagName')
   gh aw add "githubnext/gh-aw-cao/activity@${CAO_RELEASE}"
   gh aw add "githubnext/gh-aw-cao/dashboard@${CAO_RELEASE}"
   ```

1. Review, commit, and push the installed files. These include `.github/workflows/cao-activity.yml`, `.github/workflows/cao-dashboard.yml`, and the `activity/` and `dashboard/` directories.
1. Configure your credential profile. Follow the procedure for [GitHub Apps](deployment-actions-github-app.md#deploying-the-dashboard) or for a [fine-grained PAT](deployment-actions-pat.md#deploying-the-dashboard). If you use the built-in workflow token, skip this step.
1. Configure GitHub Pages.

   1. On GitHub, navigate to the main page of your control repository.
   1. Under your repository name, click **Settings**.
   1. In the "Code and automation" section of the sidebar, click **Pages**.
   1. Under "Build and deployment", under "Source", select **GitHub Actions**.
   1. Limit the site's visibility to the people who should see it.

1. Optionally, protect the `github-pages` environment. For more information, see [Managing environments for deployment](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-deployments/managing-environments-for-deployment) in the GitHub documentation.
1. Run the Activity workflow.

   1. Under your repository name, click **Actions**.
   1. In the left sidebar, click **CAO Activity**.
   1. Click **Run workflow**, then wait for the run to succeed.

   The dashboard build fails if no successful Activity run exists. If the run fails, see [Routine monitoring](operations.md#routine-monitoring).
1. In the left sidebar, click **CAO Dashboard**, then click **Run workflow**.
1. When the run finishes, open the URL from the `deploy` job. Confirm that the site shows data only from your control repository.

To learn how to read the dashboard, see [Dashboard](dashboard.md) and [Overview](dashboard-overview.md).

### Keeping the site up to date

The CAO Dashboard workflow runs when you push changes to any of these paths on the default branch:

- `.github/workflows/cao.json`
- `.github/workflows/cao-dashboard.yml`
- `*/dashboard.json`
- `dashboard/**`

The workflow has no schedule. To publish new evidence automatically, add a schedule or run the workflow after each Activity run.

## Configuration reference

| Setting | Location | Default | Description |
| --- | --- | --- | --- |
| `control-plane.campaigns.dashboard.deploy` | `.github/workflows/cao.json` | `true` | A boolean. When `false`, the workflow still builds and caches the dashboard artifact but doesn't deploy it to Pages. |
| Activity schedule | `.github/workflows/cao-activity.yml` | About every 15 minutes | Controls how fresh the evidence is. Change it in the campaign source and run `gh aw update`. Don't edit the installed lock file. |
| Activity retention | Ingestion steps in `cao-activity.yml` and `cao-dashboard.yml` | 30 days | Limits the size of the payload that browsers download. For more information, see [Update and retain browser data](dashboard-data-model.md#update-and-retain-browser-data). |
| Pages visibility | Repository Pages settings | Depends on your plan | Controls who can read the site. |

Pages destinations follow each campaign's rollout mode. In `review` mode, the dashboard publishes to access-controlled review Pages. In `live` mode, it publishes to production Pages. For more information, see [Pages report routing](rollout-and-routing.md#pages-report-routing).

### Publishing from an existing Pages workflow

If another workflow already publishes your Pages site, set `control-plane.campaigns.dashboard.deploy` to `false`. In your existing workflow, find the latest successful `cao-dashboard.yml` run on the default branch, download its `central-agentic-ops-dashboard` artifact into your site output, and deploy the combined result.

## Monitoring the deployment

This option has no server, so there's no server-side OpenTelemetry endpoint to configure for the dashboard. Use these signals instead.

| Signal | What to check |
| --- | --- |
| Workflow health | GitHub Actions run history is the primary record. When an Activity or dashboard job fails, CAO opens or updates a `CAO Activity workflow failure` or `CAO Dashboard workflow failure` issue with a stable failure code, such as `CAO_DASHBOARD_DEPLOY_FAILED`. |
| Data health | The build runs `activity/cao.mjs validate-activity-data` and `activity/cao.mjs doctor` against the restored database. The results appear in the job log. |
| Credential health | Skipped `create-github-app-token` steps, admission capacity gates, and authentication failures show which credential a run used. For details, see the [GitHub Apps](deployment-actions-github-app.md#monitoring-the-deployment) and [fine-grained PAT](deployment-actions-pat.md#monitoring-the-deployment) profiles. |
| Agentic workflow traces | Orchestrators and workers export OpenTelemetry spans through gh-aw. To turn on export, set the `GH_AW_DEFAULT_OTLP_ENDPOINT` variable and the `GH_AW_DEFAULT_OTLP_HEADERS` secret at the repository, organization, or enterprise level. For more information, see [Optional observability](configuration.md#optional-observability). |
| Browser diagnostics | Add `?debug=1`, `?debug=*`, or a category filter such as `?debug=data:query,-render:*` to the dashboard URL. The browser console then shows structured diagnostics that contain no sensitive data. `?debug=data:query` shows timings for each query stage. |
| Local reproduction | In a checkout of the catalog repository, run `npm run dashboard:local -- --repo OWNER/REPOSITORY` to download the published data and preview it locally. To query the same data with SQLite, see [Use local SQLite](dashboard-data-ingestion.md#use-local-sqlite). |

## What this deployment guarantees

- **Exact source.** The site is built from the exact workflow commit (`github.workflow_sha`). It publishes only the payload files listed in the manifest.
- **Complete payloads.** Every payload file is hash-verified before the browser loads it. If the payload is incomplete, the build fails instead of publishing partial data.
- **No long-lived credentials.** The build and deploy jobs don't hold long-lived credentials. The deploy job uses OIDC.
- **One deployment at a time.** A newer dashboard run cancels an older run that is still in progress.
- **Safe failures.** If a build or deployment fails, the previously deployed site stays in place.

## What this deployment does not guarantee

- **Freshness.** The site is a snapshot of the last successful deployment. It can lag behind the latest Activity run.
- **Confidentiality.** A private repository doesn't make its Pages site private. Access control depends on the Pages visibility settings that your plan supports.
- **Durability.** Actions caches can be evicted, and artifacts expire. The site isn't an archive. Target repository history and Actions run metadata remain the source of truth. To keep history longer, see [Create a historical archive](dashboard-data-ingestion.md#create-a-historical-archive).
- **Scale.** Each viewer's browser downloads and queries all of the data. Large fleets can exceed browser memory or load slowly. If that happens, consider a server-backed option.
- **Per-user authorization.** Anyone who can read the Pages site can read all of its data. There is no per-user or per-repository filtering.
- **Availability.** Availability depends on GitHub Pages and GitHub Actions. CAO adds no SLA.
- **Coverage.** The dashboard shows only evidence that your credential can read. Repositories that the credential can't reach appear as incomplete coverage, not as healthy repositories with no activity.

## Rolling back or stopping the deployment

- **To roll back,** run the CAO Dashboard workflow from a known-good commit, or revert the change and push.
- **To stop future deployments,** set `control-plane.campaigns.dashboard.deploy` to `false`. This setting doesn't remove the current site.
- **To take the site down,** unpublish it from your repository's Pages settings, or block the `github-pages` environment.

If private data was exposed, treat it as a Pages incident. For more information, see [Incident response](operations.md#incident-response).

## Next steps

- If you haven't set up credentials yet, configure [GitHub Apps](deployment-actions-github-app.md) or a [fine-grained PAT](deployment-actions-pat.md).
- To publish reports for reviewed campaigns, see [Publishing Pages reports](operations.md#publishing-pages-reports).

## Further reading

- [About deployment options](deployment.md)
- [Quickstart](getting-started.md)
- [Configure authentication](authentication.md)
- [CAO Activity](activity.md)
- [Data ingestion](dashboard-data-ingestion.md)
- [Monitor and recover](operations.md)
- [Configuring a publishing source for your GitHub Pages site](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site) in the GitHub documentation
- [Changing the visibility of your GitHub Pages site](https://docs.github.com/en/enterprise-cloud@latest/pages/getting-started-with-github-pages/changing-the-visibility-of-your-github-pages-site) in the GitHub documentation
