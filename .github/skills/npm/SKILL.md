---
name: npm
description: "Install npm dependencies and troubleshoot npmjs access behind the Microsoft corporate firewall using the Microsoft 1ES public npm feed. Use for registry connectivity failures, corporate proxies, and TLS certificate errors."
---

# npm access behind the Microsoft corporate firewall

## Registry and installation

On the Microsoft corporate network, use the Microsoft 1ES public npm feed:
`https://ms-feed-25.pkgs.visualstudio.com/1es-public/_packaging/npm-public/npm/registry/`.
This is an npm registry proxy/cache, not an HTTP forward proxy; do not put its
URL in `HTTPS_PROXY`.

Run these commands from the relevant package directory, using a command-local
registry override and preserving the existing lockfile:

```sh
npm view yaml@2.9.0 version --registry=https://ms-feed-25.pkgs.visualstudio.com/1es-public/_packaging/npm-public/npm/registry/ --fetch-retries=0 --fetch-timeout=15000
npm ci --registry=https://ms-feed-25.pkgs.visualstudio.com/1es-public/_packaging/npm-public/npm/registry/ --replace-registry-host=npmjs
```

`--replace-registry-host=npmjs` routes default npmjs lockfile downloads through
the selected registry without manually editing lockfile URLs. It does not
redirect unrelated private registries or postinstall download hosts.

Prefer `npm view` of a required pinned package over `npm ping` for Azure
Artifacts, whose ping endpoint may not be supported. The feed is not guaranteed
to contain every npmjs package:
[saving new upstream packages requires feed permissions](https://learn.microsoft.com/en-us/azure/devops/artifacts/concepts/upstream-sources?view=azure-devops).
Treat missing packages and authentication errors as blockers, not a reason to
invent another feed or add credentials to the repository.

## HTTP forward proxies

If the Microsoft-managed network also requires an HTTP forward proxy, obtain
its approved URL from the network configuration or IT and set `HTTPS_PROXY` /
`HTTP_PROXY` in the current shell. npm honors these variables; check that
`NO_PROXY` does not exclude the selected registry host when proxy access is
required.

Do not guess an internal proxy or registry mirror, persist machine-specific
settings in the repository, or put proxy credentials in commands, logs, or
committed `.npmrc` files.

## Corporate certificate trust

For TLS inspection errors such as `SELF_SIGNED_CERT_IN_CHAIN` or
`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, use the Microsoft-provided trusted CA.
On supported Node.js versions, try the system trust store:

```sh
NODE_USE_SYSTEM_CA=1 npm view yaml@2.9.0 version --registry=https://ms-feed-25.pkgs.visualstudio.com/1es-public/_packaging/npm-public/npm/registry/ --fetch-retries=0 --fetch-timeout=15000
NODE_USE_SYSTEM_CA=1 npm ci --registry=https://ms-feed-25.pkgs.visualstudio.com/1es-public/_packaging/npm-public/npm/registry/ --replace-registry-host=npmjs
```

If the corporate CA is not in the system trust store, set `NODE_EXTRA_CA_CERTS`
to the absolute path of an IT-provided PEM CA bundle before starting npm.
Check for an existing npm `cafile` override if certificate errors persist.

Keep TLS verification enabled: do not use `strict-ssl=false`,
`NODE_TLS_REJECT_UNAUTHORIZED=0`, `curl -k`, or an HTTP registry.

## Connectivity failures

`ENOTCONN`, connection resets, timeouts, and explicit firewall denials are
connectivity failures, not evidence of a missing package or a bad lockfile.
If the 1ES feed is unreachable, request access to
`ms-feed-25.pkgs.visualstudio.com` over HTTPS from Microsoft IT. Registry
access does not guarantee access to separate package postinstall download hosts.

Report the blocked hostname and error without exposing credentials. Do not
rewrite lockfile URLs, switch to an unapproved mirror, or repeatedly reinstall
dependencies to work around the firewall.

Keep proxy and CA configuration local to the affected environment. Do not
change dependency manifests merely to diagnose network access.
