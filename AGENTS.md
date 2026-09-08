# Central Agentic Ops Repositories

## Establish the repository role

- **Catalog source:** A checkout with the root `aw.yml` and top-level package directories is the public CAO catalog. Change package sources and documentation here. Catalog markers alone do not make the repository a control plane.
- **Control repository:** A repository with installed workflows and `cao.json` under `.github/workflows/` plus package records under `.github/aw/packages/` runs the control plane. Its workflows operate on explicitly enrolled remote repositories; targets receive only declared safe outputs.
- **Source-managed control repository:** Any repository may run workflows it maintains directly in-tree as a control plane when maintainers explicitly choose that topology and commit `.github/workflows/cao.json` plus the CAO runtime sources. Package records are not required for those directly maintained workflows. When the same repository is also a catalog, this is the supported dogfood topology: apply both catalog and control-repository safety rules, and keep package source, rollout policy, credentials, and target authority as separate records.
- **Target repository:** A target receives only declared safe outputs. Its files do not grant, narrow, or revoke control-plane authority; live activation is decided by the control repository's policy at the exact workflow SHA.

Apply the guidance for every role that is present. Do not infer a role from the repository name or from catalog files alone.

## Sources of truth

- In the catalog, root and package `aw.yml` manifests define package contents. The root manifest installs the deterministic dashboard by default and must mirror the dashboard destinations declared by `dashboard/aw.yml`. Editable gh-aw workflow sources are `.github/workflows/*.md`; shared control is `.github/workflows/shared/control.md` and its dependencies.
- In a control repository, `.github/workflows/cao.json` is the only persistent non-secret rollout policy. Keep workflow and policy changes in one reviewed commit because runs resolve policy at the exact workflow SHA.
- `.github/workflows/*.lock.yml` files are generated artifacts. Never edit them directly; change their Markdown sources and run `gh aw compile`.
- When merging, resolve conflicts in the editable workflow sources first. Resolve conflicts in `.github/workflows/*.lock.yml` by running `npm run compile:locks` during the merge (which invokes `gh aw compile` with the required schedule seed), then stage the regenerated lock files instead of editing conflict markers manually.
- `.github/aw/packages/*.json` records package-owned files. Update those files with gh-aw package commands instead of editing ownership metadata.
- `.github/cao/<operation>.md` is optional, control-repository-owned steering. It may refine evidence and priorities, but cannot grant tools, credentials, permissions, repository reach, or write capabilities.

## Authority and safety

- CAO policy controls whether and where an operation may run. gh-aw controls how an authorized workflow executes. Neither authority substitutes for the other.
- Orchestrators discover, rank, and dispatch within resolved policy. Workers handle one dispatched target and must not discover more repositories, dispatch more work, or widen the requested mode.
- `review` is the default mode. Do not broaden scope, rollout, package or worker enablement, or promote an operation to `live` unless the requested policy change explicitly requires it.
- Live work requires explicit scope and mode in the control repository's reviewed policy. Credential reach alone does not widen that policy.
- GitHub tools exposed to agents are read-only. Repository writes must use safe-output capabilities already declared by the workflow.
- Keep credentials in Actions secrets. Never place tokens, private keys, or other secrets in policy, workflow inputs, steering files, dispatch envelopes, commits, or chat.
- Preserve fail-closed behavior. Missing policy, authority, credentials, repository access, or required evidence must fail, skip, no-op, or report incomplete rather than infer broader authority.

## Building and testing

### Full validation

Run `npm run check` for complete repository validation. It executes, in order: `typecheck:cao`, `test` (unit + integration), `test:load`, `check:svg`, `compile`, and `docs:build`.

### Root package commands

| Command | Purpose |
|---------|---------|
| `npm run typecheck:cao` | TypeScript type-check for `.github/cao/src/` (ES2022, NodeNext) |
| `npm test` | Unit tests (`tests/unit/`) then integration tests (`tests/integration/control-*.test.mjs`) via the Node.js built-in test runner |
| `npm run test:unit` | Unit tests only |
| `npm run test:integration` | Integration tests only (serial) |
| `npm run test:package-lifecycle` | Clean-room `gh aw add`/`update` tests; requires `GH_TOKEN` and a GitHub App |
| `npm run test:load` | Synthetic enterprise-scale load tests (100 000 repos) |
| `npm run check:svg` | SVG visual-language compliance via `scripts/check-svg-visual-language.mjs` |
| `npm run activity:local -- activity/.env` | Run a packaged activity entrypoint with `@github/local-action` Toolkit shims |
| `npm run activity:local:node -- activity/index.mjs` | Run an activity entrypoint locally with the installed Toolkit packages |
| `npm run dashboard:local -- --repo OWNER/REPOSITORY` | Download dashboard data and start a local preview |
| `npm run dashboard:local:copilot` | Start the local dashboard preview with Copilot-assisted editing |
| `npm run compile` | Dry-run compile of workflow `.md` sources with `gh aw compile` (no lock-file writes) |
| `npm run compile:locks` | Compile and update `.lock.yml` files |
| `npm run docs:build` | Build the Astro/Starlight documentation site |

Always pass `--schedule-seed githubnext/gh-aw-cao` when running `gh aw compile` manually (the `compile` script already includes it); omitting the seed causes non-deterministic cron scattering in lock files.

### Dashboard site (`dashboard/site/`)

Run these commands from the `dashboard/site/` directory:

| Command | Purpose |
|---------|---------|
| `npm test` | Unit tests via Vitest with jsdom |
| `npm run test:e2e` | Playwright end-to-end tests (use `--shard=N/M` for CI parallelism) |
| `npm run test:performance` | CFO, CTO, and CSO Lighthouse scenarios with retained performance traces |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript strict-mode check |
| `npm run validate:corpus` | Dashboard authoring corpus validation |

### CI workflows

| Workflow file | Scope | Trigger |
|---------------|-------|---------|
| `workflow-contracts.yml` | `npm run check` + `test:package-lifecycle` | PR / push |
| `cid.yml` | Dashboard site lint, typecheck, unit tests, sharded E2E | PR / push to `dashboard/site/**` |
| `svg-contrast-check.yml` | Playwright SVG WCAG contrast validation | PR / push to SVG files |
| `docs.yml` | Documentation build | Schedule / push to main |

### Choosing which tests to run

- Editing control-plane sources under `.github/cao/src/` → `npm run typecheck:cao && npm test`
- Editing dashboard site under `dashboard/site/` → from that directory: `npm test && npm run test:e2e && npm run test:performance && npm run lint && npm run typecheck`
- Debugging downloaded dashboard data → use `npm run dashboard:local -- --repo OWNER/REPOSITORY`
- Editing activity scripts under `activity/` → run the focused activity tests and use `npm run activity:local` or `npm run activity:local:node` for local entrypoint debugging
- Editing workflow `.md` files → `npm run compile` (add `compile:locks` if lock files should update)
- Editing SVGs → `npm run check:svg`
- Editing documentation under `docs/` → `npm run docs:build`
- Unsure what's affected → `npm run check`

## Working changes

- Read the relevant workflow source, its imports, its package manifest, and the effective policy before changing behavior.
- Always run `gh aw compile` if any `.md` file is modified.
- In the catalog, follow the relevant skill under `.github/skills/` and run the narrowest tests plus `npm run compile`.
- In a control repository, validate policy JSON after editing it, reject unresolved placeholders, run `gh aw compile` after workflow-source changes, and review generated lock-file diffs.
- Do not modify unrelated packages, generated files, or consumer-owned steering while updating an installed package.