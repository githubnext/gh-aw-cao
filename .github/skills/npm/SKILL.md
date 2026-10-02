---
name: npm
description: "npm behind Microsoft firewall: use 1ES feed. Fix registry, proxy, and certificate failures."
---

# npm blocked? Use 1ES.

Go to package directory. Check pinned package. Install from existing lockfile.

```sh
registry=https://ms-feed-25.pkgs.visualstudio.com/1es-public/_packaging/npm-public/npm/registry/
npm view yaml@2.9.0 version --registry="$registry" --fetch-retries=0 --fetch-timeout=15000
npm ci --registry="$registry" --replace-registry-host=npmjs
```

- Feed is npm registry, not HTTP proxy. Never put feed URL in `HTTPS_PROXY`.
- `replace-registry-host=npmjs` reroutes npmjs downloads. Private registries and postinstall hosts stay separate. Do not edit lockfile URLs or manifests to fix network.
- Use `npm view`, not `npm ping`; feed may lack ping endpoint. Missing package or auth failure? Report blocker. No guessed mirrors or credentials. [Upstream caching needs feed permissions](https://learn.microsoft.com/en-us/azure/devops/artifacts/concepts/upstream-sources?view=azure-devops).
- Need forward proxy? Get approved URL from IT. Set shell `HTTPS_PROXY` / `HTTP_PROXY`; check `NO_PROXY`. Keep machine config and secrets out of repo, commands, and logs.
- Certificate failure? Retry with `NODE_USE_SYSTEM_CA=1` on supported Node. Or set `NODE_EXTRA_CA_CERTS` to IT-provided PEM path before npm starts. Check npm `cafile` override.
- TLS stays on. No `strict-ssl=false`, `NODE_TLS_REJECT_UNAUTHORIZED=0`, `curl -k`, or HTTP registry.
- `ENOTCONN`, reset, timeout, firewall denial? Network broken, not lockfile. Report host and error, no secrets. Ask IT for HTTPS access to `ms-feed-25.pkgs.visualstudio.com`. No reinstall loop.
