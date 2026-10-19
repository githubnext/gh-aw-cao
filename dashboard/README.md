# Central Agentic Ops Dashboard

> [!NOTE]
> **Research prototype:** Features and interfaces may change as the project evolves.

The dashboard campaign publishes an access-controlled static view of Central Agentic Ops reports from a private control-plane repository.

> [!NOTE]
> Do not create a `REPORT_PAGES_TOKEN` secret. The workflow reads report data with the automatic `github.token` under explicit job permissions and deploys through GitHub Pages OIDC using `pages: write` and `id-token: write`.

> [!CAUTION]
> The generated site contains private control-plane data, including repository identity, issue and pull request content, comments, artifact-derived summaries, and workflow/run metadata. A private source repository does not make its Pages site private. Configure Pages access control before running the standalone publisher; do not publish the dashboard when the intended audience cannot be enforced. `REPORT_INCLUDE_PRIVATE` is a boolean, not a credential, and no `REPORT_INCLUDE_TOKEN` exists. The bundled workflow does not enable cross-repository private discovery. A custom implementation needs a short-lived credential limited to selected repositories with `Metadata: read`, `Contents: read`, and `Actions: read`.

## Contents

- `.github/workflows/cao-dashboard.yml`: dashboard build, artifact publication, and optional standalone GitHub Pages deployment.
- `.github/workflows/cao-activity.yml`: shared data collector and cache publisher installed by the core activity campaign.
- `.github/workflows/shared/policy.mjs`: dependency-free checked-in policy parser and resolver.
- `.github/workflows/shared/control.mjs`: deterministic policy command adapter used by the build workflow.
- `dashboard/report`: deterministic collection modules executed by the activity action plus Dashboard Language source adaptation.
- `dashboard/site`: the bundled Dashboard Language validator, presenter, configuration, and browser runtime.
- `server/`: the Go HTTP server for both local SQLite previews and hosted PostgreSQL deployments.
- `gh cao dashboard serve`: native local artifact preparation, live reload, trusted authoring, and command execution through that same Go server.

The activity action reads trusted workflow data and writes a bounded JSONL and SQLite cache snapshot plus a deterministic `inventory-sources.json` sidecar from the reviewed control policy, installed campaign ownership records, local control workflow inventory, and paginated Actions workflow registries for resolved repositories. Campaign default-branch revisions, the latest stable gh-aw release, and generated lock compiler metadata are collected as independent version evidence. Registry and version lookup failures remain explicit partial evidence, and repository-owned workflows remain standalone rather than becoming campaign workers or rollout authority. An Activity-triggered dashboard build restores the exact triggering run and attempt's cache, or downloads that run's `cao-activity-index` artifact on a cache miss. It never substitutes another run's snapshot or an empty bootstrap. Manual builds can reuse the latest cached snapshot, falling back to a successful default-branch Activity run with a successful `index` job. The browser ingests the activity JSONL and then the sidecar so configured campaigns, including campaigns without recent runs, are available to Dashboard Language queries. AI agents do not receive `pages: write`, `id-token: write`, or deployment authority.

The **GitHub API** view reads the activity snapshot's `cao-gh.jsonl` ledger. It charts rate-limit capacity and lists the before/after credential class and aggregate cache-hydration state for each instrumented collection operation.

If authoritative control policy resolution fails, the build remains fail-closed to the control repository and publishes the resolver diagnostic on the dashboard's Coverage diagnostics page. Valid policy that omits or disables an installed campaign or worker is shown as an admission gate in Overview attention and Security & controls. A latest failed run blocked by pre-activation GitHub REST API capacity is shown separately with its reset time, wait estimate, and official GitHub rate-limit guidance.

## Install

The root Central Agentic Ops campaign installs Activity, Dashboard, the trusted
materializer, and the local runtime verification action together. The installer
resolves the latest campaign release automatically, then materializes the
canonical runtime files from the exact revision recorded by gh-aw:

```bash
curl --fail --silent --show-error --location \
  https://raw.githubusercontent.com/githubnext/gh-aw-cao/main/install.sh |
  bash -s -- githubnext/gh-aw-cao
```

Direct `gh aw add` of the component `activity/` or `dashboard/` manifests is not
a complete installation: gh-aw cannot run the required post-install materialization step
for component manifests, and those manifests intentionally contain no duplicate
runtime resources. The root installation adds the deterministic dashboard
automation without an additional enable variable. Run `gh cao setup` to
configure Pages for GitHub Actions with repository-restricted access for a
private control repository. The standalone publisher remains manual-only and
cannot enable Pages for the repository.

To refresh or restore campaign-owned files, rerun the installer. It resolves the
latest campaign release automatically:

