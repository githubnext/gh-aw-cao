---
title: GitHub Actions only
description: Deploy the Central Agentic Ops dashboard as a static GitHub Pages site built entirely by GitHub Actions.
---

> [!WARNING]
> **Experimental:** The GitHub Actions only deployment is experimental. Workflow names, cache keys, payload layout, and configuration fields may change between releases. The published site can contain private repository data; confirm the Pages access boundary before the first deployment.

This is the default deployment. Everything runs in the control repository's GitHub Actions: the Activity workflow collects evidence, the dashboard workflow builds a static site plus its data payload, and GitHub Pages serves it. All queries run in the viewer's browser, in a Web Worker over a per-browser IndexedDB database. There is no server, database, or cloud account to operate.

## Prerequisites

| Requirement | Detail |
| --- | --- |
| GitHub repository | The private control repository that runs CAO. A GitHub Enterprise account is not required. |
| GitHub Actions | Enabled for the repository, with GitHub-hosted `ubuntu-latest` runners (or compatible self-hosted runners) and enough minutes for a scheduled Activity run about every 15 minutes. |
| Actions cache | Used for the Activity snapshot (`cao-activity-v5-*`) and the built dashboard (`central-agentic-ops-dashboard`). Cache eviction is tolerated; the dashboard falls back to the latest successful Activity artifact. |
| Actions artifacts | `cao-activity-index` and `central-agentic-ops-dashboard` artifacts. The dashboard artifact is retained for one day. |
| GitHub Pages | Source set to **GitHub Actions**. Access-controlled (private) Pages visibility requires a plan that supports it, such as GitHub Enterprise Cloud; otherwise the site is public. |
| `github-pages` environment | Created by Pages; optionally protected with required reviewers. |
| Viewer browser | A current browser with Web Workers, IndexedDB, and ES modules. Data is downloaded and indexed locally on first load. |

The dashboard build and Pages deploy jobs need no additional secrets. The build job uses the automatic `github.token` with job-scoped `actions: read` and `contents: read`; the deploy job uses Pages OIDC with `pages: write` and `id-token: write`. Do not create a `REPORT_PAGES_TOKEN` secret.

## Choosing a credential profile

The Activity collector, orchestrators, and workers call the GitHub API with a credential chosen by the control repository. This choice determines what evidence the dashboard can show and which repositories campaigns can reach. Select exactly one profile before the first run:

| Profile | Credentials | Use when | Key limits |
| --- | --- | --- | --- |
| [GitHub Apps](deployment-actions-github-app.md) (recommended) | Private read and write Apps: `GH_AW_GITHUB_READ_APP_ID`/`_PRIVATE_KEY` and `GH_AW_GITHUB_WRITE_APP_ID`/`_PRIVATE_KEY` | Private or internal targets, cross-repository evidence, separate review repositories, live safe outputs, or multiple organizations in one enterprise | Requires permission to create and install private Apps |
| [Fine-grained PAT](deployment-actions-pat.md) (consented fallback) | `GH_AW_GITHUB_READ_PAT` and `GH_AW_GITHUB_WRITE_PAT` | No App can be installed, and the scope is one resource owner with PAT-compatible APIs | Tied to one user, expires, rotated by hand, one resource owner, endpoint gaps, shared rate limit |
| Built-in workflow token | None beyond `github.token` | Self-review of the control repository, or bounded `review` of public targets with outputs kept in the control repository | Cross-repository Actions, security, issue, and pull-request evidence is usually unavailable and reported as incomplete |

At runtime a configured App takes precedence over a PAT, and a PAT takes precedence over `github.token`. Because this fallback is silent, remove the credentials of any profile you did not choose. For the full policy, see [Configure authentication](authentication.md).

## Deploying the dashboard

1. Install the dashboard with the root campaign, or install only the deterministic activity and dashboard campaigns from the same release:

   ```bash
   CAO_RELEASE=$(gh release view --repo githubnext/gh-aw-cao --json tagName --jq '.tagName')
   gh aw add "githubnext/gh-aw-cao/activity@${CAO_RELEASE}"
   gh aw add "githubnext/gh-aw-cao/dashboard@${CAO_RELEASE}"
   ```

