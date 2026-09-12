---
title: Configuration Reference
description: Checked-in policy, credential secrets, and manual inputs for Central Agentic Ops.
---

Persistent non-secret policy lives only in `.github/workflows/cao.json` in the private control repository. Workflows read that file at the exact `github.workflow_sha`, so workflow code and policy are one reviewed revision. Repository variables named `CENTRAL_AGENTIC_OPS_*` are not read as defaults, overrides, or compatibility fallbacks.

Keep credentials in Actions secrets. Manual inputs may select a target or narrow a checked-in limit for one run, but they never change policy or widen it.

The policy is plain JSON so Node.js can parse it with the built-in `JSON.parse` API and no runtime dependencies. Its Draft 2020-12 schema is published at `.github/cao/cao.schema.json`; the checked-in policy's `$schema` property enables editor completion and diagnostics. The dependency-free resolver remains the runtime validator for constraints JSON Schema cannot express, including duplicate keys, case-insensitive uniqueness, and `cell-index < cell-count`.

## Control Policy

This minimal policy enables the installed Dependabot package and its workers in `review` mode for repositories owned by `acme`:

```json
{
  "$schema": "https://raw.githubusercontent.com/githubnext/gh-aw-cao/main/.github/cao/cao.schema.json",
  "version": 1,
  "gh-aw-version": "v0.89.8",
  "control-plane": {
    "scope": {
      "allowed-owners": ["acme"]
    },
    "packages": {
      "dependabot": {
        "workers": {
          "release-train-updater": {
            "workflow": "dependabot-release-train-updater"
          }
        }
      }
    }
  }
}
```

Commit the file before running an installed operation. A missing or invalid document fails closed. An undeclared package skips activation before repository discovery or agent execution. See [Admission Gates](admission.md) for the exact pre-activation checks and the checks deferred to authorized-run precompute.

Control repositories must declare `gh-aw-version` at the document root. Factory infrastructure reads this exact release when installing the CLI, and fleet maintenance can compare it with the expected release to identify repositories that need an upgrade. The field remains optional for target-authority-only documents.

The schema defaults are:

| JSON path | Default | Range or values |
| --- | --- | --- |
| `control-plane.scope.allowed-owners` | Control repository owner | Owner names |
| `control-plane.scope.allowed-repositories` | All repositories under an allowed owner | Exact `owner/repository` names |
| `control-plane.inventory.max-scan-repositories` | `1000` | `1` through `100000` |
| `control-plane.inventory.cell-count` | `1` | `1` through `1000` |
| `control-plane.inventory.cell-index` | `0` | Less than `cell-count` |
| `control-plane.inventory.batch-size` | `100000` | `1` through `100000` |
| `control-plane.inventory.batch-index` | `0` | Non-negative integer |
| `control-plane.web.favicon` | `./favicon.svg` | Absolute HTTPS URL or `./` relative path |
| `control-plane.defaults.mode` | `review` | `review` or `live` |
| `control-plane.defaults.max-repositories` | `1` | `1` through `1000` |
| `control-plane.defaults.rollout-percent` | `100` | `1` through `100` |
| `control-plane.defaults.monthly-ai-credit-budget` | `0` | Deprecated compatibility field; no runtime admission effect |
| `control-plane.packages.<package>.targets.<owner/repository>.mode` | Package mode | `review` or `live` |

Each entry under `control-plane.packages` may override the defaults with `enabled`, `mode`, `max-repositories`, and `rollout-percent`; `monthly-ai-credit-budget` remains accepted as a deprecated compatibility field but has no runtime admission effect. Its optional `targets` map assigns a different mode to an exact repository while unmatched repositories retain the package mode. Every package target must remain inside the global allowed owners and, when present, the global repository allowlist. The `workers` map is the package's workflow catalog: every worker entry requires its exact `workflow` slug, may set `enabled: false` to disable that worker, and may set `max-mode` to narrow its mode. Package and worker names are lowercase kebab-case identifiers loaded directly from this policy.

The optional `control-plane.web` section configures deterministic web surfaces without changing rollout authority. Set `favicon` to an absolute HTTPS URL without credentials, query, or fragment, or to a non-traversing `./` relative path available in the generated site. The dashboard package ships `./favicon.svg` as its default.

For example, this policy keeps Dependabot in review across its scope while promoting one exact target to live:

```json
{
  "version": 1,
  "control-plane": {
    "scope": {
      "allowed-owners": ["acme"],
      "allowed-repositories": ["acme/example-service"]
    },
    "packages": {
      "dependabot": {
        "mode": "review",
        "max-repositories": 1,
        "rollout-percent": 100,
        "targets": {
          "acme/example-service": {
            "mode": "live"
          }
        },
        "workers": {
          "release-train-updater": {
            "workflow": "dependabot-release-train-updater"
          }
        }
      }
    }
  }
}
```

Shared control applies schema defaults, then `control-plane.defaults`, package values, the exact target mode, and any explicit worker ceiling, in that order. A dispatch request may narrow the result. Workers independently resolve their exact target from the policy revision at `github.workflow_sha`; an envelope that requests a wider mode fails before agent execution. Package repository and percentage caps still apply across all candidates regardless of target mode.

### Monthly Package Budgets

`monthly-ai-credit-budget` is deprecated. Existing policy files may keep the field during migration, but shared control no longer reads month-to-date usage or gates repository admission with monthly AI Credit totals. Existing repository, rollout, dispatch, and native gh-aw workflow credit limits remain cumulative.

## Live Authority

`live` workers use only the control repository's `.github/workflows/cao.json` as their policy authority. Declare live package and worker ceilings, allowed owners or repositories, and target-specific modes there. Workers resolve that policy from the exact workflow SHA before agent execution; no `cao.json` or authority declaration is required in a target repository.

