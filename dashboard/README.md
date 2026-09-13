# Central Agentic Ops Dashboard

> [!NOTE]
> **Research prototype:** Features and interfaces may change as the project evolves.

The dashboard package publishes an access-controlled static view of Central Agentic Ops reports from a private control-plane repository.

> [!NOTE]
> Do not create a `REPORT_PAGES_TOKEN` secret. The workflow reads report data with the automatic `github.token` under explicit job permissions and deploys through GitHub Pages OIDC using `pages: write` and `id-token: write`.

> [!CAUTION]
> The generated site contains private control-plane data, including repository identity, issue and pull request content, comments, artifact-derived summaries, and workflow/run metadata. A private source repository does not make its Pages site private. Configure Pages access control before running the standalone publisher; do not publish the dashboard when the intended audience cannot be enforced. `REPORT_INCLUDE_PRIVATE` is a boolean, not a credential, and no `REPORT_INCLUDE_TOKEN` exists. The packaged workflow does not enable cross-repository private discovery. A custom implementation needs a short-lived credential limited to selected repositories with `Metadata: read`, `Contents: read`, and `Actions: read`.

## Contents

- `.github/workflows/cao-dashboard.yml`: dashboard build, artifact publication, and optional standalone GitHub Pages deployment.
- `.github/workflows/activity.yml`: shared data collector and cache publisher installed by the core activity package.
- `.github/workflows/shared/policy.mjs`: dependency-free checked-in policy parser and resolver.
- `.github/workflows/shared/control.mjs`: deterministic policy command adapter used by the build workflow.
- `.github/aw/dashboard/report`: deterministic collection modules executed by the activity action plus Dashboard Language source adaptation.
- `.github/aw/dashboard/site`: the packaged Dashboard Language validator, presenter, configuration, and browser runtime.
- `.github/aw/dashboard/local-server.mjs`: local preview server using Node.js built-ins and GitHub CLI, with live reload.

The activity action reads trusted workflow data and writes a bounded JSONL and SQLite cache snapshot plus a deterministic `inventory-sources.json` sidecar from the reviewed control policy and local workflow inventory. The dashboard publisher restores these files from the same cache. The browser ingests the activity JSONL and then the sidecar so configured packages, including packages without recent runs, are available to Dashboard Language queries. AI agents do not receive `pages: write`, `id-token: write`, or deployment authority.

The **GitHub API** view reads the activity snapshot's `cao-gh.jsonl` ledger. It charts rate-limit capacity and lists the before/after credential class and aggregate cache-hydration state for each instrumented collection operation.

If authoritative control policy resolution fails, the build remains fail-closed to the control repository and publishes the resolver diagnostic on the dashboard's Coverage diagnostics page. Valid policy that omits or disables an installed package or worker is shown as an admission gate in Overview attention and Security & controls. A latest failed run blocked by pre-activation GitHub REST API capacity is shown separately with its reset time, wait estimate, and official GitHub rate-limit guidance.

## Install

The root Central Agentic Ops package installs the dashboard by default. For a focused installation, install the core activity package and dashboard from the same reviewed release tag or full commit SHA:

```bash
gh aw add githubnext/gh-aw-cao/activity@<catalog-release>
gh aw add githubnext/gh-aw-cao/dashboard@<catalog-release>
```

Both installation paths add the deterministic dashboard automation without an additional enable variable. The standalone publisher remains manual-only and cannot enable Pages for the repository.

To refresh or restore package-owned files, reinstall a reviewed release with force:

```bash
gh aw add githubnext/gh-aw-cao/dashboard@<catalog-release> --force
```

The package contains only deterministic action workflows and resources, so `gh aw update` has no source-tracked agentic workflow through which to discover it.

## Local preview

From the root of an installed control repository, start the dashboard with Node.js:

```bash
npm run dashboard:local
```

The server requires GitHub CLI authentication with Actions read access. It downloads the latest non-expired `central-agentic-ops-dashboard` artifact and serves its `gh-aw-logs.jsonl` and `inventory-sources.json` through the same canonical browser-ingestion path as the Pages site. Run the dashboard action first; the server fails rather than opening a dashboard without data when the artifact cannot be downloaded. Use `--repo OWNER/REPOSITORY` to download from another control repository.

Open only the unguessable URL printed by the server. The server uses only Node.js built-ins plus GitHub CLI, binds to the loopback interface by default, rejects unexpected request hosts, and serves the packaged site without a build step. Use `--port` or `--host` to override its address.

The preview composes `.github/aw/dashboard/site/dashboard.json` with every installed `.github/aw/dashboards/*.json` package dashboard. It watches those files and sends the new composed `dashboard.json` over a capability-protected WebSocket after a valid update. The browser re-renders that document without reloading the page while continuing to use the downloaded report data. Invalid dashboard JSON is reported in the terminal while the last valid preview remains available.

### Canvas CLI actions

Dashboard documents may declare canvas-only CLI actions. They are hidden from
the published site and ordinary local previews. In the dashboard canvas, each
action appears in the **Actions** menu and always requires the user to review
and approve the exact command for that invocation; approval is never remembered
and there is no unattended mode.

```yaml
dashboard:
  cli-actions:
    - id: upgrade-repository
      label: Upgrade
      description: Upgrade the repository's Agentic Workflows files.
      icon: download
      command: gh aw upgrade --repo {{repository}}
      placement: settings
      arguments:
        - id: create-pull-request
          label: Create pull request
          description: Create a pull request with the generated workflow upgrades.
          type: boolean
          flag: --create-pull-request
          default: true
        - id: pre-releases
          label: Include pre-releases
          type: boolean
          flag: --pre-releases
          default: false
```

