import assert from "node:assert/strict";
import test from "node:test";
import { deployCoolify } from "../../scripts/deploy-coolify.mjs";

const oldImage = `ghcr.io/githubnext/gh-aw-cao/cao-server@sha256:${"a".repeat(64)}`;
const newImage = `ghcr.io/githubnext/gh-aw-cao/cao-server@sha256:${"b".repeat(64)}`;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fakeCoolify({ deploymentStatuses, readinessStatuses = [200], initialImage = oldImage }) {
  let image = initialImage;
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
    if (path.endsWith("/cancel") && options.method === "POST") {
      return json({ message: "Cancellation request queued." });
    }
    if (path.startsWith("/api/v1/deployments/")) {
      return json({ status: deploymentStatuses.shift() });
    }
    if (path === "/api/readiness") {
      const readiness = readinessStatuses.shift();
      if (readiness instanceof Error) throw readiness;
      return new Response(null, { status: readiness });
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

test("retries transient readiness request failures", async () => {
  const coolify = fakeCoolify({
    deploymentStatuses: ["finished"],
    readinessStatuses: [new Error("temporary DNS failure"), 200],
  });

  await deployCoolify({ ...configuration, fetchImpl: coolify.fetchImpl });

  assert.equal(coolify.image(), newImage);
});

test("rejects a mutable previous image before changing the application", async () => {
  const coolify = fakeCoolify({
    deploymentStatuses: [],
    initialImage: "ghcr.io/githubnext/gh-aw-cao/cao-server:latest",
  });

  await assert.rejects(
    deployCoolify({ ...configuration, fetchImpl: coolify.fetchImpl }),
    /existing CAO_IMAGE must be an immutable/,
  );
  assert.equal(coolify.deployments(), 0);
});

test("rejects a different package name before changing the application", async () => {
  const coolify = fakeCoolify({
    deploymentStatuses: [],
    initialImage: `ghcr.io/githubnext/gh-aw-cao/other-server@sha256:${"a".repeat(64)}`,
  });

  await assert.rejects(
    deployCoolify({ ...configuration, fetchImpl: coolify.fetchImpl }),
    /existing CAO_IMAGE must be an immutable githubnext\/gh-aw-cao cao-server digest/,
  );
  assert.equal(coolify.deployments(), 0);
});

test("cancels a timed-out deployment before rolling back", async () => {
  const coolify = fakeCoolify({
    deploymentStatuses: ["queued", "cancelled-by-user", "finished"],
  });

  await assert.rejects(
    deployCoolify({
      ...configuration,
      fetchImpl: coolify.fetchImpl,
      pollAttempts: 1,
    }),
    /deployment failed; previous image restored: Coolify deployment did not finish before the timeout/,
  );

  assert.equal(coolify.image(), oldImage);
  assert.equal(
    coolify.requests.filter(({ url }) => url.endsWith("/cancel")).length,
    1,
  );
});

test("accepts a deployment that finishes while cancellation is requested", async () => {
  const coolify = fakeCoolify({
    deploymentStatuses: ["queued", "finished"],
  });

  await deployCoolify({
    ...configuration,
    fetchImpl: coolify.fetchImpl,
    pollAttempts: 1,
  });

  assert.equal(coolify.image(), newImage);
  assert.equal(coolify.deployments(), 1);
});