## Credentials

For private or internal targets, alternate review repositories, or live writes, configure a GitHub App or fine-grained PAT. For bounded review runs against public targets, no App or PAT secret is required when outputs stay in the current control repository.

| Name | Required | Purpose |
| --- | --- | --- |
| `GH_AW_GITHUB_READ_APP_ID` | With App authentication | Repository variable containing the read-only GitHub App client ID. |
| `GH_AW_GITHUB_READ_APP_PRIVATE_KEY` | With App authentication | Repository secret containing the read-only App private key. |
| `GH_AW_GITHUB_WRITE_APP_ID` | With write-capable App authentication | Repository variable containing the safe-output and API-gate GitHub App client ID. |
| `GH_AW_GITHUB_WRITE_APP_PRIVATE_KEY` | With write-capable App authentication | Repository secret containing the safe-output and API-gate App private key. |
| `GH_AW_GITHUB_TOKEN` | PAT fallback | Fine-grained token for cross-repository access. |
| `GH_AW_CI_TOKEN` | Optional Dependabot path | Additional token used only when an empty CI commit is required. |

The root package manifest remains free of interactive setup so `gh aw add` works non-interactively. Follow [Automated App setup](authentication.md#automated-app-setup) to create and install both Apps with the package-installed Node CLI, or configure the four values manually. Shared control uses the read-only App for GitHub tools and admission. It exposes the write-capable App to safe outputs and, with only `Actions: write`, to best-effort API-gate persistence after a fresh capacity denial. Each path uses only its documented credential fallback when that credential's reach is sufficient.

## Manual Inputs

Operation orchestrators expose these `workflow_dispatch` inputs:

| Input | Effect |
| --- | --- |
| `target_repo` | Selects one exact target within checked-in owner and repository scope. |
| `safe_output_repo` | Selects an allowed private review destination for this run. |
| `max_repos` | Narrows the checked-in package repository ceiling. |
| `rollout_percent` | Narrows the checked-in package rollout ceiling. |
| `safe_output_mode` | Narrows `live` policy to `review`, or requests the already-authorized mode. |

Manual inputs affect only one run. They do not update `.github/workflows/cao.json`. Use `gh aw run <workflow-name>` to trigger an installed workflow so gh-aw validates and records its inputs correctly.

## Ops Publish Add-on

Ops Publish reads `control-plane.publishing` and `control-plane.scope` from the same JSON policy. `publishing.enabled` defaults to `false`; when enabled, `publishing.reviewers` must be non-empty. `publishing.control-repositories` defaults to the repository containing the add-on.

PAT fallback uses the separate `CENTRAL_AGENTIC_OPS_PUBLISH_CONTROL_TOKEN` and `CENTRAL_AGENTIC_OPS_PUBLISH_TARGET_TOKEN` secrets. These credentials are not policy and never override owner, repository, reviewer, or target-authority checks. See [Ops Publish](operations.md#publishing-reviewed-operation-issues).

## Markdown Steering

Each workflow may load optional repository-specific instructions from `.github/cao/<operation>.md` in the control repository. Supported operation names are `uk-ai-advisory`, `aw-doctor`, `dependabot`, `eu-cra-compliance`, `optimization`, and `software-development-practices`.

Steering can refine evidence, priorities, and selection within resolved policy. It cannot grant tools, credentials, permissions, repository reach, or safe-output capabilities. Package updates do not overwrite these files.

## Optional Observability

The dispatcher span is built into `shared/control.md`; exporter configuration determines where gh-aw sends it. Set the `GH_AW_DEFAULT_OTLP_ENDPOINT` Actions variable and `GH_AW_DEFAULT_OTLP_HEADERS` Actions secret at repository, organization, or enterprise scope. Export is disabled when the endpoint or matching headers are absent.

```bash
CONTROL_REPO="acme/central-agentic-ops"
gh variable set GH_AW_DEFAULT_OTLP_ENDPOINT \
  --repo "$CONTROL_REPO" \
  --body "https://collector.example.com/v1/traces"
gh secret set GH_AW_DEFAULT_OTLP_HEADERS --repo "$CONTROL_REPO"
```

At the secret prompt, enter the complete exporter header string, such as `Authorization=Bearer <token>` or `Authorization=Basic <credentials>,X-Scope-OrgID=<tenant>`.

The optional `shared/sentry.md`, `shared/grafana.md`, and `shared/datadog.md` imports configure exporters only; they do not create the dispatcher span. Their headers are:

| Provider | Header |
| --- | --- |
| Sentry | `Authorization: <GH_AW_OTEL_SENTRY_AUTHORIZATION>` |
| Grafana Cloud | `Authorization: <GH_AW_OTEL_GRAFANA_AUTHORIZATION>` |
| Datadog | `DD-API-KEY: <GH_AW_OTEL_DATADOG_API_KEY or DD_API_KEY>` |

Installed Central Agentic Ops packages do not include these optional provider files by default. Use the default OTLP variable and secret unless an installed package deliberately carries a provider import, then recompile all affected workflows.

## Sources of Truth

- Machine-readable policy schema: installed at `.github/aw/cao/cao.schema.json`, with `.github/cao/cao.schema.json` as the source-managed location
- Runtime policy resolution: installed at `.github/aw/cao/src/policy.mjs`, with `.github/cao/src/policy.mjs` as the source-managed location, and [Control Policy Specification](control-policy-specification.md)
- Checked-in control policy: `.github/workflows/cao.json`
- Deterministic control commands: installed at `.github/aw/cao/src/control.mjs`, with `.github/cao/src/control.mjs` as the source-managed location
- Shared runtime enforcement: `.github/workflows/shared/control.md`
- Package inventory: the root and package `aw.yml` manifests
- Credentials and permissions: [Configure Authentication](authentication.md)
