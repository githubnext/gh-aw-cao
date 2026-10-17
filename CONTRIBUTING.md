# Contributing to Central Agentic Ops

Thank you for your interest in contributing to Central Agentic Ops! We welcome
contributions from the community and are excited to work with you.

**IMPORTANT: This project uses agentic development by a core team, primarily
using Copilot coding agent or local coding agents.**

**Traditional pull requests are not enabled for contributors without write
access.** If you do not have write access, please do not create a pull request
directly. Instead, create a detailed agentic plan in an issue, discuss it with
the team, and a core team member will create and implement the pull request
using agents.

Contributors who have write access but are not yet core team members may create
pull requests by following the review workflow below.

## How development works

Central Agentic Ops is developed by a core team using agentic development. This
means:

- **Core team members use agents to create and manage pull requests**, through
  Copilot coding agent or local coding agents.
- **Continuous integration provides automated quality assurance** for every
  pull request.
- **Community members contribute through agentic plans** that the core team can
  execute.
- **Contributors with write access work in draft pull requests** until their
  changes are ready for core team review.

### Why this approach?

Central Agentic Ops practices the development model it supports: agents help
build and operate agentic workflows. This approach provides:

- **Consistency:** Changes go through the same automated quality gates.
- **Dogfooding:** We use agentic development to build agentic operations.
- **Established practices:** Agents follow the repository's documented patterns
  and safety boundaries.
- **Actionable plans:** Contributors think through implementation and validation
  before work begins.

## Quick start for community contributors

**If you do not have write access, do not create a pull request directly.**
Instead, craft a detailed agentic plan in an issue so a core team member can
implement it using agents.

### Step 1: Analyze with an agent

Before filing a contribution request, use an agent to:

- Scan the relevant source code and identify root causes for bugs.
- Analyze execution patterns and trace the issue.
- Research related issues and existing implementation patterns.
- Propose specific changes, including code examples when useful.
- Create a complete plan for implementation and validation.

For CAO deployment failures, use the
[`debug-cao` skill](skills/debug-cao/SKILL.md) to preserve the failing revision,
narrow the fault to one system boundary, and collect reproducible evidence.

Remove credentials, private repository data, and other sensitive information
from prompts, plans, examples, and logs.

### Step 2: Open an issue with your agentic plan

Search existing issues first, then open an issue that:

- Describes what you want to contribute.
- Includes the agent's analysis and findings for bugs.
- Explains the use case and expected behavior.
- Provides a complete, step-by-step implementation plan.
- Identifies the relevant files, tests, and documentation.
- Includes specific implementation details and examples.
- Uses the appropriate issue labels when available.

## Pull requests for contributors with write access

If you have write access but are not yet a core team member:

1. Open your pull request in draft mode and continue working there.
2. When the change is complete and validated, mark the pull request ready for
   review and request a review from the maintainers.
3. The maintainers will either approve and merge it immediately or return it
   with comments for follow-up.

## Core team implementation reference

Core team members implementing an accepted plan should use Node.js 24 and npm,
then install dependencies and the pinned `gh-aw` compiler:

```bash
npm ci
npm run install:gh-aw
```

