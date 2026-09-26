import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parse } from "yaml";

const root = new URL("../../", import.meta.url);

async function text(path) {
  return readFile(new URL(path, root), "utf8");
}

function classify(script, values) {
  const capturedScript = script.replace('} >> "${GITHUB_OUTPUT}"', "}");
  const result = spawnSync("bash", ["-c", capturedScript], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      EVENT_NAME: "",
      EVENT_ACTION: "",
      RELEASE_PRERELEASE: "",
      RELEASE_TAG: "",
      PR_DRAFT: "",
      PR_HEAD_REPOSITORY: "",
      PR_HEAD_SHA: "",
      PR_NUMBER: "",
      REPOSITORY: "githubnext/gh-aw-cao",
      REF: "",
      SHA: "",
      ...values,
    },
  });
  const outputs = Object.fromEntries(
    result.stdout
      .trim()
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => line.split(/=(.*)/s).slice(0, 2)),
  );
  return { ...result, outputs };
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
  assert.match(source, /identity="sha-\$\{SHA\}"/);
  assert.match(source, /identity="pr-\$\{PR_NUMBER\}-sha-\$\{PR_HEAD_SHA\}"/);
  assert.doesNotMatch(source, /-run-\$\{RUN_ID\}/);
  assert.match(source, /ref: \$\{\{ needs\.classify\.outputs\.source_ref \}\}/);
  assert.match(source, /refs\/tags\/\$\{RELEASE_TAG\}\^\{commit\}/);
  assert.match(source, /REVISION: \$\{\{ steps\.source\.outputs\.sha \}\}/);
  assert.match(source, /SOURCE_SHA: \$\{\{ needs\.image\.outputs\.source_sha \}\}/);
  assert.match(source, /group: coolify-image-\$\{\{ needs\.classify\.outputs\.identity \}\}/);
  assert.match(source, /refusing to redefine an existing immutable source identity/);
  assert.match(source, /existing identity did not resolve to one immutable digest/);
  assert.match(source, /image=\$\{repository\}@\$\{digest\}/);
  assert.doesNotMatch(source, /cao-dashboard:(latest|stable|beta|alpha|preview)\b/);
  assert.match(source, /COOLIFY_DEPLOY_ENDPOINT: \$\{\{ secrets\.COOLIFY_DEPLOY_ENDPOINT \}\}/);
  assert.match(source, /COOLIFY_DEPLOY_TOKEN: \$\{\{ secrets\.COOLIFY_DEPLOY_TOKEN \}\}/);

  for (const match of source.matchAll(/uses:\s+[^@\s]+@([^\s#]+)/g)) {
    assert.match(match[1], /^[0-9a-f]{40}$/, `action is not pinned: ${match[0]}`);
  }
});

test("deployment channels map to exact source refs and immutable identities", async () => {
  const workflow = parse(await text(".github/workflows/coolify-deploy.yml"));
  const script = workflow.jobs.classify.steps.find((step) => step.id === "tier").run;
  const stable = classify(script, {
    EVENT_NAME: "release",
    EVENT_ACTION: "published",
    RELEASE_PRERELEASE: "false",
    RELEASE_TAG: "v1.2.3",
  });
  assert.equal(stable.status, 0, stable.stderr);
  assert.deepEqual(stable.outputs, {
    eligible: "true",
    environment: "coolify-stable",
    tier: "stable",
    version: "v1.2.3",
    identity: "v1.2.3",
    source_ref: "refs/tags/v1.2.3",
    expected_sha: "",
    pr_number: "",
  });

  const beta = classify(script, {
    EVENT_NAME: "release",
    EVENT_ACTION: "published",
    RELEASE_PRERELEASE: "true",
    RELEASE_TAG: "v2.0.0-rc.1",
  });
  assert.equal(beta.status, 0, beta.stderr);
  assert.equal(beta.outputs.environment, "coolify-beta");
  assert.equal(beta.outputs.identity, "v2.0.0-rc.1");
  assert.equal(beta.outputs.source_ref, "refs/tags/v2.0.0-rc.1");

  const mainSha = "a".repeat(40);
  const alpha = classify(script, {
    EVENT_NAME: "push",
    REF: "refs/heads/main",
    SHA: mainSha,
  });
  assert.equal(alpha.status, 0, alpha.stderr);
  assert.equal(alpha.outputs.environment, "coolify-alpha");
  assert.equal(alpha.outputs.identity, `sha-${mainSha}`);
  assert.equal(alpha.outputs.source_ref, mainSha);
  assert.equal(alpha.outputs.expected_sha, mainSha);

  const headSha = "b".repeat(40);
  const preview = classify(script, {
    EVENT_NAME: "pull_request",
    PR_DRAFT: "false",
    PR_HEAD_REPOSITORY: "githubnext/gh-aw-cao",
    PR_HEAD_SHA: headSha,
    PR_NUMBER: "42",
    SHA: "c".repeat(40),
  });
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(preview.outputs.environment, "coolify-preview");
  assert.equal(preview.outputs.identity, `pr-42-sha-${headSha}`);
  assert.equal(preview.outputs.source_ref, headSha);
  assert.equal(preview.outputs.expected_sha, headSha);
  assert.notEqual(preview.outputs.source_ref, "c".repeat(40));
});

test("deployment classification fails closed on invalid release versions and sources", async () => {
  const workflow = parse(await text(".github/workflows/coolify-deploy.yml"));
  const script = workflow.jobs.classify.steps.find((step) => step.id === "tier").run;
  const invalidReleases = [
    ["false", "1.2.3"],
    ["false", "v1.2"],
    ["false", "v1.2.3-rc.1"],
    ["false", "v1.2.3+build.1"],
    ["true", "v1.2.3"],
    ["true", "v1.2.3-01"],
    ["true", "v1.2.3-rc.1+build.1"],
  ];
  for (const [prerelease, tag] of invalidReleases) {
    const result = classify(script, {
      EVENT_NAME: "release",
      EVENT_ACTION: "published",
      RELEASE_PRERELEASE: prerelease,
      RELEASE_TAG: tag,
    });
    assert.notEqual(result.status, 0, `${tag} unexpectedly passed`);
  }

  const wrongBranch = classify(script, {
    EVENT_NAME: "push",
    REF: "refs/heads/not-main",
    SHA: "a".repeat(40),
  });
  assert.notEqual(wrongBranch.status, 0);

  const invalidHead = classify(script, {
    EVENT_NAME: "pull_request",
    PR_DRAFT: "false",
    PR_HEAD_REPOSITORY: "githubnext/gh-aw-cao",
    PR_HEAD_SHA: "not-a-sha",
    PR_NUMBER: "7",
  });
  assert.notEqual(invalidHead.status, 0);
});
