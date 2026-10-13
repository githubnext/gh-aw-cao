# Setup implementation details

Load this reference only to inspect installer behavior, runtime layout, source
versus generated files, or steering files.

The root `install.sh` installs or upgrades the required gh-aw version, installs
the root CAO package when runtime files are absent, materializes the runtime,
makes `./cao.sh` executable, and runs `./cao.sh init` only when policy is absent.
It preserves an existing `.github/workflows/cao.json`.
Tools, Node.js 24+, sign-in, and checkout-root readiness are checked before
installation or upgrade. `--create-repo OWNER/NAME` explicitly creates and
clones a private repository, refusing an existing clone directory. Bare
installation stops and prints `./cao.sh setup`; `--setup` opens guided setup
directly on the controlling terminal. `--quickstart` creates a new private
control repository and delegates to the explicit end-to-end quickstart after
verified installation. Without a terminal or when `CI` is set, guided setup
defaults to No and skips configuration successfully; repository creation
requires an explicit exact coordinate, and an outdated installed gh-aw fails
with manual-upgrade guidance. Other streamed children retain null stdin.

The producer uses the dedicated `runtime/package.json` `files` field and
`npm pack --ignore-scripts`, bundles the YAML parser and Clack prompt adapter
with esbuild and their license notices, and seals a revision-bound file inventory.
Explicit source packing also bundles prompts. The materializer downloads
the prebuilt archive matching gh-aw's full `resolvedCommit`: stable `vX.Y.Z`
references use release assets, while main/SHA references use successful,
unexpired `cao-runtime.yml` Actions artifacts retained for 90 days.
Before extraction it verifies signed provenance for the catalog repository,
signer workflow, source and signer SHA, and GitHub-hosted runner. It validates
the file inventory, checksums and owned destinations before replacement.
Missing or unverifiable archives stop installation without another-revision
or source/npm fallback. Operators need Node.js and authenticated GitHub CLI
artifact/attestation access on github.com, not npm; explicit developer source
materialization and dashboard builds retain their existing npm requirements.
Consumer-owned root package metadata is preserved. Tests, fixtures,
screenshots, development configuration, and catalog component manifests are not
installed. The Agent Plugin, portable skills, Canvas extension, and bundled
specifications are separate client installations, not control-plane resources.
Updates prune development files inside the owned `activity/` and `dashboard/`
directories. Previously copied plugin files outside those directories remain
untouched; review them separately rather than deleting client-owned resources
as part of a runtime update.

Guided setup separates Repositories, Connections, and Review/apply. Arrow-key
prompts validate input inline; terminals without styling support, `NO_COLOR`,
and `ACCESSIBLE` select plain numbered prompts without animation.
Confirmation defaults to No. After confirmation, the Pages source is verified
without changing visibility. Public dashboards require separate default-No
consent before credentials are configured. Declining or cancelling that consent
removes only a newly created site where possible; existing sites remain with
restriction or unpublication guidance. Policy is saved atomically afterward.
Failures report partial external effects honestly; rerun setup after fixing
the reported problem. The default CLI output gives next actions; `setup --json`
keeps structured stdout. Setup never commits, pushes, installs a campaign, or
dispatches a workflow.

`activity/quickstart.mjs` is a separate, explicit effectful flow. It requires an
uncommitted private control repository with no existing commit, installs Bug
Bash in review mode for the pinned public starter target, declares Activity
collection only for the control repository, configures public Pages and
repository-local workflow-token mode, validates and commits only CAO-owned
paths, pushes the default branch, runs at most one investigation, collects
Activity, and waits for the data-bearing dashboard deployment. It reports
non-success Bug Bash outcomes honestly and fails unless Activity contains a
run and the dashboard deployment succeeds.

Canonical runtime files live together under `.github/workflows/shared/`,
including `control.md`, `control.mjs`, `policy.mjs`, the policy schema, the
materializer, and authentication helpers. The repository-local launcher is
`./cao.sh`. Do not fetch a second runtime copy or construct one ad hoc.

Editable workflow sources are `.github/workflows/*.md`; `.lock.yml` workflows
are generated and must be changed only by compiling their sources. Campaign
records and installed package sources are campaign-owned and remain untouched
during setup.

Preserve consumer-owned root `AGENTS.md`. CAO-specific consumer guidance belongs
in `.github/cao/instructions.md`; the gh-aw overlay under
`.github/aw/instructions.md` points to it. Campaign-specific steering belongs in
`.github/cao/<campaign-slug>.md` only after a campaign exists and the user asks
for custom prompting, so setup must not create it.

Use [CAO Commands](../../../docs/cao-cli.md) for current command behavior and
the installed `./cao.sh --help` output for exact syntax.
