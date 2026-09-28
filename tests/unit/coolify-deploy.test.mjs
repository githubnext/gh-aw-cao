import assert from "node:assert/strict";
import test from "node:test";
import { deployCoolify } from "../../scripts/deploy-coolify.mjs";

const oldImage = `ghcr.io/githubnext/gh-aw-cao/cao-dashboard@sha256:${"a".repeat(64)}`;
const newImage = `ghcr.io/githubnext/gh-aw-cao/cao-dashboard@sha256:${"b".repeat(64)}`;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fakeCoolify({ deploymentStatuses, readinessStatuses = [200] }) {
  let image = oldImage;
  let deployments = 0;
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    const path = new URL(url).pathname;
    if (path === "/api/v1/applications/app-1/envs" && !options.method) {
      return json([{ key: "CAO_IMAGE", value: image, is_preview: false }]);
    }
    if (path === "/api/v1/applications/app-1/envs" && options.method === "PATCH") {
      image = JSON.parse(options.body).value;
      return json({ key: "CAO_IMAGE" }, 201);
    }
    if (path === "/api/v1/deploy" && options.method === "POST") {
      deployments += 1;
      return json({
        deployments: [{
          resource_uuid: "app-1",
          deployment_uuid: `deployment-${deployments}`,
        }],
      });
    }
    if (path.startsWith("/api/v1/deployments/")) {
      return json({ status: deploymentStatuses.shift() });
    }
    if (path === "/api/readiness") {
      return new Response(null, { status: readinessStatuses.shift() });
    }
    return json({ message: "not found" }, 404);
  };
  return {
    fetchImpl,
    requests,
    image: () => image,
    deployments: () => deployments,
  };
}

const configuration = {
  baseUrl: "https://coolify.example.test",
  token: "test-token",
  applicationUuid: "app-1",
  readinessUrl: "https://dashboard.example.test/api/readiness",
  image: newImage,
  sleep: async () => {},
  pollInterval: 0,
  readinessInterval: 0,
};

test("deploys an immutable image and verifies Coolify and dashboard readiness", async () => {
  const coolify = fakeCoolify({ deploymentStatuses: ["queued", "in_progress", "finished"] });

  await deployCoolify({ ...configuration, fetchImpl: coolify.fetchImpl });

  assert.equal(coolify.image(), newImage);
  assert.equal(coolify.deployments(), 1);
  const deployRequest = coolify.requests.find(({ url }) => url.endsWith("/api/v1/deploy"));
  assert.deepEqual(JSON.parse(deployRequest.options.body), { uuid: "app-1" });
  assert.equal(
    deployRequest.options.headers.Authorization,
    `${"Bea" + "rer"} ${configuration.token}`,
  );
});

test("restores and redeploys the previous image when readiness fails", async () => {
  const coolify = fakeCoolify({
    deploymentStatuses: ["finished", "queued", "finished"],
    readinessStatuses: [503, 503, 200],
  });

  await assert.rejects(
    deployCoolify({
      ...configuration,
      fetchImpl: coolify.fetchImpl,
      readinessAttempts: 2,
    }),
    /deployment failed; previous image restored: dashboard readiness failed with HTTP 503/,
  );

  assert.equal(coolify.image(), oldImage);
  assert.equal(coolify.deployments(), 2);
});

test("reports rollback failure without exposing the token", async () => {
  const coolify = fakeCoolify({
    deploymentStatuses: ["failed", "failed"],
  });

  await assert.rejects(
    deployCoolify({ ...configuration, fetchImpl: coolify.fetchImpl }),
    (error) => {
      assert.match(error.message, /deployment failed and rollback failed/);
      assert.doesNotMatch(error.message, /test-token/);
      return true;
    },
  );
});
