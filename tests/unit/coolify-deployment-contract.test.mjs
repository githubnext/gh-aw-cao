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

test("Coolify image is multi-stage, non-root, versioned, and health checked", async () => {
  const dockerfile = await text("server/Dockerfile");

  assert.match(dockerfile, /FROM node:24-alpine@sha256:[0-9a-f]{64} AS dashboard-build/);
  assert.match(dockerfile, /FROM golang:1\.27-alpine@sha256:[0-9a-f]{64} AS server-build/);
  assert.match(dockerfile, /FROM alpine:3\.22@sha256:[0-9a-f]{64}/);
  assert.match(dockerfile, /ARG CAO_PROFILE=cao\.json/);
  assert.match(dockerfile, /ARG VERSION=dev/);
  assert.match(dockerfile, /ARG REVISION=unknown/);
  assert.match(dockerfile, /org\.opencontainers\.image\.revision="\$\{REVISION\}"/);
  assert.match(dockerfile, /COPY --from=dashboard-build/);
  assert.match(dockerfile, /USER 65532:65532/);
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.match(dockerfile, /ENTRYPOINT \["\/app\/cao-dashboard"\]/);
});

test("Coolify Compose contains no credentials and requires immutable image input", async () => {
  const source = await text("server/coolify/compose.yml");
  const compose = parse(source);
  const dashboard = compose.services.dashboard;

  assert.match(dashboard.image, /CAO_IMAGE/);
  assert.match(dashboard.image, /immutable ghcr\.io\/OWNER\/REPOSITORY\/cao-server@sha256:DIGEST/);
  assert.deepEqual(dashboard.command.slice(0, 3), ["serve-hosted", "--listen", "0.0.0.0:8080"]);
  assert.equal(dashboard.environment.CAO_SOURCE_DIRECTORY, "/app/source");
  assert.equal(dashboard.read_only, true);
  assert.equal(dashboard.init, true);
  assert.deepEqual(dashboard.cap_drop, ["ALL"]);
  assert.deepEqual(dashboard.security_opt, ["no-new-privileges:true"]);
  assert.equal(dashboard.ports, undefined);
  assert.deepEqual(dashboard.expose, ["8080"]);
  assert.match(dashboard.volumes[0], /:\/app\/source:ro$/);
  assert.doesNotMatch(source, /github_pat_|ghp_|gho_|-----BEGIN/);
  for (const [name, value] of Object.entries(dashboard.environment)) {
    if (/SECRET|REDIS_URL/.test(name)) {
      assert.match(value, /^\$\{/, `${name} must be injected by Coolify`);
    }
  }
});

test("sample Coolify workflow consumes the official main package", async () => {
  const source = await text(".github/workflows/coolify-sample-deploy.yml");
  const workflow = parse(source);
  const packageJob = workflow.jobs.package;
  const deploy = workflow.jobs.deploy;

  assert.equal(workflow.on.workflow_dispatch, null);
  assert.equal(workflow.on.push, undefined);
  assert.equal(packageJob.environment.name, "coolify-sample-publish");
  assert.equal(packageJob.permissions.packages, "read");
  assert.equal(packageJob.permissions.attestations, "read");
  assert.equal(deploy.environment.name, "coolify-sample");
  assert.match(source, /Require maintainer or administrator/);
  assert.match(source, /ghcr\.io\/githubnext\/gh-aw-cao\/cao-server/);
  assert.match(source, /official sample package metadata does not match the current main commit/);
  assert.match(source, /gh attestation verify "oci:\/\/\$\{image\}"/);
  assert.match(source, /Data exposure: outcomes only/);
  assert.ok((source.match(/core\.info\(/g) ?? []).length >= 20);
  assert.match(source, /Sample deployment authorization completed/);
  assert.match(source, /Deployment-stage reauthorization completed/);
  assert.doesNotMatch(source, /docker build\s/);
  assert.doesNotMatch(source, /docker push\s/);
  assert.equal(deploy.needs, "package");
  assert.match(source, /node scripts\/deploy-coolify\.mjs/);
  assert.equal(maxEchoedDetailsDepth(source), 1);

  const deploymentClient = await text("scripts/deploy-coolify.mjs");
  assert.match(
    deploymentClient,
    /ghcr\\\.io\\\/githubnext\\\/gh-aw-cao\\\/cao-server@sha256:/,
  );
});

test("Coolify delivery consumes the official immutable CAO server package", async () => {
  const source = await text(".github/workflows/coolify-deploy.yml");
  const workflow = parse(source);
  const authorize = workflow.jobs.authorize;
  const classify = workflow.jobs.classify;
  const packageJob = workflow.jobs.package;
  const deploy = workflow.jobs.deploy;
  const resolve = packageJob.steps.find((step) => step.id === "package");
  const request = deploy.steps.find((step) => step.name === "Request digest deployment");
  const classifyStep = classify.steps.find((step) => step.id === "classify");

  assert.deepEqual(workflow.on.workflow_dispatch.inputs.channel.options, ["alpha", "stable"]);
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.deepEqual(workflow.on.release.types, ["released"]);
  assert.equal(workflow.on.pull_request, undefined);
  assert.equal(workflow.jobs.classify.needs, "authorize");
  assert.deepEqual(authorize.permissions, { contents: "read" });
  const authorization = authorize.steps.find((step) => step.id === "authorization");
  assert.match(authorization.with.script, /Manual and rerun delivery requires maintain or admin repository permission/);
  assert.match(authorization.with.script, /Manual delivery must use the current default-branch workflow/);
  assert.match(authorization.with.script, /process\.env\.TRIGGERING_ACTOR/);
  assert.match(authorization.with.script, /Automatic first-attempt trigger does not require actor elevation/);
  assert.match(authorization.with.script, /Manual workflow-source validation is not required for this event/);
  assert.equal(packageJob.needs, "classify");
  assert.deepEqual(packageJob.permissions, {
    attestations: "read",
    contents: "read",
    packages: "read",
  });
  assert.deepEqual(deploy.needs, ["classify", "package"]);
  assert.equal(deploy.environment.name, "${{ needs.classify.outputs.environment }}");
  assert.match(classifyStep.with.script, /environment = 'coolify-alpha'/);
  assert.match(classifyStep.with.script, /environment = 'coolify-stable'/);
  assert.match(classifyStep.with.script, /environment = `coolify-\$\{tier\}`/);
  assert.equal(
    deploy.if,
    "needs.classify.outputs.eligible == 'true' && (github.event_name != 'push' || vars.COOLIFY_DEPLOY_ENABLED == 'true')",
  );

  assert.match(resolve.run, /ghcr\.io\/\$\{REPOSITORY,,\}\/cao-server/);
  assert.match(resolve.run, /docker buildx imagetools inspect "\$\{canonical\}"/);
  assert.match(resolve.run, /docker pull "\$\{image\}"/);
  assert.match(resolve.run, /org\.opencontainers\.image\.revision/);
  assert.match(resolve.run, /org\.opencontainers\.image\.version/);
  assert.match(resolve.run, /metadata does not match the classified source/);
  assert.match(resolve.run, /gh attestation verify "oci:\/\/\$\{image\}"/);
  assert.match(resolve.run, /--signer-workflow "\$\{GITHUB_REPOSITORY\}\/\.github\/workflows\/cao-package-publish\.yml"/);
  assert.match(resolve.run, /--source-digest "\$\{REVISION\}"/);
  assert.match(source, /<summary>Package admission outcome: \$\{PACKAGE_STATUS\}<\/summary>/);
  assert.match(source, /package metadata and attestation bodies are omitted/);
  assert.ok((source.match(/core\.info\(/g) ?? []).length >= 20);
  assert.match(source, /Immutable deployment source classification completed/);
  assert.match(source, /Deployment source freshness validation completed/);
  assert.doesNotMatch(source, /docker build\s/);
  assert.doesNotMatch(source, /docker push\s/);
  assert.doesNotMatch(source, /aquasecurity\/trivy-action/);
  assert.doesNotMatch(source, /packages:\s*write/);
  assert.equal(maxEchoedDetailsDepth(source), 1);

  assert.equal(request.env.IMAGE, "${{ needs.package.outputs.image }}");
  assert.equal(request.env.DIGEST, "${{ needs.package.outputs.digest }}");
  assert.equal(request.env.SOURCE_SHA, "${{ needs.package.outputs.source_sha }}");
  assert.match(request.run, /refusing a mutable deployment reference/);
  assert.match(request.run, /\.status == "ready"/);
  assert.match(request.run, /\.image == \$image/);
  assert.match(request.run, /\.digest == \$digest/);
  assert.match(request.run, /--max-time 300/);
  assert.match(request.run, /--max-filesize 65536/);
});

test("Coolify delivery classifies immutable alpha and stable sources", async () => {
  const source = await text(".github/workflows/coolify-deploy.yml");
  const workflow = parse(source);
  const classify = workflow.jobs.classify.steps.find((step) => step.id === "classify");
  const freshness = workflow.jobs.deploy.steps.find(
    (step) => step.name === "Reject stale deployment source",
  );

  assert.match(classify.with.script, /context\.payload\.repository\.fork/);
  assert.match(classify.with.script, /process\.env\.EVENT_NAME === 'push'/);
  assert.match(classify.with.script, /identity = `sha-\$\{process\.env\.SHA\}`/);
  assert.match(classify.with.script, /0\.0\.0-main\.\$\{process\.env\.SHA\.slice\(0, 12\)\}/);
  assert.match(classify.with.script, /process\.env\.EVENT_NAME === 'release'/);
  assert.match(classify.with.script, /await peelTag\(tag\)/);
  assert.match(classify.with.script, /await latestRelease\(\)/);
  assert.match(classify.with.script, /exact stable version vX\.Y\.Z/);
  assert.doesNotMatch(classify.with.script, /prereleaseTag|tier === 'beta'/);
  assert.match(classify.with.script, /Manual alpha source is not the current main commit/);
  assert.match(classify.with.script, /Manual delivery must select the current main branch/);
  assert.match(freshness.with.script, /Alpha source is no longer the main branch HEAD/);
  assert.match(freshness.with.script, /latest published vX\.Y\.Z release/);
  assert.match(freshness.with.script, /no longer peels to its classified commit SHA/);
});

test("Coolify delivery pins actions and does not log deployment secrets", async () => {
  const source = await text(".github/workflows/coolify-deploy.yml");

  for (const match of source.matchAll(/uses:\s+[^@\s]+@([^\s#]+)/g)) {
    assert.match(match[1], /^[0-9a-f]{40}$/, `action is not pinned: ${match[0]}`);
  }
  assert.doesNotMatch(source, /set\s+-[^ \n]*x/);
  assert.doesNotMatch(source, /curl[\s\S]*?--(?:verbose|trace(?:-ascii)?)(?:\s|\\)/);
  assert.doesNotMatch(
    source,
    /(?:echo|printf|cat|head|tail)\b[^\n]*(?:COOLIFY_DEPLOY_ENDPOINT|COOLIFY_DEPLOY_TOKEN|secrets\.)/,
  );
});
