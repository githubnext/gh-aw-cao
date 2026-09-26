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
      DISPATCH_CHANNEL: "",
      MANUAL_RELEASE_TAG: "",
      MANUAL_SOURCE_SHA: "",
      REPOSITORY_FORK: "false",
      REF: "",
      SHA: "",
      GITHUB_REPOSITORY: "githubnext/gh-aw-cao",
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
  assert.equal(workflow.on.repository_dispatch, undefined);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.channel, {
    description: "Deployment channel",
    required: true,
    type: "choice",
    options: ["alpha", "beta", "stable"],
  });
  assert.deepEqual(workflow.on.release.types, ["published"]);
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.equal(workflow.jobs.deploy.environment.name, "${{ needs.classify.outputs.environment }}");
  assert.equal(workflow.jobs.test.needs, "classify");
  assert.equal(workflow.jobs.test.if, "needs.classify.outputs.eligible == 'true'");
  assert.deepEqual(workflow.jobs.image.needs, ["classify", "test"]);
  const testCheckout = workflow.jobs.test.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
  const imageCheckout = workflow.jobs.image.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
  const setupNode = workflow.jobs.test.steps.find((step) => step.uses?.startsWith("actions/setup-node@"));
  assert.equal(testCheckout.with.ref, "${{ github.sha }}");
  assert.equal(imageCheckout.with.ref, testCheckout.with.ref);
  assert.equal(setupNode.with.cache, undefined);
  assert.equal(workflow.jobs.image.permissions, undefined);
  assert.equal(workflow.jobs.publish.permissions.packages, "write");
  assert.equal(workflow.jobs.deploy.needs[1], "publish");
  assert.deepEqual(workflow.jobs.deploy.permissions, { contents: "read" });
  assert.match(source, /Reject fork repository payload/);
  assert.match(source, /Resolve manual channel source/);
  assert.match(source, /DISPATCH_CHANNEL: \$\{\{ inputs\.channel \}\}/);
  assert.match(source, /MANUAL_RELEASE_TAG: \$\{\{ steps\.manual-source\.outputs\.tag \}\}/);
  assert.match(source, /MANUAL_SOURCE_SHA: \$\{\{ steps\.manual-source\.outputs\.sha \}\}/);
  const manualSource = workflow.jobs.classify.steps.find((step) => step.id === "manual-source");
  assert.equal(
    manualSource.if,
    "github.event_name == 'workflow_dispatch' && (github.ref == 'refs/heads/main' || github.ref == 'refs/heads/release')",
  );
  assert.match(manualSource.with.script, /github\.paginate\(github\.rest\.repos\.listReleases/);
  assert.match(manualSource.with.script, /release\.prerelease === prerelease/);
  assert.match(manualSource.with.script, /release\.published_at/);
  assert.match(manualSource.with.script, /Date\.parse\(right\.published_at\) - Date\.parse\(left\.published_at\)/);
  assert.match(manualSource.with.script, /ref: `tags\/\$\{tag\}`/);
  assert.match(manualSource.with.script, /object\.type !== 'commit'/);
  assert.match(manualSource.with.script, /core\.setOutput\('tag', tag\)/);
  assert.match(manualSource.with.script, /core\.setOutput\('sha', sha\)/);
  assert.match(source, /environment=coolify-(stable|beta)/);
  assert.match(source, /environment=coolify-alpha/);
  assert.match(source, /identity="sha-\$\{SHA\}"/);
  assert.doesNotMatch(source, /pull[-_]requests|pull_request|preview/i);
  assert.match(source, /candidate_identity="candidate-\$\{RUN_ID\}-\$\{RUN_ATTEMPT\}"/);
  assert.match(source, /candidate identity is not unique or is a channel alias/);
  assert.match(source, /git checkout --detach "\$\{EXPECTED_SHA\}"/);
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
  assert.doesNotMatch(source, /cao-dashboard:(latest|stable|beta|alpha)\b/);
  assert.match(source, /created="\$\(git show -s --format=%cI "\$\{REVISION\}"\)"/);
  assert.match(source, /Alpha source is no longer the main branch HEAD/);
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

test("deployment workflow logs every delivery phase without exposing sensitive adapter data", async () => {
  const source = await text(".github/workflows/coolify-deploy.yml");
  const groups = source.match(/::group::/g) ?? [];
  const summaries = source.match(/GITHUB_STEP_SUMMARY|core\.summary/g) ?? [];
  const informationalLogs = source.match(/core\.info|echo "(?!::)/g) ?? [];

  assert.ok(groups.length >= 10, `expected abundant grouped logs, found ${groups.length}`);
  assert.ok(summaries.length >= 10, `expected abundant step summaries, found ${summaries.length}`);
  assert.ok(informationalLogs.length >= 30, `expected abundant informational logs, found ${informationalLogs.length}`);

  for (const phrase of [
    "Validate repository payload",
    "Resolve published release source",
    "Resolve manual channel source",
    "Classify deployment event",
    "Verify test checkout",
    "Tests and production build",
    "Verify image source checkout",
    "Candidate image metadata",
    "Trivy high/critical scan",
    "Save scanned candidate",
    "Artifact upload",
    "Publish unique GHCR candidate",
    "Bind canonical image identity",
    "Candidate digest",
    "Canonical digest",
    "Revalidate deployment source freshness",
    "Deployment source freshness",
    "Request digest deployment",
    "Adapter HTTP status",
    "Adapter result: ready digest confirmed",
  ]) {
    assert.match(source, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  assert.doesNotMatch(source, /set\s+-[^ \n]*x/);
  assert.doesNotMatch(source, /curl[\s\S]*?--(?:verbose|trace(?:-ascii)?)(?:\s|\\)/);
  assert.doesNotMatch(source, /--show-error/);
  assert.doesNotMatch(
    source,
    /(?:echo|printf|cat|head|tail)\b[^\n]*(?:COOLIFY_DEPLOY_ENDPOINT|COOLIFY_DEPLOY_TOKEN|\$\{payload\}|\$\{response(?:_file)?\}|\$\{[A-Z_]*(?:TOKEN|SECRET|REDIS|OAUTH|SESSION|WEBHOOK|ENDPOINT)[A-Z_]*\})/,
  );
  assert.doesNotMatch(
    source,
    /core\.(?:info|debug|notice|warning|error)\([^\n]*(?:COOLIFY_DEPLOY_ENDPOINT|COOLIFY_DEPLOY_TOKEN|process\.env\.(?:COOLIFY|REDIS|OAUTH|SESSION|WEBHOOK))/,
  );
  assert.doesNotMatch(source, /(?:cat|head|tail|less|more)\s+["']?\$\{response_file\}/);
  assert.doesNotMatch(source, /echo\s+["']?\$\{inspect_output\}/);

  const errorMessages = [
    ...source.matchAll(/echo\s+"([^"]+)"\s+>&2/g),
    ...source.matchAll(/throw new Error\((?:`([^`]+)`|'([^']+)'|"([^"]+)")\)/g),
  ].map((match) => match.slice(1).find(Boolean));
  for (const message of errorMessages) {
    assert.doesNotMatch(message, /\p{Extended_Pictographic}/u, `error message contains an emoji: ${message}`);
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

  const manualAlpha = classify(script, {
    EVENT_NAME: "workflow_dispatch",
    DISPATCH_CHANNEL: "alpha",
    REF: "refs/heads/main",
    SHA: mainSha,
    MANUAL_SOURCE_SHA: mainSha,
  });
  assert.equal(manualAlpha.status, 0, manualAlpha.stderr);
  assert.equal(manualAlpha.outputs.environment, "coolify-alpha");
  assert.equal(manualAlpha.outputs.identity, `sha-${mainSha}`);
  assert.equal(manualAlpha.outputs.source_ref, mainSha);

  for (const ref of ["refs/heads/main", "refs/heads/release"]) {
    const manualBetaSha = "b".repeat(40);
    const manualBeta = classify(script, {
      EVENT_NAME: "workflow_dispatch",
      DISPATCH_CHANNEL: "beta",
      REF: ref,
      SHA: "c".repeat(40),
      MANUAL_RELEASE_TAG: "v3.0.0-rc.2",
      MANUAL_SOURCE_SHA: manualBetaSha,
    });
    assert.equal(manualBeta.status, 0, manualBeta.stderr);
    assert.equal(manualBeta.outputs.environment, "coolify-beta");
    assert.equal(manualBeta.outputs.identity, "v3.0.0-rc.2");
    assert.equal(manualBeta.outputs.source_ref, manualBetaSha);
    assert.equal(manualBeta.outputs.expected_sha, manualBetaSha);
    assert.notEqual(manualBeta.outputs.source_ref, "c".repeat(40));

    const manualStableSha = "f".repeat(40);
    const manualStable = classify(script, {
      EVENT_NAME: "workflow_dispatch",
      DISPATCH_CHANNEL: "stable",
      REF: ref,
      SHA: "c".repeat(40),
      MANUAL_RELEASE_TAG: "v3.0.0",
      MANUAL_SOURCE_SHA: manualStableSha,
    });
    assert.equal(manualStable.status, 0, manualStable.stderr);
    assert.equal(manualStable.outputs.environment, "coolify-stable");
    assert.equal(manualStable.outputs.identity, "v3.0.0");
    assert.equal(manualStable.outputs.source_ref, manualStableSha);
    assert.equal(manualStable.outputs.expected_sha, manualStableSha);
    assert.notEqual(manualStable.outputs.source_ref, "c".repeat(40));
  }
});

test("deployment classification fails closed on forks, branches, and invalid sources", async () => {
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

  const fork = classify(script, {
    EVENT_NAME: "push",
    REF: "refs/heads/main",
    SHA: "a".repeat(40),
    REPOSITORY_FORK: "true",
  });
  assert.notEqual(fork.status, 0);
  assert.match(fork.stderr, /refused for a fork repository payload/);

  const mutableReleaseTarget = classify(script, {
    EVENT_NAME: "release",
    EVENT_ACTION: "published",
    RELEASE_PRERELEASE: "false",
    RELEASE_TAG: "v1.2.3",
    RELEASE_SOURCE_SHA: "main",
  });
  assert.notEqual(mutableReleaseTarget.status, 0);

  const invalidManualBranch = classify(script, {
    EVENT_NAME: "workflow_dispatch",
    DISPATCH_CHANNEL: "stable",
    REF: "refs/heads/feature",
    MANUAL_RELEASE_TAG: "v1.2.3",
    MANUAL_SOURCE_SHA: "d".repeat(40),
  });
  assert.notEqual(invalidManualBranch.status, 0);

  const alphaFromRelease = classify(script, {
    EVENT_NAME: "workflow_dispatch",
    DISPATCH_CHANNEL: "alpha",
    REF: "refs/heads/release",
    SHA: "a".repeat(40),
    MANUAL_SOURCE_SHA: "a".repeat(40),
  });
  assert.notEqual(alphaFromRelease.status, 0);

  const staleMainAlpha = classify(script, {
    EVENT_NAME: "workflow_dispatch",
    DISPATCH_CHANNEL: "alpha",
    REF: "refs/heads/main",
    SHA: "a".repeat(40),
    MANUAL_SOURCE_SHA: "b".repeat(40),
  });
  assert.notEqual(staleMainAlpha.status, 0);

  const branchHeadStable = classify(script, {
    EVENT_NAME: "workflow_dispatch",
    DISPATCH_CHANNEL: "stable",
    REF: "refs/heads/release",
    SHA: "a".repeat(40),
    MANUAL_RELEASE_TAG: "",
    MANUAL_SOURCE_SHA: "a".repeat(40),
  });
  assert.notEqual(branchHeadStable.status, 0);

  const stableWithPrerelease = classify(script, {
    EVENT_NAME: "workflow_dispatch",
    DISPATCH_CHANNEL: "stable",
    REF: "refs/heads/main",
    MANUAL_RELEASE_TAG: "v1.2.3-rc.1",
    MANUAL_SOURCE_SHA: "d".repeat(40),
  });
  assert.notEqual(stableWithPrerelease.status, 0);

  const betaWithStable = classify(script, {
    EVENT_NAME: "workflow_dispatch",
    DISPATCH_CHANNEL: "beta",
    REF: "refs/heads/release",
    MANUAL_RELEASE_TAG: "v1.2.3",
    MANUAL_SOURCE_SHA: "d".repeat(40),
  });
  assert.notEqual(betaWithStable.status, 0);
});