```bash
curl --fail --silent --show-error --location \
  https://raw.githubusercontent.com/githubnext/gh-aw-cao/main/install.sh |
  bash -s -- githubnext/gh-aw-cao
```

Use `gh cao update` to move installed campaigns to a newer reviewed
release. It runs gh-aw updates and rematerializes canonical runtime files from
the immutable resolved commit recorded by gh-aw.

## Local preview

From the root of a control repository, use the native Go extension and
authenticated GitHub CLI:

```bash
gh cao dashboard serve
gh cao dashboard serve --repo OWNER/REPOSITORY
gh cao dashboard serve --data .cao/downloaded-dashboard
```

The command requires GitHub CLI authentication with Actions read access. It downloads the latest non-expired `central-agentic-ops-dashboard` artifact, validates successful trusted default-branch workflow provenance and payload hashes, and opens the artifact's canonical SQLite snapshot natively. Dashboard Language is evaluated by the shared Go query engine, including aliases and continuation pages. No Node.js, npm, PostgreSQL, Redis, OAuth setup, or site build is needed. Run the dashboard action first; startup fails rather than substituting missing data. `--data DIRECTORY` selects an explicitly prepared artifact for offline use. In a source checkout, `go run ./cmd/gh-cao dashboard serve` and `npm run dashboard:local` invoke this same native implementation.

Open only the unguessable URL printed by the server. Go owns preparation, declarative document composition, HTTP routing, capability-path and Host/Origin checks, static assets, compression, queries, diagnostics, repository memory, revision SSE, CLI output streams, live-reload WebSockets, Copilot authoring, and the durable command executor. The canvas extension is only a transport and trusted-host approval adapter; it does not implement operator commands or query semantics. JavaScript remains in the Actions pipeline and browser UI, not the operator runtime. The listener binds to loopback by default. Use `--port` or `--host` to override its address. `--data-backend indexeddb` retains browser-ingestion previews through the same Go listener; SQLite is the default.

### Hosted server: PostgreSQL with reviewed operational storage

Hosted deployments retain their explicit Go entry point:

```bash
go -C server run ./cmd/cao-dashboard serve-hosted --operational-store redis --policy .github/workflows/cao.redis.json
go -C server run ./cmd/cao-dashboard serve-hosted --operational-store memory --policy .github/workflows/cao.memory.json
```

The policy paths above are examples: supply an existing reviewed host policy or
deployment profile selecting that backend. `--policy` takes precedence over
`CAO_POLICY_PATH` and `CAO_MARKETPLACE_POLICY_PATH`; otherwise the catalog's
`.github/workflows/cao.json` is used. The selector checks the resolved policy,
including profile imports, and never rewrites it or overrides its authority.

Hosted mode runs `serve-hosted` in one owning process. It requires Go,
PostgreSQL, a built dashboard (`npm run dashboard:server:build`), and the normal
hosted OAuth, authorization, and HTTPS/proxy configuration. Use `--site` to select
another built site, `--host`/`--port` for the listener, and `--cert`/`--key` for
direct TLS. Redis remains the default operational backend in host policy; memory
requires its explicit single-process and volatility acknowledgements and
co-resident workers when collection is enabled. Memory mode does not require
Redis and loses operational state on restart.

PostgreSQL owns canonical dashboard entities and query execution in both modes.
The browser never receives database credentials. Canvas, local artifact
download (`--repo`), replacement, and preview trace options are not available in
hosted mode. The separate `gh cao dashboard serve` command selects the local SQLite preview described
above. See [`../server/README.md`](../server/README.md) for hosted configuration,
webhooks, backfill, and recovery guarantees.

The preview composes `dashboard/site/dashboard.json` with every installed `<campaign>/dashboard.json` document. Those authoring documents may list feature-oriented JSON fragments through their top-level `fragments` array; the preview watches both roots and fragments. It serves a split core `dashboard.json` plus per-page `dashboard-pages/*.json` chunks, and sends the updated core document over a capability-protected WebSocket after a valid update. The browser re-renders that shell without reloading the page while continuing to use the downloaded report data. Invalid dashboard JSON is reported in the terminal while the last valid preview remains available.

### Canvas CLI actions

Dashboard documents may declare local admin and trusted canvas CLI actions.
They are hidden from the published site and ordinary local previews. In the
dashboard canvas, each
action appears in the **Actions** menu for a command preview. Native execution
also requires independent confirmation in the trusted Copilot host, bound to
the exact resolved command, working directory, and standard input. A page POST
alone cannot authorize execution. Approval authorizes only the exact queued invocation; hosts without interactive
elicitation fail closed. Approved commands run in the server-owned queue, not
the browser request. Closing a terminal or browser detaches its output stream
without canceling approved work. Pending approvals do not authorize execution.

### CLI command queue

