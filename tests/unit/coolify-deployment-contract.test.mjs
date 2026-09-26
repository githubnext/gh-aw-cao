import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

const root = new URL("../../", import.meta.url);

async function text(path) {
  return readFile(new URL(path, root), "utf8");
}

test("Coolify image is multi-stage, non-root, versioned, and health checked", async () => {
  const dockerfile = await text("server/Dockerfile");
  assert.match(dockerfile, /FROM node:24-alpine AS dashboard-build/);
  assert.match(dockerfile, /FROM golang:1\.27-alpine AS server-build/);
  assert.match(dockerfile, /USER 65532:65532/);
  assert.match(dockerfile, /HEALTHCHECK[\s\S]*\/api\/v1\/health/);
  assert.match(dockerfile, /org\.opencontainers\.image\.revision="\$\{REVISION\}"/);
  assert.match(dockerfile, /COPY --from=dashboard-build[\s\S]*\/app\/site\//);
  assert.match(dockerfile, /VOLUME \["\/app\/source"\]/);
});

test("Coolify Compose contains no credentials and requires immutable image input", async () => {
  const source = await text("server/coolify/compose.yml");
  const compose = parse(source);
  const dashboard = compose.services.dashboard;
  assert.match(dashboard.image, /\$\{CAO_IMAGE:\?.*immutable/);
  assert.equal(dashboard.environment.CAO_SOURCE_DIRECTORY, "/app/source");
  assert.match(dashboard.environment.CAO_REDIS_URL, /^\$\{CAO_REDIS_URL:\?/);
  assert.match(dashboard.environment.CAO_TRUSTED_PROXY_CIDRS, /^\$\{CAO_TRUSTED_PROXY_CIDRS:\?/);
  assert.equal(dashboard.ports, undefined);
  assert.deepEqual(dashboard.cap_drop, ["ALL"]);
  for (const [name, value] of Object.entries(dashboard.environment)) {
    if (/SECRET|REDIS_URL/.test(name)) {
      assert.match(value, /^\$\{/, `${name} must be injected by Coolify`);
    }
  }
});

test("deployment workflow publishes no mutable channel and gates every Coolify tier", async () => {
  const source = await text(".github/workflows/coolify-deploy.yml");
  const workflow = parse(source);
  assert.deepEqual(workflow.on.release.types, ["published"]);
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.equal(workflow.jobs.deploy.environment.name, "${{ needs.classify.outputs.environment }}");
  assert.match(source, /PR_HEAD_REPOSITORY.*REPOSITORY/);
  assert.match(source, /environment=coolify-(stable|beta)/);
  assert.match(source, /environment=coolify-alpha/);
  assert.match(source, /environment=coolify-preview/);
  assert.match(source, /sha-\$\{REVISION\}-run-\$\{RUN_ID\}-\$\{RUN_ATTEMPT\}/);
  assert.match(source, /image=\$\{repository\}@\$\{digest\}/);
  assert.doesNotMatch(source, /cao-dashboard:(latest|stable|beta|alpha|preview)\b/);
  assert.match(source, /COOLIFY_DEPLOY_ENDPOINT: \$\{\{ secrets\.COOLIFY_DEPLOY_ENDPOINT \}\}/);
  assert.match(source, /COOLIFY_DEPLOY_TOKEN: \$\{\{ secrets\.COOLIFY_DEPLOY_TOKEN \}\}/);

  for (const match of source.matchAll(/uses:\s+[^@\s]+@([^\s#]+)/g)) {
    assert.match(match[1], /^[0-9a-f]{40}$/, `action is not pinned: ${match[0]}`);
  }
});
