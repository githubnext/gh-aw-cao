import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

const root = new URL("../../", import.meta.url);

const otelHeaderInputs = {
  OTEL_EXPORTER_OTLP_HEADERS: "OTEL_EXPORTER_OTLP_HEADERS_ROTATED",
  OTEL_EXPORTER_OTLP_TRACES_HEADERS: "OTEL_EXPORTER_OTLP_TRACES_HEADERS_ROTATED",
  OTEL_EXPORTER_OTLP_METRICS_HEADERS: "OTEL_EXPORTER_OTLP_METRICS_HEADERS_ROTATED",
  OTEL_EXPORTER_OTLP_LOGS_HEADERS: "OTEL_EXPORTER_OTLP_LOGS_HEADERS_ROTATED",
};

async function text(path) {
  return readFile(new URL(path, root), "utf8");
}

function assertRotatableOtelHeaders(environment) {
  for (const [runtimeName, coolifyName] of Object.entries(otelHeaderInputs)) {
    assert.equal(environment[runtimeName], `\${${coolifyName}:-}`);
  }
}

test("Coolify image is multi-stage, non-root, versioned, and health checked", async () => {
  const dockerfile = await text("server/Dockerfile");
  const dockerignore = await text(".dockerignore");
  const policy = JSON.parse(await text(".github/workflows/cao.json"));
  const ghAwVersion = policy["gh-aw-version"];

  assert.match(dockerfile, /FROM node:24-alpine@sha256:[0-9a-f]{64} AS dashboard-build/);
  assert.match(dockerfile, /FROM golang:1\.27-alpine@sha256:[0-9a-f]{64} AS server-build/);
  assert.match(dockerfile, /FROM alpine:3\.22@sha256:[0-9a-f]{64} AS dashboard-runtime/);
  assert.match(dockerfile, /FROM node:24-alpine@sha256:[0-9a-f]{64} AS collector-runtime/);
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
  assert.match(dockerfile, new RegExp(`ARG GH_AW_VERSION=${ghAwVersion.replaceAll(".", "\\.")}`));
  assert.match(dockerfile, /github\/gh-aw\/releases\/download\/\$\{GH_AW_VERSION\}\/linux-\$\{TARGETARCH\}/);
  assert.match(dockerfile, /sha256sum -c -/);
  assert.match(dockerfile, /\/app\/\.local\/share\/gh\/extensions\/gh-aw\/gh-aw/);
  assert.match(dockerfile, /\/workspace\/activity\/ \/app\/catalog\/activity\//);
  assert.match(dockerfile, /REPORT_INVENTORY_STATIC=true/);
  assert.match(
    dockerfile,
    /\/tmp\/control-plane-inventory\.json \/app\/catalog\/control-plane-inventory\.json/,
  );
  assert.match(
    dockerfile,
    /\/workspace\/\.github\/workflows\/shared\/control\.mjs \/app\/catalog\/\.github\/workflows\/shared\/control\.mjs/,
  );
  assert.match(
    dockerfile,
    /\/workspace\/\.github\/workflows\/shared\/policy\.mjs \/app\/catalog\/\.github\/workflows\/shared\/policy\.mjs/,
  );
  assert.match(
    dockerfile,
    /\/workspace\/\.github\/workflows\/\*\.lock\.yml \/app\/catalog\/\.github\/workflows\//,
  );
  assert.match(dockerignore, /^!\.github\/workflows\/\*\.lock\.yml$/m);
  assert.match(dockerfile, /\/workspace\/dashboard\/site\/node_modules\/yaml\/ \/app\/catalog\/node_modules\/yaml\//);
  assert.match(dockerfile, /VOLUME \["\/app\/evidence"\]/);
  assert.match(dockerfile, /FROM dashboard-runtime AS final/);
});

test("Coolify Compose builds the checked-out source with admission-only public service", async () => {
  const source = await text("server/coolify/compose.yml");
  const compose = parse(source);
  const dashboard = compose.services.dashboard;

  assert.equal(dashboard.image, undefined);
  assert.deepEqual(dashboard.build, {
    context: "../..",
    dockerfile: "server/Dockerfile",
    target: "dashboard-runtime",
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
  assert.equal(dashboard.environment.CAO_SOURCE_DIRECTORY, undefined);
  assert.equal(
    dashboard.environment.CAO_COLLECT_APP_ID,
    "${CAO_COLLECT_APP_ID:?Configure the numeric GitHub App ID}",
  );
  assert.equal(dashboard.environment.CAO_COLLECT_ADMIT_ONLY, "true");
  assert.equal(dashboard.environment.CAO_COLLECT_PRIVATE_KEY, undefined);
  assert.equal(dashboard.environment.CAO_COLLECT_PRIVATE_KEY_BASE64, undefined);
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
  assert.equal(dashboard.environment.CAO_OTEL_LOGS_ENABLED, "${CAO_OTEL_LOGS_ENABLED:-false}");
  assert.equal(dashboard.environment.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, "${OTEL_EXPORTER_OTLP_LOGS_ENDPOINT:-}");
  assertRotatableOtelHeaders(dashboard.environment);
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
  for (const service of Object.values(compose.services)) {
    for (const [name, value] of Object.entries(service.environment)) {
      if (/SECRET|PRIVATE_KEY|REDIS_URL|POSTGRES_URL/.test(name)) {
        assert.match(value, /^\$\{/, `${service}.${name} must be injected by Coolify`);
      }
    }
  }
});

test("Coolify collection workers isolate credentials and share durable evidence", async () => {
  const source = await text("server/coolify/compose.yml");
  const compose = parse(source);
  const { collector, backfill } = compose.services;
  const policy = JSON.parse(await text(".github/workflows/cao.json"));

  for (const service of [collector, backfill]) {
    assert.deepEqual(service.build, {
      context: "../..",
      dockerfile: "server/Dockerfile",
      target: "collector-runtime",
      args: {
        CAO_PROFILE: "cao.coolify.json",
        VERSION: "${SOURCE_COMMIT:-dev}",
        REVISION: "${SOURCE_COMMIT:-unknown}",
        GH_AW_VERSION: policy["gh-aw-version"],
      },
    });
    assert.equal(
      service.environment.CAO_COLLECT_PRIVATE_KEY_BASE64,
      "${CAO_COLLECT_PRIVATE_KEY_BASE64_ROTATED:?Configure the base64-encoded GitHub App private key as a Coolify secret}",
    );
    assert.equal(service.environment.CAO_COLLECT_PRIVATE_KEY, undefined);
    assert.equal(service.environment.CAO_COLLECT_ADMIT_ONLY, undefined);
    assert.equal(service.environment.CAO_SOURCE_DIRECTORY, undefined);
    assert.equal(service.environment.CAO_COLLECT_LAKE_DIRECTORY, "/app/evidence");
    assert.equal(service.environment.CAO_COLLECT_CATALOG_ROOT, "/app/catalog");
    assert.equal(
      service.environment.CAO_COLLECT_STATIC_INVENTORY,
      "/app/catalog/control-plane-inventory.json",
    );
    assertRotatableOtelHeaders(service.environment);
    assert.deepEqual(service.volumes, ["cao-collector-evidence:/app/evidence"]);
    assert.equal(service.read_only, true);
    assert.equal(service.init, true);
    assert.deepEqual(service.cap_drop, ["ALL"]);
    assert.deepEqual(service.security_opt, ["no-new-privileges:true"]);
    assert.equal(service.ports, undefined);
    assert.equal(service.expose, undefined);
  }

  assert.deepEqual(collector.command, [
    "collect",
    "--database-queries",
    "/app/queries/database.json",
  ]);
  assert.equal(collector.restart, "unless-stopped");
  assert.deepEqual(backfill.command, [
    "backfill",
    "--database-queries",
    "/app/queries/database.json",
  ]);
  assert.equal(backfill.restart, "no");
  assert.deepEqual(compose.volumes["cao-collector-evidence"], {
    name: "${CAO_COLLECT_EVIDENCE_VOLUME:-cao-collector-evidence}",
  });
  assert.equal(compose.volumes["cao-dashboard-artifact"].external, true);
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
