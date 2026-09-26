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
      RELEASE_SOURCE_SHA: "",
      PREVIEW_PR: "",
      PREVIEW_SHA: "",
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
  assert.match(dockerfile, /FROM node:24-alpine@sha256:[0-9a-f]{64} AS dashboard-build/);
  assert.match(dockerfile, /FROM golang:1\.27-alpine@sha256:[0-9a-f]{64} AS server-build/);
  assert.match(dockerfile, /FROM alpine:3\.22@sha256:[0-9a-f]{64}/);
  for (const line of dockerfile.match(/^FROM .*$/gm) ?? []) {
    assert.match(line, /@sha256:[0-9a-f]{64}(?: AS \S+)?$/, `base image is not digest-pinned: ${line}`);
  }
  assert.match(dockerfile, /USER 65532:65532/);
  assert.match(dockerfile, /HEALTHCHECK[\s\S]*\/api\/readiness/);
  assert.doesNotMatch(dockerfile, /HEALTHCHECK[\s\S]*\/api\/v1\/health/);
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
  assert.deepEqual(dashboard.volumes, ["cao-dashboard-artifact:/app/source:ro"]);
  assert.equal(compose.volumes["cao-dashboard-artifact"].external, true);
  assert.match(compose.volumes["cao-dashboard-artifact"].name, /^\$\{CAO_ARTIFACT_VOLUME:\?/);
  assert.doesNotMatch(source, /\.\/artifact:/);
  for (const [name, value] of Object.entries(dashboard.environment)) {
    if (/SECRET|REDIS_URL/.test(name)) {
      assert.match(value, /^\$\{/, `${name} must be injected by Coolify`);
    }
  }
});

