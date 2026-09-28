import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadPolicyFile } from "../../.github/workflows/shared/policy.mjs";

const root = new URL("../../", import.meta.url);

async function text(path) {
  return readFile(new URL(path, root), "utf8");
}

test("Railway profile extends the rollout policy with hosting only", async () => {
  const base = JSON.parse(await text(".github/workflows/cao.json"));
  const overlay = JSON.parse(await text(".github/workflows/cao.railway.json"));
  const composed = loadPolicyFile(fileURLToPath(new URL(".github/workflows/cao.railway.json", root)));

  assert.equal(overlay.extends, "cao.json");
  assert.deepEqual(Object.keys(overlay).toSorted(), ["control-plane", "extends"]);
  assert.deepEqual(Object.keys(overlay["control-plane"]), ["web"]);
  assert.deepEqual(Object.keys(overlay["control-plane"].web), ["host"]);
  assert.deepEqual(composed["control-plane"].campaigns, base["control-plane"].campaigns);
  assert.deepEqual(composed["control-plane"].scope, base["control-plane"].scope);
  assert.equal(composed["control-plane"].web.experimental, true);
  assert.deepEqual(composed["control-plane"].web.host, {
    target: {
      module: "container",
      name: "railway",
      replicas: 1,
    },
    redis: {
      module: "railway",
      "allow-private-plaintext": true,
      tls: { mode: "disabled" },
    },
  });
});

test("Railway image is pinned, non-root, snapshot-backed, and readiness-gated", async () => {
  const dockerfile = await text("server/internal/railway/Dockerfile");

  for (const line of dockerfile.match(/^FROM .*$/gm) ?? []) {
    assert.match(line, /@sha256:[0-9a-f]{64}(?: AS \S+)?$/, `base image is not digest-pinned: ${line}`);
  }
  assert.match(dockerfile, /AS dashboard-build/);
  assert.match(dockerfile, /AS snapshot-build/);
  assert.match(dockerfile, /AS server-build/);
  assert.match(dockerfile, /FROM caddy:2\.10\.2-alpine@sha256:[0-9a-f]{64} AS caddy-runtime/);
  assert.match(dockerfile, /cao\.railway\.json/);
  assert.match(dockerfile, /ARG DASHBOARD_MANIFEST_SHA256/);
  assert.match(dockerfile, /activity\/cao\.mjs download[\s\S]*--manifest-sha256 "\$\{DASHBOARD_MANIFEST_SHA256\}"[\s\S]*--output \/out\/source/);
  assert.match(dockerfile, /COPY --from=snapshot-build[\s\S]*\/app\/source\//);
  assert.match(dockerfile, /COPY --from=caddy-runtime \/usr\/bin\/caddy \/usr\/bin\/caddy/);
  assert.doesNotMatch(dockerfile, /apk add[\s\S]*\bcaddy\b/);
  assert.match(dockerfile, /CAO_POLICY_PATH=\/app\/config\/cao\.railway\.json/);
  assert.match(dockerfile, /CAO_SOURCE_DIRECTORY=\/app\/source/);
  assert.match(dockerfile, /USER 65532:65532/);
  assert.match(dockerfile, /HEALTHCHECK[\s\S]*\/api\/readiness/);
  assert.doesNotMatch(dockerfile, /HEALTHCHECK[\s\S]*\/api\/(?:v1\/)?health/);
  assert.match(dockerfile, /ENTRYPOINT \["\/bin\/sh", "\/app\/entrypoint\.sh"\]/);
  assert.doesNotMatch(dockerfile, /(?:TOKEN|SECRET|PASSWORD)=\S+/);
});

test("Railway entrypoint keeps the CAO server behind a loopback proxy boundary", async () => {
  const entrypoint = await text("server/internal/railway/entrypoint.sh");

  for (const variable of [
    "CAO_PUBLIC_HOST",
    "CAO_GITHUB_CLIENT_ID",
    "CAO_GITHUB_CLIENT_SECRET",
    "CAO_SESSION_SECRET",
    "CAO_GITHUB_ADMIN_USERS",
    "CAO_GITHUB_WEBHOOK_SECRET",
    "REDIS_URL",
  ]) {
    assert.match(entrypoint, new RegExp(`\\$\\{${variable}:\\?${variable} is required\\}`));
  }
  assert.match(entrypoint, /CAO_ALLOWED_HOSTS="\$\{CAO_ALLOWED_HOSTS:-\$\{CAO_PUBLIC_HOST\}\}"/);
  assert.match(entrypoint, /CAO_GITHUB_REDIRECT_URL=.*https:\/\/\$\{CAO_PUBLIC_HOST\}\/auth\/callback/);
  assert.match(entrypoint, /CAO_TRUSTED_PROXY_CIDRS="127\.0\.0\.0\/8,::1\/128"/);
  assert.doesNotMatch(entrypoint, /(?:10\.0\.0\.0\/8|172\.16\.0\.0\/12|192\.168\.0\.0\/16|0\.0\.0\.0\/0)/);
  assert.match(entrypoint, /caddy run --config \/app\/Caddyfile/);
  assert.match(entrypoint, /serve-hosted[\s\S]*--listen 127\.0\.0\.1:8081/);
  assert.doesNotMatch(entrypoint, /--listen 0\.0\.0\.0/);
  assert.match(entrypoint, /trap shutdown INT TERM EXIT/);
});

test("Railway Caddy proxy rewrites only reviewed forwarding headers", async () => {
  const caddyfile = await text("server/internal/railway/Caddyfile");

  assert.match(caddyfile, /auto_https off/);
  assert.match(caddyfile, /admin off/);
  assert.match(caddyfile, /:\{\$PORT:8080\}/);
  assert.match(caddyfile, /reverse_proxy 127\.0\.0\.1:8081/);
  assert.match(caddyfile, /header_up Host \{\$CAO_PUBLIC_HOST\}/);
  assert.match(caddyfile, /header_up X-Forwarded-Host \{\$CAO_PUBLIC_HOST\}/);
  assert.match(caddyfile, /header_up X-Forwarded-Proto https/);
  assert.match(caddyfile, /header_up X-Forwarded-For \{http\.request\.header\.X-Real-IP\}/);
  assert.doesNotMatch(caddyfile, /trusted_proxies|private_ranges/);
});

test("Railway test instructions keep Redis private and require OAuth", async () => {
  const readme = await text("server/internal/railway/README.md");

  assert.match(readme, /RAILWAY_DOCKERFILE_PATH=\/server\/internal\/railway\/Dockerfile/);
  assert.match(readme, /DASHBOARD_MANIFEST_SHA256=REVIEWED_64_CHARACTER_SHA256/);
  assert.match(readme, /signed release provenance/);
  assert.match(readme, /REDIS_URL=\$\{\{Redis\.REDIS_URL\}\}/);
  assert.match(readme, /Keep Redis private/);
  assert.match(readme, /keep one replica/);
  assert.match(readme, /Authorization callback URL: https:\/\/YOUR_RAILWAY_HOST\/auth\/callback/);
  assert.match(readme, /CAO_GITHUB_ALLOWED_(?:ORGS|TEAMS)/);
  assert.match(readme, /healthcheck path to `\/api\/readiness`/);
  assert.doesNotMatch(readme, /REDIS_PUBLIC_URL|Public Access.*Redis/i);
});
