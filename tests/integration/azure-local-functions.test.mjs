import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
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

function redis(...arguments_) {
  const result = spawnSync("docker", ["exec", runtime.redisContainerId, "redis-cli", ...arguments_], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("Azure Functions routes requests through shared CAO logic and Redis", async () => {
  const health = await request("/api/health");
  assert.equal(health.status, 200);
  assert.deepEqual((await health.json()).redis, { connected: true });

  const readiness = await request("/api/readiness");
  assert.equal(readiness.status, 200);

  const wrongMethod = await request("/api/health", { method: "POST" });
  assert.equal(wrongMethod.status, 404);

  const isolatedNamespace = `${runtime.redisNamespace}-isolated`;
  redis("SET", `cao:${isolatedNamespace}:sentinel`, "unchanged");

  const first = await request("/api/repositories");
  const second = await request("/api/repositories");
  assert.equal(first.status, 401);
  assert.equal(second.status, 401);
  const firstRemaining = Number(first.headers.get("ratelimit-remaining"));
  const secondRemaining = Number(second.headers.get("ratelimit-remaining"));
  assert.ok(Number.isInteger(firstRemaining), "first request must expose Redis-backed rate-limit state");
  assert.equal(secondRemaining, firstRemaining - 1);

  assert.equal(redis("GET", `cao:${isolatedNamespace}:sentinel`), "unchanged");
  const activeKeys = redis("--scan", "--pattern", `cao:${runtime.redisNamespace}:*`).split("\n").filter(Boolean);
  const isolatedKeys = redis("--scan", "--pattern", `cao:${isolatedNamespace}:*`).split("\n").filter(Boolean);
  assert.ok(activeKeys.length > 0);
  assert.deepEqual(isolatedKeys, [`cao:${isolatedNamespace}:sentinel`]);
});

test("missing local configuration fails predictably", () => {
  const result = spawnSync(`${runtime.applicationDirectory}/cao-functions`, [], {
    encoding: "utf8",
    env: {
      FUNCTIONS_CUSTOMHANDLER_PORT: "1",
      PATH: process.env.PATH,
      CAO_AZURE_LOCAL_SIMULATION: "1",
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CAO_REDIS_URL is required/);
  assert.doesNotMatch(result.stderr, /COOLIFY/i);
});