Commands must be single-line `gh aw ...` invocations. The canvas extension runs
GitHub CLI directly without a shell and supplies the user-approved
`GITHUB_TOKEN` as `GH_TOKEN` to that process. It also derives an ephemeral
author and committer identity from the currently authenticated GitHub CLI user
so pull-request actions can create commits without changing global or
repository Git configuration. When `gh aw` is unavailable, an approved action first attempts
`gh extension install github/gh-aw`. If that installation fails, it downloads
and runs the installer version declared by `gh-aw-version` in
`.github/workflows/cao.json` from the official `github/gh-aw`
repository, then verifies `gh aw` before continuing. Boolean action arguments
render as checkboxes and may append only their declared
canonical long option to the command preview and executed argv.

Catalog contributors can run `npm run dashboard:local`; the same server discovers top-level package `dashboard.json` files automatically. Pass a control repository explicitly with `npm run dashboard:local -- --repo OWNER/REPOSITORY`.

To reproduce the deployed dashboard's mobile DOM budget locally with live Pages data, run:

```bash
npm run dashboard:local:mobile
```

This starts the local preview through Playwright with the Pixel 7 profile and a 256 MiB V8 heap limit, then records DOM analysis, accessibility, trace, and screenshot evidence under `test-results/chromium-low-memory/`. The check fails when the rendered page exceeds 6,000 elements.

### Copilot-assisted editing

Install the Copilot SDK and start the preview with the optional editing mode:

```bash
npm install @github/copilot-sdk
npm run dashboard:local:copilot
```

Catalog contributors can use `npm run dashboard:local:copilot`. The CLI relaunches itself with Node's filesystem permission model, limiting reads and writes to the current workspace. It serves only Markdown, JSON, recognized web assets, and images, and redacts common secret patterns from textual files before returning them to the browser. The SDK launches Copilot CLI in headless server mode using the signed-in Copilot user and explicitly loads repository skills from `.github/skills` and `.agents/skills`. The preview adds a Copilot chat launcher above the dashboard; the dialog retains user and assistant messages across requests. Submitting a request starts a session for the active view, instructs Copilot to use the `generate-dashboard-ir` skill, validates the edited JSON until it passes, and saves it with normalized two-space indentation. Serialized, retrying source rebuilds then update the open view without reloading the page. Copilot mode only binds to a loopback host and restricts sessions to purpose-built tools that read editable dashboard sources, validate candidate JSON, and save the selected source. The server prints one access-log line for every HTTP response without exposing the capability URL prefix.

Start the Copilot-enabled development loop with:

```bash
npm run dev
```

Starting the command again replaces the prior dashboard dev server from the same workspace before binding port `4173`. It verifies the listener's command and working directory before signaling the exact process and refuses to stop unrelated port owners.

Each prompt receives one correlation ID. Browser lifecycle events, server request handling, source validation, preview rebuild, and the browser render acknowledgement are written as redacted JSON Lines to `.cao-dashboard-traces/latest.jsonl`. A request is reported as complete only after the browser confirms that it rendered the rebuilt dashboard.

Run the self-contained improvement loop without a live artifact or Copilot account:

```bash
npm run test:e2e:copilot-loop
```

The browser test starts a Copilot-enabled server with a deterministic runtime, submits a prompt through the chat UI, writes a package dashboard source, waits for the active browser view to update, and verifies the shared browser/server correlation trace.

## Standalone Pages site

Before running the standalone deployment, configure the private control-plane or review repository that will own the Pages site:

1. In **Settings > Pages**, select **GitHub Actions** as the source.
2. Restrict site access to the intended audience.
3. Protect the `github-pages` environment as required by your organization.

The workflow passes `enablement: false` to `actions/configure-pages`, so a run validates existing Pages configuration but never enables Pages for the repository.

Use **Refresh** in the dashboard header to open **Central Agentic Ops Dashboard** on the repository's **Actions** page, then click **Run workflow**. The build restores the latest complete schema-versioned activity snapshot and normalizes its usage records into the dashboard tables without triggering collection or indexing. Run **CAO Activity** separately when a fresh snapshot is required. The standalone workflow is deliberately not scheduled, so installing the package cannot replace an existing Pages deployment without an explicit run. Operational-value collection bootstraps adoption-to-current history through the gh-aw report contract and then reuses digest-scoped weekly replay shards. Actions caches accelerate refreshes but are evictable and are not historical authority.

The catalog contains only collector, adapter, and presenter code. Installed control repositories hold runtime aggregation and the current access-controlled Pages view. Live organization-specific JSON, Markdown, and SVG snapshots are generated data and are not committed to this catalog.

## Configure

1. Set `control-plane.scope.allowed-repositories` in `.github/workflows/cao.json` when report discovery should be limited to an explicit repository allowlist.
2. Set `control-plane.packages.dashboard.deploy` to `false` when another workflow downloads the `central-agentic-ops-dashboard` artifact and includes it in a combined Pages deployment. The default is `true`.

With standalone deployment disabled, the hosting workflow needs `actions: read`. It should list successful `cao-dashboard.yml` runs on the default branch, select the latest run, and download its `central-agentic-ops-dashboard` artifact into the hosting site's output directory before uploading the combined Pages artifact.

Do not install this package when the report would be public or when the repository plan cannot enforce the required access boundary. See [Publishing Pages Reports](../docs/operations.md#publishing-pages-reports) for operating details.
