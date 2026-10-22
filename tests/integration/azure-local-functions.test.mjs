import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runtimePath = process.argv[2];
if (!runtimePath) throw new Error("runtime state JSON path is required");
const runtime = JSON.parse(await readFile(runtimePath, "utf8"));

async function request(path, options = {}) {
  return fetch(`${runtime.baseUrl}${path}`, {
    redirect: "manual",
    ...options,
  });
}

test("Azure Functions routes requests through shared CAO logic and PostgreSQL", async () => {
  const health = await request("/api/health");
  assert.equal(health.status, 200);
  assert.deepEqual((await health.json()).redis, { connected: true });

  const readiness = await request("/api/readiness");
  assert.equal(readiness.status, 200);

  const wrongMethod = await request("/api/health", { method: "POST" });
  assert.equal(wrongMethod.status, 404);

  const first = await request("/api/repositories");
  const second = await request("/api/repositories");
  assert.equal(first.status, 401);
  assert.equal(second.status, 401);
  const firstRemaining = Number(first.headers.get("ratelimit-remaining"));
  const secondRemaining = Number(second.headers.get("ratelimit-remaining"));
  assert.ok(Number.isInteger(firstRemaining), "first request must expose PostgreSQL-backed rate-limit state");
  assert.equal(secondRemaining, firstRemaining - 1);
});

test("missing local configuration fails predictably", () => {
  const result = spawnSync(`${runtime.applicationDirectory}/cao-dashboard`, ["azure-functions"], {
    encoding: "utf8",
    env: {
      FUNCTIONS_CUSTOMHANDLER_PORT: "1",
      PATH: process.env.PATH,
      CAO_AZURE_LOCAL_SIMULATION: "1",
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cao\.json requires control-plane\.web\.host/);
});
