# Central Agentic Ops

<span id="project-status-and-scope"></span>

> [!NOTE]
> **Research prototype:** Features and interfaces may change as the project evolves.

> [!TIP]
> **Agent setup router:** When asked to create, bootstrap, initialize, or set up a Central Agentic Ops control plane, load and follow [the setup skill](skills/setup-cao/SKILL.md). Use a separate control repository by default; any repository may explicitly run workflows it maintains in-tree as a source-managed control plane, including a catalog dogfooding its own workflows.

> [!TIP]
> **Agent debugging router:** When a CAO deployment, credential, Agentic Workflow, Activity collection, or dashboard build fails, load and follow [the `debug-cao` skill](skills/debug-cao/SKILL.md). Preserve the failing workflow commit and exact component versions before changing or rerunning the deployment.

Monitor [GitHub Agentic Workflow](https://github.github.com/gh-aw/) runs, costs,
and outcomes from one control repository. Add policy-governed operations when
you are ready; CAO does not replace repository permissions, branch protections,
or human review.

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
`--public` instead only for public evidence.

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

## Documentation

Read the [documentation site](https://githubnext.github.io/gh-cao/), or start
with the guide for your task:

| Task | Guide |
| --- | --- |
| Understand CAO and its boundaries | [What is CAO?](docs/architecture-at-a-glance.md) and [Architecture](docs/architecture.md) |
| Install and monitor existing workflows | [Set Up CAO](docs/setup-quickstarts.md) |
| Use or upgrade the CLI | <span id="github-cli-extension"></span>[CAO Commands](docs/cao-cli.md) |
| Choose and provision credentials | [Authentication](docs/authentication.md) and [credential setup](docs/control-plane-authentication.md) |
| Host the dashboard | <span id="github-pages-setup"></span>[Deployment options](docs/deployment.md) and [GitHub Pages](docs/deployment-actions.md) |
| Interpret evidence | [Dashboard](docs/dashboard.md) |
| Analyze evidence with CLI or MCP | <span id="agent-analysis"></span>[Agent analysis](docs/agent-analysis.md) |
| Install skills or use a Copilot canvas | <span id="agent-plugin-and-requirements"></span>[Agent plugin and canvas](docs/agent-plugin.md) |
| Preview locally | [Local serving modes](docs/dashboard-data-ingestion.md#choose-a-local-serving-mode) |
| Add shared work | [From Outcome to Execution](docs/operation-patterns.md) and [campaign catalog](https://githubnext.github.io/gh-cao/catalog/) |
| Operate, update, or recover | [Monitor and recover](docs/operations.md) |

For agents: [`llms.txt`](https://githubnext.github.io/gh-cao/llms.txt) for
navigation, [`llms-small.txt`](https://githubnext.github.io/gh-cao/llms-small.txt)
for compact context, and [`llms-full.txt`](https://githubnext.github.io/gh-cao/llms-full.txt)
for the full corpus.

<span id="contributing"></span>
<span id="maintainers"></span>
<span id="support"></span>

## Contributing and support

Read [Contributing](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md).
Use [open issues](https://github.com/githubnext/gh-cao/issues) and
[Support](SUPPORT.md) for help; report vulnerabilities privately through
[Security](SECURITY.md). Maintained by [GitHub Next](https://github.com/githubnext),
with ownership in [CODEOWNERS](.github/CODEOWNERS).

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for the
full terms.
