# Central Agentic Ops

> [!NOTE]
> **Research prototype:** Features and interfaces may change as the project evolves.

> [!TIP]
> **Agent setup router:** When asked to create, bootstrap, initialize, or set up a Central Agentic Ops control plane, load and follow [the setup skill](.github/skills/setup-central-agentic-ops/SKILL.md). Use a separate control repository by default; any repository may explicitly run workflows it maintains in-tree as a source-managed control plane, including a catalog dogfooding its own workflows.

Run trusted agentic operations across your repository fleet from one central control plane.

Central Agentic Ops packages reusable orchestrators and focused workers so platform teams can automate repository operations without copying workflows into every repository.

- **Reach more repositories:** deterministically discover and batch inventories of 100,000+ repositories while keeping each run bounded.
- **Roll out with confidence:** review proposed outcomes away from the target, then promote each package independently to `live`.
- **Keep work accountable:** every worker stays scoped to one repository and links its outcome to the originating control-plane run.

## Project status and scope

Central Agentic Ops extends
[GitHub Agentic Workflows](https://github.github.com/gh-aw/) with a catalog of
reusable operations and a central control plane for explicit repository fleets.
It does not replace repository permissions, branch protections, or human review.

See the [open issues](https://github.com/githubnext/gh-aw-cao/issues) for current
work and planned improvements.

## Documentation

Ready to explore? [See the docs](https://githubnext.github.io/gh-aw-cao/).

## Agent plugin and Requirements

This repository is an [Agent Plugins 1.0](https://agent-plugins.org/) plugin. It exposes the portable `setup-central-agentic-ops`, `create-ops-package`, `analyze-agentic-ops`, and `cao-cli` skills.

Install this repository using any [compatible client's](https://agent-plugins.org/compatible-clients) plugin installer, then invoke `setup-central-agentic-ops` to create a control plane from scratch, `create-ops-package` with an operational strategy and target-repository description, `analyze-agentic-ops` to download and query CAO activity data with the `cao` CLI, or `cao-cli` for a general reference on using `cao` in local development and inside agentic workflow runs.

In Copilot CLI, the plugin also provides a **Central Agentic Ops** Canvas. Open it to start the repository's local dashboard preview, optionally for a specified `OWNER/REPOSITORY`. The extension gives the agent tools to execute declarative queries with the canonical dashboard query engine and read bounded sections of the dashboard data architecture specification.

## GitHub Pages setup

The default Central Agentic Ops package installs the dashboard builder and manual Pages publisher. Before running **Central Agentic Ops Dashboard** for the first time:

1. Open **Settings > Pages** in the control repository.
2. Under **Build and deployment**, set **Source** to **GitHub Actions**.
3. Restrict Pages access to the intended audience before publishing control-plane data.

The dashboard workflow remains manual and does not enable Pages automatically.

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
