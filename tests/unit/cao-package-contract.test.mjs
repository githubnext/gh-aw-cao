import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

const root = new URL("../../", import.meta.url);

async function text(path) {
  return readFile(new URL(path, root), "utf8");
}

test("CAO server package workflow publishes immutable Compose-ready images", async () => {
  const source = await text(".github/workflows/cao-package.yml");
  const workflow = parse(source);

  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.deepEqual(workflow.on.release.types, ["published"]);
  assert.equal(workflow.on.pull_request, undefined);
  assert.equal(workflow.permissions.contents, "read");
  assert.deepEqual(workflow.jobs.build.permissions, { contents: "read" });
  assert.equal(workflow.jobs.publish.permissions.packages, "write");
  assert.equal(workflow.jobs.publish.permissions.attestations, "write");
  assert.equal(workflow.jobs.publish.permissions["id-token"], "write");
  assert.deepEqual(workflow.jobs.publish.needs, ["source", "static-security", "build"]);
  assert.deepEqual(workflow.jobs.build.needs, ["source", "static-security"]);

  assert.match(source, /ghcr\.io\/\$\{REPOSITORY,,\}\/cao-server/);
  assert.match(source, /identity="sha-\$\{SHA\}"/);
  assert.match(source, /version="0\.0\.0-main\.\$\{SHA:0:12\}"/);
  assert.match(source, /Published release tag must be Docker-safe semantic version/);
  assert.match(source, /--file server\/Dockerfile/);
  assert.match(source, /--build-arg "CAO_PROFILE=cao\.json"/);
  assert.match(source, /go -C server test \.\/\.\.\./);
  assert.match(source, /npm run dashboard:server:build/);
  assert.match(source, /aquasecurity\/trivy-action@[0-9a-f]{40}/);
  assert.match(source, /severity: CRITICAL,HIGH/);
  assert.match(source, /anchore\/scan-action@[0-9a-f]{40}/);
  assert.match(source, /anchore\/sbom-action@[0-9a-f]{40}/);
  assert.match(source, /hadolint\/hadolint:v2\.15\.1-alpine@sha256:[0-9a-f]{64}/);
  assert.match(source, /goodwithtech\/dockle:v0\.4\.15@sha256:[0-9a-f]{64}/);
  assert.match(source, /ghcr\.io\/zizmorcore\/zizmor:1\.30\.1@sha256:[0-9a-f]{64}/);
  assert.match(source, /rhysd\/actionlint:1\.7\.12@sha256:[0-9a-f]{64}/);
  assert.match(source, /release package source is not reachable from protected main/);
  assert.match(source, /published release tag no longer matches the tested package source/);
  assert.match(source, /sha256sum --check cao-server\.sha256/);
  assert.match(source, /actions\/attest@[0-9a-f]{40}/);
  assert.match(source, /push-to-registry: true/);
  assert.match(source, /<details>/);
  assert.match(source, /Container security tools/);
  assert.match(source, /findings and inventory are not copied to the summary/);
  assert.match(source, /Publisher checks out no repository code/);
  assert.match(source, /candidate-\$\{RUN_ID\}-\$\{RUN_ATTEMPT\}/);
  assert.match(source, /refusing to redefine an existing immutable package identity/);
  assert.match(source, /canonical package identity does not equal the scanned candidate digest/);
  assert.doesNotMatch(source, /cao-server:(?:latest|main|stable|beta|alpha)\b/);

  const publisherSource = source.slice(source.indexOf("\n  publish:"));
  assert.doesNotMatch(publisherSource, /actions\/checkout@/);
  assert.doesNotMatch(publisherSource, /npm ci|go -C server test|docker build\s|trivy-action|scan-action/);

  for (const match of source.matchAll(/uses:\s+[^@\s]+@([^\s#]+)/g)) {
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
