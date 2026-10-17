# Central Agentic Ops

> [!NOTE]
> **Research prototype:** Features and interfaces may change as the project evolves.

> [!TIP]
> **Agent setup router:** When asked to create, bootstrap, initialize, or set up a Central Agentic Ops control plane, load and follow [the setup skill](skills/setup-cao/SKILL.md). Use a separate control repository by default; any repository may explicitly run workflows it maintains in-tree as a source-managed control plane, including a catalog dogfooding its own workflows.

> [!TIP]
> **Agent debugging router:** When a CAO deployment, credential, Agentic Workflow, Activity collection, or dashboard build fails, load and follow [the `debug-cao` skill](skills/debug-cao/SKILL.md). Preserve the failing workflow commit and exact component versions before changing or rerunning the deployment.

Run trusted agentic operations across your repository fleet from one central control plane.

Start the [step-by-step onboarding guide](docs/setup-quickstarts.md) with:

```bash
curl --fail --silent --show-error --location \
  https://raw.githubusercontent.com/githubnext/gh-aw-cao/main/install.sh |
  bash -s -- --quickstart \
    --create-repo CONTROL_OWNER/CONTROL_REPOSITORY \
    --target TARGET_OWNER/TARGET_REPOSITORY
```

At a repository root, the installer uses that clean default-branch checkout,
including headlessly; omit `--create-repo` when using that existing checkout.
Outside a checkout, explicitly choose the private control repository to create.
Replace the uppercase coordinates with your choices: no owner, repository name,
or target is suggested or selected by default. Interactive `--create-repo`
without a coordinate asks you to enter an owner and name without defaults;
headless creation requires the full coordinate. Occupied names are rejected,
not renamed automatically.
With no catalog source, quickstart resolves and pins
the latest stable CAO `vX.Y.Z` release; it does not fall back to `main` if
release discovery fails. Pass an explicit source such as
`githubnext/gh-aw-cao@main`, a tag, a commit SHA, or a local checkout to override
that catalog selection. Installation requires `--target OWNER/REPO` to select an
existing public repository explicitly, using Repo Assist's normal checkout.
Repo Assist proposes one small, validated maintenance improvement in review
mode, or honestly records a no-op if nothing suitable fits.
It works even when the target has no Agentic Workflows or Actions history.
Quickstart runs the existing maintenance worker, not a special assessment.
A control review issue and downloadable patch bundle let you decide whether
to apply the improvement.
Installation configures and commits the control plane, then stops with Repo
Assist paused. Continue from the printed control-repository directory:

1. **Run:** `./cao.sh quickstart --step run` requests one review and returns an
   Actions link. Inspect the orchestrator and maintenance worker there.
2. **Collect:** after the worker finishes, `./cao.sh quickstart --step collect`
   requests an Activity snapshot and returns without waiting.
3. **Explore:** `./cao.sh quickstart --step dashboard` checks publication
   read-only. Repeat this check if pending, then open the verified dashboard.

Each step explains a different component; there is no long default terminal
wait. Normal Activity push/schedule triggers may publish a baseline independently;
the collect stage refreshes evidence after your review.
The review issue is the first useful result. Starting the campaign can use
up to 1,250 AI credits under default limits (250 orchestration + 600 maintenance
+ 400 output checking; configured output-check limits may differ), not a
measured token budget or expected consumption.
**None of these proposals is a requirement for using CAO.** There are no
readiness grades, required templates, or practice checklists; keeping the
repository unchanged is a valid result. Only maintenance is enabled; quickstart
pauses the orchestrator after dispatch so recurring runs need explicit re-enablement.
CAO never modifies the target.
Remote jobs continue in GitHub Actions between stages. Use `--wait` on
`./cao.sh quickstart --target OWNER/REPO` only to explicitly opt into the original end-to-end flow
immediately after bare installation, not to resume or check a staged run.
Use `--create-repo OWNER/CONTROL_REPOSITORY` to choose a new control
repository explicitly.

