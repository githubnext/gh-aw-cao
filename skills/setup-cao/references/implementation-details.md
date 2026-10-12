# Setup implementation details

Load this reference only to inspect installer behavior, runtime layout, source
versus generated files, or steering files.

The root `install.sh` installs or upgrades the required gh-aw version, installs
the root CAO package when runtime files are absent, materializes the runtime,
makes `./cao.sh` executable, and runs `./cao.sh init` only when policy is absent.
It preserves an existing `.github/workflows/cao.json`.

The producer uses the dedicated `runtime/package.json` `files` field and
`npm pack --ignore-scripts`, bundles the YAML parser with esbuild and its
license, and seals a revision-bound file inventory. The materializer downloads
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