The built-in campaign update and repository upgrade actions include a quoted
`--pr-message` (gh-aw v0.92.4 or later). Generated pull requests explain that they
were requested through CAO, identify the affected campaign or repository and the
reason for maintenance, and link back to the CAO project and dashboard. The
message is part of the declarative command shown for approval; existing
pull-request creation and auto-merge choices are unchanged. Backlinks use the
actual control repository and published dashboard URL, not the CAO catalog's
deployment.

Command text supports literal `{{field}}` substitutions for validated row
values. Three reserved placeholders come from the host, never browser-supplied
row values: `{{cao-url}}` is the public dashboard base URL (with a trailing
slash), `{{cao-repository}}` is its control repository slug, and
`{{cao-repository-url}}` is that repository's GitHub URL. For example:

```text
gh aw upgrade --repo {{repository}} --pr-message 'Requested through {{cao-repository}}. See {{cao-url}}#page-maintenance.'
```

Local executable previews resolve the published URL from the control
repository's GitHub Pages API. For a custom-hosted dashboard, pass
`--cao-url https://ops.example.com/central/` to the local server or set
`CAO_DASHBOARD_URL` (also available to the canvas extension). URLs must use
HTTPS and contain no credentials, query, fragment, whitespace, or command
delimiters. Public dashboards use their own page base URL. Local preview
capability URLs are never copied into PRs. Missing host context disables the
action with an explicit message; queue admission rejects missing or overridden
host context. Substitutions are literal, not expressions, and never run a shell.

Local admin and trusted canvas sessions share one durable FIFO queue per
checkout, stored in `.cao/cli-actions.sqlite`. The online dashboard and ordinary
read-only previews do not initialize a queue or request its APIs. Execution
continues while the local server is running, even with every browser closed.
Stopping the server terminates running work; interrupted executions are recorded
as failed rather than silently repeated, and queued commands survive restart.
After an unclean crash, termination of detached subprocesses cannot be assumed:
the queue preserves history but pauses execution across subsequent restarts.
Verify that every interrupted subprocess has stopped before explicitly starting
with `--acknowledge-command-recovery` to resume queued work. Interrupted entries
remain failed and are never automatically retried. This acknowledgement is a
local operator action, not a browser API.

**Maintenance → Commands** lists queued, running, completed, failed, canceled,
and timed-out commands. Attach by command ID to replay retained stdout/stderr
and follow new output. Cancel explicitly to terminate work; Retry creates a new
entry linked to a failed or timed-out command.

The Go command service runs displayed `gh aw` and native `gh cao` commands in a
pseudo-terminal, capturing colors even when gh-aw requires TTY detection.
Legacy declared `./cao.sh` actions resolve to the installed Go operator; the
operator never launches the Actions JavaScript runtime. No npm installation is required.
The pseudo-terminal combines stdout and stderr in terminal order. Authentication,
JSON preparation, and stdin-backed commands retain separate pipes. Color settings
apply only to displayed commands, not authentication or JSON preparation reads.
The browser terminal preserves standard, bright, 256-color, and true-color
sequences across chunks and retained replay on both stdout and stderr; stderr
is not automatically recolored because it also carries progress and status.
Copying a transcript removes ANSI formatting without changing the terminal or
retained output; copying a pull-request result still copies only its URL.
GitHub CLI prompts and pagers are disabled. These terminal settings do not
change the parent shell environment.

The queue defaults to four concurrent executions (configure with
`--command-concurrency 1..32`) and a 15-minute execution deadline, beginning when
a command starts. GitHub-dependent work uses the existing
Go GitHub quota service in process, refreshing quota with the same
GitHub CLI authentication context as execution. Missing quota evidence pauses
starts instead of bypassing protection. Running commands are not terminated
merely because quota falls. A source checkout can run the helper with Go.
Installed runtimes require a prebuilt `cao-cli-quota` on `PATH` or selected by
`CAO_CLI_QUOTA_EXECUTABLE`; without it GitHub-dependent work remains paused.

The capability-protected local API exposes:

- `POST __cli_commands`: enqueue a declared action; an `Idempotency-Key` header
  or `idempotencyKey` field deduplicates repeated requests.
- `GET __cli_commands`: list commands with `status`, `limit`, and `offset`.
- `GET __cli_commands/:id`: retrieve persistent execution details.
- `GET __cli_commands/:id/output?after=N`: replay and stream ordered output
  after sequence `N` as newline-delimited JSON.
- `POST __cli_commands/:id/cancel` and `POST __cli_commands/:id/retry`: explicit
  lifecycle operations; retries revalidate the current action and approval.

