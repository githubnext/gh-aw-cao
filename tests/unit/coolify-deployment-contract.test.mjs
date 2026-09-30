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
  assert.match(dockerfile, /CMD \["sh", "-c"/);
  assert.doesNotMatch(dockerfile, /CMD \["CMD-SHELL"/);
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
  assert.equal(dashboard.healthcheck.test[0], "CMD-SHELL");
  assert.match(dashboard.healthcheck.test[1], /\$\$\{CAO_ALLOWED_HOSTS%%,\*\}/);
  assert.match(dashboard.healthcheck.test[1], /\/api\/readiness/);
  assert.match(dashboard.volumes[0], /:\/app\/source:ro$/);
  assert.deepEqual(dashboard.volumes.slice(1), [
    "./.github/workflows/cao.json:/app/config/cao.json:ro",
    "./.github/workflows/cao.coolify.json:/app/config/cao.coolify.json:ro",
  ]);
  assert.doesNotMatch(source, /github_pat_|ghp_|gho_|-----BEGIN/);
  for (const [name, value] of Object.entries(dashboard.environment)) {
    if (/SECRET|REDIS_URL/.test(name)) {
      assert.match(value, /^\$\{/, `${name} must be injected by Coolify`);
    }
  }
});

test("Coolify production delivery consumes the successful main package", async () => {
  const source = await text(".github/workflows/coolify-deploy.yml");
  const workflow = parse(source);
  const authorize = workflow.jobs.authorize;
  const packageJob = workflow.jobs.package;
  const deploy = workflow.jobs.deploy;
  const authorization = authorize.steps.find((step) => step.id === "authorization");
  const resolve = packageJob.steps.find((step) => step.id === "package");
  const deployment = deploy.steps.find((step) => step.id === "deployment");

  assert.equal(workflow.on.workflow_dispatch, null);
  assert.deepEqual(workflow.on.workflow_run.workflows, ["CAO server package"]);
  assert.deepEqual(workflow.on.workflow_run.types, ["completed"]);
  assert.deepEqual(workflow.on.workflow_run.branches, ["main"]);
  assert.equal(workflow.on.push, undefined);
  assert.equal(workflow.on.release, undefined);
  assert.equal(workflow.on.pull_request, undefined);
  assert.deepEqual(authorize.permissions, { contents: "read" });
  assert.match(authorize.if, /workflow_run\.conclusion == 'success'/);
  assert.match(authorize.if, /workflow_run\.event == 'push'/);
  assert.match(authorization.with.script, /Production deployment is restricted to the canonical repository/);
  assert.match(authorization.with.script, /Automatic deployment requires a successful canonical main package run/);
  assert.match(authorization.with.script, /Manual deployment must use the current default-branch workflow/);
  assert.match(authorization.with.script, /Manual deployment and reruns require maintain or admin permission/);
  assert.match(authorization.with.script, /process\.env\.TRIGGERING_ACTOR/);
  assert.match(authorization.with.script, /PACKAGE_WORKFLOW_PATH/);
  assert.match(authorization.with.script, /sourceSha !== branch\.commit\.sha/);
  assert.equal(packageJob.needs, "authorize");
  assert.deepEqual(packageJob.permissions, {
    attestations: "read",
    contents: "read",
    packages: "read",
  });
  assert.deepEqual(deploy.needs, ["authorize", "package"]);
  assert.equal(deploy.environment.name, "coolify-production");
  assert.equal(deploy.environment.url, "${{ vars.COOLIFY_READINESS_URL }}");

  assert.match(resolve.run, /ghcr\.io\/githubnext\/gh-aw-cao\/cao-server/);
  assert.match(resolve.run, /docker buildx imagetools inspect "\$\{canonical\}"/);
  assert.match(resolve.run, /docker pull "\$\{image\}"/);
  assert.match(resolve.run, /org\.opencontainers\.image\.revision/);
  assert.match(resolve.run, /org\.opencontainers\.image\.version/);
  assert.match(resolve.run, /metadata does not match the current main commit/);
  assert.match(resolve.run, /gh attestation verify "oci:\/\/\$\{image\}"/);
  assert.match(resolve.run, /--signer-workflow "\$\{GITHUB_REPOSITORY\}\/\.github\/workflows\/cao-package-publish\.yml"/);
  assert.match(resolve.run, /--source-digest "\$\{REVISION\}"/);
  assert.match(source, /Production deployment authorization completed/);
  assert.match(source, /Production deployment source remains current/);
  assert.doesNotMatch(source, /docker build\s/);
  assert.doesNotMatch(source, /docker push\s/);
  assert.doesNotMatch(source, /aquasecurity\/trivy-action/);
  assert.doesNotMatch(source, /packages:\s*write/);
  assert.doesNotMatch(source, /COOLIFY_DEPLOY_ENABLED/);
  assert.doesNotMatch(source, /COOLIFY_DEPLOY_ENDPOINT/);
  assert.doesNotMatch(source, /coolify-(?:alpha|stable|sample)/);
  assert.equal(maxEchoedDetailsDepth(source), 1);

  assert.equal(deployment.env.CAO_IMAGE, "${{ needs.package.outputs.image }}");
  assert.equal(deployment.env.COOLIFY_BASE_URL, "${{ vars.COOLIFY_BASE_URL }}");
  assert.equal(deployment.env.COOLIFY_APPLICATION_UUID, "${{ vars.COOLIFY_APPLICATION_UUID }}");
  assert.equal(deployment.env.COOLIFY_READINESS_URL, "${{ vars.COOLIFY_READINESS_URL }}");
  assert.equal(deployment.env.COOLIFY_API_TOKEN, "${{ secrets.COOLIFY_API_TOKEN }}");
  assert.equal(deployment.run, "node scripts/deploy-coolify.mjs");

  const freshness = deploy.steps.find(
    (step) => step.name === "Reject stale deployment source",
  );
  assert.match(freshness.with.script, /Production deployment source is no longer the default-branch HEAD/);

  const deploymentClient = await text("scripts/deploy-coolify.mjs");
  assert.match(
    deploymentClient,
    /ghcr\\\.io\\\/githubnext\\\/gh-aw-cao\\\/cao-server@sha256:/,
  );
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
    /(?:echo|printf|cat|head|tail)\b[^\n]*(?:COOLIFY_(?:BASE_URL|APPLICATION_UUID|READINESS_URL|API_TOKEN)|secrets\.)/,
  );
});

