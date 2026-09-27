---
title: Browse Campaign Packages
description: Configure registries and browse campaign packages without granting the dashboard installation authority.
---

The experimental **Marketplace** page appears under **Updates** in the CAO
dashboard. It provides a read-only view of campaign packages from an ordered
set of registries. Selecting a package shows its normalized metadata,
provenance, contents, and immutable source coordinate.

The dashboard does not contact registries or install packages. Its package
action only copies the canonical command:

```sh
./cao.sh add OWNER/REPOSITORY[/PATH]@COMMIT
```

Review the command and run it separately from a trusted checkout.

## Configure registries

Declare registries in `.github/workflows/cao.json`. Array order defines
precedence: when registries publish the same package coordinate, the first
registry wins.

```json
{
  "control-plane": {
    "marketplace": {
      "cache-ttl-seconds": 900,
      "registries": [
        {
          "id": "official",
          "name": "Official CAO catalog",
          "repository": "githubnext/gh-aw-cao",
          "ref": "main",
          "auth": { "type": "none" }
        },
        {
          "id": "internal",
          "name": "Internal campaigns",
          "repository": "acme/cao-packages",
          "path": "packages",
          "ref": "stable",
          "api-url": "https://github.acme.example/api/v3",
          "auth": {
            "type": "pat",
            "secret": "CAO_INTERNAL_REGISTRY_PAT"
          }
        }
      ]
    }
  }
}
```

The official registry is ordinary configuration. Remove its entry to omit it,
or replace it with public, private, or GitHub Enterprise registries. Registry
IDs must be unique and stable.

## Authenticate private registries

Registry authentication is scoped to that registry:

- `none` needs no credential.
- `pat` references one environment secret with `secret`.
- `github-app` references `app-id-secret`, `private-key-secret`, and
  `installation-id-secret`.

Configuration contains secret names, never secret values. Make those referenced
secrets available only to the trusted Activity or hosted resolver. Credentials,
installation tokens, and authentication headers are excluded from marketplace
rows, browser storage, dashboard state, and diagnostics.

Set `api-url` on each GitHub Enterprise registry. Do not use it as a global
GitHub API override.

## Resolution modes

Both dashboard backends expose the same package fields through the data worker:

- The Activity backend resolves registries during data collection and retains
  normalized rows in the dashboard's IndexedDB database.
- The hosted Go backend resolves registries at runtime and caches safe,
  normalized results in Redis. Cache entries are isolated by registry and
  source generation.

Resolvers turn mutable refs into commit identities when possible. The copied
add command uses that normalized source coordinate rather than rebuilding it
from presentation state.

## Troubleshoot unavailable packages

One unavailable registry does not hide packages from healthy registries.
Registry diagnostics report safe status information without credential values.
Check, in order:

1. the registry `repository`, optional `path`, `ref`, and `api-url`;
2. that every referenced secret exists in the trusted resolver environment;
3. token or GitHub App access to commits, trees, and package manifests;
4. that package manifests use supported gh-aw package metadata; and
5. registry order when a duplicate package is resolved from an earlier entry.

The marketplace intentionally has no installed, updating, or progress state.
Package installation and rollout policy remain separate reviewed operations.
