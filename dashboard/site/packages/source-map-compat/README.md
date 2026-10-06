# Build-time source maps

The root and dashboard npm overrides resolve `source-map-js` to this local
package, not the unavailable `source-map-js@1.2.2` registry tarball. No install
script or post-install patch is needed; use `npm ci --ignore-scripts`.

This deliberately small adapter implements the synchronous generator and
consumer APIs used by PostCSS and CSS-tree (including CSS-tree's deep generator
import and CSSO's filename assignment). Encoding, decoding, indexed maps, and
position lookup use the maintained `@jridgewell/gen-mapping` and
`@jridgewell/trace-mapping` primitives. Source maps remain enabled, including
chained maps, original-source diagnostics, and embedded source content.

This is not a general replacement for the entire `source-map-js` API: it does
not implement `SourceNode`, reverse lookups, or original-order iteration.
Keep the adapter scoped to its build-tool consumers. Its location inside the
dashboard package lets npm's local-package link resolve dependencies in both
root-only and dashboard-only installs. Docker installs only the dashboard's
build dependencies (`esbuild` and `yaml`) with `--omit=dev --ignore-scripts`,
so it does not install Vitest, Vite, PostCSS, or this adapter.

Run `node --test tests/unit/source-map-compat.test.mjs` from the repository root
after installing root dependencies.