test("Coolify workflow_run trigger mitigates the dangerous-triggers audit", async () => {
  const source = await text(".github/workflows/coolify-deploy.yml");
  const workflow = parse(source);
  const authorization = workflow.jobs.authorize;
  const packageJob = workflow.jobs.package;
  const deploy = workflow.jobs.deploy;
  const authorizeScript = authorization.steps.find(
    (step) => step.id === "authorization",
  ).with.script;
  const packageScript = packageJob.steps.find(
    (step) => step.id === "package",
  ).run;
  const checkout = deploy.steps.find(
    (step) => step.name === "Checkout deployment client",
  );
  const deployment = deploy.steps.find(
    (step) => step.id === "deployment",
  );

  assert.match(
    source,
    /workflow_run: # zizmor: ignore\[dangerous-triggers\] - retained for post-package deployment;/,
  );
  assert.match(authorization.if, /workflow_run\.conclusion == 'success'/);
  assert.match(authorization.if, /workflow_run\.event == 'push'/);
  assert.match(authorizeScript, /repositoryName !== 'githubnext\/gh-aw-cao'/);
  assert.match(authorizeScript, /PACKAGE_HEAD_BRANCH !== defaultBranch/);
  assert.match(authorizeScript, /PACKAGE_HEAD_REPOSITORY !== repositoryName/);
  assert.match(
    authorizeScript,
    /PACKAGE_WORKFLOW_PATH !== '\.github\/workflows\/cao-package\.yml'/,
  );
  assert.match(authorizeScript, /sourceSha !== branch\.commit\.sha/);

  assert.deepEqual(authorization.permissions, { contents: "read" });
  assert.deepEqual(packageJob.permissions, {
    attestations: "read",
    contents: "read",
    packages: "read",
  });
  assert.deepEqual(deploy.permissions, { contents: "read" });
  assert.equal(deploy.needs.includes("package"), true);
  assert.equal(checkout.with.ref, "${{ needs.authorize.outputs.source_sha }}");
  assert.doesNotMatch(source, /download-artifact/);
  assert.match(packageScript, /ghcr\.io\/githubnext\/gh-aw-cao\/cao-server/);
  assert.match(
    packageScript,
    /--signer-workflow "\$\{GITHUB_REPOSITORY\}\/\.github\/workflows\/cao-package-publish\.yml"/,
  );
  assert.match(packageScript, /--source-digest "\$\{REVISION\}"/);

  assert.equal(deploy.environment.name, "coolify-production");
  assert.equal(
    deployment.env.COOLIFY_API_TOKEN,
    "${{ secrets.COOLIFY_API_TOKEN }}",
  );
  assert.equal((source.match(/secrets\.COOLIFY_API_TOKEN/g) ?? []).length, 1);

  const documentation = await text("docs/deployment-coolify.md");
  assert.match(
    documentation,
    /accept deployments only from the protected\s+default branch/,
  );
  assert.match(documentation, /required reviewers/);
});
