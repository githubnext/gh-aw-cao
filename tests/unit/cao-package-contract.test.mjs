import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

const root = new URL("../../", import.meta.url);

async function text(path) {
  return readFile(new URL(path, root), "utf8");
}

function maxEchoedDetailsDepth(source) {
  let depth = 0;
  let maximum = 0;
  for (const line of source.split(/\r?\n/)) {
    if (line.includes('echo "<details')) {
      depth += 1;
      maximum = Math.max(maximum, depth);
    }
    if (line.includes('echo "</details>"')) {
      depth -= 1;
      assert.ok(depth >= 0, "summary details are unbalanced");
    }
  }
  assert.equal(depth, 0, "summary details are unbalanced");
  return maximum;
}

test("CAO server package workflow publishes immutable Compose-ready images", async () => {
  const source = await text(".github/workflows/cao-package.yml");
  const buildSource = await text(".github/workflows/cao-package-build.yml");
  const publisherSource = await text(".github/workflows/cao-package-publish.yml");
  const requestSource = await text(".github/workflows/cao-package-request.yml");
  const requestPublisherSource = await text(
    ".github/workflows/cao-package-request-publish.yml",
  );
  const workflow = parse(source);
  const build = parse(buildSource);
  const publisher = parse(publisherSource);
  const request = parse(requestSource);
  const requestPublisher = parse(requestPublisherSource);

  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.deepEqual(workflow.on.release.types, ["released"]);
  assert.equal(workflow.on.workflow_dispatch, undefined);
  assert.equal(workflow.on.pull_request, undefined);
  assert.equal(workflow.permissions.contents, "read");
  assert.equal(workflow.jobs.build.uses, "./.github/workflows/cao-package-build.yml");
  assert.equal(workflow.jobs.publish.permissions.packages, "write");
  assert.equal(workflow.jobs.publish.permissions.attestations, "write");
  assert.equal(workflow.jobs.publish.permissions["id-token"], "write");
  assert.equal(
    workflow.jobs.publish.uses,
    "githubnext/gh-aw-cao/.github/workflows/cao-package-publish.yml@main",
  );
  assert.equal(workflow.jobs.publish.needs, "build");
  assert.equal(build.on.workflow_call.inputs.source_branch.required, false);
  assert.equal(build.permissions.contents, "read");
  assert.equal(publisher.on.workflow_call.inputs.revision.required, true);
  assert.equal(publisher.jobs.publish.permissions.packages, "write");
  assert.equal(publisher.jobs.publish.permissions.attestations, "write");
  assert.equal(publisher.jobs.publish.permissions["id-token"], "write");
  assert.deepEqual(build.jobs.build.needs, ["source", "lint", "test"]);
  assert.equal(build.jobs.lint.name, "Lint container and workflow sources");
  assert.equal(build.jobs.test.name, "Test package sources");
  assert.equal(build.jobs.build.name, "Build, scan, and seal candidate");
  assert.deepEqual(build.jobs.test.permissions, { contents: "read" });
  assert.equal(build.jobs.source.steps[0].id, "repository-origin");
  assert.equal(build.jobs.source.steps[0].name, "Reject fork package sources");
  assert.doesNotMatch(
    build.jobs.build.steps.map((step) => step.run ?? "").join("\n"),
    /npm ci|go -C server test|dashboard:server:build/,
  );

  assert.match(publisherSource, /ghcr\.io\/\$\{REPOSITORY,,\}\/cao-server/);
  assert.match(buildSource, /identity="sha-\$\{SHA\}"/);
  assert.match(buildSource, /identity="dispatch-\$\{DISPATCH_REVISION\}"/);
  assert.match(buildSource, /version="0\.0\.0-main\.\$\{SHA:0:12\}"/);
  assert.match(buildSource, /version="0\.0\.0-dispatch\.\$\{DISPATCH_REVISION:0:12\}"/);
  assert.match(buildSource, /Manual package publication requires maintain or admin repository permission/);
  assert.match(buildSource, /Manual package publication must run from the current default-branch workflow/);
  assert.match(buildSource, /Manual package publication requires a source branch/);
  assert.match(buildSource, /Requested source branch resolved to its current head/);
  assert.match(buildSource, /CAO server packages cannot be published from forks/);
  assert.doesNotMatch(buildSource, /context\.payload\.repository\.fork/);
  assert.ok((buildSource.match(/core\.info\(/g) ?? []).length >= 12);
  assert.match(buildSource, /Manual package authorization completed/);
  assert.match(buildSource, /Stable release source resolution completed/);
  assert.match(buildSource, /Published release tag must be an exact stable version vX\.Y\.Z/);
  assert.doesNotMatch(buildSource, /prereleaseTag|vX\.Y\.Z-prerelease/);
  assert.match(buildSource, /--file server\/Dockerfile/);
  assert.match(buildSource, /--build-arg "CAO_PROFILE=cao\.json"/);
  assert.match(buildSource, /go -C server test \.\/\.\.\./);
  assert.match(buildSource, /npm run dashboard:server:build/);
  assert.match(buildSource, /aquasecurity\/trivy-action@[0-9a-f]{40}/);
  assert.match(buildSource, /severity: CRITICAL,HIGH/);
  assert.match(buildSource, /anchore\/scan-action@[0-9a-f]{40}/);
  assert.match(buildSource, /anchore\/sbom-action@[0-9a-f]{40}/);
  assert.match(buildSource, /hadolint\/hadolint:v2\.15\.1-alpine@sha256:[0-9a-f]{64}/);
  assert.match(buildSource, /goodwithtech\/dockle:v0\.4\.15@sha256:[0-9a-f]{64}/);
  assert.match(buildSource, /ghcr\.io\/zizmorcore\/zizmor:1\.30\.1@sha256:[0-9a-f]{64}/);
  assert.match(buildSource, /rhysd\/actionlint:1\.7\.12@sha256:[0-9a-f]{64}/);
  assert.match(buildSource, /cao-server-static-checks-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(buildSource, /static-check-results\/hadolint\.txt/);
  assert.match(buildSource, /static-check-results\/actionlint\.txt/);
  assert.match(buildSource, /static-check-results\/zizmor\.txt/);
  assert.match(buildSource, /retention-days: 7/);
  for (const id of ["hadolint", "actionlint", "zizmor"]) {
    const step = build.jobs.lint.steps.find((candidate) => candidate.id === id);
    assert.equal(step.if, "always()", `${id} must run even if an earlier static check fails`);
  }
  assert.match(buildSource, /release package source is not reachable from protected main/);
  assert.match(buildSource, /published release tag no longer matches the tested package source/);
  assert.match(publisherSource, /sha256sum --check cao-server\.sha256/);
  assert.match(buildSource, /cao-server-metadata\.json/);
  assert.match(publisherSource, /actions\/attest@[0-9a-f]{40}/);
  assert.match(publisherSource, /push-to-registry: true/);
  assert.ok((publisherSource.match(/core\.info\(/g) ?? []).length >= 20);
  assert.match(publisherSource, /Protected-main release ancestry check passed/);
  assert.match(buildSource, /<details>/);
  assert.match(buildSource, /Trivy CVE scan\|\$\{TRIVY_STATUS\}/);
  assert.match(buildSource, /findings and inventory are not copied to the summary/);
  assert.match(publisherSource, /Publisher is loaded from protected main/);
  assert.match(publisherSource, /candidate-\$\{RUN_ID\}-\$\{RUN_ATTEMPT\}/);
  assert.match(publisherSource, /refusing to redefine an existing immutable package identity/);
  assert.match(publisherSource, /canonical package identity does not equal the scanned candidate digest/);
  assert.doesNotMatch(buildSource, /cao-server:(?:latest|main|stable|beta|alpha)\b/);
  assert.equal(maxEchoedDetailsDepth(buildSource), 1);
  assert.equal(maxEchoedDetailsDepth(publisherSource), 1);

  assert.doesNotMatch(publisherSource, /actions\/checkout@/);
  assert.doesNotMatch(publisherSource, /npm ci|go -C server test|docker build\s|trivy-action|scan-action/);

  assert.equal(request.on.workflow_dispatch.inputs.source_branch.required, true);
  assert.deepEqual(request.permissions, { contents: "read" });
  assert.deepEqual(request.jobs.build.permissions, { contents: "read" });
  assert.equal(request.jobs.build.uses, "./.github/workflows/cao-package-build.yml");
  assert.doesNotMatch(requestSource, /packages:\s+write|attestations:\s+write|id-token:\s+write/);
  assert.equal(requestPublisher.on.workflow_run.workflows[0], "CAO server package request");
  assert.equal(requestPublisher.jobs.publish.environment, "cao-server-publication");
  assert.equal(requestPublisher.jobs.publish.permissions.packages, "write");
  assert.equal(requestPublisher.jobs.publish.permissions.attestations, "write");
  assert.equal(requestPublisher.jobs.publish.permissions["id-token"], "write");
  assert.match(requestPublisherSource, /run\.status !== 'completed' \|\| run\.conclusion !== 'success'/);
  assert.match(requestPublisherSource, /run\.path !== '\.github\/workflows\/cao-package-request\.yml'/);
  assert.match(requestPublisherSource, /run\.head_branch !== repository\.default_branch/);
  assert.match(requestPublisherSource, /run\.head_sha !== trustedBranch\.commit\.sha/);
  assert.match(requestPublisherSource, /run\.actor\?\.login/);
  assert.match(requestPublisherSource, /run\.triggering_actor\?\.login/);
  assert.match(requestPublisherSource, /listWorkflowRunArtifacts/);
  assert.match(requestPublisherSource, /currentArtifacts\.length !== expectedNames\.size/);
  assert.match(requestPublisherSource, /Number\(match\[1\]\) > run\.run_attempt/);
  assert.match(requestPublisherSource, /sha256sum --check cao-server\.sha256/);
  assert.match(requestPublisherSource, /Manual package metadata does not match the requested branch head/);
  assert.match(requestPublisherSource, /org\.opencontainers\.image\.revision/);
  assert.match(
    requestPublisherSource,
    /https:\/\/github\.com\/githubnext\/gh-aw-cao\/attestations\/cao-manual-source\/v1/,
  );
  assert.match(requestPublisherSource, /sourceRevision: \$revision/);
  assert.match(requestPublisherSource, /not default-branch SLSA source provenance/);
  assert.doesNotMatch(requestPublisherSource, /id: provenance/);
  assert.equal(maxEchoedDetailsDepth(requestPublisherSource), 1);
  assert.ok((requestPublisherSource.match(/core\.info\(/g) ?? []).length >= 20);

  for (const match of `${source}\n${buildSource}\n${publisherSource}\n${requestSource}\n${requestPublisherSource}`.matchAll(/uses:\s+[^@\s]+@([^\s#]+)/g)) {
    if (match[0].includes("cao-package-publish.yml@main")) continue;
    if (match[0].includes("./.github/workflows/cao-package-build.yml")) continue;
    assert.match(match[1], /^[0-9a-f]{40}$/, `action is not pinned: ${match[0]}`);
  }
});

test("CAO server image supports downstream Compose role selection", async () => {
  const dockerfile = await text("server/Dockerfile");

  assert.match(dockerfile, /ENTRYPOINT \["\/app\/cao-dashboard"\]/);
  assert.match(dockerfile, /CMD \["serve-hosted"/);
  assert.match(dockerfile, /VOLUME \["\/app\/source"\]/);
  assert.match(dockerfile, /USER 65532:65532/);
});