The `status` filter accepts one status or a comma-separated set; filtering and
the matching total count are applied before pagination.
Mutations require same-origin JSON requests as well as the preview capability.
Queue retention defaults to 30 days and removes terminal history only in wholly
expired UTC Monday-based seven-day windows, including while idle; active commands never expire. Queue
files contain operational command history and must remain local and uncommitted.
Storage is bounded to 10,000 retained entries, 1 MiB output per command, 64 MiB
retained output overall and a 128 MiB main SQLite database (excluding WAL
overhead). Output is framed by line for cross-chunk credential redaction;
overlong lines above 16 KiB and output beyond the budgets are discarded with an
explicit truncation warning. Terminal output can therefore lag until a line
ends or execution finishes.

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

Commands must be single-line `gh aw ...` or `gh workflow run <workflow> ...`
invocations; the latter triggers workflows that declare `workflow_dispatch`.
Workflow dispatch actions may set `--repo`, `--ref`, and non-file-backed inputs
with `--raw-field` (`-f`). File-reading forms such as `--field` (`-F`) are
rejected. The canvas extension runs GitHub CLI directly without a shell and
supplies the user-approved `GITHUB_TOKEN` as `GH_TOKEN` to that process. For
`gh aw` commands, it also derives an ephemeral
author and committer identity from the currently authenticated GitHub CLI user
so pull-request actions can create commits without changing global or
repository Git configuration. When `gh aw` is unavailable, an approved action first attempts
`gh extension install github/gh-aw`. If that installation fails, it downloads
and runs the installer version declared by `gh-aw-version` in
`.github/workflows/cao.json` from the official `github/gh-aw`
repository, then verifies `gh aw` before continuing. Boolean action arguments
render as checkboxes and may append only their declared
canonical long option to the command preview and executed argv.

The canvas accepts prompts up to 100,000 UTF-16 code units and bounds each JSON
request to 1 MiB, including JSON escaping and UTF-8 overhead. Oversized requests
are rejected before approval or execution.

Catalog contributors can run `npm run dashboard:local`; the same server discovers top-level campaign `dashboard.json` files automatically. Pass a control repository explicitly with `npm run dashboard:local -- --repo OWNER/REPOSITORY`.

To reproduce the deployed dashboard's mobile DOM budget locally with live Pages data, run:

```bash
npm run dashboard:local:mobile
```

This starts the local preview through Playwright with the Pixel 7 profile and a 256 MiB V8 heap limit, then records DOM analysis, accessibility, trace, and screenshot evidence under `test-results/chromium-low-memory/`. The check fails when the rendered page exceeds 6,000 elements.

## Standalone Pages site

Before running the standalone deployment, run `gh cao setup` in the control repository. It configures the Pages source as GitHub Actions and requires repository-restricted access for a private repository. If your plan does not support private Pages or you cannot manage Pages settings, setup fails rather than proceeding with a public dashboard. For an already configured review repository, verify the same settings:

1. In **Settings > Pages**, confirm **GitHub Actions** is the source.
2. Confirm site access is restricted to the intended audience.
3. Protect the `github-pages` environment as required by your organization.

The workflow passes `enablement: false` to `actions/configure-pages`, so a run validates existing Pages configuration but never enables Pages for the repository. The deploy job also refuses to publish a private repository's dashboard to a public Pages site.

Use **Refresh** in the dashboard header to open **Central Agentic Ops Dashboard** on the repository's **Actions** page, then click **Run workflow**. The build restores the latest complete schema-versioned activity snapshot and normalizes its usage records into the dashboard tables without triggering collection or indexing. Run **CAO Activity** separately when a fresh snapshot is required. The standalone workflow is deliberately not scheduled, so installing the campaign cannot replace an existing Pages deployment without an explicit run. Operational-value collection preserves the ordered native metrics already present in retained gh-aw run records. Actions caches accelerate refreshes but are evictable and are not historical authority.

The catalog contains the collector, adapter, presenter, and runtime sources at the same paths used by control repositories. Control repositories generate the current access-controlled Pages view. Live organization-specific JSON, Markdown, and SVG snapshots are generated data and are not committed to this catalog.

## Configure

1. Set `control-plane.scope.allowed-repositories` in `.github/workflows/cao.json` when report discovery should be limited to an explicit repository allowlist.
2. Set `control-plane.campaigns.dashboard.deploy` to `false` when another workflow downloads the `central-agentic-ops-dashboard` artifact and includes it in a combined Pages deployment. The default is `true`.

With standalone deployment disabled, the hosting workflow needs `actions: read`. It should list successful `cao-dashboard.yml` runs on the default branch, select the latest run, and download its `central-agentic-ops-dashboard` artifact into the hosting site's output directory before uploading the combined Pages artifact.

Do not install this campaign when the report would be public or when the repository plan cannot enforce the required access boundary. See [Publishing Pages Reports](../docs/operations.md#publishing-pages-reports) for operating details.