test("deployment workflow publishes no mutable channel and gates every Coolify tier", async () => {
  const source = await text(".github/workflows/coolify-deploy.yml");
  const workflow = parse(source);
  assert.equal(workflow.on.pull_request_target, undefined);
  assert.equal(workflow.on.pull_request, undefined);
  assert.deepEqual(workflow.on.repository_dispatch.types, ["coolify-preview"]);
  assert.equal(workflow.on.workflow_dispatch, undefined);
  assert.deepEqual(workflow.on.release.types, ["published"]);
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.equal(workflow.jobs.deploy.environment.name, "${{ needs.classify.outputs.environment }}");
  assert.equal(workflow.jobs.test.needs, "classify");
  assert.equal(workflow.jobs.test.if, "needs.classify.outputs.eligible == 'true'");
  assert.deepEqual(workflow.jobs.image.needs, ["classify", "test"]);
  const testCheckout = workflow.jobs.test.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
  const imageCheckout = workflow.jobs.image.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
  assert.equal(testCheckout.with.ref, "${{ needs.classify.outputs.source_ref }}");
  assert.equal(imageCheckout.with.ref, testCheckout.with.ref);
  assert.equal(workflow.jobs.image.permissions, undefined);
  assert.equal(workflow.jobs.publish.permissions.packages, "write");
  assert.equal(workflow.jobs.deploy.needs[1], "publish");
  assert.match(source, /Resolve eligible preview pull request/);
  assert.match(source, /pull\.head\.repo\?\.full_name !== `\$\{context\.repo\.owner\}\/\$\{context\.repo\.repo\}`/);
  assert.match(source, /PREVIEW_PR: \$\{\{ steps\.preview-source\.outputs\.number \}\}/);
  assert.match(source, /PREVIEW_SHA: \$\{\{ steps\.preview-source\.outputs\.sha \}\}/);
  assert.match(source, /environment=coolify-(stable|beta)/);
  assert.match(source, /environment=coolify-alpha/);
  assert.match(source, /environment=coolify-preview/);
  assert.match(source, /identity="sha-\$\{SHA\}"/);
  assert.match(source, /identity="pr-\$\{PREVIEW_PR\}-sha-\$\{PREVIEW_SHA\}"/);
  assert.doesNotMatch(source, /pull_request_target/);
  assert.match(source, /candidate_identity="candidate-\$\{RUN_ID\}-\$\{RUN_ATTEMPT\}"/);
  assert.match(source, /candidate identity is not unique or is a channel alias/);
  assert.match(source, /ref: \$\{\{ needs\.classify\.outputs\.source_ref \}\}/);
  assert.match(source, /refs\/tags\/\$\{RELEASE_TAG\}\^\{commit\}/);
  assert.match(source, /Resolve published release tag/);
  assert.match(source, /core\.setOutput\('sha', object\.sha\)/);
  assert.match(source, /RELEASE_SOURCE_SHA: \$\{\{ steps\.release-source\.outputs\.sha \}\}/);
  assert.match(source, /source_ref="\$\{RELEASE_SOURCE_SHA\}"/);
  assert.match(source, /expected_sha="\$\{RELEASE_SOURCE_SHA\}"/);
  assert.match(source, /REVISION: \$\{\{ steps\.source\.outputs\.sha \}\}/);
  assert.match(source, /SOURCE_SHA: \$\{\{ needs\.publish\.outputs\.source_sha \}\}/);
  assert.match(source, /group: coolify-image-\$\{\{ needs\.classify\.outputs\.identity \}\}/);
  assert.match(source, /refusing to redefine an existing immutable source identity/);
  assert.match(source, /existing identity did not resolve to one immutable digest/);
  assert.match(source, /canonical identity does not equal the scanned candidate digest/);
  assert.match(source, /image=\$\{repository\}@\$\{candidate_digest\}/);
  assert.match(source, /docker buildx imagetools create[\s\S]*--prefer-index=false[\s\S]*--tag "\$\{canonical_reference\}"[\s\S]*"\$\{repository\}@\$\{candidate_digest\}"/);
  assert.doesNotMatch(source, /existing_revision|existing_version/);
  assert.doesNotMatch(source, /cao-dashboard:(latest|stable|beta|alpha|preview)\b/);
  assert.match(source, /created="\$\(git show -s --format=%cI "\$\{REVISION\}"\)"/);
  assert.match(source, /Alpha source is no longer the main branch HEAD/);
  assert.match(source, /Preview source is no longer the open pull request HEAD/);
  assert.match(source, /latest published release for its channel/);
  assert.match(source, /prereleaseTag/);
  assert.match(source, /stableTag/);
  assert.match(source, /Published release tag no longer peels to its event target SHA/);
  assert.match(source, /COOLIFY_DEPLOY_ENDPOINT: \$\{\{ secrets\.COOLIFY_DEPLOY_ENDPOINT \}\}/);
  assert.match(source, /COOLIFY_DEPLOY_TOKEN: \$\{\{ secrets\.COOLIFY_DEPLOY_TOKEN \}\}/);
  assert.match(source, /--max-time 300/);
  assert.match(source, /--max-filesize 65536/);
  assert.match(source, /\.status == "ready"/);
  assert.match(source, /\.image == \$image/);
  assert.match(source, /\.digest == \$digest/);
  assert.match(source, /trap 'rm -f -- "\$\{response_file\}"' EXIT/);

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
    RELEASE_SOURCE_SHA: "d".repeat(40),
  });
  assert.equal(stable.status, 0, stable.stderr);
  assert.deepEqual(stable.outputs, {
    eligible: "true",
    environment: "coolify-stable",
    tier: "stable",
    version: "v1.2.3",
    identity: "v1.2.3",
    source_ref: "d".repeat(40),
    expected_sha: "d".repeat(40),
    pr_number: "",
  });

  const beta = classify(script, {
    EVENT_NAME: "release",
    EVENT_ACTION: "published",
    RELEASE_PRERELEASE: "true",
    RELEASE_TAG: "v2.0.0-rc.1",
    RELEASE_SOURCE_SHA: "e".repeat(40),
  });
  assert.equal(beta.status, 0, beta.stderr);
  assert.equal(beta.outputs.environment, "coolify-beta");
  assert.equal(beta.outputs.identity, "v2.0.0-rc.1");
  assert.equal(beta.outputs.source_ref, "e".repeat(40));
  assert.equal(beta.outputs.expected_sha, "e".repeat(40));

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
    EVENT_NAME: "repository_dispatch",
    PREVIEW_SHA: headSha,
    PREVIEW_PR: "42",
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
      RELEASE_SOURCE_SHA: "d".repeat(40),
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
    EVENT_NAME: "repository_dispatch",
    PREVIEW_SHA: "not-a-sha",
    PREVIEW_PR: "7",
  });
  assert.notEqual(invalidHead.status, 0);

  const mutableReleaseTarget = classify(script, {
    EVENT_NAME: "release",
    EVENT_ACTION: "published",
    RELEASE_PRERELEASE: "false",
    RELEASE_TAG: "v1.2.3",
    RELEASE_SOURCE_SHA: "main",
  });
  assert.notEqual(mutableReleaseTarget.status, 0);

  const missingPreview = classify(script, {
    EVENT_NAME: "repository_dispatch",
  });
  assert.notEqual(missingPreview.status, 0);
});