1. Review, commit, and push the installed files, including `.github/workflows/cao-activity.yml`, `.github/workflows/cao-dashboard.yml`, `activity/`, and `dashboard/`.
1. Configure the [credential profile](#choosing-a-credential-profile) that you chose. Follow the [GitHub Apps](deployment-actions-github-app.md#deploying-the-dashboard) or [fine-grained PAT](deployment-actions-pat.md#deploying-the-dashboard) procedure, or skip this step for the built-in workflow token.
1. Configure GitHub Pages.

   1. On GitHub, navigate to the main page of the control repository.
   1. Under your repository name, click **Settings**.
   1. In the "Code and automation" section of the sidebar, click **Pages**.
   1. Under "Build and deployment", under "Source", select **GitHub Actions**.
   1. Restrict the site visibility to the intended audience.

1. Optionally, protect the `github-pages` environment. For more information, see [Managing environments for deployment](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-deployments/managing-environments-for-deployment) in the GitHub documentation.
1. Under your repository name, click **Actions**. In the left sidebar, click **CAO Activity**, then click **Run workflow**. Wait for the run to succeed. The dashboard build fails if no successful Activity run exists.
1. In the left sidebar, click **CAO Dashboard**, then click **Run workflow**.
1. Open the deployment URL from the `deploy` job, and confirm that the site shows data only from the intended control repository.

The dashboard workflow also runs on pushes to the default branch that change `.github/workflows/cao.json`, `.github/workflows/cao-dashboard.yml`, `*/dashboard.json`, or `dashboard/**`. It has no schedule of its own; add one, or dispatch it after Activity runs, when you need the published site to track new evidence automatically.

## Configuration reference

| Setting | Location | Default | Effect |
| --- | --- | --- | --- |
| `control-plane.campaigns.dashboard.deploy` | `.github/workflows/cao.json` | `true` | Must be a boolean. `false` keeps building and caching the dashboard artifact but skips the standalone Pages deployment, so an existing Pages workflow can publish it. |
| Activity schedule | `.github/workflows/cao-activity.yml` | About every 15 minutes | Controls evidence freshness. Change it through the campaign source and `gh aw update`, not by hand-editing an installed lock file. |
| Activity retention | `cao-activity.yml` and `cao-dashboard.yml` ingestion steps | 30 days of runs and records | Bounds the payload size served to browsers. |
| Pages visibility | **Settings > Pages** | Repository plan default | Determines who can read the site. |

When another workflow already owns Pages, set `deploy` to `false`. That workflow can list successful `cao-dashboard.yml` runs on the default branch, download the latest `central-agentic-ops-dashboard` artifact into its site output, and deploy the combined result.

## Monitoring the deployment

This option runs no server, so there is no server-side OpenTelemetry endpoint to configure for the dashboard.

- **Workflow health.** GitHub Actions run history is the primary record for Activity and dashboard runs. Failed Activity or dashboard jobs open or update a `CAO Activity workflow failure` or `CAO Dashboard workflow failure` issue in the control repository, with a stable failure code such as `CAO_DASHBOARD_DEPLOY_FAILED`.
- **Data health.** The build runs `activity/cao.mjs validate-activity-data` and `activity/cao.mjs doctor` against the restored database and logs the result in the job output.
- **Credential health.** Skipped `create-github-app-token` steps, admission capacity gates, and authentication failures reveal which credential a run actually used. The [GitHub Apps](deployment-actions-github-app.md#monitoring-the-deployment) and [PAT](deployment-actions-pat.md#monitoring-the-deployment) pages describe the signals specific to each profile.
- **Agentic workflow traces.** Orchestrators and workers export OpenTelemetry spans through gh-aw. Set the `GH_AW_DEFAULT_OTLP_ENDPOINT` Actions variable and the `GH_AW_DEFAULT_OTLP_HEADERS` Actions secret at repository, organization, or enterprise scope. For more information, see [Optional observability](configuration.md#optional-observability).
- **Browser diagnostics.** Append `?debug=1`, `?debug=*`, or a category filter such as `?debug=data:query,-render:*` to the dashboard URL to log structured, non-sensitive diagnostics to the browser console. `?debug=data:query` reports per-stage query timings.
- **Local reproduction.** Run `npm run dashboard:local -- --repo OWNER/REPOSITORY` in a catalog checkout to download the published data and preview it locally.

## What this deployment guarantees

- The site is built from the exact workflow commit (`github.workflow_sha`) and only publishes manifest-listed payload files.
- Payload files are hash-verified before the browser ingests them; an incomplete payload fails the build instead of publishing partial data.
- The build and deploy jobs hold no long-lived credentials; deployment uses Pages OIDC.
- Deployment is serialized: a newer dashboard run cancels an in-progress older run.
- A failed build or deployment leaves the previously deployed site in place.

## What this deployment does not guarantee

- **Freshness.** The site is a snapshot. It reflects the last successful dashboard deployment, which may lag the latest Activity run.
- **Confidentiality.** A private repository does not make its Pages site private. Access control depends on the Pages visibility settings your plan supports.
- **Durability.** Actions caches may be evicted and artifacts expire. The site is a presentation snapshot, not an archive; target repository history and Actions run metadata remain the authority.
- **Scale.** All data is downloaded and queried in each viewer's browser. Very large fleets can exceed browser memory or make first load slow; consider a server-backed option.
- **Per-user authorization.** Everyone who can read the Pages site can read all of its data. There is no per-user or per-repository filtering.
- **Availability.** Availability is that of GitHub Pages and GitHub Actions; CAO adds no SLA.
- **Coverage.** The dashboard can show only evidence the selected credential can read. Repositories it cannot reach appear as incomplete coverage, not as healthy zeros.

## Rolling back or stopping the deployment

- Re-run **CAO Dashboard** from a known-good commit, or revert the offending change and push.
- Set `control-plane.campaigns.dashboard.deploy` to `false` to stop future standalone deployments; this does not unpublish the current site.
- To take the site down, unpublish it from the repository's Pages settings, or block the `github-pages` environment. Treat an unintended data exposure as a Pages incident.

## Further reading

- [Deployment options](deployment.md)
- [Configure authentication](authentication.md)
- [Monitor and recover](operations.md)
- [Configuring a publishing source for your GitHub Pages site](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site) in the GitHub documentation
- [Changing the visibility of your GitHub Pages site](https://docs.github.com/en/enterprise-cloud@latest/pages/getting-started-with-github-pages/changing-the-visibility-of-your-github-pages-site) in the GitHub documentation
