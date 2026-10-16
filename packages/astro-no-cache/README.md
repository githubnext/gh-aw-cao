# Astro remote-image cache policy

The root package replaces Astro's `http-cache-semantics` dependency with this
dependency-free, non-caching adapter for GHSA-ch52-4w7c-c8xp. This is a replacement,
not a renamed copy or a claimed patched release of the upstream package.

Astro's `dist/assets/build/remote.js` uses only `storable()` and `timeToLive()` to
calculate remote-image expiry. Both initial downloads and revalidations receive
zero cache lifetime. Local image optimization is unchanged. Remote images still
download and render normally, and Astro retains its ETag/Last-Modified conditional
revalidation and 304 handling. Repeated builds may make more network requests.
This does not disable Astro's on-disk transformed-image storage or its existing
stale-on-network-error behavior; it removes the vulnerable HTTP policy engine.

The adapter intentionally does not implement a general HTTP cache or upstream's
request-matching, serialization, or stale-reuse APIs. In particular, a client
`max-stale` directive cannot turn a security-zeroed lifetime into reusable content.
An incompatible new consumer must fail rather than silently gain caching.

The focused regression tests resolve the replacement from Astro, check that
lockfiles contain no registry copy of `http-cache-semantics`, and execute Astro's
real download and revalidation functions with synthetic responses. Run them with:

```sh
node --test tests/unit/docs-http-cache.test.mjs
```

The advisory identified no patched release when this replacement was added.
Version 4.3.0 was also reported to reproduce the bypass; a version-only upgrade is
not sufficient evidence. Restore upstream only after its behavior is verified
against security-zeroed responses and oversized/bare `max-stale` directives.
Production CAO cross-user exploitability has not been established: the identified
consumer is the documentation build's remote-image expiry calculation, not the
hosted Go dashboard's response cache.
