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

  assert.match(dockerfile, /FROM node:24-alpine@sha256:[0-9a-f]{64} AS dashboard-build/);
  assert.match(dockerfile, /FROM golang:1\.27-alpine@sha256:[0-9a-f]{64} AS server-build/);
  assert.match(dockerfile, /FROM alpine:3\.22@sha256:[0-9a-f]{64}/);
  assert.match(dockerfile, /ARG CAO_PROFILE=cao\.json/);
  assert.match(dockerfile, /ARG VERSION=dev/);
  assert.match(dockerfile, /ARG REVISION=unknown/);
  assert.match(dockerfile, /org\.opencontainers\.image\.revision="\$\{REVISION\}"/);
  assert.match(dockerfile, /COPY --from=dashboard-build/);
  assert.match(
    dockerfile,
    /COPY --from=dashboard-build --chown=cao:cao \/workspace\/\.github\/workflows\/cao\.coolify\.json \/app\/\.github\/workflows\/cao\.coolify\.json/,
  );
  assert.match(dockerfile, /USER 65532:65532/);
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.match(dockerfile, /CMD \["sh", "-c"/);
  assert.doesNotMatch(dockerfile, /CMD \["CMD-SHELL"/);
  assert.match(dockerfile, /ENTRYPOINT \["\/app\/cao-dashboard"\]/);
});

test("Coolify Compose builds the checked-out source without deployment credentials", async () => {
  const source = await text("server/coolify/compose.yml");
  const compose = parse(source);
  const dashboard = compose.services.dashboard;

  assert.equal(dashboard.image, undefined);
  assert.deepEqual(dashboard.build, {
    context: "../..",
    dockerfile: "server/Dockerfile",
    args: {
      CAO_PROFILE: "cao.coolify.json",
      VERSION: "${SOURCE_COMMIT:-dev}",
      REVISION: "${SOURCE_COMMIT:-unknown}",
    },
  });
  assert.deepEqual(dashboard.command.slice(0, 3), [
    "serve-hosted",
    "--listen",
    "0.0.0.0:8080",
  ]);
  assert.equal(dashboard.environment.CAO_SOURCE_DIRECTORY, "/app/source");
  assert.equal(
    dashboard.environment.CAO_POSTGRES_URL,
    "${CAO_POSTGRES_URL:?Configure the PostgreSQL connection URL}",
  );
  assert.equal(
    dashboard.environment.CAO_GITHUB_CLIENT_SECRET,
    "${CAO_GITHUB_CLIENT_SECRET_ROTATED:-}",
  );
  assert.equal(
    dashboard.environment.CAO_SESSION_SECRET,
    "${CAO_SESSION_SECRET_ROTATED:-}",
  );
  assert.equal(
    dashboard.environment.CAO_GITHUB_WEBHOOK_SECRET,
    "${CAO_GITHUB_WEBHOOK_SECRET_ROTATED:-}",
  );
  assert.equal(
    dashboard.environment.CAO_MCP_ACTIONS_REPOSITORY,
    "${CAO_MCP_ACTIONS_REPOSITORY:?Configure the GitHub repository selected as this Coolify resource's source}",
  );
  assert.equal(
    dashboard.environment.CAO_POLICY_PATH,
    "/app/.github/workflows/cao.coolify.json",
  );
  assert.equal(
    dashboard.environment.CAO_BUILD_VERSION,
    "${SOURCE_COMMIT:-unknown}",
  );
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
  assert.equal(dashboard.volumes.length, 1);
  assert.doesNotMatch(source, /CAO_IMAGE|COOLIFY_API_TOKEN/);
  assert.doesNotMatch(source, /github_pat_|ghp_|gho_|-----BEGIN/);
  for (const [name, value] of Object.entries(dashboard.environment)) {
    if (/SECRET|REDIS_URL|POSTGRES_URL/.test(name)) {
      assert.match(value, /^\$\{/, `${name} must be injected by Coolify`);
    }
  }
});

test("Coolify production delivery is owned by the Git-backed Coolify resource", async () => {
  await assert.rejects(() => text(".github/workflows/coolify-deploy.yml"), {
    code: "ENOENT",
  });
  await assert.rejects(() => text(".github/workflows/coolify-sample-deploy.yml"), {
    code: "ENOENT",
  });
  await assert.rejects(
    () => text(".github/workflows/coolify-production-deploy.yml"),
    { code: "ENOENT" },
  );
  await assert.rejects(() => text("scripts/deploy-coolify.mjs"), {
    code: "ENOENT",
  });

  const documentation = await text("docs/deployment-coolify.md");
  assert.match(
    documentation,
    /automatic deployments from the protected `main` branch/,
  );
  assert.match(documentation, /Include Source Commit in Build/);
  assert.match(documentation, /No GitHub deployment Action, `COOLIFY_API_TOKEN`/);
});