If npmjs access is blocked on the Microsoft corporate network, follow the
[1ES installation instructions](AGENTS.md#installing-npm-dependencies) instead of
the default `npm ci` command.

Keep changes focused and include tests for new behavior. Edit agentic workflow
sources in `.github/workflows/*.md`; do not edit generated
`.github/workflows/*.lock.yml` files directly. Preserve the control-plane safety
boundary: workers operate on one dispatched repository, and rollout policy
remains in `.github/workflows/cao.json`.

See [AGENTS.md](AGENTS.md) for architecture, repository conventions, and focused
test commands. Run the complete repository validation before submitting a pull
request:

```bash
npm run check
```

Workflow source changes must pass `npm run compile`. Run
`npm run compile:locks` only when generated lock files should be updated.

### Go extension development

The root Go module provides the operator-facing `gh cao` GitHub CLI extension.
It is independent of the existing `server/` module. `make check` scopes Go checks to `cmd/` and `internal/`,
excluding dashboard server tests and Go files inside npm dependencies.
Extension CI also runs golangci-lint with the root `.golangci.yml`, including
gofmt/goimports checks and the standard linters. To run those checks locally:

```bash
go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.14.0
golangci-lint fmt --diff ./cmd/... ./internal/...
golangci-lint run ./cmd/... ./internal/...
```

Formatting diffs must be empty; CI fails when the formatter reports changes.

`make test-doctor` runs the dependency-free doctor unit suite with injected
GitHub CLI responses, an empty executable search path, isolated GitHub CLI
configuration, and no authentication tokens. These tests also run in `make check`;
they require neither `gh`, gh-aw, Node.js, nor network access.

`make authtests` separately runs the `authtests`-tagged doctor integration suite
against the real GitHub CLI, the policy-pinned gh-aw installation, and GitHub
authentication. It checks both text and JSON diagnostics without changing policy.
Missing prerequisites fail the integration suite rather than skipping checks.
CI provisions gh-aw and a read-only token only in the separate authenticated
integration job; unit tests and ordinary smoke tests do not need them.

Use the Go version declared in `go.mod` or newer, GitHub CLI, and Make. For local
extension installation, the checkout directory must be named `gh-cao`, even
before the repository is renamed:

```bash
make check
make build VERSION=dev
gh extension install .
gh cao --help
gh cao version
gh cao doctor
```

Build before installing locally: GitHub CLI links to the root `gh-cao`
executable, and rebuilding updates that local installation. The extension is
named `gh cao`; the Go module path and repository URLs remain
`github.com/githubnext/gh-aw-cao` until the repository is renamed.
In a differently named worktree, run `./gh-cao` directly instead.
Remote installation under the `gh cao` name awaits the repository rename;
release assets can be downloaded and run directly in the meantime.
On Windows, build `gh-cao.exe` with
`go build -o gh-cao.exe ./cmd/gh-cao`.

| Path | Responsibility |
| --- | --- |
| `cmd/gh-cao/` | Process entry point, interrupt cancellation, exit status, and link-time version (`-X main.version=...`). |
| `internal/cli/` | Cobra operator commands, native campaign installation/materialization, policy initialization/modes and workflow enablement, help, version, and local diagnostics. |
| `internal/ghcli/` | Context-aware GitHub CLI calls through `github.com/cli/go-gh/v2`, the same helper used by gh-aw. |
| `internal/runtimecli/` | Explicit installed-runtime discovery and cancellation-aware Node process/stdio/exit-status boundary for shared domain services. |
| `go.mod`, `go.sum` | Pinned extension dependencies, separate from `server/go.mod`. |
| `Makefile` | `build`, `release`, `fmt`, `lint` (gofmt and go vet), `test` (race detector), dependency-free `test-doctor`, opt-in `authtests`, and `check`. |
| `scripts/build-release.sh` | Cross-compile six extension binaries with the exact release tag embedded in `main.version`, then write SHA-256 checksums. |
| `.golangci.yml` | Root-module standard linters and gofmt/goimports formatting, separate from the server configuration. |
| `.github/workflows/go-extension.yml` | Path-scoped extension formatting, golangci-lint (including tagged auth tests), vet, tests, build, smoke checks, and separate authenticated integration tests. |

Reuse `github.com/github/gh-aw/pkg/logger` rather than implementing another
logger. Enable its namespaces with `DEBUG=cao:*` and disable debug colors with
`DEBUG_COLORS=0`. Log only non-sensitive metadata, never credentials, raw
arguments, or subprocess payloads. Import small shared gh-aw utility packages
as needed rather than its full CLI command implementation.

Help for every operator command and version work offline without GitHub authentication.
Guided onboarding runs as `gh cao setup`; independent authentication profiles
are grouped under `gh cao setup auth github-app|enterprise-app|token`, not a
root-level `setup-auth` command. These Go commands retain the installed runtime's
setup and setup-auth handlers, including their JSON result contracts and secure
credential prompts. `./cao.sh` keeps its existing command names.
`doctor` checks GitHub CLI, gh-aw, authentication, and basic local policy structure
and compiler pin without loading Node.js. Authentication may contact GitHub.
`campaigns add`, `init`,
`campaigns mode`, `campaigns enable`, and `campaigns disable` run in Go without Node;
repository enrollment (`repos add OWNER/REPO`) and the other
operator commands require Node.js 24+ and an installed root CAO runtime.
Runtime discovery checks the working
directory and its ancestors without crossing a Git repository boundary, then
the extension executable's directory. `CAO_RUNTIME_ROOT` explicitly selects a
runtime and fails rather than falling back if invalid. Discovery selects code,
not policy or working directory: run mutations from the control checkout root.
No code is downloaded or installed implicitly by the bridge.

Preserve production onboarding, authentication, policy validation, and query
semantics through this shared-runtime boundary rather than reimplementing them
in a second engine. Argument vectors and stdin/stdout/stderr pass directly to
Node without a shell; validation exit codes and interactive secret prompts are
preserved. `add` and `update` pass evolving gh-aw options unchanged.
Activity/Dashboard pipeline commands are deliberately not registered in Go;
their Actions, Node command modules, runtime ownership, and `cao.sh` remain
unchanged. See [the operator migration table](docs/cao-cli.md#github-cli-extension).

#### Release binaries

Following the gh-aw release pattern, `make release VERSION=v1.2.3` writes
standalone `darwin-amd64`, `darwin-arm64`, `linux-amd64`, `linux-arm64`,
`windows-amd64.exe`, and `windows-arm64.exe` assets and `checksums.txt` under
`dist/gh-cao/`. The version must be a stable `vMAJOR.MINOR.PATCH` tag, and the
output directory must be empty to prevent stale assets from entering a release.
For a different output directory, run:

```bash
bash scripts/build-release.sh v1.2.3 .tmp/extension-release
```

Builds disable CGO, trim source paths, and use
`-ldflags="-s -w -X main.version=v1.2.3"`. Both `version` and `--version`
report that exact tag. Verify downloaded assets with
`sha256sum --check checksums.txt` on Linux or
`shasum -a 256 --check checksums.txt` on macOS.

The Release workflow runs extension checks and builds at the exact release SHA
in a read-only job with Go caching disabled, then checks the embedded version
before uploading its artifact. A separate source-free attachment job verifies
the binary checksums and the existing attested runtime. Publication requires
the exact nine-asset set before the release becomes an immutable prerelease;
the highlights agent remains restricted to updating release notes.
`node --test tests/unit/build-release.test.mjs tests/unit/release-workflow.test.mjs`
checks the build contract and release gates.

### CI feedback and post-merge coverage

Pull requests run the fast checks relevant to their changed paths: repository
unit contracts, lint, type checks, workflow compilation, dashboard unit tests and
production build, Go quality and API contract checks, and focused Actions,
shell, installer, and SVG checks. Frontend-only changes do not start Go CI;
control workflow Markdown and generated locks do not start Actions lint, which
checks handwritten workflow YAML.

Pushes to `main` retain the integration, load, campaign lifecycle, browser,
mobile, Azure, query-parity, deployed-data benchmark, and performance suites.
Their workflow path filters limit execution to relevant inputs. Existing
scheduled and manual runs remain available; Dashboard CI can also be dispatched
manually. Superseded PR runs are cancelled without cancelling main-branch
validation.

Moving these suites after merge shortens PR feedback but does not establish
their results before merge. Run the applicable integration or browser tests
locally when changing those contracts, and monitor the main-branch checks after
merging.

Setup-path changes must also pass the clean consumer integration suite:

```bash
npm run test:integration:setup-pathways
```

Maintainers with access to the dedicated Contoso fixtures can dispatch the
complete authentication, Activity, private Pages dashboard, campaign review,
and bounded live-mutation acceptance journey:

```bash
npm run test:e2e:setup-pathways
```

To verify existing current-revision evidence without dispatching new runs:

```bash
npm run test:e2e:setup-pathways:contoso
```

By participating in this project, you agree to follow our
[Code of Conduct](CODE_OF_CONDUCT.md).
