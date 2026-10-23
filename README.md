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

Install the **`gh cao` extension** with GitHub CLI, then open guided setup
from the root of an existing control-repository checkout:

```bash
gh extension install githubnext/gh-cao
gh cao setup
```

Git and authenticated GitHub CLI 2.68+ are required. Native setup prepares
missing gh-aw, runtime files, and baseline policy without installing Node.js
or adding or running a campaign.

> [!TIP]
> **SAML-token installation failure:** If GitHub CLI cannot download the extension
> because your token lacks cross-organization SAML authorization, use the
> [curl installer](docs/cao-cli.md#control-plane-installer):
> `curl -fsSL https://raw.githubusercontent.com/githubnext/gh-cao/main/install-gh-cao.sh | bash -s -- --setup`.
> This fallback requires Bash, curl, and Node.js 24+; public tool downloads are
> anonymous, while stored credentials remain available for control-repository
> and runtime-provenance operations.

No checkout yet? Explicitly use `gh repo create OWNER/CONTROL --private --clone`
or `gh repo clone OWNER/CONTROL`, then `cd CONTROL` before installation. Choose
`--public` instead only for public evidence. A private control repository
requires credentials even when its other targets are public.

Follow [Set Up CAO](docs/setup-quickstarts.md) for scope, authentication,
publication, and the first dashboard visit. Setup offers a separate default-No
commit-and-push prompt; declining or unattended setup leaves files local.
Publication returns **deployment pending**, not a ready dashboard.
**No campaign is installed or run.** An empty dashboard is expected when there
is no Agentic Workflow history.

Use a private control repository for non-public evidence. A private repository
does **not** guarantee a private Pages site: verify dashboard visibility before
publishing.

**Optional, later:** describe your outcome and scope in
[From Outcome to Execution](docs/operation-patterns.md), then try the
[Daily Repo Status quickstart](docs/setup/quickstart.md) or the
[Repo Assist review walkthrough](docs/repo-assist-quickstart.md).
Campaigns are one first-class way to scale recurring work, not a prerequisite.
Start with one repository in `review`; live outputs need explicit reviewed
policy and declared safe-output capabilities. You can also read
[real Repo Assist reports](repo-assist/README.md#see-repo-assist-in-action)
without starting a workflow or spending AI credits.

## Project status and scope

Central Agentic Ops extends
[GitHub Agentic Workflows](https://github.github.com/gh-aw/) with a catalog of
reusable campaigns and a central control plane for policy-governed operations.
It does not replace repository permissions, branch protections, or human review.

See the [open issues](https://github.com/githubnext/gh-cao/issues) for current
work and planned improvements.

### GitHub CLI extension

The compiled `gh cao` extension handles setup, authentication, campaigns,
diagnostics, and read-only evidence analysis without local Go or Node.js:

```bash
gh cao --help
gh cao --version
```

See [CAO Commands](docs/cao-cli.md) for installation and upgrades, command
selection, runtime provenance, and the Go/Node boundary. Operators use `gh cao`;
workflow agents and Activity/Dashboard Actions use `node activity/cao.mjs`.
The plugin and contributor tooling are not part of the installed control-plane
runtime. For local extension development, see
[Contributing](CONTRIBUTING.md#go-extension-development).

## Documentation

Read the [documentation site](https://githubnext.github.io/gh-cao/), or start
with the guide for your task:

| Task | Guide |
| --- | --- |
| Understand CAO and its boundaries | [What is CAO?](docs/architecture-at-a-glance.md) and [Architecture](docs/architecture.md) |
| Install and monitor existing workflows | [Set Up CAO](docs/setup-quickstarts.md) |
| Choose and provision credentials | [Authentication](docs/authentication.md) and [credential setup](docs/control-plane-authentication.md) |
| Choose dashboard hosting | [Deployment options](docs/deployment.md) |
| Interpret evidence | [Dashboard](docs/dashboard.md) |
| Add shared work | [From Outcome to Execution](docs/operation-patterns.md) and [campaign catalog](https://githubnext.github.io/gh-cao/catalog/) |
| Operate, update, or recover | [Monitor and recover](docs/operations.md) |

For coding agents, use
[`llms.txt`](https://githubnext.github.io/gh-cao/llms.txt) for navigation and
high-value routes,
[`llms-small.txt`](https://githubnext.github.io/gh-cao/llms-small.txt) for
compact context, or
[`llms-full.txt`](https://githubnext.github.io/gh-cao/llms-full.txt) for the
broad documentation corpus.

## Agent plugin and Requirements

This repository is an [Agent Plugins 1.0](https://agent-plugins.org/) plugin,
with portable skills for setup, debugging, campaign authoring, and analysis.
In Copilot CLI it also provides a **Central Agentic Ops** canvas.
See [Agent plugin and Copilot canvas](docs/agent-plugin.md) for installation,
requirements, query authoring, approved commands, and the local trust boundary.

For previews outside Copilot, use the
[local serving guide](docs/dashboard-data-ingestion.md#choose-a-local-serving-mode).
Hosted deployment is separate; see the [Go server guide](server/README.md).

## GitHub Pages setup

Guided setup configures Pages with **GitHub Actions** as its source and checks
public-publication consent. Successful default-branch **CAO Activity** runs
automatically trigger **CAO Dashboard**; manual dashboard rebuilds are also
available. The workflow itself does not enable Pages.
See [GitHub Actions deployment](docs/deployment-actions.md) for publication,
visibility, retention, and stopping or recovering the site.

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
