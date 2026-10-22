# Central Agentic Ops

> [!NOTE]
> **Research prototype:** Features and interfaces may change as the project evolves.

> [!TIP]
> **Agent setup router:** When asked to create, bootstrap, initialize, or set up a Central Agentic Ops control plane, load and follow [the setup skill](skills/setup-cao/SKILL.md). Use a separate control repository by default; any repository may explicitly run workflows it maintains in-tree as a source-managed control plane, including a catalog dogfooding its own workflows.

> [!TIP]
> **Agent debugging router:** When a CAO deployment, credential, Agentic Workflow, Activity collection, or dashboard build fails, load and follow [the `debug-cao` skill](skills/debug-cao/SKILL.md). Preserve the failing workflow commit and exact component versions before changing or rerunning the deployment.

Monitor GitHub Agentic Workflow runs, costs, and outcomes from one control
repository. Add trusted agentic operations when you are ready.

## Get started: monitor one repository

From the root of an existing control-repository checkout, install **gh-aw and
gh-cao** and open guided setup:

```bash
curl -fsSL https://raw.githubusercontent.com/githubnext/gh-cao/main/install-gh-cao.sh | bash -s -- --setup
```

The installer requires Bash, curl, Node.js 24+, Git, and authenticated GitHub CLI
2.68+. It uses the upstream [gh-aw installer](https://github.com/github/gh-aw/blob/main/install-gh-aw.sh)
and installs the checksum- and version-verified `gh cao` Go extension.
Public tool release discovery and downloads are anonymous, so enterprise
SAML-restricted tokens do not need cross-organization release access.
Existing GitHub credentials remain available for control-repository operations.
The installer prepares the baseline runtime and missing policy without adding
or running a campaign. Omit `--setup` to configure later with `gh cao setup`.

No checkout yet? Explicitly use `gh repo create OWNER/CONTROL --private --clone`
or `gh repo clone OWNER/CONTROL`, then `cd CONTROL` before installation. Choose
`--public` instead only for public evidence. A private control repository
requires credentials even when its other targets are public.

Interactive setup shows the CAO file summary, policy diff, and full-diff path,
then asks **“Commit and push these CAO monitoring changes? [y/N]”**. Approval
publishes only reviewed CAO files from the synchronized default branch with an
empty Git index. No force-push or branch-protection bypass. Setup returns
immediately with Actions and dashboard links marked **deployment pending**;
it never waits for collection or deployment.

Declining, blocked publication, and unattended setup leave files local.
Run `gh cao doctor` afterward. If not published, review and publish manually:

```bash
git status --short
git diff -- .github
git add .github activity dashboard
git commit -m "Set up CAO monitoring"
git push
```

On upgrades, also review and stage the retired shell launcher's deletion if Git
reports it. Only known shipped launchers are removed; consumer-owned scripts are preserved.

In Actions, check **CAO validation**, **CAO Activity**, and **CAO Dashboard**,
including its Pages deployment. The dashboard becomes ready asynchronously.
**No campaign is installed or run.** A repository without Agentic Workflow
history starts with an empty dashboard; you do not need to generate activity.

The [getting-started guide](docs/setup-quickstarts.md) covers prerequisites,
creating a separate control repository, authentication, dashboard visibility,
and your first look at the data. Prefer a private control repository for
non-public evidence; a private repository does not guarantee a private dashboard.

**Optional, later:** describe the outcome and scope using
[From Outcome to Execution](docs/operation-patterns.md), browse the
[campaign catalog](https://githubnext.github.io/gh-cao/catalog/)
or try one standalone report with the [Repo Status quickstart](docs/setup/quickstart.md).
For the campaign pattern, follow the manual
[Repo Assist review walkthrough](docs/repo-assist-quickstart.md).
You can also read [real Repo Assist reports](repo-assist/README.md#see-repo-assist-in-action)
without starting a workflow or spending AI credits.

Control repositories receive only the curated production runtime, not dashboard
tests, screenshots, contributor tooling, or plugin files. The CLI and runtime
keep their canonical paths under `activity/`, `dashboard/`, and `.github/`.
Normal installation downloads a prebuilt archive for gh-aw's exact resolved
SHA and verifies signed build provenance before replacing runtime files; it
does not run npm. Stable versions use release assets, while main/SHA installs
use successful Actions artifacts retained for 90 days and wait up to five
minutes for an already active exact-SHA runtime build. An authenticated GitHub
CLI with artifact and attestation access is required for runtime materialization;
this is separate from anonymous public tool downloads.
The installer requires local Node.js 24+; installed Go commands do not.
Dashboard builds retain their existing production npm dependencies.

Central Agentic Ops governs shared **operations**, not one mandatory
orchestration recipe. Describe the outcome, target scope, and execution
requirements; guidance and authoring agents derive the simplest suitable
structure and explain it. You do not need to choose an implementation-pattern
name. Campaigns remain a first-class way to package and scale recurring work,
not a prerequisite.

[From Outcome to Execution](docs/operation-patterns.md) maps those requirements
to direct operations, bounded fleet workflows, or independent campaign workers,
and explains when ordinary GitHub Actions or observation alone is enough.
All participating patterns retain explicit scope, review/live ceilings, and
gh-aw's execution and safe-output boundaries.

## Project status and scope

Central Agentic Ops extends
[GitHub Agentic Workflows](https://github.github.com/gh-aw/) with a catalog of
reusable campaigns and a central control plane for policy-governed operations.
It does not replace repository permissions, branch protections, or human review.

See the [open issues](https://github.com/githubnext/gh-cao/issues) for current
work and planned improvements.

### GitHub CLI extension

GitHub CLI installs the compiled `gh cao` Go extension for
setup, authentication, campaigns, diagnostics, and read-only evidence analysis.
No local Go build is needed:

```bash
gh cao --help
gh cao --version
```

Rerun the root `install-gh-cao.sh` to refresh the extension. Runtime updates
remain separate (`gh cao update --campaign root`). GitHub-CLI-managed
installations can still use `gh extension upgrade gh-cao`, but that authenticated
cross-organization release path can fail with enterprise SAML-restricted tokens.
For local development, `make build` produces `./gh-cao`.

Use `gh cao setup` for guided configuration or
`gh cao setup auth github-app|enterprise-app|token` for authentication only.
Every extension command executes natively in Go, including onboarding,
authentication, repository enrollment, validation, downloads, Dashboard Language
queries, computations, and MCP. No Node.js installation or JavaScript runtime
checkout is needed. The binary embeds the reviewed dashboard definitions and
reads canonical SQLite snapshots directly; use `--dashboard FILE` to select
an explicit dashboard document. Run policy mutations from the control repository root.
Help, version, and catalog discovery work offline.

Activity and Dashboard Actions invoke `node activity/cao.mjs <command>` directly;
operator commands use `gh cao`. There is no shell launcher.
SQLite snapshot repair and hosted-CLI App setup remain Node-only.
Releases include version-stamped
binaries named `gh-cao-OS-ARCH` (`.exe` on Windows) for Linux, macOS, and Windows
(amd64 and arm64), plus SHA-256 checksums.
The installer selects the latest published `vX.Y.Z` release, including prereleases
but excluding drafts, and also verifies older releases' legacy `OS-ARCH` assets.
See [the command reference](docs/cao-cli.md#github-cli-extension) for the migration
boundary and [extension development](CONTRIBUTING.md#go-extension-development)
for local installation, project layout, and checks.

## Documentation

Ready to explore? [See the docs](https://githubnext.github.io/gh-cao/).

For coding agents, use
[`llms.txt`](https://githubnext.github.io/gh-cao/llms.txt) for navigation and
high-value routes,
[`llms-small.txt`](https://githubnext.github.io/gh-cao/llms-small.txt) for
compact context, or
[`llms-full.txt`](https://githubnext.github.io/gh-cao/llms-full.txt) for the
broad documentation corpus.

## Agent plugin and Requirements

This repository is an [Agent Plugins 1.0](https://agent-plugins.org/) plugin. It exposes the portable `setup-cao`, `debug-cao`, `add-cao-campaign`, `create-cao-campaign`, `analyze-cao`, and `cao-cli` skills.

Install this repository using any [compatible client's](https://agent-plugins.org/compatible-clients) plugin installer, then invoke `setup-cao` to create a control plane from scratch, `debug-cao` to diagnose deployment failures and prepare evidence-rich issues, `add-cao-campaign` to discover and safely install an existing catalog campaign, `create-cao-campaign` with an outcome, target scope, and execution requirements (it checks whether a campaign is needed first), `analyze-cao` to download and query CAO activity data with the `cao` CLI, or `cao-cli` for a general reference on using `cao` in local development and inside agentic workflow runs.

The Markdown and Starlight documentation is authoritative. The `llms*.txt`
resources are generated by the documentation build and must not be edited or
committed manually. The documentation auditor evaluates whether agents can find
the authoritative material; it does not define product behavior. Architecture
and specification changes belong in their source documents.

In Copilot CLI, the plugin also provides a **Central Agentic Ops** Canvas. Open it to start the repository's local dashboard preview, optionally for a specified `OWNER/REPOSITORY`. The extension gives the agent tools to execute declarative queries with the canonical dashboard query engine and read bounded sections of the dashboard data architecture specification.

The plugin must be enabled in the client; the `com.github.copilot/extensions/`
bundle is not automatically discovered as a repository-local extension. The
canvas requires GitHub CLI authentication with Actions read access and a current
`central-agentic-ops-dashboard` artifact from a successful dashboard run. It
uses only the installed plugin's server, query engine, specification, and site;
it never imports executable modules from the active checkout. When necessary it
stages the bundled site in a temporary workspace directory without relaxing the
local server's path restrictions. Workspace campaign documents remain JSON
data. Closing the canvas or stopping/reloading the extension removes its
temporary preview files and prevents new previews from starting.

Canvas previews ingest the downloaded inventory and Activity shards into a
temporary server-side SQLite projection in an isolated data worker. The page
uses the remote HTTP query backend, not browser IndexedDB; declarative queries,
pagination, diagnostics, and revision subscriptions stay behind the preview's
capability URL. Ordinary non-canvas local previews default to the static browser
backend. Select either backend explicitly with
`npm run dashboard:local -- --data-backend sqlite --repo OWNER/REPOSITORY` or
`--data-backend indexeddb`. The canvas open input also accepts
`dataBackend: "sqlite"` or `"indexeddb"`. SQLite initialization failures stop
startup rather than silently falling back to IndexedDB.

Canvas startup also reads compiler metadata from the default-branch lock files
of workflows already present in the downloaded inventory, through its
read-only GitHub API service. Reads are cached per credential and limited to
128 distinct files with eight concurrent requests. The API returns only file
identity and the parsed compiler version, never workflow contents or credentials.
Unavailable or stale reads retain snapshot versions without fabricating fresh
installed-version evidence. Upgrade is hidden only when recorded versions are known current;
missing installed-version or release evidence keeps the action available.

`--data-backend postgres` selects the existing Go/PostgreSQL server, with
PostgreSQL operational storage by default; `--operational-store` may select
Redis or memory instead. This mode requires the reviewed host policy, built
site, database, and OAuth/HTTPS configuration described in
[the server guide](server/README.md), and does not support canvas preview mode.

CLI actions are approved in the canvas's command-review dialog; there is no
second host confirmation prompt or interactive-elicitation requirement.
The server still validates each declared action and its resolved command, binds
execution to the preview's working directory, and executes without a shell.
Installing the complete plugin bundle is required; the extension folder alone
is not a standalone package.

For extension changes, run `npm run typecheck:copilot` and the focused
`tests/unit/dashboard-extension.test.mjs` and
`tests/unit/dashboard-local-preview.test.mjs` tests. These exercise the SDK
declarations, registered tools, workspace layouts, and preview cleanup.
`npm run check:agent-plugin` validates portable skill metadata, package
containment, relative documentation links, and required bundled resources. It
runs during lint and pull-request checks, alongside the plugin installation
smoke test.

## GitHub Pages setup

The default Central Agentic Ops campaign installs the dashboard builder and manual Pages publisher. Before running **Central Agentic Ops Dashboard** for the first time:

1. Open **Settings > Pages** in the control repository.
2. Under **Build and deployment**, set **Source** to **GitHub Actions**.
3. Optionally, restrict Pages access to the intended audience if your plan supports private Pages; the dashboard can also be published publicly.

The dashboard workflow remains manual and does not enable Pages automatically.

## Agent analysis

Central Agentic Ops can give an agent its dashboard data without a browser or
shell. Install CAO, run `gh cao download`, and then either query the snapshot from
a shell with `gh cao pages`, `gh cao queries`, and `gh cao query QUERY_ID`, or start the
read-only MCP server with `gh cao mcp` and let an agent call `cao_catalog` and
`cao_query`. See [Agent analysis](docs/agent-analysis.md) for the GitHub Actions
bootstrap.

## Contributing

Contributions and issue reports are welcome. Read
[CONTRIBUTING.md](CONTRIBUTING.md) and our
[Code of Conduct](CODE_OF_CONDUCT.md) before participating.

## Maintainers

Central Agentic Ops is maintained by [GitHub Next](https://github.com/githubnext).
Ownership rules are recorded in [.github/CODEOWNERS](.github/CODEOWNERS).

## Support

See [SUPPORT.md](SUPPORT.md) for help and support expectations. Report suspected
security vulnerabilities privately by following [SECURITY.md](SECURITY.md).

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for the
full terms.