Want to see the rest of Repo Assist before running more workers? Browse
[real triage, issue-fix, maintenance, and PR-upkeep reports](repo-assist/README.md#see-repo-assist-in-action)
from our own control plane. This separate showcase adds no workflows or AI
spend to your first run; it distinguishes proposals and blockers from applied
changes. No demo repository is created.

The installer checks tools, sign-in, and checkout readiness before writing CAO
files, adds gh-aw and the core runtime, and preserves an existing policy.
Without `--quickstart`, installation remains non-greedy: bare installation
stops with `Next: ./cao.sh setup`, and `--setup` opens
**Repositories → Connections → Review and apply** directly. Guided setup uses
default-No confirmation and never installs a campaign, dispatches a workflow,
commits, or pushes. Install the Agent Plugin separately when you want the
portable CAO skills.

Without an interactive terminal, or when `CI` is set, `--setup` and
`./cao.sh setup` apply one fail-closed agent profile only: the current control
repository must be public, existing scope must already be exact to that
repository, and campaigns must be empty. Setup configures public Actions-backed
Pages, selects the repository `GITHUB_TOKEN` (`workflow-token`), and records
Activity scope for only that repository. Private/internal repositories or
broader existing policy require interactive setup. Headless guided-setup
repository creation requires `--create-repo OWNER/NAME` for both guided setup
and quickstart; neither infers a control owner or name.
Missing prerequisites (including an installed gh-aw that is too old) fail
instead of reporting success. Explicit `--quickstart` is the bounded headless
onboarding path: installation performs the documented control-repository effects
without prompting; separate stage commands authorize workflow dispatches.

Control repositories receive only the curated production runtime, not dashboard
tests, screenshots, contributor tooling, or plugin files. The CLI and runtime
keep their canonical paths under `activity/`, `dashboard/`, and `.github/`.
Normal installation downloads a prebuilt archive for gh-aw's exact resolved
SHA and verifies signed build provenance before replacing runtime files; it
does not run npm. Stable versions use release assets, while main/SHA installs
use successful Actions artifacts retained for 90 days and wait up to five
minutes for an already active exact-SHA runtime build. Node.js 24+ and an
authenticated GitHub CLI with artifact and attestation access are still
required. Dashboard builds retain their existing production npm dependencies.

Central Agentic Ops provides persistent agentic campaigns that continuously pursue defined outcomes across explicit repository fleets without copying workflows into every repository.

- **Reach more repositories:** deterministically discover and batch inventories of 100,000+ repositories while keeping each run bounded.
- **Roll out with confidence:** review proposed outcomes away from the target, then promote each campaign independently to `live`.
- **Keep work accountable:** every worker stays scoped to one repository and links its outcome to the originating control-plane run.

## Project status and scope

Central Agentic Ops extends
[GitHub Agentic Workflows](https://github.github.com/gh-aw/) with a catalog of
reusable campaigns and a central control plane for explicit repository fleets.
It does not replace repository permissions, branch protections, or human review.

See the [open issues](https://github.com/githubnext/gh-aw-cao/issues) for current
work and planned improvements.

### GitHub CLI extension

The `gh cao` Go extension exposes the operator commands for setup,
authentication, campaigns, validation, and read-only evidence analysis.
Run `make build` to produce `./gh-cao`, then try `./gh-cao --help`.
Once a release containing extension binaries is promoted to latest, install
without building Go locally:

```bash
gh extension install githubnext/gh-aw-cao
gh aw-cao --help
```

GitHub CLI derives the installed command `gh aw-cao` from the repository name.
The local development installation can expose the same executable as `gh cao`.

Use `gh cao setup` for guided configuration or
`gh cao setup auth github-app|enterprise-app|token` for authentication only.
`campaigns add`, `init`, `campaigns mode`, `campaigns enable`, and
`campaigns disable` execute natively in Go; repository enrollment
(`repos add OWNER/REPO`) and other operator commands reuse the installed CAO Node.js 24+
runtime to preserve production
onboarding, policy, and Dashboard Language semantics. Run them from the control
repository root, or select an installed runtime with `CAO_RUNTIME_ROOT`.
Help, version, and the local `doctor` diagnostic need no CAO runtime.

Activity and Dashboard Actions retain their Node CLI and pipeline commands;
`cao.sh` and the installer remain compatible. Releases include version-stamped
binaries named `gh-cao-OS-ARCH` (`.exe` on Windows) for Linux, macOS, and Windows
(amd64 and arm64), plus SHA-256 checksums.
See [the command reference](docs/cao-cli.md#github-cli-extension) for the migration
boundary and [extension development](CONTRIBUTING.md#go-extension-development)
for local installation, project layout, and checks.

## Documentation

Ready to explore? [See the docs](https://githubnext.github.io/gh-aw-cao/).

For coding agents, use
[`llms.txt`](https://githubnext.github.io/gh-aw-cao/llms.txt) for navigation and
high-value routes,
[`llms-small.txt`](https://githubnext.github.io/gh-aw-cao/llms-small.txt) for
compact context, or
[`llms-full.txt`](https://githubnext.github.io/gh-aw-cao/llms-full.txt) for the
broad documentation corpus.

## Agent plugin and Requirements

This repository is an [Agent Plugins 1.0](https://agent-plugins.org/) plugin. It exposes the portable `setup-cao`, `debug-cao`, `add-cao-campaign`, `create-cao-campaign`, `analyze-cao`, and `cao-cli` skills.

Install this repository using any [compatible client's](https://agent-plugins.org/compatible-clients) plugin installer, then invoke `setup-cao` to create a control plane from scratch, `debug-cao` to diagnose deployment failures and prepare evidence-rich issues, `add-cao-campaign` to discover and safely install an existing catalog campaign, `create-cao-campaign` with an operational strategy and target-repository description, `analyze-cao` to download and query CAO activity data with the `cao` CLI, or `cao-cli` for a general reference on using `cao` in local development and inside agentic workflow runs.

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
shell. Install CAO, run `cao download`, and then either query the snapshot from
a shell with `cao pages`, `cao queries`, and `cao query QUERY_ID`, or start the
read-only MCP server with `cao mcp` and let an agent call `cao_catalog` and
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
