# Setup implementation details

Load this reference only to inspect installer behavior, runtime layout, source
versus generated files, or steering files.

The root `install.sh` installs or upgrades the required gh-aw version, installs
the root CAO package when runtime files are absent, materializes the runtime,
makes `./cao.sh` executable, and runs `./cao.sh init` only when policy is absent.
It preserves an existing `.github/workflows/cao.json`.
Tools, Node.js 24+, sign-in, and checkout-root readiness are checked before
installation or upgrade. `--create-repo OWNER/NAME` explicitly creates and
clones a private repository, refusing an existing clone directory. After a
successful interactive installation, a default-Yes handoff offers to open
guided setup on the controlling terminal; declining prints the command for
later. `--setup` opens guided setup without that handoff prompt. Other streamed
children retain null stdin.

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
prompts validate input inline; `TERM=dumb` selects plain numbered prompts.
Confirmation defaults to No. After confirmation, the Pages source is verified
without changing visibility. Public dashboards require separate default-No
consent before credentials are configured. Declining or cancelling that consent
removes only a newly created site where possible; existing sites remain with
restriction or unpublication guidance. Policy is saved atomically afterward.
Failures report partial external effects honestly; rerun setup after fixing
the reported problem. The default CLI output gives next actions; `setup --json`
keeps structured stdout. Setup requires a terminal and never commits, pushes,
installs a campaign, or dispatches a workflow.

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
