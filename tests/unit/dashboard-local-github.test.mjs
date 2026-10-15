import assert from "node:assert/strict";
import test from "node:test";
import { createLocalGitHubService } from "../../dashboard/local-github-service.mjs";

const path = "/api/v1/github/repos/githubnext/gh-aw-cao";
const repository = {
  full_name: "githubnext/gh-aw-cao", description: null,
  html_url: "https://github.com/githubnext/gh-aw-cao", default_branch: "main",
  stargazers_count: 1, forks_count: 2, open_issues_count: 3, archived: false, visibility: "public",
};
const credential = () => "test-credential";
const reply = (body = repository, headers = {}) => Response.json(body, { headers });

test("local GitHub reads are allowlisted, cached, and conditionally returned", async () => {
  let requests = 0;
  const service = createLocalGitHubService({
    token: credential,
    fetchImpl: async (url, options) => {
      requests++;
      assert.equal(url, "https://api.github.com/repos/githubnext/gh-aw-cao");
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.Authorization, ["Bearer", credential()].join(" "));
      return reply({ ...repository, secret: "not returned", owner: { email: "not returned" } }, { etag: '"upstream"' });
    },
  });
  const first = await service.request(path);
  assert.deepEqual(first.body, repository);
  assert.equal(first.status, 200);
  assert.match(first.headers["Cache-Control"], /private.*max-age=300/);
  const next = await service.request(path, `W/${first.headers.ETag}`);
  assert.equal(next.status, 304);
  assert.equal(next.body, undefined);
  assert.equal(requests, 1);
});

test("local GitHub revalidation uses upstream ETags and keeps normalized client ETag", async () => {
  let clock = 1000;
  let calls = 0;
  const service = createLocalGitHubService({
    token: credential, now: () => clock,
    fetchImpl: async (_url, options) => {
      if (++calls === 1) return reply(repository, { etag: '"upstream"' });
      assert.equal(options.headers["If-None-Match"], '"upstream"');
      return new Response(null, { status: 304 });
    },
  });
  const first = await service.request(path);
  clock += 301_000;
  const second = await service.request(path, first.headers.ETag);
  assert.equal(second.status, 304);
  assert.equal(second.headers.ETag, first.headers.ETag);
  assert.equal(calls, 2);
});

test("local GitHub requests deduplicate credential lookup and resource fetch", async () => {
  let tokens = 0;
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const service = createLocalGitHubService({
    token: async () => { tokens++; await gate; return credential(); },
    fetchImpl: async () => { calls++; return reply(); },
  });
  const pending = Array.from({ length: 10 }, () => service.request(path));
  release();
  const results = await Promise.all(pending);
  assert.equal(tokens, 1);
  assert.equal(calls, 1);
  assert.ok(results.every((result) => result.status === 200));
});

test("missing local credentials degrade quietly and back off", async () => {
  let tokens = 0;
  const service = createLocalGitHubService({
    token: () => { tokens++; throw new Error("private diagnostic"); },
    fetchImpl: () => { throw new Error("Must not fetch"); },
  });
  assert.equal((await service.request(path)).status, 503);
  const next = await service.request(path);
  assert.equal(next.status, 503);
  assert.equal(tokens, 1);
  assert.doesNotMatch(JSON.stringify(next), /private diagnostic/);
});

test("local GitHub rate limits pause all resource refreshes and preserve stale data", async () => {
  let clock = 0;
  let calls = 0;
  const service = createLocalGitHubService({
    token: credential, now: () => clock,
    fetchImpl: async () => ++calls === 1 ? reply()
      : new Response(null, { status: 429, headers: { "Retry-After": "120" } }),
  });
  const first = await service.request(path);
  clock += 301_000;
  const stale = await service.request(path, first.headers.ETag);
  assert.equal(stale.status, 200);
  assert.match(stale.headers.Warning, /stale/);
  assert.equal(stale.headers["Retry-After"], "120");
  assert.deepEqual(stale.body, repository);
  const limited = await service.request(`${path}/releases/latest`);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers["Retry-After"], "120");
  assert.equal(calls, 2);
});

test("latest releases expose only safe fields and missing releases return 404", async () => {
  const release = { tag_name: "v1", name: null, html_url: "https://github.com/o/r/releases/tag/v1", published_at: null, draft: false, prerelease: false };
  const service = createLocalGitHubService({
    token: credential,
    fetchImpl: async (url) => url.includes("/other/") ? new Response(null, { status: 404 })
      : reply({ ...release, assets: [{ body: "omitted" }] }),
  });
  assert.deepEqual((await service.request(`${path}/releases/latest`)).body, release);
  assert.equal((await service.request("/api/v1/github/repos/other/repo/releases/latest")).status, 404);
});

test("unsafe resource paths are rejected without using credentials", async () => {
  const service = createLocalGitHubService({ token: () => { throw new Error("Must not authenticate"); } });
  for (const value of ["/api/v1/github/repos/o/..", "/api/v1/github/repos/o/r/issues", "/api/v1/github/repos/o/r%2fsecret", "/api/v1/github/repos/o/r?token=anything"]) {
    assert.equal((await service.request(value)).status, 400);
  }
});

test("local cached responses never cross credential boundaries", async () => {
  let active = "first";
  let calls = 0;
  const service = createLocalGitHubService({
    token: () => active,
    fetchImpl: async () => { calls++; return reply(); },
  });
  await service.request(path);
  active = "second";
  await service.request(path);
  assert.equal(calls, 2);
});

test("network failure and oversized upstream payloads do not replace cached data", async () => {
  let clock = 0;
  let calls = 0;
  const service = createLocalGitHubService({
    token: credential, now: () => clock,
    fetchImpl: async () => {
      if (++calls === 1) return reply();
      return new Response("too large", { headers: { "Content-Length": "999999999" } });
    },
  });
  await service.request(path);
  clock += 301_000;
  const stale = await service.request(path);
  assert.deepEqual(stale.body, repository);
  assert.match(stale.headers.Warning, /stale/);
});

test("malformed GitHub fields fail closed instead of exposing unrestricted objects", async () => {
  const service = createLocalGitHubService({
    token: credential,
    fetchImpl: async () => reply({ ...repository, description: { secret: "must not be returned" } }),
  });
  const result = await service.request(path);
  assert.equal(result.status, 503);
  assert.doesNotMatch(JSON.stringify(result), /must not be returned/);
});
