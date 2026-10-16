import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const astroEntry = require.resolve("astro");
const astroRequire = createRequire(astroEntry);
const { default: Policy } = await import(pathToFileURL(astroRequire.resolve("http-cache-semantics")));
const { loadRemoteImage, revalidateRemoteImage } = await import(
  new URL("./dist/assets/build/remote.js", pathToFileURL(require.resolve("astro/package.json")))
);
const root = new URL("../../", import.meta.url);
const url = "https://example.invalid/image.png";

test("Astro resolves only the local non-caching replacement, not the vulnerable package", () => {
  const replacement = new URL("packages/astro-no-cache/index.js", root);
  assert.equal(pathToFileURL(astroRequire.resolve("http-cache-semantics")).href, replacement.href);
  for (const directory of ["", "dashboard/site/", "server/spec/"]) {
    const lock = JSON.parse(readFileSync(new URL(`${directory}package-lock.json`, root), "utf8"));
    for (const [path, entry] of Object.entries(lock.packages)) {
      if (!path.endsWith("/http-cache-semantics")) continue;
      assert.equal(directory, "");
      assert.equal(entry.link, true, `${path} must not contain upstream code`);
      assert.equal(entry.resolved, "packages/astro-no-cache");
    }
  }
});

test("security-zeroed responses cannot gain lifetime from client max-stale", () => {
  const responseHeaders = [
    { "set-cookie": "synthetic=session", "cache-control": "max-age=3600" },
    { "cache-control": "private, max-age=3600" },
    { "cache-control": "no-store, max-age=3600" },
    { "cache-control": "no-cache, max-age=3600" },
    { "cache-control": "max-age=0" },
  ];
  for (const headers of responseHeaders) {
    for (const directive of ["", "max-stale", "max-stale=999999"]) {
      const request = { url, method: "GET", headers: { host: "example.invalid", "cache-control": directive } };
      const policy = new Policy(request, { status: 200, headers }, { shared: true });
      policy.now = () => Date.now() + 1000;
      assert.equal(policy.storable(), false);
      assert.equal(policy.timeToLive(), 0);
      assert.equal(policy.satisfiesWithoutRevalidation, undefined, "no stale-reuse API is provided");
    }
  }
});

test("Astro downloads public and security-zeroed remote images without a positive lifetime", async () => {
  for (const headers of [
    { "cache-control": "public, max-age=3600" },
    { "cache-control": "max-age=3600", "set-cookie": "synthetic=session" },
    { "cache-control": "private, max-age=3600" },
    { "cache-control": "no-store" },
    { "cache-control": "no-cache" },
  ]) {
    const before = Date.now();
    const result = await loadRemoteImage(url, async (request) => {
      assert.equal(request.url, url);
      return new Response("synthetic image bytes", {
        headers: { ...headers, etag: '"image-v1"' },
      });
    });
    assert.equal(result.data.toString(), "synthetic image bytes");
    assert.equal(result.etag, '"image-v1"');
    assert.ok(result.expires >= before && result.expires <= Date.now());
  }
});

test("Astro retries an empty 200 revalidation without losing the downloaded image", async () => {
  let requests = 0;
  const result = await revalidateRemoteImage(url, { etag: '"image-v1"' }, async (request) => {
    requests++;
    assert.equal(request.headers.get("If-None-Match"), requests === 1 ? '"image-v1"' : null);
    return new Response(requests === 1 ? null : "downloaded image", {
      headers: { "cache-control": "max-age=3600" },
    });
  });
  assert.equal(requests, 2);
  assert.equal(result.data.toString(), "downloaded image");
  assert.ok(result.expires <= Date.now());
});

test("Astro preserves conditional revalidation and 304 metadata without extending expiry", async () => {
  const metadata = { etag: '"image-v1"', lastModified: "Wed, 01 Jan 2025 00:00:00 GMT" };
  for (const status of [200, 304]) {
    const result = await revalidateRemoteImage(url, metadata, async (request) => {
      assert.equal(request.headers.get("If-None-Match"), metadata.etag);
      assert.equal(request.headers.get("If-Modified-Since"), metadata.lastModified);
      return new Response(status === 200 ? "updated image" : null, {
        status,
        headers: { "cache-control": "public, max-age=3600", ...(status === 200 ? { etag: '"image-v2"' } : {}) },
      });
    });
    assert.equal(result.data?.toString() ?? null, status === 200 ? "updated image" : null);
    assert.equal(result.etag, status === 200 ? '"image-v2"' : metadata.etag);
    assert.equal(result.lastModified, status === 200 ? undefined : metadata.lastModified);
    assert.ok(result.expires <= Date.now());
  }
});

test("Astro still rejects failed remote-image requests", async () => {
  const fetch = async () => new Response(null, { status: 403 });
  await assert.rejects(loadRemoteImage(url, fetch), /Failed to load remote image/);
  await assert.rejects(revalidateRemoteImage(url, {}, fetch), /Failed to revalidate cached remote image/);
});
